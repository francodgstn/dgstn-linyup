import * as assert from 'node:assert'
import { DEFAULT_BADGE_THRESHOLDS, mergeBadgeThresholds } from '@linyup/shared'

// ONE resolution of "the studio's thresholds over the product defaults" — the
// admin editor, the member app and the web Space all go through this, so a
// partially saved section must resolve the same everywhere.

describe('mergeBadgeThresholds', () => {
  it('nothing stored → the product defaults', () => {
    assert.deepStrictEqual(mergeBadgeThresholds(null), DEFAULT_BADGE_THRESHOLDS)
    assert.deepStrictEqual(mergeBadgeThresholds(undefined), DEFAULT_BADGE_THRESHOLDS)
    assert.deepStrictEqual(mergeBadgeThresholds({}), DEFAULT_BADGE_THRESHOLDS)
  })

  it('a partially saved section keeps every field it did not name', () => {
    const r = mergeBadgeThresholds({ attendance: { dedicated: 20 } })
    assert.strictEqual(r.attendance.dedicated, 20)
    assert.strictEqual(r.attendance.committed, DEFAULT_BADGE_THRESHOLDS.attendance.committed)
    assert.strictEqual(r.attendance.enabled, true)
    assert.deepStrictEqual(r.streak, DEFAULT_BADGE_THRESHOLDS.streak)
  })

  it('a switched-off section stays off', () => {
    assert.strictEqual(mergeBadgeThresholds({ score: { enabled: false } }).score.enabled, false)
  })

  it('a null section is "nothing stored" for that section', () => {
    assert.deepStrictEqual(mergeBadgeThresholds({ explorer: null }).explorer, DEFAULT_BADGE_THRESHOLDS.explorer)
  })

  it('returns fresh sections, never the defaults themselves (form state gets mutated)', () => {
    const r = mergeBadgeThresholds(null)
    assert.notStrictEqual(r.attendance, DEFAULT_BADGE_THRESHOLDS.attendance)
    assert.notStrictEqual(r, DEFAULT_BADGE_THRESHOLDS)
  })
})
