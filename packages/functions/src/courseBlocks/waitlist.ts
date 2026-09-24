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
  lastMeeting,
  placeFreedEdge,
  placesFree,
  resolveCourseClaimWindow,
  resolvePaymentOptions,
  selectCourseOfferHeads,
  type CourseBlock,
  type CourseBlockWaitlistEntry,
} from '@linyup/shared'
import { loadContactPaymentSnapshot } from '../booking/access'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import { requirePlan } from '../utils/plan'
import { to } from '../utils/async'
import { requireCapability } from '../utils/teams'
import { generateSecureToken } from '../utils/crypto'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { getHostingUrl } from '../utils/env'
import { getTeamData } from '../sessions/teardown'
import {
  assertUnderCheckoutRateLimit,
  checkoutRateLimit,
} from '../connect/checkout'
import {
  WAITLIST_CLAIM_RATE_LIMIT_BUCKET,
  WAITLIST_RATE_LIMIT_BUCKET,
} from '../booking/waitlist/constants'
import { courseBlockTarget, syncCourseBlockRoster } from './enrolment'

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A queue-born contact is reaped if the queue never comes good. They were
 *  never promised anything, and `purgeProvisionalContacts` re-checks the flag
 *  at delete time, so a claim that confirms them makes them permanent. */
const PROVISIONAL_DAYS_AFTER_COURSE = 30

function blockRefOf(db: FirebaseFirestore.Firestore, blockId: string) {
  return db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
}

// ─── joining ─────────────────────────────────────────────────────────────────

/**
 * Take a place in the queue for a full course.
 *
 * THE PUBLIC RAIL, so it resolves who is joining rather than being told. The
 * identity rules are the class queue's (`booking/waitlist/join.ts`) and are not
 * re-decided here:
 *
 *  - A verified CONTACT SESSION is the only identity trusted from the caller. A
 *    `contactId` in the request body proves nothing and would let anyone
 *    enumerate a studio's contacts by guessing ids.
 *  - A guest gives email + name, and an EXACT match on all three is the same
 *    person. Anything looser merges two people who share an address.
 *  - A new joiner becomes a PROVISIONAL contact with an expiry, because a queue
 *    that never comes good must not leave a permanent record of somebody who
 *    was never promised anything. `purgeProvisionalContacts` re-checks the flag
 *    at delete time, so a claim that confirms them makes them permanent.
 *
 * AN EMAIL ADDRESS IS NOT OPTIONAL, and that is a mechanical constraint rather
 * than a preference: a place is only ever redeemed through the mailed claim
 * link, and an entry is offered ONCE, ever. Somebody unreachable would take a
 * place, be offered it, and be dropped having never been told.
 *
 * It refuses a course that is NOT full. A queue on a course with places left is
 * a person who thinks they are waiting and could simply have booked, and the
 * promoter would turn their entry straight into a hold and lock a real buyer
 * out.
 */
export const joinCourseBlockWaitlist = onCall(async (request) => {
  const data = request.data as {
    teamId?: string
    blockId?: string
    contactDetails?: { firstname?: string; lastname?: string; email?: string; phone?: string }
  }
  const { teamId, blockId } = data
  if (!teamId || !blockId) {
    throw new HttpsError('invalid-argument', 'teamId and blockId are required')
  }

  // Charged up front and on the JOIN bucket, never the claim one: joining is
  // the one queue action an anonymous visitor can repeat, and every join can
  // create a contact. Sharing the claim quota would mean a busy queue behind one
  // studio's NAT made an offered place unreachable from that same NAT.
  await checkoutRateLimit(request.rawRequest?.ip, WAITLIST_RATE_LIMIT_BUCKET)

  const db = admin.firestore()
  // The waiting list is a Coach-tier feature, like the class queue it mirrors.
  await requirePlan(teamId, 'coach')

  const ref = blockRefOf(db, blockId)
  const blockDoc = await ref.get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }
  // A cancelled or unpublished course has no queue, and one whose sales have
  // closed cannot hand a place to anybody. Read through the ONE predicate the
  // public card reads, so nobody is shown a button this refuses.
  if (!courseBlockSalesOpen(block)) {
    throw new HttpsError('failed-precondition', 'That course is not taking bookings.', {
      reason: 'sales_closed',
    })
  }
  const last = lastMeeting(block)

  // ── Who is joining ────────────────────────────────────────────────────────
  let contactId: string
  let firstname: string
  let lastname: string
  let email: string
  let phone: string | null = null

  const session = optionalContactSessionFromRequest(request)
  if (session && session.teamId === teamId) {
    const snap = await db.collection(CONTACTS_COLLECTION).doc(session.contactId).get()
    const c = snap.data()
    if (!snap.exists || c?.teamId !== teamId) {
      throw new HttpsError('not-found', 'That contact no longer exists.')
    }
    contactId = snap.id
    firstname = (c!.firstname as string) || ''
    lastname = (c!.lastname as string) || ''
    email = ((c!.email as string) || '').toLowerCase().trim()
    // The session's own login email is the fallback before refusing: a contact
    // reached through the per-contact login-email allow-list (a parent on a
    // child's profile) may carry an empty `Contact.email` while the address they
    // proved control of sits in the verified token claims.
    if (!email) {
      email = ((request.auth?.token?.email as string | undefined) ?? '').toLowerCase().trim()
    }
    if (!EMAIL_RE.test(email)) {
      throw new HttpsError(
        'failed-precondition',
        'An email address is needed to hold a place on the waiting list.',
        { reason: 'email_required' }
      )
    }
    phone = (c!.phone as string) || null
  } else {
    const cd = data.contactDetails
    email = (cd?.email ?? '').toLowerCase().trim()
    firstname = (cd?.firstname ?? '').trim()
    lastname = (cd?.lastname ?? '').trim()
    phone = cd?.phone?.trim() || null
    if (!EMAIL_RE.test(email) || !firstname || !lastname) {
      throw new HttpsError('invalid-argument', 'firstname, lastname and a valid email are required')
    }
    const existing = await db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('email', '==', email)
      .get()
    const match = existing.docs.find((d) => {
      const c = d.data()
      return (
        c.firstname?.toLowerCase().trim() === firstname.toLowerCase() &&
        c.lastname?.toLowerCase().trim() === lastname.toLowerCase()
      )
    })
    if (match) {
      contactId = match.id
    } else {
      const created = db.collection(CONTACTS_COLLECTION).doc()
      await created.set({
        firstname,
        lastname,
        email,
        phone,
        // NO acquisition_stage, deliberately, and for the class queue's reason:
        // joining a queue is not a booking, and stamping a funnel entry on
        // somebody who may never get a place would report something that never
        // happened. It is stamped when they claim.
        entry: 'course_waitlist',
        provisional: true,
        // Tied to the course's END rather than its start: a queue stays worth
        // something until the last lesson, which is the whole reason the claim
        // window clamps there too.
        provisional_expires_at: Timestamp.fromMillis(
          (last?.end.toMillis() ?? Date.now()) +
            PROVISIONAL_DAYS_AFTER_COURSE * 24 * 60 * 60 * 1000
        ),
        teamId,
        archived_at: null,
        deleted_at: null,
        created_at: FieldValue.serverTimestamp(),
      })
      contactId = created.id
      console.log(`[courseWaitlist] new provisional contact ${contactId} queued for ${blockId}`)
    }
  }

  const queueRef = ref.collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
  const entryToken = generateSecureToken()

  const result = await db.runTransaction(async (tx) => {
    // The course document is in the read set, which is what serialises a join
    // against a place being taken: joining a course that filled a millisecond
    // ago, or emptied a millisecond ago, resolves one way or the other rather
    // than both.
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
    // Already ON it: not a queue candidate at all, and offering them a place
    // later would replace a settled enrolment with a hold.
    const mine = enrolments.docs.find((d) => d.id === contactId)
    if (mine && mine.get('status') === 'enrolled') {
      throw new HttpsError('failed-precondition', 'You are already on that course.', {
        reason: 'already_enrolled',
      })
    }

    const existing = queue.docs.find((d) => d.id === contactId)
    const status = existing?.get('status') as string | undefined
    // Idempotent, and NOT a fresh `joined_at`: re-joining must never let
    // somebody jump their own place in the line by clicking twice.
    if (status === 'waiting' || status === 'offered') {
      return {
        status,
        entryToken: existing!.get('entry_token') as string,
        position: null as number | null,
        created: false,
      }
    }

    const waiting = queue.docs.filter((d) => d.get('status') === 'waiting')
    if (waiting.length >= courseWaitlistCap(live.places)) {
      throw new HttpsError('resource-exhausted', 'That waiting list is full.', {
        reason: 'queue_full',
      })
    }

    tx.set(queueRef.doc(contactId), {
      teamId,
      course: blockId,
      contact: contactId,
      course_start: firstMeeting(live)?.start ?? null,
      firstname,
      lastname,
      email,
      phone,
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
    })
    return {
      status: 'waiting' as const,
      entryToken,
      position: waiting.length + 1,
      created: true,
    }
  })

  // The confirmation carries the LONG-LIVED entry token, never a claim
  // credential: it is a link to check your place and to leave, and it is
  // forwardable by design. Outside the transaction, and never allowed to fail
  // the join: they are in the queue whether or not the mail lands.
  if (result.created) {
    const [mailErr] = await to(
      notifyCourseWaitlistJoined({
        teamId,
        firstname,
        email,
        courseName: block.name,
        position: result.position,
        entryToken: result.entryToken,
      })
    )
    if (mailErr) console.error('[courseWaitlist] join confirmation failed for', email, mailErr)
  }

  return {
    blockId,
    contactId,
    status: result.status,
    position: result.position,
    entryToken: result.entryToken,
  }
})

/** The join confirmation: where you are in the line, and the link back to it. */
async function notifyCourseWaitlistJoined(params: {
  teamId: string
  firstname: string
  email: string
  courseName: string
  position: number | null
  entryToken: string
}): Promise<void> {
  if (!params.email) return
  const teamData = await getTeamData(admin.firestore(), params.teamId)
  const url = `${getHostingUrl()}/public/${teamData.slug ?? ''}/course-waitlist?token=${params.entryToken}`
  const place = params.position
    ? `<p>You are number <strong>${params.position}</strong> in the line.</p>`
    : ''
  const { html } = buildEmailTemplate({
    title: 'You are on the waiting list',
    body:
      `<p>Hi ${params.firstname},</p>` +
      `<p><strong>${params.courseName}</strong> at ${teamData.name} is full, and you are on the ` +
      `waiting list. We will write the moment a place comes free.</p>` +
      place +
      `<p style="text-align:center;margin-top:24px;">${ctaButton(url, 'Check your place')}</p>`,
  })
  await sendEmail({
    to: params.email,
    teamId: params.teamId,
    subject: `You are on the waiting list: ${params.courseName}`,
    html,
    text:
      `Hi ${params.firstname},\n\n${params.courseName} at ${teamData.name} is full, and you are on ` +
      `the waiting list. We will write the moment a place comes free.\n` +
      (params.position ? `You are number ${params.position} in the line.\n` : '') +
      `\nCheck your place: ${url}`,
  })
}

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

    // THE COURSE'S END, not its start. A place that frees in week four is the
    // reason this queue exists, and clamping to the first lesson closed the
    // window before it opened on every course that had already begun.
    const last = lastMeeting(block)
    const window = resolveCourseClaimWindow({
      nowMs,
      lastMeetingMs: last?.end.toMillis() ?? null,
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
  // ONE PARAMETER, and it is the credential. Naming the block and the contact
  // in the link would let the page assert whose offer it was; the token is what
  // the server resolves, and which token matched is what decides whether this
  // person may take the place or only look at the queue.
  const claimUrl = `${getHostingUrl()}/public/${teamData.slug ?? ''}/course-waitlist?token=${offer.offerToken}`
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

  // ── THE PRICE IS CHECKED BEFORE ANYTHING IS SETTLED ───────────────────────
  //
  // An offer is a claim on a PLACE, never on the money. Without this the token
  // was the whole gate: whoever held a valid one settled a course of any price
  // for nothing, because the transaction below writes
  // `payment_status: 'not_required'` unconditionally. The header above this
  // function said the refusal was here for a while before it was.
  //
  // Priced through the ONE resolver, with `enrolled: false`, because they are holding
  // a place, not standing on one, and the `enrolled` arm answers "you already
  // own this", which would hand the course over free.
  const blockDoc = await ref.get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }

  const contactDoc = await db.collection(CONTACTS_COLLECTION).doc(contactId).get()
  if (!contactDoc.exists) throw new HttpsError('not-found', 'That contact no longer exists.')
  const contact = contactDoc.data() as {
    teamId?: string
    firstname?: string
    lastname?: string
    email?: string
  }
  if (contact.teamId !== block.teamId) {
    throw new HttpsError('permission-denied', 'That contact belongs to another studio.')
  }

  const snapshot = await loadContactPaymentSnapshot({
    teamId: block.teamId,
    contact: { ...contact, id: contactId },
    relevantTypeIds: block.includedSubscriptionTypeIds ?? [],
  })
  const priced = resolvePaymentOptions(snapshot, courseBlockTarget(block, { enrolled: false }))
  const option = priced.options[0]

  // THE REFUSAL BRANCH COMES FIRST. An empty options array falling through to
  // the settle below is the free course this gate exists to prevent, which is
  // the mistake the appointment rail made and the free join rail was corrected
  // for.
  if (!option) {
    throw new HttpsError('failed-precondition', 'You cannot take this place.', {
      reason: priced.denial ?? 'no_subscription',
    })
  }
  if (option.type === 'pay') {
    // The offer STANDS. Nothing here consumes the token or releases the place:
    // they have until the offer's own deadline to come back through
    // `createCourseBlockCheckout` with it, which settles the same enrolment.
    throw new HttpsError('failed-precondition', 'This course has to be paid for.', {
      reason: 'payment_required',
      priceAmount: option.amount,
    })
  }

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

// ─── the token lookup ────────────────────────────────────────────────────────

/**
 * What the claim page renders from, and the only way a guest can see their own
 * place in the queue.
 *
 * A CALLABLE RATHER THAN A CLIENT READ, and it has to be: the queue is readable
 * only by team members, and somebody who joined from the public shop has no
 * session at all. The token in their mail is their whole identity here.
 *
 * WHICH TOKEN MATCHED DECIDES WHAT THEY MAY DO, and the SERVER decides that,
 * not the URL. The single-use `offer_token` is tried first and the long-lived
 * `entry_token` second, so a forwarded join confirmation can only ever show a
 * status view while the claim credential is the one thing that can take the
 * place. Passing the mode in the query string would have made the difference a
 * client's to assert.
 */
export const getCourseWaitlistEntry = onCall(async (request) => {
  const token = typeof (request.data as { token?: string })?.token === 'string'
    ? (request.data as { token: string }).token.trim()
    : ''
  if (!token) throw new HttpsError('invalid-argument', 'token is required')

  // Peeked, not charged: this callable is how the claim page RENDERS, so
  // charging every render would make an offered place unreachable from the same
  // NAT the queue was joined from. Only a token that resolves to nothing costs
  // quota, which is what bounds an enumerator.
  await assertUnderCheckoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)

  const db = admin.firestore()
  const group = db.collectionGroup(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
  const byOffer = await group.where('offer_token', '==', token).limit(1).get()
  const snap = byOffer.empty
    ? await group.where('entry_token', '==', token).limit(1).get()
    : byOffer
  if (snap.empty) {
    await checkoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)
    // INDISTINGUISHABLE BY CONSTRUCTION: the offer token is cleared when the
    // offer resolves in any direction, so "expired" and "already taken" look
    // identical from here, and must, or the credential would outlive its own
    // offer. The long-lived entry link is where the person finds out which.
    throw new HttpsError('not-found', 'This link is no longer valid')
  }

  const entry = snap.docs[0].data() as CourseBlockWaitlistEntry
  const blockId = entry.course
  const [blockSnap, teamSnap] = await Promise.all([
    db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId).get(),
    db.collection('teams').doc(entry.teamId).get(),
  ])
  if (!blockSnap.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = { ...(blockSnap.data() as CourseBlock), id: blockId }

  // The QUEUE POSITION, derived at read time from `joined_at` and never stored:
  // somebody leaving ahead of you must not rewrite every entry behind you.
  let position: number | null = null
  if (entry.status === 'waiting') {
    const ahead = await db
      .collection(COURSE_BLOCKS_COLLECTION)
      .doc(blockId)
      .collection(COURSE_BLOCK_WAITLIST_SUBCOLLECTION)
      .where('status', '==', 'waiting')
      .orderBy('joined_at', 'asc')
      .limit(COURSE_WAITLIST_SCAN_LIMIT)
      .get()
    const idx = ahead.docs.findIndex((d) => d.id === entry.contact)
    position = idx >= 0 ? idx + 1 : null
  }

  const first = firstMeeting(block)
  const last = lastMeeting(block)
  return {
    mode: byOffer.empty ? ('status' as const) : ('claim' as const),
    status: entry.status,
    position,
    /** Was a place ever actually held for them? `expired` is written both when
     *  an offer lapsed and when the queue closed without reaching them, and the
     *  two endings read completely differently to the person. */
    wasOffered: !!entry.offered_at,
    firstname: entry.firstname ?? '',
    lastname: entry.lastname ?? '',
    email: entry.email ?? null,
    teamId: entry.teamId,
    blockId,
    contactId: entry.contact,
    offerExpiresAt: entry.offer_expires_at?.toDate().toISOString() ?? null,
    course: {
      name: block.name,
      description: block.description ?? null,
      firstMeeting: first?.start.toDate().toISOString() ?? null,
      lastMeeting: last?.end.toDate().toISOString() ?? null,
      lessons: (block.meetings ?? []).length,
      location: block.location ?? null,
      providerName: block.providerName ?? null,
      priceAmount: block.priceAmount ?? null,
      cancelled: block.status === 'cancelled',
    },
    team: {
      name: (teamSnap.data()?.name as string | undefined) ?? '',
      slug: (teamSnap.data()?.slug as string | undefined) ?? null,
    },
  }
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
