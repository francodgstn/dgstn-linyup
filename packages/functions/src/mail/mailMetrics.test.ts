import assert from 'node:assert/strict'
import { previousZurichDay } from './mailMetrics'

// The window is the reason these figures mean anything: get the offset wrong and
// a day's sends land in its neighbor, twice a year, with nothing to notice it.
describe('previousZurichDay', () => {
  const iso = (d: Date) => d.toISOString()

  it('spans the previous calendar day in winter (UTC+1)', () => {
    const { start, end } = previousZurichDay('2026-01-15')
    assert.equal(iso(start), '2026-01-13T23:00:00.000Z')
    assert.equal(iso(end), '2026-01-14T23:00:00.000Z')
  })

  it('spans the previous calendar day in summer (UTC+2)', () => {
    const { start, end } = previousZurichDay('2026-07-15')
    assert.equal(iso(start), '2026-07-13T22:00:00.000Z')
    assert.equal(iso(end), '2026-07-14T22:00:00.000Z')
  })

  it('crosses a month boundary', () => {
    const { start, end } = previousZurichDay('2026-03-01')
    assert.equal(iso(start), '2026-02-27T23:00:00.000Z')
    assert.equal(iso(end), '2026-02-28T23:00:00.000Z')
  })

  it('crosses a year boundary', () => {
    const { start, end } = previousZurichDay('2026-01-01')
    assert.equal(iso(start), '2025-12-30T23:00:00.000Z')
    assert.equal(iso(end), '2025-12-31T23:00:00.000Z')
  })

  it('gives the spring-forward day its 23 hours', () => {
    // 2026-03-29 is the last Sunday of March: 02:00 CET → 03:00 CEST.
    const { start, end } = previousZurichDay('2026-03-30')
    assert.equal(iso(start), '2026-03-28T23:00:00.000Z')
    assert.equal(iso(end), '2026-03-29T22:00:00.000Z')
    assert.equal(end.getTime() - start.getTime(), 23 * 60 * 60 * 1000)
  })

  it('gives the fall-back day its 25 hours', () => {
    // 2026-10-25 is the last Sunday of October: 03:00 CEST → 02:00 CET.
    const { start, end } = previousZurichDay('2026-10-26')
    assert.equal(iso(start), '2026-10-24T22:00:00.000Z')
    assert.equal(iso(end), '2026-10-25T23:00:00.000Z')
    assert.equal(end.getTime() - start.getTime(), 25 * 60 * 60 * 1000)
  })
})
