import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TARIF595_EXPIRY_WARNING_DAYS,
  TARIF595_POSITIONS,
  tarif595DayAfter,
  tarif595PositionExpiry,
  tarif595PositionOn,
} from '@linyup/shared/tarif595-positions'
import { clampAsOf } from './suggest'

// The list retires positions every 1 January. A mapping that is fine today can
// refuse the first receipt of the new year, so the settings page warns ahead —
// on the date rule pinned here. Position 3015 ("Pilates, pro 1 Monat") is one
// of the rows whose last valid day is 2026-12-31; 1001 is open-ended.

const EXPIRING = '3015'
const OPEN = '1001'

describe('tarif595PositionExpiry — warn ahead of the last valid day', () => {
  it('the fixtures are what the test thinks they are', () => {
    assert.equal(TARIF595_POSITIONS.find((p) => p.code === EXPIRING)?.valid_until, '2026-12-31')
    assert.equal(TARIF595_POSITIONS.find((p) => p.code === OPEN)?.valid_until, null)
  })

  it('an open-ended position never warns; an unknown code answers null', () => {
    assert.deepEqual(tarif595PositionExpiry(OPEN, '2026-12-30'), { status: 'ok', validUntil: null })
    assert.equal(tarif595PositionExpiry('0000', '2026-12-30'), null)
  })

  it('is ok outside the horizon, expiring inside it, expired after the last valid day', () => {
    assert.equal(tarif595PositionExpiry(EXPIRING, '2026-06-01')?.status, 'ok')
    assert.equal(tarif595PositionExpiry(EXPIRING, '2026-09-18')?.status, 'expiring')
    // The last valid day itself is still valid — and still warns.
    assert.equal(tarif595PositionExpiry(EXPIRING, '2026-12-31')?.status, 'expiring')
    assert.deepEqual(tarif595PositionExpiry(EXPIRING, '2027-01-01'), { status: 'expired', validUntil: '2026-12-31' })
  })

  it('the horizon edge: warns from exactly TARIF595_EXPIRY_WARNING_DAYS before the day after expiry', () => {
    // today + horizon > validUntil  ⇔  today > validUntil − horizon
    const [y, m, d] = [2026, 12, 31]
    const edge = new Date(Date.UTC(y, m - 1, d - TARIF595_EXPIRY_WARNING_DAYS)).toISOString().slice(0, 10)
    assert.equal(tarif595PositionExpiry(EXPIRING, edge)?.status, 'ok')
    assert.equal(tarif595PositionExpiry(EXPIRING, tarif595DayAfter(edge))?.status, 'expiring')
  })

  it('agrees with the validity rule the preview refuses on', () => {
    assert.ok(tarif595PositionOn(EXPIRING, '2026-12-31'))
    assert.equal(tarif595PositionOn(EXPIRING, tarif595DayAfter('2026-12-31')), null)
    assert.equal(tarif595DayAfter('2026-12-31'), '2027-01-01')
    assert.equal(tarif595DayAfter('2028-02-28'), '2028-02-29')
  })
})

describe('suggestTarif595Mappings — asOf, how a replacement is proposed', () => {
  it('clamps to [today, today + the maximum]; anything else is today', () => {
    assert.equal(clampAsOf('2027-01-01', '2026-09-18'), '2027-01-01')
    assert.equal(clampAsOf('2026-09-18', '2026-09-18'), '2026-09-18')
    assert.equal(clampAsOf('2026-01-01', '2026-09-18'), '2026-09-18', 'never the past')
    assert.equal(clampAsOf('2029-01-01', '2026-09-18'), '2026-09-18', 'never past the next edition')
    assert.equal(clampAsOf('01.01.2027', '2026-09-18'), '2026-09-18')
    assert.equal(clampAsOf(undefined, '2026-09-18'), '2026-09-18')
  })

  it('the catalogue AND the parser both run on the clamped day, so this year’s codes are refused in a replacement', () => {
    const src = readFileSync(join(__dirname, 'suggest.ts'), 'utf8').replace(/\r\n/g, '\n')
    assert.match(src, /const today = clampAsOf\(data\.asOf, nowIso\)/)
    assert.match(src, /tarif595PositionsOn\(today\)/)
    assert.match(src, /tarif595PositionOn\(v\.trim\(\), today\)/)
  })
})
