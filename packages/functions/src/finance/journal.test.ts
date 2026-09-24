import assert from 'node:assert/strict'
import {
  assertFinanceInvariant,
  buildConnectChargeTxn,
  buildConnectRefundTxn,
  buildDisputeTxn,
  buildExternalPaymentTxn,
  buildGiftCardReclassTxns,
  buildPayoutTxn,
  financeTxnId,
  mapCategory,
  monthKey,
  normalizeCurrency,
} from '@linyup/shared'

// Unit tests for the finance-journal row builders (pure, shared by webhooks,
// backfill, and the accounting posting engine). Money is always integer minor
// units; the core invariant is gross + stripe_fee + platform_fee === net.
// Run with: pnpm --filter @linyup/functions test

describe('monthKey', () => {
  it('formats YYYY-MM in the finance timezone (Europe/Zurich)', () => {
    // 2026-06-14 18:32 UTC → June in Zurich.
    assert.equal(monthKey(Date.UTC(2026, 5, 14, 18, 32)), '2026-06')
  })

  it('rolls the year at the Zurich boundary, not UTC', () => {
    // Dec 31 23:30 UTC = Jan 1 00:30 CET → next year's January.
    assert.equal(monthKey(Date.UTC(2026, 11, 31, 23, 30)), '2027-01')
    // Dec 31 22:30 UTC = 23:30 CET → still December.
    assert.equal(monthKey(Date.UTC(2026, 11, 31, 22, 30)), '2026-12')
  })

  it('handles the DST switches (CET↔CEST)', () => {
    // Mar 31 22:30 UTC = Apr 1 00:30 CEST (summer offset +2).
    assert.equal(monthKey(Date.UTC(2026, 2, 31, 22, 30)), '2026-04')
    // Oct 31 23:30 UTC = Nov 1 00:30 CET (winter offset +1).
    assert.equal(monthKey(Date.UTC(2026, 9, 31, 23, 30)), '2026-11')
  })

  it('is timezone-parameterized', () => {
    assert.equal(monthKey(Date.UTC(2026, 11, 31, 23, 30), 'UTC'), '2026-12')
  })
})

describe('normalizeCurrency', () => {
  it('uppercases and defaults to CHF', () => {
    assert.equal(normalizeCurrency('chf'), 'CHF')
    assert.equal(normalizeCurrency('eur'), 'EUR')
    assert.equal(normalizeCurrency(null), 'CHF')
    assert.equal(normalizeCurrency(undefined), 'CHF')
    assert.equal(normalizeCurrency('  '), 'CHF')
  })
})

describe('mapCategory', () => {
  it('maps rail kinds to journal categories', () => {
    assert.equal(mapCategory('membership'), 'membership')
    assert.equal(mapCategory('subscription'), 'membership') // BYO spelling
    assert.equal(mapCategory('drop_in'), 'drop_in')
    assert.equal(mapCategory('course'), 'course')
    // A SCHEDULED course books to the same line as an on-demand one. It shipped
    // without this case, and because `mapCategory` is fed the payment's
    // TOP-LEVEL `kind`, every course sale landed in `other`: the studio's course
    // income was not course income, on the journal, in the CSV and on the
    // charts, and nothing anywhere was empty enough to notice.
    assert.equal(mapCategory('course_block'), 'course')
    assert.equal(mapCategory('product'), 'product')
    // Both rails spell a gift-card sale 'gift_card': MemberPayment.kind on the
    // Connect checkout, PaymentLineItem.kind on a manager-issued card.
    assert.equal(mapCategory('gift_card'), 'gift_card')
    assert.equal(mapCategory('belt_test'), 'other')
    assert.equal(mapCategory(null), 'other')
  })
})

describe('financeTxnId', () => {
  it('is deterministic and rail-scoped', () => {
    assert.equal(financeTxnId('connect', 'charge', 'pi_123'), 'connect:charge:pi_123')
    assert.equal(financeTxnId('payrexx', 'charge', '42'), 'payrexx:charge:42')
  })
})

describe('assertFinanceInvariant', () => {
  it('rejects non-integer amounts', () => {
    assert.throws(() =>
      assertFinanceInvariant({ id: 'x', gross: 10.5, stripe_fee: 0, platform_fee: 0, net: 10.5 })
    )
  })
  it('rejects a violated invariant', () => {
    assert.throws(() =>
      assertFinanceInvariant({ id: 'x', gross: 100, stripe_fee: -5, platform_fee: -5, net: 100 })
    )
  })
})

const T0 = Date.UTC(2026, 5, 14, 10, 0) // 2026-06-14 in Zurich

describe('buildConnectChargeTxn', () => {
  const base = {
    teamId: 't1',
    paymentIntentId: 'pi_1',
    amount: 5000,
    currency: 'chf',
    applicationFeeAmount: 35,
    occurredAtMs: T0,
    eventId: 'evt_1',
  }

  it('uses the balance-transaction split when available', () => {
    const txn = buildConnectChargeTxn({
      ...base,
      fees: { stripeFee: 145, applicationFee: 35, net: 4820, balanceTxnId: 'txn_1' },
      kind: 'membership',
      contactId: 'c1',
      description: 'Monthly Unlimited',
    })
    assert.equal(txn.id, 'connect:charge:pi_1')
    assert.equal(txn.gross, 5000)
    assert.equal(txn.stripe_fee, -145)
    assert.equal(txn.platform_fee, -35)
    assert.equal(txn.net, 4820)
    assert.equal(txn.fee_source, 'balance_transaction')
    assert.equal(txn.balance_txn_id, 'txn_1')
    assert.equal(txn.currency, 'CHF') // normalized from 'chf'
    assert.equal(txn.month, '2026-06')
    assert.equal(txn.category, 'membership')
  })

  it('prefers fee_details application fee over the recorded amount', () => {
    // Recorded 35 but Stripe's authoritative split says 36.
    const txn = buildConnectChargeTxn({
      ...base,
      fees: { stripeFee: 144, applicationFee: 36, net: 4820, balanceTxnId: 'txn_1' },
    })
    assert.equal(txn.platform_fee, -36)
    assert.equal(txn.net, 4820)
  })

  it('degrades to fee_source recorded when the fetch failed', () => {
    const txn = buildConnectChargeTxn({ ...base, fees: null })
    assert.equal(txn.stripe_fee, 0)
    assert.equal(txn.platform_fee, -35)
    assert.equal(txn.net, 4965)
    assert.equal(txn.fee_source, 'recorded')
    assert.equal(txn.balance_txn_id, null)
  })
})

describe('buildConnectRefundTxn', () => {
  it('produces the contra row with proportional fee reversal', () => {
    const txn = buildConnectRefundTxn({
      teamId: 't1',
      refundId: 're_1',
      paymentIntentId: 'pi_1',
      amount: 2000,
      feeReversed: 14,
      currency: 'chf',
      kind: 'membership',
      occurredAtMs: T0,
    })
    assert.equal(txn.id, 'connect:refund:re_1')
    assert.equal(txn.gross, -2000)
    assert.equal(txn.stripe_fee, 0) // Stripe keeps its processing fee on refunds
    assert.equal(txn.platform_fee, 14)
    assert.equal(txn.net, -1986)
    assert.equal(txn.category, 'membership')
  })
})

describe('buildDisputeTxn', () => {
  it('withdrawal: derives the dispute fee as the residual to balance net', () => {
    const txn = buildDisputeTxn({
      teamId: 't1',
      disputeId: 'dp_1',
      paymentIntentId: 'pi_1',
      amount: 5000,
      balanceNet: -6500, // -5000 disputed - 1500 dispute fee
      kind: 'dispute',
      currency: 'chf',
      occurredAtMs: T0,
    })
    assert.equal(txn.gross, -5000)
    assert.equal(txn.stripe_fee, -1500)
    assert.equal(txn.net, -6500)
  })

  it('won reversal: funds + fee return', () => {
    const txn = buildDisputeTxn({
      teamId: 't1',
      disputeId: 'dp_1',
      paymentIntentId: 'pi_1',
      amount: 5000,
      balanceNet: 6500,
      kind: 'dispute_reversal',
      occurredAtMs: T0,
    })
    assert.equal(txn.id, 'connect:dispute_reversal:dp_1')
    assert.equal(txn.gross, 5000)
    assert.equal(txn.stripe_fee, 1500)
    assert.equal(txn.net, 6500)
  })
})

describe('buildPayoutTxn', () => {
  it('paid: money leaves the balance for the bank', () => {
    const txn = buildPayoutTxn({
      teamId: 't1',
      payoutId: 'po_1',
      amount: 12000,
      kind: 'paid',
      currency: 'chf',
      occurredAtMs: T0,
    })
    assert.equal(txn.id, 'connect:payout:po_1')
    assert.equal(txn.gross, 0)
    assert.equal(txn.net, -12000)
    assert.equal(txn.payout_id, 'po_1')
    assert.equal(txn.payout_status, 'paid')
  })

  it('failed: funds return with a distinct deterministic id', () => {
    const txn = buildPayoutTxn({
      teamId: 't1',
      payoutId: 'po_1',
      amount: 12000,
      kind: 'failed',
      occurredAtMs: T0,
    })
    assert.equal(txn.id, 'connect:payout:po_1:failed')
    assert.equal(txn.net, 12000)
    assert.equal(txn.payout_status, 'failed')
  })
})

describe('buildExternalPaymentTxn', () => {
  it('BYO stripe: fee-blind gross row, source byo_stripe', () => {
    const txn = buildExternalPaymentTxn({
      teamId: 't1',
      gateway: 'stripe',
      gatewayRef: 'pi_byo',
      amount: 4990,
      currency: 'chf',
      lineItemKind: 'subscription',
      occurredAtMs: T0,
    })
    assert.equal(txn.id, 'byo_stripe:charge:pi_byo')
    assert.equal(txn.source, 'byo_stripe')
    assert.equal(txn.gross, 4990)
    assert.equal(txn.net, 4990)
    assert.equal(txn.fee_source, 'none')
    assert.equal(txn.category, 'membership')
    assert.equal(txn.source_doc, 'teams/t1/payment_events/stripe:pi_byo')
  })

  it('manual: category from line-item kind, uppercased currency preserved', () => {
    const txn = buildExternalPaymentTxn({
      teamId: 't1',
      gateway: 'manual',
      gatewayRef: 'abc',
      amount: 1500,
      currency: 'EUR',
      lineItemKind: 'drop_in',
      occurredAtMs: T0,
    })
    assert.equal(txn.id, 'manual:charge:abc')
    assert.equal(txn.currency, 'EUR')
    assert.equal(txn.category, 'drop_in')
  })
})

describe('buildGiftCardReclassTxns', () => {
  const base = {
    teamId: 't1',
    code: 'GC-7F3K-9QRT',
    holdKey: 'h1',
    drawdownMinor: 1700,
    currency: 'chf',
    targetCategory: 'course' as const,
    occurredAtMs: T0,
  }

  it('moves value between categories and nets to zero', () => {
    const [earn, redeem] = buildGiftCardReclassTxns(base)
    assert.equal(earn.category, 'course')
    assert.equal(earn.gross, 1700)
    assert.equal(earn.net, 1700)
    assert.equal(redeem.category, 'gift_card')
    assert.equal(redeem.gross, -1700)
    assert.equal(redeem.net, -1700)
    // The pair adds nothing to the month — it only re-attributes.
    assert.equal(earn.gross + redeem.gross, 0)
    assert.equal(earn.net + redeem.net, 0)
  })

  it('both rows satisfy the finance invariant with zero fees', () => {
    for (const txn of buildGiftCardReclassTxns(base)) {
      assert.equal(txn.stripe_fee, 0)
      assert.equal(txn.platform_fee, 0)
      assert.equal(txn.fee_source, 'none')
      assertFinanceInvariant(txn) // throws if gross + fees !== net
    }
  })

  it('ids are deterministic and hold-scoped, so a replay collides on create()', () => {
    const [earn, redeem] = buildGiftCardReclassTxns(base)
    assert.equal(earn.id, 'manual:adjustment:gift:GC-7F3K-9QRT:h1:earn')
    assert.equal(redeem.id, 'manual:adjustment:gift:GC-7F3K-9QRT:h1:redeem')
    assert.equal(earn.source_ref, 'gift:GC-7F3K-9QRT:h1')
    assert.equal(earn.source_doc, 'teams/t1/gift_cards/GC-7F3K-9QRT')
    // A second redemption of the same card is a different hold → different ids.
    const [earn2] = buildGiftCardReclassTxns({ ...base, holdKey: 'h2' })
    assert.notEqual(earn.id, earn2.id)
  })

  it('both rows carry the SAME normalized currency', () => {
    // Diverging currencies would leave the monthly report bucketing only the
    // primary-currency row, and the netting would silently break.
    const [earn, redeem] = buildGiftCardReclassTxns(base)
    assert.equal(earn.currency, 'CHF')
    assert.equal(redeem.currency, 'CHF')
  })

  it('reverse flips every sign and takes its own ids', () => {
    const [earn, redeem] = buildGiftCardReclassTxns({ ...base, reverse: true })
    assert.equal(earn.id, 'manual:adjustment:gift:GC-7F3K-9QRT:h1:earn:rev')
    assert.equal(redeem.id, 'manual:adjustment:gift:GC-7F3K-9QRT:h1:redeem:rev')
    assert.equal(earn.gross, -1700)
    assert.equal(redeem.gross, 1700)
    assert.equal(earn.gross + redeem.gross, 0)
  })

  it('refuses a zero or fractional drawdown', () => {
    assert.throws(() => buildGiftCardReclassTxns({ ...base, drawdownMinor: 0 }))
    assert.throws(() => buildGiftCardReclassTxns({ ...base, drawdownMinor: 17.5 }))
  })
})
