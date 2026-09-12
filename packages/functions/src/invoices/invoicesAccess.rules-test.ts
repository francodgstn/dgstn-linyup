import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'

// Security-rules test for the QR-invoices plugin: invoice_settings manager+ on
// both axes; invoices manager+ read, nobody's write (Cloud Functions only — an
// invoice is voided or marked paid through a callable); counters/invoices
// member read, write false. Outsiders refused everywhere.
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
const TEAM = 'teamInv'
const OTHER_TEAM = 'teamInv2'
const INVOICE = 'invoiceInv'

let testEnv: RulesTestEnvironment
const asUser = (uid: string) => testEnv.authenticatedContext(uid).firestore()
type Db = ReturnType<typeof asUser>

const settingsDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'invoice_settings', 'config')
const invoiceDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'invoices', INVOICE)
const counterDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'counters', 'invoices')

describe('firestore.rules — invoices access', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-invoices',
      firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
    })
  })
  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Db
      await setDoc(settingsDoc(db), { prefix: 'INV', due_days: 30 })
      await setDoc(invoiceDoc(db), { number: 'INV-2026-00001', status: 'open', contact_id: 'c1' })
      await setDoc(counterDoc(db), { last: 1, year: '2026' })
      for (const [uid, role] of [
        ['ownerInv', 'owner'],
        ['managerInv', 'manager'],
        ['coachInv', 'coach'],
      ] as const) {
        await setDoc(doc(db, 'teams', TEAM, 'team_members', uid), { role })
        await setDoc(doc(db, 'users', uid), { currentTeam: TEAM })
      }
      await setDoc(doc(db, 'teams', OTHER_TEAM, 'team_members', 'outsiderInv'), { role: 'owner' })
      await setDoc(doc(db, 'users', 'outsiderInv'), { currentTeam: OTHER_TEAM })
    })
  })

  for (const uid of ['ownerInv', 'managerInv']) {
    it(`${uid} reads and writes settings, reads invoices, never writes an invoice or the counter`, async () => {
      const db = asUser(uid)
      await assertSucceeds(getDoc(settingsDoc(db)))
      await assertSucceeds(setDoc(settingsDoc(db), { due_days: 14 }, { merge: true }))
      await assertSucceeds(getDoc(invoiceDoc(db)))
      await assertFails(setDoc(invoiceDoc(db), { status: 'paid' }, { merge: true }))
      await assertSucceeds(getDoc(counterDoc(db)))
      await assertFails(setDoc(counterDoc(db), { last: 99 }, { merge: true }))
    })
  }

  it('a coach sees no settings or invoices and writes nothing', async () => {
    const db = asUser('coachInv')
    await assertFails(getDoc(settingsDoc(db)))
    await assertFails(setDoc(settingsDoc(db), { due_days: 1 }, { merge: true }))
    await assertFails(getDoc(invoiceDoc(db)))
    await assertFails(setDoc(invoiceDoc(db), { status: 'void' }, { merge: true }))
  })

  it('an owner of another team is refused on every path', async () => {
    const db = asUser('outsiderInv')
    await assertFails(getDoc(settingsDoc(db)))
    await assertFails(getDoc(invoiceDoc(db)))
    await assertFails(getDoc(counterDoc(db)))
  })

  it('an unauthenticated client is refused', async () => {
    const db = testEnv.unauthenticatedContext().firestore() as unknown as Db
    await assertFails(getDoc(invoiceDoc(db)))
  })
})
