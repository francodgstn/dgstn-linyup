import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { suggestTarif595Unit } from '@linyup/shared'

// The UNIT half of a mapping is derived, never proposed — pinned here. The
// position half is the model's, and the parser in suggest.ts is what makes
// its answer safe: a code the table does not know, or not valid today, is
// dropped to null. The source pins below keep that boundary where it is.

describe('tarif595 suggestTarif595Unit — the unit follows from the offering', () => {
  it('a course is flat, a class is a lesson', () => {
    assert.deepEqual(suggestTarif595Unit({ kind: 'course' }), { unit: 'flat', entries: null })
    assert.deepEqual(suggestTarif595Unit({ kind: 'activity', activityType: 'class' }), { unit: 'lesson', entries: null })
  })
  it('a credit pack is entries, sized by the pack — before any recurrence', () => {
    assert.deepEqual(suggestTarif595Unit({ kind: 'subscription', credits: 10, recurrences: ['one_time', 'monthly'] }), { unit: 'entry', entries: 10 })
  })
  it('monthly (and the shorter recurrences) bill per month; a plan sold monthly AND yearly stays per month', () => {
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: ['monthly'] })?.unit, 'month')
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: ['weekly'] })?.unit, 'month')
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: ['quarterly'] })?.unit, 'month')
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: ['annual', 'monthly'] })?.unit, 'month')
  })
  it('annual only bills per year; per-class per lesson; one-time flat', () => {
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: ['annual'] })?.unit, 'year')
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: ['per_class'] })?.unit, 'lesson')
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: ['one_time'] })?.unit, 'flat')
  })
  it('a plan with no prices decides nothing — the row stays empty rather than guessed', () => {
    assert.equal(suggestTarif595Unit({ kind: 'subscription' }), null)
    assert.equal(suggestTarif595Unit({ kind: 'subscription', recurrences: [], credits: 0 }), null)
  })
})

describe('tarif595 suggest.ts — the parser is the boundary', () => {
  const src = readFileSync(join(__dirname, 'suggest.ts'), 'utf8').replace(/\r\n/g, '\n')
  it('every code from the model is checked against the table AND today, never passed through', () => {
    assert.match(src, /tarif595PositionOn\(v\.trim\(\), today\)/)
    assert.match(src, /const position = validCode\(s\.position\)/)
    assert.match(src, /ptPosition: validCode\(s\.ptPosition\)/)
  })
  it('writes nothing — no Firestore write, batch or transaction anywhere in the file', () => {
    // `proposed.set(` is a Map; a Firestore write goes through a ref or a batch.
    assert.ok(!/\b(ref|docRef|batch|tx)\.(set|update|delete|create)\(/.test(src), 'suggest.ts must not write')
    assert.ok(!/runTransaction\(|\.batch\(\)|FieldValue\./.test(src), 'suggest.ts must not write')
  })
  it('is rate-limited through the ONE limiter, not a copy', () => {
    assert.match(src, /import \{ assertUnderRateLimit \} from '\.\.\/offer\/draftOfferings'/)
    assert.match(src, /await assertUnderRateLimit\(uid, teamId, 'tarif595_suggest'/)
  })
})
