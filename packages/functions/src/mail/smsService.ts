/* eslint-disable no-console */
// The SMS sibling of mailService.ts. Sends transactional SMS AS a studio, with
// the same operational posture as mail:
//   • SMS_ENABLED kill switch (default OFF — SMS costs prepaid credits; enable
//     per environment once the Brevo account has SMS credits)
//   • TEST_MODE redirect to TEST_SMS_NUMBER (empty → drop + log)
//   • per-number suppression list (sms_suppressions, sha256(E.164) doc ids)
//   • mail_sends idempotency ledger reuse (channel: 'sms')
// Sender resolution: teams/{id}/integrations/sms_sender.senderName (≤11
// alphanumeric chars), falling back to 'Linyup'.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { createHash } from 'crypto'
import { defineString } from 'firebase-functions/params'
import {
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

// Upserts a phone suppression (opt-out or undeliverable). Mirrors mail/suppression.
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
  const ledgerRef = msg.idempotencyKey
    ? db.collection(MAIL_SENDS_COLLECTION).doc(msg.idempotencyKey)
    : db.collection(MAIL_SENDS_COLLECTION).doc()
  let ledgerIsNew = true
  if (msg.idempotencyKey) {
    const existing = await ledgerRef.get()
    if (existing.exists) {
      // Same predicate as mail — it owns "did this reach the provider?" for
      // both channels, so an SMS cannot answer it differently.
      if (ledgerRowSpendsKey(existing.data()?.status)) {
        console.log(`[sms] idempotent skip for key ${msg.idempotencyKey}`)
        return { providerMessageId: existing.data()?.provider_message_id, skipped: true }
      }
      ledgerIsNew = false
    }
  }

  // Recipient: normalize, then test-mode redirect, else policy → suppression.
  let recipient = normalizePhoneE164(msg.to)
  if (testMode) {
    // Local-dev/CI convenience — bypasses the per-tenant policy layer.
    const redirect = normalizePhoneE164(testSmsNumber.value())
    console.log(`[sms] TEST MODE → redirecting ${msg.to} to ${redirect ?? '(drop: no TEST_SMS_NUMBER)'}`)
    recipient = redirect
  } else if (!recipient) {
    console.warn(`[sms] unusable phone number '${msg.to}' — skipping`)
    return { skipped: true }
  } else {
    // Per-tenant delivery policy (operator-set; env default when absent). The
    // seeded demo phones are REAL routable Swiss numbers, so this — not a
    // synthetic-pattern guard — is what keeps them silent.
    const policy = await resolveMessagingPolicy(teamId)
    const decision = applySmsPolicy(recipient, policy, envDefaultMode())
    if (!decision.recipient) {
      console.log(`[sms] policy '${policy?.mode ?? envDefaultMode()}' for '${teamId}' dropped recipient (${decision.droppedReason})`)
      return { skipped: true }
    }
    recipient = decision.recipient
    if (await isPhoneSuppressed(recipient)) {
      console.warn(`[sms] recipient suppressed — skipping`)
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

  const now = FieldValue.serverTimestamp()
  await ledgerRef.set(
    {
      ...(msg.idempotencyKey ? { idempotency_key: msg.idempotencyKey } : {}),
      provider: 'brevo',
      provider_message_id: result.providerMessageId,
      channel: 'sms',
      stream: 'studio',
      team_id: teamId,
      status: 'sent',
      recipient_count: 1,
      updated_at: now,
      // Stamped once, at creation — a resend after a 'failed' row must not move
      // the send date onto the retry. Same rule as mailService.
      ...(ledgerIsNew ? { created_at: now, expires_at: ledgerExpiry('mail_sends') } : {}),
    },
    { merge: true },
  )

  return { providerMessageId: result.providerMessageId, testMode }
}
