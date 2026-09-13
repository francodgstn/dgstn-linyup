import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import { advancesLastSession } from './lastSession'

// A contact's last session is a HIGH-WATER MARK. The trigger that keeps it is
// handed one attendance row at a time, and a bulk import delivers those rows in
// any order — see lastSession.ts for the "Stopped" contacts that came from
// writing whichever row arrived last.

const at = (iso: string) => Timestamp.fromDate(new Date(iso))

describe('advancesLastSession', () => {
  it('writes when nothing is stored yet', () => {
    assert.equal(advancesLastSession(undefined, at('2026-09-07T18:00:00Z')), true)
    assert.equal(advancesLastSession(null, at('2026-09-07T18:00:00Z')), true)
  })

  it('writes a later session', () => {
    assert.equal(advancesLastSession(at('2026-04-10T18:00:00Z'), at('2026-09-07T18:00:00Z')), true)
  })

  it('never moves the date back — the bug: an old row arriving last', () => {
    assert.equal(advancesLastSession(at('2026-09-07T18:00:00Z'), at('2021-06-09T18:00:00Z')), false)
  })

  it('does not rewrite the same instant', () => {
    assert.equal(advancesLastSession(at('2026-09-07T18:00:00Z'), at('2026-09-07T18:00:00Z')), false)
  })

  it('a row with no session start never writes', () => {
    assert.equal(advancesLastSession(at('2026-09-07T18:00:00Z'), undefined), false)
    assert.equal(advancesLastSession(null, null), false)
  })

  it('reads the shapes a stored value arrives in', () => {
    const newer = at('2026-09-07T18:00:00Z')
    assert.equal(advancesLastSession({ seconds: 1_600_000_000, nanoseconds: 0 }, newer), true)
    assert.equal(advancesLastSession({ _seconds: 1_600_000_000, _nanoseconds: 0 }, newer), true)
    assert.equal(advancesLastSession(new Date('2020-01-01'), newer), true)
  })

  it('ANY ORDER OF DELIVERY converges on the latest session', () => {
    const starts = ['2021-06-09', '2026-04-10', '2023-11-04', '2025-04-02', '2024-01-20'].map((d) => at(`${d}T18:00:00Z`))
    for (let round = 0; round < 20; round++) {
      const shuffled = [...starts].sort(() => Math.random() - 0.5)
      let stored: Timestamp | undefined
      for (const s of shuffled) if (advancesLastSession(stored, s)) stored = s
      assert.equal(stored?.toDate().toISOString().slice(0, 10), '2026-04-10')
    }
  })
})
