import assert from 'node:assert/strict'
import {
  TIMELINE_DAYS_PER_SCREEN,
  TIMELINE_MIN_FILL,
  TIMELINE_MIN_UNIT_PX,
  TIMELINE_YEARS_SPAN,
  estimateLabelPx,
  fractionOf,
  participationCap,
  participationFill,
  placeTimelineEvents,
  timelineDateAt,
  timelinePxPerDay,
  timelineRange,
  timelineRangeDays,
  timelineTicks,
  timelineTrackPx,
  type TimelineInput,
} from '@linyup/shared'

// Tests for the timeline's layout maths — the org events timeline lives in
// `apps/web`, which has no test runner, so its pure half lives in shared and is
// exercised from here (the arrangement contactFilter and paymentOptions use).
//
// The thing actually worth testing is the ROW PACKING. The promise is "one row
// unless they cross", and every way of getting that wrong is silent: an extra
// row nobody needed, or two titles written on top of each other.

const ms = (y: number, m: number, d: number, h = 0) => new Date(y, m, d, h).getTime()

function ev(id: string, start: number, end: number, title = 'Event'): TimelineInput {
  return { id, start, end, title }
}

/** A wide track, so packing is decided by real overlap rather than by labels. */
const WIDE = { trackPx: 4000 }

/** The built-in event types, in the order the org timeline stacks them. */
const BUILTIN_ORDER = ['competition', 'camp', 'exam', 'seminar', 'workshop', 'other']

// A range is now just `{start, end}` — the packer never cared about anything
// else, and since the track is continuous there is no window type left to
// build one from. These two say what the old `timelineWindow` said, locally.
const yearRange = (y: number) => ({ start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) })
const monthRange = (y: number, m: number) => ({
  start: new Date(y, m, 1),
  end: new Date(y, m + 1, 1),
})

describe('eventTimeline — a band per event type', () => {
  const year = yearRange(2026)
  /** An event of a given type — `ev` above leaves the band unset. */
  const typed = (id: string, group: string, month: number, title = 'Event'): TimelineInput => ({
    ...ev(id, ms(2026, month, 3), ms(2026, month, 5), title),
    group,
  })

  it('no groups at all behaves exactly as it did before bands existed', () => {
    // THE COMPATIBILITY CLAIM, asserted rather than assumed: every other test in
    // this file calls `ev`, which sets no group.
    const { lanes, bands, placed } = placeTimelineEvents(
      [ev('a', ms(2026, 5, 1), ms(2026, 5, 20)), ev('b', ms(2026, 5, 10), ms(2026, 5, 25))],
      year,
      WIDE
    )
    assert.equal(lanes, 2)
    assert.equal(bands.length, 1)
    assert.deepEqual(bands[0], { group: '', lane: 0, lanes: 2 })
    assert.deepEqual(
      placed.map((p) => p.group),
      ['', '']
    )
  })

  it('one row per type when nothing inside a type crosses', () => {
    // The premise Franco named: same type rarely overlaps. Four competitions
    // spread across a season are four bars on ONE row.
    const { lanes, bands } = placeTimelineEvents(
      [0, 3, 6, 9].map((m) => typed(`c${m}`, 'competition', m)),
      year,
      WIDE
    )
    assert.equal(lanes, 1)
    assert.deepEqual(bands, [{ group: 'competition', lane: 0, lanes: 1 }])
  })

  it('types that overlap in time take one row each', () => {
    // The gain over plain first-fit: a camp and a competition in the same week
    // needed two rows anyway, but now the rows MEAN something.
    const { lanes, bands, placed } = placeTimelineEvents(
      [typed('a', 'competition', 5), typed('b', 'camp', 5)],
      year,
      { ...WIDE, groupOrder: ['competition', 'camp'] }
    )
    assert.equal(lanes, 2)
    assert.deepEqual(bands, [
      { group: 'competition', lane: 0, lanes: 1 },
      { group: 'camp', lane: 1, lanes: 1 },
    ])
    assert.equal(placed.find((p) => p.id === 'a')?.lane, 0)
    assert.equal(placed.find((p) => p.id === 'b')?.lane, 1)
  })

  it('a band that crosses ITSELF opens a second row, and only its own', () => {
    const camps = [
      ev('a', ms(2026, 5, 1), ms(2026, 5, 20)),
      ev('b', ms(2026, 5, 10), ms(2026, 5, 25)),
    ].map((e) => ({ ...e, group: 'camp' }))
    const { lanes, bands } = placeTimelineEvents([...camps, typed('c', 'exam', 8)], year, {
      ...WIDE,
      groupOrder: ['camp', 'exam'],
    })
    assert.equal(lanes, 3)
    assert.deepEqual(bands, [
      { group: 'camp', lane: 0, lanes: 2 },
      { group: 'exam', lane: 2, lanes: 1 },
    ])
  })

  it('`groupOrder` decides the stacking, not who happens to start first', () => {
    // THE REASON THE ORDER IS THE CALLER'S. Ordering by first appearance would
    // put camp on top here and competition on top next year — the same row
    // meaning something different every time you page.
    const { bands } = placeTimelineEvents(
      [typed('camp', 'camp', 0), typed('comp', 'competition', 9)],
      year,
      { ...WIDE, groupOrder: ['competition', 'camp'] }
    )
    assert.deepEqual(
      bands.map((b) => b.group),
      ['competition', 'camp']
    )
  })

  it('a type the order does not name lands after the ones it does', () => {
    // A plugin or team-custom type. It still gets a band, just not a reserved
    // position — which beats dropping it in with an unrelated colour.
    const { bands } = placeTimelineEvents(
      [typed('x', 'hmd_fighting_cup', 1), typed('c', 'competition', 6)],
      year,
      { ...WIDE, groupOrder: ['competition', 'camp'] }
    )
    assert.deepEqual(
      bands.map((b) => b.group),
      ['competition', 'hmd_fighting_cup']
    )
  })

  it('a band with nothing visible in the window is not returned', () => {
    // An empty row is a claim that something is missing from it.
    const gone = { ...typed('old', 'camp', 6), start: ms(2019, 1, 1), end: ms(2019, 1, 2) }
    const { bands, lanes } = placeTimelineEvents([typed('c', 'competition', 6), gone], year, {
      ...WIDE,
      groupOrder: ['competition', 'camp'],
    })
    assert.deepEqual(
      bands.map((b) => b.group),
      ['competition']
    )
    assert.equal(lanes, 1)
  })

  it('bands tile the rows with no gap and no overlap', () => {
    // The invariant the renderer draws its separators from: `lane` is a drawing
    // coordinate, so a band starting anywhere but where the last one ended
    // would leave a blank row or stack two bands on one.
    const { bands, lanes } = placeTimelineEvents(
      [
        typed('a', 'competition', 0),
        typed('b', 'camp', 2),
        typed('c', 'exam', 4),
        typed('d', 'seminar', 6),
      ],
      year,
      { ...WIDE, groupOrder: BUILTIN_ORDER }
    )
    let expected = 0
    for (const b of bands) {
      assert.equal(b.lane, expected, `band ${b.group} starts where the last ended`)
      expected += b.lanes
    }
    assert.equal(expected, lanes)
  })
})

describe('eventTimeline — one row unless they cross', () => {
  const year = yearRange(2026)

  it('events that never overlap all share row 0', () => {
    const { placed, lanes } = placeTimelineEvents(
      [
        ev('a', ms(2026, 0, 10), ms(2026, 0, 12)),
        ev('b', ms(2026, 3, 1), ms(2026, 3, 3)),
        ev('c', ms(2026, 8, 20), ms(2026, 8, 22)),
      ],
      year,
      WIDE
    )
    assert.equal(lanes, 1)
    assert.ok(placed.every((p) => p.lane === 0))
  })

  it('two events that overlap take two rows, and only two', () => {
    const { placed, lanes } = placeTimelineEvents(
      [ev('a', ms(2026, 5, 1), ms(2026, 5, 20)), ev('b', ms(2026, 5, 10), ms(2026, 5, 25))],
      year,
      WIDE
    )
    assert.equal(lanes, 2)
    assert.deepEqual(placed.map((p) => p.lane).sort(), [0, 1])
  })

  it('a third event after the pile-up reuses row 0 rather than opening a row', () => {
    // THE test for first-fit. A packer that simply appended would put this on
    // row 2 and leave rows 0 and 1 with a hole in front of it.
    const { placed, lanes } = placeTimelineEvents(
      [
        ev('a', ms(2026, 5, 1), ms(2026, 5, 20)),
        ev('b', ms(2026, 5, 10), ms(2026, 5, 25)),
        ev('c', ms(2026, 9, 1), ms(2026, 9, 5)),
      ],
      year,
      WIDE
    )
    assert.equal(lanes, 2)
    assert.equal(placed.find((p) => p.id === 'c')!.lane, 0)
  })

  it('three deep needs three rows — greedy first-fit is optimal here', () => {
    const { lanes } = placeTimelineEvents(
      [
        ev('a', ms(2026, 5, 1), ms(2026, 5, 30)),
        ev('b', ms(2026, 5, 5), ms(2026, 5, 25)),
        ev('c', ms(2026, 5, 10), ms(2026, 5, 20)),
      ],
      year,
      WIDE
    )
    assert.equal(lanes, 3)
  })

  it('events that merely touch do not count as crossing', () => {
    // One ends exactly where the next begins. On a wide track the gap is real.
    const { lanes } = placeTimelineEvents(
      [ev('a', ms(2026, 0, 1), ms(2026, 5, 1)), ev('b', ms(2026, 5, 1), ms(2026, 11, 1))],
      year,
      { trackPx: 4000, gapPx: 0 }
    )
    assert.equal(lanes, 1)
  })
})

describe('eventTimeline — crossing is measured on screen, not on the calendar', () => {
  const year = yearRange(2026)

  it('two one-day events a week apart collide once their titles are drawn', () => {
    // Nine days apart in a 1000px year is ~25px — nowhere near two titles.
    const long = 'Swiss National Championship'
    const { lanes } = placeTimelineEvents(
      [
        ev('a', ms(2026, 4, 1), ms(2026, 4, 1, 18), long),
        ev('b', ms(2026, 4, 10), ms(2026, 4, 10, 18), long),
      ],
      year,
      { trackPx: 1000 }
    )
    assert.equal(lanes, 2)
  })

  it('…and the SAME pair fits on one row when the track is wide enough', () => {
    const long = 'Swiss National Championship'
    const { lanes } = placeTimelineEvents(
      [
        ev('a', ms(2026, 4, 1), ms(2026, 4, 1, 18), long),
        ev('b', ms(2026, 4, 10), ms(2026, 4, 10, 18), long),
      ],
      year,
      { trackPx: 20000 }
    )
    assert.equal(lanes, 1)
  })

  it('a long bar carries its label inside; a short one puts it alongside', () => {
    const { placed } = placeTimelineEvents(
      [
        ev('long', ms(2026, 0, 1), ms(2026, 5, 1), 'Camp'),
        ev('short', ms(2026, 8, 1), ms(2026, 8, 1, 12), 'Camp'),
      ],
      year,
      { trackPx: 1000 }
    )
    assert.equal(placed.find((p) => p.id === 'long')!.labelSide, 'inside')
    assert.equal(placed.find((p) => p.id === 'short')!.labelSide, 'after')
  })

  it('an event at the END of the window writes its title to the LEFT', () => {
    // Written to the right it would run off the track and be clipped by the
    // container — which is exactly what December's events did on first render.
    const { placed } = placeTimelineEvents(
      [ev('gala', ms(2026, 11, 20), ms(2026, 11, 20, 22), 'Year-End Gala')],
      year,
      { trackPx: 1000 }
    )
    assert.equal(placed[0].labelSide, 'before')
  })

  it('a left-written label still keeps the row to itself', () => {
    // The claim reaches BACKWARDS. Reserving only to the right would let the
    // earlier event's bar sit underneath this one's title.
    const long = 'Winter Training Block'
    const { lanes } = placeTimelineEvents(
      [
        // Close enough that the December title would overlap it.
        ev('a', ms(2026, 11, 10), ms(2026, 11, 11), 'Cup'),
        ev('b', ms(2026, 11, 20), ms(2026, 11, 21), long),
      ],
      year,
      { trackPx: 1000 }
    )
    assert.equal(lanes, 2)
  })

  it('a longer title is estimated wider, and never unboundedly so', () => {
    assert.ok(estimateLabelPx('Camp') < estimateLabelPx('Swiss National Championship'))
    assert.ok(estimateLabelPx('x'.repeat(500)) <= 200)
  })
})

describe('eventTimeline — the window edges', () => {
  const june = monthRange(2026, 5)

  it('events wholly outside are dropped', () => {
    const { placed } = placeTimelineEvents(
      [
        ev('before', ms(2026, 3, 1), ms(2026, 3, 2)),
        ev('after', ms(2026, 7, 1), ms(2026, 7, 2)),
        ev('inside', ms(2026, 5, 10), ms(2026, 5, 12)),
      ],
      june,
      WIDE
    )
    assert.deepEqual(
      placed.map((p) => p.id),
      ['inside']
    )
  })

  it('an event straddling the start is clipped to it and flagged', () => {
    const { placed } = placeTimelineEvents(
      [ev('camp', ms(2026, 4, 25), ms(2026, 5, 3))],
      june,
      WIDE
    )
    assert.equal(placed[0].left, 0)
    assert.equal(placed[0].clippedStart, true)
    assert.equal(placed[0].clippedEnd, false)
  })

  it('an event straddling the end never draws past the window', () => {
    const { placed } = placeTimelineEvents(
      [ev('camp', ms(2026, 5, 28), ms(2026, 6, 9))],
      june,
      WIDE
    )
    assert.equal(placed[0].clippedEnd, true)
    assert.ok(placed[0].left + placed[0].width <= 1 + 1e-9, 'bar escaped the track')
  })

  it('an event spanning the whole window fills it exactly', () => {
    const { placed } = placeTimelineEvents(
      [ev('season', ms(2026, 0, 1), ms(2027, 0, 1))],
      june,
      WIDE
    )
    assert.equal(placed[0].left, 0)
    assert.ok(Math.abs(placed[0].width - 1) < 1e-9)
    assert.equal(placed[0].clippedStart, true)
    assert.equal(placed[0].clippedEnd, true)
  })

  it('a zero-length event is still drawn — a minimum bar, not nothing', () => {
    const at = ms(2026, 5, 15, 9)
    const { placed } = placeTimelineEvents([ev('x', at, at)], june, { trackPx: 1000 })
    assert.equal(placed.length, 1)
    assert.ok(placed[0].width * 1000 >= 8, 'sub-pixel bar would be invisible')
  })
})

describe('eventTimeline — stability', () => {
  it('two events starting at the same instant get a deterministic order', () => {
    // Without an id tiebreak these swap rows depending on the order Firestore
    // happened to return them, and the timeline reshuffles between renders.
    const year = yearRange(2026)
    const a = ev('aaa', ms(2026, 5, 1), ms(2026, 5, 10))
    const b = ev('bbb', ms(2026, 5, 1), ms(2026, 5, 10))
    const one = placeTimelineEvents([a, b], year, WIDE).placed
    const two = placeTimelineEvents([b, a], year, WIDE).placed
    assert.deepEqual(
      one.map((p) => [p.id, p.lane]),
      two.map((p) => [p.id, p.lane])
    )
  })

  it('an empty timeline has no rows at all', () => {
    const { placed, lanes } = placeTimelineEvents([], yearRange(new Date().getFullYear()), WIDE)
    assert.equal(placed.length, 0)
    assert.equal(lanes, 0)
  })
})

describe('eventTimeline — the range is the whole archive', () => {
  const today = new Date(2026, 8, 8)

  it('covers every event, snapped outward to whole months and padded by one', () => {
    const r = timelineRange([ev('a', ms(2026, 5, 20), ms(2026, 5, 26))], today)
    // June's event and a September today: May 1 through to 1 November.
    assert.equal(r.start.getTime(), ms(2026, 4, 1))
    assert.equal(r.end.getTime(), ms(2026, 10, 1))
  })

  it('always contains today, even when every event is history', () => {
    // A federation that stopped running events still has a marker to draw, and
    // "scroll to today" still has somewhere to go.
    const r = timelineRange([ev('old', ms(2019, 2, 1), ms(2019, 2, 2))], today)
    assert.ok(r.start.getTime() <= today.getTime())
    assert.ok(r.end.getTime() > today.getTime())
    assert.equal(r.start.getFullYear(), 2019)
  })

  it('always contains today, even when every event is still ahead', () => {
    const r = timelineRange([ev('soon', ms(2028, 4, 1), ms(2028, 4, 2))], today)
    assert.ok(r.start.getTime() <= today.getTime())
    assert.equal(r.end.getFullYear(), 2028)
  })

  it('an empty archive is still a range, around today', () => {
    const r = timelineRange([], today)
    assert.equal(r.start.getTime(), ms(2026, 7, 1))
    assert.equal(r.end.getTime(), ms(2026, 10, 1))
  })

  it('spans the years between two distant events rather than either alone', () => {
    // THE WHOLE POINT: 2025 and 2027 are on ONE track. Under the window model
    // these were two different screens with a page turn between them.
    const r = timelineRange(
      [ev('a', ms(2025, 1, 1), ms(2025, 1, 2)), ev('b', ms(2027, 10, 1), ms(2027, 10, 2))],
      today
    )
    assert.equal(r.start.getFullYear(), 2025)
    assert.equal(r.end.getFullYear(), 2028)
    assert.ok(timelineRangeDays(r) > 1000)
  })

  it('reads the LATEST END, not the latest start', () => {
    // A camp starting in December and ending in January is a January event as
    // far as the track's extent is concerned.
    const r = timelineRange([ev('camp', ms(2026, 11, 28), ms(2027, 0, 4))], today)
    assert.equal(r.end.getTime(), ms(2027, 2, 1))
  })

  it('inverts its own fractions', () => {
    const r = timelineRange([ev('a', ms(2026, 2, 5), ms(2026, 2, 9))], today)
    const d = new Date(2026, 5, 17, 12)
    const back = timelineDateAt(r, fractionOf(r, d))
    assert.ok(Math.abs(back.getTime() - d.getTime()) < 1000)
  })
})

describe('eventTimeline — the zoom is a density', () => {
  it('means what it says once the viewport is wide enough', () => {
    // "Year" is a year across the viewport, at whatever width that is.
    assert.equal(timelinePxPerDay('year', 1460), 1460 / 365)
    assert.equal(timelinePxPerDay('month', 1200), 1200 / TIMELINE_DAYS_PER_SCREEN.month)
  })

  it('falls back to the floor on a phone rather than compressing', () => {
    // 351px over a year is 0.96px a day; the floor of 64px a month is more than
    // twice that, so the year stops fitting and starts scrolling — which is the
    // trade the floors were always there to make.
    const phone = timelinePxPerDay('year', 351)
    assert.ok(phone > 351 / 365)
    assert.equal(phone, TIMELINE_MIN_UNIT_PX.year / 30.44)
  })

  it('the widest zoom is floored per YEAR, the others per month and per day', () => {
    assert.equal(timelinePxPerDay('years', 10), TIMELINE_MIN_UNIT_PX.years / 365)
    assert.equal(timelinePxPerDay('month', 10), TIMELINE_MIN_UNIT_PX.month)
  })

  it('the track is the range times the density', () => {
    const r = { start: new Date(2026, 0, 1), end: new Date(2027, 0, 1) }
    assert.equal(Math.round(timelineTrackPx(r, 2)), Math.round(timelineRangeDays(r) * 2))
  })

  it('a longer archive makes a longer track at the same zoom', () => {
    // Which is the mechanism: zoom fixes the density, the data fixes the length,
    // and the difference between them is how far there is to scroll.
    const one = { start: new Date(2026, 0, 1), end: new Date(2027, 0, 1) }
    const five = { start: new Date(2022, 0, 1), end: new Date(2027, 0, 1) }
    const px = timelinePxPerDay('year', 900)
    assert.ok(timelineTrackPx(five, px) > 4.9 * timelineTrackPx(one, px))
  })
})

describe('eventTimeline — ticks follow the density, not the zoom', () => {
  const year = { start: new Date(2026, 0, 1), end: new Date(2027, 0, 1) }

  it('one range, three densities, three units', () => {
    // The unit used to be read off the zoom's NAME, which only worked while a
    // zoom was a window of known length. On a continuous track "month zoom" can
    // mean thirty days or ten years of them.
    assert.equal(timelineTicks(year, 30).unit, 'day')
    assert.equal(timelineTicks(year, 2.4).unit, 'month')
    assert.equal(timelineTicks(year, 0.8).unit, 'quarter')
  })

  it('lands on the same choices the named branches used to make', () => {
    // A laptop's panel, at each zoom. These three are the whole of the old
    // behaviour, and they must not have moved.
    assert.equal(timelineTicks(year, timelinePxPerDay('month', 872)).unit, 'day')
    assert.equal(timelineTicks(year, timelinePxPerDay('year', 872)).unit, 'month')
    assert.equal(timelineTicks(year, timelinePxPerDay('years', 872)).unit, 'quarter')
  })

  it('a year of month ticks is twelve, one per month', () => {
    const { ticks } = timelineTicks(year, 2.4)
    assert.equal(ticks.length, 12)
    assert.deepEqual(
      ticks.map((t) => t.date.getMonth()),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    )
  })

  it('a month of day ticks is its OWN number of days, February included', () => {
    assert.equal(timelineTicks(monthRange(2026, 1), 30).ticks.length, 28)
    assert.equal(timelineTicks(monthRange(2028, 1), 30).ticks.length, 29)
    assert.equal(timelineTicks(monthRange(2026, 0), 30).ticks.length, 31)
  })

  it('quarters are the four quarter-starts a year, and only January is written', () => {
    const { ticks } = timelineTicks(year, 0.8)
    assert.equal(ticks.length, 4)
    assert.ok(ticks.every((t) => t.date.getMonth() % 3 === 0 && t.date.getDate() === 1))
    assert.deepEqual(
      ticks.filter((t) => t.labelled).map((t) => t.date.getMonth()),
      [0]
    )
  })

  it('EVERY tick survives a low density — only the labels thin out', () => {
    const roomy = timelineTicks(monthRange(2026, 0), 30)
    const tight = timelineTicks(monthRange(2026, 0), 14)
    assert.equal(roomy.ticks.length, tight.ticks.length, 'the gridlines stay')
    assert.ok(
      tight.ticks.filter((t) => t.labelled).length <
        roomy.ticks.filter((t) => t.labelled).length,
      'the writing thins'
    )
  })

  it('JANUARY IS ALWAYS WRITTEN, whatever month the archive happens to start in', () => {
    // The trap this pins: thinning by counting every second month FROM THE
    // RANGE'S START lands on January only half the time — and on a track that
    // runs across a decade, January is the label carrying the year.
    const odd = { start: new Date(2025, 4, 1), end: new Date(2028, 7, 1) }
    const { ticks } = timelineTicks(odd, 1.3) // dense enough for months, thin enough to skip
    const januaries = ticks.filter((t) => t.date.getMonth() === 0)
    assert.equal(januaries.length, 3, '2026, 2027, 2028')
    assert.ok(januaries.every((t) => t.labelled))
  })

  it('ticks run the WHOLE range, not one period of it', () => {
    const threeYears = { start: new Date(2025, 0, 1), end: new Date(2028, 0, 1) }
    assert.equal(timelineTicks(threeYears, 2.4).ticks.length, 36)
    assert.equal(timelineTicks(threeYears, 0.8).ticks.length, 12)
  })

  it('weekends are flagged on day ticks and never on the coarser ones', () => {
    const days = timelineTicks(monthRange(2026, 1), 30)
    assert.ok(days.ticks.some((t) => t.weekend))
    assert.ok(days.ticks.filter((t) => t.weekend).length >= 8, 'four weekends in February')
    assert.ok(timelineTicks(year, 2.4).ticks.every((t) => !t.weekend))
    assert.ok(timelineTicks(year, 0.8).ticks.every((t) => !t.weekend))
  })
})

describe('eventTimeline — continuity', () => {
  const today = new Date(2026, 8, 8)

  it('two events a year apart sit a year apart on the track', () => {
    // A calendar year of pixels between them, not a page turn — which is the
    // whole of what "continuous" buys.
    const items = [
      ev('a', ms(2025, 5, 1), ms(2025, 5, 2)),
      ev('b', ms(2026, 5, 1), ms(2026, 5, 2)),
    ]
    const r = timelineRange(items, today)
    const px = 4
    const track = timelineTrackPx(r, px)
    const gap = (fractionOf(r, items[1].start) - fractionOf(r, items[0].start)) * track
    assert.ok(Math.abs(gap - 365 * px) < 2 * px, `expected ~a year of pixels, got ${gap}`)
  })

  it('places events from several years at once — none is out of the window', () => {
    // Under the window model exactly one of these was ever drawn.
    const items = [2024, 2025, 2026, 2027].map((y) => ev(`e${y}`, ms(y, 3, 1), ms(y, 3, 3)))
    const r = timelineRange(items, today)
    const { placed } = placeTimelineEvents(items, r, WIDE)
    assert.equal(placed.length, 4)
    assert.ok(placed.every((p) => !p.clippedStart && !p.clippedEnd))
  })

  it('nothing is clipped, because the range was built to hold it', () => {
    const items = [ev('camp', ms(2026, 11, 28), ms(2027, 0, 4))]
    const r = timelineRange(items, today)
    const { placed } = placeTimelineEvents(items, r, WIDE)
    assert.equal(placed[0].clippedStart, false)
    assert.equal(placed[0].clippedEnd, false)
    assert.ok(placed[0].left > 0 && placed[0].left + placed[0].width < 1)
  })
})

describe('eventTimeline — participation', () => {
  it('a full bar means the busiest event there has been', () => {
    assert.equal(participationFill(210, 210), 1)
    assert.equal(participationFill(105, 210), 0.5)
  })

  it('ZERO IS A REAL ZERO — an empty frame, not a floor', () => {
    // An event nobody attended is a finding, and drawing it the same as one
    // person would hide it. Inherited from the attendance chart this replaced.
    assert.equal(participationFill(0, 210), 0)
    assert.equal(participationFill(undefined, 210), 0)
    assert.equal(participationFill(null, 210), 0)
  })

  it('but ONE person is never invisible', () => {
    // 1/400 of a 20px bar is a twentieth of a pixel, which rounds to nothing
    // and says "nobody came". The floor is the whole reason this is not a
    // division.
    assert.equal(participationFill(1, 400), TIMELINE_MIN_FILL)
    assert.ok(participationFill(1, 400) > 0)
  })

  it('never overflows its frame, whatever the cap says', () => {
    assert.equal(participationFill(500, 210), 1)
  })

  it('a cap of nothing fills nothing rather than dividing by zero', () => {
    assert.equal(participationFill(10, 0), 0)
    assert.equal(participationFill(10, -1), 0)
  })

  it('the cap is the maximum, and ignores the events that have no count', () => {
    assert.equal(participationCap([12, undefined, 210, null, 7]), 210)
    assert.equal(participationCap([]), 0)
    assert.equal(participationCap([undefined, null]), 0)
  })

  it('the cap does not move when the events are reordered', () => {
    // It is computed over the whole archive precisely so it CANNOT change with
    // what is on screen: a cap that moved would redraw every bar as you
    // scrolled, and two events could not be compared by eye.
    const counts = [12, 210, 7, 96]
    assert.equal(participationCap(counts), participationCap([...counts].reverse()))
  })
})

describe('eventTimeline — banding is optional', () => {
  // What the toggle does, at the level the packer sees it: the same events,
  // handed over with or without a group.
  const items = [
    ev('c1', ms(2026, 2, 3), ms(2026, 2, 4), 'Cup'),
    ev('k1', ms(2026, 4, 10), ms(2026, 4, 17), 'Camp'),
    ev('e1', ms(2026, 6, 1), ms(2026, 6, 2), 'Grading'),
    ev('s1', ms(2026, 8, 9), ms(2026, 8, 10), 'Seminar'),
  ]
  const typed = items.map((e, i) => ({ ...e, group: ['competition', 'camp', 'exam', 'seminar'][i] }))
  const untyped = typed.map((e) => ({ ...e, group: undefined }))
  const year = yearRange(2026)

  it('withholding the group collapses the bands into one', () => {
    const { bands, lanes } = placeTimelineEvents(untyped, year, WIDE)
    assert.deepEqual(bands, [{ group: '', lane: 0, lanes: 1 }])
    assert.equal(lanes, 1, 'four events that never cross fit on one row')
  })

  it('and never needs MORE rows than banding them did', () => {
    // The reason the toggle is worth having: banding costs a row per type
    // whether or not that type's events ever collide, so unbanded is the
    // compact reading of the same season.
    const banded = placeTimelineEvents(typed, year, WIDE)
    const flat = placeTimelineEvents(untyped, year, WIDE)
    assert.equal(banded.lanes, 4, 'one row per type')
    assert.ok(flat.lanes <= banded.lanes, `${flat.lanes} should not exceed ${banded.lanes}`)
  })

  it('draws exactly the same events either way', () => {
    const banded = placeTimelineEvents(typed, year, WIDE)
    const flat = placeTimelineEvents(untyped, year, WIDE)
    assert.deepEqual(
      banded.placed.map((p) => p.id).sort(),
      flat.placed.map((p) => p.id).sort()
    )
    // Same dates, so the same horizontal positions — only the rows move.
    for (const p of flat.placed) {
      const b = banded.placed.find((x) => x.id === p.id)!
      assert.equal(p.left, b.left)
      assert.equal(p.width, b.width)
    }
  })

  it('an ungrouped event still collides with one it overlaps', () => {
    // Dropping the bands must not drop the packing: two events on top of each
    // other still take two rows.
    const clash = [
      { ...ev('a', ms(2026, 3, 1), ms(2026, 3, 20), 'A'), group: undefined },
      { ...ev('b', ms(2026, 3, 10), ms(2026, 3, 28), 'B'), group: undefined },
    ]
    assert.equal(placeTimelineEvents(clash, year, WIDE).lanes, 2)
  })
})

describe('eventTimeline — banding by owner', () => {
  // The studio schedule bands by WHOSE event it is rather than by type: its
  // organisation's dates are the fixed ones, its own are what it arranges
  // around them. The packer needs no new concept for that — it is `groupOrder`
  // over a different group — but the ORDER is the design, so it is pinned here.
  const year = yearRange(2026)
  const mine = (id: string, m: number) => ({
    ...ev(id, ms(2026, m, 4), ms(2026, m, 5), 'Club night'),
    group: 'team',
  })
  const theirs = (id: string, m: number) => ({
    ...ev(id, ms(2026, m, 12), ms(2026, m, 13), 'Championship'),
    group: 'org',
  })

  it("puts the organisation's row ABOVE the studio's, whoever started first", () => {
    // The studio's January event comes first in time, so first-appearance order
    // would put it on top — which reads as the constraints hanging off the
    // choices instead of the other way round.
    const { bands } = placeTimelineEvents([mine('a', 0), theirs('b', 5)], year, {
      ...WIDE,
      groupOrder: ['org', 'team'],
    })
    assert.deepEqual(bands, [
      { group: 'org', lane: 0, lanes: 1 },
      { group: 'team', lane: 1, lanes: 1 },
    ])
  })

  it('keeps that order when only one side has anything in view', () => {
    // A band with nothing visible is not returned, so a studio with no events
    // of its own gets one row rather than an empty one labelled "This studio".
    const { bands } = placeTimelineEvents([theirs('b', 5)], year, {
      ...WIDE,
      groupOrder: ['org', 'team'],
    })
    assert.deepEqual(bands, [{ group: 'org', lane: 0, lanes: 1 }])
  })

  it('bands by owner across every type at once', () => {
    // The point of the mode: a competition and a camp of the SAME owner share a
    // row, which by type they never would.
    const { bands, lanes } = placeTimelineEvents(
      [
        { ...ev('c', ms(2026, 1, 3), ms(2026, 1, 4), 'Cup'), group: 'org' },
        { ...ev('k', ms(2026, 7, 1), ms(2026, 7, 8), 'Camp'), group: 'org' },
      ],
      year,
      { ...WIDE, groupOrder: ['org', 'team'] }
    )
    assert.equal(lanes, 1)
    assert.deepEqual(bands, [{ group: 'org', lane: 0, lanes: 1 }])
  })
})
