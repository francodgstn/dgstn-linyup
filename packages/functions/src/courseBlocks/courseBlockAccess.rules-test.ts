import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

// Security rules for course blocks (types/courseBlock.ts).
//
// A course carries CAPACITY, `places_taken` is an absolute counter written only
// from a transaction that read the enrolments beside it, and, from the sale
// stage, a price. So unlike the session series it owns, which any team member
// may write directly, every client write here is denied and the studio's own
// edits go through callables that check `schedule.manage`.
//
// The sibling series is deliberately covered too: it is the one thing in this
// area a client CAN still write, and the test says so out loud rather than
// leaving the asymmetry to be rediscovered.
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
const TEAM = 'teamCourseBlocks'
const BLOCK = 'blockCourseBlocks'
const CONTACT = 'contactCourseBlocks'
const OWNER = 'ownerCourseBlocks'
const OUTSIDER = 'outsiderCourseBlocks'

let testEnv: RulesTestEnvironment

const ownerDb = () => testEnv.authenticatedContext(OWNER).firestore()
const outsiderDb = () => testEnv.authenticatedContext(OUTSIDER).firestore()

const BLOCK_DOC = {
  teamId: TEAM,
  name: 'Level 2 Seepferd',
  places: 9,
  places_taken: 4,
  status: 'published',
  meetings: [],
}

describe('firestore.rules, course blocks', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-course-blocks',
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
      await setDoc(doc(db, 'course_blocks', BLOCK), BLOCK_DOC)
      await setDoc(doc(db, 'course_blocks', BLOCK, 'enrolments', CONTACT), {
        teamId: TEAM,
        status: 'enrolled',
      })
      await setDoc(doc(db, 'teams', TEAM, 'team_members', OWNER), { role: 'owner' })
      await setDoc(doc(db, 'users', OWNER), { currentTeam: TEAM })
      await setDoc(doc(db, 'users', OUTSIDER), { currentTeam: 'someOtherTeam' })
    })
  })

  it('a team owner CAN read their own course', async () => {
    await assertSucceeds(getDoc(doc(ownerDb(), 'course_blocks', BLOCK)))
  })

  it('a non-member CANNOT read it', async () => {
    await assertFails(getDoc(doc(outsiderDb(), 'course_blocks', BLOCK)))
  })

  it('a team owner CANNOT create a course from the client', async () => {
    await assertFails(
      setDoc(doc(ownerDb(), 'course_blocks', 'forged'), { ...BLOCK_DOC, name: 'Free course' })
    )
  })

  it('a team owner CANNOT move the places counter', async () => {
    // The one that matters: `places_taken` is written only from a transaction
    // that read the enrolments in the same read set. A client that could set it
    // could sell a tenth place on a nine-place course.
    await assertFails(updateDoc(doc(ownerDb(), 'course_blocks', BLOCK), { places_taken: 0 }))
  })

  it('a team owner CANNOT edit or delete a course from the client', async () => {
    await assertFails(updateDoc(doc(ownerDb(), 'course_blocks', BLOCK), { places: 99 }))
    await assertFails(deleteDoc(doc(ownerDb(), 'course_blocks', BLOCK)))
  })

  it('a team owner CAN read an enrolment but CANNOT write one', async () => {
    // An enrolment IS the place. Writing one from a client is taking a place
    // without anything having counted it.
    await assertSucceeds(getDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'enrolments', CONTACT)))
    await assertFails(
      setDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'enrolments', 'someoneElse'), {
        teamId: TEAM,
        status: 'enrolled',
      })
    )
    await assertFails(
      updateDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'enrolments', CONTACT), { status: 'withdrawn' })
    )
    await assertFails(deleteDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'enrolments', CONTACT)))
  })

  it('a non-member CANNOT read an enrolment', async () => {
    await assertFails(getDoc(doc(outsiderDb(), 'course_blocks', BLOCK, 'enrolments', CONTACT)))
  })

  it('a team owner CAN read the waiting list but CANNOT write one', async () => {
    // An OFFERED entry carries `offer_token`, the credential that takes a
    // place. A client that could write one could hand itself a place it was
    // never offered, so every write goes through a callable.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'course_blocks', BLOCK, 'course_waitlist', CONTACT), {
        teamId: TEAM,
        course: BLOCK,
        contact: CONTACT,
        status: 'waiting',
        entry_token: 'tok',
      })
    })
    await assertSucceeds(getDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'course_waitlist', CONTACT)))
    await assertFails(
      updateDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'course_waitlist', CONTACT), {
        status: 'offered',
        offer_token: 'forged',
      })
    )
    await assertFails(
      setDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'course_waitlist', 'someoneElse'), {
        teamId: TEAM,
        status: 'offered',
        offer_token: 'forged',
      })
    )
    await assertFails(
      deleteDoc(doc(ownerDb(), 'course_blocks', BLOCK, 'course_waitlist', CONTACT))
    )
  })

  it('a non-member CANNOT read the waiting list', async () => {
    // Who is waiting for a place, and their email, is the studio's business.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'course_blocks', BLOCK, 'course_waitlist', CONTACT), {
        teamId: TEAM,
        status: 'waiting',
      })
    })
    await assertFails(
      getDoc(doc(outsiderDb(), 'course_blocks', BLOCK, 'course_waitlist', CONTACT))
    )
  })

  it('the series a course owns stays client-writable, which is why the course is not', async () => {
    // Stated here on purpose. `session_series` is writable by any team member:
    // `SessionFormDialog` writes one directly, and the series doc IS the commit
    // for a hand-made recurring class. That is exactly why a course could not
    // just be a flag on a series: a price and a capacity cannot live on a
    // document the client may edit.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'session_series', 'seriesCourseBlocks'), {
        teamId: TEAM,
        teacher: OWNER,
        status: 'fixed',
        course_block_id: BLOCK,
      })
    })
    await assertSucceeds(
      updateDoc(doc(ownerDb(), 'session_series', 'seriesCourseBlocks'), { status: 'active' })
    )
  })
})
