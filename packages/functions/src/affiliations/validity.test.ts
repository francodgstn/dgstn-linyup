import assert from 'node:assert/strict'
import { resolveAffiliationValidUntil } from '@linyup/shared'

// The ONE answer to "when does this affiliation run out", shared by
// `renewAffiliation` and the web renew dialog's preview. They used to compute it
// separately; a second validity mode is exactly what would have made them
// disagree, so the resolver is pinned here.
//
// Run with: pnpm --filter @linyup/functions test

// LOCAL components, not `toISOString()`. The resolver works in local calendar
// days — a reset "on 1 September" is 1 September where the federation is — and
// `toISOString` would convert local midnight to the previous day anywhere east
// of UTC, failing every assertion here for a reason that has nothing to do with
// the code under test.
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('affiliation validity — months mode', () => {
  it('defaults to twelve months from now', () => {
    const out = resolveAffiliationValidUntil({ type: null, now: new Date(2026, 2, 15) })
    assert.equal(iso(out), '2027-03-15')
  })

  it('extends from the EXISTING expiry, so renewing early costs nothing', () => {
    const out = resolveAffiliationValidUntil({
      type: { default_validity_months: 12 },
      currentValidUntil: new Date(2026, 8, 1),
      now: new Date(2026, 2, 15),
    })
    assert.equal(iso(out), '2027-09-01')
  })

  it('extends from NOW when the affiliation already lapsed', () => {
    const out = resolveAffiliationValidUntil({
      type: { default_validity_months: 12 },
      currentValidUntil: new Date(2025, 0, 1),
      now: new Date(2026, 2, 15),
    })
    assert.equal(iso(out), '2027-03-15')
  })

  it('clamps rather than rolling into the next month', () => {
    // 31 January + 1 month is the end of February, not 3 March.
    const out = resolveAffiliationValidUntil({
      type: { default_validity_months: 1 },
      now: new Date(2026, 0, 31),
    })
    assert.equal(iso(out), '2026-02-28')
  })

  it('honors an explicit term from the caller', () => {
    const out = resolveAffiliationValidUntil({
      type: { default_validity_months: 12 },
      now: new Date(2026, 0, 1),
      monthsOverride: 6,
    })
    assert.equal(iso(out), '2026-07-01')
  })
})

describe('affiliation validity — fixed_date mode', () => {
  const HMD = { validity_mode: 'fixed_date' as const, reset_month_day: '09-01' }

  it('expires at the NEXT reset, however late in the year somebody joins', () => {
    // Franco's decision (2026-09-05): one clock for the whole roster. A member
    // joining two weeks before the reset gets two weeks, not a pro-rated term
    // and not a free extra year.
    const out = resolveAffiliationValidUntil({ type: HMD, now: new Date(2026, 7, 15) })
    assert.equal(iso(out), '2026-09-01')
  })

  it('gives a joiner ON the reset day a full year, not nothing', () => {
    // Strictly-after. Otherwise an affiliation issued on the morning of the
    // reset expires that same afternoon.
    const out = resolveAffiliationValidUntil({ type: HMD, now: new Date(2026, 8, 1) })
    assert.equal(iso(out), '2027-09-01')
  })

  it('renewing a membership that runs to this reset lands on the NEXT one', () => {
    const out = resolveAffiliationValidUntil({
      type: HMD,
      currentValidUntil: new Date(2026, 8, 1),
      now: new Date(2026, 5, 1),
    })
    assert.equal(iso(out), '2027-09-01')
  })

  it('IGNORES a caller-supplied term — nobody gets their own clock', () => {
    const out = resolveAffiliationValidUntil({
      type: HMD,
      now: new Date(2026, 7, 15),
      monthsOverride: 24,
    })
    assert.equal(iso(out), '2026-09-01')
  })

  it('falls back to months when the reset day was never set', () => {
    // A reset date nobody configured is not a reset date. Defaulting to January
    // would expire the entire federation at once.
    const out = resolveAffiliationValidUntil({
      type: { validity_mode: 'fixed_date' },
      now: new Date(2026, 2, 15),
    })
    assert.equal(iso(out), '2027-03-15')
  })

  it('falls back to months when the reset day is not a date', () => {
    for (const bad of ['9-1', '2026-09-01', 'september', '13-01', '09-00']) {
      const out = resolveAffiliationValidUntil({
        type: { validity_mode: 'fixed_date', reset_month_day: bad },
        now: new Date(2026, 2, 15),
      })
      assert.equal(iso(out), '2027-03-15', `'${bad}' must not be read as a reset day`)
    }
  })
})
