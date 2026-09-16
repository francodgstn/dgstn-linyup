// ─── The member recap email ───────────────────────────────────────────────────
//
// THE ONE place the recap's wording lives: the greeting, the two labels, the
// sign-off and the subject, in the four languages. Shared rather than kept in
// functions because the send dialog on the contact page shows the studio the
// message AS IT WILL ARRIVE — and a preview assembled from a second copy of the
// wording is a preview that drifts from the email the day one of them is edited.
//
// The two parts are the model's (`ContactAiSummary.member`), edited by the studio
// in the dialog. Everything around them is fixed copy, in the language the
// summary was written in, which is the studio's authoring language — the same
// language the parts are in, so a German recap never arrives with English labels.
//
// DU, TU, TU. The prompt asks for the informal address a sports studio uses, and
// this copy matches it. A studio that addresses its members formally edits the
// two parts in the dialog; the fixed lines here are short enough to read either
// way ("Hallo Anna," / "Bis bald").

export type MemberRecapLanguage = 'en' | 'de' | 'fr' | 'it'

/** A part the studio may send is at most this long — two sentences comfortably fit. */
export const MEMBER_RECAP_PART_MAX_CHARS = 600

interface RecapCopy {
  subject: (team: string) => string
  greeting: (firstname: string) => string
  /** No first name on file: a greeting that does not leave a gap. */
  greetingNoName: string
  statusLabel: string
  nextSessionLabel: string
  signOff: string
  /** How the send is named in the contact's email history. */
  historyName: string
}

const COPY: Record<MemberRecapLanguage, RecapCopy> = {
  en: {
    subject: (team) => `Your training update from ${team}`,
    greeting: (name) => `Hi ${name},`,
    greetingNoName: 'Hi,',
    statusLabel: 'Where you are',
    nextSessionLabel: 'For your next session',
    signOff: 'See you soon,',
    historyName: 'Training update',
  },
  de: {
    subject: (team) => `Dein Trainings-Update von ${team}`,
    greeting: (name) => `Hallo ${name},`,
    greetingNoName: 'Hallo,',
    statusLabel: 'Wo du stehst',
    nextSessionLabel: 'Für dein nächstes Training',
    signOff: 'Bis bald,',
    historyName: 'Trainings-Update',
  },
  fr: {
    subject: (team) => `Ton point d'entraînement – ${team}`,
    greeting: (name) => `Bonjour ${name},`,
    greetingNoName: 'Bonjour,',
    statusLabel: 'Où tu en es',
    nextSessionLabel: 'Pour ta prochaine séance',
    signOff: 'À bientôt,',
    historyName: "Point d'entraînement",
  },
  it: {
    subject: (team) => `Il tuo aggiornamento da ${team}`,
    greeting: (name) => `Ciao ${name},`,
    greetingNoName: 'Ciao,',
    statusLabel: 'A che punto sei',
    nextSessionLabel: 'Per la tua prossima sessione',
    signOff: 'A presto,',
    historyName: 'Aggiornamento allenamento',
  },
}

/** A stored language code → one the copy exists in; anything else reads as English. */
export function resolveMemberRecapLanguage(language: unknown): MemberRecapLanguage {
  const code = String(language ?? '').slice(0, 2).toLowerCase()
  return code === 'de' || code === 'fr' || code === 'it' ? code : 'en'
}

/**
 * A part as the studio typed it → what may be sent. Plain text: surrounding
 * whitespace trimmed, runs of blank lines collapsed to one line break, capped at
 * `MEMBER_RECAP_PART_MAX_CHARS`. Empty means "nothing to send", and the caller
 * refuses rather than sending a label over an empty paragraph.
 */
export function cleanMemberRecapPart(input: unknown): string {
  if (typeof input !== 'string') return ''
  const text = input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return text.length > MEMBER_RECAP_PART_MAX_CHARS
    ? `${text.slice(0, MEMBER_RECAP_PART_MAX_CHARS - 1).trimEnd()}…`
    : text
}

export interface MemberRecapMessage {
  subject: string
  greeting: string
  statusLabel: string
  status: string
  nextSessionLabel: string
  nextSession: string
  signOff: string
  teamName: string
  historyName: string
}

/** The message, as plain parts — what the dialog previews and the email renders. */
export function composeMemberRecap(input: {
  firstname?: string | null
  teamName: string
  status: string
  nextSession: string
  language: unknown
}): MemberRecapMessage {
  const copy = COPY[resolveMemberRecapLanguage(input.language)]
  const first = (input.firstname ?? '').trim()
  return {
    subject: copy.subject(input.teamName),
    greeting: first ? copy.greeting(first) : copy.greetingNoName,
    statusLabel: copy.statusLabel,
    status: cleanMemberRecapPart(input.status),
    nextSessionLabel: copy.nextSessionLabel,
    nextSession: cleanMemberRecapPart(input.nextSession),
    signOff: copy.signOff,
    teamName: input.teamName,
    historyName: copy.historyName,
  }
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Escaped, with the studio's line breaks kept. */
function paragraphText(text: string): string {
  return escape(text).replace(/\n/g, '<br>')
}

/**
 * The email BODY as HTML — every value escaped, since the parts are text a
 * studio typed and the name is a contact's. The layout around it (header, team
 * footer) is added by the caller's mail layout, like every outreach email.
 */
export function renderMemberRecapHtml(message: MemberRecapMessage): string {
  return [
    `<p>${escape(message.greeting)}</p>`,
    `<p><strong>${escape(message.statusLabel)}</strong><br>${paragraphText(message.status)}</p>`,
    `<p><strong>${escape(message.nextSessionLabel)}</strong><br>${paragraphText(message.nextSession)}</p>`,
    `<p>${escape(message.signOff)}<br>${escape(message.teamName)}</p>`,
  ].join('')
}
