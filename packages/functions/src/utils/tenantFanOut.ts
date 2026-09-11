/* eslint-disable no-console */
// ─── Scheduled jobs fan out to ONE TASK PER TENANT ───────────────────────────
//
// THE PROBLEM THIS EXISTS FOR. Every scheduled job was one Cloud Functions
// instance looping tenants sequentially with `await` inside the loop, under a
// 300-second timeout. At a few hundred studios that does not slow down — it
// DIES PARTWAY, and the failure is silent in the worst possible way: some
// tenants got their reminders and their rules and some did not, with nothing on
// any screen to say which. docs/scalability-2026-09.md §9 sized it at roughly
// 300–800 tenants and called it the load-bearing problem for growth.
//
// The fix is not a bigger timeout. A single instance is a single point of
// failure for every tenant at once, and one studio's bad data takes the whole
// run down with it. So each cron becomes a DISPATCHER: it lists the tenants and
// enqueues one Cloud Task each, and a task-queue worker does one tenant's work.
// That buys four things a loop cannot have — parallelism, per-tenant retry with
// backoff, isolation of one tenant's failure, and a per-tenant timeout budget
// that no longer has to be shared with everybody else.
//
// `runSeriesTeardown` and `executeDelayedRule` already ran on this machinery;
// this module is what makes it reusable rather than copied a third and fourth
// time.
//
// ── IDEMPOTENCE IS THE TENANT'S JOB, NOT THE QUEUE'S ────────────────────────
//
// Cloud Tasks gives at-least-once delivery, so every worker must be safe to run
// twice on the same tenant in the same slot. All four converted jobs already
// were, and by their own mechanisms rather than by a flag this module owns:
// reminders carry per-step `reminders_sent` markers, the weekly report refuses
// to overwrite an existing week, no-show only flips `pending` bookings, and the
// automation engine dedupes on its own run keys. A deterministic task id is
// added on top as a cheap first line of defence — never as the guarantee.
//
// ── THE TASK ID PUTS THE TENANT FIRST, DELIBERATELY ─────────────────────────
//
// `{teamId}-{runId}`, not `{runId}-{teamId}`. Cloud Tasks degrades badly when
// ids share a long sequential prefix, and a run id is a timestamp — the most
// sequential prefix available. The same reasoning is written on
// `enqueueTeardownRound`, which keys job-first for exactly this reason.
//
// An id Cloud Tasks would refuse (a tenant id carrying a character outside
// `[A-Za-z0-9_-]`) falls back to enqueueing WITHOUT an id. That is the safe
// direction and it is safe only because of the paragraph above: a second run of
// an idempotent job costs a few reads, while a SKIPPED tenant is the silent
// half-run this whole change exists to end.

import * as admin from 'firebase-admin'
import { TEAMS_COLLECTION } from '@linyup/shared'
import { to } from './async'

/** Region of the deployed handlers — `setGlobalOptions` in src/index.ts.
 *  firebase-admin's `taskQueue('name')` defaults to us-central1 when the name
 *  carries no location, which is a queue that does not exist. Same rule, same
 *  reason, as DELAYED_RULE_FUNCTION in utils/automationEngine.ts. */
const FUNCTIONS_REGION = 'europe-west6'

export function tenantQueueName(functionName: string): string {
  return `locations/${FUNCTIONS_REGION}/functions/${functionName}`
}

/** What every tenant task carries. `runId` is the SCHEDULE SLOT, not the
 *  dispatch time, so a retried dispatcher addresses the same tasks. */
export interface TenantTaskPayload {
  teamId: string
  runId: string
}

export interface FanOutResult {
  teams: number
  enqueued: number
  /** Cloud Tasks refused the id because that (tenant, slot) is already queued —
   *  a retried dispatcher, which is a success and not an error. */
  duplicate: number
  failed: number
}

/**
 * The slot a firing belongs to.
 *
 * A retry of the SAME firing must produce the SAME id, or the retry enqueues a
 * second set of tasks and every tenant's work runs twice. `Date.now()` cannot do
 * that; the slot the schedule fired for can. UTC throughout — the schedules are
 * declared in UTC, and a local-time slot would produce two ids for one firing on
 * the day the clocks move.
 */
export function runSlotId(now: Date, granularity: 'hour' | 'day'): string {
  const iso = now.toISOString()
  return granularity === 'hour' ? iso.slice(0, 13).replace('T', 'T') : iso.slice(0, 10)
}

/**
 * Every tenant a scheduled job dispatches to.
 *
 * A PROJECTION, not a full read: `select('archived_at')` returns the document
 * keys and that one field, so the dispatcher's own cost stays flat however
 * large tenant documents get.
 *
 * ── WHY THE ARCHIVED FILTER IS IN MEMORY AND NOT IN THE QUERY ───────────────
 *
 * `where('archived_at', '==', null)` matches an EXPLICIT null and NOT a missing
 * field, and on `teams` the field is missing: nothing writes it on create, and
 * `Team` does not declare it. So that clause — which reads like a harmless
 * exclusion — matches almost no studio at all, and a dispatcher built on it
 * would enqueue nothing for nearly everybody while reporting a clean run. That
 * is precisely the silent half-run this whole change exists to end, which is
 * why it is not inherited here.
 *
 * Asked in memory, a MISSING marker correctly reads as "not archived" — the
 * shape `materializeRecurringEntries` already uses on a team document it holds.
 * (The same query shape still stands in `finance/monthlyReports.ts`; it is a
 * pre-existing defect of that job, out of this module's reach.)
 */
export async function listFanOutTeamIds(
  db: admin.firestore.Firestore = admin.firestore()
): Promise<string[]> {
  const [err, snap] = await to(db.collection(TEAMS_COLLECTION).select('archived_at').get())
  if (err || !snap) {
    console.error('[fanOut] could not list tenants:', err)
    throw err ?? new Error('tenant listing failed')
  }
  return snap.docs.filter((d) => d.data()?.archived_at == null).map((d) => d.id)
}

const TASK_ID_SAFE = /^[A-Za-z0-9_-]+$/

/** Cloud Tasks accepts only `[A-Za-z0-9_-]`; anything else enqueues unnamed. */
function taskIdFor(teamId: string, runId: string): string | undefined {
  const id = `${teamId}-${runId}`
  return TASK_ID_SAFE.test(id) && id.length <= 500 ? id : undefined
}

/**
 * Is this process a local emulator WITHOUT a Cloud Tasks emulator behind it?
 *
 * `firebase emulators:start` does not run Cloud Tasks unless asked, so every
 * enqueue there fails — which would make four scheduled jobs do nothing at all
 * on a developer's machine and look like they worked. In that case the caller
 * runs the tenants inline instead. Production has no such branch: the check
 * requires FUNCTIONS_EMULATOR, which only the emulator sets.
 */
export function runsInlineForLocalDev(): boolean {
  return !!process.env.FUNCTIONS_EMULATOR && !process.env.CLOUD_TASKS_EMULATOR_HOST
}

/**
 * Enqueue one task per tenant.
 *
 * ONE FAILED TENANT IS NOT A FAILED RUN — that isolation is half the point of
 * the change — so a rejected enqueue is counted and the loop continues. But a
 * run where NOTHING could be enqueued is a total outage of that job, and it
 * throws, so the scheduler records a failure instead of a green tick over a job
 * that did nothing.
 */
export async function enqueueTenantTasks(params: {
  /** The deployed task-queue handler's name, e.g. 'remindersForTeam'. */
  functionName: string
  runId: string
  teamIds: string[]
  /** For logs. Defaults to the function name. */
  label?: string
}): Promise<FanOutResult> {
  const { functionName, runId, teamIds } = params
  const label = params.label ?? functionName
  const result: FanOutResult = { teams: teamIds.length, enqueued: 0, duplicate: 0, failed: 0 }
  if (teamIds.length === 0) return result

  const { getFunctions } = await import('firebase-admin/functions')
  const queue = getFunctions().taskQueue<TenantTaskPayload>(tenantQueueName(functionName))

  for (const teamId of teamIds) {
    const id = taskIdFor(teamId, runId)
    try {
      await queue.enqueue({ teamId, runId }, id ? { id } : {})
      result.enqueued++
    } catch (err) {
      if ((err as { code?: string })?.code === 'functions/task-already-exists') {
        // The dispatcher was retried. The task we wanted queued is queued.
        result.duplicate++
        continue
      }
      result.failed++
      console.error(`[fanOut:${label}] enqueue failed for team ${teamId}:`, err)
    }
  }

  if (result.enqueued === 0 && result.duplicate === 0) {
    throw new Error(
      `[fanOut:${label}] could not enqueue any of ${teamIds.length} tenant task(s) — the job did nothing`
    )
  }
  console.log(`[fanOut:${label}] run ${runId}:`, result)
  return result
}

/**
 * The dispatcher half of a converted cron: list the tenants, enqueue one task
 * each — or, on a developer's machine with no Cloud Tasks emulator, just run
 * them.
 *
 * `perTeam` is the SAME function the task-queue worker calls, which is what
 * keeps the inline path from becoming a second implementation that drifts.
 */
export async function dispatchTenantJob(params: {
  functionName: string
  granularity: 'hour' | 'day'
  perTeam: (teamId: string) => Promise<unknown>
  now?: Date
  label?: string
}): Promise<FanOutResult> {
  const label = params.label ?? params.functionName
  const runId = runSlotId(params.now ?? new Date(), params.granularity)
  const teamIds = await listFanOutTeamIds()

  if (runsInlineForLocalDev()) {
    console.log(`[fanOut:${label}] no Cloud Tasks emulator — running ${teamIds.length} tenant(s) inline`)
    const result: FanOutResult = { teams: teamIds.length, enqueued: 0, duplicate: 0, failed: 0 }
    for (const teamId of teamIds) {
      try {
        await params.perTeam(teamId)
        result.enqueued++
      } catch (err) {
        result.failed++
        console.error(`[fanOut:${label}] inline run failed for team ${teamId}:`, err)
      }
    }
    return result
  }

  return enqueueTenantTasks({ functionName: params.functionName, runId, teamIds, label })
}
