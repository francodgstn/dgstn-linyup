import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appointmentChargeIsDuplicate } from '@linyup/shared'

// THE DESK SETTLEMENT OF AN APPOINTMENT THAT WAS AWAITING AN ONLINE PAYMENT
// (UX-59) — the pure predicate that stops it being paid for twice, plus source
// assertions on the two orderings the rest of it rests on.
//
// The defect: `createStaffAppointment` can email a Stripe payment link that
// stays payable for seven days, on the ONE appointment rail that deliberately
// carries no `hold_expires_at` and is therefore unreachable by
// `expirePendingBookings`. The client pays cash at the door, nobody uses the
// link, and until this change `markAppointmentPaid` refused the mode by name.
// The only thing that could ever close the booking was Stripe's own expiry,
// which CANCELS the session and DELETES the booking — so the studio's
// appointment vanished a week later and the cash was never recorded anywhere.
//
// Settling it in cash creates a new obligation: kill the link. That is done at
// Stripe (`closeTeamCheckoutSession`), and the predicate below is the net under
// a close that could not be proved — a late online payment for a seat already
// paid for at the desk is refunded rather than kept.

describe('appointmentChargeIsDuplicate', () => {
  it('a redelivery of the SAME charge is not a duplicate', () => {
    assert.equal(
      appointmentChargeIsDuplicate({
        payment_intent_id: 'pi_1',
        incomingPaymentIntentId: 'pi_1',
      }),
      false
    )
  })

  it('a DIFFERENT charge on a booking that already names one is a duplicate', () => {
    assert.equal(
      appointmentChargeIsDuplicate({
        payment_intent_id: 'pi_1',
        incomingPaymentIntentId: 'pi_2',
      }),
      true
    )
  })

  it('a charge arriving on a DESK-SETTLED booking is a duplicate, though there is no id to compare', () => {
    // The whole point: `markAppointmentPaid` records cash, so the booking is
    // confirmed and paid for but carries no PaymentIntent. Without this arm the
    // client who later opens the emailed link pays for the appointment twice.
    assert.equal(
      appointmentChargeIsDuplicate({
        payment_intent_id: null,
        settled_offline: true,
        incomingPaymentIntentId: 'pi_late',
      }),
      true
    )
  })

  it('a confirmed booking that was never settled offline is NOT a duplicate — that charge is its first', () => {
    // `createStaffAppointment`'s free and `pending_offline` rails both write a
    // confirmed booking with no payment marker. Treating those as duplicates
    // would refund the first payment they ever received.
    assert.equal(
      appointmentChargeIsDuplicate({
        payment_intent_id: null,
        settled_offline: false,
        incomingPaymentIntentId: 'pi_1',
      }),
      false
    )
    assert.equal(
      appointmentChargeIsDuplicate({ incomingPaymentIntentId: 'pi_1' }),
      false
    )
  })

  it('no incoming payment is never a duplicate', () => {
    assert.equal(
      appointmentChargeIsDuplicate({
        payment_intent_id: 'pi_1',
        settled_offline: true,
        incomingPaymentIntentId: null,
      }),
      false
    )
  })
})

// ─── Source assertions ───────────────────────────────────────────────────────
// Same technique and same reasoning as connect/dahliaReads.test.ts and
// connect/commitSites.test.ts: the properties below are about ORDER inside two
// handlers that take the Admin SDK, a live Stripe client and firebase-functions,
// and reversing either is invisible to every behavioral test in this package.

const SRC = join(__dirname, '..')

/** LF-normalized: CRLF on Windows, LF on CI, and these patterns span lines. */
function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

describe('markAppointmentPaid — the orderings that make the link rail safe', () => {
  const src = read('appointments/staffBooking.ts')
  const markPaid = src.slice(src.indexOf('export const markAppointmentPaid'))

  it('settles BEFORE it closes the Stripe session', () => {
    // Expiring a session makes Stripe deliver `checkout.session.expired`, which
    // is census site 3 of the appointment-hold release (holdRelease.ts) and
    // holds this hold's booking token — so its ownership proof SUCCEEDS and it
    // would cancel the very appointment being settled. Moving the session off
    // `pending_payment` first makes that event inert (`not_a_live_hold`).
    const settleAt = markPaid.indexOf('db.runTransaction')
    const closeAt = markPaid.indexOf('closeTeamCheckoutSession')
    assert.ok(settleAt > 0, 'the settle transaction is gone')
    assert.ok(closeAt > 0, 'the Stripe close is gone')
    assert.ok(
      settleAt < closeAt,
      'markAppointmentPaid must settle before it closes the Checkout Session — closing first ' +
        'lets checkout.session.expired cancel the appointment being settled'
    )
  })

  it('records no cash when the close reports the link was already PAID', () => {
    const paidBranch = markPaid.indexOf("linkOutcome === 'paid'")
    const writeAt = markPaid.indexOf('writeManualPaymentEvent')
    assert.ok(paidBranch > 0, "the 'paid' close outcome is no longer handled")
    assert.ok(
      paidBranch < writeAt,
      'the already-paid-online branch must return before writeManualPaymentEvent — a cash row ' +
        "on top of Stripe's own row doubles the studio's revenue for one appointment"
    )
  })

  it('stamps settled_offline on the booking, which is what the duplicate guard reads', () => {
    assert.match(markPaid, /settled_offline: true/)
  })

  it('retracts settled_offline when the link turns out to have been paid', () => {
    // The marker is what makes the webhook refund an incoming charge. Left
    // standing on this branch it would refund the payment the client just made.
    const paidBranch = markPaid.slice(markPaid.indexOf("linkOutcome === 'paid'"))
    assert.match(paidBranch.slice(0, 900), /settled_offline: FieldValue\.delete\(\)/)
  })

  it('accepts BOTH awaiting-payment modes', () => {
    // The refusal this finding was made of: `payment_intent_mode !== 'offline'`.
    assert.doesNotMatch(markPaid, /payment_intent_mode !== 'offline'/)
    assert.match(markPaid, /intentMode !== 'offline' && intentMode !== 'link'/)
  })
})

describe('createStaffAppointment — the payment link is closable', () => {
  const src = read('appointments/staffBooking.ts')

  it('stores the Checkout Session id, outside the catch that releases the hold', () => {
    // By the time the id exists, Stripe has a live payable session. A Firestore
    // failure here must not fall into a catch whose job is to give the slot back
    // and report that the link could not be created.
    const createBlockEnd = src.indexOf("throw new HttpsError('internal', 'Failed to create the payment link')")
    const storeAt = src.indexOf('payment_checkout_session_id: checkoutSessionId')
    assert.ok(createBlockEnd > 0 && storeAt > 0)
    assert.ok(
      storeAt > createBlockEnd,
      'the checkout session id must be stored outside the payment-link catch block'
    )
  })
})
