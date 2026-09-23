// ─── COURSE BLOCKS — the scheduling half ─────────────────────────────────────
//
// A course is a bounded set of lessons sold as one thing. This file creates,
// reschedules and deletes one; enrolment, capacity and the sale arrive in their
// own stages, and nothing here writes a price.
//
// ── THE OWNED SERIES ────────────────────────────────────────────────────────
//
// A course OWNS one `session_series/{id}`, and its lessons are that series'
// sessions. That is what makes them ORDINARY sessions — roster, attendance,
// check-in, reminders, cancellation, the coach's busy set and the existing
// teardown job all work with no new code, and `materializeOccurrences` stays
// the ONE materialisation path with its one `(seriesId, instanceDate)` dedupe
// rule.
//
// The series is written with `course_block_id` and `status: 'fixed'`, a status
// that means MATERIALISED IN FULL, NOTHING TO ROLL. The daily roller queries
// `status == 'active'`, so a fixed series is never even read; `planSeriesRoll`
// refuses it a second time, structurally, in case somebody flips a status back.
//
// The series document is NOT skipped, tempting as it is: `freezeSeriesForTeardown`
// and `endSeriesAfterTeardown` call `update()` on it, and an `update()` on a
// missing document throws — so a course with no series doc would break "cancel
// the whole course" silently.
//
// ── THE REFUSALS ────────────────────────────────────────────────────────────
//
// `updateRecurringSession` and `cancelSession` refuse a series carrying
// `course_block_id` (sessions/index.ts, the same shape as the `teardown_job_id`
// refusal beside them). That is load-bearing rather than tidy: the recurrence
// edit branch DELETES future sessions outright, with no bookings check, and a
// deleted lesson may be one nine people have paid for.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  COURSE_BLOCKS_COLLECTION,
  MAX_COURSE_BLOCK_NAME_LENGTH,
  SESSION_SERIES_COLLECTION,
  type Activity,
  type CourseBlock,
  type CourseMeeting,
} from '@linyup/shared'
import { to } from '../utils/async'
import { requireCapability } from '../utils/teams'
import { materializeOccurrences, SESSIONS_COLLECTION } from '../sessions/series'
import { resolveCourseSchedule, type CourseScheduleInput } from './schedule'

/** The series status that means "every occurrence exists; there is nothing to
 *  roll". The roller's query (`status == 'active'`) is what makes it free. */
export const FIXED_SERIES_STATUS = 'fixed'

interface CourseBlockWrite {
  name?: unknown
  description?: unknown
  activityId?: unknown
  placeId?: unknown
  roomId?: unknown
  location?: unknown
  providerId?: unknown
  providerName?: unknown
  places?: unknown
  schedule?: CourseScheduleInput
}

function requireTeamId(data: unknown): string {
  const teamId = (data as { teamId?: unknown })?.teamId
  if (typeof teamId !== 'string' || !teamId) {
    throw new HttpsError('invalid-argument', 'teamId is required')
  }
  return teamId
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_COURSE_BLOCK_NAME_LENGTH) : ''
  if (!name) throw new HttpsError('invalid-argument', 'A course needs a name.')
  return name
}

function optionalString(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, max)
  return trimmed || null
}

/** Places: absent, null or 0 all mean uncapped, matching `placesFree`. */
function cleanPlaces(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpsError('invalid-argument', 'Places has to be a number.')
  }
  return n > 0 ? Math.floor(n) : null
}

/**
 * The series template — the field-for-field shape `buildSeriesSessionDoc` copies
 * onto every generated session, and the same one `SessionFormDialog` writes for
 * a hand-made series.
 *
 * Two defaults are decisions, not conveniences:
 *
 * - `allowBooking: false`. A course lesson is sold as part of the course, not
 *   individually, so it is not separately bookable and carries no public
 *   booking form of its own. The mirror still publishes it (see
 *   `syncSessionPublicProfile`) so a public calendar can SHOW the lesson and
 *   point at the course.
 * - `max_participants: places`. The course's capacity, copied down, so a
 *   stray drop-in cannot take a seat the course has already sold. The course's
 *   own counter remains the authority; this is the session-level backstop.
 */
function buildSeriesTemplate(
  block: Pick<
    CourseBlock,
    'activityId' | 'activityName' | 'placeId' | 'roomId' | 'location' | 'providerId' | 'providerName' | 'places'
  >,
  durationMinutes: number
): Record<string, unknown> {
  return {
    activityId: block.activityId ?? null,
    activityName: block.activityName ?? null,
    activityType: 'class',
    location: block.location ?? null,
    placeId: block.placeId ?? null,
    roomId: block.roomId ?? null,
    tags: [],
    notes: '',
    headline: null,
    headlinePublic: false,
    duration: durationMinutes,
    allowBooking: false,
    bookingMandatory: false,
    providerName: block.providerName ?? null,
    providerId: block.providerId ?? null,
    max_participants: block.places ?? null,
  }
}

/** `calculateOccurrences`' shape, from a stored meeting list — what
 *  `materializeOccurrences` takes. */
function toOccurrences(meetings: CourseMeeting[]) {
  return meetings.map((m) => ({ start: m.start.toDate(), end: m.end.toDate() }))
}

/** A meeting list's first length, which is what the series template records as
 *  its nominal duration. Each session's real `duration_minutes` is derived from
 *  its OWN occurrence pair by `buildSeriesSessionDoc`, which is exactly why a
 *  weekend course with two different day lengths works. */
function nominalDuration(meetings: CourseMeeting[]): number {
  const first = meetings[0]
  if (!first) return 60
  return Math.max(1, Math.round((first.end.toMillis() - first.start.toMillis()) / 60_000))
}

async function loadActivityName(
  db: FirebaseFirestore.Firestore,
  teamId: string,
  activityId: string | null
): Promise<string | null> {
  if (!activityId) return null
  const [, doc] = await to(db.collection(ACTIVITIES_COLLECTION).doc(activityId).get())
  if (!doc?.exists) return null
  const activity = doc.data() as Activity
  if (activity.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That class belongs to another studio.')
  }
  if (activity.type === 'appointment') {
    // An appointment has no calendar until somebody books it, so a set of them
    // is not a course. The price is its only gate, and a course's price is the
    // course's.
    throw new HttpsError('invalid-argument', 'A course runs on a class, not an appointment.')
  }
  return activity.name ?? null
}

// ─── createCourseBlock ───────────────────────────────────────────────────────

export const createCourseBlock = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const teamId = requireTeamId(request.data)
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const data = request.data as CourseBlockWrite
  const schedule = resolveCourseSchedule(data.schedule as CourseScheduleInput)
  const db = admin.firestore()

  const activityId = optionalString(data.activityId, 200)
  const activityName = await loadActivityName(db, teamId, activityId)

  const block = {
    teamId,
    name: cleanName(data.name),
    description: optionalString(data.description, 2000),
    activityId,
    activityName,
    placeId: optionalString(data.placeId, 200),
    roomId: optionalString(data.roomId, 200),
    location: optionalString(data.location, 120),
    providerId: optionalString(data.providerId, 200),
    providerName: optionalString(data.providerName, 120),
    places: cleanPlaces(data.places),
    meetings: schedule.meetings,
    pattern: schedule.recurrence ? { recurrence: schedule.recurrence } : null,
    // A course lands in draft: its lessons exist on the calendar so the studio
    // can look at them, and nothing about it is public or sellable until it
    // says so.
    status: 'draft' as const,
    places_taken: 0,
    roster_version: 1,
    fanout_conflicts: [],
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
    createdBy: request.auth.uid,
  }

  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc()

  // The series first, and the course's own `seriesId` with it: a course whose
  // series id were written later could be read, between the two writes, as a
  // course with no lessons.
  const seriesRef = db.collection(SESSION_SERIES_COLLECTION).doc()
  await seriesRef.set({
    teamId,
    teacher: request.auth.uid,
    createdBy: request.auth.uid,
    course_block_id: blockRef.id,
    // Not 'active': the roller must never touch it. Every occurrence is written
    // below, in full, and the meeting list is the only thing that changes it.
    status: FIXED_SERIES_STATUS,
    template: buildSeriesTemplate({ ...block, activityName }, nominalDuration(schedule.meetings)),
    // A course is a list, not a rule — but the rule is kept when there was one,
    // so a reschedule can re-read what the studio typed.
    recurrence: schedule.recurrence ?? null,
    lastGeneratedUntil: schedule.meetings.length
      ? schedule.meetings[schedule.meetings.length - 1].end
      : null,
    totalOccurrences: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  await blockRef.set({ ...block, seriesId: seriesRef.id })

  const [materializeErr, created] = await to(
    materializeOccurrences(db, seriesRef.id, (await seriesRef.get()).data()!, toOccurrences(schedule.meetings))
  )
  if (materializeErr) {
    // Same reasoning as `generateRecurringSessions`: `materializeOccurrences`
    // re-throws a failed dedupe read on purpose, and an unhandled throw out of a
    // gen2 callable reaches the client as the bare word "INTERNAL".
    console.error('[courseBlocks] could not create the lessons for', blockRef.id, materializeErr)
    throw new HttpsError(
      'internal',
      'The course was created but its lessons could not be added to the calendar. Open it and save the schedule again.'
    )
  }
  await seriesRef.update({ totalOccurrences: created })

  return { id: blockRef.id, seriesId: seriesRef.id, meetings: schedule.meetings.length, created }
})

// ─── updateCourseBlock ───────────────────────────────────────────────────────

/**
 * Edits the details, and optionally the schedule.
 *
 * THE SCHEDULE IS ADDITIVE HERE. A new meeting list creates the sessions it adds
 * and leaves every existing one alone — `materializeOccurrences` writes and never
 * deletes, and a lesson already on the calendar may be one people hold bookings
 * on. Removing a lesson is `cancelSession` on that lesson, which returns the
 * seats, closes its waitlist and mails the roster; the meeting list then drops
 * it on the next save.
 *
 * That asymmetry is deliberate and is the same rule `excludeDates` follows: a
 * schedule says what will be CREATED, never what exists.
 */
export const updateCourseBlock = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const teamId = requireTeamId(request.data)
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const data = request.data as CourseBlockWrite & { blockId?: string }
  const blockId = typeof data.blockId === 'string' ? data.blockId : ''
  if (!blockId) throw new HttpsError('invalid-argument', 'blockId is required')

  const db = admin.firestore()
  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const blockDoc = await blockRef.get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const existing = blockDoc.data() as CourseBlock
  if (existing.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }

  const patch: Record<string, unknown> = { updated_at: FieldValue.serverTimestamp() }
  if (data.name !== undefined) patch.name = cleanName(data.name)
  if (data.description !== undefined) patch.description = optionalString(data.description, 2000)
  if (data.places !== undefined) patch.places = cleanPlaces(data.places)
  if (data.placeId !== undefined) patch.placeId = optionalString(data.placeId, 200)
  if (data.roomId !== undefined) patch.roomId = optionalString(data.roomId, 200)
  if (data.location !== undefined) patch.location = optionalString(data.location, 120)
  if (data.providerId !== undefined) patch.providerId = optionalString(data.providerId, 200)
  if (data.providerName !== undefined) patch.providerName = optionalString(data.providerName, 120)
  if (data.activityId !== undefined) {
    const activityId = optionalString(data.activityId, 200)
    patch.activityId = activityId
    patch.activityName = await loadActivityName(db, teamId, activityId)
  }

  let created = 0
  if (data.schedule) {
    const schedule = resolveCourseSchedule(data.schedule)
    patch.meetings = schedule.meetings
    patch.pattern = schedule.recurrence ? { recurrence: schedule.recurrence } : null
    patch.roster_version = (existing.roster_version ?? 1) + 1

    const seriesId = existing.seriesId
    if (!seriesId) throw new HttpsError('failed-precondition', 'That course has no lessons to update.')
    const seriesRef = db.collection(SESSION_SERIES_COLLECTION).doc(seriesId)
    const seriesDoc = await seriesRef.get()
    if (!seriesDoc.exists) throw new HttpsError('failed-precondition', 'That course has no lessons to update.')
    if (seriesDoc.data()?.teardown_job_id) {
      throw new HttpsError('failed-precondition', 'teardown-in-progress')
    }

    await seriesRef.update({
      recurrence: schedule.recurrence ?? null,
      'template.duration': nominalDuration(schedule.meetings),
      ...(patch.places !== undefined ? { 'template.max_participants': patch.places } : {}),
      lastGeneratedUntil: schedule.meetings[schedule.meetings.length - 1].end,
      updatedAt: FieldValue.serverTimestamp(),
    })

    const [err, count] = await to(
      materializeOccurrences(db, seriesId, (await seriesRef.get()).data()!, toOccurrences(schedule.meetings))
    )
    if (err) {
      console.error('[courseBlocks] could not add the new lessons for', blockId, err)
      throw new HttpsError('internal', 'The new lessons could not be added to the calendar. Try again.')
    }
    created = count
    await seriesRef.update({ totalOccurrences: FieldValue.increment(created) })
  }

  await blockRef.update(patch)
  return { id: blockId, created }
})

// ─── setCourseBlockStatus ────────────────────────────────────────────────────

/** Publish a draft, or put a published course back into draft. Cancelling a
 *  whole course is its own callable (it tears the lessons down and mails the
 *  roster), and is not reachable from here. */
export const setCourseBlockStatus = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const teamId = requireTeamId(request.data)
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const { blockId, status } = request.data as { blockId?: string; status?: string }
  if (!blockId) throw new HttpsError('invalid-argument', 'blockId is required')
  if (status !== 'draft' && status !== 'published') {
    throw new HttpsError('invalid-argument', 'A course is either a draft or published here.')
  }

  const db = admin.firestore()
  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const doc = await blockRef.get()
  if (!doc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = doc.data() as CourseBlock
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }
  if (block.status === 'cancelled') {
    throw new HttpsError('failed-precondition', 'That course was cancelled.')
  }

  await blockRef.update({ status, updated_at: FieldValue.serverTimestamp() })
  return { id: blockId, status }
})

// ─── deleteCourseBlock ───────────────────────────────────────────────────────

/**
 * Deletes a course that never ran.
 *
 * REFUSES ONCE ANYONE IS IN IT. A course with enrolments is CANCELLED, not
 * deleted: people are owed a mail, seats are owed back, and the record of who
 * was in it is the studio's. That callable arrives with enrolment; until then
 * there is nothing to enrol, so this is the whole story.
 *
 * The lessons go through the existing teardown path rather than a delete loop
 * of its own — `cancelSession` is the ONE path that calls a session off, and it
 * is what closes waitlists and returns counters.
 */
export const deleteCourseBlock = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const teamId = requireTeamId(request.data)
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const { blockId } = request.data as { blockId?: string }
  if (!blockId) throw new HttpsError('invalid-argument', 'blockId is required')

  const db = admin.firestore()
  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const doc = await blockRef.get()
  if (!doc.exists) return { id: blockId, deleted: true }
  const block = doc.data() as CourseBlock
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }
  if ((block.places_taken ?? 0) > 0) {
    throw new HttpsError(
      'failed-precondition',
      'Somebody is enrolled on that course. Cancel it instead, so they are told.'
    )
  }

  // The lessons: nobody holds a booking (no enrolments, and a course lesson is
  // not separately bookable), so a plain delete is honest here. Batched, because
  // a term course is a few dozen documents.
  if (block.seriesId) {
    const sessions = await db
      .collection(SESSIONS_COLLECTION)
      .where('seriesId', '==', block.seriesId)
      .get()
    for (let i = 0; i < sessions.docs.length; i += 400) {
      const batch = db.batch()
      for (const s of sessions.docs.slice(i, i + 400)) batch.delete(s.ref)
      await batch.commit()
    }
    await db.collection(SESSION_SERIES_COLLECTION).doc(block.seriesId).delete()
  }

  await blockRef.delete()
  return { id: blockId, deleted: true }
})

/** Exported for the tests, and for the sale stage which builds the same shape. */
export const __courseBlockInternals = { buildSeriesTemplate, nominalDuration, cleanPlaces }
