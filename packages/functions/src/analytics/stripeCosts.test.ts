// Stripe cost — the split, the signs, and the rule that the two halves are
// never added together.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  lastCompletedMonth,
  monthRangeSeconds,
  reducePlatformFees,
  reduceStudioFees,
} from './stripeCosts'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

const totals = (stripeFees: number) => ({
  gross: 0,
  stripe_fees: stripeFees,
  platform_fees: 0,
  net: 0,
  count: 1,
})

// A month report with only the fields the reducer reads.
const report = (connectFees: number, currency = 'CHF') =>
  ({
    currencies: [currency],
    by_source: {
      connect: totals(connectFees),
      byo_stripe: totals(0),
      payrexx: totals(0),
      manual: totals(0),
    },
  }) as never

describe('lastCompletedMonth', () => {
  it('returns the previous month', () => {
    assert.equal(lastCompletedMonth(new Date('2026-09-12T10:00:00Z')), '2026-08')
  })

  it('rolls the year back in January', () => {
    assert.equal(lastCompletedMonth(new Date('2026-01-05T10:00:00Z')), '2025-12')
  })
})

describe('monthRangeSeconds', () => {
  it('brackets the month', () => {
    const r = monthRangeSeconds('2026-08')
    assert.equal(r?.gte, Date.UTC(2026, 7, 1) / 1000)
    assert.equal(r?.lt, Date.UTC(2026, 8, 1) / 1000)
  })

  it('rolls into the next year in December', () => {
    const r = monthRangeSeconds('2026-12')
    assert.equal(r?.lt, Date.UTC(2027, 0, 1) / 1000)
  })

  it('refuses a malformed or impossible month', () => {
    for (const bad of ['2026-13', '2026-00', 'August', '2026', '']) {
      assert.equal(monthRangeSeconds(bad), null, bad)
    }
  })
})

describe('reducePlatformFees', () => {
  it('sums Stripe fees as-is — a balance transaction fee is already positive', () => {
    const out = reducePlatformFees(
      [
        { fee: 59, currency: 'chf' },
        { fee: 120, currency: 'chf' },
      ],
      false,
    )
    assert.equal(out?.fees_minor, 179)
    assert.equal(out?.currency, 'CHF')
    assert.equal(out?.truncated, false)
  })

  it('returns null without a currency — an amount with no unit is not a cost', () => {
    assert.equal(reducePlatformFees([{ fee: 100 }], false), null)
    assert.equal(reducePlatformFees([], false), null)
  })

  it('carries the truncation flag, so a floor is never shown as a total', () => {
    assert.equal(reducePlatformFees([{ fee: 1, currency: 'chf' }], true)?.truncated, true)
  })

  it('ignores non-numeric fees rather than counting them as zero silently', () => {
    const out = reducePlatformFees(
      [{ fee: 'x', currency: 'chf' }, { fee: 40, currency: 'chf' }],
      false,
    )
    assert.equal(out?.fees_minor, 40)
  })
})

describe('reduceStudioFees — THE SIGN FLIP', () => {
  it('negates the journal sign into an amount PAID', () => {
    // The journal stores a fee negative from the studio's point of view
    // (types/finance.ts sign convention). A cost page showing "−145" reads as
    // money coming back.
    const out = reduceStudioFees([report(-145), report(-55)], 2)
    assert.equal(out?.fees_minor, 200)
    assert.equal(out?.currency, 'CHF')
  })

  it('counts tenants and reports the ones with no month report', () => {
    const out = reduceStudioFees([report(-100)], 5)
    assert.equal(out?.teams_counted, 1)
    assert.equal(out?.teams_missing_report, 4)
  })

  it('never reports a negative missing count when reports outnumber teams', () => {
    // A team deleted after its report was written would otherwise produce "-1
    // tenants had no report".
    const out = reduceStudioFees([report(-10), report(-10)], 1)
    assert.equal(out?.teams_missing_report, 0)
  })

  it('returns null with no reports at all — zero fees is a different claim', () => {
    assert.equal(reduceStudioFees([], 10), null)
  })

  it('counts only the connect source — BYO and Payrexx are fee-blind', () => {
    const r = {
      currencies: ['CHF'],
      by_source: {
        connect: totals(-100),
        byo_stripe: totals(-999),
        payrexx: totals(-999),
        manual: totals(-999),
      },
    } as never
    assert.equal(reduceStudioFees([r], 1)?.fees_minor, 100)
  })

  it('tolerates a report with no by_source rather than throwing on it', () => {
    const out = reduceStudioFees([{ currencies: ['CHF'] } as never, report(-70)], 2)
    assert.equal(out?.fees_minor, 70)
  })
})

describe('the two halves are never summed', () => {
  // The defect this guards is a one-line "improvement": a reader who sees two
  // fee figures and adds them. Linyup pays Stripe NOTHING on the member→studio
  // rail (direct charges, studio is the fee payer), so the sum overstates COGS
  // by the whole width of payment volume — and it would look plausible.
  const FILES = [
    'packages/functions/src/analytics/stripeCosts.ts',
    'apps/admin/src/lib/queries/providerCosts.ts',
    'apps/admin/src/app/(dashboard)/providers/page.tsx',
  ]

  it('no source adds a platform figure to a studio figure', () => {
    for (const rel of FILES) {
      const code = readFileSync(join(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n')
      assert.doesNotMatch(
        code,
        /platform[A-Za-z_.?]*\.?fees_minor\s*\+[^+]/,
        `${rel} adds the platform fee total to something — the two halves are different parties' money`,
      )
      assert.doesNotMatch(
        code,
        /studios[A-Za-z_.?]*\.?fees_minor\s*\+[^+]/,
        `${rel} adds the studio fee total to something`,
      )
    }
  })

  it('the shared type keeps them as two fields, so they cannot be summed by accident', () => {
    const t = readFileSync(join(REPO_ROOT, 'packages/shared/src/types/metrics.ts'), 'utf8')
    const block = t.slice(t.indexOf('export interface StripeCostSnapshot'))
    assert.match(block, /platform: StripePlatformCost \| null/)
    assert.match(block, /studios: StripeStudioCost \| null/)
  })

  it('the platform call is NOT made against a connected account', () => {
    // `stripeAccount` on that list call would return a studio's transactions and
    // silently turn the platform figure into the other half of the split.
    const src = readFileSync(
      join(REPO_ROOT, 'packages/functions/src/analytics/stripeCosts.ts'),
      'utf8',
    )
    const call = src.slice(src.indexOf('balanceTransactions.list'))
    const endOfCall = call.indexOf('\n    )')
    assert.doesNotMatch(
      call.slice(0, endOfCall > 0 ? endOfCall : 400),
      /stripeAccount/,
      'the platform balance-transaction list passes a connected account',
    )
  })
})
