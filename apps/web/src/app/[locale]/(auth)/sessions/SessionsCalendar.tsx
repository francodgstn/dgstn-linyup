'use client'

import { useEffect, useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { startOfWeek, weekdayOrder, type WeekStart } from '@linyup/shared'
import { cn } from '@/lib/utils'
import { eventTypeColor } from '@/lib/eventTypeColor'
import { Button } from '@/components/ui/button'
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Users,
  UserCheck,
  Pencil,
  Trash2,
  CalendarDays,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import {
  resolveAppointmentDurations,
  isExpiredAppointmentHold,
  dayKey,
  daySpans,
  spanOnDay,
} from '@linyup/shared'
import type { Session, Activity, Event, Availability } from '@linyup/shared'
import { SessionPeekSheet } from '@/components/sessions/SessionPeekSheet'
import { EventPeekSheet } from '@/components/events/EventPeekSheet'
import { Tip } from '@/components/ui/tip'

// ─── colour palette ───────────────────────────────────────────────────────────

const PALETTE = [
  '#7C3AED',
  '#EC4899',
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#F43F5E',
  '#0EA5E9',
  '#22C55E',
]

function activityAccent(activityId?: string | null, activities: Activity[] = []): string {
  const custom = activities.find((a) => a.id === activityId)?.color
  if (custom) return custom
  if (!activityId) return PALETTE[0]
  let h = 0
  for (const ch of activityId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}


// ─── calendar helpers ─────────────────────────────────────────────────────────

function buildMonthGrid(year: number, month: number, weekStartsOn: WeekStart): Date[][] {
  const first = new Date(year, month, 1)
  const last = new Date(year, month + 1, 0)
  // Columns start on the studio's first weekday (Settings → General).
  const offset = (first.getDay() - weekStartsOn + 7) % 7
  // Pad with real prev/next-month days so every week is complete
  const total = Math.ceil((offset + last.getDate()) / 7) * 7
  const cells = Array.from({ length: total }, (_, i) => new Date(year, month, 1 - offset + i))
  const weeks: Date[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

// `dayKey` and the interval→days translation live in shared/utils/calendarSpan,
// so this grid and the public planner cannot disagree about which day an item is
// on. `sameDay` stays local — it answers "is this the selected column", a
// question about the grid's own state, not about any item's extent.
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

function addDays(d: Date, n: number) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

// ── THE CALENDAR'S CLOCK ─────────────────────────────────────────────────────
// Every block on this calendar is positioned with the DEVICE's clock
// (`getHours()`, `new Date(y, m, d)`), and so is the class form it opens
// (SessionFormDialog, `zone: 'device'`). By the zone rule in useTeamFormat a
// surface labels in the zone its arithmetic runs in, so every label here comes
// from `useTeamFormat({ zone: 'device' })`: the studio's hour cycle, date order
// and week start, on the device's clock. It used to be bare
// `toLocaleTimeString()`, which asked the BROWSER for the hour cycle too — so a
// 24-hour studio read "07:00" on the axis and "07:00 AM" on the block beside it.

function itemMs(item: DayItem) {
  return (item.data.start as unknown as { toDate(): Date } | undefined)?.toDate().getTime() ?? 0
}

type DayItem = { kind: 'session'; data: Session } | { kind: 'event'; data: Event }

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('Calendar')
  const cfg: Record<string, { cls: string; label: string }> = {
    open: {
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      label: t('statusOpen'),
    },
    full: {
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      label: t('statusFull'),
    },
    cancelled: {
      cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',
      label: t('statusCancelled'),
    },
    // A paid-booking HOLD — the slot is reserved while checkout completes. Never
    // published publicly; ghosted here so admin never mistakes it for a real
    // booking. An expired-but-unswept hold is displayed as 'cancelled' instead
    // (see effectiveSessionStatus) — this entry only fires for a LIVE hold.
    pending_payment: {
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      label: t('statusAwaitingPayment'),
    },
  }
  const { cls, label } = cfg[status] ?? { cls: 'bg-muted text-muted-foreground', label: status }
  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold', cls)}>
      {label}
    </span>
  )
}

// The single source of truth for "what status do we SHOW" — a lapsed paid-booking
// hold (see isExpiredAppointmentHold) is logically free/cancelled even before the
// daily sweep flips the stored status, so admin surfaces should never render it as
// a live 'pending_payment' hold.
function effectiveSessionStatus(s: Session, nowMs: number): string {
  return isExpiredAppointmentHold(s, nowMs) ? 'cancelled' : (s.status ?? 'open')
}

// ─── DayCell ──────────────────────────────────────────────────────────────────

interface DayCellProps {
  day: Date
  count: number
  isSelected: boolean
  isToday: boolean
  isOutside: boolean
  inWeek: boolean
  bandStart: boolean
  bandEnd: boolean
  onClick: (d: Date) => void
}

function DayCell({
  day,
  count,
  isSelected,
  isToday,
  isOutside,
  inWeek,
  bandStart,
  bandEnd,
  onClick,
}: DayCellProps) {
  const dotColor = isSelected ? 'rgba(255,255,255,0.8)' : 'var(--primary)'
  const muted = isOutside && !isSelected

  return (
    <button
      onClick={() => onClick(day)}
      className={cn(
        'flex flex-col items-center justify-center gap-0.5 rounded-lg py-1 w-full aspect-square transition-colors',
        inWeek && !isSelected && 'bg-primary/10 rounded-none hover:bg-primary/20',
        inWeek && bandStart && 'rounded-l-lg',
        inWeek && bandEnd && 'rounded-r-lg',
        isSelected
          ? 'bg-primary text-primary-foreground'
          : cn(isToday && 'text-primary font-semibold', !inWeek && 'hover:bg-muted'),
        muted && 'text-muted-foreground/50'
      )}
    >
      <span className="text-sm leading-none">{day.getDate()}</span>
      {count > 0 && (
        <div className={cn('flex items-center justify-center h-2', muted && 'opacity-40')}>
          {/* front dot */}
          <div
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: dotColor }}
          />
          {/* back dot — offset behind front, lower opacity → "stacked" look */}
          {count > 1 && (
            <div
              className="w-1.5 h-1.5 rounded-full shrink-0 -ml-0.5"
              style={{ backgroundColor: dotColor, opacity: 0.4 }}
            />
          )}
        </div>
      )}
    </button>
  )
}

// ─── SessionCard ──────────────────────────────────────────────────────────────

interface SessionCardProps {
  session: Session
  activities: Activity[]
  onOpen: (s: Session) => void
  onEdit: (s: Session) => void
  onDelete: (s: Session) => void
}

function SessionCard({ session, activities, onOpen, onEdit, onDelete }: SessionCardProps) {
  const fmt = useTeamFormat({ zone: 'device' })
  const t = useTranslations('Calendar')
  const color = activityAccent(session.activityId, activities)

  // `bookings_count` is SEATS HELD, `participants_count` is WHO TURNED UP, and
  // the second is not derivable from the first — a walk-in is checked in with no
  // booking at all, and a no-show has a booking that holds no seat.
  const booked = session.bookings_count ?? 0
  const attended = session.participants_count ?? 0
  const countsLabel = [
    t('countBooked', { count: booked }),
    attended > 0 ? t('countCheckedIn', { count: attended }) : null,
    session.max_participants != null ? t('countCapacity', { count: session.max_participants }) : null,
  ]
    .filter((part): part is string => !!part)
    .join(' · ')

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(session)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(session)}
      className="flex gap-3 rounded-lg px-2 py-2 hover:bg-accent/50 transition-colors group cursor-pointer"
    >
      {/* activity colour strip */}
      <div className="w-1 rounded-full shrink-0 self-stretch" style={{ backgroundColor: color }} />

      <div className="flex-1 min-w-0 space-y-1.5">
        {/* row 1: name + status */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm truncate">
            {session.activityName ?? t('noActivity')}
          </span>
          <StatusBadge status={effectiveSessionStatus(session, Date.now())} />
        </div>

        {/* row 2: time + location */}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {fmt.time(session.start)} – {fmt.time(session.end)}
          </span>
          {session.location && (
            <span className="flex items-center gap-1 max-w-[200px] truncate">
              <MapPin className="h-3 w-3 shrink-0" />
              {session.location}
            </span>
          )}
        </div>

        {/* row 3: who is coming, who came + hover actions */}
        <div className="flex items-center justify-between mt-0.5">
          {/*
            TWO NUMBERS, BECAUSE THEY ARE TWO FACTS. This was one bare icon and
            `bookings_count`, which reads as "how many people" and is not:
            `bookings_count` is SEATS HELD, so a booking marked no-show drops out
            of it (`NON_HOLDING_BOOKING_STATUSES`). A class where one person
            booked, did not come, and six others were checked in at the door
            therefore showed "1" — every number on the screen correct, and the
            row still wrong about the day.

            The tooltip names them, because an icon pair is a legend nobody has.
          */}
          <Tip label={countsLabel}>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {booked}
                {session.max_participants ? ` / ${session.max_participants}` : ''}
              </span>
              {attended > 0 && (
                <span className="flex items-center gap-1">
                  <UserCheck className="h-3 w-3" />
                  {attended}
                </span>
              )}
            </span>
          </Tip>
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation()
                onEdit(session)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(session)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── EventCard ────────────────────────────────────────────────────────────────

function EventCard({
  event,
  day,
  onOpen,
}: {
  event: Event
  /** Which day's agenda this card is in — an event now appears on all of them. */
  day: Date
  onOpen: (e: Event) => void
}) {
  const fmt = useTeamFormat({ zone: 'device' })
  const t = useTranslations('Calendar')
  const color = eventTypeColor(event.type)

  // "09:00 – 17:00" is a lie on a four-day camp: those are the clock times of
  // two different days, three days apart, and printed together they read as one
  // afternoon. A spanning event says which day of how many it is instead, and
  // keeps the clock only for the two days where a clock time is true — the day
  // it starts and the day it ends.
  const start = (event.start as unknown as { toDate(): Date }).toDate()
  const end = (event.end as unknown as { toDate(): Date } | undefined)?.toDate() ?? null
  const spans = daySpans(start, end)
  const isMultiDay = spans.length > 1
  const index = spans.findIndex((s) => s.key === dayKey(day))
  const here = index >= 0 ? spans[index] : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(event)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(event)}
      className="flex gap-3 rounded-lg px-2 py-2 hover:bg-accent/50 transition-colors cursor-pointer"
    >
      <div className="w-1 rounded-full shrink-0 self-stretch" style={{ backgroundColor: color }} />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm truncate">{event.title}</span>
          <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground capitalize">
            {event.type}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {!isMultiDay ? (
              <>
                {fmt.time(event.start as unknown as { toDate(): Date })}
                {event.end && ` – ${fmt.time(event.end as unknown as { toDate(): Date })}`}
              </>
            ) : (
              <>
                {t('eventDayOf', { day: index + 1, total: spans.length })}
                {here?.isFirstDay && ` · ${t('eventFrom')} ${fmt.time(start)}`}
                {here?.isLastDay &&
                  end &&
                  ` · ${t('eventUntil')} ${fmt.time(end)}`}
              </>
            )}
          </span>
          {event.location && (
            <span className="flex items-center gap-1 max-w-[200px] truncate">
              <MapPin className="h-3 w-3 shrink-0" />
              {event.location}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── week time-grid layout ────────────────────────────────────────────────────

const HOUR_PX = 48
const MIN_BLOCK_PX = 22
/** Hour axis + one column per day on screen (seven for a week, one for a day). */
const gridCols = (days: number) =>
  ({ gridTemplateColumns: `3.25rem repeat(${days}, minmax(0, 1fr))` }) as const
/** Click-to-create snaps to this many minutes. Half an hour is what a timetable
 *  is written in; finer than that and a click lands on 09:07. */
const CREATE_SNAP_MIN = 30
/** Items a month cell lists before it says "+N more". */
const MONTH_CELL_ITEMS = 3
// Left-hand gutter reserved in every day column (only when availability is shown)
// so the rules stay visible even under an overlapping session: blocks stop short
// of it and each coach's rule sits in it. When availability is hidden the gutter
// collapses and blocks take the full column width.
//
// With more than one coach in scope the gutter widens and is split into one
// sub-lane per coach, so two coaches free at the same hour read as two ticks
// rather than one. Beyond MAX_AVAIL_LANES coaches share the last lane — the week
// grid is a "who is sellable when" hint, and the coach filter is the precise
// answer.
//
// NARROWED with the fill (10→6, 16→12). A day column is `minmax(0, 1fr)` of a
// seven-way split and is the scarcest space on this screen, and the old widths
// were sized for a translucent band beside the rule. A 2px rule plus breathing
// room needs 6; three of them need 12. Every pixel saved goes back to the
// session blocks, which is where the words are.
const AVAIL_GUTTER_PX = 6
const AVAIL_GUTTER_MULTI_PX = 12
const MAX_AVAIL_LANES = 3

interface PositionedSession {
  session: Session
  top: number
  height: number
  col: number
  cols: number
}

/**
 * Position a day's sessions on the time grid. Transitively-overlapping
 * sessions form a cluster; within a cluster each session is greedily assigned
 * the first free column and all cluster members share the column count.
 *
 * `day` is which column is being drawn, and it is REQUIRED: a session reaching
 * this list may have started yesterday. Its minutes on this day come from
 * `spanOnDay`, so a 22:00→01:00 class draws 22:00→24:00 in one column and
 * 00:00→01:00 in the next, rather than the flat sixty-minute block the old
 * `sameDay(end, start)` clamp substituted whenever the end was on another day.
 */
function layoutDaySessions(
  daySessions: Session[],
  day: Date,
  rangeStartHour: number,
  rangeEndHour: number
): PositionedSession[] {
  const rangeStartMin = rangeStartHour * 60
  const rangeEndMin = rangeEndHour * 60
  const items = daySessions
    .map((s) => {
      const st = (s.start as { toDate(): Date }).toDate()
      const en = (s.end as { toDate(): Date } | undefined)?.toDate() ?? null
      const span = spanOnDay(st, en, day)
      const startMin = span ? span.startMin : st.getHours() * 60 + st.getMinutes()
      let endMin = span ? span.endMin : startMin + 60
      endMin = Math.min(Math.max(endMin, startMin + 30), rangeEndMin) // ≥30min visual, clamp to grid
      return { s, startMin, endMin }
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)

  const placed: PositionedSession[] = []
  let cluster: typeof items = []
  let clusterEnd = -1

  const flush = () => {
    if (!cluster.length) return
    const colEnds: number[] = []
    const cols = cluster.map((it) => {
      let c = colEnds.findIndex((end) => end <= it.startMin)
      if (c === -1) {
        c = colEnds.length
        colEnds.push(0)
      }
      colEnds[c] = it.endMin
      return c
    })
    const n = colEnds.length
    cluster.forEach((it, i) => {
      placed.push({
        session: it.s,
        top: ((it.startMin - rangeStartMin) / 60) * HOUR_PX,
        height: Math.max(((it.endMin - it.startMin) / 60) * HOUR_PX, MIN_BLOCK_PX),
        col: cols[i],
        cols: n,
      })
    })
    cluster = []
    clusterEnd = -1
  }

  for (const it of items) {
    if (cluster.length && it.startMin >= clusterEnd) flush()
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.endMin)
  }
  flush()
  return placed
}

// ─── availability bands (Calendly-style "free time" background) ──────────────
//
// Not a slot computation — just the RAW published window/times from
// `availability` docs, expanded over the visible dates. Booked appointments
// already render as solid session blocks on top of these, so "free vs taken"
// reads correctly for free. Callers filter to ACTIVE schedules (and to a coach,
// if one is in scope) before passing `availability` in — this component doesn't
// re-derive that scoping (see schedule/page.tsx).
//
// Bands are always drawn when there are any. There used to be a second,
// exclusive "availability mode" that replaced the sessions with per-coach lanes;
// it was reached from a filter chip that emptied the list while the grid stayed
// full, and it is gone.

interface RawAvailabilityBand {
  key: string
  title: string
  providerId: string
  providerName: string
  startMin: number
  endMin: number
}

interface PositionedAvailabilityBand {
  key: string
  title: string
  providerId: string
  providerName: string
  top: number
  height: number
}

/** Shortest duration among the availability's linked activities — a 'times'
 *  entry has no length of its own, so the band uses the shortest bookable
 *  duration (the most conservative "at least this free"). Falls back to
 *  30min if no linked activity resolves a duration. */
function shortestActivityDuration(activityIds: string[] | undefined, activities: Activity[]): number {
  const durations = (activityIds ?? [])
    .flatMap((id) => {
      const activity = activities.find((a) => a.id === id)
      return activity ? resolveAppointmentDurations(activity).map((d) => d.minutes) : []
    })
    .filter((d) => d > 0)
  return durations.length ? Math.min(...durations) : 30
}

/** Expand one day's active availability schedules into raw (unpositioned)
 *  bands. `daysOfWeek` uses the same 0=Sun…6=Sat convention as `Date#getDay()`,
 *  so no remapping is needed. Times are 'HH:MM' Europe/Zurich, read as local
 *  wall-clock minutes — the same convention the grid already uses for session
 *  start/end (both derive from `Date#getHours()/getMinutes()`). */
function expandAvailabilityForDay(
  day: Date,
  availability: (Availability & { id: string })[],
  activities: Activity[]
): RawAvailabilityBand[] {
  const weekday = day.getDay()
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const bands: RawAvailabilityBand[] = []

  for (const a of availability) {
    if (!a.recurrence.daysOfWeek.includes(weekday)) continue
    const start = a.recurrence.startDate.toDate()
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    if (dayStart < startDay) continue
    if (a.recurrence.endDate) {
      const end = a.recurrence.endDate.toDate()
      const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
      if (dayStart > endDay) continue
    }

    const who = { providerId: a.providerId, providerName: a.providerName || a.providerId }
    if (a.mode === 'range' && a.window) {
      const [sh, sm] = a.window.start.split(':').map(Number)
      const [eh, em] = a.window.end.split(':').map(Number)
      if (Number.isFinite(sh) && Number.isFinite(sm) && Number.isFinite(eh) && Number.isFinite(em)) {
        bands.push({ key: `${a.id}-range`, title: a.title, ...who, startMin: sh * 60 + sm, endMin: eh * 60 + em })
      }
    } else if (a.mode === 'times' && a.times?.length) {
      const duration = shortestActivityDuration(a.activityIds, activities)
      for (const time of a.times) {
        const [h, m] = time.split(':').map(Number)
        if (!Number.isFinite(h) || !Number.isFinite(m)) continue
        const startMin = h * 60 + m
        bands.push({ key: `${a.id}-${time}`, title: a.title, ...who, startMin, endMin: startMin + duration })
      }
    }
  }
  return bands
}

// ─── SessionsCalendar ─────────────────────────────────────────────────────────

interface SessionsCalendarProps {
  sessions: Session[]
  activities: Activity[]
  events?: Event[]
  /** Active availability to render as translucent "free time" bands behind the
   *  week grid's session blocks — one sub-lane per coach in the left gutter.
   *  Pass an empty array (or omit) to render none; the caller
   *  (schedule/page.tsx) decides scoping (active only, narrowed to the coach
   *  filter), this component just expands+positions whatever it's given. */
  availability?: (Availability & { id: string })[]
  onEdit: (s: Session) => void
  onDelete: (s: Session) => void
  onEventEdit?: (e: Event) => void
  onEventDelete?: (e: Event) => void
  /** Where the event peek sheet's "Open full" goes — see EventPeekSheet. */
  eventHref?: (e: Event) => string
  viewYear?: number
  viewMonth?: number
  onNavigate?: (year: number, month: number) => void
  /** How much the main pane shows: one day or a week on the time grid, or a
   *  month of cells. The page owns it (it sits in the page's view switch). */
  range?: CalendarRange
  /** Asked to show another range, e.g. a month cell's day number → that day. */
  onRangeChange?: (range: CalendarRange) => void
  /** Click on an empty slot of the time grid: a new class starting there,
   *  snapped to CREATE_SNAP_MIN. Omit and the empty grid only selects days. */
  onCreateAt?: (start: Date) => void
}

export type CalendarRange = 'day' | 'week' | 'month'

// Stable per-coach colour for the availability lanes (hashed, same palette the
// activity blocks use).
function providerColor(providerId: string): string {
  let h = 0
  for (const ch of providerId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export default function SessionsCalendar({
  sessions,
  activities,
  events = [],
  availability = [],
  onEdit,
  onDelete,
  onEventEdit,
  onEventDelete,
  eventHref,
  viewYear: externalYear,
  viewMonth: externalMonth,
  onNavigate,
  range = 'week',
  onRangeChange,
  onCreateAt,
}: SessionsCalendarProps) {
  const t = useTranslations('Calendar')
  const tCommon = useTranslations('Common')
  // See THE CALENDAR'S CLOCK above: studio formats, device clock.
  const fmt = useTeamFormat({ zone: 'device' })
  const weekStartsOn = fmt.weekStartsOn
  const today = useMemo(() => new Date(), [])

  const [internalYear, setInternalYear] = useState(() => today.getFullYear())
  const [internalMonth, setInternalMonth] = useState(() => today.getMonth())
  const [selected, setSelected] = useState<Date>(() => new Date(today))
  const [peekSessionId, setPeekSessionId] = useState<string | null>(null)
  const [peekEventId, setPeekEventId] = useState<string | null>(null)
  // FOCUS MODE (Franco, 2026-09-25). Expand used to hide only the side pane,
  // leaving the page header, the view switch and the filters above the grid.
  // It now takes the whole window: the week grid alone, with its own week
  // navigation and an exit. Escape leaves, and the page underneath stops
  // scrolling while it is open. It sits above the floating dock (z-40) and
  // below dialogs and sheets (z-50), so a class opened from the grid still
  // shows its peek on top. Desktop only, like the button that opens it.
  const [fullWeek, setFullWeek] = useState(false)
  useEffect(() => {
    if (!fullWeek) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullWeek(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [fullWeek])

  const viewYear = externalYear ?? internalYear
  const viewMonth = externalMonth ?? internalMonth

  function navigate(y: number, m: number) {
    if (onNavigate) {
      onNavigate(y, m)
    } else {
      setInternalYear(y)
      setInternalMonth(m)
    }
  }

  /** Select a date and keep the mini calendar (and data window) on its month. */
  function selectDate(d: Date) {
    setSelected(d)
    if (d.getMonth() !== viewMonth || d.getFullYear() !== viewYear) {
      navigate(d.getFullYear(), d.getMonth())
    }
  }

  // ── THE INDEXES, and the one thing to know about them ──────────────────────
  // An item is filed under EVERY day it touches, not just the day it starts.
  // That single change is what makes a four-day camp appear on four days, and it
  // is why nothing downstream needs to know about spanning: the mini-month dots,
  // the day agenda, the week strip and the week grid all read these maps and all
  // become correct together. `daySpans` owns the interval→days translation.
  const sessionsByDate = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      if (!s.start) continue
      const st = (s.start as { toDate(): Date }).toDate()
      const en = (s.end as { toDate(): Date } | undefined)?.toDate() ?? null
      for (const span of daySpans(st, en)) {
        map.set(span.key, [...(map.get(span.key) ?? []), s])
      }
    }
    return map
  }, [sessions])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, Event[]>()
    for (const e of events) {
      if (!e.start) continue
      const st = (e.start as unknown as { toDate(): Date }).toDate()
      const en = (e.end as unknown as { toDate(): Date } | undefined)?.toDate() ?? null
      for (const span of daySpans(st, en)) {
        map.set(span.key, [...(map.get(span.key) ?? []), e])
      }
    }
    return map
  }, [events])

  const daySessions = useMemo(
    () =>
      (sessionsByDate.get(dayKey(selected)) ?? [])
        .slice()
        .sort(
          (a, b) => itemMs({ kind: 'session', data: a }) - itemMs({ kind: 'session', data: b })
        ),
    [sessionsByDate, selected]
  )
  const dayEvents = useMemo(
    () =>
      (eventsByDate.get(dayKey(selected)) ?? [])
        .slice()
        .sort((a, b) => itemMs({ kind: 'event', data: a }) - itemMs({ kind: 'event', data: b })),
    [eventsByDate, selected]
  )

  const weeks = useMemo(
    () => buildMonthGrid(viewYear, viewMonth, weekStartsOn),
    [viewYear, viewMonth, weekStartsOn]
  )

  const weekStart = useMemo(() => startOfWeek(selected, weekStartsOn), [selected, weekStartsOn])
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  )
  // The columns of the time grid. Day view is the week grid with one column;
  // every layout rule below (hour range, blocks, bands) runs unchanged on it.
  const selectedKey = dayKey(selected)
  const gridDays = useMemo(
    () =>
      range === 'day'
        ? [new Date(selected.getFullYear(), selected.getMonth(), selected.getDate())]
        : weekDays,
    // `selectedKey`, not `selected`: a new Date for the same day must not
    // re-run the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, selectedKey, weekDays]
  )
  const cols = gridCols(gridDays.length)

  // Week time grid: hour range (8–20 by default, stretched to fit) + positioned blocks per day
  const weekGrid = useMemo(() => {
    let startHour = 8
    let endHour = 20

    // Raw (unpositioned) availability bands per day — computed before the
    // final hour range so a published window outside the session-derived
    // range (e.g. an early-morning slot with no bookings yet) still stretches
    // the grid to show it in full.
    const dayRawBands = gridDays.map((day) => expandAvailabilityForDay(day, availability, activities))

    // The hours the grid must open, asked PER DAY through the same span the
    // blocks are drawn from. Reading the session's own clock times here was the
    // clamp's second home: a session continuing from yesterday would report its
    // start hour (23:00) on today's column and the grid would stretch backwards
    // to open an hour nothing is drawn in, while never opening the 00:00 the
    // continuation actually occupies.
    for (const d of gridDays) {
      for (const s of sessionsByDate.get(dayKey(d)) ?? []) {
        const st = (s.start as { toDate(): Date }).toDate()
        const en = (s.end as { toDate(): Date } | undefined)?.toDate() ?? null
        const span = spanOnDay(st, en, d)
        if (!span) continue
        startHour = Math.min(startHour, Math.floor(span.startMin / 60))
        const endH = Math.ceil(span.endMin / 60)
        endHour = Math.max(endHour, Math.min(endH, 24))
      }
    }
    for (const dayBands of dayRawBands) {
      for (const b of dayBands) {
        startHour = Math.min(startHour, Math.floor(b.startMin / 60))
        endHour = Math.max(endHour, Math.min(Math.ceil(b.endMin / 60), 24))
      }
    }

    // Positioned with the exact same formula `layoutDaySessions` uses for
    // session blocks (top = (minutesSinceRangeStart / 60) * HOUR_PX), so a
    // band's top edge lines up exactly with a session block at the same
    // clock time.
    const rangeStartMin = startHour * 60
    const days = gridDays.map((day, i) => ({
      day,
      events: eventsByDate.get(dayKey(day)) ?? [],
      blocks: layoutDaySessions(sessionsByDate.get(dayKey(day)) ?? [], day, startHour, endHour),
      bands: dayRawBands[i].map(
        (b): PositionedAvailabilityBand => ({
          key: b.key,
          title: b.title,
          providerId: b.providerId,
          providerName: b.providerName,
          top: ((b.startMin - rangeStartMin) / 60) * HOUR_PX,
          height: Math.max(((b.endMin - b.startMin) / 60) * HOUR_PX, 6),
        })
      ),
    }))
    return { startHour, endHour, days, hasEvents: days.some((d) => d.events.length > 0) }
  }, [gridDays, sessionsByDate, eventsByDate, availability, activities])

  const gridHeight = (weekGrid.endHour - weekGrid.startHour) * HOUR_PX
  const hourCount = weekGrid.endHour - weekGrid.startHour
  // The distinct coaches (stable order + lane index) whose free time is shown
  // this week — derived from the bands actually drawn, so the legend below can
  // never name a coach the grid doesn't show.
  const availabilityProviders = useMemo(() => {
    const byId = new Map<string, string>()
    for (const day of weekGrid.days)
      for (const b of day.bands) if (!byId.has(b.providerId)) byId.set(b.providerId, b.providerName)
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [weekGrid])
  // The gutter is reserved only when there is something to draw in it; otherwise
  // session blocks take the full column width.
  const showLane = availabilityProviders.length > 0
  const laneCount = Math.min(Math.max(availabilityProviders.length, 1), MAX_AVAIL_LANES)
  const lanePx = showLane ? (laneCount > 1 ? AVAIL_GUTTER_MULTI_PX : AVAIL_GUTTER_PX) : 0
  const laneWidthPx = lanePx / laneCount

  // Locale-aware labels
  const monthLabel = fmt.monthYear(new Date(viewYear, viewMonth, 1))
  /** The hour axis: "07:00" on a 24-hour studio, "7 AM" on a 12-hour one (the
   *  minutes are always :00, and "7:00 AM" does not fit the gutter). */
  const hourLabel = (h: number) =>
    fmt.regional.timeFormat === '12h'
      ? fmt.custom(new Date(2024, 0, 1, h), { hour: 'numeric' })
      : `${String(h).padStart(2, '0')}:00`
  // 7 January 2024 was a Sunday, so weekday `d` of `weekdayOrder` (0=Sun…6=Sat)
  // is the 7th + d: one fixed week, read in the studio's order.
  const weekdayNarrow = useMemo(
    () =>
      weekdayOrder(weekStartsOn).map((d) =>
        fmt.custom(new Date(2024, 0, 7 + d), { weekday: 'narrow' })
      ),
    [fmt, weekStartsOn]
  )

  const weekdayShortLabels = useMemo(
    () =>
      weekdayOrder(weekStartsOn).map((d) =>
        fmt.custom(new Date(2024, 0, 7 + d), { weekday: 'short' })
      ),
    [fmt, weekStartsOn]
  )

  function weekRangeLabel() {
    const sameMonth = weekStart.getMonth() === weekEnd.getMonth()
    const startStr = fmt.custom(
      weekStart,
      sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' }
    )
    const endStr = fmt.custom(weekEnd, { day: 'numeric', month: 'short', year: 'numeric' })
    return `${startStr} – ${endStr}`
  }

  function prevMonth() {
    if (viewMonth === 0) navigate(viewYear - 1, 11)
    else navigate(viewYear, viewMonth - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) navigate(viewYear + 1, 0)
    else navigate(viewYear, viewMonth + 1)
  }

  function step(dir: 1 | -1) {
    if (range === 'month') selectDate(new Date(viewYear, viewMonth + dir, 1))
    else selectDate(addDays(selected, dir * (range === 'day' ? 1 : 7)))
  }

  function rangeLabel() {
    if (range === 'month') return monthLabel
    if (range === 'day')
      return fmt.custom(selected, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    return weekRangeLabel()
  }

  // ── CLICK TO CREATE ─────────────────────────────────────────────────────────
  // An empty slot is the fastest way to say "a class here": the day and the
  // time are already on screen, so the form opens with both filled in. The
  // ghost under the pointer shows the snapped start before the click, so the
  // click lands where it looks like it will.
  const [hoverSlot, setHoverSlot] = useState<{ key: string; min: number } | null>(null)
  function slotMinutes(e: React.MouseEvent<HTMLElement>): number {
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = weekGrid.startHour * 60 + ((e.clientY - rect.top) / HOUR_PX) * 60
    const snapped = Math.floor(raw / CREATE_SNAP_MIN) * CREATE_SNAP_MIN
    return Math.min(
      Math.max(snapped, weekGrid.startHour * 60),
      weekGrid.endHour * 60 - CREATE_SNAP_MIN
    )
  }
  function createAt(day: Date, min: number) {
    const start = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Math.floor(min / 60),
      min % 60
    )
    selectDate(start)
    onCreateAt?.(start)
  }
  function goToday() {
    selectDate(new Date(today))
  }

  const openSessionPeek = (s: Session) => setPeekSessionId(s.id)
  const openEventPeek = (e: Event) => setPeekEventId(e.id)

  return (
    <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
      {/* ── Mini-month + day list — LEFT on desktop (Franco, 2026-09-25), the
          Google / Outlook convention: the month is navigation, so it is read
          first. Hidden in focus mode. ── */}
      {!fullWeek && (
      <div className="lg:order-1 lg:w-72 shrink-0 lg:flex lg:flex-col lg:min-h-0">
        {/* The mini-month is navigation for the day and week views. In month
            view the main pane IS the month, so only the day agenda stays. */}
        {range !== 'month' && (
        <>
        {/* Month navigation */}
        <div className="flex items-center justify-between mb-3 px-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={prevMonth}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold capitalize">{monthLabel}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={nextMonth}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Weekday labels */}
        <div className="grid grid-cols-7 mb-1">
          {weekdayNarrow.map((label, i) => (
            <div
              key={i}
              className="text-center text-xs font-medium text-muted-foreground py-1 select-none"
            >
              {label}
            </div>
          ))}
        </div>

        {/* Day grid */}
        {weeks.map((week, wi) => {
          const inBand = (d: Date) =>
            d.getTime() >= weekStart.getTime() && d.getTime() <= weekEnd.getTime()
          return (
            <div key={wi} className="grid grid-cols-7">
              {week.map((day, di) => (
                <DayCell
                  key={di}
                  day={day}
                  count={
                    (sessionsByDate.get(dayKey(day))?.length ?? 0) +
                    (eventsByDate.get(dayKey(day))?.length ?? 0)
                  }
                  isSelected={sameDay(day, selected)}
                  isToday={sameDay(day, today)}
                  isOutside={day.getMonth() !== viewMonth}
                  inWeek={inBand(day)}
                  bandStart={di === 0}
                  bandEnd={di === 6}
                  onClick={setSelected}
                />
              ))}
            </div>
          )
        })}

        </>
        )}

        {/* Selected-day detail — the day agenda, anchored under the calendar.
            On desktop it fills the space below the mini-calendar (the column is
            stretched to the week-grid height by the flex row) and scrolls, so a
            busy day never grows the page. */}
        <div
          className={cn(
            'lg:flex lg:min-h-0 lg:flex-1 lg:flex-col',
            range !== 'month' && 'mt-6 pt-4 border-t'
          )}
        >
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 select-none capitalize">
            {fmt.custom(selected, { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          {daySessions.length === 0 && dayEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
              <CalendarDays className="h-7 w-7 opacity-30" />
              <p className="text-sm">{t('emptyDay')}</p>
            </div>
          ) : (
            <div className="-mx-2 space-y-0.5 max-h-[28rem] overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1">
              {dayEvents.map((e) => (
                <EventCard key={e.id} event={e} day={selected} onOpen={openEventPeek} />
              ))}
              {daySessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  activities={activities}
                  onOpen={openSessionPeek}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      )}

      {/* ── Week grid — RIGHT on desktop; the whole window in focus mode ── */}
      <div
        className={cn(
          'lg:order-2 flex-1 min-w-0',
          fullWeek && 'fixed inset-0 z-[45] overflow-y-auto bg-background p-4 sm:p-6'
        )}
      >
        {/* Week header: stepper + range + today */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-1 min-w-0">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => step(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => step(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <h3 className="font-semibold text-base truncate ml-1 capitalize">{rangeLabel()}</h3>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={goToday}>
              {tCommon('today')}
            </Button>
            {/* Expand the week grid to full width (hide month + agenda) — desktop only */}
            <Tip label={fullWeek ? t('collapseWeek') : t('expandWeek')}>
              <Button
                variant="ghost"
                size="icon"
                className="hidden lg:inline-flex h-7 w-7"
                onClick={() => setFullWeek((v) => !v)}
                aria-label={fullWeek ? t('collapseWeek') : t('expandWeek')}
              >
                {fullWeek ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </Tip>
          </div>
        </div>

        {/* Bookable-hours legend — the bands in the left gutter are a coloured
            tick; without a name they're a mystery, and this is the only thing on
            the page that says what they are. Rendered only when there are any. */}
        {range !== 'month' && availabilityProviders.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium">{t('availabilityLegend')}</span>
            {availabilityProviders.slice(0, MAX_AVAIL_LANES).map((p) => (
              <span key={p.id} className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="h-2.5 w-1.5 rounded-sm"
                  style={{ backgroundColor: providerColor(p.id) }}
                />
                {p.name}
              </span>
            ))}
            {availabilityProviders.length > MAX_AVAIL_LANES && (
              <span>{t('peekMore', { count: availabilityProviders.length - MAX_AVAIL_LANES })}</span>
            )}
          </div>
        )}

        {range === 'month' && (
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="grid grid-cols-7 border-b">
              {weekdayShortLabels.map((label, i) => (
                <div
                  key={i}
                  className={cn(
                    'py-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground select-none',
                    i > 0 && 'border-l'
                  )}
                >
                  {label}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7 border-b last:border-b-0">
                {week.map((day, di) => {
                  const key = dayKey(day)
                  const dayEvts = eventsByDate.get(key) ?? []
                  const daySess = (sessionsByDate.get(key) ?? [])
                    .slice()
                    .sort(
                      (a, b) =>
                        itemMs({ kind: 'session', data: a }) - itemMs({ kind: 'session', data: b })
                    )
                  const total = dayEvts.length + daySess.length
                  // Events first (they frame the day), then classes by time,
                  // cut at MONTH_CELL_ITEMS so every cell keeps one height.
                  const shownEvts = dayEvts.slice(0, MONTH_CELL_ITEMS)
                  const shownSess = daySess.slice(0, MONTH_CELL_ITEMS - shownEvts.length)
                  const hidden = total - shownEvts.length - shownSess.length
                  const isToday = sameDay(day, today)
                  const isSelected = sameDay(day, selected)
                  const openDay = () => {
                    selectDate(day)
                    onRangeChange?.('day')
                  }
                  return (
                    <div
                      key={key}
                      className={cn(
                        'relative min-h-24 min-w-0 space-y-0.5 p-1',
                        di > 0 && 'border-l',
                        day.getMonth() !== viewMonth && 'bg-muted/40 text-muted-foreground',
                        isSelected && 'bg-primary/[0.07]'
                      )}
                    >
                      {/* Empty space selects the day (its agenda is on the
                          left); the day number is the accessible route. */}
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={() => selectDate(day)}
                        className="absolute inset-0 cursor-default"
                      />
                      <div className="relative flex justify-end">
                        <button
                          type="button"
                          onClick={openDay}
                          title={fmt.custom(day, { weekday: 'long', day: 'numeric', month: 'long' })}
                          className={cn(
                            'flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold transition-colors',
                            isToday
                              ? 'bg-primary text-primary-foreground'
                              : 'hover:bg-muted'
                          )}
                        >
                          {day.getDate()}
                        </button>
                      </div>
                      {shownEvts.map((e) => {
                        const color = eventTypeColor(e.type)
                        return (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => openEventPeek(e)}
                            title={e.title}
                            className="relative block w-full truncate rounded px-1.5 py-0.5 text-left text-2xs font-semibold transition-opacity hover:opacity-80"
                            style={{ backgroundColor: `${color}1F`, color }}
                          >
                            {e.title}
                          </button>
                        )
                      })}
                      {shownSess.map((s) => {
                        const cancelled = s.status === 'cancelled'
                        const name = s.activityName ?? t('noActivity')
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => openSessionPeek(s)}
                            title={`${name} · ${fmt.time(s.start)} – ${fmt.time(s.end)}`}
                            className={cn(
                              'relative flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-2xs transition-colors hover:bg-muted',
                              cancelled && 'line-through opacity-60'
                            )}
                          >
                            <span
                              aria-hidden
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: activityAccent(s.activityId, activities) }}
                            />
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {fmt.time(s.start)}
                            </span>
                            <span className="truncate font-medium text-foreground">{name}</span>
                          </button>
                        )
                      })}
                      {hidden > 0 && (
                        <button
                          type="button"
                          onClick={openDay}
                          className="relative block w-full rounded px-1 text-left text-2xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          {t('peekMore', { count: hidden })}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {/* ── Week / day timetable grid ── */}
        {range !== 'month' && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <div className={cn(range === 'week' && 'min-w-[640px]')}>
              {/* Day headers — click to focus that day in the detail panel */}
              <div className="grid border-b" style={cols}>
                <div />
                {weekGrid.days.map(({ day }) => {
                  const isToday = sameDay(day, today)
                  const isSelected = sameDay(day, selected)
                  return (
                    <button
                      key={dayKey(day)}
                      onClick={() => selectDate(day)}
                      className={cn(
                        'flex flex-col items-center gap-0.5 py-2 border-l group min-w-0 transition-colors',
                        isSelected && range === 'week' && 'bg-primary/[0.07]'
                      )}
                      title={fmt.custom(day, { weekday: 'long', day: 'numeric', month: 'long' })}
                    >
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {fmt.weekdayShort(day)}
                      </span>
                      <span
                        className={cn(
                          'h-6 w-6 rounded-full flex items-center justify-center text-sm font-semibold transition-colors',
                          isToday
                            ? 'bg-primary text-primary-foreground'
                            : isSelected
                              ? 'bg-primary/15 text-primary'
                              : 'group-hover:bg-muted'
                        )}
                      >
                        {day.getDate()}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Events strip */}
              {weekGrid.hasEvents && (
                <div className="grid border-b" style={cols}>
                  <div />
                  {weekGrid.days.map(({ day, events: dayEvts }) => (
                    <div
                      key={dayKey(day)}
                      // NO horizontal padding: a spanning event's bar must reach
                      // both edges of its cell so the run in the next column
                      // touches it. With `px-1` here every day boundary opened a
                      // 8px gutter and one camp read as a row of separate chips.
                      // The text inset lives on the bar instead.
                      className={cn(
                        'border-l py-1 space-y-1 min-w-0',
                        range === 'week' && sameDay(day, selected) && 'bg-primary/[0.07]'
                      )}
                    >
                      {dayEvts.map((e) => {
                        const color = eventTypeColor(e.type)
                        // A multi-day event now appears in every day's cell.
                        // Squaring off the inner edges is what turns seven
                        // separate chips into one continuous bar; the label is
                        // printed only on the day it starts, and on a
                        // continuation the bar carries the colour alone —
                        // repeating the title in every column reads as seven
                        // events, which is the bug this fix exists to remove.
                        const span = spanOnDay(
                          (e.start as unknown as { toDate(): Date }).toDate(),
                          (e.end as unknown as { toDate(): Date } | undefined)?.toDate() ?? null,
                          day
                        )
                        const isFirst = span?.isFirstDay ?? true
                        const isLast = span?.isLastDay ?? true
                        return (
                          <button
                            key={e.id}
                            onClick={() => openEventPeek(e)}
                            // `w-full`, NOT `w-auto`: a <button> shrink-to-fits
                            // on `width: auto` even at `display: block` (it
                            // sizes like a replaced element), so a continuation
                            // bar carrying only a space collapsed to 10px.
                            className={cn(
                              'block w-full truncate px-1.5 py-0.5 text-2xs font-semibold text-left transition-opacity hover:opacity-80',
                              isFirst ? 'rounded-l-md' : 'rounded-l-none',
                              isLast ? 'rounded-r-md' : 'rounded-r-none'
                            )}
                            style={{ backgroundColor: `${color}1F`, color }}
                            title={e.title}
                          >
                            {/* Non-breaking space, not an empty string: the bar
                                must keep its height on a continuation day or the
                                run of it goes ragged. */}
                            {isFirst ? e.title : ' '}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}

              {/* Time grid */}
              <div className="grid" style={cols}>
                {/* Hour axis */}
                <div className="relative" style={{ height: gridHeight }}>
                  {Array.from({ length: hourCount }, (_, i) => (
                    <span
                      key={i}
                      className="absolute right-1.5 text-2xs text-muted-foreground tabular-nums select-none"
                      style={{ top: i * HOUR_PX + 2 }}
                    >
                      {hourLabel(weekGrid.startHour + i)}
                    </span>
                  ))}
                </div>

                {/* Day columns */}
                {weekGrid.days.map(({ day, blocks, bands }) => {
                  const isToday = sameDay(day, today)
                  const isSelected = sameDay(day, selected)
                  const now = new Date()
                  const nowTop =
                    ((now.getHours() * 60 + now.getMinutes()) / 60 - weekGrid.startHour) * HOUR_PX
                  return (
                    <div
                      key={dayKey(day)}
                      className={cn(
                        'relative border-l',
                        // Selected day (from the mini calendar) gets a stronger tint than today.
                        // A lone day column has nothing to be picked out from.
                        isSelected && range === 'week'
                          ? 'bg-primary/[0.07]'
                          : isToday && range === 'week' && 'bg-primary/[0.03]'
                      )}
                      style={{ height: gridHeight }}
                    >
                      {/* Clicking where nothing is scheduled opens a new class
                          at that time (see CLICK TO CREATE), or only selects
                          the day when the page offers no create. The header
                          button and the New menu are the accessible routes, so
                          the catcher is hidden from AT and out of the tab order
                          rather than adding a stop per column. It is the FIRST
                          child, so every session block paints — and takes its
                          clicks — above it. */}
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={(e) =>
                          onCreateAt ? createAt(day, slotMinutes(e)) : selectDate(day)
                        }
                        onMouseMove={
                          onCreateAt
                            ? (e) => {
                                const min = slotMinutes(e)
                                const key = dayKey(day)
                                setHoverSlot((cur) =>
                                  cur && cur.key === key && cur.min === min ? cur : { key, min }
                                )
                              }
                            : undefined
                        }
                        onMouseLeave={onCreateAt ? () => setHoverSlot(null) : undefined}
                        className={cn(
                          'absolute inset-0',
                          onCreateAt ? 'cursor-pointer' : 'cursor-default'
                        )}
                      />

                      {/* The slot a click would create — pointer devices only
                          (there is no hover on touch, and a tap just opens it). */}
                      {onCreateAt && hoverSlot?.key === dayKey(day) && (
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute z-[1] flex items-start rounded-md border border-dashed border-primary/50 bg-primary/[0.06] px-1.5 py-0.5 text-2xs font-medium text-primary"
                          style={{
                            top: ((hoverSlot.min - weekGrid.startHour * 60) / 60) * HOUR_PX + 1,
                            height: (CREATE_SNAP_MIN / 60) * HOUR_PX - 2,
                            left: lanePx + 2,
                            right: 2,
                          }}
                        >
                          +{' '}
                          {fmt.time(
                            new Date(2024, 0, 1, Math.floor(hoverSlot.min / 60), hoverSlot.min % 60)
                          )}
                        </div>
                      )}

                      {/* Availability gutter — a faint LEFT strip the session
                          blocks stop short of, so a band still reads here even
                          when a session overlaps its time. Shown only when there
                          are published hours to draw. */}
                      {showLane && (
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-y-0 left-0 bg-muted/30 dark:bg-muted/20"
                          style={{ width: lanePx }}
                        />
                      )}

                      {/* Hour lines */}
                      {Array.from({ length: hourCount }, (_, i) => (
                        <div
                          key={i}
                          className="pointer-events-none absolute inset-x-0 border-t border-border/60"
                          style={{ top: i * HOUR_PX }}
                        />
                      ))}

                      {/* Availability bands — A LINE, NOT A BAND. Each is a
                          coloured rule in the left gutter spanning the bookable
                          window, one sub-lane per coach, so it still reads under
                          an overlapping session and never fights a session's
                          fill, and capped round at both ends. Tooltip carries
                          the coach + schedule name; the legend above the grid
                          names the colours.

                          The translucent fill beside the rule is gone (Franco,
                          2026-08-21). A lane is a handful of pixels wide, so the
                          fill was never an area anybody could read as one — it
                          was a smudge next to a 2px line that already carried
                          the same colour and the same extent. Dropping it is
                          what let the gutter narrow. */}
                      {bands.map((band) => {
                        const c = providerColor(band.providerId)
                        // Coaches past the third share the last lane (see
                        // MAX_AVAIL_LANES) — colour still tells them apart.
                        const laneIdx = Math.min(
                          Math.max(availabilityProviders.findIndex((p) => p.id === band.providerId), 0),
                          laneCount - 1
                        )
                        return (
                          <div
                            key={band.key}
                            title={`${band.providerName} · ${band.title}`}
                            // `rounded-full` on a 2px-wide element clamps to a
                            // 1px radius, which is exactly a pill cap: the rule
                            // ends in a soft dome instead of a cut edge. At this
                            // width it is one pixel of difference and it still
                            // shows — a flat end reads as something clipped by
                            // the row above it, a domed one reads as finished.
                            className="absolute z-[2] rounded-full"
                            style={{
                              top: band.top,
                              height: band.height,
                              left: laneIdx * laneWidthPx,
                              // The rule IS the element now — no box behind it,
                              // nothing to fill.
                              width: 2,
                              backgroundColor: c,
                            }}
                          />
                        )
                      })}

                      {/* Now indicator */}
                      {isToday && nowTop >= 0 && nowTop <= gridHeight && (
                        <div
                          className="absolute inset-x-0 z-10 pointer-events-none"
                          style={{ top: nowTop }}
                        >
                          <div className="h-px bg-red-500" />
                          <div className="absolute -top-[2.5px] left-0 h-1.5 w-1.5 rounded-full bg-red-500" />
                        </div>
                      )}

                      {/* Session blocks */}
                      {blocks.map(({ session: s, top, height, col, cols }) => {
                        const color = activityAccent(s.activityId, activities)
                        const expiredHold = isExpiredAppointmentHold(s, now.getTime())
                        const cancelled = s.status === 'cancelled' || expiredHold
                        // A LIVE paid-booking hold — ghosted like 'cancelled' (dimmed +
                        // dashed border) but NOT struck through: it isn't cancelled, it's
                        // reserved pending payment.
                        const awaitingPayment = s.status === 'pending_payment' && !expiredHold
                        const name = s.activityName ?? t('noActivity')
                        return (
                          <button
                            key={s.id}
                            onClick={() => openSessionPeek(s)}
                            // The full range lives in the tooltip and the peek;
                            // the block itself carries the start and the name.
                            title={`${name} · ${fmt.time(s.start)} – ${fmt.time(s.end)}`}
                            className={cn(
                              'absolute z-[5] rounded-md border-l-2 px-1.5 py-0.5 text-left overflow-hidden transition-opacity hover:opacity-75',
                              (cancelled || awaitingPayment) && 'opacity-50',
                              awaitingPayment && 'border-dashed'
                            )}
                            style={{
                              top: top + 1,
                              height: height - 2,
                              // Blocks are pushed off the LEFT availability lane and
                              // share the remaining width, so the band always peeks
                              // out on the left even under an overlapping session.
                              // With the lane hidden (lanePx 0) they take full width.
                              left: `calc(${lanePx}px + (100% - ${lanePx}px) * ${col / cols} + 2px)`,
                              width: `calc((100% - ${lanePx}px) / ${cols} - 4px)`,
                              backgroundColor: `${color}1F`,
                              borderLeftColor: color,
                            }}
                          >
                            {/* SHORT LABEL (Franco, 2026-09-25): the start
                                time and the name, on one line when the block is
                                short. The end is where the block ends, which
                                the grid already draws. */}
                            <p
                              className={cn(
                                'text-2xs leading-tight',
                                height >= 36 ? 'line-clamp-2' : 'truncate',
                                cancelled && 'line-through'
                              )}
                            >
                              <span className="tabular-nums text-muted-foreground">
                                {fmt.time(s.start)}
                              </span>{' '}
                              <span className="font-medium">{name}</span>
                            </p>
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        )}
      </div>

      {/* ── Session preview ── */}
      <SessionPeekSheet
        sessionId={peekSessionId}
        onClose={() => setPeekSessionId(null)}
        activities={activities}
        onEdit={(s) => {
          setPeekSessionId(null)
          onEdit(s)
        }}
        onDelete={(s) => {
          setPeekSessionId(null)
          onDelete(s)
        }}
      />

      {/* ── Event preview ── */}
      <EventPeekSheet
        eventId={peekEventId}
        onClose={() => setPeekEventId(null)}
        eventHref={eventHref}
        onEdit={(e) => {
          setPeekEventId(null)
          onEventEdit?.(e)
        }}
        onDelete={(e) => {
          setPeekEventId(null)
          onEventDelete?.(e)
        }}
      />
    </div>
  )
}
