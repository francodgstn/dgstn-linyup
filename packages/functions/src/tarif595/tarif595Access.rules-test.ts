import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'

// Security-rules test for the Tarif 595 plugin's three collections and its
// counter (teams/{id}/tarif595_settings, tarif595_contacts, tarif595_receipts,
// counters/tarif595_receipts).
//
// The matrix: settings and per-contact insurer data are MANAGER+ on both axes
// (the person mapping offerings is the manager; AHV numbers are not coach
// data); receipts are manager+ READ and nobody's write (Cloud Functions only —
// a receipt is voided through a callable, never edited); the counter is member
// read, nobody's write. Everyone outside the team is refused everywhere.
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
const TEAM = 'team595'
const OTHER_TEAM = 'team595b'
const CONTACT = 'contact595'
const RECEIPT = 'receipt595'

let testEnv: RulesTestEnvironment

const asUser = (uid: string) => testEnv.authenticatedContext(uid).firestore()
type Db = ReturnType<typeof asUser>

const settingsDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'tarif595_settings', 'config')
const contactDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'tarif595_contacts', CONTACT)
const receiptDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'tarif595_receipts', RECEIPT)
const counterDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'counters', 'tarif595_receipts')

describe('firestore.rules — tarif595 access', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-tarif595',
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
      await setDoc(settingsDoc(db), { language: 'de', numbering: { prefix: '595' }, offerings: {} })
      await setDoc(contactDoc(db), { ahv_number: '7569217076985' })
      await setDoc(receiptDoc(db), { number: '595-2027-00001', status: 'issued', contact_id: CONTACT })
      await setDoc(counterDoc(db), { last: 1, year: '2027' })
      for (const [uid, role] of [
        ['owner595', 'owner'],
        ['manager595', 'manager'],
        ['coach595', 'coach'],
      ] as const) {
        await setDoc(doc(db, 'teams', TEAM, 'team_members', uid), { role })
        await setDoc(doc(db, 'users', uid), { currentTeam: TEAM })
      }
      await setDoc(doc(db, 'teams', OTHER_TEAM, 'team_members', 'outsider595'), { role: 'owner' })
      await setDoc(doc(db, 'users', 'outsider595'), { currentTeam: OTHER_TEAM })
    })
  })

  for (const uid of ['owner595', 'manager595']) {
    it(`${uid} reads and writes settings and contact data, reads receipts, never writes a receipt or the counter`, async () => {
      const db = asUser(uid)
      await assertSucceeds(getDoc(settingsDoc(db)))
      await assertSucceeds(setDoc(settingsDoc(db), { numbering: { prefix: 'FIT' } }, { merge: true }))
      await assertSucceeds(getDoc(contactDoc(db)))
      await assertSucceeds(setDoc(contactDoc(db), { insured_number: '123' }, { merge: true }))
      await assertSucceeds(getDoc(receiptDoc(db)))
      await assertFails(setDoc(receiptDoc(db), { status: 'voided' }, { merge: true }))
      await assertSucceeds(getDoc(counterDoc(db)))
      await assertFails(setDoc(counterDoc(db), { last: 99 }, { merge: true }))
    })
  }

  it('a coach sees none of it (the counter aside — a plain member read) and writes nothing', async () => {
    const db = asUser('coach595')
    await assertFails(getDoc(settingsDoc(db)))
    await assertFails(setDoc(settingsDoc(db), { numbering: { prefix: 'X' } }, { merge: true }))
    await assertFails(getDoc(contactDoc(db)))
    await assertFails(setDoc(contactDoc(db), { ahv_number: '1' }, { merge: true }))
    await assertFails(getDoc(receiptDoc(db)))
    await assertSucceeds(getDoc(counterDoc(db)))
    await assertFails(setDoc(counterDoc(db), { last: 99 }, { merge: true }))
  })

  it('an owner of another team is refused on every path', async () => {
    const db = asUser('outsider595')
    await assertFails(getDoc(settingsDoc(db)))
    await assertFails(getDoc(contactDoc(db)))
    await assertFails(getDoc(receiptDoc(db)))
    await assertFails(getDoc(counterDoc(db)))
    await assertFails(setDoc(settingsDoc(db), { numbering: { prefix: 'X' } }, { merge: true }))
  })

  it('an unauthenticated client is refused', async () => {
    const db = testEnv.unauthenticatedContext().firestore() as unknown as Db
    await assertFails(getDoc(settingsDoc(db)))
    await assertFails(getDoc(receiptDoc(db)))
  })
})
