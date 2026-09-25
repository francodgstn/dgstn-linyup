// THE PLATFORM FEE — its waiver, and the census of every site that computes one.
//
// ── WHY A CENSUS TEST ────────────────────────────────────────────────────────
// `computePlatformFee.test.ts` beside this file pins the four take-RATES and the
// unknown-tier fallback. It cannot see the thing that actually goes wrong here:
// a waiver wired into two of the three fee sites is a comped tenant charged on
// the third, and every unit test still passes. The failure is silent, it is
// money, and it is discovered by a customer.
//
// So this file reads the SOURCE and pins the call sites, the same technique as
// `connect/commitSites.test.ts` and for the same reason — it spans the
// functions/shared boundary, which is where corrections stop traveling.
//
// It is deliberately a COUNT plus the NAMES. CLAUDE.md forbids a comment that
// asserts a count of code sites, because a comment rots silently; a test is the
// one place a bare number is allowed, because there it is executable.

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import { join } from 'path'
import { chargeHasApplicationFee, computePlatformFee, takeRatePercent } from '@linyup/shared'

const SRC = join(__dirname, '..')

function read(...parts: string[]): string {
  // Normalized: a Windows checkout is CRLF, and the needles below span lines.
  return readFileSync(join(SRC, ...parts), 'utf8').replace(/\r\n/g, '\n')
}

/** Strip line and block comments so prose mentioning a call is not counted. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('the platform fee is waived for a comped tenant', () => {
  it('an unknown tier still costs the HIGHEST rate, never zero', () => {
    // The guard that makes the explicit `waived` flag necessary in the first
    // place: a zero reachable by omitting something would be a free transaction
    // shipped by a typo.
    const bogus = computePlatformFee({ tier: 'nonsense' as never, amount: 10_000 })
    assert.equal(bogus, 250, 'an unknown tier must fall back to the free (highest) rate')
  })

  it('absent and false both mean CHARGE', () => {
    const base = computePlatformFee({ tier: 'studio', amount: 10_000 })
    assert.equal(base, 80)
    assert.equal(computePlatformFee({ tier: 'studio', amount: 10_000, waived: false }), base)
    assert.equal(computePlatformFee({ tier: 'studio', amount: 10_000, waived: undefined }), base)
  })

  it('only an explicit true waives it, on both rails', () => {
    assert.equal(computePlatformFee({ tier: 'studio', amount: 10_000, waived: true }), 0)
    assert.equal(computePlatformFee({ tier: 'organization', amount: 10_000, waived: true }), 0)
    assert.equal(takeRatePercent('studio'), 0.8)
    assert.equal(takeRatePercent('studio', true), 0)
  })

  it('a waiver beats the unknown-tier fallback', () => {
    // A comped tenant whose plan field is missing or junk must still pay nothing
    // — the fallback exists to protect revenue, not to override a decision.
    assert.equal(computePlatformFee({ tier: undefined as never, amount: 10_000, waived: true }), 0)
  })

  it('a zero fee is not an application fee, which is what the refund path turns on', () => {
    assert.equal(chargeHasApplicationFee(0), false)
    assert.equal(chargeHasApplicationFee(null), false)
    assert.equal(chargeHasApplicationFee(undefined), false)
    assert.equal(chargeHasApplicationFee(1), true)
  })
})

describe('THE CENSUS — every site that computes a platform fee', () => {
  // Each entry: the file, and the expression that must carry the waiver.
  const SITES = [
    {
      file: ['connect', 'checkout.ts'],
      what: 'startOneOffCheckout — the choke point for every one-off rail',
      needle: 'waived: team.feeWaived,\n    rate: team.fee.rate,',
    },
    {
      file: ['connect', 'checkout.ts'],
      what: 'startSubscriptionCheckout — recurring, via application_fee_percent',
      needle: 'takeRatePercent(team.plan, team.feeWaived, team.fee.rate)',
    },
    {
      file: ['appointments', 'staffBooking.ts'],
      what: 'createStaffAppointment — the one caller that bypasses both choke points',
      needle: 'waived: enabledTeam.feeWaived,\n      rate: enabledTeam.fee.rate,',
    },
  ]

  for (const site of SITES) {
    it(`${site.file.join('/')} — ${site.what} — passes the waiver`, () => {
      assert.ok(
        code(read(...site.file)).includes(site.needle),
        `this fee site no longer passes the waiver AND the resolved rate; a comped tenant ` +
          `would be charged here, or a negotiated one charged the published rate`
      )
    })
  }

  it('there are exactly four fee computations — a fifth must join the census above', () => {
    // feeRateSync.ts brings live subscriptions onto the resolved rate; it passes
    // the same three arguments, and is counted here so it cannot quietly stop.
    const files = [
      'connect/checkout.ts',
      'appointments/staffBooking.ts',
      'connect/payments.ts',
      'connect/feeRateSync.ts',
    ]
    let found = 0
    const seen: string[] = []
    for (const f of files) {
      const src = code(read(...f.split('/')))
      for (const m of src.matchAll(/computePlatformFee\(|takeRatePercent\(/g)) {
        found += 1
        seen.push(`${f}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
    assert.equal(
      found,
      4,
      `expected 4 fee computations, found ${found} at ${seen.join(', ')}. ` +
        `A NEW ONE MUST PASS \`waived\` — add it to SITES above rather than deleting this assertion.`
    )
  })

  it('the waiver is resolved in exactly one place', () => {
    // If a second resolver appears, the two will disagree — and the one that is
    // wrong will be wrong in the direction of charging a comped customer.
    const access = code(read('connect', 'access.ts'))
    assert.ok(access.includes('async function resolvePlatformFee'), 'the resolver moved')
    assert.ok(
      access.includes('const fee = await resolvePlatformFee(data, plan)') &&
        access.includes("feeWaived: fee.source === 'comped'"),
      'loadEnabledTeam no longer resolves the waiver and the rate together'
    )
    assert.ok(
      access.includes("data.org_id as string | undefined"),
      'the resolver no longer reads through to the organization — a member studio of a ' +
        'comped org would be charged'
    )
  })

  it('the refund path does not send refund_application_fee unconditionally', () => {
    // Stripe REFUSES the flag on a charge with no application fee. Verified
    // against a live test-mode connected account, 2026-08-28.
    const client = code(read('utils', 'connect', 'client.ts'))
    assert.ok(
      !/\n\s*refund_application_fee: true,/.test(client),
      'refund_application_fee is unconditional again — every refund at a comped ' +
        'studio, and any refund of a charge under CHF 1.43, would be refused'
    )
    assert.ok(
      client.includes('...(hasFee ? { refund_application_fee: true } : {})'),
      'the conditional spread that replaced it is gone'
    )
  })
})
