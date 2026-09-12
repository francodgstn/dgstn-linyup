import * as assert from 'node:assert'
import { primaryRank } from '@linyup/shared'
import type { RankingSystem } from '@linyup/shared'

// THE primary-rank rule — one for the coach's screen and the member's app. The
// two used to disagree on which system and on what an orphaned value shows.
//
// Since the scale decoupling a contact names a level by RankRef: its id, or a
// legacy number on a record the data flip has not reached. Both arms are pinned
// here because both are live during the transition.

const belts: RankingSystem = {
  id: 'belts',
  name: 'Belts',
  levels: [
    { id: 'white', value: 1, label: 'White', color: '#fff' },
    { id: 'blue', value: 2, label: 'Blue', color: '#00f' },
    { id: 'black', value: 4, label: 'Black', color: '#000' },
  ],
}
const swim: RankingSystem = {
  id: 'swim',
  name: 'Swim',
  levels: [
    { id: 'penguin', value: 1, label: 'Penguin', emoji: '🐧' },
    { id: 'crab', value: 2, label: 'Crab', emoji: '🦀' },
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

  it('an orphaned NUMBER shows the nearest level at or below, and says so', () => {
    const r = primaryRank({ ranks: { belts: 3 } }, [belts])
    assert.strictEqual(r?.level.label, 'Blue')
    assert.strictEqual(r?.value, 3)
    assert.strictEqual(r?.orphaned, true)
    // Below every level: nothing to stand in.
    assert.strictEqual(primaryRank({ ranks: { belts: 0 } }, [belts]), null)
  })

  it('an orphaned ID has no stand-in — identities do not sort — so it resolves to nothing', () => {
    assert.strictEqual(primaryRank({ ranks: { belts: 'purple' } }, [belts]), null)
  })

  it('an exact match is not orphaned', () => {
    const r = primaryRank({ ranks: { belts: 'black' } }, [belts])
    assert.strictEqual(r?.level.label, 'Black')
    assert.strictEqual(r?.orphaned, false)
  })

  it('a numeric STRING is an id, never coerced to a value', () => {
    // A level labelled "3" would slug to "3"; treating that as the number 3
    // would silently resolve a different belt.
    assert.strictEqual(primaryRank({ ranks: { belts: '2' } }, [belts]), null)
  })
})
