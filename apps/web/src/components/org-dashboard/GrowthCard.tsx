'use client'

/**
 * THE FEDERATION OVER TIME — how many studios have belonged to it, month by
 * month, for the last twelve.
 *
 * ── WHY THIS SERIES AND NOT A REVENUE OR BOOKINGS TREND ─────────────────────
 *
 * A studio's trends read `weekly_reports` — a per-team rollup that no
 * organisation has an equivalent of. Aggregating sixteen studios' weeks in the
 * browser to draw one line is a fan-out this page deliberately refuses (see the
 * counts note in `data.ts`), and doing it properly means a Cloud Function
 * writing an org rollup. That is worth building; it is not worth blocking a
 * first dashboard on.
 *
 * So the one trend here is the one the page already holds the data for: the
 * roster carries `joined` on every row, so this costs ZERO extra reads and
 * cannot go stale relative to the figures above it. It is also the trend an
 * organisation actually reports on — a federation's annual meeting asks how many
 * clubs it has, not how many bookings they took.
 *
 * ── IT IS CUMULATIVE, AND HONEST ABOUT A MIGRATION ──────────────────────────
 *
 * A federation that arrived in one import shows a step and then a flat line,
 * which is TRUE and is the reason the subtitle reports the joins inside the
 * window rather than only the total. A flat line with "0 joined in 12 months"
 * beneath it says something; a flat line on its own reads as a broken chart,
 * which is exactly the failure `ChartEmptyState` was written for.
 *
 * `removed` studios are absent from the roster entirely, so this is the CURRENT
 * membership placed on the timeline of when it joined — not a historical
 * headcount. A studio that joined in March and left in June never appears. Say
 * it here rather than let a reader infer a churn chart from a growth one.
 */

import { useMemo } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Building2 } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartEmptyState } from '@/components/dashboard/ChartEmptyState'
import type { OrgStudioRow } from './data'

const MONTHS_SHOWN = 12

interface GrowthPoint {
  /** `YYYY-MM` — the key, never rendered. */
  month: string
  /** First day of the month, for locale-aware axis + tooltip labels. */
  date: Date
  /** Studios that had joined by the END of this month. */
  studios: number
}

/**
 * Cumulative membership per month, plus how much of it happened in the window.
 *
 * Rows with no `joined` are counted into the OPENING balance rather than
 * dropped: a studio with no join date is still a member today, and leaving it
 * out would draw a chart whose last point disagrees with the figure at the top
 * of the page.
 */
export function buildGrowthSeries(rows: OrgStudioRow[], now = new Date()) {
  const months: GrowthPoint[] = []
  for (let i = MONTHS_SHOWN - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      date: d,
      studios: 0,
    })
  }
  const windowStart = months[0].date.getTime()

  let joinedInWindow = 0
  for (const row of rows) {
    const joined = row.joined?.toDate?.().getTime()
    // No date, or older than the window: part of the opening balance, so it
    // lifts every point.
    if (joined == null || Number.isNaN(joined) || joined < windowStart) {
      months.forEach((m) => (m.studios += 1))
      continue
    }
    joinedInWindow += 1
    months.forEach((m) => {
      const monthEnd = new Date(m.date.getFullYear(), m.date.getMonth() + 1, 1).getTime()
      if (joined < monthEnd) m.studios += 1
    })
  }

  return { months, joinedInWindow }
}

/**
 * ACTIVE STUDIOS ONLY — the caller passes them, and the header above says why
 * this counts current membership rather than a historical headcount. An INVITED
 * studio has not joined, so counting it here made the chart's own subtitle
 * disagree with the STUDIOS figure at the top of the page (13 against 12).
 */
export function GrowthCard({ rows, loading }: { rows: OrgStudioRow[]; loading: boolean }) {
  const t = useTranslations('OrgDashboard')
  const format = useFormatter()
  const { months, joinedInWindow } = useMemo(() => buildGrowthSeries(rows), [rows])

  const data = months.map((m) => ({
    label: format.dateTime(m.date, { month: 'short' }),
    full: format.dateTime(m.date, { month: 'long', year: 'numeric' }),
    studios: m.studios,
  }))

  return (
    <Card size="sm" className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-sm">{t('growthTitle')}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {t('growthSubtitle', { count: joinedInWindow, months: MONTHS_SHOWN })}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-3">
        {loading ? (
          <Skeleton className="h-[120px] w-full" />
        ) : rows.length === 0 ? (
          <ChartEmptyState
            icon={Building2}
            title={t('growthEmptyTitle')}
            hint={t('growthEmptyHint')}
          />
        ) : (
          <div className="h-[120px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="orgGrowthFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                {/* NO Y AXIS, AND NO GRID FOR IT TO LABEL.
                    This card is a third of the page wide. A value axis there
                    cost ~34px of a ~270px plot and then failed twice over: at
                    `margin.left: -24` it clipped its own top tick (a
                    twelve-studio federation drew "12" as "3"), and once the card
                    narrowed it rendered at zero width with no ticks at all. An
                    axis that is sometimes wrong and sometimes absent is worse
                    than none.

                    Nothing is lost. The MAGNITUDE is the STUDIOS figure at the
                    top of this page, the CHANGE is the subtitle directly above,
                    and the per-month value is on hover. What is left is the
                    shape, which is the only thing a twelve-point series in
                    ~270px can honestly show. */}
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  minTickGap={16}
                  tick={{ fontSize: 10 }}
                  className="fill-muted-foreground"
                />
                <Tooltip
                  cursor={{ stroke: 'var(--color-border)' }}
                  contentStyle={{
                    background: 'var(--color-popover)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(_label, payload) => payload?.[0]?.payload?.full ?? ''}
                  formatter={(value) => [value, t('growthSeries')]}
                />
                {/* A STEP, NOT A CURVE, and this was a real misreading before
                    it was one: `type="monotone"` drew the seed federation's two
                    September joins as a gentle ramp that began lifting in July,
                    so the chart said studios had been arriving for three months
                    when none had. Each point is a count at the END of its month
                    — a quantity that changes in jumps — and `stepAfter` is the
                    shape that says so. */}
                <Area
                  type="stepAfter"
                  dataKey="studios"
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  fill="url(#orgGrowthFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
