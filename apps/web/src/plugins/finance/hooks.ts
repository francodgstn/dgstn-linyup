'use client'

// Finance plugin data hooks — react-query over the accounting subcollections
// (manager/owner-readable per rules) + httpsCallable wrappers for the
// function-gated actions. Pattern: online-courses/hooks.ts.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { callFunction } from '@/lib/callFunction'
import {
  ACCOUNTING_ACCOUNTS_SUBCOLLECTION,
  ACCOUNTING_ENTRIES_SUBCOLLECTION,
  ACCOUNTING_ENTRY_TEMPLATES_SUBCOLLECTION,
  ACCOUNTING_PERIOD_SUMMARIES_SUBCOLLECTION,
  ACCOUNTING_SETTINGS_DOC,
  ACCOUNTING_SETTINGS_SUBCOLLECTION,
  ASSET_REGISTER_SUBCOLLECTION,
  FINANCE_MONTHLY_REPORTS_SUBCOLLECTION,
  FINANCE_TRANSACTIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  computeNextRunMs,
} from '@linyup/shared'
import { Timestamp } from 'firebase/firestore'
import type {
  AccountingAccount,
  AccountingEntry,
  AccountingEntryTemplate,
  AccountingPeriodSummary,
  AccountingSettings,
  Asset,
  AssetCategory,
  AssetDisposalKind,
  ChartTemplateId,
  EntryTemplateDraft,
  FinanceMonthlyReport,
  FinanceTransaction,
} from '@linyup/shared'

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * The money JOURNAL for a window — what each payment actually booked.
 *
 * ── WHY THE PAYMENTS PAGE READS THIS AND NOT THE ACCOUNTING ENTRIES ─────────
 * Two collections here are both called "accounting" and they are not the same
 * thing. `accounting_entries` is double-entry bookkeeping the studio authors;
 * `finance_transactions` is the journal a MONEY EVENT writes, one row per
 * charge, carrying the category it booked as and the authoritative fee split.
 * A payment never produces an accounting entry, so linking a payment to one
 * would have been linking it to the wrong thing.
 *
 * It is read here rather than navigated to (Franco, 2026-08-23): a studio
 * manager wants to know what a charge booked and what actually landed, not to
 * open a ledger. So there is no journal SCREEN — the facts ride on the payment
 * row that raised the question.
 *
 * Rules already allow the read (manager/owner); nothing in the app had ever
 * used it.
 */
export interface PaymentJournal {
  /** The charge row, keyed by the rail's own payment reference. */
  charge?: FinanceTransaction
  /** Every refund booked against that charge, oldest first. */
  refunds: FinanceTransaction[]
}

export function useFinanceJournal(
  teamId: string | null,
  sinceMs: number | null,
  enabled = true
) {
  return useQuery<Map<string, PaymentJournal>>({
    queryKey: ['finance-journal', teamId, sinceMs],
    enabled: !!teamId && enabled,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, FINANCE_TRANSACTIONS_SUBCOLLECTION),
          ...(sinceMs !== null
            ? [where('occurred_at', '>=', Timestamp.fromMillis(sinceMs))]
            : []),
          orderBy('occurred_at', 'desc'),
          limit(500)
        )
      )

      // ── TWO ROW TYPES, TWO DIFFERENT KEYS ───────────────────────────────
      // A CHARGE is keyed by the rail's own payment reference (`source_ref`),
      // which `financeSourceRefForPayment` reproduces from a payment row.
      //
      // A REFUND is keyed by the REFUND id, so it cannot be found that way at
      // all — but it carries `source_doc`, the path of the payment it reverses,
      // whose last segment is that same payment reference. That is the join,
      // and it is why refunds are grouped here rather than looked up per row.
      //
      // The type filter is CLIENT-SIDE deliberately: `where('type','in',[…])`
      // beside the date range would need a composite index, and this window is
      // already bounded. Disputes and payouts fall out here.
      const byRef = new Map<string, PaymentJournal>()
      const entry = (ref: string) => {
        let e = byRef.get(ref)
        if (!e) byRef.set(ref, (e = { refunds: [] }))
        return e
      }
      for (const d of snap.docs) {
        const txn = { ...(d.data() as FinanceTransaction), id: d.id }
        if (txn.type === 'charge' && txn.source_ref) {
          entry(txn.source_ref).charge = txn
        } else if (txn.type === 'refund' && txn.source_doc) {
          const paymentRef = txn.source_doc.split('/').pop()
          if (paymentRef) entry(paymentRef).refunds.push(txn)
        }
      }
      // The query is newest-first; a breakdown reads better oldest-first.
      for (const e of byRef.values()) {
        e.refunds.sort(
          (a, b) => (a.occurred_at?.toMillis?.() ?? 0) - (b.occurred_at?.toMillis?.() ?? 0)
        )
      }
      return byRef
    },
  })
}

export function useAccountingSettings(teamId: string | null) {
  return useQuery<AccountingSettings | null>({
    queryKey: ['accounting-settings', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDoc(
        doc(
          db,
          TEAMS_COLLECTION,
          teamId!,
          ACCOUNTING_SETTINGS_SUBCOLLECTION,
          ACCOUNTING_SETTINGS_DOC
        )
      )
      return snap.exists() ? (snap.data() as AccountingSettings) : null
    },
  })
}

export function useAccounts(teamId: string | null) {
  return useQuery<AccountingAccount[]>({
    queryKey: ['accounting-accounts', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId!, ACCOUNTING_ACCOUNTS_SUBCOLLECTION)
      )
      return snap.docs
        .map((d) => d.data() as AccountingAccount)
        .sort((a, b) => a.code.localeCompare(b.code))
    },
  })
}

export function useEntries(teamId: string | null, period: string | null) {
  return useQuery<AccountingEntry[]>({
    queryKey: ['accounting-entries', teamId, period],
    enabled: !!teamId && !!period,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, ACCOUNTING_ENTRIES_SUBCOLLECTION),
          where('period', '==', period),
          orderBy('date', 'desc')
        )
      )
      return snap.docs.map((d) => ({ ...(d.data() as AccountingEntry), id: d.id }))
    },
  })
}

/** All period summaries up to (and including) `toPeriod` — the balance-sheet
 * substrate (cumulative from inception; ≤12 docs per year of history). */
export function usePeriodSummaries(teamId: string | null, toPeriod: string | null) {
  return useQuery<AccountingPeriodSummary[]>({
    queryKey: ['accounting-summaries', teamId, toPeriod],
    enabled: !!teamId && !!toPeriod,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, ACCOUNTING_PERIOD_SUMMARIES_SUBCOLLECTION),
          where('period', '<=', toPeriod!),
          orderBy('period', 'asc')
        )
      )
      return snap.docs.map((d) => d.data() as AccountingPeriodSummary)
    },
  })
}

/** Fiscal-year close entries (≤1 per closed year) — the trend charts subtract
 * their lines so a close doesn't show the whole year reversed in its month. */
export function useClosingEntries(teamId: string | null) {
  return useQuery<Array<Pick<AccountingEntry, 'period' | 'lines'>>>({
    queryKey: ['accounting-closing-entries', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, ACCOUNTING_ENTRIES_SUBCOLLECTION),
          where('source', '==', 'closing')
        )
      )
      return snap.docs.map((d) => {
        const e = d.data() as AccountingEntry
        return { period: e.period, lines: e.lines }
      })
    },
  })
}

/** The team's entry templates (owner-managed manual-entry presets). */
export function useEntryTemplates(teamId: string | null) {
  return useQuery<AccountingEntryTemplate[]>({
    queryKey: ['accounting-templates', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId!, ACCOUNTING_ENTRY_TEMPLATES_SUBCOLLECTION)
      )
      return snap.docs
        .map((d) => ({ ...(d.data() as AccountingEntryTemplate), id: d.id }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
  })
}

export function useFinanceMonthlyReport(teamId: string | null, month: string | null) {
  return useQuery<FinanceMonthlyReport | null>({
    queryKey: ['finance-monthly-report', teamId, month],
    enabled: !!teamId && !!month,
    queryFn: async () => {
      const snap = await getDoc(
        doc(db, TEAMS_COLLECTION, teamId!, FINANCE_MONTHLY_REPORTS_SUBCOLLECTION, month!)
      )
      return snap.exists() ? (snap.data() as FinanceMonthlyReport) : null
    },
  })
}

// ─── Account writes (direct client writes — rules allow owner) ──────────────

export async function saveAccount(
  teamId: string,
  account: Pick<AccountingAccount, 'code' | 'name' | 'type' | 'active'> & { system?: boolean },
  isNew: boolean
): Promise<void> {
  const ref = doc(db, TEAMS_COLLECTION, teamId, ACCOUNTING_ACCOUNTS_SUBCOLLECTION, account.code)
  await setDoc(
    ref,
    {
      code: account.code,
      name: account.name,
      type: account.type,
      active: account.active,
      ...(isNew
        ? { system: false, tax_code: null, description: null, created_at: serverTimestamp() }
        : {}),
      updated_at: serverTimestamp(),
    },
    { merge: true }
  )
}

/** Create/update an entry template (rules allow owner; `system` immutable).
 * Recurring + active templates get their next_run_at computed here — the daily
 * materializer only sweeps docs with a due timestamp. */
export async function saveEntryTemplate(
  teamId: string,
  tpl: EntryTemplateDraft & { active: boolean },
  id: string | null,
  uid: string
): Promise<string> {
  const col = collection(db, TEAMS_COLLECTION, teamId, ACCOUNTING_ENTRY_TEMPLATES_SUBCOLLECTION)
  const ref = id ? doc(col, id) : doc(col)
  const recurring = tpl.recurrence !== 'none' && tpl.active
  const nextRunAt = recurring
    ? Timestamp.fromMillis(
        computeNextRunMs(
          tpl.recurrence as 'monthly' | 'yearly',
          tpl.day_of_month ?? 1,
          tpl.month_of_year,
          Date.now()
        )
      )
    : null
  await setDoc(
    ref,
    {
      id: ref.id,
      name: tpl.name.trim(),
      debit_account_code: tpl.debit_account_code,
      credit_account_code: tpl.credit_account_code,
      amount_minor: tpl.amount_minor,
      recurrence: tpl.recurrence,
      day_of_month: tpl.recurrence === 'none' ? null : (tpl.day_of_month ?? null),
      month_of_year: tpl.recurrence === 'yearly' ? (tpl.month_of_year ?? null) : null,
      next_run_at: nextRunAt,
      active: tpl.active,
      ...(id
        ? {}
        : {
            system: false,
            last_posted_period: null,
            last_posted_at: null,
            last_error: null,
            created_at: serverTimestamp(),
            created_by: uid,
          }),
      updated_at: serverTimestamp(),
    },
    { merge: true }
  )
  return ref.id
}

export async function deleteEntryTemplate(teamId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, TEAMS_COLLECTION, teamId, ACCOUNTING_ENTRY_TEMPLATES_SUBCOLLECTION, id))
}

// ─── Callables ──────────────────────────────────────────────────────────────

export const callRebuildLedger = httpsCallable<
  { teamId: string },
  { entries_written: number; skipped_foreign_currency: number }
>(functions, 'rebuildAccountingLedger')

export const callCreateManualEntry = callFunction<
  {
    teamId: string
    dateMs: number
    description: string
    lines: Array<{
      account_code: string
      debit: number
      credit: number
      description?: string | null
    }>
  },
  { id: string; period: string }
>('createManualEntry')

export const callReverseEntry = callFunction<{ teamId: string; entryId: string }, { id: string }>(
  'reverseEntry'
)

export const callCloseFiscalYear = callFunction<
  { teamId: string; fiscalYear: number },
  { id: string; period: string }
>('closeFiscalYear')

export const callSetChartTemplate = callFunction<
  { teamId: string; template: ChartTemplateId },
  { template: ChartTemplateId }
>('setChartTemplate')

/** Invalidate everything accounting after a mutating callable. */
export function useInvalidateAccounting(teamId: string | null) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['accounting-settings', teamId] })
    void qc.invalidateQueries({ queryKey: ['accounting-accounts', teamId] })
    void qc.invalidateQueries({ queryKey: ['accounting-entries', teamId] })
    void qc.invalidateQueries({ queryKey: ['accounting-summaries', teamId] })
    void qc.invalidateQueries({ queryKey: ['accounting-templates', teamId] })
    void qc.invalidateQueries({ queryKey: ['accounting-closing-entries', teamId] })
  }
}
