'use client'

/**
 * WHO THE STUDIO IS COACHING, OVER TIME.
 *
 * The contacts snapshot answers "who is here now". This answers "who has been
 * arriving" — a kids programme that has quietly become a teens programme is
 * invisible in a snapshot and obvious in a trend.
 *
 * ── IT READS CONTACTS, NOT WEEKLY REPORTS ───────────────────────────────────
 *
 * Every other trend on this page reads `team_weekly_reports`, and this one
 * deliberately does not: no report has ever carried a demographic field, so a
 * report-backed version would start empty today and stay empty for a year —
 * useless to exactly the migrated clubs with five years of history.
 *
 * It does not need one. A past week's answer is DETERMINED by facts each
 * contact already carries:
 *
 *   who was here     `created_at` on or before the week's end, and not archived
 *                    or deleted by then. Both are real dates.
 *   how old they were  `birthdate` and the week's end — the age is computed AT
 *                    THAT WEEK, which is the whole point: a 14-year-old in 2022
 *                    is in the teens band in 2024, and a trend that used today's
 *                    age would slide the entire history up the bands.
 *
 * ── WHY THERE IS NO LEVEL DIMENSION ─────────────────────────────────────────
 *
 * The snapshot offers age, gender AND level. This card offers age and gender.
 *
 * A rank has NO HISTORY in the data. `Contact.ranks` is a current value with no
 * promotion ledger behind it (that ledger is planned, not built), so the only
 * available answer for 2022 is today's belt — which would draw every contact as
 * having held their current rank since the day they joined, and show promotions
 * that never happened on dates they did not happen. It is the same refusal the
 * weekly-report backfill makes for `bookings_count` and subscription counts:
 * a field with no history is not a trend, and a plausible line is worse than a
 * missing one because nobody can tell it is wrong.
 *
 * Add the dimension when `rank_promotions` exists; not before.
 *
 * ── GENDER IS A CURRENT VALUE APPLIED BACKWARDS ─────────────────────────────
 *
 * Unlike age it is not recomputed per week, because nothing records when it was
 * set or changed. A correction made today therefore reads back through the whole
 * history. That is acceptable — it is a correction, and the alternative is no
 * dimension at all — but it is not the same kind of fact as the age curve, and
 * it should not be described as one.
 */

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Users } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Contact } from '@linyup/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChartEmptyState } from './ChartEmptyState'
import { buildWeekKeys, formatAxisWeek, formatTooltipWeek, isoWeekToDate, shortWeekLabel } from '@/lib/isoWeek'
import { endOfISOWeek } from 'date-fns'

/** Same bands and colours as the contacts snapshot, so the two agree on sight. */
const AGE_GROUPS = [
  { key: 'demoAgeKids', min: 5, max: 9, color: '#4ADE80' },
  { key: 'demoAgeYouth', min: 10, max: 14, color: '#60A5FA' },
  { key: 'demoAgeTeens', min: 15, max: 17, color: '#A78BFA' },
  { key: 'demoAgeAdults', min: 18, max: 39, color: '#F59E0B' },
  { key: 'demoAgeMasters', min: 40, max: 999, color: '#F97316' },
] as const

const GENDER_CONFIG = [
  { key: 'F', tKey: 'gender_F', color: '#EC4899' },
  { key: 'M', tKey: 'gender_M', color: '#3B82F6' },
  { key: 'other', tKey: 'gender_other', color: '#9CA3AF' },
] as const

const YEAR_MS = 365.25 * 24 * 3600 * 1000

function tsToMs(ts: unknown): number | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: unknown }).toDate === 'function')
    return (ts as { toDate(): Date }).toDate().getTime()
  if (typeof (ts as { seconds?: unknown }).seconds === 'number')
    return (ts as { seconds: number }).seconds * 1000
  return null
}

function birthMs(b: unknown): number | null {
  if (!b) return null
  if (typeof b === 'string') {
    const t = new Date(b).getTime()
    return Number.isNaN(t) ? null : t
  }
  return tsToMs(b)
}

/** The one fact each contact contributes, reduced once so the per-week loop is
 *  arithmetic rather than a re-read of Firestore timestamp wrappers. */
interface Facts {
  created: number | null
  gone: number | null
  birth: number | null
  gender: string | null
}

/** The last instant of the week a key names.
 *
 *  `isoWeekToDate` promises only A DATE INSIDE that week (date-fns `parse` with
 *  no weekday token), not its Monday — so the end is taken with `endOfISOWeek`
 *  rather than by adding six days, which would land on the wrong instant the
 *  moment that promise changed. */
function weekEndMs(isoWeek: string): number {
  return endOfISOWeek(isoWeekToDate(isoWeek)).getTime()
}

type Dimension = 'age' | 'gender'

interface Props {
  contacts?: Contact[]
  trendsWeeks?: number
  title?: string
}

export function DemographicsTrendCard({ contacts = [], trendsWeeks = 13, title }: Props) {
  const td = useTranslations('Dashboard')
  const tc = useTranslations('Contacts')
  const [dimension, setDimension] = useState<Dimension>('age')

  const facts: Facts[] = useMemo(
    () =>
      contacts.map((c) => {
        const archived = tsToMs((c as { archived_at?: unknown }).archived_at)
        const deleted = tsToMs((c as { deleted_at?: unknown }).deleted_at)
        return {
          created: tsToMs((c as { created_at?: unknown }).created_at),
          gone:
            archived !== null && deleted !== null
              ? Math.min(archived, deleted)
              : (archived ?? deleted),
          birth: birthMs((c as { birthdate?: unknown }).birthdate),
          gender: (c as { gender?: string | null }).gender ?? null,
        }
      }),
    [contacts],
  )

  const series = useMemo(
    () =>
      dimension === 'age'
        ? AGE_GROUPS.map((g) => ({ value: g.key, label: td(g.key), color: g.color }))
        : GENDER_CONFIG.map((g) => ({ value: g.key, label: tc(g.tKey), color: g.color })),
    [dimension, td, tc],
  )

  const chartData = useMemo(() => {
    const weekKeys = buildWeekKeys(trendsWeeks, 0)
    return weekKeys.map((key, idx) => {
      const at = weekEndMs(key)
      const pt: Record<string, unknown> = { week: key, label: shortWeekLabel(key, weekKeys[idx - 1]) }
      for (const s of series) pt[s.value] = 0
      for (const f of facts) {
        if (f.created === null || f.created > at) continue
        if (f.gone !== null && f.gone <= at) continue
        if (dimension === 'age') {
          // Age AT THAT WEEK — see the header on why not today's age.
          if (f.birth === null) continue
          const age = Math.floor((at - f.birth) / YEAR_MS)
          const band = AGE_GROUPS.find((g) => age >= g.min && age <= g.max)
          if (band) pt[band.key] = (pt[band.key] as number) + 1
        } else {
          const g = GENDER_CONFIG.find((x) => x.key === f.gender)
          if (g) pt[g.key] = (pt[g.key] as number) + 1
        }
      }
      return pt
    })
  }, [facts, series, dimension, trendsWeeks])

  const hasData = (chartData as Record<string, unknown>[]).some((d) =>
    series.some((s) => ((d[s.value] as number) ?? 0) > 0),
  )

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="flex-1">{title || td('chartTitleDemographics')}</CardTitle>
          <Select
            value={dimension}
            onValueChange={(v) => {
              if (v) setDimension(v as Dimension)
            }}
          >
            <SelectTrigger size="sm" className="w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="age">{td('demoViewAge')}</SelectItem>
              <SelectItem value="gender">{td('demoViewGender')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          {dimension === 'age' ? td('demoTrendAgeHint') : td('demoTrendGenderHint')}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col pb-4 pt-3">
        {!hasData ? (
          <ChartEmptyState
            icon={Users}
            title={td('chartEmptyTitle')}
            hint={dimension === 'age' ? td('demoEmptyAge') : td('demoEmptyGender')}
          />
        ) : (
          <div className="mt-auto">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData as object[]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  {series.map((s) => (
                    <linearGradient key={s.value} id={`gradDemo_${s.value}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={s.color} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={s.color} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                <XAxis
                  dataKey="week"
                  tickFormatter={formatAxisWeek}
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} tickCount={5} />
                <Tooltip content={<DemographicsTooltip series={series} />} />
                {/* STACKED, unlike the other trends: the bands partition the
                    roster, so the stack's top edge is the population that
                    answered — a fact worth showing, and one separate lines
                    leave the reader to add up. */}
                {series.map((s) => (
                  <Area
                    key={s.value}
                    type="monotone"
                    dataKey={s.value}
                    stackId="demo"
                    stroke={s.color}
                    strokeWidth={1.5}
                    fill={`url(#gradDemo_${s.value})`}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>

            <div className="mt-1.5 flex flex-wrap justify-center gap-3">
              {series.map((s) => (
                <div key={s.value} className="flex items-center gap-1">
                  <div className="h-0.5 w-4 rounded" style={{ background: s.color }} />
                  <span className="text-xs text-muted-foreground">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DemographicsTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean
  payload?: { dataKey: string; value: number }[]
  label?: string
  series?: { value: string; label: string; color: string }[]
}) {
  const t = useTranslations('Dashboard')
  if (!active || !payload?.length || !label || !series) return null
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0)
  return (
    <div className="max-w-[220px] rounded-lg border bg-background p-3 text-xs shadow-lg">
      <p className="mb-1.5 font-bold">{formatTooltipWeek(label)}</p>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.value)
        if (!p || !p.value) return null
        return (
          <div key={s.value} className="mt-0.5 flex items-center gap-1.5">
            <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="flex-1 truncate">{s.label}</span>
            <span className="font-bold">{p.value}</span>
          </div>
        )
      })}
      <div className="mt-1.5 flex items-center gap-1.5 border-t pt-1.5 text-muted-foreground">
        <span className="flex-1">{t('demoTrendTotal')}</span>
        <span className="font-bold">{total}</span>
      </div>
    </div>
  )
}
