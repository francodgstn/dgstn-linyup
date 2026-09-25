import { buildEmailTemplate } from '../utils/email'
import { detailsBox, ctaButton, factLines } from '../utils/emailLayout'
import { instructionsBox } from '../booking/templates'
import { escapeHtml } from '../utils/html'
// The iCal writer moved to utils/ical.ts so the CLASS confirmations can use it
// too — while it was private here, a class booking got no calendar invite on
// either the free or the paid path.
import { buildICalEvent, icalAttachment } from '../utils/ical'

// EVERY INTERPOLATED VALUE IS ESCAPED — the same rule booking/templates.ts
// states, applied here for the same reason. `bookAppointment` is a PUBLIC
// callable: the client's name, address, phone and notes arrive from an
// unauthenticated caller, and the provider notification below puts them in front
// of the coach. A value that must go out raw (a mail SUBJECT, which Brevo takes
// as its own field and `buildEmailTemplate` escapes for the HTML header) reads
// `params.x` explicitly.

type Lang = 'en' | 'de' | 'fr' | 'it'

const LOCALE_MAP: Record<Lang, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH' }

function formatDateTime(d: Date, lang: Lang): string {
  return d.toLocaleString(LOCALE_MAP[lang], {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich',
  })
}

function formatTime(d: Date, lang: Lang): string {
  return d.toLocaleTimeString(LOCALE_MAP[lang], {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Zurich',
  })
}

// ─── client confirmation ──────────────────────────────────────────────────────

interface ConfirmParams {
  firstname: string
  teamName: string
  slotTitle: string
  providerName: string
  start: Date
  end: Date
  location?: string | null
  onlineUrl?: string | null
  cancelUrl?: string | null
  /** Studio-authored plain-text note (activity override ?? team setting). */
  instructions?: string | null
  lang?: Lang
}

export function buildAppointmentConfirmationEmail(params: ConfirmParams) {
  const { start, end, onlineUrl, cancelUrl, instructions, lang = 'en' } = params
  const firstname = escapeHtml(params.firstname)
  const teamName = escapeHtml(params.teamName)
  const slotTitle = escapeHtml(params.slotTitle)
  const providerName = escapeHtml(params.providerName)
  const location = params.location ? escapeHtml(params.location) : params.location
  const dateStr = formatDateTime(start, lang)
  const endTime = formatTime(end, lang)

  const titles: Record<Lang, string> = {
    en: 'Appointment Confirmed',
    de: 'Termin bestätigt',
    fr: 'Rendez-vous confirmé',
    it: 'Appuntamento confermato',
  }
  const greetings: Record<Lang, string> = {
    en: `Hi ${firstname},`, de: `Hallo ${firstname},`, fr: `Bonjour ${firstname},`, it: `Ciao ${firstname},`,
  }
  const lines: Record<Lang, string[]> = {
    en: [
      `Your appointment with <strong>${teamName}</strong> has been confirmed.`,
      `<strong>Session:</strong> ${slotTitle}`,
      `<strong>Coach:</strong> ${providerName}`,
      `<strong>Date:</strong> ${dateStr} – ${endTime}`,
      location ? `<strong>Location:</strong> ${location}` : '',
      onlineUrl ? `<strong>Online:</strong> <a href="${onlineUrl}">${onlineUrl}</a>` : '',
      'A calendar invite (.ics) is attached to this email.',
    ],
    de: [
      `Ihr Termin bei <strong>${teamName}</strong> wurde bestätigt.`,
      `<strong>Sitzung:</strong> ${slotTitle}`,
      `<strong>Coach:</strong> ${providerName}`,
      `<strong>Datum:</strong> ${dateStr} – ${endTime}`,
      location ? `<strong>Ort:</strong> ${location}` : '',
      onlineUrl ? `<strong>Online:</strong> <a href="${onlineUrl}">${onlineUrl}</a>` : '',
      'Ein Kalender-Einladung (.ics) ist dieser E-Mail beigefügt.',
    ],
    fr: [
      `Votre rendez-vous avec <strong>${teamName}</strong> a été confirmé.`,
      `<strong>Séance :</strong> ${slotTitle}`,
      `<strong>Coach :</strong> ${providerName}`,
      `<strong>Date :</strong> ${dateStr} – ${endTime}`,
      location ? `<strong>Lieu :</strong> ${location}` : '',
      onlineUrl ? `<strong>En ligne :</strong> <a href="${onlineUrl}">${onlineUrl}</a>` : '',
      'Une invitation de calendrier (.ics) est jointe à cet e-mail.',
    ],
    it: [
      `Il tuo appuntamento con <strong>${teamName}</strong> è stato confermato.`,
      `<strong>Sessione:</strong> ${slotTitle}`,
      `<strong>Coach:</strong> ${providerName}`,
      `<strong>Data:</strong> ${dateStr} – ${endTime}`,
      location ? `<strong>Luogo:</strong> ${location}` : '',
      onlineUrl ? `<strong>Online:</strong> <a href="${onlineUrl}">${onlineUrl}</a>` : '',
      'Un invito al calendario (.ics) è allegato a questa email.',
    ],
  }
  const cancelLabels: Record<Lang, string> = {
    en: 'Cancel appointment', de: 'Termin absagen', fr: 'Annuler le rendez-vous', it: 'Annulla appuntamento',
  }
  // lines[lang] = [intro, ...facts, ics-note]
  const [intro, ...rest] = lines[lang]
  const icsNote = rest.pop() as string
  const body = [
    `<p>${greetings[lang]}</p>`,
    `<p>${intro}</p>`,
    detailsBox({ content: factLines(rest) }),
    ...(instructions?.trim() ? [instructionsBox(instructions, lang)] : []),
    `<p>${icsNote}</p>`,
    ...(cancelUrl
      ? [`<p style="text-align:center;margin-top:24px;">${ctaButton(cancelUrl, cancelLabels[lang])}</p>`]
      : []),
  ].join('\n')

  return buildEmailTemplate({ title: titles[lang], body })
}

export function buildAppointmentICalAttachment(params: {
  bookingId: string
  slotTitle: string
  start: Date
  end: Date
  location?: string | null
  providerName: string
  coachEmail: string
  clientName: string
  clientEmail: string
}): { filename: string; content: string; contentType: string } {
  const ical = buildICalEvent({
    uid: `appointment-${params.bookingId}@linyup.com`,
    title: params.slotTitle,
    start: params.start,
    end: params.end,
    location: params.location,
    organizer: { name: params.providerName, email: params.coachEmail },
    attendee: { name: params.clientName, email: params.clientEmail },
  })
  return icalAttachment('appointment.ics', ical)
}

// ─── coach notification ───────────────────────────────────────────────────────

interface CoachNotifParams {
  coachFirstname: string
  clientName: string
  clientEmail: string
  clientPhone?: string | null
  slotTitle: string
  start: Date
  end: Date
  notes?: string | null
  lang?: Lang
}

export function buildAppointmentProviderNotificationEmail(params: CoachNotifParams) {
  const { start, end, lang = 'en' } = params
  // The twin of `buildTeacherNotificationEmail`, and the same reasoning: four of
  // these come from an anonymous public booking payload and the message goes to
  // the COACH, who has every reason to trust it.
  const coachFirstname = escapeHtml(params.coachFirstname)
  const clientName = escapeHtml(params.clientName)
  const clientEmail = escapeHtml(params.clientEmail)
  const clientPhone = params.clientPhone ? escapeHtml(params.clientPhone) : params.clientPhone
  const slotTitle = escapeHtml(params.slotTitle)
  const notes = params.notes ? escapeHtml(params.notes) : params.notes
  const dateStr = formatDateTime(start, lang)
  const endTime = formatTime(end, lang)

  const titles: Record<Lang, string> = {
    en: `New appointment: ${params.clientName}`,
    de: `Neuer Termin: ${params.clientName}`,
    fr: `Nouveau rendez-vous : ${params.clientName}`,
    it: `Nuovo appuntamento: ${params.clientName}`,
  }
  const lines: Record<Lang, string[]> = {
    en: [
      `Hi ${coachFirstname}, a new appointment has been booked.`,
      `<strong>Session:</strong> ${slotTitle}`,
      `<strong>Client:</strong> ${clientName} (${clientEmail})${clientPhone ? ` · ${clientPhone}` : ''}`,
      `<strong>Date:</strong> ${dateStr} – ${endTime}`,
      notes ? `<strong>Notes:</strong> ${notes}` : '',
    ],
    de: [
      `Hallo ${coachFirstname}, ein neuer Termin wurde gebucht.`,
      `<strong>Sitzung:</strong> ${slotTitle}`,
      `<strong>Klient:</strong> ${clientName} (${clientEmail})${clientPhone ? ` · ${clientPhone}` : ''}`,
      `<strong>Datum:</strong> ${dateStr} – ${endTime}`,
      notes ? `<strong>Notizen:</strong> ${notes}` : '',
    ],
    fr: [
      `Bonjour ${coachFirstname}, un nouveau rendez-vous a été réservé.`,
      `<strong>Séance :</strong> ${slotTitle}`,
      `<strong>Client :</strong> ${clientName} (${clientEmail})${clientPhone ? ` · ${clientPhone}` : ''}`,
      `<strong>Date :</strong> ${dateStr} – ${endTime}`,
      notes ? `<strong>Notes :</strong> ${notes}` : '',
    ],
    it: [
      `Ciao ${coachFirstname}, è stato prenotato un nuovo appuntamento.`,
      `<strong>Sessione:</strong> ${slotTitle}`,
      `<strong>Cliente:</strong> ${clientName} (${clientEmail})${clientPhone ? ` · ${clientPhone}` : ''}`,
      `<strong>Data:</strong> ${dateStr} – ${endTime}`,
      notes ? `<strong>Note:</strong> ${notes}` : '',
    ],
  }
  const [greeting, ...factList] = lines[lang]
  const body = [`<p>${greeting}</p>`, detailsBox({ content: factLines(factList) })].join('\n')
  return buildEmailTemplate({ title: titles[lang], body })
}

// ─── cancellation confirmation ────────────────────────────────────────────────

interface CancelParams {
  firstname: string
  teamName: string
  slotTitle: string
  start: Date
  lang?: Lang
}

export function buildAppointmentCancellationEmail(params: CancelParams) {
  const { start, lang = 'en' } = params
  const firstname = escapeHtml(params.firstname)
  const teamName = escapeHtml(params.teamName)
  const slotTitle = escapeHtml(params.slotTitle)
  const dateStr = formatDateTime(start, lang)

  const titles: Record<Lang, string> = {
    en: 'Appointment Canceled', de: 'Termin abgesagt', fr: 'Rendez-vous annulé', it: 'Appuntamento annullato',
  }
  const bodies: Record<Lang, string> = {
    en: `<p>Hi ${firstname},</p><p>Your <strong>${slotTitle}</strong> appointment with ${teamName} on ${dateStr} has been canceled.</p>`,
    de: `<p>Hallo ${firstname},</p><p>Ihr <strong>${slotTitle}</strong>-Termin bei ${teamName} am ${dateStr} wurde abgesagt.</p>`,
    fr: `<p>Bonjour ${firstname},</p><p>Votre rendez-vous <strong>${slotTitle}</strong> avec ${teamName} le ${dateStr} a été annulé.</p>`,
    it: `<p>Ciao ${firstname},</p><p>Il tuo appuntamento <strong>${slotTitle}</strong> con ${teamName} del ${dateStr} è stato annullato.</p>`,
  }
  return buildEmailTemplate({ title: titles[lang], body: bodies[lang] })
}
