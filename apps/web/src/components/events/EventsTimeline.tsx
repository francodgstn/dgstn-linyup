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
 * they collide badly. The maths are in `@linyup/shared/utils/eventTimeline`;
 * they are tested from `packages/functions/src/events/eventTimeline.test.ts`
 * because `apps/web` has no test runner.
 *
 * ── ONE CONTINUOUS TRACK, NOT A WINDOW YOU PAGE ─────────────────────────────
 *
 * Franco, 2026-09-08: "can we make it like continuous scroll among the years?"
 * The track is the federation's WHOLE archive, end to end, and you scroll
 * along it — off the end of one year and into the next with no seam and nothing
 * reflowing. The zoom is a DENSITY (how much fits on screen), not a window, so
 * changing it re-scales what you are looking at rather than replacing it.
 *
 * What that retires, and what it costs:
 *
 *   GONE  the `anchor` state, `shiftTimelineWindow`, and the arrows-turn-a-page
 *         model. The arrows now scroll, and the header is a READOUT of what is
 *         on screen rather than a statement of what was chosen.
 *   GONE  measuring the track. Its width is derived — the range's length in
 *         days times the density — so only the viewport is observed.
 *   COST  the scroll position has to come back into React, which is why there
 *         is an rAF throttle AND a 16px threshold on `scrollPx`.
 *   COST  the range can be thousands of gridlines wide, so only the ticks near
 *         the viewport are put in the DOM. Bars are not virtualised: there are
 *         at most a few hundred, and they are the thing you came to see.
 *
 * Everything is positioned in PERCENTAGES of the track, so a re-measure moves
 * nothing but the row assignment, which settles on the same frame.
 *
 * DRAGGING IS FOR MICE ONLY (`pointerType === 'mouse'`). Touch already has
 * momentum scrolling that is better than anything reimplemented here, and
 * hijacking it would replace a good gesture with a worse one.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tip'
import { Segmented } from '@/components/ui/segmented'
import { EventPeekSheet } from '@/components/events/EventPeekSheet'
import { eventTypeColor } from '@/lib/eventTypeColor'
import { eventTypeLabel } from '@/lib/eventTypeLabel'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { MapPin, Users } from 'lucide-react'
import {
  BUILTIN_EVENT_TYPES,
  TIMELINE_YEARS_SPAN,
  TIMELINE_ZOOMS,
  participationCap,
  participationFill,
  placeTimelineEvents,
  timelineDateAt,
  timelinePxPerDay,
  timelineRange,
  timelineTicks,
  timelineTrackPx,
  fractionOf,
  type TimelineInput,
  type TimelineZoom,
} from '@linyup/shared'
import type { Event } from '@linyup/shared'

/** Row height, and the bar inside it. A row is deliberately compact: the point
 *  of this view is how many rows there AREN'T. */
const LANE_H = 34
const BAR_H = 20

const DAY_MS = 86_400_000

/**
 * WHAT THE ROWS MEAN.
 *
 *   'type'   one band per event type — a row you can read along, which is why
 *            bands were asked for in the first place.
 *   'owner'  one band for the organisation's events and one for the studio's.
 *            Only offered where both exist; see `ownerBandsWorth`.
 *   'none'   no bands, everything packed into as few rows as it will go.
 *
 * BANDING IS A VIEW, NOT A PROPERTY OF THE EVENTS, so every mode is the same
 * packer over the same events with a different `group` withheld or supplied.
 */
export type TimelineBandMode = 'type' | 'owner' | 'none'

const OWNER_BANDS = ['org', 'team'] as const

/** THE ORGANISATION'S ROW COMES FIRST, deliberately: on a studio's own page its
 *  federation's dates are the FIXED ones and its own are what it arranges around
 *  them, so the constraints read above the choices. */
function ownerBandOf(event: Event | undefined): string {
  return event?.scope === 'org' ? 'org' : 'team'
}

/**
 * WHAT A BAR CANNOT SAY FOR ITSELF — the dates, the length and the place.
 *
 * The bar already carries the title beside it, so repeating it here would waste
 * the one thing a hover card has that a tooltip does not: room for the answer
 * rather than the question. A one-day event states its date once; a camp states
 * the range AND the number of days, because "27 Jun – 4 Jul" is a span you have
 * to count and "8 days" is the thing you actually wanted.
 *
 * PLACE COMES FROM `location`, THE FREE-TEXT FIELD, and never from `placeId`.
 * Resolving the id means a read per event, and a hover card is not worth
 * fifteen reads on a page that has already loaded everything it needs — the
 * peek sheet, which opens on click, is where a resolved place belongs.
 */
function BarCard({ event, color, past }: { event: Event; color: string; past: boolean }) {
  const t = useTranslations('OrgEvents')
  const tE = useTranslations('Events')
  const format = useFormatter()

  const start = event.start?.toDate?.()
  const end = event.end?.toDate?.() ?? start
  if (!start) return null

  // CALENDAR days, not elapsed ones: a camp that runs 09:00 Saturday to 16:00
  // the next Saturday is eight days to everyone who is going, and 7.3 to
  // subtraction. Both ends are floored to midnight before counting.
  const d0 = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
  const d1 = new Date(end!.getFullYear(), end!.getMonth(), end!.getDate()).getTime()
  const days = Math.round((d1 - d0) / DAY_MS) + 1

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-1.5">
        <span
          className="inline-block h-2 w-2 shrink-0 translate-y-px rounded-full"
          style={{ background: color }}
        />
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {event.type ? eventTypeLabel(event.type, tE.has, tE) : t('timelineTypeless')}
        </span>
      </div>

      <div className="text-sm font-medium leading-snug">{event.title}</div>

      <div className="text-xs text-muted-foreground">
        {days <= 1
          ? format.dateTime(start, { day: 'numeric', month: 'short', year: 'numeric' })
          : `${format.dateTimeRange(start, end!, { day: 'numeric', month: 'short', year: 'numeric' })} · ${t('timelineDays', { count: days })}`}
      </div>

      {event.location && (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{event.location}</span>
        </div>
      )}

      {/* THE BAR GIVES THE SHAPE, THIS GIVES THE NUMBER. How full a bar is
          answers "did this one draw people"; nobody can read 137 off it, and
          nobody should have to. Shown only for a PAST event: an upcoming one
          has no attendance to report, and a zero there would read as a
          prediction rather than a blank.

          It counts CHECK-INS (`participants_count`), which is the only
          attendance there is — `attendees_count` is RSVPs, and who said they
          were coming is a different question from who came. A past event with
          no count is a real zero: on migrated data the field may simply never
          have been written, and inventing attendance for it would be worse than
          reporting none. (The same call the attendance chart made, before this
          view absorbed it and it was deleted in 2026-09.) */}
      {past && (
        <div className="flex items-center gap-1.5 border-t pt-1.5 text-xs text-muted-foreground">
          <Users className="h-3 w-3 shrink-0" />
          <span>{t('timelineAttended', { count: event.participants_count ?? 0 })}</span>
        </div>
      )}
    </div>
  )
}

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
  const tE = useTranslations('Events')
  const format = useFormatter()

  const [zoom, setZoom] = useState<TimelineZoom>('year')
  // Rows by type, or everything packed as tightly as it will go. Local state
  // like `zoom` and the legend's filtering, and for the same reason: it is how
  // one reader is looking at the page right now, not something a pasted link
  // should carry.
  const [bandMode, setBandMode] = useState<TimelineBandMode>('type')
  const [peekId, setPeekId] = useState<string | null>(null)
  // TODAY IS CAPTURED ONCE. It anchors the range and draws the marker, and a
  // timeline that silently re-based itself at midnight would move under anyone
  // who left the tab open.
  const [today] = useState(() => new Date())

  const trackRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [viewPx, setViewPx] = useState(0)
  // Where the scroller is, quantised — the source for the header readout and
  // for which ticks are worth putting in the DOM.
  const [scrollPx, setScrollPx] = useState(0)
  const [dragging, setDragging] = useState(false)
  // A drag that MOVED must not also fire the bar it started on. Set on the
  // first real movement, read by the bar's click handler, cleared on the next
  // press — a ref rather than state so the click sees it in the same tick.
  const draggedRef = useRef(false)
  // Types the legend has been used to switch off. A view control, not a query:
  // it is deliberately NOT in the URL, where `?view=` earns its place because a
  // pasted link should open the timeline — nobody pastes a link meaning "and
  // with camps hidden".
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())

  // ONLY THE VIEWPORT IS MEASURED NOW. The track used to be measured too,
  // because its width was `max(container, minTrackPx)` and only the DOM knew
  // which side had won. On a continuous track the width is derived — the
  // range's length in days times the density the zoom asked for — so the one
  // thing left to observe is the hole you look through it.
  useEffect(() => {
    const view = scrollRef.current
    if (!view) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setViewPx(entry.contentRect.width)
    })
    ro.observe(view)
    // Read once synchronously so the first paint draws bars rather than nothing.
    setViewPx(view.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  const inputs = useMemo<TimelineInput[]>(
    () =>
      events
        .filter((e) => e.start?.toDate)
        .map((e) => ({
          id: e.id,
          // THE BAND IS THE EVENT TYPE. It is also what colours the bar, so a
          // band reads as one colour without needing a gutter to name it.
          group: e.type ?? '',
          start: e.start.toDate().getTime(),
          // An event with no end is a moment, not a zero-length error — the
          // packer gives it the minimum bar either way.
          end: (e.end?.toDate?.() ?? e.start.toDate()).getTime(),
          title: e.title ?? '',
        })),
    [events]
  )

  // THE RANGE IS THE WHOLE ARCHIVE, and it does NOT depend on the zoom — see
  // `timelineRange`. Everything below is derived from it and one number: how
  // many pixels a day gets.
  const range = useMemo(() => timelineRange(inputs, today), [inputs, today])
  const pxPerDay = timelinePxPerDay(zoom, viewPx)
  // `max(…, viewPx)` for the degenerate archive: a federation with one event
  // has a range of about three months, which at the widest zoom is a track
  // narrower than the card it sits in. Stretching it to fill is the same
  // bargain the old `max(container, minTrackPx)` struck, kept for the only case
  // that still needs it.
  const trackPx = Math.max(timelineTrackPx(range, pxPerDay), viewPx)

  // THE BUSIEST EVENT THERE HAS BEEN — what a full bar means. Over the whole
  // archive and never over what is on screen: a cap that changed as you
  // scrolled would redraw every bar under you. See `participationFill`.
  const cap = useMemo(
    () => participationCap(events.map((e) => e.participants_count)),
    [events]
  )

  // BUILT-IN TYPES IN THEIR DECLARED ORDER, so a band stays on the same row all
  // the way through a federation's history. A plugin or team-custom type is not
  // in that list and lands after them, ordered by its first event — see
  // `groupOrder` for why ordering everything that way would be worse.
  // WHAT THE LEGEND OFFERS AND WHAT THE TRACK DRAWS ARE TWO DIFFERENT PACKS.
  //
  // The legend has to list every type there is INCLUDING the hidden ones —
  // a legend that only listed what is currently drawn would delete its own
  // "camp" entry the moment you hid camps, and there would be no way back. So
  // the full set is packed for its BAND ORDER and the filtered set for the
  // rows. Two passes over a few dozen events, and the alternative is a second
  // copy of the packer's ordering rules living here and drifting from it.
  const allBands = useMemo(
    () => placeTimelineEvents(inputs, range, { trackPx, groupOrder: BUILTIN_EVENT_TYPES }).bands,
    [inputs, range, trackPx]
  )
  const shown = useMemo(() => inputs.filter((e) => !hidden.has(e.group ?? '')), [inputs, hidden])
  /**
   * BANDING IS A VIEW, NOT A PROPERTY OF THE EVENTS — so turning it off just
   * withholds the group and lets the packer do what it did before bands
   * existed: first-fit everything into as few rows as it can.
   *
   * Both readings are worth having. Banded answers "how did the competitions
   * go this season", because a row you can read along is the whole reason the
   * bands were asked for. Unbanded answers "how busy is the year" — the same
   * events in half the rows, where the clustering and the empty stretches are
   * the shape rather than five sparse lines each telling a fifth of the story.
   *
   * `group: undefined` rather than a `delete`: the packer reads `e.group ?? ''`,
   * so an absent group and an undefined one are already the same thing to it.
   */
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events])

  /**
   * OWNER BANDS ARE OFFERED ONLY WHERE BOTH OWNERS EXIST — which is derived from
   * the events rather than passed in, so the mode appears exactly where it means
   * something and cannot be misconfigured. On an organisation's own events page
   * everything is org-scoped, so it never shows; on a studio's schedule, which
   * loads its own events AND its organisation's, it does.
   */
  const ownerBandsWorth = useMemo(() => {
    let org = false
    let team = false
    for (const e of events) {
      if (ownerBandOf(e) === 'org') org = true
      else team = true
      if (org && team) return true
    }
    return false
  }, [events])
  // Derived rather than corrected by an effect: if the events change under a
  // chosen mode that no longer applies, the view falls back on the same render
  // instead of drawing one frame of a band that is not there.
  const mode: TimelineBandMode = bandMode === 'owner' && !ownerBandsWorth ? 'type' : bandMode

  /** What a band is called in the gutter — the type, or whose event it is. */
  const bandName = useCallback(
    (group: string) =>
      mode === 'owner'
        ? group === 'org'
          ? t('timelineBandOrgRow')
          : t('timelineBandTeamRow')
        : group
          ? eventTypeLabel(group, tE.has, tE)
          : t('timelineTypeless'),
    [mode, t, tE]
  )

  const packed = useMemo(() => {
    if (mode === 'none') return shown.map((e) => ({ ...e, group: undefined }))
    if (mode === 'owner') return shown.map((e) => ({ ...e, group: ownerBandOf(byId.get(e.id)) }))
    return shown
  }, [shown, mode, byId])
  const { placed, lanes, bands } = useMemo(
    () =>
      placeTimelineEvents(packed, range, {
        trackPx,
        groupOrder: mode === 'owner' ? [...OWNER_BANDS] : BUILTIN_EVENT_TYPES,
      }),
    [packed, range, trackPx, mode]
  )
  const { unit, ticks } = useMemo(() => timelineTicks(range, pxPerDay), [range, pxPerDay])

  const todayAt = fractionOf(range, today)
  const measured = viewPx > 0
  // A grab cursor over something that cannot move is a small lie, and the one
  // people notice. 1px of slack for sub-pixel layout.
  const overflowing = measured && trackPx - viewPx > 1

  // ONLY THE TICKS NEAR THE VIEWPORT REACH THE DOM. The range is the whole of a
  // federation's history, so at day density it can run to thousands of
  // gridlines — three years of days is 1,095 of them, and a bigger archive is
  // worse. A viewport of margin on each side means a scroll never outruns the
  // last render, and `nextAt` is carried along because the weekend shading is
  // drawn as the gap to the following tick and filtering breaks the indices.
  // The bigger boundary WITHIN the current unit: a month among days, a year
  // among months and quarters. It gets the firmer gridline and the bolder label.
  const startsAPeriod = useCallback(
    (d: Date) => (unit === 'day' ? d.getDate() === 1 : d.getMonth() === 0),
    [unit]
  )

  const drawnTicks = useMemo(() => {
    const from = scrollPx - viewPx
    const to = scrollPx + viewPx * 2
    const out: { at: number; nextAt: number; date: Date; labelled: boolean; weekend: boolean }[] = []
    for (let i = 0; i < ticks.length; i++) {
      const x = ticks[i].at * trackPx
      if (!measured || (x >= from && x <= to)) {
        out.push({ ...ticks[i], nextAt: ticks[i + 1]?.at ?? 1 })
      }
    }
    return out
  }, [ticks, scrollPx, viewPx, trackPx, measured])

  // ── DRAG TO SCROLL, for mice ───────────────────────────────────────────────
  //
  // Window listeners rather than `setPointerCapture`: capture retargets the
  // pointer stream to the capturing element, so `pointerup` lands on the
  // container instead of the bar and the browser dispatches the resulting
  // `click` on their common ancestor — which silently kills every bar's click.
  // Listening on the window keeps the drag alive outside the element AND leaves
  // the bar as both the down and up target.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    const el = scrollRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    const startX = e.clientX
    const startScroll = el.scrollLeft
    draggedRef.current = false
    setDragging(true)

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      // A few pixels of slop, so a click with a shaky hand is still a click.
      if (!draggedRef.current && Math.abs(dx) > 3) draggedRef.current = true
      if (draggedRef.current) el.scrollLeft = startScroll - dx
    }
    const up = () => {
      setDragging(false)
      // The click that ends this gesture has NOT been dispatched yet — it
      // follows `pointerup` in the same task — so the flag is cleared after it
      // rather than in here. Leaving it set would swallow the next keyboard
      // Enter on a bar, which arrives as a click with no pointer behind it.
      setTimeout(() => {
        draggedRef.current = false
      }, 0)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [])

  // ── WHERE THE SCROLLER IS ──────────────────────────────────────────────────
  //
  // The scroll position is now what the window used to be: it decides what the
  // header says, which ticks are worth drawing, and whether the Today button
  // has anything to offer. So it has to come back into React — but at 60fps,
  // and it moves ~150 elements when it changes.
  //
  // Hence both throttles. `requestAnimationFrame` collapses a burst of scroll
  // events into one, and the 16px threshold drops the rest: the readout says
  // "2026", and no reader can tell it was computed a few pixels ago.
  //
  // The CENTRE is kept separately and unthrottled, because it is not display —
  // it is the anchor that holds your place when the track is re-scaled.
  const centreFracRef = useRef<number | null>(null)
  const trackPxRef = useRef(trackPx)
  trackPxRef.current = trackPx
  const rafRef = useRef(0)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (trackPxRef.current > 0) {
      centreFracRef.current = (el.scrollLeft + el.clientWidth / 2) / trackPxRef.current
    }
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const now = scrollRef.current?.scrollLeft ?? 0
      setScrollPx((prev) => (Math.abs(now - prev) >= 16 ? now : prev))
    })
  }, [])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  // OPEN ON TODAY; AFTERWARDS, STAY WHERE YOU WERE.
  //
  // The track's width changes for two reasons — the zoom was re-scaled, or the
  // window was resized — and in both the reader is looking at something and
  // expects to go on looking at it. Restoring the CENTRE fraction is what makes
  // zooming feel like a lens rather than a jump; anchoring on the left edge
  // instead would slide the view sideways every time.
  //
  // A layout effect, so the corrected position is the first one painted.
  const initedRef = useRef(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || trackPx <= 0 || viewPx <= 0) return
    const frac = initedRef.current && centreFracRef.current !== null ? centreFracRef.current : todayAt
    initedRef.current = true
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    el.scrollLeft = Math.max(0, Math.min(max, frac * trackPx - el.clientWidth / 2))
    setScrollPx(el.scrollLeft)
    // `todayAt` is read on the first run only, and re-running when it changes
    // would fight the person scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackPx, viewPx])

  /** Scroll so `frac` of the range sits in the middle of the viewport. */
  const scrollToFraction = useCallback((frac: number) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({
      left: frac * trackPxRef.current - el.clientWidth / 2,
      behavior: 'smooth',
    })
  }, [])

  /** One arrow press: most of a viewport, forwards or back. */
  const scrollBy = useCallback((dir: 1 | -1) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
  }, [])

  // WHAT IS ON SCREEN, read off the scroll position rather than chosen. The
  // half-open range makes the right edge exclusive, so a viewport ending
  // exactly at 1 January reports the year before it — which is what a reader
  // looking at December would expect it to say.
  const viewFrom = timelineDateAt(range, Math.max(0, scrollPx) / trackPx)
  const viewTo = timelineDateAt(range, Math.min(1, (scrollPx + Math.max(1, viewPx)) / trackPx))
  const midDate = timelineDateAt(range, (scrollPx + Math.max(1, viewPx) / 2) / trackPx)
  const yFrom = viewFrom.getFullYear()
  const yTo = new Date(viewTo.getTime() - 1).getFullYear()
  const windowLabel =
    zoom === 'month'
      ? format.dateTime(midDate, { month: 'long', year: 'numeric' })
      : yFrom === yTo
        ? String(yFrom)
        : // An EN DASH between the first and last year on screen.
          `${yFrom}–${yTo}`

  /**
   * THE EVENTS THE VIEWPORT IS OVER, in date order — what the list below reads.
   *
   * A timeline answers "how is the season shaped" and is bad at "what exactly
   * is that one in March", which is the question you ask the moment the shape
   * tells you something. The list is that answer, and it is bound to the SCROLL
   * rather than to a filter: what you have scrolled to IS the query, so there is
   * no second control to keep in step with the first.
   *
   * Read off `placed`, so it inherits the legend's filtering for free — switch
   * camps off and they leave the list with the rows. INTERSECTION, not
   * containment: a camp running across the whole viewport is very much in view
   * even though neither end of it is.
   */
  const inView = useMemo(() => {
    if (!measured) return []
    const from = scrollPx
    const to = scrollPx + viewPx
    return placed
      .filter((p) => p.left * trackPx < to && (p.left + p.width) * trackPx > from)
      .map((p) => byId.get(p.id))
      .filter((e): e is Event => !!e)
      .sort((a, b) => (a.start?.toDate?.()?.getTime() ?? 0) - (b.start?.toDate?.()?.getTime() ?? 0))
  }, [placed, scrollPx, viewPx, trackPx, byId, measured])

  // The button appears only when today is somewhere you cannot see, which on a
  // continuous track is a real possibility rather than a page you stepped off.
  const todayOffScreen =
    measured && (todayAt * trackPx < scrollPx || todayAt * trackPx > scrollPx + viewPx)

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
              // THE ARROWS SCROLL; THEY NO LONGER TURN A PAGE. A shade under a
              // full viewport, so a strip of what you were just reading stays on
              // screen — a full one lands you somewhere with nothing in common
              // with where you were, which is the discontinuity this whole change
              // was about. Keyboard and screen readers need them: dragging and a
              // trackpad are the only other ways across.
              onClick={() => scrollBy(-1)}
              disabled={!overflowing}
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
              onClick={() => scrollBy(1)}
              disabled={!overflowing}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Tip>
          {todayOffScreen && (
            <Button variant="ghost" size="sm" onClick={() => scrollToFraction(todayAt)}>
              {t('timelineToday')}
            </Button>
          )}
        </div>

        {/* TWO CONTROLS OF ONE KIND, so they are drawn by one component. Both
            answer "how is the track drawn" rather than "which events are on
            it", which is why neither lives down in the legend among the type
            chips, where it would read as another filter.

            `Segmented` rather than a third hand-rolled pill tray: its own
            header says it exists because this markup had been written twice and
            "two copies of a control are two places for its focus, hover and
            selected states to drift". The zoom buttons were the third copy. */}
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            ariaLabel={t('timelineBandsLabel')}
            value={mode}
            onChange={setBandMode}
            options={[
              { value: 'type' as const, label: t('timelineBandType') },
              // Offered only where both owners exist — see `ownerBandsWorth`.
              ...(ownerBandsWorth ? [{ value: 'owner' as const, label: t('timelineBandOwner') }] : []),
              { value: 'none' as const, label: t('timelineBandNone') },
            ]}
          />

          {/* NOTHING IS SAVED WHEN THE ZOOM CHANGES. It is a change of scale,
              not of place, and the scroll centre that keeps your place was
              recorded by the last scroll — the layout effect restores it once
              the new track width is known. See `centreFracRef`. */}
          <Segmented
            size="sm"
            ariaLabel={t('timelineZoomLabel')}
            value={zoom}
            onChange={setZoom}
            options={TIMELINE_ZOOMS.map((z) => ({
              value: z,
              label:
                z === 'years'
                  ? t('timelineZoomYears', { count: TIMELINE_YEARS_SPAN })
                  : z === 'year'
                    ? t('timelineZoomYear')
                    : t('timelineZoomMonth'),
            }))}
          />
        </div>
      </div>

      {/* ── the track ─────────────────────────────────────────────────────── */}
      {/* THE SCROLLER IS THE OUTER ELEMENT AND THE TRACK IS THE INNER ONE, and
          the track is now given an explicit width rather than measured: it is
          the range's length in days times the density. That removes the loop
          the old version had to live with, where the DOM decided the width and
          React had to read it back before it could pack anything.

          NO HORIZONTAL PADDING, deliberately. A continuous track should run
          under both edges of the card — content that stops short of the edge
          reads as the end of the data rather than the end of the viewport — and
          it also makes the scroll arithmetic honest: fraction `f` is at exactly
          `f * trackPx`, with no padding offset to remember. The month of empty
          range at each end (see `timelineRange`) is what keeps the first bar
          off the border.

          `overscroll-x-contain` stops a sideways flick at the end of the track
          from navigating the browser back. */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex">
          {/* THE ROW LABELS, OUTSIDE THE SCROLLER so they never scroll away from
              the rows they name — which is the whole reason a Gantt chart puts
              them in a gutter rather than on the track.

              HIDDEN BELOW `sm`. It costs ~7rem, and 7rem of a 351px phone is a
              fifth of the timeline; there the legend underneath does the naming
              instead. The spacer matches the axis above the rows exactly
              (`h-5 mb-1`), because a gutter half a row out of step is worse
              than no gutter. */}
          {/* Nothing to name when the rows are not bands — an ungrouped track
              has one band whose group is the empty string, and a gutter reading
              "No type" beside every row would be worse than no gutter. */}
          {mode !== 'none' && measured && bands.length > 0 && (
            <div className="hidden shrink-0 border-r py-3 pl-3 pr-2 sm:block">
              <div className="mb-1 h-5" aria-hidden />
              {bands.map((b) => (
                <div
                  key={`lbl-${b.group}`}
                  className="flex items-center"
                  style={{ height: b.lanes * LANE_H }}
                >
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {/* NO DOT ON AN OWNER BAND. A type band is one colour, so a
                        dot restates the bars beside it; an owner band holds
                        every type at once and a single colour would name one of
                        them, which is worse than naming none. */}
                    {mode === 'type' && (
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: eventTypeColor(b.group) }}
                      />
                    )}
                    <span className="max-w-24 truncate">{bandName(b.group)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* `min-w-0` is load-bearing: a flex child defaults to `min-width:
              auto`, which is its CONTENT width, so without this the scroller
              refuses to shrink and the whole card overflows the page instead. */}
          <div
            ref={scrollRef}
            onPointerDown={onPointerDown}
            onScroll={onScroll}
            className={`min-w-0 flex-1 overflow-x-auto overscroll-x-contain py-3 ${
              !overflowing ? '' : dragging ? 'cursor-grabbing select-none' : 'cursor-grab'
            }`}
          >
            <div ref={trackRef} className="relative" style={{ width: trackPx }}>
              {/* THE AXIS. Gridlines for every tick, writing only where it fits —
              see `timelineTicks`, which picks the unit and thins the labels by
              how many pixels a day has.

              THE YEAR IS WRITTEN WHEREVER A YEAR BEGINS, and a month wherever a
              month does. On a track that runs across a decade, "Feb" on its own
              says nothing — the reader needs to know which February — so January
              gives up its own name to carry the year, and the 1st of a month
              carries the month. It costs nothing: the position already says
              which month it is, and the word was the redundant half. */}
              <div className="relative mb-1 h-5 select-none">
                {drawnTicks.map((tick) => (
                  <div
                    key={tick.date.getTime()}
                    className="absolute top-0 text-[10px] leading-5 text-muted-foreground"
                    style={{ left: `${tick.at * 100}%` }}
                  >
                    {tick.labelled && (
                      <span
                        className={`-ml-px inline-block whitespace-nowrap pl-1 ${
                          startsAPeriod(tick.date) ? 'font-semibold text-foreground/70' : ''
                        }`}
                      >
                        {unit === 'day'
                          ? // THE MONTH NAME REPLACES THE NUMBER, it does not join
                            // it. "Aug 1" is about 30px and a day is 29 at the
                            // densities this unit appears at, so the two together
                            // crowd the 2 beside them — and the number was the
                            // redundant half, because the position already says
                            // which day this is.
                            tick.date.getDate() === 1
                            ? format.dateTime(tick.date, { month: 'short' })
                            : tick.date.getDate()
                          : tick.date.getMonth() === 0
                            ? tick.date.getFullYear()
                            : format.dateTime(tick.date, { month: 'short' })}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              <div
                className="relative overflow-hidden rounded-md bg-muted/30"
                style={{ height: Math.max(1, lanes) * LANE_H }}
              >
                {/* Weekend shading, day ticks only. It is what makes a month
                timeline scannable — the eye finds the weeks without counting. */}
                {drawnTicks.map((tick) =>
                  tick.weekend ? (
                    <div
                      key={`w${tick.date.getTime()}`}
                      className="absolute inset-y-0 bg-foreground/[0.04]"
                      style={{
                        left: `${tick.at * 100}%`,
                        width: `${(tick.nextAt - tick.at) * 100}%`,
                      }}
                    />
                  ) : null
                )}

                {drawnTicks.map((tick) => (
                  <div
                    key={`g${tick.date.getTime()}`}
                    className={`absolute inset-y-0 w-px ${
                      // The turn of a period gets a firmer line, so a track that
                      // runs across several of them has structure you can see
                      // without reading the labels.
                      startsAPeriod(tick.date) ? 'bg-border' : 'bg-border/60'
                    }`}
                    style={{ left: `${tick.at * 100}%` }}
                  />
                ))}

                {/* A HAIRLINE BETWEEN BANDS, and none above the first. Without
                it the rows are a stack; with it they read as groups, which is
                the entire point of banding. Drawn under the bars (`z-0`) so a
                bar crossing it is not sliced in half. */}
                {bands.slice(1).map((b) => (
                  <div
                    key={`band-${b.group}`}
                    className="absolute inset-x-0 z-0 h-px bg-border/70"
                    style={{ top: b.lane * LANE_H }}
                  />
                ))}

                {/* Always drawn: the range is built to contain today, so there
                is no longer a window it can fall outside of. */}
                <div
                  className="absolute inset-y-0 z-10 w-0.5 bg-primary/70"
                  style={{ left: `${todayAt * 100}%` }}
                  title={t('timelineToday')}
                />

                {measured &&
                  placed.map((p) => {
                    const event = byId.get(p.id)
                    if (!event) return null
                    const color = eventTypeColor(event.type)
                    // AN EVENT IS PAST WHEN IT HAS FINISHED, not when it started
                    // — a camp running across today is still happening, and
                    // drawing it as an attendance figure would be a count of a
                    // thing that is not over.
                    const ends = (event.end?.toDate?.() ?? event.start?.toDate?.())?.getTime() ?? 0
                    const past = ends < today.getTime()
                    const fill = past ? participationFill(event.participants_count, cap) : 0
                    return (
                      // A HOVER CARD, NOT A `title` ATTRIBUTE. The native
                      // tooltip could only repeat the name already written
                      // beside the bar; WHEN the event runs, for how long and
                      // where is the thing a timeline is being read for, and
                      // clicking each bar open to find out is the interaction
                      // this view exists to replace.
                      //
                      // `render` because base-ui's trigger is an `<a>` by
                      // default — this has to be the button that opens the peek
                      // sheet, not a link wrapped round one. The delay is well
                      // under the 600ms default: hovering ALONG a row is the
                      // gesture here, and at 600ms it feels broken.
                      <HoverCard key={p.id}>
                        <HoverCardTrigger
                          delay={200}
                          closeDelay={80}
                          render={
                            <button
                              type="button"
                              // A drag that moved is not a click on whatever it
                              // began over. `draggedRef` is set by the first few
                              // pixels of movement and read here in the same tick.
                              onClick={() => {
                                if (draggedRef.current) return
                                setPeekId(p.id)
                              }}
                              // NO `overflow-hidden` HERE, EVER. The `after` and `before`
                              // labels are absolutely positioned OUTSIDE this
                              // box, so clipping the fill to the rounded corners
                              // this way deletes almost every title on the
                              // track. The fill rounds its own bottom instead.
                              className={`group absolute z-20 flex items-center rounded-[4px] text-left text-[11px] font-medium text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                // A clipped edge is drawn SQUARE. A rounded end
                                // says "it finishes here", which is the one thing
                                // an event running past the window does not do.
                                p.clippedStart ? 'rounded-l-none' : ''
                              } ${p.clippedEnd ? 'rounded-r-none' : ''}`}
                              style={{
                                left: `${p.left * 100}%`,
                                width: `${p.width * 100}%`,
                                top: p.lane * LANE_H + (LANE_H - BAR_H) / 2,
                                height: BAR_H,
                                // THE BAR IS A FRAME AND THE FILL IS THE
                                // QUANTITY — see the `PARTICIPATION` note in the
                                // module header. The frame carries the type
                                // colour so a band still reads as one colour;
                                // the fill inside it says how many came.
                                // THE FRAME IS FAINT AND THE FILL IS THE INK.
                                // At 42% an empty bar already read as a
                                // coloured one, which left the fill almost no
                                // range to work in — a one-day event is an 8px
                                // sliver and the whole quantity has to live in
                                // 20px of height, so every bit of contrast
                                // between empty and full is worth having.
                                background: `color-mix(in srgb, ${color} ${past ? 14 : 22}%, transparent)`,
                                // AN UPCOMING EVENT IS DRAWN HOLLOW. The today
                                // marker already separates the two spatially,
                                // but that is no help once you have scrolled
                                // away from it, and an empty solid frame would
                                // otherwise be indistinguishable from a past
                                // event nobody came to.
                                border: past
                                  ? `1px solid color-mix(in srgb, ${color} 45%, transparent)`
                                  : // AN UPCOMING EVENT KEEPS ITS FULL-STRENGTH
                                    // OUTLINE. Fading it to match the faint
                                    // frame of a past one made the events you
                                    // are PLANNING the least visible thing on a
                                    // planning view — the exact opposite of
                                    // what this is for. Hollow says "no figure
                                    // yet"; faint would say "less important".
                                    `1px dashed ${color}`,
                              }}
                            />
                          }
                        >
                          {/* THE FILL IS A CHILD OF THE TRIGGER, NOT OF THE
                        RENDERED BUTTON. base-ui injects the trigger's children
                        into the element `render` returns, so giving that
                        element its own children REPLACES them — which silently
                        deleted every bar's title the first time this was
                        written. Everything the bar draws goes in here. */}
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-[3px]"
                            style={{ height: `${fill * 100}%`, background: color }}
                          />
                          {/* THREE PLACES A TITLE CAN GO, and the packer chose which
                        — see `labelSide`. An outside label is positioned
                        ABSOLUTELY so it cannot stretch the bar it belongs to,
                        and `before` exists because a December event written to
                        the right runs off the track and is clipped by this
                        container. Whichever side it took, the row already
                        reserved that space, which is what stops another event
                        being drawn underneath it. */}
                          {/* AN INSIDE LABEL GETS ITS OWN BACKING. It used to
                        be white on a solid bar; the bar is now part tint and
                        part saturated fill, and no single text colour is
                        readable on both — white disappears against the empty
                        top of a quiet event, dark text against the fill of a
                        busy one. A translucent chip is legible over either, and
                        it separates the name from the quantity behind it. */}
                          {p.labelSide === 'inside' && (
                            <span className="relative mx-1 truncate rounded-sm bg-background/75 px-1 text-foreground">
                              {event.title}
                            </span>
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
                        </HoverCardTrigger>
                        <HoverCardContent className="w-auto max-w-72">
                          <BarCard event={event} color={color} past={past} />
                        </HoverCardContent>
                      </HoverCard>
                    )
                  })}

                {/* PINNED TO TODAY, not centred in the track. The track is as
                    long as the archive and the view opens on today, so
                    `justify-center` would put this message halfway along a
                    track that can be forty thousand pixels wide — off screen,
                    and reading as a timeline that simply failed to draw. */}
                {measured && placed.length === 0 && (
                  <div
                    className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground"
                    style={{ left: `${todayAt * 100}%` }}
                  >
                    <CalendarRange className="h-4 w-4 text-muted-foreground/40" />
                    {t('timelineEmpty')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* THE LEGEND NAMES THE BANDS AND SWITCHES THEM OFF.
            On a phone it is the only thing that names them at all, the gutter
            being hidden there; on a desktop it is the control, and the gutter
            does the naming beside each row.

            IT LISTS `allBands`, NOT `bands` — every type in the window,
            including the ones currently switched off. Listing only what is
            drawn would remove "Camp" from the legend the instant you hid camps,
            and nothing would bring it back. A hidden entry is struck through
            and dimmed rather than removed, so the set of things you can switch
            on never changes under you.

            `allBands` IS ALSO WHY IT SURVIVES UNGROUPING. The legend does two
            jobs — it names the bands and it filters by type — and only the
            first one depends on the rows being bands. `allBands` is packed WITH
            groups whatever the toggle says, so switching banding off leaves the
            filter, and the colours, exactly where they were. */}
        {allBands.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t px-3 py-2">
            {allBands.map((b) => {
              const off = hidden.has(b.group)
              const label = b.group ? eventTypeLabel(b.group, tE.has, tE) : t('timelineTypeless')
              return (
                <li key={b.group}>
                  <button
                    type="button"
                    aria-pressed={!off}
                    onClick={() =>
                      setHidden((prev) => {
                        const next = new Set(prev)
                        if (!next.delete(b.group)) next.add(b.group)
                        return next
                      })
                    }
                    className="flex items-baseline gap-1.5 rounded text-[11px] transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={`inline-block h-2 w-2 shrink-0 translate-y-px rounded-full ${off ? 'opacity-30' : ''}`}
                      style={{ background: eventTypeColor(b.group) }}
                    />
                    <span
                      className={
                        off ? 'text-muted-foreground/50 line-through' : 'text-muted-foreground'
                      }
                    >
                      {label}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* ── WHAT YOU ARE LOOKING AT, SPELLED OUT ──────────────────────────────
          BELOW the track, not beside it. A column alongside would cost the
          timeline a third of its width, and width is the one thing it cannot
          spare: at 1440 the panel is 872px and a 65/35 split leaves ~560, which
          is under the floor a year needs — "Year" would quietly stop meaning a
          year on screen. Below, both get the full width and the sync, which was
          the valuable half, costs nothing. */}
      {measured && (
        <div className="rounded-xl border bg-card">
          <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-medium">{t('timelineInView')}</span>
            <span className="text-xs text-muted-foreground">
              {t('timelineInViewCount', { count: inView.length })}
            </span>
          </div>

          {inView.length === 0 ? (
            // An empty stretch is a FINDING, not a failure — a quiet summer is
            // one of the things this view exists to show — so it says so rather
            // than offering to widen the search.
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('timelineInViewEmpty')}
            </p>
          ) : (
            <ul className="divide-y">
              {inView.map((e) => {
                const start = e.start?.toDate?.()
                const ends = (e.end?.toDate?.() ?? start)?.getTime() ?? 0
                const isPast = ends < today.getTime()
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setPeekId(e.id)}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      {/* The same glyph the bar uses — hollow while it is still
                          ahead, filled once it has run — so a row and its bar
                          are recognisably the same thing. */}
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: isPast ? eventTypeColor(e.type) : 'transparent',
                          border: `1px ${isPast ? 'solid' : 'dashed'} ${eventTypeColor(e.type)}`,
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{e.title}</span>
                      {/* WHOSE EVENT IT IS, and only where that is a real
                          question — a studio's schedule carries its own events
                          and its organisation's, an organisation's page only
                          its own. Marked on the ORGANISATION's rows alone:
                          badging both is noise, and the one worth spotting is
                          the date somebody else fixed.

                          At every width, unlike the type beside it, because the
                          gutter that names the owner bands is hidden below `sm`
                          — on a phone this row is the only thing that says. */}
                      {ownerBandsWorth && ownerBandOf(e) === 'org' && (
                        <span className="shrink-0 rounded border px-1 py-px text-[10px] text-muted-foreground">
                          {t('timelineBandOrgRow')}
                        </span>
                      )}
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                        {e.type ? eventTypeLabel(e.type, tE.has, tE) : t('timelineTypeless')}
                      </span>
                      {isPast && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                          <Users className="h-3 w-3" />
                          {e.participants_count ?? 0}
                        </span>
                      )}
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {start ? format.dateTime(start, { day: 'numeric', month: 'short' }) : '—'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

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
