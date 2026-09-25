/* eslint-disable no-console */
// THE APPOINTMENT HOLD RELEASE — one ownership rule, one executor, one census.
//
// An appointment hold is a `sessions/{apt_<providerId>_<startMs>}` document with
// `status: 'pending_payment'` plus its paired booking subdocument. THE HOLD IS
// THE SESSION: nothing exists on the calendar until somebody books, so releasing
// a hold means CANCELING a session and DELETING a booking.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// The session's doc id is DETERMINISTIC and therefore SHARED by every attempt at
// that slot — which is exactly what lets `runAppointmentSlotTransaction` refuse a
// second visitor. The cost is that "cancel the session at this id and delete the
// booking under it" is an operation any attempt can perform on any other's live,
// payable hold. Presence is not ownership.
//
// This was fixed three times, once per site, from three different files, and the
// third site was missed twice. So the rule is now written ONCE, as a pure
// predicate plus the ONE transaction that applies it, and the sites that
// legitimately diverge are enumerated below rather than left to be rediscovered.
//
// ── THE CENSUS: EVERY SITE THAT CAN RELEASE, CANCEL OR DELETE A HOLD ────────
//
// Complete as of Wave 3 Phase 3. Re-derive it with, in packages/functions/src:
//   grep -rn "releaseAppointmentHold(" .        ← every site routed through here
//   grep -rn "status: 'cancelled'" .            ← every session-cancel writer
//   grep -rn "collection('bookings')" .         ← every booking deleter
// The FIRST grep is the one that used to be missing, and its absence made the
// recipe find only the sites that DIVERGE from this file and none of the ones
// this file exists for. The other two find whoever writes those documents by
// hand and therefore has to justify itself below; a site in none of the three
// cannot touch a hold.
//
//  1. `createAppointmentCheckout`'s rollback (appointments/checkout.ts) — a
//     failure between the slot transaction and the returned URL.
//         PROOF: booking_token. Uses releaseAppointmentHold.
//  2. `createStaffAppointment`'s payment-link catch (appointments/staffBooking.ts)
//     — the Stripe payment-link create failed after the hold was written.
//         PROOF: booking_token, falling back to EXCLUSIVITY when there is no
//         stored token to compare it against. Uses releaseAppointmentHold.
//         (Until Phase 3 this canceled on PRESENCE, with a comment claiming it
//         followed site 1. It now actually does.)
//         THIS RAIL HAS NO DEADLINE. It deliberately writes no
//         `hold_expires_at`, so the daily sweep (4) can never reach it and
//         site 3 is its only other release path. A refusal here therefore
//         strands the provider's slot FOREVER rather than until a deadline —
//         which is why the predicate below must never refuse a token-holder it
//         would have released without the token.
//  3. `handleCheckoutExpired` (connect/webhook.ts) — `checkout.session.expired`,
//     the prompt release at the Stripe-side expiry.
//         PROOF: booking_token, carried in the Checkout Session metadata.
//         Uses releaseAppointmentHold.
//         THIS IS THE SITE PHASE 3 MADE DANGEROUS. A promo refresh EXPIRES the
//         superseded Checkout Session at Stripe before writing anything
//         (`reservePromoRedemption`'s pre-flight close), so the expiry event for
//         a superseded sibling now arrives SECONDS after the buyer's retry
//         instead of ~31 minutes later. On presence alone it canceled the hold
//         the retry's live, payable session was guarding: the buyer pays for an
//         appointment that has been canceled out from under them.
//  4. `expirePendingBookings` (dailyTasks/) — the daily sweep.
//         PROOF: THE DEADLINE. It addresses holds by
//         `status == 'pending_payment' AND hold_expires_at <= now`, and a lapsed
//         hold belongs to nobody: `runAppointmentSlotTransaction` REPLACES the
//         whole session document, so any attempt that took this hold over wrote
//         the deadline that is now on it. A deadline in the past is therefore
//         proof that no live attempt holds it. Deliberately NOT routed through
//         this file — it is a batched query sweep, and a per-document
//         transaction would be a different shape for no gain.
//  5. `runAppointmentSlotTransaction`'s stale-booking reclaim
//     (appointments/booking.ts) — deletes the PREVIOUS holder's `payment_status:
//     'required'` booking when it reuses the doc id.
//         PROOF: THE DEADLINE, same as 4 — it only reclaims when the session is
//         `cancelled` or its hold has lapsed. (`ownsLiveHold` reuse, the retry
//         path, keeps the booking and rewrites it.) Not routed through this file
//         either: it is a REUSE inside somebody else's transaction, not a
//         release.
//  6. `cancelBooking` (booking/index.ts) — the customer's or manager's explicit
//     cancellation.
//         PROOF: THE TOKEN, structurally — the callable's input IS the
//         `booking_token` and it finds the booking by querying for it, so it
//         cannot address a document it does not own. Same proof as 1–3, arrived
//         at from the other end.
//  7. `cancelSession` (sessions/index.ts) — the manager deleting or canceling a
//     whole session, holds included.
//         DELIBERATE EXEMPTION, the twin of `releasePromoReservations` on the
//         promo side: a manager clearing a slot is precisely the operation no
//         attempt owns.
//         AND THE EXEMPTION IS WIDER THAN THIS CALLABLE. `firestore.rules` lets
//         any holder of the team's `schedule.manage` capability update
//         `sessions/{id}` and write or delete `sessions/{id}/bookings/{id}`
//         DIRECTLY from the client — which the admin session and booking UIs
//         do. So "a manager may clear a slot out from under an attempt" is a
//         RULES-level fact, not a property of any code path enumerated here,
//         and nothing in this file can bind it. Anything that ever has to be
//         enforced rather than documented has to move into those rules or
//         behind a callable first.
//  8. `cancelAppointmentSlot` (appointments/cancelSlot.ts) — the manager
//     canceling ONE appointment from the admin, which is the client-side
//     `updateDoc(status: 'cancelled')` above moved behind a callable so the
//     Stripe payment link behind a link-mode hold can be closed with it.
//         SAME DELIBERATE EXEMPTION AS 7, for the same reason: the manager's
//         cancellation is the operation no attempt owns. It cancels the session
//         and deletes the hold's booking (a CONFIRMED booking is left standing)
//         without presenting a token.
//         IT CLOSES THE CHECKOUT SESSION *BEFORE* IT CANCELS — the reverse of
//         `markAppointmentPaid` below, and deliberately so. The argument for the
//         reversal lives in that file's header; do not copy either order across
//         without re-deriving it, because the two are right for opposite
//         reasons.
//
// Sites 1–3 are the ones that address a hold BY ITS SHARED ADDRESS while another
// attempt may own it. They are the ones this file exists for, and they are now
// one call each.
//
// ── NOT A RELEASE, though the recipe's third grep finds it ─────────────────
//
// `markAppointmentPaid` (appointments/staffBooking.ts) writes the session and
// the booking of a hold it did not create. It is not on the census because it
// SETTLES rather than releases: the session goes to 'full' and the booking to
// 'confirmed', so the slot is kept, not given back, and no other attempt is
// deprived of anything. It has an ownership question of its own — a manager may
// be settling a hold the client is paying for online at that moment — and it
// answers it the way this file would: re-read inside the transaction, refuse
// unless the session is still `pending_payment`, then close the Stripe session
// and refuse to record cash if the close reports the money already moved.
//
// It also DEPENDS on this file's ordering, which is why it is named here at all.
// Closing a Checkout Session makes Stripe deliver `checkout.session.expired`,
// which is site 3 — carrying this hold's own booking token, so its proof
// SUCCEEDS. The settlement therefore writes BEFORE it closes: past that write
// `releaseAppointmentHold` returns `not_a_live_hold` and the event is inert.
// Reverse the two and a studio's own settlement cancels the appointment it was
// settling.
//
// ── THE PROOF LADDER ────────────────────────────────────────────────────────
//
// The primary proof is `booking_token`: minted fresh per attempt and rewritten by
// every `runAppointmentSlotTransaction` that reuses the document. Two secondary
// proofs are named below, and naming them is what stops the next reader from
// quietly falling back to presence. They carry every caller that cannot present
// the primary one — a Checkout Session created before the metadata carried the
// token — and every caller whose token has nothing to be compared against:
//
//   • THE DEADLINE — a hold past its own `hold_expires_at` is owned by nobody,
//     because every takeover REPLACES the session document and therefore wrote
//     the deadline now on it.
//   • EXCLUSIVITY — a hold that STILL PRESENTS NO `hold_expires_at` has exactly
//     one owner. This is the staff payment-link rail, which deliberately writes
//     no deadline so the daily sweep leaves its 7-day link alone. Once the link
//     is out, `checkout.session.expired` is the only thing that can give the
//     slot back — its own catch (site 2) fires only when the Stripe create
//     failed — so this proof refusing is not "over-hold until the deadline",
//     there being none. It is "never".
//
//     The argument is about the CURRENT document, not about the rail, and the
//     difference matters: a deadline-less hold is NOT unreachable.
//     `runAppointmentSlotTransaction` reuses a session that is canceled, whose
//     hold has lapsed, or whose own holder is retrying (`allowRewriteByHolder`)
//     — and the third of those DOES fire here, because the same client booking
//     the same slot through the public checkout rewrites the staff hold in place.
//     What makes the proof sound is that every one of those outcomes changes the
//     shape this predicate reads: a public rewrite installs a `hold_expires_at`
//     (so the DEADLINE branch decides it, and a live deadline refuses), and a
//     confirm or a cancel moves `status` off `pending_payment` (so
//     `releaseAppointmentHold` returns before the predicate at all). A document
//     that reaches this branch still deadline-less has not changed hands.
//
// THE TOKEN TAKES PRECEDENCE; IT DOES NOT EXCLUDE. Where there IS a stored token
// to compare against, the token decides outright — a match releases, a mismatch
// refuses and never falls through to a weaker proof, because that fall-through is
// exactly how a losing sibling gets a second chance to cancel the winner. Where
// there is NOTHING to compare (the booking is gone, or carries no token), a
// token-holder is judged on precisely the proofs a caller with no token gets:
// presenting the right token must never leave a caller worse off than presenting
// none. It did, for one release: a token-holder meeting a missing booking was
// refused outright, which on the deadline-less staff payment-link rail (site 2)
// means the slot is never given back at all.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

/** How a release was justified — `null` when it was refused. Returned rather
 *  than inferred so the log line can say WHICH proof carried it. */
export type AppointmentHoldProof = 'token' | 'deadline' | 'exclusive'

export interface AppointmentHoldReleaseInput {
  /** The token THIS attempt wrote onto the booking document. `null` when the
   *  caller cannot present one — a Checkout Session created before the metadata
   *  carried it. */
  bookingToken?: string | null
  /** The token on the booking document right now; `null` when it is gone. */
  storedToken?: string | null
  bookingExists: boolean
  /** The session's own hold deadline, in ms. `null` when the rail deliberately
   *  writes none (staff payment links). */
  holdExpiresAtMs?: number | null
  nowMs: number
}

/**
 * THE HOLD-RELEASE OWNERSHIP RULE, pure — the exact analogue of
 * `decidePromoRelease`, and deliberately the same shape.
 *
 * TWO ROLLBACKS, ONE OWNERSHIP RULE. Both of the appointment rail's rollbacks
 * address a DETERMINISTIC, SHARED id — the promo entry at `reservationKey`, the
 * session at `apt_{providerId}_{startMs}` — so in both cases "delete what is at
 * this address" is an operation any sibling attempt can perform on any other.
 * Neither may act on presence; each must prove the thing at that address is still
 * the one IT wrote. The promo proves it with `instanceId`; the hold proves it
 * with `booking_token`.
 *
 * The caller this exists for is a LOSING SIBLING BY THE SAME CONTACT.
 * `allowRewriteByHolder: contactId` lets one contact's second attempt rewrite its
 * own still-live hold — that is the retry path, and it is correct. But it means:
 *
 *   attempt A takes the hold (booking_token T_A) → Stripe session A
 *   attempt B rewrites the same hold (booking_token T_B) → Stripe session B
 *   attempt A now fails, or session A expires → and, without this check, cancels
 *   the session and deletes the booking that B's live, payable session guards.
 *
 * The buyer then pays for an appointment that has been canceled out from under
 * them. The race pre-dates Phase 3, but Phase 3 is what made it LIKELY rather
 * than rare, twice over: the promo lifecycle refuses losing attempts on purpose
 * (`promo_busy` from the compare-and-set, and from a bind whose slot moved on),
 * and a promo refresh expires the superseded Checkout Session at Stripe, so the
 * expiry event for the older attempt lands seconds after the retry.
 *
 * A MISSING BOOKING IS NOT A REFUSAL — it is an ABSENCE OF EVIDENCE, and the
 * caller falls to exactly the secondary proofs a caller with no token gets. The
 * winner may already have confirmed and rewritten it, so over-holding until the
 * DOCUMENT's own proof says otherwise is the safe direction — its deadline on
 * the public rail, its exclusivity on the staff rail.
 *
 * Refusing outright instead reads like the safe direction and is not. It made
 * the right token strictly WORSE than no token, and on the staff payment-link
 * rail (census site 2: no `hold_expires_at`, unreachable by the daily sweep,
 * `checkout.session.expired` its only other release path) "refuse" is not
 * "over-hold until the deadline" but "strand the provider's slot forever".
 */
export function decideAppointmentHoldRelease(
  input: AppointmentHoldReleaseInput
): { release: boolean; proof: AppointmentHoldProof | null } {
  // A booking that is HERE and carries a token settles the question outright:
  // match → release, mismatch → refuse, and no fall-through. This is the one
  // branch that must not fall through — a mismatch means a newer attempt owns
  // the hold, and the weaker proofs would hand the loser a second chance at it.
  if (input.bookingToken && input.bookingExists && input.storedToken) {
    return input.storedToken === input.bookingToken
      ? { release: true, proof: 'token' }
      : { release: false, proof: null }
  }
  // Nothing to compare a token against — no token was presented, or the booking
  // is gone / carries none. The two named secondary proofs decide it, the same
  // way for a token-holder as for a caller without one.
  if (input.holdExpiresAtMs == null) return { release: true, proof: 'exclusive' }
  return input.holdExpiresAtMs <= input.nowMs
    ? { release: true, proof: 'deadline' }
    : { release: false, proof: null }
}

export type AppointmentHoldReleaseOutcome =
  | 'released'
  /** The session is gone, already canceled, or already confirmed — nothing to
   *  release. */
  | 'not_a_live_hold'
  /** The booking is confirmed: somebody paid. Never cancel a paid appointment. */
  | 'confirmed'
  /** A newer attempt owns the hold, or this caller cannot prove it owns it. */
  | 'not_ours'

/**
 * THE ONE way sites 1–3 of the census give a hold back.
 *
 * Both reads and both writes happen inside ONE transaction, so a sibling cannot
 * rewrite the booking between the ownership check and the delete. Idempotent and
 * safe to call from any failure path: every refusal is a no-op.
 *
 * SESSION FIRST, THEN THE BOOKING — the same order `expirePendingBookings`
 * documents: deleting the booking first would let its own `trackBookings` recount
 * see a still-`pending_payment` session and recompute it to 'open', resurrecting
 * a slot nobody can book. Inside one transaction the order is not observable, but
 * both writes land together for exactly that reason.
 */
export async function releaseAppointmentHold(params: {
  teamId: string
  sessionId: string
  /** The booking subdoc id — the contactId on every rail that takes a hold. */
  contactId: string
  /** This attempt's proof of ownership; `null` only when the caller genuinely
   *  has none (see the proof ladder in the module header). */
  bookingToken: string | null
  /** Prefixes the log line, e.g. 'createAppointmentCheckout'. */
  label: string
}): Promise<AppointmentHoldReleaseOutcome> {
  const db = admin.firestore()
  const sessionRef = db.collection('sessions').doc(params.sessionId)
  const bookingRef = sessionRef.collection('bookings').doc(params.contactId)

  const outcome = await db.runTransaction<AppointmentHoldReleaseOutcome>(async (tx) => {
    const [sSnap, bSnap] = await Promise.all([tx.get(sessionRef), tx.get(bookingRef)])
    if (!sSnap.exists) return 'not_a_live_hold'
    const s = sSnap.data()!
    // Belt and braces: the session id reaches site 3 through Checkout Session
    // metadata, so it is worth one field comparison never to cancel another
    // tenant's slot.
    if (s.teamId !== params.teamId) return 'not_a_live_hold'
    // Already confirmed, already canceled, or re-acquired as 'full' — there is
    // no live hold at this address to give back.
    if (s.status !== 'pending_payment') return 'not_a_live_hold'
    if (bSnap.exists && bSnap.data()?.status === 'confirmed') return 'confirmed'

    const holdExpiresAt = s.hold_expires_at as { toMillis(): number } | null | undefined
    const decision = decideAppointmentHoldRelease({
      bookingToken: params.bookingToken,
      storedToken: bSnap.exists ? ((bSnap.data()?.booking_token as string | undefined) ?? null) : null,
      bookingExists: bSnap.exists,
      holdExpiresAtMs: holdExpiresAt ? holdExpiresAt.toMillis() : null,
      nowMs: Date.now(),
    })
    if (!decision.release) return 'not_ours'

    tx.set(sessionRef, { status: 'cancelled', hold_expires_at: FieldValue.delete() }, { merge: true })
    if (bSnap.exists) tx.delete(bookingRef)
    console.log(
      `[appointments] ${params.label}: hold released by ${decision.proof} proof ` +
        `(session=${params.sessionId} contact=${params.contactId})`
    )
    return 'released'
  })

  if (outcome === 'not_ours') {
    console.warn(
      `[appointments] ${params.label}: hold release skipped — a newer attempt owns this hold ` +
        `(session=${params.sessionId} contact=${params.contactId})`
    )
  }
  return outcome
}
