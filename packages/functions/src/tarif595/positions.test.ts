import assert from 'node:assert/strict'
import {
  TARIF595_CHAPTERS,
  TARIF595_LIST_VERSION,
  TARIF595_POSITIONS,
  tarif595Position,
  tarif595PositionOn,
  tarif595PositionsOn,
} from '@linyup/shared/tarif595-positions'

// THE ONE PLACE the counts of the generated table live (CLAUDE.md: a comment
// must never assert a count; a test may, because here the number is
// executable). When Forum Datenaustausch publishes the next edition, regenerate
// (`pnpm tarif595:positions`) and let these lines tell you what moved.

describe('tarif595 positions — the generated table', () => {
  it('is the 03.06.2026 edition with 596 positions in 18 chapters', () => {
    assert.equal(TARIF595_LIST_VERSION, '2026-06-03')
    assert.equal(TARIF595_POSITIONS.length, 596)
    assert.equal(TARIF595_CHAPTERS.length, 18)
  })

  it('codes are unique four-digit strings', () => {
    const codes = TARIF595_POSITIONS.map((p) => p.code)
    assert.equal(new Set(codes).size, codes.length)
    assert.ok(codes.every((c) => /^[0-9]{4}$/.test(c)))
  })

  it('every position carries de, fr and it text and belongs to a listed chapter', () => {
    const chapters = new Set(TARIF595_CHAPTERS.map((c) => c.id))
    for (const p of TARIF595_POSITIONS) {
      assert.ok(p.text.de && p.text.fr && p.text.it, p.code)
      assert.ok(chapters.has(p.chapter), `${p.code} chapter ${p.chapter}`)
    }
  })

  it('513 positions start on 2027-01-01 and 18 expire on 2026-12-31', () => {
    assert.equal(TARIF595_POSITIONS.filter((p) => p.valid_from === '2027-01-01').length, 513)
    assert.equal(TARIF595_POSITIONS.filter((p) => p.valid_until === '2026-12-31').length, 18)
  })

  it('the well-known codes exist: 1001, 1100, 1105, 9999', () => {
    assert.equal(tarif595Position('1001')?.text.de, 'Training auf der Trainingsfläche, pro 1 Monat')
    assert.ok(tarif595Position('1100'))
    assert.equal(tarif595Position('1105')?.text.de, 'Aufgezeichnetes Onlinetraining')
    assert.ok(tarif595Position('9999'))
    assert.equal(tarif595Position('0000'), null)
  })

  it('validity is decided by the line date', () => {
    assert.ok(tarif595PositionOn('3016', '2026-12-31'), 'Pilates per lesson still valid on the last day of 2026')
    assert.equal(tarif595PositionOn('3016', '2027-01-01'), null)
    assert.equal(tarif595PositionOn('3039', '2026-12-31'), null)
    assert.ok(tarif595PositionOn('3039', '2027-01-01'))
    assert.ok(tarif595PositionOn('1001', '2020-06-01'))
  })

  it('tarif595PositionsOn filters the table by date', () => {
    const in2027 = tarif595PositionsOn('2027-06-01')
    // 18 expire on 2026-12-31 and 2 expired on 2022-12-31 (the old livestream pair).
    assert.equal(in2027.length, 596 - 18 - 2)
    assert.equal(TARIF595_POSITIONS.filter((p) => p.valid_until === '2022-12-31').length, 2)
    assert.ok(in2027.every((p) => p.valid_from <= '2027-06-01'))
  })
})
