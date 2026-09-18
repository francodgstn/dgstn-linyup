// Bring live member subscriptions onto the platform-fee rate that applies NOW.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
// A one-off payment reads the rate at checkout (`loadEnabledTeam` →
// `resolvePlatformFee`), so a negotiated rate, its expiry, a comp or a plan
// change reach it on the very next charge with nothing to run. A recurring member
// subscription does not: Stripe stores `application_fee_percent` ON the
// subscription at creation and applies that number to every invoice after. So a
// rate change reaches existing subscriptions only when somebody updates them —
// which is this module, called from two places:
//
//   • `resyncTenantFeeRate` (ops/feeRate.ts) — the operator's button, after
//     setting or ending a negotiated rate;
//   • `resyncExpiredFeeRates` (dailyTasks) — a negotiated rate that EXPIRED, so a
//     deal that ended stops discounting the subscriptions it was applied to.
//
// It never decides a rate. It asks the one resolver and writes what it says, so
// it is idempotent: a subscription already on the resolved percent is left alone,
// and running it twice does nothing the second time.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  LIVE_SUBSCRIPTION_STATUSES,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  ORGANIZATIONS_COLLECTION,
  TEAMS_COLLECTION,
  takeRatePercent,
} from '@linyup/shared'
import { getConnectStripe } from '../utils/connect/client'
import { loadEnabledTeam, type EnabledTeam } from './access'

export interface TeamFeeResync {
  teamId: string
  /** The percent the live subscriptions were brought to; null when skipped. */
  percent: number | null
  updated: number
  unchanged: number
  failed: number
  /** Why the team was not touched at all. */
  skipped?: 'payments_disabled' | 'no_account'
}

export async function resyncTeamSubscriptionFees(teamId: string): Promise<TeamFeeResync> {
  const result: TeamFeeResync = { teamId, percent: null, updated: 0, unchanged: 0, failed: 0 }

  let team: EnabledTeam
  try {
    team = await loadEnabledTeam(teamId)
  } catch {
    // Not found, or the operator kill-switch — either way nothing may be charged,
    // so there is nothing to bring onto a rate.
    return { ...result, skipped: 'payments_disabled' }
  }
  const accountId = team.payments?.connectAccountId
  if (!accountId) return { ...result, skipped: 'no_account' }

  const percent = takeRatePercent(team.plan, team.feeWaived, team.fee.rate)
  result.percent = percent

  const subs = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    // Every status Stripe can still invoice — `unpaid` included, which is not
    // "live" for access but keeps retrying its invoices at the stored percent.
    .where('status', 'in', [...LIVE_SUBSCRIPTION_STATUSES, 'unpaid'])
    .get()
  if (subs.empty) return result

  const stripe = await getConnectStripe()
  for (const doc of subs.docs) {
    const data = doc.data()
    if (data.application_fee_percent === percent) {
      result.unchanged += 1
      continue
    }
    const subscriptionId = (data.subscriptionId as string | undefined) ?? doc.id
    try {
      await stripe.subscriptions.update(
        subscriptionId,
        { application_fee_percent: percent },
        { stripeAccount: accountId }
      )
      // The Connect webhook writes the same value back on
      // customer.subscription.updated; mirroring it now keeps the operator's
      // numbers right before that event lands, and makes a re-run a no-op.
      await doc.ref.set(
        { application_fee_percent: percent, updated_at: FieldValue.serverTimestamp() },
        { merge: true }
      )
      result.updated += 1
    } catch (err) {
      console.error(`[fee-resync] ${teamId}/${subscriptionId} failed:`, err)
      result.failed += 1
    }
  }
  return result
}

/** Every studio a tenant's rate reaches: the team itself, or every team in the org. */
export async function resyncTenantSubscriptionFees(
  kind: 'team' | 'org',
  entityId: string
): Promise<TeamFeeResync[]> {
  if (kind === 'team') return [await resyncTeamSubscriptionFees(entityId)]
  const teams = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .where('org_id', '==', entityId)
    .get()
  const results: TeamFeeResync[] = []
  // Sequential on purpose: each team is a run of Stripe writes, and an org is a
  // handful of studios — parallelism buys nothing and invites rate limits.
  for (const t of teams.docs) results.push(await resyncTeamSubscriptionFees(t.id))
  return results
}

/**
 * Daily: tenants whose negotiated rate expired in the last few days.
 *
 * The window is several days wide so a missed daily run is caught by the next
 * one; the resync is idempotent, so re-visiting a tenant changes nothing.
 */
export async function resyncExpiredFeeRates(nowMs = Date.now()): Promise<{
  tenants: number
  updated: number
  failed: number
}> {
  const WINDOW_MS = 3 * 24 * 60 * 60 * 1000
  const from = admin.firestore.Timestamp.fromMillis(nowMs - WINDOW_MS)
  const to = admin.firestore.Timestamp.fromMillis(nowMs)
  const db = admin.firestore()

  const [teams, orgs] = await Promise.all(
    [TEAMS_COLLECTION, ORGANIZATIONS_COLLECTION].map((c) =>
      db
        .collection(c)
        .where('flags.fee_rate.expires_at', '>', from)
        .where('flags.fee_rate.expires_at', '<=', to)
        .get()
    )
  )

  const summary = { tenants: teams.size + orgs.size, updated: 0, failed: 0 }
  const tally = (rs: TeamFeeResync[]) => {
    for (const r of rs) {
      summary.updated += r.updated
      summary.failed += r.failed
    }
  }
  for (const t of teams.docs) tally(await resyncTenantSubscriptionFees('team', t.id))
  for (const o of orgs.docs) tally(await resyncTenantSubscriptionFees('org', o.id))
  return summary
}
