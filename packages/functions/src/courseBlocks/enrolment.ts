// ─── ENROLMENT: the place, and the bookings that follow from it ─────────────
//
// A course is sold once and attended thirteen times, so two things have to be
// true at once: the PLACE has to be contended for exactly like a seat, and the
// thirteen bookings have to end up written without any of that happening inside
// one transaction.
//
// ── THE PLACE ───────────────────────────────────────────────────────────────
//
// The course document is the serialization point, exactly as the session
// document is for a seat: two people taking the last place conflict on it. And
// the counter obeys the seat rule, restated one level up:
//
//   ONE PLACE WRITER. `places_taken` is only ever an ABSOLUTE value, written
//   either by `trackCourseBlockEnrolments`' recount or from inside a transaction
//   that read the `enrolments` subcollection in the same read set. There is NO
//   `FieldValue.increment` on it anywhere, and a new writer is added only in
//   that shape.
//
// ── THE BOOKINGS ────────────────────────────────────────────────────────────
//
// `syncCourseBlockRoster` is the converger. For every live enrolment × every
// future lesson, it ensures `sessions/{id}/bookings/{contactId}` exists.
//
//   IT ONLY EVER CREATES A BOOKING THAT IS MISSING. It never rewrites one that
//   exists, and never deletes one.
//
// That single rule is what makes it safe to run arbitrarily often, after an
// enrolment, from a Cloud Task, from the nightly reconciliation, and it is also
// what makes "the member cancelled lesson six" stick: a cancelled booking still
// exists, so the converger leaves it exactly where it is instead of resurrecting
// it on the next pass.
//
// Each ensure is its own small transaction in the shape `bookSession` already
// uses: read the session's `bookings`, count with `countHoldingSeats`, write
// `bookings_count` absolutely. The contact's `pending_bookings_count` is moved
// at CREATION, with `increment(1)`, because that is the shape every existing
// disposal path already expects, `cancelBooking` decrements unconditionally,
// and a booking that was never counted would drive a real person's counter
// negative the first time they cancelled one lesson.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import {
  CONTACTS_COLLECTION,
  COURSE_BLOCKS_COLLECTION,
  COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION,
  SESSION_BOOKINGS_SUBCOLLECTION,
  countHoldingPlaces,
  countHoldingSeats,
  courseBlockSalesOpen,
  placesFree,
  resolvePaymentOptions,
  seatsFree,
  type CourseBlock,
  type CourseBlockEnrolment,
  type CourseBlockTarget,
} from '@linyup/shared'
import { loadContactPaymentSnapshot } from '../booking/access'
import { to } from '../utils/async'
import { requireCapability } from '../utils/teams'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import { generateSecureToken } from '../utils/crypto'
import { SESSIONS_COLLECTION } from '../sessions/series'

/** How many (enrolment × lesson) pairs one inline converge will do before it
 *  hands the rest to the next run. A term course for a full cohort is ~120
 *  pairs; this keeps a single callable honest while the common case (one new
 *  enrolment, thirteen lessons) finishes inline. */
export const ROSTER_CONVERGE_INLINE_MAX = 200

export interface CourseEnrolmentResult {
  blockId: string
  contactId: string
  placesTaken: number
  /** Bookings written by the converge that ran with this call. */
  bookingsWritten: number
  /** Lessons whose session had no room, surfaced, never fatal. */
  conflicts: string[]
}

/**
 * A course, as the ONE resolver sees it.
 *
 * Every rail that asks what a course costs, the free join, the checkout, the
 * public card, builds its target here, so none of them can quietly read one
 * facet of the plan edge and miss the other, or forget the sign-up wall. It is
 * the same reason `classAccessFacts` exists on the class side.
 */
export function courseBlockTarget(
  block: Pick<
    CourseBlock,
    'priceAmount' | 'includedSubscriptionTypeIds' | 'benefit' | 'audience'
  >,
  opts: { enrolled: boolean }
): CourseBlockTarget {
  return {
    kind: 'course_block',
    priceAmount: block.priceAmount ?? null,
    includedSubscriptionTypeIds: block.includedSubscriptionTypeIds ?? [],
    benefit: block.benefit ?? null,
    audience: block.audience ?? 'anyone',
    enrolled: opts.enrolled,
  }
}

// ─── the gate ────────────────────────────────────────────────────────────────

export interface EnrolInput {
  blockId: string
  contactId: string
  /** Denormalised for the roster. */
  firstname?: string | null
  lastname?: string | null
  email?: string | null
  /** 'hold' while a checkout is open; 'enrolled' for a free or settled place. */
  status?: 'enrolled' | 'hold'
  payment_status?: 'not_required' | 'required' | 'paid'
  expiresAt?: Timestamp | null
}

/**
 * Takes a place, or refuses. THE ONE WRITER of an enrolment.
 *
 * One transaction on the course and its enrolments: read the whole subcollection,
 * count the live ones at a single sampled instant, refuse when there is no room,
 * and write the counter as an absolute value derived from that read set.
 *
 * The caller's own enrolment is excluded from the count, so re-opening an
 * abandoned checkout or confirming a hold does not refuse somebody the place
 * they are already holding.
 */
export async function takeCourseBlockPlace(
  db: FirebaseFirestore.Firestore,
  input: EnrolInput
): Promise<{ block: CourseBlock; placesTaken: number }> {
  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(input.blockId)
  const enrolmentsRef = blockRef.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)
  const nowMs = Date.now()

  return db.runTransaction(async (tx) => {
    const blockDoc = await tx.get(blockRef)
    if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
    const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }
    if (block.status === 'cancelled') {
      throw new HttpsError('failed-precondition', 'That course was cancelled.')
    }

    const enrolments = await tx.get(enrolmentsRef)
    const holding = countHoldingPlaces(enrolments.docs, nowMs, input.contactId)
    if (placesFree(block.places, holding) <= 0) {
      throw new HttpsError('resource-exhausted', 'That course is full.', {
        reason: 'course_full',
      })
    }

    const existing = enrolments.docs.find((d) => d.id === input.contactId)
    const enrolment: Record<string, unknown> = {
      contactId: input.contactId,
      teamId: block.teamId,
      status: input.status ?? 'enrolled',
      payment_status: input.payment_status ?? 'not_required',
      ...(input.firstname !== undefined ? { firstname: input.firstname } : {}),
      ...(input.lastname !== undefined ? { lastname: input.lastname } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      expires_at: input.expiresAt ?? null,
      withdrawn_at: null,
      // Kept from an earlier enrolment so a re-enrol does not read as brand new
      // on the roster; set on a first one.
      enrolled_at: (existing?.get('enrolled_at') as Timestamp | undefined) ?? FieldValue.serverTimestamp(),
    }

    tx.set(enrolmentsRef.doc(input.contactId), enrolment, { merge: true })
    // ABSOLUTE, from the read set above, never `increment`. `holding` excluded
    // this contact, so +1 is them.
    const placesTaken = holding + 1
    tx.update(blockRef, {
      places_taken: placesTaken,
      roster_version: (block.roster_version ?? 1) + 1,
      updated_at: FieldValue.serverTimestamp(),
    })
    return { block, placesTaken }
  })
}

/** Gives a place back. The same transaction shape, the other way round. */
export async function releaseCourseBlockPlace(
  db: FirebaseFirestore.Firestore,
  blockId: string,
  contactId: string
): Promise<number> {
  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const enrolmentsRef = blockRef.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)
  const nowMs = Date.now()

  return db.runTransaction(async (tx) => {
    const blockDoc = await tx.get(blockRef)
    if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
    const block = blockDoc.data() as CourseBlock
    const enrolments = await tx.get(enrolmentsRef)
    // WITHDRAWN, not deleted: who was on a course is the studio's record, and a
    // deleted row would also lose the fact that they ever paid.
    tx.set(
      enrolmentsRef.doc(contactId),
      { status: 'withdrawn', withdrawn_at: FieldValue.serverTimestamp(), expires_at: null },
      { merge: true }
    )
    const placesTaken = countHoldingPlaces(enrolments.docs, nowMs, contactId)
    tx.update(blockRef, {
      places_taken: placesTaken,
      roster_version: (block.roster_version ?? 1) + 1,
      updated_at: FieldValue.serverTimestamp(),
    })
    return placesTaken
  })
}

// ─── the converger ───────────────────────────────────────────────────────────

/**
 * Makes the per-lesson bookings match the enrolments.
 *
 * Creates what is missing for a live enrolment; cancels a FUTURE booking whose
 * enrolment is no longer live. Never rewrites a booking that exists and is
 * wanted, which is what lets a member cancel one lesson and keep their place.
 *
 * Past lessons are never touched in either direction: a cancelled enrolment does
 * not rewrite attendance history, and a new enrolment does not put somebody on
 * the register of a lesson that already happened.
 */
export async function syncCourseBlockRoster(
  db: FirebaseFirestore.Firestore,
  blockId: string,
  limit = ROSTER_CONVERGE_INLINE_MAX
): Promise<{ written: number; cancelled: number; conflicts: string[]; done: boolean }> {
  const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)
  const blockDoc = await blockRef.get()
  if (!blockDoc.exists) return { written: 0, cancelled: 0, conflicts: [], done: true }
  const block = blockDoc.data() as CourseBlock
  if (!block.seriesId) return { written: 0, cancelled: 0, conflicts: [], done: true }

  const nowMs = Date.now()
  const [enrolSnap, sessionSnap] = await Promise.all([
    blockRef.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).get(),
    db
      .collection(SESSIONS_COLLECTION)
      .where('seriesId', '==', block.seriesId)
      .where('start', '>=', Timestamp.fromMillis(nowMs))
      .get(),
  ])

  const live: Array<{ id: string; data: CourseBlockEnrolment }> = []
  const gone: string[] = []
  for (const d of enrolSnap.docs) {
    const e = d.data() as CourseBlockEnrolment
    // A HOLD IS NOT A ROSTER. An open checkout holds a place, but writing its
    // bookings would put an unpaid person on thirteen registers and leave them
    // there when the checkout lapsed. Bookings follow a SETTLED enrolment.
    if (e.status === 'enrolled') live.push({ id: d.id, data: e })
    else gone.push(d.id)
  }

  const sessions = sessionSnap.docs.filter((d) => {
    const s = d.data() as { status?: string }
    return s.status !== 'cancelled'
  })

  let written = 0
  let cancelled = 0
  const conflicts: string[] = []
  let budget = limit

  for (const session of sessions) {
    if (budget <= 0) return { written, cancelled, conflicts, done: false }
    const bookingsRef = session.ref.collection(SESSION_BOOKINGS_SUBCOLLECTION)
    const existing = await bookingsRef.get()
    const have = new Map(existing.docs.map((d) => [d.id, d]))

    for (const person of live) {
      if (have.has(person.id)) continue
      budget -= 1
      const [err] = await to(
        ensureBooking(db, session.ref, person, block, session.id)
      )
      if (err) {
        // A lesson already at capacity from an ordinary booking. Recorded and
        // shown on the roster, NEVER a reason to fail an enrolment, because
        // refunding a whole course over one full lesson is the wrong answer.
        conflicts.push(session.id)
      } else {
        written += 1
      }
    }

    for (const contactId of gone) {
      const booking = have.get(contactId)
      if (!booking) continue
      const status = booking.get('status') as string | undefined
      if (status === 'cancelled') continue
      budget -= 1
      await cancelBookingForWithdrawal(db, session.ref, booking.ref, contactId)
      cancelled += 1
    }
  }

  const applied = block.roster_version ?? 1
  await Promise.all(
    live.map((p) =>
      blockRef
        .collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)
        .doc(p.id)
        .update({ roster_version_applied: applied })
        .catch(() => undefined)
    )
  )
  await blockRef
    .update({ fanout_conflicts: [...new Set(conflicts)] })
    .catch(() => undefined)

  return { written, cancelled, conflicts: [...new Set(conflicts)], done: true }
}

/** One lesson, one person, the ordinary booking-commit shape. */
async function ensureBooking(
  db: FirebaseFirestore.Firestore,
  sessionRef: FirebaseFirestore.DocumentReference,
  person: { id: string; data: CourseBlockEnrolment },
  block: CourseBlock,
  sessionId: string
): Promise<void> {
  const bookingRef = sessionRef.collection(SESSION_BOOKINGS_SUBCOLLECTION).doc(person.id)
  const nowMs = Date.now()

  await db.runTransaction(async (tx) => {
    const [sessionDoc, bookingsSnap] = await Promise.all([
      tx.get(sessionRef),
      tx.get(sessionRef.collection(SESSION_BOOKINGS_SUBCOLLECTION)),
    ])
    if (!sessionDoc.exists) return
    const session = sessionDoc.data() as { max_participants?: number | null; status?: string }
    if (session.status === 'cancelled') return
    if (bookingsSnap.docs.some((d) => d.id === person.id)) return

    const holding = countHoldingSeats(bookingsSnap.docs, nowMs, person.id)
    if (seatsFree(session.max_participants, holding) <= 0) {
      throw new HttpsError('resource-exhausted', `Lesson ${sessionId} is full.`)
    }

    tx.set(bookingRef, {
      teamId: block.teamId,
      contact: person.id,
      session: sessionId,
      firstname: person.data.firstname ?? null,
      lastname: person.data.lastname ?? null,
      email: person.data.email ?? null,
      // CONFIRMED, whatever the activity's autoConfirm says: they bought the
      // course. A course place is not a request to attend.
      status: 'confirmed',
      // Paid FOR THE COURSE, which is what makes a cancelled lesson mail them
      // even when the studio has the notice switched off (`bookingWasPaidFor`).
      payment_status: person.data.payment_status === 'paid' ? 'paid' : 'not_required',
      course_block_id: block.id,
      booking_token: generateSecureToken(),
      joinedAt: FieldValue.serverTimestamp(),
    })
    // ABSOLUTE, from the read set, the seat rule, unchanged.
    tx.update(sessionRef, { bookings_count: holding + 1 })
    // Per-CONTACT and increment-only by design: this function's read set cannot
    // produce the true total, and nothing recounts it. Moved once, here, at the
    // creation, which is what keeps every existing disposal path correct with
    // no change at all.
    tx.update(db.collection(CONTACTS_COLLECTION).doc(person.id), {
      pending_bookings_count: FieldValue.increment(1),
    })
  })
}

/** A withdrawal's future bookings, cancelled through the ordinary shape so
 *  `trackBookings` recounts, the contact's counter returns once, and the
 *  seat-freed edge fires for any session waitlist. */
async function cancelBookingForWithdrawal(
  db: FirebaseFirestore.Firestore,
  sessionRef: FirebaseFirestore.DocumentReference,
  bookingRef: FirebaseFirestore.DocumentReference,
  contactId: string
): Promise<void> {
  const nowMs = Date.now()
  await db.runTransaction(async (tx) => {
    const bookingsSnap = await tx.get(sessionRef.collection(SESSION_BOOKINGS_SUBCOLLECTION))
    const mine = bookingsSnap.docs.find((d) => d.id === contactId)
    if (!mine || mine.get('status') === 'cancelled') return
    tx.update(bookingRef, { status: 'cancelled', cancelled_at: FieldValue.serverTimestamp() })
    tx.update(sessionRef, {
      bookings_count: countHoldingSeats(bookingsSnap.docs, nowMs, contactId),
    })
    tx.update(db.collection(CONTACTS_COLLECTION).doc(contactId), {
      pending_bookings_count: FieldValue.increment(-1),
    })
  })
}

// ─── the recount ─────────────────────────────────────────────────────────────

/**
 * `places_taken`, recounted from the enrolments on every write to one, the
 * direct analogue of `trackBookings`, and what makes the counter self-healing.
 *
 * It writes the course document, which re-fires nothing here (this trigger
 * watches the ENROLMENTS, not the course) but does drive `placeFreedEdge` for
 * whatever hangs on it.
 */
export const trackCourseBlockEnrolments = onDocumentWritten(
  'course_blocks/{blockId}/enrolments/{contactId}',
  async (event) => {
    const { blockId } = event.params
    const db = admin.firestore()
    const blockRef = db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId)

    const [readErr, snap] = await to(
      blockRef.collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION).get()
    )
    if (readErr || !snap) {
      console.error('[courseBlocks] could not recount places for', blockId, readErr)
      return
    }

    const placesTaken = countHoldingPlaces(snap.docs, Date.now())
    const [writeErr] = await to(blockRef.update({ places_taken: placesTaken }))
    if (writeErr) console.error('[courseBlocks] could not write places_taken for', blockId, writeErr)
  }
)

// ─── the callables ───────────────────────────────────────────────────────────

/**
 * The studio puts somebody on a course, at the desk, over the phone, or because
 * they paid by bank transfer. No money moves here; what they paid, if anything,
 * is recorded through the ordinary payments rail.
 */
export const enrolCourseBlockContact = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const { teamId, blockId, contactId } = request.data as {
    teamId?: string
    blockId?: string
    contactId?: string
  }
  if (!teamId || !blockId || !contactId) {
    throw new HttpsError('invalid-argument', 'teamId, blockId and contactId are required')
  }
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const db = admin.firestore()
  const contactDoc = await db.collection(CONTACTS_COLLECTION).doc(contactId).get()
  if (!contactDoc.exists) throw new HttpsError('not-found', 'That contact no longer exists.')
  const contact = contactDoc.data() as { teamId?: string; firstname?: string; lastname?: string; email?: string }
  if (contact.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That contact belongs to another studio.')
  }

  // BOTH TENANT CHECKS BEFORE THE WRITE. This one used to sit AFTER
  // `takeCourseBlockPlace`, so a manager aiming at another studio's course
  // committed the enrolment and consumed one of their places, and the refusal
  // that followed rolled nothing back: a foreign name and email sat on their
  // roster until somebody noticed. A permission check after the write is not a
  // permission check.
  const blockDoc = await db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId).get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  if ((blockDoc.data() as CourseBlock).teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }

  const { placesTaken } = await takeCourseBlockPlace(db, {
    blockId,
    contactId,
    firstname: contact.firstname ?? null,
    lastname: contact.lastname ?? null,
    email: contact.email ?? null,
    status: 'enrolled',
    payment_status: 'not_required',
  })

  const roster = await syncCourseBlockRoster(db, blockId)
  return {
    blockId,
    contactId,
    placesTaken,
    bookingsWritten: roster.written,
    conflicts: roster.conflicts,
  } satisfies CourseEnrolmentResult
})

/**
 * The FREE rail: a member or a guest takes a place that costs them nothing,
 * because the course is free or because a plan they hold includes it.
 *
 * It refuses a PAYABLE caller with `payment_required`, exactly as
 * `bookAppointment` does, and for the same reason: if this decided on its own
 * what was free it would be a second pricing path, and the two would disagree
 * the first time a promo, a plan edge or a sales deadline changed. The price
 * comes from `resolvePaymentOptions`, and a payable answer sends the caller to
 * the checkout instead.
 */
export const joinCourseBlock = onCall(async (request) => {
  const { teamId, blockId } = request.data as { teamId?: string; blockId?: string }
  if (!teamId || !blockId) {
    throw new HttpsError('invalid-argument', 'teamId and blockId are required')
  }

  // TRUST ONLY THE VERIFIED CONTACT SESSION for who is joining, never a
  // `contactId` from the request body. This callable is on the public member
  // router, so a body id would let anyone enrol anyone on any free or
  // plan-covered course of any studio, and probe which contact ids exist by
  // watching which ones come back `not-found`. It read one for a while, which is
  // exactly what `createDropInCheckout` says in as many words not to do.
  //
  // A guest cannot reach this rail at all, and that is correct rather than a
  // gap: being covered means holding a plan, and holding a plan means being a
  // contact. A course that is free FOR EVERYONE would be the one case for a
  // guest, and the day it needs one it gets the same resolve-or-create the
  // waiting-list join already has, not a body parameter.
  const session = optionalContactSessionFromRequest(request)
  if (!session || session.teamId !== teamId) {
    throw new HttpsError('unauthenticated', 'Sign in to take a place on this course.', {
      reason: 'sign_in_required',
    })
  }
  const contactId = session.contactId

  const db = admin.firestore()
  const blockDoc = await db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId).get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  const block = { ...(blockDoc.data() as CourseBlock), id: blockDoc.id }
  if (block.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }
  // The sales window, read through the ONE predicate the public card reads, so
  // a visitor is never shown a button this refuses.
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
  const option = priced.options[0]

  // THE REFUSAL BRANCH MUST COME BEFORE THE FREE ONE. Without it an empty
  // options array falls through to "enrols without paying", which is the free
  // course this rail exists to prevent. The appointment rail learned this.
  if (!option) {
    throw new HttpsError('failed-precondition', 'You cannot book this course.', {
      reason: priced.denial ?? 'no_subscription',
    })
  }
  if (option.type === 'pay') {
    throw new HttpsError('failed-precondition', 'This course has to be paid for.', {
      reason: 'payment_required',
      priceAmount: option.amount,
    })
  }

  const { placesTaken } = await takeCourseBlockPlace(db, {
    blockId,
    contactId,
    firstname: contact.firstname ?? null,
    lastname: contact.lastname ?? null,
    email: contact.email ?? null,
    status: 'enrolled',
    payment_status: 'not_required',
  })
  const roster = await syncCourseBlockRoster(db, blockId)
  return {
    blockId,
    contactId,
    placesTaken,
    bookingsWritten: roster.written,
    conflicts: roster.conflicts,
  } satisfies CourseEnrolmentResult
})

/** The studio takes somebody off a course. Their future lessons are cancelled
 *  through the ordinary path; the past stays as attendance history. No refund:
 *  money is handed back from the payments page, deliberately and by hand. */
export const withdrawFromCourseBlock = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')
  const { teamId, blockId, contactId } = request.data as {
    teamId?: string
    blockId?: string
    contactId?: string
  }
  if (!teamId || !blockId || !contactId) {
    throw new HttpsError('invalid-argument', 'teamId, blockId and contactId are required')
  }
  await requireCapability(request.auth.uid, teamId, 'schedule.manage')

  const db = admin.firestore()
  const blockDoc = await db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId).get()
  if (!blockDoc.exists) throw new HttpsError('not-found', 'That course no longer exists.')
  if ((blockDoc.data() as CourseBlock).teamId !== teamId) {
    throw new HttpsError('permission-denied', 'That course belongs to another studio.')
  }

  const placesTaken = await releaseCourseBlockPlace(db, blockId, contactId)
  const roster = await syncCourseBlockRoster(db, blockId)
  return { blockId, contactId, placesTaken, cancelled: roster.cancelled }
})
