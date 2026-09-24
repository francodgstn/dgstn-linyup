// ─── Session series → sessions: the ONE materialisation path ─────────────────
//
// Everything that turns a `session_series` doc into `sessions/*` docs goes
// through here: the `generateRecurringSessions` callable (at creation), the
// `rollSessionSeries` daily task (the rolling horizon),
// `updateRecurringSession`'s regeneration branch (after a recurrence edit), and
// `createCourseBlock` / `updateCourseBlock` (a course's lessons, materialised in
// full from its meeting list rather than rolled).
//
// Two properties this module owns, both of which were previously duplicated,
// and, being duplicated, had already drifted:
//
// 1. THE GENERATED SESSION SHAPE. `buildSeriesSessionDoc` is the only writer of
//    a series-generated session. Before it existed the recurring path wrote a
//    different document from the single-session form (no `duration_minutes`,
//    `placeId`, `roomId` or `autoConfirm`), so the same class behaved
//    differently depending on how it had been created.
// 2. THE DEDUPE RULE. One occurrence == one `(seriesId, instanceDate)` pair.
//    `materializeOccurrences` refuses to write a second session for a pair that
//    already has one, which is what makes every caller — and a re-run of any of
//    them — idempotent. There is no second dedupe rule anywhere. It is answered
//    by ONE read of the series' existing `instanceDate`s; a failing read THROWS
//    rather than falling through to a write, because an occurrence whose
//    existence we could not establish is better left for the next run than
//    duplicated in front of everyone holding a booking link.
import { Timestamp, FieldValue, type Firestore, type DocumentData } from 'firebase-admin/firestore'
import { SESSION_SERIES_COLLECTION, SESSIONS_COLLECTION } from '@linyup/shared'
import { to } from '../utils/async'

export { SESSION_SERIES_COLLECTION, SESSIONS_COLLECTION }

/** How far ahead a series is materialised, in months. The calendar never holds
 *  more than this, and — thanks to `rollSessionSeries` — never less. */
export const SERIES_HORIZON_MONTHS = 6
/** A series is rolled forward once its coverage reaches inside this window, so
 *  the daily task does real work roughly once a quarter per series and is a
 *  cheap read for every other run. */
export const SERIES_REFRESH_MONTHS = 3

/** Firestore's hard cap on a single batched write. */
const BATCH_SIZE = 500

export interface Occurrence {
  start: Date
  end: Date
}

/**
 * The generated-session document — kept field-for-field in step with the single
 * session written by `SessionFormDialog.basePayload`.
 *
 * `autoConfirm` is written only when the series template actually carries one.
 * The booking callables fall back to the ACTIVITY when the session has no
 * boolean (`booking/index.ts` → `resolveAutoConfirm`), so a made-up default here
 * would silently override a studio's activity setting on every legacy series.
 * Absent means "ask the activity"; that is the correct answer, not a gap.
 */
export function buildSeriesSessionDoc(
  seriesId: string,
  seriesData: DocumentData,
  occurrence: Occurrence
): DocumentData {
  const tpl = (seriesData.template ?? {}) as DocumentData
  const teamId = (seriesData.teamId || seriesData.teacher) as string
  // Derived from the occurrence rather than read from the template: it is the
  // same number by construction (the recurrence's duration produced the pair)
  // and it is right even for a legacy series whose template predates the field.
  const durationMinutes = Math.max(
    1,
    Math.round((occurrence.end.getTime() - occurrence.start.getTime()) / 60000)
  )

  return {
    seriesId,
    // A COURSE'S LESSONS CARRY THE COURSE. Read from the SERIES, not the
    // template: it is a fact about which series this is, and putting it in the
    // template would let a studio edit a lesson out of its own course.
    ...(seriesData.course_block_id ? { course_block_id: seriesData.course_block_id } : {}),
    instanceDate: Timestamp.fromDate(occurrence.start),
    start: Timestamp.fromDate(occurrence.start),
    end: Timestamp.fromDate(occurrence.end),
    activityId: tpl.activityId ?? null,
    activityName: tpl.activityName ?? null,
    activityType: tpl.activityType ?? null,
    location: tpl.location ?? null,
    placeId: tpl.placeId ?? null,
    roomId: tpl.roomId ?? null,
    tags: tpl.tags ?? [],
    notes: tpl.notes ?? '',
    headline: tpl.headline ?? null,
    headlinePublic: tpl.headlinePublic ?? false,
    allowBooking: tpl.allowBooking ?? false,
    providerName: tpl.providerName ?? null,
    providerId: tpl.providerId ?? null,
    max_participants: tpl.max_participants ?? null,
    bookingMandatory: tpl.bookingMandatory ?? false,
    duration_minutes: durationMinutes,
    ...(typeof tpl.autoConfirm === 'boolean' ? { autoConfirm: tpl.autoConfirm } : {}),
    teamId,
    teacher: seriesData.teacher,
    createdBy: seriesData.createdBy || seriesData.teacher,
    participants_count: 0,
    isException: false,
    exceptionType: null,
  }
}

/**
 * Writes one session per occurrence that does not already have one, and returns
 * how many were created.
 *
 * IDEMPOTENCY. Every `(seriesId, instanceDate)` pair the series already has is
 * read once, up front, into a set; an occurrence whose pair is in it is skipped.
 * Two runs on the same day therefore create the same set exactly once — the
 * second finds every pair taken. A FAILING dedupe read THROWS rather than
 * falling through to writes: occurrences whose existence we could not establish
 * are left for the next run, because a duplicate class is visible to every
 * member holding a booking link while a one-day delay is visible to nobody.
 */
export async function materializeOccurrences(
  db: Firestore,
  seriesId: string,
  seriesData: DocumentData,
  occurrences: Occurrence[]
): Promise<number> {
  let created = 0

  // ONE read for the whole series, not one per occurrence. This used to run a
  // `(seriesId, instanceDate)` query inside the occurrence loop — 26 sequential
  // round-trips for a 6-month weekly class and ~180 for a daily one, which is
  // the entire reason creating a series felt like it had hung. The rule it
  // enforces is unchanged (one occurrence == one `(seriesId, instanceDate)`
  // pair); only the number of queries that answer it is.
  //
  // Deliberately NOT bounded to the occurrence window: a range on
  // `instanceDate` beside the `seriesId` equality is the one query shape that
  // would need a composite index, and this projection is a handful of
  // timestamps per series.
  const [takenErr, takenSnap] = await to(
    db.collection(SESSIONS_COLLECTION).where('seriesId', '==', seriesId).select('instanceDate').get()
  )
  if (takenErr) throw takenErr
  const taken = new Set<number>()
  for (const d of takenSnap?.docs ?? []) {
    const at = d.get('instanceDate') as Timestamp | undefined
    if (at) taken.add(at.toMillis())
  }

  for (let i = 0; i < occurrences.length; i += BATCH_SIZE) {
    const slice = occurrences.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    let inBatch = 0

    for (const occurrence of slice) {
      // Guards against a duplicate WITHIN this run as well as against one
      // already on the server — the recurrence calculator is not required to
      // return a distinct set.
      const key = occurrence.start.getTime()
      if (taken.has(key)) continue
      taken.add(key)

      batch.set(
        db.collection(SESSIONS_COLLECTION).doc(),
        buildSeriesSessionDoc(seriesId, seriesData, occurrence)
      )
      inBatch++
    }

    if (inBatch > 0) {
      await batch.commit()
      created += inBatch
    }
  }

  return created
}

/** The metadata write that follows a successful materialisation. Kept here so
 *  `lastGeneratedUntil` is only ever set to an instant sessions were actually
 *  generated to — a horizon that claims sessions which do not exist makes the
 *  daily roller skip the very series that needs it. */
export function seriesHorizonUpdate(generatedUntil: Date, created: number): DocumentData {
  return {
    lastGeneratedUntil: Timestamp.fromDate(generatedUntil),
    totalOccurrences: FieldValue.increment(created),
    updatedAt: FieldValue.serverTimestamp(),
  }
}
