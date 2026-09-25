// Unit tests for automationEngine condition evaluation and the contact-write
// events of automation/contactEvents.ts.
//
// Tests cover:
//   1. evaluateContactConditions — the plan conditions read the plan list
//   2. evaluateContactConditions — legacy subscription_missing / subscription_set aliases
//   3. evaluateContactConditions — subscription_expires_in reads the plan list's ends
//   4. resolveContactEvents — plan events diff the stored plan-list mirror

import assert from 'node:assert/strict'
import type { HeldPlan } from '@linyup/shared'
import {
  evaluateContactConditions,
  recordRecipient,
  RECIPIENT_ID_CAP,
  type ContactData,
  type RuleStats,
} from './automationEngine'
import {
  resolveContactEvents,
  resolveHeldTypeIds,
  type ContactEvent,
} from '../automation/contactEvents'

const NOW = new Date('2026-01-15T12:00:00Z')
const DAY = 86_400_000

function makeContact(overrides: Partial<ContactData> = {}): ContactData {
  return { id: 'c1', ...overrides }
}

function plan(typeId: string, over: Partial<HeldPlan> = {}): HeldPlan {
  return {
    subscription_type_id: typeId,
    subscription_type_name: null,
    source: 'grant',
    status: 'active',
    starts_at_ms: NOW.getTime() - 30 * DAY,
    ends_at_ms: null,
    price_id: null,
    amount: null,
    recurrence: null,
    ref: `ref-${typeId}`,
    ...over,
  }
}

/** A contact holding the given plan types, each through a grant with no end. */
const holding = (...typeIds: string[]) => makeContact({ held_plans: typeIds.map((id) => plan(id)) })

describe('evaluateContactConditions — unknown condition types fail closed', () => {
  it('blocks the rule when a condition type is unrecognized (e.g. legacy contact_type)', () => {
    // Regression: an ignored dead condition once turned a "welcome new trial" rule
    // into "email every new contact" — spamming shop registrations.
    const c = makeContact({ entry: 'shop' } as Partial<ContactData>)
    const conditions = [{ type: 'contact_type', value: 'trial' } as never]
    assert.equal(evaluateContactConditions(conditions, c, NOW), false)
  })
})

// ---------------------------------------------------------------------------
// 1. evaluateContactConditions — subscription condition
// ---------------------------------------------------------------------------

describe('evaluateContactConditions — subscription condition', () => {
  const sub = (value: string) => [{ type: 'subscription' as const, value }]

  it('none: passes when the contact holds no plan', () => {
    assert.equal(evaluateContactConditions(sub('none'), makeContact(), NOW), true)
    assert.equal(evaluateContactConditions(sub('none'), makeContact({ held_plans: [] }), NOW), true)
  })

  it('none: fails when the contact holds any plan, whatever holds it', () => {
    assert.equal(evaluateContactConditions(sub('none'), holding('sub-A'), NOW), false)
    const stripe = makeContact({ held_plans: [plan('sub-B', { source: 'stripe' })] })
    assert.equal(evaluateContactConditions(sub('none'), stripe, NOW), false)
  })

  it('any: passes with one plan, fails with none', () => {
    assert.equal(evaluateContactConditions(sub('any'), holding('sub-A'), NOW), true)
    assert.equal(evaluateContactConditions(sub('any'), makeContact(), NOW), false)
  })

  it('specific id: passes for ANY held plan, not only the first', () => {
    const c = holding('yoga', 'boxing', 'swim')
    assert.equal(evaluateContactConditions(sub('boxing'), c, NOW), true)
    assert.equal(evaluateContactConditions(sub('karate'), c, NOW), false)
  })

  // The list is stored ahead of the clock; a lapsed grant is compared, not trusted.
  it('a grant that has ended or not begun is not held', () => {
    const c = makeContact({
      held_plans: [
        plan('ended', { ends_at_ms: NOW.getTime() - DAY }),
        plan('future', { starts_at_ms: NOW.getTime() + DAY }),
      ],
    })
    assert.equal(evaluateContactConditions(sub('ended'), c, NOW), false)
    assert.equal(evaluateContactConditions(sub('future'), c, NOW), false)
    assert.equal(evaluateContactConditions(sub('none'), c, NOW), true)
  })

  it('the retired single plan slot is not read', () => {
    const c = makeContact({ subscription_type_id: 'sub-A' } as Partial<ContactData>)
    assert.equal(evaluateContactConditions(sub('sub-A'), c, NOW), false)
  })
})

// ---------------------------------------------------------------------------
// 2. legacy aliases
// ---------------------------------------------------------------------------

describe('evaluateContactConditions — legacy subscription aliases', () => {
  it('subscription_missing: passes with no plan, fails with one', () => {
    assert.equal(
      evaluateContactConditions([{ type: 'subscription_missing' }], makeContact(), NOW),
      true
    )
    assert.equal(
      evaluateContactConditions([{ type: 'subscription_missing' }], holding('sub-A'), NOW),
      false
    )
  })

  it('subscription_set: passes with a plan, fails with none', () => {
    assert.equal(
      evaluateContactConditions([{ type: 'subscription_set' }], holding('sub-A'), NOW),
      true
    )
    assert.equal(
      evaluateContactConditions([{ type: 'subscription_set' }], makeContact(), NOW),
      false
    )
  })
})

// ---------------------------------------------------------------------------
// 3. subscription_expires_in — the win-back window
// ---------------------------------------------------------------------------

describe('evaluateContactConditions — subscription_expires_in', () => {
  const within7 = [{ type: 'subscription_expires_in' as const, value: 7 }]
  const endsIn = (days: number, over: Partial<HeldPlan> = {}) =>
    plan('grant', { ends_at_ms: NOW.getTime() + days * DAY, ...over })

  it('matches a membership ending inside the window', () => {
    assert.equal(
      evaluateContactConditions(within7, makeContact({ held_plans: [endsIn(3)] }), NOW),
      true
    )
  })

  it('does not match one ending after the window', () => {
    assert.equal(
      evaluateContactConditions(within7, makeContact({ held_plans: [endsIn(10)] }), NOW),
      false
    )
  })

  it('does not match when another membership has no end — the member is not losing access', () => {
    const c = makeContact({ held_plans: [endsIn(3), plan('stripe', { source: 'stripe' })] })
    assert.equal(evaluateContactConditions(within7, c, NOW), false)
  })

  it('reads the LAST end when every membership ends', () => {
    const c = makeContact({
      held_plans: [endsIn(3), plan('later', { ends_at_ms: NOW.getTime() + 20 * DAY })],
    })
    assert.equal(evaluateContactConditions(within7, c, NOW), false)
  })

  it('ignores credit packs, which are not memberships', () => {
    const c = makeContact({
      held_plans: [
        plan('pack', {
          source: 'credits',
          credits_remaining: 3,
          ends_at_ms: NOW.getTime() + 2 * DAY,
        }),
      ],
    })
    assert.equal(evaluateContactConditions(within7, c, NOW), false)
  })

  it('does not match a contact holding nothing', () => {
    assert.equal(evaluateContactConditions(within7, makeContact(), NOW), false)
  })
})

// ---------------------------------------------------------------------------
// 4. resolveContactEvents — plan delta
// ---------------------------------------------------------------------------

describe('resolveHeldTypeIds', () => {
  it('reads the stored mirror, and nothing else', () => {
    assert.equal(resolveHeldTypeIds(undefined).size, 0)
    assert.deepEqual([...resolveHeldTypeIds({ held_plan_type_ids: ['a', 'b'] })], ['a', 'b'])
    assert.equal(resolveHeldTypeIds({ subscription_type_id: 'a' }).size, 0)
  })
})

describe('resolveContactEvents — plan delta', () => {
  const types = (events: ContactEvent[], t: string) => events.filter((e) => e.triggerType === t)

  it('fires contact_created and nothing else for a new document', () => {
    const events = resolveContactEvents(undefined, { teamId: 't1' })
    assert.deepEqual(
      events.map((e) => e.triggerType),
      ['contact_created']
    )
  })

  it('returns nothing for a delete', () => {
    assert.equal(resolveContactEvents({ held_plan_type_ids: ['sub-A'] }, undefined).length, 0)
  })

  it('fires subscription_added + subscription_changed when a type joins the list', () => {
    const events = resolveContactEvents(
      { held_plan_type_ids: ['sub-A'] },
      { held_plan_type_ids: ['sub-A', 'sub-B'] }
    )
    assert.deepEqual(
      types(events, 'subscription_added').map((e) => e.delta?.subscriptionTypeId),
      ['sub-B']
    )
    assert.equal(types(events, 'subscription_removed').length, 0)
    assert.equal(types(events, 'subscription_changed').length, 1)
  })

  it('fires subscription_removed when a type leaves — including the daily refresh dropping a lapsed grant', () => {
    const events = resolveContactEvents(
      { held_plan_type_ids: ['sub-A', 'sub-B'] },
      { held_plan_type_ids: ['sub-A'] }
    )
    assert.deepEqual(
      types(events, 'subscription_removed').map((e) => e.delta?.subscriptionTypeId),
      ['sub-B']
    )
    assert.equal(types(events, 'subscription_changed').length, 1)
  })

  it('fires both when two types swap in one write', () => {
    const events = resolveContactEvents(
      { held_plan_type_ids: ['sub-A'] },
      { held_plan_type_ids: ['sub-B'] }
    )
    assert.deepEqual(
      types(events, 'subscription_added').map((e) => e.delta?.subscriptionTypeId),
      ['sub-B']
    )
    assert.deepEqual(
      types(events, 'subscription_removed').map((e) => e.delta?.subscriptionTypeId),
      ['sub-A']
    )
  })

  it('fires no plan events when the list is unchanged or an unrelated field moves', () => {
    const before = { acquisition_stage: 'trial_booked', held_plan_type_ids: ['sub-A'] }
    const after = { acquisition_stage: 'trial_booked', held_plan_type_ids: ['sub-A'], notes: 'x' }
    assert.equal(resolveContactEvents(before, after).length, 0)
  })

  it('the retired single plan slot changing fires nothing', () => {
    assert.equal(
      resolveContactEvents({ subscription_type_id: 'sub-A' }, { subscription_type_id: 'sub-B' })
        .length,
      0
    )
  })

  it('a Stripe status change still fires subscription_changed, and past_due fires payment_failed', () => {
    const events = resolveContactEvents(
      { subscription_status: 'active' },
      { subscription_status: 'past_due' }
    )
    assert.equal(types(events, 'subscription_changed').length, 1)
    assert.equal(types(events, 'subscription_payment_failed').length, 1)
  })

  it('a member asking to cancel fires subscription_cancel_requested once per type', () => {
    const events = resolveContactEvents(
      { active_subscriptions: [{ subscription_type_id: 'sub-A' }] },
      { active_subscriptions: [{ subscription_type_id: 'sub-A', cancelling: true }] }
    )
    assert.deepEqual(
      types(events, 'subscription_cancel_requested').map((e) => e.delta?.subscriptionTypeId),
      ['sub-A']
    )
  })
})

// ---------------------------------------------------------------------------
// recordRecipient — the run log's "who got it" (decision 14 / UX-48)
// ---------------------------------------------------------------------------

function freshStats(): RuleStats {
  return { processed: 0, sent: 0, skipped: 0, errors: 0, recipients: new Set<string>() }
}

describe('recordRecipient', () => {
  it('records a contact id', () => {
    const stats = freshStats()
    recordRecipient(stats, 'c1')
    assert.deepEqual([...stats.recipients], ['c1'])
  })

  it('ignores an empty id — a booking without a contact document is not a recipient', () => {
    const stats = freshStats()
    recordRecipient(stats, '')
    recordRecipient(stats, undefined)
    assert.equal(stats.recipients.size, 0)
  })

  it('dedupes — one contact reached twice in a run is one recipient', () => {
    const stats = freshStats()
    recordRecipient(stats, 'c1')
    recordRecipient(stats, 'c1')
    assert.equal(stats.recipients.size, 1)
  })

  it('keeps an EXACT total past the cap, so the log can say "50 of 400"', () => {
    const stats = freshStats()
    for (let i = 0; i < 400; i++) recordRecipient(stats, `c${i}`)
    assert.equal(stats.recipients.size, 400)
    // The cap applies where the log row is built, never to the tally.
    assert.equal([...stats.recipients].slice(0, RECIPIENT_ID_CAP).length, 50)
  })
})
