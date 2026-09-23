import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planSeriesRoll } from '../dailyTasks/rollSessionSeries'
import { buildSeriesSessionDoc } from '../sessions/series'
import { Timestamp } from 'firebase-admin/firestore'

// A COURSE OWNS ITS SERIES, AND NOTHING ELSE MAY EDIT IT.
//
// The course's lessons are ordinary sessions of an ordinary series, which is
// what gets them a roster, attendance, reminders and cancellation for free. The
// price of that reuse is that the series' OWN editing callables can reach them —
// and one of them, `updateRecurringSession`'s regeneration branch, deletes
// future sessions outright with no bookings check. On a course those are lessons
// somebody paid for.
//
// So three things have to hold, and none of them is visible in a type:
//
//  1. Every generated lesson carries `course_block_id`, from the SERIES rather
//     than the template — a fact about which series this is, not a field a
//     studio can edit off a lesson.
//  2. The daily roller never extends a course. Its `status == 'active'` query
//     already excludes one, which is what makes the guard free; the pure guard
//     is the structural half, so the guarantee survives a status flipped back.
//  3. The two series-editing callables refuse a course's series by name.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')

/** Line endings normalised — the tree is LF on CI and CRLF on Windows. */
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')

const occurrence = {
  start: new Date('2026-08-19T13:45:00Z'),
  end: new Date('2026-08-19T14:15:00Z'),
}

describe('a course owns its series', () => {
  it('stamps the course on every lesson it generates', () => {
    const doc = buildSeriesSessionDoc(
      'series-1',
      { teamId: 'team-1', teacher: 'uid-1', course_block_id: 'course-1', template: { activityId: 'act-1' } },
      occurrence
    )
    assert.equal(doc.course_block_id, 'course-1')
  })

  it('leaves an ordinary series' + "'" + 's sessions unstamped', () => {
    const doc = buildSeriesSessionDoc(
      'series-1',
      { teamId: 'team-1', teacher: 'uid-1', template: { activityId: 'act-1' } },
      occurrence
    )
    assert.ok(!('course_block_id' in doc), 'a plain class must not gain a course field')
  })

  it('takes the course from the SERIES, never from the template', () => {
    // A template field is copied onto every session and is editable through the
    // series; a lesson that could be edited out of its own course would then be
    // deletable by the very branch this guard exists to stop.
    const doc = buildSeriesSessionDoc(
      'series-1',
      { teamId: 'team-1', teacher: 'uid-1', template: { activityId: 'act-1', course_block_id: 'forged' } },
      occurrence
    )
    assert.ok(!('course_block_id' in doc))
  })

  it('never rolls a course forward, even if its status says active', () => {
    const base = {
      endCondition: 'date' as const,
      recurrenceStartMs: Date.UTC(2026, 7, 1),
      lastGeneratedUntilMs: null,
      nowMs: Date.UTC(2026, 7, 10),
      horizonMs: Date.UTC(2027, 1, 10),
      refreshBeforeMs: Date.UTC(2026, 10, 10),
    }
    // The belt: a course's series is 'fixed', which the roller's query excludes.
    assert.equal(planSeriesRoll({ ...base, status: 'fixed' }).roll, false)
    // The braces: even called with 'active', a fixed occurrence list is refused.
    // Rolling one would invent lessons nobody bought.
    const guarded = planSeriesRoll({ ...base, status: 'active', fixedOccurrences: true })
    assert.equal(guarded.roll, false)
    assert.equal(guarded.reason, 'fixed')
    // …and the guard is capable of failing: the same series without it rolls.
    assert.equal(planSeriesRoll({ ...base, status: 'active' }).roll, true)
  })

  it('refuses the two series-editing callables by name', () => {
    // Asserted on the SOURCE because both refusals are early returns inside
    // callables that import firebase-functions, and the claim is about the
    // guard existing at all — the class of bug is somebody removing it.
    const sessions = read('sessions/index.ts')
    const refusals = sessions.split('course_block_id').length - 1
    assert.ok(
      refusals >= 2,
      'sessions/index.ts must refuse a course series in BOTH updateRecurringSession and the series-wide cancelSession'
    )
    assert.ok(
      sessions.includes("'belongs-to-course'"),
      'the refusal must name itself so the client can route the studio to the course'
    )
  })
})
