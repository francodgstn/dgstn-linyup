import type { Timestamp } from './common'
import type { RecurrencePattern } from './session'

// ─── COURSE BLOCKS — a bounded, sellable set of lessons ──────────────────────
//
// "Every Wednesday 15:45–16:15, 20.08 to 26.11, no lesson on 8.10 and 15.10 →
// 13 lessons, 9 places, CHF 364, one booking, the child enrolled in every one."
//
// A class is a seat in a session. A COURSE is the whole set, sold once, and the
// set is what the studio and the parent both talk about: "levels 1 to 5 start in
// August", "13 lessons", "9 places", "sold out". None of that is expressible as
// thirteen independent sessions — thirteen sessions at 9/9 are thirteen answers
// to one question, and a child who misses lesson four must not free a place on
// the course.
//
// UI NAME: **Course**. The online-courses plugin (`courses/{id}`,
// `types/course.ts`) is displayed as *Online course* — it is on-demand video,
// not a timetable. The stored names differ so the two can never be confused in
// code, and neither stored name ever changes.
//
// ── THE SHAPE, AND WHY IT IS A LIST ─────────────────────────────────────────
//
// A course's meetings are a LIST (`meetings[]`), never a rule. `RecurrencePattern`
// has ONE `startDate` (which carries the time of day) and ONE `duration`, so it
// cannot say "Saturday 10:00–16:15 AND Sunday 09:00–15:00" — and that weekend
// crawl course is an ordinary product, not an edge case. A repeating pattern is
// therefore an AUTHORING INPUT that resolves to the list, kept beside it
// (`recurrence`) so the studio can see and re-edit what it typed.
//
// The three shapes a studio authors are one shape once stored:
//
//   Repeating   weekly pattern + skip dates   → 13 meetings
//   Days        two dates, different times    →  2 meetings
//   Single      one date                      →  1 meeting
//
// ── WHAT OWNS WHAT ──────────────────────────────────────────────────────────
//
// A course OWNS one `session_series/{id}`, which owns its `sessions`. That is
// what makes its lessons ORDINARY sessions: roster, attendance, check-in,
// reminders, cancellation and the trainer's busy set all work with no new code,
// and the series teardown job cancels the whole course. The series carries
// `course_block_id` and `status: 'fixed'` — materialised in full, nothing to
// roll — so the daily roller never reads it.
//
// The editing callables (`updateRecurringSession`, `cancelSession`) REFUSE a
// series carrying `course_block_id` and point at the course instead. That
// refusal is load-bearing: the recurrence-edit branch DELETES future sessions
// outright, and a deleted lesson may be one nine people have paid for.

/** One meeting of a course. Its own start and end, because a weekend course's
 *  two days are different lengths and a make-up lesson is rarely the same hour
 *  as the one it replaces. */
export interface CourseMeeting {
  start: Timestamp
  end: Timestamp
}

/**
 * How the studio authored the meeting list. Display and re-editing only — the
 * list is the truth, and a course whose dates were typed one by one has no
 * pattern at all.
 */
export interface CourseSchedulePattern {
  /** The weekly (or daily/monthly) rule, including its skip dates. */
  recurrence: RecurrencePattern
}

export type CourseBlockStatus =
  /** Being set up. Not sellable, not public. Where a duplicate lands. */
  | 'draft'
  /** Published. Whether it can be bought right now is `courseBlockSalesOpen`,
   *  which reads the dates — a status is not a clock. */
  | 'published'
  /** Called off. The series teardown has run (or is running); enrolments stand
   *  as a record of who was in it, and refunds are the studio's own act. */
  | 'cancelled'

export interface CourseBlock {
  id: string
  teamId: string

  /** What the studio calls it: "Level 2 Seepferd", "Crawl for beginners". */
  name: string
  description?: string

  /** The class type behind it. The lessons are sessions of this activity, so
   *  everything an activity already says — colour, image, meeting point, what
   *  to bring, cancellation terms, booking questions — is said once. */
  activityId?: string | null
  activityName?: string | null

  /** The series this course owns. Its sessions ARE this course's lessons. */
  seriesId?: string | null

  /** WHEN, resolved. Ordered, and the only truth about which days run. */
  meetings: CourseMeeting[]
  /** WHEN, as typed. Absent for a course whose dates were entered one by one. */
  pattern?: CourseSchedulePattern | null

  /** WHERE and WHO — copied onto every lesson through the series template. */
  placeId?: string | null
  roomId?: string | null
  location?: string | null
  providerId?: string | null
  providerName?: string | null

  /**
   * HOW MANY PEOPLE. The course's own capacity, not the session's: someone who
   * misses lesson four does not free a place. Absent or 0 ⇒ uncapped.
   */
  places?: number | null
  /**
   * How many places are held right now.
   *
   * ONE PLACE WRITER: an ABSOLUTE value, written either by
   * `trackCourseBlockEnrolments`' recount or from inside a transaction that read
   * the `enrolments` subcollection in the same read set. There is NO
   * `FieldValue.increment` on this field anywhere, and a new writer is added
   * only in that shape. It is the same rule as `Session.bookings_count`, one
   * level up, for the same reason: two people taking the last place must
   * conflict on one document.
   */
  places_taken?: number

  status?: CourseBlockStatus

  /** Sessions this course's own callables could not create — a lesson whose
   *  session is already at capacity from an ordinary booking. Surfaced on the
   *  roster; never a reason to fail an enrolment. */
  fanout_conflicts?: string[] | null

  /** Bumped whenever the enrolment set or the meeting list changes, so the
   *  roster converger can skip work it has already done. A hint, never the
   *  guarantee — the converger re-derives rather than trusting a marker. */
  roster_version?: number

  created_at?: Timestamp
  updated_at?: Timestamp
  createdBy?: string
}

/** A course with at least one meeting, ordered. The list is stored sorted, but
 *  anything that resolves it sorts again rather than trusting the write. */
export function orderedMeetings(block: Pick<CourseBlock, 'meetings'>): CourseMeeting[] {
  return [...(block.meetings ?? [])].sort((a, b) => a.start.toMillis() - b.start.toMillis())
}

/** The first meeting, or null for a course with none (a draft mid-setup). */
export function firstMeeting(block: Pick<CourseBlock, 'meetings'>): CourseMeeting | null {
  return orderedMeetings(block)[0] ?? null
}

/** The last meeting, or null. */
export function lastMeeting(block: Pick<CourseBlock, 'meetings'>): CourseMeeting | null {
  const all = orderedMeetings(block)
  return all[all.length - 1] ?? null
}

/** How many lessons the course runs — the number on every card and every
 *  confirmation ("13 lessons"). */
export function meetingCount(block: Pick<CourseBlock, 'meetings'>): number {
  return block.meetings?.length ?? 0
}

/**
 * Places still open, or `Infinity` for an uncapped course.
 *
 * The sibling of `seatsFree` (types/session.ts) on purpose: the two answer the
 * same question one level apart, and a reader who knows one knows the other.
 */
export function placesFree(places: number | null | undefined, taken: number | undefined): number {
  if (typeof places !== 'number' || places <= 0) return Infinity
  return Math.max(0, places - (taken ?? 0))
}

/** Whether the course is full. Separate from `placesFree` so a caller says what
 *  it means rather than comparing a number to zero at every site. */
export function courseBlockIsFull(block: Pick<CourseBlock, 'places' | 'places_taken'>): boolean {
  return placesFree(block.places, block.places_taken) <= 0
}

/** Longest a course name may be. Bounded like an activity's. */
export const MAX_COURSE_BLOCK_NAME_LENGTH = 120

/** How many meetings one course may hold. A weekly course runs a term or two;
 *  this is generous for that and small enough that the whole list stays a
 *  single document field, which is what keeps the meeting set atomic. */
export const MAX_COURSE_MEETINGS = 200
