'use client'

// WHEN DOES THIS ACTUALLY RUN? — the question the activities page could not
// answer about its own rows.
//
// An activity is a TEMPLATE. Nothing on the list says whether it is on the
// calendar, so an activity with no sessions behind it looks perfectly configured
// and is invisible to every visitor. The page already admitted this in a comment
// and sent people to the Schedule to find out; the Schedule answers a different
// question (what is on this week) and makes you filter your way back. This is
// the activity's own answer.
//
// ── GROUPED BY SERIES, NOT LISTED BY DATE ────────────────────────────────────
// A flat list of the next fifty sessions of a weekly class is fifty rows saying
// the same thing, and the one fact worth having — "Tuesdays 18:00, until
// February" — is not on any of them. So sessions are grouped by `seriesId`: each
// group is a recurring pattern, rendered through `SeriesSummary` (the existing
// component that turns a series document into that sentence) with its next few
// dates underneath. Anything without a `seriesId` is a one-off and gets its own
// list.
//
// ── WHY IT READS SESSIONS AND NOT session_series ─────────────────────────────
// A series is materialized into real `sessions` documents six months ahead
// (SERIES_HORIZON_MONTHS, rolled by the daily task), so the sessions collection
// already contains every occurrence anyone can book. Expanding recurrence rules
// here would be a second implementation of the one materialization path, and it
// would disagree with the calendar the first time a single occurrence was
// edited or canceled. Reading what was actually written cannot drift.
//
// Note this is also why a PAUSED or ENDED series simply stops appearing: its
// occurrences are in the past or were never generated. That is the truth the
// studio wants — "is anything scheduled" — not "does a series document exist".

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, limit, orderBy, query, where, Timestamp } from 'firebase/firestore'
import { CalendarDays, Clock, MapPin, Repeat2 } from 'lucide-react'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { db } from '@/lib/firebase'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { SeriesSummary } from '@/components/sessions/SeriesSummary'
import { SESSIONS_COLLECTION, type Activity, type Session } from '@linyup/shared'

/** Enough to show several occurrences of every pattern an activity runs, without
 *  turning a busy class into an unbounded read. The footer links to the Schedule
 *  for the full picture. */
const PREVIEW_LIMIT = 60
/** Dates shown per recurring group before "+ n more". Four is two rows of two on
 *  a narrow sheet and answers "is it on next week" without becoming a list. */
const DATES_PER_SERIES = 4

/**
 * Upcoming sessions for one activity.
 *
 * REQUIRES the composite index `sessions (teamId, activityId, start)` — added in
 * firestore.index.json with this component. The pre-existing
 * `(teamId, activityId, allowBooking, start)` does NOT serve this query:
 * Firestore needs the index's equality fields to match the query's exactly
 * before the range field, and `allowBooking` sits in between. Adding
 * `allowBooking == true` would have reused it for free and been wrong — a
 * manager asking what is scheduled means everything, including the sessions that
 * are not open for online booking.
 */
function useActivitySessions(teamId: string | null, activityId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['sessions', 'by-activity', teamId, activityId],
    enabled: enabled && !!teamId && !!activityId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('activityId', '==', activityId),
          where('start', '>=', Timestamp.fromDate(new Date())),
          orderBy('start', 'asc'),
          limit(PREVIEW_LIMIT)
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Session)
    },
  })
}

interface Group {
  seriesId: string | null
  sessions: Session[]
}

/** Group by series, preserving the date order the query returned so the first
 *  group is the pattern that runs soonest. */
function groupBySeries(sessions: Session[]): { series: Group[]; oneOffs: Session[] } {
  const bySeries = new Map<string, Session[]>()
  const oneOffs: Session[] = []
  for (const s of sessions) {
    if (s.seriesId) bySeries.set(s.seriesId, [...(bySeries.get(s.seriesId) ?? []), s])
    else oneOffs.push(s)
  }
  return {
    series: [...bySeries.entries()].map(([seriesId, list]) => ({ seriesId, sessions: list })),
    oneOffs,
  }
}

function fmtDate(ts: { toDate(): Date } | undefined) {
  return (
    ts?.toDate().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) ?? ''
  )
}
function fmtTime(ts: { toDate(): Date } | undefined) {
  return ts?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? ''
}

function SessionLine({ session }: { session: Session }) {
  return (
    <Link
      href={`/sessions/${session.id}` as Route}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent"
    >
      <span className="font-medium">{fmtDate(session.start)}</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        <Clock className="h-3 w-3 shrink-0" />
        {fmtTime(session.start)}
      </span>
      {session.location && (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <MapPin className="h-3 w-3 shrink-0" />
          <span className="truncate">{session.location}</span>
        </span>
      )}
    </Link>
  )
}

export function ActivityScheduleSheet({
  activity,
  open,
  onOpenChange,
  teamId,
}: {
  activity: Activity | null
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string | null
}) {
  const t = useTranslations('Activities')
  const { data: sessions = [], isLoading } = useActivitySessions(
    teamId,
    activity?.id ?? null,
    open
  )

  const { series, oneOffs } = useMemo(() => groupBySeries(sessions), [sessions])
  const nothing = !isLoading && sessions.length === 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-md gap-0 p-0"
      >
        <SheetHeader className="shrink-0 border-b p-4 pr-12">
          <SheetTitle className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" />
            {activity?.name}
          </SheetTitle>
          <SheetDescription>{t('scheduleSheetSubtitle')}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </div>
          )}

          {/* THE EMPTY STATE IS THE FEATURE. This is the case the activities
              page could not show: configured, looks finished, on nobody's
              calendar. It says so and offers the fix. */}
          {nothing && (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <CalendarDays className="mx-auto h-7 w-7 text-muted-foreground/40" />
              <p className="mt-2 text-sm font-medium">{t('scheduleSheetEmptyTitle')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('scheduleSheetEmptyBody')}</p>
              <Link
                href={'/schedule' as Route}
                className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
              >
                {t('scheduleSheetEmptyCta')}
              </Link>
            </div>
          )}

          {series.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('scheduleSheetRecurring')}
              </h3>
              {series.map((g) => (
                <div key={g.seriesId} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-primary">
                    <Repeat2 className="h-3.5 w-3.5 shrink-0" />
                    {/* The pattern sentence — "Weekly · until 14 Feb 2027" —
                        from the series document. The fallback covers a series
                        doc deleted out from under its sessions. */}
                    <SeriesSummary
                      seriesId={g.seriesId!}
                      fallback={t('scheduleSheetRecurringFallback')}
                    />
                  </div>
                  <div className="mt-1.5 -mx-2">
                    {g.sessions.slice(0, DATES_PER_SERIES).map((s) => (
                      <SessionLine key={s.id} session={s} />
                    ))}
                  </div>
                  {g.sessions.length > DATES_PER_SERIES && (
                    <p className="px-2 pt-1 text-xs text-muted-foreground">
                      {t('scheduleSheetMore', { count: g.sessions.length - DATES_PER_SERIES })}
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}

          {oneOffs.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('scheduleSheetOneOff')}
              </h3>
              <div className="-mx-2 rounded-lg border p-1">
                {oneOffs.map((s) => (
                  <SessionLine key={s.id} session={s} />
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="shrink-0 border-t bg-muted/20 p-4">
          <Link
            href={'/schedule' as Route}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <CalendarDays className="h-3.5 w-3.5 shrink-0" />
            {t('scheduleSheetOpenSchedule')}
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  )
}
