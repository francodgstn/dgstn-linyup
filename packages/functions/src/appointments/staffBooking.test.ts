import assert from 'node:assert/strict'
import { HttpsError } from 'firebase-functions/v2/https'
import { PAYMENT_LINK_EXPIRY_SECONDS, resolveStaffBookingPlan } from './staffBooking'
import { STRIPE_MAX_CHECKOUT_EXPIRY_MINUTES } from '../connect/checkout'

// Unit tests for the staff "phone booking" settlement-rail decision — pure,
// no Firestore. See createStaffAppointment's module doc comment for the four
// rails (free, paid_offline, pending_offline, payment_link) plus blocked time.

describe('resolveStaffBookingPlan', () => {
  it('blocked time is always a confirmed hold with no payment, regardless of amount/mode', () => {
    const plan = resolveStaffBookingPlan({ blocked: true, amountMinor: 8500, paymentMode: 'payment_link' })
    assert.deepEqual(plan, {
      sessionStatus: 'full',
      paymentPending: false,
      bookingStatus: 'confirmed',
      recordPaymentNow: false,
    })
  })

  it('a free/unpriced booking (amountMinor 0) is confirmed with no payment, regardless of mode', () => {
    const plan = resolveStaffBookingPlan({ blocked: false, amountMinor: 0, paymentMode: 'paid_offline' })
    assert.deepEqual(plan, {
      sessionStatus: 'full',
      paymentPending: false,
      bookingStatus: 'confirmed',
      recordPaymentNow: false,
    })
  })

  it("paid_offline: full session, confirmed booking, and records the payment immediately", () => {
    const plan = resolveStaffBookingPlan({ blocked: false, amountMinor: 8500, paymentMode: 'paid_offline' })
    assert.deepEqual(plan, {
      sessionStatus: 'full',
      paymentPending: false,
      bookingStatus: 'confirmed',
      recordPaymentNow: true,
    })
  })

  it("pending_offline: the client IS booked (confirmed) but the session carries a payment_pending offline hold", () => {
    const plan = resolveStaffBookingPlan({ blocked: false, amountMinor: 8500, paymentMode: 'pending_offline' })
    assert.deepEqual(plan, {
      sessionStatus: 'pending_payment',
      paymentPending: true,
      paymentIntentMode: 'offline',
      bookingStatus: 'confirmed',
      recordPaymentNow: false,
    })
  })

  it("payment_link: mirrors the public checkout hold — pending session AND pending booking, awaiting Stripe", () => {
    const plan = resolveStaffBookingPlan({ blocked: false, amountMinor: 8500, paymentMode: 'payment_link' })
    assert.deepEqual(plan, {
      sessionStatus: 'pending_payment',
      paymentPending: true,
      paymentIntentMode: 'link',
      bookingStatus: 'pending',
      bookingPaymentStatus: 'required',
      recordPaymentNow: false,
    })
  })

  it('a priced, non-blocked booking with no/invalid paymentMode throws invalid-argument', () => {
    assert.throws(
      () => resolveStaffBookingPlan({ blocked: false, amountMinor: 8500 }),
      (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
    )
    assert.throws(
      () =>
        resolveStaffBookingPlan({
          blocked: false,
          amountMinor: 8500,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          paymentMode: 'bogus' as any,
        }),
      (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
    )
  })
})

describe('the staff payment link expiry', () => {
  // Stripe refuses a Checkout Session whose expires_at is 24 hours or more
  // away. This was a week, and every "Send payment link" failed with "Failed to
  // create the payment link" (found by the payments e2e run, 2026-09-25).
  it('stays strictly inside the 24-hour limit Stripe sets', () => {
    assert.ok(PAYMENT_LINK_EXPIRY_SECONDS < STRIPE_MAX_CHECKOUT_EXPIRY_MINUTES * 60)
  })

  it('still gives the client most of a day to pay', () => {
    assert.ok(PAYMENT_LINK_EXPIRY_SECONDS >= 23 * 60 * 60)
  })
})
