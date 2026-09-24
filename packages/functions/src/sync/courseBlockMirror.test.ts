import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import { buildCourseBlockPublicProfile } from './syncCourseBlockPublicProfile'

// THE COURSE MIRROR: what the world may see of a course.
//
// Two properties, and the first is the one that matters:
//
//  1. AGGREGATES, NEVER IDENTITIES. A card needs to say "2 of 9 places", never
//     who has them. The enrolments live in a subcollection the mirror does not
//     read, so this is true by construction, and this file is what keeps it true
//     if somebody later reaches for a name to put on a card.
//  2. A COUNT, NOT A CALENDAR. The meeting list runs to 200 entries; a public
//     card shows the first date, the last and how many. Mirroring the list would
//     put the whole term into a world-readable document for no reader.
//
// Run with: pnpm --filter @linyup/functions test

const meeting = (iso: string, minutes: number) => ({
  start: Timestamp.fromDate(new Date(iso)),
  end: Timestamp.fromMillis(new Date(iso).getTime() + minutes * 60_000),
})

const BLOCK = {
  teamId: 'team-1',
  name: 'Level 2 Seepferd',
  description: 'For children who can float.',
  activityId: 'act-1',
  activityName: 'Kids swimming',
  seriesId: 'series-1',
  placeId: 'pool-freilager',
  providerId: 'uid-thomas',
  providerName: 'Thomas',
  priceAmount: 364,
  includedSubscriptionTypeIds: ['gold'],
  benefit: { subscriptionTypeIds: ['silver'], effect: 'percent_off', percent: 10 },
  audience: 'anyone',
  places: 9,
  places_taken: 2,
  status: 'published',
  booking_closes_at: Timestamp.fromDate(new Date('2026-08-16T12:00:00Z')),
  meetings: [
    meeting('2026-08-19T13:45:00Z', 30),
    meeting('2026-08-26T13:45:00Z', 30),
    meeting('2026-09-02T13:45:00Z', 30),
  ],
  // Things that must NOT reach a public document.
  createdBy: 'uid-owner',
  fanout_conflicts: ['session-4'],
  roster_version: 7,
}

describe('the course mirror', () => {
  const mirror = buildCourseBlockPublicProfile(BLOCK)

  it('says how full it is, and never who is on it', () => {
    assert.equal(mirror.places, 9)
    assert.equal(mirror.places_taken, 2)
    const text = JSON.stringify(mirror)
    for (const leak of ['uid-owner', 'enrolments', 'contactId', 'email']) {
      assert.ok(!text.includes(leak), `the mirror must not carry ${leak}`)
    }
  })

  it('carries a count and the two ends, not the whole term', () => {
    assert.equal(mirror.meeting_count, 3)
    assert.equal(
      (mirror.first_meeting as Timestamp).toMillis(),
      new Date('2026-08-19T13:45:00Z').getTime()
    )
    assert.equal(
      (mirror.last_meeting as Timestamp).toMillis(),
      new Date('2026-09-02T13:45:00Z').getTime() + 30 * 60_000
    )
    assert.ok(!('meetings' in mirror), 'the meeting list is not a public document')
  })

  it('carries the price and BOTH halves of the plan edge', () => {
    // A card that had the included list but not the benefit would say "full
    // price" to somebody whose plan discounts it, which is the bug the resolver
    // arm already had to be corrected for.
    assert.equal(mirror.priceAmount, 364)
    assert.deepEqual(mirror.includedSubscriptionTypeIds, ['gold'])
    assert.ok(mirror.benefit)
  })

  it('carries the sign-up wall and the closing date, which decide what the card may offer', () => {
    assert.equal(mirror.audience, 'anyone')
    assert.ok(mirror.booking_closes_at)
  })

  it('leaves the studio-only bookkeeping behind', () => {
    assert.ok(!('fanout_conflicts' in mirror))
    assert.ok(!('roster_version' in mirror))
    assert.ok(!('seriesId' in mirror), 'the series is an internal link, not a public one')
  })

  it('reports a free, uncapped course honestly rather than as an absence', () => {
    const free = buildCourseBlockPublicProfile({
      ...BLOCK,
      priceAmount: undefined,
      places: undefined,
      places_taken: undefined,
    })
    // Null rather than missing: a card distinguishes "free" from "we could not
    // read the price", and `placesFree` reads a null cap as uncapped.
    assert.equal(free.priceAmount, null)
    assert.equal(free.places, null)
    assert.equal(free.places_taken, 0)
  })
})
