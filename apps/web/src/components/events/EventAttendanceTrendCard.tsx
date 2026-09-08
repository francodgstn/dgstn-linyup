'use client'

/**
 * ATTENDANCE ACROSS THE SEASON — how many people the federation's events drew,
 * month by month, for the last twelve.
 *
 * ── BARS, NOT A LINE ────────────────────────────────────────────────────────
 * Each month is an INDEPENDENT TOTAL, not a running one: 60 people in March and
 * 40 in April is 60 then 40, and a line drawn between them invites the reader to
 * see a decline through the weeks in between, where nothing happened at all
 * because there was no event. The same misreading `GrowthCard` fixed with
 * `stepAfter` — bars are the shape that says "these are buckets".
 *
 * A month with no event is a REAL ZERO and is drawn, rather than dropped. A
 * federation's calendar has quiet months by design (a summer with one camp in
 * it), and omitting them would compress the axis until the season looked
 * continuous.
 *
 * ── IT COUNTS CHECK-INS, WHICH IS THE ONLY ATTENDANCE THERE IS ──────────────
 * `Event.participants_count` — the number of people actually checked in,
 * recounted by the trigger that owns it. Not `attendees_count`, which is RSVPs:
 * who said they were coming is a different question from who came, and on
 * migrated data the second exists while the first does not.
 *
 * ── ZERO EXTRA READS ────────────────────────────────────────────────────────
 * The events page already loads past events to list them, and the count is a
 * field on each. So this cannot go stale relative to the rows beneath it, and it
 * costs nothing to show.
 */

import { useMemo } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { CalendarDays } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartEmptyState } from '@/components/dashboard/ChartEmptyState'
import type { Event } from '@linyup/shared'

const MONTHS_SHOWN = 12

export interface AttendancePoint {
  /** First day of the month — the locale formats the label from it. */
  date: Date
  /** People checked in across every event that started in this month. */
  attendees: number
  /** How many events those came from, for the tooltip. */
  events: number
}

const toDate = (v: unknown): Date | null =>
  v && typeof v === 'object' && 'toDate' in (v as object)
    ? (v as { toDate(): Date }).toDate()
    : null

/**
 * Attendance per month over the trailing window, plus the totals inside it.
 *
 * Events OUTSIDE the window are excluded rather than folded into the first
 * bucket — unlike a cumulative series, an opening balance would be a lie here:
 * a camp in 2022 did not happen last September.
 */
export function buildAttendanceSeries(events: Event[], now = new Date()) {
  const months: AttendancePoint[] = []
  for (let i = MONTHS_SHOWN - 1; i >= 0; i--) {
    months.push({
      date: new Date(now.getFullYear(), now.getMonth() - i, 1),
      attendees: 0,
      events: 0,
    })
  }
  const index = new Map(months.map((m, i) => [`${m.date.getFullYear()}-${m.date.getMonth()}`, i]))

  let totalAttendees = 0
  let totalEvents = 0
  for (const e of events) {
    const start = toDate(e.start)
    if (!start) continue
    const slot = index.get(`${start.getFullYear()}-${start.getMonth()}`)
    if (slot === undefined) continue
    const n = e.participants_count ?? 0
    months[slot].attendees += n
    months[slot].events += 1
    totalAttendees += n
    totalEvents += 1
  }

  return { months, totalAttendees, totalEvents }
}

export function EventAttendanceTrendCard({
  events,
  loading = false,
}: {
  events: Event[]
  loading?: boolean
}) {
  const t = useTranslations('OrgEvents')
  const format = useFormatter()
  const { months, totalAttendees, totalEvents } = useMemo(
    () => buildAttendanceSeries(events),
    [events]
  )

  const data = months.map((m) => ({
    label: format.dateTime(m.date, { month: 'short' }),
    full: format.dateTime(m.date, { month: 'long', year: 'numeric' }),
    attendees: m.attendees,
    events: m.events,
  }))

  return (
    <Card className="min-h-[248px]">
      <CardHeader>
        <CardTitle className="text-sm">{t('trendTitle')}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {t('trendSubtitle', { attendees: totalAttendees, events: totalEvents })}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {loading ? (
          <Skeleton className="h-[160px] w-full" />
        ) : totalEvents === 0 ? (
          <ChartEmptyState
            icon={CalendarDays}
            title={t('trendEmptyTitle')}
            hint={t('trendEmptyHint')}
          />
        ) : (
          <div className="h-[160px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                />
                <YAxis
                  allowDecimals={false}
                  // `dataMax` rather than recharts' padded default, for the
                  // reason GrowthCard records: a small real number drawn against
                  // an invented ceiling reads as a shortfall against a target.
                  domain={[0, 'dataMax']}
                  width={40}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                />
                <Tooltip
                  cursor={{ fill: 'var(--color-muted)', opacity: 0.4 }}
                  contentStyle={{
                    background: 'var(--color-popover)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(_label, payload) => payload?.[0]?.payload?.full ?? ''}
                  formatter={(value, _name, item) => [
                    t('trendTooltip', {
                      attendees: Number(value),
                      events: Number(item?.payload?.events ?? 0),
                    }),
                    '',
                  ]}
                />
                {/* NO ENTRY ANIMATION. Recharts grows a bar from zero height
                    over 1.5s, and a chart whose first painted frames are empty
                    is one a reader can genuinely catch reading "no attendance"
                    — the bars measured 1-9px of their real height for as long
                    as the tab was throttled. A twelve-bar summary is read at a
                    glance; there is nothing here worth animating. */}
                <Bar
                  dataKey="attendees"
                  fill="var(--color-primary)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={28}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
