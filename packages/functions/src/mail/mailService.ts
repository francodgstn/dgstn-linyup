/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { createHash } from 'crypto'
import { defineString } from 'firebase-functions/params'
import { MAIL_SENDS_COLLECTION } from '@linyup/shared'
import { brevoProvider } from './brevoProvider'
import { getManagedStudioFrom, getSystemSender } from './senderIdentity'
import { resolveStudioSender } from './senderResolution'
import { loadOrgContext, loadStudioContext } from './senderConfig'
import { isSuppressed } from './suppression'
import {
  applyEmailPolicy,
  envDefaultMode,
  isSyntheticEmail,
  resolveMessagingPolicy,
} from './messagingPolicy'
import type { MailProvider, OutboundMessage, ResolvedSender } from './types'
import { rewriteTenantPublicLinks } from '@linyup/shared'
import { activeCustomDomainHost } from '../domains/activeDomain'
import { getHostingUrl } from '../utils/env'

const testModeEnabled = defineString('TEST_MODE', {
  description: 'Redirect all outbound mail to a single test address',
  default: 'false',
})
const testEmail = defineString('TEST_EMAIL', {
  description: 'Recipient when TEST_MODE is enabled',
  default: '',
})
// Master kill switch for outbound mail. Set to "false" to disable ALL sending in
// an environment (e.g. the public sandbox/demo) — no Brevo calls, no quota use,
// no risk of mailing demo contacts. Defaults to enabled.
const mailEnabled = defineString('MAIL_ENABLED', {
  description: 'Set to "false" to disable all outbound mail in this environment',
  default: 'true',
})

// The active provider. Swappable for tests; in production it is always Brevo.
let provider: MailProvider = brevoProvider
export function __setMailProviderForTests(p: MailProvider): void {
  provider = p
}

export type MailStream = 'system' | 'studio'

export interface SendOutcome {
  providerMessageId?: string
  // True when the send was suppressed (all recipients dead) or deduped.
  skipped?: boolean
  testMode?: boolean
}

/**
 * In TEST_MODE `dispatch` replaces every recipient with `testEmail` and bypasses
 * the policy layer below, so nothing addressed to a real person leaves a
 * developer's machine or a lead demo.
 *
 * It used to be EXPORTED, because one caller — the emailed guardian link, a
 * message whose delivery WAS the evidence — had to record the environment on the
 * artefact it wrote rather than merely react to it. That mechanism is gone, so
 * this is internal again. `requestWaiverAcceptance` does send mail, but it
 * records nothing about delivery — it asks somebody to sign and reports the
 * ordinary `SendOutcome` back to the manager, which needs no environment stamp.
 */
function isTestMode(): boolean {
  return testModeEnabled.value() === 'true'
}

/**
 * EXPORTED for the same reason, on the other axis: the kill switch is a fact
 * about the ENVIRONMENT and never about a recipient's address. `dispatch`
 * short-circuits on it before any Firestore work and writes no ledger row at
 * all, so "no row" alone cannot distinguish a disabled environment from a dead
 * mailbox — and filing an operator's configuration beside a hard bounce would
 * tell a studio that a parent's address is bad when nothing was ever sent.
 */
export function isMailEnabled(): boolean {
  return mailEnabled.value() !== 'false'
}

function toArray(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to]
}

// Retry only when an idempotency key is present — Brevo dedupes on the
// Idempotency-Key header, so a retried POST cannot double-send. Without a key we
// rely on the SDK's own bounded retries and do not risk duplicates here.
async function sendWithRetry(
  msg: OutboundMessage,
  sender: ResolvedSender,
): Promise<{ providerMessageId: string }> {
  const maxAttempts = msg.idempotencyKey ? 3 : 1
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await provider.send(msg, sender)
    } catch (err) {
      lastErr = err
      if (attempt < maxAttempts) {
        const backoffMs = 250 * 2 ** (attempt - 1)
        await new Promise((r) => setTimeout(r, backoffMs))
      }
    }
  }
  throw lastErr
}

// ── The send ledger ─────────────────────────────────────────────────────────
// `mail_sends/{id}` is a SEND LOG, and every send lands in it — keyed or not.
// It used to record only the sends whose call site happened to pass an
// idempotency key, which is a minority of them; anything counting it therefore
// reported an arbitrary fraction while reading as authoritative, so the
// operator console's volume figures and the platform daily snapshot both
// depend on this being complete.
//
// The idempotency key, when there is one, is the DOC ID — that is what makes a
// keyed resend a no-op. A keyless send gets an auto id and no dedupe, exactly
// as before.
type SuppressReason = 'synthetic' | 'policy_silent' | 'policy_allowlist' | 'dead_address'

/**
 * Whether an existing ledger row has SPENT its idempotency key — i.e. whether a
 * keyed resend must be skipped.
 *
 * A key is spent once the message REACHED THE PROVIDER: `status: 'sent'`, or
 * whatever the Brevo webhook later made of it (`delivered`, `bounced`,
 * `blocked`, `spam`). Those all describe a message Brevo accepted, and sending
 * again would double it.
 *
 * `failed` and `suppressed` are NOT spent, because nothing left this process. A
 * suppressed row records why a send was dropped — a seeded @example.com
 * address, the tenant policy an operator set, an address on the suppression
 * list — and each of those can be true today and false tomorrow. The key is
 * derived from the message and never changes, so treating a drop as terminal
 * means the legitimate send that follows the fix is skipped forever: the
 * operator flips the policy back to `live`, the parent's mailbox comes off the
 * suppression list, and the confirmation still never goes out.
 *
 * An absent status blocks, deliberately — a row nothing here wrote is not
 * evidence that nothing was sent, and a duplicate is the worse mistake.
 */
export function ledgerRowSpendsKey(status: unknown): boolean {
  return status !== 'failed' && status !== 'suppressed'
}

interface LedgerSlot {
  ref: FirebaseFirestore.DocumentReference
  /** False once the row already exists — which is what keeps `created_at` put. */
  isNew: boolean
}

function ledgerFields(
  slot: LedgerSlot,
  f: {
    stream: MailStream
    teamId?: string
    idempotencyKey?: string
    status: 'sent' | 'suppressed'
    /** Addresses that actually reached the provider — 0 on a suppressed row. A
     *  row is one provider call, which may carry several of them. */
    recipientCount: number
    providerMessageId?: string
    suppressReason?: SuppressReason
  },
): Record<string, unknown> {
  const now = FieldValue.serverTimestamp()
  return {
    provider: 'brevo',
    // SMS rows share this collection (smsService.ts) and have always carried
    // `channel`; mail rows did not, so a channel filter matched none of them.
    channel: 'email',
    stream: f.stream,
    status: f.status,
    recipient_count: f.recipientCount,
    ...(f.idempotencyKey ? { idempotency_key: f.idempotencyKey } : {}),
    ...(f.providerMessageId ? { provider_message_id: f.providerMessageId } : {}),
    ...(f.teamId ? { team_id: f.teamId } : {}),
    ...(f.suppressReason ? { suppress_reason: f.suppressReason } : {}),
    updated_at: now,
    // `created_at` is the SEND time and is stamped once, at creation. It used to
    // be re-stamped on every merge, so a resend after the webhook marked a row
    // 'failed' silently moved the send date onto the retry — and a send-time
    // window is exactly what the volume counts range over.
    ...(slot.isNew ? { created_at: now } : {}),
  }
}

// Records a send dropped before the provider (synthetic recipient, tenant
// policy, or every address already dead) so ledger gaps are explainable.
// A suppressed row does NOT spend the idempotency key — see `ledgerRowSpendsKey`.
async function writeSuppressedLedger(
  slot: LedgerSlot,
  stream: MailStream,
  teamId: string | undefined,
  idempotencyKey: string | undefined,
  reason: SuppressReason,
): Promise<void> {
  try {
    await slot.ref.set(
      ledgerFields(slot, {
        stream,
        teamId,
        idempotencyKey,
        status: 'suppressed',
        recipientCount: 0,
        suppressReason: reason,
      }),
      { merge: true },
    )
  } catch (err) {
    console.warn('[mail] failed to write suppressed ledger entry:', err)
  }
}

async function dispatch(
  msg: OutboundMessage,
  sender: ResolvedSender,
  stream: MailStream,
  teamId?: string,
): Promise<SendOutcome> {
  // An EMPTY recipient list is a caller bug, and `!msg.to` does not catch it —
  // `[]` and `''` are both falsy-looking and only one of them is falsy. Left
  // unchecked, an empty array survives to the synthetic filter below and is
  // filed as `suppress_reason: 'synthetic'`, which records a caller bug as a
  // fact about a recipient in the very ledger whose job is to explain gaps.
  const requested = toArray(msg.to ?? []).filter((r) => r.trim().length > 0)
  if (requested.length === 0 || !msg.subject || (!msg.html && !msg.text)) {
    throw new Error('Missing required email fields: to (at least one address), subject, and html/text')
  }

  // Kill switch — short-circuit before any Brevo or Firestore work so a disabled
  // environment makes zero external calls.
  if (!isMailEnabled()) {
    console.log(`[mail] sending disabled (MAIL_ENABLED=false) — skipping ${stream} mail to ${requested.join(', ')}`)
    return { skipped: true }
  }

  const db = admin.firestore()
  const testMode = isTestMode()

  // ── Ledger slot + idempotency: skip a keyed send that already succeeded ────
  const slot: LedgerSlot = msg.idempotencyKey
    ? { ref: db.collection(MAIL_SENDS_COLLECTION).doc(msg.idempotencyKey), isNew: true }
    : { ref: db.collection(MAIL_SENDS_COLLECTION).doc(), isNew: true }
  if (msg.idempotencyKey) {
    const existing = await slot.ref.get()
    if (existing.exists) {
      if (ledgerRowSpendsKey(existing.data()?.status)) {
        console.log(`[mail] idempotent skip for key ${msg.idempotencyKey}`)
        return { providerMessageId: existing.data()?.provider_message_id, skipped: true }
      }
      slot.isNew = false
    }
  }

  // ── Recipients: test-mode redirect, else synthetic guard → policy → suppression ──
  let recipients = requested
  if (testMode) {
    // Local-dev/CI convenience: redirect everything to one inbox. Deliberately
    // BYPASSES the per-tenant policy layer below.
    const redirect = testEmail.value()
    console.log(`[mail] TEST MODE → redirecting ${recipients.join(', ')} to ${redirect}`)
    recipients = redirect ? [redirect] : []
  } else {
    // Layer 1 — synthetic recipients (RFC-2606 reserved domains, i.e. seeded demo
    // contacts) never reach the provider, in ANY environment. Protects the Brevo
    // sender reputation from @example.com bounces on reseeds/automations.
    const synthetic = recipients.filter(isSyntheticEmail)
    if (synthetic.length) console.log(`[mail] dropping synthetic recipients: ${synthetic.join(', ')}`)
    recipients = recipients.filter((r) => !isSyntheticEmail(r))
    if (recipients.length === 0) {
      await writeSuppressedLedger(slot, stream, teamId, msg.idempotencyKey, 'synthetic')
      return { skipped: true }
    }

    // Layer 2 — per-tenant delivery policy (operator-set; env default when absent).
    const entityId = stream === 'system' ? 'system' : (teamId ?? 'system')
    const policy = await resolveMessagingPolicy(entityId)
    const decision = applyEmailPolicy(recipients, policy, envDefaultMode())
    if (decision.droppedAll) {
      console.log(`[mail] policy '${policy?.mode ?? envDefaultMode()}' for '${entityId}' dropped all recipients (${decision.droppedAll})`)
      await writeSuppressedLedger(slot, stream, teamId, msg.idempotencyKey, decision.droppedAll)
      return { skipped: true }
    }
    if (decision.recipients.join(',') !== recipients.join(',')) {
      console.log(`[mail] policy for '${entityId}' adjusted recipients: ${recipients.join(', ')} → ${decision.recipients.join(', ')}`)
    }
    recipients = decision.recipients

    const checked = await Promise.all(
      recipients.map(async (email) => ({ email, suppressed: await isSuppressed(email) })),
    )
    const suppressed = checked.filter((c) => c.suppressed).map((c) => c.email)
    if (suppressed.length) console.warn(`[mail] skipping suppressed recipients: ${suppressed.join(', ')}`)
    recipients = checked.filter((c) => !c.suppressed).map((c) => c.email)
    if (recipients.length === 0) {
      await writeSuppressedLedger(slot, stream, teamId, msg.idempotencyKey, 'dead_address')
      return { skipped: true }
    }
  }

  if (recipients.length === 0) {
    // Reached when the test-mode redirect produced no recipient: TEST_MODE is on
    // and TEST_EMAIL is unset. NOTHING is filed, for the same reason the kill
    // switch files nothing (see `isMailEnabled` above) — this is a fact about how
    // the environment is configured, never about an address, and a row in the
    // send log would say a message was dropped on the recipient's account.
    console.warn('[mail] TEST_MODE is on but TEST_EMAIL is unset — nothing sent, nothing recorded')
    return { skipped: true, testMode }
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const result = await sendWithRetry({ ...msg, to: recipients }, sender)

  // ── Ledger (send log + idempotency + delivery-status linkage for the webhook) ──
  await slot.ref.set(
    ledgerFields(slot, {
      stream,
      teamId,
      idempotencyKey: msg.idempotencyKey,
      status: 'sent',
      recipientCount: recipients.length,
      providerMessageId: result.providerMessageId,
    }),
    { merge: true },
  )

  return { providerMessageId: result.providerMessageId, testMode }
}

// Linyup's own system mail — password reset, verification, receipts, platform
// notices. Sent from the configured system identity (hello@linyup.com).
export async function sendSystemMail(msg: OutboundMessage): Promise<SendOutcome> {
  return dispatch(msg, getSystemSender(), 'system')
}

// "Send as the studio" — resolves the entity's sender identity (Managed or a
// verified BYO domain) and sends on its behalf. Works for a team or an org.
//
// TEST_MODE override: when TEST_MODE=true, the managed-studio sender
// (studios@linyup.com with an unverified studio display name) is not registered
// in the Brevo test account and would be rejected. Instead we fall back to the
// system sender (hello@linyup.com — verified) so local dev and CI can send
// without a registered managed sender. Production behavior is unchanged.
export async function sendEntityMail(
  scope: 'team' | 'org',
  entityId: string,
  msg: OutboundMessage,
  fallbackContactEmail?: string,
): Promise<SendOutcome> {
  if (isTestMode()) {
    // Use the verified system sender in test mode — avoids Brevo rejecting an
    // unverified managed From address (studios@linyup.com) in dev/CI.
    return dispatch(msg, getSystemSender(), 'studio', entityId)
  }
  const ctx =
    scope === 'team' ? await loadStudioContext(entityId) : await loadOrgContext(entityId, fallbackContactEmail)

  // ── AN UNVERIFIED SIGNUP DOES NOT GET TO SEND MAIL AS A STUDIO ─────────────
  // Anyone could sign up with an address they do not own and, within a minute,
  // have this product mailing strangers under a studio name. Verification is
  // what closes that, and the send is where it has to bite — a banner in the
  // dashboard asks nicely, it does not stop anything.
  //
  // BLOCKS ON AN EXPLICIT `false`, never on absence. The flag is written by
  // signup and by `confirmEmailVerified` from 2026-08-23 onward; every team that
  // existed before has no value at all, and reading that as "unverified" would
  // silence every studio on the platform. Failing open here is the correct
  // direction: the population it cannot see is the one that was never at risk.
  if (scope === 'team' && ctx.ownerEmailVerified === false) {
    console.warn(`[mail] blocked: team ${entityId} has not verified its email address`)
    return { skipped: true }
  }

  const sender = resolveStudioSender({
    teamName: ctx.teamName,
    contactEmail: ctx.contactEmail,
    plan: ctx.plan,
    config: ctx.config,
    managedFrom: getManagedStudioFrom(),
  })
  return dispatch(await onCustomDomain(msg, scope, entityId, ctx.slug), sender, 'studio', entityId)
}

/**
 * Puts this studio's OWN domain in the mail it sends.
 *
 * Every emailed link is built from one global `getHostingUrl()`, read at ~39
 * call sites, so a booking confirmation says `app.linyup.com/public/{slug}/…`
 * even for a studio paying to be on their own domain. Threading a per-tenant
 * base through all of those is 39 chances to miss one — and a missed one is
 * INVISIBLE, because the link still works. Rewriting here, at the seam every
 * studio mail already passes through, cannot be missed and covers call sites
 * that do not exist yet.
 *
 * Untouched when the studio has no active domain, which is almost everyone: one
 * cached lookup and the message is returned exactly as it came in.
 */
async function onCustomDomain(
  msg: OutboundMessage,
  scope: 'team' | 'org',
  entityId: string,
  slug: string | undefined,
): Promise<OutboundMessage> {
  if (!slug || (!msg.html && !msg.text)) return msg
  const host = await activeCustomDomainHost(entityId, scope)
  if (!host) return msg

  const opts = { origin: getHostingUrl(), slug, host, scope }
  return {
    ...msg,
    ...(msg.html ? { html: rewriteTenantPublicLinks(msg.html, opts) } : {}),
    ...(msg.text ? { text: rewriteTenantPublicLinks(msg.text, opts) } : {}),
  }
}

// Convenience wrapper for the common team case (used by utils/email's façade).
export async function sendStudioMail(teamId: string, msg: OutboundMessage): Promise<SendOutcome> {
  return sendEntityMail('team', teamId, msg)
}

// Stable idempotency key helper for critical-path sends.
export function idempotencyKey(...parts: (string | undefined)[]): string {
  return createHash('sha256').update(parts.filter(Boolean).join(':')).digest('hex').slice(0, 32)
}
