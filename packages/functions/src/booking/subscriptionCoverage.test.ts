import assert from 'node:assert/strict'
import {
  classAccessFacts,
  contactHoldsCoveringSubscription,
  type HeldPlan,
  type SubscriptionCoverageSnapshot,
} from '@linyup/shared'

const NOW = 1_800_000_000_000

function plan(p: Partial<HeldPlan> & Pick<HeldPlan, 'subscription_type_id' | 'source'>): HeldPlan {
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

// `activityRequiresSubscription` was removed (class-access stage 5,
// docs/class-access-derived.md): "plan required" is now DERIVED, so callers
// read it off `classAccessFacts(...).planHoldersOnly` / `.includedPlanIds`
// instead of a stored/legacy-tier answer.
describe('classAccessFacts — plan-holders-only, derived', () => {
  it('open and members rules with no linked plans are not plan-holders-only', () => {
    assert.equal(classAccessFacts({ type: 'class', accessRule: { type: 'open' } }, null).planHoldersOnly, false)
    assert.equal(classAccessFacts({ type: 'class', accessRule: { type: 'members' } }, null).planHoldersOnly, false)
    assert.equal(classAccessFacts({ type: 'class' }, null).planHoldersOnly, false)
  })

  it('a subscription rule with ids and no door is plan-holders-only, and names the ids', () => {
    const facts = classAccessFacts(
      { type: 'class', accessRule: { type: 'subscription', subscriptionTypeIds: ['a', 'b'] } },
      null
    )
    assert.equal(facts.planHoldersOnly, true)
    assert.deepEqual(facts.includedPlanIds, ['a', 'b'])
  })

  it('a subscription rule with NO ids has nothing to gate on, so it is not plan-holders-only', () => {
    const facts = classAccessFacts({ type: 'class', accessRule: { type: 'subscription' } }, null)
    assert.equal(facts.planHoldersOnly, false)
    assert.deepEqual(facts.includedPlanIds, [])
  })
})

// Coverage reads the contact's plan list (docs/multi-plan-holdings.md, phase 3):
// every holding in one place, each compared against the clock rather than
// trusted as stored.
describe('contactHoldsCoveringSubscription', () => {
  it('is false for a missing contact or empty allow-list', () => {
    assert.equal(contactHoldsCoveringSubscription(null, ['a'], NOW), false)
    assert.equal(contactHoldsCoveringSubscription({}, [], NOW), false)
    assert.equal(contactHoldsCoveringSubscription({}, null, NOW), false)
  })

  it('matches a plan held through a grant or a Stripe subscription', () => {
    const contact = {
      held_plans: [plan({ subscription_type_id: 'a', source: 'grant' }), plan({ subscription_type_id: 'b', source: 'stripe' })],
    }
    assert.equal(contactHoldsCoveringSubscription(contact, ['a'], NOW), true)
    assert.equal(contactHoldsCoveringSubscription(contact, ['b'], NOW), true)
    assert.equal(contactHoldsCoveringSubscription(contact, ['c'], NOW), false)
  })

  it('matches a credit pack with credits left, and not one that has run out', () => {
    const left = { held_plans: [plan({ subscription_type_id: 'pack', source: 'credits', credits_remaining: 3 })] }
    const none = { held_plans: [plan({ subscription_type_id: 'pack', source: 'credits', credits_remaining: 0 })] }
    assert.equal(contactHoldsCoveringSubscription(left, ['pack'], NOW), true)
    assert.equal(contactHoldsCoveringSubscription(none, ['pack'], NOW), false)
  })

  it('ignores an entry that has ended or has not started yet', () => {
    const ended = { held_plans: [plan({ subscription_type_id: 'a', source: 'grant', ends_at_ms: NOW })] }
    const future = { held_plans: [plan({ subscription_type_id: 'a', source: 'grant', starts_at_ms: NOW + 1 })] }
    const running = { held_plans: [plan({ subscription_type_id: 'a', source: 'grant', ends_at_ms: NOW + 1 })] }
    assert.equal(contactHoldsCoveringSubscription(ended, ['a'], NOW), false)
    assert.equal(contactHoldsCoveringSubscription(future, ['a'], NOW), false)
    assert.equal(contactHoldsCoveringSubscription(running, ['a'], NOW), true)
  })

  it('reads nothing but the plan list: the legacy slot alone holds nothing', () => {
    const slotOnly = { subscription_type_id: 'a' } as unknown as SubscriptionCoverageSnapshot
    assert.equal(contactHoldsCoveringSubscription(slotOnly, ['a'], NOW), false)
  })
})
