import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// WHO MAY SETTLE A COURSE PLACE WITHOUT PAYING.
//
// This exists because the answer was "anybody holding an offer token", and the
// module header directly above the callable said otherwise. A waiting-list
// offer is a claim on a PLACE, never on the money, but `claimCourseBlockPlace`
// wrote `payment_status: 'not_required'` unconditionally, so a valid token on a
// CHF 364 course settled it for nothing. Every other rail onto a course had the
// gate; the queue was the way round all of them.
//
// Nothing sampled this, and nothing could have: the defect has no failing state
// short of a real offer on a real priced course, and the header asserting the
// guard is exactly what a reviewer would have read instead of the code. So the
// shape is pinned against the source, and the shape is the thing: EVERY rail
// that can put somebody on a course prices it through the one resolver first,
// and refuses `pay` before it writes anything.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
// CRLF-normalized: Windows checkouts store these with \r\n, and a bare newline
// anchor would pass in CI and fail on a laptop.
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

/** Every callable that can settle a course enrollment without a Stripe charge.
 *  Named rather than counted: a claim checkable by reading the names beside it
 *  fails visibly rather than silently. */
const FREE_RAILS = [
  { file: 'courseBlocks/enrolment.ts', fn: 'joinCourseBlock' },
  { file: 'courseBlocks/waitlist.ts', fn: 'claimCourseBlockPlace' },
]

describe('every free way onto a course prices it first', () => {
  for (const rail of FREE_RAILS) {
    it(`${rail.fn} resolves a price and refuses a payable caller`, () => {
      const src = read(rail.file)
      const start = src.indexOf(`export const ${rail.fn} = onCall`)
      assert.ok(start > 0, `${rail.fn} not found in ${rail.file}`)
      // To the next top-level export, or the end of the file.
      const next = src.indexOf('\nexport ', start + 1)
      const body = src.slice(start, next === -1 ? undefined : next)

      assert.match(
        body,
        /resolvePaymentOptions\(/,
        `${rail.fn} must price through the one resolver, never decide for itself`
      )
      assert.match(
        body,
        /reason: 'payment_required'/,
        `${rail.fn} must refuse a payable caller with payment_required`
      )
      // The empty-options branch, which is the one that falls through to a free
      // settle when it is missing.
      assert.match(
        body,
        /if \(!option\)/,
        `${rail.fn} must refuse when the resolver offers nothing at all`
      )
    })

    it(`${rail.fn} refuses BEFORE it writes anything`, () => {
      // Order is the whole guarantee. A refusal raised after the enrollment was
      // settled would be a place given away and an error shown.
      const src = read(rail.file)
      const start = src.indexOf(`export const ${rail.fn} = onCall`)
      const next = src.indexOf('\nexport ', start + 1)
      const body = src.slice(start, next === -1 ? undefined : next)
      const refusal = body.indexOf("reason: 'payment_required'")
      const write = Math.min(
        ...[body.indexOf('runTransaction'), body.indexOf('takeCourseBlockPlace')].filter(
          (i) => i >= 0
        )
      )
      assert.ok(refusal > 0 && Number.isFinite(write) && write > 0)
      assert.ok(refusal < write, `${rail.fn} must refuse before it writes`)
    })
  }

  it('and the claim rail does NOT price itself as already-enrolled', () => {
    // `courseBlockTarget(block, { enrolled: true })` answers "you already own
    // this", which is free. A claimant is HOLDING a place, not standing on one,
    // so the claim must ask as a newcomer would or the gate above is a no-op.
    const body = read('courseBlocks/waitlist.ts')
    assert.match(body, /courseBlockTarget\(block, \{ enrolled: false \}\)/)
    assert.ok(
      !/courseBlockTarget\([^)]*enrolled: true/.test(body),
      'the claim rail must never price the caller as already enrolled'
    )
  })

  it('the pins are capable of failing', () => {
    // A source-reading assertion is green on the day it is written whether or
    // not it works, so each pattern is run against the code as it WAS.
    const asItWas = `export const claimCourseBlockPlace = onCall(async (request) => {
      const { settled } = await db.runTransaction(async (tx) => {
        tx.set(ref, { status: 'enrolled', payment_status: 'not_required' })
      })
    })`
    assert.ok(!/resolvePaymentOptions\(/.test(asItWas))
    assert.ok(!/reason: 'payment_required'/.test(asItWas))
    assert.ok(!/if \(!option\)/.test(asItWas))
  })
})
