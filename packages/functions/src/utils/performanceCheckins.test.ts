import * as assert from 'node:assert'
import {
  buildPerformanceCheckin,
  isSameLocalDay,
  localDayBounds,
  sameDayCheckin,
} from '@linyup/shared'

// ONE payload and ONE same-day rule for the three check-in writers.

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime(), seconds: 0, nanoseconds: 0 })

describe('buildPerformanceCheckin', () => {
  it('stores the author, context, scores, trimmed notes and the profile — with the caller\'s taken_at', () => {
    const stamp = { server: true }
    const doc = buildPerformanceCheckin(
      { scores: { consistency: 4, effort: 3, focus: 4, recharge: 2, sense_of_progress: 3 }, notes: '  felt good ', filled_by: 'coach', context: '1to1' },
      stamp,
    )
    assert.strictEqual(doc.taken_at, stamp)
    assert.strictEqual(doc.filled_by, 'coach')
    assert.strictEqual(doc.context, '1to1')
    assert.strictEqual(doc.notes, 'felt good')
    assert.ok('profile_key' in doc && 'primary_lever' in doc && 'anchor' in doc)
  })

  it('empty notes are null, never "" (three writers, one shape)', () => {
    const base = { scores: { a: 3 }, filled_by: 'student' as const, context: 'self' as const }
    assert.strictEqual(buildPerformanceCheckin({ ...base, notes: '' }, 1).notes, null)
    assert.strictEqual(buildPerformanceCheckin({ ...base, notes: '   ' }, 1).notes, null)
    assert.strictEqual(buildPerformanceCheckin({ ...base }, 1).notes, null)
  })
})

describe('sameDayCheckin', () => {
  const now = new Date(2026, 8, 10, 14, 30)
  const rows = [
    { id: 'a', filled_by: 'student' as const, taken_at: ts(new Date(2026, 8, 10, 9, 0)) },
    { id: 'b', filled_by: 'coach' as const, taken_at: ts(new Date(2026, 8, 10, 11, 0)) },
    { id: 'c', filled_by: 'student' as const, taken_at: ts(new Date(2026, 8, 9, 23, 59)) },
  ]

  it("today's row by the same author, and only that", () => {
    assert.strictEqual(sameDayCheckin(rows, 'student', now)?.id, 'a')
    assert.strictEqual(sameDayCheckin(rows, 'coach', now)?.id, 'b')
  })

  it('yesterday at 23:59 is not today', () => {
    assert.strictEqual(sameDayCheckin([rows[2]], 'student', now), undefined)
  })

  it('another author\'s row never counts', () => {
    assert.strictEqual(sameDayCheckin([rows[1]], 'student', now), undefined)
  })
})

describe('localDayBounds / isSameLocalDay', () => {
  it('brackets the local calendar day', () => {
    const { start, end } = localDayBounds(new Date(2026, 8, 10, 14, 30))
    assert.deepStrictEqual([start.getHours(), start.getMinutes(), start.getDate()], [0, 0, 10])
    assert.deepStrictEqual([end.getHours(), end.getMinutes(), end.getSeconds(), end.getDate()], [23, 59, 59, 10])
    assert.strictEqual(isSameLocalDay(start, end), true)
    assert.strictEqual(isSameLocalDay(end, new Date(2026, 8, 11, 0, 0)), false)
  })
})
