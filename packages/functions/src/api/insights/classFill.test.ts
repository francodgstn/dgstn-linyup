import * as assert from 'node:assert'
import type { ApiSession } from '@linyup/shared'
import { computeClassFill } from './classFill'

function session(over: Partial<ApiSession> & { start: string }): ApiSession {
  return {
    object: 'session',
    id: Math.random().toString(36).slice(2),
    activity: { id: 'bjj', name: 'BJJ', type: 'class' },
    end: null,
    duration_minutes: 60,
    location: null,
    place_id: null,
    room_id: null,
    provider: { id: 'marta', name: 'Marta' },
    capacity: 10,
    booked: 5,
    waitlisted: 0,
    attended: 4,
    trial_bookings: 0,
    status: 'open',
    booking: { allowed: true, required: false },
    headline: null,
    headline_public: false,
    series_id: null,
    tags: [],
    ...over,
  }
}

// Thursday 18:00 in Zurich (CEST, UTC+2) is 16:00 UTC.
const THU = '2026-09-10T16:00:00.000Z'
const THU_NEXT = '2026-09-17T16:00:00.000Z'
const TUE = '2026-09-15T05:30:00.000Z'

describe('class fill rates', () => {
  it('averages fill per class, caps an overbooked session at 100% and counts full ones', () => {
    const rows = computeClassFill(
      [
        session({ start: THU, booked: 10 }),
        session({ start: THU_NEXT, booked: 12 }),
        session({ start: TUE, booked: 5 }),
      ],
      'activity',
      'Europe/Zurich'
    )
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].sessions, 3)
    assert.strictEqual(rows[0].avg_fill_percent, Math.round(((1 + 1 + 0.5) / 3) * 100))
    assert.strictEqual(rows[0].full_sessions, 2)
    assert.strictEqual(rows[0].avg_booked, 9)
  })

  it('leaves out cancelled sessions and appointments', () => {
    const rows = computeClassFill(
      [
        session({ start: THU, booked: 10 }),
        session({ start: THU_NEXT, status: 'cancelled', booked: 0 }),
        session({ start: TUE, activity: { id: 'pt', name: 'Personal training', type: 'appointment' }, capacity: 1, booked: 1 }),
      ],
      'activity',
      'Europe/Zurich'
    )
    assert.deepStrictEqual(rows.map((r) => [r.label, r.sessions, r.avg_fill_percent]), [['BJJ', 1, 100]])
  })

  it('groups by the weekly slot in the studio’s time zone', () => {
    const rows = computeClassFill(
      [session({ start: THU, booked: 8 }), session({ start: THU_NEXT, booked: 6 }), session({ start: TUE, booked: 2 })],
      'weekday_time',
      'Europe/Zurich'
    )
    assert.deepStrictEqual(
      rows.map((r) => [r.label, r.sessions, r.avg_fill_percent]),
      [
        ['Thu 18:00', 2, 70],
        ['Tue 07:30', 1, 20],
      ]
    )
  })

  it('counts a session with no capacity without inventing a fill rate', () => {
    const rows = computeClassFill([session({ start: THU, capacity: null, booked: 30 })], 'provider', 'Europe/Zurich')
    assert.strictEqual(rows[0].label, 'Marta')
    assert.strictEqual(rows[0].capped_sessions, 0)
    assert.strictEqual(rows[0].avg_fill_percent, null)
    assert.strictEqual(rows[0].full_sessions, 0)
  })
})
