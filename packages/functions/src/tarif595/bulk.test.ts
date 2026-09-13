import assert from 'node:assert/strict'
import type { Tarif595OfferingMapping } from '@linyup/shared'
import { selectBulkRows, type BulkHistoryRow } from './bulk'

// The row selection behind a bulk run, pure: which subscription-history rows
// get a receipt from a window, and for which period.

const OFFERINGS: Record<string, Tarif595OfferingMapping> = {
  'subscription:monthly': { position: '1001', unit: 'month' },
  'subscription:annual': { position: '1002', unit: 'year' },
}
const WINDOW = { from: '2027-01-01', to: '2027-12-31' }
const TODAY = '2028-01-10'

const row = (id: string, type: string | null, start: string | null, end: string | null): BulkHistoryRow => ({
  id,
  subscriptionTypeId: type,
  start,
  end,
})

describe('tarif595 bulk — selectBulkRows', () => {
  it('takes a mapped row inside the window with its own period', () => {
    assert.deepEqual(selectBulkRows([row('h1', 'monthly', '2027-03-01', '2027-08-31')], WINDOW, OFFERINGS, TODAY), [
      { historyId: 'h1', from: '2027-03-01', to: '2027-08-31' },
    ])
  })

  it('clips a row that straddles the window to the window — the calendar-year receipt', () => {
    assert.deepEqual(selectBulkRows([row('h1', 'annual', '2026-06-01', '2027-05-31')], WINDOW, OFFERINGS, TODAY), [
      { historyId: 'h1', from: '2027-01-01', to: '2027-05-31' },
    ])
    assert.deepEqual(selectBulkRows([row('h2', 'annual', '2027-09-01', '2028-08-31')], WINDOW, OFFERINGS, TODAY), [
      { historyId: 'h2', from: '2027-09-01', to: '2027-12-31' },
    ])
  })

  it('an open row ends at the run day, or at the window, whichever is earlier', () => {
    assert.deepEqual(selectBulkRows([row('h1', 'monthly', '2027-11-01', null)], WINDOW, OFFERINGS, TODAY), [
      { historyId: 'h1', from: '2027-11-01', to: '2027-12-31' },
    ])
    assert.deepEqual(selectBulkRows([row('h1', 'monthly', '2027-11-01', null)], WINDOW, OFFERINGS, '2027-11-20'), [
      { historyId: 'h1', from: '2027-11-01', to: '2027-11-20' },
    ])
  })

  it('skips an unmapped plan, a row without a type or a start, and a row outside the window', () => {
    const rows = [
      row('unmapped', 'dropin', '2027-01-01', '2027-12-31'),
      row('notype', null, '2027-01-01', '2027-12-31'),
      row('nostart', 'monthly', null, '2027-12-31'),
      row('before', 'monthly', '2026-01-01', '2026-12-31'),
      row('after', 'monthly', '2028-01-01', null),
      row('edge', 'monthly', '2026-12-31', '2026-12-31'),
    ]
    assert.deepEqual(selectBulkRows(rows, WINDOW, OFFERINGS, TODAY), [])
  })

  it('an open row that started after the run day is not attested', () => {
    assert.deepEqual(selectBulkRows([row('h1', 'monthly', '2027-06-01', null)], WINDOW, OFFERINGS, '2027-05-01'), [])
  })

  it('orders by period start, then by row id, so a run is deterministic', () => {
    const rows = [row('b', 'monthly', '2027-03-01', '2027-03-31'), row('a', 'monthly', '2027-03-01', '2027-03-31'), row('c', 'annual', '2027-01-01', '2027-12-31')]
    assert.deepEqual(
      selectBulkRows(rows, WINDOW, OFFERINGS, TODAY).map((r) => r.historyId),
      ['c', 'a', 'b']
    )
  })
})
