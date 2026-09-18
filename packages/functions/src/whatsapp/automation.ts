/* eslint-disable no-console */
// The `send_whatsapp` automation action — docs/whatsapp-outbound.md → "6c", "6d".
//
// Per contact: render the template's tokens for this person, then either send
// now through the one rail (`sendStudioWhatsApp`, which asks the approval, the
// opt-in the template's category needs, the STOP list and the connection) or,
// outside 08:00–21:00, HOLD it: a Cloud Task (`sendHeldWhatsApp`) sends it when
// the window opens, asking all of that again then. Only this action waits; the
// rule's other actions have already run.
import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import * as admin from 'firebase-admin'
import {
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  WHATSAPP_TEMPLATE_TOKENS,
  type WhatsAppTemplateToken,
} from '@linyup/shared'
import { substituteVariables } from '../utils/outreachEmail'
import { isWithinSmsSendingHours, nextSmsWindowOpen } from '../utils/sms'
import { runsInlineForLocalDev } from '../utils/tenantFanOut'
import { sendStudioWhatsApp, type WhatsAppSkipReason } from './service'

/** What one `send_whatsapp` action did for one contact. */
export type WhatsAppActionOutcome = 'sent' | 'held' | 'no_phone' | WhatsAppSkipReason

type ContactLike = Record<string, unknown> & { phone?: unknown }

/** Every token's value for this contact, through the same substitution the
 *  email templates use — so `{{firstname}}` means one thing everywhere. */
export function renderWhatsAppTokenValues(
  contact: ContactLike,
  teamData: Record<string, unknown>,
  now: Date,
  payload?: Record<string, unknown>,
): Partial<Record<WhatsAppTemplateToken, string>> {
  const teamName = (teamData.name as string) || ''
  const values: Partial<Record<WhatsAppTemplateToken, string>> = {}
  for (const token of Object.keys(WHATSAPP_TEMPLATE_TOKENS) as WhatsAppTemplateToken[]) {
    values[token] = substituteVariables(
      `{{${token}}}`,
      contact as Parameters<typeof substituteVariables>[1],
      teamName,
      now,
      teamData as Parameters<typeof substituteVariables>[4],
      payload,
    )
  }
  return values
}

/** The studio's calendar day, for the idempotency key: a retry of the same run
 *  is one message; the rule's own dedup window decides whether tomorrow is. */
function zurichDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(now)
}

export function whatsappAutomationKey(ruleId: string, contactId: string, now: Date): string {
  return `wa-auto-${ruleId}-${contactId}-${zurichDay(now)}`
}

export interface HeldWhatsAppPayload {
  teamId: string
  ruleId: string
  contactId: string
  templateId: string
  idempotencyKey: string
}

const HELD_FUNCTION = 'locations/europe-west6/functions/sendHeldWhatsApp'

/** Cloud Tasks ids allow letters, digits, hyphens and underscores. */
export function heldTaskId(idempotencyKey: string): string {
  return idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 480)
}

async function holdUntil(payload: HeldWhatsAppPayload, at: Date): Promise<void> {
  const { getFunctions } = await import('firebase-admin/functions')
  const queue = getFunctions().taskQueue<HeldWhatsAppPayload>(HELD_FUNCTION)
  try {
    await queue.enqueue(payload, { scheduleTime: at, id: heldTaskId(payload.idempotencyKey) })
  } catch (err) {
    // The same message already waiting is the same hold, not a failure.
    if ((err as { code?: string })?.code === 'functions/task-already-exists') return
    throw err
  }
}

async function sendNow(args: {
  teamId: string
  contactId: string
  contact: ContactLike
  templateId: string
  teamData: Record<string, unknown>
  idempotencyKey: string
  now: Date
  payload?: Record<string, unknown>
}): Promise<WhatsAppActionOutcome> {
  const phone = typeof args.contact.phone === 'string' ? args.contact.phone : ''
  if (!phone) return 'no_phone'
  const outcome = await sendStudioWhatsApp(args.teamId, {
    contactId: args.contactId,
    to: phone,
    template: {
      kind: 'studio',
      templateId: args.templateId,
      values: renderWhatsAppTokenValues(args.contact, args.teamData, args.now, args.payload),
    },
    tag: 'automation',
    idempotencyKey: args.idempotencyKey,
  })
  return outcome.messageId ? 'sent' : (outcome.skipped ?? 'sent')
}

/** One `send_whatsapp` action for one contact, from the automation engine. */
export async function runWhatsAppAction(args: {
  teamId: string
  ruleId: string
  contactId: string
  contact: ContactLike
  templateId: string
  teamData: Record<string, unknown>
  payload?: Record<string, unknown>
  now?: Date
}): Promise<WhatsAppActionOutcome> {
  const now = args.now ?? new Date()
  if (!args.contactId) return 'no_consent'
  if (typeof args.contact.phone !== 'string' || !args.contact.phone) return 'no_phone'
  const idempotencyKey = whatsappAutomationKey(args.ruleId, args.contactId, now)

  if (!isWithinSmsSendingHours(now)) {
    if (runsInlineForLocalDev()) {
      console.log(`[whatsapp] no Cloud Tasks emulator — sending the held message now (rule ${args.ruleId})`)
    } else {
      await holdUntil(
        {
          teamId: args.teamId,
          ruleId: args.ruleId,
          contactId: args.contactId,
          templateId: args.templateId,
          idempotencyKey,
        },
        nextSmsWindowOpen(now),
      )
      return 'held'
    }
  }
  return sendNow({ ...args, idempotencyKey, now })
}

/** Sends a message that waited for the window to open. Everything about the
 *  contact is read NOW: a member who opted out overnight gets nothing. */
export const sendHeldWhatsApp = onTaskDispatched<HeldWhatsAppPayload>(
  { retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 }, rateLimits: { maxConcurrentDispatches: 20 } },
  async (req) => {
    const { teamId, ruleId, contactId, templateId, idempotencyKey } = req.data ?? ({} as Partial<HeldWhatsAppPayload>)
    if (!teamId || !ruleId || !contactId || !templateId || !idempotencyKey) {
      console.warn('[whatsapp] held message with an incomplete payload — dropped', req.data)
      return
    }
    const db = admin.firestore()
    const [contactSnap, teamSnap] = await Promise.all([
      db.collection(CONTACTS_COLLECTION).doc(contactId).get(),
      db.collection(TEAMS_COLLECTION).doc(teamId).get(),
    ])
    const contact = contactSnap.data() as ContactLike | undefined
    if (!contact || contact.teamId !== teamId || contact.archived_at != null || contact.deleted_at != null) {
      console.log(`[whatsapp] held message for ${contactId} dropped: the contact is gone`)
      return
    }
    const outcome = await sendNow({
      teamId,
      contactId,
      contact,
      templateId,
      teamData: (teamSnap.data() ?? {}) as Record<string, unknown>,
      idempotencyKey,
      now: new Date(),
    })
    console.log(`[whatsapp] held message rule=${ruleId} contact=${contactId}: ${outcome}`)
  },
)
