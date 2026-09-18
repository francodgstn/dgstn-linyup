import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  INTRO_OFFER_MAX_PERIODS,
  introOfferDurationFor,
  introOfferProblem,
  introOfferSpan,
  introOfferSupport,
  resolveIntroOffer,
  type SubscriptionType,
} from '@linyup/shared'
import { introCheckoutMetadata, introCouponId, introCouponSpec } from './introOffer'

// The plan's intro offer. Three things are pinned here, and each was a way the
// feature could have shipped wrong:
//
//  1. WHICH interval × N combinations are expressible. Stripe measures a
//     repeating discount in `duration_in_months` and nothing else, so "the first
//     3 weeks" cannot be stated — and an editor that offered it would write a
//     value Stripe rejects or, worse, silently misapplies.
//  2. That a ZERO intro is a 100%-off coupon (a free invoice) and not a charge
//     below the 0.50 floor.
//  3. That the coupon id is DERIVED, so a retry reuses it and an EDIT does not.

const monthly = (overrides: Partial<SubscriptionType> = {}): SubscriptionType => ({
  id: 'plan1',
  name: 'Unlimited',
  prices: [{ id: 'p_m', amount: 79, recurrence: 'monthly' }],
  ...overrides,
})

describe('introOfferDurationFor — what Stripe can express', () => {
  it('N = 1 is `once` at EVERY recurrence, weekly included', () => {
    for (const r of ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'] as const) {
      assert.deepEqual(introOfferDurationFor(r, 1), { duration: 'once' })
    }
  })

  it('N > 1 converts to WHOLE MONTHS on the month-aligned recurrences', () => {
    assert.deepEqual(introOfferDurationFor('monthly', 3), {
      duration: 'repeating',
      durationInMonths: 3,
    })
    assert.deepEqual(introOfferDurationFor('quarterly', 2), {
      duration: 'repeating',
      durationInMonths: 6,
    })
    assert.deepEqual(introOfferDurationFor('annual', 2), {
      duration: 'repeating',
      durationInMonths: 24,
    })
  })

  it('REFUSES N > 1 on weekly/biweekly — N weeks is not a whole number of months', () => {
    assert.equal(introOfferDurationFor('weekly', 3), null)
    assert.equal(introOfferDurationFor('biweekly', 2), null)
  })

  it('REFUSES the non-subscription recurrences outright', () => {
    assert.equal(introOfferDurationFor('one_time', 1), null)
  })

  it('refuses a non-integer, a zero, and anything past the cap', () => {
    assert.equal(introOfferDurationFor('monthly', 0), null)
    assert.equal(introOfferDurationFor('monthly', 1.5), null)
    assert.equal(introOfferDurationFor('monthly', INTRO_OFFER_MAX_PERIODS + 1), null)
    assert.notEqual(introOfferDurationFor('monthly', INTRO_OFFER_MAX_PERIODS), null)
  })

  it('introOfferSupport tells the editor which control to render', () => {
    assert.equal(introOfferSupport('monthly'), 'periods')
    assert.equal(introOfferSupport('quarterly'), 'periods')
    assert.equal(introOfferSupport('annual'), 'periods')
    assert.equal(introOfferSupport('weekly'), 'first_only')
    assert.equal(introOfferSupport('biweekly'), 'first_only')
    assert.equal(introOfferSupport('one_time'), 'none')
  })
})

describe('introOfferProblem — the rules the editor and the server both apply', () => {
  const price = { amount: 79, recurrence: 'monthly' } as const

  it('accepts an ordinary priced offer', () => {
    assert.equal(introOfferProblem({ priceId: 'p_m', periods: 3, amount: 1 }, price), null)
  })

  it('accepts ZERO — a free intro is not a charge, so no floor applies', () => {
    assert.equal(introOfferProblem({ priceId: 'p_m', periods: 3, amount: 0 }, price), null)
  })

  it('refuses a charge under the 0.50 floor (0.20 would fail at Stripe)', () => {
    assert.equal(
      introOfferProblem({ priceId: 'p_m', periods: 1, amount: 0.2 }, price),
      'below_minimum'
    )
  })

  it('refuses an intro that is not cheaper than the plan', () => {
    assert.equal(
      introOfferProblem({ priceId: 'p_m', periods: 1, amount: 79 }, price),
      'not_cheaper'
    )
    assert.equal(
      introOfferProblem({ priceId: 'p_m', periods: 1, amount: 99 }, price),
      'not_cheaper'
    )
  })

  it('names the WEEKLY refusal specifically, so the editor can explain it', () => {
    assert.equal(
      introOfferProblem(
        { priceId: 'p_w', periods: 3, amount: 1 },
        { amount: 20, recurrence: 'weekly' }
      ),
      'interval_not_monthly'
    )
  })

  it('refuses a one-off price — nothing recurs, so nothing returns to full', () => {
    assert.equal(
      introOfferProblem(
        { priceId: 'p_o', periods: 1, amount: 1 },
        { amount: 200, recurrence: 'one_time' }
      ),
      'not_recurring'
    )
  })
})

describe('resolveIntroOffer — one answer every surface acts on', () => {
  it('resolves against the price it names', () => {
    const type = monthly({ introOffer: { priceId: 'p_m', periods: 3, amount: 1 } })
    const r = resolveIntroOffer(type, 'p_m')
    assert.ok(r)
    assert.equal(r.periods, 3)
    assert.equal(r.amount, 1)
    assert.equal(r.fullAmount, 79)
    assert.equal(r.free, false)
    assert.deepEqual(r.stripe, { duration: 'repeating', durationInMonths: 3 })
  })

  it('returns null for a price with NO offer of its own', () => {
    const type = monthly({
      prices: [
        { id: 'p_m', amount: 79, recurrence: 'monthly' },
        { id: 'p_y', amount: 790, recurrence: 'annual' },
      ],
      introOffers: [{ priceId: 'p_m', periods: 3, amount: 1 }],
    })
    assert.ok(resolveIntroOffer(type, 'p_m'))
    assert.equal(resolveIntroOffer(type, 'p_y'), null)
  })

  it('EACH price carries its own offer — the monthly and the annual differ', () => {
    // The reason the list exists: a studio prices an opener on both cadences
    // ("3 months at 29, or your first year at 490"), and the plan-level single
    // offer could express only one of them.
    const type = monthly({
      prices: [
        { id: 'p_m', amount: 79, recurrence: 'monthly' },
        { id: 'p_y', amount: 790, recurrence: 'annual' },
      ],
      introOffers: [
        { priceId: 'p_m', periods: 3, amount: 29 },
        { priceId: 'p_y', periods: 1, amount: 490 },
      ],
    })
    const m = resolveIntroOffer(type, 'p_m')
    const y = resolveIntroOffer(type, 'p_y')
    assert.equal(m?.amount, 29)
    assert.deepEqual(m?.stripe, { duration: 'repeating', durationInMonths: 3 })
    assert.equal(y?.amount, 490)
    assert.deepEqual(y?.stripe, { duration: 'once' })
  })

  it('one price falling foul of a rule leaves the OTHER price selling', () => {
    // Independence is the point: an offer the studio has since undercut must go
    // quiet on its own price without silencing the plan's other opener.
    const type = monthly({
      prices: [
        { id: 'p_m', amount: 79, recurrence: 'monthly' },
        { id: 'p_y', amount: 790, recurrence: 'annual' },
      ],
      introOffers: [
        { priceId: 'p_m', periods: 3, amount: 99 }, // not cheaper — unsellable
        { priceId: 'p_y', periods: 1, amount: 490 },
      ],
    })
    assert.equal(resolveIntroOffer(type, 'p_m'), null)
    assert.ok(resolveIntroOffer(type, 'p_y'))
  })

  it('reads a plan still carrying the LEGACY single offer, unchanged', () => {
    // Stored documents are read, never rewritten to be readable. A plan written
    // before the list existed must keep selling exactly as it did.
    const type = monthly({
      prices: [{ id: 'p_m', amount: 79, recurrence: 'monthly' }],
      introOffer: { priceId: 'p_m', periods: 3, amount: 1 },
    })
    const r = resolveIntroOffer(type, 'p_m')
    assert.equal(r?.amount, 1)
    assert.equal(r?.periods, 3)
  })

  it('the list WINS over a legacy field left beside it', () => {
    // The editor writes the list and deletes the legacy field in one update, so
    // both are present only if a write half-landed. The list is the newer
    // statement of intent, and picking it keeps the card and the checkout
    // agreeing on ONE answer rather than on whichever they read first.
    const type = monthly({
      prices: [{ id: 'p_m', amount: 79, recurrence: 'monthly' }],
      introOffer: { priceId: 'p_m', periods: 3, amount: 1 },
      introOffers: [{ priceId: 'p_m', periods: 2, amount: 19 }],
    })
    assert.equal(resolveIntroOffer(type, 'p_m')?.amount, 19)
  })

  it('returns null once the offer is unsellable — so the CARD and the CHECKOUT go quiet together', () => {
    // The studio raised the plan price to 1.00 and left a 1.00 intro standing.
    const type = monthly({
      prices: [{ id: 'p_m', amount: 1, recurrence: 'monthly' }],
      introOffer: { priceId: 'p_m', periods: 3, amount: 1 },
    })
    assert.equal(resolveIntroOffer(type, 'p_m'), null)
  })

  it('returns null when the named price was deactivated', () => {
    const type = monthly({
      prices: [{ id: 'p_m', amount: 79, recurrence: 'monthly', active: false }],
      introOffer: { priceId: 'p_m', periods: 3, amount: 1 },
    })
    assert.equal(resolveIntroOffer(type, 'p_m'), null)
  })

  it('introOfferSpan counts the way a member counts, not the way billing does', () => {
    assert.deepEqual(introOfferSpan('quarterly', 2), { count: 6, unit: 'month' })
    assert.deepEqual(introOfferSpan('biweekly', 1), { count: 2, unit: 'week' })
    assert.deepEqual(introOfferSpan('annual', 1), { count: 1, unit: 'year' })
  })
})

describe('introCouponSpec — the coupon, and why its id is derived', () => {
  const type = monthly({ introOffer: { priceId: 'p_m', periods: 3, amount: 1 } })
  const args = { subType: type, subscriptionTypeId: 'plan1', priceId: 'p_m', currency: 'chf' }

  it('a priced intro is amount_off = full − intro, in MINOR units', () => {
    const out = introCouponSpec(args)
    assert.ok(out)
    assert.equal(out.spec.amountOffMinor, 7900 - 100)
    assert.equal(out.spec.currency, 'chf')
    assert.equal(out.spec.duration, 'repeating')
    assert.equal(out.spec.durationInMonths, 3)
  })

  it('a FREE intro is percent_off: 100 (a zero invoice), never an amount_off', () => {
    const free = introCouponSpec({
      ...args,
      subType: monthly({ introOffer: { priceId: 'p_m', periods: 1, amount: 0 } }),
    })
    assert.ok(free)
    assert.equal(free.spec.amountOffMinor, null)
    assert.equal(free.spec.duration, 'once')
  })

  it('the SAME offer always derives the SAME id — a retry reuses the coupon', () => {
    assert.equal(introCouponSpec(args)!.spec.id, introCouponSpec(args)!.spec.id)
  })

  it('EVERY term that changes the promise changes the id', () => {
    const base = introCouponSpec(args)!.spec.id
    const idFor = (o: { periods: number; amount: number }, full = 79, currency = 'chf') =>
      introCouponSpec({
        ...args,
        currency,
        subType: monthly({
          prices: [{ id: 'p_m', amount: full, recurrence: 'monthly' }],
          introOffer: { priceId: 'p_m', ...o },
        }),
      })!.spec.id
    assert.notEqual(base, idFor({ periods: 6, amount: 1 })) // more periods
    assert.notEqual(base, idFor({ periods: 3, amount: 2 })) // different intro price
    assert.notEqual(base, idFor({ periods: 3, amount: 1 }, 89)) // plan price moved
    assert.notEqual(base, idFor({ periods: 3, amount: 1 }, 79, 'eur')) // currency
    // …and editing BACK returns to the original coupon.
    assert.equal(base, idFor({ periods: 3, amount: 1 }))
  })

  it('the id is a legal, bounded Stripe coupon id', () => {
    const id = introCouponSpec(args)!.spec.id
    assert.ok(/^intro_[A-Za-z0-9_-]+$/.test(id), id)
    assert.ok(id.length <= 60, `${id} is ${id.length} chars`)
  })

  it('the invoice label stays inside Stripe’s 40-character coupon name limit', () => {
    const long = introCouponSpec({
      ...args,
      subType: monthly({
        name: 'Unlimited Adult Membership With Everything Included',
        introOffer: { priceId: 'p_m', periods: 3, amount: 1 },
      }),
    })!
    assert.ok(long.spec.name.length <= 40, long.spec.name)
  })

  it('is null when the plan has no sellable offer', () => {
    assert.equal(introCouponSpec({ ...args, subType: monthly() }), null)
  })

  it('introCouponId is a pure function of the resolved offer', () => {
    const offer = resolveIntroOffer(type, 'p_m')!
    assert.equal(
      introCouponId({ subscriptionTypeId: 'plan1', offer, currency: 'chf' }),
      introCouponId({ subscriptionTypeId: 'plan1', offer, currency: 'CHF' })
    )
    assert.notEqual(
      introCouponId({ subscriptionTypeId: 'plan1', offer, currency: 'chf' }),
      introCouponId({ subscriptionTypeId: 'plan2', offer, currency: 'chf' })
    )
  })

  it('the checkout metadata carries BOTH halves of the schedule', () => {
    const md = introCheckoutMetadata(resolveIntroOffer(type, 'p_m')!)
    // The receipt has to restate "then CHF 79/month", and the session itself
    // only knows the discounted first total.
    assert.deepEqual(md, { introPeriods: '3', introAmount: '1', fullAmount: '79' })
  })
})

describe('the intro offer is NOT a price', () => {
  // The single most important property of this feature, and the one a future
  // change is most likely to break: `resolvePaymentOptions` returns ONE amount,
  // and an intro offer is a schedule. Adding an arm there is what the whole
  // design exists to avoid — so this reads the SOURCE rather than trusting a
  // comment (the idiom of connect/commitSites.test.ts).
  const resolverSrc = fs.readFileSync(
    path.join(__dirname, '../../../shared/src/utils/paymentOptions.ts'),
    'utf8'
  )

  it('resolvePaymentOptions knows nothing about intro offers', () => {
    assert.ok(
      !/intro/i.test(resolverSrc),
      'shared/utils/paymentOptions.ts mentions "intro". An intro offer is a SCHEDULE ' +
        '(an amount AND how many periods it survives) and that resolver returns ONE ' +
        'amount — which is exactly why memberships are outside the promo rails. ' +
        'The offer belongs to the CHECKOUT (a Stripe coupon), not to the resolver.'
    )
  })

  it('the checkout is created at the FULL price, with the discount as a coupon', () => {
    const clientSrc = fs.readFileSync(
      path.join(__dirname, '../utils/connect/client.ts'),
      'utf8'
    )
    // `unit_amount` on the recurring price is the price the member pays forever;
    // lowering it "works" on the first invoice and is the trap this feature is
    // named after.
    assert.ok(
      clientSrc.includes('discounts: [{ coupon: params.discountCouponId }]'),
      'createSubscriptionCheckoutSession must apply the intro offer through `discounts`'
    )
    assert.ok(
      clientSrc.includes('unit_amount: params.amount'),
      'the recurring price must stay the FULL amount'
    )
  })
})
