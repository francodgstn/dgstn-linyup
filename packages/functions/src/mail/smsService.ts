/* eslint-disable no-console */
// The SMS sibling of mailService.ts. Sends transactional SMS AS a studio, with
// the same operational posture as mail:
//   • SMS_ENABLED kill switch (default OFF — SMS costs prepaid credits; enable
//     per environment once the Brevo account has SMS credits)
//   • TEST_MODE redirect to TEST_SMS_NUMBER (empty → drop + log)
//   • per-contact opt-out (Contact.sms_opt_out, read from the contact the send
//     names) and per-number suppression list (sms_suppressions, sha256(E.164))
//   • mail_sends idempotency ledger reuse (channel: 'sms'), including a
//     'suppressed' row for a send dropped on the recipient's account
// Sender resolution: teams/{id}/integrations/sms_sender.senderName (≤11
// alphanumeric chars), falling back to 'Linyup'.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { createHash } from 'crypto'
import { defineString } from 'firebase-functions/params'
import {
  CONTACTS_COLLECTION,
  MAIL_SENDS_COLLECTION,
  SMS_SUPPRESSIONS_COLLECTION,
  SMS_SENDER_INTEGRATION_DOC,
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
} from '@linyup/shared'
import { brevoSmsProvider } from './brevoSmsProvider'
import { applySmsPolicy, envDefaultMode, resolveMessagingPolicy } from './messagingPolicy'
import { ledgerRowSpendsKey } from './mailService'
import type { OutboundSms, SmsProvider } from './smsTypes'
import { ledgerExpiry } from '../utils/ledgerRetention'

// Master kill switch. Unlike mail this DEFAULTS OFF: SMS sends spend prepaid
// Brevo credits, so an environment must opt in explicitly.
const smsEnabled = defineString('SMS_ENABLED', {
  description: 'Set to "true" to enable outbound SMS in this environment',
  default: 'false',
})
const testModeEnabled = defineString('TEST_MODE', {
  description: 'Redirect all outbound mail/SMS to a single test recipient',
  default: 'false',
})
const testSmsNumber = defineString('TEST_SMS_NUMBER', {
  description: 'Recipient when TEST_MODE is enabled (E.164); empty → drop + log',
  default: '',
})

const DEFAULT_SENDER = 'Linyup'

let provider: SmsProvider = brevoSmsProvider
export function __setSmsProviderForTests(p: SmsProvider): void {
  provider = p
}

export interface SmsSendOutcome {
  providerMessageId?: string
  // True when the send was suppressed, deduped, disabled, or dropped (bad number).
  skipped?: boolean
  testMode?: boolean
}

// ── phone normalization (CH default) ──────────────────────────────────────────
// Best-effort E.164: strips separators, resolves 00-prefixes, and assumes
// Switzerland (+41) for national 0-prefixed numbers. Returns null when the
// result doesn't look like E.164 — the caller should skip, not throw.
export function normalizePhoneE164(raw: string | null | undefined, defaultCountry = '41'): string | null {
  if (!raw) return null
  let s = raw.replace(/[\s().\-/]/g, '')
  if (s.startsWith('00')) s = `+${s.slice(2)}`
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) s = `+${defaultCountry}${s.slice(1)}`
    else if (/^\d{6,15}$/.test(s)) s = `+${s}`
  }
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null
}

// Why a send was dropped on the RECIPIENT's account — the SMS sibling of
// mailService's SuppressReason. Environment facts (kill switch, TEST_MODE with no
// TEST_SMS_NUMBER) are deliberately not reasons: they file nothing.
export type SmsSuppressReason =
  | 'opt_out'
  | 'invalid_number'
  | 'policy_silent'
  | 'policy_allowlist'
  | 'suppressed_number'

export function phoneHash(phoneE164: string): string {
  return createHash('sha256').update(phoneE164.trim()).digest('hex')
}

async function isPhoneSuppressed(phoneE164: string): Promise<boolean> {
  const snap = await admin
    .firestore()
    .collection(SMS_SUPPRESSIONS_COLLECTION)
    .doc(phoneHash(phoneE164))
    .get()
  return snap.exists
}

// Whether the contact asked not to be texted. Only an explicit `true` opts out;
// a missing contact has no preference on file. A READ ERROR PROPAGATES — the
// caller retries later rather than texting someone who may have said no.
async function contactOptedOutOfSms(contactId: string): Promise<boolean> {
  const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).get()
  return snap.data()?.sms_opt_out === true
}

// Upserts a phone suppression (opt-out or undeliverable). Mirrors mail/suppression.
// No inbound STOP handling writes here yet — see the README's SMS section.
export async function addSmsSuppression(phoneE164: string, reason: string): Promise<void> {
  const ref = admin.firestore().collection(SMS_SUPPRESSIONS_COLLECTION).doc(phoneHash(phoneE164))
  const existing = await ref.get()
  await ref.set(
    {
      phone: phoneE164,
      reason,
      updated_at: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { created_at: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  )
}

// ── sender resolution ─────────────────────────────────────────────────────────
// Alphanumeric sender, ≤11 chars (GSM limit). Falls back to 'Linyup' when the
// studio hasn't configured (or has disabled) its own sender name.
export function sanitizeSmsSender(name: string | null | undefined): string {
  const cleaned = (name ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 11)
  return cleaned || DEFAULT_SENDER
}

async function resolveSmsSender(teamId: string): Promise<string> {
  try {
    const snap = await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(TEAM_INTEGRATIONS_SUBCOLLECTION)
      .doc(SMS_SENDER_INTEGRATION_DOC)
      .get()
    const data = snap.data()
    if (!snap.exists || data?.enabled === false) return DEFAULT_SENDER
    return sanitizeSmsSender(data?.senderName as string | undefined)
  } catch (err) {
    console.warn(`[sms] failed to read sms_sender config for team ${teamId}:`, err)
    return DEFAULT_SENDER
  }
}

// ── ledger ────────────────────────────────────────────────────────────────────
interface SmsLedgerSlot {
  ref: FirebaseFirestore.DocumentReference
  /** False once the row already exists — which is what keeps `created_at` put. */
  isNew: boolean
}

// The one shape of an SMS `mail_sends` row, for both a send and a drop.
function smsLedgerFields(
  slot: { isNew: boolean },
  f: {
    teamId: string
    idempotencyKey?: string
    status: 'sent' | 'suppressed'
    providerMessageId?: string
    suppressReason?: SmsSuppressReason
  },
): Record<string, unknown> {
  const now = FieldValue.serverTimestamp()
  return {
    ...(f.idempotencyKey ? { idempotency_key: f.idempotencyKey } : {}),
    provider: 'brevo',
    ...(f.providerMessageId ? { provider_message_id: f.providerMessageId } : {}),
    channel: 'sms',
    stream: 'studio',
    team_id: f.teamId,
    status: f.status,
    recipient_count: f.status === 'sent' ? 1 : 0,
    // A send that follows a suppressed row on the same key must not keep the
    // old drop reason beside its new status.
    ...(f.suppressReason
      ? { suppress_reason: f.suppressReason }
      : slot.isNew ? {} : { suppress_reason: FieldValue.delete() }),
    updated_at: now,
    // Stamped once, at creation — a resend after a 'failed' or 'suppressed' row
    // must not move the send date onto the retry. Same rule as mailService.
    ...(slot.isNew ? { created_at: now, expires_at: ledgerExpiry('mail_sends') } : {}),
  }
}

// Records an SMS dropped before the provider so ledger gaps are explainable.
// A suppressed row does NOT spend the idempotency key (`ledgerRowSpendsKey`): an
// opt-in or a policy flip lets the next keyed send go out. Never throws — the
// drop already happened, and a failed log write must not turn it into an error.
async function writeSuppressedSmsLedger(
  slot: SmsLedgerSlot,
  teamId: string,
  idempotencyKey: string | undefined,
  reason: SmsSuppressReason,
): Promise<void> {
  try {
    await slot.ref.set(
      smsLedgerFields(slot, { teamId, idempotencyKey, status: 'suppressed', suppressReason: reason }),
      { merge: true },
    )
  } catch (err) {
    console.warn('[sms] failed to write suppressed ledger entry:', err)
  }
}

// ── send ──────────────────────────────────────────────────────────────────────
export async function sendStudioSms(teamId: string, msg: OutboundSms): Promise<SmsSendOutcome> {
  if (!msg.to || !msg.content?.trim()) {
    throw new Error('Missing required SMS fields: to and content')
  }

  // Kill switch — zero external calls when disabled.
  if (smsEnabled.value() !== 'true') {
    console.log(`[sms] sending disabled (SMS_ENABLED!=true) — skipping SMS to ${msg.to}`)
    return { skipped: true }
  }

  const db = admin.firestore()
  const testMode = testModeEnabled.value() === 'true'

  // Ledger slot (shared mail_sends send log, channel-tagged) + idempotency. Same
  // shape as mailService: a keyed send is deduped on its key as the doc id, a
  // keyless one gets an auto id — every send is recorded either way, so the SMS
  // figure beside the email one counts sends rather than keyed sends.
  const slot: SmsLedgerSlot = {
    ref: msg.idempotencyKey
      ? db.collection(MAIL_SENDS_COLLECTION).doc(msg.idempotencyKey)
      : db.collection(MAIL_SENDS_COLLECTION).doc(),
    isNew: true,
  }
  if (msg.idempotencyKey) {
    const existing = await slot.ref.get()
    if (existing.exists) {
      // Same predicate as mail — it owns "did this reach the provider?" for
      // both channels, so an SMS cannot answer it differently.
      if (ledgerRowSpendsKey(existing.data()?.status)) {
        console.log(`[sms] idempotent skip for key ${msg.idempotencyKey}`)
        return { providerMessageId: existing.data()?.provider_message_id, skipped: true }
      }
      slot.isNew = false
    }
  }

  // The contact's own "no SMS" — checked before the test-mode redirect too, so a
  // redirected test run shows what production would actually send.
  if (msg.contactId && (await contactOptedOutOfSms(msg.contactId))) {
    console.log(`[sms] contact ${msg.contactId} opted out of SMS — skipping`)
    await writeSuppressedSmsLedger(slot, teamId, msg.idempotencyKey, 'opt_out')
    return { skipped: true }
  }

  // Recipient: normalize, then test-mode redirect, else policy → suppression.
  //
  // Resolved BEFORE the branch for the same reason as in mailService: a tenant
  // the operator has exempted (`ignoreTestMode`) skips the environment-wide
  // redirect and is decided by its own policy instead. Absent ⇒ unchanged.
  const policy = await resolveMessagingPolicy(teamId)
  const bypassTestMode = testMode && policy?.ignoreTestMode === true

  let recipient = normalizePhoneE164(msg.to)
  if (testMode && !bypassTestMode) {
    // Local-dev/CI convenience — bypasses the per-tenant policy layer.
    const redirect = normalizePhoneE164(testSmsNumber.value())
    console.log(`[sms] TEST MODE → redirecting ${msg.to} to ${redirect ?? '(drop: no TEST_SMS_NUMBER)'}`)
    recipient = redirect
  } else if (!recipient) {
    console.warn(`[sms] unusable phone number '${msg.to}' — skipping`)
    await writeSuppressedSmsLedger(slot, teamId, msg.idempotencyKey, 'invalid_number')
    return { skipped: true }
  } else {
    if (bypassTestMode) {
      console.warn(
        `[sms] TEST_MODE is on but '${teamId}' is exempt (ignoreTestMode) — its own policy ` +
          `'${policy?.mode ?? envDefaultMode()}' decides, and a real number may be reached`,
      )
    }
    // Per-tenant delivery policy (operator-set; env default when absent). The
    // seeded demo phones are REAL routable Swiss numbers, so this — not a
    // synthetic-pattern guard — is what keeps them silent.
    const decision = applySmsPolicy(recipient, policy, envDefaultMode())
    if (!decision.recipient) {
      console.log(`[sms] policy '${policy?.mode ?? envDefaultMode()}' for '${teamId}' dropped recipient (${decision.droppedReason})`)
      await writeSuppressedSmsLedger(slot, teamId, msg.idempotencyKey, decision.droppedReason ?? 'policy_silent')
      return { skipped: true }
    }
    recipient = decision.recipient
    if (await isPhoneSuppressed(recipient)) {
      console.warn(`[sms] recipient suppressed — skipping`)
      await writeSuppressedSmsLedger(slot, teamId, msg.idempotencyKey, 'suppressed_number')
      return { skipped: true }
    }
  }
  if (!recipient) return { skipped: true, testMode }

  const sender = await resolveSmsSender(teamId)
  const result = await provider.send({
    recipient,
    content: msg.content,
    sender,
    tag: msg.tag,
  })

  await slot.ref.set(
    smsLedgerFields(slot, {
      teamId,
      idempotencyKey: msg.idempotencyKey,
      status: 'sent',
      providerMessageId: result.providerMessageId,
    }),
    { merge: true },
  )

  return { providerMessageId: result.providerMessageId, testMode }
}
