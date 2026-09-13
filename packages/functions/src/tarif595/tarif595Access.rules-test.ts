import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

// Security-rules test for the Tarif 595 plugin's collections and its counter
// (teams/{id}/tarif595_settings, tarif595_contacts, tarif595_receipts,
// tarif595_jobs, counters/tarif595_receipts).
//
// The matrix: settings are MANAGER+ on both axes (the person mapping offerings
// is the manager); per-contact insurer data is manager+ AND the contact's own
// session on their own row, for the fields a member can know (AHV number,
// insurer name, insured number) and nothing else — never the insurer GLN, the
// sex override or the guardian, never another contact's row, never a delete;
// receipts and jobs are manager+ READ and nobody's write (Cloud Functions
// only); the counter is member read, nobody's write. Everyone outside the
// team is refused everywhere.
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
const OTHER_CONTACT = 'contact595b'
const RECEIPT = 'receipt595'
const JOB = 'job595'

let testEnv: RulesTestEnvironment

const asUser = (uid: string) => testEnv.authenticatedContext(uid).firestore()
type Db = ReturnType<typeof asUser>

/** The Space's custom-token session — the claims buildContactSession mints. */
const asContact = (contactId = CONTACT, teamId = TEAM, expiresIn = 3_600_000) =>
  testEnv.authenticatedContext('contact:' + contactId, { contactId, teamId, sessionExpires: Date.now() + expiresIn }).firestore()

const settingsDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'tarif595_settings', 'config')
const contactDoc = (db: Db, team = TEAM, contactId = CONTACT) => doc(db, 'teams', team, 'tarif595_contacts', contactId)
const receiptDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'tarif595_receipts', RECEIPT)
const jobDoc = (db: Db, team = TEAM) => doc(db, 'teams', team, 'tarif595_jobs', JOB)
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
      await setDoc(jobDoc(db), { status: 'running', total: 10, processed: 0 })
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
    await assertFails(getDoc(jobDoc(db)))
  })

  // ── Bulk jobs: manager+ read, nobody's write ─────────────────────────────
  it('jobs — a manager reads, nobody writes, a coach sees nothing', async () => {
    await assertSucceeds(getDoc(jobDoc(asUser('manager595'))))
    await assertFails(updateDoc(jobDoc(asUser('owner595')), { status: 'completed' }))
    await assertFails(getDoc(jobDoc(asUser('coach595'))))
    await assertFails(getDoc(jobDoc(asUser('outsider595'))))
    await assertFails(getDoc(jobDoc(asContact())))
  })

  // ── The contact's own insurer row, from the Space ────────────────────────
  it('a contact session reads its OWN row and writes the member-known fields', async () => {
    const db = asContact()
    await assertSucceeds(getDoc(contactDoc(db)))
    await assertSucceeds(updateDoc(contactDoc(db), { ahv_number: '7569217076985', insurer_name: 'Helsana', insured_number: '123', updated_at: new Date() }))
    await assertSucceeds(setDoc(contactDoc(db), { insured_number: '456' }, { merge: true }))
  })

  it('a contact session CREATES its own row with the member-known fields only', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(contactDoc(ctx.firestore() as unknown as Db))
    })
    const db = asContact()
    await assertFails(setDoc(contactDoc(db), { ahv_number: '7569217076985', insurer_gln: '7601003000012' }))
    await assertSucceeds(setDoc(contactDoc(db), { ahv_number: '7569217076985', insurer_name: 'CSS', updated_at: new Date() }))
  })

  it('a contact session never writes the manager-only fields — alone or beside an allowed one', async () => {
    const db = asContact()
    await assertFails(updateDoc(contactDoc(db), { insurer_gln: '7601003000012' }))
    await assertFails(updateDoc(contactDoc(db), { sex_override: 'male' }))
    await assertFails(updateDoc(contactDoc(db), { guardian: { familyname: 'X', givenname: 'Y' } }))
    await assertFails(updateDoc(contactDoc(db), { updated_by: 'manager595' }))
    // A partial update is ONE allow/deny decision: the allowed key does not
    // carry the forbidden one through.
    await assertFails(updateDoc(contactDoc(db), { ahv_number: '7569217076985', sex_override: 'male' }))
    // Rewriting the whole document is checked on the keys it touches, so a
    // full setDoc without merge that includes a forbidden key is refused too.
    await assertFails(setDoc(contactDoc(db), { ahv_number: '7569217076985', insurer_gln: '7601003000012' }))
  })

  it('a contact session never deletes its row, never touches another contact, another team, a receipt or the settings', async () => {
    const db = asContact()
    await assertFails(deleteDoc(contactDoc(db)))
    await assertFails(getDoc(contactDoc(db, TEAM, OTHER_CONTACT)))
    await assertFails(setDoc(contactDoc(db, TEAM, OTHER_CONTACT), { ahv_number: '7569217076985' }))
    await assertFails(getDoc(contactDoc(asContact(CONTACT, OTHER_TEAM), TEAM)))
    await assertFails(getDoc(receiptDoc(db)))
    await assertFails(getDoc(settingsDoc(db)))
  })

  it('an expired contact session is refused', async () => {
    const db = asContact(CONTACT, TEAM, -1_000)
    await assertFails(getDoc(contactDoc(db)))
    await assertFails(updateDoc(contactDoc(db), { insured_number: '9' }))
  })
})
