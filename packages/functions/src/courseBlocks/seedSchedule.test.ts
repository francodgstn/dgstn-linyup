import assert from 'node:assert/strict'
import { courseLessonDates } from '../../../../scripts/lib/courseSchedule'

// THE SEEDED COURSE'S DATES.
//
// A seeder is not usually worth a test, but this one computes something: where
// "a third of the way through" falls, relative to whatever day the seed is run
// on. `/try` reseeds nightly and `pnpm emulators:seed` runs whenever somebody
// feels like it, so this function is evaluated on all seven weekdays, and the
// failure mode is silent in the worst way. A course that lands entirely in the
// future shows an empty roster and no attendance; one entirely in the past
// cannot be enrolled on. Either looks like a working seed until somebody opens
// it.
//
// Run with: pnpm --filter @linyup/functions test

const SPEC = { dayOfWeek: 2, time: '18:00', lessons: 8, lessonsElapsed: 3 }

describe('the seeded course sits a third of the way through', () => {
  it('produces the asked-for number of lessons, a week apart, on the asked-for weekday', () => {
    const dates = courseLessonDates(SPEC)
    assert.equal(dates.length, 8)
    for (const d of dates) assert.equal(d.getDay(), 2, 'every lesson is a Tuesday')
    for (let i = 1; i < dates.length; i++) {
      // Local-date arithmetic, so a DST week is still "one week later at 18:00"
      // rather than 17:00 or 19:00.
      assert.equal(dates[i].getHours(), 18)
      assert.equal(dates[i].getMinutes(), 0)
    }
  })

  it('puts exactly `lessonsElapsed` lessons behind us, WHATEVER DAY IT IS RUN', () => {
    // The whole point. Asserted across a full week rather than on today, which
    // is the one day it was written on and the one day it was sure to pass.
    const realNow = Date.now
    try {
      for (let offset = 0; offset < 7; offset++) {
        // A fixed Monday, walked forward a day at a time through a whole week.
        const day = new Date(2026, 8, 7, 11, 0, 0, 0)
        day.setDate(day.getDate() + offset)
        Date.now = () => day.getTime()
        // `courseLessonDates` builds from `new Date()`, so that is stubbed too.
        const RealDate = Date
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(globalThis as any).Date = class extends RealDate {
          constructor(...args: unknown[]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (args.length === 0) super(day.getTime() as any)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            else super(...(args as []))
          }
          static now() {
            return day.getTime()
          }
        }
        try {
          const dates = courseLessonDates(SPEC)
          const past = dates.filter((d) => d.getTime() < day.getTime()).length
          assert.equal(
            past,
            SPEC.lessonsElapsed,
            `run on ${day.toDateString()}: expected ${SPEC.lessonsElapsed} lessons behind us, got ${past}`
          )
          assert.equal(dates.length - past, SPEC.lessons - SPEC.lessonsElapsed)
        } finally {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(globalThis as any).Date = RealDate
        }
      }
    } finally {
      Date.now = realNow
    }
  })

  it('never produces a course entirely in the future or entirely in the past', () => {
    // The two states that read as a working seed and are not: an empty roster
    // with nothing to attend, and a course nobody can join.
    const dates = courseLessonDates(SPEC)
    const now = Date.now()
    assert.ok(
      dates.some((d) => d.getTime() < now),
      'a seeded course must have started'
    )
    assert.ok(
      dates.some((d) => d.getTime() > now),
      'a seeded course must have lessons left'
    )
  })
})
