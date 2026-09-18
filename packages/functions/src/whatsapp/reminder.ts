// The booking reminder as a WhatsApp template send: the parameters for
// `linyup_booking_reminder_v1`, in the studio's language and clock.
import {
  WHATSAPP_BOOKING_REMINDER_TEMPLATE,
  resolveWhatsAppLanguage,
  type WhatsAppLanguage,
} from '@linyup/shared'
import { getHostingUrl } from '../utils/env'
import { sendStudioWhatsApp, type WhatsAppSendOutcome } from './service'
import { buttonSuffixFor } from './templates'

const LOCALE: Record<WhatsAppLanguage, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH' }

export function whatsappReminderParams(args: {
  firstname: string | null | undefined
  activityName: string
  teamName: string
  sessionStart: Date
  lang: string | null | undefined
  timeZone?: string
}): { language: WhatsAppLanguage; params: Record<string, string> } {
  const language = resolveWhatsAppLanguage(args.lang)
  const timeZone = args.timeZone ?? 'Europe/Zurich'
  const date = args.sessionStart.toLocaleDateString(LOCALE[language], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  })
  const time = args.sessionStart.toLocaleTimeString(LOCALE[language], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
  return {
    language,
    params: {
      first_name: args.firstname?.trim() || '-',
      class_name: args.activityName,
      studio_name: args.teamName,
      date,
      time,
    },
  }
}

export type WhatsAppReminderResult = WhatsAppSendOutcome | { skipped: 'no_contact' | 'no_phone' | 'no_manage_link' }

/** One reminder step to one booking. Never throws for an unsendable booking —
 *  it reports why; a Graph failure still throws, so the step is retried. */
export async function sendWhatsAppBookingReminder(args: {
  teamId: string
  teamName: string
  lang: string
  booking: FirebaseFirestore.DocumentData
  bookingId: string
  sessionId: string
  stepId: string
  activityName: string
  sessionStart: Date
  manageBookingUrl: string | null
}): Promise<WhatsAppReminderResult> {
  const contactId = args.booking.contact as string | undefined
  if (!contactId) return { skipped: 'no_contact' }
  const phone = args.booking.phone as string | undefined
  if (!phone) return { skipped: 'no_phone' }
  const buttonSuffix = buttonSuffixFor(args.manageBookingUrl, getHostingUrl())
  if (!buttonSuffix) return { skipped: 'no_manage_link' }

  const { language, params } = whatsappReminderParams({
    firstname: args.booking.firstname as string | undefined,
    activityName: args.activityName,
    teamName: args.teamName,
    sessionStart: args.sessionStart,
    lang: args.lang,
  })
  return sendStudioWhatsApp(args.teamId, {
    contactId,
    to: phone,
    template: { kind: 'linyup', def: WHATSAPP_BOOKING_REMINDER_TEMPLATE, language, params, buttonSuffix },
    tag: 'booking-reminder',
    idempotencyKey: `wa-reminder-${args.sessionId}-${args.bookingId}-${args.stepId}`,
  })
}
