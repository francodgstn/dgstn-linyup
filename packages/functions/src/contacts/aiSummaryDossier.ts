// ─── The PURE half of the contact summary ───────────────────────────────────
//
// What the model is told (`buildContactDossier`), the SIGNALS derived for it
// first (`deriveSignals`), and what is done to what it says back
// (`normaliseSummary`). No Firebase, no network: `aiSummary.test.ts` feeds
// this a contact with every identifying field set to something easy to spot
// and pins that none of them reach the prompt. The callable in `aiSummary.ts`
// only fetches and forwards.
//
// WHY THE SIGNALS ARE COMPUTED HERE AND NOT LEFT TO THE MODEL. The first
// version handed over raw counters and got the counters back in prose —
// "Anna has 47 sessions and holds Unlimited" — which the coach can read off
// the same screen. A model asked to compare, project and suggest does it far
// better when the comparison is already done: a trend is arithmetic, a
// no-show rate is arithmetic, "usually Tuesday evenings" is a histogram. The
// model's job is to say what they mean together. Everything below is
// deterministic and tested; nothing is invented.

import type { Contact } from '@linyup/shared'

/** A stored summary never exceeds this, in characters. Six sentences fit. */
export const SUMMARY_MAX_CHARS = 900
/** …nor this many sentences — a paragraph, not a report. */
export const SUMMARY_MAX_SENTENCES = 6
/** How much of one note the model sees. */
export const NOTE_MAX_CHARS = 240
/**
 * The studio's clock, for "Tuesday evenings". The recurrence utilities make
 * the same assumption; a per-team timezone would land here first.
 */
export const STUDIO_TIME_ZONE = 'Europe/Zurich'
/** The trailing weeks that count as "now" when a trend is read. */
export const RECENT_WEEKS = 4

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

/** One held period from the subscription history. */
export interface DossierPeriod {
  plan: string | null
  start: Date | null
  end: Date | null
  reason: string | null
}

export interface DossierInput {
  contact: Contact
  /** One entry per week of the window, oldest first, zero where nothing happened. */
  weekly: ReadonlyArray<{ iso_week: string; sessions_count: number }>
  /** Newest first. */
  bookings: readonly DossierBooking[]
  /** Newest first. */
  notes: readonly DossierNote[]
  /** Newest first. Absent when the studio keeps no history. */
  periods?: readonly DossierPeriod[]
  /** The studio's engagement band for this person, when the caller resolved it. */
  engagementBand?: string | null
  timeZone?: string
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

// ─── Signals ─────────────────────────────────────────────────────────────────

export type Trend = 'up' | 'down' | 'steady' | 'insufficient'
export type TimeOfDay = 'morning' | 'midday' | 'evening'

export interface Signals {
  weeksInWindow: number
  activeWeeks: number
  /** Mean sessions per week over the last `RECENT_WEEKS`. */
  recentPerWeek: number
  /** Mean over the weeks before those; null when there are too few to compare. */
  earlierPerWeek: number | null
  trend: Trend
  longestGapWeeks: number
  /** Zero-session weeks at the end of the window, the current one included. */
  trailingGapWeeks: number
  daysSinceLast: number | null
  outcomes: { kept: number; noShow: number; cancelled: number; upcoming: number }
  /** no-shows over (kept + no-shows); null under three decided bookings. */
  noShowRate: number | null
  nextUpcoming: DossierBooking | null
  favouriteDays: string[]
  favouriteTime: TimeOfDay | null
  activityMix: Array<{ name: string; count: number }>
  tenureMonths: number | null
  periods: { count: number; firstStart: Date | null; lastEnd: Date | null; lastReason: string | null }
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function weekdayName(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(d)
}

function hourIn(d: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(d)
  return Number.parseInt(h, 10)
}

function timeOfDay(hour: number): TimeOfDay {
  if (hour < 11) return 'morning'
  if (hour < 16) return 'midday'
  return 'evening'
}

function top<T extends string>(counts: Map<T, number>, n: number, min: number): Array<[T, number]> {
  return [...counts.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, n)
}

/**
 * Everything the model would otherwise have to work out from the raw rows,
 * done deterministically. A booking is DECIDED (kept or no-show) once its
 * session is in the past; a confirmed booking in the future is upcoming, and
 * an upcoming booking is the strongest forward signal there is.
 */
export function deriveSignals(input: DossierInput): Signals {
  const { contact: c, weekly, bookings, now } = input
  const timeZone = input.timeZone ?? STUDIO_TIME_ZONE
  const counts = weekly.map((w) => w.sessions_count)

  const recent = counts.slice(-RECENT_WEEKS)
  const earlier = counts.slice(0, Math.max(0, counts.length - RECENT_WEEKS))
  const recentPerWeek = mean(recent)
  const earlierPerWeek = earlier.length >= RECENT_WEEKS ? mean(earlier) : null
  let trend: Trend = 'insufficient'
  if (earlierPerWeek !== null) {
    const diff = recentPerWeek - earlierPerWeek
    if (diff >= 0.5 && recentPerWeek >= earlierPerWeek * 1.25) trend = 'up'
    else if (diff <= -0.5 && recentPerWeek <= earlierPerWeek * 0.75) trend = 'down'
    else trend = 'steady'
  }

  let longestGapWeeks = 0
  let run = 0
  for (const n of counts) {
    run = n > 0 ? 0 : run + 1
    if (run > longestGapWeeks) longestGapWeeks = run
  }
  let trailingGapWeeks = 0
  for (let i = counts.length - 1; i >= 0 && counts[i] === 0; i--) trailingGapWeeks++

  const last = toDate(c.last_session_at)
  const daysSinceLast = last ? Math.max(0, Math.floor((now.getTime() - last.getTime()) / 86_400_000)) : null

  const outcomes = { kept: 0, noShow: 0, cancelled: 0, upcoming: 0 }
  let nextUpcoming: DossierBooking | null = null
  const days = new Map<string, number>()
  const times = new Map<TimeOfDay, number>()
  const activities = new Map<string, number>()
  for (const b of bookings) {
    const status = b.status ?? 'confirmed'
    if (status === 'cancelled') {
      outcomes.cancelled++
      continue
    }
    if (status === 'rebooked') continue
    const future = !!b.when && b.when.getTime() > now.getTime()
    if (status === 'no_show') outcomes.noShow++
    else if (future) {
      outcomes.upcoming++
      if (
        !nextUpcoming ||
        (b.when && nextUpcoming.when && b.when.getTime() < nextUpcoming.when.getTime())
      ) {
        nextUpcoming = b
      }
    } else outcomes.kept++
    if (b.when) {
      const day = weekdayName(b.when, timeZone)
      days.set(day, (days.get(day) ?? 0) + 1)
      const t = timeOfDay(hourIn(b.when, timeZone))
      times.set(t, (times.get(t) ?? 0) + 1)
    }
    if (b.activity) activities.set(b.activity, (activities.get(b.activity) ?? 0) + 1)
  }
  const decided = outcomes.kept + outcomes.noShow
  const noShowRate = decided >= 3 ? outcomes.noShow / decided : null
  const dated = [...times.values()].reduce((a, b) => a + b, 0)
  const topTime = top(times, 1, 2)[0]
  const favouriteTime = topTime && topTime[1] * 2 >= dated ? topTime[0] : null

  const joined = toDate(c.created_at)
  const tenureMonths = joined
    ? Math.max(0, Math.floor((now.getTime() - joined.getTime()) / (30.44 * 86_400_000)))
    : null

  const periods = input.periods ?? []
  const starts = periods.map((p) => p.start).filter((d): d is Date => !!d)
  const ended = periods.filter((p) => p.end && p.end.getTime() <= now.getTime())
  const ends = ended.map((p) => p.end as Date)
  const newestEnded = ended.slice().sort((a, b) => (b.end as Date).getTime() - (a.end as Date).getTime())[0]

  return {
    weeksInWindow: counts.length,
    activeWeeks: counts.filter((n) => n > 0).length,
    recentPerWeek,
    earlierPerWeek,
    trend,
    longestGapWeeks,
    trailingGapWeeks,
    daysSinceLast,
    outcomes,
    noShowRate,
    nextUpcoming,
    favouriteDays: top(days, 2, 2).map(([d]) => d),
    favouriteTime,
    activityMix: top(activities, 3, 1).map(([name, count]) => ({ name, count })),
    tenureMonths,
    periods: {
      count: periods.length,
      firstStart: starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null,
      lastEnd: ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null,
      lastReason: newestEnded?.reason ?? null,
    },
  }
}

// ─── The dossier ─────────────────────────────────────────────────────────────

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toString()

/**
 * The facts and the signals, as plain labelled lines. Only the FIRST NAME
 * identifies the person: email, phone, address, birthdate, emergency
 * contacts, weight and the surname are not read — an analysis of a training
 * relationship needs none of them. Notes ARE read: they are the most useful
 * thing a coach has written.
 */
export function buildContactDossier(input: DossierInput): string {
  const { contact: c, weekly, bookings, notes, now } = input
  const s = deriveSignals(input)
  const lines: string[] = []
  const name = (c.firstname ?? '').trim() || 'This person'
  lines.push(`Person: ${name}`)

  const joined = toDate(c.created_at)
  if (joined) lines.push(`With the studio since: ${isoDay(joined)} (${ago(joined, now)})`)
  if (c.acquisition_stage) lines.push(`Journey stage: ${c.acquisition_stage.replace(/_/g, ' ')}`)
  if (c.external === true) lines.push('Roster: external — trains here but is not on the roster')

  const plans = (c.active_subscriptions ?? []).map((sub) => {
    const endsAt = sub.cancels_at_ms ? isoDay(new Date(sub.cancels_at_ms)) : null
    const winding = sub.cancelling || endsAt ? `, cancelled — ends ${endsAt ?? 'at a date not recorded'}` : ''
    return `${sub.subscription_type_name ?? 'unnamed plan'} (${sub.status}${winding})`
  })
  if (plans.length) lines.push(`Plans held: ${plans.join('; ')}`)
  else if (c.subscription_type_name) {
    lines.push(
      `Plan: ${c.subscription_type_name}${c.subscription_status ? ` (${c.subscription_status})` : ''}`
    )
  } else lines.push('Plans held: none')
  if (s.periods.count) {
    const bits = [`${s.periods.count} period${s.periods.count === 1 ? '' : 's'} on record`]
    if (s.periods.firstStart) bits.push(`first started ${isoDay(s.periods.firstStart)}`)
    if (s.periods.lastEnd) {
      bits.push(
        `last ended ${isoDay(s.periods.lastEnd)}${s.periods.lastReason ? ` (${s.periods.lastReason.replace(/_/g, ' ')})` : ''}`
      )
    }
    lines.push(`Membership history: ${bits.join('; ')}`)
  }
  const credits = (c.credit_summary ?? []).map((cr) => {
    const exp = toDate(cr.next_expires_at)
    return `${cr.remaining} left on ${cr.subscription_type_name ?? 'a credit pack'}${exp ? ` (next expiry ${isoDay(exp)})` : ''}`
  })
  if (credits.length) lines.push(`Credits: ${credits.join('; ')}`)
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
      `Bookings, newest first: ${bookings
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

  lines.push('')
  lines.push('Computed signals:')
  if (weekly.length) {
    const trendWord = { up: 'rising', down: 'slipping', steady: 'steady', insufficient: '' }[s.trend]
    lines.push(
      s.earlierPerWeek === null
        ? `- Attendance trend: ${fmt1(s.recentPerWeek)} sessions/week over the last ${Math.min(RECENT_WEEKS, weekly.length)} weeks; too little history before that to compare`
        : `- Attendance trend: ${fmt1(s.recentPerWeek)} sessions/week over the last ${RECENT_WEEKS} weeks vs ${fmt1(s.earlierPerWeek)}/week over the ${weekly.length - RECENT_WEEKS} weeks before — ${trendWord}`
    )
    lines.push(
      `- Active in ${s.activeWeeks} of the last ${s.weeksInWindow} weeks; longest gap ${s.longestGapWeeks} week${s.longestGapWeeks === 1 ? '' : 's'}; ${s.trailingGapWeeks} week${s.trailingGapWeeks === 1 ? '' : 's'} without a session at the end of the window`
    )
  }
  if (bookings.length) {
    const o = s.outcomes
    const rate = s.noShowRate === null ? '' : ` (${Math.round(s.noShowRate * 100)}% of decided bookings)`
    const next = s.nextUpcoming
      ? ` — next ${s.nextUpcoming.when ? isoDay(s.nextUpcoming.when) : 'undated'} ${s.nextUpcoming.activity ?? ''}`.trimEnd()
      : ''
    lines.push(
      `- Bookings, last ${bookings.length}: ${o.kept} kept, ${o.noShow} no-show${o.noShow === 1 ? '' : 's'}${rate}, ${o.cancelled} cancelled, ${o.upcoming} upcoming${next}`
    )
    const rhythm: string[] = []
    if (s.favouriteDays.length) rhythm.push(s.favouriteDays.join(' and '))
    if (s.favouriteTime) rhythm.push(`${s.favouriteTime}s`)
    if (s.activityMix.length) {
      rhythm.push(`mostly ${s.activityMix.map((a) => `${a.name} (${a.count})`).join(', ')}`)
    }
    if (rhythm.length) lines.push(`- Usual rhythm: ${rhythm.join('; ')}`)
  }
  if (s.tenureMonths !== null) lines.push(`- Tenure: ${s.tenureMonths} month${s.tenureMonths === 1 ? '' : 's'}`)
  if (input.engagementBand) {
    lines.push(`- Engagement band by the studio's own thresholds: ${input.engagementBand.replace(/_/g, ' ')}`)
  }

  lines.push('')
  if (notes.length) {
    lines.push('Latest coach notes, newest first:')
    for (const n of notes) lines.push(`- ${n.when ? isoDay(n.when) : 'undated'}: ${n.text}`)
  } else lines.push('Coach notes: none')
  return lines.join('\n')
}

// ─── The reply ───────────────────────────────────────────────────────────────

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
 *
 * It asks for an ANALYSIS and says what one is here, in order: where the
 * person stands against their own history, what to expect next and why, and
 * one thing to do about it. It also says what NOT to do — restate the
 * counters on the screen — because that is exactly what the first version
 * came back with.
 */
export function systemPrompt(languageName: string): string {
  return `You write a short analysis of one client of a sports, fitness or wellness studio, for the coach who looks after them.

Four to six sentences, at most 130 words, one paragraph of plain prose: no heading, no bullet points, no markdown, no greeting, no sign-off. Refer to the person by first name.

Do not repeat the raw numbers the coach can already see on the same screen — total sessions, streak, the plan's name, the counters. Interpret them. Cover, in this order:
1. Engagement now, against this person's own history: is attendance rising, steady or slipping, and how regular is the rhythm (which days, times and activities, if a pattern shows).
2. What to expect next, and why, from the signals: likely to keep coming, at risk of drifting, a plan ending or credits running out, upcoming bookings, a no-show habit. Say how confident you are; when the history is thin, say so rather than guess.
3. One concrete, specific thing the coach could do or say at the next session, drawn from the notes or from the pattern.

Use only the facts given. Never invent a number, never guess at health, mood or motives, never read a reason into a gap the facts do not explain. Dates are ISO; write them the way a coach would say them.

Write in ${languageName}.`
}
