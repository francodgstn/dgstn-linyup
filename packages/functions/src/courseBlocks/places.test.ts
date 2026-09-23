import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  countHoldingPlaces,
  courseBlockEnrolmentHoldsPlace,
  placeFreedEdge,
  placesFree,
} from '@linyup/shared'

// ONE PLACE WRITER, the seat rule, one level up.
//
// A course's "9 places" is a second capacity axis: a child who misses lesson
// four must not free a place, and thirteen sessions each at 9/9 are thirteen
// answers to one question. So the course document is the serialization point
// and `places_taken` obeys the same rule `bookings_count` does:
//
//   an ABSOLUTE value, from a recount or from a transaction that read the
//   enrolments in the same read set. No `FieldValue.increment`, anywhere.
//
// These fixtures pin the predicates that turn documents into that number, and
// the last one pins the rule itself against the source, because "we always
// write it absolutely" is a claim that rots the first time somebody reaches for
// an increment, and nothing else would notice.
//
// Run with: pnpm --filter @linyup/functions test

const NOW = Date.UTC(2026, 8, 1, 12, 0)
const ts = (ms: number) => ({ toMillis: () => ms })

const docs = (
  entries: Array<{ id: string; status?: string; expires_at?: { toMillis(): number } | null }>
) => entries.map((e) => ({ id: e.id, data: () => e }))

describe('a course place', () => {
  it('is held by an enrolment, and by a hold that has not lapsed', () => {
    assert.equal(courseBlockEnrolmentHoldsPlace({ status: 'enrolled' }, NOW), true)
    assert.equal(
      courseBlockEnrolmentHoldsPlace({ status: 'hold', expires_at: ts(NOW + 60_000) }, NOW),
      true
    )
    // An absent status is an enrolment. A row with no opinion is somebody on the
    // course, not somebody who is not.
    assert.equal(courseBlockEnrolmentHoldsPlace({}, NOW), true)
  })

  it('is freed the moment a hold lapses, not at the next sweep', () => {
    // The lesson the appointment rail learned the hard way: a course advertised
    // full on the strength of an abandoned checkout is a place nobody can reach.
    assert.equal(
      courseBlockEnrolmentHoldsPlace({ status: 'hold', expires_at: ts(NOW - 1) }, NOW),
      false
    )
  })

  it('is not held by a withdrawal, whatever else the row says', () => {
    assert.equal(
      courseBlockEnrolmentHoldsPlace({ status: 'withdrawn', expires_at: ts(NOW + 60_000) }, NOW),
      false
    )
  })

  it('counts the live rows at ONE sampled instant', () => {
    const snapshot = docs([
      { id: 'a', status: 'enrolled' },
      { id: 'b', status: 'hold', expires_at: ts(NOW + 60_000) },
      { id: 'c', status: 'hold', expires_at: ts(NOW - 1) },
      { id: 'd', status: 'withdrawn' },
    ])
    assert.equal(countHoldingPlaces(snapshot, NOW), 2)
  })

  it('excludes the caller, whose own row the gate is about to replace', () => {
    // A buyer re-opening an abandoned checkout, or a webhook confirming the hold
    // it created: counting their own row would refuse them the place they hold.
    const snapshot = docs([
      { id: 'a', status: 'enrolled' },
      { id: 'me', status: 'hold', expires_at: ts(NOW + 60_000) },
    ])
    assert.equal(countHoldingPlaces(snapshot, NOW, 'me'), 1)
  })

  it('never runs out on an uncapped course', () => {
    assert.equal(placesFree(null, 99), Infinity)
    assert.equal(placesFree(0, 99), Infinity)
    assert.equal(placesFree(9, 4), 5)
    assert.equal(placesFree(9, 12), 0, 'an oversold course reports no places, never a negative')
  })
})

describe('the place-freed edge', () => {
  it('fires when a full course gains room, and only then', () => {
    assert.equal(placeFreedEdge({ places: 9, places_taken: 9 }, { places: 9, places_taken: 8 }), true)
    // Already had room: no edge, so a promoter does not re-enter on its own write.
    assert.equal(placeFreedEdge({ places: 9, places_taken: 7 }, { places: 9, places_taken: 6 }), false)
    // Filling up is not freeing.
    assert.equal(placeFreedEdge({ places: 9, places_taken: 8 }, { places: 9, places_taken: 9 }), false)
  })

  it('fires when the studio raises the cap on a full course', () => {
    assert.equal(placeFreedEdge({ places: 9, places_taken: 9 }, { places: 12, places_taken: 9 }), true)
  })

  it('never fires on an uncapped or a cancelled course', () => {
    // Uncapped was never full, so there is no edge to cross…
    assert.equal(placeFreedEdge({ places: null, places_taken: 9 }, { places: null, places_taken: 8 }), false)
    // …and a cancelled course has no place to hand on.
    assert.equal(
      placeFreedEdge({ places: 9, places_taken: 9 }, { places: 9, places_taken: 0, status: 'cancelled' }),
      false
    )
  })
})

describe('the ONE PLACE WRITER rule, asserted against the source', () => {
  // Structural, not a sample: the defect is a future `increment` on this field,
  // which no behaviour test would see until two people had bought one place.
  // Matched on ANY receiver and any spelling of the field, a pin that requires
  // one spelling passes against the very edit it exists to catch.
  const SRC = join(__dirname, '..')
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
  /** CODE only: a prose mention of the rule in a comment is not a writer. */
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  for (const file of ['courseBlocks/enrolment.ts', 'courseBlocks/index.ts']) {
    it(`${file} never increments places_taken`, () => {
      const source = code(read(file))
      const offenders = source
        .split('\n')
        .filter((line) => /places_taken/.test(line) && /increment\s*\(/.test(line))
      assert.deepEqual(
        offenders,
        [],
        `places_taken must be written as an ABSOLUTE value from a read set, never incremented:\n${offenders.join('\n')}`
      )
    })
  }

  it('and the pin is capable of failing', () => {
    const forged = "tx.update(blockRef, { places_taken: FieldValue.increment(1) })"
    assert.ok(/places_taken/.test(forged) && /increment\s*\(/.test(forged))
  })
})
