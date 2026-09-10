import * as assert from 'node:assert'
import { primaryRank } from '@linyup/shared'
import type { RankingSystem } from '@linyup/shared'

// THE primary-rank rule — one for the coach's screen and the member's app. The
// two used to disagree on which system and on what an orphaned value shows.

const belts: RankingSystem = {
  id: 'belts',
  name: 'Belts',
  levels: [
    { value: 1, label: 'White', color: '#fff' },
    { value: 2, label: 'Blue', color: '#00f' },
    { value: 4, label: 'Black', color: '#000' },
  ],
}
const swim: RankingSystem = {
  id: 'swim',
  name: 'Swim',
  levels: [
    { value: 1, label: 'Penguin', emoji: '🐧' },
    { value: 2, label: 'Crab', emoji: '🦀' },
  ],
}

describe('primaryRank', () => {
  it('nothing configured, or nothing held → null (no sport-specific fallback)', () => {
    assert.strictEqual(primaryRank({ ranks: { belts: 2 } }, []), null)
    assert.strictEqual(primaryRank({ ranks: { belts: 2 } }, null), null)
    assert.strictEqual(primaryRank({ ranks: {} }, [belts]), null)
    assert.strictEqual(primaryRank({}, [belts]), null)
  })

  it('the first CONFIGURED system the contact holds a rank in — never the biggest number', () => {
    // Held only in the second scale: the web showed this belt, the app showed none.
    const r = primaryRank({ ranks: { swim: 2 } }, [belts, swim])
    assert.strictEqual(r?.system.id, 'swim')
    assert.strictEqual(r?.level.label, 'Crab')
    // Held in both: configured order decides, not 4 > 2.
    const both = primaryRank({ ranks: { belts: 2, swim: 4 } }, [belts, swim])
    assert.strictEqual(both?.system.id, 'belts')
  })

  it('a flagged primary wins outright — even when the contact holds no rank in it', () => {
    const systems = [belts, { ...swim, is_primary: true }]
    assert.strictEqual(primaryRank({ ranks: { swim: 1 } }, systems)?.level.label, 'Penguin')
    assert.strictEqual(primaryRank({ ranks: { belts: 4 } }, systems), null)
  })

  it('an orphaned value shows the nearest level at or below, and says so', () => {
    const r = primaryRank({ ranks: { belts: 3 } }, [belts])
    assert.strictEqual(r?.level.label, 'Blue')
    assert.strictEqual(r?.value, 3)
    assert.strictEqual(r?.orphaned, true)
    // Below every level: nothing to stand in.
    assert.strictEqual(primaryRank({ ranks: { belts: 0 } }, [belts]), null)
  })

  it('an exact match is not orphaned', () => {
    const r = primaryRank({ ranks: { belts: 4 } }, [belts])
    assert.strictEqual(r?.level.label, 'Black')
    assert.strictEqual(r?.orphaned, false)
  })
})
