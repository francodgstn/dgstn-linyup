import assert from 'node:assert/strict'
import type { Tarif595OfferingMapping } from '@linyup/shared'
import { buildTarif595Lines, monthsBetween, splitByYear, type LineInput, type Tarif595PositionText } from './lines'

// A tiny position table with validity, standing in for the generated one: the
// builder only ever sees `positionOn(code, date)`.
const TABLE: Array<Tarif595PositionText & { from: string; until: string | null }> = [
  { code: '1001', text: { de: 'Training, pro 1 Monat', fr: 'F1001', it: 'I1001' }, from: '2019-01-01', until: null },
  { code: '3016', text: { de: 'Pilates, pro 1 Lektion', fr: 'F3016', it: 'I3016' }, from: '2021-01-01', until: '2026-12-31' },
  { code: '3039', text: { de: 'Kraft, pro 1 Lektion', fr: 'F3039', it: 'I3039' }, from: '2027-01-01', until: null },
  { code: '3037', text: { de: 'Aerobic, Personal Training', fr: 'F3037', it: 'I3037' }, from: '2027-01-01', until: null },
  { code: '1200', text: { de: 'Jahresabo, pro 1 Jahr', fr: 'F1200', it: 'I1200' }, from: '2027-01-01', until: null },
  { code: '9999', text: { de: 'Angebote ohne Tarifziffer', fr: 'F9999', it: 'I9999' }, from: '2022-01-01', until: null },
]
const positionOn = (code: string, date: string) => {
  const p = TABLE.find((t) => t.code === code)
  if (!p || date < p.from || (p.until !== null && date > p.until)) return null
  return { code: p.code, text: p.text }
}

function input(mapping: Tarif595OfferingMapping, extra: Partial<LineInput> = {}): LineInput {
  return {
    mapping,
    period: { from: '2027-01-15', to: '2028-01-14' },
    unitPriceMinor: 8900,
    vatRate: 0,
    language: 'de',
    positionOn,
    ...extra,
  }
}

describe('tarif595 monthsBetween — partial months round up, never below 1', () => {
  const cases: Array<[string, string, number]> = [
    ['2027-01-15', '2027-02-14', 1],
    ['2027-01-01', '2027-01-31', 1],
    ['2027-01-01', '2027-12-31', 12],
    ['2027-01-15', '2028-01-14', 12],
    ['2027-01-01', '2027-01-15', 1],
    ['2027-01-15', '2027-03-01', 2],
    ['2027-02-01', '2027-04-30', 3],
  ]
  for (const [from, to, want] of cases) {
    it(`${from} – ${to} = ${want}`, () => assert.equal(monthsBetween(from, to), want))
  }
})

describe('tarif595 splitByYear — anniversaries of the start, not calendar years', () => {
  it('a period inside a year is one segment', () => {
    assert.deepEqual(splitByYear('2027-01-15', '2027-12-31'), [{ from: '2027-01-15', to: '2027-12-31' }])
  })
  it('Qualitop FAQ 3.7: 01.04.2027 – 31.03.2029 is two lines dated each year start', () => {
    assert.deepEqual(splitByYear('2027-04-01', '2029-03-31'), [
      { from: '2027-04-01', to: '2028-03-31' },
      { from: '2028-04-01', to: '2029-03-31' },
    ])
  })
  it('an 18-month period has a short second segment', () => {
    assert.deepEqual(splitByYear('2027-01-01', '2028-06-30'), [
      { from: '2027-01-01', to: '2027-12-31' },
      { from: '2028-01-01', to: '2028-06-30' },
    ])
  })
})

describe('tarif595 buildTarif595Lines — one case per line rule', () => {
  it('month: one line, quantity = months, dated the period start, amount = qty × unit', () => {
    const r = buildTarif595Lines(input({ position: '1001', unit: 'month' }))
    assert.deepEqual(r.issues, [])
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].quantity, 12)
    assert.equal(r.lines[0].date_begin, '2027-01-15')
    assert.equal(r.lines[0].amount_minor, 12 * 8900)
    assert.equal(r.lines[0].name, 'Training, pro 1 Monat')
    assert.equal(r.totals.amount_minor, 106800)
  })

  it('month, multi-year: one line per year, each dated its own start', () => {
    const r = buildTarif595Lines(input({ position: '1001', unit: 'month' }, { period: { from: '2027-04-01', to: '2029-03-31' } }))
    assert.equal(r.lines.length, 2)
    assert.deepEqual(
      r.lines.map((l) => [l.date_begin, l.quantity]),
      [
        ['2027-04-01', 12],
        ['2028-04-01', 12],
      ]
    )
  })

  it('year: quantity 1 per anniversary year', () => {
    const r = buildTarif595Lines(input({ position: '1200', unit: 'year' }, { period: { from: '2027-04-01', to: '2029-03-31' }, unitPriceMinor: 80000 }))
    assert.deepEqual(
      r.lines.map((l) => [l.date_begin, l.quantity, l.amount_minor]),
      [
        ['2027-04-01', 1, 80000],
        ['2028-04-01', 1, 80000],
      ]
    )
    assert.equal(r.totals.amount_minor, 160000)
  })

  it('lesson: one line per attended day, quantity 1, dates outside the period and duplicates dropped', () => {
    const r = buildTarif595Lines(
      input(
        { position: '3039', unit: 'lesson' },
        {
          period: { from: '2027-03-01', to: '2027-03-31' },
          attendanceDates: ['2027-03-09', '2027-03-02', '2027-03-02', '2027-04-01', '2027-03-16'],
          unitPriceMinor: 2500,
        }
      )
    )
    assert.deepEqual(
      r.lines.map((l) => [l.date_begin, l.quantity, l.record_id]),
      [
        ['2027-03-02', 1, 1],
        ['2027-03-09', 1, 2],
        ['2027-03-16', 1, 3],
      ]
    )
    assert.equal(r.totals.amount_minor, 7500)
  })

  it('lesson with no attendance yields no_lines', () => {
    const r = buildTarif595Lines(input({ position: '3039', unit: 'lesson' }, { attendanceDates: [] }))
    assert.deepEqual(r.lines, [])
    assert.deepEqual(r.issues, [{ code: 'no_lines' }])
  })

  it('entry: ONE line with the pass size as quantity (Qualitop FAQ 3.4)', () => {
    const r = buildTarif595Lines(input({ position: '3039', unit: 'entry', entries: 10 }, { unitPriceMinor: 2500 }))
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].quantity, 10)
    assert.equal(r.lines[0].amount_minor, 25000)
  })

  it('flat: one line, quantity 1', () => {
    const r = buildTarif595Lines(input({ position: '1001', unit: 'flat' }))
    assert.deepEqual(r.lines.map((l) => l.quantity), [1])
  })

  it('personal training adds the PT companion line at zero (Qualitop FAQ 4.6)', () => {
    const r = buildTarif595Lines(input({ position: '1001', unit: 'month', ptPosition: '3037' }))
    assert.deepEqual(
      r.lines.map((l) => [l.code, l.quantity, l.amount_minor]),
      [
        ['1001', 12, 106800],
        ['3037', 12, 0],
      ]
    )
    assert.equal(r.totals.amount_minor, 106800)
  })

  it('9999 carries the custom text; any other code keeps the official text', () => {
    const custom = buildTarif595Lines(input({ position: '9999', unit: 'flat', customName: 'Kletterkurs Herbst' }))
    assert.equal(custom.lines[0].name, 'Kletterkurs Herbst')
    const official = buildTarif595Lines(input({ position: '1001', unit: 'flat', customName: 'ignored' }))
    assert.equal(official.lines[0].name, 'Training, pro 1 Monat')
  })

  it('the position is looked up by the LINE date: 3016 expired 2026-12-31 is refused for a 2027 line', () => {
    const r = buildTarif595Lines(input({ position: '3016', unit: 'flat' }))
    assert.deepEqual(r.lines, [])
    assert.deepEqual(r.issues, [{ code: 'position_invalid_on_date', detail: '3016@2027-01-15' }])
    const ok = buildTarif595Lines(input({ position: '3016', unit: 'flat' }, { period: { from: '2026-12-01', to: '2026-12-31' } }))
    assert.equal(ok.lines.length, 1)
  })

  it('text follows the receipt language', () => {
    const r = buildTarif595Lines(input({ position: '1001', unit: 'flat' }, { language: 'fr' }))
    assert.equal(r.lines[0].name, 'F1001')
  })

  it('VAT contained in a gross price: 8.1% of 75.00 is 5.62', () => {
    const r = buildTarif595Lines(
      input({ position: '3039', unit: 'entry', entries: 3 }, { unitPriceMinor: 2500, vatRate: 8.1 })
    )
    assert.equal(r.totals.amount_minor, 7500)
    assert.equal(r.totals.vat_minor, 562)
  })

  it('an inverted period is period_invalid', () => {
    const r = buildTarif595Lines(input({ position: '1001', unit: 'month' }, { period: { from: '2027-02-01', to: '2027-01-01' } }))
    assert.deepEqual(r.issues, [{ code: 'period_invalid' }])
  })
})
