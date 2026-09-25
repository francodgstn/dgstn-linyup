import assert from 'node:assert/strict'
import {
  buildHeldPlans,
  planGrantIsHeld,
  type HeldPlanMemberSubscriptionInput,
  type HeldPlansInput,
  type PlanGrantInput,
} from '@linyup/shared'

// buildHeldPlans — the ONE builder of a contact's plan list
// (docs/multi-plan-holdings.md, phase 1). Pure, so every rule it applies is
// pinned here: which grants are held, how same-type grants merge, how Stripe
// and credit packs become entries, the order, and the next-change marker.

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0)
const DAY = 86_400_000
const at = (millis: number) => ({ toMillis: () => millis })

function grant(partial: Partial<PlanGrantInput> & { id: string }): PlanGrantInput {
  return {
    subscription_type_id: 'plan-a',
    subscription_type_name: 'Plan A',
    price_id: 'price-a',
    recurrence: 'monthly',
    amount: 89,
    source: 'staff',
    starts_at: at(NOW - 30 * DAY),
    expires_at: null,
    ended_at: null,
    ...partial,
  }
}

function stripe(partial: Partial<HeldPlanMemberSubscriptionInput> = {}): HeldPlanMemberSubscriptionInput {
  return {
    subscriptionId: 'sub_1',
    subscriptionTypeId: 'plan-s',
    subscriptionTypeName: 'Stripe Plan',
    recurrence: 'monthly',
    amount: 8900,
    status: 'active',
    current_period_end: at(NOW + 20 * DAY) as never,
    ...partial,
  }
}

function build(partial: Partial<HeldPlansInput>) {
  return buildHeldPlans({ grants: [], memberSubscriptions: [], creditSummary: [], nowMs: NOW, ...partial })
}

describe('buildHeldPlans — grants', () => {
  it('an open grant is held; an ended, expired or not-yet-started one is not', () => {
    assert.equal(planGrantIsHeld(grant({ id: 'g' }), NOW), true)
    assert.equal(planGrantIsHeld(grant({ id: 'g', ended_at: at(NOW - DAY) }), NOW), false)
    assert.equal(planGrantIsHeld(grant({ id: 'g', expires_at: at(NOW - 1) }), NOW), false)
    assert.equal(planGrantIsHeld(grant({ id: 'g', starts_at: at(NOW + DAY) }), NOW), false)
    assert.equal(planGrantIsHeld(grant({ id: 'g', expires_at: at(NOW + DAY) }), NOW), true)
  })

  it('a held grant becomes one entry carrying its own fields', () => {
    const m = build({ grants: [grant({ id: 'g1', expires_at: at(NOW + 10 * DAY) })] })
    assert.deepEqual(m.held_plans, [
      {
        subscription_type_id: 'plan-a',
        subscription_type_name: 'Plan A',
        source: 'grant',
        grant_source: 'staff',
        status: 'active',
        starts_at_ms: NOW - 30 * DAY,
        ends_at_ms: NOW + 10 * DAY,
        price_id: 'price-a',
        amount: 89,
        recurrence: 'monthly',
        ref: 'g1',
      },
    ])
    assert.deepEqual(m.held_plan_type_ids, ['plan-a'])
    assert.equal(m.held_plans_next_change_at_ms, NOW + 10 * DAY)
  })

  it('two grants of one type merge: the latest end wins, the earliest start stays (D4)', () => {
    const m = build({
      grants: [
        grant({ id: 'early', starts_at: at(NOW - 30 * DAY), expires_at: at(NOW + 10 * DAY) }),
        grant({ id: 'late', starts_at: at(NOW - 5 * DAY), expires_at: at(NOW + 40 * DAY), source: 'purchase' }),
      ],
    })
    assert.equal(m.held_plans.length, 1)
    assert.equal(m.held_plans[0].ref, 'late')
    assert.equal(m.held_plans[0].grant_source, 'purchase')
    assert.equal(m.held_plans[0].ends_at_ms, NOW + 40 * DAY)
    assert.equal(m.held_plans[0].starts_at_ms, NOW - 30 * DAY)
  })

  it('a grant with no end of its own beats one that ends', () => {
    const m = build({
      grants: [grant({ id: 'ends', expires_at: at(NOW + 400 * DAY) }), grant({ id: 'open', expires_at: null })],
    })
    assert.equal(m.held_plans[0].ref, 'open')
    assert.equal(m.held_plans[0].ends_at_ms, null)
  })

  it('a future grant is not held yet, but the list changes when it starts', () => {
    const m = build({ grants: [grant({ id: 'soon', starts_at: at(NOW + 3 * DAY) })] })
    assert.deepEqual(m.held_plans, [])
    assert.equal(m.held_plans_next_change_at_ms, NOW + 3 * DAY)
  })
})

describe('buildHeldPlans — Stripe subscriptions', () => {
  it('a live subscription is an entry with its next charge, in major units', () => {
    const [e] = build({ memberSubscriptions: [stripe()] }).held_plans
    assert.equal(e.source, 'stripe')
    assert.equal(e.status, 'active')
    assert.equal(e.amount, 89)
    assert.equal(e.next_charge_at_ms, NOW + 20 * DAY)
    assert.equal(e.ends_at_ms, null)
    assert.equal(e.ref, 'sub_1')
  })

  it('a canceling subscription says when it ends and does not charge again', () => {
    const [e] = build({ memberSubscriptions: [stripe({ cancel_at_period_end: true })] }).held_plans
    assert.equal(e.status, 'cancelling')
    assert.equal(e.ends_at_ms, NOW + 20 * DAY)
    assert.equal(e.next_charge_at_ms, null)
  })

  it('a paused subscription stays held without a next charge', () => {
    const [e] = build({ memberSubscriptions: [stripe({ pause_collection: { behavior: 'void' } })] }).held_plans
    assert.equal(e.status, 'paused')
    assert.equal(e.next_charge_at_ms, null)
  })

  it('a canceled, duplicate or untyped subscription is not held', () => {
    const m = build({
      memberSubscriptions: [
        stripe({ subscriptionId: 'c', status: 'canceled' }),
        stripe({ subscriptionId: 'd', duplicate: true }),
        stripe({ subscriptionId: 'u', subscriptionTypeId: null }),
      ],
    })
    assert.deepEqual(m.held_plans, [])
  })

  it('Stripe dates are events, not scheduled changes: they do not set the marker', () => {
    const m = build({ memberSubscriptions: [stripe({ cancel_at_period_end: true })] })
    assert.equal(m.held_plans_next_change_at_ms, null)
  })
})

describe('buildHeldPlans — credit packs', () => {
  it('a pack with lessons left is an entry; an exhausted or expired one is not', () => {
    const m = build({
      creditSummary: [
        { subscription_type_id: 'pack-a', subscription_type_name: 'Ten-pack', remaining: 4, next_expires_at: at(NOW + 60 * DAY) as never },
        { subscription_type_id: 'pack-b', subscription_type_name: 'Empty', remaining: 0, next_expires_at: null },
        { subscription_type_id: 'pack-c', subscription_type_name: 'Lapsed', remaining: 3, next_expires_at: at(NOW - 1) as never },
      ],
    })
    assert.equal(m.held_plans.length, 1)
    assert.equal(m.held_plans[0].source, 'credits')
    assert.equal(m.held_plans[0].credits_remaining, 4)
    assert.equal(m.held_plans[0].ends_at_ms, NOW + 60 * DAY)
    assert.equal(m.held_plans_next_change_at_ms, NOW + 60 * DAY)
  })
})

describe('buildHeldPlans — the whole list', () => {
  it('orders grants, then Stripe, then credits, and lists each type id once, sorted', () => {
    const m = build({
      grants: [grant({ id: 'g', subscription_type_id: 'plan-z' })],
      memberSubscriptions: [stripe({ subscriptionTypeId: 'plan-z' })],
      creditSummary: [{ subscription_type_id: 'plan-b', subscription_type_name: 'B', remaining: 2, next_expires_at: null }],
    })
    assert.deepEqual(
      m.held_plans.map((e) => e.source),
      ['grant', 'stripe', 'credits']
    )
    assert.deepEqual(m.held_plan_type_ids, ['plan-b', 'plan-z'])
  })

  it('the next change is the soonest of a grant ending, a grant starting and a pack expiring', () => {
    const m = build({
      grants: [
        grant({ id: 'ends', expires_at: at(NOW + 9 * DAY) }),
        grant({ id: 'starts', subscription_type_id: 'plan-b', starts_at: at(NOW + 4 * DAY) }),
      ],
      creditSummary: [{ subscription_type_id: 'pack', subscription_type_name: 'P', remaining: 1, next_expires_at: at(NOW + 6 * DAY) as never }],
    })
    assert.equal(m.held_plans_next_change_at_ms, NOW + 4 * DAY)
  })

  it('an empty contact has an empty list and no marker', () => {
    assert.deepEqual(build({}), { held_plans: [], held_plan_type_ids: [], held_plans_next_change_at_ms: null })
  })

  it('carries no undefined value, which Firestore would refuse', () => {
    const m = build({
      grants: [grant({ id: 'g', source: null })],
      memberSubscriptions: [stripe()],
      creditSummary: [{ subscription_type_id: 'p', subscription_type_name: null, remaining: 1, next_expires_at: null }],
    })
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m)
  })
})
