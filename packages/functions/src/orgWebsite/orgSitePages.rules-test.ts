import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc } from 'firebase/firestore'

// Security-rules coverage for an organization site's PAGES —
// `org_site_drafts/{orgId}/pages/{pageId}` and
// `org_site_published/{orgId}/pages/{pageId}`.
//
// The same shape as the team site's pages: a draft page is the org admin's to
// read and write (the builder saves it directly), and a published page is
// readable by anyone and written by nobody but `publishOrgWebsite`. Without the
// nested matches, the builder could not save a page at all — Firestore rules
// do not cascade into subcollections.
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

function emulatorAddress(): { host: string; port: number } {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':')
  return { host: host || '127.0.0.1', port: Number(port) || 8080 }
}

const RULES = findRules()
const ORG = 'orgPages'
const ADMIN = 'orgPagesAdmin'
const VIEWER = 'orgPagesViewer'
const OUTSIDER = 'orgPagesOutsider'
const DRAFT_PAGE = ['org_site_drafts', ORG, 'pages', 'p-about'] as const
const PUBLISHED_PAGE = ['org_site_published', ORG, 'pages', 'p-about'] as const
const PAGE = { orgId: ORG, pageId: 'p-about', sections: [] }

let testEnv: RulesTestEnvironment

describe('firestore.rules — organization site pages', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-org-site-pages',
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
      await setDoc(doc(db, 'organizations', ORG), { name: 'Federation', slug: 'federation' })
      await setDoc(doc(db, 'organizations', ORG, 'org_members', ADMIN), { role: 'org_admin' })
      await setDoc(doc(db, 'organizations', ORG, 'org_members', VIEWER), { role: 'org_viewer' })
      await setDoc(doc(db, ...DRAFT_PAGE), PAGE)
      await setDoc(doc(db, ...PUBLISHED_PAGE), PAGE)
    })
  })

  const as = (uid: string) => testEnv.authenticatedContext(uid).firestore()
  const anon = () => testEnv.unauthenticatedContext().firestore()

  it('an org admin reads and writes a draft page', async () => {
    await assertSucceeds(getDoc(doc(as(ADMIN), ...DRAFT_PAGE)))
    await assertSucceeds(setDoc(doc(as(ADMIN), ...DRAFT_PAGE), { ...PAGE, sections: [{ id: 's1', type: 'content' }] }))
  })

  it('nobody else touches a draft page', async () => {
    for (const db of [as(VIEWER), as(OUTSIDER), anon()]) {
      await assertFails(getDoc(doc(db, ...DRAFT_PAGE)))
      await assertFails(setDoc(doc(db, ...DRAFT_PAGE), PAGE))
    }
  })

  it('anyone reads a published page, and no client writes one', async () => {
    await assertSucceeds(getDoc(doc(anon(), ...PUBLISHED_PAGE)))
    await assertSucceeds(getDoc(doc(as(OUTSIDER), ...PUBLISHED_PAGE)))
    for (const db of [as(ADMIN), as(OUTSIDER), anon()]) {
      await assertFails(setDoc(doc(db, ...PUBLISHED_PAGE), PAGE))
    }
  })
})
