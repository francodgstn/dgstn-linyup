import assert from 'node:assert/strict'
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import {
  claimSessionForTeardown,
  runSeriesTeardownBatch,
  type TeamData,
} from './teardown'
import { SERIES_TEARDOWN_BATCH, SERIES_TEARDOWN_CLAIM_TTL_MS } from '@linyup/shared'

// WHAT THESE TESTS PIN, and why each case was worth writing down.
//
// A background teardown runs for minutes against a calendar that is still live:
// a manager deletes one of the doomed occurrences by hand, a retry redelivers a
// round, a worker dies holding a session. The engine's answer to each is a
// POLICY, not an accident, and the policies are cheap to invert by accident:
//
//   • a session somebody ELSE deleted is the outcome we wanted — it must count
//     as PROGRESS, never as an error, or a studio tidying up mid-run drives the
//     job into `completed_with_errors` for doing nothing wrong;
//   • a session another worker holds must be SKIPPED, because the harm from
//     doing it twice is a second "your class is canceled" mail to a real
//     member, and that cannot be taken back;
//   • a claim must EXPIRE, or one crashed worker leaves a session nothing may
//     ever touch — and since the drain query keeps handing that session back,
//     the whole job stalls on it;
//   • a session that keeps THROWING must be quarantined by id, for the same
//     reason: the query cannot forget it, so only the job can.

// ─── a very small in-memory Firestore ────────────────────────────────────────
// Supports exactly what the teardown engine uses: the scope query (three
// equality/inequality filters, an order, a limit), doc get/update/delete, and a
// serialized runTransaction. Modeled on the fake in
// dailyTasks/rollSessionSeries.test.ts — the real code is driven through it, so
// a change to the engine fails here rather than being re-implemented.

type Row = Record<string, unknown>

function makeDb(rows: Record<string, Row>) {
  const store = new Map<string, Row>(Object.entries(rows))
  const deleted: string[] = []

  function ref(id: string) {
    return {
      id,
      get delete() {
        return async () => {
          store.delete(id)
          deleted.push(id)
        }
      },
      async update(patch: Row) {
        const cur = store.get(id)
        if (!cur) throw new Error(`no doc ${id}`)
        store.set(id, { ...cur, ...patch })
      },
      async get() {
        const d = store.get(id)
        return { exists: !!d, id, data: () => d }
      },
    }
  }

  const query = (filters: Array<[string, string, unknown]>, lim: number | null) => ({
    where(f: string, op: string, v: unknown) {
      return query([...filters, [f, op, v]], lim)
    },
    orderBy() {
      return query(filters, lim)
    },
    limit(n: number) {
      return query(filters, n)
    },
    async get() {
      let docs = [...store.entries()].filter(([, row]) =>
        filters.every(([f, op, v]) => {
          const actual = row[f]
          if (op === '==') return actual === v
          if (op === '>=') {
            return (actual as Timestamp).toMillis() >= (v as Timestamp).toMillis()
          }
          throw new Error(`unsupported op ${op}`)
        }),
      )
      docs.sort((a, b) => (a[1].start as Timestamp).toMillis() - (b[1].start as Timestamp).toMillis())
      if (lim !== null) docs = docs.slice(0, lim)
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map(([id, row]) => ({ id, data: () => row, ref: ref(id) })),
      }
    },
  })

  const db = {
    collection: () => query([], null),
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      // Serialized, which is the right model here: the engine relies on the
      // transaction being atomic, not on observing contention.
      const tx = {
        async get(r: { id: string }) {
          const d = store.get(r.id)
          return { exists: !!d, id: r.id, data: () => d }
        },
        update(r: { id: string }, patch: Row) {
          store.set(r.id, { ...(store.get(r.id) ?? {}), ...patch })
        },
      }
      return fn(tx)
    },
  } as unknown as Firestore

  return { db, store, deleted, ref }
}

const TEAM: TeamData = { name: 'T', language: 'en', slug: 't', ctaUrl: null }
const CUTOFF = Timestamp.fromMillis(1_000)

function session(startMs: number, extra: Row = {}): Row {
  return {
    seriesId: 'S1',
    isException: false,
    start: Timestamp.fromMillis(startMs),
    teamId: 'team1',
    ...extra,
  }
}

/** A teardown that deletes the document, like the real one, but sends no mail. */
function fakeTeardown(store: Map<string, Row>, onCall?: (id: string) => void) {
  return (async (
    _db: unknown,
    id: string,
    r: { delete(): Promise<void> },
  ) => {
    onCall?.(id)
    await r.delete()
    store.delete(id)
    return { sent: 1, failed: 0 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
}

describe('series teardown — the drain', () => {
  it('counts a session someone else deleted mid-run as PROGRESS, not an error', async () => {
    const { db, store } = makeDb({ a: session(5_000), b: session(6_000) })

    // The manager deletes `a` by hand between the query and the claim — exactly
    // the race the live drain query exists to absorb.
    const torn: string[] = []
    const teardown = (async (
      _db: unknown,
      id: string,
      r: { delete(): Promise<void> },
    ) => {
      torn.push(id)
      await r.delete()
      store.delete(id)
      return { sent: 0, failed: 0 }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
    store.delete('a')

    const res = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF,
      teamData: TEAM, failedIds: [], teardownSession: teardown,
    })

    assert.equal(res.processed, 1, 'only b was actually torn down')
    assert.equal(res.newFailedIds.length, 0, 'a vanishing is not a failure')
    assert.deepEqual(torn, ['b'])
  })

  it('reports drained once the scope is empty', async () => {
    const { db } = makeDb({ past: session(500) }) // before the cutoff → out of scope
    const res = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF, teamData: TEAM, failedIds: [],
    })
    assert.equal(res.drained, true)
    assert.equal(res.processed, 0)
  })

  it('leaves a session another worker holds alone — no second cancellation mail', async () => {
    const now = 10_000_000
    const { db, store } = makeDb({
      a: session(5_000, { teardown_claim: { job: 'OTHER', at: Timestamp.fromMillis(now - 1_000) } }),
      b: session(6_000),
    })
    const torn: string[] = []
    const res = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF, teamData: TEAM,
      failedIds: [], nowMs: now, teardownSession: fakeTeardown(store, (id) => torn.push(id)),
    })
    assert.deepEqual(torn, ['b'], 'the live claim on a was respected')
    assert.equal(res.processed, 1)
    assert.equal(res.drained, false, 'a is still there, so the job is not done')
  })

  it('takes over a STALE claim — a crashed worker must not wedge a session forever', async () => {
    const now = 10_000_000
    const { db, store } = makeDb({
      a: session(5_000, {
        teardown_claim: { job: 'DEAD', at: Timestamp.fromMillis(now - SERIES_TEARDOWN_CLAIM_TTL_MS - 1) },
      }),
    })
    const torn: string[] = []
    const res = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF, teamData: TEAM,
      failedIds: [], nowMs: now, teardownSession: fakeTeardown(store, (id) => torn.push(id)),
    })
    assert.deepEqual(torn, ['a'])
    assert.equal(res.processed, 1)
  })

  it('quarantines a throwing session by id instead of retrying it forever', async () => {
    const { db } = makeDb({ bad: session(5_000) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boom = (async () => { throw new Error('nope') }) as any

    const first = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF,
      teamData: TEAM, failedIds: [], teardownSession: boom,
    })
    assert.deepEqual(first.newFailedIds, ['bad'])
    assert.equal(first.processed, 0)
    assert.equal(first.drained, false)

    // Fed back as failedIds, the same document is now skipped — and since it is
    // the only thing in scope, the job is drained rather than looping.
    const second = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF,
      teamData: TEAM, failedIds: ['bad'], teardownSession: boom,
    })
    assert.equal(second.drained, true, 'a quarantined scope is drained, not stuck')
  })

  it('does not let quarantined ids crowd real work out of a batch', async () => {
    const rows: Record<string, Row> = {}
    // Three known-bad documents sort FIRST, so a naive limit(BATCH) would spend
    // three of its slots re-fetching them and tear down three fewer sessions.
    for (let i = 0; i < 3; i++) rows[`bad${i}`] = session(1_000 + i)
    for (let i = 0; i < SERIES_TEARDOWN_BATCH; i++) rows[`ok${i}`] = session(50_000 + i)

    const { db, store } = makeDb(rows)
    const torn: string[] = []
    const res = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF, teamData: TEAM,
      failedIds: ['bad0', 'bad1', 'bad2'],
      teardownSession: fakeTeardown(store, (id) => torn.push(id)),
    })
    assert.equal(res.processed, SERIES_TEARDOWN_BATCH, 'a full batch of real work')
    assert.ok(torn.every((id) => id.startsWith('ok')))
  })

  it('never exceeds the batch size', async () => {
    const rows: Record<string, Row> = {}
    for (let i = 0; i < SERIES_TEARDOWN_BATCH + 25; i++) rows[`s${i}`] = session(5_000 + i)
    const { db, store } = makeDb(rows)
    const res = await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF, teamData: TEAM,
      failedIds: [], teardownSession: fakeTeardown(store),
    })
    assert.equal(res.processed, SERIES_TEARDOWN_BATCH)
    assert.equal(res.drained, false)
  })

  it('excludes exceptions and anything before the cutoff from the scope', async () => {
    const { db, store } = makeDb({
      before: session(500),
      exception: session(9_000, { isException: true }),
      other: session(9_000, { seriesId: 'S2' }),
      target: session(9_000),
    })
    const torn: string[] = []
    await runSeriesTeardownBatch({
      db, jobId: 'J', seriesId: 'S1', cutoff: CUTOFF, teamData: TEAM,
      failedIds: [], teardownSession: fakeTeardown(store, (id) => torn.push(id)),
    })
    assert.deepEqual(torn, ['target'])
  })
})

describe('series teardown — the claim', () => {
  it('claims a free session and closes its seats in the same transaction', async () => {
    const { db, store, ref } = makeDb({ a: session(5_000, { allowBooking: true }) })
    const res = await claimSessionForTeardown(db, ref('a') as never, 'J', 1_000)
    assert.equal(res.outcome, 'claimed')
    // allowBooking: false rides ALONG WITH the claim — the ordering
    // cancelSingleSession depends on (seats shut before the waitlist is touched)
    // is established transactionally rather than in a best-effort write after.
    assert.equal(store.get('a')!.allowBooking, false)
    assert.equal((store.get('a')!.teardown_claim as { job: string }).job, 'J')
  })

  it('reports a missing session as gone rather than throwing', async () => {
    const { db, ref } = makeDb({})
    const res = await claimSessionForTeardown(db, ref('nope') as never, 'J', 1_000)
    assert.equal(res.outcome, 'gone')
  })

  it('re-claims its OWN claim, so a retry of the same round is not blocked', async () => {
    const now = 5_000_000
    const { db, ref } = makeDb({
      a: session(5_000, { teardown_claim: { job: 'J', at: Timestamp.fromMillis(now - 10) } }),
    })
    const res = await claimSessionForTeardown(db, ref('a') as never, 'J', now)
    assert.equal(res.outcome, 'claimed')
  })

  it('refuses a live claim held by another job', async () => {
    const now = 5_000_000
    const { db, ref } = makeDb({
      a: session(5_000, { teardown_claim: { job: 'OTHER', at: Timestamp.fromMillis(now - 10) } }),
    })
    const res = await claimSessionForTeardown(db, ref('a') as never, 'J', now)
    assert.equal(res.outcome, 'taken')
  })

  it('treats a claim with no timestamp as stale rather than permanent', async () => {
    // A malformed claim (no `at`) would otherwise read as claimed-at-epoch and,
    // under a different comparison, could pin the session forever.
    const { db, ref } = makeDb({ a: session(5_000, { teardown_claim: { job: 'OTHER' } }) })
    const res = await claimSessionForTeardown(db, ref('a') as never, 'J', 5_000_000)
    assert.equal(res.outcome, 'claimed')
  })
})
