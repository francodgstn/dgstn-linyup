/* eslint-disable no-console */
// THE STUDIO CANCELS AN APPOINTMENT — and, if a Stripe payment link is still
// payable behind it, kills the link on the way out. Gated on `schedule.manage`
// with the rules' own coach own-scope, not on the manager role: see the gate.
//
// ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
//
// `createStaffAppointment`'s payment-link rail emails a Checkout Session that
// stays payable for SEVEN DAYS and deliberately carries no `hold_expires_at`
// (so the daily sweep leaves it alone). Canceling the appointment used to be a
// client-side `updateDoc(session, { status: 'cancelled' })` and nothing else:
// the link stayed live, the client paid it days later, and
// `handleAppointmentCheckout`'s case 3 RE-ACQUIRED the canceled session and
// confirmed the booking. The studio had called the appointment off; the client
// had a paid confirmation for it. Somebody arrives to a locked door.
//
// The other half of that rail — the client pays CASH instead — was closed by
// UX-59 in `markAppointmentPaid`. This is the same obligation on the other
// outcome: whichever way a link-mode hold ends, the link ends with it.
//
// ── THE ORDERING, WHICH IS THE OPPOSITE OF `markAppointmentPaid`'s ─────────
//
// Closing a Checkout Session makes Stripe deliver `checkout.session.expired`,
// which is census site 3 of the appointment-hold release (holdRelease.ts) and
// carries THIS hold's own booking token — so its ownership proof SUCCEEDS and
// it cancels the session and deletes the booking. `markAppointmentPaid` must
// therefore settle FIRST and close SECOND: for a settlement that event is an
// UNDO, and closing first would let a studio's own settlement cancel the
// appointment it was settling.
//
// A CANCELLATION IS NOT A SETTLEMENT, and the hazard points the other way, so
// this callable CLOSES FIRST and cancels second:
//
//   • What the expiry event does — cancel the session, delete the hold's
//     booking — is exactly what this callable is about to write. The two
//     writers COMMUTE: event first, our transaction re-reads an
//     already-canceled session and writes the same end state; transaction
//     first, `releaseAppointmentHold` returns `not_a_live_hold` and the event
//     is inert. Nothing is undone in either order.
//   • The hazard that does NOT commute is the PAYMENT. Cancel first and the
//     window between the cancel write and a successful close is precisely the
//     defect above, merely narrowed to a few hundred milliseconds: the client
//     pays, case 3 re-acquires the canceled slot, and the studio is never
//     told. Closing first means that once Stripe says `closed`, no money can
//     arrive for a slot we are about to cancel.
//
// So: `markAppointmentPaid`'s order is right for `markAppointmentPaid` and
// wrong here. The rule underneath both is the same one — do the irreversible
// half in the order where a racing `checkout.session.expired` cannot destroy
// it.
//
// ── THE THREE OUTCOMES, REPORTED HONESTLY ──────────────────────────────────
//
//   closed → the link can never take money again. The ordinary case, and the
//            cancellation proceeds.
//   paid   → the client paid in the seconds before this call. THE CANCELLATION
//            IS REFUSED: the money has moved, the webhook is confirming that
//            booking, and canceling here would leave a paid-for appointment
//            canceled with nothing said about the money. The manager is told
//            what happened, and the refusal clears itself — once the webhook
//            confirms the session it is no longer `payment_pending`, so a
//            second attempt skips Stripe entirely and cancels a booking the
//            manager now knows is paid (and can refund).
//   failed → Stripe could not tell us, so the link may still be live. The
//            cancellation PROCEEDS (a manager clearing a slot must not be
//            blocked by Stripe being unreachable) and the caller is told, so it
//            can say the link may still be payable. A late payment on such a
//            link still lands in `handleAppointmentCheckout`, which is the net.
//
// ── SCOPE, DELIBERATELY NARROW ─────────────────────────────────────────────
//
//   • Only a `payment_pending` LINK hold has a link to close. A public-checkout
//     hold (`createAppointmentCheckout`) stores no `payment_checkout_session_id`
//     at all, so there is nothing here to close — it carries a 30-minute
//     `hold_expires_at` and its own rollback instead. Storing the id on that
//     rail too would let a manager close a buyer's in-flight checkout; that is
//     a separate call, not this one.
//   • The DELETE path (`SessionDeleteDialog` on a session with no stored link
//     id) is left alone on purpose: a deleted session sends a late payment into
//     `handleAppointmentCheckout`'s case 4, which REFUNDS it rather than
//     re-acquiring anything. No locked door, so no defect there. The dialog
//     still routes through this callable when there IS a link id, because
//     deleting the document would otherwise throw away the only reference that
//     could ever close it.
//   • A CONFIRMED booking under the canceled session is left exactly as the
//     client-side write this replaces left it. Only an unconfirmed hold's
//     booking is deleted, matching `releaseAppointmentHold`.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { SESSIONS_COLLECTION } from '@linyup/shared'
import { loadEnabledTeam } from '../connect/access'
import { callerIsAllScoped, requireCapability } from '../utils/teams'
import { closeTeamCheckoutSession } from '../connect/checkout'
import type { CheckoutSessionCloseOutcome } from '../utils/connect/client'

export const cancelAppointmentSlot = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string; sessionId?: string }
  if (!data?.teamId || !data?.sessionId) {
    throw new HttpsError('invalid-argument', 'teamId and sessionId are required')
  }
  const { teamId, sessionId } = data
  const uid = request.auth.uid

  const db = admin.firestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const sSnap = await sessionRef.get()
  if (!sSnap.exists) throw new HttpsError('not-found', 'Session not found')
  const s = sSnap.data()!
  if (s.teamId !== teamId) throw new HttpsError('permission-denied', 'Team mismatch')
  if (s.activityType !== 'appointment') {
    throw new HttpsError('failed-precondition', 'Not an appointment session')
  }

  // THE SAME GATE THE CLIENT WRITE HAD, moved rather than re-invented.
  // `firestore.rules` lets a holder of `schedule.manage` update a session,
  // own-scoped for a coach (`callerOwnsSession`), and that is what the cancel
  // button in the admin was using. Gating this on `assertManager` — as its
  // siblings `createStaffAppointment` and `markAppointmentPaid` do, since only a
  // manager can create or settle a priced staff booking — would have quietly
  // taken the cancel button away from every coach, which is a permission change
  // decision 16 never asked for.
  await requireCapability(uid, teamId, 'schedule.manage')
  if (!(await callerIsAllScoped(uid, teamId)) && s.providerId !== uid && s.createdBy !== uid) {
    throw new HttpsError('permission-denied', 'You can only cancel your own appointments')
  }

  // Only a hold that is STILL awaiting its payment can have a live link. Once
  // the webhook (or `markAppointmentPaid`) has settled it, the money is already
  // recorded and the stored id names a spent session — asking Stripe about it
  // would answer `paid` and refuse a cancellation that has nothing to do with a
  // link.
  const awaitingPayment = s.status === 'pending_payment' && s.payment_pending === true
  const checkoutSessionId = (s.payment_checkout_session_id as string | null | undefined) ?? null
  const contactId = (s.contact_id as string | null | undefined) ?? null

  // ── 1. Kill the link, BEFORE anything is canceled (see the header). ──
  let linkOutcome: CheckoutSessionCloseOutcome | null = null
  if (awaitingPayment && checkoutSessionId) {
    try {
      // `loadEnabledTeam` throws for a studio whose Connect was switched off
      // since the link went out. Same judgment as `markAppointmentPaid`: that
      // is a `failed` close, not a refusal to cancel — a manager clearing a slot
      // must never be blocked by Stripe being out of reach.
      const team = await loadEnabledTeam(teamId)
      linkOutcome = await closeTeamCheckoutSession(team, checkoutSessionId)
    } catch (err) {
      console.error(
        `[appointments] cancelAppointmentSlot: could not reach Stripe to close the link ` +
          `(session=${sessionId}):`,
        err
      )
      linkOutcome = 'failed'
    }
    if (linkOutcome === 'paid') {
      console.log(
        `[appointments] cancelAppointmentSlot: refused — the client paid the link ` +
          `(session=${sessionId})`
      )
      return { ok: false, cancelled: false, reason: 'paid_in_window' as const, linkStillOpen: false }
    }
  }

  // ── 2. Cancel. ──
  // Both reads before both writes, in one transaction, so a booking cannot be
  // rewritten between the read and the delete. SESSION FIRST, THEN THE BOOKING —
  // the order `releaseAppointmentHold` and `expirePendingBookings` document:
  // deleting the booking first would let `trackBookings` recount against a
  // still-live session. Inside one transaction the order is not observable, but
  // both writes land together for that reason.
  const cancelled = await db.runTransaction(async (tx) => {
    const bookingRef = contactId ? sessionRef.collection('bookings').doc(contactId) : null
    const [freshSession, freshBooking] = await Promise.all([
      tx.get(sessionRef),
      bookingRef ? tx.get(bookingRef) : Promise.resolve(null),
    ])
    // Gone already — `checkout.session.expired` may have released it in the
    // moment between the close above and here, or a manager deleted it.
    if (!freshSession.exists) return false
    if (freshSession.data()!.teamId !== teamId) return false

    tx.set(
      sessionRef,
      {
        status: 'cancelled',
        allowBooking: false,
        cancelled_at: FieldValue.serverTimestamp(),
        hold_expires_at: FieldValue.delete(),
        payment_pending: FieldValue.delete(),
        payment_intent_mode: FieldValue.delete(),
        payment_checkout_session_id: FieldValue.delete(),
      },
      { merge: true }
    )
    // The hold's own booking goes with it — same shape as
    // `releaseAppointmentHold`. A CONFIRMED booking is left standing: it is the
    // record of somebody who was booked in, and the client-side write this
    // callable replaces never touched it either. An unconfirmed appointment hold
    // is uncounted in `pending_bookings_count` for its whole life
    // (`replacedBookingWasCounted`), so deleting it moves no counter.
    if (bookingRef && freshBooking?.exists && freshBooking.data()?.status !== 'confirmed') {
      tx.delete(bookingRef)
    }
    return true
  })

  console.log(
    `[appointments] cancelAppointmentSlot: session=${sessionId} canceled=${cancelled} ` +
      `link=${linkOutcome ?? 'none'}`
  )
  // `linkStillOpen` is the honest half of a three-valued close: the studio is
  // told when the link it emailed may still take money, so it can expire it in
  // its own Stripe dashboard.
  return { ok: true, cancelled, linkStillOpen: linkOutcome === 'failed' }
})
