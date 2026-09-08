/**
 * THE MATHS BEHIND A TIMELINE OF EVENTS — a window, positions within it, and
 * which row each event lands on.
 *
 * Pure and date-only: no React, no DOM, no Firestore. It lives in shared and is
 * tested from `packages/functions/src/events/eventTimeline.test.ts`, which is the
 * same arrangement `contactFilter` and `paymentOptions` use — `apps/web` has no
 * test runner, and lane packing is precisely the kind of arithmetic that is
 * wrong by one pixel for a year before anybody notices.
 *
 * ── ONE ROW UNLESS THEY CROSS ───────────────────────────────────────────────
 *
 * The whole design (Franco, 2026-09-08): a timeline is not a Gantt chart. Every
 * event gets the SAME row until two of them would sit on top of each other, and
 * only then does a second row open. A federation's year is a dozen events that
 * mostly do not overlap, so it should read as one line, not as a dozen lanes
 * with one bar each.
 *
 * ── "CROSS" MEANS ON SCREEN, NOT ON THE CALENDAR ────────────────────────────
 *
 * Two events a week apart do not overlap in TIME, and in a year view they are
 * 6px apart — with their titles written next to them, they collide badly. So
 * packing works in PIXELS over the rendered track, and an event reserves its bar
 * PLUS its label when the label will not fit inside the bar.
 *
 * That is why `trackPx` is an argument: the same twelve events pack onto one row
 * at 1200px and three rows at 360px, which is correct — they really do collide
 * on a phone. The caller measures its track and passes it in.
 *
 * The label width is ESTIMATED from the character count rather than measured
 * (measuring every title means laying out text off-screen, for a number that
 * only decides which row a bar sits on). The estimate is deliberately GENEROUS:
 * too wide opens a row that was not strictly needed, too narrow overlaps two
 * titles. The first is a slightly taller timeline, the second is unreadable.
 */

/** How much calendar the timeline shows at once. */
export type TimelineZoom = 'year' | 'month'

export const TIMELINE_ZOOMS: readonly TimelineZoom[] = ['year', 'month'] as const

/** A half-open interval `[start, end)` in LOCAL time. */
export interface TimelineWindow {
  zoom: TimelineZoom
  start: Date
  end: Date
}

/** The window of `zoom` that contains `anchor`. */
export function timelineWindow(zoom: TimelineZoom, anchor: Date): TimelineWindow {
  const y = anchor.getFullYear()
  if (zoom === 'year') {
    return { zoom, start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) }
  }
  const m = anchor.getMonth()
  return { zoom, start: new Date(y, m, 1), end: new Date(y, m + 1, 1) }
}

/**
 * The window `delta` steps away. Steps are whole years or whole months, so
 * stepping never lands mid-period and stepping back and forth returns exactly
 * where it started — `new Date(y, m + n, 1)` normalises the overflow, which is
 * why this does no modular arithmetic of its own.
 */
export function shiftTimelineWindow(w: TimelineWindow, delta: number): TimelineWindow {
  const s = w.start
  return w.zoom === 'year'
    ? timelineWindow('year', new Date(s.getFullYear() + delta, 0, 1))
    : timelineWindow('month', new Date(s.getFullYear(), s.getMonth() + delta, 1))
}

/** Where `t` sits in the window, as a fraction. Outside the window it is <0 or >1. */
export function fractionOf(w: TimelineWindow, t: Date | number): number {
  const ms = typeof t === 'number' ? t : t.getTime()
  const span = w.end.getTime() - w.start.getTime()
  return span <= 0 ? 0 : (ms - w.start.getTime()) / span
}

/** Does the window contain `t`? Half-open, like the window itself. */
export function windowContains(w: TimelineWindow, t: Date): boolean {
  return t.getTime() >= w.start.getTime() && t.getTime() < w.end.getTime()
}

// ─── ticks ───────────────────────────────────────────────────────────────────

export interface TimelineTick {
  /** Where the tick sits, as a fraction of the window. */
  at: number
  /** The date it marks — the caller formats it in the viewer's locale. */
  date: Date
  /** Whether this tick is worth a written label at the current width. */
  labelled: boolean
  /** Saturday or Sunday. Month zoom only; a year's ticks are month starts. */
  weekend: boolean
}

/**
 * The gridlines. Month starts for a year; days for a month.
 *
 * THE LABEL DENSITY IS DECIDED HERE, from the track width, because it is the
 * one thing that cannot be decided in CSS: at 1100px a month's 31 day-numbers
 * fit comfortably, at 360px they overlap into a grey smear. Every tick is still
 * RETURNED — the gridlines stay evenly spaced and only the writing thins out.
 */
export function timelineTicks(w: TimelineWindow, trackPx: number): TimelineTick[] {
  const ticks: TimelineTick[] = []
  if (w.zoom === 'year') {
    const y = w.start.getFullYear()
    // A month label is ~26px ("Sep"); below ~40px per month, label every third.
    const per = trackPx / 12
    const step = per >= 40 ? 1 : per >= 22 ? 2 : 3
    for (let m = 0; m < 12; m++) {
      const date = new Date(y, m, 1)
      ticks.push({ at: fractionOf(w, date), date, labelled: m % step === 0, weekend: false })
    }
    return ticks
  }
  const days = Math.round((w.end.getTime() - w.start.getTime()) / 86_400_000)
  const per = trackPx / days
  // A day number is ~14px; leave half again as breathing room before labelling
  // every day, then thin to every other, every fifth, every seventh.
  const step = per >= 22 ? 1 : per >= 12 ? 2 : per >= 6 ? 5 : 7
  for (let d = 0; d < days; d++) {
    const date = new Date(w.start.getFullYear(), w.start.getMonth(), 1 + d)
    const dow = date.getDay()
    ticks.push({
      at: fractionOf(w, date),
      date,
      labelled: d % step === 0,
      weekend: dow === 0 || dow === 6,
    })
  }
  return ticks
}

// ─── placement ───────────────────────────────────────────────────────────────

/** What the packer needs to know about one event. */
export interface TimelineInput {
  id: string
  /** Epoch ms. */
  start: number
  /** Epoch ms, exclusive-ish — an event ending at 18:00 stops at 18:00. */
  end: number
  /** Used only to estimate how much room its label needs. */
  title: string
}

export interface PlacedTimelineEvent {
  id: string
  /** Row, from 0. Everything sits on 0 until something collides. */
  lane: number
  /** Fraction of the window, already clamped to it. */
  left: number
  width: number
  /** The event starts before / ends after the window and is drawn cut off. */
  clippedStart: boolean
  clippedEnd: boolean
  /**
   * Where the title is drawn.
   *
   *   'inside'  the bar is wide enough to hold it.
   *   'after'   to the right of the bar, in room the packer reserved.
   *   'before'  to the LEFT of the bar — the only option for an event near the
   *             end of the window, where a label written to the right would run
   *             off the track and be clipped. That was the first thing wrong
   *             with the rendered timeline: December's events had their titles
   *             cut in half by the track's own `overflow-hidden`.
   */
  labelSide: 'inside' | 'after' | 'before'
}

export interface TimelinePlacementOptions {
  /** Measured width of the track, in CSS pixels. */
  trackPx: number
  /** Smallest a bar may be drawn. A one-day event in a year is sub-pixel. */
  minBarPx?: number
  /** Clear space demanded between one event's extent and the next's start. */
  gapPx?: number
}

const DEFAULT_MIN_BAR_PX = 8
const DEFAULT_GAP_PX = 8
/** Rough width of one character of the label type, plus the bar's padding. */
const LABEL_CHAR_PX = 6.4
const LABEL_PADDING_PX = 14
const LABEL_MAX_PX = 200

/** The room a title wants, generously — see the header on why generous. */
export function estimateLabelPx(title: string): number {
  return Math.min(LABEL_MAX_PX, title.trim().length * LABEL_CHAR_PX + LABEL_PADDING_PX)
}

/**
 * Assign every event a row, first-fit by start.
 *
 * Greedy first-fit over intervals sorted by start is OPTIMAL for interval
 * graphs — it never uses more rows than the deepest pile-up — which is exactly
 * the "one row unless they cross" promise, stated as an algorithm rather than
 * hoped for.
 *
 * Events entirely outside the window are dropped; ones that straddle an edge are
 * clipped to it and flagged, so the renderer can show that they continue rather
 * than pretending they begin at the boundary.
 *
 * TIES ARE BROKEN BY `id`, not left to sort stability. Two events starting at
 * the same instant would otherwise swap rows between renders depending on the
 * order Firestore happened to return them, which reads as the timeline
 * reshuffling itself for no reason.
 */
export function placeTimelineEvents(
  items: TimelineInput[],
  w: TimelineWindow,
  opts: TimelinePlacementOptions
): { placed: PlacedTimelineEvent[]; lanes: number } {
  const trackPx = Math.max(1, opts.trackPx)
  const minBarPx = opts.minBarPx ?? DEFAULT_MIN_BAR_PX
  const gapPx = opts.gapPx ?? DEFAULT_GAP_PX

  const wStart = w.start.getTime()
  const wEnd = w.end.getTime()

  const visible = items
    .filter((e) => e.end > wStart && e.start < wEnd)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))

  // `laneEnd[i]` is the right-most pixel row `i` is occupied to.
  const laneEnd: number[] = []
  const placed: PlacedTimelineEvent[] = []

  for (const e of visible) {
    const clippedStart = e.start < wStart
    const clippedEnd = e.end > wEnd
    const left = fractionOf(w, Math.max(e.start, wStart))
    // An event that ends exactly at the window's end must not exceed 1.
    const right = fractionOf(w, Math.min(e.end, wEnd))

    const leftPx = left * trackPx
    const barPx = Math.max(minBarPx, (right - left) * trackPx)
    const labelPx = estimateLabelPx(e.title)
    // Inside when the bar can hold the whole label. Otherwise the label needs a
    // side, and which side is decided by whether the track has room on the
    // right — an event in December has none, so its title goes to the left.
    const labelSide: PlacedTimelineEvent['labelSide'] =
      barPx >= labelPx
        ? 'inside'
        : leftPx + barPx + gapPx / 2 + labelPx <= trackPx
          ? 'after'
          : 'before'

    // THE ROW MUST RESERVE WHAT IS ACTUALLY DRAWN, on whichever side. A
    // 'before' label reaches BACKWARDS, so its claim starts left of its bar —
    // reserving only to the right would let the previous event's bar sit under
    // this one's title.
    const claimLeft = labelSide === 'before' ? leftPx - gapPx / 2 - labelPx : leftPx
    const claimRight = leftPx + barPx + (labelSide === 'after' ? gapPx / 2 + labelPx : 0)

    let lane = laneEnd.findIndex((end) => end + gapPx <= claimLeft)
    if (lane === -1) {
      lane = laneEnd.length
      laneEnd.push(claimRight)
    } else {
      laneEnd[lane] = claimRight
    }

    placed.push({
      id: e.id,
      lane,
      left,
      // Width in FRACTIONS still, but never below what minBarPx asked for —
      // the renderer positions in %, so the floor has to survive the conversion.
      width: Math.max(barPx / trackPx, right - left),
      clippedStart,
      clippedEnd,
      labelSide,
    })
  }

  return { placed, lanes: laneEnd.length }
}
