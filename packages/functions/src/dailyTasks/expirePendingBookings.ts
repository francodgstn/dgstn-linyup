// Daily task: release payment holds that were never paid.
//
// Two independent hold shapes converge here:
//  - Drop-in / membership one-off checkouts write a PENDING booking (a
//    `payment_status: 'required'` doc with `expires_at`) directly on an
//    already-existing session — releasing it is just deleting the booking.
//  - Appointment checkouts are different: THE HOLD IS THE SESSION
//    (`status: 'pending_payment'` + `hold_expires_at`) — nothing else exists
//    until paid. So appointment holds are swept in TWO steps, SESSION FIRST:
//      1. flip the expired session to 'cancelled' (see isExpiredAppointmentHold);
//      2. THEN delete its paired 'required' booking.
//    Order matters: deleting the booking first would let its own onDocumentWritten
//    recount (trackBookings) see a session that's still 'pending_payment' and
//    recompute it to 'open' — resurrecting a slot nobody can now book (the
//    session doc would still say 'pending_payment' with a stale hold_expires_at).
//    Doing the session first means the SAME recount instead sees 'cancelled' and
//    preserves it (trackBookings early-returns on 'pending_payment' but not on
//    'cancelled', so the delete's recount runs and correctly keeps it canceled).
//
// Paid bookings are flipped to 'confirmed' by the Connect webhook (which also
// clears payment_status: 'required'), so they're excluded from both sweeps here.
//
// THIS IS SITE 4 OF THE APPOINTMENT-HOLD RELEASE CENSUS
// (appointments/holdRelease.ts — which owns the list of sites and the proof each
// one rests on; do not restate either here). This site is DEADLINE-addressed
// rather than token-addressed, and it does not have to be: it addresses holds by
// `hold_expires_at <= now`, and `runAppointmentSlotTransaction` REPLACES the whole
// session document, so whichever attempt took a hold over wrote the deadline now
// on it. A deadline in the past is therefore proof that no live attempt holds it.
// Anything that ever makes this query match a LIVE hold breaks that proof — read
// the census header before changing the filter.

import * as admin from 'firebase-admin'

const BATCH_SIZE = 400

/** Step 1 — cancel expired appointment holds (session-level). Must run BEFORE
 *  releaseExpiredBookingHolds so the paired booking's delete-triggered recount
 *  sees 'cancelled', not a still-'pending_payment' session. */
async function cancelExpiredAppointmentHolds(): Promise<number> {
  const db = admin.firestore()
  const now = admin.firestore.Timestamp.now()

  const snap = await db
    .collection('sessions')
    .where('status', '==', 'pending_payment')
    .where('hold_expires_at', '<=', now)
    .get()

  if (snap.empty) return 0

  let count = 0
  let batch = db.batch()
  for (const docSnap of snap.docs) {
    batch.update(docSnap.ref, { status: 'cancelled' })
    count++
    if (count % BATCH_SIZE === 0) {
      await batch.commit()
      batch = db.batch()
    }
  }
  if (count % BATCH_SIZE !== 0) await batch.commit()

  return count
}

/** Step 2 — delete every still-unpaid hold booking (drop-in AND appointment
 *  alike; appointment sessions were already canceled above by this point). */
async function releaseExpiredBookingHolds(): Promise<number> {
  const db = admin.firestore()
  const now = admin.firestore.Timestamp.now()

  const snap = await db
    .collectionGroup('bookings')
    .where('payment_status', '==', 'required')
    .where('expires_at', '<=', now)
    .get()

  if (snap.empty) return 0

  let count = 0
  let batch = db.batch()
  for (const docSnap of snap.docs) {
    batch.delete(docSnap.ref)
    count++
    if (count % BATCH_SIZE === 0) {
      await batch.commit()
      batch = db.batch()
    }
  }
  if (count % BATCH_SIZE !== 0) await batch.commit()

  return count
}

export async function expirePendingBookings(): Promise<{ sessionsCancelled: number; released: number }> {
  const sessionsCancelled = await cancelExpiredAppointmentHolds()
  const released = await releaseExpiredBookingHolds()
  return { sessionsCancelled, released }
}
