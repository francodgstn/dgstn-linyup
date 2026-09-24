// ─── THE MEETING LIST: one resolver, three ways of asking for it ────────────
//
// A course's meetings are a LIST, and this is the only place one is built. The
// studio authors in whichever of three shapes fits what it is selling; all three
// arrive here and leave as `CourseMeeting[]`, so everything downstream, the
// preview, the sessions, the "13 lessons" on the card, the confirmation email
// all read one thing.
//
//   Repeating   a weekly rule + its skip dates    "every Wed, 20.08–26.11, not 8.10/15.10"
//   Days        explicit day+time pairs            "Sat 10:00–16:15 and Sun 09:00–15:00"
//   Single      one of the above with one entry    "Sunday 14.10, 15:00–17:45"
//
// WHY A LIST AND NOT A PATTERN. `RecurrencePattern` carries ONE `startDate`,
// which is also its time of day, and ONE `duration`. So it cannot say "Saturday
// ten to quarter past four AND Sunday nine to three", and that weekend crawl
// course is an ordinary product rather than an edge case. The repeating shape is
// therefore an INPUT that resolves to the list, kept beside it so the studio can
// re-edit what it typed.
//
// The repeating shape reuses `calculateOccurrences` rather than reimplementing a
// calendar: skip dates, the DST-safe advance and the Europe/Zurich civil day are
// all already decided there, and a second implementation would drift from the
// one the rolling series uses.
import { HttpsError } from 'firebase-functions/v2/https'
import { Timestamp } from 'firebase-admin/firestore'
import {
  MAX_COURSE_MEETINGS,
  type CourseMeeting,
  type RecurrencePattern,
} from '@linyup/shared'
import { calculateOccurrences, validateRecurrence } from '../utils/recurrence'

/** What a client sends to describe when a course runs. */
export type CourseScheduleInput =
  | {
      kind: 'repeating'
      /** The rule, including `excludeDates`. `endCondition` decides where it
       *  stops; a course must stop, so `never` is refused below. */
      recurrence: RecurrencePattern
    }
  | {
      kind: 'dates'
      /** Explicit meetings, each with its own start and length. */
      meetings: Array<{ startMs: number; durationMinutes: number }>
    }

export interface ResolvedSchedule {
  meetings: CourseMeeting[]
  /** The rule, when there was one, stored beside the list for re-editing. */
  recurrence: RecurrencePattern | null
}

/** A course runs for a term, not for ever: there is a last lesson by definition,
 *  and the price on the card is the price of a known number of them. */
const BOUNDED_END_CONDITIONS = new Set(['date', 'count'])

/** Longest one meeting may run. A full-day workshop is ~8 hours; this is
 *  generous for that and refuses an obvious typo (a 3000-minute lesson). */
const MAX_MEETING_MINUTES = 12 * 60

export function resolveCourseSchedule(input: CourseScheduleInput): ResolvedSchedule {
  if (!input || typeof input !== 'object') {
    throw new HttpsError('invalid-argument', 'A course needs a schedule.')
  }

  // NORMALISE THE WIRE SHAPES ONCE, here, so nothing downstream has to know
  // that a callable's payload is JSON: the generator reads real Dates, and what
  // gets STORED as the pattern is real Timestamps rather than the plain maps a
  // client Timestamp serialises into.
  const recurrence =
    input.kind === 'repeating' ? normaliseRecurrence(input.recurrence) : null

  const meetings =
    recurrence ? fromRecurrence(recurrence) : fromDates((input as { meetings: DateInput[] }).meetings)

  if (meetings.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'That schedule produces no lessons. Check the dates and the days of the week.'
    )
  }
  if (meetings.length > MAX_COURSE_MEETINGS) {
    throw new HttpsError(
      'invalid-argument',
      `That schedule produces ${meetings.length} lessons, more than a course can hold (${MAX_COURSE_MEETINGS}).`
    )
  }

  return { meetings, recurrence }
}

/** One meeting as the client sends it. */
type DateInput = { startMs: number; durationMinutes: number }

/**
 * The recurrence, with every date turned into a real Timestamp.
 *
 * The payload arrives as JSON, so `startDate`, `endDate` and each entry of
 * `excludeDates` are plain maps by the time they reach here. Coercing them in
 * one place means the generator, the validator and the stored pattern all see
 * the same thing.
 */
function normaliseRecurrence(recurrence: RecurrencePattern): RecurrencePattern {
  const startDate = toTimestamp(recurrence.startDate)
  if (!startDate) throw new HttpsError('invalid-argument', 'The course needs a first lesson date.')
  const endDate = toTimestamp(recurrence.endDate)
  const excludeDates = (recurrence.excludeDates ?? [])
    .map((d) => toTimestamp(d))
    .filter((d): d is Timestamp => d !== null)

  return {
    ...recurrence,
    startDate: startDate as unknown as RecurrencePattern['startDate'],
    ...(endDate ? { endDate: endDate as unknown as RecurrencePattern['endDate'] } : {}),
    ...(excludeDates.length
      ? { excludeDates: excludeDates as unknown as RecurrencePattern['excludeDates'] }
      : {}),
  }
}

function fromRecurrence(recurrence: RecurrencePattern): CourseMeeting[] {
  const check = validateRecurrence(recurrence)
  if (!check.valid) throw new HttpsError('invalid-argument', check.errors.join('; '))
  if (!BOUNDED_END_CONDITIONS.has(recurrence.endCondition)) {
    // A course is a bounded thing, "13 lessons", "until the end of November".
    // An open-ended rule is a timetable, which is what a plain session series
    // already is.
    throw new HttpsError(
      'invalid-argument',
      'A course has to end: set a last date or a number of lessons.'
    )
  }

  const start = toDate(recurrence.startDate)
  if (!start) throw new HttpsError('invalid-argument', 'The course needs a first lesson date.')

  // The window is wide enough that the recurrence's OWN end condition is what
  // stops it: asking for a narrower one would silently truncate a long course.
  // `MAX_COURSE_MEETINGS` above is the real ceiling.
  const horizonEnd = toDate(recurrence.endDate) ?? addYears(start, 3)

  return calculateOccurrences(
    recurrence as unknown as Parameters<typeof calculateOccurrences>[0],
    start,
    addDays(horizonEnd, 1)
  ).map((o) => ({
    start: Timestamp.fromDate(o.start),
    end: Timestamp.fromDate(o.end),
  }))
}

function fromDates(entries: Array<{ startMs: number; durationMinutes: number }>): CourseMeeting[] {
  if (!Array.isArray(entries)) {
    throw new HttpsError('invalid-argument', 'A course needs at least one lesson date.')
  }

  const seen = new Set<number>()
  const meetings: CourseMeeting[] = []
  for (const entry of entries) {
    const startMs = Number(entry?.startMs)
    const minutes = Number(entry?.durationMinutes)
    if (!Number.isFinite(startMs) || startMs <= 0) {
      throw new HttpsError('invalid-argument', 'One of the lesson dates is not a date.')
    }
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MEETING_MINUTES) {
      throw new HttpsError(
        'invalid-argument',
        `A lesson has to run between 1 and ${MAX_MEETING_MINUTES} minutes.`
      )
    }
    // Two lessons at the same instant is a double entry, not a schedule, and
    // it would give the series two occurrences deduped to one, so the course's
    // own count and its sessions would disagree for ever.
    if (seen.has(startMs)) continue
    seen.add(startMs)
    meetings.push({
      start: Timestamp.fromMillis(startMs),
      end: Timestamp.fromMillis(startMs + minutes * 60_000),
    })
  }

  return meetings.sort((a, b) => a.start.toMillis() - b.start.toMillis())
}

/**
 * An instant, from any of the shapes one arrives in here.
 *
 * A CALLABLE'S PAYLOAD IS JSON. The web form builds a client `Timestamp` and
 * hands it to `callFunction`, but the callable protocol serialises it, so what
 * reaches this file is a PLAIN OBJECT with no `toDate` on it: `{seconds,
 * nanoseconds}` from the client SDK, or `{_seconds, _nanoseconds}` from the
 * admin one. Reading only `toDate` returned null for every date the form sent,
 * and the course refused to save with "needs a first lesson date" while the
 * studio was looking at one.
 *
 * So every shape is accepted, and `resolveCourseSchedule` normalises the whole
 * recurrence through here before anything reads it, which is also what makes
 * the stored pattern real Timestamps rather than the wire's plain maps.
 */
function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  const obj = value as {
    toDate?: () => Date
    seconds?: number
    nanoseconds?: number
    _seconds?: number
    _nanoseconds?: number
  }
  if (typeof obj.toDate === 'function') {
    const d = obj.toDate()
    return Number.isNaN(d.getTime()) ? null : d
  }
  const seconds = typeof obj.seconds === 'number' ? obj.seconds : obj._seconds
  const nanos = typeof obj.nanoseconds === 'number' ? obj.nanoseconds : (obj._nanoseconds ?? 0)
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    return new Date(seconds * 1000 + Math.floor((nanos ?? 0) / 1e6))
  }
  return null
}

/** The same coercion, as a Firestore Timestamp. */
function toTimestamp(value: unknown): Timestamp | null {
  const d = toDate(value)
  return d ? Timestamp.fromDate(d) : null
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000)
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date)
  d.setFullYear(d.getFullYear() + years)
  return d
}
