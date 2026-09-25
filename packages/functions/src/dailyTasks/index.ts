import { onSchedule } from 'firebase-functions/v2/scheduler'
import { markNoShowBookings } from './markNoShowBookings'
import { refreshHeldPlans } from './refreshHeldPlans'
import { resetExpiredStreaks } from './resetExpiredStreaks'
import { resetMonthlyScores } from './resetMonthlyScores'
import { sendBookingReminders } from './sendBookingReminders'
import { runScheduledRules } from './runScheduledRules'
import { expireAffiliations } from './expireAffiliations'
import { expirePendingBookings } from './expirePendingBookings'
import { expireOrgMemberInvitations } from './expireOrgMemberInvitations'
import { purgeProvisionalContacts } from './purgeProvisionalContacts'
import { purgeVerificationCodes } from './purgeVerificationCodes'
import { purgeCheckoutAttempts } from './purgeCheckoutAttempts'
import { purgeUnverifiedSignups } from './purgeUnverifiedSignups'
import { purgeScheduledTeams } from './purgeScheduledTeams'
import { anonymizeScheduledContacts } from './anonymizeScheduledContacts'
import { materializeRecurringEntries } from './materializeRecurringEntries'
import { refreshCustomDomains } from './refreshCustomDomains'
import { assertZoneRecordsUnproxied } from './assertZoneRecordsUnproxied'
import { rollSessionSeries } from './rollSessionSeries'
import { stampOverdueGoals } from './stampOverdueGoals'
import { sweepWaitlistOffers } from '../booking/waitlist/sweep'
import { sweepCourseWaitlistOffers } from '../courseBlocks/waitlist'
import { publishMessagingEnv } from '../mail/messagingEnvStatus'
import { resyncExpiredFeeRates } from '../connect/feeRateSync'

// Booking reminders run HOURLY (not in the 02:00 batch): multi-step schedules
// (e.g. SMS 24h before) need offset accuracy, and SMS quiet-hour deferrals need
// frequent retries. Idempotent via per-step reminders_sent markers.
// Piggybacked: the messaging ENV snapshot for the operator console (a new
// deploy's param values are visible within the hour).
export const bookingRemindersHourly = onSchedule(
  { schedule: 'every 1 hours', timeZone: 'UTC', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    await publishMessagingEnv()
    await sendBookingReminders()
    // The waitlist rides this schedule for the same reason reminders do: a claim
    // window is two hours, so an offer that lapses at 11:00 has to roll on to the
    // next person then — the 02:00 batch would leave the seat dead all day. Its
    // own failure must not take the reminders down with it, and the next hour
    // re-derives everything from storage.
    try {
      await sweepWaitlistOffers()
    } catch (err) {
      console.error('sweepWaitlistOffers failed:', err) // eslint-disable-line no-console
    }
    // The COURSE queue rides the same schedule, in its own try for the same
    // reason: two queues over two different capacities, and neither one's
    // failure may take the other down. A course claim window is measured in
    // days rather than hours, so hourly is generous here, but a place freed by
    // a lapsed offer should still roll on the same morning.
    try {
      await sweepCourseWaitlistOffers()
    } catch (err) {
      console.error('sweepCourseWaitlistOffers failed:', err) // eslint-disable-line no-console
    }
  },
)


interface TaskResult {
  name: string
  status: 'success' | 'error'
  result?: unknown
  error?: string
}

// Run daily at 03:00 CET (02:00 UTC; DST-safe because tasks are idempotent)
export const dailyTasks = onSchedule(
  { schedule: 'every day 02:00', timeZone: 'UTC', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    console.log('Daily tasks started at:', new Date().toISOString()) // eslint-disable-line no-console

    const tasks: Array<{ name: string; handler: () => Promise<unknown> }> = [
      { name: 'markNoShowBookings', handler: markNoShowBookings },
      // Plan lists whose next change (a grant ending or starting, a credit pack
      // expiring) has come due. The course rules read the flat type-id list,
      // which no write refreshes when a date simply passes.
      { name: 'refreshHeldPlans', handler: refreshHeldPlans },
      // autoArchiveTrialContacts was retired — stale trial bookings are archived by
      // the default 'lib_trial_cleanup' automation rule instead (see onTeamCreated).
      { name: 'resetExpiredStreaks', handler: resetExpiredStreaks },
      { name: 'resetMonthlyScores', handler: resetMonthlyScores },
      // sendBookingReminders moved to the hourly bookingRemindersHourly schedule.
      { name: 'runScheduledRules', handler: runScheduledRules },
      { name: 'expireAffiliations', handler: expireAffiliations },
      { name: 'expirePendingBookings', handler: expirePendingBookings },
      // Org member invitations past their deadline. Bookkeeping ONLY — accepting
      // already refuses on the deadline itself, so this sweep can never grant
      // anything and its failure is a stale row, not an open door. See the
      // module header for why it earns a place the waiver work gave nothing.
      { name: 'expireOrgMemberInvitations', handler: expireOrgMemberInvitations },
      { name: 'purgeProvisionalContacts', handler: purgeProvisionalContacts },
      // Expired one-time codes on both OTP rails. They carry an email address
      // and (on the contact rail) a plaintext code, and nothing ever deleted
      // them — see the module header for why this is not just tidiness.
      { name: 'purgeVerificationCodes', handler: purgeVerificationCodes },
      // Dead hourly rate-limit buckets in connect_checkout_attempts — a store
      // that only grew, and until the subject was hashed also held raw client
      // IPs past the 30-day promise. Deleting a bucket past its hour removes no
      // capability. See the module header.
      { name: 'purgeCheckoutAttempts', handler: purgeCheckoutAttempts },
      // Signups that never proved their address AND never did anything. Both
      // halves are required — see the module header for why deleting on the
      // first half alone would be the worst thing this file could do.
      { name: 'purgeUnverifiedSignups', handler: purgeUnverifiedSignups },
      // Studios that asked to be deleted and whose 30-day window has passed.
      // Decides nothing — see teams/deleteAccount.ts for the shape.
      { name: 'purgeScheduledTeams', handler: purgeScheduledTeams },
      // Self-service account deletions whose 30-day window has passed. Runs
      // AFTER purgeProvisionalContacts on purpose: a provisional contact that
      // asked to be deleted is better hard-deleted by that one than anonymised
      // into a permanent 'Deleted account' row nobody can explain.
      { name: 'anonymizeScheduledContacts', handler: anonymizeScheduledContacts },
      // The rolling 6-month horizon for recurring classes. Without it a series
      // simply stops at whatever was materialised the day it was created, and
      // every public booking link for it goes with it.
      { name: 'rollSessionSeries', handler: rollSessionSeries },
      // Recurring accounting entry templates (finance plugin) — e.g. monthly rent.
      { name: 'materializeRecurringEntries', handler: materializeRecurringEntries },
      // Custom domains: re-poll Cloudflare. Catches a domain that stops working
      // with no event on our side — a lapsed certificate, or a CNAME the studio
      // removed at their registrar. Status only; never registers or deletes.
      { name: 'refreshCustomDomains', handler: refreshCustomDomains },
      // Alarm for a linyup.com record that has been proxied when it should be
      // DNS-only. Since the tenant-router now passes such hosts through instead
      // of refusing them, the misconfiguration is no longer visible — but it
      // still flattens CNAMEs, which is what silently broke DKIM and cert
      // renewal on 2026-08-21.
      { name: 'assertZoneRecordsUnproxied', handler: assertZoneRecordsUnproxied },
      // Stamps `overdue_at` on goals/tasks whose target_date has just passed —
      // wakes `trackGoals`' counter recompute. Clearing the stamp back off
      // lives in `trackGoals` itself, not here — see stampOverdueGoals.ts.
      { name: 'stampOverdueGoals', handler: stampOverdueGoals },
      // A negotiated platform-fee rate that EXPIRED. One-off payments return to
      // the published rate on their own (the resolver reads the expiry at
      // charge time); recurring member subscriptions carry their fee percent on
      // the Stripe object, so they are brought back here. Idempotent.
      { name: 'resyncExpiredFeeRates', handler: () => resyncExpiredFeeRates() },
    ]

    const results: TaskResult[] = []

    for (const task of tasks) {
      console.log(`Starting task: ${task.name}`) // eslint-disable-line no-console
      try {
        const result = await task.handler()
        results.push({ name: task.name, status: 'success', result })
        console.log(`Completed task: ${task.name}`, result) // eslint-disable-line no-console
      } catch (error) {
        const err = error as Error
        console.error(`Error in task: ${task.name}`, err) // eslint-disable-line no-console
        results.push({ name: task.name, status: 'error', error: err.message || String(err) })
        // Continue with remaining tasks even if one fails
      }
    }

    console.log('Daily tasks completed:', results) // eslint-disable-line no-console
  },
)
