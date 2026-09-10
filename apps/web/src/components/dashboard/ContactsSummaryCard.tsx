'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Users } from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ChartEmptyState } from './ChartEmptyState'
import { buildWeekKeys, shortWeekLabel, formatTooltipWeek, formatAxisWeek } from '@/lib/isoWeek'
import type { WeeklyReport, SubscriptionTypeDoc } from '@/hooks/useDashboardData'

// ─── colors ──────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  all: '#6366F1', student: '#6366F1', trial: '#10B981',
  external: '#F59E0B', guest: '#EC4899', member: '#3B82F6',
}
const PALETTE = ['#6366F1','#10B981','#F59E0B','#EC4899','#3B82F6','#8B5CF6','#EF4444','#14B8A6','#F97316','#84CC16']
const FALLBACK = '#6366F1'

function typeColor(t: string) { return TYPE_COLORS[t] ?? FALLBACK }
function paletteColor(i: number) { return PALETTE[i % PALETTE.length] }

// ─── dimensions ──────────────────────────────────────────────────────────────
// Built dynamically inside the component so the membership term can be injected.

// The series value for "on a partner-app plan". Not a subscription type id —
// no type doc carries this id — so it cannot collide with the per-type series.
const PARTNER_SERIES = '__partner'

// Fallback display for an affiliation type_key (e.g. 'federation_licence').
function humanizeKey(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : k
}

function countFor(report: WeeklyReport | undefined, dim: string, value: string): number {
  if (!report) return 0
  // Affiliation & subscription are multi-valued (a contact may hold several): the
  // "all" series is the distinct-contact scalar, per-value series the by-type map.
  if (dim === 'affiliation') {
    if (value === 'all') return report.contacts_with_active_affiliation ?? 0
    return report.contacts_count_by_affiliation_type?.[value] ?? 0
  }
  if (dim === 'subscription_type') {
    // "Subscribed" is the studio's OWN plans; partner-app plans are their own
    // series (see subscriptionSource.ts in shared) and never in the headline.
    if (value === 'all') return report.contacts_with_active_subscription ?? 0
    if (value === PARTNER_SERIES) return report.contacts_with_aggregator_subscription ?? 0
    return report.contacts_count_by_subscription_type?.[value] ?? 0
  }
  // Acquisition stage is exclusive, so summing the map gives distinct contacts.
  const map = report.contacts_count_by_stage ?? {}
  if (value === 'all') return Object.values(map).reduce((s, v) => s + v, 0)
  return map[value] ?? 0
}

// ─── tooltip ─────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, valueLabel, color, compareWith, series }: {
  active?: boolean; payload?: { dataKey: string; value: number }[]
  label?: string; valueLabel?: string; color?: string
  compareWith?: string; series?: { value: string; label: string; color: string }[]
}) {
  const td = useTranslations('Dashboard')
  if (!active || !payload?.length || !label) return null
  const weekLabel = formatTooltipWeek(label)

  if (series) {
    return (
      <div className="bg-background border rounded-lg shadow-lg p-3 text-xs max-w-[220px]">
        <p className="font-bold mb-1.5">{weekLabel}</p>
        {series.map((s) => {
          const p = payload.find((x) => x.dataKey === s.value)
          if (!p) return null
          return (
            <div key={s.value} className="flex items-center gap-1.5 mt-0.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.color }} />
              <span className="flex-1 capitalize">{s.label}</span>
              <span className="font-bold">{p.value}</span>
            </div>
          )
        })}
      </div>
    )
  }

  const mainVal = payload.find((p) => p.dataKey === 'value')?.value ?? 0
  const compVal = payload.find((p) => p.dataKey === 'comparison')?.value
  return (
    <div className="bg-background border rounded-lg shadow-lg p-3 text-xs max-w-[220px]">
      <p className="font-bold mb-1">{weekLabel}</p>
      <p style={{ color }}>{valueLabel}: <strong>{mainVal}</strong></p>
      {compareWith && compareWith !== 'none' && compVal !== undefined && (
        <p className="text-muted-foreground mt-0.5">
          {compareWith === 'last_year' ? td('legendLastYear') : td('legendPrevPeriod')}:{' '}
          <strong>{compVal}</strong>
        </p>
      )}
    </div>
  )
}

// ─── series selector ──────────────────────────────────────────────────────────
// Simple multi-series toggle: click a colored dot to add/remove a series.
// Clicking "All" deselects everything else.

function SeriesSelector({ options, selected, onToggle }: {
  options: { value: string; label: string; color: string }[]
  selected: string[]
  onToggle: (val: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = selected.includes(o.value)
        return (
          <button
            key={o.value}
            onClick={() => onToggle(o.value)}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors
              ${active ? 'border-transparent text-foreground' : 'border-border text-muted-foreground'}`}
            style={active ? { background: o.color + '22', borderColor: o.color } : {}}
          >
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: o.color }} />
            <span className="capitalize">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─── component ────────────────────────────────────────────────────────────────

interface Props {
  weeklyReports: WeeklyReport[]
  comparisonWeeklyReports?: WeeklyReport[]
  compareWith?: string
  trendsWeeks?: number
  subscriptionTypes?: SubscriptionTypeDoc[]
  title?: string
}

export function ContactsSummaryCard({
  weeklyReports, comparisonWeeklyReports = [], compareWith = 'none',
  trendsWeeks = 13, subscriptionTypes = [], title,
}: Props) {
  const DIMENSIONS = [
    { value: 'type',              label: 'Acquisition stage' },
    { value: 'affiliation',       label: 'Affiliation' },
    { value: 'subscription_type', label: 'Subscription' },
  ]

  const td = useTranslations('Dashboard')
  const [dimension, setDimension] = useState('type')
  const [selectedValues, setSelectedValues] = useState<string[]>(['all'])

  const comparisonOffset = compareWith === 'last_year' ? 52 : trendsWeeks

  const valueOptions = useMemo(() => {
    if (dimension === 'type') {
      const types = Array.from(new Set(weeklyReports.flatMap((r) => Object.keys(r.contacts_count_by_stage ?? {})))).sort()
      return [
        { value: 'all', label: 'All types', color: typeColor('all') },
        ...types.map((t) => ({ value: t, label: t, color: typeColor(t) })),
      ]
    }
    if (dimension === 'affiliation') {
      const keys = Array.from(new Set(weeklyReports.flatMap((r) => Object.keys(r.contacts_count_by_affiliation_type ?? {})))).sort()
      return [
        { value: 'all', label: td('seriesAffiliated'), color: typeColor('member') },
        ...keys.map((k, i) => ({ value: k, label: humanizeKey(k), color: paletteColor(i) })),
      ]
    }
    // subscription_type — "Subscribed" is the studio's OWN plans; a partner-app
    // plan (FitPass, ClassPass…) gets its own series, offered only once a
    // report has somebody on one. Per-type series keep every type by name.
    const ids = Array.from(new Set(weeklyReports.flatMap((r) => Object.keys(r.contacts_count_by_subscription_type ?? {}))))
    const nameMap = Object.fromEntries((subscriptionTypes ?? []).map((st) => [st.id, st.name]))
    const anyPartner = weeklyReports.some((r) => (r.contacts_with_aggregator_subscription ?? 0) > 0)
    return [
      { value: 'all', label: td('seriesSubscribed'), color: FALLBACK },
      ...(anyPartner ? [{ value: PARTNER_SERIES, label: td('seriesViaPartner'), color: paletteColor(ids.length) }] : []),
      ...ids.map((id, i) => ({ value: id, label: nameMap[id] ?? id, color: paletteColor(i) })),
    ]
  }, [dimension, weeklyReports, subscriptionTypes, td])

  const handleDimensionChange = (dim: string) => {
    setDimension(dim)
    setSelectedValues(['all'])
  }

  const handleToggle = (val: string) => {
    if (val === 'all') { setSelectedValues(['all']); return }
    setSelectedValues((prev) => {
      const without = prev.filter((v) => v !== 'all')
      if (without.includes(val)) {
        const next = without.filter((v) => v !== val)
        return next.length > 0 ? next : ['all']
      }
      return [...without, val]
    })
  }

  const isSplit = selectedValues.length > 1 || (selectedValues.length === 1 && !selectedValues.includes('all') && selectedValues[0] !== 'all')
  const combinedSeries = useMemo(
    () => valueOptions.filter((o) => selectedValues.includes(o.value)),
    [valueOptions, selectedValues],
  )
  const singleValue = selectedValues[0] ?? 'all'
  const currentOption = valueOptions.find((o) => o.value === singleValue) ?? valueOptions[0]
  const color = currentOption?.color ?? FALLBACK
  const gradId = `gradContacts_${dimension}_${singleValue}`

  const chartData = useMemo(() => {
    const weekKeys = buildWeekKeys(trendsWeeks, 0)
    const compWeekKeys = compareWith !== 'none' ? buildWeekKeys(trendsWeeks, comparisonOffset) : []
    const byWeek = Object.fromEntries((weeklyReports).map((r) => [r.iso_week, r]))
    const compByWeek = Object.fromEntries((comparisonWeeklyReports).map((r) => [r.iso_week, r]))

    if (isSplit) {
      return weekKeys.map((key, idx) => {
        const pt: Record<string, unknown> = { week: key, label: shortWeekLabel(key, weekKeys[idx - 1]) }
        combinedSeries.forEach((s) => { pt[s.value] = countFor(byWeek[key], dimension, s.value) })
        return pt
      })
    }
    return weekKeys.map((key, idx) => ({
      week: key,
      label: shortWeekLabel(key, weekKeys[idx - 1]),
      value: countFor(byWeek[key], dimension, singleValue),
      ...(compareWith !== 'none' && { comparison: countFor(compByWeek[compWeekKeys[idx]], dimension, singleValue) }),
    }))
  }, [weeklyReports, comparisonWeeklyReports, dimension, singleValue, isSplit, combinedSeries, trendsWeeks, compareWith, comparisonOffset])

  const hasData = isSplit
    ? (chartData as Record<string, unknown>[]).some((d) => combinedSeries.some((s) => (d[s.value] as number ?? 0) > 0))
    : (chartData as { value: number; comparison?: number }[]).some((d) => d.value > 0 || (d.comparison ?? 0) > 0)

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">

          <CardTitle className="flex-1">{title || td('chartTitleContacts')}</CardTitle>
          <Select value={dimension} onValueChange={(v) => { if (v) handleDimensionChange(v) }}>
            <SelectTrigger size="sm" className="w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DIMENSIONS.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {valueOptions.length > 1 && (
          <SeriesSelector options={valueOptions} selected={selectedValues} onToggle={handleToggle} />
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pb-4 pt-3">
        {!hasData ? (
          <ChartEmptyState
            icon={Users}
            title={td('chartEmptyTitle')}
            hint={td('chartEmptyContacts')}
          />
        ) : (
          <div className="mt-auto">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData as object[]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  {isSplit ? combinedSeries.map((s) => (
                    <linearGradient key={s.value} id={`grad_comb_${s.value}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={s.color} stopOpacity={0.12} />
                      <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                    </linearGradient>
                  )) : <>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id={`${gradId}_comp`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={color} stopOpacity={0.08} />
                      <stop offset="95%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                  </>}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                <XAxis dataKey="week" tickFormatter={formatAxisWeek} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} tickCount={5} />
                <Tooltip content={
                  isSplit
                    ? <ChartTooltip series={combinedSeries} />
                    : <ChartTooltip valueLabel={currentOption?.label} color={color} compareWith={compareWith} />
                } />
                {isSplit
                  ? combinedSeries.map((s) => (
                    <Area key={s.value} type="monotone" dataKey={s.value}
                      stroke={s.color} strokeWidth={2} fill={`url(#grad_comb_${s.value})`}
                      dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
                  )) : <>
                    {compareWith !== 'none' && (
                      <Area type="monotone" dataKey="comparison"
                        stroke={color} strokeWidth={1.5} strokeDasharray="5 3" strokeOpacity={0.45}
                        fill={`url(#${gradId}_comp)`} dot={false} activeDot={false} isAnimationActive={false} />
                    )}
                    <Area type="monotone" dataKey="value"
                      stroke={color} strokeWidth={2} fill={`url(#${gradId})`}
                      dot={false} activeDot={{ r: 4 }} />
                  </>}
              </AreaChart>
            </ResponsiveContainer>

            {/* legend */}
            {isSplit && (
              <div className="flex flex-wrap gap-3 justify-center mt-1.5">
                {combinedSeries.map((s) => (
                  <div key={s.value} className="flex items-center gap-1">
                    <div className="w-4 h-0.5 rounded" style={{ background: s.color }} />
                    <span className="text-xs text-muted-foreground capitalize">{s.label}</span>
                  </div>
                ))}
              </div>
            )}
            {!isSplit && compareWith !== 'none' && (
              <div className="flex items-center gap-4 justify-end mt-1.5">
                <div className="flex items-center gap-1">
                  <div className="w-5 h-0.5 rounded" style={{ background: color }} />
                  <span className="text-xs text-muted-foreground">
                    {td('legendCurrent')}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-5 h-0" style={{ borderTop: `2px dashed ${color}`, opacity: 0.45 }} />
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
