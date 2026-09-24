import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// WHO A PUBLIC COURSE RAIL BELIEVES IT IS TALKING TO.
//
// Both of these shipped wrong, in the same way, and the rule they broke is
// written verbatim in `booking/dropIn.ts`:
//
//   "Trust ONLY the verified contact-session token for the caller's identity —
//    never a contactId from the request body (which would let anyone act as,
//    and enumerate, arbitrary contacts of the team)."
//
// `joinCourseBlock` and `createCourseBlockCheckout` are both on PUBLIC routers
// and both read `contactId` out of `request.data`. Anyone could enrol anyone on
// any free or plan-covered course of any studio, start a checkout as somebody
// else, and map which contact ids exist by watching which came back
// `not-found`. Neither had an auth check at all.
//
// Nothing behavioural catches this: every call the app makes passes the RIGHT
// contact id, so every screen works. It is only wrong for a caller nobody wrote
// a test for, which is the caller that matters. So it is pinned against the
// source, structurally.
//
// Run with: pnpm --filter @linyup/functions test

const read = (rel: string) =>
  readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

/**
 * Every callable on a PUBLIC router that puts somebody on a course or takes
 * their money for one, and WHAT PROVES who is calling. Named rather than
 * counted, and the exemptions are stated as explicitly as the inclusions.
 *
 * `credential: 'session'` — the caller asserts nothing. A `contactId` in the
 * body would BE the identity claim, so it is forbidden outright.
 *
 * `credential: <token field>` — the caller holds an unguessable single-use
 * credential that names one row. There `contactId` is an ADDRESS, not a claim:
 * it says which entry, and the token is checked against that exact entry's
 * stored value, so a wrong pairing simply fails. Forbidding it would buy
 * nothing and cost a second collection-group lookup per claim.
 */
const PUBLIC_COURSE_RAILS: Array<{
  file: string
  fn: string
  credential: 'session' | string
}> = [
  { file: 'courseBlocks/enrolment.ts', fn: 'joinCourseBlock', credential: 'session' },
  { file: 'courseBlocks/checkout.ts', fn: 'createCourseBlockCheckout', credential: 'session' },
  { file: 'courseBlocks/waitlist.ts', fn: 'joinCourseBlockWaitlist', credential: 'session' },
  { file: 'courseBlocks/waitlist.ts', fn: 'claimCourseBlockPlace', credential: 'offer_token' },
]

function bodyOf(file: string, fn: string): string {
  const src = read(file)
  const start = src.indexOf(`export const ${fn} = onCall`)
  assert.ok(start > 0, `${fn} not found in ${file}`)
  const next = src.indexOf('\nexport ', start + 1)
  return src.slice(start, next === -1 ? undefined : next)
}

describe('a public course rail never takes its caller from the request body', () => {
  for (const rail of PUBLIC_COURSE_RAILS.filter((r) => r.credential === 'session')) {
    it(`${rail.fn} does not read contactId out of request.data`, () => {
      const body = bodyOf(rail.file, rail.fn)
      // The destructure is where it went wrong both times.
      const destructures = /const \{[^}]*\bcontactId\b[^}]*\} = (request\.data|data)\b/.test(body)
      assert.ok(
        !destructures,
        `${rail.fn} destructures contactId from the request body: take it from ` +
          `optionalContactSessionFromRequest, or resolve it from email + name`
      )
    })

    it(`${rail.fn} establishes its caller before it writes`, () => {
      // Either a verified session, or the waiting list's resolve-or-create from
      // email plus name. What it may never do is believe an id it was handed.
      const body = bodyOf(rail.file, rail.fn)
      assert.ok(
        /optionalContactSessionFromRequest\(request\)/.test(body) ||
          /contactDetails/.test(body),
        `${rail.fn} must resolve who is calling, from a session or from details`
      )
    })
  }

  for (const rail of PUBLIC_COURSE_RAILS.filter((r) => r.credential !== 'session')) {
    it(`${rail.fn} checks its ${rail.credential} against the row it names`, () => {
      // What makes the addressed contactId safe. The credential is compared to
      // the STORED one on that exact entry, so naming somebody else's row with
      // your own token fails rather than acting as them.
      const body = bodyOf(rail.file, rail.fn)
      assert.match(
        body,
        new RegExp(`get\\('${rail.credential}'\\) !== `),
        `${rail.fn} must compare the supplied ${rail.credential} with the stored one`
      )
    })
  }

  it('the pin is capable of failing', () => {
    // A source-reading assertion is green on the day it is written whether or
    // not it works, so the pattern is run against the code as it WAS.
    const asItWas = `export const joinCourseBlock = onCall(async (request) => {
      const { teamId, blockId, contactId } = request.data as {
        teamId?: string
      }
    })`
    assert.ok(/const \{[^}]*\bcontactId\b[^}]*\} = request\.data\b/.test(asItWas))
  })
})

describe('a tenant check never comes after the write it guards', () => {
  it('enrolCourseBlockContact verifies the course BEFORE taking a place', () => {
    // It used to check `block.teamId` on the value `takeCourseBlockPlace`
    // returned, which is one line too late: the enrolment was already committed
    // and one of the other studio's places consumed, and the refusal rolled
    // nothing back. A foreign name and email simply sat on their roster.
    const body = bodyOf('courseBlocks/enrolment.ts', 'enrolCourseBlockContact')
    const check = body.indexOf("'That course belongs to another studio.'")
    const write = body.indexOf('takeCourseBlockPlace(')
    assert.ok(check > 0 && write > 0)
    assert.ok(check < write, 'the course tenant check must precede the place write')
  })
})
