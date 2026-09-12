import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, setDoc } from 'firebase/firestore'
import { getBytes, listAll, ref, uploadBytes } from 'firebase/storage'

// Security-rules test for teams/{teamId}/tarif595/** in storage.rules.
//
// Storage grants if ANY matching rule allows, so the broad teams/{teamId}
// member match cannot be overridden by a narrower deny — it has to exclude the
// prefix itself, on read AND write. This pins that exclusion: a MANAGER of the
// team (the strongest client the broad match serves) can neither read, list
// nor upload under tarif595/, while the same manager still can under any other
// team prefix. The receipts are served only by downloadTarif595Receipt.
//
// Needs BOTH emulators:  pnpm --filter @linyup/functions test:rules

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

const TEAM = 'teamT595'
const RECEIPT_PDF = `teams/${TEAM}/tarif595/receipt123/receipt.pdf`
const RECEIPT_DIR = `teams/${TEAM}/tarif595/receipt123`
const OTHER_PDF = `teams/${TEAM}/documents/handout.pdf`
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

let testEnv: RulesTestEnvironment

describe('storage.rules — tarif595 receipts are not client-readable', function () {
  this.timeout(30_000)

  before(async () => {
    // projectId MUST be the emulator's own project: a Storage rule's
    // cross-service firestore.get resolves against the Storage emulator's project.
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
      await setDoc(doc(ctx.firestore(), 'teams', TEAM, 'team_members', 'managerT595'), { role: 'manager' })
      await setDoc(doc(ctx.firestore(), 'users', 'managerT595'), { currentTeam: TEAM })
      await uploadBytes(ref(ctx.storage(), RECEIPT_PDF), PDF_BYTES, { contentType: 'application/pdf' })
      await uploadBytes(ref(ctx.storage(), OTHER_PDF), PDF_BYTES, { contentType: 'application/pdf' })
    })
  })

  it('a manager of the team cannot read, list or upload under tarif595/', async () => {
    const storage = testEnv.authenticatedContext('managerT595').storage()
    await assertFails(getBytes(ref(storage, RECEIPT_PDF)))
    await assertFails(listAll(ref(storage, RECEIPT_DIR)))
    await assertFails(uploadBytes(ref(storage, `teams/${TEAM}/tarif595/forged/receipt.pdf`), PDF_BYTES, { contentType: 'application/pdf' }))
  })

  it('…while the same manager still reads and uploads under any other team prefix', async () => {
    const storage = testEnv.authenticatedContext('managerT595').storage()
    await assertSucceeds(getBytes(ref(storage, OTHER_PDF)))
    await assertSucceeds(uploadBytes(ref(storage, `teams/${TEAM}/documents/new.pdf`), PDF_BYTES, { contentType: 'application/pdf' }))
  })

  it('an unauthenticated client is refused', async () => {
    const storage = testEnv.unauthenticatedContext().storage()
    await assertFails(getBytes(ref(storage, RECEIPT_PDF)))
  })
})
