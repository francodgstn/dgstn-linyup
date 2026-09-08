'use client'

/**
 * ATTENDANCE ACROSS THE SEASON — one bar per EVENT, placed on the date it ran.
 *
 * ── A TIME AXIS, NOT TWELVE CATEGORIES ──────────────────────────────────────
 * This began as a monthly total and the aggregate was the wrong unit: a
 * federation's question is "which events drew people", and a month that holds a
 * cup and a belt test answers it with one number that is neither. So each event
 * keeps its own bar, and the x axis is real TIME (`type="number"` over epoch
 * milliseconds) rather than twelve equal slots — two events a week apart sit a
 * week apart, and a quiet summer is visibly empty instead of being compressed
 * into a category that looks the same width as a busy March.
 *
 * The month ticks are supplied explicitly. Left to itself a numeric axis picks
 * round numbers, and a round number of milliseconds lands mid-month.
 *
 * ── BARS, NOT A LINE ────────────────────────────────────────────────────────
 * Each event is an independent quantity. A line between two of them invites the
 * reader to see a trend through the weeks in between, where nothing happened at
 * all — the same misreading `GrowthCard` fixed with `stepAfter`.
 *
 * ── IT COUNTS CHECK-INS, WHICH IS THE ONLY ATTENDANCE THERE IS ──────────────
 * `Event.participants_count` — people actually checked in, recounted by the
 * trigger that owns it. Not `attendees_count`, which is RSVPs: who said they
 * were coming is a different question from who came, and on migrated data the
 * second exists while the first does not.
 *
 * An event nobody attended is a REAL ZERO and stays in the series: it has no bar
 * to hover, which is the honest picture of an event with no attendance rather
 * than an omission that makes the season look busier than it was.
 *
 * ── ZERO EXTRA READS ────────────────────────────────────────────────────────
 * The events page already loads past events to list them, and the count is a
 * field on each. So this cannot go stale relative to the rows beneath it.
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

export interface AttendanceBar {
  /** Epoch ms of the event's start — the x position. */
  ts: number
  attendees: number
  title: string
  type: string
}

const toDate = (v: unknown): Date | null =>
  v && typeof v === 'object' && 'toDate' in (v as object)
    ? (v as { toDate(): Date }).toDate()
    : null

/**
 * One point per event inside the trailing window, plus the month ticks the axis
 * is drawn against.
 *
 * The window runs from the first of the month twelve months back to the first of
 * NEXT month, so an event today sits inside the domain rather than exactly on
 * its edge, where half its bar would be clipped.
 */
export function buildAttendanceBars(events: Event[], now = new Date()) {
  const windowStart = new Date(now.getFullYear(), now.getMonth() - (MONTHS_SHOWN - 1), 1)
  const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  const monthTicks: number[] = []
  for (let i = 0; i < MONTHS_SHOWN; i++) {
    monthTicks.push(new Date(now.getFullYear(), now.getMonth() - (MONTHS_SHOWN - 1) + i, 1).getTime())
  }

  const bars: AttendanceBar[] = []
  let totalAttendees = 0
  for (const e of events) {
    const start = toDate(e.start)
    if (!start || start < windowStart || start >= windowEnd) continue
    const attendees = e.participants_count ?? 0
    bars.push({
      ts: start.getTime(),
      attendees,
      title: e.title,
      type: String(e.type ?? ''),
    })
    totalAttendees += attendees
  }
  bars.sort((a, b) => a.ts - b.ts)

  return {
    bars,
    monthTicks,
    domain: [windowStart.getTime(), windowEnd.getTime()] as [number, number],
    totalAttendees,
    totalEvents: bars.length,
  }
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
  const { bars, monthTicks, domain, totalAttendees, totalEvents } = useMemo(
    () => buildAttendanceBars(events),
    [events]
  )

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
              <BarChart data={bars} margin={{ top: 4, right: 12, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                <XAxis
                  // TIME, not a category index — see the header. `ticks` are the
                  // month boundaries; without them a numeric axis picks round
                  // millisecond values, which land mid-month.
                  type="number"
                  dataKey="ts"
                  domain={domain}
                  ticks={monthTicks}
                  tickFormatter={(ts: number) => format.dateTime(new Date(ts), { month: 'short' })}
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
                  // The row is one sentence, not a name/value pair, so there is
                  // nothing for a separator to sit between. Recharts prints its
                  // default " : " regardless of an empty series name, which read
                  // as ": 42 checked in".
                  separator=""
                  contentStyle={{
                    background: 'var(--color-popover)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  // The EVENT is the headline, because that is what a bar is
                  // now. The date is the subtitle the label formatter cannot
                  // carry, so it rides on the value line.
                  labelFormatter={(_ts, payload) => payload?.[0]?.payload?.title ?? ''}
                  formatter={(value, _name, item) => [
                    t('trendTooltip', {
                      attendees: Number(value),
                      date: format.dateTime(new Date(Number(item?.payload?.ts ?? 0)), {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      }),
                    }),
                    '',
                  ]}
                />
                {/* A FIXED WIDTH, because a numeric axis has no category to
                    divide: recharts would otherwise size every bar from the
                    smallest gap between two events, so one busy weekend would
                    make the whole season hairline-thin. */}
                <Bar
                  dataKey="attendees"
                  fill="var(--color-primary)"
                  radius={[3, 3, 0, 0]}
                  barSize={9}
                  // No entry animation: recharts grows a bar from zero over
                  // 1.5s, and the bars measured 1-9px of their true height for
                  // as long as the tab was throttled. A chart whose painted
                  // frames read "no attendance" is worse than one that appears.
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
