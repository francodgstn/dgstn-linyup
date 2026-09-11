import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contactIsLiveForCount, liveContactCountDeltas } from '@linyup/shared'

// THE COUNTER HAS TWO WRITERS AND ONE RULE. `trackContacts` applies deltas,
// `capturePlatformMetrics` reconciles with an authoritative count, and the
// operator console reads what they wrote. These pin the rule the delta writer
// runs on, and the ONE property the pair depends on: the reconciler writes an
// ABSOLUTE value, never an increment, or a repair would compound the drift it
// exists to remove.

const live = (teamId: string) => ({ teamId, deleted_at: null, archived_at: null })

describe('live contact counter', () => {
  it('counts a contact with both markers clear, and nothing else', () => {
    assert.strictEqual(contactIsLiveForCount(live('t1')), true)
    assert.strictEqual(contactIsLiveForCount({ teamId: 't1', deleted_at: {}, archived_at: null }), false)
    assert.strictEqual(contactIsLiveForCount({ teamId: 't1', deleted_at: null, archived_at: {} }), false)
    assert.strictEqual(contactIsLiveForCount(null), false)
  })

  it('a create adds one, a hard delete takes one back', () => {
    assert.deepStrictEqual(liveContactCountDeltas(null, live('t1')), [{ teamId: 't1', delta: 1 }])
    assert.deepStrictEqual(liveContactCountDeltas(live('t1'), null), [{ teamId: 't1', delta: -1 }])
  })

  it('archiving and restoring move it, an unrelated edit does not', () => {
    assert.deepStrictEqual(
      liveContactCountDeltas(live('t1'), { teamId: 't1', deleted_at: null, archived_at: {} }),
      [{ teamId: 't1', delta: -1 }],
    )
    assert.deepStrictEqual(
      liveContactCountDeltas({ teamId: 't1', deleted_at: null, archived_at: {} }, live('t1')),
      [{ teamId: 't1', delta: 1 }],
    )
    assert.deepStrictEqual(liveContactCountDeltas(live('t1'), live('t1')), [])
  })

  // `moveContacts` exists, and a rule that returned one number would have
  // silently dropped half of this.
  it('a move between studios is TWO deltas', () => {
    assert.deepStrictEqual(liveContactCountDeltas(live('t1'), live('t2')), [
      { teamId: 't1', delta: -1 },
      { teamId: 't2', delta: 1 },
    ])
  })

  it('an archived contact moving studios moves no counter', () => {
    const archived = (teamId: string) => ({ teamId, deleted_at: null, archived_at: {} })
    assert.deepStrictEqual(liveContactCountDeltas(archived('t1'), archived('t2')), [])
  })

  it('the nightly reconciliation writes an absolute value, never an increment', () => {
    const src = readFileSync(resolve(__dirname, 'platformMetrics.ts'), 'utf8')
    const block = /RECONCILE THE STORED COUNTER[\s\S]*?\n    \)\n/.exec(src)?.[0]
    assert.ok(block, 'the reconciliation block is still there')
    assert.match(block!, /live: contactCount\.get\(id\) \?\? 0/)
    assert.doesNotMatch(block!, /FieldValue\.increment/)
  })
})
