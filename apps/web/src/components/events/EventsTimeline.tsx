'use client'

/**
 * THE FEDERATION'S YEAR ON ONE LINE.
 *
 * A calendar answers "what is happening in September". A timeline answers a
 * question a calendar structurally cannot: **how a season is shaped** — where
 * the events cluster, how long the camps run against the one-day competitions,
 * and how much empty summer sits between them. A twelve-cell month grid cannot
 * show that, because it never shows more than one month.
 *
 * ── ONE ROW UNLESS THEY CROSS ───────────────────────────────────────────────
 *
 * Franco's requirement (2026-09-08) and the thing that makes this readable: it
 * is NOT a Gantt chart with a row per event. Everything sits on one line until
 * two events would be drawn on top of each other, and only then does a second
 * line open. A federation's year is a dozen events that mostly do not overlap,
 * so it should read as one line.
 *
 * "Crossing" is decided in PIXELS, not in dates — two one-day events a week
 * apart are 6px apart in a year view, and with their titles written beside them
 * they collide badly. The maths, and the reason the track measures itself, are
 * in `@linyup/shared/utils/eventTimeline`; it is tested from
 * `packages/functions/src/events/eventTimeline.test.ts` because `apps/web` has
 * no test runner.
 *
 * ── WHY IT MEASURES ITSELF ──────────────────────────────────────────────────
 *
 * Packing needs the track's width in pixels, so a `ResizeObserver` feeds it
 * back. Everything else is positioned in PERCENTAGES, so the bars stay correct
 * between a resize and the next observer callback — only the row assignment is
 * ever momentarily stale, and it settles on the same frame in practice. Before
 * the first measurement nothing is drawn rather than drawn wrongly.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tip'
import { EventPeekSheet } from '@/components/events/EventPeekSheet'
import { eventTypeColor } from '@/lib/eventTypeColor'
import {
  placeTimelineEvents,
  shiftTimelineWindow,
  timelineTicks,
  timelineWindow,
  windowContains,
  fractionOf,
  TIMELINE_ZOOMS,
  type TimelineInput,
  type TimelineZoom,
} from '@linyup/shared'
import type { Event } from '@linyup/shared'

/** Row height, and the bar inside it. A row is deliberately compact: the point
 *  of this view is how many rows there AREN'T. */
const LANE_H = 34
const BAR_H = 20

export function EventsTimeline({
  events,
  onEdit,
  onDelete,
}: {
  events: Event[]
  onEdit?: (event: Event) => void
  onDelete?: (event: Event) => void
}) {
  const t = useTranslations('OrgEvents')
  const format = useFormatter()

  const [zoom, setZoom] = useState<TimelineZoom>('year')
  // The window is held as its own anchor rather than derived from "today", so
  // stepping away from the current period survives a re-render.
  const [anchor, setAnchor] = useState<Date>(() => new Date())
  const [peekId, setPeekId] = useState<string | null>(null)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const [trackPx, setTrackPx] = useState(0)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setTrackPx(entry.contentRect.width)
    })
    ro.observe(el)
    setTrackPx(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  const win = useMemo(() => timelineWindow(zoom, anchor), [zoom, anchor])

  const inputs = useMemo<TimelineInput[]>(
    () =>
      events
        .filter((e) => e.start?.toDate)
        .map((e) => ({
          id: e.id,
          start: e.start.toDate().getTime(),
          // An event with no end is a moment, not a zero-length error — the
          // packer gives it the minimum bar either way.
          end: (e.end?.toDate?.() ?? e.start.toDate()).getTime(),
          title: e.title ?? '',
        })),
    [events]
  )

  const { placed, lanes } = useMemo(
    () => placeTimelineEvents(inputs, win, { trackPx }),
    [inputs, win, trackPx]
  )
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events])
  const ticks = useMemo(() => timelineTicks(win, trackPx), [win, trackPx])

  const todayAt = windowContains(win, new Date()) ? fractionOf(win, new Date()) : null
  const measured = trackPx > 0

  const windowLabel =
    zoom === 'year'
      ? String(win.start.getFullYear())
      : format.dateTime(win.start, { month: 'long', year: 'numeric' })

  return (
    <div className="space-y-3">
      {/* ── the controls: where you are, and how much you are looking at ──── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Tip label={t('timelinePrevious')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('timelinePrevious')}
              onClick={() => setAnchor(shiftTimelineWindow(win, -1).start)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Tip>
          {/* Wide enough for "September 2026" so the arrows do not jump about
              as the label changes length from month to month. */}
          <span className="min-w-[9.5rem] text-center text-sm font-semibold capitalize">
            {windowLabel}
          </span>
          <Tip label={t('timelineNext')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('timelineNext')}
              onClick={() => setAnchor(shiftTimelineWindow(win, 1).start)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Tip>
          {todayAt === null && (
            <Button variant="ghost" size="sm" onClick={() => setAnchor(new Date())}>
              {t('timelineToday')}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-0.5 rounded-lg border bg-background p-0.5">
          {TIMELINE_ZOOMS.map((z) => (
            <button
              key={z}
              type="button"
              // THE ANCHOR IS KEPT, so zooming out from September lands on that
              // year and zooming back in returns to September rather than to
              // today. Changing zoom is a change of scale, not of place.
              onClick={() => setZoom(z)}
              aria-pressed={zoom === z}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                zoom === z
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {z === 'year' ? t('timelineZoomYear') : t('timelineZoomMonth')}
            </button>
          ))}
        </div>
      </div>

      {/* ── the track ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-3">
        <div ref={trackRef} className="relative">
          {/* THE AXIS. Gridlines for every tick, writing only where it fits —
              see `timelineTicks`, which thins the labels by track width so a
              phone shows a readable few rather than a grey smear. */}
          <div className="relative mb-1 h-5 select-none">
            {ticks.map((tick) => (
              <div
                key={tick.date.getTime()}
                className="absolute top-0 text-[10px] leading-5 text-muted-foreground"
                style={{ left: `${tick.at * 100}%` }}
              >
                {tick.labelled && (
                  <span className="-ml-px inline-block pl-1">
                    {zoom === 'year'
                      ? format.dateTime(tick.date, { month: 'short' })
                      : tick.date.getDate()}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div
            className="relative overflow-hidden rounded-md bg-muted/30"
            style={{ height: Math.max(1, lanes) * LANE_H }}
          >
            {/* Weekend shading, month zoom only. It is what makes a month
                timeline scannable — the eye finds the weeks without counting. */}
            {ticks.map((tick, i) =>
              tick.weekend ? (
                <div
                  key={`w${tick.date.getTime()}`}
                  className="absolute inset-y-0 bg-foreground/[0.04]"
                  style={{
                    left: `${tick.at * 100}%`,
                    width: `${((ticks[i + 1]?.at ?? 1) - tick.at) * 100}%`,
                  }}
                />
              ) : null
            )}

            {ticks.map((tick) => (
              <div
                key={`g${tick.date.getTime()}`}
                className="absolute inset-y-0 w-px bg-border/60"
                style={{ left: `${tick.at * 100}%` }}
              />
            ))}

            {todayAt !== null && (
              <div
                className="absolute inset-y-0 z-10 w-0.5 bg-primary/70"
                style={{ left: `${todayAt * 100}%` }}
                title={t('timelineToday')}
              />
            )}

            {measured &&
              placed.map((p) => {
                const event = byId.get(p.id)
                if (!event) return null
                const color = eventTypeColor(event.type)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPeekId(p.id)}
                    title={event.title}
                    className={`group absolute z-20 flex items-center rounded-[4px] text-left text-[11px] font-medium text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      // A clipped edge is drawn SQUARE. A rounded end says "it
                      // finishes here", which is the one thing an event running
                      // past the window does not do.
                      p.clippedStart ? 'rounded-l-none' : ''
                    } ${p.clippedEnd ? 'rounded-r-none' : ''}`}
                    style={{
                      left: `${p.left * 100}%`,
                      width: `${p.width * 100}%`,
                      top: p.lane * LANE_H + (LANE_H - BAR_H) / 2,
                      height: BAR_H,
                      background: color,
                    }}
                  >
                    {/* THREE PLACES A TITLE CAN GO, and the packer chose which
                        — see `labelSide`. An outside label is positioned
                        ABSOLUTELY so it cannot stretch the bar it belongs to,
                        and `before` exists because a December event written to
                        the right runs off the track and is clipped by this
                        container. Whichever side it took, the row already
                        reserved that space, which is what stops another event
                        being drawn underneath it. */}
                    {p.labelSide === 'inside' && (
                      <span className="truncate px-1.5">{event.title}</span>
                    )}
                    {p.labelSide === 'after' && (
                      <span className="pointer-events-none absolute left-full ml-1.5 whitespace-nowrap text-[11px] font-medium text-foreground">
                        {event.title}
                      </span>
                    )}
                    {p.labelSide === 'before' && (
                      <span className="pointer-events-none absolute right-full mr-1.5 whitespace-nowrap text-[11px] font-medium text-foreground">
                        {event.title}
                      </span>
                    )}
                  </button>
                )
              })}

            {measured && placed.length === 0 && (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                <CalendarRange className="h-4 w-4 text-muted-foreground/40" />
                {t('timelineEmpty', { window: windowLabel })}
              </div>
            )}
          </div>
        </div>
      </div>

      {peekId && (
        <EventPeekSheet
          eventId={peekId}
          onClose={() => setPeekId(null)}
          onEdit={(e) => {
            setPeekId(null)
            onEdit?.(e)
          }}
          onDelete={(e) => {
            setPeekId(null)
            onDelete?.(e)
          }}
        />
      )}
    </div>
  )
}
