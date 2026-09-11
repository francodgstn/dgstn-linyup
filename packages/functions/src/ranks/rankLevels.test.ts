import assert from 'node:assert/strict'
import {
  expandRankRange,
  findRankLevel,
  levelLabel,
  matchesFilter,
  nextLevel,
  orderedLevels,
  rankLevelIndex,
  rankLevelKey,
  rankRefWithin,
  ruleForLevel,
  sameRankRef,
  type RankProgression,
  type RankingSystem,
} from '@linyup/shared'

// Phase 2 of docs/rank-scale-decoupling.md — levels are named by identity and
// ordered by ladder position. The ladder here is deliberately NOT in `value`
// order, so anything still sorting by value fails here rather than in front of
// a studio that reordered its belts.

const LADDER: RankingSystem = {
  id: 'hmd',
  name: 'HMD',
  levels: [
    { id: 'white', value: 1, label: 'White' },
    { id: 'white-yellow', value: 15, label: 'White-Yellow' }, // inserted later: high value, early position
    { id: 'yellow', value: 2, label: 'Yellow' },
    { id: 'orange', value: 3, label: 'Orange' },
    { value: 9, label: 'Legacy only' }, // an unbackfilled level keeps working by value
  ],
}

describe('rankLevelKey / sameRankRef / findRankLevel', () => {
  it('a level is keyed by its id, or its value while it has none', () => {
    assert.equal(rankLevelKey(LADDER.levels[0]), 'white')
    assert.equal(rankLevelKey(LADDER.levels[4]), 9)
  })

  it('resolves a string as an id and a number as a legacy value, and never crosses', () => {
    assert.equal(findRankLevel(LADDER.levels, 'yellow')?.label, 'Yellow')
    assert.equal(findRankLevel(LADDER.levels, 2)?.label, 'Yellow')
    assert.equal(findRankLevel(LADDER.levels, 9)?.label, 'Legacy only')
    assert.equal(findRankLevel(LADDER.levels, '2'), undefined)
    assert.equal(findRankLevel(LADDER.levels, 'nope'), undefined)
  })

  it('sameRankRef compares as stored', () => {
    assert.equal(sameRankRef('white', 'white'), true)
    assert.equal(sameRankRef(9, 9), true)
    assert.equal(sameRankRef('white', 1), false)
    assert.equal(sameRankRef(null, null), false)
  })
})

describe('order is ARRAY POSITION, never value', () => {
  it('orderedLevels keeps the ladder as the studio keeps it', () => {
    assert.deepEqual(orderedLevels(LADDER).map((l) => l.label), ['White', 'White-Yellow', 'Yellow', 'Orange', 'Legacy only'])
  })

  it('rankLevelIndex is the position, whatever the value', () => {
    assert.equal(rankLevelIndex(LADDER.levels, 'white-yellow'), 1)
    assert.equal(rankLevelIndex(LADDER.levels, 2), 2) // Yellow by legacy value
    assert.equal(rankLevelIndex(LADDER.levels, 'missing'), -1)
  })

  it('nextLevel walks the ladder — through an inserted belt, not around it', () => {
    assert.equal(nextLevel(LADDER, 'white')?.label, 'White-Yellow')
    assert.equal(nextLevel(LADDER, 'white-yellow')?.label, 'Yellow')
    assert.equal(nextLevel(LADDER, null)?.label, 'White')
    assert.equal(nextLevel(LADDER, 9), null) // top
    assert.equal(nextLevel(LADDER, 'missing'), null)
  })

  it('levelLabel names a ref or says it is gone', () => {
    assert.equal(levelLabel(LADDER, 'orange'), 'Orange')
    assert.equal(levelLabel(LADDER, 'gone'), null)
  })
})

describe('rankRefWithin / expandRankRange — bands by position', () => {
  it('an inserted belt falls inside a band that spans it', () => {
    assert.equal(rankRefWithin(LADDER.levels, 'white-yellow', 'white', 'yellow'), true)
    assert.equal(rankRefWithin(LADDER.levels, 'orange', 'white', 'yellow'), false)
  })

  it('open ends are unbounded, and a legacy number resolves', () => {
    assert.equal(rankRefWithin(LADDER.levels, 'orange', 'yellow', null), true)
    assert.equal(rankRefWithin(LADDER.levels, 3, null, 'orange'), true)
  })

  it('a bound naming a deleted level makes the band unsatisfiable, never open', () => {
    assert.equal(rankRefWithin(LADDER.levels, 'yellow', 'gone', null), false)
    assert.deepEqual(expandRankRange(LADDER.levels, { min: 'gone', max: null }), [])
  })

  it('expandRankRange returns refs in ladder order', () => {
    assert.deepEqual(expandRankRange(LADDER.levels, { min: 'white-yellow', max: 3 }), ['white-yellow', 'yellow', 'orange'])
    assert.deepEqual(expandRankRange(LADDER.levels, { min: null, max: null }).length, 5)
  })
})

describe('ruleForLevel — a band by position', () => {
  const progression: RankProgression = {
    id: 'hmd',
    rules: [{ from: 'yellow', to: 'orange', requirements: [] }],
  }
  it('governs the levels inside the band and nothing outside it', () => {
    assert.ok(ruleForLevel(progression, 'yellow', LADDER))
    assert.ok(ruleForLevel(progression, 'orange', LADDER))
    assert.ok(ruleForLevel(progression, 3, LADDER)) // Orange by legacy value
    assert.equal(ruleForLevel(progression, 'white-yellow', LADDER), null)
    assert.equal(ruleForLevel(progression, 'gone', LADDER), null)
  })
})

describe('matchesFilter — the rank dimension with a ladder in context', () => {
  const NOW = Date.UTC(2026, 8, 11)
  const ctx = { nowMs: NOW, rankingSystems: [LADDER] }
  const contact = (ranks: Record<string, string | number>) => ({ ranks } as never)

  it('a band saved with ids admits a contact still on a legacy number', () => {
    const f = { rankRanges: { hmd: { min: 'yellow', max: null } } }
    assert.equal(matchesFilter(contact({ hmd: 2 }), f, ctx), true)
    assert.equal(matchesFilter(contact({ hmd: 'white' }), f, ctx), false)
  })

  it('an id-based mirror matches a numeric rank once the ladder resolves both', () => {
    const f = { rankFilter: { hmd: ['yellow', 'orange'] } }
    assert.equal(matchesFilter(contact({ hmd: 3 }), f, ctx), true)
    assert.equal(matchesFilter(contact({ hmd: 'white' }), f, ctx), false)
  })

  it('without the ladder a numeric band against a numeric rank still compares (the old behaviour)', () => {
    const f = { rankRanges: { hmd: { min: 2, max: null } } }
    assert.equal(matchesFilter(contact({ hmd: 3 }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ hmd: 1 }), f, { nowMs: NOW }), false)
  })

  it('without the ladder an id band falls back to its mirror, and never widens', () => {
    const f = { rankRanges: { hmd: { min: 'yellow', max: null } }, rankFilter: { hmd: ['yellow', 'orange'] } }
    assert.equal(matchesFilter(contact({ hmd: 'orange' }), f, { nowMs: NOW }), true)
    assert.equal(matchesFilter(contact({ hmd: 3 }), f, { nowMs: NOW }), false)
  })
})
