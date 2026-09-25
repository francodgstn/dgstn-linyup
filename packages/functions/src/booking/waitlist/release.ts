// Giving a claim hold back — the ONE way an offer stops being an offer.
//
// Six callers reach the same decision from different directions: the hourly
// sweep (pass 1, the window lapsed; pass 2, the class has already run),
// leaveWaitlist (the person gave it up), removeWaitlistEntry (the studio ended
// it), closeSessionWaitlist (the class was canceled or deleted), the Connect
// webhook's oversell branch (the charge was refunded, so the claim dies with the
// seat) and the promoter itself (the offer mail reached nobody, so the seat goes
// straight back). They must apply the identical guard, because the guard is
// what stands between the queue and a destroyed paid booking: an offer that was
// taken up in the meantime is an ordinary confirmed — possibly paid, possibly
// paid with stored value — booking, and deleting it would take the seat off
// someone who owns it and hand it to the next person in line.
//
// So the entry is treated as a DERIVED VIEW of the booking, never as a second
// source of truth: whatever the booking says happened is what the entry is set
// to. A flip that was missed anywhere else self-heals here rather than turning
// into a deletion.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  SESSIONS_COLLECTION,
  WAITLIST_SUBCOLLECTION,
  bookingSeatTakenUp,
  countHoldingSeats,
  isUnclaimedClaimHold,
  type SeatHold,
  type WaitlistStatus,
} from '@linyup/shared'
import { WAITLIST_QUEUE_SCAN_LIMIT } from './constants'

export type OfferReleaseOutcome =
  /** The entry had already moved on — nothing was written. */
  | 'noop'
  /** The entry was only WAITING: it left the queue, no seat was involved. */
  | 'queue_only'
  /** A live unclaimed hold was deleted — a seat is free RIGHT NOW and the caller
   *  should re-offer it before anything else looks at the session. */
  | 'released'
  /** The person is IN the class: whatever replaced the hold still holds their
   *  seat. Either the claim settled and its entry flip was missed (a full-cover
   *  gift-card claim), or they got in another way (booked the class directly
   *  while holding the offer). The booking was left alone and the entry was
   *  corrected to 'claimed' — which is what it should have said. */
  | 'self_healed'
  /** Nothing of the offer is left to release and nothing came of it: the hold is
   *  gone (expirePendingBookings or an admin got there first), what replaced it
   *  no longer holds a seat (canceled, no-showed, rebooked away), or what
   *  replaced it is itself unsettled — a live UNPAID drop-in hold, which
   *  occupies the seat while it lasts but puts nobody in the class. The entry
   *  was closed out and the person is told the offer lapsed, which is the truth
   *  in all three cases. */
  | 'stale'

export interface OfferReleaseResult {
  outcome: OfferReleaseOutcome
  /** Denormalised on the entry, so a collection-group hit needs no parent walk. */
  sessionId: string | null
}

/**
 * Resolve one waitlist entry that may own a claim hold, in ONE transaction.
 *
 * `terminalStatus` is where the entry lands when the seat genuinely goes back to
 * the queue — 'expired' for a lapsed window, 'left' for someone giving it up.
 * `from` is the set of statuses this caller is willing to act on, and it doubles
 * as the idempotency guard: a second run (a redelivered sweep, a double-clicked
 * "leave" link) finds a terminal entry and writes nothing.
 *
 * RELEASE FIRST, re-offer after. The booking is deleted and the session's count
 * corrected inside this transaction; the caller re-offers outside it. Doing it
 * the other way round means the promoter looks for free seats while this one is
 * still held, and the seat leaks until the next sweep.
 */
export async function releaseWaitlistOffer(params: {
  entryRef: FirebaseFirestore.DocumentReference
  terminalStatus: Extract<WaitlistStatus, 'expired' | 'left'>
  from: readonly WaitlistStatus[]
}): Promise<OfferReleaseResult> {
  const { entryRef, terminalStatus, from } = params
  const db = admin.firestore()

  return db.runTransaction<OfferReleaseResult>(async (tx) => {
    // ── READS (all of them, before the first write) ───────────────────────────
    // Sampled ONCE: the same instant decides whether the replacement booking
    // still holds its seat and how many seats are left after this release, so
    // the two can never disagree about a hold that lapses mid-transaction.
    const nowMs = Date.now()
    const entrySnap = await tx.get(entryRef)
    if (!entrySnap.exists) return { outcome: 'noop', sessionId: null }
    const entry = entrySnap.data()!
    const sessionId = (entry.session as string | undefined) ?? null
    const status = entry.status as WaitlistStatus | undefined
    if (!sessionId || !status || !from.includes(status)) {
      return { outcome: 'noop', sessionId }
    }

    const contactId = entrySnap.id
    const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
    const bookingsRef = sessionRef.collection('bookings')
    const waitlistRef = sessionRef.collection(WAITLIST_SUBCOLLECTION)

    // A WAITING entry occupies a place in the queue and nothing else — its
    // departure changes `waitlist_count` and no seat.
    const waitingSnap =
      status === 'waiting'
        ? await tx.get(waitlistRef.where('status', '==', 'waiting').limit(WAITLIST_QUEUE_SCAN_LIMIT))
        : null

    // The session may be GONE — a subcollection outlives its parent document, so
    // the sweep reaches entries left on deleted sessions. `tx.set(…, {merge:true})`
    // on a deleted document CREATES it, which would resurrect a ghost session
    // carrying nothing but a seat count, visible to every list and every sweep.
    const sessionSnap = await tx.get(sessionRef)

    let hold: { remainingSeats: number; contactExists: boolean } | null = null
    let takenUp = false
    if (status === 'offered') {
      const holdSnap = await tx.get(bookingsRef.doc(contactId))
      const booking = holdSnap.data() as SeatHold | undefined
      if (isUnclaimedClaimHold(booking)) {
        const bookingsSnap = await tx.get(bookingsRef)
        const contactSnap = await tx.get(db.collection(CONTACTS_COLLECTION).doc(contactId))
        hold = {
          // The hold is still in this read set — exclude it, because the very
          // next write deletes it.
          remainingSeats: countHoldingSeats(bookingsSnap.docs, nowMs, contactId),
          contactExists: contactSnap.exists,
        }
      } else {
        // Not releasable, and the reason decides what the entry becomes — and
        // what the caller tells the person. THE question is whether they are IN
        // THE CLASS, which is a narrower question than "does this document
        // occupy a seat", so it is asked with `bookingSeatTakenUp` over the
        // document that replaced the hold.
        //
        // Reading a list of settled shapes was too narrow in a way that reached
        // real people. It named 'confirmed'/'paid'/'gift_card' — which covers
        // the full-cover gift-card claim, whose booking carries no
        // `waitlist_claim` at all — but not the offer holder who simply went and
        // BOOKED the class through the public form: on a class with
        // `autoConfirm: false`, `bookSession` full-replaces their claim hold
        // with an ordinary pending booking that keeps the seat and carries no
        // status field at all. They held their seat and were still told their
        // place had not been claimed in time.
        //
        // The bare seat predicate is too WIDE for the same reason, in the other
        // direction: an offer holder who abandoned the claim link and opened an
        // ordinary drop-in checkout instead is sitting on a live UNPAID hold
        // (createDropInCheckout's `.set()` drops `waitlist_claim` when no offer
        // token is passed), and that hold occupies the seat while it lasts
        // without its owner having settled anything. Calling that 'claimed'
        // swallows the "your offer lapsed" mail for somebody who then never
        // pays. A CONFIRMED booking is in the class whatever its payment
        // markers say — see the predicate.
        //
        // Everything else — the booking is gone (expirePendingBookings or an
        // admin got there first), or it was canceled, no-showed or rebooked
        // away — means the seat is already back in the pool and only the entry
        // is left to close out.
        takenUp = bookingSeatTakenUp(booking, nowMs)
      }
    }

    // ── WRITES ───────────────────────────────────────────────────────────────
    tx.update(entryRef, {
      status: takenUp ? 'claimed' : terminalStatus,
      ...(takenUp
        ? { claimed_at: FieldValue.serverTimestamp() }
        : terminalStatus === 'expired'
          ? { expired_at: FieldValue.serverTimestamp() }
          : { left_at: FieldValue.serverTimestamp() }),
      // The claim credential dies with the offer, in every direction it can
      // resolve — including the self-heal, where the claim already happened.
      ...(entry.offer_token ? { offer_token: FieldValue.delete() } : {}),
    })

    if (hold) {
      tx.delete(bookingsRef.doc(contactId))
      if (hold.contactExists) {
        // The promoter incremented this when it minted the offer; the hold it
        // counted is gone, so the counter has to come back or it drifts up by
        // one on every offer nobody takes.
        //
        // Only paired with a delete WE made. When the booking has already gone
        // (expirePendingBookings can reach a lapsed PAID claim first, since that
        // is the only claim shape carrying `payment_status: 'required'`) the
        // counter may be left one high — deliberately, because guessing wrong in
        // the other direction drives a real person's counter negative, which is
        // the failure anyone would actually notice.
        tx.update(db.collection(CONTACTS_COLLECTION).doc(contactId), {
          pending_bookings_count: FieldValue.increment(-1),
        })
      }
    }

    // Only touch the session when a number on it actually moved, and only while
    // it still exists. Absolute values from this transaction's own read set,
    // never increments.
    if ((hold || waitingSnap) && sessionSnap.exists) {
      tx.set(
        sessionRef,
        {
          ...(hold ? { bookings_count: hold.remainingSeats } : {}),
          ...(waitingSnap ? { waitlist_count: Math.max(waitingSnap.size - 1, 0) } : {}),
        },
        { merge: true }
      )
    }

    const outcome: OfferReleaseOutcome = hold
      ? 'released'
      : takenUp
        ? 'self_healed'
        : status === 'waiting'
          ? 'queue_only'
          : 'stale'
    return { outcome, sessionId }
  })
}
