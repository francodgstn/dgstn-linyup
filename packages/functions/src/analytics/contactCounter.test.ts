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

/** Index just past the `)` that balances the `(` opening the call at `open`. */
function closeOfCall(src: string, open: number): number {
  assert.notStrictEqual(open, -1, 'the reconciliation is still one Promise.all call')
  let depth = 0
  for (let i = src.indexOf('(', open); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return i + 1
  }
  return assert.fail('the reconciliation call never closes')
}

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
    // Read as LF whatever the checkout: `core.autocrlf` hands a Windows working
    // tree CRLF, and a `\n` in a source anchor then never matches — the same
    // normalisation `commitSites.test.ts` and `gate.test.ts` do.
    const src = readFileSync(resolve(__dirname, 'platformMetrics.ts'), 'utf8').replace(/\r\n/g, '\n')
    const start = src.indexOf('RECONCILE THE STORED COUNTER')
    assert.notStrictEqual(start, -1, 'the reconciliation block is still there')
    // The block is the marker comment plus the ONE statement after it, ending
    // at the balanced close of that `Promise.all(` — not at a `)` on some
    // indentation, which a reformat moves and which then reports the block
    // gone while it stands.
    const block = src.slice(start, closeOfCall(src, src.indexOf('Promise.all(', start)))
    assert.match(block, /live: contactCount\.get\(id\) \?\? 0/)
    assert.doesNotMatch(block, /FieldValue\.increment/)
  })
})
