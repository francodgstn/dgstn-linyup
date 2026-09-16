'use client'

// THE STATEMENT — the second view of the Payments segment, and the Overview
// segment until 2026-09-13. One dated stream answering the question that used to
// require switching tabs and searching by hand:
//
//     "in period X, what did this contact pay for, and what plan or allowance
//      did they hold?"
//
// It is READ-ONLY on purpose. Every action — assign a plan, grant credits, record
// or refund a payment — stays on the Current segment and the payments list.
// Duplicating the
// dialogs here would re-create, at a new address, the very defect this tab was
// merged to remove.
//
// WHAT IT WILL NOT CLAIM. A payment can be tied to a plan TYPE and never to a
// subscription instance, and on a real slice of rows it carries no plan at all
// (legacy rows, a renewal that outran its subscription webhook, a BYO gateway
// default). So this view puts dated facts side by side and lets the reader do the
// joining; it never asserts that a payment belongs to a plan period, and a row
// with no plan says so plainly instead of being filed under a guess. The join it
// DOES make is exact: a credit grant's doc id is the id of the payment that
// bought it.

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import type { Contact, CreditGrant, SubscriptionHistoryEntry } from '@linyup/shared'
import {
  buildContactLedger,
  type LedgerCreditGrantInput,
  type LedgerPaymentInput,
  type LedgerPlanSpanInput,
  type LedgerRow,
} from '@linyup/shared'
import { useSubscriptionHistory } from '@/hooks/useSubscriptionHistory'
import { useContactCreditGrants } from '@/hooks/useContactCreditGrants'
import { useContactPayments } from '@/hooks/useConnect'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { useTabParam } from '@/hooks/useTabParam'
import {
  byoToUnified,
  connectToUnified,
  formatMoneyMinor,
  mergePaymentRows,
  paymentLabel,
} from '@/lib/payments'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryErrorState } from '@/components/ui/query-error'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { BookOpen, CircleSlash, Coins, CreditCard, XCircle } from 'lucide-react'

// 12 MONTHS BY DEFAULT, and no 30-day option. The question this segment answers
// is money-shaped, and money questions are annual: a monthly biller inside a
// 30-day window shows one payment and no plan context at all, which is the
// emptiest possible answer to "what happened".
const PERIODS = [
  { key: '3m', months: 3 },
  { key: '6m', months: 6 },
  { key: '12m', months: 12 },
  { key: 'all', months: null },
] as const
type PeriodKey = (typeof PERIODS)[number]['key']
const PERIOD_KEYS = PERIODS.map((p) => p.key) as unknown as readonly PeriodKey[]

function toMs(ts: unknown): number | null {
  const v = ts as { toMillis?: () => number; toDate?: () => Date; seconds?: number } | null
  if (!v) return null
  if (typeof v.toMillis === 'function') return v.toMillis()
  if (typeof v.toDate === 'function') return v.toDate().getTime()
  if (typeof v.seconds === 'number') return v.seconds * 1000
  return null
}

function fmtDate(ms: number, locale?: string) {
  return new Date(ms).toLocaleDateString(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function LedgerSegment({
  contact,
  teamId,
}: {
  contact: Contact & { id: string }
  teamId: string | null
}) {
  const t = useTranslations('Contacts')
  // `?period=` rather than component state, for the same reason the segment is in
  // the URL: a coach who shares "look at this contact's last 3 months" should be
  // sharing the window too.
  const [period, setPeriod] = useTabParam(PERIOD_KEYS, '12m', 'period')

  const { data: history = [], isLoading: histLoading } = useSubscriptionHistory(contact.id)
  const { data: grants = [], isLoading: grantsLoading } = useContactCreditGrants(contact.id)
  const {
    data: paymentData,
    isLoading: payLoading,
    isError,
    refetch,
  } = useContactPayments(teamId, contact.id)
  const { data: subTypes = [] } = useSubscriptionTypes(teamId)

  const typeName = useMemo(() => {
    const byId = new Map(subTypes.map((s) => [s.id, s.name]))
    return (id: string | null | undefined) => (id ? (byId.get(id) ?? null) : null)
  }, [subTypes])

  const ledger = useMemo(() => {
    const months = PERIODS.find((p) => p.key === period)?.months ?? null
    const toMsNow = Date.now()
    let fromMs: number | null = null
    if (months != null) {
      const d = new Date(toMsNow)
      d.setMonth(d.getMonth() - months)
      fromMs = d.getTime()
    }

    const rows = mergePaymentRows(
      connectToUnified(paymentData?.payments ?? []),
      byoToUnified(paymentData?.events ?? [])
    )

    const payments: LedgerPaymentInput[] = rows.flatMap((r) => {
      const atMs = r.createdAt?.toDate?.()?.getTime() ?? null
      if (atMs == null) return []
      return [
        {
          paymentId: r.paymentId,
          atMs,
          amountMinor: r.amount,
          refundedMinor: r.amountRefunded,
          currency: r.currency,
          label: paymentLabel(r),
          status: r.status,
          voided: r.voided,
          planTypeId: r.planTypeId,
          // Prefer the studio's CURRENT name for the type, so a renamed plan reads
          // consistently across the stream; fall back to whatever the row stored.
          planName: typeName(r.planTypeId) ?? r.lineItem?.label ?? null,
          attribution: r.planAttribution,
          gateway: r.gateway,
        },
      ]
    })

    const planSpans: LedgerPlanSpanInput[] = (history as SubscriptionHistoryEntry[]).flatMap((h) => {
      const startMs = toMs(h.start_date)
      if (startMs == null) return []
      return [
        {
          id: h.id,
          typeId: h.subscription_type_id ?? null,
          planName:
            typeName(h.subscription_type_id) ?? h.subscription_type_name ?? t('unknownPlanName'),
          startMs,
          endMs: toMs(h.end_date),
          terminationReason: h.termination_reason ?? null,
        },
      ]
    })

    const creditGrants: LedgerCreditGrantInput[] = (grants as CreditGrant[]).flatMap((g) => {
      const createdAtMs = toMs(g.created_at)
      if (createdAtMs == null) return []
      return [
        {
          id: g.id,
          typeId: g.subscription_type_id ?? null,
          planName: typeName(g.subscription_type_id) ?? g.subscription_type_name ?? null,
          createdAtMs,
          expiresAtMs: toMs(g.expires_at),
          creditsTotal: g.credits_total ?? 0,
          creditsUsed: g.credits_used ?? 0,
          source: g.source,
          paymentRef: g.payment_ref ?? g.id ?? null,
        },
      ]
    })

    return buildContactLedger({ payments, planSpans, creditGrants, fromMs, toMs: toMsNow })
  }, [paymentData, history, grants, period, typeName, t])

  const loading = histLoading || grantsLoading || payLoading

  if (isError) return <QueryErrorState onRetry={() => refetch()} />

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm text-muted-foreground">
          {/* WHAT THEY ALREADY HELD when the window opened. Without this line a
              short window over a long membership shows payments against an
              apparently plan-less contact. */}
          {ledger.openingState.plans.length > 0 ? (
            <span>
              {t('ledgerHeldAtStart')}{' '}
              <span className="text-foreground">
                {ledger.openingState.plans.map((p) => p.planName).join(', ')}
              </span>
            </span>
          ) : (
            <span>{t('ledgerHeldAtStartNone')}</span>
          )}
        </div>
        <Segmented
          size="sm"
          options={PERIODS.map((p) => ({ value: p.key, label: t(`ledgerPeriod_${p.key}`) }))}
          value={period}
          onChange={setPeriod}
        />
      </div>

      {/* Money in the window, PER CURRENCY — a studio that has taken CHF and EUR
          has two totals, never one meaningless sum. */}
      {ledger.totals.length > 0 && (
        <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/30 px-3 py-2">
          {ledger.totals.map((tot) => (
            <div key={tot.currency}>
              <div className="text-xs text-muted-foreground">
                {t('ledgerPaidInPeriod', { count: tot.count })}
              </div>
              <div className="text-sm font-medium tabular-nums">
                {formatMoneyMinor(tot.netMinor, tot.currency)}
                {tot.refundedMinor > 0 && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    −{formatMoneyMinor(tot.refundedMinor, tot.currency)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <Skeleton className="h-24 rounded" />
      ) : ledger.rows.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t('ledgerNothingInPeriod')}</p>
          {/* Without this a dormant member reads as missing data rather than as a
              quiet period. */}
          {period !== 'all' && (
            <button
              type="button"
              onClick={() => setPeriod('all')}
              className="mt-1 text-sm text-primary hover:underline"
            >
              {t('ledgerShowAllTime')}
            </button>
          )}
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {ledger.rows.map((row, i) => (
            <LedgerRowView key={`${row.kind}:${i}`} row={row} />
          ))}
        </ul>
      )}

      {/* Only shown when it can actually mislead — a payment attributed to a plan
          for which no period is recorded. The blanket version of this note was
          equally true on every contact and therefore read by nobody. */}
      {ledger.flags.attributedTypesWithoutSpan.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('ledgerPrimaryPlanOnlyNote')}</p>
      )}
    </div>
  )
}

function LedgerRowView({ row }: { row: LedgerRow }) {
  const t = useTranslations('Contacts')

  if (row.kind === 'payment') {
    const p = row.payment
    return (
      <li className={`flex items-start gap-3 px-3 py-2.5 ${p.voided ? 'opacity-60' : ''}`}>
        <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={`text-sm ${p.voided ? 'line-through' : ''}`}>{p.label}</span>
            <PlanChip
              planName={p.planName}
              attribution={p.attribution}
              gateway={p.gateway}
            />
          </div>
          <div className="text-xs text-muted-foreground">{fmtDate(row.atMs)}</div>
          {/* The one exact money→entitlement link in the model. */}
          {row.grant && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Coins className="h-3 w-3 shrink-0" />
              <span>
                {t('creditsRemaining', {
                  count: Math.max(0, row.grant.creditsTotal - row.grant.creditsUsed),
                })}
                {row.grant.expiresAtMs != null && (
                  <> · {t('creditsExpiresOn', { date: fmtDate(row.grant.expiresAtMs) })}</>
                )}
              </span>
            </div>
          )}
        </div>
        <div className={`shrink-0 text-sm tabular-nums ${p.voided ? 'line-through' : ''}`}>
          {formatMoneyMinor(p.amountMinor, p.currency)}
        </div>
      </li>
    )
  }

  const meta: Record<
    Exclude<LedgerRow['kind'], 'payment'>,
    { Icon: typeof BookOpen; className: string }
  > = {
    plan_started: { Icon: BookOpen, className: 'text-emerald-600 dark:text-emerald-400' },
    plan_ended: { Icon: XCircle, className: 'text-muted-foreground' },
    credit_granted: { Icon: Coins, className: 'text-muted-foreground' },
    credit_expired: { Icon: CircleSlash, className: 'text-muted-foreground' },
  }
  const { Icon, className } = meta[row.kind]

  const text =
    row.kind === 'plan_started'
      ? t('ledgerPlanStarted', { plan: row.planName })
      : row.kind === 'plan_ended'
        ? t('ledgerPlanEnded', { plan: row.planName })
        : row.kind === 'credit_granted'
          ? t('ledgerCreditsGranted', { count: row.grant.creditsTotal })
          : t('ledgerCreditsExpired')

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">{text}</div>
        <div className="text-xs text-muted-foreground">{fmtDate(row.atMs)}</div>
      </div>
    </li>
  )
}

/**
 * WHICH PLAN a payment was for — and, just as importantly, when the row does not
 * say. A muted "no plan linked" chip, deliberately NOT a warning colour: legacy
 * rows and the renewal race are common and are not the studio's mistake, and an
 * alarm on a third of a contact's history is an alarm nobody reads.
 */
function PlanChip({
  planName,
  attribution,
  gateway,
}: {
  planName: string | null
  attribution: LedgerPaymentInput['attribution']
  gateway: string
}) {
  const t = useTranslations('Contacts')

  if (attribution === 'none' || !planName) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="cursor-help rounded border border-dashed px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                {t('ledgerNoPlanLinked')}
              </span>
            }
          />
          <TooltipContent className="max-w-xs">{t('ledgerNoPlanLinkedHelp')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // A BYO gateway can substitute its configured default plan for a transaction
  // that named none, and at read time that is indistinguishable from a real
  // reference — so the link is shown, with a hedge, rather than asserted flatly.
  const hedged = gateway !== 'connect'
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={`cursor-help rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground ${
                hedged ? 'underline decoration-dotted underline-offset-2' : ''
              }`}
            >
              {planName}
            </span>
          }
        />
        <TooltipContent className="max-w-xs">
          {hedged ? t('ledgerGatewayDefaultHelp') : t('ledgerPlanTypeOnlyHelp')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
