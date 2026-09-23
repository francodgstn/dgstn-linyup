import type { Benefit } from './benefit'
import type { Timestamp } from './common'
import type { RecurrencePattern } from './session'

// ─── COURSE BLOCKS: a bounded, sellable set of lessons ──────────────────────
//
// "Every Wednesday 15:45–16:15, 20.08 to 26.11, no lesson on 8.10 and 15.10 →
// 13 lessons, 9 places, CHF 364, one booking, the child enrolled in every one."
//
// A class is a seat in a session. A COURSE is the whole set, sold once, and the
// set is what the studio and the parent both talk about: "levels 1 to 5 start in
// August", "13 lessons", "9 places", "sold out". None of that is expressible as
// thirteen independent sessions, thirteen sessions at 9/9 are thirteen answers
// to one question, and a child who misses lesson four must not free a place on
// the course.
//
// UI NAME: **Course**. The online-courses plugin (`courses/{id}`,
// `types/course.ts`) is displayed as *Online course*, it is on-demand video,
// not a timetable. The stored names differ so the two can never be confused in
// code, and neither stored name ever changes.
//
// ── THE SHAPE, AND WHY IT IS A LIST ─────────────────────────────────────────
//
// A course's meetings are a LIST (`meetings[]`), never a rule. `RecurrencePattern`
// has ONE `startDate` (which carries the time of day) and ONE `duration`, so it
// cannot say "Saturday 10:00–16:15 AND Sunday 09:00–15:00", and that weekend
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
// `course_block_id` and `status: 'fixed'`, materialised in full, nothing to
// roll, so the daily roller never reads it.
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
 * How the studio authored the meeting list. Display and re-editing only, the
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
   *  which reads the dates, a status is not a clock. */
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
   *  everything an activity already says, colour, image, meeting point, what
   *  to bring, cancellation terms, booking questions, is said once. */
  activityId?: string | null
  activityName?: string | null

  /** The series this course owns. Its sessions ARE this course's lessons. */
  seriesId?: string | null

  /** WHEN, resolved. Ordered, and the only truth about which days run. */
  meetings: CourseMeeting[]
  /** WHEN, as typed. Absent for a course whose dates were entered one by one. */
  pattern?: CourseSchedulePattern | null

  /** WHERE and WHO, copied onto every lesson through the series template. */
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

  /**
   * WHAT IT COSTS, in major units of the team currency. Null or absent means
   * free for everyone, which is an offer rather than a misconfiguration: a
   * taster week and an open-water meet-up are both ordinary things a studio
   * runs, and it still wants the register.
   *
   * Read through `resolvePaymentOptions` with a `course_block` target, never
   * directly: what somebody actually pays depends on the plans they hold and
   * any promo code, and this is only the base.
   */
  priceAmount?: number | null

  /**
   * THE PLAN EDGE, in the two facets every other offering has: the plans that
   * get this course FREE, and the one rule that prices it for the plans that
   * merely get it CHEAPER. They are read additively and free wins, which is the
   * shape the LMS course arm had to be corrected into after a holder was quoted
   * full price for something the rules already let them have.
   */
  includedSubscriptionTypeIds?: string[] | null
  benefit?: Benefit | null

  /** The "only people who signed up with you" wall, the same one a class has.
   *  Absent reads as 'anyone'. */
  audience?: 'anyone' | 'members'

  /** When it stops being sellable. Stored absolute so a public list can filter
   *  on it and the mirror can carry it; `close_days_before` is kept beside it so
   *  the absolute is re-derived when the first lesson moves. */
  booking_closes_at?: Timestamp | null
  close_days_before?: number | null

  status?: CourseBlockStatus

  /** Sessions this course's own callables could not create, a lesson whose
   *  session is already at capacity from an ordinary booking. Surfaced on the
   *  roster; never a reason to fail an enrolment. */
  fanout_conflicts?: string[] | null

  /** Bumped whenever the enrolment set or the meeting list changes, so the
   *  roster converger can skip work it has already done. A hint, never the
   *  guarantee, the converger re-derives rather than trusting a marker. */
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

/** How many lessons the course runs, the number on every card and every
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

// ─── ENROLMENTS: one purchase, one place, N lessons ─────────────────────────
//
// `course_blocks/{blockId}/enrolments/{contactId}`, the doc id IS the contact
// id, exactly like `bookings`, `waitlist` and `participants`, so a second enrol
// is an idempotent write rather than a duplicate row.
//
// THE ENROLMENT IS THE TRUTH; the per-session bookings are a PROJECTION of it.
// Nothing writes thirteen bookings inside one transaction: the enrolment commits
// alone, against the course's own counter, and a converger then ensures each
// future lesson has a booking for this contact. That is what keeps this inside
// Firestore's transaction limits AND inside the existing seat rule, each
// booking is written by an ordinary per-session transaction, absolutely, the way
// every other booking in the system is.

export type CourseEnrolmentStatus =
  /** Paid for, or given a place by the studio. Holds a place. */
  | 'enrolled'
  /** A checkout is open. Holds a place until `expires_at` lapses, lazy expiry,
   *  the same shape as an appointment hold, so the gate and the recount can
   *  never disagree and nothing waits for a sweep. */
  | 'hold'
  /** They left, or the studio took them off. Holds nothing. */
  | 'withdrawn'

export interface CourseBlockEnrolment {
  /** The contact id, and this document's own id. */
  contactId: string
  teamId: string
  status?: CourseEnrolmentStatus
  /** Display only, so a roster renders without N contact reads. */
  firstname?: string | null
  lastname?: string | null
  email?: string | null
  /** 'required' while a checkout is open, 'paid' once it settled, and
   *  'not_required' for a free course or a place the studio gave. */
  payment_status?: 'not_required' | 'required' | 'paid'
  payment_intent_id?: string | null
  /** When a hold lapses. Absent on a settled enrolment. */
  expires_at?: Timestamp | null
  /** An offered place from the waiting list, an ORDINARY enrolment carrying
   *  this flag, so every capacity gate already stops selling it. */
  waitlist_claim?: boolean
  claim_expires_at?: Timestamp | null
  enrolled_at?: Timestamp
  withdrawn_at?: Timestamp | null
  /** Bumped to the course's `roster_version` when this enrolment's bookings were
   *  last written. A cheap skip for the converger, never its guarantee, it
   *  re-derives rather than trusting a marker. */
  roster_version_applied?: number
}

/** The two fields the place predicate reads, and nothing else, narrowed the
 *  way `SeatHold` is, so a raw Firestore document, a plain object and a test
 *  fixture all satisfy it without a cast. */
export interface PlaceHold {
  status?: string
  expires_at?: { toMillis(): number } | null
}

/**
 * Does this enrolment occupy a place RIGHT NOW? The sibling of
 * `bookingHoldsSeat`, and the single source of truth for the question.
 *
 * A lapsed hold frees its place IMMEDIATELY rather than at the next sweep, for
 * the reason the appointment rail learned the hard way: a course advertised full
 * on the strength of an abandoned checkout is a place nobody can reach. Reading
 * it here means the gate and the recount give the same answer.
 *
 * An ABSENT status is an enrolment, and holds.
 */
export function courseBlockEnrolmentHoldsPlace(
  e: PlaceHold,
  nowMs: number = Date.now()
): boolean {
  if (e.status === 'withdrawn') return false
  if (e.status === 'hold' && !!e.expires_at && e.expires_at.toMillis() <= nowMs) return false
  return true
}

/**
 * Live place count over a course's `enrolments` subcollection, the ONE way a
 * capacity gate turns documents into a number, and the sibling of
 * `countHoldingSeats`.
 *
 * `nowMs` is sampled ONCE by the caller and threaded through: the number a gate
 * refuses on is the same number it is about to persist, and re-reading the clock
 * per document could count a hold live at the top of a pass and lapsed at the
 * bottom.
 *
 * `excludeId` drops the caller's own enrolment, whose document the gate is about
 * to replace, a buyer re-opening an abandoned checkout, a webhook confirming
 * the hold it created. Counting it would refuse them the place they hold.
 */
export function countHoldingPlaces(
  docs: Array<{ id: string; data(): unknown }>,
  nowMs: number = Date.now(),
  excludeId?: string
): number {
  return docs.reduce(
    (n, d) =>
      d.id !== excludeId &&
      courseBlockEnrolmentHoldsPlace(d.data() as PlaceHold, nowMs)
        ? n + 1
        : n,
    0
  )
}

/** The course fields the place-freed edge reads. */
export interface PlaceCounts {
  places?: number | null
  places_taken?: number
  status?: string
}

/**
 * Did this write FREE A PLACE? The sibling of `seatFreedEdge`, and what a
 * course's waiting list hangs on.
 *
 * THE SAME BINDING COROLLARY: a handler on this edge must NOT write the course
 * document on any path where it decides not to promote, or a "harmless" touch
 * re-enters it for ever. Being an edge is what makes a promoter loop-safe, its
 * own write re-fires the trigger, and on that pass the course is full again.
 *
 * An uncapped course never produces it (it was never full), and neither does a
 * cancelled one (there is no place to hand on).
 */
export function placeFreedEdge(
  before: PlaceCounts | null | undefined,
  after: PlaceCounts | null | undefined
): boolean {
  if (!before || !after) return false
  if (after.status === 'cancelled') return false
  return (
    placesFree(before.places, before.places_taken ?? 0) <= 0 &&
    placesFree(after.places, after.places_taken ?? 0) > 0
  )
}

/**
 * Can this course be bought RIGHT NOW?
 *
 * One predicate, read by the public card (to hide the button), by the checkout
 * callable and by the free-enrolment callable (to refuse), so a visitor is never
 * shown a button that the server will turn down. The same contract
 * `isPastBookingCutoff` has for a session, and deliberately NOT that function:
 * this asks about a course's sales window, not about minutes before one lesson.
 *
 * A draft is not sellable, a cancelled course is not sellable, and a course
 * whose closing date has passed is not sellable. A course with no closing date
 * stays open, which is what a studio that never set one means.
 *
 * It does NOT consider capacity. A full course is a different answer with a
 * different remedy (the waiting list), and fusing the two would make "sold out"
 * and "closed" the same word on the card.
 */
export function courseBlockSalesOpen(
  block: Pick<CourseBlock, 'status' | 'booking_closes_at'>,
  nowMs: number = Date.now()
): boolean {
  if (block.status !== 'published') return false
  if (block.booking_closes_at && block.booking_closes_at.toMillis() <= nowMs) return false
  return true
}

/** Longest a course name may be. Bounded like an activity's. */
export const MAX_COURSE_BLOCK_NAME_LENGTH = 120

/** How many meetings one course may hold. A weekly course runs a term or two;
 *  this is generous for that and small enough that the whole list stays a
 *  single document field, which is what keeps the meeting set atomic. */
export const MAX_COURSE_MEETINGS = 200
