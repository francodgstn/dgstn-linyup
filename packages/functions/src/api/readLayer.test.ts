import * as assert from 'node:assert'
import { cursorFingerprint, decodeCursor, encodeCursor } from './cursor'
import { ApiError } from './errors'
import { parseInput, contactListShape, sessionListShape } from './schemas'
import { parseApiInstant, zonedDayStartMs, zonedYmd } from './time'
import { TokenBuckets } from './usage'

function apiErrorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof ApiError ? err.code : 'not_an_api_error'
  }
  return undefined
}

describe('api cursors', () => {
  it('round-trips a key and refuses one issued for other filters', () => {
    const fp = cursorFingerprint({ lifecycle: 'roster', q: 'ada' })
    const raw = encodeCursor({ key: ['Lovelace', 'Ada', 'c-1'], fingerprint: fp })
    assert.deepStrictEqual(decodeCursor(raw, fp)?.key, ['Lovelace', 'Ada', 'c-1'])
    assert.strictEqual(apiErrorCode(() => decodeCursor(raw, cursorFingerprint({ lifecycle: 'live' }))), 'invalid_cursor')
    assert.strictEqual(apiErrorCode(() => decodeCursor('not-a-cursor', fp)), 'invalid_cursor')
    assert.strictEqual(decodeCursor(undefined, fp), null)
  })

  it('fingerprints filters regardless of key order and ignores unset ones', () => {
    assert.strictEqual(cursorFingerprint({ a: 1, b: 'x', c: undefined }), cursorFingerprint({ b: 'x', a: 1 }))
  })
})

describe('api dates', () => {
  it('reads a bare date as the studio day, across a DST change', () => {
    // Zurich: CEST (UTC+2) in September, CET (UTC+1) in January.
    assert.strictEqual(new Date(zonedDayStartMs('2026-09-14', 'Europe/Zurich')).toISOString(), '2026-09-13T22:00:00.000Z')
    assert.strictEqual(new Date(zonedDayStartMs('2026-01-14', 'Europe/Zurich')).toISOString(), '2026-01-13T23:00:00.000Z')
    // The day DST ends (25 hours long) still starts at local midnight.
    assert.strictEqual(new Date(zonedDayStartMs('2026-10-25', 'Europe/Zurich')).toISOString(), '2026-10-24T22:00:00.000Z')
  })

  it('makes `to` inclusive of its day and refuses an instant without an offset', () => {
    const from = parseApiInstant('2026-09-14', 'Europe/Zurich', 'from')
    const to = parseApiInstant('2026-09-14', 'Europe/Zurich', 'to')
    assert.strictEqual(to - from, 86_400_000)
    assert.strictEqual(parseApiInstant('2026-09-14T18:00:00Z', 'Europe/Zurich', 'from'), Date.UTC(2026, 8, 14, 18))
    assert.strictEqual(apiErrorCode(() => parseApiInstant('2026-09-14T18:00', 'Europe/Zurich', 'from')), 'invalid_request')
    assert.strictEqual(apiErrorCode(() => parseApiInstant('next tuesday', 'Europe/Zurich', 'from')), 'invalid_request')
  })

  it('names the studio day of an instant', () => {
    assert.strictEqual(zonedYmd(Date.UTC(2026, 8, 13, 22, 30), 'Europe/Zurich'), '2026-09-14')
  })
})

describe('api request schemas', () => {
  it('reads REST query strings: comma lists, string booleans, numeric strings', () => {
    const q = parseInput(contactListShape(50, 200), {
      engagement: 'at_risk,inactive',
      has_plan: 'true',
      inactive_days: '21',
    })
    assert.deepStrictEqual(q.engagement, ['at_risk', 'inactive'])
    assert.strictEqual(q.has_plan, true)
    assert.strictEqual(q.inactive_days, 21)
    assert.strictEqual(q.limit, 50)
    assert.strictEqual(q.lifecycle, 'live')
  })

  it('refuses what it does not know, with the offending path', () => {
    assert.strictEqual(apiErrorCode(() => parseInput(contactListShape(50, 200), { engagement: 'dormant' })), 'invalid_request')
    assert.strictEqual(apiErrorCode(() => parseInput(contactListShape(50, 200), { limit: '500' })), 'invalid_request')
    assert.strictEqual(apiErrorCode(() => parseInput(sessionListShape(50, 200), { from: '2026-09-14' })), 'invalid_request')
  })
})

describe('api rate buckets', () => {
  it('allows a burst, then asks to wait, then refills', () => {
    const buckets = new TokenBuckets(3, 60)
    const t0 = 1_000_000
    assert.strictEqual(buckets.take('k', t0), 0)
    assert.strictEqual(buckets.take('k', t0), 0)
    assert.strictEqual(buckets.take('k', t0), 0)
    assert.ok(buckets.take('k', t0) > 0)
    assert.strictEqual(buckets.take('k', t0 + 1000), 0, 'one token back after a second at 60/min')
    assert.strictEqual(buckets.take('other', t0), 0, 'buckets are per credential')
  })
})
