'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarDays } from 'lucide-react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  buildWeekKeys,
  shortWeekLabel,
  formatTooltipWeek,
  formatAxisWeek,
} from '@/lib/isoWeek'
import { ChartEmptyState } from './ChartEmptyState'
import type { SessionDoc, BookingDoc, WeeklyReport } from '@/hooks/useDashboardData'
import { isoWeekKey } from '@linyup/shared'

const SOURCE_OPTIONS = [
  {
    value: 'checkins',
    label: 'Check-ins',
    sublabel: 'by session time',
    color: '#6366F1',
    gradientId: 'gradCheckins',
  },
  {
    value: 'all_bookings',
    label: 'All bookings',
    sublabel: 'new + existing contacts',
    color: '#F59E0B',
    gradientId: 'gradAllBookings',
  },
  {
    value: 'new_bookings',
    label: 'New bookings',
    sublabel: 'first-time / trial contacts only',
    color: '#10B981',
    gradientId: 'gradNewBookings',
  },
  {
    value: 'engagement_rate',
    label: 'Engagement rate',
    sublabel: 'check-ins as % of total contacts',
    color: '#8B5CF6',
    gradientId: 'gradEngagement',
  },
  {
    value: 'no_show_count',
    label: 'No-shows',
    sublabel: 'bio-link bookings not attended',
    color: '#EF4444',
    gradientId: 'gradNoShow',
  },
  {
    value: 'no_show_rate',
    label: 'No-show rate',
    sublabel: 'no-shows as % of resolved bookings',
    color: '#F97316',
    gradientId: 'gradNoShowRate',
  },
]

function buildByWeek(
  source: string,
  weekKeys: string[],
  sessions: SessionDoc[],
  allBookings: BookingDoc[],
  newBookings: BookingDoc[],
  weeklyReports: WeeklyReport[]
): Record<string, number> {
  const byWeek: Record<string, number> = Object.fromEntries(weekKeys.map((k) => [k, 0]))

  if (source === 'checkins') {
    for (const s of sessions) {
      const date = s.start?.toDate?.()
      if (!date) continue
      const key = isoWeekKey(date)
      if (byWeek[key] === undefined) continue
      byWeek[key] += s.participants_count ?? 0
    }
  } else if (source === 'all_bookings') {
    for (const b of allBookings) {
      const date = b.joinedAt?.toDate?.()
      if (!date) continue
      const key = isoWeekKey(date)
      if (byWeek[key] === undefined) continue
      byWeek[key] += 1
    }
  } else if (source === 'new_bookings') {
    for (const b of newBookings) {
      const date = b.joinedAt?.toDate?.()
      if (!date) continue
      const key = isoWeekKey(date)
      if (byWeek[key] === undefined) continue
      byWeek[key] += 1
    }
  } else if (source === 'engagement_rate') {
    const contactsByWeek: Record<string, number> = {}
    for (const r of weeklyReports) {
      contactsByWeek[r.iso_week] = Object.values(r.contacts_count_by_stage ?? {}).reduce(
        (a, b) => a + b,
        0
      )
    }
    for (const s of sessions) {
      const date = s.start?.toDate?.()
      if (!date) continue
      const key = isoWeekKey(date)
      if (byWeek[key] === undefined) continue
      byWeek[key] += s.participants_count ?? 0
    }
    for (const key of weekKeys) {
      const contacts = contactsByWeek[key] ?? 0
      byWeek[key] = contacts > 0 ? Math.round((byWeek[key] / contacts) * 1000) / 10 : 0
    }
  } else if (source === 'no_show_count') {
    for (const b of allBookings) {
      if (b.status !== 'no_show') continue
      const date = b.joinedAt?.toDate?.()
      if (!date) continue
      const key = isoWeekKey(date)
      if (byWeek[key] === undefined) continue
      byWeek[key] += 1
    }
  } else if (source === 'no_show_rate') {
    const resolved: Record<string, number> = Object.fromEntries(weekKeys.map((k) => [k, 0]))
    const noShow: Record<string, number> = Object.fromEntries(weekKeys.map((k) => [k, 0]))
    for (const b of allBookings) {
      if (b.status === 'pending') continue
      const date = b.joinedAt?.toDate?.()
      if (!date) continue
      const key = isoWeekKey(date)
      if (resolved[key] === undefined) continue
      resolved[key] += 1
      if (b.status === 'no_show') noShow[key] += 1
    }
    for (const key of weekKeys) {
      byWeek[key] = resolved[key] > 0 ? Math.round((noShow[key] / resolved[key]) * 1000) / 10 : 0
    }
  }
  return byWeek
}

function BookingsTooltip({
  active,
  payload,
  label,
  option,
  compareWith,
}: {
  active?: boolean
  payload?: { dataKey: string; value: number }[]
  label?: string
  option: (typeof SOURCE_OPTIONS)[0]
  compareWith?: string
}) {
  const td = useTranslations('Dashboard')
  if (!active || !payload?.length || !label) return null
  const isRate = option.value === 'engagement_rate' || option.value === 'no_show_rate'
  const fmt = (v: number) => (isRate ? `${v}%` : String(v))
  const mainVal = payload.find((p) => p.dataKey === 'value')?.value ?? 0
  const compVal = payload.find((p) => p.dataKey === 'comparison')?.value
  return (
    <div className="bg-background border rounded-lg shadow-lg p-3 text-xs max-w-[260px]">
      <p className="font-bold mb-1">{formatTooltipWeek(label)}</p>
      <p style={{ color: option.color }}>
        {option.label}: <strong>{fmt(mainVal)}</strong>
      </p>
      {compareWith && compareWith !== 'none' && compVal !== undefined && (
        <p className="text-muted-foreground mt-0.5">
          {compareWith === 'last_year' ? td('legendLastYear') : td('legendPrevPeriod')}:{' '}
          <strong>{fmt(compVal)}</strong>
        </p>
      )}
    </div>
  )
}

interface Props {
  sessions?: SessionDoc[]
  allBookings?: BookingDoc[]
  newContactBookings?: BookingDoc[]
  weeklyReports?: WeeklyReport[]
  comparisonWeeklyReports?: WeeklyReport[]
  trendsWeeks?: number
  compareWith?: string
  comparisonSessions?: SessionDoc[]
  comparisonAllBookings?: BookingDoc[]
  comparisonNewContactBookings?: BookingDoc[]
  title?: string
}

export function BookingsTrendCard({
  sessions = [],
  allBookings = [],
  newContactBookings = [],
  weeklyReports = [],
  comparisonWeeklyReports = [],
  trendsWeeks = 13,
  compareWith = 'none',
  comparisonSessions = [],
  comparisonAllBookings = [],
  comparisonNewContactBookings = [],
  title,
}: Props) {
  const td = useTranslations('Dashboard')
  const [source, setSource] = useState('checkins')
  const selectedOption = SOURCE_OPTIONS.find((o) => o.value === source)!
  const comparisonOffset = compareWith === 'last_year' ? 52 : trendsWeeks
  const isRate = source === 'engagement_rate' || source === 'no_show_rate'

  const chartData = useMemo(() => {
    const weekKeys = buildWeekKeys(trendsWeeks, 0)
    const compWeekKeys = compareWith !== 'none' ? buildWeekKeys(trendsWeeks, comparisonOffset) : []
    const byWeek = buildByWeek(
      source,
      weekKeys,
      sessions,
      allBookings,
      newContactBookings,
      weeklyReports
    )
    const byCompWeek =
      compareWith !== 'none'
        ? buildByWeek(
            source,
            compWeekKeys,
            comparisonSessions,
            comparisonAllBookings,
            comparisonNewContactBookings,
            comparisonWeeklyReports
          )
        : {}
    return weekKeys.map((key, idx) => ({
      week: key,
      label: shortWeekLabel(key, weekKeys[idx - 1]),
      value: byWeek[key],
      ...(compareWith !== 'none' && { comparison: byCompWeek[compWeekKeys[idx]] ?? 0 }),
    }))
  }, [
    sessions,
    allBookings,
    newContactBookings,
    weeklyReports,
    comparisonWeeklyReports,
    comparisonSessions,
    comparisonAllBookings,
    comparisonNewContactBookings,
    source,
    trendsWeeks,
    compareWith,
    comparisonOffset,
  ])

  const hasData = chartData.some((d) => d.value > 0 || (d.comparison ?? 0) > 0)
  const { color, gradientId } = selectedOption

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="flex-1">{title || td('chartTitleSessions')}</CardTitle>
          <Select
            value={source}
            onValueChange={(v) => {
              if (v) setSource(v)
            }}
          >
            <SelectTrigger size="sm" className="w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} label={o.label}>
                  {o.sublabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pb-4 pt-3">
        {!hasData ? (
          <ChartEmptyState
            icon={CalendarDays}
            title={td('chartEmptyTitle')}
            hint={td('chartEmptySessions')}
          />
        ) : (
          <div className="mt-auto">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id={`${gradientId}_comp`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.08} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                <XAxis
                  dataKey="week"
                  tickFormatter={formatAxisWeek}
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  allowDecimals={isRate}
                  tickFormatter={isRate ? (v) => `${v}%` : undefined}
                  tick={{ fontSize: 11 }}
                  width={isRate ? 44 : 36}
                  tickCount={5}
                />
                <Tooltip
                  content={<BookingsTooltip option={selectedOption} compareWith={compareWith} />}
                />
                {compareWith !== 'none' && (
                  <Area
                    type="monotone"
                    dataKey="comparison"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    strokeOpacity={0.45}
                    fill={`url(#${gradientId}_comp)`}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
            {compareWith !== 'none' && (
              <div className="flex items-center gap-4 justify-end mt-1.5">
                <div className="flex items-center gap-1">
                  <div className="w-5 h-0.5 rounded" style={{ background: color }} />
                  <span className="text-xs text-muted-foreground">
                    {td('legendCurrent')}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <div
                    className="w-5 h-0"
                    style={{ borderTop: `2px dashed ${color}`, opacity: 0.45 }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {compareWith === 'last_year' ? td('legendLastYear') : td('legendPrevPeriod')}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
