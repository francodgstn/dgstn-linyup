import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  holdsOwnPlan,
  holdsPartnerPlan,
  isPartnerSubscriptionType,
  partnerSubscriptionTypeIds,
} from '@linyup/shared'

// "Subscribed" means on one of the studio's OWN plans. A partner-app type
// (source: 'aggregator') is a subscription the studio did not sell, and
// counting its holders as subscribers flattered every headcount. These pin the
// ONE predicate and the two counts that read it.
// Run with: pnpm --filter @linyup/functions test

const SRC = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const FIGURES = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'src', 'components', 'dashboard-preview', 'FiguresBlock.tsx'),
  'utf8',
)

const TYPES = [
  { id: 'monthly', source: 'internal' },
  { id: 'comp', source: null },
  { id: 'legacy' },
  { id: 'fitpass', source: 'aggregator' },
  { id: 'classpass', source: 'aggregator' },
]

describe('subscription source — the predicate', () => {
  it("only source: 'aggregator' is a partner type; absent, null and 'internal' are the studio's own", () => {
    assert.equal(isPartnerSubscriptionType({ source: 'aggregator' }), true)
    assert.equal(isPartnerSubscriptionType({ source: 'internal' }), false)
    assert.equal(isPartnerSubscriptionType({ source: null }), false)
    assert.equal(isPartnerSubscriptionType({}), false)
    assert.deepEqual([...partnerSubscriptionTypeIds(TYPES)].sort(), ['classpass', 'fitpass'])
  })

  it('a person is subscribed when at least one live plan is the studio\'s own — a partner plan alone is not', () => {
    const partner = partnerSubscriptionTypeIds(TYPES)
    assert.equal(holdsOwnPlan([{ subscription_type_id: 'monthly' }], partner), true)
    assert.equal(holdsOwnPlan([{ subscription_type_id: 'fitpass' }], partner), false)
    assert.equal(holdsOwnPlan([{ subscription_type_id: 'fitpass' }, { subscription_type_id: 'comp' }], partner), true)
    assert.equal(holdsOwnPlan([], partner), false)
    assert.equal(holdsOwnPlan(undefined, partner), false)
  })

  it('and may hold both — the two counts overlap by design, neither is the other\'s complement', () => {
    const partner = partnerSubscriptionTypeIds(TYPES)
    const both = [{ subscription_type_id: 'monthly' }, { subscription_type_id: 'classpass' }]
    assert.equal(holdsOwnPlan(both, partner), true)
    assert.equal(holdsPartnerPlan(both, partner), true)
    assert.equal(holdsPartnerPlan([{ subscription_type_id: 'monthly' }], partner), false)
    assert.equal(holdsPartnerPlan(null, partner), false)
  })

  it('with no partner types at all, every live plan is the studio\'s own', () => {
    const none = partnerSubscriptionTypeIds([{ id: 'monthly', source: 'internal' }])
    assert.equal(none.size, 0)
    assert.equal(holdsOwnPlan([{ subscription_type_id: 'anything' }], none), true)
    assert.equal(holdsPartnerPlan([{ subscription_type_id: 'anything' }], none), false)
  })
})

describe('the counts that read it', () => {
  it('the weekly report headline is holdsOwnPlan, the partner figure holdsPartnerPlan, and both are written', () => {
    assert.match(SRC, /contacts_with_active_subscription = contacts\.filter\(\(c\) => holdsOwnPlan\(liveSubs\(c\), partnerIds\)\)/)
    assert.match(SRC, /contacts_with_aggregator_subscription = contacts\.filter\(\(c\) => holdsPartnerPlan\(liveSubs\(c\), partnerIds\)\)/)
    assert.match(SRC, /^\s+contacts_with_active_subscription,\r?\n\s+contacts_with_aggregator_subscription,/m)
    assert.doesNotMatch(SRC, /active_subscriptions[^\n]*\.length > 0\s*\)\.length/, 'no raw "has any live plan" count survives')
  })

  it('the per-type map is untouched — a partner type is honest by NAME', () => {
    assert.match(SRC, /contacts_count_by_subscription_type = countByDistinctKeys\(contacts, \(c\) => \{\s*const subs = /)
  })

  it("the dashboard preview's figure reads the same predicate rather than its own copy", () => {
    assert.match(FIGURES, /partnerSubscriptionTypeIds\(subTypes/)
    assert.doesNotMatch(FIGURES, /=== 'aggregator'/)
  })
})
