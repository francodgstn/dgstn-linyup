import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reportMonthsForRun } from './monthlyReports'

// THE JOB THAT WROTE ALMOST NOTHING.
//
// `monthlyFinanceReports` listed tenants with `teams where archived_at == null`.
// A Firestore `== null` filter matches an EXPLICIT null and not a missing field,
// and on `teams` that field is missing — nothing writes it on create and `Team`
// does not declare it. So the clause matched almost no studio and the job logged
// a clean `0 team-months written` for as long as it existed
// (docs/scalability-2026-09.md §9). Converting it to the tenant fan-out fixed it
// by construction; these keep it fixed.

describe('monthly finance reports', () => {
  it('lists tenants through the fan-out, never through the archived clause', () => {
    const src = readFileSync(resolve(__dirname, 'monthlyReports.ts'), 'utf8')
    assert.match(src, /dispatchTenantJob\(\{/)
    // Comment lines first: the module explains the clause it refuses to use.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    assert.doesNotMatch(code, /where\('archived_at', '==', null\)/)
  })

  // A Cloud Task can run minutes — or, on a retry with backoff, hours — after
  // the schedule fired. A worker that recomputed the months from its own clock
  // could land on a different pair across a month boundary, so the run slot is
  // what decides.
  it('derives the two months from the run slot, not from the clock', () => {
    // Schedule fires on the 3rd; a retry on the 4th must regenerate the same pair.
    assert.deepEqual(reportMonthsForRun('2026-09-03'), reportMonthsForRun('2026-09-04'))
    assert.deepEqual(reportMonthsForRun('2026-09-03'), ['2026-07', '2026-08'])
    // …and the next month's run moves both.
    assert.deepEqual(reportMonthsForRun('2026-10-03'), ['2026-08', '2026-09'])
    // Across a year boundary.
    assert.deepEqual(reportMonthsForRun('2027-01-03'), ['2026-11', '2026-12'])
  })

  it('falls back to now when a task carries no run id', () => {
    const months = reportMonthsForRun(undefined)
    assert.equal(months.length, 2)
    assert.match(months[0]!, /^\d{4}-\d{2}$/)
    assert.match(months[1]!, /^\d{4}-\d{2}$/)
  })
})
