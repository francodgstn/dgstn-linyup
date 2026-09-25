import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { addMonths, getDay } from 'date-fns'
import { to } from '../utils/async'
import { calculateOccurrences, validateRecurrence } from '../utils/recurrence'
import { getHostingUrl } from '../utils/env'
import { enforceWaiverGate } from '../waivers/gate'
import {
  confirmClearedHoldFields,
  buildParticipantDoc,
  localizedPublicUrl,
  SERIES_TEARDOWN_INLINE_MAX,
  SERIES_TEARDOWN_STALE_MS,
  type SeatHold,
} from '@linyup/shared'
import {
  SESSION_SERIES_COLLECTION,
  SESSIONS_COLLECTION,
  SERIES_HORIZON_MONTHS,
  materializeOccurrences,
  seriesHorizonUpdate,
} from './series'
// Canceling a class lives in ./teardown — ONE definition, shared by the inline
// path below and the background worker, so "delete three" and "delete two
// hundred" cannot mean two different things.
import {
  cancelSingleSession,
  countTeardownScope,
  createTeardownJob,
  endSeriesAfterTeardown,
  enqueueTeardownRound,
  freezeSeriesForTeardown,
  getTeamData,
  jobRef,
  teardownScopeQuery,
} from './teardown'

const TEAMS_COLLECTION = 'teams'
const ACTIVITIES_COLLECTION = 'activities'

// ─── generateRecurringSessions ────────────────────────────────────────────────

export const generateRecurringSessions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')

  const { seriesId, fromDate, toDate } = request.data as {
    seriesId?: string
    fromDate?: string
    toDate?: string
  }
  if (!seriesId) throw new HttpsError('invalid-argument', 'seriesId is required')

  const db = admin.firestore()
  const seriesRef = db.collection(SESSION_SERIES_COLLECTION).doc(seriesId)
  const [seriesErr, seriesDoc] = await to(seriesRef.get())

  if (seriesErr) throw new HttpsError('internal', 'Error fetching series document')
  if (!seriesDoc || !seriesDoc.exists)
    throw new HttpsError('not-found', `Recurrence series ${seriesId} not found`)

  const seriesData = seriesDoc.data()!

  if (seriesData.teacher !== request.auth.uid) {
    throw new HttpsError(
      'permission-denied',
      'You do not have permission to generate sessions for this series'
    )
  }

  // The explicit half of the teardown freeze. `rollSessionSeries` is stopped by
  // construction (it rolls `status == 'active'` and a frozen series is
  // 'deleting'), but this callable names a series directly and would happily
  // re-materialize the occurrences a running job is deleting.
  if (seriesData.teardown_job_id) {
    throw new HttpsError('failed-precondition', 'teardown-in-progress')
  }

  const validation = validateRecurrence(seriesData.recurrence)
  if (!validation.valid) {
    throw new HttpsError(
      'invalid-argument',
      `Invalid recurrence pattern: ${validation.errors.join(', ')}`
    )
  }

  const now = new Date()
  const generationStart = fromDate ? new Date(fromDate) : now
  const generationEnd = toDate ? new Date(toDate) : addMonths(now, SERIES_HORIZON_MONTHS)

  const occurrences = calculateOccurrences(seriesData.recurrence, generationStart, generationEnd)
  console.log(`Calculated ${occurrences.length} occurrences for series ${seriesId}`)

  // Shape + dedupe both live in ./series — the same code the daily roller runs,
  // so creating a series and extending it can never drift apart again.
  //
  // WRAPPED, because this is the one step here that can throw something that is
  // not an HttpsError: `materializeOccurrences` deliberately re-throws a failed
  // dedupe read, and an unhandled throw out of a gen2 callable reaches the
  // client as the bare word "INTERNAL" — no code, no message, nothing to act
  // on. It reached a studio exactly that way. The series itself is already
  // committed at this point and the daily `rollSessionSeries` task will fill it
  // in, so the failure is recoverable; it just has to be legible.
  let generatedCount = 0
  try {
    generatedCount = await materializeOccurrences(db, seriesId, seriesData, occurrences)
  } catch (err) {
    console.error(`[sessions] materializeOccurrences failed for series ${seriesId}:`, err)
    throw new HttpsError(
      'internal',
      `Could not create the sessions for this series (${seriesId}). They will be created automatically within a day.`
    )
  }

  await to(seriesRef.update(seriesHorizonUpdate(generationEnd, generatedCount)))

  return {
    success: true,
    generatedCount,
    message: `Successfully generated ${generatedCount} sessions`,
  }
})

// ─── cancelSession ────────────────────────────────────────────────────────────

/**
 * Call off a session — one occurrence, or this one and every later occurrence of
 * its series.
 *
 * A SMALL SCOPE STAYS INLINE. A studio deleting a handful of classes gets the
 * same synchronous answer it always had, with counts to put in a toast. Nothing
 * about that path changed, and making a manager watch a progress bar to delete
 * three sessions would be a worse product.
 *
 * A LARGE SCOPE BECOMES A JOB, because the walk is unbounded: every future
 * occurrence closes a waitlist, hands seats back, moves per-contact counters and
 * mails everybody holding a booking. Past SERIES_TEARDOWN_INLINE_MAX that does
 * not fit in a callable — and timing out halfway is the worst available outcome,
 * because the studio sees a failure and cannot tell which classes were actually
 * called off.
 *
 * THE ORDER OF THE THREE WRITES BELOW IS THE SAFETY PROPERTY (the full
 * concurrency contract lives on SeriesTeardownJob in
 * packages/shared/src/types/sessionSeriesJob.ts):
 *
 *   1. PIN the scope — `cutoff` is the anchor occurrence's start, captured now,
 *      so "and following" means the same set of sessions ten minutes into the
 *      run as it did at the click.
 *   2. FREEZE the series — one synchronous write, BEFORE anything is enqueued.
 *      Enqueue first and there is a window in which the daily roller is still
 *      free to re-materialize the very occurrences the job is deleting.
 *   3. ENQUEUE.
 *
 * Returns `mode` so the client knows whether it is looking at a finished result
 * or a job to follow.
 */
export const cancelSession = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')

  const { sessionId, deleteScope } = request.data as { sessionId?: string; deleteScope?: string }
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId is required')

  const db = admin.firestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const [sessionErr, sessionDoc] = await to(sessionRef.get())

  if (sessionErr) throw new HttpsError('internal', 'Error fetching session')
  if (!sessionDoc || !sessionDoc.exists) throw new HttpsError('not-found', 'Session not found')

  const session = sessionDoc.data()!
  const teamId = (session.teamId || session.teacher) as string

  if (session.teacher !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'You do not have permission to cancel this session')
  }

  const seriesId = session.seriesId as string | undefined
  const isSeriesWide = deleteScope === 'future' && !!seriesId

  // ── The background path ────────────────────────────────────────────────────
  if (isSeriesWide) {
    // SERIES-WIDE ON A COURSE IS CANCELING THE COURSE, and that is the course's
    // own callable: it closes the course first, so nothing can be sold while the
    // lessons are coming down, and it hands back the payments to refund. Reached
    // from here it would strip the lessons and leave a course that still says
    // "13 lessons, 4 places left".
    //
    // CANCELING ONE LESSON IS FINE and deliberately not refused: seats return,
    // the roster is mailed, and the course itself is untouched, which is what
    // "no lesson on 8.10, we'll add a make-up" means.
    const [courseErr, courseSeries] = await to(
      db.collection(SESSION_SERIES_COLLECTION).doc(seriesId!).get()
    )
    if (courseErr) throw new HttpsError('internal', 'Failed to read the series')
    const courseBlockId = courseSeries?.data()?.course_block_id as string | undefined
    if (courseBlockId) {
      throw new HttpsError('failed-precondition', 'belongs-to-course', { courseBlockId })
    }

    const cutoff = session.start as Timestamp

    // A series already being torn down must not acquire a second job: two
    // chains over one scope would claim sessions from each other and, worse,
    // double-mail the rosters they raced on.
    //
    // THE MARKER IS NOT THE ANSWER — THE JOB'S STATUS IS. A run that stopped
    // early leaves the series frozen on purpose (nothing may regenerate into a
    // half-removed future), so keying the refusal on `teardown_job_id` alone
    // would make a FAILED teardown permanent: the studio could never retry, and
    // the only way out would be editing Firestore by hand. So the marker is
    // followed to the job it names, and only a job that is still `running`
    // refuses. A terminal one is history, and the series is frozen exactly the
    // way a fresh attempt wants it.
    const [frozenErr, frozenDoc] = await to(
      db.collection(SESSION_SERIES_COLLECTION).doc(seriesId).get()
    )
    if (frozenErr) throw new HttpsError('internal', 'Failed to read the series')
    const priorJobId = frozenDoc?.exists
      ? (frozenDoc.data()?.teardown_job_id as string | undefined)
      : undefined
    if (priorJobId) {
      const [priorErr, priorDoc] = await to(jobRef(db, priorJobId).get())
      // A marker we cannot resolve is treated as LIVE. Guessing the other way
      // starts a second chain over a scope that may still be draining, and that
      // is the one mistake here that reaches a member's inbox.
      if (priorErr) {
        throw new HttpsError('failed-precondition', 'teardown-already-running', {
          jobId: priorJobId,
        })
      }
      const prior = priorDoc?.exists
        ? (priorDoc.data() as { status?: string; updated_at?: Timestamp })
        : undefined
      // A chain can die outright — one round exhausting its Cloud Tasks retries
      // leaves `running` with nothing behind it. So "running" is believed only
      // while the job is still BEATING; past the stale window a fresh attempt is
      // allowed, which is safe because the per-session claim, not this guard, is
      // what stops a roster being mailed twice.
      const beatMs = prior?.updated_at?.toMillis?.() ?? 0
      const stale = Date.now() - beatMs > SERIES_TEARDOWN_STALE_MS
      if ((prior?.status ?? 'running') === 'running' && prior && !stale) {
        throw new HttpsError('failed-precondition', 'teardown-already-running', {
          jobId: priorJobId,
        })
      }
    }

    const [countErr, total] = await to(countTeardownScope(db, seriesId, cutoff))
    if (countErr) throw new HttpsError('internal', 'Failed to measure the series')

    if ((total ?? 0) > SERIES_TEARDOWN_INLINE_MAX) {
      const jobId = await createTeardownJob({
        db,
        teamId,
        seriesId,
        anchorSessionId: sessionId,
        cutoff,
        total: total!,
        createdBy: request.auth.uid,
      })

      // Freeze BEFORE enqueue — see the note above. If the enqueue then fails we
      // are left with a frozen series and a `running` job that nothing drains:
      // visible, recoverable, and strictly safer than a live series racing a
      // worker. The job is failed explicitly so it never shows as in-flight.
      await freezeSeriesForTeardown(db, seriesId, jobId)
      const [enqueueErr] = await to(enqueueTeardownRound(jobId, 1))
      if (enqueueErr) {
        await to(
          jobRef(db, jobId).update({
            status: 'failed',
            error: 'could not be queued',
            finished_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
          })
        )
        throw new HttpsError('internal', 'Could not start the deletion job')
      }

      return { success: true, mode: 'background' as const, jobId, total }
    }
  }

  // ── The inline path ────────────────────────────────────────────────────────
  let sessionsToCancel: Array<{
    id: string
    ref: admin.firestore.DocumentReference
    data: admin.firestore.DocumentData
  }> = []

  if (isSeriesWide) {
    const [futureErr, futureSnap] = await to(
      teardownScopeQuery(db, seriesId!, session.start as Timestamp).get()
    )
    if (futureErr) throw new HttpsError('internal', 'Failed to fetch future sessions')
    sessionsToCancel = (futureSnap?.docs ?? []).map((doc) => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data(),
    }))
  } else {
    sessionsToCancel = [{ id: sessionId, ref: sessionRef, data: session }]
  }

  const teamData = await getTeamData(db, teamId)
  let totalSent = 0
  let totalFailed = 0

  for (const s of sessionsToCancel) {
    const { sent, failed } = await cancelSingleSession(
      db,
      s.id,
      s.ref,
      s.data,
      teamData,
      deleteScope === 'single' && !!seriesId
    )
    totalSent += sent
    totalFailed += failed
  }

  // "This and all following" ENDS the series, on the inline path exactly as on
  // the background one. Leaving it active was a real defect: rollSessionSeries
  // resumes from `lastGeneratedUntil`, so a few months later the deleted class
  // quietly reappeared beyond the old horizon and nothing had asked for it.
  if (isSeriesWide) await endSeriesAfterTeardown(db, seriesId!)

  return {
    success: true,
    mode: 'inline' as const,
    cancelledCount: sessionsToCancel.length,
    notificationsSent: totalSent,
    notificationsFailed: totalFailed,
  }
})

// ─── updateRecurringSession ───────────────────────────────────────────────────

function toTimestamp(val: unknown): Timestamp {
  if (!val) return val as Timestamp
  if (val instanceof Timestamp) return val
  const v = val as Record<string, number>
  if (v._seconds !== undefined) return new Timestamp(v._seconds, v._nanoseconds ?? 0)
  if (v.seconds !== undefined) return new Timestamp(v.seconds, v.nanoseconds ?? 0)
  if (val instanceof Date) return Timestamp.fromDate(val)
  const parsed = new Date(val as string | number)
  return isNaN(parsed.getTime()) ? (val as Timestamp) : Timestamp.fromDate(parsed)
}

export const updateRecurringSession = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')

  const { sessionId, updates, editScope } = request.data as {
    sessionId?: string
    updates?: Record<string, unknown>
    editScope?: 'single' | 'future'
  }
  if (!sessionId || !updates || !editScope) {
    throw new HttpsError('invalid-argument', 'sessionId, updates, and editScope are required')
  }

  const db = admin.firestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const [sessionErr, sessionDoc] = await to(sessionRef.get())
  if (sessionErr || !sessionDoc || !sessionDoc.exists)
    throw new HttpsError('not-found', 'Session not found')

  const session = sessionDoc.data()!

  if (session.teacher !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'You do not have permission to update this session')
  }
  if (!session.seriesId) throw new HttpsError('invalid-argument', 'This is not a recurring session')

  // Read the series UP FRONT, for both scopes, so the teardown freeze can be
  // enforced on both. 'single' looks harmless — it only marks one occurrence as
  // an exception — but `isException: true` is exactly what removes a session
  // from the teardown's scope query, so an edit landing mid-run would leave one
  // orphaned occurrence standing in a series the studio deleted.
  const seriesRef = db.collection(SESSION_SERIES_COLLECTION).doc(session.seriesId as string)
  const [seriesErr, seriesDoc] = await to(seriesRef.get())
  if (seriesErr || !seriesDoc || !seriesDoc.exists)
    throw new HttpsError('not-found', 'Recurrence series not found')
  if (seriesDoc.data()?.teardown_job_id) {
    throw new HttpsError('failed-precondition', 'teardown-in-progress')
  }
  // A COURSE'S LESSONS ARE NOT EDITED FROM HERE. The 'future' scope's
  // regeneration branch DELETES future sessions whose weekday no longer matches,
  // with no bookings check, and on a course those are lessons people have paid
  // to attend. The course's own callables rewrite the meeting list and add what
  // is missing; removing a lesson goes through `cancelSession` on that lesson,
  // which returns the seats and tells the roster.
  if (seriesDoc.data()?.course_block_id) {
    throw new HttpsError('failed-precondition', 'belongs-to-course', {
      courseBlockId: seriesDoc.data()?.course_block_id,
    })
  }

  // Whitelist allowed update fields — prevents overwriting privileged fields
  // like teacher, teamId, seriesId, isException, createdBy, etc.
  const ALLOWED_UPDATE_FIELDS = new Set([
    'title',
    'description',
    'start',
    'end',
    'duration',
    'location',
    'tags',
    'maxParticipants',
    'type',
    'notes',
    'headline',
    'headlinePublic',
    'recurrence',
    'activityId',
    'activityName',
    'activityType',
    'providerName',
    'providerId',
    'allowBooking',
    'max_participants',
    'bookingMandatory',
  ])
  const safeUpdates = Object.fromEntries(
    Object.entries(updates).filter(([k]) => ALLOWED_UPDATE_FIELDS.has(k))
  )
  if (Object.keys(safeUpdates).length === 0) {
    throw new HttpsError('invalid-argument', 'No valid fields to update')
  }

  if (editScope === 'single') {
    const { location: _loc, tags: _tags, ...regularUpdates } = safeUpdates
    const normalized: Record<string, unknown> = { ...regularUpdates }
    if (regularUpdates.start !== undefined) normalized.start = toTimestamp(regularUpdates.start)
    if (regularUpdates.end !== undefined) normalized.end = toTimestamp(regularUpdates.end)
    // Inline location/tags update (no separate function)
    if (_loc !== undefined) normalized.location = _loc
    if (_tags !== undefined) normalized.tags = _tags

    await sessionRef.update({
      ...normalized,
      isException: true,
      exceptionType: 'modified',
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { success: true, message: 'Session updated as exception.', updatedCount: 1 }
  }

  // editScope === 'future' — `seriesRef` / `seriesDoc` were read above, where
  // the teardown freeze is enforced for both scopes.
  const [futureErr, futureSnap] = await to(
    db
      .collection(SESSIONS_COLLECTION)
      .where('seriesId', '==', session.seriesId)
      .where('start', '>=', session.start)
      .where('isException', '==', false)
      .get()
  )
  if (futureErr) throw new HttpsError('internal', 'Failed to fetch future sessions')

  const {
    location,
    tags,
    start,
    end,
    duration,
    recurrence: recurrenceUpdates,
    ...regularUpdates
  } = safeUpdates

  let newTimeHours: number | null = null
  let newTimeMinutes: number | null = null
  let newDuration: number | null = null

  if (start !== undefined) {
    const ts = toTimestamp(start).toDate()
    newTimeHours = ts.getUTCHours()
    newTimeMinutes = ts.getUTCMinutes()
  }
  if (start !== undefined && end !== undefined) {
    newDuration = Math.round(
      (toTimestamp(end).toDate().getTime() - toTimestamp(start).toDate().getTime()) / 60000
    )
  } else if (duration !== undefined) {
    newDuration = duration as number
  }

  const batch = db.batch()
  for (const doc of futureSnap?.docs ?? []) {
    const perDoc: Record<string, unknown> = {
      ...regularUpdates,
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (location !== undefined) perDoc.location = location
    if (tags !== undefined) perDoc.tags = tags

    if (newTimeHours !== null && newTimeMinutes !== null) {
      const orig = (doc.data().start as Timestamp).toDate()
      const newStart = new Date(
        Date.UTC(
          orig.getUTCFullYear(),
          orig.getUTCMonth(),
          orig.getUTCDate(),
          newTimeHours,
          newTimeMinutes,
          0,
          0
        )
      )
      perDoc.start = Timestamp.fromDate(newStart)
      perDoc.instanceDate = perDoc.start
      if (newDuration)
        perDoc.end = Timestamp.fromDate(new Date(newStart.getTime() + newDuration * 60000))
    } else if (newDuration) {
      const orig = (doc.data().start as Timestamp).toDate()
      perDoc.end = Timestamp.fromDate(new Date(orig.getTime() + newDuration * 60000))
      perDoc.duration = newDuration
    }

    batch.update(doc.ref, perDoc)
  }

  const generationEnd = addMonths(new Date(), SERIES_HORIZON_MONTHS)
  // NO `lastGeneratedUntil` HERE. This used to bump the stored horizon to
  // now + 6 months on every "this and following" edit while generating nothing,
  // so the field claimed sessions that did not exist. That is not a cosmetic
  // lie: `rollSessionSeries` reads it to decide whether a series still has
  // runway, so a false horizon parks the roller for three months on precisely
  // the series a manager just touched. The field is now written only where
  // sessions were actually materialized to that instant — the regeneration
  // branch at the end of this function, and nowhere else in here.
  const seriesUpdates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  }
  if (updates.activityId !== undefined) seriesUpdates['template.activityId'] = updates.activityId
  if (updates.activityName !== undefined)
    seriesUpdates['template.activityName'] = updates.activityName
  if (updates.activityType !== undefined)
    seriesUpdates['template.activityType'] = updates.activityType
  if (location !== undefined) seriesUpdates['template.location'] = location
  if (tags !== undefined) seriesUpdates['template.tags'] = tags
  if (updates.notes !== undefined) seriesUpdates['template.notes'] = updates.notes
  if (updates.headline !== undefined) seriesUpdates['template.headline'] = updates.headline
  if (updates.headlinePublic !== undefined)
    seriesUpdates['template.headlinePublic'] = updates.headlinePublic
  if (updates.allowBooking !== undefined)
    seriesUpdates['template.allowBooking'] = updates.allowBooking
  if (updates.providerName !== undefined)
    seriesUpdates['template.providerName'] = updates.providerName
  if (updates.providerId !== undefined)
    seriesUpdates['template.providerId'] = updates.providerId
  if (updates.max_participants !== undefined)
    seriesUpdates['template.max_participants'] = updates.max_participants
  if (updates.bookingMandatory !== undefined)
    seriesUpdates['template.bookingMandatory'] = updates.bookingMandatory

  if (start !== undefined && newTimeHours !== null && newTimeMinutes !== null) {
    const seriesData = seriesDoc.data()!
    const currentStart = (seriesData.recurrence.startDate as Timestamp).toDate()
    seriesUpdates['recurrence.startDate'] = Timestamp.fromDate(
      new Date(
        Date.UTC(
          currentStart.getUTCFullYear(),
          currentStart.getUTCMonth(),
          currentStart.getUTCDate(),
          newTimeHours,
          newTimeMinutes,
          0,
          0
        )
      )
    )
  }
  if (newDuration) {
    seriesUpdates['recurrence.duration'] = newDuration
    seriesUpdates['template.duration'] = newDuration
  }

  let recurrenceChanged = false
  let newRecurrence: Record<string, unknown> | null = null

  if (recurrenceUpdates && typeof recurrenceUpdates === 'object') {
    const ru = recurrenceUpdates as Record<string, unknown>
    const seriesData = seriesDoc.data()!
    newRecurrence = {
      ...(seriesData.recurrence as Record<string, unknown>),
      ...(seriesUpdates['recurrence.startDate']
        ? { startDate: seriesUpdates['recurrence.startDate'] }
        : {}),
    }

    for (const key of [
      'frequency',
      'interval',
      'daysOfWeek',
      'endCondition',
      'maxOccurrences',
    ] as const) {
      if (ru[key] !== undefined) {
        seriesUpdates[`recurrence.${key}`] = ru[key]
        ;(newRecurrence as Record<string, unknown>)[key] = ru[key]
        recurrenceChanged = true
      }
    }
    if (ru.endDate !== undefined) {
      const endDateVal = ru.endDate ? toTimestamp(ru.endDate) : null
      seriesUpdates['recurrence.endDate'] = endDateVal
      newRecurrence.endDate = endDateVal
      recurrenceChanged = true
    }
  }

  batch.update(seriesRef, seriesUpdates)
  await batch.commit()

  let deletedCount = 0
  let generatedCount = 0

  if (recurrenceChanged && newRecurrence) {
    const sessionStart = session.start as Timestamp
    const [allFutureErr, allFutureSnap] = await to(
      db
        .collection(SESSIONS_COLLECTION)
        .where('seriesId', '==', session.seriesId)
        .where('start', '>=', sessionStart)
        .where('isException', '==', false)
        .get()
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newOccurrences = calculateOccurrences(
      newRecurrence as any,
      sessionStart.toDate(),
      generationEnd
    )
    const sessionsToDelete: admin.firestore.DocumentReference[] = []
    const existingDates = new Set<string>()

    for (const doc of allFutureSnap?.docs ?? []) {
      const docStart = (doc.data().start as Timestamp).toDate()
      const dateKey = docStart.toISOString().slice(0, 10)
      if (newRecurrence.frequency === 'weekly' && Array.isArray(newRecurrence.daysOfWeek)) {
        if (!(newRecurrence.daysOfWeek as number[]).includes(getDay(docStart))) {
          sessionsToDelete.push(doc.ref)
        } else {
          existingDates.add(dateKey)
        }
      } else {
        existingDates.add(dateKey)
      }
    }

    if (sessionsToDelete.length > 0) {
      const delBatch = db.batch()
      sessionsToDelete.forEach((ref) => delBatch.delete(ref))
      await delBatch.commit()
      deletedCount = sessionsToDelete.length
    }

    const toCreate = newOccurrences.filter(
      (o) => !existingDates.has(o.start.toISOString().slice(0, 10))
    )
    if (toCreate.length > 0) {
      const seriesData = seriesDoc.data()!
      // The template as it stands AFTER this edit. Fields this callable cannot
      // change (placeId, roomId, autoConfirm) are carried through untouched so
      // the regenerated sessions keep the shape `buildSeriesSessionDoc` writes
      // everywhere else.
      const tpl = {
        ...(seriesData.template ?? {}),
        activityId:
          ((seriesUpdates['template.activityId'] ?? seriesData.template?.activityId) as
            | string
            | null) ?? null,
        activityName:
          ((seriesUpdates['template.activityName'] ?? seriesData.template?.activityName) as
            | string
            | null) ?? null,
        activityType:
          ((seriesUpdates['template.activityType'] ?? seriesData.template?.activityType) as
            | string
            | null) ?? null,
        location:
          ((seriesUpdates['template.location'] ?? seriesData.template?.location) as
            | string
            | null) ?? null,
        tags: ((seriesUpdates['template.tags'] ?? seriesData.template?.tags) as string[]) ?? [],
        notes: ((seriesUpdates['template.notes'] ?? seriesData.template?.notes) as string) ?? '',
        headline:
          ((seriesUpdates['template.headline'] ?? seriesData.template?.headline) as
            | string
            | null) ?? null,
        headlinePublic:
          ((seriesUpdates['template.headlinePublic'] ??
            seriesData.template?.headlinePublic) as boolean) ?? false,
        allowBooking:
          ((seriesUpdates['template.allowBooking'] ??
            seriesData.template?.allowBooking) as boolean) ?? false,
        providerName:
          ((seriesUpdates['template.providerName'] ?? seriesData.template?.providerName) as
            | string
            | null) ?? null,
        providerId:
          ((seriesUpdates['template.providerId'] ?? seriesData.template?.providerId) as
            | string
            | null) ?? null,
        max_participants:
          ((seriesUpdates['template.max_participants'] ??
            seriesData.template?.max_participants) as number) ?? null,
        bookingMandatory:
          ((seriesUpdates['template.bookingMandatory'] ??
            seriesData.template?.bookingMandatory) as boolean) ?? false,
      }
      generatedCount = await materializeOccurrences(
        db,
        session.seriesId as string,
        { ...seriesData, template: tpl },
        toCreate
      )
    }

    // Written HERE and only here: these sessions now exist up to generationEnd,
    // so the horizon is a fact rather than a claim. (`buildSeriesSessionDoc` is
    // referenced through materializeOccurrences — same shape as the callable and
    // the daily roller.)
    await to(seriesRef.update(seriesHorizonUpdate(generationEnd, generatedCount)))
  }

  return {
    success: true,
    updatedCount: futureSnap?.size ?? 0,
    deletedCount,
    generatedCount,
  }
})

// ─── selfCheckIn ──────────────────────────────────────────────────────────────

export const selfCheckIn = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')

  const contactId = (request.auth.token as Record<string, string>)?.contactId
  if (!contactId)
    throw new HttpsError('permission-denied', 'Invalid membership session. Please log in again.')

  const { teamSlug, sessionId: requestedSessionId } = request.data as {
    teamSlug?: string
    sessionId?: string
  }
  if (!teamSlug) throw new HttpsError('invalid-argument', 'teamSlug is required')

  const db = admin.firestore()
  const DEFAULT_WINDOW_MINUTES = 15

  // Resolve slug → teamId via public_profile collectionGroup
  const slugSnap = await db
    .collectionGroup('public_profile')
    .where('slug', '==', teamSlug)
    .limit(5)
    .get()
  const teamDoc = slugSnap.docs.find((d) => {
    const segs = d.ref.path.split('/')
    return segs[0] === 'teams' && segs.length === 4
  })
  if (!teamDoc) throw new HttpsError('not-found', 'Team not found for this QR code')

  const teamId = teamDoc.ref.parent.parent!.id
  const [teamErr, teamSnap] = await to(db.collection(TEAMS_COLLECTION).doc(teamId).get())
  if (teamErr || !teamSnap || !teamSnap.exists) throw new HttpsError('not-found', 'Team not found')

  const windowMinutes: number =
    (teamSnap.data()?.settings?.selfCheckInWindowMinutes as number) ?? DEFAULT_WINDOW_MINUTES
  const windowMs = windowMinutes * 60 * 1000

  const [contactErr, contactSnap] = await to(db.collection('contacts').doc(contactId).get())
  if (contactErr || !contactSnap || !contactSnap.exists)
    throw new HttpsError('not-found', 'Contact not found')
  const contact = contactSnap.data()!
  if ((contact.teamId || contact.teacher) !== teamId)
    throw new HttpsError('permission-denied', 'You are not a member of this team')

  const now = Timestamp.now()

  let sessionsToProcess: Array<Record<string, unknown> & { id: string }> = []

  if (requestedSessionId) {
    const [sErr, sSnap] = await to(db.collection('sessions').doc(requestedSessionId).get())
    if (sErr || !sSnap || !sSnap.exists) throw new HttpsError('not-found', 'Session not found')
    const s = sSnap.data()!
    if ((s.teamId || s.teacher) !== teamId)
      throw new HttpsError('permission-denied', 'Session does not belong to this team')
    sessionsToProcess = [{ id: requestedSessionId, ...s }]
  } else {
    const LOOKBACK_MS = 4 * 60 * 60 * 1000
    const queryStart = Timestamp.fromMillis(now.toMillis() - LOOKBACK_MS)
    const queryEnd = Timestamp.fromMillis(now.toMillis() + windowMs)
    const [sessErr, sessSnap] = await to(
      db
        .collection('sessions')
        .where('teamId', '==', teamId)
        .where('start', '>=', queryStart)
        .where('start', '<=', queryEnd)
        .orderBy('start', 'asc')
        .get()
    )
    sessionsToProcess = (sessSnap?.docs ?? [])
      .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown> & { id: string })
      .filter((s) => {
        const end =
          (s.end as Timestamp | undefined) ||
          Timestamp.fromMillis(
            (s.start as Timestamp).toMillis() +
              ((s.duration as number | undefined) || 60) * 60 * 1000
          )
        const checkInOpens = Timestamp.fromMillis((s.start as Timestamp).toMillis() - windowMs)
        return now >= checkInOpens && end.toMillis() > now.toMillis()
      })
  }

  if (sessionsToProcess.length === 0) return { status: 'no_sessions' }

  // Resolve activity names
  const uniqueActivityIds = [
    ...new Set(
      sessionsToProcess.map((s) => s.activityId as string | undefined).filter(Boolean) as string[]
    ),
  ]
  const activityNameMap: Record<string, string> = {}
  await Promise.all(
    uniqueActivityIds.map(async (aid) => {
      const snap = await db.collection(ACTIVITIES_COLLECTION).doc(aid).get()
      if (snap.exists) activityNameMap[aid] = (snap.data()?.name as string) || aid
    })
  )
  const resolveActivityName = (s: Record<string, unknown>) =>
    activityNameMap[s.activityId as string] || (s.activityId as string) || 'Session'

  if (sessionsToProcess.length > 1 && !requestedSessionId) {
    return {
      status: 'session_required',
      sessions: sessionsToProcess.map((s) => ({
        id: s.id,
        activityName: resolveActivityName(s),
        start: s.start,
        end:
          (s.end as Timestamp) ||
          Timestamp.fromMillis(
            (s.start as Timestamp).toMillis() + ((s.duration as number) || 60) * 60 * 1000
          ),
      })),
    }
  }

  const session = sessionsToProcess[0]
  const resolvedSessionId = session.id
  const sessionStart = session.start as Timestamp
  const sessionEnd =
    (session.end as Timestamp) ||
    Timestamp.fromMillis(sessionStart.toMillis() + ((session.duration as number) || 60) * 60 * 1000)
  const checkInWindowStart = Timestamp.fromMillis(sessionStart.toMillis() - windowMs)

  if (now < checkInWindowStart || now > sessionEnd)
    throw new HttpsError('failed-precondition', 'Check-in window is not open for this session')

  const sessionRef = db.collection('sessions').doc(resolvedSessionId)
  const participantRef = sessionRef.collection('participants').doc(contactId)
  const [pErr, participantDoc] = await to(participantRef.get())
  if (!pErr && participantDoc && participantDoc.exists) {
    return {
      status: 'checked_in',
      alreadyCheckedIn: true,
      sessionName: resolveActivityName(session),
      sessionStart: sessionStart.toMillis(),
    }
  }

  // ONE builder — shared with `checkInContact` and both staff confirm surfaces in
  // the web app, so the same act cannot produce four document shapes. It also
  // pins the invariant every reader relies on: the DOCUMENT ID IS THE CONTACT ID.
  const participantData = buildParticipantDoc({
    contactId,
    sessionId: resolvedSessionId,
    who: {
      firstname: contact.firstname as string | undefined,
      lastname: contact.lastname as string | undefined,
      avatar_url: contact.avatar_url as string | undefined,
    },
    checkedInBy: 'self-scan',
    checkedInAt: FieldValue.serverTimestamp(),
  })

  const bookingRef = sessionRef.collection('bookings').doc(contactId)
  const [bErr, bookingDoc] = await to(bookingRef.get())

  // ── The waiver gate — REFUSE ONLY ──────────────────────────────────────────
  // This callable writes `participants` with NO booking required and none looked
  // for (the booking read above only CONFIRMS an existing one; its absence is
  // not an error). Left ungated, a member who never signed — or whose signature
  // a `require_resign` publish superseded — walks up, scans the kiosk QR, and is
  // written into the room. They attend unsigned and the studio's evidence is
  // nothing at all.
  //
  // It is gated because it CAN be: it is a callable, the contactId is on the
  // contact-session token, and the cost is the same one policy read plus a
  // signer read per applicable waiver every other rail pays.
  //
  // It writes NO acceptance, because a check-in collects no tick — there is no
  // consent step on a QR scan and inventing one would record a signature nobody
  // gave.
  //
  // ── THE REFUSAL CARRIES ITS OWN WAY OUT, and it has to come from HERE ──────
  // The mobile app is the surface that raises this refusal most, and it cannot
  // build the link itself: the web origin lives in a server-side env param
  // (`HOSTING_URL`), the app has no equivalent, and a client that guessed one
  // would send a member at a door to a hostname that may not exist. So the
  // server — which holds both the origin and the team slug the QR carried —
  // attaches `signUrl` to the refusal, pointing at the member's own Space, the
  // one surface a person standing at a door can complete on their phone.
  try {
    await enforceWaiverGate({
      teamId,
      activityId: (session.activityId as string | undefined) ?? null,
      subject: {
        contactId,
        name: `${(contact.firstname as string) ?? ''} ${(contact.lastname as string) ?? ''}`.trim(),
        email: (contact.email as string) ?? null,
      },
      submissions: [],
      source: 'kiosk',
      signerEmailVerifiedBy: 'session',
      ip: request.rawRequest?.ip ?? null,
      userAgent: null,
      locale: null,
      nowMs: Date.now(),
    })
  } catch (err) {
    const e = err as HttpsError & { details?: { reason?: string } }
    const reason = e?.details?.reason
    if (typeof reason === 'string' && reason.startsWith('waiver_')) {
      throw new HttpsError(e.code ?? 'failed-precondition', e.message, {
        ...(e.details as Record<string, unknown>),
        // Locale-pinned on the team's language — this URL is shown on the
        // studio's own door device and opened on the member's phone, and
        // nothing in the request carries a locale (the gate is called with
        // `locale: null`).
        signUrl: localizedPublicUrl(
          getHostingUrl(),
          (teamSnap.data()?.language as string | undefined) ?? null,
          teamSlug,
          'space'
        ),
      })
    }
    throw err
  }

  const batch = db.batch()
  batch.set(participantRef, participantData)

  if (!bErr && bookingDoc && bookingDoc.exists) {
    const bStatus = bookingDoc.data()?.status as string | undefined
    if (!bStatus || bStatus === 'pending') {
      batch.update(bookingRef, {
        status: 'confirmed',
        confirmed_at: FieldValue.serverTimestamp(),
        // A confirmed seat is an ordinary booking — the hold markers go with the
        // same write. The claim flag is not an oversell any more
        // (bookingHoldsSeat no longer expires a SETTLED claim), but it still
        // hides this person from `sendBookingReminders` forever; and a claim
        // that was mid-payment also carries `payment_status: 'required'` +
        // `expires_at`, which DO still cost the seat (freed at the deadline by
        // the recount, then hard-deleted at 02:00 by
        // releaseExpiredBookingHolds). `confirmClearedHoldFields` is the one
        // patch every confirm surface applies; absent fields are a no-op.
        ...confirmClearedHoldFields(bookingDoc.data() as SeatHold, FieldValue.delete()),
      })
      // No `bookings_count` here: a confirmed booking still HOLDS its seat
      // (bookingHoldsSeat), so decrementing on check-in was a leftover from the
      // pre-merge counter model — it put the class one seat under for whoever
      // won the race with trackBookings' recount of this same status flip.
      batch.update(sessionRef, {
        conversions_count: FieldValue.increment(1),
      })
      batch.update(db.collection('contacts').doc(contactId), {
        pending_bookings_count: FieldValue.increment(-1),
      })
    }
  }

  await batch.commit()
  return {
    status: 'checked_in',
    alreadyCheckedIn: false,
    sessionName: resolveActivityName(session),
    sessionStart: sessionStart.toMillis(),
  }
})
