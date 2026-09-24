/* eslint-disable no-console */
// ─── THE WAITING LIST FOR A FULL COURSE ─────────────────────────────────────
//
// "Level 2 Seepferd is sold out. Tell me if a place comes free." A term course
// is bought months ahead and people do drop out, so a full course is the one
// case where sold-out is not the end of the conversation.
//
// The SHAPE is the class waitlist's, which is documented on
// `CourseBlockWaitlistEntry` in `@linyup/shared` and is where the three carried
// invariants are written down. The STORAGE is deliberately separate, down to
// the subcollection's name, because a collection-group query cannot tell two
// queues apart. See `COURSE_BLOCK_WAITLIST_SUBCOLLECTION`.
//
// ── WHAT HANGS ON WHAT ──────────────────────────────────────────────────────
//
// The promoter hangs on ONE trigger: a course document whose write freed a
// place (`placeFreedEdge`). Every event that can free one converges there, a
// withdrawal, a lapsed checkout recounted by `trackCourseBlockEnrolments`, the
// studio raising the cap, because `places_taken` has ONE WRITER and it always
// writes an absolute value. Wiring the three call sites instead would have
// missed the fourth.
//
// The offer is an ORDINARY ENROLMENT: `status: 'hold'`, `waitlist_claim: true`,
// `expires_at` at the deadline. So `courseBlockEnrolmentHoldsPlace` already
// counts it, already lapses it lazily, and nothing else in the codebase has to
// learn what a waiting list is for the course to stop selling that place.
//
// ── THE EDGE, AND WHY THE PROMOTER MUST NOT TOUCH THE COURSE ON A NO-OP ─────
//
// `placeFreedEdge` is an EDGE: full, then not full. The promoter's own write
// re-fires this trigger, and on that pass the course is full again, which is
// what makes it loop-safe. The corollary is binding: on any path where it
// decides NOT to promote, it must not write the course document at all, or a
// harmless touch re-enters it for ever.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  COURSE_BLOCKS_COLLECTION,
  COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION,
  COURSE_BLOCK_WAITLIST_SUBCOLLECTION,
  COURSE_WAITLIST_MAX_OFFERS_PER_RUN,
  COURSE_WAITLIST_SCAN_LIMIT,
  countHoldingPlaces,
  courseBlockSalesOpen,
  courseWaitlistCap,
  firstMeeting,
  placeFreedEdge,
  placesFree,
  resolveCourseClaimWindow,
  selectCourseOfferHeads,
  type CourseBlock,
  type CourseBlockWaitlistEntry,
} from '@linyup/shared'
import { to } from '../utils/async'
import { requireCapability } from '../utils/teams'
import { generateSecureToken } from '../utils/crypto'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { getHostingUrl } from '../utils/env'
import { getTeamData } from '../sessions/teardown'
import { syncCourseBlockRoster } from './enrolment'

/** One minted offer, returned so the caller can notify the person. The mail is
 *  sent AFTER the commit, never inside the transaction. */
export interface CourseWaitlistOffer {
  teamId: string
  blockId: string
  courseName: string
  contactId: string
  firstname: string
  email: string
  offerToken: string
  offerExpiresAt: Timestamp
}

function blockRefOf(db: FirebaseFirestore.Firestore, blockId: string) {
  return db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
}

// ─── joining ─────────────────────────────────────────────────────────────────

/**
 * Take a place in the queue for a full course.
 *
 * Refuses a course that is NOT full, which is not pedantry: a queue on a course
 * with places left is a person who thinks they are waiting and could simply
 * have booked. The client is told `places_available` so it can send them to the
 * ordinary door.
 */
export const joinCourseBlockWaitlist = onCall(async (request) => {
  const { teamId, blockId, contactId } = request.data as {
    teamId?: string
    blockId?: string
    contactId?: string
  }
  if (!teamId || !blockId || !contactId) {
    throw new HttpsError('invalid-argument', 'teamId, blockId and contactId are required')
  }

  const db = admin.firestore()
  const ref = blockRefOf(db, blockId)
  const blockDoc = await ref.get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }
  // A cancelled or unpublished course has no queue, and a course whose sales
  // have closed cannot hand a place on to anybody. Read through the ONE
  // predicate the public card reads, so nobody is shown a button this refuses.
  if (!courseBlockSalesOpen(block)) {
    throw new HttpsError('failed-precondition', 'That course is not taking bookings.', {
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
    phone?: string
  }
  if (contact.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That contact belongs to another studio.')
  }

  const first = firstMeeting(block)
  const queueRef = ref.collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
  const entryToken = generateSecureToken()

  return db.runTransaction(async (tx) => {
    // The course document is in the read set, which is what serialises a join
    // against a place being taken: joining a course that filled up a
    // millisecond ago, or emptied a millisecond ago, resolves one way or the
    // other rather than both.
    const [courseDoc, enrolments, queue] = await Promise.all([
      tx.get(ref),
      tx.get(ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)),
      tx.get(queueRef.limit(COURSE_WAITLIST_SCAN_LIMIT)),
    ])
    const live = courseDoc.data() as CourseBlock
    const nowMs = Date.now()
    const holding = countHoldingPlaces(enrolments.docs, nowMs)
    if (placesFree(live.places, holding) > 0) {
      throw new HttpsError('failed-precondition', 'That course still has places.', {
        reason: 'places_available',
      })
    }

    const mine = queue.docs.find((d) => d.id === contactId)
    const mineStatus = mine?.get('status') as string | undefined
    // Already waiting, or holding an offer: idempotent, and NOT a fresh
    // `joined_at`. Re-joining must never let somebody jump their own queue
    // position by clicking twice.
    if (mineStatus === 'waiting' || mineStatus === 'offered') {
      return { blockId, contactId, status: mineStatus, entryToken: mine!.get('entry_token') }
    }

    const waiting = queue.docs.filter((d) => d.get('status') === 'waiting').length
    if (waiting >= courseWaitlistCap(live.places)) {
      throw new HttpsError('resource-exhausted', 'That waiting list is full.', {
        reason: 'queue_full',
      })
    }

    const entry = {
      teamId,
      course: blockId,
      contact: contactId,
      course_start: first?.start ?? null,
      firstname: contact.firstname ?? '',
      lastname: contact.lastname ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? null,
      // A fresh join after a lapsed offer goes to the TAIL, which is the whole
      // re-queue policy: an entry is offered once, ever.
      joined_at: FieldValue.serverTimestamp(),
      status: 'waiting' as const,
      entry_token: entryToken,
      offer_token: null,
      offered_at: null,
      offer_expires_at: null,
      claimed_at: null,
      left_at: null,
    }
    tx.set(queueRef.doc(contactId), entry)
    return { blockId, contactId, status: 'waiting' as const, entryToken }
  })
})

/** Leave the queue. Authenticated by the long-lived `entry_token`, which is
 *  deliberately not the claim credential. */
export const leaveCourseBlockWaitlist = onCall(async (request) => {
  const { blockId, contactId, entryToken } = request.data as {
    blockId?: string
    contactId?: string
    entryToken?: string
  }
  if (!blockId || !contactId || !entryToken) {
    throw new HttpsError('invalid-argument', 'blockId, contactId and entryToken are required')
  }
  const db = admin.firestore()
  const entryRef = blockRefOf(db, blockId)
    .collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
    .doc(contactId)
  const doc = await entryRef.get()
  if (!doc.exists) return { blockId, contactId, left: true }
  if (doc.get('entry_token') !== entryToken) {
    throw new HttpsError('permission-denied', 'That link is not valid.')
  }

  const wasOffered = doc.get('status') === 'offered'
  await entryRef.update({
    status: 'left',
    left_at: FieldValue.serverTimestamp(),
    offer_token: null,
    offer_expires_at: null,
  })
  // Giving up an OFFER gives the place back, which is the only branch here that
  // touches capacity. Release before anything re-offers: the promoter runs off
  // the course document's edge, and the release is what produces that edge.
  if (wasOffered) await releaseCourseOffer(db, blockId, contactId)
  return { blockId, contactId, left: true, releasedPlace: wasOffered }
})

// ─── releasing an offer ──────────────────────────────────────────────────────

/**
 * Give an offered place back. THE ONE way a course offer stops being an offer.
 *
 * The guard is what stands between the queue and a destroyed paid enrolment: an
 * offer taken up in the meantime is an ordinary `enrolled` row, possibly paid
 * for, and withdrawing it would take the place off somebody who owns it. So the
 * ENTRY is treated as a derived view of the ENROLMENT: whatever the enrolment
 * says happened is what the entry is set to, and a flip missed anywhere else
 * self-heals here instead of turning into a deletion.
 */
export async function releaseCourseOffer(
  db: FirebaseFirestore.Firestore,
  blockId: string,
  contactId: string
): Promise<'released' | 'self_healed' | 'noop'> {
  const ref = blockRefOf(db, blockId)
  const enrolmentRef = ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).doc(contactId)

  return db.runTransaction(async (tx) => {
    const [enrolDoc, enrolments] = await Promise.all([
      tx.get(enrolmentRef),
      tx.get(ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)),
    ])
    if (!enrolDoc.exists) return 'noop'
    const status = enrolDoc.get('status') as string | undefined
    const isClaim = enrolDoc.get('waitlist_claim') === true
    // They are ON the course. Either the claim settled and the entry flip was
    // missed, or they bought a place another way while holding the offer.
    // Either way the enrolment is theirs and is left exactly alone.
    if (status === 'enrolled') return 'self_healed'
    if (!isClaim) return 'noop'

    tx.set(
      enrolmentRef,
      {
        status: 'withdrawn',
        withdrawn_at: FieldValue.serverTimestamp(),
        expires_at: null,
        waitlist_claim: FieldValue.delete(),
        claim_expires_at: FieldValue.delete(),
      },
      { merge: true }
    )
    // ABSOLUTE, from the read set this transaction already holds, never an
    // increment. The ONE PLACE WRITER rule, unchanged.
    tx.update(ref, {
      places_taken: countHoldingPlaces(enrolments.docs, Date.now(), contactId),
      updated_at: FieldValue.serverTimestamp(),
    })
    return 'released'
  })
}

// ─── the promoter ────────────────────────────────────────────────────────────

/**
 * Offer as many places as the course currently has free, oldest waiter first.
 *
 * ONE transaction, with the course document in both the read set and the write
 * set: that is the serialization point, and it is the same document the
 * ordinary door contends on, so an offer and a purchase cannot take the same
 * place.
 */
export async function offerCoursePlaces(
  db: FirebaseFirestore.Firestore,
  blockId: string
): Promise<CourseWaitlistOffer[]> {
  const ref = blockRefOf(db, blockId)
  const nowMs = Date.now()

  return db.runTransaction(async (tx) => {
    const blockDoc = await tx.get(ref)
    if (!blockDoc.exists) return []
    const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }
    // Every refusal below returns WITHOUT writing the course. See the header:
    // touching it on a no-op path re-enters the edge for ever.
    if (!courseBlockSalesOpen(block, nowMs)) return []

    const first = firstMeeting(block)
    const window = resolveCourseClaimWindow({
      nowMs,
      firstMeetingMs: first?.start.toMillis() ?? null,
      closesAtMs: block.booking_closes_at?.toMillis() ?? null,
    })
    // Too little of a window left to be worth offering. The place simply shows
    // as free and the ordinary door can sell it, which is the right outcome.
    if (!window.offerable) return []

    const [enrolments, queue] = await Promise.all([
      tx.get(ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)),
      tx.get(
        ref
          .collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
          .where('status', '==', 'waiting')
          .orderBy('joined_at', 'asc')
          .limit(COURSE_WAITLIST_SCAN_LIMIT)
      ),
    ])

    const holding = countHoldingPlaces(enrolments.docs, nowMs)
    const free = placesFree(block.places, holding)
    if (!Number.isFinite(free) || free <= 0) return []
    const room = Math.min(free, COURSE_WAITLIST_MAX_OFFERS_PER_RUN)

    // Somebody who got onto the course another way since joining must not be
    // offered a place: the offer would REPLACE their enrolment with a hold, and
    // the next release would then withdraw them from a course they had paid
    // for.
    const already = new Set(
      enrolments.docs.filter((d) => d.get('status') === 'enrolled').map((d) => d.id)
    )
    const candidates = queue.docs.filter((d) => !already.has(d.id))

    // Contact liveness is applied BEFORE the head is taken; the reasoning is on
    // `selectCourseOfferHeads`, which owns it.
    const contactDocs = await Promise.all(
      candidates.map((d) => tx.get(db.collection(CONTACTS_COLLECTION).doc(d.id)))
    )
    const liveIds = new Set(contactDocs.filter((d) => d.exists).map((d) => d.id))
    const { heads, dropped } = selectCourseOfferHeads(candidates, room, (d) => liveIds.has(d.id))

    // A contact that no longer exists is TERMINAL and is closed out in this same
    // transaction. That is what stops a corpse at the front of the queue being
    // re-picked on every trigger for the life of the course.
    for (const corpse of dropped) {
      tx.update(corpse.ref, { status: 'expired', offer_token: null, offer_expires_at: null })
    }
    if (heads.length === 0) {
      // Nothing to offer. If entries were closed out above, that write already
      // happened; the COURSE is still untouched, which is the invariant.
      return []
    }

    const expiresAt = Timestamp.fromMillis(window.expiresAtMs)
    const offers: CourseWaitlistOffer[] = []
    for (const head of heads) {
      const offerToken = generateSecureToken()
      const entry = head.data() as CourseBlockWaitlistEntry
      tx.set(
        ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).doc(head.id),
        {
          contactId: head.id,
          teamId: block.teamId,
          status: 'hold',
          payment_status: 'required',
          firstname: entry.firstname ?? null,
          lastname: entry.lastname ?? null,
          email: entry.email ?? null,
          waitlist_claim: true,
          // THE SINGLE-DEADLINE RULE: one instant, computed once above, copied
          // into all of these. `expires_at` is what the place predicate reads;
          // `claim_expires_at` is what the claim rail reads; the entry's
          // `offer_expires_at` is what the sweep reads. Diverge and a place is
          // sold twice.
          expires_at: expiresAt,
          claim_expires_at: expiresAt,
          enrolled_at: FieldValue.serverTimestamp(),
          withdrawn_at: null,
        },
        { merge: true }
      )
      tx.update(head.ref, {
        status: 'offered',
        offered_at: FieldValue.serverTimestamp(),
        offer_expires_at: expiresAt,
        offer_token: offerToken,
      })
      offers.push({
        teamId: block.teamId,
        blockId,
        courseName: block.name,
        contactId: head.id,
        firstname: entry.firstname || 'there',
        email: entry.email ?? '',
        offerToken,
        offerExpiresAt: expiresAt,
      })
    }

    // ABSOLUTE, from the read set, never an increment. The offered holds are
    // counted because they are ordinary enrolments.
    tx.update(ref, {
      places_taken: holding + heads.length,
      updated_at: FieldValue.serverTimestamp(),
    })
    return offers
  })
}

/** Mints the offers and then tells the people. The mail is outside the
 *  transaction because a send is slow, can fail, and must never hold a lock on
 *  the document the ordinary door contends on. */
export async function offerCoursePlacesAndNotify(
  db: FirebaseFirestore.Firestore,
  blockId: string
): Promise<number> {
  const [err, offers] = await to(offerCoursePlaces(db, blockId))
  if (err || !offers) {
    console.error('[courseWaitlist] could not offer places on', blockId, err)
    return 0
  }
  for (const offer of offers) {
    const [mailErr] = await to(notifyCourseOffer(db, offer))
    if (mailErr) {
      // Nobody was told, so the place is dead: give it back rather than let it
      // sit held for two days on an offer that reached no one.
      console.error('[courseWaitlist] offer mail failed for', offer.contactId, mailErr)
      await to(releaseCourseOffer(db, blockId, offer.contactId))
    }
  }
  return offers.length
}

async function notifyCourseOffer(
  db: FirebaseFirestore.Firestore,
  offer: CourseWaitlistOffer
): Promise<void> {
  const teamData = await getTeamData(db, offer.teamId)
  const until = offer.offerExpiresAt.toDate().toLocaleString('en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
  const claimUrl = `${getHostingUrl()}/public/${teamData.slug ?? ''}/course-claim?block=${offer.blockId}&contact=${offer.contactId}&token=${offer.offerToken}`
  const { html } = buildEmailTemplate({
    title: 'A place has come free',
    body:
      `<p>Hi ${offer.firstname},</p>` +
      `<p>A place has come free on <strong>${offer.courseName}</strong> at ${teamData.name}, ` +
      `and it is being held for you until <strong>${until}</strong>.</p>` +
      `<p>After that it goes to the next person on the list.</p>` +
      `<p style="text-align:center;margin-top:24px;">${ctaButton(claimUrl, 'Take the place')}</p>`,
  })
  await sendEmail({
    to: offer.email,
    teamId: offer.teamId,
    subject: `A place has come free: ${offer.courseName}`,
    html,
    text:
      `Hi ${offer.firstname},\n\nA place has come free on ${offer.courseName} at ${teamData.name}, ` +
      `and it is being held for you until ${until}.\nAfter that it goes to the next person on the list.\n\n` +
      `Take the place: ${claimUrl}`,
  })
}

/**
 * The trigger. Fires on the EDGE: the course was full, and now it is not.
 *
 * Every way a place can free converges here, because `places_taken` has one
 * writer and it always writes an absolute value. That is why this is a trigger
 * on the document rather than a call at each of the sites that frees one.
 */
export const promoteCourseWaitlistOnPlaceFreed = onDocumentWritten(
  'course_blocks/{blockId}',
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() : null
    const after = event.data?.after.exists ? event.data.after.data() : null
    if (!placeFreedEdge(before, after)) return
    await offerCoursePlacesAndNotify(admin.firestore(), event.params.blockId)
  }
)

// ─── the sweep ───────────────────────────────────────────────────────────────

/**
 * Offers whose window closed, released and rolled on to the next person.
 *
 * HOURLY GRANULARITY IS ONLY ACCEPTABLE BECAUSE EXPIRY IS LAZY. A lapsed hold
 * stops occupying its place the instant any transaction reads it
 * (`courseBlockEnrolmentHoldsPlace`), and the claim rail refuses a lapsed offer
 * whether or not this has run. This is bookkeeping and re-offering, never
 * correctness.
 *
 * Pass 1 releases before pass 2 re-offers. The other way round would re-offer
 * into a place that had not been given back yet and leak it for an hour.
 */
export async function sweepCourseWaitlistOffers(): Promise<{
  lapsed: number
  promoted: number
  errors: number
}> {
  const db = admin.firestore()
  const now = Timestamp.now()
  const stats = { lapsed: 0, promoted: 0, errors: 0 }

  const lapsed = await db
    .collectionGroup(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
    .where('status', '==', 'offered')
    .where('offer_expires_at', '<=', now)
    .orderBy('offer_expires_at', 'asc')
    .limit(COURSE_WAITLIST_SCAN_LIMIT)
    .get()

  const touched = new Set<string>()
  for (const entry of lapsed.docs) {
    const blockId = entry.get('course') as string | undefined
    if (!blockId) continue
    const [err, outcome] = await to(releaseCourseOffer(db, blockId, entry.id))
    if (err) {
      stats.errors += 1
      continue
    }
    // The entry is a DERIVED VIEW of the enrolment: if they got on the course
    // after all, the entry is corrected rather than expired.
    await to(
      entry.ref.update({
        status: outcome === 'self_healed' ? 'claimed' : 'expired',
        offer_token: null,
        offer_expires_at: null,
      })
    )
    stats.lapsed += 1
    if (outcome === 'released') touched.add(blockId)
  }

  for (const blockId of touched) {
    const [err, count] = await to(offerCoursePlacesAndNotify(db, blockId))
    if (err) stats.errors += 1
    else stats.promoted += count ?? 0
  }
  return stats
}

// ─── claiming ────────────────────────────────────────────────────────────────

/**
 * Turn an offer into a place. The FREE rail.
 *
 * It refuses a payable caller with `payment_required`, exactly as
 * `joinCourseBlock` does, and the paid claim goes back out through
 * `createCourseBlockCheckout` carrying the same token. There is deliberately no
 * second pricing path: one resolver decides what a course costs whoever is
 * asking, and a queue that priced things itself would disagree with it the
 * first time a plan edge or a promo code changed.
 */
export const claimCourseBlockPlace = onCall(async (request) => {
  const { blockId, contactId, offerToken } = request.data as {
    blockId?: string
    contactId?: string
    offerToken?: string
  }
  if (!blockId || !contactId || !offerToken) {
    throw new HttpsError('invalid-argument', 'blockId, contactId and offerToken are required')
  }

  const db = admin.firestore()
  const ref = blockRefOf(db, blockId)
  const entryRef = ref.collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION).doc(contactId)

  const { settled } = await db.runTransaction(async (tx) => {
    const [entryDoc, enrolDoc] = await Promise.all([
      tx.get(entryRef),
      tx.get(ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).doc(contactId)),
    ])
    if (!entryDoc.exists) throw new HttpsError('not-found', 'That offer no longer exists.')
    // SINGLE USE. The token is cleared the moment the offer resolves in any
    // direction, so a forwarded link cannot be replayed.
    if (entryDoc.get('offer_token') !== offerToken) {
      throw new HttpsError('permission-denied', 'That link has already been used.')
    }
    const expiresAt = entryDoc.get('offer_expires_at') as Timestamp | undefined
    // Refused here whether or not the sweep has run: the deadline is the truth,
    // not the bookkeeping.
    if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'That offer has expired.', { reason: 'expired' })
    }
    if (!enrolDoc.exists || enrolDoc.get('waitlist_claim') !== true) {
      throw new HttpsError('failed-precondition', 'That place is no longer being held.')
    }

    // The place is ALREADY HELD by this hold, so settling it takes nothing and
    // `places_taken` does not move. That is the whole point of the offer being
    // an ordinary enrolment.
    tx.set(
      ref.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).doc(contactId),
      {
        status: 'enrolled',
        payment_status: 'not_required',
        expires_at: null,
        waitlist_claim: FieldValue.delete(),
        claim_expires_at: FieldValue.delete(),
      },
      { merge: true }
    )
    tx.update(entryRef, {
      status: 'claimed',
      claimed_at: FieldValue.serverTimestamp(),
      offer_token: null,
      offer_expires_at: null,
    })
    tx.update(ref, { roster_version: FieldValue.increment(1) })
    return { settled: true }
  })

  // The bookings follow the settled enrolment, outside the transaction, exactly
  // as they do for every other way onto a course.
  const roster = await syncCourseBlockRoster(db, blockId)
  return { blockId, contactId, settled, bookingsWritten: roster.written }
})

// ─── the studio's view ───────────────────────────────────────────────────────

/** The queue, in order, for the roster panel. Read-only; every write to a
 *  waitlist entry goes through a callable. */
export const listCourseBlockWaitlist = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const { teamId, blockId } = request.data as { teamId?: string; blockId?: string }
  if (!teamId || !blockId) {
    throw new HttpsError('invalid-argument', 'teamId and blockId are required')
  }
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const db = admin.firestore()
  const snap = await blockRefOf(db, blockId)
    .collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
    .orderBy('joined_at', 'asc')
    .limit(COURSE_WAITLIST_SCAN_LIMIT)
    .get()

  return {
    blockId,
    entries: snap.docs
      .filter((d) => d.get('teamId') === teamId)
      .map((d, index) => ({
        contactId: d.id,
        firstname: d.get('firstname') ?? '',
        lastname: d.get('lastname') ?? '',
        email: d.get('email') ?? '',
        status: d.get('status') ?? 'waiting',
        // DERIVED at read time, never stored: somebody leaving ahead of you must
        // not rewrite every entry behind you.
        position: index + 1,
        joinedAt: (d.get('joined_at') as Timestamp | undefined)?.toMillis() ?? null,
        offerExpiresAt:
          (d.get('offer_expires_at') as Timestamp | undefined)?.toMillis() ?? null,
      })),
  }
})
