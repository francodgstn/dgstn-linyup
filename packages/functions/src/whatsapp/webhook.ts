/* eslint-disable no-console */
// Meta's WhatsApp webhook — one endpoint for the Linyup app, every studio.
// docs/whatsapp-outbound.md → "Webhook".
//
//   GET   the subscription handshake: echo `hub.challenge` when
//         `hub.verify_token` matches.
//   POST  signed with the app secret (`X-Hub-Signature-256: sha256=<hex>` over
//         the RAW body). Verified before anything is read; fails CLOSED — no
//         secret configured is a 503, never "accept and warn".
//
// What it does with a verified delivery:
//   • message statuses → the `mail_sends` row holding that message id;
//   • an inbound message that is a STOP keyword → the studio's suppression list
//     plus an opt-out of BOTH answers on the contacts that number was messaged as. Every other
//     inbound message is ignored and NOT stored: replies belong to the studio's
//     WhatsApp Business app, which receives them itself;
//   • template review results → a studio template (promoting an approved edit)
//     or the integration doc's statuses for Linyup's own templates;
//   • a template moved to another category → the studio template records it;
//   • a marketing message refused because the member stopped promotions →
//     that member's news-and-offers answer ends.
//
// Anything it does not recognize is acknowledged with 200, so Meta does not
// retry an event that was deliberately ignored.
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'
import { onRequest } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  MAIL_SENDS_COLLECTION,
  WHATSAPP_CONNECTIONS_COLLECTION,
  isWhatsAppStopMessage,
  whatsappTemplateStatusKey,
} from '@linyup/shared'
import { FieldValue } from 'firebase-admin/firestore'
import { readSecret } from '../utils/secrets'
import { timingSafeEqualStr } from '../utils/secureCompare'
import { normalizePhoneE164, phoneHash } from '../mail/smsService'
import { META_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN } from './config'
import { patchWhatsAppIntegration, readWhatsAppIntegration, teamForPhoneNumberId } from './connection'
import { whatsappConsentPatch, whatsappStopPatch } from './consentPatch'
import { applyStudioTemplateCategory, applyStudioTemplateStatus } from './studioTemplates'
import { whatsappSuppressionRef } from './service'
import { normaliseTemplateStatus } from './templates'

// ─── Signature ───────────────────────────────────────────────────────────────

export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!rawBody || !header || !secret) return false
  const [scheme, digest] = header.split('=')
  if (scheme !== 'sha256' || !digest) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return timingSafeEqualStr(digest.toLowerCase(), expected)
}

// ─── Parsing (pure) ──────────────────────────────────────────────────────────

export type WhatsAppWebhookEvent =
  | {
      kind: 'status'
      phoneNumberId: string
      messageId: string
      status: string
      errorCode: number | null
      category: string | null
      billable: boolean | null
    }
  | { kind: 'inbound'; phoneNumberId: string; from: string; text: string | null }
  | { kind: 'template_status'; wabaId: string; name: string; language: string; event: string; reason: string | null }
  | { kind: 'template_category'; wabaId: string; name: string; category: string }

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export function parseWhatsAppWebhook(body: unknown): WhatsAppWebhookEvent[] {
  const events: WhatsAppWebhookEvent[] = []
  const root = body as Json
  if (root?.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) return events
  for (const entry of root.entry as Json[]) {
    for (const change of (entry?.changes ?? []) as Json[]) {
      const value = (change?.value ?? {}) as Json
      if (change?.field === 'messages') {
        const phoneNumberId = value.metadata?.phone_number_id
        if (typeof phoneNumberId !== 'string') continue
        for (const s of (value.statuses ?? []) as Json[]) {
          if (typeof s?.id !== 'string' || typeof s?.status !== 'string') continue
          events.push({
            kind: 'status',
            phoneNumberId,
            messageId: s.id,
            status: s.status,
            errorCode: typeof s.errors?.[0]?.code === 'number' ? s.errors[0].code : null,
            category: typeof s.pricing?.category === 'string' ? s.pricing.category : null,
            billable: typeof s.pricing?.billable === 'boolean' ? s.pricing.billable : null,
          })
        }
        for (const m of (value.messages ?? []) as Json[]) {
          if (typeof m?.from !== 'string') continue
          const text =
            m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.interactive?.button_reply?.title
          events.push({ kind: 'inbound', phoneNumberId, from: m.from, text: typeof text === 'string' ? text : null })
        }
      } else if (change?.field === 'message_template_status_update') {
        if (typeof entry.id !== 'string' || typeof value.message_template_name !== 'string') continue
        events.push({
          kind: 'template_status',
          wabaId: entry.id,
          name: value.message_template_name,
          language: String(value.message_template_language ?? ''),
          event: String(value.event ?? ''),
          reason: typeof value.reason === 'string' && value.reason !== 'NONE' ? value.reason : null,
        })
      } else if (change?.field === 'template_category_update') {
        if (typeof entry.id !== 'string' || typeof value.message_template_name !== 'string') continue
        events.push({
          kind: 'template_category',
          wabaId: entry.id,
          name: value.message_template_name,
          category: String(value.new_category ?? ''),
        })
      }
    }
  }
  return events
}

/** A message Meta accepted keeps its idempotency key spent whatever happens to
 *  it next, so a delivery failure is `undelivered`, never `failed`. */
export function ledgerStatusFor(metaStatus: string): string | null {
  switch (metaStatus) {
    case 'sent':
      return 'sent'
    case 'delivered':
      return 'delivered'
    case 'read':
      return 'read'
    case 'failed':
      return 'undelivered'
    default:
      return null
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** Meta's failure code for "this person stopped marketing messages from you".
 *  To be confirmed against a real failure in the Phase 0 spike. */
export const META_STOPPED_PROMOTIONS = 131050

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, undelivered: 3 }

async function applyStatus(event: Extract<WhatsAppWebhookEvent, { kind: 'status' }>): Promise<void> {
  const next = ledgerStatusFor(event.status)
  if (!next) return
  const db = admin.firestore()
  const rows = await db
    .collection(MAIL_SENDS_COLLECTION)
    .where('provider_message_id', '==', event.messageId)
    .limit(1)
    .get()
  const row = rows.docs[0]
  if (!row || row.data().channel !== 'whatsapp') return
  // Statuses can arrive out of order; never move a row backwards.
  if ((STATUS_RANK[row.data().status] ?? 0) >= STATUS_RANK[next]) return
  // The member tapped "stop promotions" in WhatsApp: Meta refuses marketing to
  // them from now on, so record it as the end of the news-and-offers answer —
  // otherwise every later marketing send would fail the same way, and the
  // studio would never see why. Reminders are untouched.
  if (event.errorCode === META_STOPPED_PROMOTIONS && row.data().consent_kind === 'marketing') {
    const contactId = row.data().contact_id as string | undefined
    const teamId = row.data().team_id as string | undefined
    if (contactId && teamId) {
      const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
      const contact = await contactRef.get()
      if (contact.data()?.teamId === teamId) {
        await contactRef.update(whatsappConsentPatch('marketing', false, 'meta_stop_promotions'))
      }
    }
  }
  await row.ref.update({
    status: next,
    ...(event.errorCode !== null ? { error_code: event.errorCode } : {}),
    ...(event.category ? { wa_category: event.category } : {}),
    ...(event.billable !== null ? { wa_billable: event.billable } : {}),
    updated_at: FieldValue.serverTimestamp(),
  })
}

async function applyInbound(event: Extract<WhatsAppWebhookEvent, { kind: 'inbound' }>): Promise<void> {
  if (!isWhatsAppStopMessage(event.text)) return
  const teamId = await teamForPhoneNumberId(event.phoneNumberId)
  const phone = normalizePhoneE164(`+${event.from}`)
  if (!teamId || !phone) return
  const db = admin.firestore()
  // `created_at` is re-stamped on every STOP: it is compared with the
  // contact's latest opt-in (`suppressionBlocks`), so the newest answer wins.
  await whatsappSuppressionRef(teamId, phone).set({
    team_id: teamId,
    reason: 'stop',
    created_at: FieldValue.serverTimestamp(),
  })
  // Who was messaged at this number, from the send log: phones are stored as
  // typed on contacts, so the log is the only exact match there is.
  const sends = await db
    .collection(MAIL_SENDS_COLLECTION)
    .where('team_id', '==', teamId)
    .where('recipient_hash', '==', phoneHash(phone))
    .limit(20)
    .get()
  const contactIds = new Set(sends.docs.map((d) => d.data().contact_id as string | undefined).filter(Boolean))
  for (const contactId of contactIds) {
    const ref = db.collection(CONTACTS_COLLECTION).doc(contactId as string)
    const snap = await ref.get()
    if (snap.data()?.teamId !== teamId) continue
    await ref.update(whatsappStopPatch('reply_stop'))
  }
  console.log(`[whatsapp] STOP recorded for team ${teamId} (${contactIds.size} contact(s))`)
}

async function teamForWaba(wabaId: string): Promise<string | null> {
  const connections = await admin
    .firestore()
    .collection(WHATSAPP_CONNECTIONS_COLLECTION)
    .where('waba_id', '==', wabaId)
    .limit(1)
    .get()
  return connections.docs[0]?.id ?? null
}

async function applyTemplateCategory(event: Extract<WhatsAppWebhookEvent, { kind: 'template_category' }>): Promise<void> {
  const teamId = await teamForWaba(event.wabaId)
  if (teamId) await applyStudioTemplateCategory(teamId, event.name, event.category)
}

async function applyTemplateStatus(event: Extract<WhatsAppWebhookEvent, { kind: 'template_status' }>): Promise<void> {
  const teamId = await teamForWaba(event.wabaId)
  if (!teamId) return
  // A studio's own template first; otherwise one of Linyup's.
  if (await applyStudioTemplateStatus(teamId, event.name, event.event, event.reason)) return
  const integration = await readWhatsAppIntegration(teamId)
  const key = whatsappTemplateStatusKey(event.name, event.language)
  // Only templates Linyup tracks; a studio's own templates are not ours to list.
  if (!integration?.templates?.[key]) return
  await patchWhatsAppIntegration(teamId, {
    templates: {
      ...integration.templates,
      [key]: { status: normaliseTemplateStatus(event.event), reason: event.reason },
    },
  })
}

export const handleWhatsAppWebhook = onRequest({ invoker: 'public' }, async (req, res) => {
  if (req.method === 'GET') {
    const verify = await readSecret(WHATSAPP_WEBHOOK_VERIFY_TOKEN)
    const token = String(req.query['hub.verify_token'] ?? '')
    if (verify.ok && req.query['hub.mode'] === 'subscribe' && timingSafeEqualStr(token, verify.value)) {
      res.status(200).send(String(req.query['hub.challenge'] ?? ''))
      return
    }
    res.status(403).send('forbidden')
    return
  }
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed')
    return
  }

  const secret = await readSecret(META_APP_SECRET)
  if (!secret.ok) {
    console.error(`[whatsapp] webhook secret unavailable (${secret.reason})`)
    res.status(503).send('not configured')
    return
  }
  if (!verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), secret.value)) {
    res.status(401).send('bad signature')
    return
  }

  for (const event of parseWhatsAppWebhook(req.body)) {
    try {
      if (event.kind === 'status') await applyStatus(event)
      else if (event.kind === 'inbound') await applyInbound(event)
      else if (event.kind === 'template_category') await applyTemplateCategory(event)
      else await applyTemplateStatus(event)
    } catch (err) {
      // One bad event must not make Meta redeliver the others in the batch.
      console.error(`[whatsapp] webhook ${event.kind} event failed:`, err)
    }
  }
  res.status(200).send('ok')
})
