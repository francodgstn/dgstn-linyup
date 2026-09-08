import assert from 'node:assert/strict'
import {
  TIMELINE_MIN_UNIT_PX,
  estimateLabelPx,
  fractionOf,
  timelineMinTrackPx,
  placeTimelineEvents,
  shiftTimelineWindow,
  timelineTicks,
  timelineWindow,
  windowContains,
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

describe('eventTimeline — the window', () => {
  it('a year window is Jan 1 to Jan 1, half-open', () => {
    const w = timelineWindow('year', new Date(2026, 6, 14))
    assert.equal(w.start.getTime(), ms(2026, 0, 1))
    assert.equal(w.end.getTime(), ms(2027, 0, 1))
  })

  it('a month window is the 1st to the 1st, and handles December', () => {
    const w = timelineWindow('month', new Date(2026, 11, 31))
    assert.equal(w.start.getTime(), ms(2026, 11, 1))
    assert.equal(w.end.getTime(), ms(2027, 0, 1))
  })

  it('stepping forward and back returns exactly where it started', () => {
    for (const zoom of ['year', 'month'] as const) {
      const w = timelineWindow(zoom, new Date(2026, 0, 15))
      const there = shiftTimelineWindow(w, 5)
      const back = shiftTimelineWindow(there, -5)
      assert.equal(back.start.getTime(), w.start.getTime(), zoom)
      assert.equal(back.end.getTime(), w.end.getTime(), zoom)
    }
  })

  it('stepping a month across a year boundary lands on the right month', () => {
    const dec = timelineWindow('month', new Date(2026, 11, 5))
    const jan = shiftTimelineWindow(dec, 1)
    assert.equal(jan.start.getTime(), ms(2027, 0, 1))
  })

  it('the window is half-open: its own end is NOT contained', () => {
    const w = timelineWindow('month', new Date(2026, 5, 1))
    assert.equal(windowContains(w, w.start), true)
    assert.equal(windowContains(w, w.end), false)
  })

  it('fractionOf spans 0 to 1 across the window', () => {
    const w = timelineWindow('year', new Date(2026, 0, 1))
    assert.equal(fractionOf(w, w.start), 0)
    assert.equal(fractionOf(w, w.end), 1)
    const half = fractionOf(w, new Date(2026, 6, 2))
    assert.ok(half > 0.49 && half < 0.51, `mid-year was ${half}`)
  })
})

describe('eventTimeline — how wide the track wants to be', () => {
  it('a year asks for twelve months of room', () => {
    const w = timelineWindow('year', new Date(2026, 3, 1))
    assert.equal(timelineMinTrackPx(w), 12 * TIMELINE_MIN_UNIT_PX.year)
  })

  it('a month asks for its OWN number of days, not an average', () => {
    // February and January must not ask for the same width, or the last days of
    // a long month are drawn tighter than the rest of the year.
    const feb = timelineMinTrackPx(timelineWindow('month', new Date(2026, 1, 1)))
    const jan = timelineMinTrackPx(timelineWindow('month', new Date(2026, 0, 1)))
    assert.equal(feb, 28 * TIMELINE_MIN_UNIT_PX.month)
    assert.equal(jan, 31 * TIMELINE_MIN_UNIT_PX.month)
    assert.ok(feb < jan)
  })

  it('a leap February asks for one more day', () => {
    const y2028 = timelineMinTrackPx(timelineWindow('month', new Date(2028, 1, 1)))
    assert.equal(y2028, 29 * TIMELINE_MIN_UNIT_PX.month)
  })

  it('the minimum is what keeps a phone off one-row-per-event', () => {
    // THE REASON THIS EXISTS. Packed against a phone's viewport every label
    // collides and the packer opens a row per event; packed against the track
    // it actually scrolls across, it does not.
    const year = timelineWindow('year', new Date(2026, 0, 1))
    const events = [0, 1, 2, 3, 4, 5].map((i) =>
      ev(`e${i}`, ms(2026, i * 2, 3), ms(2026, i * 2, 4), 'Regional Championship')
    )
    const squeezed = placeTimelineEvents(events, year, { trackPx: 330 })
    const scrolled = placeTimelineEvents(events, year, { trackPx: timelineMinTrackPx(year) })
    assert.equal(squeezed.lanes, 6, 'a 330px year really does collide everywhere')
    assert.ok(scrolled.lanes < squeezed.lanes, 'the scrollable track packs tighter')
  })
})

describe('eventTimeline — a band per event type', () => {
  const year = timelineWindow('year', new Date(2026, 0, 1))
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

describe('eventTimeline — ticks', () => {
  it('a year has twelve, one per month', () => {
    const t = timelineTicks(timelineWindow('year', new Date(2026, 0, 1)), 1200)
    assert.equal(t.length, 12)
    assert.equal(t[0].date.getMonth(), 0)
    assert.equal(t[11].date.getMonth(), 11)
  })

  it('a month has one per day, February included', () => {
    const feb = timelineTicks(timelineWindow('month', new Date(2026, 1, 1)), 1200)
    assert.equal(feb.length, 28)
    const leap = timelineTicks(timelineWindow('month', new Date(2028, 1, 1)), 1200)
    assert.equal(leap.length, 29)
  })

  it('EVERY tick survives a narrow track — only the labels thin out', () => {
    // The gridlines must stay evenly spaced; it is the writing that cannot fit.
    const wide = timelineTicks(timelineWindow('month', new Date(2026, 0, 1)), 1200)
    const narrow = timelineTicks(timelineWindow('month', new Date(2026, 0, 1)), 320)
    assert.equal(narrow.length, wide.length)
    const labelled = (ts: typeof wide) => ts.filter((x) => x.labelled).length
    assert.ok(labelled(narrow) < labelled(wide), 'a phone should label fewer days')
    assert.ok(labelled(narrow) > 0, 'but not zero')
  })

  it('weekends are flagged in a month, and never in a year', () => {
    // 2026-01-03 is a Saturday.
    const jan = timelineTicks(timelineWindow('month', new Date(2026, 0, 1)), 1200)
    assert.equal(jan[2].weekend, true)
    assert.equal(jan[3].weekend, true)
    assert.equal(jan[4].weekend, false)
    const year = timelineTicks(timelineWindow('year', new Date(2026, 0, 1)), 1200)
    assert.ok(year.every((t) => !t.weekend))
  })
})

describe('eventTimeline — one row unless they cross', () => {
  const year = timelineWindow('year', new Date(2026, 0, 1))

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
  const year = timelineWindow('year', new Date(2026, 0, 1))

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
  const june = timelineWindow('month', new Date(2026, 5, 1))

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
    const year = timelineWindow('year', new Date(2026, 0, 1))
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
    const { placed, lanes } = placeTimelineEvents([], timelineWindow('year', new Date()), WIDE)
    assert.equal(placed.length, 0)
    assert.equal(lanes, 0)
  })
})
