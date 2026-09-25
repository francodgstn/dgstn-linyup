import assert from 'node:assert/strict'
import type { firestore } from 'firebase-admin'
import { applyPaymentEffects, normalizePaymentLineItem } from './effects'

// Minimal Firestore double: records set/create/add ops keyed by their full path,
// and answers get() from a seed map. Enough to exercise applyPaymentEffects.
interface Ops {
  sets: Array<{ path: string; data: Record<string, unknown> }>
  creates: Array<{ path: string; data: Record<string, unknown> }>
  adds: Array<{ path: string; data: Record<string, unknown> }>
}

function mockDb(seed: Record<string, Record<string, unknown>>) {
  const ops: Ops = { sets: [], creates: [], adds: [] }
  const docRef = (path: string) => ({
    async get() {
      return { exists: seed[path] !== undefined, data: () => seed[path] }
    },
    async set(data: Record<string, unknown>) {
      ops.sets.push({ path, data })
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
    collection(name: string) {
      return colRef(`${path}/${name}`)
    },
  })
  const colRef = (path: string) => ({
    doc(id?: string) {
      return docRef(id ? `${path}/${id}` : `${path}/_auto${ops.adds.length}`)
    },
    async add(data: Record<string, unknown>) {
      ops.adds.push({ path, data })
    },
  })
  const db = { collection: (name: string) => colRef(name) } as unknown as firestore.Firestore
  return { db, ops }
}

describe('normalizePaymentLineItem', () => {
  it('rejects junk / unknown kinds', () => {
    assert.equal(normalizePaymentLineItem(null), null)
    assert.equal(normalizePaymentLineItem({ kind: 'bogus' }), null)
    assert.equal(normalizePaymentLineItem('nope'), null)
  })

  it('passes a valid subscription line-item through', () => {
    const li = normalizePaymentLineItem({ kind: 'subscription', subscriptionTypeId: 'st1', priceId: 'p1' })
    assert.deepEqual(li, { kind: 'subscription', subscriptionTypeId: 'st1', priceId: 'p1' })
  })

  it('downgrades an effect-less subscription/course link to "other"', () => {
    assert.deepEqual(normalizePaymentLineItem({ kind: 'subscription', label: 'x' }), {
      kind: 'other',
      label: 'x',
    })
    assert.deepEqual(normalizePaymentLineItem({ kind: 'course' }), { kind: 'other' })
  })

  it('keeps product + variant', () => {
    const li = normalizePaymentLineItem({ kind: 'product', productId: 'pr1', variantId: 'v1', label: 'Tee · L' })
    assert.deepEqual(li, { kind: 'product', productId: 'pr1', variantId: 'v1', label: 'Tee · L' })
  })
})

describe('applyPaymentEffects', () => {
  it('subscription → gives a plan grant + grants credits + logs activity', async () => {
    const { db, ops } = mockDb({
      'teams/t1/subscription_types/st1': {
        name: 'Monthly',
        prices: [{ id: 'p1', amount: 50, recurrence: 'monthly', credits: 8, included_months: 1 }],
      },
    })
    await applyPaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      lineItem: { kind: 'subscription', subscriptionTypeId: 'st1', priceId: 'p1' },
      amountRappen: 5000,
      currency: 'CHF',
      source: 'manual',
      paymentRef: 'manual:x',
    })

    // The plan is a grant keyed by the payment — what a reversal ends. The
    // contact carries no plan field; only the last payment is stamped on it.
    const planGrant = ops.creates.find((c) => c.path === 'contacts/ct1/plan_grants/manual:x')
    assert.ok(planGrant, 'plan grant created')
    assert.equal(planGrant!.data.subscription_type_id, 'st1')
    assert.equal(planGrant!.data.subscription_type_name, 'Monthly')
    assert.equal(planGrant!.data.price_id, 'p1')
    assert.equal(planGrant!.data.amount, 50)
    assert.equal(planGrant!.data.source_ref, 'manual:x')
    const contactSet = ops.sets.find((s) => s.path === 'contacts/ct1')
    assert.ok(contactSet, 'last payment stamped')
    assert.deepEqual(Object.keys(contactSet!.data), ['last_payment_at'])

    const grant = ops.creates.find((c) => c.path === 'contacts/ct1/credit_grants/manual:x')
    assert.ok(grant, 'credit grant created')
    assert.equal(grant!.data.credits_total, 8)
    assert.equal(grant!.data.credits_used, 0)
    assert.equal(grant!.data.source, 'manual')
    // Doc id IS the payment ref — that is what a reversal keys off.
    assert.equal(grant!.data.payment_ref, 'manual:x')

    const activity = ops.adds.find((a) => a.path === 'contacts/ct1/activity_log')
    assert.ok(activity, 'activity logged')
    assert.equal(activity!.data.type, 'payment_received')
    assert.equal(activity!.data.payment_id, 'manual:x')
  })

  it('subscription without credits → no credit grant', async () => {
    const { db, ops } = mockDb({
      'teams/t1/subscription_types/st1': {
        name: 'Monthly',
        prices: [{ id: 'p1', amount: 50, recurrence: 'monthly' }],
      },
    })
    await applyPaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      lineItem: { kind: 'subscription', subscriptionTypeId: 'st1', priceId: 'p1' },
      amountRappen: 5000,
      currency: 'CHF',
      source: 'manual',
      paymentRef: 'manual:x',
    })
    // Assert the ABSENCE OF A GRANT, not the absence of every create: this
    // purchase legitimately records a plan_purchases row (the per-contact
    // purchase-cap ledger), and a bare count would have failed for that.
    assert.equal(
      ops.creates.filter((c) => c.path.includes('/credit_grants/')).length,
      0,
      'no credit grant for a price that carries no credits'
    )
  })

  it('subscription → records the purchase, keyed by the payment ref', async () => {
    const { db, ops } = mockDb({
      'teams/t1/subscription_types/st1': {
        name: 'Intro',
        prices: [{ id: 'p1', amount: 100, recurrence: 'one_time', included_months: 2 }],
      },
    })
    await applyPaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      lineItem: { kind: 'subscription', subscriptionTypeId: 'st1', priceId: 'p1' },
      amountRappen: 10000,
      currency: 'CHF',
      source: 'manual',
      paymentRef: 'manual:x',
    })
    // Doc id IS the payment ref — that is the whole idempotency story: the same
    // purchase arriving twice cannot spend two of a member's allowed purchases.
    const purchase = ops.creates.find((c) => c.path === 'contacts/ct1/plan_purchases/manual:x')
    assert.ok(purchase, 'plan purchase recorded')
    assert.equal(purchase!.data.price_id, 'p1')
    assert.equal(purchase!.data.subscription_type_id, 'st1')

    // ...and the grant it bought carries its own end date, because a one-time
    // price with included_months has no renewal to end it.
    const planGrant = ops.creates.find((c) => c.path === 'contacts/ct1/plan_grants/manual:x')
    assert.ok(planGrant, 'plan grant created')
    assert.ok(planGrant!.data.expires_at, 'expiry stamped from included_months')
  })

  it('course → grants the entitlement + logs activity', async () => {
    const { db, ops } = mockDb({ 'courses/c1': { teamId: 't1', title: 'Yoga 101' } })
    await applyPaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      lineItem: { kind: 'course', courseId: 'c1' },
      amountRappen: 9900,
      currency: 'CHF',
      source: 'manual',
      paymentRef: 'manual:y',
    })
    const purchase = ops.sets.find((s) => s.path === 'courses/c1/purchases/ct1')
    assert.ok(purchase, 'entitlement granted')
    assert.equal(purchase!.data.courseId, 'c1')
    assert.equal(purchase!.data.contactId, 'ct1')
    // The doc id is the CONTACT, so this is the only thing that says which
    // payment bought it — and the only thing a reversal may act on.
    assert.equal(purchase!.data.payment_ref, 'manual:y')
    const activity = ops.adds.find((a) => a.path === 'contacts/ct1/activity_log')
    assert.equal(activity?.data.type, 'course_purchased')
  })

  it('course from another team → no entitlement (guarded)', async () => {
    const { db, ops } = mockDb({ 'courses/c2': { teamId: 'other', title: 'X' } })
    await applyPaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      lineItem: { kind: 'course', courseId: 'c2' },
      amountRappen: 9900,
      currency: 'CHF',
      source: 'manual',
      paymentRef: 'manual:z',
    })
    assert.equal(ops.sets.length, 0)
    assert.equal(ops.adds.length, 0)
  })

  it('product → activity only (no entitlement)', async () => {
    const { db, ops } = mockDb({})
    await applyPaymentEffects(db, {
      teamId: 't1',
      contactId: 'ct1',
      lineItem: { kind: 'product', productId: 'pr1', label: 'Tee' },
      amountRappen: 2500,
      currency: 'CHF',
      source: 'manual',
      paymentRef: 'manual:p',
    })
    assert.ok(ops.sets.find((s) => s.path === 'contacts/ct1'), 'last_payment_at stamped')
    const activity = ops.adds.find((a) => a.path === 'contacts/ct1/activity_log')
    assert.equal(activity?.data.type, 'product_purchased')
    // No course/subscription writes.
    assert.equal(ops.creates.length, 0)
    assert.ok(!ops.sets.find((s) => s.path.includes('purchases')))
  })
})
