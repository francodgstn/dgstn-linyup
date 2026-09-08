/**
 * THE MATHS BEHIND A TIMELINE OF EVENTS — a range, positions within it, and
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

/**
 * How much calendar the viewport shows AT ONCE.
 *
 * THIS IS A DENSITY, NOT A WINDOW (Franco, 2026-09-08: "continuous scroll among
 * the years"). The track is one unbroken span of the federation's whole history
 * — see `timelineRange` — and the zoom only decides how tightly it is drawn, so
 * scrolling right runs off the end of one year and into the next with no seam,
 * no page and no reflow. Changing zoom re-scales what you are looking at rather
 * than replacing it.
 */
export type TimelineZoom = 'years' | 'year' | 'month'

/** Widest first, which is the order the zoom control renders them in. */
export const TIMELINE_ZOOMS: readonly TimelineZoom[] = ['years', 'year', 'month'] as const

/**
 * How many years the widest zoom fits on screen, and it is THREE for a reason:
 * a federation asking "how does next season sit against this one" needs the year
 * before and the year after in the same picture. Two would answer only half of
 * that, and four starts compressing a year past the point where a bar is a bar.
 */
export const TIMELINE_YEARS_SPAN = 3

/** A half-open interval `[start, end)` in LOCAL time. */
export interface TimelineRange {
  start: Date
  end: Date
}

/** Days of calendar the viewport holds at each zoom. The zoom IS this number. */
export const TIMELINE_DAYS_PER_SCREEN: Record<TimelineZoom, number> = {
  years: 365 * TIMELINE_YEARS_SPAN,
  year: 365,
  month: 30,
}

const DAY_MS = 86_400_000
/** Mean days per unit, for converting the floors below into a density. */
const DAYS_PER_UNIT: Record<TimelineZoom, number> = { years: 365, year: 30.44, month: 1 }

/**
 * THE WHOLE EXTENT THE TRACK COVERS: every event there is, plus today.
 *
 * The page already holds every org event — it hands the timeline `[...upcoming,
 * ...past]` with no date bound — so the continuous track costs nothing to fill
 * and there is no window left to page between. Today is always included, so the
 * marker has somewhere to be even for a federation whose events are all history.
 *
 * IT TAKES NO ZOOM, deliberately. A range that changed with the zoom would move
 * the ground under you every time you re-scaled: the same scroll fraction would
 * be a different date, and the view would jump. Zoom-independent means switching
 * from a year to three years keeps you looking at the same month.
 *
 * Snapped outward to whole months and padded by one, so the earliest event is
 * never flush against the edge with its label clipped, and there is always a
 * little empty track that says "nothing before this" rather than a hard stop
 * that might be a scroll that failed.
 */
export function timelineRange(
  items: readonly { start: number; end: number }[],
  today: Date
): TimelineRange {
  const now = today.getTime()
  let min = now
  let max = now
  for (const e of items) {
    if (e.start < min) min = e.start
    if (e.end > max) max = e.end
  }
  const a = new Date(min)
  const b = new Date(max)
  return {
    start: new Date(a.getFullYear(), a.getMonth() - 1, 1),
    // +1 closes the month `max` falls in, +1 again is the pad.
    end: new Date(b.getFullYear(), b.getMonth() + 2, 1),
  }
}

/** Whole days the range covers. Fractional across a DST boundary; that is fine
 *  for a width, and every position is computed from milliseconds regardless. */
export function timelineRangeDays(r: TimelineRange): number {
  return Math.max(1, (r.end.getTime() - r.start.getTime()) / DAY_MS)
}

/** Where `t` sits in the range, as a fraction. Outside it this is <0 or >1. */
export function fractionOf(r: TimelineRange, t: Date | number): number {
  const ms = typeof t === 'number' ? t : t.getTime()
  const span = r.end.getTime() - r.start.getTime()
  return span <= 0 ? 0 : (ms - r.start.getTime()) / span
}

/** The inverse: the date a fraction of the way along. Used to say what is on
 *  screen, which is now a question about the scroll position rather than about
 *  a window the component chose. */
export function timelineDateAt(r: TimelineRange, fraction: number): Date {
  return new Date(r.start.getTime() + fraction * (r.end.getTime() - r.start.getTime()))
}

// ─── how wide the track wants to be ──────────────────────────────────────────

/**
 * The narrowest a single unit may be drawn — a month in a year view, a day in a
 * month view.
 *
 * BELOW THIS THE VIEW STOPS BEING A TIMELINE. Squeezed into a phone's 330px a
 * year gives each month 27px, every label collides with every other, and the
 * packer — correctly — opens a row per event, at which point it is a list with
 * extra steps. The answer is not to squeeze harder but to let the track be as
 * wide as it needs and SCROLL, which is what these numbers are for.
 *
 * THIS IS A FLOOR, NOT A PREFERRED WIDTH — read it as "narrower than this is
 * broken", never as "this is how wide a year should be". Pitching it at what
 * looks comfortable instead costs a phantom scrollbar on every viewport that
 * lands just under it: 80px per month put a year at 960 and made a 1440px
 * laptop — whose panel measures 950 — scroll by ten pixels.
 *
 * 64px per month puts a year at 768: several times the label it has to hold
 * ("Sep" is about 19px at this size), so the axis stays legible and the packer
 * keeps the lane count it would have on a desktop, while laptops draw the whole
 * year with room to spare and only tablets and phones scroll. 28px per day
 * holds a two-digit date the same way and puts a long month at 868.
 *
 * The widest zoom is measured PER YEAR rather than per month, because at that
 * scale a month is never labelled and never needs to be: 300px a year keeps the
 * four year labels apart and still leaves a fortnight-long camp about 12px of
 * bar, which reads as a bar rather than a tick.
 */
export const TIMELINE_MIN_UNIT_PX: Record<TimelineZoom, number> = {
  years: 300,
  year: 64,
  month: 28,
}

/**
 * How many pixels one day gets — the single number the whole track is drawn
 * from.
 *
 * TWO CLAIMS, AND THE LARGER WINS. The zoom asks for a FIT: a year across the
 * viewport means `viewport / 365`, which is what makes "Year" mean a year on
 * screen at any width. `TIMELINE_MIN_UNIT_PX` asks for a FLOOR, which is what
 * stops a phone compressing that year into an unreadable smear. On a laptop the
 * fit is the larger and the zoom means exactly what it says; on a phone the
 * floor takes over and the year simply scrolls, which is the trade the floors
 * were always there to make.
 */
export function timelinePxPerDay(zoom: TimelineZoom, viewportPx: number): number {
  const fit = Math.max(1, viewportPx) / TIMELINE_DAYS_PER_SCREEN[zoom]
  return Math.max(fit, TIMELINE_MIN_UNIT_PX[zoom] / DAYS_PER_UNIT[zoom])
}

/** How wide the whole track is drawn. There is no `max(container, …)` any more:
 *  the range is longer than the viewport by construction, so the track's width
 *  is simply its length in days times the density. */
export function timelineTrackPx(r: TimelineRange, pxPerDay: number): number {
  return Math.max(1, timelineRangeDays(r) * pxPerDay)
}

// ─── ticks ───────────────────────────────────────────────────────────────────

/** What one gridline stands for. There is no 'year' member: the coarsest
 *  density any zoom can reach is the widest zoom's floor of 300px a year, and a
 *  quarter is still 75px there — so a year-unit tick is unreachable, and an
 *  unreachable branch is a lie about what the code does. */
export type TimelineTickUnit = 'day' | 'month' | 'quarter'

export interface TimelineTick {
  /** Where the tick sits, as a fraction of the range. */
  at: number
  /** The date it marks — the caller formats it in the viewer's locale. */
  date: Date
  /** Whether this tick is worth a written label at the current density. */
  labelled: boolean
  /** Saturday or Sunday. Day ticks only. */
  weekend: boolean
}

/**
 * The gridlines across the WHOLE range.
 *
 * ── THE UNIT COMES FROM THE DENSITY, NOT FROM THE ZOOM'S NAME ───────────────
 *
 * It used to be one branch per zoom, which worked only because a zoom was a
 * window of known length. On a continuous track "month zoom" can mean thirty
 * days or ten years of them, so the question a tick has to answer is not which
 * zoom is selected but how much room one day has. Picking from `pxPerDay` also
 * collapses the three branches into one ladder, and lands on exactly the same
 * choices the named branches made: 28px a day is still days, a year across a
 * laptop (~2.4px a day) is still months, three years (~0.8) is still quarters.
 *
 * THE LABELS THIN, THE GRIDLINES DO NOT — the lines stay evenly spaced and only
 * the writing drops out, which is what keeps the grid readable while the
 * density changes under it.
 *
 * A LABEL IS COUNTED FROM THE CALENDAR, NEVER FROM THE RANGE'S START. Counting
 * every second month from wherever the earliest event happens to sit would land
 * on January only half the time, and January is the one label a multi-year
 * track cannot do without — it is where the year gets written.
 */
export function timelineTicks(
  r: TimelineRange,
  pxPerDay: number
): { unit: TimelineTickUnit; ticks: TimelineTick[] } {
  const unit: TimelineTickUnit = pxPerDay >= 12 ? 'day' : pxPerDay >= 1.2 ? 'month' : 'quarter'
  const ticks: TimelineTick[] = []
  const endMs = r.end.getTime()

  if (unit === 'day') {
    // A day number is ~14px; below ~22px per day, label the odd days only.
    const step = pxPerDay >= 22 ? 1 : 2
    const d = new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate())
    for (; d.getTime() < endMs; d.setDate(d.getDate() + 1)) {
      const date = new Date(d)
      const dow = date.getDay()
      ticks.push({
        at: fractionOf(r, date),
        date,
        labelled: step === 1 || date.getDate() % 2 === 1,
        weekend: dow === 0 || dow === 6,
      })
    }
    return { unit, ticks }
  }

  // Month and quarter both walk months; the quarter keeps every third.
  const perMonth = pxPerDay * 30.44
  // A month label is ~26px ("Sep"); below ~40px, label every second or third.
  const step = unit === 'quarter' ? 3 : perMonth >= 40 ? 1 : perMonth >= 22 ? 2 : 3
  const m = new Date(r.start.getFullYear(), r.start.getMonth(), 1)
  for (; m.getTime() < endMs; m.setMonth(m.getMonth() + 1)) {
    const date = new Date(m)
    if (unit === 'quarter' && date.getMonth() % 3 !== 0) continue
    ticks.push({
      at: fractionOf(r, date),
      date,
      // A quarter writes only January — the year. See the header.
      labelled: unit === 'quarter' ? date.getMonth() === 0 : date.getMonth() % step === 0,
      weekend: false,
    })
  }
  return { unit, ticks }
}

// ─── participation ───────────────────────────────────────────────────────────

/**
 * The least a bar with anybody in it is filled.
 *
 * One person against a cap of four hundred is 0.25% of a 20px bar — a quarter
 * of a pixel, which rounds to nothing and says "nobody came". The floor is what
 * keeps "somebody" and "nobody" visibly different, and it is the only reason
 * this is not just a division.
 */
export const TIMELINE_MIN_FILL = 0.12

/**
 * How full to draw an event's bar, 0..1 — the attendance chart's encoding, moved
 * onto the timeline.
 *
 * ── ZERO IS A REAL ZERO ─────────────────────────────────────────────────────
 *
 * An event nobody attended returns exactly 0 and is drawn as an empty frame,
 * which is the honest picture. `EventAttendanceTrendCard` made the same call
 * for the same reason, and a missing `participants_count` on a PAST event is
 * read as 0 there too — on migrated data the field may simply never have been
 * written, and inventing attendance for it would be worse than showing none.
 * The caller decides whether an event is past; an upcoming one is not asked.
 *
 * ── THE CAP IS THE ARCHIVE'S OWN MAXIMUM ────────────────────────────────────
 *
 * So a full bar means "the best-attended event this federation has had", which
 * needs no legend to explain. It must be computed over the WHOLE archive and
 * never over what happens to be on screen: a cap that changed as you scrolled
 * would redraw every bar under you, and two events could not be compared by
 * eye — which is the entire point of putting the quantity here.
 */
export function participationFill(count: number | undefined | null, cap: number): number {
  if (!count || count <= 0 || cap <= 0) return 0
  return Math.max(TIMELINE_MIN_FILL, Math.min(1, count / cap))
}

/** The busiest event there has been, which is what a full bar means. */
export function participationCap(counts: readonly (number | undefined | null)[]): number {
  let max = 0
  for (const c of counts) if (c && c > max) max = c
  return max
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
  /**
   * The BAND this event belongs to — its event type, for the org timeline.
   *
   * Absent on every event ⇒ one band, and the packer behaves exactly as it did
   * before bands existed. Absent on SOME is treated as its own band (`''`)
   * rather than merged into a neighbour's, because a typeless event sharing a
   * row with the competitions would say it was one.
   */
  group?: string
}

export interface PlacedTimelineEvent {
  id: string
  /** The band it was packed in — echoed back so the renderer needn't re-derive. */
  group: string
  /**
   * Row, from 0, ACROSS THE WHOLE TRACK — a band's own rows are offset by the
   * bands above it, so this is a drawing coordinate and not an index into
   * anything.
   */
  lane: number
  /** Fraction of the range, already clamped to it. */
  left: number
  width: number
  /** The event starts before / ends after the range and is drawn cut off.
   *  The range covers every event by construction, so on the org timeline these
   *  are always false — they are kept for a caller that passes a narrower one. */
  clippedStart: boolean
  clippedEnd: boolean
  /**
   * Where the title is drawn.
   *
   *   'inside'  the bar is wide enough to hold it.
   *   'after'   to the right of the bar, in room the packer reserved.
   *   'before'  to the LEFT of the bar — the only option for an event near the
   *             end of the range, where a label written to the right would run
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
  /**
   * The order bands are stacked in. Groups it does not name follow, ordered by
   * their first event.
   *
   * IT MATTERS THAT THE CALLER DECIDES. Ordering by first appearance alone
   * would be stable within one window and reshuffle between them — page from
   * 2026 to 2027 and the row that was competitions becomes camps, which is the
   * one thing banding is supposed to prevent. A fixed vocabulary (the built-in
   * event types) keeps a band in the same place all the way through a
   * federation's history.
   */
  groupOrder?: string[]
}

/** One band of the track: which group it is, and the rows it occupies. */
export interface TimelineBand {
  group: string
  /** First lane index, inclusive. */
  lane: number
  /** How many rows the band needed — 1 unless its own events crossed. */
  lanes: number
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
 * Assign every event a row, first-fit by start, WITHIN ITS BAND.
 *
 * Greedy first-fit over intervals sorted by start is OPTIMAL for interval
 * graphs — it never uses more rows than the deepest pile-up — which is exactly
 * the "one row unless they cross" promise, stated as an algorithm rather than
 * hoped for. Bands do not weaken it: each is packed that way on its own, and
 * they are stacked.
 *
 * ── WHY BAND AT ALL, WHEN FIRST-FIT ALREADY USES FEWEST ROWS ────────────────
 *
 * Because fewest rows was never the goal — a READABLE year was, and an
 * unbanded row means nothing. It holds whatever happened to fit: a competition,
 * then a camp, then a grading, in an order that changes as soon as one event
 * moves. Banding by type costs a row or two (a band is one row unless its own
 * events cross, and same-type events rarely do) and buys a row you can read
 * along: "here is every competition this season" (Franco, 2026-09-08).
 *
 * Events entirely outside the range are dropped; ones that straddle an edge are
 * clipped to it and flagged, so the renderer can show that they continue rather
 * than pretending they begin at the boundary. A band with no visible event is
 * not returned — an empty row is a claim that something is missing.
 *
 * TIES ARE BROKEN BY `id`, not left to sort stability. Two events starting at
 * the same instant would otherwise swap rows between renders depending on the
 * order Firestore happened to return them, which reads as the timeline
 * reshuffling itself for no reason.
 */
export function placeTimelineEvents(
  items: TimelineInput[],
  w: TimelineRange,
  opts: TimelinePlacementOptions
): { placed: PlacedTimelineEvent[]; lanes: number; bands: TimelineBand[] } {
  const trackPx = Math.max(1, opts.trackPx)
  const minBarPx = opts.minBarPx ?? DEFAULT_MIN_BAR_PX
  const gapPx = opts.gapPx ?? DEFAULT_GAP_PX

  const wStart = w.start.getTime()
  const wEnd = w.end.getTime()

  const visible = items
    .filter((e) => e.end > wStart && e.start < wEnd)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))

  // Grouped in the sorted order, so each band's list is already sorted and the
  // insertion order records which band's first event came first — the tiebreak
  // for anything `groupOrder` does not name.
  const byGroup = new Map<string, TimelineInput[]>()
  for (const e of visible) {
    const key = e.group ?? ''
    const list = byGroup.get(key)
    if (list) list.push(e)
    else byGroup.set(key, [e])
  }

  const order = opts.groupOrder ?? []
  const groups = [...byGroup.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    // Named groups first, in the caller's order; the rest keep the insertion
    // order above, which is first-event-first.
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return 0
  })

  const placed: PlacedTimelineEvent[] = []
  const bands: TimelineBand[] = []
  let laneOffset = 0

  for (const group of groups) {
    // `laneEnd[i]` is the right-most pixel row `i` OF THIS BAND is occupied to.
    // It resets per band, which is the whole of the change: a competition never
    // has to fit around a camp.
    const laneEnd: number[] = []
    placeInBand(byGroup.get(group) ?? [], group, laneEnd)
    bands.push({ group, lane: laneOffset, lanes: laneEnd.length })
    laneOffset += laneEnd.length
  }

  return { placed, lanes: laneOffset, bands }

  function placeInBand(band: TimelineInput[], group: string, laneEnd: number[]) {
    for (const e of band) {
      const clippedStart = e.start < wStart
      const clippedEnd = e.end > wEnd
      const left = fractionOf(w, Math.max(e.start, wStart))
      // An event that ends exactly at the range's end must not exceed 1.
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
        group,
        // The band's own row, shifted past every band above it.
        lane: laneOffset + lane,
        left,
        // Width in FRACTIONS still, but never below what minBarPx asked for —
        // the renderer positions in %, so the floor has to survive the conversion.
        width: Math.max(barPx / trackPx, right - left),
        clippedStart,
        clippedEnd,
        labelSide,
      })
    }
  }
}
