import assert from 'node:assert/strict'
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { addMonths } from 'date-fns'
import {
  planSeriesRoll,
  rollSessionSeries,
  MAX_SESSIONS_PER_RUN,
  MAX_SESSIONS_PER_SERIES,
} from './rollSessionSeries'

// THE SERIES CLIFF, and the two things that stop it coming back.
//
// 1. IDEMPOTENCY. The roller must be safe to run twice in a day — and it is
//    running in the same 02:00 batch as everything else, so "twice" includes a
//    retry after a partial failure. There is exactly ONE dedupe rule
//    (`seriesId` + `instanceDate`, in sessions/series.ts) and these tests drive
//    the REAL code through a fake Firestore rather than re-implementing it, so a
//    change to that rule fails here.
// 2. END CONDITIONS. A series that ends must stop where the studio said it
//    stops. The subtle one is `endCondition: 'count'`: `calculateOccurrences`
//    counts within the window it is given, so a naive roll would restart the
//    count every quarter and quietly run a "10 sessions" course forever.

// ─── a very small in-memory Firestore ────────────────────────────────────────
// Supports only what this task uses: an equality query with a limit and an
// optional field projection, a batch of sets, and doc.ref.update().

type Row = Record<string, unknown>
type Filter = [string, string, unknown]

interface FakeRef {
  id: string
  collection: string
  update(patch: Row): Promise<void>
}
interface FakeSnap {
  empty: boolean
  size: number
  docs: Array<{ id: string; data(): Row; get(field: string): unknown; ref: FakeRef }>
}
interface FakeQuery {
  where(field: string, op: string, value: unknown): FakeQuery
  limit(n: number): FakeQuery
  /** Projection. Modelled because the dedupe read asks for `instanceDate` only;
   *  the rows it returns are read through `doc.get(field)`, not `data()`. */
  select(...fields: string[]): FakeQuery
  doc(id?: string): FakeRef
  get(): Promise<FakeSnap>
}

function millisOf(v: unknown): number | null {
  if (v && typeof (v as Timestamp).toMillis === 'function') return (v as Timestamp).toMillis()
  return null
}

function valueEquals(a: unknown, b: unknown): boolean {
  const am = millisOf(a)
  const bm = millisOf(b)
  if (am !== null || bm !== null) return am === bm
  return a === b
}

class FakeDb {
  collections = new Map<string, Map<string, Row>>()
  /** Every dedupe lookup the roller made — proof it asked before it wrote. */
  lookups = 0
  private seq = 0

  col(name: string): Map<string, Row> {
    let c = this.collections.get(name)
    if (!c) {
      c = new Map<string, Row>()
      this.collections.set(name, c)
    }
    return c
  }

  seed(name: string, id: string, data: Row): void {
    this.col(name).set(id, data)
  }

  docs(name: string): Array<{ id: string; data: Row }> {
    return [...this.col(name).entries()].map(([id, data]) => ({ id, data }))
  }

  private query(name: string, filters: Filter[], take: number | null): FakeQuery {
    const self = this
    return {
      where: (field, op, value) => self.query(name, [...filters, [field, op, value]], take),
      limit: (n) => self.query(name, filters, n),
      select: () => self.query(name, filters, take),
      doc: (id?: string) => self.docRef(name, id ?? `auto-${++self.seq}`),
      get: async () => {
        if (filters.length > 0 && name === 'sessions') self.lookups++
        let docs = self
          .docs(name)
          .filter((d) => filters.every(([f, , v]) => valueEquals(d.data[f], v)))
        if (take !== null) docs = docs.slice(0, take)
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs: docs.map((d) => ({
            id: d.id,
            data: () => d.data,
            get: (field: string) => d.data[field],
            ref: self.docRef(name, d.id),
          })),
        }
      },
    }
  }

  collection(name: string): FakeQuery {
    return this.query(name, [], null)
  }

  docRef(collection: string, id: string): FakeRef {
    const self = this
    return {
      id,
      collection,
      async update(patch: Row): Promise<void> {
        // FieldValue sentinels are opaque objects here; only the fields the
        // tests assert on (the horizon) are read back.
        self.col(collection).set(id, { ...(self.col(collection).get(id) ?? {}), ...patch })
      },
    }
  }

  batch() {
    const ops: Array<() => void> = []
    const self = this
    return {
      set(ref: FakeRef, data: Row) {
        ops.push(() => self.col(ref.collection).set(ref.id, data))
      },
      update(ref: FakeRef, data: Row) {
        ops.push(() =>
          self.col(ref.collection).set(ref.id, { ...(self.col(ref.collection).get(ref.id) ?? {}), ...data })
        )
      },
      delete(ref: FakeRef) {
        ops.push(() => self.col(ref.collection).delete(ref.id))
      },
      async commit() {
        ops.forEach((op) => op())
      },
    }
  }
}

const NOW = new Date('2026-08-17T02:00:00Z')

function weeklySeries(over: Record<string, unknown> = {}) {
  return {
    teamId: 'team-1',
    teacher: 'uid-1',
    createdBy: 'uid-1',
    status: 'active',
    template: {
      activityId: 'act-1',
      activityName: 'Vinyasa',
      activityType: 'class',
      autoConfirm: true,
      placeId: 'place-1',
      roomId: 'room-1',
      allowBooking: true,
      duration: 60,
    },
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [2], // Tuesdays
      duration: 60,
      startDate: Timestamp.fromDate(new Date('2026-08-18T09:00:00Z')),
      endCondition: 'never',
      endDate: null,
    },
    lastGeneratedUntil: null,
    totalOccurrences: 0,
    ...over,
  }
}

function makeDb(series: Record<string, Record<string, unknown>>) {
  const db = new FakeDb()
  for (const [id, data] of Object.entries(series)) db.seed('session_series', id, data)
  return db
}

const asFirestore = (db: FakeDb) => db as unknown as Firestore

// ─── idempotency ─────────────────────────────────────────────────────────────

describe('rollSessionSeries — idempotency', () => {
  it('a second run the same day creates nothing', async () => {
    const db = makeDb({ s1: weeklySeries() })

    const first = await rollSessionSeries(asFirestore(db), NOW)
    assert.ok(first.created > 20, `expected a six-month roll, got ${first.created}`)
    const afterFirst = db.docs('sessions').length

    const second = await rollSessionSeries(asFirestore(db), NOW)
    assert.equal(second.created, 0)
    assert.equal(db.docs('sessions').length, afterFirst)
  })

  it('re-rolls from a horizon that was reset, without duplicating a single slot', async () => {
    const db = makeDb({ s1: weeklySeries() })
    await rollSessionSeries(asFirestore(db), NOW)
    const created = db.docs('sessions').length

    // The cliff case: the horizon is wound back (a failed write, a restored
    // backup, a manager edit that used to bump it falsely). Every occurrence is
    // recalculated — and every one of them is already taken.
    await db.docRef('session_series', 's1').update({ lastGeneratedUntil: null })
    const again = await rollSessionSeries(asFirestore(db), NOW)

    assert.equal(again.created, 0)
    assert.equal(db.docs('sessions').length, created)
    const instants = db.docs('sessions').map((d) => (d.data.instanceDate as Timestamp).toMillis())
    assert.equal(new Set(instants).size, instants.length, 'duplicate instanceDate written')
  })

  it('asks the (seriesId, instanceDate) question ONCE per series, not once per write', async () => {
    // The dedupe used to run a query per occurrence — 26 sequential round-trips
    // for a weekly class, which is what made creating a series feel hung. It is
    // one read of the pairs the series already holds, and the property that
    // matters (nothing is written without having asked) is unchanged: the read
    // happens, and it happens before any write.
    const db = makeDb({ s1: weeklySeries() })
    const res = await rollSessionSeries(asFirestore(db), NOW)
    assert.ok(res.created > 1, 'fixture should create several sessions')
    assert.equal(db.lookups, 1)
  })

  it('finishes a series that was only half-materialised', async () => {
    const db = makeDb({ s1: weeklySeries() })
    await rollSessionSeries(asFirestore(db), NOW)
    const all = db.docs('sessions')
    // Drop half the sessions and wind the horizon back — a crash mid-roll.
    all.slice(0, 5).forEach((d) => db.col('sessions').delete(d.id))
    await db.docRef('session_series', 's1').update({ lastGeneratedUntil: null })

    const res = await rollSessionSeries(asFirestore(db), NOW)
    assert.equal(res.created, 5)
    assert.equal(db.docs('sessions').length, all.length)
  })
})

// ─── end conditions ──────────────────────────────────────────────────────────

describe('rollSessionSeries — end conditions', () => {
  it('stops at the series end date, never past it', async () => {
    const endDate = new Date('2026-09-30T09:00:00Z')
    const db = makeDb({
      s1: weeklySeries({
        recurrence: {
          ...weeklySeries().recurrence,
          endCondition: 'date',
          endDate: Timestamp.fromDate(endDate),
        },
      }),
    })

    await rollSessionSeries(asFirestore(db), NOW)
    const starts = db.docs('sessions').map((d) => (d.data.start as Timestamp).toDate())
    assert.ok(starts.length > 0)
    for (const s of starts) {
      assert.ok(s.getTime() <= endDate.getTime(), `generated ${s.toISOString()} past the end date`)
    }
  })

  it('never exceeds maxOccurrences, even across two rolls a quarter apart', async () => {
    const db = makeDb({
      s1: weeklySeries({
        recurrence: {
          ...weeklySeries().recurrence,
          endCondition: 'count',
          maxOccurrences: 40, // more than six months of Tuesdays
        },
      }),
    })

    const first = await rollSessionSeries(asFirestore(db), NOW)
    assert.ok(first.created < 40, 'the six-month horizon should not cover 40 weeks')

    // Four months later the roller comes back for the rest. If it recalculated
    // from the cursor the count would restart here and the course would run on
    // for ever.
    const later = addMonths(NOW, 4)
    await rollSessionSeries(asFirestore(db), later)
    await rollSessionSeries(asFirestore(db), addMonths(NOW, 8))

    assert.equal(db.docs('sessions').length, 40)
  })

  it('a skipped date stays skipped across rolls, and does not spend a count', async () => {
    // THE REASON SKIP DATES LIVE ON THE PATTERN. A `count` series recomputes its
    // total from its own start on every roll, so an exclusion held anywhere but
    // the pattern would be forgotten here — the skipped Tuesdays would come back
    // on the second roll, and the count would be wrong on every one.
    const skipped = [new Date('2026-09-01T09:00:00Z'), new Date('2026-09-08T09:00:00Z')]
    const db = makeDb({
      s1: weeklySeries({
        recurrence: {
          ...weeklySeries().recurrence,
          endCondition: 'count',
          maxOccurrences: 12,
          excludeDates: skipped.map((d) => Timestamp.fromDate(d)),
        },
      }),
    })

    await rollSessionSeries(asFirestore(db), NOW)
    await rollSessionSeries(asFirestore(db), addMonths(NOW, 4))
    await rollSessionSeries(asFirestore(db), addMonths(NOW, 8))

    const starts = db.docs('sessions').map((d) => (d.data.start as Timestamp).toMillis())
    // Twelve lessons, not ten: the skipped weeks are skipped, not deducted.
    assert.equal(starts.length, 12)
    for (const gone of skipped) {
      assert.ok(
        !starts.includes(gone.getTime()),
        `${gone.toISOString()} was generated despite being a skip date`
      )
    }
  })

  it('skips paused, ended and deleted series', async () => {
    const db = makeDb({
      paused: weeklySeries({ status: 'paused' }),
      ended: weeklySeries({ status: 'ended' }),
      deleted: weeklySeries({ status: 'deleted' }),
    })
    const res = await rollSessionSeries(asFirestore(db), NOW)
    assert.equal(res.series, 0)
    assert.equal(res.created, 0)
    assert.equal(db.docs('sessions').length, 0)
  })

  it('skips a series whose horizon is still far enough out', async () => {
    const db = makeDb({
      s1: weeklySeries({ lastGeneratedUntil: Timestamp.fromDate(addMonths(NOW, 5)) }),
    })
    const res = await rollSessionSeries(asFirestore(db), NOW)
    assert.equal(res.skipped, 1)
    assert.equal(res.created, 0)
  })

  it('reports a broken recurrence instead of throwing the whole sweep away', async () => {
    const db = makeDb({
      broken: weeklySeries({ recurrence: { frequency: 'weekly', interval: 1 } }),
      fine: weeklySeries(),
    })
    const res = await rollSessionSeries(asFirestore(db), NOW)
    assert.equal(res.invalid, 1)
    assert.equal(res.errors, 0)
    assert.equal(res.rolled, 1)
    assert.ok(res.created > 0)
  })
})

// ─── the generated shape + the honest horizon ────────────────────────────────

describe('rollSessionSeries — what it writes', () => {
  it('generated sessions carry the fields the single-session form writes', async () => {
    const db = makeDb({ s1: weeklySeries() })
    await rollSessionSeries(asFirestore(db), NOW)
    const s = db.docs('sessions')[0].data

    assert.equal(s.duration_minutes, 60)
    assert.equal(s.autoConfirm, true)
    assert.equal(s.placeId, 'place-1')
    assert.equal(s.roomId, 'room-1')
    assert.equal(s.teamId, 'team-1')
    assert.equal(s.seriesId, 's1')
    assert.equal(s.isException, false)
  })

  it('omits autoConfirm when the series template has none, so the activity still decides', async () => {
    const base = weeklySeries()
    const template = { ...(base.template as Record<string, unknown>) }
    delete template.autoConfirm
    const db = makeDb({ s1: { ...base, template } })

    await rollSessionSeries(asFirestore(db), NOW)
    assert.ok(!('autoConfirm' in db.docs('sessions')[0].data))
  })

  it('records the horizon it actually generated to', async () => {
    const db = makeDb({ s1: weeklySeries() })
    await rollSessionSeries(asFirestore(db), NOW)
    const horizon = db.col('session_series').get('s1')!.lastGeneratedUntil as Timestamp
    assert.equal(horizon.toMillis(), addMonths(NOW, 6).getTime())
  })
})

// ─── the pure planner ────────────────────────────────────────────────────────

describe('planSeriesRoll', () => {
  const nowMs = NOW.getTime()
  const base = {
    status: 'active',
    endCondition: 'never' as string,
    recurrenceStartMs: nowMs - 30 * 24 * 3600_000,
    lastGeneratedUntilMs: null as number | null,
    nowMs,
    horizonMs: addMonths(NOW, 6).getTime(),
    refreshBeforeMs: addMonths(NOW, 3).getTime(),
  }

  it('rolls a series that has never been generated', () => {
    assert.equal(planSeriesRoll(base).reason, 'extend')
  })

  it('leaves a covered series alone', () => {
    const plan = planSeriesRoll({
      ...base,
      lastGeneratedUntilMs: addMonths(NOW, 4).getTime(),
    })
    assert.deepEqual([plan.roll, plan.reason], [false, 'covered'])
  })

  it('rolls once coverage falls inside the refresh window', () => {
    const plan = planSeriesRoll({
      ...base,
      lastGeneratedUntilMs: addMonths(NOW, 2).getTime(),
    })
    assert.equal(plan.reason, 'extend')
    assert.equal(plan.keepFromMs, addMonths(NOW, 2).getTime())
  })

  it('never generates into the past when the horizon has already lapsed', () => {
    const plan = planSeriesRoll({ ...base, lastGeneratedUntilMs: nowMs - 90 * 24 * 3600_000 })
    assert.equal(plan.keepFromMs, nowMs)
  })

  it('a count-limited series is always calculated from its own start date', () => {
    const plan = planSeriesRoll({
      ...base,
      endCondition: 'count',
      lastGeneratedUntilMs: addMonths(NOW, 2).getTime(),
    })
    assert.equal(plan.calcFromMs, base.recurrenceStartMs)
    assert.equal(plan.keepFromMs, addMonths(NOW, 2).getTime())
  })

  it('every other end condition calculates from the cheap cursor', () => {
    for (const endCondition of ['never', 'date']) {
      const plan = planSeriesRoll({
        ...base,
        endCondition,
        lastGeneratedUntilMs: addMonths(NOW, 2).getTime(),
      })
      assert.equal(plan.calcFromMs, plan.keepFromMs)
    }
  })

  it('anything but active is left untouched', () => {
    for (const status of ['paused', 'ended', 'deleted', undefined]) {
      assert.equal(planSeriesRoll({ ...base, status }).reason, 'inactive')
    }
  })

  it('an invalid recurrence is reported, not rolled', () => {
    assert.equal(planSeriesRoll({ ...base, recurrenceValid: false }).reason, 'invalid')
  })
})

// ─── bounded work, and no starvation ─────────────────────────────────────────

describe('rollSessionSeries — bounded work', () => {
  it('the shipped budget is a real number', () => {
    assert.ok(MAX_SESSIONS_PER_RUN > 0)
    assert.ok(MAX_SESSIONS_PER_SERIES > 0)
  })

  it('stops at the per-run budget, says so, and the next run finishes the rest', async () => {
    const db = makeDb({ a: weeklySeries(), b: weeklySeries(), c: weeklySeries() })

    const first = await rollSessionSeries(asFirestore(db), NOW, { perRun: 30, perSeries: 250 })
    assert.equal(first.truncated, true)
    assert.equal(first.rolled, 2) // the third never started
    assert.equal(first.remaining, 1)

    // The series that WAS rolled is now covered, so the budget goes to the one
    // that was left behind — nothing starves.
    const second = await rollSessionSeries(asFirestore(db), NOW, { perRun: 30, perSeries: 250 })
    assert.equal(second.truncated, false)
    assert.equal(second.rolled, 1)
    assert.equal(second.skipped, 2)

    const bySeries = new Map<string, number>()
    for (const d of db.docs('sessions')) {
      const id = d.data.seriesId as string
      bySeries.set(id, (bySeries.get(id) ?? 0) + 1)
    }
    assert.deepEqual([...bySeries.values()], [27, 27, 27])
  })

  it('a series capped mid-roll records the horizon it REACHED, not the one it wanted', async () => {
    const db = makeDb({ s1: weeklySeries() })
    await rollSessionSeries(asFirestore(db), NOW, { perRun: 1000, perSeries: 4 })

    const horizon = db.col('session_series').get('s1')!.lastGeneratedUntil as Timestamp
    const latest = Math.max(
      ...db.docs('sessions').map((d) => (d.data.start as Timestamp).toMillis())
    )
    assert.equal(db.docs('sessions').length, 4)
    assert.equal(horizon.toMillis(), latest, 'a capped roll must not claim the full horizon')

    // …and because the claim is honest, the next run carries on from where it
    // stopped instead of believing itself finished. (It re-offers the last
    // occurrence it wrote — the day-granular window includes it — and the dedupe
    // rule turns that into a no-op, which is exactly the point.)
    const next = await rollSessionSeries(asFirestore(db), NOW, { perRun: 1000, perSeries: 4 })
    assert.ok(next.created > 0, 'a capped series must keep making progress')
    const instants = db.docs('sessions').map((d) => (d.data.instanceDate as Timestamp).toMillis())
    assert.equal(new Set(instants).size, instants.length, 'resuming duplicated a slot')
  })
})
