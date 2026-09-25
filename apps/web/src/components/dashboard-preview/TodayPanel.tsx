'use client'

/**
 * THE DAY — the one primary block on this page.
 *
 * The question this dashboard is designed around is "what does a studio need to
 * see when it opens the app in the morning?", and the honest first answer is
 * not a number: it is the hours it is about to run. So the day gets the widest
 * column, the tallest body and the top of the fold, and nothing else on the
 * page is allowed to be as large.
 *
 * Three things it does that a list of session titles does not:
 *
 *  1. **A SEAT METER, not a badge.** "12" is a fact; "12/16" with a bar is the
 *     answer to the question actually being asked — is this class filling, full,
 *     or empty enough to promote. A session with no cap shows the count alone
 *     rather than a bar it cannot fill.
 *  2. **NOW IS MARKED.** The next session that has not started carries a left
 *     rule and the minutes until it starts; sessions already finished are
 *     dimmed. A day view whose past and future look identical makes the reader
 *     do the clock arithmetic that the page is holding the clock for.
 *  3. **The day IS the title.** The navigator is two arrows and a reset, not a
 *     row of its own — the panel header already had to say something.
 */

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { ArrowRight, CalendarPlus, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import type { Session } from '@linyup/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Panel, PanelBody, PanelHeader } from './Panel'
import { usePreviewSessionsForDay, startOfToday } from './preview-data'

function toDate(ts: { toDate(): Date } | null | undefined): Date | null {
  return ts ? ts.toDate() : null
}

function SeatMeter({ session, state }: { session: Session; state: 'past' | 'next' | 'later' }) {
  const t = useTranslations('NewDashboard')
  const booked = session.bookings_count ?? 0
  const cap = session.max_participants ?? null
  const trials = session.trial_bookings_count ?? 0
  // BOOKED AND ATTENDED ARE DIFFERENT QUESTIONS, and the row was answering only
  // the first for every session including the ones that already happened —
  // so a class where nobody turned up read identically to a full one.
  //
  // Before it starts, booked is the only fact there is. Once it is past, the
  // number worth seeing is who actually came, so the meter switches: attended
  // becomes the figure and booked is what it is measured against.
  const attended = session.participants_count ?? 0
  const showAttendance = state === 'past'
  const primary = showAttendance ? attended : booked
  const against = showAttendance ? booked : cap
  const full = cap != null && cap > 0 && booked >= cap
  const pct = cap && cap > 0 ? Math.min(100, Math.round((booked / cap) * 100)) : 0

  return (
    <div className="w-[74px] shrink-0 text-right">
      <p className="text-sm font-semibold leading-none tabular-nums">
        {against != null && against > 0 ? `${primary}/${against}` : primary}
      </p>
      {showAttendance ? (
        <p className="mt-0.5 text-xs leading-none text-muted-foreground">{t('seatsAttended')}</p>
      ) : cap != null && cap > 0 ? (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', full ? 'bg-amber-500' : 'bg-primary')}
            style={{ width: `${Math.max(pct, booked > 0 ? 6 : 0)}%` }}
          />
        </div>
      ) : (
        <p className="mt-0.5 text-xs leading-none text-muted-foreground">{t('seatsBooked')}</p>
      )}
      {trials > 0 && (
        <p className="mt-1 text-xs leading-none text-emerald-600">
          {t('seatsTrials', { count: trials })}
        </p>
      )}
    </div>
  )
}

/**
 * "In 962 min" was the FIRST THING a studio owner read every morning, and it is
 * not how anybody says half past four (Franco, 2026-08-28).
 *
 * Minutes are right up to an hour and useless past it: the number stops being a
 * duration you can feel and becomes arithmetic homework. Above an hour the
 * coarse unit leads and the fine one only appears when it says something — "In
 * 16h" reads better than "In 16h 0min", and nobody needs "In 16h 02min" to the
 * minute at that distance.
 *
 * IT NEVER NEEDS DAYS. The countdown is only ever rendered for the session
 * marked `next`, which exists only when the panel is showing TODAY (`offset ===
 * 0`, see `nextIndex`), so the largest possible value is one minute short of a
 * day. If that ever changes this needs a days branch — it will not silently do
 * the right thing.
 */
function countdownLabel(
  minutesUntil: number,
  t: ReturnType<typeof useTranslations<'NewDashboard'>>
): string {
  if (minutesUntil < 1) return t('startingNow')
  if (minutesUntil < 60) return t('startsIn', { minutes: minutesUntil })
  const hours = Math.floor(minutesUntil / 60)
  const minutes = minutesUntil % 60
  return minutes === 0
    ? t('startsInHours', { hours })
    : t('startsInHoursMinutes', { hours, minutes })
}

function SessionRow({
  session,
  state,
  minutesUntil,
}: {
  session: Session
  state: 'past' | 'next' | 'later'
  minutesUntil: number | null
}) {
  const t = useTranslations('NewDashboard')
  const start = toDate(session.start)
  const time = start ? start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const meta = [session.providerName, session.location].filter(Boolean).join(' · ')

  return (
    <Link
      href={`/sessions/${session.id}` as Route}
      className={cn(
        'flex items-center gap-2.5 rounded-lg py-2 pr-2 transition-colors hover:bg-muted/60',
        state === 'past' && 'opacity-50'
      )}
    >
      {/* The now-marker. A 2px rule, present on every row so nothing shifts. */}
      <span
        className={cn(
          'h-9 w-[3px] shrink-0 rounded-full',
          state === 'next' ? 'bg-primary' : 'bg-transparent'
        )}
      />
      <div className="w-11 shrink-0 text-right">
        <p className="text-sm font-semibold leading-none tabular-nums">{time}</p>
        {session.duration_minutes ? (
          <p className="mt-1 text-xs leading-none text-muted-foreground tabular-nums">
            {t('durationMinutes', { minutes: session.duration_minutes })}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">
          {session.activityName ?? t('sessionFallback')}
        </p>
        <p className="truncate text-xs leading-tight text-muted-foreground">
          {state === 'next' && minutesUntil !== null && minutesUntil >= 0 ? (
            <span className="font-medium text-primary">
              {countdownLabel(minutesUntil, t)}
              {meta ? ' · ' : ''}
            </span>
          ) : null}
          {meta}
        </p>
      </div>
      <SeatMeter session={session} state={state} />
    </Link>
  )
}

export function TodayPanel({ teamId }: { teamId: string | null }) {
  const t = useTranslations('NewDashboard')
  const locale = useLocale()
  const [offset, setOffset] = useState(0)

  const day = useMemo(() => {
    const d = startOfToday()
    d.setDate(d.getDate() + offset)
    return d
  }, [offset])

  const { data: sessions, isLoading } = usePreviewSessionsForDay(teamId, day)

  // Read once per render: two clock reads a few lines apart can disagree, and
  // "next up" and "already finished" must be decided against the same instant.
  const nowMs = Date.now()
  const rows = sessions ?? []

  // The next session that has not started yet — only meaningful on today.
  // Deliberately not memoised: it depends on the clock, so a memo keyed on the
  // clock recomputes every render anyway and only adds a dependency to get
  // wrong.
  const nextIndex =
    offset === 0
      ? rows.findIndex((s) => {
          const start = toDate(s.start)
          return !!start && start.getTime() >= nowMs
        })
      : -1

  const dayLabel =
    offset === 0
      ? t('dayToday')
      : offset === 1
        ? t('dayTomorrow')
        : day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' })

  const booked = rows.reduce((sum, s) => sum + (s.bookings_count ?? 0), 0)
  // Only counted for sessions that have finished — an attended tally that
  // included this evening's classes would read as a turnout nobody has had yet.
  const attended = rows.reduce(
    (sum, s) =>
      (toDate(s.start)?.getTime() ?? 0) < nowMs ? sum + (s.participants_count ?? 0) : sum,
    0
  )
  const meta = isLoading
    ? ''
    : rows.length === 0
      ? ''
      : [
          t('metaSessions', { count: rows.length }),
          t('metaBooked', { count: booked }),
          // Appended only once somebody has actually turned up — a "0 attended"
          // on a day that has not started yet is a fact about the clock, not
          // about the studio, and reads like a bad morning.
          ...(attended > 0 ? [t('metaAttended', { count: attended })] : []),
        ].join(' · ')

  const navButton =
    'rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

  return (
    <Panel>
      <PanelHeader
        title={<span className="capitalize">{dayLabel}</span>}
        meta={meta}
        // THE STEPPER LEADS, before the day it steps (Franco, 2026-08-21).
        // It sat on the right, sharing a cluster with "back to today" and the
        // link out — three controls that do three different things. The
        // schedule calendar has always put `[<] [>]` in front of the range
        // label it moves and left `Today` on the other side, so this is the
        // same bar arranged the same way, and a chevron in front of a date now
        // means the same thing on both screens.
        lead={
          <>
            <button
              type="button"
              onClick={() => setOffset((o) => o - 1)}
              aria-label={t('prevDay')}
              className={navButton}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setOffset((o) => o + 1)}
              aria-label={t('nextDay')}
              className={navButton}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </>
        }
        action={
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Stays on the RIGHT, with the way out — it is the calendar's
                `Today` button, which lives on that side there too. */}
            {offset !== 0 && (
              <button
                type="button"
                onClick={() => setOffset(0)}
                aria-label={t('backToToday')}
                className={navButton}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            <Link
              href={'/schedule' as Route}
              className="ml-1 flex items-center gap-0.5 text-xs text-primary hover:underline"
            >
              {t('openSchedule')}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        }
      />
      <PanelBody>
        {isLoading ? (
          <div className="space-y-3 p-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-11" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-3.5 w-12" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          /* AN EMPTY DAY IS A REAL DAY. It offers the one thing a studio
             looking at an empty day wants — a way to put something in it —
             rather than a gray line saying nothing is there. */
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center">
            <p className="text-sm font-medium">{t('dayEmptyTitle')}</p>
            <Link
              href={'/schedule' as Route}
              className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
            >
              <CalendarPlus className="h-3.5 w-3.5 text-primary" />
              {t('dayEmptyAction')}
            </Link>
          </div>
        ) : (
          <div className="space-y-0.5">
            {rows.map((s, i) => {
              const start = toDate(s.start)
              const end = toDate(s.end) ?? start
              const isPast = offset < 0 || (!!end && end.getTime() < nowMs)
              const state: 'past' | 'next' | 'later' =
                i === nextIndex ? 'next' : isPast ? 'past' : 'later'
              const minutesUntil =
                state === 'next' && start ? Math.round((start.getTime() - nowMs) / 60000) : null
              return (
                <SessionRow key={s.id} session={s} state={state} minutesUntil={minutesUntil} />
              )
            })}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
