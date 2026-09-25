// A NEGOTIATED platform-fee rate — `TenantFlags.fee_rate`, decided by
// `resolveTakeRate` in @linyup/shared. The comp and the census of fee sites live
// in `feeWaiver.test.ts`; this file pins the rate itself: precedence, the cap at
// the published rate, expiry, and the fail-towards-charging fallbacks.

import { strict as assert } from 'assert'
import {
  CONNECT_TAKE_RATE,
  computePlatformFee,
  negotiatedRateExpiresAtMs,
  resolveTakeRate,
  takeRatePercent,
  type TenantFlags,
  type Timestamp,
} from '@linyup/shared'

const NOW = Date.UTC(2026, 8, 17, 12) // 2026-09-17 12:00 UTC

const ts = (ms: number): Timestamp => ({
  toMillis: () => ms,
  toDate: () => new Date(ms),
  seconds: Math.floor(ms / 1000),
  nanoseconds: 0,
})

function rate(bps: number, expiresAtMs: number | null = null): TenantFlags {
  return {
    fee_rate: { bps, reason: 'test', since: ts(NOW - 1000), expires_at: expiresAtMs == null ? null : ts(expiresAtMs) },
  }
}

describe('resolveTakeRate — a negotiated rate', () => {
  it('no flags → the published rate', () => {
    const r = resolveTakeRate({ tier: 'studio', nowMs: NOW })
    assert.deepEqual(r, { rate: CONNECT_TAKE_RATE.studio, source: 'plan', expiresAtMs: null })
  })

  it("a team's own rate replaces the published one", () => {
    const r = resolveTakeRate({ tier: 'studio', teamFlags: rate(50), nowMs: NOW })
    assert.equal(r.rate.bps, 50)
    assert.equal(r.source, 'team_rate')
    assert.equal(r.expiresAtMs, null)
  })

  it("an organization's rate reaches its studios", () => {
    const r = resolveTakeRate({ tier: 'coach', orgFlags: rate(60), nowMs: NOW })
    assert.equal(r.rate.bps, 60)
    assert.equal(r.source, 'org_rate')
  })

  it("the studio's own rate wins over its organization's", () => {
    const r = resolveTakeRate({ tier: 'coach', teamFlags: rate(90), orgFlags: rate(40), nowMs: NOW })
    assert.equal(r.rate.bps, 90)
    assert.equal(r.source, 'team_rate')
  })

  it('a comp beats any rate, on either document', () => {
    for (const [teamFlags, orgFlags] of [
      [{ ...rate(40), comped: true }, undefined],
      [rate(40), { comped: true }],
    ] as [TenantFlags, TenantFlags | undefined][]) {
      const r = resolveTakeRate({ tier: 'studio', teamFlags, orgFlags, nowMs: NOW })
      assert.equal(r.source, 'comped')
      assert.equal(r.rate.bps, 0)
    }
  })

  it('is a DISCOUNT, never a surcharge: at or above the published rate it changes nothing', () => {
    for (const bps of [80, 120, 10_000]) {
      const r = resolveTakeRate({ tier: 'studio', teamFlags: rate(bps), nowMs: NOW })
      assert.deepEqual(r.rate, CONNECT_TAKE_RATE.studio, `${bps} bps must not raise studio's 80`)
      assert.equal(r.source, 'plan')
    }
  })

  it('a plan upgrade past the deal gives the cheaper plan rate', () => {
    // Negotiated 1.0 % as a Coach (1.5 %), then upgraded to Studio (0.8 %).
    const r = resolveTakeRate({ tier: 'studio', teamFlags: rate(100), nowMs: NOW })
    assert.equal(r.rate.bps, 80)
  })

  it('a zero rate takes no fee at all', () => {
    const r = resolveTakeRate({ tier: 'studio', teamFlags: rate(0), nowMs: NOW })
    assert.equal(r.source, 'team_rate')
    assert.equal(computePlatformFee({ tier: 'studio', amount: 10_000, rate: r.rate }), 0)
  })

  it('applies until its expiry and not a millisecond after', () => {
    const until = NOW + 1
    const live = resolveTakeRate({ tier: 'studio', teamFlags: rate(50, until), nowMs: NOW })
    assert.equal(live.rate.bps, 50)
    assert.equal(live.expiresAtMs, until)

    const ended = resolveTakeRate({ tier: 'studio', teamFlags: rate(50, NOW), nowMs: NOW })
    assert.equal(ended.rate.bps, 80)
    assert.equal(ended.source, 'plan')
  })

  it("an expired studio rate falls through to its organization's", () => {
    const r = resolveTakeRate({
      tier: 'studio',
      teamFlags: rate(30, NOW - 1),
      orgFlags: rate(60),
      nowMs: NOW,
    })
    assert.equal(r.rate.bps, 60)
    assert.equal(r.source, 'org_rate')
  })

  it('anything malformed is ignored and the published rate CHARGES', () => {
    const junk: TenantFlags[] = [
      rate(12.5),
      rate(-1),
      rate(10_001),
      { fee_rate: { bps: NaN, reason: '', since: ts(NOW), expires_at: null } },
      { fee_rate: { bps: 50, reason: '', since: ts(NOW), expires_at: {} as Timestamp } },
      { fee_rate: null },
    ]
    for (const teamFlags of junk) {
      const r = resolveTakeRate({ tier: 'studio', teamFlags, nowMs: NOW })
      assert.deepEqual(r.rate, CONNECT_TAKE_RATE.studio, JSON.stringify(teamFlags))
    }
  })

  it('an unknown tier still falls back to the highest published rate', () => {
    const r = resolveTakeRate({ tier: 'nonsense' as never, nowMs: NOW })
    assert.deepEqual(r.rate, CONNECT_TAKE_RATE.free)
  })
})

describe('the fee functions take the resolved rate', () => {
  it('computePlatformFee charges the rate it is given', () => {
    assert.equal(computePlatformFee({ tier: 'studio', amount: 10_000, rate: { bps: 50, minFeeRappen: 0 } }), 50)
  })

  it('absent rate = the published rate, so a forgotten argument never undercharges', () => {
    assert.equal(computePlatformFee({ tier: 'studio', amount: 10_000 }), 80)
    assert.equal(takeRatePercent('studio'), 0.8)
  })

  it('the waiver still wins over a rate', () => {
    assert.equal(computePlatformFee({ tier: 'studio', amount: 10_000, waived: true, rate: { bps: 50, minFeeRappen: 0 } }), 0)
    assert.equal(takeRatePercent('studio', true, { bps: 50, minFeeRappen: 0 }), 0)
  })

  it('takeRatePercent gives the subscription percent of the rate', () => {
    assert.equal(takeRatePercent('studio', false, { bps: 45, minFeeRappen: 0 }), 0.45)
  })
})

describe('negotiatedRateExpiresAtMs — the last day, in the studio calendar', () => {
  it('ends at midnight Zurich AFTER the last day (summer, UTC+2)', () => {
    assert.equal(negotiatedRateExpiresAtMs('2026-09-30'), Date.UTC(2026, 8, 30, 22))
  })

  it('ends at midnight Zurich after the last day (winter, UTC+1)', () => {
    assert.equal(negotiatedRateExpiresAtMs('2026-12-31'), Date.UTC(2026, 11, 31, 23))
  })

  it('handles the day the clocks change', () => {
    // Clocks go back at 03:00 on 2026-10-25; the next midnight is on UTC+1.
    assert.equal(negotiatedRateExpiresAtMs('2026-10-25'), Date.UTC(2026, 9, 25, 23))
    // Clocks go forward at 02:00 on 2026-03-29; midnight after the 28th is still UTC+1.
    assert.equal(negotiatedRateExpiresAtMs('2026-03-28'), Date.UTC(2026, 2, 28, 23))
  })

  it('refuses a malformed or impossible date', () => {
    for (const bad of ['', '2026-2-3', '2026-02-30', '31.12.2026', 'soon']) {
      assert.equal(negotiatedRateExpiresAtMs(bad), null, bad)
    }
  })
})
