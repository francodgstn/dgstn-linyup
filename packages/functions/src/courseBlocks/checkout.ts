// ─── BUYING A COURSE ─────────────────────────────────────────────────────────
//
// THE HOLD IS ONE DOCUMENT. A course place is contended for on the course, so a
// checkout takes the place first, as an `enrolments/{contactId}` row with
// `status: 'hold'` and an `expires_at`, and the Connect webhook settles it.
//
// It deliberately writes NO per-lesson bookings. An open checkout holds a place,
// but putting an unpaid person on thirteen registers and taking them off again
// when the checkout lapses is worse than waiting for the money, and an abandoned
// checkout then leaves one document rather than fourteen. The roster converges
// on confirm.
//
// LAZY EXPIRY, the appointment rail's shape: `courseBlockEnrolmentHoldsPlace`
// reads the deadline, so a lapsed hold frees its place the moment it lapses
// rather than at the next sweep, and the gate and the recount cannot disagree
// about whether a course is full.
//
// The price is NEVER computed here. `resolvePaymentOptions` prices a
// `course_block` target built by the one builder (`courseBlockTarget`), so the
// card, the free rail and this agree by construction.
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  COURSE_BLOCKS_COLLECTION,
  courseBlockSalesOpen,
  firstMeeting,
  meetingCount,
  resolvePaymentOptions,
  type CourseBlock,
} from '@linyup/shared'
import { loadEnabledTeam, requireChargeableAccount } from '../connect/access'
import {
  assertQuotedAmount,
  checkoutRateLimit,
  defaultIdempotencyKey,
  requireChargeableAmountFromMajor,
  resolveCheckoutHoldWindow,
  startOneOffCheckout,
} from '../connect/checkout'
import { loadContactPaymentSnapshot } from '../booking/access'
import { courseBlockTarget, releaseCourseBlockPlace, takeCourseBlockPlace } from './enrolment'
import { getHostingUrl } from '../utils/env'
import { to } from '../utils/async'

/** How long a course place is held while somebody pays. The same 30 minutes an
 *  appointment slot gets: long enough to find a card, short enough that an
 *  abandoned checkout does not sit on the last place of a nine-place course. */
const HOLD_MINUTES = 30

export const createCourseBlockCheckout = onCall(async (request) => {
  await checkoutRateLimit(request.rawRequest?.ip, 'course-block-checkout')

  const data = request.data as {
    teamId?: string
    blockId?: string
    contactId?: string
    slug?: string
    locale?: string
    origin?: string
    idempotencyKey?: string
    /** The price the surface rendered. Refused with `price_changed` when it
     *  disagrees with what the resolver says, rather than silently charging a
     *  different figure. */
    quotedAmount?: number
  }
  const { teamId, blockId, contactId } = data
  if (!teamId || !blockId || !contactId) {
    throw new HttpsError('invalid-argument', 'teamId, blockId and contactId are required')
  }

  const db = admin.firestore()
  const team = await loadEnabledTeam(teamId)
  requireChargeableAccount(team)

  const blockDoc = await db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId).get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }
  // THE SALES WINDOW, through the one predicate the public card reads, so a
  // visitor is never shown a button this refuses.
  if (!courseBlockSalesOpen(block)) {
    throw new HttpsError('failed-precondition', 'That course is not open for booking.', {
      reason: 'sales_closed',
    })
  }

  const contactDoc = await db.collection(CONTACTS_COLLECTION).doc(contactId).get()
  if (!contactDoc.exists) throw new HttpsError('not-found', 'That contact no longer exists.')
  const contact = contactDoc.data() as {
    teamId?: string
    firstname?: string
    lastname?: string
    email?: string
  }
  if (contact.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That contact belongs to another studio.')
  }

  const snapshot = await loadContactPaymentSnapshot({
    teamId,
    contact: { ...contact, id: contactId },
    relevantTypeIds: block.includedSubscriptionTypeIds ?? [],
  })
  const priced = resolvePaymentOptions(snapshot, courseBlockTarget(block, { enrolled: false }))
  const payOption = priced.options[0]

  // NOT PAYABLE means there is nothing to check out. A covered course is the
  // free rail's business (`joinCourseBlock`), and sending somebody to Stripe for
  // nothing would charge them for what a plan already gives them.
  if (!payOption) {
    throw new HttpsError('failed-precondition', 'You cannot book this course.', {
      reason: priced.denial ?? 'no_subscription',
    })
  }
  if (payOption.type !== 'pay') {
    throw new HttpsError('failed-precondition', 'This course costs you nothing.', {
      reason: 'covered',
    })
  }

  assertQuotedAmount(data.quotedAmount, payOption.amount, { promoAttempted: false })
  const amount = requireChargeableAmountFromMajor(payOption.amount)

  const nowMs = Date.now()
  const holdWindow = resolveCheckoutHoldWindow({
    nowMs,
    carriesReservation: false,
    alwaysBounded: true,
  })
  const expiresAt = Timestamp.fromMillis(nowMs + HOLD_MINUTES * 60_000)

  // TAKE THE PLACE FIRST. The capacity gate lives in that transaction, so a
  // sold-out course refuses here rather than after the buyer has paid, and two
  // people racing for the last place conflict on the course document.
  const { placesTaken } = await takeCourseBlockPlace(db, {
    blockId,
    contactId,
    firstname: contact.firstname ?? null,
    lastname: contact.lastname ?? null,
    email: contact.email ?? null,
    status: 'hold',
    payment_status: 'required',
    expiresAt,
  })

  const base = data.origin || getHostingUrl()
  const slug = data.slug ?? ''
  const successUrl = `${base}/pay/result?status=success&kind=course_block&slug=${encodeURIComponent(slug)}`
  const cancelUrl = `${base}/pay/result?status=cancelled&kind=course_block&slug=${encodeURIComponent(slug)}`

  const first = firstMeeting(block)
  const lessons = meetingCount(block)

  try {
    const checkoutSession = await startOneOffCheckout({
      team,
      amountMinor: amount,
      // What the buyer sees on the Stripe page. The lesson count is the thing
      // they are buying, so it belongs in the name rather than only in the
      // confirmation that follows.
      productName: lessons > 1 ? `${block.name} (${lessons} lessons)` : block.name,
      successUrl,
      cancelUrl,
      customerEmail: contact.email || undefined,
      metadata: {
        kind: 'course_block',
        purpose: 'course_block',
        teamId,
        blockId,
        contactId,
        courseName: block.name,
        lessons: String(lessons),
        ...(first ? { firstMeetingMs: String(first.start.toMillis()) } : {}),
      },
      idempotencyKey:
        data.idempotencyKey ?? defaultIdempotencyKey('course', teamId, blockId, contactId),
      expiresAtEpochSeconds: holdWindow.expiresAtEpochSeconds,
      label: 'createCourseBlockCheckout',
    })

    return { url: checkoutSession.url, amount: payOption.amount, placesTaken }
  } catch (err) {
    // THE HOLD IS OURS TO GIVE BACK, because we took it two lines ago. Best
    // effort: a place that stays held until its deadline is a bounded cost, and
    // throwing a release failure over the original error would hide why the
    // checkout failed.
    const [releaseErr] = await to(releaseCourseBlockPlace(db, blockId, contactId))
    if (releaseErr) {
      console.error('[courseBlocks] could not release the hold for', blockId, contactId, releaseErr)
    }
    throw err
  }
})
