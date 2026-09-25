import assert from 'node:assert/strict'
import { resolveCourseSchedule } from './schedule'
import { MAX_COURSE_MEETINGS, type RecurrencePattern } from '@linyup/shared'
import { Timestamp } from 'firebase-admin/firestore'

// A COURSE'S MEETINGS ARE A LIST, the three ways a studio says when it runs,
// and the one shape they all become.
//
// The decisive fixture is the weekend course. `RecurrencePattern` carries ONE
// `startDate` (which is also its time of day) and ONE `duration`, so it cannot
// say "Saturday 10:00–16:15 AND Sunday 09:00–15:00", and that crawl weekend is
// an ordinary product, not an edge case. It is why a course stores a list and
// treats a repeating rule as an authoring input.
//
// Run with: pnpm --filter @linyup/functions test

/** Zurich wall-clock → the instant, derived rather than guessed (a hand-written
 *  offset table got a October date wrong in a sibling test). */
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

const ts = (d: Date) => Timestamp.fromDate(d) as unknown as RecurrencePattern['startDate']

const minutes = (m: { start: { toMillis(): number }; end: { toMillis(): number } }) =>
  Math.round((m.end.toMillis() - m.start.toMillis()) / 60_000)

const dayOf = (m: { start: { toDate(): Date } }) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(m.start.toDate())

describe('a course schedule', () => {
  it('resolves the kids course: 13 Wednesdays with two weeks skipped', () => {
    const { meetings, recurrence } = resolveCourseSchedule({
      kind: 'repeating',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [3],
        duration: 30,
        startDate: ts(zurich(2025, 8, 20, 15, 45)),
        endCondition: 'date',
        endDate: ts(zurich(2025, 11, 26, 16, 15)),
        excludeDates: [
          Timestamp.fromDate(zurich(2025, 10, 8, 15, 45)),
          Timestamp.fromDate(zurich(2025, 10, 15, 15, 45)),
        ] as unknown as RecurrencePattern['excludeDates'],
      },
    })

    assert.equal(meetings.length, 13)
    assert.equal(dayOf(meetings[0]), '2025-08-20')
    assert.equal(dayOf(meetings[meetings.length - 1]), '2025-11-26')
    assert.ok(!meetings.map(dayOf).includes('2025-10-08'))
    assert.ok(!meetings.map(dayOf).includes('2025-10-15'))
    assert.ok(meetings.every((m) => minutes(m) === 30))
    // The rule is kept beside the list, so a reschedule can re-read what the
    // studio typed rather than reverse-engineering it from thirteen dates.
    assert.ok(recurrence)
  })

  it('resolves the weekend course, two days, two different lengths', () => {
    // THE FIXTURE THAT DECIDED THE SHAPE. No RecurrencePattern can express this.
    const sat = zurich(2025, 9, 13, 10, 0)
    const sun = zurich(2025, 9, 14, 9, 0)
    const { meetings, recurrence } = resolveCourseSchedule({
      kind: 'dates',
      meetings: [
        { startMs: sat.getTime(), durationMinutes: 375 }, // 10:00–16:15
        { startMs: sun.getTime(), durationMinutes: 360 }, // 09:00–15:00
      ],
    })

    assert.equal(meetings.length, 2)
    assert.equal(minutes(meetings[0]), 375)
    assert.equal(minutes(meetings[1]), 360)
    assert.equal(recurrence, null, 'dates typed by hand have no rule to keep')
  })

  it('resolves a single-date course', () => {
    const { meetings } = resolveCourseSchedule({
      kind: 'dates',
      meetings: [{ startMs: zurich(2025, 10, 14, 15, 0).getTime(), durationMinutes: 165 }],
    })
    assert.equal(meetings.length, 1)
    assert.equal(minutes(meetings[0]), 165)
  })

  it('orders the meetings and drops a date entered twice', () => {
    const a = zurich(2025, 9, 14, 9, 0).getTime()
    const b = zurich(2025, 9, 13, 10, 0).getTime()
    const { meetings } = resolveCourseSchedule({
      kind: 'dates',
      meetings: [
        { startMs: a, durationMinutes: 60 },
        { startMs: b, durationMinutes: 60 },
        // The same instant twice would give the series two occurrences that its
        // (seriesId, instanceDate) dedupe collapses into one, leaving the
        // course's own count disagreeing with its sessions for ever.
        { startMs: a, durationMinutes: 60 },
      ],
    })
    assert.equal(meetings.length, 2)
    assert.ok(meetings[0].start.toMillis() < meetings[1].start.toMillis())
  })

  it('accepts the dates in the shape a CALLABLE actually delivers them', () => {
    // THE BUG THIS PINS. A callable's payload is JSON, so the client `Timestamp`
    // the web form builds arrives as a plain `{seconds, nanoseconds}` map with no
    // `toDate` on it. Reading only `toDate` returned null for every date the form
    // sent, and the course refused to save with "needs a first lesson date" while
    // the studio was looking at one. Only running it showed this.
    const wire = (d: Date) => ({
      seconds: Math.floor(d.getTime() / 1000),
      nanoseconds: (d.getTime() % 1000) * 1e6,
    })

    const { meetings } = resolveCourseSchedule({
      kind: 'repeating',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [3],
        duration: 30,
        startDate: wire(zurich(2025, 8, 20, 15, 45)) as unknown as RecurrencePattern['startDate'],
        endCondition: 'date',
        endDate: wire(zurich(2025, 11, 26, 16, 15)) as unknown as RecurrencePattern['endDate'],
        excludeDates: [
          wire(zurich(2025, 10, 8, 15, 45)),
          wire(zurich(2025, 10, 15, 15, 45)),
        ] as unknown as RecurrencePattern['excludeDates'],
      },
    })
    assert.equal(meetings.length, 13, 'the wire shape must resolve exactly like a Timestamp does')
    assert.ok(!meetings.map(dayOf).includes('2025-10-08'))
  })

  it('normalizes the stored pattern, so what is saved is Timestamps and not wire maps', () => {
    const wire = (d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 })
    const { recurrence } = resolveCourseSchedule({
      kind: 'repeating',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [3],
        duration: 30,
        startDate: wire(zurich(2025, 8, 20, 15, 45)) as unknown as RecurrencePattern['startDate'],
        endCondition: 'date',
        endDate: wire(zurich(2025, 9, 3, 16, 15)) as unknown as RecurrencePattern['endDate'],
      },
    })
    // Re-reading a saved course depends on this: the dialog calls `.toDate()` on
    // the stored pattern to put the studio back on the shape it typed.
    assert.equal(typeof (recurrence?.startDate as unknown as Timestamp)?.toDate, 'function')
    assert.equal(typeof (recurrence?.endDate as unknown as Timestamp)?.toDate, 'function')
  })

  it('refuses a course that never ends', () => {
    // A course is bounded by definition, "13 lessons", "until November". An
    // open-ended rule is a timetable, which a plain session series already is.
    assert.throws(
      () =>
        resolveCourseSchedule({
          kind: 'repeating',
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            daysOfWeek: [3],
            duration: 30,
            startDate: ts(zurich(2025, 8, 20, 15, 45)),
            endCondition: 'never',
          },
        }),
      /has to end/
    )
  })

  it('refuses a schedule that produces no lesson at all', () => {
    assert.throws(() => resolveCourseSchedule({ kind: 'dates', meetings: [] }), /no lessons/)
    assert.throws(
      () =>
        resolveCourseSchedule({
          kind: 'repeating',
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            daysOfWeek: [0], // Sundays, in a Monday-to-Friday window
            duration: 30,
            startDate: ts(zurich(2025, 8, 18, 15, 45)),
            endCondition: 'date',
            endDate: ts(zurich(2025, 8, 22, 16, 15)),
          },
        }),
      /no lessons/
    )
  })

  it('refuses a nonsense lesson length and a run longer than a course can hold', () => {
    const start = zurich(2025, 9, 13, 10, 0).getTime()
    assert.throws(
      () => resolveCourseSchedule({ kind: 'dates', meetings: [{ startMs: start, durationMinutes: 3000 }] }),
      /between 1 and/
    )
    assert.throws(
      () => resolveCourseSchedule({ kind: 'dates', meetings: [{ startMs: 0, durationMinutes: 60 }] }),
      /not a date/
    )

    const daily = resolveCourseSchedule.bind(null, {
      kind: 'repeating' as const,
      recurrence: {
        frequency: 'daily',
        interval: 1,
        duration: 60,
        startDate: ts(zurich(2025, 1, 1, 9, 0)),
        endCondition: 'count',
        maxOccurrences: MAX_COURSE_MEETINGS + 1,
      } as RecurrencePattern,
    })
    assert.throws(daily, /more than a course can hold/)
  })
})
