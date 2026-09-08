import assert from 'node:assert/strict'
import {
  GUEST_SNAPSHOT,
  resolvePaymentOptions,
  type ActivityAccessRule,
  type ContactPaymentSnapshot,
} from '@linyup/shared'

// ─── WHO MAY BOOK A CLASS ────────────────────────────────────────────────────
//
// The gate asks two questions — may this person book at all (`audience`), and
// must she hold a plan (`requirePlan`) — and what she PAYS is not one of them: a
// covering plan makes it free, and everyone else pays the drop-in price if one
// exists. So "free" is the absence of a price.
//
// The old single tier could not say one thing a studio routinely wants: MEMBERS
// ONLY, WITH A PAID DOOR. `members` made every member free, so the price never
// fired; `subscription` let a stranger buy in. That cell is the reason this
// exists, and the first suite below is it.
//
// The second suite is the other half of the promise: a document that predates
// these fields behaves EXACTLY as it did. Both halves matter — a gate that gets
// the new cell right by quietly moving an old one is not a fix.

const member = (over: Partial<ContactPaymentSnapshot> = {}): ContactPaymentSnapshot => ({
  authenticated: true,
  joined: true,
  heldUnmeteredTypeIds: [],
  heldCreditTypes: [],
  ...over,
})

const DROP_IN = { enabled: true, priceAmount: 25 }

const dropInTarget = (accessRule: ActivityAccessRule, over: Record<string, unknown> = {}) =>
  ({ kind: 'drop_in' as const, accessRule, dropIn: DROP_IN, ...over })

const bookTarget = (accessRule: ActivityAccessRule, dropIn: unknown = DROP_IN) =>
  ({ kind: 'class_booking' as const, accessRule, dropIn }) as never

describe('the class gate — members only, with a paid door', () => {
  // The cell the old tiers could not express.
  const rule: ActivityAccessRule = {
    type: 'members',
    audience: 'members',
    requirePlan: false,
    subscriptionTypeIds: ['unlimited'],
  }

  it('a member holding the plan trains free', () => {
    const r = resolvePaymentOptions(member({ heldUnmeteredTypeIds: ['unlimited'] }), bookTarget(rule))
    assert.equal(r.options[0]?.type, 'covered')
  })

  it('a member holding NO plan is not covered — she pays the drop-in', () => {
    assert.equal(resolvePaymentOptions(member(), bookTarget(rule)).denial, 'no_subscription')
    const paid = resolvePaymentOptions(member(), dropInTarget(rule))
    assert.deepEqual(paid.options, [{ type: 'pay', amount: 25, source: 'drop_in' }])
  })

  it('A GUEST IS REFUSED — even with the price in hand', () => {
    // The leak this shape closes: until now the paid door was open to everyone
    // the moment a price existed, whatever the class said about membership.
    assert.equal(resolvePaymentOptions(GUEST_SNAPSHOT, dropInTarget(rule)).options.length, 0)
    assert.equal(resolvePaymentOptions(GUEST_SNAPSHOT, dropInTarget(rule)).denial, 'guest')
  })

  it('…but a TRIAL still gets through, because that is how she becomes a member', () => {
    const r = resolvePaymentOptions(
      GUEST_SNAPSHOT,
      dropInTarget(rule, { asTrial: true, trial: { enabled: true, priceAmount: 10 } })
    )
    assert.deepEqual(r.options, [{ type: 'pay', amount: 10, source: 'trial' }])
  })

  it('with NO price, the same rule is simply free for every member', () => {
    const free = { ...rule, subscriptionTypeIds: [] }
    const r = resolvePaymentOptions(member(), bookTarget(free, null))
    assert.deepEqual(r.options, [{ type: 'covered', via: { reason: 'members' } }])
  })
})

describe('the class gate — a plan is REQUIRED', () => {
  const rule: ActivityAccessRule = {
    type: 'subscription',
    audience: 'members',
    requirePlan: true,
    subscriptionTypeIds: ['unlimited'],
  }

  it('a holder trains free', () => {
    const r = resolvePaymentOptions(member({ heldUnmeteredTypeIds: ['unlimited'] }), bookTarget(rule))
    assert.equal(r.options[0]?.type, 'covered')
  })

  it('someone with no plan cannot buy their way in', () => {
    // The difference from the suite above: there, the drop-in was the way in for
    // a member without a plan. Here there is no way in at all.
    const r = resolvePaymentOptions(member(), dropInTarget(rule))
    assert.equal(r.options.length, 0)
    assert.equal(r.denial, 'no_subscription')
  })

  it('a DISCOUNTED plan still gets through the door, and pays its rate', () => {
    // A plan that only earns a rate is still a plan. Reading only the access
    // list would turn its holder away at a class her membership is linked to.
    const r = resolvePaymentOptions(
      member({ heldUnmeteredTypeIds: ['pack10'] }),
      dropInTarget(rule, {
        benefit: { subscriptionTypeIds: ['pack10'], effect: 'percent_off', percent: 20 },
      })
    )
    assert.equal(r.options[0]?.type, 'pay')
    assert.equal((r.options[0] as { amount: number }).amount, 20)
  })
})

describe('a document that predates the two fields is untouched', () => {
  it('open stays free even with a stray drop-in price', () => {
    const r = resolvePaymentOptions(GUEST_SNAPSHOT, dropInTarget({ type: 'open' }))
    assert.deepEqual(r.options, [{ type: 'covered', via: { reason: 'open' } }])
  })

  it('members stays free for members, and a guest may still pay', () => {
    const rule: ActivityAccessRule = { type: 'members' }
    assert.deepEqual(resolvePaymentOptions(member(), bookTarget(rule)).options, [
      { type: 'covered', via: { reason: 'members' } },
    ])
    assert.deepEqual(resolvePaymentOptions(GUEST_SNAPSHOT, dropInTarget(rule)).options, [
      { type: 'pay', amount: 25, source: 'drop_in' },
    ])
  })

  it('subscription still denies a non-holder, and still sells them a drop-in', () => {
    const rule: ActivityAccessRule = { type: 'subscription', subscriptionTypeIds: ['unlimited'] }
    assert.equal(resolvePaymentOptions(member(), bookTarget(rule)).denial, 'no_subscription')
    assert.deepEqual(resolvePaymentOptions(member(), dropInTarget(rule)).options, [
      { type: 'pay', amount: 25, source: 'drop_in' },
    ])
  })

  it('subscription with NO drop-in denies rather than turning free', () => {
    // The trap in deriving the new fields from the old tier: "no plan required"
    // plus "no price to pay" reads as free, which would have opened every
    // plan-gated class that never sold drop-ins.
    const rule: ActivityAccessRule = { type: 'subscription', subscriptionTypeIds: ['unlimited'] }
    const r = resolvePaymentOptions(member(), bookTarget(rule, null))
    assert.equal(r.options.length, 0)
    assert.equal(r.denial, 'no_subscription')
  })
})
