import assert from 'node:assert/strict'
import {
  currentHeldPlans,
  heldSubscriptionTypeIds,
  holdingIsCurrent,
  paymentHoldingsByType,
  type HeldPlan,
} from '@linyup/shared'

// The readers of the plan list (docs/multi-plan-holdings.md, phase 3). The
// mirror is exact when it is built, but nothing writes when a grant ends or a
// pack expires — so every reader compares the stored instants against the
// clock through `holdingIsCurrent`, and these pin that comparison.

const NOW = Date.UTC(2026, 8, 14, 12)

function plan(p: Pick<HeldPlan, 'subscription_type_id' | 'source'> & Partial<HeldPlan>): HeldPlan {
  return {
    subscription_type_name: null,
    status: 'active',
    starts_at_ms: null,
    ends_at_ms: null,
    price_id: null,
    amount: null,
    recurrence: null,
    ref: p.subscription_type_id,
    ...p,
  }
}

describe('plan list readers — held now', () => {
  it('an entry is held from its start up to, not including, its end', () => {
    assert.equal(holdingIsCurrent(plan({ subscription_type_id: 'a', source: 'grant' }), NOW), true)
    assert.equal(holdingIsCurrent(plan({ subscription_type_id: 'a', source: 'grant', starts_at_ms: NOW + 1 }), NOW), false)
    assert.equal(holdingIsCurrent(plan({ subscription_type_id: 'a', source: 'grant', ends_at_ms: NOW }), NOW), false)
    assert.equal(holdingIsCurrent(plan({ subscription_type_id: 'a', source: 'stripe', ends_at_ms: NOW + 1 }), NOW), true)
  })

  it('a credit pack is held only while it has credits', () => {
    assert.equal(holdingIsCurrent(plan({ subscription_type_id: 'p', source: 'credits', credits_remaining: 1 }), NOW), true)
    assert.equal(holdingIsCurrent(plan({ subscription_type_id: 'p', source: 'credits', credits_remaining: 0 }), NOW), false)
    assert.equal(holdingIsCurrent(plan({ subscription_type_id: 'p', source: 'credits' }), NOW), false)
  })

  it('the SAME stored list answers differently later, with no write in between', () => {
    const contact = { held_plans: [plan({ subscription_type_id: 'intro', source: 'grant', ends_at_ms: NOW + 1000 })] }
    assert.deepEqual(heldSubscriptionTypeIds(contact, NOW), ['intro'])
    assert.deepEqual(heldSubscriptionTypeIds(contact, NOW + 1000), [])
    assert.equal(currentHeldPlans(contact, NOW + 1000).length, 0)
  })

  it('lists each type once, however many entries hold it', () => {
    const contact = {
      held_plans: [
        plan({ subscription_type_id: 'gold', source: 'grant' }),
        plan({ subscription_type_id: 'gold', source: 'stripe', ref: 'sub_1' }),
      ],
    }
    assert.deepEqual(heldSubscriptionTypeIds(contact, NOW), ['gold'])
  })

  it('no list, no plans', () => {
    assert.deepEqual(heldSubscriptionTypeIds(null, NOW), [])
    assert.deepEqual(heldSubscriptionTypeIds({}, NOW), [])
  })
})

describe('plan list readers — what the payment snapshot sees', () => {
  it('groups the held entries by type: the grant prices, whether a plan holds it, and the pack', () => {
    const contact = {
      held_plans: [
        plan({ subscription_type_id: 'gold', source: 'grant', price_id: 'monthly' }),
        plan({ subscription_type_id: 'gold', source: 'grant', price_id: 'annual', ref: 'g2' }),
        plan({ subscription_type_id: 'gold', source: 'stripe', ref: 'sub_1' }),
        plan({ subscription_type_id: 'pack10', source: 'credits', credits_remaining: 4, ends_at_ms: NOW + 5000 }),
      ],
    }
    const holdings = paymentHoldingsByType(contact, NOW)
    assert.deepEqual(holdings.get('gold'), { priceIds: ['monthly', 'annual'], heldAsPlan: true, credits: null })
    assert.deepEqual(holdings.get('pack10'), {
      priceIds: [],
      heldAsPlan: false,
      credits: { remaining: 4, expiresAtMs: NOW + 5000 },
    })
  })

  it('a pack bought as a plan is held BOTH as a plan (for its price) and as credits', () => {
    const contact = {
      held_plans: [
        plan({ subscription_type_id: 'pack10', source: 'grant', price_id: 'ten' }),
        plan({ subscription_type_id: 'pack10', source: 'credits', credits_remaining: 7 }),
      ],
    }
    assert.deepEqual(paymentHoldingsByType(contact, NOW).get('pack10'), {
      priceIds: ['ten'],
      heldAsPlan: true,
      credits: { remaining: 7, expiresAtMs: null },
    })
  })

  it('leaves out what is not held now', () => {
    const contact = {
      held_plans: [
        plan({ subscription_type_id: 'ended', source: 'grant', ends_at_ms: NOW }),
        plan({ subscription_type_id: 'spent', source: 'credits', credits_remaining: 0 }),
      ],
    }
    assert.equal(paymentHoldingsByType(contact, NOW).size, 0)
  })
})
