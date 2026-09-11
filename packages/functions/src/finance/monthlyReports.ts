/* eslint-disable no-console */
// monthlyFinanceReports — regenerates teams/{id}/finance_monthly_reports/{YYYY-MM}
// from the finance journal for the previous month AND the month before it.
//
// Runs on the 3rd at 03:00 Europe/Zurich so late-arriving events for the closed
// month (payout timing, refunds, disputes closing) are captured.
//
// UNLIKE weeklyReports (never overwrites — its doc accumulates mid-week
// increments and is the source of truth), finance reports ALWAYS overwrite:
// the journal is the source of truth and regeneration is the correctness
// mechanism. Generated for ALL teams — the finance plugin gates export/UI,
// not the data.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import {
  FINANCE_MONTHLY_REPORTS_SUBCOLLECTION,
  FINANCE_TIMEZONE,
  FINANCE_TRANSACTIONS_SUBCOLLECTION,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  PAYMENT_EVENTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  computeMonthlyFinanceReport,
  monthKey,
  type FinanceReportRow,
} from '@linyup/shared'
import { to } from '../utils/async'
import { dispatchTenantJob } from '../utils/tenantFanOut'

/** 'YYYY-MM' → the previous month's key. */
export function prevMonthKey(month: string): string {
  const [y, m] = month.split('-').map((v) => parseInt(v, 10))
  const d = new Date(Date.UTC(y, m - 1 - 1, 1)) // one month back
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Offset (ms) of `timeZone` relative to UTC at the given UTC instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs))
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return wall - utcMs
}

/** UTC instants of the month's [start, end) in the finance timezone. */
export function monthRange(month: string, timeZone: string = FINANCE_TIMEZONE): { start: Date; end: Date } {
  const [y, m] = month.split('-').map((v) => parseInt(v, 10))
  const startOf = (yy: number, mm: number): number => {
    const guess = Date.UTC(yy, mm - 1, 1)
    // Two-step correction handles the DST edge next to a month boundary.
    let utc = guess - zoneOffsetMs(guess, timeZone)
    utc = guess - zoneOffsetMs(utc, timeZone)
    return utc
  }
  const endY = m === 12 ? y + 1 : y
  const endM = m === 12 ? 1 : m + 1
  return { start: new Date(startOf(y, m)), end: new Date(startOf(endY, endM)) }
}

/**
 * Journal-vs-source drift check: count charge rows in the journal against the
 * source collections for the same period. A mismatch means a webhook write was
 * missed (run the backfill script to reconcile) — stamped on the report doc so
 * the gap is visible instead of silently absent.
 */
async function reconciliationCheck(
  teamId: string,
  month: string
): Promise<{ sources_count: number; journal_count: number; ok: boolean }> {
  const db = admin.firestore()
  const { start, end } = monthRange(month)
  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)

  const [mpSnap, peSnap, journalSnap] = await Promise.all([
    teamRef
      .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
      .where('status', 'in', ['succeeded', 'refunded', 'partially_refunded'])
      .where('created_at', '>=', Timestamp.fromDate(start))
      .where('created_at', '<', Timestamp.fromDate(end))
      .count()
      .get(),
    teamRef
      .collection(PAYMENT_EVENTS_SUBCOLLECTION)
      .where('processed_at', '>=', Timestamp.fromDate(start))
      .where('processed_at', '<', Timestamp.fromDate(end))
      .count()
      .get(),
    teamRef
      .collection(FINANCE_TRANSACTIONS_SUBCOLLECTION)
      .where('month', '==', month)
      .where('type', '==', 'charge')
      .count()
      .get(),
  ])

  // Note: a payment_events row with a null/zero amount is recorded but never
  // journaled — a rare, benign source of drift the warning message calls out.
  const sources = mpSnap.data().count + peSnap.data().count
  const journal = journalSnap.data().count
  return { sources_count: sources, journal_count: journal, ok: journal === sources }
}

/** Regenerate one team-month. Exported for reuse by the export callable
 * (compute-on-demand for a missing/current month) and emulator testing. */
export async function generateMonthlyFinanceReport(teamId: string, month: string): Promise<boolean> {
  const db = admin.firestore()
  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)
  const rowsSnap = await teamRef
    .collection(FINANCE_TRANSACTIONS_SUBCOLLECTION)
    .where('month', '==', month)
    .orderBy('occurred_at', 'asc')
    .get()
  if (rowsSnap.empty) return false // don't litter empty report docs

  const rows = rowsSnap.docs.map((d) => d.data() as unknown as FinanceReportRow)
  const report = computeMonthlyFinanceReport(rows, month)
  const check = await reconciliationCheck(teamId, month)
  if (!check.ok) {
    console.warn(
      `[finance] reconciliation drift team=${teamId} month=${month}: sources=${check.sources_count} journal=${check.journal_count} — run pnpm backfill:finance`
    )
  }

  await teamRef
    .collection(FINANCE_MONTHLY_REPORTS_SUBCOLLECTION)
    .doc(month)
    .set({ ...report, reconciliation_check: check, generated_at: FieldValue.serverTimestamp() })
  return true
}

/**
 * The two months one run regenerates, derived from the day it ran for.
 *
 * FROM THE RUN SLOT AND NOT FROM `Date.now()`, because a Cloud Task can execute
 * minutes or (on a retry with backoff) hours after the schedule fired, and a
 * worker that recomputed from its own clock could land on a different pair
 * across a month boundary. The run id IS the date the schedule fired for, so
 * every task of one run — and every retry of one task — regenerates the same
 * two months.
 */
export function reportMonthsForRun(runId: string | undefined): string[] {
  const ms = runId ? Date.parse(`${runId}T12:00:00Z`) : NaN
  const prev = prevMonthKey(monthKey(Number.isNaN(ms) ? Date.now() : ms))
  return [prevMonthKey(prev), prev] // late events can land in either
}

/** ONE tenant's two months. The worker body and the dispatcher's inline path. */
export async function monthlyFinanceReportsForTeam(
  teamId: string,
  runId?: string
): Promise<number> {
  let written = 0
  for (const month of reportMonthsForRun(runId)) {
    try {
      if (await generateMonthlyFinanceReport(teamId, month)) written += 1
    } catch (err) {
      console.error(`[finance] monthly report failed team=${teamId} month=${month}:`, err)
    }
  }
  return written
}

/**
 * THE DISPATCHER — one task per tenant.
 *
 * ── IT USED TO SKIP ALMOST EVERY STUDIO ─────────────────────────────────────
 *
 * This listed tenants with `teams where archived_at == null`. A Firestore
 * `== null` filter matches an EXPLICIT null and NOT a missing field, and on
 * `teams` that field is missing — nothing writes it on create, and `Team` does
 * not declare it. So the clause matched almost nothing and this job wrote
 * almost no monthly finance reports, for as long as it has existed, while
 * logging a clean `0 team-months written`. Found while converting the four
 * scheduled fan-outs (docs/scalability-2026-09.md §9); `listFanOutTeamIds`
 * projects the field and filters in memory, where an absent marker correctly
 * reads as "not archived".
 *
 * The identical clause against `contacts` IS correct and is not this bug —
 * contact writers always set the field, which is what
 * `apps/web/src/lib/liveContacts.ts` exists to guarantee.
 *
 * Regeneration is the correctness mechanism here (the journal is the source of
 * truth and a report is always overwritten), so a redelivered task is a no-op
 * by construction — this job needed no idempotence work of its own.
 */
export const monthlyFinanceReports = onSchedule(
  { schedule: '0 3 3 * *', timeZone: FINANCE_TIMEZONE, timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const result = await dispatchTenantJob({
      functionName: 'financeReportForTeam',
      granularity: 'day',
      perTeam: (teamId) => monthlyFinanceReportsForTeam(teamId),
      label: 'financeReports',
    })
    console.log('[finance] monthly reports dispatched:', result)
  }
)
