/* eslint-disable no-console */
// THE WhatsApp send rail — every outbound WhatsApp message goes through
// `sendStudioWhatsApp`. The SMS sibling (mail/smsService.ts) sets the order;
// this adds what the channel needs on top of it:
//
//   kill switch → idempotency (mail_sends, channel 'whatsapp')
//   → recipient: test-mode redirect, or messaging policy
//   → the CONTACT's opt-in → the studio's STOP list → connected + template approved
//   → Graph send → ledger row, carrying the message id the webhook updates it by
//
// The opt-in is the synthetic-recipient guard for this channel. Seeded contacts
// carry fabricated but ROUTABLE Swiss numbers, and no seeder writes
// `whatsapp_consent`, so none of them can ever be messaged.
//
// A dropped send writes a `suppressed` row with its reason, which does not
// spend the idempotency key (`ledgerRowSpendsKey`): an opt-in given tomorrow
// must not be blocked by a drop recorded today.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { defineString } from 'firebase-functions/params'
import {
  CONTACTS_COLLECTION,
  MAIL_SENDS_COLLECTION,
  WHATSAPP_SUPPRESSIONS_COLLECTION,
  whatsappConsentAllows,
  whatsappTemplateApproved,
  type WhatsAppLanguage,
  type WhatsAppTemplateDefinition,
} from '@linyup/shared'
import { applySmsPolicy, envDefaultMode, resolveMessagingPolicy } from '../mail/messagingPolicy'
import { ledgerRowSpendsKey } from '../mail/mailService'
import { normalizePhoneE164, phoneHash } from '../mail/smsService'
import { ledgerExpiry } from '../utils/ledgerRetention'
import { whatsappEnabled } from './config'
import { loadWhatsAppCredentials, readWhatsAppIntegration } from './connection'
import { whatsappGraph, WhatsAppGraphError } from './graph'
import { buildTemplateSendPayload } from './templates'

const testModeEnabled = defineString('TEST_MODE', {
  description: 'Redirect all outbound mail/SMS to a single test recipient',
  default: 'false',
})
const testSmsNumber = defineString('TEST_SMS_NUMBER', {
  description: 'Recipient when TEST_MODE is enabled (E.164); empty → drop + log',
  default: '',
})

export interface OutboundWhatsApp {
  /** The contact being messaged — whose opt-in decides. */
  contactId: string
  to: string
  template: WhatsAppTemplateDefinition
  language: WhatsAppLanguage
  params: Record<string, string>
  buttonSuffix?: string
  tag: string
  idempotencyKey: string
}

export type WhatsAppSkipReason =
  | 'disabled'
  | 'duplicate'
  | 'bad_number'
  | 'test_mode_no_recipient'
  | 'policy_silent'
  | 'policy_allowlist'
  | 'no_consent'
  | 'suppressed'
  | 'not_connected'
  | 'template_not_approved'

export interface WhatsAppSendOutcome {
  messageId?: string
  skipped?: WhatsAppSkipReason
}

/** Per STUDIO: a STOP sent to one studio's number says nothing about another's. */
export function whatsappSuppressionRef(teamId: string, phoneE164: string): FirebaseFirestore.DocumentReference {
  return admin.firestore().collection(WHATSAPP_SUPPRESSIONS_COLLECTION).doc(`${teamId}_${phoneHash(phoneE164)}`)
}

function millis(value: unknown): number | null {
  const v = value as { toMillis?: () => number } | null | undefined
  return typeof v?.toMillis === 'function' ? v.toMillis() : null
}

/**
 * Does a STOP block this send? Only one given AFTER the contact's opt-in: a
 * member who replied STOP and later opted in again (on a form, in the Space)
 * has changed their mind, and the newer answer wins. Deciding it by time here
 * means no door that records an opt-in has to know the suppression list exists.
 */
export function suppressionBlocks(suppressionCreatedAt: unknown, consentAt: unknown): boolean {
  const stoppedAt = millis(suppressionCreatedAt)
  const optedInAt = millis(consentAt)
  if (stoppedAt === null || optedInAt === null) return true
  return stoppedAt >= optedInAt
}

export async function sendStudioWhatsApp(teamId: string, msg: OutboundWhatsApp): Promise<WhatsAppSendOutcome> {
  if (!whatsappEnabled()) {
    console.log(`[whatsapp] sending disabled (WHATSAPP_ENABLED!=true) — skipping ${msg.tag}`)
    return { skipped: 'disabled' }
  }

  const db = admin.firestore()
  const ledgerRef = db.collection(MAIL_SENDS_COLLECTION).doc(msg.idempotencyKey)
  const existing = await ledgerRef.get()
  if (existing.exists && ledgerRowSpendsKey(existing.data()?.status)) {
    return { messageId: existing.data()?.provider_message_id, skipped: 'duplicate' }
  }
  const ledgerIsNew = !existing.exists

  const writeLedger = async (fields: Record<string, unknown>): Promise<void> => {
    const now = FieldValue.serverTimestamp()
    await ledgerRef.set(
      {
        idempotency_key: msg.idempotencyKey,
        provider: 'meta',
        channel: 'whatsapp',
        stream: 'studio',
        team_id: teamId,
        tag: msg.tag,
        updated_at: now,
        ...(ledgerIsNew ? { created_at: now, expires_at: ledgerExpiry('mail_sends') } : {}),
        ...fields,
      },
      { merge: true },
    )
  }
  const drop = async (reason: WhatsAppSkipReason): Promise<WhatsAppSendOutcome> => {
    console.log(`[whatsapp] ${msg.tag} for team ${teamId} dropped: ${reason}`)
    try {
      await writeLedger({ status: 'suppressed', suppress_reason: reason, recipient_count: 0 })
    } catch (err) {
      console.warn('[whatsapp] failed to write suppressed ledger entry:', err)
    }
    return { skipped: reason }
  }

  // Recipient. The policy is resolved before the test-mode branch so an
  // operator-exempted tenant (`ignoreTestMode`) is decided by its own policy.
  const policy = await resolveMessagingPolicy(teamId)
  const testMode = testModeEnabled.value() === 'true' && policy?.ignoreTestMode !== true
  let recipient = normalizePhoneE164(msg.to)
  if (!recipient) return drop('bad_number')
  if (testMode) {
    recipient = normalizePhoneE164(testSmsNumber.value())
    if (!recipient) return drop('test_mode_no_recipient')
  } else {
    // Both phone channels share the policy's phone allowlist and redirect.
    const decision = applySmsPolicy(recipient, policy, envDefaultMode())
    if (!decision.recipient) return drop(decision.droppedReason ?? 'policy_silent')
    recipient = decision.recipient
  }

  // The opt-in belongs to the contact being messaged, even when the policy
  // redirected the delivery.
  const contactSnap = await db.collection(CONTACTS_COLLECTION).doc(msg.contactId).get()
  const contact = contactSnap.data()
  if (!contactSnap.exists || contact?.teamId !== teamId || !whatsappConsentAllows(contact)) {
    return drop('no_consent')
  }
  const suppression = await whatsappSuppressionRef(teamId, recipient).get()
  if (suppression.exists && suppressionBlocks(suppression.data()?.created_at, contact.whatsapp_consent?.at)) {
    return drop('suppressed')
  }

  const integration = await readWhatsAppIntegration(teamId)
  if (integration?.status !== 'connected') return drop('not_connected')
  if (!whatsappTemplateApproved(integration, msg.template.name, msg.language)) {
    return drop('template_not_approved')
  }
  const credentials = await loadWhatsAppCredentials(teamId)
  if (!credentials) return drop('not_connected')

  try {
    const { messageId } = await whatsappGraph().sendMessage(
      credentials.token,
      credentials.phoneNumberId,
      buildTemplateSendPayload({
        toE164: recipient,
        def: msg.template,
        language: msg.language,
        params: msg.params,
        buttonSuffix: msg.buttonSuffix,
      }),
    )
    // The contact and the number's hash let a STOP reply find who said it.
    await writeLedger({
      status: 'sent',
      provider_message_id: messageId,
      recipient_count: 1,
      contact_id: msg.contactId,
      recipient_hash: phoneHash(recipient),
    })
    return { messageId }
  } catch (err) {
    const code = err instanceof WhatsAppGraphError ? err.code : null
    await writeLedger({ status: 'failed', error_code: code, recipient_count: 0 })
    throw err
  }
}
