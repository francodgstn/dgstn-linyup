import assert from 'node:assert/strict'
import { tallyMobileAdoption, type MobileAdoptionRow } from './mobileAdoptionMetrics'

// The member-app adoption tally — the one part of the app-store insight work
// that produces real numbers before the app is published.
//
// Run with: pnpm --filter @linyup/functions test

const NOW = Date.parse('2026-09-09T12:00:00Z')
const daysAgo = (n: number) => NOW - n * 24 * 60 * 60 * 1000

describe('tallyMobileAdoption', () => {
  it('counts every telemetry row as an install, versioned or not', () => {
    const rows: MobileAdoptionRow[] = [
      { version: '1.0.0', lastSeenMs: daysAgo(1) },
      { version: '1.0.0', lastSeenMs: daysAgo(2) },
      { version: '1.1.0', lastSeenMs: daysAgo(3) },
    ]
    const m = tallyMobileAdoption(rows, NOW)
    assert.equal(m.installs_seen, 3)
    assert.deepEqual(m.by_version, { '1.0.0': 2, '1.1.0': 1 })
  })

  it('buckets a missing version under (unknown) rather than dropping the install', () => {
    // buildMobileAppTelemetry OMITS `version` when the app cannot read it, so
    // these rows exist in the wild. Dropping them would understate installs by
    // exactly the population whose version we most want to know about — and it
    // would do so silently, which is why the query orders on `ota_is_embedded`
    // rather than on `version`.
    const m = tallyMobileAdoption(
      [{ lastSeenMs: daysAgo(1) }, { version: '', lastSeenMs: daysAgo(1) }],
      NOW,
    )
    assert.equal(m.installs_seen, 2)
    assert.deepEqual(m.by_version, { '(unknown)': 2 })
  })

  it('counts active_30d off last_seen_at, and never off the install count', () => {
    // installs_seen only ever grows — there is no uninstall signal in the
    // telemetry. active_30d is the figure that means "still using it", and the
    // two must be able to diverge.
    const m = tallyMobileAdoption(
      [
        { version: '1.0.0', lastSeenMs: daysAgo(2) },
        { version: '1.0.0', lastSeenMs: daysAgo(31) },
        { version: '1.0.0', lastSeenMs: null },
      ],
      NOW,
    )
    assert.equal(m.installs_seen, 3)
    assert.equal(m.active_30d, 1)
  })

  it('counts embedded launches only on an explicit true', () => {
    // A null means the app did not report, not that an OTA had applied.
    const m = tallyMobileAdoption(
      [
        { otaIsEmbedded: true },
        { otaIsEmbedded: false },
        { otaIsEmbedded: null },
        {},
      ],
      NOW,
    )
    assert.equal(m.embedded, 1)
    assert.equal(m.installs_seen, 4)
  })

  it('buckets OTA channels, unknown included', () => {
    const m = tallyMobileAdoption(
      [
        { otaChannel: 'production' },
        { otaChannel: 'production' },
        { otaChannel: 'staging' },
        { otaChannel: null },
      ],
      NOW,
    )
    assert.deepEqual(m.by_ota_channel, { production: 2, staging: 1, '(unknown)': 1 })
  })

  it('returns zeroes for no rows — the caller decides whether that is a gap', () => {
    // An EMPTY result is a real answer ("nobody has opened the app yet") and is
    // different from a FAILED read, which returns null from the capture wrapper
    // so the block is omitted from the snapshot entirely.
    const m = tallyMobileAdoption([], NOW)
    assert.equal(m.installs_seen, 0)
    assert.deepEqual(m.by_version, {})
  })
})
