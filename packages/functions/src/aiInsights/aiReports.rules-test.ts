import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

// Security-rules coverage for `teams/{teamId}/ai_reports/{reportId}` — the team
// sentiment reading and its daily run count (`ai-team-sentiment`,
// docs/ai-insights.md).
//
// Two things must hold. NOBODY writes it from a client — the run count lives on
// this document, so a write would let a studio reset its own daily cap. And only
// ALL-SCOPED members read it — a coach scoped to their own book cannot read the
// other contacts, so they do not read a reading of them either.
//
//   pnpm --filter @linyup/functions test:rules
//
// The emulator address comes from FIRESTORE_EMULATOR_HOST when set (which
// `firebase emulators:exec` sets), so the file also runs against a worktree's
// own port slot; it falls back to the default 127.0.0.1:8080.

function findRules(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'firestore.rules')
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    dir = path.dirname(dir)
  }
  throw new Error('firestore.rules not found above ' + process.cwd())
}

function emulatorAddress(): { host: string; port: number } {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':')
  return { host: host || '127.0.0.1', port: Number(port) || 8080 }
}

const RULES = findRules()
const TEAM = 'teamAi'
const OWNER = 'ownerAi'
const MANAGER = 'managerAi'
const COACH = 'coachAi'
const OUTSIDER = 'outsiderAi'
const REPORT = ['teams', TEAM, 'ai_reports', 'team_sentiment'] as const

let testEnv: RulesTestEnvironment

describe('firestore.rules — ai_reports (team sentiment)', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-ai-reports',
      firestore: { rules: RULES, ...emulatorAddress() },
    })
  })
  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'teams', TEAM), { name: 'AI Team', plan: 'studio' })
      await setDoc(doc(db, 'teams', TEAM, 'team_members', OWNER), { role: 'owner' })
      await setDoc(doc(db, 'teams', TEAM, 'team_members', MANAGER), { role: 'manager' })
      await setDoc(doc(db, 'teams', TEAM, 'team_members', COACH), { role: 'coach', scope: 'own' })
      await setDoc(doc(db, ...REPORT), {
        report: { mood: 'steady', sections: { overview: 'Steady.' } },
        usage: { day: '2026-09-16', count: 5 },
      })
    })
  })

  const as = (uid: string) => testEnv.authenticatedContext(uid).firestore()

  it('an owner and a manager read it', async () => {
    await assertSucceeds(getDoc(doc(as(OWNER), ...REPORT)))
    await assertSucceeds(getDoc(doc(as(MANAGER), ...REPORT)))
  })

  it('an own-scoped coach does not — it is a reading of contacts they cannot see', async () => {
    await assertFails(getDoc(doc(as(COACH), ...REPORT)))
  })

  it('a non-member does not', async () => {
    await assertFails(getDoc(doc(as(OUTSIDER), ...REPORT)))
  })

  it('not even the owner can reset the daily count or forge a reading', async () => {
    await assertFails(updateDoc(doc(as(OWNER), ...REPORT), { usage: { day: '2026-09-16', count: 0 } }))
    await assertFails(setDoc(doc(as(OWNER), 'teams', TEAM, 'ai_reports', 'other'), { report: {} }))
  })
})
