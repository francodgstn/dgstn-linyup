import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, setDoc } from 'firebase/firestore'
import { ref, uploadBytes, getBytes } from 'firebase/storage'

// Security-rules test for tier-aware course-media reads in storage.rules.
//
// The object store must enforce the SAME access tier as canReadPublishedCourse
// (firestore.rules): the old rule granted any contact of the team read of ANY
// tier's media, so a free-tier member could download paid subscription/purchase
// course content. These tests pin the fix. Needs BOTH emulators:
//   pnpm --filter @linyup/functions test:rules   (runs --only firestore,storage)

function readRules(name: string): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    dir = path.dirname(dir)
  }
  throw new Error(`${name} not found above ${process.cwd()}`)
}

const FIRESTORE_RULES = readRules('firestore.rules')
const STORAGE_RULES = readRules('storage.rules')

const TEAM = 'teamS'
const SUB_COURSE = 'subCourse'
const FREE_COURSE = 'freeCourse'
const SUB_MEDIA = `teams/${TEAM}/courses/${SUB_COURSE}/lessons/media/x.mp4`
const FREE_MEDIA = `teams/${TEAM}/courses/${FREE_COURSE}/lessons/media/y.mp4`

let testEnv: RulesTestEnvironment

const contactStorage = (contactId: string) =>
  testEnv
    .authenticatedContext('contact:' + contactId, {
      contactId,
      teamId: TEAM,
      sessionExpires: Date.now() + 3_600_000,
    })
    .storage()

describe('storage.rules — course media tier gating', function () {
  this.timeout(30_000)

  before(async () => {
    // projectId MUST be the emulator's own project (the `--project` of
    // emulators:exec): a Storage rule's cross-service `firestore.get` resolves the
    // firestore project from the Storage emulator's project, not the test's, so
    // the seeded course/contact docs have to live under the same id. Isolated from
    // the other rules-test files, which use distinct `demo-linyup-*` ids.
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup',
      firestore: { rules: FIRESTORE_RULES, host: '127.0.0.1', port: 8080 },
      storage: { rules: STORAGE_RULES, host: '127.0.0.1', port: 9199 },
    })
  })
  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await testEnv.clearStorage()
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'courses', SUB_COURSE), {
        status: 'published',
        teamId: TEAM,
        accessRule: { type: 'subscription', subscriptionTypeIds: ['pro'] },
      })
      await setDoc(doc(db, 'courses', FREE_COURSE), {
        status: 'published',
        teamId: TEAM,
        accessRule: { type: 'free' },
      })
      await setDoc(doc(db, 'contacts', 'free1'), { teamId: TEAM }) // no subscription
      await setDoc(doc(db, 'contacts', 'pro1'), { teamId: TEAM, subscription_type_id: 'pro' })
      await setDoc(doc(db, 'teams', TEAM, 'team_members', 'staffS'), { role: 'manager' })

      const s = ctx.storage()
      await uploadBytes(ref(s, SUB_MEDIA), new Uint8Array([1, 2, 3]))
      await uploadBytes(ref(s, FREE_MEDIA), new Uint8Array([4, 5, 6]))
    })
  })

  it('anyone (even anonymous) can read FREE-course media', async () => {
    const s = testEnv.unauthenticatedContext().storage()
    await assertSucceeds(getBytes(ref(s, FREE_MEDIA)))
  })

  it('a contact WITHOUT the subscription CANNOT read subscription-tier media', async () => {
    // THE fix — this used to succeed for any contact of the team.
    await assertFails(getBytes(ref(contactStorage('free1'), SUB_MEDIA)))
  })

  it('a contact WITH the matching subscription CAN read subscription-tier media', async () => {
    await assertSucceeds(getBytes(ref(contactStorage('pro1'), SUB_MEDIA)))
  })

  it('team staff can read gated media', async () => {
    const s = testEnv.authenticatedContext('staffS').storage()
    await assertSucceeds(getBytes(ref(s, SUB_MEDIA)))
  })

  // ── Uploads: video is embed-only ──────────────────────────────────────────
  // A video served from this bucket is billed per byte delivered to every
  // member who watches it (docs/scalability-2026-09.md §12). The rule refuses
  // it everywhere under a team except the kiosk's standby media, which loops
  // on one tablet. Audio stays uploadable.

  const staffStorage = () => testEnv.authenticatedContext('staffS').storage()
  const bytes = new Uint8Array([9, 9, 9])

  it('staff CANNOT upload a video under a course', async () => {
    await assertFails(
      uploadBytes(ref(staffStorage(), `teams/${TEAM}/courses/${FREE_COURSE}/lessons/media/z.mp4`), bytes, {
        contentType: 'video/mp4',
      }),
    )
  })

  it('staff CANNOT upload a video anywhere else under the team', async () => {
    await assertFails(
      uploadBytes(ref(staffStorage(), `teams/${TEAM}/misc/z.mp4`), bytes, { contentType: 'video/mp4' }),
    )
  })

  it('staff CAN still upload audio, images and PDFs under a course', async () => {
    await assertSucceeds(
      uploadBytes(ref(staffStorage(), `teams/${TEAM}/courses/${FREE_COURSE}/lessons/media/a.mp3`), bytes, {
        contentType: 'audio/mpeg',
      }),
    )
    await assertSucceeds(
      uploadBytes(ref(staffStorage(), `teams/${TEAM}/courses/${FREE_COURSE}/lessons/images/i.png`), bytes, {
        contentType: 'image/png',
      }),
    )
  })

  it('the kiosk standby media is the one place a video may be uploaded', async () => {
    await assertSucceeds(
      uploadBytes(ref(staffStorage(), `teams/${TEAM}/kiosk/loop.mp4`), bytes, { contentType: 'video/mp4' }),
    )
  })
})
