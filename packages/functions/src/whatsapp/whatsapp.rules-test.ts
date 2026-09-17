import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

// Security-rules coverage for WhatsApp (docs/whatsapp-outbound.md).
//
// Everything WhatsApp stores is written by functions only: the sealed token, the
// number claim, the suppressions, the integration display doc, and the member's
// consent on the contact. An owner can READ the integration doc (it drives the
// settings card) and nothing else.
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
const TEAM = 'teamW'
const CONTACT = 'contactW'
const OWNER = 'ownerW'

let testEnv: RulesTestEnvironment

const ownerSession = () => testEnv.authenticatedContext(OWNER).firestore()
const contactSession = () =>
  testEnv
    .authenticatedContext('contact:' + CONTACT, {
      contactId: CONTACT,
      teamId: TEAM,
      sessionExpires: Date.now() + 3_600_000,
    })
    .firestore()

describe('firestore.rules — WhatsApp', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-whatsapp',
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
      await setDoc(doc(db, 'contacts', CONTACT), { teamId: TEAM, firstname: 'Nadia', archived_at: null, deleted_at: null })
      await setDoc(doc(db, 'teams', TEAM, 'team_members', OWNER), { role: 'owner' })
      await setDoc(doc(db, 'users', OWNER), { currentTeam: TEAM })
      await setDoc(doc(db, 'teams', TEAM, 'integrations', 'whatsapp'), { status: 'connected' })
      await setDoc(doc(db, 'whatsapp_connections', TEAM), { sealed_token: 'v1.x.y.z' })
    })
  })

  it('an owner reads the integration doc but cannot write it', async () => {
    const db = ownerSession()
    await assertSucceeds(getDoc(doc(db, 'teams', TEAM, 'integrations', 'whatsapp')))
    await assertFails(setDoc(doc(db, 'teams', TEAM, 'integrations', 'whatsapp'), { status: 'connected', templates: {} }))
  })

  it('an owner can still write an ordinary integration doc', async () => {
    const db = ownerSession()
    await assertSucceeds(setDoc(doc(db, 'teams', TEAM, 'integrations', 'sms_sender'), { senderName: 'Studio' }))
  })

  it('no client reads or writes the token, the number claims or the suppressions', async () => {
    const db = ownerSession()
    await assertFails(getDoc(doc(db, 'whatsapp_connections', TEAM)))
    await assertFails(setDoc(doc(db, 'whatsapp_numbers', 'PN1'), { teamId: TEAM }))
    await assertFails(getDoc(doc(db, 'whatsapp_suppressions', `${TEAM}_hash`)))
  })

  it('an owner cannot record a member’s consent directly', async () => {
    const db = ownerSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT), { whatsapp_consent: { status: 'opted_in', source: 'staff' } }),
    )
    await assertSucceeds(updateDoc(doc(db, 'contacts', CONTACT), { firstname: 'Nadège' }))
  })

  it('an owner cannot create a contact that already carries consent', async () => {
    const db = ownerSession()
    await assertFails(
      setDoc(doc(db, 'contacts', 'newW'), {
        teamId: TEAM,
        firstname: 'New',
        whatsapp_consent: { status: 'opted_in', source: 'staff' },
      }),
    )
    // The control: the same contact without it is fine.
    await assertSucceeds(setDoc(doc(db, 'contacts', 'newW'), { teamId: TEAM, firstname: 'New' }))
  })

  it('a member cannot set their own consent directly either — the callable does', async () => {
    const db = contactSession()
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { whatsapp_consent: { status: 'opted_in' } }))
  })
})
