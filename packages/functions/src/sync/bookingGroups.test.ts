import assert from 'node:assert/strict'
import { groupActivitiesForBooking, bookingGroupsInUse, normalizeBookingGroup } from '@linyup/shared'

// THE ONE GROUPER for the public booking page's sections (Activity.bookingGroup).
// Run: pnpm --filter @linyup/functions test  (build @linyup/shared first).

const act = (name: string, order: number, bookingGroup?: string) => ({ name, order, bookingGroup })

describe('normalizeBookingGroup', () => {
  it('trims, bounds, and reads blank as ungrouped', () => {
    assert.equal(normalizeBookingGroup('  Kurse  '), 'Kurse')
    assert.equal(normalizeBookingGroup('   '), undefined)
    assert.equal(normalizeBookingGroup(''), undefined)
    assert.equal(normalizeBookingGroup(undefined), undefined)
    assert.equal(normalizeBookingGroup(42), undefined)
    assert.equal(normalizeBookingGroup('x'.repeat(80))?.length, 40)
  })
})

describe('groupActivitiesForBooking', () => {
  it('keeps a studio that never grouped anything on one flat, unlabelled list', () => {
    const flat = [act('B', 1), act('A', 0)]
    assert.deepEqual(groupActivitiesForBooking(flat), [{ activities: [act('A', 0), act('B', 1)] }])
  })

  it('orders groups by their FIRST activity, and activities inside by order', () => {
    const sections = groupActivitiesForBooking([
      act('Kraul 2', 3, 'Kurse'),
      act('Morgen', 1, 'Training'),
      act('Kraul 1', 2, 'Kurse'),
      act('Abend', 0, 'Training'),
    ])
    assert.deepEqual(
      sections.map((s) => [s.group, s.activities.map((a) => a.name)]),
      [
        ['Training', ['Abend', 'Morgen']],
        ['Kurse', ['Kraul 1', 'Kraul 2']],
      ]
    )
  })

  it('is case-insensitive, labeled by the first spelling — a typo is not a second section', () => {
    const sections = groupActivitiesForBooking([act('A', 0, 'Kinder'), act('B', 1, 'kinder')])
    assert.equal(sections.length, 1)
    assert.equal(sections[0].group, 'Kinder')
    assert.deepEqual(sections[0].activities.map((a) => a.name), ['A', 'B'])
  })

  it('puts the ungrouped last, in one unnamed bucket, whatever their order', () => {
    const sections = groupActivitiesForBooking([act('Loose', 0), act('Grouped', 5, 'Kurse')])
    assert.deepEqual(
      sections.map((s) => [s.group, s.activities.map((a) => a.name)]),
      [
        ['Kurse', ['Grouped']],
        [undefined, ['Loose']],
      ]
    )
  })

  it('loses nothing: every activity comes back exactly once', () => {
    const input = [act('A', 0, 'X'), act('B', 1), act('C', 2, 'Y'), act('D', 3, 'x')]
    const out = groupActivitiesForBooking(input).flatMap((s) => s.activities)
    assert.equal(out.length, input.length)
    assert.deepEqual(new Set(out.map((a) => a.name)), new Set(['A', 'B', 'C', 'D']))
  })
})

describe('bookingGroupsInUse', () => {
  it('lists the headings in the order the booking page renders them', () => {
    assert.deepEqual(
      bookingGroupsInUse([act('A', 2, 'Kurse'), act('B', 0, 'Training'), act('C', 1), act('D', 3, 'Kurse')]),
      ['Training', 'Kurse']
    )
  })
})
