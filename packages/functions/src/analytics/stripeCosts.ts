/* eslint-disable no-console */
// STRIPE COST — split by WHOSE COST IT IS, which on this platform is not a
// presentation choice but a fact about the charge model.
//
// Linyup runs Connect as DIRECT CHARGES on the connected account with
// `fees_collector: 'stripe'`, so Stripe bills the STUDIO for processing (see
// the header of utils/connect/client.ts). On the member→studio rail Linyup pays
// Stripe nothing. The two figures therefore come from two completely different
// places, and neither is derivable from the other:
//
//   platform — fees on the PLATFORM account's own balance transactions, from
//              the Stripe API. In practice SaaS billing. This is the COGS line.
//   studios  — `by_source.connect.stripe_fees` summed across every tenant's
//              finance_monthly_report, from OUR OWN data. No Stripe call, no
//              per-tenant fan-out: one collection-group query.
//
// Summing the studio side from our own journal rather than from Stripe is the
// whole reason this is cheap. The alternative — listing balance transactions on
// every connected account — is a per-tenant fan-out to a rate-limited external
// API, which is the shape docs/scalability-2026-09.md §9 spent a week removing
// from the scheduled jobs. It would also be no more accurate: the journal rows
// are built FROM those same balance transactions (finance/journal.ts →
// retrieveChargeFees).
//
// ── WHY LAST COMPLETED MONTH ────────────────────────────────────────────────
// `finance_monthly_reports` are written after a month closes and have already
// excluded `status: 'corrected'` rows. Re-deriving month-to-date from the raw
// journal would have to exclude those in the query, and a Firestore
// `where('status', '!=', 'corrected')` MATCHES NOTHING when the field is
// absent — which it is on almost every row. That is the same trap as
// `archived_at == null` (CLAUDE.md), and here it would silently report a tiny
// fraction of the real fees. Taking the closed month from the reports sidesteps
// it entirely and is correct by construction.
import * as admin from 'firebase-admin'
import {
  FINANCE_MONTHLY_REPORTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type FinanceMonthlyReport,
  type StripeCostSnapshot,
  type StripePlatformCost,
  type StripeStudioCost,
} from '@linyup/shared'
import { getConnectStripe } from '../utils/connect/client'
import { to } from '../utils/async'

/** Pages of 100 balance transactions. A bound, not a guess: the platform
 *  account carries SaaS billing only, so this is generous — and hitting it sets
 *  `truncated` rather than reporting a smaller number as if it were the total. */
const MAX_BALANCE_TXN_PAGES = 20
const BALANCE_TXN_PAGE_SIZE = 100

/** 'YYYY-MM' of the month before the one `now` falls in, in Europe/Zurich. */
export function lastCompletedMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value)
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }
  return `${prev.y}-${String(prev.m).padStart(2, '0')}`
}

/** UTC epoch-second bounds of a 'YYYY-MM'. Stripe filters on `created`. */
export function monthRangeSeconds(month: string): { gte: number; lt: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  const start = Date.UTC(y, mo - 1, 1) / 1000
  const end = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) / 1000
  return { gte: start, lt: end }
}

/**
 * PURE — reduce balance-transaction rows to the platform's fee total.
 *
 * `fee` is already POSITIVE minor units on a Stripe balance transaction (the
 * amount Stripe took), unlike the finance journal's signed convention, so this
 * sums as-is. Rows are counted whatever their `type`: a fee is a fee whether it
 * arrived on a charge, a refund or a payout.
 *
 * Returns null when there is no usable currency, rather than defaulting one —
 * an amount with no unit is not a cost (the same rule the budget reducer
 * follows).
 */
export function reducePlatformFees(
  rows: { fee?: unknown; currency?: unknown }[],
  truncated: boolean,
): StripePlatformCost | null {
  let fees = 0
  let currency: string | null = null
  for (const r of rows) {
    if (typeof r.fee === 'number' && Number.isFinite(r.fee)) fees += r.fee
    if (!currency && typeof r.currency === 'string' && r.currency) currency = r.currency
  }
  if (currency === null) return null
  return { fees_minor: fees, currency: currency.toUpperCase(), truncated }
}

/** Linyup's OWN Stripe bill for the month — platform-account fees. */
export async function capturePlatformStripeFees(
  month: string,
): Promise<StripePlatformCost | null> {
  const range = monthRangeSeconds(month)
  if (!range) return null

  const [clientErr, stripe] = await to(getConnectStripe())
  if (clientErr || !stripe) {
    console.warn('[stripe-cost] no platform client (key not configured?)', clientErr?.message)
    return null
  }

  const rows: { fee?: unknown; currency?: unknown }[] = []
  let startingAfter: string | undefined
  let truncated = false

  for (let page = 0; page < MAX_BALANCE_TXN_PAGES; page++) {
    // NO `stripeAccount` option — that is the whole point. An unheadered call
    // is the PLATFORM account; adding the header would return a studio's
    // transactions and quietly turn this into the other half of the split.
    const [err, res] = await to(
      stripe.balanceTransactions.list({
        created: { gte: range.gte, lt: range.lt },
        limit: BALANCE_TXN_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }),
    )
    if (err || !res) {
      console.error('[stripe-cost] balance transaction list failed', err?.message)
      // A partial read is not a total. Returning what we have would understate
      // the bill with no sign that it did.
      return null
    }
    const data = (res.data ?? []) as { id: string; fee?: unknown; currency?: unknown }[]
    rows.push(...data)
    if (!res.has_more || data.length === 0) break
    startingAfter = data[data.length - 1]?.id
    if (page === MAX_BALANCE_TXN_PAGES - 1 && res.has_more) truncated = true
  }

  if (truncated) {
    console.warn(`[stripe-cost] platform fees for ${month} hit the page cap — reporting a floor`)
  }
  return reducePlatformFees(rows, truncated)
}

/**
 * PURE — sum the studio side from month reports.
 *
 * `by_source.connect.stripe_fees` is NEGATIVE when a cost (the journal's locked
 * sign convention, from the studio's point of view), so it is negated here into
 * a positive "amount paid". BYO Stripe and Payrexx are fee-blind and contribute
 * zero by construction rather than by an estimate.
 */
export function reduceStudioFees(
  reports: Pick<FinanceMonthlyReport, 'by_source' | 'currencies'>[],
  teamsTotal: number,
): StripeStudioCost | null {
  if (reports.length === 0) return null
  let fees = 0
  let currency: string | null = null
  for (const r of reports) {
    const connect = r.by_source?.connect
    if (connect && typeof connect.stripe_fees === 'number') fees += connect.stripe_fees
    if (!currency && Array.isArray(r.currencies) && r.currencies[0]) currency = r.currencies[0]
  }
  return {
    // Negated: the journal signs a cost negative; a cost page shows what was paid.
    fees_minor: -fees,
    currency: (currency ?? 'CHF').toUpperCase(),
    teams_counted: reports.length,
    teams_missing_report: Math.max(0, teamsTotal - reports.length),
  }
}

/** What studios paid Stripe in `month`, from our own monthly reports. */
export async function captureStudioStripeFees(
  month: string,
  teamsTotal: number,
  db = admin.firestore(),
): Promise<StripeStudioCost | null> {
  // ONE collection-group query — one document per tenant that has a report for
  // the month, never a per-tenant loop.
  const [err, snap] = await to(
    db
      .collectionGroup(FINANCE_MONTHLY_REPORTS_SUBCOLLECTION)
      .where('month', '==', month)
      .get(),
  )
  if (err || !snap) {
    console.error('[stripe-cost] month report query failed', err?.message)
    return null
  }
  return reduceStudioFees(
    snap.docs.map((d) => d.data() as FinanceMonthlyReport),
    teamsTotal,
  )
}

/**
 * Both halves. Returns null only when NEITHER could be measured — one side
 * answering is worth recording, and the type carries a null per side so the UI
 * can say which is missing.
 */
export async function captureStripeCosts(
  nowMs = Date.now(),
  db = admin.firestore(),
): Promise<StripeCostSnapshot | null> {
  const month = lastCompletedMonth(new Date(nowMs))

  const [teamsErr, teamsSnap] = await to(db.collection(TEAMS_COLLECTION).select().get())
  const teamsTotal = teamsErr || !teamsSnap ? 0 : teamsSnap.size

  const [platform, studios] = await Promise.all([
    capturePlatformStripeFees(month),
    captureStudioStripeFees(month, teamsTotal, db),
  ])

  if (!platform && !studios) return null
  return { month, platform, studios, fetched_at_ms: nowMs }
}
