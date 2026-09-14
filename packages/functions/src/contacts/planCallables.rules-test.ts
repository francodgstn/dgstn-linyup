import assert from 'node:assert/strict'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { assignPlan, changePlan, endPlan } from './planCallables'

// The staff plan callables, run against the Firestore emulator
// (docs/multi-plan-holdings.md, phase 2). Their pure parts are pinned in
// planGrants.test.ts; this runs what only a real Firestore can check — the
// transactions (every read before any write), the grant rows, the legacy-slot
// bridge — and the contact write check the rules used to make, now made here.
//
// A *.rules-test.ts file so it runs in the emulator job, not because it tests
// rules: the Admin SDK it uses bypasses them.
//
//   pnpm --filter @linyup/functions test:rules

if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-linyup' })
const db = () => admin.firestore()

const TEAM = 'teamPlanCallables'
const CONTACT = 'contactPlanCallables'
const OTHER_CONTACT = 'contactPlanCallablesOther'
const OWNER = 'ownerPlanCallables'
const COACH = 'coachPlanCallables'
const VIEWER = 'viewerPlanCallables'

const MONTHLY = { subscriptionTypeId: 'st-monthly', priceId: 'p-monthly' }
const INTRO = { subscriptionTypeId: 'st-intro', priceId: 'p-intro' }

type Grant = { id: string } & Record<string, unknown>

function call<T>(
  fn: { run(request: CallableRequest<unknown>): unknown },
  uid: string | null,
  data: Record<string, unknown>
): Promise<T> {
  const request = { auth: uid ? { uid, token: {} } : undefined, data, rawRequest: {} }
  return Promise.resolve(fn.run(request as unknown as CallableRequest<unknown>)) as Promise<T>
}

async function refusedWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: { code?: string }) => {
    assert.equal(err.code, code)
    return true
  })
}

const contactRef = () => db().collection('contacts').doc(CONTACT)
const contact = async () => (await contactRef().get()).data() ?? {}
const grants = async (): Promise<Grant[]> =>
  (await contactRef().collection('plan_grants').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const openGrants = async () => (await grants()).filter((g) => g.ended_at == null)

describe('plan callables — against the Firestore emulator', function () {
  this.timeout(30_000)

  // The Admin SDK holds its connection open, and an open handle keeps mocha —
  // and so `emulators:exec` — from ever exiting.
  after(async () => {
    await Promise.all(admin.apps.map((app) => app?.delete()))
  })

  beforeEach(async () => {
    await db().recursiveDelete(contactRef())
    await db().recursiveDelete(db().collection('contacts').doc(OTHER_CONTACT))
    const team = db().collection('teams').doc(TEAM)
    await team.collection('team_members').doc(OWNER).set({ role: 'owner' })
    await team
      .collection('team_members')
      .doc(COACH)
      .set({ role: 'coach', scope: 'own', capabilities: ['contacts.manage'] })
    await team.collection('team_members').doc(VIEWER).set({ role: 'viewer', capabilities: [] })
    await team
      .collection('subscription_types')
      .doc('st-monthly')
      .set({ name: 'Monthly', prices: [{ id: 'p-monthly', amount: 89, recurrence: 'monthly' }] })
    await team.collection('subscription_types').doc('st-intro').set({
      name: 'Intro',
      prices: [{ id: 'p-intro', amount: 100, recurrence: 'one_time', included_months: 2 }],
    })
    await contactRef().set({
      teamId: TEAM,
      firstname: 'Robin',
      provisional: true,
      provisional_expires_at: Timestamp.now(),
      assigned_coach_ids: [COACH],
    })
    await db().collection('contacts').doc(OTHER_CONTACT).set({ teamId: TEAM, firstname: 'Sam', assigned_coach_ids: [] })
  })

  it('assignPlan gives a staff grant, writes the slot as the bridge, and materialises a provisional lead', async () => {
    const res = await call<{ grantId: string; duplicate: boolean }>(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY })
    assert.equal(res.duplicate, false)
    const [grant] = await grants()
    assert.equal(grant.id, res.grantId)
    assert.equal(grant.source, 'staff')
    assert.equal(grant.created_by, OWNER)
    assert.equal(grant.price_id, 'p-monthly')
    assert.equal(grant.amount, 89)
    assert.equal(grant.expires_at, null)
    const c = await contact()
    assert.equal(c.subscription_type_id, 'st-monthly')
    assert.equal(c.subscription_type_name, 'Monthly')
    assert.equal(c.subscription_source_ref, null)
    assert.equal(c.provisional, undefined)
    assert.equal('last_payment_at' in c, false, 'nobody paid')
  })

  it('assignPlan ADDS by default, and a price with included months gives the grant its own end', async () => {
    await call(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY })
    await call(assignPlan, OWNER, { contactId: CONTACT, ...INTRO })
    const open = await openGrants()
    assert.equal(open.length, 2)
    assert.ok(open.find((g) => g.subscription_type_id === 'st-intro')?.expires_at instanceof Timestamp)
  })

  it("replace: true ends every open plan as 'changed' before giving the new one", async () => {
    await call(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY })
    const res = await call<{ ended: string[] }>(assignPlan, OWNER, { contactId: CONTACT, ...INTRO, replace: true })
    assert.equal(res.ended.length, 1)
    const all = await grants()
    assert.equal(all.length, 2, 'the replaced row stays: it is the record')
    const replaced = all.find((g) => g.subscription_type_id === 'st-monthly')
    assert.equal(replaced?.ended_reason, 'changed')
    assert.ok(replaced?.ended_at instanceof Timestamp)
    assert.equal((await openGrants()).length, 1)
    assert.equal((await contact()).subscription_type_id, 'st-intro')
  })

  it('an idempotency key turns a second click into a duplicate, not a second plan', async () => {
    const first = await call<{ duplicate: boolean }>(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY, idempotencyKey: 'click-1' })
    const second = await call<{ duplicate: boolean }>(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY, idempotencyKey: 'click-1' })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
    assert.equal((await grants()).length, 1)
  })

  it('changePlan ends the named grant and gives its replacement', async () => {
    const { grantId } = await call<{ grantId: string }>(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY })
    const res = await call<{ grantId: string; ended: string[] }>(changePlan, OWNER, { contactId: CONTACT, grantId, ...INTRO })
    assert.deepEqual(res.ended, [grantId])
    const open = await openGrants()
    assert.deepEqual(open.map((g) => g.id), [res.grantId])
    assert.equal((await grants()).find((g) => g.id === grantId)?.ended_reason, 'changed')
    await refusedWith(call(changePlan, OWNER, { contactId: CONTACT, grantId, ...MONTHLY }), 'failed-precondition')
  })

  it('endPlan ends one grant; the slot empties only when nothing open still holds its plan', async () => {
    const a = await call<{ grantId: string }>(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY })
    const b = await call<{ grantId: string }>(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY })
    const first = await call<{ ended: string[]; slotCleared: boolean }>(endPlan, OWNER, { contactId: CONTACT, grantId: a.grantId })
    assert.deepEqual(first.ended, [a.grantId])
    assert.equal(first.slotCleared, false, 'a second grant of the same plan is still open')
    assert.equal((await contact()).subscription_type_id, 'st-monthly')
    const second = await call<{ slotCleared: boolean }>(endPlan, OWNER, { contactId: CONTACT, grantId: b.grantId })
    assert.equal(second.slotCleared, true)
    assert.equal((await contact()).subscription_type_id, null)
    const again = await call<{ ended: string[] }>(endPlan, OWNER, { contactId: CONTACT, grantId: b.grantId })
    assert.deepEqual(again.ended, [], 'ending an ended grant is a no-op')
  })

  it('endPlan with allCurrent ends every open plan and empties the slot', async () => {
    await call(assignPlan, OWNER, { contactId: CONTACT, ...MONTHLY })
    await call(assignPlan, OWNER, { contactId: CONTACT, ...INTRO })
    const res = await call<{ ended: string[]; slotCleared: boolean }>(endPlan, OWNER, { contactId: CONTACT, allCurrent: true })
    assert.equal(res.ended.length, 2)
    assert.equal(res.slotCleared, true)
    assert.equal((await openGrants()).length, 0)
    assert.equal((await grants()).every((g) => g.ended_reason === 'staff'), true)
  })

  it('an own-scoped coach may change the plans of their own contact, and of no other', async () => {
    await call(assignPlan, COACH, { contactId: CONTACT, ...MONTHLY })
    assert.equal((await grants()).length, 1)
    await refusedWith(call(assignPlan, COACH, { contactId: OTHER_CONTACT, ...MONTHLY }), 'permission-denied')
  })

  it('a member without contacts.manage, and a signed-out caller, are refused', async () => {
    await refusedWith(call(assignPlan, VIEWER, { contactId: CONTACT, ...MONTHLY }), 'permission-denied')
    await refusedWith(call(endPlan, null, { contactId: CONTACT, allCurrent: true }), 'unauthenticated')
    assert.equal((await grants()).length, 0)
  })

  it('a price that is not on the plan is refused before anything is written', async () => {
    await refusedWith(
      call(assignPlan, OWNER, { contactId: CONTACT, subscriptionTypeId: 'st-monthly', priceId: 'p-intro' }),
      'not-found'
    )
    assert.equal((await grants()).length, 0)
    assert.equal((await contact()).subscription_type_id, undefined)
  })
})
