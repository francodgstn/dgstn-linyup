// WHO PAYS, AND HOW MUCH — the MRR arm of `computePlatformMetrics`.
//
// This is the platform's revenue number. It feeds the operator console's KPI and
// the daily `platform_metrics/{date}` snapshot, and the snapshot is PERSISTED, so
// a wrong figure is not a wrong screen — it is permanent history.
//
// Two facts it has to hold, both of which it got wrong before these fixtures:
//
//   1. THE ORGANIZATION IS THE PAYING ENTITY, not its studios. Joining an
//      organization sets a studio's `plan` to 'organization', and the reducer
//      receives every studio AND the org as separate rows — so charging each row
//      the tier's price counted a five-studio federation as six subscriptions.
//   2. THE ORGANIZATION'S PRICE IS NOT A SCALAR. It is per studio, so it cannot
//      be read off `PLAN_PRICING.baseMonthly` — that field is 0 for this tier,
//      and a reducer trusting it reports every federation as free.
//
// Both failures are silent: they compile, they render, and they are wrong.

import { strict as assert } from 'assert'
import {
  ORG_PER_STUDIO,
  PLAN_PRICING,
  computePlatformMetrics,
  type AccountMetricInput,
} from '@linyup/shared'

const NOW = Date.UTC(2026, 7, 28)

function account(over: Partial<AccountMetricInput> = {}): AccountMetricInput {
  return {
    type: 'team',
    plan: 'studio',
    status: 'active',
    createdMs: NOW - 86_400_000,
    trialEndsAtMs: null,
    contactCount: 0,
    ...over,
  }
}

/** An organization and its member studios, as the loaders actually produce them. */
function federation(studios: number, over: Partial<AccountMetricInput> = {}) {
  return [
    account({ type: 'org', plan: 'organization', contactCount: null, studioCount: studios, ...over }),
    ...Array.from({ length: studios }, () =>
      account({ type: 'team', plan: 'organization', billedByOrg: true, ...over })
    ),
  ]
}

const mrr = (inputs: AccountMetricInput[]) => computePlatformMetrics(inputs, NOW).mrr

describe('platform MRR — the organization tier', () => {
  it('bills the ORG for its studios, and the studios for nothing', () => {
    const m = mrr(federation(5))
    assert.equal(m.estimatedChf, 5 * ORG_PER_STUDIO.monthly)
    assert.equal(m.byPlan.organization, 5 * ORG_PER_STUDIO.monthly)
  })

  it('counts a federation ONCE, not once per studio', () => {
    // The regression this file exists for. Six rows, one subscription.
    const six = mrr(federation(5)).estimatedChf
    const one = mrr([
      account({ type: 'org', plan: 'organization', contactCount: null, studioCount: 5 }),
    ]).estimatedChf
    assert.equal(six, one)
  })

  it('scales with the studio count, at a FLAT rate', () => {
    // Not tiered and not volume-discounted: the tenth studio costs what the
    // second did. Doubling the studios doubles the bill exactly.
    const five = mrr(federation(5)).estimatedChf
    const ten = mrr(federation(10)).estimatedChf
    assert.equal(ten, five * 2)
  })

  it('does NOT read baseMonthly for the org tier', () => {
    // `PLAN_PRICING.organization.baseMonthly` is 0 — the tier has no base fee.
    // A reducer that trusted it would report this federation as free.
    assert.equal(PLAN_PRICING.organization.baseMonthly, 0)
    assert.ok(mrr(federation(3)).estimatedChf > 0)
  })

  it('a comped federation contributes nothing', () => {
    // The largest tenant is comped; charging it list price would invent money.
    assert.equal(mrr(federation(8, { comped: true })).estimatedChf, 0)
  })

  it('a trialing federation contributes nothing', () => {
    assert.equal(mrr(federation(4, { status: 'trial' })).estimatedChf, 0)
  })

  it('an org with no studios yet falls back to the minimum, never to zero', () => {
    // Absent/zero under-states rather than inventing — but an active
    // organization subscription is never worth CHF 0.
    const m = mrr([
      account({ type: 'org', plan: 'organization', contactCount: null, studioCount: 0 }),
    ])
    assert.ok(m.estimatedChf > 0)
  })
})

describe('platform MRR — the flat tiers are unchanged', () => {
  it('a studio pays its base price', () => {
    const m = mrr([account({ plan: 'studio' })])
    assert.equal(m.estimatedChf, PLAN_PRICING.studio.baseMonthly)
  })

  it('a coach pays its base price', () => {
    assert.equal(mrr([account({ plan: 'coach' })]).estimatedChf, PLAN_PRICING.coach.baseMonthly)
  })

  it('a free team pays nothing', () => {
    assert.equal(mrr([account({ plan: 'free' })]).estimatedChf, 0)
  })

  it('an INDEPENDENT studio is still billed — `billedByOrg` is the only exemption', () => {
    // The exemption keys on belonging to an organization, not on the plan name,
    // so an ordinary studio cannot fall through it.
    assert.equal(
      mrr([account({ plan: 'studio', billedByOrg: false })]).estimatedChf,
      PLAN_PRICING.studio.baseMonthly
    )
  })
})
