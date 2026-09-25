import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { collection, doc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore'

// Security-rules tests for ORGANIZATION access — the two org-scoped holes the
// 2026-08-26 rules review closed:
//
//   1) org_members SELF-PROVISION (the org twin of the #106 team takeover): the
//      write rule had a disjunct that required nothing about WHICH org it was, so
//      any authenticated principal could write itself an `org_admin` row into any
//      org and — because hasOrgRole reads the role off that very doc — become its
//      admin, reaching every member studio's contact PII via isOrgAdminOfTeam.
//      The disjunct was removed; org_members is org_admin-write only (creation +
//      member management run on the Admin SDK, which bypasses rules).
//
//   2) org-shared READ via a forged team.org_id: the org-shared collections
//      (org_places, org_program_templates, affiliation_types, org
//      installed_plugins, org events + program_items) gated reads on
//      `get(teams/$(currentTeam)).org_id == orgId`. Both operands are
//      client-controlled — currentTeam is a self-written user field and team
//      create puts no constraint on org_id — so anyone could forge a team
//      carrying a target org's id and read its shared data. The rules now gate on
//      the server-written organizations/{orgId}/org_teams/{teamId} membership doc
//      (currentTeamInOrg), which a client cannot forge.
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
const ORG = 'victimOrg'

let testEnv: RulesTestEnvironment

describe('firestore.rules — organization access', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-org-access',
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
      // The victim organization and its real admin.
      await setDoc(doc(db, 'organizations', ORG), {
        name: 'Victim Federation',
        slug: 'victim-fed',
        plan: 'organization',
        createdBy: 'realOrgAdmin',
      })
      await setDoc(doc(db, 'organizations', ORG, 'org_members', 'realOrgAdmin'), {
        role: 'org_admin',
        userId: 'realOrgAdmin',
      })
      // A legitimate org_viewer, for the self-escalation guard.
      await setDoc(doc(db, 'organizations', ORG, 'org_members', 'viewerV'), {
        role: 'org_viewer',
        userId: 'viewerV',
      })

      // A studio that GENUINELY belongs to the org: the server-written org_teams
      // membership proof + the team carrying org_id + a member of that team.
      await setDoc(doc(db, 'organizations', ORG, 'org_teams', 'legitTeam'), {
        teamId: 'legitTeam',
        orgId: ORG,
        status: 'active',
      })
      await setDoc(doc(db, 'teams', 'legitTeam'), {
        name: 'Member Studio',
        slug: 'member-studio',
        org_id: ORG,
        createdBy: 'legitOwner',
      })
      await setDoc(doc(db, 'teams', 'legitTeam', 'team_members', 'legitUser'), {
        role: 'viewer',
        userId: 'legitUser',
      })
      await setDoc(doc(db, 'users', 'legitUser'), { currentTeam: 'legitTeam' })

      // An UNLINKED studio: on org lapse/removal its team.org_id is deleted but
      // the org_teams row is kept as status:'inactive' (orgs/lifecycle.ts). It
      // must NOT retain org-shared read access.
      await setDoc(doc(db, 'organizations', ORG, 'org_teams', 'exTeam'), {
        teamId: 'exTeam',
        orgId: ORG,
        status: 'inactive',
      })
      await setDoc(doc(db, 'teams', 'exTeam', 'team_members', 'exUser'), {
        role: 'owner',
        userId: 'exUser',
      })
      await setDoc(doc(db, 'users', 'exUser'), { currentTeam: 'exTeam' })

      // A shared org collection the sub-studio is meant to read.
      await setDoc(doc(db, 'organizations', ORG, 'org_places', 'place1'), {
        name: 'Main Dojo',
        orgId: ORG,
      })

      // A place belonging to the MEMBER STUDIO — what Org > Places lists beside
      // the organization's own.
      await setDoc(doc(db, 'teams', 'legitTeam', 'team_places', 'tp1'), {
        name: 'Studio Hall',
        teamId: 'legitTeam',
        scope: 'team',
      })
    })
  })

  // ── 1) org_members self-provision (the takeover) ───────────────────────────

  it('a stranger CANNOT self-provision org_admin on an org they do not run', async () => {
    // THE takeover write — the one that used to succeed. Shaped like a passwordless
    // contact session uid, the cheapest identity that reached the hole.
    const db = testEnv.authenticatedContext('contact:attacker').firestore()
    await assertFails(
      setDoc(doc(db, 'organizations', ORG, 'org_members', 'contact:attacker'), {
        role: 'org_admin',
        userId: 'contact:attacker',
      })
    )
  })

  it('a stranger CANNOT self-provision a non-admin org role either', async () => {
    const db = testEnv.authenticatedContext('contact:attacker').firestore()
    await assertFails(
      setDoc(doc(db, 'organizations', ORG, 'org_members', 'contact:attacker'), {
        role: 'org_viewer',
        userId: 'contact:attacker',
      })
    )
  })

  it('an existing org_viewer CANNOT rewrite their own row to org_admin', async () => {
    const db = testEnv.authenticatedContext('viewerV').firestore()
    await assertFails(
      updateDoc(doc(db, 'organizations', ORG, 'org_members', 'viewerV'), { role: 'org_admin' })
    )
  })

  it('a real org_admin can still manage members (the legitimate path)', async () => {
    // org_members is now org_admin-write only; this proves the removal did not
    // touch the admin's own ability to add someone.
    const db = testEnv.authenticatedContext('realOrgAdmin').firestore()
    await assertSucceeds(
      setDoc(doc(db, 'organizations', ORG, 'org_members', 'invited'), {
        role: 'org_viewer',
        userId: 'invited',
      })
    )
  })

  // ── 2) org-shared read via a forged team.org_id ────────────────────────────

  it('a forged team.org_id does NOT unlock the org’s shared collections', async () => {
    const attacker = testEnv.authenticatedContext('attackerU').firestore()

    // The forge writes the rules still permit: a team you created (org_id is
    // UNCONSTRAINED on create — the whole point of the attack) and pointing your
    // own currentTeam at it.
    await assertSucceeds(
      setDoc(doc(attacker, 'teams', 'fakeTeam'), {
        name: 'Forged',
        slug: 'forged',
        org_id: ORG,
        createdBy: 'attackerU',
      })
    )
    await assertSucceeds(setDoc(doc(attacker, 'users', 'attackerU'), { currentTeam: 'fakeTeam' }))

    // A membership in their OWN forged team, seeded directly — the client
    // self-provision path is gone (a real creator gets this via createStudioTeam),
    // but granting it here makes isTeamMember(fakeTeam) hold so the ONLY thing
    // still missing is the server-written org_teams row.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'teams', 'fakeTeam', 'team_members', 'attackerU'), {
        role: 'owner',
        userId: 'attackerU',
      })
    })

    // …the read is gated on org_teams membership, which the attacker cannot forge
    // (allow write: if false), so the shared collection stays shut.
    await assertFails(getDocs(query(collection(attacker, 'organizations', ORG, 'org_places'))))
  })

  // ── Org > Places lists the member studios' own locations ──────────────────
  //
  // An org admin is NOT a member of the studios it federates, so without an
  // explicit disjunct `teams/{id}/team_places` is closed to them and the page
  // renders as an organization whose studios have no locations at all — a denied
  // list and an empty one are the same thing on screen, which is how this class
  // of defect ships twice.
  describe('a member studio’s places, from the organization', () => {
    it('the org admin CAN read them', async () => {
      const orgAdmin = testEnv.authenticatedContext('realOrgAdmin').firestore()
      await assertSucceeds(getDocs(collection(orgAdmin, 'teams', 'legitTeam', 'team_places')))
    })

    it('…but CANNOT write them — a studio’s locations stay the studio’s', async () => {
      const orgAdmin = testEnv.authenticatedContext('realOrgAdmin').firestore()
      await assertFails(
        setDoc(doc(orgAdmin, 'teams', 'legitTeam', 'team_places', 'tp1'), { name: 'Renamed' }),
      )
    })

    it('an org_VIEWER cannot read them', async () => {
      // `isOrgAdminOfTeam` is deliberately admin-only: this is a studio's own
      // operational data, not the federation's shared standards.
      const viewer = testEnv.authenticatedContext('viewerV').firestore()
      await assertFails(getDocs(collection(viewer, 'teams', 'legitTeam', 'team_places')))
    })

    it('an unrelated signed-in user still cannot read them', async () => {
      const outsider = testEnv.authenticatedContext('nobody').firestore()
      await assertFails(getDocs(collection(outsider, 'teams', 'legitTeam', 'team_places')))
    })
  })

  it('a genuine sub-studio member CAN still read the org’s shared collections', async () => {
    // legitUser belongs to legitTeam, which has an org_teams row in the org — the
    // fix must not cost real sub-studio access.
    const db = testEnv.authenticatedContext('legitUser').firestore()
    await assertSucceeds(getDocs(query(collection(db, 'organizations', ORG, 'org_places'))))
  })

  it('an UNLINKED studio (inactive org_teams row) is refused', async () => {
    // exUser's team was removed from the org; its membership row lingers as
    // status:'inactive', which currentTeamInOrg must reject.
    const db = testEnv.authenticatedContext('exUser').firestore()
    await assertFails(getDocs(query(collection(db, 'organizations', ORG, 'org_places'))))
  })
})
