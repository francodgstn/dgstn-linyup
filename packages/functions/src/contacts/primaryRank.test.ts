import * as assert from 'node:assert'
import { primaryRank } from '@linyup/shared'
import type { RankLevel, RankingSystem } from '@linyup/shared'

// THE primary-rank rule — one for the coach's screen and the member's app. The
// two used to disagree on which system and on what an orphaned value shows.
//
// Since the scale decoupling a contact names a level by RankRef: its id, or a
// legacy number on a record the data flip has not reached. Both arms are pinned
// here because both are live during the transition. `RankLevel` has no `value`
// (Phase 4); `legacy` puts the number back the way a ladder document written
// before then still hands it over.

const legacy = (level: RankLevel, value: number): RankLevel => Object.assign({ ...level }, { value })

const belts: RankingSystem = {
  id: 'belts',
  name: 'Belts',
  levels: [
    { id: 'white', label: 'White', color: '#fff' },
    legacy({ id: 'blue', label: 'Blue', color: '#00f' }, 2),
    { id: 'black', label: 'Black', color: '#000' },
  ],
}
const swim: RankingSystem = {
  id: 'swim',
  name: 'Swim',
  levels: [
    { id: 'penguin', label: 'Penguin', emoji: '🐧' },
    { id: 'crab', label: 'Crab', emoji: '🦀' },
  ],
}

describe('primaryRank', () => {
  it('nothing configured, or nothing held → null (no sport-specific fallback)', () => {
    assert.strictEqual(primaryRank({ ranks: { belts: 'blue' } }, []), null)
    assert.strictEqual(primaryRank({ ranks: { belts: 'blue' } }, null), null)
    assert.strictEqual(primaryRank({ ranks: {} }, [belts]), null)
    assert.strictEqual(primaryRank({}, [belts]), null)
  })

  it('resolves an id, and still resolves a legacy number by value', () => {
    assert.strictEqual(primaryRank({ ranks: { belts: 'blue' } }, [belts])?.level.label, 'Blue')
    assert.strictEqual(primaryRank({ ranks: { belts: 2 } }, [belts])?.level.label, 'Blue')
  })

  it('the first CONFIGURED system the contact holds a rank in — never the biggest number', () => {
    // Held only in the second scale: the web showed this belt, the app showed none.
    const r = primaryRank({ ranks: { swim: 'crab' } }, [belts, swim])
    assert.strictEqual(r?.system.id, 'swim')
    assert.strictEqual(r?.level.label, 'Crab')
    // Held in both: configured order decides.
    const both = primaryRank({ ranks: { belts: 'blue', swim: 'crab' } }, [belts, swim])
    assert.strictEqual(both?.system.id, 'belts')
  })

  it('a flagged primary wins outright — even when the contact holds no rank in it', () => {
    const systems = [belts, { ...swim, is_primary: true }]
    assert.strictEqual(primaryRank({ ranks: { swim: 'penguin' } }, systems)?.level.label, 'Penguin')
    assert.strictEqual(primaryRank({ ranks: { belts: 'black' } }, systems), null)
  })

  it('AN ORPHAN RESOLVES TO NOTHING — a number no level carries used to demote to the level below', () => {
    // The stand-in was the silent demotion docs/rank-scale-decoupling.md
    // names; since Phase 4 neither kind of ref has one.
    assert.strictEqual(primaryRank({ ranks: { belts: 3 } }, [belts]), null)
    assert.strictEqual(primaryRank({ ranks: { belts: 0 } }, [belts]), null)
    assert.strictEqual(primaryRank({ ranks: { belts: 'purple' } }, [belts]), null)
  })

  it('an exact match carries the stored ref beside the level', () => {
    const r = primaryRank({ ranks: { belts: 'black' } }, [belts])
    assert.strictEqual(r?.level.label, 'Black')
    assert.strictEqual(r?.value, 'black')
    const viaNumber = primaryRank({ ranks: { belts: 2 } }, [belts])
    assert.strictEqual(viaNumber?.level.label, 'Blue')
    assert.strictEqual(viaNumber?.value, 2)
  })

  it('a numeric STRING is an id, never coerced to a value', () => {
    // A level labelled "3" would slug to "3"; treating that as the number 3
    // would silently resolve a different belt.
    assert.strictEqual(primaryRank({ ranks: { belts: '2' } }, [belts]), null)
  })
})
