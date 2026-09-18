import assert from 'node:assert/strict'
import {
  GUEST_SNAPSHOT,
  MIN_CHARGE_MAJOR,
  resolvePaymentOptions,
  type ContactPaymentSnapshot,
  type PaymentContext,
  type PaymentOptionsResult,
  type PaymentTarget,
  type PromoEffect,
  type PromoModifier,
} from '@linyup/shared'

// Table-driven tests for the ONE coverage/quote resolver (Phase B of the
// pricing consolidation). Each row is a (snapshot, target) → expected fixture;
// the appointment rows are parity ports of effectivePrice.test.ts, and the
// P1/P2 rows are named after the audit findings they fix.
// Run with: pnpm --filter @linyup/functions test

function contact(overrides: Partial<ContactPaymentSnapshot> = {}): ContactPaymentSnapshot {
  return {
    authenticated: true,
    joined: true,
    heldUnmeteredTypeIds: [],
    heldCreditTypes: [],
    ...overrides,
  }
}

interface Row {
  name: string
  snapshot: ContactPaymentSnapshot
  target: PaymentTarget
  expected: PaymentOptionsResult
}

function runRows(rows: Row[]) {
  for (const row of rows) {
    it(row.name, () => {
      assert.deepEqual(resolvePaymentOptions(row.snapshot, row.target), row.expected)
    })
  }
}

const covered = (via: Record<string, unknown>): PaymentOptionsResult => ({
  options: [{ type: 'covered', via } as never],
  denial: null,
})
const denied = (denial: PaymentOptionsResult['denial']): PaymentOptionsResult => ({
  options: [],
  denial,
})

describe('resolvePaymentOptions — class_booking (bookSession gate parity)', () => {
  const gated: PaymentTarget = {
    kind: 'class_booking',
    accessRule: { type: 'subscription', subscriptionTypeIds: ['gold', 'pack10'] },
  }
  runRows([
    {
      name: 'open class: everyone covered, guests included',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'class_booking', accessRule: { type: 'open' } },
      expected: covered({ reason: 'open' }),
    },
    {
      name: 'members class: guest denied guest',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'class_booking', accessRule: { type: 'members' } },
      expected: denied('guest'),
    },
    {
      name: 'members class: authenticated but not joined denied not_joined',
      snapshot: contact({ joined: false }),
      target: { kind: 'class_booking', accessRule: { type: 'members' } },
      expected: denied('not_joined'),
    },
    {
      name: 'members class: joined contact covered',
      snapshot: contact(),
      target: { kind: 'class_booking', accessRule: { type: 'members' } },
      expected: covered({ reason: 'members' }),
    },
    {
      name: 'subscription class: unmetered holder covered via that type',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: gated,
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'subscription class: unmetered wins over credits (never burns a credit)',
      snapshot: contact({
        heldUnmeteredTypeIds: ['gold'],
        heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 3 }],
      }),
      target: gated,
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'subscription class: credit holder gets spend_credits with remaining',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 3 }] }),
      target: gated,
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'pack10' }, remaining: 3 }],
        denial: null,
      },
    },
    {
      name: 'subscription class: exhausted pack denied no_credits (not no_subscription)',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 0 }] }),
      target: gated,
      expected: denied('no_credits'),
    },
    {
      name: 'subscription class: nothing held denied no_subscription',
      snapshot: contact(),
      target: gated,
      expected: denied('no_subscription'),
    },
    {
      // rule 5d (class-access stage 5, 'dead_end_reopened'): "plan required"
      // with NO plan named is no longer expressible — with no gate ids
      // requirePlan derives false, so this misconfigured class is free rather
      // than a dead end nobody can book.
      name: 'subscription class with EMPTY allow-list (misconfig): no ids to gate on, so it is free (dead_end_reopened)',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: { kind: 'class_booking', accessRule: { type: 'subscription', subscriptionTypeIds: [] } },
      expected: { options: [{ type: 'covered', via: { reason: 'open' } }], denial: null },
    },
    {
      name: 'subscription class: holder of an UNLISTED type denied no_subscription',
      snapshot: contact({ heldUnmeteredTypeIds: ['other'] }),
      target: gated,
      expected: denied('no_subscription'),
    },
  ])
})

describe('resolvePaymentOptions — drop_in (P1/P2 audit fixes live here)', () => {
  const target = (over: Partial<Extract<PaymentTarget, { kind: 'drop_in' }>> = {}): PaymentTarget => ({
    kind: 'drop_in',
    accessRule: { type: 'subscription', subscriptionTypeIds: ['gold', 'pack10'] },
    dropIn: { enabled: true, priceAmount: 25 },
    ...over,
  })
  runRows([
    {
      name: 'covered member (unmetered) is refused a drop-in: coverage option returned',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: target(),
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'P1: usable credit-pack holder is ALSO refused (bookSession semantics win)',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 2 }] }),
      target: target(),
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'pack10' }, remaining: 2 }],
        denial: null,
      },
    },
    {
      name: 'P2: EXHAUSTED pack holder gets the pay option (old deadlock: refused both paths)',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 0 }] }),
      target: target(),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
      },
    },
    {
      name: 'guest pays the drop-in price on a gated class',
      snapshot: GUEST_SNAPSHOT,
      target: target(),
      expected: { options: [{ type: 'pay', amount: 25, source: 'drop_in' }], denial: null },
    },
    {
      name: 'joined-but-uncovered member pays the drop-in price',
      snapshot: contact(),
      target: target(),
      expected: { options: [{ type: 'pay', amount: 25, source: 'drop_in' }], denial: null },
    },
    {
      name: 'open class: covered(open) — the callable maps this to "free to book"',
      snapshot: GUEST_SNAPSHOT,
      target: target({ accessRule: { type: 'open' } }),
      expected: covered({ reason: 'open' }),
    },
    {
      name: 'no drop-in configured and not covered: underlying denial surfaces',
      snapshot: contact(),
      target: target({ dropIn: null }),
      expected: denied('no_subscription'),
    },
    {
      name: 'paid trial (asTrial): guest pays the trial price',
      snapshot: GUEST_SNAPSHOT,
      target: target({ asTrial: true, trial: { enabled: true, priceAmount: 15 }, dropIn: null }),
      expected: { options: [{ type: 'pay', amount: 15, source: 'trial' }], denial: null },
    },
    {
      name: 'paid trial: contact who already used their trial denied trial_used',
      snapshot: contact({ trialUsed: true, joined: false }),
      target: target({ asTrial: true, trial: { enabled: true, priceAmount: 15 } }),
      expected: denied('trial_used'),
    },
  ])
})

describe('resolvePaymentOptions — appointment (effectivePrice parity rows)', () => {
  const duration = { minutes: 60, priceAmount: 95 }
  const included = { subscriptionTypeIds: ['gold'], kind: 'included' as const }
  const discount20 = { subscriptionTypeIds: ['gold'], kind: 'discount' as const, discountPercent: 20 }
  const t = (over: Partial<Extract<PaymentTarget, { kind: 'appointment' }>> = {}): PaymentTarget => ({
    kind: 'appointment',
    duration,
    benefit: null,
    ...over,
  })
  runRows([
    {
      name: 'unpriced duration: covered(unpriced) for everyone, benefit or not',
      snapshot: GUEST_SNAPSHOT,
      target: t({ duration: { minutes: 60 }, benefit: included }),
      expected: covered({ reason: 'unpriced' }),
    },
    {
      name: 'priced + guest: pay base',
      snapshot: GUEST_SNAPSHOT,
      target: t(),
      expected: { options: [{ type: 'pay', amount: 95, source: 'base' }], denial: null },
    },
    {
      name: 'priced + holder of an unlisted type: pay base',
      snapshot: contact({ heldUnmeteredTypeIds: ['other'] }),
      target: t({ benefit: included }),
      expected: { options: [{ type: 'pay', amount: 95, source: 'base' }], denial: null },
    },
    {
      name: 'included + unmetered holder: covered(benefit_included)',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ benefit: included }),
      expected: covered({ reason: 'benefit_included', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'included + credit-only holder: spend_credits (pack pays the visit)',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'gold', remaining: 4 }] }),
      target: t({ benefit: included }),
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'gold' }, remaining: 4 }],
        denial: null,
      },
    },
    {
      name: 'discount 20%: pays 76 with appliedBenefit carrying the base',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ benefit: discount20 }),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 76,
            source: 'base',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 95 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'discount clamps to the 0.50 floor, never lower',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({
        duration: { minutes: 30, priceAmount: 1 },
        benefit: { subscriptionTypeIds: ['gold'], kind: 'discount', discountPercent: 90 },
      }),
      expected: {
        options: [
          {
            type: 'pay',
            amount: MIN_CHARGE_MAJOR,
            source: 'base',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 1 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'discountPercent >= 100 clamps to the floor rather than going free',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({
        benefit: { subscriptionTypeIds: ['gold'], kind: 'discount', discountPercent: 150 },
      }),
      expected: {
        options: [
          {
            type: 'pay',
            amount: MIN_CHARGE_MAJOR,
            source: 'base',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 95 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'malformed discountPercent (missing/zero): base price, benefit NOT applied',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ benefit: { subscriptionTypeIds: ['gold'], kind: 'discount' } }),
      expected: { options: [{ type: 'pay', amount: 95, source: 'base' }], denial: null },
    },
    {
      name: 'several held benefit types: FIRST in config order wins deterministically',
      snapshot: contact({ heldUnmeteredTypeIds: ['elite', 'basic'] }),
      target: t({
        benefit: { subscriptionTypeIds: ['basic', 'elite'], kind: 'included' },
      }),
      expected: covered({ reason: 'benefit_included', subscriptionTypeId: 'basic' }),
    },
  ])
})

// UX-70 — the third sale mode. An absent price used to mean BOTH "free for
// everyone" and "not sold by the session"; `benefitOnly` separates them. The
// rows that matter are the refusals: a benefit_only duration must never fall
// through to the unpriced/covered branch, which is what would hand a stranger a
// free one-to-one.
describe('resolvePaymentOptions — appointment benefit_only (UX-70)', () => {
  const packOnly = { minutes: 60, benefitOnly: true }
  const included = { subscriptionTypeIds: ['pack10'], kind: 'included' as const }
  const t = (over: Partial<Extract<PaymentTarget, { kind: 'appointment' }>> = {}): PaymentTarget => ({
    kind: 'appointment',
    duration: packOnly,
    benefit: included,
    ...over,
  })
  runRows([
    {
      name: 'guest: refused sign_in_required — never the free unpriced path',
      snapshot: GUEST_SNAPSHOT,
      target: t(),
      expected: denied('sign_in_required'),
    },
    {
      name: 'signed-in non-holder: refused no_subscription (what to buy, not who to be)',
      snapshot: contact({ heldUnmeteredTypeIds: ['other'] }),
      target: t(),
      expected: denied('no_subscription'),
    },
    {
      name: 'unmetered holder: covered(benefit_included)',
      snapshot: contact({ heldUnmeteredTypeIds: ['pack10'] }),
      target: t(),
      expected: covered({ reason: 'benefit_included', subscriptionTypeId: 'pack10' }),
    },
    {
      name: 'credit-pack holder with balance: spends one credit',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 3 }] }),
      target: t(),
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'pack10' }, remaining: 3 }],
        denial: null,
      },
    },
    {
      name: 'exhausted pack: refused — there is no per-session price to fall back to',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 0 }] }),
      target: t(),
      expected: denied('no_subscription'),
    },
    {
      name: 'a DISCOUNT benefit is not a way in: there is no price to discount',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ benefit: { subscriptionTypeIds: ['gold'], kind: 'discount', discountPercent: 50 } }),
      expected: denied('no_subscription'),
    },
    {
      name: 'no benefit at all: nobody can book it (computePricingHealth reports this)',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ benefit: null }),
      expected: denied('no_subscription'),
    },
    {
      name: 'a stale priceAmount beside benefitOnly is IGNORED, never charged',
      snapshot: GUEST_SNAPSHOT,
      target: t({ duration: { minutes: 60, priceAmount: 120, benefitOnly: true } }),
      expected: denied('sign_in_required'),
    },
    {
      name: 'benefitOnly false is the ordinary unpriced duration: free for everyone',
      snapshot: GUEST_SNAPSHOT,
      target: t({ duration: { minutes: 60, benefitOnly: false }, benefit: included }),
      expected: covered({ reason: 'unpriced' }),
    },
  ])
})

describe('resolvePaymentOptions — course (shop/Space tiers incl. P6 widening)', () => {
  const t = (accessRule: Extract<PaymentTarget, { kind: 'course' }>['accessRule']): PaymentTarget => ({
    kind: 'course',
    accessRule,
  })
  runRows([
    {
      name: 'free tier: covered for anyone',
      snapshot: GUEST_SNAPSHOT,
      target: t({ type: 'free' }),
      expected: covered({ reason: 'free_tier' }),
    },
    {
      name: 'registered tier: guest denied sign_in_required',
      snapshot: GUEST_SNAPSHOT,
      target: t({ type: 'registered' }),
      expected: denied('sign_in_required'),
    },
    {
      name: 'registered tier: any signed-in contact covered',
      snapshot: contact({ joined: false }),
      target: t({ type: 'registered' }),
      expected: covered({ reason: 'registered' }),
    },
    {
      name: 'subscription tier: holder covered via type',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ type: 'subscription', subscriptionTypeIds: ['gold'] }),
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'P6: coverage honours active_subscriptions beyond the primary (held union)',
      snapshot: contact({ heldUnmeteredTypeIds: ['second-sub'] }),
      target: t({ type: 'subscription', subscriptionTypeIds: ['second-sub'] }),
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'second-sub' }),
    },
    {
      name: 'subscription tier: credit-pack attachment counts as held (never spends)',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 0 }] }),
      target: t({ type: 'subscription', subscriptionTypeIds: ['pack10'] }),
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'pack10' }),
    },
    {
      name: 'subscription tier: signed-in non-holder denied no_subscription',
      snapshot: contact(),
      target: t({ type: 'subscription', subscriptionTypeIds: ['gold'] }),
      expected: denied('no_subscription'),
    },
    {
      name: 'purchase tier: not owned → pay the course price',
      snapshot: contact(),
      target: t({ type: 'purchase', priceAmount: 120 }),
      expected: {
        options: [{ type: 'pay', amount: 120, source: 'course_price' }],
        denial: null,
      },
    },
    {
      name: 'purchase tier: owner covered(owned) — lifetime entitlement',
      snapshot: contact({ ownsCourse: true }),
      target: t({ type: 'purchase', priceAmount: 120 }),
      expected: covered({ reason: 'owned' }),
    },
    {
      name: 'purchase tier: included-free for listed subscription holders',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ type: 'purchase', priceAmount: 120, subscriptionTypeIds: ['gold'] }),
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'purchase tier: guests still see the price (login enforced at checkout)',
      snapshot: GUEST_SNAPSHOT,
      target: t({ type: 'purchase', priceAmount: 120 }),
      expected: {
        options: [{ type: 'pay', amount: 120, source: 'course_price' }],
        denial: null,
      },
    },
  ])
})

describe('resolvePaymentOptions — generalized Benefit (Phase C)', () => {
  const dropInTarget = (benefit: unknown): PaymentTarget => ({
    kind: 'drop_in',
    accessRule: { type: 'subscription', subscriptionTypeIds: ['gold'] },
    dropIn: { enabled: true, priceAmount: 25 },
    benefit: benefit as never,
  })
  runRows([
    {
      name: 'drop-in member rate: percent_off holder pays the reduced drop-in price',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: dropInTarget({ subscriptionTypeIds: ['silver'], effect: 'percent_off', percent: 40 }),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 15,
            source: 'drop_in',
            appliedBenefit: { subscriptionTypeId: 'silver', effect: 'percent_off', baseAmount: 25 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'drop-in member rate: fixed_price holder pays the flat member price',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: dropInTarget({ subscriptionTypeIds: ['silver'], effect: 'fixed_price', amount: 10 }),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 10,
            source: 'drop_in',
            appliedBenefit: { subscriptionTypeId: 'silver', effect: 'fixed_price', baseAmount: 25 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'drop-in: included/spend_credits effects are IGNORED on classes (accessRule owns coverage)',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: dropInTarget({ subscriptionTypeIds: ['silver'], effect: 'included' }),
      expected: { options: [{ type: 'pay', amount: 25, source: 'drop_in' }], denial: null },
    },
    {
      name: 'appointment fixed_price: holder pays the flat rate, clamped to the floor',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'fixed_price', amount: 0.1 },
      },
      expected: {
        options: [
          {
            type: 'pay',
            amount: MIN_CHARGE_MAJOR,
            source: 'base',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'fixed_price', baseAmount: 95 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'appointment explicit spend_credits effect: only a pack WITH balance applies',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 5 }] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['pack10'], effect: 'spend_credits' },
      },
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'pack10' }, remaining: 5 }],
        denial: null,
      },
    },
    {
      name: 'appointment spend_credits effect without balance: falls back to base',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 0 }] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['pack10'], effect: 'spend_credits' },
      },
      expected: { options: [{ type: 'pay', amount: 95, source: 'base' }], denial: null },
    },
    {
      name: 'course percent_off: subscriber pays half price (the tier free-or-full could not express)',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120 },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'percent_off', percent: 50 },
      },
      expected: {
        options: [
          {
            type: 'pay',
            amount: 60,
            source: 'course_price',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 120 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'course included benefit: holder covered(benefit_included)',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120 },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'included' },
      },
      expected: covered({ reason: 'benefit_included', subscriptionTypeId: 'gold' }),
    },
    {
      // THE GATE AND THE BENEFIT ARE ADDITIVE, AND FREE WINS. A plan on both
      // lists is a contradiction the editor cannot produce, and of the two
      // readings this is the one `firestore.rules` has always taken (it ORs
      // them) — so the resolver quoting a price to somebody the rules let read
      // the course for free is the state that cannot happen.
      //
      // Inverted on 2026-09-01. It used to be `benefit` that won, via a
      // `if (!benefit && included)` guard that made the gate list invisible.
      name: 'course: the gate BEATS a discount benefit — free wins over cheaper',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120, subscriptionTypeIds: ['gold'] },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'percent_off', percent: 50 },
      },
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      // The per-plan rates the additive read exists for: one plan free, another
      // discounted, on the SAME sold course. Inexpressible before.
      name: 'course: a gated plan is free while a rated plan pays the discount',
      snapshot: contact({ heldUnmeteredTypeIds: ['elite'] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120, subscriptionTypeIds: ['premium'] },
        benefit: { subscriptionTypeIds: ['elite'], effect: 'percent_off', percent: 50 },
      },
      expected: {
        options: [
          {
            type: 'pay',
            amount: 60,
            source: 'course_price',
            appliedBenefit: { subscriptionTypeId: 'elite', effect: 'percent_off', baseAmount: 120 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'course: …and the gated plan on that same course pays nothing',
      snapshot: contact({ heldUnmeteredTypeIds: ['premium'] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120, subscriptionTypeIds: ['premium'] },
        benefit: { subscriptionTypeIds: ['elite'], effect: 'percent_off', percent: 50 },
      },
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'premium' }),
    },
    {
      name: 'course: a plan on neither list pays the full price',
      snapshot: contact({ heldUnmeteredTypeIds: ['sportpass'] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120, subscriptionTypeIds: ['premium'] },
        benefit: { subscriptionTypeIds: ['elite'], effect: 'percent_off', percent: 50 },
      },
      expected: {
        options: [{ type: 'pay', amount: 120, source: 'course_price' }],
        denial: null,
      },
    },
    {
      name: 'course: spend_credits effect is ignored (no grant+spend story) → pay base',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 5 }] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120 },
        benefit: { subscriptionTypeIds: ['pack10'], effect: 'spend_credits' },
      },
      expected: {
        options: [{ type: 'pay', amount: 120, source: 'course_price' }],
        denial: null,
      },
    },
    {
      name: 'legacy appointment shape {kind: included} still resolves via normalizeBenefit',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['gold'], kind: 'included' },
      },
      expected: covered({ reason: 'benefit_included', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'legacy {kind: discount, discountPercent} ≡ new {effect: percent_off, percent}',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 100 },
        benefit: { subscriptionTypeIds: ['gold'], kind: 'discount', discountPercent: 25 },
      },
      expected: {
        options: [
          {
            type: 'pay',
            amount: 75,
            source: 'base',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 100 },
          },
        ],
        denial: null,
      },
    },
  ])
})

describe('resolvePaymentOptions — usage limits (Phase D)', () => {
  const gated: PaymentTarget = {
    kind: 'class_booking',
    accessRule: { type: 'subscription', subscriptionTypeIds: ['starter'] },
  }
  const dropInTarget: PaymentTarget = {
    kind: 'drop_in',
    accessRule: { type: 'subscription', subscriptionTypeIds: ['starter'] },
    dropIn: { enabled: true, priceAmount: 25 },
    benefit: { subscriptionTypeIds: ['starter'], effect: 'percent_off', percent: 50 },
  }
  runRows([
    {
      name: 'limited type with allowance left: covered, remaining reported AFTER this booking',
      snapshot: contact({ heldUnmeteredTypeIds: ['starter'], usageRemaining: { starter: 3 } }),
      target: gated,
      expected: {
        options: [
          {
            type: 'covered',
            via: { reason: 'subscription', subscriptionTypeId: 'starter' },
            remaining: 2,
          } as never,
        ],
        denial: null,
      },
    },
    {
      name: 'limited type with window spent: denied limit_reached (free path)',
      snapshot: contact({ heldUnmeteredTypeIds: ['starter'], usageRemaining: { starter: 0 } }),
      target: gated,
      expected: denied('limit_reached'),
    },
    {
      name: 'window spent + drop-in: falls to the PAY path, member rate still applies',
      snapshot: contact({ heldUnmeteredTypeIds: ['starter'], usageRemaining: { starter: 0 } }),
      target: dropInTarget,
      expected: {
        options: [
          {
            type: 'pay',
            amount: 12.5,
            source: 'drop_in',
            appliedBenefit: { subscriptionTypeId: 'starter', effect: 'percent_off', baseAmount: 25 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'window spent but a listed credit pack has balance: spend_credits fallback',
      snapshot: contact({
        heldUnmeteredTypeIds: ['starter'],
        heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 4 }],
        usageRemaining: { starter: 0 },
      }),
      target: {
        kind: 'class_booking',
        accessRule: { type: 'subscription', subscriptionTypeIds: ['starter', 'pack10'] },
      },
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'pack10' }, remaining: 4 }],
        denial: null,
      },
    },
    {
      name: 'unlimited types are untouched: no usageRemaining key, no remaining on the option',
      snapshot: contact({ heldUnmeteredTypeIds: ['starter'] }),
      target: gated,
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'starter' }),
    },
  ])
})

describe('resolvePaymentOptions — review-fix regressions', () => {
  runRows([
    {
      name: 'course included-benefit held only via a CREDIT PACK falls back to pay (no course credit-spend exists)',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 5 }] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120 },
        benefit: { subscriptionTypeIds: ['pack10'], effect: 'included' },
      },
      expected: {
        options: [{ type: 'pay', amount: 120, source: 'course_price' }],
        denial: null,
      },
    },
    {
      name: 'percent_off keeps two-decimal rounding (45 at 33% off -> 30.15)',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 45 },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'percent_off', percent: 33 },
      },
      expected: {
        options: [
          {
            type: 'pay',
            amount: 30.15,
            source: 'base',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 45 },
          },
        ],
        denial: null,
      },
    },
  ])
})

// ─────────────────────────────────────────────────────────────────────────────
// Wave 3 Phase 3 — the `product` arm, the promo modifier, and the B1 fix.
//
// These rows are a MATRIX, not anecdotes: every arm crossed with every promo
// outcome, plus each money edge stated as a value rather than as prose. The
// whole block exists because of one structural fact — the pay option and the
// result both follow an OMITTED-WHEN-ABSENT convention, so any key added
// unconditionally to a pay option breaks ~35 existing rows and any key added
// unconditionally to the result breaks all 60. Nothing above this line was
// touched.
// ─────────────────────────────────────────────────────────────────────────────

interface ContextRow extends Row {
  context?: PaymentContext
}

/** The promo-aware harness. Deliberately a SECOND function rather than a widened
 *  `runRows`, so the sixty pre-existing fixtures and the code that runs them are
 *  provably untouched. */
function runContextRows(rows: ContextRow[]) {
  for (const row of rows) {
    it(row.name, () => {
      assert.deepEqual(resolvePaymentOptions(row.snapshot, row.target, row.context), row.expected)
    })
  }
}

const CODE = 'AUTUMN25'
const ctx = (promo: PromoModifier): PaymentContext => ({ promo })
/** percent_off with a well-formed percent. */
const pct = (percent: number): PromoModifier => ({ code: CODE, effect: 'percent_off', percent })
/** fixed_price with a well-formed amount. */
const fixed = (amount: number): PromoModifier => ({ code: CODE, effect: 'fixed_price', amount })
/** The effect with NO parameter at all — the malformed shape a hand-written or
 *  half-migrated document produces. */
const bare = (effect: PromoEffect): PromoModifier => ({ code: CODE, effect })

describe('resolvePaymentOptions — product arm (Phase 3, B2)', () => {
  const t = (over: Partial<Extract<PaymentTarget, { kind: 'product' }>> = {}): PaymentTarget => ({
    kind: 'product',
    priceAmount: 40,
    ...over,
  })
  runRows([
    {
      name: 'guest pays the product price',
      snapshot: GUEST_SNAPSHOT,
      target: t(),
      expected: { options: [{ type: 'pay', amount: 40, source: 'product' }], denial: null },
    },
    {
      name: 'the arm IGNORES the snapshot — a subscribed member pays the same price',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t(),
      expected: { options: [{ type: 'pay', amount: 40, source: 'product' }], denial: null },
    },
    {
      name: 'a credit-pack holder pays the same price (products never spend credits)',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 5 }] }),
      target: t(),
      expected: { options: [{ type: 'pay', amount: 40, source: 'product' }], denial: null },
    },
    {
      name: 'a variant price is just the resolved price the callable passes in',
      snapshot: GUEST_SNAPSHOT,
      target: t({ priceAmount: 59.9 }),
      expected: { options: [{ type: 'pay', amount: 59.9, source: 'product' }], denial: null },
    },
    {
      name: 'an included benefit can never cover a product (coverage effects are excluded)',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ benefit: { subscriptionTypeIds: ['gold'], effect: 'included' } }),
      expected: { options: [{ type: 'pay', amount: 40, source: 'product' }], denial: null },
    },
    {
      name: 'a spend_credits benefit can never spend on a product either',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 5 }] }),
      target: t({ benefit: { subscriptionTypeIds: ['pack10'], effect: 'spend_credits' } }),
      expected: { options: [{ type: 'pay', amount: 40, source: 'product' }], denial: null },
    },
    {
      name: 'a price-modifying benefit WOULD apply if Product ever carried one',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ benefit: { subscriptionTypeIds: ['gold'], effect: 'percent_off', percent: 25 } }),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 30,
            source: 'product',
            appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 40 },
          },
        ],
        denial: null,
      },
    },
  ])

  it('N6: never covers and never denies — exactly one pay option, for every snapshot', () => {
    const snapshots: ContactPaymentSnapshot[] = [
      GUEST_SNAPSHOT,
      contact(),
      contact({ joined: false }),
      contact({ heldUnmeteredTypeIds: ['gold'] }),
      contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 5 }] }),
      contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 0 }] }),
      contact({ trialUsed: true, ownsCourse: true, usageRemaining: { gold: 0 } }),
    ]
    for (const snapshot of snapshots) {
      const result = resolvePaymentOptions(snapshot, { kind: 'product', priceAmount: 40 })
      assert.equal(result.denial, null)
      assert.equal(result.options.length, 1)
      assert.equal(result.options[0]!.type, 'pay')
    }
  })
})

describe('resolvePaymentOptions — B1: a modifier never raises a price', () => {
  runRows([
    {
      name: 'drop-in: a fixed_price benefit ABOVE base does not apply (used to charge the member 999)',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: {
        kind: 'drop_in',
        accessRule: { type: 'subscription', subscriptionTypeIds: ['gold'] },
        dropIn: { enabled: true, priceAmount: 25 },
        benefit: { subscriptionTypeIds: ['silver'], effect: 'fixed_price', amount: 999 },
      },
      expected: { options: [{ type: 'pay', amount: 25, source: 'drop_in' }], denial: null },
    },
    {
      name: 'drop-in: a fixed_price benefit EXACTLY AT base still stamps appliedBenefit (provenance)',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: {
        kind: 'drop_in',
        accessRule: { type: 'subscription', subscriptionTypeIds: ['gold'] },
        dropIn: { enabled: true, priceAmount: 25 },
        benefit: { subscriptionTypeIds: ['silver'], effect: 'fixed_price', amount: 25 },
      },
      expected: {
        options: [
          {
            type: 'pay',
            amount: 25,
            source: 'drop_in',
            appliedBenefit: { subscriptionTypeId: 'silver', effect: 'fixed_price', baseAmount: 25 },
          },
        ],
        denial: null,
      },
    },
    {
      name: 'appointment: a fixed_price benefit above base does not apply',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'fixed_price', amount: 120 },
      },
      expected: { options: [{ type: 'pay', amount: 95, source: 'base' }], denial: null },
    },
    {
      name: 'course: a fixed_price benefit above base does not apply',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'course',
        accessRule: { type: 'purchase', priceAmount: 120 },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'fixed_price', amount: 200 },
      },
      expected: { options: [{ type: 'pay', amount: 120, source: 'course_price' }], denial: null },
    },
  ])
})

describe('resolvePaymentOptions — promo (Phase 3)', () => {
  const dropIn = (over: Partial<Extract<PaymentTarget, { kind: 'drop_in' }>> = {}): PaymentTarget => ({
    kind: 'drop_in',
    accessRule: { type: 'subscription', subscriptionTypeIds: ['gold', 'pack10'] },
    dropIn: { enabled: true, priceAmount: 25 },
    ...over,
  })
  const memberRate = (percent: number) => ({
    subscriptionTypeIds: ['silver'],
    effect: 'percent_off' as const,
    percent,
  })

  runContextRows([
    // ── one row per arm × applied ─────────────────────────────────────────
    {
      name: 'drop_in applied: 25% off 25.00 → 18.75, appliedPromo carries the base',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(pct(25)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 18.75,
            source: 'drop_in',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 25 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'appointment applied: 25% off 95.00 → 71.25',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'appointment', duration: { minutes: 60, priceAmount: 95 }, benefit: null },
      context: ctx(pct(25)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 71.25,
            source: 'base',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 95 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'course applied: 25% off 120.00 → 90.00',
      snapshot: contact(),
      target: { kind: 'course', accessRule: { type: 'purchase', priceAmount: 120 } },
      context: ctx(pct(25)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 90,
            source: 'course_price',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 120 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'product applied: 25% off 40.00 → 30.00 (the arm B2 added)',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'product', priceAmount: 40 },
      context: ctx(pct(25)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 30,
            source: 'product',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 40 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },

    // ── superseded — and by WHAT, because the two sentences differ ─────────
    {
      name: 'superseded by base: a fixed_price promo ABOVE list never applies (the promo half of B1)',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(fixed(30)),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'superseded', by: 'base' },
      },
    },
    {
      name: 'superseded by base: a fixed_price promo EXACTLY AT list changed nothing',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(fixed(25)),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'superseded', by: 'base' },
      },
    },
    {
      name: 'superseded by benefit: the member rate is lower, and keeps its stamp',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: dropIn({ benefit: memberRate(50) }),
      context: ctx(pct(25)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 12.5,
            source: 'drop_in',
            appliedBenefit: { subscriptionTypeId: 'silver', effect: 'percent_off', baseAmount: 25 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'superseded', by: 'benefit' },
      },
    },
    {
      name: 'a TIE goes to the member benefit — nobody is told their membership stopped mattering',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: dropIn({ benefit: memberRate(20) }),
      context: ctx(fixed(20)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 20,
            source: 'drop_in',
            appliedBenefit: { subscriptionTypeId: 'silver', effect: 'percent_off', baseAmount: 25 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'superseded', by: 'benefit' },
      },
    },
    {
      name: 'promo BEATS the benefit: appliedBenefit is dropped but rides out on supersededBenefit',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: dropIn({ benefit: memberRate(10) }),
      context: ctx(pct(25)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 18.75,
            source: 'drop_in',
            appliedPromo: {
              code: CODE,
              effect: 'percent_off',
              baseAmount: 25,
              supersededBenefit: { subscriptionTypeId: 'silver', effect: 'percent_off' },
            },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'a promo that beats NO benefit carries no supersededBenefit key at all',
      snapshot: contact({ heldUnmeteredTypeIds: ['other'] }),
      target: dropIn({ benefit: memberRate(10) }),
      context: ctx(pct(25)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 18.75,
            source: 'drop_in',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 25 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },

    // ── not_needed: coverage beats every promo, on every arm ──────────────
    {
      name: 'not_needed: a covered member is not sold a discount',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: dropIn(),
      context: ctx(pct(25)),
      expected: {
        ...covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
        promo: { code: CODE, status: 'not_needed' },
      },
    },
    {
      name: 'not_needed: a credit-pack holder spends a credit, price untouched',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 2 }] }),
      target: dropIn(),
      context: ctx(pct(25)),
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'pack10' }, remaining: 2 }],
        denial: null,
        promo: { code: CODE, status: 'not_needed' },
      },
    },
    {
      name: 'not_needed: an unpriced appointment is already free',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'appointment', duration: { minutes: 60 }, benefit: null },
      context: ctx(pct(25)),
      expected: {
        ...covered({ reason: 'unpriced' }),
        promo: { code: CODE, status: 'not_needed' },
      },
    },
    {
      name: 'not_needed: an included benefit covers the appointment before any comparison',
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['gold'], effect: 'included' },
      },
      context: ctx(pct(25)),
      expected: {
        ...covered({ reason: 'benefit_included', subscriptionTypeId: 'gold' }),
        promo: { code: CODE, status: 'not_needed' },
      },
    },
    {
      name: 'not_needed: a free-tier course',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'course', accessRule: { type: 'free' } },
      context: ctx(pct(25)),
      expected: {
        ...covered({ reason: 'free_tier' }),
        promo: { code: CODE, status: 'not_needed' },
      },
    },

    // ── not_applicable: the trial door, the arms that never price, denials ─
    {
      name: 'not_applicable: a promo NEVER stacks on a paid trial',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn({ asTrial: true, trial: { enabled: true, priceAmount: 15 }, dropIn: null }),
      context: ctx(pct(25)),
      expected: {
        options: [{ type: 'pay', amount: 15, source: 'trial' }],
        denial: null,
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
    {
      name: 'not_applicable: class_booking takes no promo, and is otherwise byte-identical',
      snapshot: contact(),
      target: { kind: 'class_booking', accessRule: { type: 'members' } },
      context: ctx(pct(25)),
      expected: {
        ...covered({ reason: 'members' }),
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
    {
      name: 'not_applicable: a class_booking DENIAL is not "not_needed" either',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'class_booking', accessRule: { type: 'members' } },
      context: ctx(pct(25)),
      expected: { ...denied('guest'), promo: { code: CODE, status: 'not_applicable' } },
    },
    {
      name: 'not_applicable: a drop-in denial has no price for a code to modify',
      snapshot: contact(),
      target: dropIn({ dropIn: null }),
      context: ctx(pct(25)),
      expected: {
        ...denied('no_subscription'),
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
    {
      name: 'not_applicable: a course the caller must sign in for',
      snapshot: GUEST_SNAPSHOT,
      target: { kind: 'course', accessRule: { type: 'registered' } },
      context: ctx(pct(25)),
      expected: {
        ...denied('sign_in_required'),
        promo: { code: CODE, status: 'not_applicable' },
      },
    },

    // ── percent_off money edges ───────────────────────────────────────────
    {
      name: 'percent_off clamps to the 0.50 floor, never to free',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn({ dropIn: { enabled: true, priceAmount: 1 } }),
      context: ctx(pct(90)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: MIN_CHARGE_MAJOR,
            source: 'drop_in',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 1 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'percent_off >= 100 clamps to the floor (the backstop; creation caps it at 99)',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(pct(150)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: MIN_CHARGE_MAJOR,
            source: 'drop_in',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 25 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'ROUNDING, pinned as a value: 15% off 33.30 is 28.30, not 28.31',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn({ dropIn: { enabled: true, priceAmount: 33.3 } }),
      context: ctx(pct(15)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 28.3,
            source: 'drop_in',
            appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 33.3 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'malformed percent (zero): not applied, and never "applied as zero"',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(pct(0)),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
    {
      name: 'malformed percent (negative): not applied',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(pct(-10)),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
    {
      name: 'malformed percent (non-finite): not applied, never NaN',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(pct(Number.NaN)),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
    {
      name: 'malformed percent (missing): not applied',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(bare('percent_off')),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'not_applicable' },
      },
    },

    // ── fixed_price money edges ───────────────────────────────────────────
    {
      name: 'fixed_price below list applies',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(fixed(9.9)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: 9.9,
            source: 'drop_in',
            appliedPromo: { code: CODE, effect: 'fixed_price', baseAmount: 25 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'fixed_price below the 0.50 floor clamps up (the backstop; creation throws)',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(fixed(0.1)),
      expected: {
        options: [
          {
            type: 'pay',
            amount: MIN_CHARGE_MAJOR,
            source: 'drop_in',
            appliedPromo: { code: CODE, effect: 'fixed_price', baseAmount: 25 },
          },
        ],
        denial: null,
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: 'malformed amount (non-finite): not applied',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(fixed(Number.NaN)),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
    {
      name: 'malformed amount (missing): not applied',
      snapshot: GUEST_SNAPSHOT,
      target: dropIn(),
      context: ctx(bare('fixed_price')),
      expected: {
        options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
        denial: null,
        promo: { code: CODE, status: 'not_applicable' },
      },
    },
  ])

  it('a promo-free call carries NO promo key — the convention the 60 fixtures rest on', () => {
    const target: PaymentTarget = {
      kind: 'drop_in',
      accessRule: { type: 'subscription', subscriptionTypeIds: ['gold'] },
      dropIn: { enabled: true, priceAmount: 25 },
    }
    const bare2: PaymentOptionsResult = {
      options: [{ type: 'pay', amount: 25, source: 'drop_in' }],
      denial: null,
    }
    assert.deepEqual(resolvePaymentOptions(GUEST_SNAPSHOT, target), bare2)
    assert.deepEqual(resolvePaymentOptions(GUEST_SNAPSHOT, target, {}), bare2)
    assert.deepEqual(resolvePaymentOptions(GUEST_SNAPSHOT, target, { promo: null }), bare2)
  })

  it('N4/N5: applied ⟺ exactly one option carries appliedPromo, and no price ever rises', () => {
    const bases = [0.5, 1, 25, 33.3, 95, 120]
    const modifiers: PromoModifier[] = [pct(1), pct(25), pct(99), fixed(0.5), fixed(24), fixed(999)]
    for (const base of bases) {
      for (const promo of modifiers) {
        const result = resolvePaymentOptions(
          GUEST_SNAPSHOT,
          { kind: 'product', priceAmount: base },
          ctx(promo)
        )
        const option = result.options[0]!
        assert.equal(result.options.length, 1)
        assert.equal(option.type, 'pay')
        if (option.type !== 'pay') continue
        assert.ok(option.amount <= base, `${option.amount} <= ${base}`)
        assert.equal(result.promo?.status === 'applied', Boolean(option.appliedPromo))
        assert.equal(option.appliedBenefit ?? null, null)
      }
    }
  })
})

// A member holding several plans that each cover the same thing uses the BEST
// one, never the first the rule lists (docs/multi-plan-holdings.md §2.5, D3).
// Every row lists the worse plan first, so first-listed would get it wrong.
describe('resolvePaymentOptions — best plan, not first plan (D3)', () => {
  const classWith = (ids: string[]): PaymentTarget => ({
    kind: 'class_booking',
    accessRule: { type: 'subscription', subscriptionTypeIds: ids },
  })
  runRows([
    {
      name: 'an unlimited plan covers before a limited one listed first',
      snapshot: contact({ heldUnmeteredTypeIds: ['starter', 'gold'], usageRemaining: { starter: 3 } }),
      target: classWith(['starter', 'gold']),
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'between limited plans, the one with the most allowance left covers',
      snapshot: contact({ heldUnmeteredTypeIds: ['small', 'big'], usageRemaining: { small: 1, big: 5 } }),
      target: classWith(['small', 'big']),
      expected: {
        options: [
          { type: 'covered', via: { reason: 'subscription', subscriptionTypeId: 'big' }, remaining: 4 } as never,
        ],
        denial: null,
      },
    },
    {
      name: 'between credit packs, the one lapsing soonest is spent; a pack with no end goes last',
      snapshot: contact({
        heldCreditTypes: [
          { subscriptionTypeId: 'forever', remaining: 9 },
          { subscriptionTypeId: 'late', remaining: 5, expiresAtMs: 2_000 },
          { subscriptionTypeId: 'soon', remaining: 2, expiresAtMs: 1_000 },
        ],
      }),
      target: classWith(['forever', 'late', 'soon']),
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'soon' }, remaining: 2 }],
        denial: null,
      },
    },
    {
      name: 'equally good plans keep the rule order',
      snapshot: contact({ heldUnmeteredTypeIds: ['platinum', 'gold'] }),
      target: classWith(['gold', 'platinum']),
      expected: covered({ reason: 'subscription', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'an included benefit is covered by a held subscription before a pack listed first spends a credit',
      snapshot: contact({
        heldUnmeteredTypeIds: ['gold'],
        heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 5 }],
      }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['pack10', 'gold'], effect: 'included' },
      },
      expected: covered({ reason: 'benefit_included', subscriptionTypeId: 'gold' }),
    },
    {
      name: 'a spend_credits benefit spends the pack lapsing soonest',
      snapshot: contact({
        heldCreditTypes: [
          { subscriptionTypeId: 'late', remaining: 5, expiresAtMs: 2_000 },
          { subscriptionTypeId: 'soon', remaining: 3, expiresAtMs: 1_000 },
        ],
      }),
      target: {
        kind: 'appointment',
        duration: { minutes: 60, priceAmount: 95 },
        benefit: { subscriptionTypeIds: ['late', 'soon'], effect: 'spend_credits' },
      },
      expected: {
        options: [{ type: 'spend_credits', via: { subscriptionTypeId: 'soon' }, remaining: 3 }],
        denial: null,
      },
    },
  ])
})
