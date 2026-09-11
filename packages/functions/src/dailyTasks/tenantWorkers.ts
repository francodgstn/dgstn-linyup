/* eslint-disable no-console */
// ─── The task-queue workers for the per-tenant scheduled jobs ────────────────
//
// One handler per job, and each one does exactly one tenant's work. The
// dispatchers that enqueue them live beside the jobs themselves; the machinery
// they share is `utils/tenantFanOut.ts`, whose header carries the reasoning for
// the whole shape (docs/scalability-2026-09.md §9).
//
// THEY ARE SEPARATE HANDLERS AND NOT ONE GENERIC WORKER, deliberately. Firebase
// creates one Cloud Tasks queue per handler name, so four handlers means four
// queues: the hourly reminder flood cannot sit behind Monday's weekly reports,
// and each job gets retry and concurrency settings that suit its own work
// rather than the worst of the four.
//
// ── WHAT THROWS AND WHAT RETURNS ────────────────────────────────────────────
//
// Throwing hands the task back to Cloud Tasks for a retry with backoff, which
// is what a transient Firestore error wants. A BAD PAYLOAD returns instead: no
// number of retries improves a task with no teamId, and letting it throw would
// keep a dead task circling until its attempts ran out. Same rule, and the same
// reason, as `runSeriesTeardown`.
//
// A tenant whose work throws for its own reasons therefore retries on its own,
// and — this is the point of the change — takes no other tenant down with it.

import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import type { TenantTaskPayload } from '../utils/tenantFanOut'
import { sendBookingRemindersForTeam } from './sendBookingReminders'
import { markNoShowBookingsForTeam } from './markNoShowBookings'
import { runScheduledRulesForTeam } from './runScheduledRules'
import { weeklyReportsForTeam } from '../analytics'

/** Reads the tenant off a task payload, or null when the payload is unusable. */
function teamOf(data: TenantTaskPayload | undefined, label: string): string | null {
  const teamId = data?.teamId
  if (!teamId || typeof teamId !== 'string') {
    console.error(`[${label}] invalid payload:`, data)
    return null
  }
  return teamId
}

/**
 * Booking reminders for ONE tenant.
 *
 * The busiest of the four — it fires every hour — so it gets the widest
 * concurrency. Sending is idempotent per step through the booking's
 * `reminders_sent` markers, which is what makes at-least-once delivery safe
 * here: a retried task re-reads the markers and sends nothing twice.
 */
export const remindersForTeam = onTaskDispatched<TenantTaskPayload>(
  {
    timeoutSeconds: 300,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 20 },
  },
  async (req) => {
    const teamId = teamOf(req.data, 'remindersForTeam')
    if (!teamId) return
    const stats = await sendBookingRemindersForTeam(teamId)
    if (stats.sent > 0 || stats.errors > 0) {
      console.log(`[remindersForTeam] ${teamId}:`, stats)
    }
  }
)

/** No-show marking for ONE tenant. Only ever flips a `pending` booking, so a
 *  redelivery finds nothing left to do. */
export const noShowsForTeam = onTaskDispatched<TenantTaskPayload>(
  {
    timeoutSeconds: 300,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 10 },
  },
  async (req) => {
    const teamId = teamOf(req.data, 'noShowsForTeam')
    if (!teamId) return
    const stats = await markNoShowBookingsForTeam(teamId)
    if (stats.updated > 0 || stats.errors > 0) {
      console.log(`[noShowsForTeam] ${teamId}:`, stats)
    }
  }
)

/**
 * Scheduled automation rules for ONE tenant.
 *
 * The heaviest per tenant (it loads the studio's roster), and the one that can
 * SEND — so it gets the long timeout and the narrowest concurrency, which is
 * also a rate limit on how fast the platform can hit the ESP.
 *
 * Its idempotence is the automation engine's own, not this file's.
 */
export const scheduledRulesForTeam = onTaskDispatched<TenantTaskPayload>(
  {
    timeoutSeconds: 540,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 120 },
    rateLimits: { maxConcurrentDispatches: 5 },
  },
  async (req) => {
    const teamId = teamOf(req.data, 'scheduledRulesForTeam')
    if (!teamId) return
    const stats = await runScheduledRulesForTeam(teamId)
    if (stats.rules > 0) console.log(`[scheduledRulesForTeam] ${teamId}:`, stats)
  }
)

/** The weekly report for ONE tenant. Never overwrites an existing week, which
 *  is both the mid-week-increment rule and the redelivery guard. */
export const weeklyReportForTeam = onTaskDispatched<TenantTaskPayload>(
  {
    timeoutSeconds: 540,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 120 },
    rateLimits: { maxConcurrentDispatches: 10 },
  },
  async (req) => {
    const teamId = teamOf(req.data, 'weeklyReportForTeam')
    if (!teamId) return
    await weeklyReportsForTeam(teamId)
  }
)
