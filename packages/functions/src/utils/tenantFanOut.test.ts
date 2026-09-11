import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runSlotId, runsInlineForLocalDev, tenantQueueName } from './tenantFanOut'
import { reminderWindowHours } from '../dailyTasks/sendBookingReminders'

// THE FOUR SCHEDULED FAN-OUTS, AND THE PROPERTIES THEY NOW DEPEND ON.
//
// docs/scalability-2026-09.md §9: each cron used to loop every tenant inside one
// 300-second instance, and past a few hundred studios it died partway with some
// tenants done and some not — silently. They are dispatchers now. These pin the
// handful of things that, if they broke, would break quietly in exactly the
// same way.

const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')

describe('tenant fan-out', () => {
  // A RETRIED DISPATCHER MUST ADDRESS THE SAME TASKS. `Date.now()` cannot do
  // that; the slot the schedule fired for can. Get this wrong and every retry
  // runs every tenant's work a second time.
  it('the run id is the schedule slot, so a retry is the same id', () => {
    const a = new Date('2026-09-11T14:03:09.412Z')
    const b = new Date('2026-09-11T14:58:59.999Z')
    assert.strictEqual(runSlotId(a, 'hour'), runSlotId(b, 'hour'))
    assert.strictEqual(runSlotId(a, 'day'), runSlotId(b, 'day'))
  })

  it('and a different slot is a different id', () => {
    const h1 = new Date('2026-09-11T14:00:00Z')
    const h2 = new Date('2026-09-11T15:00:00Z')
    assert.notStrictEqual(runSlotId(h1, 'hour'), runSlotId(h2, 'hour'))
    assert.strictEqual(runSlotId(h1, 'day'), runSlotId(h2, 'day'))
    assert.notStrictEqual(runSlotId(h1, 'day'), runSlotId(new Date('2026-09-12T00:00:00Z'), 'day'))
  })

  // firebase-admin's taskQueue() defaults to us-central1 when the name carries
  // no location — a queue that does not exist. Every enqueue would fail, and the
  // job would do nothing at all.
  it('the queue is addressed with its region', () => {
    assert.strictEqual(
      tenantQueueName('remindersForTeam'),
      'locations/europe-west6/functions/remindersForTeam'
    )
  })

  // Cloud Tasks degrades on a long shared sequential prefix, and a run id is a
  // timestamp — the most sequential prefix available. `enqueueTeardownRound`
  // keys job-first for the same reason.
  it('the task id puts the tenant before the slot', () => {
    const s = src('tenantFanOut.ts')
    assert.match(s, /const id = `\$\{teamId\}-\$\{runId\}`/)
    assert.doesNotMatch(s, /`\$\{runId\}-\$\{teamId\}`/)
  })

  // A run where nothing could be enqueued is a total outage of that job. It must
  // not report success.
  it('a run that enqueued nothing throws rather than reporting a quiet success', () => {
    const s = src('tenantFanOut.ts')
    assert.match(s, /if \(result\.enqueued === 0 && result\.duplicate === 0\)\s*\{\s*\n\s*throw new Error\(/)
  })

  // `where('archived_at','==',null)` matches an EXPLICIT null and not a missing
  // field, and on `teams` the field is missing — nothing writes it on create and
  // `Team` does not declare it. A dispatcher built on that clause enqueues
  // nothing for nearly every studio and reports a clean run: the exact silent
  // half-run the conversion exists to end.
  it('archived tenants are excluded in memory, never by a query clause', () => {
    const s = src('tenantFanOut.ts')
    assert.match(s, /\.select\('archived_at'\)/)
    assert.match(s, /\.filter\(\(d\) => d\.data\(\)\?\.archived_at == null\)/)
    // Comment lines dropped first: the module QUOTES the clause it refuses to
    // use, and a naive scan of the whole file would read that as the defect.
    const code = s
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    assert.doesNotMatch(code, /where\('archived_at', '==', null\)/)
  })

  // The inline path exists so four scheduled jobs are not silently dead on a
  // developer's machine. It must never be reachable in production.
  it('the inline fallback is emulator-only', () => {
    assert.strictEqual(runsInlineForLocalDev(), !!process.env.FUNCTIONS_EMULATOR)
    assert.match(src('tenantFanOut.ts'), /process\.env\.FUNCTIONS_EMULATOR && !process\.env\.CLOUD_TASKS_EMULATOR_HOST/)
  })
})

describe('the converted crons', () => {
  // Named rather than counted, per CLAUDE.md: each entry is the job's source
  // file and the per-tenant function it must expose. `monthlyFinanceReports`
  // joined them after the fact — it was the one carrying the `archived_at`
  // clause the fan-out was written to avoid, so it wrote almost no reports at
  // all until it was converted.
  const JOBS = [
    { file: '../dailyTasks/sendBookingReminders.ts', perTeam: 'sendBookingRemindersForTeam' },
    { file: '../dailyTasks/markNoShowBookings.ts', perTeam: 'markNoShowBookingsForTeam' },
    { file: '../dailyTasks/runScheduledRules.ts', perTeam: 'runScheduledRulesForTeam' },
    { file: '../analytics/index.ts', perTeam: 'weeklyReportsForTeam' },
    { file: '../finance/monthlyReports.ts', perTeam: 'monthlyFinanceReportsForTeam' },
  ]

  it('every one dispatches per tenant instead of looping them', () => {
    for (const job of JOBS) {
      const s = src(job.file)
      assert.match(s, new RegExp(`export async function ${job.perTeam}\\(`), `${job.file} lost ${job.perTeam}`)
      assert.match(s, /dispatchTenantJob\(\{/, `${job.file} no longer dispatches`)
    }
  })

  it('each per-tenant function is wired to a task-queue worker', () => {
    const workers = src('../dailyTasks/tenantWorkers.ts')
    for (const job of JOBS) assert.match(workers, new RegExp(job.perTeam))
    // The worker names the dispatchers enqueue into must be the ones deployed.
    const WORKERS = [
      'remindersForTeam',
      'noShowsForTeam',
      'scheduledRulesForTeam',
      'weeklyReportForTeam',
      'financeReportForTeam',
    ]
    for (const name of WORKERS) {
      assert.match(workers, new RegExp(`export const ${name} = onTaskDispatched`), `${name} is not a task handler`)
      assert.match(src('../index.ts'), new RegExp(`\\b${name}\\b`), `${name} is not exported for deploy`)
    }
  })

  // The reminder scan used to cover fourteen days — the largest offset ANY team
  // could author — because a global query cannot know whose sessions it holds.
  it('the reminder window is the team’s own longest offset plus the catch-up', () => {
    assert.strictEqual(reminderWindowHours([{ id: 'a', channel: 'email', offsetHours: 24 }]), 48)
    assert.strictEqual(
      reminderWindowHours([
        { id: 'a', channel: 'email', offsetHours: 24 },
        { id: 'b', channel: 'sms', offsetHours: 2 },
      ]),
      48
    )
    // Clamped at the authorable ceiling, so a bad document cannot widen the scan.
    assert.strictEqual(reminderWindowHours([{ id: 'x', channel: 'email', offsetHours: 9999 }]), 14 * 24 + 24)
    assert.strictEqual(reminderWindowHours([]), 24)
  })

  // Both per-tenant scans skip the bookings subcollection when the session has
  // nobody in it — the other narrowing §9 asked for.
  it('a session with no bookings costs no subcollection read', () => {
    for (const f of ['../dailyTasks/sendBookingReminders.ts', '../dailyTasks/markNoShowBookings.ts']) {
      assert.match(src(f), /bookings_count === 0/, `${f} still reads bookings for empty sessions`)
    }
  })
})
