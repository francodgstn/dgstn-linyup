// ─── CANCELING A WHOLE COURSE ──────────────────────────────────────────────
//
// A course is called off. Three things have to happen, in this order, and the
// order is the whole design:
//
//   1. THE DOOR SHUTS FIRST. `status: 'cancelled'` is one synchronous write
//      before anything else, and it closes every way in at once:
//      `courseBlockSalesOpen` goes false, `takeCourseBlockPlace` refuses
//      outright, and `syncCourseBlockPublicProfile` deletes the public mirror.
//      This is the same "freeze before you enqueue" rule the series teardown
//      already follows, for the same reason: the lessons are about to be
//      deleted, and somebody buying a place into that is the one outcome
//      nothing downstream could repair.
//   2. THE PEOPLE ARE TOLD, ONCE. One mail per enrolled person, from here.
//      NOT one per lesson: nine people on a thirteen-week course would
//      otherwise get a hundred and seventeen mails, each of them true and none
//      of them the news. That is what `notify: false` on the teardown is for,
//      and `SeriesTeardownJob.notify` owns the reasoning.
//   3. THE LESSONS GO, from now forward. Past lessons are attendance history
//      and are never touched, exactly as the roster converger never touches
//      them.
//
// ── NO MONEY MOVES HERE ─────────────────────────────────────────────────────
//
// This callable RETURNS the payments that may be owed back; it refunds none of
// them. The precedent is stated twice already in this codebase, on
// `cancelBooking` and on `cancelSingleSession`, and it is not squeamishness: a
// refund is irreversible, the studio may have a policy (a credit, a transfer to
// next term, a partial), and a money writer inside a best-effort retried worker
// is the one shape this repo consistently refuses. So the studio is handed the
// list and refunds from the payments page, by hand, deliberately.
//
// ── THE ENROLLMENTS STAY ─────────────────────────────────────────────────────
//
// Nobody is withdrawn. Who was on a canceled course is the studio's record,
// and it is what the refund list is reconciled against. A canceled course
// holds places that mean nothing, which is correct: `placeFreedEdge` refuses a
// canceled course by name, so no waiting list promotes into it.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  COURSE_BLOCKS_COLLECTION,
  COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  SERIES_TEARDOWN_INLINE_MAX,
  SERIES_TEARDOWN_STALE_MS,
  SESSION_SERIES_COLLECTION,
  TEAMS_COLLECTION,
  courseBlockEnrolmentHoldsPlace,
  type CourseBlock,
  type CourseBlockEnrolment,
} from '@linyup/shared'
import { to } from '../utils/async'
import { requireCapability } from '../utils/teams'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { systemEmailEnabledFor } from '../utils/systemEmails'
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
  type TeamData,
} from '../sessions/teardown'

/** One person the studio may owe money to, and the payment that says so. */
export interface CourseRefundCandidate {
  contactId: string | null
  email: string | null
  /** The `member_payments` document id, which is the payment intent id. */
  paymentId: string
  /** What is still refundable, in MINOR units: what was charged less what has
   *  already gone back. A partially-refunded payment therefore shows what is
   *  left rather than what it once was. */
  refundableAmount: number
  currency: string
}

/** The two statuses `refundMemberPayment` will act on. Read here so this list
 *  cannot offer the studio a row that the refund callable then turns down. */
const REFUNDABLE_STATUSES = new Set(['succeeded', 'partially_refunded'])

/** The narrowest thing a payment row has to be to answer these questions, so
 *  the rules below are testable against plain objects. */
export interface PaymentRowLike {
  id: string
  get(field: string): unknown
}

/**
 * Which payment rows are worth offering the studio, and for how much. Pure, so
 * the three rules that each cost somebody money if they go wrong get fixtures:
 * a void is not a refund, a partial refund leaves only the remainder, and a row
 * the refund callable would turn down is never listed at all.
 */
export function refundableRows(docs: readonly PaymentRowLike[]): CourseRefundCandidate[] {
  return docs
    .filter((d) => {
      // A VOID says the money never arrived, so refunding it would be inventing
      // a payment to hand back. Any other status the refund rail refuses is
      // filtered here too, for the same reason: a list that offers a row the
      // next screen turns down is worse than a shorter list.
      if (d.get('voided_at')) return false
      return REFUNDABLE_STATUSES.has((d.get('status') as string | undefined) ?? '')
    })
    .map((d) => {
      // `contactId` is what the Connect webhook writes; `contact_id` is the
      // manual rail's older spelling. Both are read, because a course could have
      // been paid for either way and a row with no contact is still refundable.
      const contactId =
        (d.get('contactId') as string | undefined) ??
        (d.get('contact_id') as string | undefined) ??
        null
      const charged = (d.get('amount') as number | undefined) ?? 0
      const alreadyBack = (d.get('amount_refunded') as number | undefined) ?? 0
      return {
        contactId,
        email: (d.get('email') as string | undefined) ?? null,
        paymentId: d.id,
        refundableAmount: Math.max(0, charged - alreadyBack),
        currency: (d.get('currency') as string | undefined) ?? 'chf',
      }
    })
    .filter((row) => row.refundableAmount > 0)
}

/**
 * What the studio may owe back.
 *
 * Read from the payments ledger rather than from the enrollments, because the
 * ledger is what a refund acts on and it is the only place that knows what was
 * actually charged after a plan benefit or a promo code had its say. An
 * enrollment the studio granted by hand produces no row here, which is right:
 * nothing was taken, so nothing is owed.
 *
 * Voided rows are skipped. A void says the money never arrived, so refunding it
 * would be inventing a payment to hand back.
 */
export async function courseRefundCandidates(
  db: FirebaseFirestore.Firestore,
  teamId: string,
  blockId: string
): Promise<CourseRefundCandidate[]> {
  const [err, snap] = await to(
    db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
      .where('line_item.courseBlockId', '==', blockId)
      .get()
  )
  if (err || !snap) {
    // A missing index or a transient read must not stop a cancellation: the
    // lessons still have to go and the members still have to be told. The list
    // is a convenience, and the payments page can always be read directly.
    console.error('[courseBlocks] could not list refundable payments for', blockId, err)
    return []
  }
  return refundableRows(snap.docs)
}

/** The one mail a canceled course sends. Plain, because there is no good
 *  version of this news: what was called off, and what happens about the money. */
export function buildCourseCancellationEmail(params: {
  firstname: string
  teamName: string
  courseName: string
  paid: boolean
}): { subject: string; html: string; text: string } {
  const subject = `Course canceled: ${params.courseName}`
  // Deliberately does NOT promise a refund. Whether money comes back, and in
  // what shape, is the studio's decision and its policy; a mail that guarantees
  // one on the studio's behalf is a commitment this code is not entitled to
  // make. It says who will be in touch, which is true in every case.
  const moneyLine = params.paid
    ? `<p>You paid for this course, so ${params.teamName} will be in touch about it.</p>`
    : ''
  const { html } = buildEmailTemplate({
    title: 'Course canceled',
    body:
      `<p>Hi ${params.firstname},</p>` +
      `<p><strong>${params.courseName}</strong> has been canceled by ${params.teamName}, ` +
      `and its remaining lessons have been taken off the calendar.</p>` +
      moneyLine +
      `<p>We are sorry for the inconvenience.</p>`,
  })
  const text =
    `Hi ${params.firstname},\n\n${params.courseName} has been canceled by ${params.teamName}, ` +
    `and its remaining lessons have been taken off the calendar.\n` +
    (params.paid ? `You paid for this course, so ${params.teamName} will be in touch about it.\n` : '') +
    `\nWe are sorry for the inconvenience.`
  return { subject, html, text }
}

/**
 * Tells everyone who holds a place, once.
 *
 * The toggle rule is the one `cancelSingleSession` already applies and is not
 * re-decided here: a free place loses only news when the studio switches
 * cancellation mail off, while a PAID one loses the only warning that the thing
 * they were charged for is not happening. So a paid enrollment is mailed
 * whatever the toggle says.
 */
async function notifyCourseRoster(
  teamId: string,
  teamData: TeamData,
  block: CourseBlock,
  enrolments: Array<{ id: string; data: CourseBlockEnrolment }>
): Promise<{ sent: number; failed: number }> {
  if (enrolments.length === 0) return { sent: 0, failed: 0 }
  const enabled = await systemEmailEnabledFor(teamId, 'session_cancellation')
  const recipients = enabled
    ? enrolments
    : enrolments.filter((e) => e.data.payment_status === 'paid')

  let sent = 0
  let failed = 0
  for (const person of recipients) {
    if (!person.data.email) continue
    const email = buildCourseCancellationEmail({
      firstname: person.data.firstname || 'there',
      teamName: teamData.name,
      courseName: block.name,
      paid: person.data.payment_status === 'paid',
    })
    const [err] = await to(
      sendEmail({
        to: person.data.email,
        teamId,
        subject: email.subject,
        html: email.html,
        text: email.text,
      })
    )
    if (err) {
      console.error('[courseBlocks] could not mail', person.data.email, 'about', block.id, err)
      failed += 1
    } else {
      sent += 1
    }
  }
  return { sent, failed }
}

/**
 * Is a teardown of this series already in flight?
 *
 * The same guard `cancelSession` applies, and for the same reason: two chains
 * over one scope claim sessions from each other. It follows the marker to the
 * JOB rather than trusting the marker, because a run that died leaves the
 * series frozen on purpose, and refusing on the marker alone would make a
 * failed teardown permanent with no way out but editing Firestore by hand.
 */
async function teardownAlreadyRunning(
  db: FirebaseFirestore.Firestore,
  seriesId: string
): Promise<string | null> {
  const [err, doc] = await to(db.collection(SESSION_SERIES_COLLECTION).doc(seriesId).get())
  if (err || !doc?.exists) return null
  const priorJobId = doc.data()?.teardown_job_id as string | undefined
  if (!priorJobId) return null

  const [jobErr, jobDoc] = await to(jobRef(db, priorJobId).get())
  // A marker we cannot resolve is treated as LIVE. Guessing the other way
  // starts a second chain over a scope that may still be draining, and that is
  // the one mistake here that reaches a member's inbox.
  if (jobErr) return priorJobId
  const prior = jobDoc?.exists
    ? (jobDoc.data() as { status?: string; updated_at?: Timestamp })
    : undefined
  if (!prior) return null
  const beatMs = prior.updated_at?.toMillis?.() ?? 0
  const stale = Date.now() - beatMs > SERIES_TEARDOWN_STALE_MS
  return (prior.status ?? 'running') === 'running' && !stale ? priorJobId : null
}

export const cancelCourseBlock = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const { teamId, blockId } = request.data as { teamId?: string; blockId?: string }
  if (!teamId || !blockId) {
    throw new HttpsError('invalid-argument', 'teamId and blockId are required')
  }
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const db = admin.firestore()
  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const blockDoc = await blockRef.get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }

  const alreadyCancelled = block.status === 'cancelled'

  // ── 1. The door, first and synchronously ──────────────────────────────────
  if (!alreadyCancelled) {
    await blockRef.update({
      status: 'cancelled',
      cancelled_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    })
  }

  // ── 2. The people, once ───────────────────────────────────────────────────
  //
  // Skipped on a re-run. Everything below this point is idempotent by
  // construction (a live drain query, a per-session claim), but a mail is not:
  // a studio clicking Cancel twice, or retrying after a failed enqueue, must
  // not tell nine people twice that their course is off. The status flip above
  // is the marker that says the news has gone.
  const teamData = await getTeamData(db, teamId)
  let notified = { sent: 0, failed: 0 }
  if (!alreadyCancelled) {
    const [enrolErr, enrolSnap] = await to(
      blockRef.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).get()
    )
    if (enrolErr) {
      console.error('[courseBlocks] could not read the roster of', blockId, enrolErr)
    } else {
      const nowMs = Date.now()
      const holders = (enrolSnap?.docs ?? [])
        // A lapsed hold is somebody who abandoned a checkout. They never had a
        // place, so this is not their news.
        .filter((d) => courseBlockEnrolmentHoldsPlace(d.data() as CourseBlockEnrolment, nowMs))
        .map((d) => ({ id: d.id, data: d.data() as CourseBlockEnrolment }))
      notified = await notifyCourseRoster(teamId, teamData, block, holders)
    }
  }

  // ── 3. The lessons, from now forward ──────────────────────────────────────
  const seriesId = block.seriesId
  let mode: 'inline' | 'background' | 'none' = 'none'
  let jobId: string | null = null
  let cancelledCount = 0

  if (seriesId) {
    const running = await teardownAlreadyRunning(db, seriesId)
    if (running) {
      throw new HttpsError('failed-precondition', 'teardown-already-running', { jobId: running })
    }

    // The scope is pinned HERE and never recomputed, which is what makes "how
    // long the job took" unable to change what it deleted. Now, not the first
    // lesson: a course called off in week six keeps weeks one to five.
    const cutoff = Timestamp.now()
    const [countErr, total] = await to(countTeardownScope(db, seriesId, cutoff))
    if (countErr) throw new HttpsError('internal', 'Could not measure the course.')

    if ((total ?? 0) > SERIES_TEARDOWN_INLINE_MAX) {
      jobId = await createTeardownJob({
        db,
        teamId,
        seriesId,
        anchorSessionId: blockId,
        cutoff,
        total: total!,
        createdBy: request.auth.uid,
        // The course has already sent its one mail. See the header.
        notify: false,
      })
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
        throw new HttpsError('internal', 'Could not start removing the lessons.')
      }
      mode = 'background'
      cancelledCount = total!
    } else {
      const [futureErr, futureSnap] = await to(teardownScopeQuery(db, seriesId, cutoff).get())
      if (futureErr) throw new HttpsError('internal', 'Could not read the remaining lessons.')
      for (const doc of futureSnap?.docs ?? []) {
        await cancelSingleSession(db, doc.id, doc.ref, doc.data(), teamData, false, false, false)
        cancelledCount += 1
      }
      // The series is ENDED, on the inline path exactly as on the background
      // one. Leaving it alive was a real defect on the class rail: the roller
      // resumes from `lastGeneratedUntil` and the deleted classes reappeared
      // months later. A course's series is `fixed` and the roller skips it
      // anyway, so this is belt and braces, and it is the honest status.
      await endSeriesAfterTeardown(db, seriesId)
      mode = 'inline'
    }
  }

  const refunds = await courseRefundCandidates(db, teamId, blockId)

  return {
    id: blockId,
    status: 'cancelled' as const,
    alreadyCancelled,
    mode,
    jobId,
    lessonsCancelled: cancelledCount,
    notified: notified.sent,
    notifyFailed: notified.failed,
    // NOT refunded. The studio decides, on the payments page, by hand.
    refunds,
  }
})
