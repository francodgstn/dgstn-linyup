'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Line, ReferenceLine,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { buildWeekKeys, formatTooltipWeek } from '@/lib/isoWeek'
import type { WeeklyReport, SessionDoc, BookingDoc } from '@/hooks/useDashboardData'
import { isoWeekKey } from '@linyup/shared'

// ─── metrics ──────────────────────────────────────────────────────────────────
// Labels are translated (CorrelationExplorer.metric*); this only maps a metric
// key to its message key.

const METRICS = [
  { value: 'checkins',        key: 'metricCheckins' },
  { value: 'all_bookings',    key: 'metricAllBookings' },
  { value: 'new_bookings',    key: 'metricNewBookings' },
  { value: 'active_contacts', key: 'metricActiveContacts' },
  { value: 'total_contacts',  key: 'metricTotalContacts' },
  { value: 'trials',          key: 'metricTrials' },
  { value: 'students',        key: 'metricStudents' },
  { value: 'engagement_rate', key: 'metricEngagementRate' },
  { value: 'sessions_held',   key: 'metricSessionsHeld' },
] as const

type MetricKey = typeof METRICS[number]['value']
type Translator = ReturnType<typeof useTranslations>

function metricLabel(t: Translator, key: MetricKey): string {
  const metric = METRICS.find((m) => m.value === key)
  return metric ? t(metric.key) : key
}

// ─── linear regression ────────────────────────────────────────────────────────

function linearRegression(points: { x: number; y: number }[]): {
  slope: number; intercept: number; r: number
} | null {
  const n = points.length
  if (n < 3) return null
  const sumX  = points.reduce((s, p) => s + p.x, 0)
  const sumY  = points.reduce((s, p) => s + p.y, 0)
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0)
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0)
  const sumY2 = points.reduce((s, p) => s + p.y * p.y, 0)
  const denom = n * sumX2 - sumX * sumX
  if (denom === 0) return null
  const slope     = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  const rNum = n * sumXY - sumX * sumY
  const rDen = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
  const r = rDen === 0 ? 0 : rNum / rDen
  return { slope, intercept, r }
}

function rLabel(t: Translator, r: number): string {
  const abs = Math.abs(r)
  const directionKey = r >= 0 ? 'directionPositive' : 'directionNegative'
  const strengthKey = abs >= 0.7 ? 'strengthStrong' : abs >= 0.4 ? 'strengthModerate' : abs >= 0.2 ? 'strengthWeak' : 'strengthNone'
  return t('correlationLabel', { strength: t(strengthKey), direction: t(directionKey), r: r.toFixed(2) })
}

// ─── tooltip ─────────────────────────────────────────────────────────────────

function CorrelationTooltip({ active, payload, metricX, metricY }: {
  active?: boolean
  payload?: { payload: { week: string; x: number; y: number } }[]
  metricX: MetricKey; metricY: MetricKey
}) {
  const t = useTranslations('CorrelationExplorer')
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-background border rounded-lg shadow-lg p-3 text-xs">
      <p className="font-bold mb-1">{formatTooltipWeek(d.week)}</p>
      <p className="text-muted-foreground">
        {t.rich('tooltipMetric', { metric: metricLabel(t, metricX), value: d.x, strong: (chunks) => <strong>{chunks}</strong> })}
      </p>
      <p className="text-muted-foreground">
        {t.rich('tooltipMetric', { metric: metricLabel(t, metricY), value: d.y, strong: (chunks) => <strong>{chunks}</strong> })}
      </p>
    </div>
  )
}

// ─── component ────────────────────────────────────────────────────────────────

export function CorrelationExplorerCard({
  weeklyReports,
  sessions,
  allBookings,
  newContactBookings,
  trendsWeeks,
}: {
  weeklyReports: WeeklyReport[]
  sessions: SessionDoc[]
  allBookings: BookingDoc[]
  newContactBookings: BookingDoc[]
  trendsWeeks: number
}) {
  const t = useTranslations('CorrelationExplorer')
  const [metricX, setMetricX] = useState<MetricKey>('active_contacts')
  const [metricY, setMetricY] = useState<MetricKey>('checkins')

  const chartData = useMemo(() => {
    const weekKeys = buildWeekKeys(trendsWeeks)
    const byWeek   = new Map(weeklyReports.map((r) => [r.iso_week, r]))

    // Aggregate sessions → checkins by week
    const checkinsByWeek: Record<string, number> = {}
    for (const s of sessions) {
      if (!s.start) continue
      const wk = isoWeekKey((s.start as { toDate(): Date }).toDate())
      checkinsByWeek[wk] = (checkinsByWeek[wk] ?? 0) + (s.participants_count ?? 0)
    }

    // Aggregate bookings by week
    const allByWeek: Record<string, number> = {}
    const newByWeek: Record<string, number> = {}
    for (const b of allBookings) {
      if (!b.joinedAt) continue
      const wk = isoWeekKey((b.joinedAt as { toDate(): Date }).toDate())
      allByWeek[wk] = (allByWeek[wk] ?? 0) + 1
    }
    for (const b of newContactBookings) {
      if (!b.joinedAt) continue
      const wk = isoWeekKey((b.joinedAt as { toDate(): Date }).toDate())
      newByWeek[wk] = (newByWeek[wk] ?? 0) + 1
    }

    function getMetric(week: string, metric: MetricKey): number | null {
      const r = byWeek.get(week)
      switch (metric) {
        case 'checkins':        return checkinsByWeek[week] ?? 0
        case 'all_bookings':    return allByWeek[week] ?? 0
        case 'new_bookings':    return newByWeek[week] ?? 0
        case 'active_contacts': return r?.active_contacts_count ?? null
        case 'total_contacts': {
          const stageCounts = r?.contacts_count_by_stage
          return stageCounts ? Object.values(stageCounts).reduce((s, v) => s + v, 0) : null
        }
        case 'trials':          return r?.contacts_count_by_stage
          ? (r.contacts_count_by_stage.trial_booked ?? 0) + (r.contacts_count_by_stage.trial_attended ?? 0)
          : null
        case 'students':        return r?.contacts_count_by_stage?.joined ?? null
        case 'engagement_rate': {
          const bk = r?.bookings_count ?? 0
          const ac = r?.active_contacts_count ?? 0
          return ac > 0 ? Math.round((bk / ac) * 1000) / 10 : null
        }
        case 'sessions_held':   return r?.sessions_count ?? null
        default:                return null
      }
    }

    return weekKeys
      .map((week) => {
        const x = getMetric(week, metricX)
        const y = getMetric(week, metricY)
        if (x === null || y === null) return null
        return { week, x, y }
      })
      .filter((d): d is { week: string; x: number; y: number } => d !== null)
  }, [weeklyReports, sessions, allBookings, newContactBookings, trendsWeeks, metricX, metricY])

  const regression = useMemo(() => {
    const reg = linearRegression(chartData)
    if (!reg || chartData.length < 3) return null
    const xs = chartData.map((d) => d.x)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    return {
      ...reg,
      line: [
        { x: minX, y: reg.slope * minX + reg.intercept },
        { x: maxX, y: reg.slope * maxX + reg.intercept },
      ],
    }
  }, [chartData])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 flex-wrap">

          <CardTitle className="flex-1">{t('cardTitle')}</CardTitle>
          <Select value={metricX} onValueChange={(v) => setMetricX(v as MetricKey)}>
            <SelectTrigger size="sm" className="w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METRICS.map((m) => <SelectItem key={m.value} value={m.value}>{t(m.key)}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{t('vsLabel')}</span>
          <Select value={metricY} onValueChange={(v) => setMetricY(v as MetricKey)}>
            <SelectTrigger size="sm" className="w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METRICS.map((m) => <SelectItem key={m.value} value={m.value}>{t(m.key)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {regression && (
          <p className="text-[11px] text-muted-foreground">{rLabel(t, regression.r)}</p>
        )}
      </CardHeader>
      <CardContent>
        {chartData.length < 3 ? (
          <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
            {t('notEnoughData')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 4, right: 12, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
              <XAxis
                type="number"
                dataKey="x"
                name={metricLabel(t, metricX)}
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                label={{ value: metricLabel(t, metricX), position: 'insideBottom', offset: -12, fontSize: 10 }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={metricLabel(t, metricY)}
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={38}
                label={{ value: metricLabel(t, metricY), angle: -90, position: 'insideLeft', fontSize: 10 }}
              />
              <Tooltip
                content={<CorrelationTooltip metricX={metricX} metricY={metricY} />}
                cursor={{ strokeDasharray: '3 3' }}
              />
              <Scatter data={chartData} fill="#6366F1" fillOpacity={0.7} r={4} />
              {regression && (
                <Line
                  data={regression.line}
                  type="linear"
                  dataKey="y"
                  stroke="#6366F1"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  strokeOpacity={0.5}
                  legendType="none"
                  isAnimationActive={false}
                />
              )}
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
