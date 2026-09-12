// ─── The PURE half of the contact summary ───────────────────────────────────
//
// What the model is told (`buildContactDossier`) and what is done to what it
// says back (`normaliseSummary`). No Firebase, no network: `aiSummary.test.ts`
// feeds this a contact with every identifying field set to something easy to
// spot and pins that none of them reach the prompt. The callable in
// `aiSummary.ts` only fetches and forwards.

import type { Contact } from '@linyup/shared'

/** A stored summary never exceeds this, in characters. Three sentences fit. */
export const SUMMARY_MAX_CHARS = 480
/** …nor this many sentences — "two or three lines" is the whole brief. */
export const SUMMARY_MAX_SENTENCES = 3
/** How much of one note the model sees. */
export const NOTE_MAX_CHARS = 240

export interface DossierBooking {
  when: Date | null
  activity: string | null
  status: string | null
}

export interface DossierNote {
  when: Date | null
  /** Plain text — already through `noteText`. */
  text: string
}

export interface DossierInput {
  contact: Contact
  /** One entry per week of the window, oldest first, zero where nothing happened. */
  weekly: ReadonlyArray<{ iso_week: string; sessions_count: number }>
  /** Newest first. */
  bookings: readonly DossierBooking[]
  /** Newest first. */
  notes: readonly DossierNote[]
  now: Date
}

/** Admin Timestamp, client Timestamp, `{seconds}`, epoch ms or Date → Date. */
export function toDate(v: unknown): Date | null {
  if (!v) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') return new Date(v)
  const o = v as { toDate?: () => Date; seconds?: number }
  if (typeof o.toDate === 'function') return o.toDate()
  if (typeof o.seconds === 'number') return new Date(o.seconds * 1000)
  return null
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** "today", "3 days ago", "2 weeks ago", … — relative to `now`, coarse on purpose. */
function ago(d: Date, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000))
  if (days < 1) return 'today'
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

/** Note HTML → one line of plain text, entities decoded, cut to `NOTE_MAX_CHARS`. */
export function noteText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS - 1).trimEnd()}…` : text
}

/**
 * The facts, as plain labelled lines. Only the FIRST NAME identifies the
 * person: email, phone, address, birthdate, emergency contacts, weight and the
 * surname are not read — a summary of a training relationship needs none of
 * them. Notes ARE read: they are the most useful thing a coach has written.
 */
export function buildContactDossier(input: DossierInput): string {
  const { contact: c, weekly, bookings, notes, now } = input
  const lines: string[] = []
  const name = (c.firstname ?? '').trim() || 'This person'
  lines.push(`Person: ${name}`)

  const joined = toDate(c.created_at)
  if (joined) lines.push(`With the studio since: ${isoDay(joined)} (${ago(joined, now)})`)
  if (c.acquisition_stage) lines.push(`Journey stage: ${c.acquisition_stage.replace(/_/g, ' ')}`)
  if (c.external === true) lines.push('Roster: external — trains here but is not on the roster')

  const plans = (c.active_subscriptions ?? []).map(
    (s) => `${s.subscription_type_name ?? 'unnamed plan'} (${s.status})`
  )
  if (plans.length) lines.push(`Plans held: ${plans.join('; ')}`)
  else if (c.subscription_type_name) {
    lines.push(
      `Plan: ${c.subscription_type_name}${c.subscription_status ? ` (${c.subscription_status})` : ''}`
    )
  } else lines.push('Plans held: none')
  if (c.affiliation_summary?.has_active) lines.push('Affiliation: active member of the organisation')

  const total = c.total_sessions ?? 0
  const last = toDate(c.last_session_at)
  lines.push(
    `Attendance: ${total} session${total === 1 ? '' : 's'} in total` +
      (last ? `; last session ${isoDay(last)} (${ago(last, now)})` : '; no session recorded')
  )
  if (c.current_streak != null || c.max_streak != null) {
    lines.push(
      `Weekly streak: ${c.current_streak ?? 0} weeks now, best ${c.max_streak ?? c.current_streak ?? 0}`
    )
  }
  if (weekly.length) {
    lines.push(
      `Sessions per week over the last ${weekly.length} weeks, oldest first: ${weekly
        .map((w) => w.sessions_count)
        .join(' ')}`
    )
  }
  if (bookings.length) {
    lines.push(
      `Recent bookings, newest first: ${bookings
        .map(
          (b) =>
            `${b.when ? isoDay(b.when) : 'undated'} ${b.activity ?? 'unnamed activity'}${
              b.status ? ` (${b.status.replace(/_/g, ' ')})` : ''
            }`
        )
        .join('; ')}`
    )
  }
  if ((c.no_show_strikes ?? 0) > 0) lines.push(`No-show strikes: ${c.no_show_strikes}`)
  if ((c.alerts_count ?? 0) > 0) lines.push(`Open alerts on this contact: ${c.alerts_count}`)
  if (c.tags?.length) lines.push(`Tags: ${c.tags.slice(0, 10).join(', ')}`)
  if (notes.length) {
    lines.push('Latest coach notes, newest first:')
    for (const n of notes) lines.push(`- ${n.when ? isoDay(n.when) : 'undated'}: ${n.text}`)
  } else lines.push('Coach notes: none')
  return lines.join('\n')
}

/** Strip a ```fence if the model wrapped its answer in one. */
function unfence(text: string): string {
  const m = text.trim().match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i)
  return (m ? m[1] : text).trim()
}

/**
 * The model's reply → the stored text. Fences, heading lines, bullets and
 * emphasis go (it is asked for plain prose and sometimes sends markdown
 * anyway); then at most `SUMMARY_MAX_SENTENCES` sentences and never more than
 * `SUMMARY_MAX_CHARS`, cut at a sentence boundary where one exists. Empty in,
 * empty out — the caller decides what an empty summary means.
 */
export function normaliseSummary(raw: string): string {
  const flat = unfence(raw ?? '')
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return ''
  const sentences =
    flat
      .match(/[^.!?]+(?:[.!?]+|$)/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [flat]
  let out = ''
  let count = 0
  for (const sentence of sentences) {
    if (count >= SUMMARY_MAX_SENTENCES) break
    const next = out ? `${out} ${sentence}` : sentence
    if (next.length > SUMMARY_MAX_CHARS) break
    out = next
    count += 1
  }
  // Nothing fit whole (one enormous sentence): hard-cut rather than return
  // nothing, since something is still more useful than a failure.
  if (!out) out = `${flat.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`
  return out
}

/**
 * The rules' `callerOwnsContact`, for the own-scoped coach: on the contact's
 * coach list, or its creator.
 */
export function coachOwnsContact(
  contact: Pick<Contact, 'assigned_coach_ids' | 'createdBy'>,
  uid: string
): boolean {
  return (contact.assigned_coach_ids ?? []).includes(uid) || contact.createdBy === uid
}

/** The language the summary is written in, from the studio's authoring language. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German, in Swiss spelling (ss, never ß)',
  fr: 'French',
  it: 'Italian',
}

/**
 * Quality, not safety: nothing in a prompt is enforceable, and the boundary is
 * what the dossier does and does not contain plus `normaliseSummary` on the
 * way back.
 */
export function systemPrompt(languageName: string): string {
  return `You write a short briefing about one client of a sports, fitness or wellness studio, for the coach who is about to see them.

Two or three sentences, at most 60 words, plain prose: no heading, no bullet points, no markdown, no greeting, no sign-off. Refer to the person by first name.

Use only the facts you are given. Say nothing the facts do not support: never guess at health, mood, motivation or reasons, and never invent a number. If the facts are thin, say less rather than more.

Lead with what matters most to a coach today: how regularly they come and whether that has changed recently, what they hold, and anything in the notes worth acting on. Dates in the facts are ISO; write them the way a coach would say them.

Write in ${languageName}.`
}
