/* eslint-disable no-console */
// THE WhatsApp send rail — every outbound WhatsApp message goes through
// `sendStudioWhatsApp`. The SMS sibling (mail/smsService.ts) sets the order;
// this adds what the channel needs on top of it:
//
//   kill switch → idempotency (mail_sends, channel 'whatsapp')
//   → recipient: test-mode redirect, or messaging policy
//   → connected + template approved → the CONTACT's opt-in (the answer the
//     template needs: reminders, or news and offers) → the studio's STOP list
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
  TEAMS_COLLECTION,
  WHATSAPP_CONSENT_FIELD,
  WHATSAPP_SUPPRESSIONS_COLLECTION,
  WHATSAPP_TEMPLATES_SUBCOLLECTION,
  whatsappConsentAllows,
  whatsappConsentKindFor,
  whatsappStudioTemplateSendable,
  whatsappTemplateApproved,
  whatsappTemplateForMeta,
  type WhatsAppConsentKind,
  type WhatsAppLanguage,
  type WhatsAppStudioTemplate,
  type WhatsAppTemplateDefinition,
  type WhatsAppTemplateToken,
} from '@linyup/shared'
import { applySmsPolicy, envDefaultMode, resolveMessagingPolicy } from '../mail/messagingPolicy'
import { ledgerRowSpendsKey } from '../mail/mailService'
import { normalizePhoneE164, phoneHash } from '../mail/smsService'
import { ledgerExpiry } from '../utils/ledgerRetention'
import { whatsappEnabled } from './config'
import { loadWhatsAppCredentials, readWhatsAppIntegration } from './connection'
import { whatsappGraph, WhatsAppGraphError } from './graph'
import { buildSendPayload } from './templates'

const testModeEnabled = defineString('TEST_MODE', {
  description: 'Redirect all outbound mail/SMS to a single test recipient',
  default: 'false',
})
const testSmsNumber = defineString('TEST_SMS_NUMBER', {
  description: 'Recipient when TEST_MODE is enabled (E.164); empty → drop + log',
  default: '',
})

/**
 * What to send. A Linyup template (the booking reminder) is approved per account
 * on the integration doc and always asks the REMINDERS answer; a studio's own
 * template is read here, sends its live approved version, and asks the answer
 * its Meta category needs (`whatsappConsentKindFor`) — decided in this one
 * place so no caller can ask the wrong one.
 */
export type OutboundTemplate =
  | {
      kind: 'linyup'
      def: WhatsAppTemplateDefinition
      language: WhatsAppLanguage
      params: Record<string, string>
      buttonSuffix?: string
    }
  | {
      kind: 'studio'
      templateId: string
      /** Rendered values keyed by TOKEN (`firstname`, `bookingUrl`, …). */
      values: Partial<Record<WhatsAppTemplateToken, string>>
    }

export interface OutboundWhatsApp {
  /** The contact being messaged — whose opt-in decides. */
  contactId: string
  to: string
  template: OutboundTemplate
  tag: string
  idempotencyKey: string
}

interface ResolvedTemplate {
  name: string
  language: string
  bodyParams: { name: string; text: string | null | undefined }[]
  buttonSuffix: string | null
  consentKind: WhatsAppConsentKind
}

/** The template as it will be sent, or why it cannot be. */
async function resolveOutboundTemplate(
  teamId: string,
  template: OutboundTemplate,
): Promise<ResolvedTemplate | 'template_not_approved'> {
  if (template.kind === 'linyup') {
    const integration = await readWhatsAppIntegration(teamId)
    if (!whatsappTemplateApproved(integration, template.def.name, template.language)) return 'template_not_approved'
    if (template.def.urlButton && !template.buttonSuffix) return 'template_not_approved'
    return {
      name: template.def.name,
      language: template.language,
      bodyParams: template.def.params.map((p) => ({ name: p.name, text: template.params[p.name] })),
      buttonSuffix: template.def.urlButton ? template.buttonSuffix ?? null : null,
      consentKind: 'reminders',
    }
  }
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(WHATSAPP_TEMPLATES_SUBCOLLECTION)
    .doc(template.templateId)
    .get()
  const doc = snap.data() as WhatsAppStudioTemplate | undefined
  if (!doc || !whatsappStudioTemplateSendable(doc)) return 'template_not_approved'
  const live = doc.live!
  return {
    name: live.meta_name,
    language: doc.language,
    bodyParams: whatsappTemplateForMeta(live.body).params.map((p) => ({ name: p.name, text: template.values[p.token] })),
    buttonSuffix: null,
    consentKind: whatsappConsentKindFor(live.category),
  }
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
  | 'no_marketing_consent'

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

  const integration = await readWhatsAppIntegration(teamId)
  if (integration?.status !== 'connected') return drop('not_connected')
  const template = await resolveOutboundTemplate(teamId, msg.template)
  if (template === 'template_not_approved') return drop('template_not_approved')

  // The opt-in belongs to the contact being messaged, even when the policy
  // redirected the delivery — and it is the answer THIS template needs.
  const contactSnap = await db.collection(CONTACTS_COLLECTION).doc(msg.contactId).get()
  const contact = contactSnap.data()
  if (!contactSnap.exists || contact?.teamId !== teamId) return drop('no_consent')
  if (!whatsappConsentAllows(contact, template.consentKind)) {
    return drop(template.consentKind === 'marketing' ? 'no_marketing_consent' : 'no_consent')
  }
  const consentAt = (contact[WHATSAPP_CONSENT_FIELD[template.consentKind]] as { at?: unknown } | undefined)?.at
  const suppression = await whatsappSuppressionRef(teamId, recipient).get()
  if (suppression.exists && suppressionBlocks(suppression.data()?.created_at, consentAt)) {
    return drop('suppressed')
  }

  const credentials = await loadWhatsAppCredentials(teamId)
  if (!credentials) return drop('not_connected')

  try {
    const { messageId } = await whatsappGraph().sendMessage(
      credentials.token,
      credentials.phoneNumberId,
      buildSendPayload({
        toE164: recipient,
        name: template.name,
        language: template.language,
        bodyParams: template.bodyParams,
        buttonSuffix: template.buttonSuffix,
      }),
    )
    // The contact and the number's hash let a STOP reply find who said it; the
    // consent kind lets Meta's "stop promotions" failure end the right answer.
    await writeLedger({
      status: 'sent',
      provider_message_id: messageId,
      recipient_count: 1,
      contact_id: msg.contactId,
      recipient_hash: phoneHash(recipient),
      template_name: template.name,
      consent_kind: template.consentKind,
    })
    return { messageId }
  } catch (err) {
    const code = err instanceof WhatsAppGraphError ? err.code : null
    await writeLedger({ status: 'failed', error_code: code, recipient_count: 0 })
    throw err
  }
}
