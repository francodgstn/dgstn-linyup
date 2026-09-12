import * as assert from 'node:assert'
import { newRankLevelId, slugRankLevelId, withRankLevelIds } from '@linyup/shared'
import type { RankLevel, RankLevelInput } from '@linyup/shared'

// Stable level identities — Phase 1 of docs/rank-scale-decoupling.md. The
// property that matters most is DETERMINISM: a re-seed, a re-run backfill and a
// fresh HMD migration must all produce the same ids, or contacts ranked by the
// previous run are orphaned by the next.

describe('slugRankLevelId', () => {
  it('derives a lowercase ASCII slug from the label', () => {
    assert.strictEqual(slugRankLevelId('Black I Dan', []), 'black-i-dan')
    assert.strictEqual(slugRankLevelId('Orange/Green', []), 'orange-green')
    assert.strictEqual(slugRankLevelId('No belt', []), 'no-belt')
  })

  it('strips diacritics rather than dropping the letter', () => {
    assert.strictEqual(slugRankLevelId('Eisbär (WSC)', []), 'eisbar-wsc')
    assert.strictEqual(slugRankLevelId('Brust & Delfin — Einführung', []), 'brust-delfin-einfuhrung')
  })

  it('deduplicates against ids already taken, with a numeric suffix', () => {
    assert.strictEqual(slugRankLevelId('Black', ['black']), 'black-2')
    assert.strictEqual(slugRankLevelId('Black', ['black', 'black-2']), 'black-3')
  })

  it('falls back to the position when the label yields nothing', () => {
    assert.strictEqual(slugRankLevelId('🐧', [], 3), 'level-3')
    assert.strictEqual(slugRankLevelId('', [], 0), 'level-0')
  })
})

describe('withRankLevelIds', () => {
  const ladder: RankLevelInput[] = [
    { label: 'White', color: '#fff' },
    { label: 'Blue', color: '#00f' },
    { label: 'Blue', color: '#00e' },
  ]

  it('fills every missing id deterministically and preserves order', () => {
    const out = withRankLevelIds(ladder)
    assert.deepStrictEqual(out.map((l) => l.id), ['white', 'blue', 'blue-2'])
    assert.deepStrictEqual(out.map((l) => l.label), ['White', 'Blue', 'Blue'])
  })

  it('is idempotent — a second pass changes nothing', () => {
    const once = withRankLevelIds(ladder)
    assert.deepStrictEqual(withRankLevelIds(once), once)
  })

  it('never replaces an id that is already there, even when the label changed', () => {
    const renamed: RankLevel[] = [{ id: 'yellow', label: 'Gold' }]
    assert.strictEqual(withRankLevelIds(renamed)[0].id, 'yellow')
  })

  it('treats an existing id as taken when minting the others', () => {
    const mixed: RankLevelInput[] = [
      { id: 'blue', label: 'White' },
      { label: 'Blue' },
    ]
    assert.deepStrictEqual(withRankLevelIds(mixed).map((l) => l.id), ['blue', 'blue-2'])
  })

  it('agrees with the ids the HMD migration writes literally', () => {
    // scripts/migration/config.ts carries these fifteen strings by hand so the
    // migration is reproducible by reading it. If this derivation ever drifts
    // from them, a backfilled staging org and a freshly migrated one disagree.
    const labels = [
      'No belt', 'White', 'Yellow', 'Orange', 'Orange/Green', 'Green', 'Green/Blue',
      'Blue', 'Blue/Red', 'Red', 'Red/Black', 'Black I Dan', 'Black II Dan',
      'Black III Dan', 'Master',
    ]
    const ids = withRankLevelIds(labels.map((label, value) => ({ value, label }))).map((l) => l.id)
    assert.deepStrictEqual(ids, [
      'no-belt', 'white', 'yellow', 'orange', 'orange-green', 'green', 'green-blue',
      'blue', 'blue-red', 'red', 'red-black', 'black-i-dan', 'black-ii-dan',
      'black-iii-dan', 'master',
    ])
  })
})

describe('newRankLevelId', () => {
  it('is ten base-36 characters and does not repeat across a sample', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const id = newRankLevelId()
      assert.match(id, /^[a-z0-9]{10}$/)
      seen.add(id)
    }
    assert.strictEqual(seen.size, 2000)
  })
})
