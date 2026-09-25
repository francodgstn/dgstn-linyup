import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, addDoc, collection, setDoc, updateDoc } from 'firebase/firestore'

// Security-rules test for a contact SESSION's own self-writes — the arm that
// lets the mobile app (and the web Space) update `weight` / `last_seen_at` /
// `mobile_app` on its OWN contact document, and the sibling arms that let a
// contact create its own `performance_checkins` row.
//
// `mobile_app` (Contact.mobile_app / MobileAppTelemetry,
// packages/shared/src/types/contact.ts) is the foreground telemetry write the
// Expo app makes; before this the contacts self-update `hasOnly([...])` list
// did not carry it, so the write was refused whole (a partial Firestore update
// is one write, one allow/deny decision — there is no "the fields it does
// recognize land, the rest are dropped").
//
// A ready exploratory probe of these cases (plus the goals/evaluations arms,
// covered by their own rules-tests) lives at
// /tmp/claude-0/-home-user-dgstn-linyup/71fa28db-3099-59c2-bb52-9cc93a24d53a/scratchpad/probe.cjs.
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
const TEAM = 'teamSW'
const CONTACT = 'contactSW'

let testEnv: RulesTestEnvironment

const contactSession = () =>
  testEnv
    .authenticatedContext('contact:' + CONTACT, {
      contactId: CONTACT,
      teamId: TEAM,
      sessionExpires: Date.now() + 3_600_000,
    })
    .firestore()

describe('firestore.rules — a contact session writing its OWN contact document', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-contact-self-writes',
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
      await setDoc(doc(db, 'contacts', CONTACT), {
        teamId: TEAM,
        firstname: 'Sam',
        weight: 70,
        coaching_open_count: 2,
      })
    })
  })

  it('{last_seen_at, mobile_app: {...}} is ALLOWED', async () => {
    await assertSucceeds(
      updateDoc(doc(contactSession(), 'contacts', CONTACT), {
        last_seen_at: new Date(),
        mobile_app: {
          version: '1.2.3',
          ota_runtime_version: '1.2.3',
          ota_channel: 'production',
          ota_is_embedded: true,
          ota_update_id: null,
        },
      })
    )
  })

  it('weight ALONE is ALLOWED', async () => {
    await assertSucceeds(updateDoc(doc(contactSession(), 'contacts', CONTACT), { weight: 71 }))
  })

  it('firstname is DENIED — not on the self-write allow-list', async () => {
    await assertFails(updateDoc(doc(contactSession(), 'contacts', CONTACT), { firstname: 'Forged' }))
  })

  it('a forged coaching_open_count is DENIED, even alongside an allowed field', async () => {
    await assertFails(
      updateDoc(doc(contactSession(), 'contacts', CONTACT), { weight: 72, coaching_open_count: 99 })
    )
  })

  describe('performance_checkins', () => {
    it("create with filled_by: 'student' is ALLOWED", async () => {
      await assertSucceeds(
        addDoc(collection(contactSession(), 'contacts', CONTACT, 'performance_checkins'), {
          filled_by: 'student',
          taken_at: new Date(),
          scores: {},
        })
      )
    })

    it("create with filled_by: 'coach' is DENIED — a contact cannot forge a coach check-in", async () => {
      await assertFails(
        addDoc(collection(contactSession(), 'contacts', CONTACT, 'performance_checkins'), {
          filled_by: 'coach',
          taken_at: new Date(),
          scores: {},
        })
      )
    })
  })
})
