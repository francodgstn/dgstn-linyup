// The reversal matrix: {divisible, indivisible, none} × {full, partial} ×
// {consumed 0, n, all} × {owner, not-owner, absent}.
//
// The tests that matter most are the ones that assert NOTHING was written —
// under-revoking is the design, and a reversal that quietly strips access a
// different payment paid for is the failure this file exists to catch.

import assert from 'node:assert/strict'
import type { firestore } from 'firebase-admin'
import {
  lineItemForReversal,
  reversalPlanFor,
  reversePaymentEffects,
  type ReversalActions,
  type ReversalPlan,
} from './reversal'

// ─── helpers ─────────────────────────────────────────────────────────────────

function actions(plan: ReversalPlan): ReversalActions {
  assert.equal(plan.refuse, undefined, `expected an actionable plan, got refuse=${plan.refuse}`)
  return plan as ReversalActions
}

interface TxOps {
  updates: Array<{ path: string; data: Record<string, unknown> }>
  deletes: string[]
}

/** Firestore double with just enough transaction to run the executor: get() by
 *  doc id off a seed map, update/delete recorded by path. */
function mockDb(seed: Record<string, Record<string, unknown> | undefined>) {
  const ops: TxOps = { updates: [], deletes: [] }
  const reads: string[] = []
  const docRef = (path: string) => ({
    path,
    collection: (name: string) => colRef(`${path}/${name}`),
  })
  const colRef = (path: string) => ({
    doc: (id: string) => docRef(`${path}/${id}`),
  })
  const tx = {
    async get(ref: { path: string }) {
      reads.push(ref.path)
      const data = seed[ref.path]
      return { exists: data !== undefined, data: () => data }
    },
    update(ref: { path: string }, data: Record<string, unknown>) {
      ops.updates.push({ path: ref.path, data })
    },
    delete(ref: { path: string }) {
      ops.deletes.push(ref.path)
    },
  }
  const db = {
    collection: (name: string) => colRef(name),
    runTransaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as firestore.Firestore
  return { db, ops, reads }
}

const PACK = { kind: 'subscription' as const, subscriptionTypeId: 'st1', priceId: 'p1' }
const PLAIN_SUB = { kind: 'subscription' as const, subscriptionTypeId: 'st1' }
const COURSE = { kind: 'course' as const, courseId: 'c1' }

// ─── lineItemForReversal ─────────────────────────────────────────────────────

describe('lineItemForReversal', () => {
  it('prefers the stored line item', () => {
    assert.deepEqual(lineItemForReversal({ line_item: PACK, kind: 'membership' }), PACK)
  })

  it('maps a legacy Connect row from `kind` — membership becomes subscription', () => {
    assert.deepEqual(lineItemForReversal({ kind: 'membership' }), { kind: 'subscription' })
    assert.deepEqual(lineItemForReversal({ kind: 'course', courseId: 'c1' }), {
      kind: 'course',
      courseId: 'c1',
    })
    assert.deepEqual(lineItemForReversal({ kind: 'drop_in' }), { kind: 'drop_in' })
  })

  it('is null for a row that names nothing', () => {
    assert.equal(lineItemForReversal({}), null)
    assert.equal(lineItemForReversal({ kind: 'policy_fee' }), null)
  })

  it('does not consult contactId — legality is a property of what was sold', () => {
    // The same course row, assigned and unassigned, resolves identically. This is
    // the seam where "can I refund half of this?" used to depend on whether a
    // manager had got round to assigning the payment.
    assert.deepEqual(
      lineItemForReversal({ kind: 'course', courseId: 'c1' }),
      lineItemForReversal({ kind: 'course', courseId: 'c1', contactId: 'ct1' })
    )
  })
})

// ─── reversalPlanFor ─────────────────────────────────────────────────────────

// A PACK IS A COMMITMENT (Franco, 2026-08). Refundable in full while untouched;
// refused the moment a class has been taken, and refused in part always.
describe('reversalPlanFor — a credit pack', () => {
  it('full refund of an UNTOUCHED pack clears the plan and revokes everything', () => {
    const plan = reversalPlanFor({
      lineItem: PACK,
      divisible: { unitsGranted: 10, unitsConsumed: 0 },
    })
    assert.deepEqual(actions(plan), {
      subscription: 'clear_if_owned',
      credits: { op: 'reduce_to', total: 0 },
      course: 'leave',
    })
  })

  it('full refund of a PARTLY consumed pack is refused, with the facts and NO amount', () => {
    const plan = reversalPlanFor({
      lineItem: PACK,
      divisible: { unitsGranted: 10, unitsConsumed: 3 },
    })
    assert.equal(plan.refuse, 'full_refund_on_consumed_pack')
    // Exactly two numbers. A suggested amount here would be a "what now" beat
    // with nothing behind it — see reversalPlanFor.
    assert.deepEqual((plan as { facts: unknown }).facts, {
      unitsGranted: 10,
      unitsConsumed: 3,
    })
  })

  it('one class taken is enough — the rule is consumption, not proportion', () => {
    const plan = reversalPlanFor({
      lineItem: PACK,
      divisible: { unitsGranted: 10, unitsConsumed: 1 },
    })
    assert.equal(plan.refuse, 'full_refund_on_consumed_pack')
  })

  it('full refund of a FULLY consumed pack is refused', () => {
    const plan = reversalPlanFor({
      lineItem: PACK,
      divisible: { unitsGranted: 10, unitsConsumed: 10 },
    })
    assert.equal(plan.refuse, 'full_refund_on_consumed_pack')
  })

  // THE REGRESSION THIS PINS: the partial branch once ignored `refundAmountMinor`
  // entirely and revoked the whole remainder, so a CHF 10 goodwill gesture on a
  // CHF 180 ten-class pack took all ten credits back and reported a clean
  // success. The settled answer is that a pack is not refundable in part at all.
  //
  // IF A FUTURE CHANGE MAKES THESE FAIL BY ALLOWING A PARTIAL AGAIN, it owes an
  // amount-aware revocation rule — and that rule is the INVERSE OF A PRO-RATA
  // SUGGESTION (the largest n whose pro-rata price does not exceed the money
  // returned), NOT `floor(refund / unitPrice)`. The division form looks right and
  // leaves a credit behind: a CHF 100.00 / 3-class pack with 2 left is worth
  // `floor(10000 × 2/3) = 6666`, and `6666 / 3333.33 = 1.9998 → 1`, so accepting
  // the studio's own figure would revoke one of the two.
  for (const [name, refundAmountMinor] of [
    ['a token goodwill amount', 1000],
    ['a pro-rata-looking amount', 12600],
    ['almost the whole charge', 17900],
  ] as const) {
    it(`PARTIAL refund is refused — ${name}`, () => {
      const plan = reversalPlanFor({
        lineItem: PACK,
        divisible: { unitsGranted: 10, unitsConsumed: 3 },
        refundAmountMinor,
      })
      assert.equal(plan.refuse, 'partial_refund_on_pack')
    })
  }

  it('PARTIAL refund of an UNTOUCHED pack is refused too — the rule is the pack, not the usage', () => {
    const plan = reversalPlanFor({
      lineItem: PACK,
      divisible: { unitsGranted: 10, unitsConsumed: 0 },
      refundAmountMinor: 9000,
    })
    assert.equal(plan.refuse, 'partial_refund_on_pack')
  })

  it('a refused plan produces NO actions at all — nothing can be revoked by accident', () => {
    for (const input of [
      { lineItem: PACK, divisible: { unitsGranted: 10, unitsConsumed: 0 }, refundAmountMinor: 1000 },
      { lineItem: PACK, divisible: { unitsGranted: 10, unitsConsumed: 3 } },
    ]) {
      const plan = reversalPlanFor(input)
      assert.ok(plan.refuse)
      assert.equal((plan as { credits?: unknown }).credits, undefined)
      assert.equal((plan as { subscription?: unknown }).subscription, undefined)
      assert.equal((plan as { course?: unknown }).course, undefined)
    }
  })
})

describe('reversalPlanFor — indivisible', () => {
  it('full refund of a plain membership clears it if owned', () => {
    const plan = reversalPlanFor({
      lineItem: PLAIN_SUB,
      divisible: null,
    })
    assert.deepEqual(actions(plan), {
      subscription: 'clear_if_owned',
      credits: { op: 'leave' },
      course: 'leave',
    })
  })

  it('PARTIAL refund of a plain membership is refused', () => {
    const plan = reversalPlanFor({
      lineItem: PLAIN_SUB,
      divisible: null,
      refundAmountMinor: 2500,
    })
    assert.equal(plan.refuse, 'partial_refund_on_indivisible')
  })

  it('a pack whose grant reports zero units is treated as a plain membership', () => {
    const plan = reversalPlanFor({
      lineItem: PACK,
      divisible: { unitsGranted: 0, unitsConsumed: 0 },
      refundAmountMinor: 2500,
    })
    assert.equal(plan.refuse, 'partial_refund_on_indivisible')
  })

  it('full refund of a course deletes it if owned; partial is refused', () => {
    assert.deepEqual(
      actions(reversalPlanFor({ lineItem: COURSE, divisible: null })),
      { subscription: 'leave', credits: { op: 'leave' }, course: 'delete_if_owned' }
    )
    assert.equal(
      reversalPlanFor({
        lineItem: COURSE,
        divisible: null,
        refundAmountMinor: 5000,
      }).refuse,
      'partial_refund_on_indivisible'
    )
  })
})

describe('reversalPlanFor — nothing to reverse', () => {
  for (const kind of ['product', 'drop_in', 'appointment', 'gift_card', 'other'] as const) {
    it(`${kind}: full AND partial are allowed and touch nothing`, () => {
      const nothing = {
        subscription: 'leave',
        credits: { op: 'leave' },
        course: 'leave',
      }
      assert.deepEqual(
        actions(reversalPlanFor({ lineItem: { kind }, divisible: null })),
        nothing
      )
      assert.deepEqual(
        actions(
          reversalPlanFor({
            lineItem: { kind },
            divisible: null,
            refundAmountMinor: 1000,
          })
        ),
        nothing
      )
    })
  }

  it('an unlinked payment (no line item) touches nothing', () => {
    assert.equal(
      actions(reversalPlanFor({ lineItem: null, divisible: null }))
        .subscription,
      'leave'
    )
  })
})

// ─── reversePaymentEffects ───────────────────────────────────────────────────

const CLEAR: ReversalActions = {
  subscription: 'clear_if_owned',
  credits: { op: 'leave' },
  course: 'leave',
}
const REDUCE: ReversalActions = {
  subscription: 'leave',
  credits: { op: 'reduce_to', total: 0 },
  course: 'leave',
}
const DELETE_COURSE: ReversalActions = {
  subscription: 'leave',
  credits: { op: 'leave' },
  course: 'delete_if_owned',
}

describe('reversePaymentEffects — the contact document', () => {
  // A plan is a grant row keyed by the payment, so a refund ends exactly that
  // row. The contact itself is never written: a slot left on old data is not
  // cleared, and a later plan of the same type — its own row — is untouched.
  it('ends only the refunded payment’s grant and never writes the contact', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1': { subscription_type_id: 'st1', subscription_source_ref: 'pi_1' },
      'contacts/ct1/plan_grants/pi_1': { subscription_type_id: 'st1', ended_at: null },
      'contacts/ct1/plan_grants/pi_2': { subscription_type_id: 'st1', ended_at: null },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PLAIN_SUB,
      plan: CLEAR,
    })
    assert.equal(out.planGrant, 'ended')
    assert.equal('subscription' in out, false)
    assert.deepEqual(
      ops.updates.map((u) => u.path),
      ['contacts/ct1/plan_grants/pi_1']
    )
  })
})

describe('reversePaymentEffects — credits', () => {
  it('reduces credits_total to the IN-TRANSACTION credits_used, absolutely', async () => {
    const { db, ops } = mockDb({
      // The plan said reduce_to 0 (nothing consumed at pre-flight); by the time
      // the transaction runs she has spent 2. Those two stay hers.
      'contacts/ct1/credit_grants/pi_1': { credits_total: 10, credits_used: 2 },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PACK,
      plan: REDUCE,
    })
    assert.equal(out.credits, 'reduced')
    assert.equal(out.creditsRevoked, 8)
    const u = ops.updates.find((x) => x.path === 'contacts/ct1/credit_grants/pi_1')!
    assert.equal(u.data.credits_total, 2, 'absolute, from the transaction read set')
    assert.equal(u.data.credits_used, undefined, 'credits_used is never touched')
    assert.equal(u.data.credits_revoked, 8)
    assert.equal(u.data.reversed_by_payment_ref, 'pi_1')
  })

  it('reduces an untouched pack to zero', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1/credit_grants/pi_1': { credits_total: 10, credits_used: 0 },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PACK,
      plan: REDUCE,
    })
    assert.equal(out.creditsRevoked, 10)
    assert.equal(ops.updates[0].data.credits_total, 0)
  })

  it('a second run writes nothing — total already equals used', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1/credit_grants/pi_1': {
        credits_total: 3,
        credits_used: 3,
        credits_revoked: 7,
      },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PACK,
      plan: REDUCE,
    })
    assert.equal(out.credits, 'reduced')
    assert.equal(out.creditsRevoked, 0)
    assert.equal(ops.updates.length, 0)
  })

  it('accumulates credits_revoked across two reversals without an increment', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1/credit_grants/pi_1': {
        credits_total: 8,
        credits_used: 2,
        credits_revoked: 2,
      },
    })
    await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PACK,
      plan: REDUCE,
    })
    assert.equal(ops.updates[0].data.credits_revoked, 8)
  })

  it('never writes ABOVE the current total — a re-run cannot hand credits back', async () => {
    // An earlier reversal already took this pack from 10 to 2. A stale plan
    // asking for 8 must not restore six revoked credits.
    const { db, ops } = mockDb({
      'contacts/ct1/credit_grants/pi_1': { credits_total: 2, credits_used: 0, credits_revoked: 8 },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PACK,
      plan: { subscription: 'leave', credits: { op: 'reduce_to', total: 8 }, course: 'leave' },
    })
    assert.equal(out.creditsRevoked, 0)
    assert.equal(ops.updates.length, 0)
  })

  it('never writes BELOW credits_used — a class booked in the meantime stays hers', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1/credit_grants/pi_1': { credits_total: 10, credits_used: 4 },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      // The plan was computed when nothing had been consumed.
      plan: { subscription: 'leave', credits: { op: 'reduce_to', total: 0 }, course: 'leave' },
      lineItem: PACK,
    })
    assert.equal(ops.updates[0].data.credits_total, 4)
    assert.equal(out.creditsRevoked, 6)
  })

  it('reports absent when no grant exists at that doc id', async () => {
    const { db, ops } = mockDb({})
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PACK,
      plan: REDUCE,
    })
    assert.equal(out.credits, 'absent')
    assert.equal(ops.updates.length, 0)
  })

  it('reaches the grant BY DOC ID — never by a field query', async () => {
    const { db, reads } = mockDb({
      // A Connect grant stamps payment_intent_id, not payment_ref. Keying off a
      // field would have missed this one entirely.
      'contacts/ct1/credit_grants/pi_1': {
        credits_total: 5,
        credits_used: 0,
        payment_intent_id: 'pi_1',
      },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: PACK,
      plan: REDUCE,
    })
    assert.equal(out.creditsRevoked, 5)
    assert.deepEqual(reads, ['contacts/ct1/credit_grants/pi_1'])
  })
})

describe('reversePaymentEffects — course entitlement', () => {
  it('deletes when payment_ref matches', async () => {
    const { db, ops } = mockDb({ 'courses/c1/purchases/ct1': { payment_ref: 'pi_1' } })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: COURSE,
      plan: DELETE_COURSE,
    })
    assert.equal(out.course, 'deleted')
    assert.deepEqual(ops.deletes, ['courses/c1/purchases/ct1'])
  })

  it('deletes when only the legacy paymentIntentId matches', async () => {
    const { db, ops } = mockDb({ 'courses/c1/purchases/ct1': { paymentIntentId: 'pi_1' } })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: COURSE,
      plan: DELETE_COURSE,
    })
    assert.equal(out.course, 'deleted')
    assert.deepEqual(ops.deletes, ['courses/c1/purchases/ct1'])
  })

  it('SKIPS a gift-card-funded entitlement — no /payments refund owns it', async () => {
    const { db, ops } = mockDb({
      'courses/c1/purchases/ct1': { payment_ref: 'gift:GC-ABC:hold1', source: 'gift_card' },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: COURSE,
      plan: DELETE_COURSE,
    })
    assert.equal(out.course, 'skipped_not_owner')
    assert.deepEqual(ops.deletes, [], 'nothing deleted')
  })

  it('SKIPS an entitlement with no provenance at all', async () => {
    const { db, ops } = mockDb({ 'courses/c1/purchases/ct1': { contactId: 'ct1' } })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: COURSE,
      plan: DELETE_COURSE,
    })
    assert.equal(out.course, 'skipped_not_owner')
    assert.deepEqual(ops.deletes, [])
  })

  it('a second run finds it absent', async () => {
    const { db } = mockDb({})
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: COURSE,
      plan: DELETE_COURSE,
    })
    assert.equal(out.course, 'absent')
  })

  it('reports absent — and reads nothing — when the line item names no course', async () => {
    const { db, reads } = mockDb({})
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: { kind: 'course' },
      plan: DELETE_COURSE,
    })
    assert.equal(out.course, 'absent')
    assert.deepEqual(reads, [])
  })
})

describe('reversePaymentEffects — the read set', () => {
  it('reads only the documents the plan names, all by doc id', async () => {
    const { db, reads } = mockDb({
      'contacts/ct1': { subscription_type_id: 'st1', subscription_source_ref: 'pi_1' },
      'contacts/ct1/credit_grants/pi_1': { credits_total: 10, credits_used: 0 },
      'courses/c1/purchases/ct1': { payment_ref: 'pi_1' },
    })
    await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: COURSE,
      plan: {
        subscription: 'clear_if_owned',
        credits: { op: 'reduce_to', total: 0 },
        course: 'delete_if_owned',
      },
    })
    assert.deepEqual(reads, [
      'contacts/ct1/plan_grants/pi_1',
      'contacts/ct1/credit_grants/pi_1',
      'courses/c1/purchases/ct1',
    ])
  })

  it('reads NOTHING when the plan touches nothing', async () => {
    const { db, reads, ops } = mockDb({
      'contacts/ct1': { subscription_type_id: 'st1', subscription_source_ref: 'pi_1' },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: { kind: 'product' },
      plan: { subscription: 'leave', credits: { op: 'leave' }, course: 'leave' },
    })
    assert.deepEqual(reads, [])
    assert.deepEqual(ops.updates, [])
    assert.deepEqual(ops.deletes, [])
    assert.deepEqual(out, {
      credits: 'left',
      creditsRevoked: 0,
      course: 'left',
      planGrant: 'left',
    })
  })
})

describe('reversePaymentEffects — the plan grant the payment made', () => {
  const CLEAR = {
    subscription: 'clear_if_owned' as const,
    credits: { op: 'leave' as const },
    course: 'leave' as const,
  }

  it('ends the grant keyed by the refunded payment, and keeps the row', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1/plan_grants/pi_1': { subscription_type_id: 'st1', ended_at: null },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: { kind: 'subscription', subscriptionTypeId: 'st1' },
      plan: CLEAR,
    })
    assert.equal(out.planGrant, 'ended')
    const end = ops.updates.find((u) => u.path === 'contacts/ct1/plan_grants/pi_1')
    assert.ok(end, 'the grant was ended')
    assert.equal(end.data.ended_reason, 'refund')
    assert.deepEqual(ops.deletes, [], 'never deleted')
  })

  it('reports absent — and writes nothing — when the grant is already ended', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1/plan_grants/pi_1': { subscription_type_id: 'st1', ended_at: { seconds: 1 } },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: { kind: 'subscription', subscriptionTypeId: 'st1' },
      plan: CLEAR,
    })
    assert.equal(out.planGrant, 'absent')
    assert.equal(ops.updates.filter((u) => u.path.includes('/plan_grants/')).length, 0)
  })

  it('a grant made by a DIFFERENT payment is out of reach: it is addressed by doc id only', async () => {
    const { db, ops } = mockDb({
      'contacts/ct1/plan_grants/pi_other': { subscription_type_id: 'st1', ended_at: null },
    })
    const out = await reversePaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      paymentRef: 'pi_1',
      lineItem: { kind: 'subscription', subscriptionTypeId: 'st1' },
      plan: CLEAR,
    })
    assert.equal(out.planGrant, 'absent')
    assert.equal(ops.updates.length, 0)
  })
})
