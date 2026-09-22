import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'

// Security-rules tests for `teams/{teamId}/queue_seen/{docId}` — what the
// dashboard's "Waiting on you" card has already shown the studio
// (packages/shared/src/types/dashboardQueue.ts).
//
// WHY THIS FILE EXISTS RATHER THAN A LIVE CLICK. The write was verified in the
// browser as an OWNER, which proves nothing about the other half of the rule:
// `hasTeamRole(teamId, 'manager') || hasTeamRole(teamId, 'owner')`. And a rules
// denial leaves NO Cloud Logging trail — if the manager arm were wrong, a
// manager's "Mark seen" would fail silently and the dot would simply never
// clear, which is the kind of defect nobody reports because nothing looks
// broken.
//
// THE COACH CASE IS THE POINT OF THE SPLIT. Read is `isTeamMember`, so a coach
// sees the same dots as their manager — a card that disagreed between two
// people looking at one studio would be worse than no dot at all. Write is
// manager/owner, so a coach cannot clear a nudge for everyone else. Both halves
// are asserted below; either one silently inverting is a real bug.
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
const TEAM = 'teamQueue'
const OTHER_TEAM = 'teamOther'

/** The real path the card writes — `QUEUE_SEEN_SUBCOLLECTION` / `QUEUE_SEEN_DOC_ID`. */
const SEEN = ['teams', TEAM, 'queue_seen', 'current'] as const

/** The shape `useQueueSeen` sends: one tab's keys, merged. */
const PAYLOAD = { bookings: ['booking:s1:c1'], updated_by: 'someone' }

let testEnv: RulesTestEnvironment

describe('firestore.rules — dashboard queue_seen', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-queue-seen',
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
      for (const [uid, role] of [
        ['ownerUid', 'owner'],
        ['managerUid', 'manager'],
        ['coachUid', 'coach'],
        ['viewerUid', 'viewer'],
      ] as const) {
        await setDoc(doc(db, 'teams', TEAM, 'team_members', uid), { role })
      }
      // A member of a DIFFERENT studio, to prove the tenant boundary holds on a
      // document whose path is the only thing naming its team.
      await setDoc(doc(db, 'teams', OTHER_TEAM, 'team_members', 'outsiderUid'), { role: 'owner' })
      // An existing record, so the read tests have something to read and the
      // write tests exercise the update arm as well as create.
      await setDoc(doc(db, ...SEEN), { bookings: [], contacts: [], other: [] })
    })
  })

  const as = (uid: string) => testEnv.authenticatedContext(uid).firestore()

  // ── write: manager and owner, and nobody else ────────────────────────────
  it('an OWNER can acknowledge', async () => {
    await assertSucceeds(setDoc(doc(as('ownerUid'), ...SEEN), PAYLOAD, { merge: true }))
  })

  it('a MANAGER can acknowledge — the arm the live check could not prove', async () => {
    await assertSucceeds(setDoc(doc(as('managerUid'), ...SEEN), PAYLOAD, { merge: true }))
  })

  it('a COACH cannot acknowledge, so one coach cannot clear the studio’s dot', async () => {
    await assertFails(setDoc(doc(as('coachUid'), ...SEEN), PAYLOAD, { merge: true }))
  })

  it('a VIEWER cannot acknowledge', async () => {
    await assertFails(setDoc(doc(as('viewerUid'), ...SEEN), PAYLOAD, { merge: true }))
  })

  it('another studio’s owner cannot acknowledge here', async () => {
    await assertFails(setDoc(doc(as('outsiderUid'), ...SEEN), PAYLOAD, { merge: true }))
  })

  it('a stranger who belongs to no team cannot acknowledge', async () => {
    await assertFails(setDoc(doc(as('strangerUid'), ...SEEN), PAYLOAD, { merge: true }))
  })

  // ── read: every member of the team, and nobody outside it ────────────────
  it('a COACH can read it, so their card shows the same dots as their manager’s', async () => {
    await assertSucceeds(getDoc(doc(as('coachUid'), ...SEEN)))
  })

  it('a MANAGER can read it', async () => {
    await assertSucceeds(getDoc(doc(as('managerUid'), ...SEEN)))
  })

  it('another studio’s owner cannot read it', async () => {
    await assertFails(getDoc(doc(as('outsiderUid'), ...SEEN)))
  })

  it('a stranger cannot read it', async () => {
    await assertFails(getDoc(doc(as('strangerUid'), ...SEEN)))
  })
})
