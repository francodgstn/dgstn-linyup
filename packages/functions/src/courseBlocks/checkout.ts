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
  COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION,
  COURSE_BLOCK_WAITLIST_SUBCOLLECTION,
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
import { resolveClaimCheckoutWindow } from '../booking/waitlist/constants'
import { loadContactPaymentSnapshot } from '../booking/access'
import { courseBlockTarget, releaseCourseBlockPlace, takeCourseBlockPlace } from './enrolment'
import { getHostingUrl } from '../utils/env'
import { to } from '../utils/async'
import { optionalContactSessionFromRequest } from '../utils/contactSession'

/** How long a course place is held while somebody pays. The same 30 minutes an
 *  appointment slot gets: long enough to find a card, short enough that an
 *  abandoned checkout does not sit on the last place of a nine-place course. */
const HOLD_MINUTES = 30

/** Stripe refuses a Checkout Session shorter than 30 minutes; 31 for clock
 *  skew. Below it a claim is refused rather than given a LONGER session, which
 *  would still be payable after the place had rolled on. */
const CHECKOUT_MIN_WINDOW_MINUTES = 31
/** Stripe's own ceiling on a Checkout Session. A course claim window is longer
 *  than this by design, so the session is clamped and the hold outlives it. */
const CHECKOUT_MAX_WINDOW_HOURS = 24

/**
 * Is this a live offer, held by this person, with this token?
 *
 * Every check the free claim rail makes, made again here. A claim that skipped
 * one of them would be a second way onto a course with weaker rules than the
 * first, which is the shape this whole area exists to avoid.
 */
async function verifyCourseClaim(
  db: FirebaseFirestore.Firestore,
  blockId: string,
  contactId: string,
  token: string
): Promise<{ expiresAtMs: number; placesTaken: number }> {
  const ref = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const [entry, enrolment, block] = await Promise.all([
    ref.collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION).doc(contactId).get(),
    ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).doc(contactId).get(),
    ref.get(),
  ])
  if (!entry.exists || entry.get('offer_token') !== token) {
    throw new HttpsError('permission-denied', 'That link has already been used.')
  }
  const expiresAt = entry.get('offer_expires_at') as Timestamp | undefined
  if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'That offer has expired.', { reason: 'expired' })
  }
  // The place must actually still be held for them. An offer whose hold was
  // released underneath it is not a claim, it is a race that was lost.
  if (!enrolment.exists || enrolment.get('waitlist_claim') !== true) {
    throw new HttpsError('failed-precondition', 'That place is no longer being held.')
  }
  return {
    expiresAtMs: expiresAt.toMillis(),
    placesTaken: (block.get('places_taken') as number | undefined) ?? 0,
  }
}

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
    /**
     * The single-use credential from a waiting-list offer. Its presence changes
     * three things and nothing else: the place is ALREADY HELD so none is taken,
     * the Stripe session dies at the OFFER's deadline rather than thirty minutes
     * from now, and a failure here does not release the place, because the offer
     * stands until its own deadline whatever happens at the card form.
     *
     * There is deliberately no second pricing path: a claim is quoted by the
     * same resolver as the ordinary door, so a plan edge or a promo code cannot
     * mean one thing at the front and another in the queue.
     */
    waitlistToken?: string
  }
  const { teamId, blockId } = data
  if (!teamId || !blockId) {
    throw new HttpsError('invalid-argument', 'teamId and blockId are required')
  }

  // TRUST ONLY THE VERIFIED CONTACT SESSION, never a `contactId` from the body:
  // this is a public router, and a body id would let anyone start a checkout as
  // any contact of any studio and enumerate ids by watching which come back
  // `not-found`. The same rule `createDropInCheckout` states, and which this
  // rail read a body parameter in spite of.
  const session = optionalContactSessionFromRequest(request)
  if (!session || session.teamId !== teamId) {
    throw new HttpsError('unauthenticated', 'Sign in to book this course.', {
      reason: 'sign_in_required',
    })
  }
  const contactId = session.contactId

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

  // ALREADY ON THE COURSE: refuse rather than take a place again.
  //
  // `takeCourseBlockPlace` MERGES, so a second checkout rewrote a settled
  // `enrolled` row to `hold` with an `expires_at`. Abandoning that checkout then
  // lapsed a place the member had paid for, a Stripe failure marked them
  // `withdrawn`, and either way the next roster converge read them as gone and
  // canceled every future lesson booking they had. One stray double-click on
  // the Buy button was enough.
  //
  // A waiting-list claim is the deliberate exception: its enrollment IS a hold,
  // and paying is how it settles.
  const existing = await db
    .collection(COURSE_BLOCKS_COLLECTION)
    .doc(blockId)
    .collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)
    .doc(contactId)
    .get()
  if (!data.waitlistToken && existing.get('status') === 'enrolled') {
    throw new HttpsError('failed-precondition', 'You are already on that course.', {
      reason: 'already_enrolled',
    })
  }

  const nowMs = Date.now()

  // A WAITING-LIST CLAIM, or the ordinary door.
  //
  // THE SINGLE-DEADLINE RULE is what separates the two. A claim's place is held
  // until the offer's own deadline, and every timer around it has to be that
  // same instant, so the Stripe session is clamped to it rather than given a
  // fresh thirty minutes. `resolveClaimCheckoutWindow` is the class queue's
  // existing arithmetic, reused rather than re-derived: it clamps DOWN at
  // Stripe's 24-hour ceiling, which is the safe direction. A checkout that dies
  // before the hold costs one more click; one that outlives the hold sells a
  // place that has already gone to the next person.
  const claim = data.waitlistToken
    ? await verifyCourseClaim(db, blockId, contactId, data.waitlistToken)
    : null

  let placesTaken: number
  // Optional because the ordinary hold window may be unbounded; a claim's
  // never is, since its whole point is a deadline.
  let stripeExpiresAt: number | undefined
  if (claim) {
    const window = resolveClaimCheckoutWindow({
      nowMs,
      claimExpiresAtMs: claim.expiresAtMs,
      minMinutes: CHECKOUT_MIN_WINDOW_MINUTES,
      maxMinutes: CHECKOUT_MAX_WINDOW_HOURS * 60,
    })
    if (!window.payable) {
      throw new HttpsError('failed-precondition', 'That offer is about to expire.', {
        reason: 'claim_window_too_short',
      })
    }
    stripeExpiresAt = window.expiresAtEpochSeconds
    // NOT taken: the offer already holds it, and taking it again would rewrite
    // the hold's deadline, which is exactly the divergence the rule forbids.
    placesTaken = claim.placesTaken
  } else {
    const holdWindow = resolveCheckoutHoldWindow({
      nowMs,
      carriesReservation: false,
      alwaysBounded: true,
    })
    stripeExpiresAt = holdWindow.expiresAtEpochSeconds
    const expiresAt = Timestamp.fromMillis(nowMs + HOLD_MINUTES * 60_000)

    // TAKE THE PLACE FIRST. The capacity gate lives in that transaction, so a
    // sold-out course refuses here rather than after the buyer has paid, and two
    // people racing for the last place conflict on the course document.
    const taken = await takeCourseBlockPlace(db, {
      blockId,
      contactId,
      firstname: contact.firstname ?? null,
      lastname: contact.lastname ?? null,
      email: contact.email ?? null,
      status: 'hold',
      payment_status: 'required',
      expiresAt,
    })
    placesTaken = taken.placesTaken
  }

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
        // Carried so the confirm can close the queue entry out. Without it a
        // paid claim would settle the enrollment and leave the entry saying
        // 'offered' for ever, which the sweep would then try to release.
        ...(data.waitlistToken ? { waitlistToken: data.waitlistToken } : {}),
        ...(first ? { firstMeetingMs: String(first.start.toMillis()) } : {}),
      },
      idempotencyKey:
        data.idempotencyKey ?? defaultIdempotencyKey('course', teamId, blockId, contactId),
      expiresAtEpochSeconds: stripeExpiresAt,
      label: 'createCourseBlockCheckout',
    })

    return { url: checkoutSession.url, amount: payOption.amount, placesTaken }
  } catch (err) {
    // A CLAIM'S PLACE IS NOT OURS TO GIVE BACK. It was held by the offer before
    // this call and it stands until the offer's own deadline, so a failed
    // checkout leaves the claimant free to try again rather than handing their
    // place to the next person over a Stripe hiccup.
    if (claim) throw err
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
