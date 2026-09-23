import assert from 'node:assert/strict'
import { calculateOccurrences, validateRecurrence } from './recurrence'
import type { RecurrencePattern } from '@linyup/shared'

// SKIP DATES, "every Wednesday from August to November, no lesson on 8.10 and
// 15.10, which is thirteen lessons".
//
// Three things are easy to get wrong here, and each is silent:
//
//  1. Counting a skipped day against a `count` series. "20 lessons, skipping the
//     holidays" then quietly delivers eighteen, and the studio finds out in
//     week nineteen.
//  2. Comparing the day in the PROCESS timezone. Cloud Run is UTC and the
//     studio is in Zurich, so a class in the small hours falls on the previous
//     UTC day, and excluding "24 December" skips the 23rd instead. The rest of
//     recurrence.ts is scrupulously Zurich-aware; `startOfDay` is not, and this
//     is the first feature that reads a calendar day a human typed.
//  3. Treating exclusions as a rule about what EXISTS. They are a rule about
//     what gets CREATED: the generator never writes an excluded day, and a
//     lesson already on the calendar is removed through `cancelSession`,
//     because people may hold bookings on it.
//
// Run with: pnpm --filter @linyup/functions test

/**
 * Zurich wall-clock → the instant.
 *
 * Derived from `Intl`, not from a hand-written offset table: an earlier version
 * of this helper hard-coded "April–September is CEST" and put 8 October at
 * 00:30 the next day, which failed a test that was testing the right thing.
 * DST boundaries are exactly what these fixtures are about, so the fixture does
 * not get to guess them.
 */
function zurich(y: number, m: number, d: number, hh: number, mm = 0): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Zurich',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    })
      .formatToParts(new Date(guess))
      .map(({ type, value }) => [type, parseInt(value, 10)])
  )
  const asZurich = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return new Date(guess + (guess - asZurich))
}

const WEEKLY: RecurrencePattern = {
  frequency: 'weekly',
  interval: 1,
  daysOfWeek: [3], // Wednesday
  duration: 30,
  // 20.08.2025 was a Wednesday; 15:45 Zurich.
  startDate: zurich(2025, 8, 20, 15, 45) as unknown as RecurrencePattern['startDate'],
  endCondition: 'date',
  endDate: zurich(2025, 11, 26, 23, 59) as unknown as RecurrencePattern['endDate'],
}

const run = (pattern: RecurrencePattern, from: Date, to: Date) =>
  calculateOccurrences(
    pattern as unknown as Parameters<typeof calculateOccurrences>[0],
    from,
    to
  )

/** The Zurich calendar day of each occurrence, for readable assertions. */
const days = (occ: { start: Date }[]) =>
  occ.map((o) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(o.start)
  )

describe('recurrence skip dates', () => {
  const from = new Date(Date.UTC(2025, 7, 1))
  const to = new Date(Date.UTC(2025, 11, 1))

  it('drops exactly the skipped days, the Swimatic kids course is 13 lessons', () => {
    const all = run(WEEKLY, from, to)
    assert.equal(all.length, 15, 'without skips, 20.08–26.11 weekly is 15 Wednesdays')

    const withSkips = run(
      {
        ...WEEKLY,
        excludeDates: [
          zurich(2025, 10, 8, 15, 45),
          zurich(2025, 10, 15, 15, 45),
        ] as unknown as RecurrencePattern['excludeDates'],
      },
      from,
      to
    )
    assert.equal(withSkips.length, 13)
    assert.ok(!days(withSkips).includes('2025-10-08'))
    assert.ok(!days(withSkips).includes('2025-10-15'))
    assert.ok(days(withSkips).includes('2025-10-01'))
    assert.ok(days(withSkips).includes('2025-10-22'))
  })

  it('reads only the calendar day, whatever time of day the skip carries', () => {
    // The studio picks a date; whatever instant the picker hands over, it means
    // "that day". Midnight and late evening must exclude the same lesson.
    for (const at of [zurich(2025, 10, 8, 0, 0), zurich(2025, 10, 8, 23, 30)]) {
      const occ = run(
        { ...WEEKLY, excludeDates: [at] as unknown as RecurrencePattern['excludeDates'] },
        from,
        to
      )
      assert.ok(!days(occ).includes('2025-10-08'), `skip at ${at.toISOString()} missed the day`)
      assert.equal(occ.length, 14)
    }
  })

  it('compares the day in the STUDIO timezone, not the process one', () => {
    // A 00:30 Zurich class on 25 December is 23:30 UTC on the 24th. Excluding
    // the 25th must drop the 25th, under a UTC day boundary it would leave the
    // 25th standing and drop the 24th's (nonexistent) lesson instead.
    const lateNight: RecurrencePattern = {
      frequency: 'daily',
      interval: 1,
      duration: 60,
      startDate: zurich(2025, 12, 22, 0, 30) as unknown as RecurrencePattern['startDate'],
      endCondition: 'date',
      endDate: zurich(2025, 12, 27, 23, 59) as unknown as RecurrencePattern['endDate'],
      excludeDates: [zurich(2025, 12, 25, 12, 0)] as unknown as RecurrencePattern['excludeDates'],
    }
    const occ = run(lateNight, new Date(Date.UTC(2025, 11, 20)), new Date(Date.UTC(2025, 11, 28)))
    const got = days(occ)
    assert.ok(!got.includes('2025-12-25'), `Christmas Day survived the exclusion: ${got.join(', ')}`)
    assert.ok(got.includes('2025-12-24'), `Christmas Eve was dropped instead: ${got.join(', ')}`)
  })

  it('does not spend a count on a skipped day', () => {
    // THE RULE: "20 lessons, skipping the holidays" is twenty lessons. If the
    // exclusion were applied after the counter, this would return 8.
    const counted: RecurrencePattern = {
      ...WEEKLY,
      endCondition: 'count',
      endDate: undefined,
      maxOccurrences: 10,
      excludeDates: [
        zurich(2025, 10, 8, 15, 45),
        zurich(2025, 10, 15, 15, 45),
      ] as unknown as RecurrencePattern['excludeDates'],
    }
    const occ = run(counted, from, new Date(Date.UTC(2026, 1, 1)))
    assert.equal(occ.length, 10)
    assert.ok(!days(occ).includes('2025-10-08'))
    assert.ok(!days(occ).includes('2025-10-15'))
  })

  it('ignores a skip date that matches no occurrence, and an empty list', () => {
    const noMatch = run(
      {
        ...WEEKLY,
        // A Thursday, and a date years away, neither is an error.
        excludeDates: [
          zurich(2025, 10, 9, 15, 45),
          zurich(2030, 1, 1, 12, 0),
        ] as unknown as RecurrencePattern['excludeDates'],
      },
      from,
      to
    )
    assert.equal(noMatch.length, 15)
    assert.equal(
      run({ ...WEEKLY, excludeDates: [] as unknown as RecurrencePattern['excludeDates'] }, from, to)
        .length,
      15
    )
  })

  it('accepts a Firestore Timestamp as well as a Date', () => {
    // Stored patterns come back as Timestamps; a form hands over Dates.
    const asTimestamp = { toDate: () => zurich(2025, 10, 8, 15, 45) }
    const occ = run(
      { ...WEEKLY, excludeDates: [asTimestamp] as unknown as RecurrencePattern['excludeDates'] },
      from,
      to
    )
    assert.equal(occ.length, 14)
    assert.ok(!days(occ).includes('2025-10-08'))
  })

  it('validates the field without demanding it', () => {
    const base = { ...WEEKLY } as Partial<RecurrencePattern>
    assert.equal(validateRecurrence(base).valid, true)
    assert.equal(validateRecurrence({ ...base, excludeDates: [] }).valid, true)
    const bad = validateRecurrence({
      ...base,
      excludeDates: 'nope' as unknown as RecurrencePattern['excludeDates'],
    })
    assert.equal(bad.valid, false)
    assert.ok(bad.errors.some((e) => e.includes('Skip dates')))
  })
})
