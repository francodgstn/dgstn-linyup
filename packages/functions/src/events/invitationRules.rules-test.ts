import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { collection, doc, getDocs, query, setDoc, where } from 'firebase/firestore'

// Security rules for events/{id}/invitations. Staff read them for the
// Invitations tab (the rule used to be `if false`, so the tab never loaded).
// A row carries its invitee's RSVP token and contact details, so read is held
// to `events.manage`, and on an ORG event — where every member studio invites
// into the same subcollection — a studio sees only the rows stamped with its
// own teamId. Writes stay function-only.
//
// Needs the Firestore emulator:  pnpm --filter @linyup/functions test:rules

const PROJECT_ID = 'demo-linyup-invitation-rules'

function findRules(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'firestore.rules')
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    dir = path.dirname(dir)
  }
  throw new Error('firestore.rules not found above ' + process.cwd())
}

const TEAM_A = 'teamA'
const TEAM_B = 'teamB'
const ORG = 'org1'
const EVENT_TEAM = 'eventTeam'
const EVENT_ORG = 'eventOrg'

let testEnv: RulesTestEnvironment

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'teams', TEAM_A), { name: 'Team A', org_id: ORG })
    await setDoc(doc(db, 'teams', TEAM_B), { name: 'Team B', org_id: ORG })
    await setDoc(doc(db, 'teams', TEAM_A, 'team_members', 'managerA'), {
      role: 'manager', capabilities: ['events.manage'],
    })
    await setDoc(doc(db, 'teams', TEAM_A, 'team_members', 'viewerA'), {
      role: 'viewer', capabilities: [],
    })
    await setDoc(doc(db, 'teams', TEAM_B, 'team_members', 'managerB'), {
      role: 'manager', capabilities: ['events.manage'],
    })
    await setDoc(doc(db, 'users', 'managerA'), { currentTeam: TEAM_A })
    await setDoc(doc(db, 'users', 'viewerA'), { currentTeam: TEAM_A })
    await setDoc(doc(db, 'users', 'managerB'), { currentTeam: TEAM_B })
    await setDoc(doc(db, 'users', 'orgAdmin'), { currentTeam: null })

    await setDoc(doc(db, 'organizations', ORG), { name: 'Federation' })
    await setDoc(doc(db, 'organizations', ORG, 'org_members', 'orgAdmin'), { role: 'org_admin' })

    await setDoc(doc(db, 'events', EVENT_TEAM), {
      teamId: TEAM_A, scope: 'team', title: 'Team camp', deleted_at: null,
    })
    await setDoc(doc(db, 'events', EVENT_ORG), {
      teamId: null, orgId: ORG, scope: 'org', title: 'Federation cup', deleted_at: null,
    })

    // A team event's rows: one written before the stamp existed, one after.
    await setDoc(doc(db, 'events', EVENT_TEAM, 'invitations', 'legacy'), {
      contactId: 'legacy', token: 't1', eventId: EVENT_TEAM,
    })
    await setDoc(doc(db, 'events', EVENT_TEAM, 'invitations', 'c1'), {
      contactId: 'c1', token: 't2', eventId: EVENT_TEAM, teamId: TEAM_A,
    })
    // An org event: two member studios each invited their own people.
    await setDoc(doc(db, 'events', EVENT_ORG, 'invitations', 'a1'), {
      contactId: 'a1', token: 't3', eventId: EVENT_ORG, teamId: TEAM_A,
    })
    await setDoc(doc(db, 'events', EVENT_ORG, 'invitations', 'b1'), {
      contactId: 'b1', token: 't4', eventId: EVENT_ORG, teamId: TEAM_B,
    })
  })
}

const as = (uid: string) => testEnv.authenticatedContext(uid).firestore()
const invitations = (db: ReturnType<typeof as>, eventId: string) =>
  collection(db, 'events', eventId, 'invitations')

describe('events/{id}/invitations rules', function () {
  this.timeout(20000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { rules: findRules() },
    })
  })
  after(async () => {
    await testEnv?.cleanup()
  })
  beforeEach(async () => {
    await testEnv.clearFirestore()
    await seed()
  })

  describe('team event', () => {
    it('its studio’s manager reads every row, stamped or not', async () => {
      await assertSucceeds(getDocs(invitations(as('managerA'), EVENT_TEAM)))
    })
    it('a member without events.manage cannot — the rows carry RSVP tokens', async () => {
      await assertFails(getDocs(invitations(as('viewerA'), EVENT_TEAM)))
    })
    it('another studio’s manager cannot', async () => {
      await assertFails(getDocs(invitations(as('managerB'), EVENT_TEAM)))
    })
    it('nobody signed out can', async () => {
      await assertFails(getDocs(invitations(testEnv.unauthenticatedContext().firestore(), EVENT_TEAM)))
    })
  })

  describe('org event', () => {
    it('a member studio reads its OWN rows, filtered by its teamId', async () => {
      await assertSucceeds(
        getDocs(query(invitations(as('managerA'), EVENT_ORG), where('teamId', '==', TEAM_A))),
      )
    })
    it('an unfiltered query is refused — it would include other studios’ members', async () => {
      await assertFails(getDocs(invitations(as('managerA'), EVENT_ORG)))
    })
    it('a studio cannot read another studio’s rows', async () => {
      await assertFails(
        getDocs(query(invitations(as('managerA'), EVENT_ORG), where('teamId', '==', TEAM_B))),
      )
    })
    it('the organisation’s admin reads every studio’s rows', async () => {
      await assertSucceeds(getDocs(invitations(as('orgAdmin'), EVENT_ORG)))
    })
  })

  it('no client writes an invitation, whoever it is', async () => {
    for (const uid of ['managerA', 'orgAdmin']) {
      await assertFails(
        setDoc(doc(as(uid), 'events', EVENT_TEAM, 'invitations', 'x'), { teamId: TEAM_A }),
      )
      await assertFails(
        setDoc(doc(as(uid), 'events', EVENT_ORG, 'invitations', 'x'), { teamId: TEAM_A }),
      )
    }
  })
})
