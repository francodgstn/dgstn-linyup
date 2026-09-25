import assert from 'node:assert/strict'
import { carriedFields, DROPPED_FIELDS } from './duplicateEvent'
import { shiftProgramDays, daysBetweenISO, type EventProgramConfig } from '@linyup/shared'

// Duplicating an event copies its SETUP and never its PARTICIPANTS. These tests
// pin that contract — getting it wrong would either leak another cohort's
// roster onto a new event or silently publish a draft copy.
// Run with: pnpm --filter @linyup/functions test

const SOURCE = {
  id: 'evt1',
  teamId: 'team1',
  orgId: undefined,
  scope: 'team',
  title: 'Summer camp',
  type: 'camp',
  start: { seconds: 1 },
  end: { seconds: 2 },
  location: 'Beach club',
  placeId: 'place1',
  roomId: 'room1',
  description: 'Five days',
  fee: 250,
  status: 'open',
  coachId: 'coach1',
  coachName: 'Marta',
  program: { days: [], tracks: [] },
  // participant state
  participants_count: 42,
  completed_checkins_count: 40,
  attendees_count: 38,
  invitations_sent_count: 90,
  last_invitation_sent_at: { seconds: 3 },
  // provenance + publication
  created_at: { seconds: 4 },
  createdBy: 'someoneElse',
  deleted_at: null,
  publicVisibility: 'public',
} as Record<string, unknown>

describe('duplicateEvent — what carries over', () => {
  const carried = carriedFields(SOURCE)

  it('never carries participant state', () => {
    for (const field of [
      'participants_count',
      'completed_checkins_count',
      'attendees_count',
      'invitations_sent_count',
      'last_invitation_sent_at',
    ]) {
      assert.ok(!(field in carried), `${field} must not be copied`)
    }
  })

  it('never inherits published visibility', () => {
    // The copy is stamped 'hidden' explicitly; the source value must not survive
    // even as a default, or creating a duplicate would expose a draft event.
    assert.ok(!('publicVisibility' in carried))
    assert.ok(DROPPED_FIELDS.has('publicVisibility'))
  })

  it('never carries provenance or the source id', () => {
    for (const field of ['id', 'created_at', 'createdBy', 'deleted_at']) {
      assert.ok(!(field in carried), `${field} must not be copied`)
    }
  })

  it('leaves title, dates and program to be set explicitly', () => {
    for (const field of ['title', 'start', 'end', 'program']) {
      assert.ok(!(field in carried), `${field} is set explicitly, not carried`)
    }
  })

  it('carries the tenant stamp so the copy stays in the same tenant', () => {
    assert.equal(carried.teamId, 'team1')
    assert.equal(carried.scope, 'team')
  })

  it('carries the event setup verbatim', () => {
    assert.equal(carried.type, 'camp')
    assert.equal(carried.location, 'Beach club')
    assert.equal(carried.placeId, 'place1')
    assert.equal(carried.roomId, 'room1')
    assert.equal(carried.fee, 250)
    assert.equal(carried.coachName, 'Marta')
    assert.equal(carried.description, 'Five days')
  })

  it('carries an unknown future field by default', () => {
    // New setup fields should be inherited without anyone remembering to update
    // this function — the deny-list is the deliberate part.
    const withNew = carriedFields({ ...SOURCE, someFutureSetting: 'x' })
    assert.equal(withNew.someFutureSetting, 'x')
  })

  it('carries the org stamp for an org-scoped event', () => {
    const org = carriedFields({ ...SOURCE, teamId: null, orgId: 'org1', scope: 'org' })
    assert.equal(org.orgId, 'org1')
    assert.equal(org.scope, 'org')
    assert.equal(org.teamId, null)
  })
})

describe('duplicateEvent — program day shifting', () => {
  const config: EventProgramConfig = {
    days: [
      { id: 'd1', date: '2026-08-01', title: 'Arrival', order: 0 },
      { id: 'd2', date: '2026-08-02', order: 1 },
      { id: 'd3', date: '2026-08-03', order: 2 },
    ],
    tracks: [{ id: 'kids', name: 'Kids', order: 0 }],
  }

  it('moves a camp to a new start date keeping consecutive days', () => {
    const shift = daysBetweenISO('2026-08-01', '2027-06-14')
    const moved = shiftProgramDays(config, shift)
    assert.deepEqual(
      moved.days.map((d) => d.date),
      ['2027-06-14', '2027-06-15', '2027-06-16'],
    )
    // Ids, titles and tracks are untouched — only the dates move.
    assert.deepEqual(moved.days.map((d) => d.id), ['d1', 'd2', 'd3'])
    assert.equal(moved.days[0].title, 'Arrival')
    assert.deepEqual(moved.tracks, config.tracks)
  })

  it('shifts backwards too', () => {
    const moved = shiftProgramDays(config, daysBetweenISO('2026-08-01', '2026-07-30'))
    assert.deepEqual(moved.days.map((d) => d.date), ['2026-07-30', '2026-07-31', '2026-08-01'])
  })

  it('crosses a DST boundary without collapsing two days onto one', () => {
    // Europe/Zurich springs forward on 2026-03-29 — the classic place where
    // millisecond-based date maths loses or duplicates a day.
    const moved = shiftProgramDays(config, daysBetweenISO('2026-08-01', '2026-03-28'))
    assert.deepEqual(moved.days.map((d) => d.date), ['2026-03-28', '2026-03-29', '2026-03-30'])
    assert.equal(new Set(moved.days.map((d) => d.date)).size, 3)
  })
})
