'use client'

/**
 * THE TRENDS — carried over by instruction, and the one place cards are right.
 *
 * A chart needs a plotting surface, so it gets a frame; that was settled before
 * this lane started and nothing here relitigates it. The four existing cards are
 * imported as they are — this page competes on COMPOSITION, not on redrawing
 * charts that already work.
 *
 * What is different is where they sit and how they are introduced. On the
 * incumbent every block is announced by the same tinted section band, because a
 * page with eight sections needs a repeated idiom to stay legible. This page has
 * ONE section heading in total, so it needs no idiom: a hairline, a title, and
 * the two controls on the same line. A band that appears once is chrome.
 *
 * Below the fold, deliberately. Nothing here is a morning question.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { TrendingUp } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDashboardData } from '@/hooks/useDashboardData'
import { ContactsSummaryCard } from '@/components/dashboard/ContactsSummaryCard'
import { BookingsTrendCard } from '@/components/dashboard/BookingsTrendCard'
import { TopActivitiesCard } from '@/components/dashboard/TopActivitiesCard'
import { SessionsHeatmapCard } from '@/components/dashboard/SessionsHeatmapCard'
import { ActivitiesTrendCard } from '@/components/dashboard/ActivitiesTrendCard'
import { DemographicsTrendCard } from '@/components/dashboard/DemographicsTrendCard'
import type { Contact } from '@linyup/shared'

type CompareWith = 'none' | 'prev_period' | 'last_year'
const WEEKS_OPTIONS = [4, 8, 13, 26, 52]

function TrendControls({
  weeks,
  onWeeks,
  compare,
  onCompare,
}: {
  weeks: number
  onWeeks: (n: number) => void
  compare: CompareWith
  onCompare: (c: CompareWith) => void
}) {
  const t = useTranslations('NewDashboard')
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Select value={String(weeks)} onValueChange={(v) => onWeeks(Number(v))}>
        <SelectTrigger className="h-7 w-[104px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WEEKS_OPTIONS.map((w) => (
            <SelectItem key={w} value={String(w)}>
              {t('trendsWeeksOption', { weeks: w })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={compare} onValueChange={(v) => onCompare(v as CompareWith)}>
        <SelectTrigger className="h-7 w-[168px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('trendsCompareNone')}</SelectItem>
          <SelectItem value="prev_period">{t('trendsComparePrev')}</SelectItem>
          <SelectItem value="last_year">{t('trendsCompareLastYear')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function WeekSection({
  teamId,
  contacts,
}: {
  teamId: string | null
  /** Passed down rather than re-fetched: the page already holds the roster on
   *  the contacts page's cache entry, and a second hook here with different
   *  arguments would be a second QUERY, not a second reader. */
  contacts?: Contact[]
}) {
  const t = useTranslations('NewDashboard')
  const [weeks, setWeeks] = useState(13)
  const [compare, setCompare] = useState<CompareWith>('none')
  const data = useDashboardData(teamId, weeks, compare)

  const shared = { trendsWeeks: weeks, compareWith: compare }

  // No history means no trend at any width. Say it once instead of drawing four
  // flat lines that read as broken charts.
  const noHistory =
    !data.isLoading && data.weeklyReports.length === 0 && data.sessions.length === 0

  return (
    <section className="space-y-4">
      {/* The range and comparison sit BESIDE the heading, not opposite it.
          Pushed to the far right they read as page chrome and are separated
          from the word they qualify by the full width of the page; next to
          "Trends" they read as part of the title — thirteen weeks OF trends,
          compared WITH last year. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
        <h2 className="font-heading text-base font-bold tracking-tight text-heading">
          {t('trendsTitle')}
        </h2>
        {!noHistory && (
          <TrendControls
            weeks={weeks}
            onWeeks={setWeeks}
            compare={compare}
            onCompare={setCompare}
          />
        )}
      </div>

      {noHistory ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <TrendingUp className="h-7 w-7 text-muted-foreground/40" />
            <p className="text-sm font-medium">{t('trendsNoHistoryTitle')}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t('trendsNoHistoryBody')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <ContactsSummaryCard
            weeklyReports={data.weeklyReports}
            comparisonWeeklyReports={data.comparisonWeeklyReports}
            subscriptionTypes={data.subscriptionTypes}
            {...shared}
          />
          <BookingsTrendCard
            sessions={data.sessions}
            allBookings={data.allBookings}
            newContactBookings={data.newContactBookings}
            weeklyReports={data.weeklyReports}
            comparisonWeeklyReports={data.comparisonWeeklyReports}
            comparisonSessions={data.comparisonSessions}
            comparisonAllBookings={data.comparisonAllBookings}
            comparisonNewContactBookings={data.comparisonNewContactBookings}
            {...shared}
          />
          <TopActivitiesCard
            sessions={data.sessions}
            allBookings={data.allBookings}
            newContactBookings={data.newContactBookings}
            activities={data.activities}
            comparisonSessions={data.comparisonSessions}
            comparisonAllBookings={data.comparisonAllBookings}
            comparisonNewContactBookings={data.comparisonNewContactBookings}
            compareWith={compare}
          />
          <SessionsHeatmapCard
            sessions={data.sessions}
            newContactBookings={data.newContactBookings}
            compareWith={compare}
            comparisonSessions={data.comparisonSessions}
            comparisonNewContactBookings={data.comparisonNewContactBookings}
          />
          {/* `TopActivitiesCard` above ranks activities over the window; this
              plots the same measure through it. Ranking answers what is
              popular, the curve answers what is growing — neither substitutes
              for the other, which is why both are here. */}
          <ActivitiesTrendCard
            sessions={data.sessions}
            comparisonSessions={data.comparisonSessions}
            activities={data.activities}
            {...shared}
          />
          {/* The one trend NOT backed by weekly reports — see its header. It
              needs the roster, so it is the only card here that takes anything
              the dashboard data hook does not return. */}
          <DemographicsTrendCard contacts={contacts} trendsWeeks={weeks} />
        </div>
      )}
    </section>
  )
}
