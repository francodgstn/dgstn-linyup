import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import { goalIsArchived, sortSteps, type Goal } from '@linyup/shared'

// The two predicates behind the admin tab's sort control and the archive that
// every surface honors. Both are pure; the ordering rules they encode are the
// ones a coach notices immediately when they are wrong — an unplaced task
// jumping to the top of a list, or a filed-away goal reappearing.

const ts = (iso: string) => Timestamp.fromDate(new Date(iso)) as unknown as Goal['created_at']

function task(id: string, extra: Partial<Goal> = {}): Goal {
  return {
    id,
    type: 'task',
    title: id,
    status: 'open',
    categories: [],
    created_by: 'coach',
    created_at: ts('2026-01-01T00:00:00Z'),
    ...extra,
  } as Goal
}

const ids = (list: Goal[]) => list.map((g) => g.id).join(',')

describe('goalIsArchived', () => {
  it('is false for the ABSENT field — every goal written before the field existed', () => {
    assert.equal(goalIsArchived(task('a')), false)
  })
  it('is false for an explicit null (an un-archived goal)', () => {
    assert.equal(goalIsArchived(task('a', { archived_at: null })), false)
  })
  it('is true once stamped', () => {
    assert.equal(goalIsArchived(task('a', { archived_at: ts('2026-02-01T00:00:00Z') })), true)
  })
})

describe('sortSteps', () => {
  it('manual: placed tasks first in their order, unplaced after in incoming order', () => {
    const list = [
      task('unplaced1'),
      task('second', { order: 1 }),
      task('unplaced2'),
      task('first', { order: 0 }),
    ]
    assert.equal(ids(sortSteps(list, 'manual')), 'first,second,unplaced1,unplaced2')
  })

  it('with nothing dragged AND identical timestamps, incoming order survives', () => {
    const list = [task('c'), task('a'), task('b')]
    assert.equal(ids(sortSteps(list, 'manual')), 'c,a,b')
  })

  // THE CASE THAT WAS WRONG IN PRODUCTION. `order` is written only by a drag,
  // never on create, so every step of an untouched goal ties — and the surfaces
  // all query `created_at desc`, so leaning on the stable sort rendered a
  // sequence backwards for the overwhelmingly common case.
  it('unplaced tasks read OLDEST-FIRST, not in the query order they arrived in', () => {
    const list = [
      task('register', { created_at: ts('2026-01-04T00:00:00Z') }),
      task('cut', { created_at: ts('2026-01-03T00:00:00Z') }),
      task('spar', { created_at: ts('2026-01-02T00:00:00Z') }),
      task('drill', { created_at: ts('2026-01-01T00:00:00Z') }),
    ]
    assert.equal(ids(sortSteps(list, 'manual')), 'drill,spar,cut,register')
  })

  it('a drag still wins over the timestamp tie-break', () => {
    const list = [
      task('old-but-last', { order: 1, created_at: ts('2026-01-01T00:00:00Z') }),
      task('new-but-first', { order: 0, created_at: ts('2026-01-09T00:00:00Z') }),
    ]
    assert.equal(ids(sortSteps(list, 'manual')), 'new-but-first,old-but-last')
  })

  it('date modes break their own ties by age too', () => {
    const same = '2026-05-01T00:00:00Z'
    const list = [
      task('newer', { target_date: ts(same), created_at: ts('2026-01-05T00:00:00Z') }),
      task('older', { target_date: ts(same), created_at: ts('2026-01-02T00:00:00Z') }),
    ]
    assert.equal(ids(sortSteps(list, 'target_date')), 'older,newer')
  })

  it('date modes sort ascending with the undated LAST, not first', () => {
    const list = [
      task('undated'),
      task('late', { target_date: ts('2026-06-01T00:00:00Z') }),
      task('early', { target_date: ts('2026-03-01T00:00:00Z') }),
    ]
    assert.equal(ids(sortSteps(list, 'target_date')), 'early,late,undated')
  })

  it('start_date and target_date are read independently', () => {
    const list = [
      task('x', { start_date: ts('2026-05-01T00:00:00Z'), target_date: ts('2026-02-01T00:00:00Z') }),
      task('y', { start_date: ts('2026-01-01T00:00:00Z'), target_date: ts('2026-09-01T00:00:00Z') }),
    ]
    assert.equal(ids(sortSteps(list, 'start_date')), 'y,x')
    assert.equal(ids(sortSteps(list, 'target_date')), 'x,y')
  })

  it('a date mode ignores `order` entirely, and manual ignores the dates', () => {
    const list = [
      task('dated-first', { order: 9, target_date: ts('2026-01-01T00:00:00Z') }),
      task('placed-first', { order: 0, target_date: ts('2026-12-01T00:00:00Z') }),
    ]
    assert.equal(ids(sortSteps(list, 'target_date')), 'dated-first,placed-first')
    assert.equal(ids(sortSteps(list, 'manual')), 'placed-first,dated-first')
  })

  it('ties keep incoming order (stable), so equal dates read as the query gave them', () => {
    const same = ts('2026-04-01T00:00:00Z')
    const list = [task('c', { target_date: same }), task('a', { target_date: same }), task('b', { target_date: same })]
    assert.equal(ids(sortSteps(list, 'target_date')), 'c,a,b')
  })

  it('does not mutate its input', () => {
    const list = [task('b', { order: 1 }), task('a', { order: 0 })]
    const before = ids(list)
    sortSteps(list, 'manual')
    assert.equal(ids(list), before)
  })
})
