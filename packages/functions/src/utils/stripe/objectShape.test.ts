import assert from 'node:assert/strict'
import Stripe from 'stripe'
import payloads from './dahlia-payloads.json'
import {
  STRIPE_VERIFIED_API_VERSION,
  STRIPE_WIRE_API_VERSION,
  invoiceBillsSubscription,
  readChargeBillingEmail,
  readChargeReceiptUrl,
  readInvoicePaymentIntentId,
  readInvoiceSubscriptionId,
  readInvoiceSubscriptionMetadata,
  readPaymentIntentEmail,
  readSubscriptionCancellation,
  readSubscriptionPeriod,
} from './objectShape'

// Fixtures for the Basil→Dahlia field migration (see objectShape.ts).
//
// The MODERN halves are REAL captured Stripe objects, not hand-written shapes —
// see `_provenance` in dahlia-payloads.json. That matters: a hand-built object
// encodes the same assumption the broken code did, and would have passed against
// the bug. Every one of these assertions FAILS against the pre-migration reads.
//
// The LEGACY halves below are hand-written on purpose — a 2024-vintage payload
// cannot be captured from a Dahlia account — and are marked as such.

const p = payloads as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Stripe wire version', () => {
  it('is the version these readers and fixtures were verified against', () => {
    // The runtime half of the compile-time tripwire in objectShape.ts. If this
    // fails, `pnpm update stripe` moved the wire version: re-capture the
    // fixtures, re-check every reader, then bump STRIPE_VERIFIED_API_VERSION.
    assert.equal(STRIPE_WIRE_API_VERSION, STRIPE_VERIFIED_API_VERSION)
    assert.equal(Stripe.API_VERSION, STRIPE_VERIFIED_API_VERSION)
  })

  it('is the version the captured fixtures were delivered at', () => {
    assert.equal(p._provenance.api_version, STRIPE_VERIFIED_API_VERSION)
  })
})

describe('readSubscriptionPeriod', () => {
  it('reads the period off the ITEM on a delivered customer.subscription.updated', () => {
    const sub = p.subscription_updated_event_object
    // The premise of the defect: the top-level field is simply not there.
    assert.equal('current_period_end' in sub, false)
    const period = readSubscriptionPeriod(sub)
    assert.equal(period.source, 'modern')
    assert.equal(period.end, sub.items.data[0].current_period_end)
    assert.equal(period.start, sub.items.data[0].current_period_start)
    assert.ok(period.end && period.end > 0)
  })

  it('reads it off a retrieved subscription too', () => {
    const period = readSubscriptionPeriod(p.subscription_retrieved)
    assert.equal(period.source, 'modern')
    assert.equal(period.end, 1789487599)
  })

  it('falls back to the pre-Basil top-level field (hand-written legacy shape)', () => {
    const period = readSubscriptionPeriod({
      id: 'sub_legacy',
      items: { data: [{ id: 'si_1', price: { id: 'price_1' } }] },
      current_period_start: 1700000000,
      current_period_end: 1702592000,
    })
    assert.equal(period.source, 'legacy')
    assert.equal(period.start, 1700000000)
    assert.equal(period.end, 1702592000)
  })

  it('takes start and end from the SAME item — the one ending soonest', () => {
    const period = readSubscriptionPeriod({
      items: {
        data: [
          { current_period_start: 100, current_period_end: 900 },
          { current_period_start: 200, current_period_end: 400 },
        ],
      },
    })
    assert.equal(period.end, 400)
    assert.equal(period.start, 200)
  })

  it('reports absent rather than guessing when neither location has it', () => {
    const period = readSubscriptionPeriod({ id: 'sub_x', items: { data: [{ id: 'si_1' }] } })
    assert.equal(period.source, 'absent')
    assert.equal(period.end, null)
  })
})

describe('readSubscriptionCancellation', () => {
  it('sees a BILLING-PORTAL cancellation, which leaves the boolean false', () => {
    const sub = p.subscription_retrieved
    // The exact shape that made symptom 3 invisible.
    assert.equal(sub.status, 'active')
    assert.equal(sub.cancel_at_period_end, false)
    assert.equal(typeof sub.cancel_at, 'number')

    const c = readSubscriptionCancellation(sub)
    assert.equal(c.cancelsAtPeriodEnd, true)
    assert.equal(c.expression, 'cancel_at')
    assert.equal(c.cancelAt, 1789487599)
    assert.equal(c.canceledAt, 1786810613)
    assert.equal(c.reason, 'cancellation_requested')
  })

  it('carries the WHOLE cancellation_details across, from the real payload', () => {
    // A live churn survey answer, captured rather than invented — the studio-
    // facing half of what the boolean could never express.
    const c = readSubscriptionCancellation(p.subscription_updated_event_object)
    assert.deepEqual(c.details, {
      reason: 'cancellation_requested',
      feedback: 'switched_service',
      comment: null,
    })
  })

  it('narrows to the enums we store, and drops anything outside them', () => {
    // Stripe may ADD a member; the stored enum is our subset, and an unknown
    // value must land as null rather than as copy no locale can translate.
    const c = readSubscriptionCancellation({
      cancel_at_period_end: true,
      cancellation_details: { reason: 'brand_new_stripe_reason', feedback: 'also_new', comment: 'hi' },
    })
    assert.equal(c.reason, null)
    assert.deepEqual(c.details, { reason: null, feedback: null, comment: 'hi' })
  })

  it('reports details as NULL when Stripe said nothing, so one write clears the field', () => {
    // Firestore deep-merges a nested map: a partial object over a previous
    // cancellation would keep that cancellation's feedback behind a new reason.
    // Null-when-empty is what lets every writer clear it in one move.
    const c = readSubscriptionCancellation({
      cancel_at_period_end: false,
      cancellation_details: { reason: null, feedback: null, comment: null },
    })
    assert.equal(c.details, null)
    assert.equal(readSubscriptionCancellation({}).details, null)
  })

  it('still sees an API-initiated cancellation, which sets the boolean', () => {
    const c = readSubscriptionCancellation({ cancel_at_period_end: true, cancel_at: null })
    assert.equal(c.cancelsAtPeriodEnd, true)
    assert.equal(c.expression, 'cancel_at_period_end')
    assert.equal(c.cancelAt, null)
  })

  it('reports "none" for a subscription that is simply renewing', () => {
    const c = readSubscriptionCancellation({ cancel_at_period_end: false, cancel_at: null })
    assert.equal(c.cancelsAtPeriodEnd, false)
    assert.equal(c.expression, 'none')
    assert.equal(c.canceledAt, null)
  })
})

describe('readInvoiceSubscriptionId', () => {
  it('reads it off parent.subscription_details on the DELIVERED payload', () => {
    const invoice = p.invoice_delivered_event_object
    // No API call needed — and no `subscription` key to fall back to.
    assert.equal('subscription' in invoice, false)
    const read = readInvoiceSubscriptionId(invoice)
    assert.equal(read.source, 'modern')
    assert.equal(read.value, 'sub_1U4jtdGz6xp8VQ38RRkK37D0')
  })

  it('carries the subscription metadata across with it', () => {
    const md = readInvoiceSubscriptionMetadata(p.invoice_delivered_event_object)
    assert.equal(md.kind, 'membership')
    assert.ok(md.subscriptionTypeId)
  })

  it('falls back to invoice.subscription (hand-written legacy shape)', () => {
    const read = readInvoiceSubscriptionId({ id: 'in_legacy', subscription: 'sub_legacy' })
    assert.equal(read.source, 'legacy')
    assert.equal(read.value, 'sub_legacy')
  })
})

describe('invoiceBillsSubscription', () => {
  it('is true for a real subscription invoice', () => {
    assert.equal(invoiceBillsSubscription(p.invoice_delivered_event_object), true)
    assert.equal(invoiceBillsSubscription(p.invoice_retrieved_expanded), true)
  })

  it('is false for a one-off invoice — which is why it does not cry wolf', () => {
    // A studio raising an invoice by hand has no subscription BY DESIGN. Without
    // this, every one would be logged as a missing field until the alarm was
    // worth nothing.
    assert.equal(
      invoiceBillsSubscription({ id: 'in_oneoff', parent: { type: 'quote_details' } }),
      false
    )
    assert.equal(invoiceBillsSubscription({ id: 'in_oneoff' }), false)
  })

  it('is true when only the legacy marker is present', () => {
    assert.equal(invoiceBillsSubscription({ id: 'in_legacy', subscription: 'sub_legacy' }), true)
  })

  it('asks through the MARKER, so an invoice that claims one and names none is still loud', () => {
    const claimed = { id: 'in_x', parent: { type: 'subscription_details' } }
    assert.equal(invoiceBillsSubscription(claimed), true)
    assert.equal(readInvoiceSubscriptionId(claimed).source, 'absent')
  })
})

describe('readInvoicePaymentIntentId', () => {
  it('is ABSENT on the delivered payload — `payments` is expand-only', () => {
    // Pinned deliberately. Re-pointing the read is NOT enough on its own: a
    // caller holding only the webhook payload must re-fetch with expand.
    const invoice = p.invoice_delivered_event_object
    assert.equal('payment_intent' in invoice, false)
    assert.equal('payments' in invoice, false)
    assert.equal(readInvoicePaymentIntentId(invoice).source, 'absent')
  })

  it('reads it from payments.data[].payment on an expanded retrieve', () => {
    const read = readInvoicePaymentIntentId(p.invoice_retrieved_expanded)
    assert.equal(read.source, 'modern')
    assert.equal(read.value, 'pi_3U4jtbGz6xp8VQ38150eBCOy')
  })

  it('reads it through subscriptions.retrieve(expand: latest_invoice.payments)', () => {
    // The route handleCheckoutCompleted takes to stamp the FIRST charge.
    const sub = p.subscription_retrieved_expanded_latest_invoice_payments
    const read = readInvoicePaymentIntentId(sub.latest_invoice)
    assert.equal(read.source, 'modern')
    assert.equal(read.value, 'pi_3U4jtbGz6xp8VQ38150eBCOy')
  })

  it('falls back to invoice.payment_intent (hand-written legacy shape)', () => {
    const read = readInvoicePaymentIntentId({ id: 'in_legacy', payment_intent: 'pi_legacy' })
    assert.equal(read.source, 'legacy')
    assert.equal(read.value, 'pi_legacy')
  })
})

describe('the payer email', () => {
  it('is NOT recoverable from an invoice-generated PaymentIntent', () => {
    // receipt_email is null and `charges` is long gone — so a rail that cannot
    // call the Stripe API genuinely does not know who paid.
    const pi = p.payment_intent_succeeded_event_object
    assert.equal('charges' in pi, false)
    assert.equal(pi.receipt_email, null)
    assert.equal(readPaymentIntentEmail(pi).source, 'absent')
  })

  it('IS on the charge, which is the only place it survives', () => {
    const charge = p.charge_succeeded_event_object
    assert.equal(readChargeBillingEmail(charge), 'member@example.test')
    assert.equal(charge.payment_intent, 'pi_3U4jtbGz6xp8VQ38150eBCOy')
  })

  it('still reads receipt_email, and the pre-2022 charges list (legacy shape)', () => {
    assert.equal(readPaymentIntentEmail({ receipt_email: 'a@b.test' }).source, 'modern')
    const legacy = readPaymentIntentEmail({
      receipt_email: null,
      charges: { data: [{ billing_details: { email: 'a@b.test' } }] },
    })
    assert.equal(legacy.source, 'legacy')
    assert.equal(legacy.value, 'a@b.test')
  })
})

describe('the hosted receipt link', () => {
  it('is still ON THE CHARGE at the version we bundle', () => {
    // `getPaymentReceiptUrl` retrieves a charge and hands this straight to the
    // browser, and there is no second location to fail over to — so what is
    // worth pinning is that the key is where the reader looks, on a REAL
    // captured Dahlia charge rather than on a shape we wrote ourselves. The
    // captured VALUE is redacted (a receipt link is durable and belongs to a
    // real payment), which is why the assertion is about the key.
    const charge = p.charge_succeeded_event_object
    assert.equal(typeof charge.receipt_url, 'string')
    assert.equal(readChargeReceiptUrl(charge), charge.receipt_url)
  })

  it('reads null rather than throwing when the charge never produced one', () => {
    // Nullable by design: a caller renders "no receipt", never a failure.
    assert.equal(readChargeReceiptUrl({ receipt_url: null }), null)
    assert.equal(readChargeReceiptUrl({}), null)
    assert.equal(readChargeReceiptUrl(null), null)
    assert.equal(readChargeReceiptUrl({ receipt_url: '' }), null)
  })
})

describe('the subscription checkout session', () => {
  it('carries an invoice but never a payment_intent, which is why the link is indirect', () => {
    const session = p.checkout_session_completed_event_object
    assert.equal(session.mode, 'subscription')
    assert.equal(session.payment_intent, null)
    assert.equal(session.invoice, 'in_1U4jtbGz6xp8VQ38TFp0ScIe')
    assert.ok(session.subscription)
    // customer_details.name survived Dahlia (which merely ADDED individual_name).
    assert.equal(typeof session.customer_details.name, 'string')
    assert.equal(typeof session.customer_details.email, 'string')
  })
})
