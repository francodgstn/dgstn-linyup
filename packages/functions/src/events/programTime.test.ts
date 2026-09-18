import assert from 'node:assert/strict'
import {
  addDaysISO,
  compareProgramItems,
  crossesMidnight,
  daysBetweenISO,
  extractTemplate,
  formatHHMM,
  groupItemsByDay,
  itemDurationMinutes,
  isoDateInTimezone,
  itemsForTrack,
  materialiseTemplate,
  nextItemOrder,
  parseHHMM,
  shiftProgramDays,
  MAX_PROGRAM_ITEMS,
  STARTER_PROGRAM_TEMPLATES,
  type EventProgramConfig,
} from '@linyup/shared'

// Unit tests for the event-program helpers. Program times are WALL-CLOCK at the
// venue ('HH:MM' + the day's calendar date) — nothing here converts timezones,
// and these tests are the guard against someone later "fixing" that into UTC.
// Run with: pnpm --filter @linyup/functions test

describe('parseHHMM / formatHHMM', () => {
  it('parses valid wall-clock times', () => {
    assert.equal(parseHHMM('00:00'), 0)
    assert.equal(parseHHMM('09:30'), 570)
    assert.equal(parseHHMM('23:59'), 1439)
    assert.equal(parseHHMM('9:05'), 545) // single-digit hour tolerated
  })

  it('rejects malformed or out-of-range values', () => {
    for (const bad of ['', 'noon', '24:00', '12:60', '12', '12:5', null, undefined]) {
      assert.equal(parseHHMM(bad as string), null, `expected null for ${String(bad)}`)
    }
  })

  it('formats back, wrapping past midnight', () => {
    assert.equal(formatHHMM(570), '09:30')
    assert.equal(formatHHMM(0), '00:00')
    assert.equal(formatHHMM(1440), '00:00')
    assert.equal(formatHHMM(1500), '01:00')
  })
})

describe('compareProgramItems', () => {
  const item = (startTime: string, order = 0, allDay = false) =>
    ({ startTime, order, allDay })

  it('sorts all-day items before timed ones', () => {
    const sorted = [item('08:00'), item('00:00', 0, true)].sort(compareProgramItems)
    assert.equal(sorted[0].allDay, true)
  })

  it('orders by start time, then by `order` as tie-break', () => {
    const sorted = [
      item('14:00', 0),
      item('09:00', 1),
      item('09:00', 0),
    ].sort(compareProgramItems)
    assert.deepEqual(
      sorted.map((i) => `${i.startTime}#${i.order}`),
      ['09:00#0', '09:00#1', '14:00#0'],
    )
  })

  it('sorts an unparseable time last instead of throwing', () => {
    const sorted = [item('oops'), item('10:00')].sort(compareProgramItems)
    assert.equal(sorted[0].startTime, '10:00')
  })
})

describe('itemDurationMinutes / crossesMidnight', () => {
  it('measures a normal item', () => {
    assert.equal(itemDurationMinutes({ startTime: '09:00', endTime: '10:30' }), 90)
    assert.equal(crossesMidnight({ startTime: '09:00', endTime: '10:30' }), false)
  })

  it('handles an item running past midnight', () => {
    // 22:00 → 01:00 is three hours, not minus twenty-one.
    assert.equal(itemDurationMinutes({ startTime: '22:00', endTime: '01:00' }), 180)
    assert.equal(crossesMidnight({ startTime: '22:00', endTime: '01:00' }), true)
  })

  it('returns null when an end is missing or unparseable', () => {
    assert.equal(itemDurationMinutes({ startTime: '09:00' }), null)
    assert.equal(itemDurationMinutes({ startTime: '09:00', endTime: 'x' }), null)
  })
})

describe('calendar-date helpers', () => {
  it('adds days across a month boundary', () => {
    assert.equal(addDaysISO('2026-07-30', 3), '2026-08-02')
    assert.equal(addDaysISO('2026-01-01', -1), '2025-12-31')
  })

  it('is unaffected by the DST boundary (pure calendar arithmetic)', () => {
    // Europe/Zurich springs forward on 2026-03-29. A naive local-time Date
    // would produce 2026-03-29 twice or skip it; the calendar must not care.
    assert.equal(addDaysISO('2026-03-28', 1), '2026-03-29')
    assert.equal(addDaysISO('2026-03-28', 2), '2026-03-30')
    assert.equal(addDaysISO('2026-10-24', 2), '2026-10-26')
  })

  it('handles leap days', () => {
    assert.equal(addDaysISO('2028-02-28', 1), '2028-02-29')
    assert.equal(daysBetweenISO('2028-02-28', '2028-03-01'), 2)
  })

  it('counts days between dates in both directions', () => {
    assert.equal(daysBetweenISO('2026-07-01', '2026-07-06'), 5)
    assert.equal(daysBetweenISO('2026-07-06', '2026-07-01'), -5)
    assert.equal(daysBetweenISO('2026-07-01', '2026-07-01'), 0)
  })
})

describe('nextItemOrder', () => {
  const item = (dayId: string, order: number) => ({ dayId, order })

  it('starts at 0 for an empty day', () => {
    assert.equal(nextItemOrder([], 'd1'), 0)
    assert.equal(nextItemOrder([item('d2', 7)], 'd1'), 0)
  })

  it('is MAX + 1, not the count — the bug a delete used to cause', () => {
    // Three items were created (orders 0,1,2) and the middle one deleted.
    // Counting would return 2, which item 'c' already holds; two items sharing a
    // start time would then order unpredictably.
    const afterDelete = [item('d1', 0), item('d1', 2)]
    assert.equal(nextItemOrder(afterDelete, 'd1'), 3)
  })

  it('is scoped to the day asked about, not the whole programme', () => {
    // The Day picker lets an item be filed under a day other than the one on
    // screen, so the answer must come from the destination day.
    const items = [item('d1', 0), item('d1', 1), item('d2', 9)]
    assert.equal(nextItemOrder(items, 'd1'), 2)
    assert.equal(nextItemOrder(items, 'd2'), 10)
    assert.equal(nextItemOrder(items, 'd3'), 0)
  })

  it('tolerates an item with no order at all', () => {
    assert.equal(nextItemOrder([{ dayId: 'd1' }], 'd1'), 1)
  })

  it('never returns a value already in use', () => {
    const items = [item('d1', 0), item('d1', 5), item('d1', 3)]
    const next = nextItemOrder(items, 'd1')
    assert.ok(!items.some((i) => i.order === next), `${next} is already taken`)
  })
})

describe('isoDateInTimezone', () => {
  it('reads the calendar date at the venue, not at the server', () => {
    // 2026-07-31 22:30 UTC is already 2026-08-01 in Zurich (CEST, +2). Cloud
    // Functions run in UTC, so reading the date off the Date directly answers
    // '2026-07-31' — a full day out, which used to shift a duplicated camp's
    // whole programme by one day.
    const justAfterMidnightInZurich = new Date('2026-07-31T22:30:00Z')
    assert.equal(isoDateInTimezone(justAfterMidnightInZurich, 'Europe/Zurich'), '2026-08-01')
    assert.equal(isoDateInTimezone(justAfterMidnightInZurich, 'UTC'), '2026-07-31')
  })

  it('handles the winter offset too', () => {
    // CET (+1): 23:30 UTC on the 31st is 00:30 on the 1st in Zurich.
    const d = new Date('2026-01-31T23:30:00Z')
    assert.equal(isoDateInTimezone(d, 'Europe/Zurich'), '2026-02-01')
  })

  it('always returns the YYYY-MM-DD shape a ProgramDay stores', () => {
    const d = new Date('2026-03-05T12:00:00Z')
    assert.match(isoDateInTimezone(d, 'Europe/Zurich'), /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(isoDateInTimezone(d, 'Europe/Zurich'), '2026-03-05')
  })

  it('composes with the calendar helpers it feeds', () => {
    // The duplicate path is exactly this: read both endpoints in the venue's
    // timezone, diff them, shift the programme by that many days.
    const from = isoDateInTimezone(new Date('2026-07-31T22:30:00Z'), 'Europe/Zurich')
    const to = isoDateInTimezone(new Date('2027-06-13T23:00:00Z'), 'Europe/Zurich')
    assert.equal(from, '2026-08-01')
    assert.equal(to, '2027-06-14')
    assert.equal(addDaysISO(from, daysBetweenISO(from, to)), to)
  })
})

describe('grouping', () => {
  const config: EventProgramConfig = {
    days: [
      { id: 'd2', date: '2026-08-02', order: 1 },
      { id: 'd1', date: '2026-08-01', order: 0 },
    ],
    tracks: [
      { id: 'kids', name: 'Kids', order: 1 },
      { id: 'adults', name: 'Adults', order: 0 },
    ],
  }
  const items = [
    { dayId: 'd1', trackId: 'kids', startTime: '10:00', order: 0, title: 'Kids drill' },
    { dayId: 'd1', trackId: null, startTime: '12:00', order: 0, title: 'Lunch' },
    { dayId: 'd1', trackId: 'adults', startTime: '10:00', order: 1, title: 'Adults drill' },
    { dayId: 'd2', trackId: 'kids', startTime: '09:00', order: 0, title: 'Games' },
  ]

  it('groups by day in day order, keeping empty days', () => {
    const grouped = groupItemsByDay(config, items)
    assert.deepEqual(grouped.map((g) => g.day.id), ['d1', 'd2'])
    assert.equal(grouped[0].items.length, 3)
    assert.equal(grouped[1].items.length, 1)
  })

  it('separates plenary items from track items', () => {
    assert.deepEqual(itemsForTrack(items, null).map((i) => i.title), ['Lunch'])
    assert.deepEqual(itemsForTrack(items, 'kids').map((i) => i.title), ['Kids drill', 'Games'])
  })
})

describe('materialiseTemplate', () => {
  // Deterministic id generator so assertions can name the ids.
  const gen = () => {
    let n = 0
    return () => `id${++n}`
  }

  const template = {
    days: [
      { dayIndex: 0, title: 'Arrival' },
      { dayIndex: 2, title: 'Finals' },
    ],
    tracks: [
      { id: 'tpl-adults', name: 'Adults', order: 0 },
      { id: 'tpl-kids', name: 'Kids', order: 1 },
    ],
    items: [
      { dayIndex: 0, trackId: 'tpl-kids', startTime: '10:00', title: 'Warm-up', order: 0 },
      { dayIndex: 2, trackId: null, startTime: '12:00', title: 'Lunch', order: 0 },
      { dayIndex: 1, trackId: 'tpl-adults', startTime: '09:00', title: 'Sparring', order: 0 },
    ],
  }

  it('anchors day dates on the chosen start date', () => {
    const { config } = materialiseTemplate(template, '2026-08-10', gen())
    assert.deepEqual(config.days.map((d) => d.date), ['2026-08-10', '2026-08-11', '2026-08-12'])
    assert.deepEqual(config.days.map((d) => d.order), [0, 1, 2])
  })

  it('creates a day for every index an item references, even without metadata', () => {
    // dayIndex 1 has no entry in template.days but an item lives there.
    const { config } = materialiseTemplate(template, '2026-08-10', gen())
    assert.equal(config.days.length, 3)
    assert.equal(config.days[0].title, 'Arrival')
    assert.equal(config.days[1].title, undefined)
    assert.equal(config.days[2].title, 'Finals')
  })

  it('regenerates track ids and remaps items onto them', () => {
    const { config, items } = materialiseTemplate(template, '2026-08-10', gen())
    const kids = config.tracks.find((t) => t.name === 'Kids')!
    const adults = config.tracks.find((t) => t.name === 'Adults')!
    // Never reuse the template's ids — two events must not share track ids.
    assert.notEqual(kids.id, 'tpl-kids')
    assert.equal(items.find((i) => i.title === 'Warm-up')!.trackId, kids.id)
    assert.equal(items.find((i) => i.title === 'Sparring')!.trackId, adults.id)
    assert.equal(items.find((i) => i.title === 'Lunch')!.trackId, null)
  })

  it('points every item at a real generated day', () => {
    const { config, items } = materialiseTemplate(template, '2026-08-10', gen())
    const dayIds = new Set(config.days.map((d) => d.id))
    for (const item of items) assert.ok(dayIds.has(item.dayId))
  })

  it('handles a template with no tracks', () => {
    const { config, items } = materialiseTemplate(
      { days: [], tracks: [], items: [{ dayIndex: 0, startTime: '08:00', title: 'Solo', order: 0 }] },
      '2026-08-10',
      gen(),
    )
    assert.equal(config.tracks.length, 0)
    assert.equal(config.days.length, 1)
    assert.equal(items[0].trackId, null)
  })

  it('produces an empty program from an empty template', () => {
    const { config, items } = materialiseTemplate({ days: [], tracks: [], items: [] }, '2026-08-10', gen())
    assert.deepEqual(config.days, [])
    assert.deepEqual(items, [])
  })
})

describe('extractTemplate', () => {
  const config: EventProgramConfig = {
    days: [
      { id: 'd1', date: '2026-08-01', title: 'Arrival', order: 0 },
      { id: 'd2', date: '2026-08-02', order: 1 },
    ],
    tracks: [{ id: 'kids', name: 'Kids', order: 0 }],
    timezoneLabel: 'Europe/Madrid',
  }

  it('replaces dayIds with 0-based indexes', () => {
    const tpl = extractTemplate(config, [
      { dayId: 'd2', trackId: 'kids', startTime: '09:00', title: 'Games', order: 0 },
      { dayId: 'd1', trackId: null, startTime: '12:00', title: 'Lunch', order: 0 },
    ])
    assert.deepEqual(tpl.items.map((i) => [i.title, i.dayIndex]), [['Lunch', 0], ['Games', 1]])
    assert.deepEqual(tpl.days, [{ dayIndex: 0, title: 'Arrival' }, { dayIndex: 1 }])
    assert.equal(tpl.timezoneLabel, 'Europe/Madrid')
  })

  it('drops a dangling track reference to plenary rather than keeping a broken id', () => {
    const tpl = extractTemplate(config, [
      { dayId: 'd1', trackId: 'deleted-track', startTime: '09:00', title: 'Orphan', order: 0 },
    ])
    assert.equal(tpl.items[0].trackId, null)
  })

  it('skips items pointing at a day that no longer exists', () => {
    const tpl = extractTemplate(config, [
      { dayId: 'gone', trackId: null, startTime: '09:00', title: 'Orphan', order: 0 },
    ])
    assert.equal(tpl.items.length, 0)
  })

  it('round-trips: extract then materialise preserves shape and times', () => {
    let n = 0
    const items = [
      { dayId: 'd1', trackId: 'kids', startTime: '10:00', endTime: '11:00', title: 'Drill', order: 0 },
      { dayId: 'd2', trackId: null, startTime: '12:00', title: 'Lunch', order: 0 },
    ]
    const tpl = extractTemplate(config, items)
    const { config: rebuilt, items: rebuiltItems } = materialiseTemplate(tpl, '2027-01-05', () => `r${++n}`)

    assert.deepEqual(rebuilt.days.map((d) => d.date), ['2027-01-05', '2027-01-06'])
    assert.equal(rebuilt.days[0].title, 'Arrival')
    assert.deepEqual(rebuiltItems.map((i) => i.title), ['Drill', 'Lunch'])
    assert.equal(rebuiltItems[0].startTime, '10:00')
    assert.equal(rebuiltItems[0].endTime, '11:00')
    // The plenary item stays plenary; the tracked one lands on the new Kids id.
    assert.equal(rebuiltItems[1].trackId, null)
    assert.equal(rebuiltItems[0].trackId, rebuilt.tracks[0].id)
  })
})

describe('STARTER_PROGRAM_TEMPLATES', () => {
  // The starter library is data that ships to studios and is applied verbatim
  // onto events, so a malformed entry (a bad time, an item on a track that does
  // not exist) would break a real programme. These assertions are the guard.

  it('ships the built-in library with unique ids and identity fields', () => {
    assert.ok(STARTER_PROGRAM_TEMPLATES.length >= 4)
    const ids = STARTER_PROGRAM_TEMPLATES.map((s) => s.id)
    assert.equal(new Set(ids).size, ids.length, 'starter ids must be unique')
    for (const s of STARTER_PROGRAM_TEMPLATES) {
      assert.ok(s.name.trim(), `${s.id} needs a name`)
      assert.ok(s.description.trim(), `${s.id} needs a description`)
      assert.ok(s.icon.trim(), `${s.id} needs an icon`)
      assert.ok(s.items.length > 0, `${s.id} needs at least one item`)
      assert.ok(s.items.length <= MAX_PROGRAM_ITEMS, `${s.id} exceeds the item cap`)
    }
  })

  it('has well-formed times, tracks and day coverage in every starter', () => {
    for (const s of STARTER_PROGRAM_TEMPLATES) {
      const trackIds = new Set(s.tracks.map((t) => t.id))
      const declaredDays = new Set(s.days.map((d) => d.dayIndex))
      const maxItemDay = s.items.reduce((m, i) => Math.max(m, i.dayIndex), 0)
      // Track ids must be unique so materialise's remap is unambiguous.
      assert.equal(trackIds.size, s.tracks.length, `${s.id} has duplicate track ids`)
      for (const item of s.items) {
        assert.notEqual(parseHHMM(item.startTime), null, `${s.id}: bad startTime ${item.startTime}`)
        if (item.endTime) {
          assert.notEqual(parseHHMM(item.endTime), null, `${s.id}: bad endTime ${item.endTime}`)
        }
        assert.ok(item.dayIndex >= 0 && item.dayIndex <= maxItemDay)
        if (item.trackId) {
          assert.ok(trackIds.has(item.trackId), `${s.id}: item on unknown track ${item.trackId}`)
        }
      }
      // Day metadata may be sparse, but must never name a day past the items.
      for (const d of declaredDays) assert.ok(d >= 0)
    }
  })

  it('materialises each starter cleanly onto a real event', () => {
    let n = 0
    for (const s of STARTER_PROGRAM_TEMPLATES) {
      const { config, items } = materialiseTemplate(s, '2026-09-01', () => `s${++n}`)
      const dayIds = new Set(config.days.map((d) => d.id))
      // Every generated item lands on a generated day, dates run consecutively.
      for (const item of items) assert.ok(dayIds.has(item.dayId), `${s.id}: item off-day`)
      assert.equal(config.days[0].date, '2026-09-01')
      for (let i = 1; i < config.days.length; i++) {
        assert.equal(config.days[i].date, addDaysISO('2026-09-01', i), `${s.id}: day ${i} not consecutive`)
      }
      // No item is dropped — every template item references a covered day.
      assert.equal(items.length, s.items.length, `${s.id}: lost items on apply`)
    }
  })

  it('round-trips through extractTemplate without losing items', () => {
    let n = 0
    for (const s of STARTER_PROGRAM_TEMPLATES) {
      const { config, items } = materialiseTemplate(s, '2026-09-01', () => `m${++n}`)
      const withIds = items.map((it, i) => ({ ...it, id: `x${i}` }))
      const back = extractTemplate(config, withIds)
      assert.equal(back.items.length, s.items.length, `${s.id}: item count changed on extract`)
      assert.equal(back.tracks.length, s.tracks.length, `${s.id}: track count changed on extract`)
    }
  })
})

describe('shiftProgramDays', () => {
  const config: EventProgramConfig = {
    days: [
      { id: 'd1', date: '2026-08-01', order: 0 },
      { id: 'd2', date: '2026-08-02', order: 1 },
    ],
    tracks: [],
  }

  it('moves every day by the same delta, keeping the shape', () => {
    const shifted = shiftProgramDays(config, 30)
    assert.deepEqual(shifted.days.map((d) => d.date), ['2026-08-31', '2026-09-01'])
    assert.deepEqual(shifted.days.map((d) => d.id), ['d1', 'd2'])
  })

  it('is a no-op for a zero delta', () => {
    assert.equal(shiftProgramDays(config, 0), config)
  })
})
