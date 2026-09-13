import assert from 'node:assert/strict'
import type { firestore } from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  IMPORTED_SLOT_GRANT_ID,
  importedSlotGrantDoc,
  newPlanGrantDoc,
  planGrantIsOpen,
  planGrantSourceForRail,
  setPaymentPlanGrantInTx,
  writePaymentPlanGrant,
  type PaymentPlanGrantInput,
  type PlanGrantPlan,
} from './planGrants'
import { clearedSlotFields, shouldClearSlot, slotFieldsForStaffPlan } from './planCallables'

// Plan grants — the ONE writer of contacts/{c}/plan_grants
// (docs/multi-plan-holdings.md, phase 2). What is pinned here: a payment's grant
// is keyed by the payment and converges however often it is applied; an ended
// grant is never revived; the staff bridge writes the slot whole and clears it
// only when nothing open still holds its plan.

// Minimal Firestore double: get/create/set by full path off a seed map.
function mockDb(seed: Record<string, Record<string, unknown>>) {
  const ops = {
    creates: [] as Array<{ path: string; data: Record<string, unknown> }>,
    sets: [] as Array<{ path: string; data: Record<string, unknown>; merge: boolean }>,
  }
  const docRef = (path: string) => ({
    path,
    async get() {
      return { exists: seed[path] !== undefined, data: () => seed[path] }
    },
    async create(data: Record<string, unknown>) {
      if (seed[path] !== undefined) {
        const e = new Error('already exists') as Error & { code?: number }
        e.code = 6
        throw e
      }
      seed[path] = data
      ops.creates.push({ path, data })
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      seed[path] = opts?.merge ? { ...(seed[path] ?? {}), ...data } : data
      ops.sets.push({ path, data, merge: Boolean(opts?.merge) })
    },
    collection: (name: string) => colRef(`${path}/${name}`),
  })
  const colRef = (path: string) => ({ doc: (id: string) => docRef(`${path}/${id}`) })
  const db = { collection: (name: string) => colRef(name) } as unknown as firestore.Firestore
  return { db, ops, seed }
}

const PLAN: PlanGrantPlan = {
  subscriptionTypeId: 'st1',
  subscriptionTypeName: 'Monthly',
  priceId: 'p1',
  recurrence: 'monthly',
  amountMajor: 89,
  expiresAt: null,
}
const INPUT: PaymentPlanGrantInput = { ...PLAN, teamId: 't1', source: 'purchase', paymentRef: 'pay_1' }
const GRANT_PATH = 'contacts/ct1/plan_grants/pay_1'

describe('plan grants — a payment grant', () => {
  it('is created under the payment ref, carrying the payment as its source', async () => {
    const { db, ops } = mockDb({})
    assert.equal(await writePaymentPlanGrant(db, 'ct1', INPUT), 'created')
    assert.equal(ops.creates.length, 1)
    const { path, data } = ops.creates[0]
    assert.equal(path, GRANT_PATH)
    assert.equal(data.source, 'purchase')
    assert.equal(data.source_ref, 'pay_1')
    assert.equal(data.created_by, null)
    assert.equal(data.ended_at, null)
    assert.equal(data.subscription_type_id, 'st1')
    assert.equal(data.price_id, 'p1')
    assert.equal(data.amount, 89)
  })

  it('a second event about the same payment changes nothing', async () => {
    const { db, ops } = mockDb({})
    await writePaymentPlanGrant(db, 'ct1', INPUT)
    assert.equal(await writePaymentPlanGrant(db, 'ct1', INPUT), 'unchanged')
    assert.equal(ops.creates.length, 1)
    assert.equal(ops.sets.length, 0)
  })

  it('a re-link of the payment to another price corrects its own grant in place', async () => {
    const { db, ops, seed } = mockDb({
      [GRANT_PATH]: { subscription_type_id: 'st1', price_id: 'p0', ended_at: null },
    })
    assert.equal(await writePaymentPlanGrant(db, 'ct1', INPUT), 'corrected')
    assert.equal(ops.sets.length, 1)
    assert.equal(ops.sets[0].merge, true)
    assert.equal(seed[GRANT_PATH].price_id, 'p1')
    assert.ok('corrected_at' in ops.sets[0].data)
  })

  it('an ended grant is never revived by a re-apply', async () => {
    const endedAt = Timestamp.fromMillis(1)
    const { db, ops } = mockDb({
      [GRANT_PATH]: { subscription_type_id: 'st0', price_id: null, ended_at: endedAt, ended_reason: 'refund' },
    })
    assert.equal(await writePaymentPlanGrant(db, 'ct1', INPUT), 'ended')
    assert.equal(ops.creates.length + ops.sets.length, 0)
  })

  it('inside a transaction: written when absent, left alone when present', () => {
    const writes: unknown[] = []
    const tx = { set: (_ref: unknown, data: unknown) => writes.push(data) } as unknown as firestore.Transaction
    const ref = {} as firestore.DocumentReference
    assert.equal(setPaymentPlanGrantInTx(tx, ref, { exists: true }, INPUT), false)
    assert.equal(writes.length, 0)
    assert.equal(setPaymentPlanGrantInTx(tx, ref, { exists: false }, INPUT), true)
    assert.equal((writes[0] as Record<string, unknown>).source_ref, 'pay_1')
  })

  it("the studio's own gateways are 'gateway'; every other rail that took money is 'purchase'", () => {
    assert.equal(planGrantSourceForRail('payrexx'), 'gateway')
    assert.equal(planGrantSourceForRail('stripe'), 'gateway')
    assert.equal(planGrantSourceForRail('byo'), 'gateway')
    assert.equal(planGrantSourceForRail('manual'), 'purchase')
    assert.equal(planGrantSourceForRail('stripe_connect'), 'purchase')
  })
})

describe('plan grants — open or not', () => {
  const NOW = Date.UTC(2026, 8, 13)
  it('an ended grant is not open; an expired one is not; one with no end or a future end is', () => {
    assert.equal(planGrantIsOpen({ ended_at: Timestamp.fromMillis(NOW - 1) }, NOW), false)
    assert.equal(planGrantIsOpen({ ended_at: null, expires_at: Timestamp.fromMillis(NOW) }, NOW), false)
    assert.equal(planGrantIsOpen({ ended_at: null, expires_at: null }, NOW), true)
    assert.equal(planGrantIsOpen({ ended_at: null, expires_at: Timestamp.fromMillis(NOW + 1) }, NOW), true)
  })

  it("a new row starts on this process's clock and has no end of its own unless the plan says so", () => {
    const doc = newPlanGrantDoc('t1', PLAN, { source: 'staff', sourceRef: null, createdBy: 'uid1' })
    assert.ok(doc.starts_at instanceof Timestamp)
    assert.equal(doc.expires_at, null)
    assert.equal(doc.created_by, 'uid1')
    assert.equal(doc.source, 'staff')
  })
})

describe('plan grants — the staff bridge to the legacy slot', () => {
  it('writes the slot whole, with no payment ref and no last payment', () => {
    const fields = slotFieldsForStaffPlan({ ...PLAN, priceId: null, amountMajor: null, recurrence: null })
    for (const key of [
      'subscription_type_id',
      'subscription_type_name',
      'subscription_price_id',
      'subscription_recurrence',
      'subscription_amount',
      'subscription_source_ref',
      'subscription_expires_at',
    ]) {
      assert.ok(key in fields, `${key} is written, null included`)
    }
    assert.equal(fields.subscription_source_ref, null)
    assert.equal('last_payment_at' in fields, false)
  })

  it('clearing nulls every slot field', () => {
    const fields = clearedSlotFields()
    assert.equal(fields.subscription_type_id, null)
    assert.equal(fields.subscription_expires_at, null)
    assert.equal(fields.subscription_source_ref, null)
  })

  it('ending every current plan clears the slot; ending one clears it only when nothing open still holds that plan', () => {
    const base = { slotTypeId: 'st1', endedTypeIds: ['st1'], openTypeIdsAfter: [] as string[] }
    assert.equal(shouldClearSlot({ ...base, allCurrent: true, endedTypeIds: [] }), true)
    assert.equal(shouldClearSlot({ ...base, allCurrent: false }), true)
    assert.equal(shouldClearSlot({ ...base, allCurrent: false, openTypeIdsAfter: ['st1'] }), false)
    assert.equal(shouldClearSlot({ ...base, allCurrent: false, endedTypeIds: ['st2'] }), false)
    assert.equal(shouldClearSlot({ ...base, allCurrent: true, slotTypeId: null }), false)
  })
})

describe('plan grants — the legacy slot, imported', () => {
  it('no slot, no grant', () => {
    assert.equal(importedSlotGrantDoc({ teamId: 't1' }), null)
    assert.equal(importedSlotGrantDoc({ teamId: 't1', subscription_type_id: '  ' }), null)
  })

  it("carries the slot's own fields, source 'import', and starts at the slot's last change", () => {
    const changed = Timestamp.fromMillis(1_000)
    const doc = importedSlotGrantDoc({
      teamId: 't1',
      subscription_type_id: 'st1',
      subscription_type_name: 'Monthly',
      subscription_price_id: 'p1',
      subscription_recurrence: 'monthly',
      subscription_amount: 89,
      subscription_source_ref: 'pay_9',
      subscription_expires_at: null,
      subscription_type_updated_at: changed,
      created_at: Timestamp.fromMillis(1),
    })
    assert.ok(doc)
    assert.equal(doc.source, 'import')
    assert.equal(doc.source_ref, 'pay_9')
    assert.equal(doc.starts_at, changed)
    assert.equal(doc.amount, 89)
    assert.equal(IMPORTED_SLOT_GRANT_ID, 'import-slot')
  })
})
