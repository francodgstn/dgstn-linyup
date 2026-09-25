// Finance journal — the normalized, immutable, per-team transaction log that all
// financial reporting (and the future double-entry accounting plugin) derives from.
//
// One row per MONEY EVENT, across every rail:
//   • Stripe Connect  (member → studio; charges, refunds, disputes, payouts)
//   • BYO Stripe      (studio's own Stripe account; charges only — fee-blind)
//   • Payrexx         (studio's own Payrexx account; charges only — fee-blind)
//   • Manual          (cash / bank transfer / TWINT recorded by hand)
//
// Stored at teams/{teamId}/finance_transactions/{txnId} (FINANCE_TRANSACTIONS_
// SUBCOLLECTION). Doc id is DETERMINISTIC (financeTxnId) so webhook retries,
// duplicate event delivery, and backfill re-runs all converge on one row —
// writers use create() and swallow ALREADY_EXISTS.
//
// Dedupe rule (which sources feed the journal):
//   • Connect      → teams/{id}/member_payments (+ payout events, no Firestore mirror)
//   • BYO/manual   → teams/{id}/payment_events
//   • courses/{id}/purchases and contacts/{id}/credit_grants are NEVER read —
//     they duplicate the member_payments PaymentIntent rows.
//
// Sign convention (LOCKED): every amount is a SIGNED INTEGER in minor units
// (Rappen/cents), from the STUDIO's point of view. `net` is what actually moved
// on the studio's gateway balance (or till). Fees are negative when a cost.
// Invariant, enforced by every builder:  gross + stripe_fee + platform_fee === net
// EXCEPTION: 'payout' rows are pure balance movements (gross and fees are 0 by
// design; net = -payout.amount) — the invariant deliberately does not apply.
//
//   charge   gross +5000, stripe_fee  -145, platform_fee  -35 → net +4820
//   refund   gross -2000, stripe_fee     0, platform_fee  +14 → net -1986
//   dispute  gross -5000, stripe_fee -1500, platform_fee    0 → net -6500
//   payout   gross     0, stripe_fee     0, platform_fee    0 → net -12000
//
// Immutability: financial fields (type/gross/fees/net/currency/occurred_at) are
// NEVER mutated after create. The only permitted post-create mutations:
//   • payout_id / contact_id — linkage metadata, not money
//   • fee upgrade — fee fields + fee_source only, and only while
//     fee_source !== 'balance_transaction' (backfill improving a degraded row)
//   • status → 'corrected'. TWO SHAPES, and mixing them invents money:
//       – the AMOUNT was wrong → 'corrected' + a compensating 'adjustment' row
//         (`corrects`) carrying the right figure, because the right figure needs
//         somewhere to live;
//       – the EVENT DID NOT HAPPEN (a manual payment a manager voided) →
//         'corrected' ALONE, no second row. There is no right amount — the redo
//         is a fresh payment, which writes its own row — so an adjustment here
//         would be a phantom entry for money that never moved.
//     Either way the status flip is the whole mechanism: computeMonthlyFinanceReport
//     drops corrected rows (below), and onFinanceTransactionWrite posts the
//     compensating double-entry reversal on the recorded → corrected edge.
//     markFinanceTxnCorrected (functions/src/finance/journal.ts) is the writer.
// Errors are fixed by new rows, never edits — this is what makes the journal
// replayable into double-entry postings.
//
// ─── Double-entry posting map (consumed by the accounting plugin) ─────────────
// Account codes are the ch_kmu template defaults; the posting engine reads codes
// exclusively from AccountingSettings.mapping, never these literals.
//
// | type              | Debit                                          | Credit                          |
// |-------------------|------------------------------------------------|---------------------------------|
// | charge (gateway)  | clearing[source] net · 6940 -stripe_fee ·      | revenue[category] gross         |
// |                   | 6941 -platform_fee                             |                                 |
// | charge (manual)   | 1000 Cash gross                                | revenue[category] gross         |
// | refund            | revenue[category] -gross                       | clearing[source] -net ·         |
// |                   |                                                | 6941 platform_fee (fee return)  |
// | dispute           | 3901 chargebacks -gross · 6940 -stripe_fee     | clearing[source] -net           |
// | dispute_reversal  | clearing[source] net                           | 3901 gross · 6940 fee return    |
// | payout            | 1020 Bank -net                                 | clearing[source] -net           |
// | adjustment        | free-form balanced pair                        |                                 |

import type { Timestamp } from './common'
import { normalizeRedemptionCode } from '../utils/codes'

// ─── Core enums ───────────────────────────────────────────────────────────────

export type FinanceTxnSource = 'connect' | 'byo_stripe' | 'payrexx' | 'manual'

export type FinanceTxnType =
  | 'charge'
  | 'refund'
  | 'dispute'
  | 'dispute_reversal'
  | 'payout'
  | 'adjustment'

/**
 * What was sold. 'gift_card' is stored value, not a service: the money event is
 * the SALE, so — cash basis — that is where the revenue is recognized, in its
 * own bucket rather than lumped in with no-show fees under 'other'.
 *
 * Why this cannot double-count: a redemption moves no money (no charge, no
 * payout, no till), so it is not a journalable event and adds no positive row.
 * The one row that exists is the sale, and it is counted once, in 'gift_card'.
 * When the value is later spent, the ONLY permitted write is a signed pair that
 * sums to zero (+d on the category consumed, −d on 'gift_card') — an attribution
 * change, never a second recognition. A bare positive row on redemption would be
 * the double count, and it is exactly what the pair exists to forbid.
 */
export type FinanceCategory =
  | 'membership'
  | 'drop_in'
  | 'course'
  | 'product'
  | 'gift_card'
  | 'other'

/**
 * Where the fee breakdown came from:
 *   balance_transaction — fetched from Stripe (authoritative gross/fee/net split)
 *   recorded            — from our own record only (platform fee known, Stripe fee 0);
 *                         the backfill can later upgrade these to balance_transaction
 *   none                — BYO/manual rails: fees unknown by design, recorded as 0
 */
export type FinanceFeeSource = 'balance_transaction' | 'recorded' | 'none'

// ─── Row shape ────────────────────────────────────────────────────────────────

/**
 * Builder output — the pure, SDK-agnostic shape. The functions layer converts
 * `occurred_at_ms` to a Firestore Timestamp and stamps `recorded_at` server-side.
 */
export interface FinanceTransactionInput {
  id: string
  teamId: string
  type: FinanceTxnType
  source: FinanceTxnSource
  /** Rail-native reference: pi_/re_/dp_/po_ id, or the payment_events gatewayRef. */
  source_ref: string
  /** Firestore path of the origin doc (member_payments/... or payment_events/...). */
  source_doc?: string | null
  occurred_at_ms: number
  /** 'YYYY-MM' in the finance timezone — precomputed query key. */
  month: string
  /** Uppercase ISO 4217 — normalized on build (Connect events carry 'chf'). */
  currency: string
  gross: number
  stripe_fee: number
  platform_fee: number
  net: number
  fee_source: FinanceFeeSource
  balance_txn_id?: string | null
  /** Payout linkage (set by the payout handler / backfill) — mutable metadata. */
  payout_id?: string | null
  contact_id?: string | null
  category: FinanceCategory
  description?: string | null
  /**
   * VAT readiness ONLY — nothing computes or reports VAT yet, but DE (§19 UStG)
   * and IT (regime forfettario) thresholds are low, so the field exists from day
   * one. Journal writers currently store null; a future VAT module derives codes
   * from `category` (also stored) for history and stamps codes going forward.
   */
  tax_code?: string | null
  /** Provenance: Stripe event id, or 'backfill'. */
  last_event_id?: string | null
  // Payout rows only.
  payout_arrival_date_ms?: number | null
  payout_status?: 'paid' | 'failed'
}

/** Stored shape (Firestore document). */
export interface FinanceTransaction
  extends Omit<FinanceTransactionInput, 'occurred_at_ms' | 'payout_arrival_date_ms'> {
  occurred_at: Timestamp
  recorded_at: Timestamp
  status: 'recorded' | 'corrected'
  /** Adjustment rows: the txn id being corrected. */
  corrects?: string | null
  payout_arrival_date?: Timestamp | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Business timezone for period bucketing. CH/DE/IT all share CET/CEST today;
 * monthKey is parameterized so expanding beyond CET never touches call sites. */
export const FINANCE_TIMEZONE = 'Europe/Zurich'

/**
 * 'YYYY-MM' period key for a date in the given timezone. Uses the en-CA locale
 * (ISO-style formatting) — same idiom as analytics/platformMetrics.
 */
export function monthKey(date: Date | number, timeZone: string = FINANCE_TIMEZONE): string {
  const d = typeof date === 'number' ? new Date(date) : date
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d)
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000'
  const month = parts.find((p) => p.type === 'month')?.value ?? '00'
  return `${year}-${month}`
}

/** Uppercase ISO 4217 — fixes the 'chf' (Connect/Stripe) vs 'CHF' (BYO/manual)
 * inconsistency at the journal boundary. */
export function normalizeCurrency(currency?: string | null): string {
  return (currency ?? 'CHF').trim().toUpperCase() || 'CHF'
}

/** Sign flip that never produces JavaScript's -0. */
function neg(v: number): number {
  return v === 0 ? 0 : -v
}

/**
 * The journal's natural key for a PAYMENT, derived the way a reader has it.
 *
 * Every writer above builds its id from a `source_ref` — the PaymentIntent id on
 * Connect, the gateway's own reference on BYO. A reader holding a payment row
 * has the same fact, but the BYO rails carry it inside the `payment_events` doc
 * id (`${gateway}:${gatewayRef}`), so getting back to it means stripping a
 * prefix.
 *
 * That derivation lives HERE rather than in the UI that needs it, for the reason
 * this file already states about its ids: the moment two places compute the same
 * key, they compute it differently. A reader that got the prefix rule wrong
 * would silently match nothing and render "not recorded" over a payment that
 * was.
 */
export function financeSourceRefForPayment(gateway: string, paymentId: string): string {
  // Connect stores the PaymentIntent id as-is.
  if (gateway === 'connect') return paymentId
  // BYO: the doc id is `${gateway}:${gatewayRef}`, and only the FIRST separator
  // is ours — a gateway reference may legitimately contain colons.
  const sep = paymentId.indexOf(':')
  return sep === -1 ? paymentId : paymentId.slice(sep + 1)
}

/** Deterministic journal doc id — the idempotency key for every writer. */
export function financeTxnId(
  source: FinanceTxnSource,
  type: FinanceTxnType,
  sourceRef: string
): string {
  return `${source}:${type}:${sourceRef}`
}

/**
 * Map a rail-native sale kind to the journal category.
 * Connect rows carry MemberPayment.kind; BYO/manual rows carry line_item.kind
 * ('subscription' is the BYO spelling of a membership sale).
 */
export function mapCategory(kind?: string | null): FinanceCategory {
  switch (kind) {
    case 'membership':
    case 'subscription':
      return 'membership'
    case 'drop_in':
      return 'drop_in'
    case 'course':
    // A SCHEDULED course books to the same line as an on-demand one. The two
    // are different products (a term of lessons, a set of videos) and the
    // distinction is kept on `PaymentLineItem.kind` for anyone who needs it,
    // but a studio's accounts have one question here and it is "what did
    // courses bring in". Mapping it to a category of its own would widen a
    // stored enum that every journal row, CSV column and chart already reads,
    // to split a line nobody asked to have split.
    case 'course_block':
      return 'course'
    case 'product':
      return 'product'
    case 'gift_card':
      // Both rails already spell it this way — MemberPayment.kind on the Connect
      // gift-card checkout, PaymentLineItem.kind on a manager-issued card — so
      // this case only stops them falling through to 'other'.
      return 'gift_card'
    default:
      return 'other'
  }
}

/** Throws unless all amounts are integers and gross + fees === net. Called by
 * every builder so a violating row can never be constructed. */
export function assertFinanceInvariant(txn: {
  id: string
  gross: number
  stripe_fee: number
  platform_fee: number
  net: number
}): void {
  for (const [field, v] of [
    ['gross', txn.gross],
    ['stripe_fee', txn.stripe_fee],
    ['platform_fee', txn.platform_fee],
    ['net', txn.net],
  ] as const) {
    if (!Number.isInteger(v)) {
      throw new Error(`finance txn ${txn.id}: ${field} must be an integer minor-unit amount, got ${v}`)
    }
  }
  if (txn.gross + txn.stripe_fee + txn.platform_fee !== txn.net) {
    throw new Error(
      `finance txn ${txn.id}: invariant violated — gross(${txn.gross}) + stripe_fee(${txn.stripe_fee}) + platform_fee(${txn.platform_fee}) !== net(${txn.net})`
    )
  }
}

// ─── Monthly report (derived rollup) ──────────────────────────────────────────
// teams/{teamId}/finance_monthly_reports/{YYYY-MM}. UNLIKE team_weekly_reports
// (never overwritten — the doc accumulates live increments), finance reports are
// pure derivations of the journal: the cron ALWAYS overwrites, and regeneration
// is the correctness mechanism.

export interface FinanceTotals {
  gross: number
  stripe_fees: number
  platform_fees: number
  net: number
  count: number
}

export interface FinanceMonthlyReport {
  month: string
  txn_count: number
  /** Currencies seen this month (uppercase). Almost always ['CHF']. */
  currencies: string[]
  /** Primary-currency totals (the most frequent currency this month). */
  totals: FinanceTotals
  by_category: Record<FinanceCategory, FinanceTotals>
  by_source: Record<FinanceTxnSource, FinanceTotals>
  refunds: { count: number; amount: number } // amount positive minor units
  disputes: { count: number; withdrawn: number; reinstated: number; fees: number }
  payouts: { count: number; total: number } // total paid to bank, positive
  /** Gateway-balance view: what the month's activity produced vs what was paid out. */
  reconciliation: { net_activity: number; paid_out: number; delta: number }
  /** Per-currency totals — present only when more than one currency was seen. */
  by_currency?: Record<string, FinanceTotals>
  /** Journal-vs-source drift check stamped by the cron (see monthlyFinanceReports). */
  reconciliation_check?: { sources_count: number; journal_count: number; ok: boolean }
  generated_at?: Timestamp
}

/** Pure builder input — the journal rows of one month (mixed types). */
export interface FinanceReportRow {
  type: FinanceTxnType
  source: FinanceTxnSource
  category: FinanceCategory
  currency: string
  gross: number
  stripe_fee: number
  platform_fee: number
  net: number
  status?: 'recorded' | 'corrected'
}

const emptyTotals = (): FinanceTotals => ({
  gross: 0,
  stripe_fees: 0,
  platform_fees: 0,
  net: 0,
  count: 0,
})

function addTotals(t: FinanceTotals, row: FinanceReportRow): void {
  t.gross += row.gross
  t.stripe_fees += row.stripe_fee
  t.platform_fees += row.platform_fee
  t.net += row.net
  t.count += 1
}

export const FINANCE_CATEGORIES: FinanceCategory[] = [
  'membership',
  'drop_in',
  'course',
  'product',
  'gift_card',
  'other',
]
export const FINANCE_SOURCES: FinanceTxnSource[] = ['connect', 'byo_stripe', 'payrexx', 'manual']

/**
 * Reduce one month's journal rows into the report doc. Pure — unit-tested with
 * synthetic rows; the cron only queries + writes. Rows with status 'corrected'
 * are excluded (their compensating adjustment rows carry the corrected values).
 */
export function computeMonthlyFinanceReport(
  rows: FinanceReportRow[],
  month: string
): FinanceMonthlyReport {
  const active = rows.filter((r) => r.status !== 'corrected')

  const byCategory = Object.fromEntries(
    FINANCE_CATEGORIES.map((c) => [c, emptyTotals()])
  ) as Record<FinanceCategory, FinanceTotals>
  const bySource = Object.fromEntries(FINANCE_SOURCES.map((s) => [s, emptyTotals()])) as Record<
    FinanceTxnSource,
    FinanceTotals
  >
  const byCurrency: Record<string, FinanceTotals> = {}
  const totals = emptyTotals()
  const refunds = { count: 0, amount: 0 }
  const disputes = { count: 0, withdrawn: 0, reinstated: 0, fees: 0 }
  const payouts = { count: 0, total: 0 }
  let netActivity = 0

  // Primary currency = the most frequent one this month.
  const currencyCounts = new Map<string, number>()
  for (const r of active) {
    const c = normalizeCurrency(r.currency)
    currencyCounts.set(c, (currencyCounts.get(c) ?? 0) + 1)
  }
  const currencies = [...currencyCounts.keys()].sort()
  const primary =
    [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'CHF'

  for (const r of active) {
    const currency = normalizeCurrency(r.currency)
    if (!byCurrency[currency]) byCurrency[currency] = emptyTotals()
    addTotals(byCurrency[currency], r)

    if (r.type === 'payout') {
      payouts.count += 1
      payouts.total += -r.net // paid: net negative → positive amount to bank; failed rows subtract
      continue // payouts are balance movements — not part of activity totals
    }

    if (currency === primary) {
      addTotals(totals, r)
      addTotals(byCategory[r.category] ?? (byCategory[r.category] = emptyTotals()), r)
      addTotals(bySource[r.source] ?? (bySource[r.source] = emptyTotals()), r)
      netActivity += r.net
    }

    if (r.type === 'refund') {
      refunds.count += 1
      refunds.amount += -r.gross
    } else if (r.type === 'dispute') {
      disputes.count += 1
      disputes.withdrawn += -r.gross
      disputes.fees += -r.stripe_fee
    } else if (r.type === 'dispute_reversal') {
      disputes.reinstated += r.gross
      disputes.fees -= r.stripe_fee // fee refunded on a won dispute
    }
  }

  const report: FinanceMonthlyReport = {
    month,
    txn_count: active.length,
    currencies,
    totals,
    by_category: byCategory,
    by_source: bySource,
    refunds,
    disputes,
    payouts,
    reconciliation: {
      net_activity: netActivity,
      paid_out: payouts.total,
      delta: netActivity - payouts.total,
    },
  }
  if (currencies.length > 1) report.by_currency = byCurrency
  return report
}

// ─── Row builders (pure — shared by webhooks, backfill, and tests) ────────────

/** Fee breakdown fetched from a charge's balance transaction (all values are
 * POSITIVE magnitudes as Stripe reports them; builders apply signs). */
export interface ConnectChargeFees {
  /** Stripe processing fee (fee_details type 'stripe_fee'). */
  stripeFee: number
  /** Application fee per fee_details (type 'application_fee'); authoritative when
   * present — cross-checks MemberPayment.application_fee_amount. */
  applicationFee: number | null
  /** bt.net — what landed on the studio's Stripe balance. */
  net: number
  balanceTxnId: string
}

export function buildConnectChargeTxn(params: {
  teamId: string
  paymentIntentId: string
  amount: number // gross Rappen (pi.amount)
  currency?: string | null
  /** Our recorded platform fee (pi.application_fee_amount). */
  applicationFeeAmount: number
  /** Balance-transaction breakdown, or null when the fetch failed/skipped. */
  fees: ConnectChargeFees | null
  kind?: string | null // MemberPayment.kind
  contactId?: string | null
  description?: string | null
  occurredAtMs: number
  eventId?: string | null
}): FinanceTransactionInput {
  const gross = params.amount
  // fee_details is authoritative when fetched; our recorded fee otherwise.
  const platformFeeAbs = params.fees?.applicationFee ?? params.applicationFeeAmount
  const stripeFeeAbs = params.fees?.stripeFee ?? 0
  const net = params.fees ? params.fees.net : gross - platformFeeAbs
  const txn: FinanceTransactionInput = {
    id: financeTxnId('connect', 'charge', params.paymentIntentId),
    teamId: params.teamId,
    type: 'charge',
    source: 'connect',
    source_ref: params.paymentIntentId,
    source_doc: `teams/${params.teamId}/member_payments/${params.paymentIntentId}`,
    occurred_at_ms: params.occurredAtMs,
    month: monthKey(params.occurredAtMs),
    currency: normalizeCurrency(params.currency),
    gross,
    stripe_fee: neg(stripeFeeAbs),
    platform_fee: neg(platformFeeAbs),
    net,
    fee_source: params.fees ? 'balance_transaction' : 'recorded',
    balance_txn_id: params.fees?.balanceTxnId ?? null,
    contact_id: params.contactId ?? null,
    category: mapCategory(params.kind),
    description: params.description ?? null,
    tax_code: null,
    last_event_id: params.eventId ?? null,
  }
  assertFinanceInvariant(txn)
  return txn
}

export function buildConnectRefundTxn(params: {
  teamId: string
  refundId: string
  paymentIntentId: string
  amount: number // Rappen refunded (positive)
  feeReversed: number // platform fee returned for this refund (positive)
  currency?: string | null
  kind?: string | null
  contactId?: string | null
  description?: string | null
  occurredAtMs: number
  eventId?: string | null
}): FinanceTransactionInput {
  // Stripe keeps its processing fee on refunds — stripe_fee stays 0.
  const txn: FinanceTransactionInput = {
    id: financeTxnId('connect', 'refund', params.refundId),
    teamId: params.teamId,
    type: 'refund',
    source: 'connect',
    source_ref: params.refundId,
    source_doc: `teams/${params.teamId}/member_payments/${params.paymentIntentId}`,
    occurred_at_ms: params.occurredAtMs,
    month: monthKey(params.occurredAtMs),
    currency: normalizeCurrency(params.currency),
    gross: neg(params.amount),
    stripe_fee: 0,
    platform_fee: params.feeReversed,
    net: neg(params.amount - params.feeReversed),
    fee_source: 'recorded',
    contact_id: params.contactId ?? null,
    category: mapCategory(params.kind),
    description: params.description ?? null,
    tax_code: null,
    last_event_id: params.eventId ?? null,
  }
  assertFinanceInvariant(txn)
  return txn
}

export function buildDisputeTxn(params: {
  teamId: string
  disputeId: string
  paymentIntentId: string
  /** Disputed amount (positive Rappen). */
  amount: number
  /**
   * Net balance movement from the dispute's balance transactions (SIGNED):
   * negative on withdrawal, positive on a won reversal. The dispute fee is
   * derived as the residual so the row always ties to Stripe's actual movement.
   */
  balanceNet: number
  kind: 'dispute' | 'dispute_reversal'
  currency?: string | null
  contactId?: string | null
  category?: FinanceCategory
  description?: string | null
  occurredAtMs: number
  eventId?: string | null
}): FinanceTransactionInput {
  const gross = params.kind === 'dispute' ? neg(params.amount) : params.amount
  // Residual = the dispute fee (withdrawal) or its refund (won reversal).
  const stripeFee = params.balanceNet - gross
  const txn: FinanceTransactionInput = {
    id: financeTxnId('connect', params.kind, params.disputeId),
    teamId: params.teamId,
    type: params.kind,
    source: 'connect',
    source_ref: params.disputeId,
    source_doc: `teams/${params.teamId}/member_payments/${params.paymentIntentId}`,
    occurred_at_ms: params.occurredAtMs,
    month: monthKey(params.occurredAtMs),
    currency: normalizeCurrency(params.currency),
    gross,
    stripe_fee: stripeFee,
    platform_fee: 0,
    net: params.balanceNet,
    fee_source: 'balance_transaction',
    contact_id: params.contactId ?? null,
    category: params.category ?? 'other',
    description: params.description ?? null,
    tax_code: null,
    last_event_id: params.eventId ?? null,
  }
  assertFinanceInvariant(txn)
  return txn
}

export function buildPayoutTxn(params: {
  teamId: string
  payoutId: string
  /** payout.amount (positive Rappen). */
  amount: number
  kind: 'paid' | 'failed'
  currency?: string | null
  occurredAtMs: number
  arrivalDateMs?: number | null
  description?: string | null
  eventId?: string | null
}): FinanceTransactionInput {
  // paid  → money leaves the Stripe balance for the bank (net negative).
  // failed → the bank returned the payout; funds are back on the balance.
  const net = params.kind === 'paid' ? neg(params.amount) : params.amount
  const ref = params.kind === 'paid' ? params.payoutId : `${params.payoutId}:failed`
  const txn: FinanceTransactionInput = {
    id: financeTxnId('connect', 'payout', ref),
    teamId: params.teamId,
    type: 'payout',
    source: 'connect',
    source_ref: params.payoutId,
    occurred_at_ms: params.occurredAtMs,
    month: monthKey(params.occurredAtMs),
    currency: normalizeCurrency(params.currency),
    gross: 0,
    stripe_fee: 0,
    platform_fee: 0,
    net,
    fee_source: 'balance_transaction',
    category: 'other',
    description:
      params.description ?? (params.kind === 'failed' ? 'Payout failed — funds returned' : 'Payout to bank'),
    tax_code: null,
    last_event_id: params.eventId ?? null,
    payout_id: params.payoutId,
    payout_arrival_date_ms: params.arrivalDateMs ?? null,
    payout_status: params.kind,
  }
  // net = 0 + 0 + 0 would violate the invariant — payouts are the one type where
  // gross is 0 by design, so the generic assertion is replaced by integer checks.
  if (!Number.isInteger(net)) throw new Error(`finance txn ${txn.id}: net must be an integer`)
  return txn
}

export function buildExternalPaymentTxn(params: {
  teamId: string
  gateway: 'payrexx' | 'stripe' | 'manual'
  gatewayRef: string
  amount: number // gross minor units (positive)
  currency?: string | null
  contactId?: string | null
  lineItemKind?: string | null
  description?: string | null
  occurredAtMs: number
  eventId?: string | null
}): FinanceTransactionInput {
  const source: FinanceTxnSource = params.gateway === 'stripe' ? 'byo_stripe' : params.gateway
  const docId = `${params.gateway}:${params.gatewayRef}`
  const txn: FinanceTransactionInput = {
    id: financeTxnId(source, 'charge', params.gatewayRef),
    teamId: params.teamId,
    type: 'charge',
    source,
    source_ref: params.gatewayRef,
    source_doc: `teams/${params.teamId}/payment_events/${docId}`,
    occurred_at_ms: params.occurredAtMs,
    month: monthKey(params.occurredAtMs),
    currency: normalizeCurrency(params.currency),
    gross: params.amount,
    // BYO gateways report no fee data; manual payments have none. Documented
    // limitation: net overstates by the gateway's fee until a manual entry books it.
    stripe_fee: 0,
    platform_fee: 0,
    net: params.amount,
    fee_source: 'none',
    contact_id: params.contactId ?? null,
    category: mapCategory(params.lineItemKind),
    description: params.description ?? null,
    tax_code: null,
    last_event_id: params.eventId ?? null,
  }
  assertFinanceInvariant(txn)
  return txn
}

/**
 * Gift-card RECLASSIFICATION — the signed pair written when stored value is
 * spent. Redeeming a card moves no money (the money moved when the card was
 * SOLD, and that sale is already the one 'gift_card' charge row), so a
 * redemption may never add a positive row: it only re-attributes value that is
 * already in the books.
 *
 *   row A  category = what was bought   gross +d  net +d
 *   row B  category = 'gift_card'       gross −d  net −d
 *
 * The pair therefore contributes exactly ZERO to totals, by_category, by_source
 * and every fee bucket — only the counts move. What it changes is WHERE the
 * lifetime revenue sits: a card sold in January and spent on a course in March
 * reads `gift_card +100` in January and `course +100 / gift_card −100` in
 * March, so lifetime shows `course 100, gift_card 0`. The running `gift_card`
 * bucket is then sold-minus-redeemed — recognized-but-unconsumed stored value,
 * which doubles as the cash-basis shadow of the liability this ledger is not
 * allowed to accrue (docs/accounting.md: entries mirror money events).
 *
 * `reverse` flips every sign and suffixes the ids, for the paths that give the
 * value back (a refunded booking, a duplicate charge). Same builder on purpose:
 * a second builder is a second place for the signs to disagree.
 *
 * MUST be written as one batch — see recordGiftCardReclass. Half a pair leaves
 * by_category permanently wrong and nothing detects it (reconciliationCheck
 * counts only 'charge' rows).
 */
export function buildGiftCardReclassTxns(params: {
  teamId: string
  /** Canonical GC-XXXX-XXXX — part of the deterministic row id. */
  code: string
  /** The hold key the drawdown was committed under — makes the id unique per
   *  redemption, so a card spent twice produces two distinct pairs. */
  holdKey: string
  /** MINOR units, positive — the value that actually moved off the card. */
  drawdownMinor: number
  /** The CARD's currency. Both rows must carry the same one, or the monthly
   *  report buckets only the primary-currency row and the netting breaks. */
  currency: string
  /** What the redeemed value bought. */
  targetCategory: FinanceCategory
  contactId?: string | null
  occurredAtMs: number
  description?: string | null
  reverse?: boolean
}): [FinanceTransactionInput, FinanceTransactionInput] {
  if (!Number.isInteger(params.drawdownMinor) || params.drawdownMinor <= 0) {
    throw new Error(
      `gift card reclass ${params.code}: drawdownMinor must be a positive integer minor-unit amount, got ${params.drawdownMinor}`
    )
  }
  // The reclass pair's sourceRef must match the paymentRef the callables build
  // for the same drawdown, character for character — one normalizer, no forks.
  const code = normalizeRedemptionCode(params.code)
  const sourceRef = `gift:${code}:${params.holdKey}`
  const suffix = params.reverse ? ':rev' : ''
  const sign = params.reverse ? -1 : 1
  const d = params.drawdownMinor * sign
  const shared = {
    teamId: params.teamId,
    type: 'adjustment' as const,
    source: 'manual' as const,
    source_ref: sourceRef,
    source_doc: `teams/${params.teamId}/gift_cards/${code}`,
    occurred_at_ms: params.occurredAtMs,
    month: monthKey(params.occurredAtMs),
    currency: normalizeCurrency(params.currency),
    stripe_fee: 0,
    platform_fee: 0,
    fee_source: 'none' as const,
    contact_id: params.contactId ?? null,
    description:
      params.description ??
      (params.reverse ? `Gift card ${code} · redemption reversed` : `Gift card ${code} redeemed`),
    tax_code: null,
  }
  const earn: FinanceTransactionInput = {
    ...shared,
    id: financeTxnId('manual', 'adjustment', `${sourceRef}:earn${suffix}`),
    gross: d,
    net: d,
    category: params.targetCategory,
  }
  const redeem: FinanceTransactionInput = {
    ...shared,
    id: financeTxnId('manual', 'adjustment', `${sourceRef}:redeem${suffix}`),
    gross: neg(d),
    net: neg(d),
    category: 'gift_card',
  }
  assertFinanceInvariant(earn)
  assertFinanceInvariant(redeem)
  return [earn, redeem]
}
