import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import {
  DROPPED_ON_DUPLICATE,
  carriedCourseFields,
  shiftMeetings,
  shiftPattern,
} from './duplicate'
import { civilDaysBetween, shiftWallClockDays } from '../utils/recurrence'

// DUPLICATING A COURSE: "run Level 2 Seepferd again, from 4 March".
//
// Two classes of defect, and neither one announces itself.
//
// THE CLOCK. A term duplicated into the next term crosses a DST boundary by
// construction, so `+ n * 86_400_000` turns a 15:45 lesson into a 14:45 one.
// Nobody reads a copy's thirteen times; they read the first one, and by the
// time a parent arrives an hour late it is a fact about the studio. These
// fixtures cross the boundary in both directions on purpose.
//
// THE DENY-LIST. A copy that carried `places_taken` would be born looking half
// full, one that carried `status: 'published'` would go on sale before anybody
// checked it, and one that carried `seriesId` would write its lessons into the
// OLD course's calendar. The list is asserted by behaviour, not by length: a
// count would rot the moment a field is added.
//
// Run with: pnpm --filter @linyup/functions test

const ZURICH_SUMMER = new Date('2026-08-19T13:45:00Z') // 15:45 Zurich, CEST
const ZURICH_WINTER = new Date('2026-11-25T14:45:00Z') // 15:45 Zurich, CET

describe('shifting a lesson to another term', () => {
  it('keeps the WALL CLOCK across a summer-to-winter boundary', () => {
    // 19 Aug to 25 Nov is 98 days. Both are 15:45 in Zurich; they are one hour
    // apart in UTC, which is exactly the hour a millisecond shift would lose.
    const moved = shiftWallClockDays(ZURICH_SUMMER, 98)
    assert.equal(moved.toISOString(), ZURICH_WINTER.toISOString())
  })

  it('keeps it the other way round too, winter to summer', () => {
    const moved = shiftWallClockDays(ZURICH_WINTER, -98)
    assert.equal(moved.toISOString(), ZURICH_SUMMER.toISOString())
  })

  it('is NOT the same as adding the milliseconds, which is the point', () => {
    const naive = new Date(ZURICH_SUMMER.getTime() + 98 * 86_400_000)
    const correct = shiftWallClockDays(ZURICH_SUMMER, 98)
    assert.notEqual(naive.toISOString(), correct.toISOString())
    // An hour out: 14:45 Zurich instead of 15:45.
    assert.equal(correct.getTime() - naive.getTime(), 60 * 60_000)
  })

  it('preserves the weekday when the shift is a multiple of seven', () => {
    const wednesday = ZURICH_SUMMER.getUTCDay()
    assert.equal(shiftWallClockDays(ZURICH_SUMMER, 98).getUTCDay(), wednesday)
  })

  it('counts whole calendar days between two terms, DST and all', () => {
    assert.equal(civilDaysBetween(ZURICH_SUMMER, ZURICH_WINTER), 98)
    assert.equal(civilDaysBetween(ZURICH_WINTER, ZURICH_SUMMER), -98)
    assert.equal(civilDaysBetween(ZURICH_SUMMER, ZURICH_SUMMER), 0)
  })
})

describe('the copy’s meeting list', () => {
  const ts = (iso: string) => Timestamp.fromDate(new Date(iso))

  it('moves every meeting by the same delta and keeps each one’s OWN length', () => {
    // The weekend course: Saturday 10:00 to 16:15, Sunday 09:00 to 15:00. Two
    // different lengths from one course, which is why a copy shifts the list
    // instead of regenerating from a pattern.
    const weekend = [
      { start: ts('2026-08-22T08:00:00Z'), end: ts('2026-08-22T14:15:00Z') },
      { start: ts('2026-08-23T07:00:00Z'), end: ts('2026-08-23T13:00:00Z') },
    ]
    const moved = shiftMeetings(weekend, 7)
    assert.equal(moved.length, 2)
    for (let i = 0; i < 2; i++) {
      assert.equal(
        moved[i].end.toMillis() - moved[i].start.toMillis(),
        weekend[i].end.toMillis() - weekend[i].start.toMillis(),
        'a meeting keeps its own length'
      )
      assert.equal(civilDaysBetween(weekend[i].start.toDate(), moved[i].start.toDate()), 7)
    }
  })

  it('keeps the gaps between lessons, so a skipped fortnight stays skipped', () => {
    const term = [
      { start: ts('2026-08-19T13:45:00Z'), end: ts('2026-08-19T14:15:00Z') },
      // a fortnight later: the two October weeks were skipped
      { start: ts('2026-09-02T13:45:00Z'), end: ts('2026-09-02T14:15:00Z') },
    ]
    const moved = shiftMeetings(term, 98)
    assert.equal(
      civilDaysBetween(moved[0].start.toDate(), moved[1].start.toDate()),
      civilDaysBetween(term[0].start.toDate(), term[1].start.toDate())
    )
  })
})

describe('the pattern that comes with the copy', () => {
  it('DROPS the skip dates rather than shifting them', () => {
    // "No lesson on 8 October" is a fact about one autumn. Shifted into spring
    // it removes a lesson nobody asked about, and the studio finds out in week
    // seven. Starting with every date present is the error somebody notices the
    // same day.
    const pattern = {
      recurrence: {
        frequency: 'weekly' as const,
        interval: 1,
        duration: 30,
        endCondition: 'date' as const,
        startDate: Timestamp.fromDate(new Date('2026-08-19T13:45:00Z')),
        endDate: Timestamp.fromDate(new Date('2026-11-26T14:15:00Z')),
        excludeDates: [
          Timestamp.fromDate(new Date('2026-10-08T13:45:00Z')),
          Timestamp.fromDate(new Date('2026-10-15T13:45:00Z')),
        ],
      },
    }
    const moved = shiftPattern(pattern, 98)
    assert.deepEqual(moved?.recurrence.excludeDates, [])
  })

  it('moves the pattern’s own dates with the list', () => {
    const pattern = {
      recurrence: {
        frequency: 'weekly' as const,
        interval: 1,
        duration: 30,
        endCondition: 'never' as const,
        startDate: Timestamp.fromDate(ZURICH_SUMMER),
      },
    }
    const moved = shiftPattern(pattern, 98)
    assert.equal(
      (moved?.recurrence.startDate as Timestamp).toMillis(),
      ZURICH_WINTER.getTime(),
      'the stored pattern must not still point at last term'
    )
  })

  it('has nothing to move for a course whose dates were typed one by one', () => {
    assert.equal(shiftPattern(null, 98), null)
    assert.equal(shiftPattern(undefined, 98), null)
  })
})

describe('what a copy carries, and what it refuses to', () => {
  const SOURCE = {
    teamId: 'team-1',
    name: 'Level 2 Seepferd',
    description: 'For children who can float.',
    activityId: 'act-1',
    activityName: 'Kids swimming',
    priceAmount: 364,
    places: 9,
    includedSubscriptionTypeIds: ['gold'],
    benefit: { subscriptionTypeIds: ['silver'], effect: 'percent_off', percent: 10 },
    audience: 'anyone',
    close_days_before: 3,
    // none of these may survive
    places_taken: 7,
    status: 'published',
    seriesId: 'series-old',
    meetings: [{ start: 1, end: 2 }],
    fanout_conflicts: ['session-4'],
    roster_version: 12,
    createdBy: 'uid-owner',
    created_at: 'then',
  }

  it('carries the SETUP: what it costs, who it is for, and what it runs on', () => {
    const carried = carriedCourseFields(SOURCE)
    assert.equal(carried.priceAmount, 364)
    assert.equal(carried.places, 9)
    assert.deepEqual(carried.includedSubscriptionTypeIds, ['gold'])
    assert.ok(carried.benefit)
    assert.equal(carried.audience, 'anyone')
    assert.equal(carried.activityId, 'act-1')
    assert.equal(carried.close_days_before, 3)
  })

  it('carries NOTHING about the people who were on the last one', () => {
    const carried = carriedCourseFields(SOURCE)
    for (const stale of ['places_taken', 'roster_version', 'fanout_conflicts']) {
      assert.ok(!(stale in carried), `a copy must not inherit ${stale}`)
    }
  })

  it('is never born published, and never points at the old calendar', () => {
    const carried = carriedCourseFields(SOURCE)
    // Published would put an unchecked copy on sale; `seriesId` would write its
    // lessons into LAST term's course, which is the worst of the two.
    assert.ok(!('status' in carried))
    assert.ok(!('seriesId' in carried))
    assert.ok(!('meetings' in carried))
    assert.ok(!('booking_closes_at' in carried))
  })

  it('inherits a field nobody has thought of yet', () => {
    // The deny-list direction is the decision: setup is carried by default, so
    // a new `CourseBlock` field works on a copy the day it is added, and only
    // facts about people or about this run have to be named.
    const carried = carriedCourseFields({ ...SOURCE, somethingNew: 'kept' })
    assert.equal(carried.somethingNew, 'kept')
  })

  it('names every field it drops, so the list is read rather than counted', () => {
    // Deliberately not an assertion about HOW MANY: that number rots the moment
    // somebody adds a case, silently, against the reader who trusts it.
    for (const field of ['places_taken', 'seriesId', 'status', 'meetings', 'name']) {
      assert.ok(DROPPED_ON_DUPLICATE.has(field), `${field} must be on the deny-list`)
    }
  })
})
