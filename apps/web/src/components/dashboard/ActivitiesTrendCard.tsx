'use client'

/**
 * WHICH ACTIVITIES FILL UP, WEEK BY WEEK.
 *
 * `TopActivitiesCard` ranks activities over the whole window and answers "what
 * is popular". It cannot answer "what is GROWING" — a class that halved and a
 * class that doubled sit next to each other in the same order all quarter. This
 * card plots the same measure over time, which is the only way that shows.
 *
 * ── ONE MEASURE, AND WHY NOT THREE ──────────────────────────────────────────
 *
 * The ranking card offers check-ins, all bookings and new-contact bookings. This
 * one plots CHECK-INS only (`Session.participants_count`), and the choice is not
 * laziness: a booking is an intention and a check-in is attendance, and the
 * trend a studio acts on is attendance. It also happens to be the measure
 * migrated clubs actually have — HMD recorded attendance on 309 of 400 sessions
 * and a booking count on 16, so a bookings trend would be a flat line at zero
 * for the tenant with the most history to show.
 *
 * ── THE SERIES CAP ──────────────────────────────────────────────────────────
 *
 * A studio with thirty activities cannot read thirty lines, and a selector with
 * thirty chips is not a control. So the per-activity series are the TOP
 * `MAX_SERIES` by total check-ins in the window; "All activities" always sums
 * EVERY activity, including the ones with no chip, so the headline is never
 * quietly a subtotal.
 */

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dumbbell } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { isoWeekKey } from '@linyup/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartEmptyState } from './ChartEmptyState'
import { buildWeekKeys, formatAxisWeek, formatTooltipWeek, shortWeekLabel } from '@/lib/isoWeek'
import type { ActivityDoc, SessionDoc } from '@/hooks/useDashboardData'

const PALETTE = [
  '#6366F1',
  '#10B981',
  '#F59E0B',
  '#EC4899',
  '#3B82F6',
  '#8B5CF6',
  '#EF4444',
  '#14B8A6',
]
const ALL_COLOR = '#6366F1'
/** See the header: a readable number of lines, not every activity ever run. */
const MAX_SERIES = 8

/** The series key for the total. Not an activity id, so it cannot collide. */
const ALL = '__all'

type Bucket = Record<string, Record<string, number>>

/** week key → activity id → check-ins. Sessions carry their own `start`, so the
 *  bucket is built from the sessions themselves and never from a report. */
function bucketByWeek(sessions: SessionDoc[]): Bucket {
  const out: Bucket = {}
  for (const s of sessions) {
    const n = s.participants_count ?? 0
    if (n <= 0) continue
    if (s.cancelled_at) continue
    const week = isoWeekKey(s.start.toDate())
    const key = s.activityId ?? '__none__'
    out[week] ??= {}
    out[week][key] = (out[week][key] ?? 0) + n
  }
  return out
}

function countFor(bucket: Bucket, week: string, series: string): number {
  const row = bucket[week]
  if (!row) return 0
  if (series === ALL) return Object.values(row).reduce((s, v) => s + v, 0)
  return row[series] ?? 0
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  valueLabel,
  color,
  compareWith,
}: {
  active?: boolean
  payload?: { dataKey: string; value: number }[]
  label?: string
  series?: { value: string; label: string; color: string }[]
  valueLabel?: string
  color?: string
  compareWith?: string
}) {
  const td = useTranslations('Dashboard')
  if (!active || !payload?.length || !label) return null
  const weekLabel = formatTooltipWeek(label)

  if (series) {
    return (
      <div className="max-w-[220px] rounded-lg border bg-background p-3 text-xs shadow-lg">
        <p className="mb-1.5 font-bold">{weekLabel}</p>
        {series.map((s) => {
          const p = payload.find((x) => x.dataKey === s.value)
          if (!p) return null
          return (
            <div key={s.value} className="mt-0.5 flex items-center gap-1.5">
              <span
                className="h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: s.color }}
              />
              <span className="flex-1 truncate">{s.label}</span>
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
    <div className="max-w-[220px] rounded-lg border bg-background p-3 text-xs shadow-lg">
      <p className="mb-1 font-bold">{weekLabel}</p>
      <p style={{ color }}>
        {valueLabel}: <strong>{mainVal}</strong>
      </p>
      {compareWith && compareWith !== 'none' && compVal !== undefined && (
        <p className="mt-0.5 text-muted-foreground">
          {compareWith === 'last_year' ? td('legendLastYear') : td('legendPrevPeriod')}:{' '}
          <strong>{compVal}</strong>
        </p>
      )}
    </div>
  )
}

interface Props {
  sessions?: SessionDoc[]
  comparisonSessions?: SessionDoc[]
  activities?: ActivityDoc[]
  compareWith?: string
  trendsWeeks?: number
  title?: string
}

export function ActivitiesTrendCard({
  sessions = [],
  comparisonSessions = [],
  activities = [],
  compareWith = 'none',
  trendsWeeks = 13,
  title,
}: Props) {
  const td = useTranslations('Dashboard')
  const [selected, setSelected] = useState<string[]>([ALL])

  const comparisonOffset = compareWith === 'last_year' ? 52 : trendsWeeks
  const bucket = useMemo(() => bucketByWeek(sessions), [sessions])
  const compBucket = useMemo(() => bucketByWeek(comparisonSessions), [comparisonSessions])

  const options = useMemo(() => {
    const names = new Map(activities.map((a) => [a.id, a.name ?? a.activityName ?? a.id]))
    // A session carries its own denormalised name, which is what a DELETED
    // activity leaves behind — fall back to it rather than printing an id.
    for (const s of sessions) {
      if (s.activityId && !names.has(s.activityId) && s.activityName)
        names.set(s.activityId, s.activityName)
    }
    const totals = new Map<string, number>()
    for (const row of Object.values(bucket))
      for (const [key, n] of Object.entries(row)) totals.set(key, (totals.get(key) ?? 0) + n)

    const ranked = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SERIES)
      .map(([key], i) => ({
        value: key,
        label: key === '__none__' ? td('activityNone') : (names.get(key) ?? key),
        color: PALETTE[i % PALETTE.length],
      }))
    return [{ value: ALL, label: td('seriesAllActivities'), color: ALL_COLOR }, ...ranked]
  }, [activities, sessions, bucket, td])

  const toggle = (val: string) => {
    if (val === ALL) {
      setSelected([ALL])
      return
    }
    setSelected((prev) => {
      const without = prev.filter((v) => v !== ALL)
      if (without.includes(val)) {
        const next = without.filter((v) => v !== val)
        return next.length > 0 ? next : [ALL]
      }
      return [...without, val]
    })
  }

  const isSplit = selected.length > 1 || (selected.length === 1 && selected[0] !== ALL)
  const combined = useMemo(
    () => options.filter((o) => selected.includes(o.value)),
    [options, selected],
  )
  const single = selected[0] ?? ALL
  const current = options.find((o) => o.value === single) ?? options[0]
  const color = current?.color ?? ALL_COLOR
  const gradId = `gradActivities_${single}`

  const chartData = useMemo(() => {
    const weekKeys = buildWeekKeys(trendsWeeks, 0)
    const compKeys = compareWith !== 'none' ? buildWeekKeys(trendsWeeks, comparisonOffset) : []
    if (isSplit) {
      return weekKeys.map((key, idx) => {
        const pt: Record<string, unknown> = { week: key, label: shortWeekLabel(key, weekKeys[idx - 1]) }
        combined.forEach((s) => {
          pt[s.value] = countFor(bucket, key, s.value)
        })
        return pt
      })
    }
    return weekKeys.map((key, idx) => ({
      week: key,
      label: shortWeekLabel(key, weekKeys[idx - 1]),
      value: countFor(bucket, key, single),
      ...(compareWith !== 'none' && {
        comparison: countFor(compBucket, compKeys[idx], single),
      }),
    }))
  }, [bucket, compBucket, trendsWeeks, compareWith, comparisonOffset, isSplit, combined, single])

  const hasData = isSplit
    ? (chartData as Record<string, unknown>[]).some((d) =>
        combined.some((s) => ((d[s.value] as number) ?? 0) > 0),
      )
    : (chartData as { value: number; comparison?: number }[]).some(
        (d) => d.value > 0 || (d.comparison ?? 0) > 0,
      )

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="flex-1">{title || td('chartTitleActivities')}</CardTitle>
          <span className="shrink-0 text-xs text-muted-foreground">{td('measureCheckins')}</span>
        </div>
        {options.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => {
              const on = selected.includes(o.value)
              return (
                <button
                  key={o.value}
                  onClick={() => toggle(o.value)}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    on ? 'border-transparent text-foreground' : 'border-border text-muted-foreground'
                  }`}
                  style={on ? { background: o.color + '22', borderColor: o.color } : {}}
                >
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: o.color }}
                  />
                  <span className="max-w-[120px] truncate">{o.label}</span>
                </button>
              )
            })}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col pb-4 pt-3">
        {!hasData ? (
          <ChartEmptyState
            icon={Dumbbell}
            title={td('chartEmptyTitle')}
            hint={td('chartEmptyActivities')}
          />
        ) : (
          <div className="mt-auto">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData as object[]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  {isSplit ? (
                    combined.map((s) => (
                      <linearGradient
                        key={s.value}
                        id={`gradAct_${s.value}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop offset="5%" stopColor={s.color} stopOpacity={0.12} />
                        <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                      </linearGradient>
                    ))
                  ) : (
                    <>
                      <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={color} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id={`${gradId}_comp`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={color} stopOpacity={0.08} />
                        <stop offset="95%" stopColor={color} stopOpacity={0} />
                      </linearGradient>
                    </>
                  )}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                <XAxis
                  dataKey="week"
                  tickFormatter={formatAxisWeek}
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} tickCount={5} />
                <Tooltip
                  content={
                    isSplit ? (
                      <ChartTooltip series={combined} />
                    ) : (
                      <ChartTooltip
                        valueLabel={current?.label}
                        color={color}
                        compareWith={compareWith}
                      />
                    )
                  }
                />
                {isSplit ? (
                  combined.map((s) => (
                    <Area
                      key={s.value}
                      type="monotone"
                      dataKey={s.value}
                      stroke={s.color}
                      strokeWidth={2}
                      fill={`url(#gradAct_${s.value})`}
                      dot={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                  ))
                ) : (
                  <>
                    {compareWith !== 'none' && (
                      <Area
                        type="monotone"
                        dataKey="comparison"
                        stroke={color}
                        strokeWidth={1.5}
                        strokeDasharray="5 3"
                        strokeOpacity={0.45}
                        fill={`url(#${gradId}_comp)`}
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
                      fill={`url(#${gradId})`}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </>
                )}
              </AreaChart>
            </ResponsiveContainer>

            {isSplit && (
              <div className="mt-1.5 flex flex-wrap justify-center gap-3">
                {combined.map((s) => (
                  <div key={s.value} className="flex items-center gap-1">
                    <div className="h-0.5 w-4 rounded" style={{ background: s.color }} />
                    <span className="max-w-[140px] truncate text-xs text-muted-foreground">
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!isSplit && compareWith !== 'none' && (
              <div className="mt-1.5 flex items-center justify-end gap-4">
                <div className="flex items-center gap-1">
                  <div className="h-0.5 w-5 rounded" style={{ background: color }} />
                  <span className="text-xs text-muted-foreground">{td('legendCurrent')}</span>
                </div>
                <div className="flex items-center gap-1">
                  <div
                    className="h-0 w-5"
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
