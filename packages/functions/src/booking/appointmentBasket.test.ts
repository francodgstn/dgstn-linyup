import assert from 'node:assert/strict'
import {
  BASKET_MAX_DATES,
  GUEST_SNAPSHOT,
  resolveMaxDatesPerBooking,
  resolvePaymentOptions,
  type ContactPaymentSnapshot,
  type PaymentTarget,
  type PromoModifier,
} from '@linyup/shared'
import {
  appointmentSessionId,
  basketCheckoutMetadata,
  basketDateToken,
  basketFromCheckoutMetadata,
  basketKeyParts,
  basketRefundKey,
  readBasketStarts,
} from '../appointments/basket'

// A BASKET: several dates with one provider, booked and paid as one (US-07).
// Design record: docs/appointments.md "Several dates in one booking".

const contact = (over: Partial<ContactPaymentSnapshot> = {}): ContactPaymentSnapshot => ({
  authenticated: true,
  joined: true,
  heldUnmeteredTypeIds: [],
  heldCreditTypes: [],
  ...over,
})
const solo = { minutes: 45, priceAmount: 110 }
const t = (over: Partial<Extract<PaymentTarget, { kind: 'appointment' }>> = {}): PaymentTarget => ({
  kind: 'appointment',
  duration: solo,
  benefit: null,
  ...over,
})

describe('resolveMaxDatesPerBooking: the one reader of the per-offer limit', () => {
  it('absent, malformed or below one is a one-date booking', () => {
    assert.equal(resolveMaxDatesPerBooking({}), 1)
    assert.equal(resolveMaxDatesPerBooking({ maxDatesPerBooking: 0 }), 1)
    assert.equal(resolveMaxDatesPerBooking({ maxDatesPerBooking: 2.5 }), 1)
  })
  it('is capped at the largest basket', () => {
    assert.equal(resolveMaxDatesPerBooking({ maxDatesPerBooking: 5 }), 5)
    assert.equal(resolveMaxDatesPerBooking({ maxDatesPerBooking: 99 }), BASKET_MAX_DATES)
  })
})

describe('resolvePaymentOptions: a basket of dates', () => {
  it('one date is priced exactly as before, with no basket record', () => {
    assert.deepEqual(resolvePaymentOptions(GUEST_SNAPSHOT, t({ quantity: 1 })), {
      options: [{ type: 'pay', amount: 110, source: 'base' }],
      denial: null,
    })
  })
  it('four dates pay four lessons, and say what one lesson cost', () => {
    assert.deepEqual(resolvePaymentOptions(GUEST_SNAPSHOT, t({ quantity: 4 })), {
      options: [{ type: 'pay', amount: 440, source: 'base', basket: { lessons: 4, lessonAmount: 110 } }],
      denial: null,
    })
  })
  it('a member price applies to every date, and its list total scales with it', () => {
    const r = resolvePaymentOptions(
      contact({ heldUnmeteredTypeIds: ['silver'] }),
      t({ quantity: 3, benefit: { subscriptionTypeIds: ['silver'], effect: 'percent_off', percent: 10 } })
    )
    assert.deepEqual(r.options[0], {
      type: 'pay',
      amount: 297,
      source: 'base',
      appliedBenefit: { subscriptionTypeId: 'silver', effect: 'percent_off', baseAmount: 330 },
      basket: { lessons: 3, lessonAmount: 99 },
    })
  })
  it('a plan that includes the length covers every date', () => {
    const r = resolvePaymentOptions(
      contact({ heldUnmeteredTypeIds: ['gold'] }),
      t({ quantity: 5, benefit: { subscriptionTypeIds: ['gold'], effect: 'included' } })
    )
    assert.deepEqual(r, {
      options: [{ type: 'covered', via: { reason: 'benefit_included', subscriptionTypeId: 'gold' } }],
      denial: null,
    })
  })
  it('a credit pack does not pay for a basket: the credits could run out partway', () => {
    const r = resolvePaymentOptions(
      contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 10 }] }),
      t({ quantity: 3, benefit: { subscriptionTypeIds: ['pack10'], effect: 'included' } })
    )
    assert.equal(r.options[0]?.type, 'pay')
  })
  it('an unpriced length is free for every date', () => {
    assert.deepEqual(
      resolvePaymentOptions(GUEST_SNAPSHOT, t({ duration: { minutes: 45 }, quantity: 6 })),
      { options: [{ type: 'covered', via: { reason: 'unpriced' } }], denial: null }
    )
  })
  it('a party basket: each date is the party price, and the basket is that times the dates', () => {
    const r = resolvePaymentOptions(
      GUEST_SNAPSHOT,
      t({ duration: { minutes: 45, priceAmount: 75, party: { min: 2, max: 4 } }, people: 2, quantity: 3 })
    )
    assert.deepEqual(r.options[0], {
      type: 'pay',
      amount: 450,
      source: 'base',
      party: { people: 2, unitAmount: 75 },
      basket: { lessons: 3, lessonAmount: 150 },
    })
  })
  it('a promo lowers every date, and the struck-through base is the basket list total', () => {
    const promo: PromoModifier = { code: 'SPRING', effect: 'percent_off', percent: 20 }
    const r = resolvePaymentOptions(GUEST_SNAPSHOT, t({ quantity: 2 }), { promo })
    assert.deepEqual(r.options[0], {
      type: 'pay',
      amount: 176,
      source: 'base',
      appliedPromo: { code: 'SPRING', effect: 'percent_off', baseAmount: 220 },
      basket: { lessons: 2, lessonAmount: 88 },
    })
    assert.deepEqual(r.promo, { code: 'SPRING', status: 'applied' })
  })
})

describe('appointments/basket.ts: what the rails read and carry', () => {
  it('reads one date as before, or a list sorted and de-duplicated', () => {
    assert.deepEqual(readBasketStarts({ startMs: 5000 }, 1), [5000])
    assert.deepEqual(readBasketStarts({ startMsList: [3000, 1000, 3000, 2000] }, 12), [1000, 2000, 3000])
  })
  it('refuses a basket larger than the offer allows, by name', () => {
    assert.throws(
      () => readBasketStarts({ startMsList: [1, 2, 3] }, 2),
      (err: { details?: { reason?: string; max?: number } }) =>
        err.details?.reason === 'basket_too_large' && err.details?.max === 2
    )
  })
  it('refuses a list that is not whole start times, and a request with neither', () => {
    assert.throws(() => readBasketStarts({ startMsList: [1.5] }, 12))
    assert.throws(() => readBasketStarts({ startMsList: [] }, 12))
    assert.throws(() => readBasketStarts({}, 12))
  })
  it('the dates round-trip through Checkout metadata; one date carries nothing', () => {
    const identity = { basketId: 'b-1', secret: 's3cret' }
    assert.deepEqual(basketCheckoutMetadata([1000], identity), {})
    const md = basketCheckoutMetadata([1000, 2000], identity)
    assert.deepEqual(basketFromCheckoutMetadata(md), { starts: [1000, 2000], basketId: 'b-1', secret: 's3cret' })
    assert.equal(basketFromCheckoutMetadata({}), null)
  })
  it('twelve dates fit in one Stripe metadata value', () => {
    const starts = Array.from({ length: BASKET_MAX_DATES }, (_, i) => 1_790_000_000_000 + i * 3_600_000)
    const md = basketCheckoutMetadata(starts, { basketId: 'b', secret: 's' })
    assert.ok(md.startMsList.length <= 500, `${md.startMsList.length} characters`)
  })
  it('each date gets its own token from the one secret, re-derivable and distinct', () => {
    const a = basketDateToken('s', appointmentSessionId('coach', 1000))
    const b = basketDateToken('s', appointmentSessionId('coach', 2000))
    assert.notEqual(a, b)
    assert.equal(a, basketDateToken('s', appointmentSessionId('coach', 1000)))
    assert.notEqual(a, basketDateToken('other', appointmentSessionId('coach', 1000)))
  })
  it('one date adds nothing to the idempotency key; a different set of dates is a different key', () => {
    assert.deepEqual(basketKeyParts([1000]), [])
    assert.notDeepEqual(basketKeyParts([1000, 2000]), basketKeyParts([1000, 3000]))
  })
  it('the partial refund key names WHICH dates, in any order', () => {
    assert.equal(basketRefundKey('pi_1', ['b', 'a']), basketRefundKey('pi_1', ['a', 'b']))
    assert.notEqual(basketRefundKey('pi_1', ['a']), basketRefundKey('pi_1', ['a', 'b']))
  })
})
