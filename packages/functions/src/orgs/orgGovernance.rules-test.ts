import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, setDoc, updateDoc } from 'firebase/firestore'

// Security-rules tests for the two escalations that made a fee waiver
// self-serve, and for the ONE that is not obvious.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// `tenantGovernance.rules-test.ts` beside this one proves a TEAM owner cannot
// write `plan`, `plan_status`, `trial_ends_at` or `flags` — including
// `flags.comped`, which (since 2026-08-28) waives Linyup's platform fee on every
// payment the studio takes. Two holes went around that proof entirely:
//
//   1. `organizations/{orgId}` had NO governance guard at all — a bare
//      `allow update: if hasOrgRole(orgId, 'org_admin')` — while becoming an
//      org_admin is self-service (`createOrganization` checks only that the
//      caller is signed in). So anyone could create an organization and comp it.
//
//   2. `users/{uid}` was writable by its owner with no field restriction, and
//      `roles` lives on that document. `hasRole()` reads it, `superadmin`
//      satisfies every role, and the team rule's guard is
//      `(paymentsUnchanged() && tenantGovernanceUnchanged()) || hasRole('admin')`
//      — so one write to your own user document DEFEATED the team guard rather
//      than going around it.
//
// The second is the one worth remembering: the team-side proof was real and
// still bypassable, because the bypass was in the predicate.
//
// Needs the Firestore emulator:
//   pnpm --filter @linyup/functions test:rules

const PROJECT_ID = 'demo-linyup-org-governance'

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
const ORG = 'orgA'
const TEAM = 'teamA'

let testEnv: RulesTestEnvironment

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'organizations', ORG), {
      name: 'Org A',
      slug: 'org-a',
      plan: 'organization',
      plan_status: 'trial',
      trial_ends_at: null,
      flags: {},
      createdBy: 'adminA',
    })
    await setDoc(doc(db, 'organizations', ORG, 'org_members', 'adminA'), { role: 'org_admin' })
    await setDoc(doc(db, 'users', 'adminA'), { currentTeam: TEAM, roles: {} })

    await setDoc(doc(db, 'teams', TEAM), {
      name: 'Team A',
      slug: 'team-a',
      plan: 'free',
      plan_status: 'active',
      flags: {},
      payments: {},
      createdBy: 'ownerA',
    })
    await setDoc(doc(db, 'teams', TEAM, 'team_members', 'ownerA'), {
      role: 'owner',
      capabilities: [],
    })
    await setDoc(doc(db, 'users', 'ownerA'), { currentTeam: TEAM, roles: {} })
  })
}

const asOrgAdmin = () => testEnv.authenticatedContext('adminA').firestore()
const asOwner = () => testEnv.authenticatedContext('ownerA').firestore()

describe('firestore.rules — an organization cannot comp itself', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
    })
  })

  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await seed()
  })

  it('an org admin can still edit ordinary organization details', async () => {
    await assertSucceeds(
      updateDoc(doc(asOrgAdmin(), 'organizations', ORG), {
        name: 'Renamed',
        description: 'Hello',
      })
    )
  })

  it('an org admin CANNOT comp their own organization', async () => {
    // The whole point. `flags.comped` exempts the org from the trial sweep, from
    // `lapseOrganization`, from the MRR line — and waives the platform fee at
    // every studio in it.
    await assertFails(
      updateDoc(doc(asOrgAdmin(), 'organizations', ORG), { flags: { comped: true } })
    )
  })

  it('an org admin CANNOT hide the organization from platform metrics', async () => {
    await assertFails(
      updateDoc(doc(asOrgAdmin(), 'organizations', ORG), { flags: { internal: true } })
    )
  })

  it('an org admin CANNOT grant a plan, a status, or extend a trial', async () => {
    await assertFails(updateDoc(doc(asOrgAdmin(), 'organizations', ORG), { plan_status: 'active' }))
    await assertFails(
      updateDoc(doc(asOrgAdmin(), 'organizations', ORG), {
        trial_ends_at: new Date(Date.now() + 9e8),
      })
    )
  })

  it('re-writing an unchanged governed value is allowed — it changes nothing', async () => {
    await assertSucceeds(
      updateDoc(doc(asOrgAdmin(), 'organizations', ORG), { plan_status: 'trial' })
    )
  })

  it('a NEW organization cannot be created carrying flags', async () => {
    // An unguarded create is the same grant, one document earlier.
    await assertFails(
      setDoc(doc(asOrgAdmin(), 'organizations', 'orgNew'), {
        name: 'New',
        createdBy: 'adminA',
        flags: { comped: true },
      })
    )
    await assertSucceeds(
      setDoc(doc(asOrgAdmin(), 'organizations', 'orgNew2'), { name: 'New', createdBy: 'adminA' })
    )
  })
})

describe('firestore.rules — `users.roles` is not self-grantable', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID + '-users',
      firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
    })
  })

  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await seed()
  })

  it('a user can still write their own ordinary profile fields', async () => {
    // The entire legitimate client write surface: locale, names, feedback counters.
    await assertSucceeds(
      setDoc(
        doc(asOwner(), 'users', 'ownerA'),
        { locale: 'de', firstname: 'A', lastname: 'B' },
        { merge: true }
      )
    )
  })

  it('a user CANNOT grant themselves the admin role', async () => {
    await assertFails(
      setDoc(doc(asOwner(), 'users', 'ownerA'), { roles: { admin: true } }, { merge: true })
    )
  })

  it('a user CANNOT grant themselves superadmin, which satisfies every role', async () => {
    await assertFails(
      setDoc(doc(asOwner(), 'users', 'ownerA'), { roles: { superadmin: true } }, { merge: true })
    )
  })

  it('a NEW user document cannot be created carrying roles', async () => {
    const fresh = testEnv.authenticatedContext('brandNew').firestore()
    await assertFails(
      setDoc(doc(fresh, 'users', 'brandNew'), { locale: 'en', roles: { admin: true } })
    )
    await assertSucceeds(setDoc(doc(fresh, 'users', 'brandNew'), { locale: 'en' }))
  })

  it('THE ESCALATION, end to end: self-granted admin no longer defeats the team guard', async () => {
    // Before this change the two writes below succeeded in sequence, and the
    // second one is the payload: `flags.comped` waives the platform fee on every
    // member payment the studio takes. The team rule's own guard was intact the
    // whole time — the bypass was inside it, via `|| hasRole('admin')`.
    const db = asOwner()
    await assertFails(
      setDoc(doc(db, 'users', 'ownerA'), { roles: { admin: true } }, { merge: true })
    )

    // And with roles genuinely unset, the governance guard does its job.
    const teamRef = doc(db, 'teams', TEAM)
    await assertFails(updateDoc(teamRef, { flags: { comped: true } }))
    await assertFails(updateDoc(teamRef, { plan: 'organization' }))
  })

  it('a REAL admin, provisioned server-side, still passes hasRole', async () => {
    // The guard must not have broken the legitimate path: roles written by the
    // Admin SDK are readable and still satisfy `hasRole('admin')`, which the team
    // rule accepts. Proven by the operator being able to do what an owner cannot.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'users', 'opA'),
        { currentTeam: TEAM, roles: { admin: true } },
        { merge: true }
      )
      await setDoc(doc(ctx.firestore(), 'teams', TEAM, 'team_members', 'opA'), {
        role: 'owner',
        capabilities: [],
      })
    })
    const op = testEnv.authenticatedContext('opA').firestore()
    await assertSucceeds(updateDoc(doc(op, 'teams', TEAM), { plan: 'studio' }))
  })

  it('…and that admin still cannot rewrite their own roles from the client', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'users', 'opB'),
        { roles: { admin: true } },
        { merge: true }
      )
    })
    const op = testEnv.authenticatedContext('opB').firestore()
    await assertFails(
      setDoc(doc(op, 'users', 'opB'), { roles: { superadmin: true } }, { merge: true })
    )
    // Unchanged is still fine — an idempotent profile save must not fail.
    await assertSucceeds(
      setDoc(doc(op, 'users', 'opB'), { roles: { admin: true }, locale: 'fr' }, { merge: true })
    )
  })
})

// A guard that cannot fail proves nothing.
describe('the org governance guard is capable of failing', () => {
  it('the rules file actually carries both fixes', () => {
    assert.ok(
      /allow update: if hasOrgRole\(orgId, 'org_admin'\) && tenantGovernanceUnchanged\(\)/.test(
        RULES
      ),
      'the organization update rule lost its governance guard'
    )
    assert.ok(
      /request\.resource\.data\.get\('roles', \{\}\) == resource\.data\.get\('roles', \{\}\)/.test(
        RULES
      ),
      'the users rule lost its roles pin — the admin role is self-grantable again'
    )
  })
})
