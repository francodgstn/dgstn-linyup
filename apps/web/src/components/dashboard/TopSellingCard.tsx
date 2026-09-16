'use client'

/**
 * TOP SELLING — what the studio actually sells, ranked.
 *
 * The counterpart to `TopActivitiesCard`, and deliberately the same shape: a
 * ranked list with a bar per row and one selector. That card answers "which
 * class fills up"; this one answers "which THING earns", across every rail the
 * studio sells on — plans, products, courses, drop-ins, appointments, gift
 * cards.
 *
 * It replaced a five-row "recent payments" list on the same shelf. A list of
 * the last five charges is a smaller, worse version of the /payments page it
 * links to; ranked totals are the thing a dashboard can say that a table
 * cannot.
 *
 * ── WHAT COUNTS AS ONE ITEM ─────────────────────────────────────────────────
 * The structured `PaymentLineItem` link when there is one — a subscription type,
 * a course, a product (+ its variant) — so a plan whose display label changed
 * mid-period still ranks as one row. Everything else falls back to the label
 * the payments list already shows (`paymentLabel`), which is what a manual row
 * or a legacy charge has instead.
 *
 * ── WHAT COUNTS AS A SALE ───────────────────────────────────────────────────
 * Settled money only, and never a voided row — the same rule the revenue figure
 * uses. A failed or still-pending charge listed here would read as income the
 * studio never got. A refund is not subtracted: `partially_refunded` counts at
 * its charged amount, exactly as the revenue total does, and making this one
 * card net would make it disagree with every other money surface.
 */

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ShoppingBag } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useMemberPayments, usePaymentEvents } from '@/hooks/useConnect'
import { Skeleton } from '@/components/ui/skeleton'
import {
  byoToUnified,
  connectToUnified,
  formatMoneyMinor,
  mergePaymentRows,
  paymentLabel,
  type UnifiedPaymentRow,
} from '@/lib/payments'
import type { PaymentLineItemKind } from '@linyup/shared'

/** How many rows the ranking shows. Beyond this the tail is noise. */
const TOP_N = 6

/**
 * How far back each rail is read, and how many rows.
 *
 * The window matches the shelf's fixed 13 weeks (see ExtraSection). The caps
 * are the honest part: they are a CAP, not a total, so when a rail comes back
 * full the card says so under the list rather than presenting a partial ranking
 * as the whole period's.
 */
const CONNECT_LIMIT = 250
const BYO_LIMIT = 250

function windowStartMs(weeks: number): number {
  return Date.now() - weeks * 7 * 24 * 60 * 60 * 1000
}

/** Money that actually arrived — the same predicate the revenue figure uses. */
function isSettled(row: UnifiedPaymentRow): boolean {
  return row.status === 'succeeded' || row.status === 'partially_refunded' || row.status === 'paid'
}

interface SellingRow {
  key: string
  name: string
  kind: PaymentLineItemKind
  amount: number
  units: number
  currency: string
}

/** One stable identity per sellable thing. The structured link wins so a
 *  renamed plan does not split into two rows; the label is the fallback every
 *  unlinked row has. */
function itemKey(row: UnifiedPaymentRow, name: string): string {
  const li = row.lineItem
  if (li?.subscriptionTypeId) return `subscription:${li.subscriptionTypeId}:${li.priceId ?? ''}`
  if (li?.courseId) return `course:${li.courseId}`
  if (li?.productId) return `product:${li.productId}:${li.variantId ?? ''}`
  return `label:${(li?.kind ?? 'other')}:${name.toLowerCase()}`
}

function rank(rows: UnifiedPaymentRow[], by: 'amount' | 'units'): SellingRow[] {
  const acc = new Map<string, SellingRow>()
  for (const row of rows) {
    if (row.voided || !isSettled(row)) continue
    const name = paymentLabel(row)
    const key = itemKey(row, name)
    const existing = acc.get(key)
    if (existing) {
      existing.amount += row.amount
      existing.units += 1
    } else {
      acc.set(key, {
        key,
        name,
        kind: row.lineItem?.kind ?? 'other',
        amount: row.amount,
        units: 1,
        currency: row.currency,
      })
    }
  }
  return [...acc.values()].sort((a, b) => b[by] - a[by] || b.amount - a.amount)
}

export function TopSellingCard({
  teamId,
  trendsWeeks,
}: {
  teamId: string | null
  /** The shelf's window, so this card covers the same period as its neighbours. */
  trendsWeeks: number
}) {
  const t = useTranslations('TopSelling')
  const [mode, setMode] = useState<'amount' | 'units'>('amount')

  const since = useMemo(() => windowStartMs(trendsWeeks), [trendsWeeks])
  const { data: memberPayments = [], isLoading: loadingConnect } = useMemberPayments(
    teamId,
    CONNECT_LIMIT,
    since
  )
  const { data: paymentEvents = [], isLoading: loadingByo } = usePaymentEvents(
    teamId,
    BYO_LIMIT,
    since
  )
  const isLoading = loadingConnect || loadingByo

  const rows = useMemo(
    () => mergePaymentRows(connectToUnified(memberPayments), byoToUnified(paymentEvents)),
    [memberPayments, paymentEvents]
  )
  const ranked = useMemo(() => rank(rows, mode), [rows, mode])
  const shown = ranked.slice(0, TOP_N)
  const max = shown[0]?.[mode] || 1
  // A cap was hit, so the ranking is of the most recent payments in the window
  // rather than of all of them. Said out loud — a truncated ranking that looks
  // complete is worse than one that admits what it read.
  const capped = memberPayments.length >= CONNECT_LIMIT || paymentEvents.length >= BYO_LIMIT

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="flex-1">{t('title')}</CardTitle>
          <Select value={mode} onValueChange={(v) => v && setMode(v as 'amount' | 'units')}>
            <SelectTrigger size="sm" className="w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="amount" label={t('modeRevenue')}>
                {t('modeRevenueHint')}
              </SelectItem>
              <SelectItem value="units" label={t('modeUnits')}>
                {t('modeUnitsHint')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">{t('period', { weeks: trendsWeeks })}</p>
      </CardHeader>
      <CardContent className="flex-1 py-2 pb-4">
        {isLoading ? (
          <div className="space-y-3 pt-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2">
            <ShoppingBag className="h-9 w-9 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-2">
            {shown.map((item, idx) => {
              const isTop = idx === 0
              const value = item[mode]
              return (
                <div key={item.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`min-w-[18px] flex-shrink-0 text-xs font-bold ${isTop ? 'text-yellow-500' : 'text-muted-foreground'}`}
                      >
                        #{idx + 1}
                      </span>
                      <span
                        className={`truncate text-sm ${isTop ? 'font-bold' : 'font-medium'}`}
                        title={item.name}
                      >
                        {item.name}
                      </span>
                      {/* The KIND, not a category the studio chose: it is what
                          tells a plan from a product when two of them share a
                          name, which happens more often than it sounds. */}
                      <Badge variant="outline" className="shrink-0 text-[0.625rem] font-normal">
                        {t(`kind.${item.kind}` as Parameters<typeof t>[0])}
                      </Badge>
                    </div>
                    <span
                      className={`flex-shrink-0 text-sm font-bold tabular-nums ${isTop ? 'text-yellow-500' : ''}`}
                    >
                      {mode === 'amount' ? (
                        formatMoneyMinor(item.amount, item.currency)
                      ) : (
                        <>
                          {item.units}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            {t('unitsSuffix', { count: item.units })}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${(value / max) * 100}%`,
                        background: isTop ? '#EAB308' : '#6366F1',
                        opacity: Math.max(0.3, 1 - idx * 0.12),
                      }}
                    />
                  </div>
                </div>
              )
            })}
            {capped && (
              <p className="pt-0.5 text-[0.6875rem] text-muted-foreground/70">
                {t('cappedNote', { count: CONNECT_LIMIT })}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
