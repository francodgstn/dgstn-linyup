'use client'

// Public, read-only weekly time-grid planner — days as columns, hours as rows,
// sessions positioned/sized by start→end with overlaps side-by-side. Ported from
// the admin SessionsCalendar week grid (layoutDaySessions + grid math), minus
// auth, editing, peek sheets and Firestore access. Shared by the public website
// schedule section (components/site/sections.tsx) and the kiosk (KioskSchedule).
//
// The container scrolls horizontally on narrow screens; the hour axis sticks to
// the left so it stays visible. Shows the CURRENT week, pageable forward while
// the data window lasts.
//
// Week start, hour cycle and weekday/month names come from the studio's
// regional settings. The grid POSITIONS its blocks with the device's clock
// (`daySpans` reads local hours), so it labels them in the device's zone too —
// a Zurich time on a New York row is worse than either alone. Converting the
// bucketing is its own change; until then this surface opts out of the studio's
// display zone. The opt-out itself is documented once, on the `zone` option in
// hooks/useTeamFormat.ts.

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { dayKey, daySpans, spanOnDay, startOfWeek, type RegionalSettings, type WeekStart } from '@linyup/shared'
import { useTeamFormat } from '@/hooks/useTeamFormat'

/** Firestore-Timestamp-like — the public session mirror provides `{ toDate() }`. */
interface TimestampLike {
  toDate(): Date
}

export interface PlannerSession {
  id: string
  start: TimestampLike
  end?: TimestampLike | null
  activityName?: string | null
  activityColor?: string | null
  location?: string | null
  /** Provider running the slot (appointment sessions) — distinguishes parallel slots. */
  providerName?: string | null
  /** Per-session link target; takes precedence over the shared `bookingHref`
   *  (e.g. appointment slots link to the appointments page, classes to booking). */
  href?: string
  /**
   * 'availability' renders as an outlined block rather than a solid one: it is a
   * window in which an appointment CAN be booked, not a scheduled event, and it
   * must not compete visually with the actual classes on the grid.
   * Absent ⇒ a normal session.
   */
  variant?: 'session' | 'availability'
}

const HOUR_PX = 48
const MIN_BLOCK_PX = 24
// Fallback palette for sessions whose activity has no colour set (hashed by id).
const PALETTE = ['#7C3AED', '#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#F43F5E', '#0EA5E9', '#22C55E']
const GRID_COLS = { gridTemplateColumns: '2.75rem repeat(7, minmax(6.5rem, 1fr))' } as const

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
// `dayKey` was a local copy; it and the interval→days translation now live in
// shared/utils/calendarSpan, shared with the admin grid.

function colorFor(s: PlannerSession, accent?: string): string {
  if (s.activityColor) return s.activityColor
  if (accent) return accent
  let h = 0
  for (const ch of s.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

interface Positioned {
  s: PlannerSession
  top: number
  height: number
  col: number
  cols: number
}

/**
 * Position a day's sessions on the time grid. Transitively-overlapping sessions
 * form a cluster; within it each session takes the first free column and all
 * cluster members share the column count. (Ported from SessionsCalendar.)
 */
function layoutDay(
  day: PlannerSession[],
  date: Date,
  startHour: number,
  endHour: number
): Positioned[] {
  const rangeStartMin = startHour * 60
  const rangeEndMin = endHour * 60
  const items = day
    .map((s) => {
      const st = s.start.toDate()
      const en = s.end?.toDate() ?? null
      // Was `en && sameDay(en, st) ? … : startMin + 60` — which threw away the
      // end time of anything crossing midnight and drew a flat hour instead.
      // Shared with the admin grid now (lib/calendar-span), because these two
      // files carried hand-ported copies of that clamp and only one of them
      // would ever have been fixed.
      const span = spanOnDay(st, en, date)
      const startMin = span ? span.startMin : st.getHours() * 60 + st.getMinutes()
      let endMin = span ? span.endMin : startMin + 60
      endMin = Math.min(Math.max(endMin, startMin + 30), rangeEndMin)
      return { s, startMin, endMin }
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)

  const placed: Positioned[] = []
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
        s: it.s,
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

interface Props {
  sessions: PlannerSession[]
  /** Theme accent (e.g. the website palette) used when a session has no colour. */
  accent?: string
  /** When set, each session block links here (e.g. the public booking page). */
  bookingHref?: string
  /** When set, clicking a block calls this (e.g. the kiosk detail modal). Takes
   *  precedence over `bookingHref`. */
  onSelect?: (session: PlannerSession) => void
  /** How many days ahead the schedule covers — bounds how many weeks the visitor
   *  can page forward. Defaults to 7 (a single week, no navigation shown). */
  windowDays?: number
  /**
   * The studio's regional settings. Public surfaces have no signed-in team to
   * read them off, so the page that resolved the tenant passes them in; absent
   * ⇒ the product defaults (weeks from Monday, 24-hour).
   */
  regional?: Partial<RegionalSettings> | null
}

export function WeeklyCalendar({ sessions, accent, bookingHref, onSelect, windowDays = 7, regional }: Props) {
  const fmt = useTeamFormat({ zone: 'device', regional })
  const weekStartsOn: WeekStart = fmt.weekStartsOn
  const weekStartOf = (d: Date) => startOfWeek(d, weekStartsOn)
  // Weeks the visitor can page through: from the current week up to the week
  // containing the end of the section's data window.
  const weekMs = 7 * 24 * 60 * 60 * 1000
  // The axis is a device-local clock reading, so it is built from a device-local
  // Date — only the hour cycle (24h vs AM/PM) comes from the studio.
  const hourLabel = (h: number) => fmt.custom(new Date(2000, 0, 1, h, 0), { hour: '2-digit', minute: '2-digit' })
  const maxOffset = useMemo(() => {
    const last = new Date()
    last.setDate(last.getDate() + windowDays)
    return Math.max(0, Math.floor((last.getTime() - weekStartOf(new Date()).getTime()) / weekMs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays, weekMs, weekStartsOn])
  // Land on the first week that actually has a session — for sparse/future
  // schedules (e.g. appointment slots starting next week) the current week is often
  // empty, and showing an empty grid reads as "nothing here". Near-term
  // schedules resolve to offset 0 (this week), unchanged.
  const initialOffset = useMemo(() => {
    let earliest = Infinity
    for (const s of sessions) earliest = Math.min(earliest, s.start.toDate().getTime())
    if (!isFinite(earliest)) return 0
    const off = Math.floor((earliest - weekStartOf(new Date()).getTime()) / weekMs)
    return Math.max(0, Math.min(off, maxOffset))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [weekOffset, setWeekOffset] = useState(initialOffset)

  const { weekDays, startHour, endHour } = useMemo(() => {
    const start = weekStartOf(new Date())
    start.setDate(start.getDate() + weekOffset * 7)

    const byDay = new Map<string, PlannerSession[]>()
    let sh = 8
    let eh = 20
    // Filed under every day it touches, and the hour range opened from the
    // minutes it occupies ON each of those days — not from its own clock times,
    // which belong to the day it started.
    for (const s of sessions) {
      const st = s.start.toDate()
      const en = s.end?.toDate() ?? null
      for (const span of daySpans(st, en)) {
        const arr = byDay.get(span.key)
        if (arr) arr.push(s)
        else byDay.set(span.key, [s])
        sh = Math.min(sh, Math.floor(span.startMin / 60))
        eh = Math.max(eh, Math.min(Math.ceil(span.endMin / 60), 24))
      }
    }
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(start)
      date.setDate(start.getDate() + i)
      return { date, blocks: layoutDay(byDay.get(dayKey(date)) ?? [], date, sh, eh) }
    })
    return { weekDays: days, startHour: sh, endHour: eh }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, weekOffset, weekStartsOn])

  const hourCount = endHour - startHour
  const gridHeight = hourCount * HOUR_PX
  const today = new Date()
  const now = new Date()
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60 - startHour) * HOUR_PX

  return (
    <div>
      {maxOffset > 0 && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setWeekOffset((o) => Math.max(0, o - 1))}
            disabled={weekOffset === 0}
            aria-label="Previous week"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-medium tabular-nums">
            {fmt.dayMonth(weekDays[0].date)}
            {' – '}
            {fmt.dayMonth(weekDays[6].date)}
          </span>
          <button
            type="button"
            onClick={() => setWeekOffset((o) => Math.min(maxOffset, o + 1))}
            disabled={weekOffset >= maxOffset}
            aria-label="Next week"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
      {/* Day headers */}
      <div className="grid" style={GRID_COLS}>
        <div className="sticky left-0 z-20 border-b bg-background" />
        {weekDays.map(({ date }) => {
          const isToday = sameDay(date, today)
          return (
            <div
              key={dayKey(date)}
              className={`border-b border-l px-1 py-1.5 text-center ${isToday ? 'bg-primary/5' : ''}`}
            >
              <p className="text-xs font-bold">{fmt.weekdayShort(date)}</p>
              <p className="text-xs text-muted-foreground">{fmt.dayMonth(date)}</p>
            </div>
          )
        })}
      </div>

      {/* Time grid */}
      <div className="grid" style={GRID_COLS}>
        {/* Hour axis — sticks left while scrolling horizontally */}
        <div className="sticky left-0 z-10 bg-background" style={{ height: gridHeight }}>
          <div className="relative h-full">
            {Array.from({ length: hourCount }, (_, i) => (
              <span
                key={i}
                className="absolute right-1.5 text-xs text-muted-foreground tabular-nums select-none"
                style={{ top: i * HOUR_PX + 2 }}
              >
                {hourLabel(startHour + i)}
              </span>
            ))}
          </div>
        </div>

        {/* Day columns */}
        {weekDays.map(({ date, blocks }) => {
          const isToday = sameDay(date, today)
          return (
            <div
              key={dayKey(date)}
              className={`relative border-l ${isToday ? 'bg-primary/[0.03]' : ''}`}
              style={{ height: gridHeight }}
            >
              {Array.from({ length: hourCount }, (_, i) => (
                <div key={i} className="absolute inset-x-0 border-t border-border/60" style={{ top: i * HOUR_PX }} />
              ))}

              {isToday && nowTop >= 0 && nowTop <= gridHeight && (
                <div className="absolute inset-x-0 z-10 pointer-events-none" style={{ top: nowTop }}>
                  <div className="h-px bg-red-500" />
                  <div className="absolute -top-[2.5px] left-0 h-1.5 w-1.5 rounded-full bg-red-500" />
                </div>
              )}

              {blocks.map(({ s, top, height, col, cols }) => {
                const color = colorFor(s, accent)
                const availability = s.variant === 'availability'
                const style = {
                  top: top + 1,
                  height: height - 2,
                  left: `calc(${(col / cols) * 100}% + 2px)`,
                  width: `calc(${100 / cols}% - 4px)`,
                  // Availability is a lighter wash with a dashed outline all
                  // round; a class keeps the solid fill and the left rule, so
                  // the two never read as the same kind of thing.
                  backgroundColor: availability ? `${color}0F` : `${color}1F`,
                  ...(availability ? { borderColor: color } : { borderLeftColor: color }),
                }
                const name = s.activityName ?? 'Session'
                // Provider in the title distinguishes parallel slots (e.g. three
                // "Private Lesson" columns at the same hour, one per provider).
                const label = s.providerName ? `${name} · ${s.providerName}` : name
                const timeRange = `${fmt.time(s.start)}${s.end ? ` – ${fmt.time(s.end)}` : ''}`
                // Narrow parallel columns truncate hard — the tooltip carries it all.
                const tooltip = [label, timeRange, s.location].filter(Boolean).join(' · ')
                // Already-run sessions stay on the grid (timetable) but muted.
                const ended = (s.end ?? s.start).toDate().getTime() < now.getTime()
                const inner = (
                  <>
                    <p className="truncate text-xs font-medium leading-tight">{label}</p>
                    {height >= 34 && (
                      <p className="truncate text-xs text-muted-foreground">{timeRange}</p>
                    )}
                    {height >= 52 && s.location && (
                      <p className="truncate text-xs text-muted-foreground">{s.location}</p>
                    )}
                  </>
                )
                const isAvailability = s.variant === 'availability'
                const cls = `absolute z-[5] overflow-hidden rounded-md px-1.5 py-0.5 text-left${
                  isAvailability ? ' border border-dashed' : ' border-l-2'
                }${ended ? ' opacity-45' : ''}`
                if (onSelect) {
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => onSelect(s)}
                      title={tooltip}
                      className={`${cls} transition-opacity hover:opacity-80`}
                      style={style}
                    >
                      {inner}
                    </button>
                  )
                }
                const href = s.href ?? bookingHref
                return href ? (
                  <a key={s.id} href={href} title={tooltip} className={`${cls} transition-opacity hover:opacity-80`} style={style}>
                    {inner}
                  </a>
                ) : (
                  <div key={s.id} title={tooltip} className={cls} style={style}>
                    {inner}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}
