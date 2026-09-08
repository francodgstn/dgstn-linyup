import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { collectionGroup, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore'

// Security-rules tests for the COLLECTION-GROUP read of contact affiliations —
// the studio's own roster, and the issuing organisation's.
//
// BOTH Affiliations pages asked the same shape and NEITHER worked:
//   collectionGroup('affiliations').where('teamId','==',myTeam)      (studio)
//   collectionGroup('affiliations').where('org_id','==',orgId)       (org)
// A collection-group read is matched ONLY by a `{path=**}` statement, and there
// was none for `affiliations` — the nested `contacts/{id}/{sub}/{doc}` catch-all
// cannot serve one. So every status on both pages came back empty: a permission
// denial wearing the costume of a roster where nobody holds anything.
//
// The org half had a second cause on top: even per-document, the catch-all gates
// on `canAccessContact`, which starts at `belongsToUserTeam` —
// `resource.data.teamId == getUserCurrentTeam()`. A federation admin is not a
// member of the studios in the federation.
//
// The issuer's arm reads `org_id` off the affiliation itself, so what it admits
// is exactly what this organisation granted. The tests below are as much about
// what it does NOT admit: a studio's own club membership, a governing body the
// studio merely tracks, another organisation's rows, an org_viewer, an
// own-scoped coach, and any write at all.
//
// Runs against the isolated emulator only:
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
const ORG = 'fedOrg'
const OTHER_ORG = 'rivalOrg'
const STUDIO = 'memberStudio'

let testEnv: RulesTestEnvironment

describe('firestore.rules — an organisation reads the affiliations it issued', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-org-affiliation-read',
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

      await setDoc(doc(db, 'organizations', ORG), { name: 'Federation', slug: 'fed' })
      await setDoc(doc(db, 'organizations', ORG, 'org_members', 'fedAdmin'), {
        role: 'org_admin',
        userId: 'fedAdmin',
      })
      await setDoc(doc(db, 'organizations', ORG, 'org_members', 'fedViewer'), {
        role: 'org_viewer',
        userId: 'fedViewer',
      })

      await setDoc(doc(db, 'organizations', OTHER_ORG), { name: 'Rival', slug: 'rival' })
      await setDoc(doc(db, 'organizations', OTHER_ORG, 'org_members', 'rivalAdmin'), {
        role: 'org_admin',
        userId: 'rivalAdmin',
      })

      // A member studio and one of its people. THE ADMIN IS NOT A MEMBER OF IT —
      // that is the whole point: a federation admin is not staff at its clubs.
      await setDoc(doc(db, 'organizations', ORG, 'org_teams', STUDIO), {
        teamId: STUDIO,
        orgId: ORG,
        status: 'active',
      })
      await setDoc(doc(db, 'teams', STUDIO), {
        name: 'Member Studio',
        slug: 'member-studio',
        org_id: ORG,
        createdBy: 'studioOwner',
      })
      await setDoc(doc(db, 'teams', STUDIO, 'team_members', 'studioOwner'), {
        role: 'owner',
        userId: 'studioOwner',
      })
      await setDoc(doc(db, 'users', 'studioOwner'), { currentTeam: STUDIO })
      // An own-scoped coach: may read only the contacts in their own book.
      await setDoc(doc(db, 'teams', STUDIO, 'team_members', 'ownCoach'), {
        role: 'coach',
        userId: 'ownCoach',
        scope: 'own',
      })
      await setDoc(doc(db, 'users', 'ownCoach'), { currentTeam: STUDIO })
      await setDoc(doc(db, 'contacts', 'c1'), {
        teamId: STUDIO,
        firstname: 'Ada',
        lastname: 'Lovelace',
        deleted_at: null,
        archived_at: null,
      })

      // THE THREE ISSUERS, all in the same subcollection. Only the first is the
      // federation's business.
      await setDoc(doc(db, 'contacts', 'c1', 'affiliations', 'orgLicence'), {
        teamId: STUDIO,
        issuer: 'org',
        org_id: ORG,
        affiliation_type_id: 'licence',
        status_id: 'active',
        active: true,
      })
      await setDoc(doc(db, 'contacts', 'c1', 'affiliations', 'clubMembership'), {
        teamId: STUDIO,
        issuer: 'team',
        affiliation_type_id: 'club',
        status_id: 'active',
        active: true,
      })
      await setDoc(doc(db, 'contacts', 'c1', 'affiliations', 'externalGrading'), {
        teamId: STUDIO,
        issuer: 'external',
        issuer_name: 'World Federation',
        affiliation_type_id: 'grading',
        status_id: 'active',
        active: true,
      })
    })
  })

  // ── the fix ────────────────────────────────────────────────────────────────

  it('the issuing org admin can read an affiliation it granted, in a studio it is not a member of', async () => {
    const db = testEnv.authenticatedContext('fedAdmin').firestore()
    await assertSucceeds(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'orgLicence')))
  })

  it('the collection-group query the org Affiliations page actually runs succeeds', async () => {
    // THE REGRESSION ITSELF. Rules are evaluated per document on a list, so this
    // passes only while every row the filter returns is readable — which is why
    // the org_id filter and the rule's org_id read have to be the same fact.
    const db = testEnv.authenticatedContext('fedAdmin').firestore()
    const snap = await assertSucceeds(
      getDocs(query(collectionGroup(db, 'affiliations'), where('org_id', '==', ORG)))
    )
    if (snap.size !== 1) throw new Error(`expected 1 org-issued row, got ${snap.size}`)
  })

  // ── and its narrowness ─────────────────────────────────────────────────────

  it('it does NOT reach the studio’s own club membership', async () => {
    const db = testEnv.authenticatedContext('fedAdmin').firestore()
    await assertFails(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'clubMembership')))
  })

  it('it does NOT reach a governing body the studio merely tracks', async () => {
    const db = testEnv.authenticatedContext('fedAdmin').firestore()
    await assertFails(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'externalGrading')))
  })

  it('a DIFFERENT organisation’s admin cannot read this org’s licence', async () => {
    const db = testEnv.authenticatedContext('rivalAdmin').firestore()
    await assertFails(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'orgLicence')))
  })

  it('an org_viewer cannot read it — the arm is org_admin, like contacts', async () => {
    // `contacts` itself admits only `isOrgAdminOfTeam`, so a viewer who could
    // read the affiliation could not read the person it belongs to. Failing
    // closed keeps the two consistent.
    const db = testEnv.authenticatedContext('fedViewer').firestore()
    await assertFails(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'orgLicence')))
  })

  it('a stranger with no org row at all is denied, and does not error the rule', async () => {
    // `hasOrgRole` reads `get(...).data` unguarded, which is an evaluation ERROR
    // rather than a false when the row is missing — this is the case
    // `isOrgAdminOfOrg` adds the existence check for.
    const db = testEnv.authenticatedContext('nobody').firestore()
    await assertFails(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'orgLicence')))
  })

  it('the arm is READ ONLY — the issuer cannot write the affiliation', async () => {
    // Writes go through the upsertAffiliation callable (Admin SDK), which is
    // where the org's affiliation lock is applied.
    const db = testEnv.authenticatedContext('fedAdmin').firestore()
    await assertFails(
      setDoc(doc(db, 'contacts', 'c1', 'affiliations', 'orgLicence'), {
        teamId: STUDIO,
        issuer: 'org',
        org_id: ORG,
        affiliation_type_id: 'licence',
        status_id: 'expired',
        active: false,
      })
    )
  })

  it('the studio’s own staff still read all three, unchanged', async () => {
    // The added match is ADDITIVE: nothing the catch-all granted was withdrawn.
    const db = testEnv.authenticatedContext('studioOwner').firestore()
    await assertSucceeds(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'orgLicence')))
    await assertSucceeds(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'clubMembership')))
    await assertSucceeds(getDoc(doc(db, 'contacts', 'c1', 'affiliations', 'externalGrading')))
  })

  // ── the studio's OWN page, broken the same way and by the same cause ───────

  it('a studio can run its own Affiliations page query, scoped to its team', async () => {
    // `collectionGroup('affiliations').where('teamId','==',currentTeam)` — the
    // query `(auth)/affiliations/page.tsx` issues. It returns all three issuers,
    // which is right: this is the studio's own roster of what its people hold.
    const db = testEnv.authenticatedContext('studioOwner').firestore()
    const snap = await assertSucceeds(
      getDocs(query(collectionGroup(db, 'affiliations'), where('teamId', '==', STUDIO)))
    )
    if (snap.size !== 3) throw new Error(`expected all 3 rows, got ${snap.size}`)
  })

  it('a studio CANNOT list another studio’s affiliations', async () => {
    const db = testEnv.authenticatedContext('studioOwner').firestore()
    await assertFails(
      getDocs(query(collectionGroup(db, 'affiliations'), where('teamId', '==', 'someoneElse')))
    )
  })

  it('an UNSCOPED collection-group list is refused — no cross-tenant harvest', async () => {
    // Neither arm can be proven from a query with no constraints, so Firestore
    // refuses the whole thing rather than filtering it.
    const db = testEnv.authenticatedContext('studioOwner').firestore()
    await assertFails(getDocs(query(collectionGroup(db, 'affiliations'))))
  })

  it('an OWN-SCOPED coach cannot list the whole team’s affiliations', async () => {
    // The own-scope branch of `canAccessContact` reads `assigned_coach_ids` off
    // the CONTACT, and a `{path=**}` match binds no contact id to get() with —
    // so the list arm excludes a coach rather than handing them contacts outside
    // their book. Their per-document access through the nested rule is intact.
    const db = testEnv.authenticatedContext('ownCoach').firestore()
    await assertFails(
      getDocs(query(collectionGroup(db, 'affiliations'), where('teamId', '==', STUDIO)))
    )
  })
})
