// The stale-full self-heal — re-derive a session's seat count from the bookings
// themselves and PERSIST the answer.
//
// Why it has to exist. Expiry is lazy: an abandoned drop-in hold stops occupying
// its seat the instant `bookingHoldsSeat` reads it, but the stored
// `bookings_count` still counts it, and nothing rewrites that number until the
// next booking WRITE fires trackBookings' recount — which is exactly the write a
// full-looking class refuses to accept. So a hold abandoned at 14:00 leaves the
// class advertised full, on the public mirror, until the 02:00 sweep deletes it.
// A genuinely free seat that nobody can reach.
//
// Why it is a transaction, and the only shape allowed. `bookings_count` has ONE
// writing style: an absolute value derived from a read set taken inside the same
// transaction that writes it (see Session.bookings_count). Re-deriving outside a
// transaction and writing the result is the lost-update shape this phase retired
// — a concurrent booking's own absolute write would be clobbered by a number
// computed before it existed.
//
// It writes NOTHING when nothing moved. That matters beyond cost: a session
// write re-enters `promoteWaitlistOnSeatFreed`, and a "harmless" touch on a
// no-op path is how a trigger loops. When it DOES heal a stale-full class it
// produces the seat-freed edge on purpose — the queue is the rightful owner of a
// seat that just came back.

import * as admin from 'firebase-admin'
import { SESSIONS_COLLECTION, countHoldingSeats } from '@linyup/shared'

export interface HealedSeatCount {
  /** False when the session document is gone — the caller decides what that
   *  means; nothing was read or written. */
  exists: boolean
  /** Live seats occupied, counting every booking. This is the number that was
   *  persisted (if anything was). */
  holding: number
  /** Live seats occupied EXCLUDING the caller's own booking — the number a
   *  capacity gate tests, since the caller's document is the one it is about to
   *  replace. Equals `holding` when no `excludeId` was given. */
  holdingExcludingCaller: number
  /** The session's own cap, re-read rather than trusted from the caller. */
  maxParticipants?: number
  /** True when the stored count or status actually disagreed and was corrected. */
  healed: boolean
}

/**
 * Recount one session's seats and correct `bookings_count` / `status` if they
 * drifted. Returns the live numbers so the caller can make its decision from the
 * same read set that was just persisted.
 *
 * Call it on the path that was about to say "full" — that is the only path where
 * a stale count does damage, and it keeps the cost off every other request.
 */
export async function healSessionSeatCount(
  sessionId: string,
  excludeId?: string
): Promise<HealedSeatCount> {
  const db = admin.firestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)

  return db.runTransaction<HealedSeatCount>(async (tx) => {
    const sessionSnap = await tx.get(sessionRef)
    if (!sessionSnap.exists) {
      return { exists: false, holding: 0, holdingExcludingCaller: 0, healed: false }
    }
    const session = sessionSnap.data()!
    const bookingsSnap = await tx.get(sessionRef.collection('bookings'))

    // ONE instant for the whole pass, exactly as countHoldingSeats requires:
    // the number refused on and the number persisted have to be the same number.
    const nowMs = Date.now()
    const holding = countHoldingSeats(bookingsSnap.docs, nowMs)
    const holdingExcludingCaller = excludeId
      ? countHoldingSeats(bookingsSnap.docs, nowMs, excludeId)
      : holding
    const maxParticipants = session.max_participants as number | undefined
    const status = session.status as string | undefined
    const base: HealedSeatCount = {
      exists: true,
      holding,
      holdingExcludingCaller,
      maxParticipants,
      healed: false,
    }

    // A paid-appointment hold owns its own lifecycle (createAppointmentCheckout,
    // the Connect webhook, the daily sweep) and a canceled session has no seats
    // to account for. trackBookings skips both for the same reason; re-deriving
    // either would clobber a status only its owner may write.
    if (status === 'pending_payment' || status === 'cancelled') return base

    // Same derivation trackBookings' recount uses, so the two writers of this
    // pair can never leave a session in a state the other would not have.
    const nextStatus = maxParticipants && holding >= maxParticipants ? 'full' : 'open'
    // Absent reads as its default on BOTH fields (see Session.status), or a
    // session that never carried them would be "corrected" on every pass — a
    // write with nothing behind it, which is the one thing a handler on the
    // seat-freed edge must not produce.
    const storedCount = (session.bookings_count as number | undefined) ?? 0
    if (storedCount === holding && (status ?? 'open') === nextStatus) return base

    tx.set(sessionRef, { bookings_count: holding, status: nextStatus }, { merge: true })
    return { ...base, healed: true }
  })
}
