import { buildEmailTemplate } from '../utils/email'
import { detailsBox, ctaButton, factLines, BRAND } from '../utils/emailLayout'
import { escapeHtml } from '../utils/html'
import { buildICalEvent, icalAttachment, ICAL_FALLBACK_ORGANIZER_EMAIL } from '../utils/ical'

// Localized heading for the studio's custom instructions box (confirmation emails).
const INSTRUCTIONS_TITLES: Record<'en' | 'de' | 'fr' | 'it', string> = {
  en: 'Important',
  de: 'Wichtig',
  fr: 'Important',
  it: 'Importante',
}

// Localized heading for the cancellation policy box (confirmation emails).
const POLICY_TITLES: Record<'en' | 'de' | 'fr' | 'it', string> = {
  en: 'Cancellation policy',
  de: 'Stornobedingungen',
  fr: "Politique d'annulation",
  it: 'Politica di cancellazione',
}

/** Studio-authored plain-text instructions → highlighted box. Text is escaped,
 *  newlines become <br>, and bare URLs become clickable links. */
export function instructionsBox(instructions: string, lang: 'en' | 'de' | 'fr' | 'it'): string {
  const html = escapeHtml(instructions.trim())
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:inherit;">$1</a>')
    .replace(/\n/g, '<br>')
  return detailsBox({ title: INSTRUCTIONS_TITLES[lang], content: `<p style="margin:0;">${html}</p>` })
}

/** Same shape as `instructionsBox`, titled for the cancellation policy. */
export function cancellationPolicyBox(policy: string, lang: 'en' | 'de' | 'fr' | 'it'): string {
  const html = escapeHtml(policy.trim())
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:inherit;">$1</a>')
    .replace(/\n/g, '<br>')
  return detailsBox({ title: POLICY_TITLES[lang], content: `<p style="margin:0;">${html}</p>` })
}

type Lang = 'en' | 'de' | 'fr' | 'it'

function formatDate(d: Date, lang: Lang): string {
  const localeMap: Record<Lang, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH' }
  return d.toLocaleString(localeMap[lang], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Zurich',
  })
}

function formatTime(d: Date, lang: Lang): string {
  const localeMap: Record<Lang, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH' }
  return d.toLocaleTimeString(localeMap[lang], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Zurich',
  })
}

/** Day + time, no year — the compact form SMS copy uses, where every character
 *  is charged for and the recipient already knows what month it is. */
function formatShortDateTime(d: Date, lang: Lang): string {
  const localeMap: Record<Lang, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH' }
  return d.toLocaleString(localeMap[lang], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Zurich',
  })
}

interface ConfirmationParams {
  firstname: string
  teamName: string
  activityName: string
  sessionStart: Date
  sessionEnd: Date
  locationName?: string | null
  manageBookingUrl?: string | null
  /** The contact's own portal (`/public/{slug}/space`) — bookings, membership,
   *  profile. Sent on BOTH the free and the paid path: per UX-C2-5 the only
   *  place a booker ever hears that the portal exists is this email. */
  spaceUrl?: string | null
  /** Studio-authored plain-text note (activity override ?? team setting). */
  instructions?: string | null
  /** Cancellation/refund policy (activity override ?? team default). */
  cancellationPolicy?: string | null
  /** Short human-readable code (e.g. "BK-7F3K9Q") for phone/desk lookups. */
  reference?: string | null
  /** Set ONLY when this booking was paid for — money or stored value — which
   *  turns the confirmation into the receipt for it. Major units, so
   *  `{ amount: 25, currency: 'CHF' }` reads "CHF 25.00". */
  paid?: { amount: number; currency: string } | null
  /** Set by `buildClassBookingConfirmationMail`, which attaches the file. Never
   *  set by hand: it prints "a calendar invite is attached". */
  calendarAttached?: boolean
  lang?: Lang
}

export function buildBookingConfirmationEmail(params: ConfirmationParams) {
  const {
    sessionStart,
    sessionEnd,
    manageBookingUrl,
    spaceUrl,
    instructions,
    cancellationPolicy,
    reference,
    paid,
    lang = 'en',
  } = params
  // THE ESCAPING IDIOM THIS FILE USES, and the reason it shadows: every
  // interpolated string is escaped once at the top under the name the template
  // below reaches for, so a line added later cannot pick up a raw value by using
  // the obvious identifier. `firstname` here is typed by a guest on a public
  // form. Where a value must go out RAW — a mail SUBJECT, which Brevo takes as
  // its own API field and `buildEmailTemplate` escapes for the HTML header — the
  // template reads `params.x` explicitly, and that explicitness is the signal.
  const firstname = escapeHtml(params.firstname)
  const teamName = escapeHtml(params.teamName)
  const activityName = escapeHtml(params.activityName)
  const locationName = params.locationName ? escapeHtml(params.locationName) : params.locationName

  const date = formatDate(sessionStart, lang)
  const endTime = formatTime(sessionEnd, lang)

  const titles: Record<Lang, string> = {
    en: 'Booking Confirmed',
    de: 'Buchung bestätigt',
    fr: 'Réservation confirmée',
    it: 'Prenotazione confermata',
  }

  const greetings: Record<Lang, string> = {
    en: `Hi ${firstname},`,
    de: `Hallo ${firstname},`,
    fr: `Bonjour ${firstname},`,
    it: `Ciao ${firstname},`,
  }

  const intros: Record<Lang, string> = {
    en: `Your session at <strong>${teamName}</strong> has been confirmed.`,
    de: `Ihre Sitzung bei <strong>${teamName}</strong> wurde bestätigt.`,
    fr: `Votre session chez <strong>${teamName}</strong> a été confirmée.`,
    it: `La tua sessione presso <strong>${teamName}</strong> è stata confermata.`,
  }

  // "CHF 25.00" — the currency code as the studio's Stripe account reports it,
  // and two decimals because this line is a receipt, not a price tag.
  const paidLine = paid
    ? `${escapeHtml(paid.currency.toUpperCase())} ${paid.amount.toFixed(2)}`
    : null

  const facts: Record<Lang, string[]> = {
    en: [
      `<strong>Activity:</strong> ${activityName}`,
      `<strong>Date:</strong> ${date} – ${endTime}`,
      locationName ? `<strong>Location:</strong> ${locationName}` : '',
      reference ? `<strong>Reference:</strong> ${escapeHtml(reference)}` : '',
      paidLine ? `<strong>Paid:</strong> ${paidLine}` : '',
    ],
    de: [
      `<strong>Aktivität:</strong> ${activityName}`,
      `<strong>Datum:</strong> ${date} – ${endTime}`,
      locationName ? `<strong>Ort:</strong> ${locationName}` : '',
      reference ? `<strong>Referenz:</strong> ${escapeHtml(reference)}` : '',
      paidLine ? `<strong>Bezahlt:</strong> ${paidLine}` : '',
    ],
    fr: [
      `<strong>Activité :</strong> ${activityName}`,
      `<strong>Date :</strong> ${date} – ${endTime}`,
      locationName ? `<strong>Lieu :</strong> ${locationName}` : '',
      reference ? `<strong>Référence :</strong> ${escapeHtml(reference)}` : '',
      paidLine ? `<strong>Payé :</strong> ${paidLine}` : '',
    ],
    it: [
      `<strong>Attività:</strong> ${activityName}`,
      `<strong>Data:</strong> ${date} – ${endTime}`,
      locationName ? `<strong>Luogo:</strong> ${locationName}` : '',
      reference ? `<strong>Riferimento:</strong> ${escapeHtml(reference)}` : '',
      paidLine ? `<strong>Pagato:</strong> ${paidLine}` : '',
    ],
  }

  const closings: Record<Lang, string> = {
    en: 'We look forward to seeing you!',
    de: 'Wir freuen uns auf Sie!',
    fr: 'Nous avons hâte de vous voir !',
    it: "Non vediamo l'ora di vederti!",
  }

  const manageLabels: Record<Lang, string> = {
    en: 'Manage / Cancel Booking',
    de: 'Buchung verwalten / stornieren',
    fr: 'Gérer / Annuler la réservation',
    it: 'Gestisci / Annulla prenotazione',
  }

  // Only ever true when the caller really is attaching the file — a mail that
  // announces an invite it did not send is worse than one that stays quiet.
  const icsNotes: Record<Lang, string> = {
    en: 'A calendar invite (.ics) is attached to this email.',
    de: 'Eine Kalender-Einladung (.ics) ist dieser E-Mail beigefügt.',
    fr: 'Une invitation de calendrier (.ics) est jointe à cet e-mail.',
    it: 'Un invito al calendario (.ics) è allegato a questa email.',
  }

  // The Space is mentioned in prose, under the manage button, rather than as a
  // second CTA: one booking has one primary action, and this line exists to tell
  // a first-time buyer that the portal is there at all.
  const spaceLines: Record<Lang, string> = {
    en: `You can see this booking, your membership and your courses any time in your <a href="${spaceUrl}">member area</a> — sign in with this email address, no password needed.`,
    de: `Diese Buchung, Ihre Mitgliedschaft und Ihre Kurse finden Sie jederzeit in Ihrem <a href="${spaceUrl}">Mitgliederbereich</a> — Anmeldung mit dieser E-Mail-Adresse, ohne Passwort.`,
    fr: `Vous pouvez consulter cette réservation, votre abonnement et vos cours à tout moment dans votre <a href="${spaceUrl}">espace membre</a> — connexion avec cette adresse e-mail, sans mot de passe.`,
    it: `Puoi vedere questa prenotazione, il tuo abbonamento e i tuoi corsi in qualsiasi momento nella tua <a href="${spaceUrl}">area riservata</a> — accesso con questo indirizzo e-mail, senza password.`,
  }

  const body = [
    `<p>${greetings[lang]}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({ content: factLines(facts[lang]) }),
    instructions?.trim() ? instructionsBox(instructions, lang) : '',
    cancellationPolicy?.trim() ? cancellationPolicyBox(cancellationPolicy, lang) : '',
    params.calendarAttached ? `<p>${icsNotes[lang]}</p>` : '',
    `<p>${closings[lang]}</p>`,
    manageBookingUrl
      ? `<p style="text-align:center;margin-top:24px;">${ctaButton(manageBookingUrl, manageLabels[lang])}</p>`
      : '',
    spaceUrl ? `<p style="font-size:14px;">${spaceLines[lang]}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return buildEmailTemplate({ title: titles[lang], body })
}

/** The mail SUBJECT for a class booking confirmation, in one place: three call
 *  sites send this message (free booking, free waitlist claim, paid drop-in) and
 *  a receipt whose subject differed by tender would read as a different mail. */
export const BOOKING_CONFIRMATION_SUBJECTS: Record<Lang, (activityName: string) => string> = {
  en: (a) => `Booking Confirmed – ${a}`,
  de: (a) => `Buchung bestätigt – ${a}`,
  fr: (a) => `Réservation confirmée – ${a}`,
  it: (a) => `Prenotazione confermata – ${a}`,
}

/**
 * The class booking confirmation, ready to hand to `sendEmail` — subject, body
 * and the calendar invite.
 *
 * It exists because there are three senders of this one message and they had
 * drifted: the free path built it inline, the waitlist claim built it inline
 * again, and the PAID path did not build it at all (UX-76). A class booking had
 * no `.ics` on any of them, because the iCal writer was private to the
 * appointments module.
 */
export function buildClassBookingConfirmationMail(
  params: ConfirmationParams & {
    /** Stable per booking (`{sessionId}-{contactId}`) so a re-sent invite
     *  UPDATES the calendar entry instead of adding a second one. */
    bookingId: string
    attendeeName: string
    attendeeEmail: string
    /** The studio's published address (`getTeamContactEmail`), if it has one. */
    organizerEmail?: string | null
  }
): {
  subject: string
  html: string
  text: string
  attachments: { filename: string; content: string; contentType: string }[]
} {
  const lang = params.lang ?? 'en'
  const { html, text } = buildBookingConfirmationEmail({ ...params, calendarAttached: true })
  const ics = buildICalEvent({
    uid: `booking-${params.bookingId}@linyup.com`,
    title: params.activityName,
    start: params.sessionStart,
    end: params.sessionEnd,
    location: params.locationName,
    organizer: {
      name: params.teamName,
      email: params.organizerEmail?.trim() || ICAL_FALLBACK_ORGANIZER_EMAIL,
    },
    attendee: { name: params.attendeeName, email: params.attendeeEmail },
  })
  return {
    subject: BOOKING_CONFIRMATION_SUBJECTS[lang](params.activityName),
    html,
    text,
    attachments: [icalAttachment('booking.ics', ics)],
  }
}

interface ReminderParams {
  firstname: string
  teamName: string
  activityName: string
  sessionStart: Date
  sessionEnd: Date
  locationName?: string | null
  locationAddress?: string | null
  manageBookingUrl?: string | null
  lang?: Lang
}

export function buildBookingReminderEmail(params: ReminderParams) {
  const { sessionStart, sessionEnd, manageBookingUrl, lang = 'en' } = params
  const firstname = escapeHtml(params.firstname)
  const teamName = escapeHtml(params.teamName)
  const activityName = escapeHtml(params.activityName)
  const locationName = params.locationName ? escapeHtml(params.locationName) : params.locationName
  const locationAddress = params.locationAddress
    ? escapeHtml(params.locationAddress)
    : params.locationAddress

  const date = formatDate(sessionStart, lang)
  const endTime = formatTime(sessionEnd, lang)

  const titles: Record<Lang, string> = {
    en: 'Session Reminder',
    de: 'Terminerinnerung',
    fr: 'Rappel de session',
    it: 'Promemoria sessione',
  }

  const greetings: Record<Lang, string> = {
    en: `Hi ${firstname},`,
    de: `Hallo ${firstname},`,
    fr: `Bonjour ${firstname},`,
    it: `Ciao ${firstname},`,
  }

  const intros: Record<Lang, string> = {
    en: `This is a reminder for your upcoming session at <strong>${teamName}</strong>.`,
    de: `Dies ist eine Erinnerung für Ihre bevorstehende Sitzung bei <strong>${teamName}</strong>.`,
    fr: `Voici un rappel pour votre prochaine session chez <strong>${teamName}</strong>.`,
    it: `Questo è un promemoria per la tua prossima sessione presso <strong>${teamName}</strong>.`,
  }

  const locationLabels: Record<Lang, string> = {
    en: 'Location',
    de: 'Ort',
    fr: 'Lieu',
    it: 'Luogo',
  }

  const manageLabels: Record<Lang, string> = {
    en: 'Manage / Cancel Booking',
    de: 'Buchung verwalten / stornieren',
    fr: 'Gérer / Annuler la réservation',
    it: 'Gestisci / Annulla prenotazione',
  }

  const activityLabels: Record<Lang, string> = {
    en: 'Activity',
    de: 'Aktivität',
    fr: 'Activité',
    it: 'Attività',
  }

  const dateLabels: Record<Lang, string> = {
    en: 'Date',
    de: 'Datum',
    fr: 'Date',
    it: 'Data',
  }

  const locationLine = locationName
    ? `<strong>${locationLabels[lang]}:</strong> ${locationName}${locationAddress ? `, ${locationAddress}` : ''}`
    : ''

  const body = [
    `<p>${greetings[lang]}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({
      content: factLines([
        `<strong>${activityLabels[lang]}:</strong> ${activityName}`,
        `<strong>${dateLabels[lang]}:</strong> ${date} – ${endTime}`,
        locationLine,
      ]),
    }),
    manageBookingUrl
      ? `<p style="text-align:center;margin-top:24px;">${ctaButton(manageBookingUrl, manageLabels[lang])}</p>`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  return buildEmailTemplate({ title: titles[lang], body })
}

// Single-segment SMS reminder (~160 chars incl. the alphanumeric sender). Kept
// deliberately terse: team, activity, day+time, location. The manage-booking
// link is left to the email steps — URLs blow the segment budget.
export function buildBookingReminderSms(params: {
  teamName: string
  activityName: string
  sessionStart: Date
  locationName?: string | null
  lang?: Lang
}): string {
  const { teamName, activityName, sessionStart, locationName, lang = 'en' } = params
  const when = formatShortDateTime(sessionStart, lang)
  const reminders: Record<Lang, string> = {
    en: 'Reminder',
    de: 'Erinnerung',
    fr: 'Rappel',
    it: 'Promemoria',
  }
  const location = locationName ? ` @ ${locationName}` : ''
  return `${teamName}: ${reminders[lang]} — ${activityName}, ${when}${location}`
}

interface NotificationParams {
  teamOwnerFirstname: string
  contactName: string
  contactEmail: string
  contactPhone?: string | null
  activityName: string
  sessionStart: Date
  sessionEnd: Date
  lang?: Lang
}

export function buildTeacherNotificationEmail(params: NotificationParams) {
  const { sessionStart, sessionEnd, lang = 'en' } = params
  // THE HIGHEST-VALUE ESCAPE IN THIS FILE. `contactName`, `contactEmail` and
  // `contactPhone` are typed by an anonymous guest on a public booking form, and
  // this message is delivered to the STUDIO — so unescaped they put attacker-
  // authored markup and links in front of the one reader who trusts this mail
  // most. The booker's own confirmation is self-injection; this one is not.
  const teamOwnerFirstname = escapeHtml(params.teamOwnerFirstname)
  const contactName = escapeHtml(params.contactName)
  const contactEmail = escapeHtml(params.contactEmail)
  const contactPhone = params.contactPhone ? escapeHtml(params.contactPhone) : params.contactPhone
  const activityName = escapeHtml(params.activityName)

  const date = formatDate(sessionStart, lang)
  const endTime = formatTime(sessionEnd, lang)

  const titles: Record<Lang, string> = {
    en: `New Booking: ${params.contactName}`,
    de: `Neue Buchung: ${params.contactName}`,
    fr: `Nouvelle réservation : ${params.contactName}`,
    it: `Nuova prenotazione: ${params.contactName}`,
  }

  const lines: Record<Lang, string[]> = {
    en: [
      `Hi ${teamOwnerFirstname}, a new booking has been made.`,
      `<strong>Contact:</strong> ${contactName} (${contactEmail})${contactPhone ? ` – ${contactPhone}` : ''}`,
      `<strong>Activity:</strong> ${activityName}`,
      `<strong>Date:</strong> ${date} – ${endTime}`,
    ],
    de: [
      `Hallo ${teamOwnerFirstname}, eine neue Buchung ist eingegangen.`,
      `<strong>Kontakt:</strong> ${contactName} (${contactEmail})${contactPhone ? ` – ${contactPhone}` : ''}`,
      `<strong>Aktivität:</strong> ${activityName}`,
      `<strong>Datum:</strong> ${date} – ${endTime}`,
    ],
    fr: [
      `Bonjour ${teamOwnerFirstname}, une nouvelle réservation vient d'être effectuée.`,
      `<strong>Contact :</strong> ${contactName} (${contactEmail})${contactPhone ? ` – ${contactPhone}` : ''}`,
      `<strong>Activité :</strong> ${activityName}`,
      `<strong>Date :</strong> ${date} – ${endTime}`,
    ],
    it: [
      `Ciao ${teamOwnerFirstname}, è stata effettuata una nuova prenotazione.`,
      `<strong>Contatto:</strong> ${contactName} (${contactEmail})${contactPhone ? ` – ${contactPhone}` : ''}`,
      `<strong>Attività:</strong> ${activityName}`,
      `<strong>Data:</strong> ${date} – ${endTime}`,
    ],
  }

  const [greeting, ...factList] = lines[lang]
  const body = [`<p>${greeting}</p>`, detailsBox({ content: factLines(factList) })].join('\n')
  return buildEmailTemplate({ title: titles[lang], body })
}

interface VerificationCodeParams {
  code: string
  teamName: string
  expiresInMinutes: number
  lang?: Lang
}

export function buildVerificationCodeEmail(params: VerificationCodeParams) {
  const { expiresInMinutes, lang = 'en' } = params
  const code = escapeHtml(params.code)

  const titles: Record<Lang, string> = {
    en: `Your verification code for ${params.teamName}`,
    de: `Ihr Verifizierungscode für ${params.teamName}`,
    fr: `Votre code de vérification pour ${params.teamName}`,
    it: `Il tuo codice di verifica per ${params.teamName}`,
  }

  const codeStyle = `font-size:2rem;font-weight:bold;letter-spacing:0.25em;color:${BRAND.primaryDeep};text-align:center;`
  const bodies: Record<Lang, string> = {
    en: `<p>Your verification code is:</p><p style="${codeStyle}">${code}</p><p>This code expires in ${expiresInMinutes} minutes. Do not share it.</p>`,
    de: `<p>Ihr Verifizierungscode lautet:</p><p style="${codeStyle}">${code}</p><p>Dieser Code läuft in ${expiresInMinutes} Minuten ab. Geben Sie ihn nicht weiter.</p>`,
    fr: `<p>Votre code de vérification est :</p><p style="${codeStyle}">${code}</p><p>Ce code expire dans ${expiresInMinutes} minutes. Ne le partagez pas.</p>`,
    it: `<p>Il tuo codice di verifica è:</p><p style="${codeStyle}">${code}</p><p>Questo codice scade in ${expiresInMinutes} minuti. Non condividerlo.</p>`,
  }

  return buildEmailTemplate({ title: titles[lang], body: bodies[lang] })
}

// ─── Waitlist ────────────────────────────────────────────────────────────────
// The three moments a queue has to speak for itself: joining it, being offered a
// seat, and losing that offer to the clock. The offer mail is the one that
// matters — it carries the single-use claim token, so it is the ONLY thing
// standing between a held seat and a seat destroyed in silence.
//
// The three mails share their fact-box labels — they describe the same class
// three times, and a "Class:" that reads differently between them would look
// like three different systems writing to one person. The SENTENCES stay
// per-builder: they are prose, not columns.

/** A waitlist entry can carry an empty firstname (a contact record that never
 *  had one), and "Hi ," is worse than no name at all. */
function greetingLine(firstname: string, lang: Lang): string {
  const named: Record<Lang, string> = {
    en: `Hi ${firstname},`,
    de: `Hallo ${firstname},`,
    fr: `Bonjour ${firstname},`,
    it: `Ciao ${firstname},`,
  }
  const bare: Record<Lang, string> = { en: 'Hi,', de: 'Hallo,', fr: 'Bonjour,', it: 'Ciao,' }
  return firstname.trim() ? named[lang] : bare[lang]
}

const WAITLIST_CLASS_LABELS: Record<Lang, string> = {
  en: 'Class',
  de: 'Kurs',
  fr: 'Cours',
  it: 'Corso',
}

const WAITLIST_DATE_LABELS: Record<Lang, string> = {
  en: 'Date',
  de: 'Datum',
  fr: 'Date',
  it: 'Data',
}

const WAITLIST_LOCATION_LABELS: Record<Lang, string> = {
  en: 'Location',
  de: 'Ort',
  fr: 'Lieu',
  it: 'Luogo',
}

interface WaitlistJoinedParams {
  firstname: string
  teamName: string
  activityName: string
  sessionStart: Date
  sessionEnd: Date
  locationName?: string | null
  /** 1-based, derived at join. */
  position: number
  /** The long-lived `entry_token` link — status and "leave the waitlist". Never
   *  a claim credential: this mail gets forwarded. */
  statusUrl?: string | null
  lang?: Lang
}

export function buildWaitlistJoinedEmail(params: WaitlistJoinedParams) {
  const { sessionStart, sessionEnd, position, statusUrl, lang = 'en' } = params
  const firstname = escapeHtml(params.firstname)
  const teamName = escapeHtml(params.teamName)
  const activityName = escapeHtml(params.activityName)
  const locationName = params.locationName ? escapeHtml(params.locationName) : params.locationName

  const date = formatDate(sessionStart, lang)
  const endTime = formatTime(sessionEnd, lang)

  const titles: Record<Lang, string> = {
    en: "You're on the waitlist",
    de: 'Sie stehen auf der Warteliste',
    fr: "Vous êtes sur la liste d'attente",
    it: "Sei in lista d'attesa",
  }

  const intros: Record<Lang, string> = {
    en: `You are on the waitlist for <strong>${activityName}</strong> at <strong>${teamName}</strong>.`,
    de: `Sie stehen auf der Warteliste für <strong>${activityName}</strong> bei <strong>${teamName}</strong>.`,
    fr: `Vous êtes sur la liste d'attente pour <strong>${activityName}</strong> chez <strong>${teamName}</strong>.`,
    it: `Sei in lista d'attesa per <strong>${activityName}</strong> presso <strong>${teamName}</strong>.`,
  }

  const positionLabels: Record<Lang, string> = {
    en: 'Your position',
    de: 'Ihre Position',
    fr: 'Votre position',
    it: 'La tua posizione',
  }

  const explainers: Record<Lang, string> = {
    en: 'If a place frees up, we will email you and hold it for you for a limited time. The place is only yours once you claim it, so keep an eye on your inbox.',
    de: 'Wird ein Platz frei, benachrichtigen wir Sie per E-Mail und halten ihn für eine begrenzte Zeit für Sie frei. Der Platz gehört Ihnen erst, wenn Sie ihn bestätigen — behalten Sie also Ihren Posteingang im Auge.',
    fr: "Si une place se libère, nous vous enverrons un e-mail et la garderons pour vous pendant un temps limité. La place n'est à vous qu'une fois confirmée : surveillez votre boîte de réception.",
    it: "Se si libera un posto, ti invieremo un'e-mail e lo terremo per te per un tempo limitato. Il posto è tuo solo dopo la conferma: tieni d'occhio la posta in arrivo.",
  }

  const statusLabels: Record<Lang, string> = {
    en: 'View or leave the waitlist',
    de: 'Warteliste ansehen oder verlassen',
    fr: "Voir ou quitter la liste d'attente",
    it: "Vedi o lascia la lista d'attesa",
  }

  const body = [
    `<p>${greetingLine(firstname, lang)}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({
      content: factLines([
        `<strong>${WAITLIST_CLASS_LABELS[lang]}:</strong> ${activityName}`,
        `<strong>${WAITLIST_DATE_LABELS[lang]}:</strong> ${date} – ${endTime}`,
        locationName ? `<strong>${WAITLIST_LOCATION_LABELS[lang]}:</strong> ${locationName}` : '',
        `<strong>${positionLabels[lang]}:</strong> ${position}`,
      ]),
    }),
    `<p>${explainers[lang]}</p>`,
    statusUrl
      ? `<p style="text-align:center;margin-top:24px;">${ctaButton(statusUrl, statusLabels[lang])}</p>`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return buildEmailTemplate({ title: titles[lang], body })
}

interface WaitlistOfferParams {
  firstname: string
  teamName: string
  activityName: string
  sessionStart: Date
  sessionEnd: Date
  locationName?: string | null
  /** The claim page, carrying the single-use `offer_token`. */
  claimUrl: string
  /** THE deadline — the same instant the hold and (for a paid claim) the Stripe
   *  session die at. */
  expiresAt: Date
  lang?: Lang
}

export function buildWaitlistOfferEmail(params: WaitlistOfferParams) {
  const { sessionStart, sessionEnd, claimUrl, expiresAt, lang = 'en' } = params
  const firstname = escapeHtml(params.firstname)
  const teamName = escapeHtml(params.teamName)
  const activityName = escapeHtml(params.activityName)
  const locationName = params.locationName ? escapeHtml(params.locationName) : params.locationName

  const date = formatDate(sessionStart, lang)
  const endTime = formatTime(sessionEnd, lang)
  const deadline = formatDate(expiresAt, lang)

  const titles: Record<Lang, string> = {
    en: 'A place has opened up',
    de: 'Ein Platz ist frei geworden',
    fr: "Une place s'est libérée",
    it: 'Si è liberato un posto',
  }

  const intros: Record<Lang, string> = {
    en: `A place has opened up in <strong>${activityName}</strong> at <strong>${teamName}</strong>, and we are holding it for you.`,
    de: `In <strong>${activityName}</strong> bei <strong>${teamName}</strong> ist ein Platz frei geworden — wir halten ihn für Sie.`,
    fr: `Une place s'est libérée pour <strong>${activityName}</strong> chez <strong>${teamName}</strong> et nous la gardons pour vous.`,
    it: `Si è liberato un posto per <strong>${activityName}</strong> presso <strong>${teamName}</strong> e lo stiamo tenendo per te.`,
  }

  const deadlineLabels: Record<Lang, string> = {
    en: 'Claim by',
    de: 'Bestätigen bis',
    fr: 'À confirmer avant',
    it: 'Da confermare entro',
  }

  // The whole point of the mail: the hold is real, and it is not forever.
  const urgencies: Record<Lang, string> = {
    en: `The place is yours once you claim it. If it is not claimed by <strong>${deadline}</strong>, it goes to the next person on the list.`,
    de: `Der Platz gehört Ihnen, sobald Sie ihn bestätigen. Bleibt er bis <strong>${deadline}</strong> unbestätigt, geht er an die nächste Person auf der Liste.`,
    fr: `La place est à vous dès que vous la confirmez. Sans confirmation avant le <strong>${deadline}</strong>, elle passe à la personne suivante sur la liste.`,
    it: `Il posto è tuo non appena lo confermi. Se non viene confermato entro <strong>${deadline}</strong>, passa alla persona successiva in lista.`,
  }

  const claimLabels: Record<Lang, string> = {
    en: 'Claim my place',
    de: 'Platz sichern',
    fr: 'Confirmer ma place',
    it: 'Conferma il mio posto',
  }

  const body = [
    `<p>${greetingLine(firstname, lang)}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({
      content: factLines([
        `<strong>${WAITLIST_CLASS_LABELS[lang]}:</strong> ${activityName}`,
        `<strong>${WAITLIST_DATE_LABELS[lang]}:</strong> ${date} – ${endTime}`,
        locationName ? `<strong>${WAITLIST_LOCATION_LABELS[lang]}:</strong> ${locationName}` : '',
        `<strong>${deadlineLabels[lang]}:</strong> ${deadline}`,
      ]),
    }),
    `<p>${urgencies[lang]}</p>`,
    `<p style="text-align:center;margin-top:24px;">${ctaButton(claimUrl, claimLabels[lang])}</p>`,
  ]
    .filter(Boolean)
    .join('\n')

  return buildEmailTemplate({ title: titles[lang], body })
}

/**
 * The nudge, not the credential. No URL, deliberately: a claim link carries a
 * 64-character token and would push every offer to a second charged segment,
 * and the email carrying that link goes out at the same instant on every offer.
 * Same reasoning as `buildBookingReminderSms`.
 */
export function buildWaitlistOfferSms(params: {
  teamName: string
  activityName: string
  sessionStart: Date
  expiresAt: Date
  lang?: Lang
}): string {
  const { teamName, activityName, sessionStart, expiresAt, lang = 'en' } = params
  const when = formatShortDateTime(sessionStart, lang)
  const deadline = formatShortDateTime(expiresAt, lang)
  const bodies: Record<Lang, string> = {
    en: `place free for ${activityName}, ${when}. Check your email to claim it by ${deadline}.`,
    de: `Platz frei für ${activityName}, ${when}. E-Mail prüfen und bis ${deadline} sichern.`,
    fr: `place libre pour ${activityName}, ${when}. Consultez votre e-mail pour la confirmer avant ${deadline}.`,
    it: `posto libero per ${activityName}, ${when}. Controlla l'e-mail e conferma entro ${deadline}.`,
  }
  return `${teamName}: ${bodies[lang]}`
}

interface WaitlistExpiredParams {
  firstname: string
  teamName: string
  activityName: string
  sessionStart: Date
  /** Back to the public booking page for this class, so re-joining is one click
   *  — the queue has no re-queue machinery by design (one offer per entry). */
  rejoinUrl?: string | null
  lang?: Lang
}

export function buildWaitlistExpiredEmail(params: WaitlistExpiredParams) {
  const { sessionStart, rejoinUrl, lang = 'en' } = params
  const firstname = escapeHtml(params.firstname)
  const teamName = escapeHtml(params.teamName)
  const activityName = escapeHtml(params.activityName)

  const date = formatDate(sessionStart, lang)

  const titles: Record<Lang, string> = {
    en: 'Your place was not claimed in time',
    de: 'Ihr Platz wurde nicht rechtzeitig bestätigt',
    fr: "Votre place n'a pas été confirmée à temps",
    it: 'Il tuo posto non è stato confermato in tempo',
  }

  const intros: Record<Lang, string> = {
    en: `The place we were holding for you in <strong>${activityName}</strong> (${date}) at <strong>${teamName}</strong> was not claimed in time, so it has gone to the next person on the list.`,
    de: `Der Platz, den wir für Sie in <strong>${activityName}</strong> (${date}) bei <strong>${teamName}</strong> reserviert hatten, wurde nicht rechtzeitig bestätigt und ist an die nächste Person auf der Liste gegangen.`,
    fr: `La place que nous gardions pour vous en <strong>${activityName}</strong> (${date}) chez <strong>${teamName}</strong> n'a pas été confirmée à temps : elle est passée à la personne suivante sur la liste.`,
    it: `Il posto che tenevamo per te in <strong>${activityName}</strong> (${date}) presso <strong>${teamName}</strong> non è stato confermato in tempo ed è passato alla persona successiva in lista.`,
  }

  const outros: Record<Lang, string> = {
    en: 'You are no longer on the waitlist for this class. If you would still like to come, you can join the list again.',
    de: 'Sie stehen nicht mehr auf der Warteliste für diesen Kurs. Wenn Sie weiterhin teilnehmen möchten, können Sie sich erneut eintragen.',
    fr: "Vous n'êtes plus sur la liste d'attente pour ce cours. Si vous souhaitez toujours venir, vous pouvez vous réinscrire sur la liste.",
    it: "Non sei più in lista d'attesa per questo corso. Se vuoi ancora partecipare, puoi iscriverti di nuovo alla lista.",
  }

  const rejoinLabels: Record<Lang, string> = {
    en: 'Join the waitlist again',
    de: 'Erneut auf die Warteliste',
    fr: "Rejoindre la liste d'attente",
    it: "Torna in lista d'attesa",
  }

  const body = [
    `<p>${greetingLine(firstname, lang)}</p>`,
    `<p>${intros[lang]}</p>`,
    `<p>${outros[lang]}</p>`,
    rejoinUrl
      ? `<p style="text-align:center;margin-top:24px;">${ctaButton(rejoinUrl, rejoinLabels[lang])}</p>`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return buildEmailTemplate({ title: titles[lang], body })
}
