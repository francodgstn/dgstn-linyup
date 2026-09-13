import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

// Security rules for multi-plan holdings (docs/multi-plan-holdings.md, phase 1).
//
// `contacts/{id}/plan_grants` rows are written ONLY by Cloud Functions and the
// import backfill; the contact's `held_plans` mirror is written ONLY by
// `recomputeHeldPlans`. Rules are additive, so the catch-all child-collection
// rule must name `plan_grants` in its write exclusions or its blanket staff
// grant would override the explicit deny — which is what the create case below
// would catch.
//
//   pnpm --filter @linyup/functions test:rules

function findRules(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'firestore.rules')
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    dir = path.dirname(dir)
  }
  throw new Error('firestore.rules not found above ' + process.cwd())
}

const RULES = findRules()
const TEAM = 'teamPlanGrants'
const CONTACT = 'contactPlanGrants'
const OWNER = 'ownerPlanGrants'
const OUTSIDER = 'outsiderPlanGrants'

let testEnv: RulesTestEnvironment

const ownerDb = () => testEnv.authenticatedContext(OWNER).firestore()
const outsiderDb = () => testEnv.authenticatedContext(OUTSIDER).firestore()
const selfDb = () =>
  testEnv
    .authenticatedContext('contact:' + CONTACT, {
      contactId: CONTACT,
      teamId: TEAM,
      sessionExpires: Date.now() + 3_600_000,
    })
    .firestore()

const GRANT = {
  teamId: TEAM,
  subscription_type_id: 'plan-a',
  subscription_type_name: 'Plan A',
  price_id: null,
  recurrence: 'monthly',
  amount: 89,
  source: 'staff',
  source_ref: null,
  starts_at: new Date(),
  expires_at: null,
  ended_at: null,
  ended_reason: null,
  created_by: OWNER,
  created_at: new Date(),
}

describe('firestore.rules — plan grants and the held_plans mirror', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-plan-grants',
      firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
    })
  })
  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'contacts', CONTACT), { teamId: TEAM, firstname: 'Robin' })
      await setDoc(doc(db, 'contacts', CONTACT, 'plan_grants', 'g1'), GRANT)
      await setDoc(doc(db, 'teams', TEAM, 'team_members', OWNER), { role: 'owner' })
      await setDoc(doc(db, 'users', OWNER), { currentTeam: TEAM })
      await setDoc(doc(db, 'users', OUTSIDER), { currentTeam: 'someOtherTeam' })
    })
  })

  // ── plan_grants ───────────────────────────────────────────────────────────

  it('a team owner CAN read a grant', async () => {
    await assertSucceeds(getDoc(doc(ownerDb(), 'contacts', CONTACT, 'plan_grants', 'g1')))
  })

  it('the contact themself CAN read their own grants, as with credit grants', async () => {
    await assertSucceeds(getDoc(doc(selfDb(), 'contacts', CONTACT, 'plan_grants', 'g1')))
  })

  it('a non-member CANNOT read a grant', async () => {
    await assertFails(getDoc(doc(outsiderDb(), 'contacts', CONTACT, 'plan_grants', 'g1')))
  })

  it('a team owner CANNOT create a grant — the catch-all must not re-open writes', async () => {
    await assertFails(setDoc(doc(ownerDb(), 'contacts', CONTACT, 'plan_grants', 'g2'), GRANT))
  })

  it('a team owner CANNOT edit or delete a grant', async () => {
    await assertFails(updateDoc(doc(ownerDb(), 'contacts', CONTACT, 'plan_grants', 'g1'), { amount: 0 }))
    await assertFails(deleteDoc(doc(ownerDb(), 'contacts', CONTACT, 'plan_grants', 'g1')))
  })

  it('the contact themself CANNOT write a grant', async () => {
    await assertFails(setDoc(doc(selfDb(), 'contacts', CONTACT, 'plan_grants', 'g3'), GRANT))
  })

  // ── the mirror on the contact ─────────────────────────────────────────────

  it('a team owner CANNOT forge the plan list on the contact', async () => {
    const db = ownerDb()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT), {
        held_plans: [{ subscription_type_id: 'plan-x', source: 'grant', ref: 'forged' }],
      })
    )
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { held_plan_type_ids: ['plan-x'] }))
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { held_plans_next_change_at_ms: 0 }))
  })

  it('a team owner CAN still update an ordinary contact field', async () => {
    await assertSucceeds(updateDoc(doc(ownerDb(), 'contacts', CONTACT), { firstname: 'Sam' }))
  })

  // ── the legacy plan slot, server-written since phase 2 ────────────────────

  it('a team owner CANNOT write the legacy plan slot — plans go through the plan callables', async () => {
    const db = ownerDb()
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { subscription_type_id: 'plan-x' }))
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { subscription_expires_at: null }))
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { subscription_source_ref: 'pay_1' }))
  })

  it('a team owner CANNOT create a contact that already holds a plan', async () => {
    await assertFails(
      setDoc(doc(ownerDb(), 'contacts', 'contactWithPlan'), {
        teamId: TEAM,
        firstname: 'Kim',
        subscription_type_id: 'plan-x',
      })
    )
  })

  it('a team owner CAN still create an ordinary contact', async () => {
    await assertSucceeds(
      setDoc(doc(ownerDb(), 'contacts', 'contactPlain'), { teamId: TEAM, firstname: 'Kim' })
    )
  })
})
