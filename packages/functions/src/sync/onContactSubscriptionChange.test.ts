// This test lives in `functions`, not `packages/shared` (where the code under
// test actually is), because `packages/shared` has no test runner of its own —
// see its package.json. The reconciler is pure and imported straight from
// `@linyup/shared`; this file never touches Firestore or the trigger itself.
import assert from 'node:assert/strict'
import {
  resolveHeldPlans,
  heldPlanIdsEqual,
  planSubscriptionHistory,
  isSubscriptionHistoryRowOpen,
} from '@linyup/shared'
import type {
  HeldPlan,
  HeldPlanSnapshot,
  SubscriptionHistoryRow,
  ContactSubscriptionFields,
} from '@linyup/shared'

function held(entries: Array<Partial<HeldPlanSnapshot> & { subscription_type_id: string }>) {
  const m = new Map<string, HeldPlanSnapshot>()
  for (const e of entries) {
    m.set(e.subscription_type_id, {
      subscription_type_id: e.subscription_type_id,
      subscription_type_name: e.subscription_type_name ?? null,
      recurrence: e.recurrence ?? null,
      subscription_price_id: e.subscription_price_id ?? null,
      amount: e.amount ?? null,
    })
  }
  return m
}

function row(partial: Partial<SubscriptionHistoryRow> & { id: string }): SubscriptionHistoryRow {
  return {
    subscription_type_id: null,
    start_date: 1,
    end_date: null,
    ...partial,
  }
}

function entry(typeId: string, over: Partial<HeldPlan> = {}): HeldPlan {
  return {
    subscription_type_id: typeId,
    subscription_type_name: null,
    source: 'grant',
    status: 'active',
    starts_at_ms: 1,
    ends_at_ms: null,
    price_id: null,
    amount: null,
    recurrence: null,
    ref: `ref-${typeId}`,
    ...over,
  }
}

describe('resolveHeldPlans — the stored plan list', () => {
  it('a staff or bought grant, with its own price', () => {
    const contact: ContactSubscriptionFields = {
      held_plans: [
        entry('sub-a', { subscription_type_name: 'Unlimited', recurrence: 'monthly', price_id: 'price-1', amount: 89 }),
      ],
    }
    assert.deepEqual(resolveHeldPlans(contact).get('sub-a'), {
      subscription_type_id: 'sub-a',
      subscription_type_name: 'Unlimited',
      recurrence: 'monthly',
      subscription_price_id: 'price-1',
      amount: 89,
    })
  })

  it('a Stripe subscription — no price id (it tracks what is charged)', () => {
    const contact: ContactSubscriptionFields = {
      held_plans: [entry('sub-b', { source: 'stripe', subscription_type_name: 'Kids', recurrence: 'monthly', amount: 45 })],
    }
    assert.equal(resolveHeldPlans(contact).get('sub-b')!.subscription_price_id, null)
  })

  it('two entries of one type make one period, each field from the first entry that has it', () => {
    const contact: ContactSubscriptionFields = {
      held_plans: [
        entry('sub-a', { price_id: 'price-1' }),
        entry('sub-a', { source: 'stripe', subscription_type_name: 'Unlimited', recurrence: 'monthly', amount: 89 }),
      ],
    }
    const m = resolveHeldPlans(contact)
    assert.equal(m.size, 1)
    assert.deepEqual(m.get('sub-a'), {
      subscription_type_id: 'sub-a',
      subscription_type_name: 'Unlimited',
      recurrence: 'monthly',
      subscription_price_id: 'price-1',
      amount: 89,
    })
  })

  it('different types — every one held (a set, not one winner)', () => {
    const m = resolveHeldPlans({ held_plans: [entry('sub-a'), entry('sub-b', { source: 'stripe' })] })
    assert.deepEqual(new Set(m.keys()), new Set(['sub-a', 'sub-b']))
  })

  it('credit packs are not periods of membership', () => {
    const m = resolveHeldPlans({ held_plans: [entry('pack', { source: 'credits', credits_remaining: 4 })] })
    assert.equal(m.size, 0)
  })

  it('entries with no subscription_type_id are skipped', () => {
    assert.equal(resolveHeldPlans({ held_plans: [entry('')] }).size, 0)
  })

  // The list is read as stored: the daily refresh that drops a lapsed grant is
  // the write that closes its row, so the reader must not re-filter by clock.
  it('reads the list as stored — an entry is held until the mirror drops it', () => {
    const m = resolveHeldPlans({ held_plans: [entry('sub-a', { ends_at_ms: 1 })] })
    assert.deepEqual([...m.keys()], ['sub-a'])
  })

  it('the retired single plan slot and active_subscriptions are not read', () => {
    const legacy = {
      subscription_type_id: 'sub-a',
      active_subscriptions: [{ subscription_type_id: 'sub-b' }],
    } as unknown as ContactSubscriptionFields
    assert.equal(resolveHeldPlans(legacy).size, 0)
  })

  it('amount stays MAJOR units — never sourced as Rappen', () => {
    // buildHeldPlans divides a Stripe amount by 100 before it reaches the list;
    // a regression here would silently write a number 100x too large into history.
    const m = resolveHeldPlans({ held_plans: [entry('b', { source: 'stripe', amount: 45 })] })
    assert.equal(m.get('b')!.amount, 45)
  })

  it('null/undefined contact returns an empty map', () => {
    assert.equal(resolveHeldPlans(null).size, 0)
    assert.equal(resolveHeldPlans(undefined).size, 0)
  })
})

describe('heldPlanIdsEqual', () => {
  it('true for the same id set, even if snapshot VALUES differ', () => {
    const a = held([{ subscription_type_id: 'a', amount: 10 }])
    const b = held([{ subscription_type_id: 'a', amount: 99, subscription_type_name: 'renamed' }])
    assert.equal(heldPlanIdsEqual(a, b), true)
  })

  it('false when sizes differ', () => {
    const a = held([{ subscription_type_id: 'a' }])
    const b = held([{ subscription_type_id: 'a' }, { subscription_type_id: 'b' }])
    assert.equal(heldPlanIdsEqual(a, b), false)
  })

  it('false when the same-size sets name different types', () => {
    const a = held([{ subscription_type_id: 'a' }])
    const b = held([{ subscription_type_id: 'b' }])
    assert.equal(heldPlanIdsEqual(a, b), false)
  })

  it('true for two empty maps — the bulk-import-of-plain-contacts case', () => {
    assert.equal(heldPlanIdsEqual(new Map(), new Map()), true)
  })
})

describe('isSubscriptionHistoryRowOpen', () => {
  it('absent end_date + a start_date counts as open', () => {
    assert.equal(isSubscriptionHistoryRowOpen({ start_date: 1 }), true)
  })

  it('null end_date + a start_date counts as open', () => {
    assert.equal(isSubscriptionHistoryRowOpen({ start_date: 1, end_date: null }), true)
  })

  it('a set end_date is NOT open', () => {
    assert.equal(isSubscriptionHistoryRowOpen({ start_date: 1, end_date: 5 }), false)
  })

  it('a row with NO start_date is never open, even with end_date absent/null', () => {
    assert.equal(isSubscriptionHistoryRowOpen({ end_date: null }), false)
    assert.equal(isSubscriptionHistoryRowOpen({ start_date: null, end_date: null }), false)
  })
})

describe('planSubscriptionHistory', () => {
  it('idempotent re-invocation writes nothing — held matches the row already there', () => {
    const h = held([{ subscription_type_id: 'a' }])
    const rows = [row({ id: 'r1', subscription_type_id: 'a' })]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(plan.open, [])
    assert.deepEqual(plan.close, [])
    assert.deepEqual(plan.transitions, [])
  })

  it('a second plan added leaves the first row open', () => {
    const h = held([{ subscription_type_id: 'a' }, { subscription_type_id: 'b' }])
    const rows = [row({ id: 'r1', subscription_type_id: 'a' })]
    const plan = planSubscriptionHistory(h, rows)
    assert.equal(plan.close.length, 0)
    assert.deepEqual(
      plan.open.map((o) => o.subscription_type_id),
      ['b']
    )
  })

  it('one plan removed while another stays open', () => {
    const h = held([{ subscription_type_id: 'b' }])
    const rows = [row({ id: 'rA', subscription_type_id: 'a' }), row({ id: 'rB', subscription_type_id: 'b' })]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(
      plan.close.map((r) => r.id),
      ['rA']
    )
    assert.equal(plan.open.length, 0)
  })

  it('genuine 1-in-1-out emits exactly ONE transition (the legacy swap shape)', () => {
    const h = held([{ subscription_type_id: 'b', subscription_type_name: 'New Plan', recurrence: 'monthly', amount: 99 }])
    const rows = [row({ id: 'rA', subscription_type_id: 'a', subscription_type_name: 'Old Plan', termination_reason: 'downgraded' })]
    const plan = planSubscriptionHistory(h, rows)
    assert.equal(plan.transitions.length, 1)
    assert.deepEqual(plan.transitions[0], {
      from_subscription_type_id: 'a',
      from_subscription_type_name: 'Old Plan',
      to_subscription_type_id: 'b',
      to_subscription_type_name: 'New Plan',
      recurrence: 'monthly',
      subscription_price_id: null,
      amount: 99,
      termination_reason: 'downgraded',
    })
  })

  it('N-in/M-out never fabricates a swap — one row per close, one per open', () => {
    const h = held([{ subscription_type_id: 'b' }, { subscription_type_id: 'c' }])
    const rows = [row({ id: 'rA', subscription_type_id: 'a' })]
    const plan = planSubscriptionHistory(h, rows)
    assert.equal(plan.transitions.length, 3)
    // No transition may name BOTH a from and a to — that would be a fabricated pairing.
    for (const t of plan.transitions) {
      assert.ok(t.from_subscription_type_id === null || t.to_subscription_type_id === null)
    }
    const closeOnly = plan.transitions.filter((t) => t.to_subscription_type_id === null)
    const openOnly = plan.transitions.filter((t) => t.from_subscription_type_id === null)
    assert.deepEqual(
      closeOnly.map((t) => t.from_subscription_type_id),
      ['a']
    )
    assert.deepEqual(
      openOnly.map((t) => t.to_subscription_type_id).sort(),
      ['b', 'c']
    )
  })

  it('zero close + zero open (no change) never emits a transition', () => {
    const h = held([{ subscription_type_id: 'a' }])
    const rows = [row({ id: 'r1', subscription_type_id: 'a' })]
    assert.deepEqual(planSubscriptionHistory(h, rows).transitions, [])
  })

  it('a row with an absent end_date key counts as open (same as null)', () => {
    const h = held([{ subscription_type_id: 'a' }])
    const rows: SubscriptionHistoryRow[] = [{ id: 'r1', subscription_type_id: 'a', start_date: 1 }]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(plan.open, [])
    assert.deepEqual(plan.close, [])
  })

  it('a row with no start_date is NOT treated as open — a new row opens for the same type', () => {
    const h = held([{ subscription_type_id: 'a' }])
    const rows: SubscriptionHistoryRow[] = [{ id: 'r1', subscription_type_id: 'a', end_date: null }]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(
      plan.open.map((o) => o.subscription_type_id),
      ['a']
    )
    assert.deepEqual(plan.close, [])
  })

  it('re-subscription after a gap opens a NEW row — a past CLOSED row does not block it', () => {
    const h = held([{ subscription_type_id: 'a' }])
    const rows = [row({ id: 'r-old', subscription_type_id: 'a', start_date: 1, end_date: 5 })]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(
      plan.open.map((o) => o.subscription_type_id),
      ['a']
    )
    assert.deepEqual(plan.close, [])
  })

  it('several open rows for a type STILL held: close none, report the duplicate', () => {
    const h = held([{ subscription_type_id: 'a' }])
    const rows = [row({ id: 'r1', subscription_type_id: 'a' }), row({ id: 'r2', subscription_type_id: 'a' })]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(plan.close, [])
    assert.deepEqual(plan.open, [])
    assert.deepEqual(plan.duplicateOpenTypeIds, ['a'])
  })

  it('several open rows for a type NO LONGER held: close ALL of them, report the duplicate', () => {
    const h = held([])
    const rows = [row({ id: 'r1', subscription_type_id: 'a' }), row({ id: 'r2', subscription_type_id: 'a' })]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(
      plan.close.map((r) => r.id).sort(),
      ['r1', 'r2']
    )
    assert.deepEqual(plan.duplicateOpenTypeIds, ['a'])
  })

  it('an open row naming no type is ignored — nothing to reconcile it against', () => {
    const h = held([{ subscription_type_id: 'a' }])
    const rows: SubscriptionHistoryRow[] = [{ id: 'orphan', subscription_type_id: null, start_date: 1, end_date: null }]
    const plan = planSubscriptionHistory(h, rows)
    assert.deepEqual(
      plan.open.map((o) => o.subscription_type_id),
      ['a']
    )
    assert.deepEqual(plan.close, [])
  })
})
