// ─── DUPLICATING A COURSE, AND ADDING A LESSON TO ONE ───────────────────────
//
// Two things a studio does between terms, and they are here together because
// both write a MEETING LIST and nothing else about a course changes.
//
// ── DUPLICATE: the setup, never the people ──────────────────────────────────
//
// "Level 2 Seepferd ran last term; run it again from 4 March." The copy carries
// the price, the places, the plan edge, the class it runs on and the whole
// shape of the timetable; it carries no enrollments, no waiting list, no
// counters, no public mirror, and it lands in DRAFT.
//
// Two rules are decisions rather than plumbing:
//
//  1. THE SHIFT IS IN CIVIL DAYS AT THE STUDIO'S WALL CLOCK. Adding
//     `n * 86_400_000` moves a 15:45 lesson to 14:45 across a DST boundary, and
//     a term duplicated into the next term crosses one by construction. See
//     `shiftWallClockDays`, which owns that.
//  2. SKIP DATES ARE DROPPED, AND THAT MEANS THE LESSON COMES BACK. "No lesson
//     on 8 October" is a fact about one autumn; carried into spring it silently
//     removes a lesson nobody asked about, and the studio finds out in week
//     seven. The copy therefore starts with every date present, which is the
//     error anybody notices immediately.
//
//     Which is why a course that HAS a rule is REGENERATED from the shifted
//     rule rather than having its meeting list moved. Moving the list looks
//     equivalent and is not: the list has a HOLE where the skipped week was, so
//     shifting it carries the hole into the new term. Emptying `excludeDates`
//     on a pattern nothing re-reads changes only what the studio sees when they
//     next open the schedule editor, which is precisely the silent version of
//     this bug. A course whose dates were typed one by one has no rule to
//     re-run, and there its list IS the answer, holes and all, because a typed
//     list has no notion of a skipped week.
//
//     A make-up lesson added to the source is dropped by the same mechanism,
//     for the same reason: it belongs to the term where the lesson it replaced
//     was called off.
//
// ── THE MAKE-UP LESSON ──────────────────────────────────────────────────────
//
// The other half of "one lesson was canceled". `cancelSession` on one lesson
// is the existing path and the course is untouched by it: no place moves, no
// money moves. What the studio then wants is to put the lesson back on another
// day, and that is one meeting appended plus one converge, so everybody already
// enrolled gets a booking for it without being sold anything.
//
// It is ADDITIVE, like every other schedule write here: it creates the session
// it adds and leaves every existing one alone, because a lesson already on the
// calendar may be one people hold bookings on.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  COURSE_BLOCKS_COLLECTION,
  MAX_COURSE_BLOCK_NAME_LENGTH,
  MAX_COURSE_MEETINGS,
  SESSION_SERIES_COLLECTION,
  firstMeeting,
  orderedMeetings,
  type CourseBlock,
  type CourseMeeting,
} from '@linyup/shared'
import { to } from '../utils/async'
import { requireCapability } from '../utils/teams'
import { civilDaysBetween, shiftWallClockDays } from '../utils/recurrence'
import { materializeOccurrences, SESSIONS_COLLECTION } from '../sessions/series'
import { resolveCourseSchedule } from './schedule'
import { syncCourseBlockRoster } from './enrolment'
import { FIXED_SERIES_STATUS, __courseBlockInternals } from './index'

const { buildSeriesTemplate, nominalDuration } = __courseBlockInternals

/**
 * Everything about a course that is NOT carried into a copy.
 *
 * Stated as a deny-list so a field added to `CourseBlock` later is inherited by
 * default, which is the safe direction for SETUP data and the same choice
 * `duplicateEvent` made. Anything that is a fact about people, about money that
 * moved, or about this particular run of the course, is named here.
 */
export const DROPPED_ON_DUPLICATE = new Set([
  'id',
  // who was on it, and how full it got
  'places_taken',
  'fanout_conflicts',
  'roster_version',
  // this run's own calendar and lessons
  'seriesId',
  'meetings',
  'pattern',
  'booking_closes_at',
  // provenance and publication: a copy is never born public
  'status',
  'cancelled_at',
  'created_at',
  'updated_at',
  'createdBy',
  // handled explicitly
  'name',
])

/** The part of the source that survives, before the copy's own name, dates and
 *  counters are layered on. Pure, so "never copies the roster, never inherits
 *  published" is a fixture rather than a claim. */
export function carriedCourseFields(source: Record<string, unknown>): Record<string, unknown> {
  const carried: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!DROPPED_ON_DUPLICATE.has(key)) carried[key] = value
  }
  return carried
}

/**
 * The copy's meeting list: every meeting moved by the same whole number of
 * calendar days, each keeping its own wall-clock time and its own length.
 *
 * Moving each meeting independently rather than regenerating from the pattern
 * is what preserves a weekend course's two different day lengths, and what
 * makes a hand-typed list of dates duplicable at all.
 */
export function shiftMeetings(meetings: CourseMeeting[], days: number): CourseMeeting[] {
  return meetings.map((m) => ({
    start: Timestamp.fromDate(shiftWallClockDays(m.start.toDate(), days)),
    end: Timestamp.fromDate(shiftWallClockDays(m.end.toDate(), days)),
  }))
}

/** The stored pattern, moved to the new term and stripped of its skip dates.
 *  See rule 2 in the header for why they go, and for why the meeting list is
 *  then RE-RUN from this rather than shifted. */
export function shiftPattern(
  pattern: CourseBlock['pattern'],
  days: number
): CourseBlock['pattern'] {
  if (!pattern?.recurrence) return null
  const r = pattern.recurrence
  const startDate = r.startDate as Timestamp | undefined
  const endDate = r.endDate as Timestamp | undefined
  // THE WEEKDAYS MOVE WITH THE DATES. A weekly rule carries `daysOfWeek`, and
  // shifting only `startDate` left them naming the OLD term's days: duplicating
  // a Wednesday course to start on a Monday generated nothing at all, and the
  // callable failed with "That schedule produces no lessons" rather than
  // producing wrong ones. Shifted by the same delta the dates were, so a course
  // that ran Tuesday and Thursday still runs two days two apart.
  const dayShift = ((days % 7) + 7) % 7
  const daysOfWeek = Array.isArray(r.daysOfWeek)
    ? r.daysOfWeek.map((d) => (d + dayShift) % 7)
    : r.daysOfWeek
  return {
    recurrence: {
      ...r,
      ...(daysOfWeek ? { daysOfWeek } : {}),
      ...(startDate
        ? { startDate: Timestamp.fromDate(shiftWallClockDays(startDate.toDate(), days)) }
        : {}),
      ...(endDate
        ? { endDate: Timestamp.fromDate(shiftWallClockDays(endDate.toDate(), days)) }
        : {}),
      // Dropped, never shifted: a holiday is a fact about one year.
      excludeDates: [],
    },
  }
}

/** `calculateOccurrences`' shape, which is what `materializeOccurrences` takes. */
function toOccurrences(meetings: CourseMeeting[]) {
  return meetings.map((m) => ({ start: m.start.toDate(), end: m.end.toDate() }))
}

async function loadOwnCourse(
  db: FirebaseFirestore.Firestore,
  teamId: string,
  blockId: string
): Promise<{ ref: FirebaseFirestore.DocumentReference; block: CourseBlock; raw: Record<string, unknown> }> {
  const ref = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const doc = await ref.get()
  if (!doc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const raw = doc.data() as Record<string, unknown>
  const block = { ...(raw as unknown as CourseBlock), id: doc.id }
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }
  return { ref, block, raw }
}

/** A `YYYY-MM-DD` from the client, read as the studio's own calendar day. */
function civilDateAtNoon(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpsError('invalid-argument', 'A start date is needed, as YYYY-MM-DD.')
  }
  const [y, m, d] = value.split('-').map(Number)
  // Noon, so the instant is unambiguously inside that civil day in every
  // timezone this runs in; only the DAY is read out of it.
  return new Date(Date.UTC(y, m - 1, d, 12))
}

export const duplicateCourseBlock = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const { teamId, blockId, newStartDate, name } = request.data as {
    teamId?: string
    blockId?: string
    newStartDate?: string
    name?: string
  }
  if (!teamId || !blockId) {
    throw new HttpsError('invalid-argument', 'teamId and blockId are required')
  }
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const db = admin.firestore()
  const { block, raw } = await loadOwnCourse(db, teamId, blockId)

  const meetings = orderedMeetings(block)
  const first = firstMeeting(block)
  if (!first) {
    throw new HttpsError('failed-precondition', 'That course has no lessons to copy.')
  }
  const days = civilDaysBetween(first.start.toDate(), civilDateAtNoon(newStartDate))
  const pattern = shiftPattern(block.pattern, days)

  // RE-RUN THE RULE where there is one, so the weeks the old term skipped come
  // back. Shifting the list instead would carry its holes; see rule 2.
  // `resolveCourseSchedule` is the ONE meeting-list resolver, the same one
  // create and reschedule go through, so a copy cannot produce a list the
  // editor would not.
  const shifted = pattern?.recurrence
    ? resolveCourseSchedule({ kind: 'repeating', recurrence: pattern.recurrence }).meetings
    : shiftMeetings(meetings, days)

  const copyName =
    typeof name === 'string' && name.trim()
      ? name.trim().slice(0, MAX_COURSE_BLOCK_NAME_LENGTH)
      : block.name

  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc()
  const seriesRef = db.collection(SESSION_SERIES_COLLECTION).doc()

  const copy = {
    ...carriedCourseFields(raw),
    name: copyName,
    meetings: shifted,
    pattern,
    seriesId: seriesRef.id,
    // The deadline is DERIVED, so it is re-derived from the copy's own first
    // lesson rather than shifted: "closes three days before it starts" has to go
    // on meaning that.
    booking_closes_at:
      typeof block.close_days_before === 'number' && shifted[0]
        ? Timestamp.fromMillis(
            shifted[0].start.toMillis() - block.close_days_before * 24 * 60 * 60_000
          )
        : null,
    // A copy is NEVER born public, whatever the source was. Publishing is a
    // decision about a course that is ready, and a duplicate is by definition
    // not yet checked.
    status: 'draft' as const,
    places_taken: 0,
    roster_version: 1,
    fanout_conflicts: [],
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
    createdBy: request.auth.uid,
  }

  await seriesRef.set({
    teamId,
    teacher: request.auth.uid,
    createdBy: request.auth.uid,
    course_block_id: blockRef.id,
    status: FIXED_SERIES_STATUS,
    template: buildSeriesTemplate(copy as unknown as CourseBlock, nominalDuration(shifted)),
    recurrence: copy.pattern?.recurrence ?? null,
    lastGeneratedUntil: shifted[shifted.length - 1]?.end ?? null,
    totalOccurrences: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
  await blockRef.set(copy)

  const [err, created] = await to(
    materializeOccurrences(db, seriesRef.id, (await seriesRef.get()).data()!, toOccurrences(shifted))
  )
  if (err) {
    console.error('[courseBlocks] could not create the copy’s lessons for', blockRef.id, err)
    throw new HttpsError(
      'internal',
      'The course was copied but its lessons could not be added to the calendar. Open it and save the schedule again.'
    )
  }
  await seriesRef.update({ totalOccurrences: created })

  return {
    id: blockRef.id,
    seriesId: seriesRef.id,
    meetings: shifted.length,
    created,
    shiftedByDays: days,
    // The copy starts with every date present, so it may hold MORE lessons than
    // the course it came from. Reported rather than left to be noticed: the
    // dialog warned about the skip dates, and this is the number that warning
    // was about.
    skipDatesDropped: (block.pattern?.recurrence?.excludeDates ?? []).length,
    lessonsAdded: shifted.length - meetings.length,
  }
})

// ─── the make-up lesson ──────────────────────────────────────────────────────

export const addCourseBlockMeeting = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const { teamId, blockId, start, end } = request.data as {
    teamId?: string
    blockId?: string
    start?: number
    end?: number
  }
  if (!teamId || !blockId) {
    throw new HttpsError('invalid-argument', 'teamId and blockId are required')
  }
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    throw new HttpsError('invalid-argument', 'A lesson needs a start and a later end.')
  }
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const db = admin.firestore()
  const { ref, block } = await loadOwnCourse(db, teamId, blockId)
  if (block.status === 'cancelled') {
    throw new HttpsError('failed-precondition', 'That course was canceled.')
  }
  const seriesId = block.seriesId
  if (!seriesId) throw new HttpsError('failed-precondition', 'That course has no lessons.')

  const meetings = orderedMeetings(block)
  if (meetings.length >= MAX_COURSE_MEETINGS) {
    throw new HttpsError('failed-precondition', 'That course already has as many lessons as it can hold.')
  }
  const added: CourseMeeting = {
    start: Timestamp.fromMillis(start),
    end: Timestamp.fromMillis(end),
  }
  // Same instant as an existing lesson: `materializeOccurrences` dedupes on
  // `(seriesId, instanceDate)` and would write nothing, so the refusal is here,
  // where it can say why.
  if (meetings.some((m) => m.start.toMillis() === added.start.toMillis())) {
    throw new HttpsError('already-exists', 'That course already has a lesson at that time.')
  }

  const next = [...meetings, added].sort((a, b) => a.start.toMillis() - b.start.toMillis())
  const seriesRef = db.collection(SESSION_SERIES_COLLECTION).doc(seriesId)
  const seriesDoc = await seriesRef.get()
  if (!seriesDoc.exists) throw new HttpsError('failed-precondition', 'That course has no lessons.')
  if (seriesDoc.data()?.teardown_job_id) {
    throw new HttpsError('failed-precondition', 'teardown-in-progress')
  }

  const [err, created] = await to(
    materializeOccurrences(db, seriesId, seriesDoc.data()!, toOccurrences([added]))
  )
  if (err) {
    console.error('[courseBlocks] could not add a lesson to', blockId, err)
    throw new HttpsError('internal', 'The lesson could not be added to the calendar. Try again.')
  }

  await ref.update({
    meetings: next,
    // Bumped so the converger knows the roster is owed work, and so a
    // `booking_closes_at` derived from the FIRST lesson is re-derived when a
    // make-up lands before it (rare, and wrong in a way nobody would find).
    roster_version: (block.roster_version ?? 1) + 1,
    ...(typeof block.close_days_before === 'number'
      ? {
          booking_closes_at: Timestamp.fromMillis(
            next[0].start.toMillis() - block.close_days_before * 24 * 60 * 60_000
          ),
        }
      : {}),
    updated_at: FieldValue.serverTimestamp(),
  })
  await seriesRef.update({
    lastGeneratedUntil: next[next.length - 1].end,
    totalOccurrences: FieldValue.increment(created),
    updatedAt: FieldValue.serverTimestamp(),
  })

  // Everybody already enrolled gets a booking for the new lesson, and nobody is
  // sold anything: the course was bought once, and this is part of it.
  const roster = await syncCourseBlockRoster(db, blockId)

  return {
    id: blockId,
    meetings: next.length,
    created,
    bookingsWritten: roster.written,
    conflicts: roster.conflicts,
  }
})

/** Exported for the tests. */
export const __duplicateInternals = { SESSIONS_COLLECTION }
