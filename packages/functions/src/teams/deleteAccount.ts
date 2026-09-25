/* eslint-disable no-console */
// SELF-SERVICE STUDIO DELETION — the studio side of what contacts have had
// since `contacts/selfDeletion.ts`, and the thing a GDPR request has to be
// answerable with.
//
// Until this existed, `purgeTeam` was reachable only from a shell script an
// operator runs by hand: a studio asking to be deleted had to email somebody.
//
// ── THE SHAPE, AND WHY THIS SHAPE (Franco, 2026-08-23) ─────────────────────
// FORCE-STOP, THEN A 30-DAY WINDOW.
//
//   1. The request cancels every live subscription on the connected account
//      IMMEDIATELY, before anything is stamped. Money is the part that cannot
//      wait thirty days: a member charged monthly for a studio that is winding
//      down is a refund conversation and, in a payment-processing sense, a
//      claim nobody is watching.
//   2. Then the team is stamped and the clock starts. Everything keeps working:
//      the studio can still export, still change their mind, still finish the
//      term they owe their members.
//   3. `purgeScheduledTeams` erases it when the window passes, through
//      `purgeTeam` — the ONE implementation, whose collection list is driven by
//      TENANT_DATA_COLLECTIONS, so nothing here has a copy to go stale.
//
// The two alternatives were considered and rejected. "Refuse until the money is
// settled" leaves a studio that abandons mid-way permanently unable to leave —
// the opposite of what a deletion right is for. "Delete immediately" makes an
// irreversible action out of a click, on the one screen where a mistake cannot
// be walked back.
//
// ── WHAT IS NOT DELETED, AND WHY THE COPY SAYS SO ──────────────────────────
// The studio's Stripe account, and the payment records inside it. It is theirs,
// it holds their money, and it is the other side of transactions with real
// people — Linyup could not delete it if it wanted to. The Connect LINK is
// severed; the account is not touched.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONNECT_ACCOUNTS_COLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
  LIVE_SUBSCRIPTION_STATUSES,
} from '@linyup/shared'
import { getConnectStripe } from '../utils/connect/client'

/** How long a studio has to change its mind. Same window as the contact-side
 *  self-deletion, deliberately: two different grace periods on one platform is
 *  a support answer nobody can give from memory. */
export const TEAM_DELETION_GRACE_DAYS = 30

/** Anything Stripe can still charge for. Paused included — a frozen
 *  subscription is one resume away from billing a studio that no longer exists. */

async function assertTeamOwner(uid: string, teamId: string): Promise<void> {
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TEAM_MEMBERS_SUBCOLLECTION)
    .doc(uid)
    .get()
  if (!snap.exists || snap.data()?.role !== 'owner') {
    throw new HttpsError('permission-denied', 'Only the owner can delete this account')
  }
}

/**
 * Stop every live subscription on the team's connected account.
 *
 * Returns how many it stopped. THROWS if any of them refused: a partial stop is
 * the one outcome worth interrupting the request for, because the member whose
 * subscription survived would go on being charged by a studio that believes it
 * has closed. The owner retries, or cancels that one in Stripe — either way
 * they find out now rather than next month.
 */
async function stopAllBilling(teamId: string, accountId: string): Promise<number> {
  const db = admin.firestore()
  const snap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .where('status', 'in', [...LIVE_SUBSCRIPTION_STATUSES])
    .get()

  const live = snap.docs.filter((d) => d.data().duplicate !== true && !!d.data().subscriptionId)
  if (live.length === 0) return 0

  const stripe = await getConnectStripe()
  const failed: string[] = []
  for (const doc of live) {
    const subscriptionId = doc.data().subscriptionId as string
    try {
      await stripe.subscriptions.cancel(subscriptionId, undefined, { stripeAccount: accountId })
      // Mirror immediately so the rollup recomputes and the member's own Space
      // stops claiming a membership within seconds rather than after the webhook.
      await doc.ref.set(
        { status: 'canceled', updated_at: FieldValue.serverTimestamp() },
        { merge: true }
      )
    } catch (err) {
      console.error(`[teamDeletion] cancel ${subscriptionId} failed:`, err)
      failed.push(subscriptionId)
    }
  }

  if (failed.length > 0) {
    throw new HttpsError(
      'internal',
      `Could not stop ${failed.length} of ${live.length} subscriptions. Nothing has been scheduled for deletion — try again, or cancel them in Stripe first.`,
      { reason: 'billing_stop_failed', failed: failed.length, total: live.length }
    )
  }
  return live.length
}

// ─────────────────────────────────────────────────────────────────────────────
// requestTeamDeletion — stop the money, start the clock.
// ─────────────────────────────────────────────────────────────────────────────
export const requestTeamDeletion = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const { teamId, confirm } = (request.data ?? {}) as { teamId?: string; confirm?: string }
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  await assertTeamOwner(request.auth.uid, teamId)

  const db = admin.firestore()
  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)
  const teamSnap = await teamRef.get()
  if (!teamSnap.exists) throw new HttpsError('not-found', 'Team not found')
  const team = teamSnap.data()!

  // The typed confirmation is the studio's own NAME, checked here and not only
  // in the dialog: this is the one callable in the product whose success is
  // measured in deleted data, and a client that can be called directly should
  // not be able to trigger it with an empty body.
  const expected = ((team.name as string | undefined) ?? '').trim()
  if (!confirm || confirm.trim() !== expected) {
    throw new HttpsError('invalid-argument', 'Type the studio name exactly to confirm')
  }

  if (team.deletion_scheduled_for) {
    // Already scheduled — idempotent, and returning the existing date is more
    // useful than refusing.
    return {
      ok: true as const,
      scheduledFor: (team.deletion_scheduled_for as Timestamp).toMillis(),
      subscriptionsStopped: 0,
    }
  }

  const accountId = team.payments?.connectAccountId as string | undefined
  const subscriptionsStopped = accountId ? await stopAllBilling(teamId, accountId) : 0

  const scheduledFor = Timestamp.fromMillis(
    Date.now() + TEAM_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000
  )
  await teamRef.update({
    deletion_requested_at: FieldValue.serverTimestamp(),
    deletion_requested_by: request.auth.uid,
    deletion_scheduled_for: scheduledFor,
  })

  console.log(
    `[teamDeletion] team ${teamId} scheduled for ${scheduledFor.toDate().toISOString()} (${subscriptionsStopped} subscription(s) stopped)`
  )
  return { ok: true as const, scheduledFor: scheduledFor.toMillis(), subscriptionsStopped }
})

// ─────────────────────────────────────────────────────────────────────────────
// cancelTeamDeletion — change of mind, any time inside the window.
//
// It does NOT restart the billing it stopped. Those subscriptions are canceled
// in Stripe and a canceled subscription cannot be un-canceled; the members
// have to be sold a membership again. Saying so is the copy's job — quietly
// leaving the studio to discover it would be worse than refusing outright.
// ─────────────────────────────────────────────────────────────────────────────
export const cancelTeamDeletion = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const { teamId } = (request.data ?? {}) as { teamId?: string }
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  await assertTeamOwner(request.auth.uid, teamId)

  await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .update({
      deletion_requested_at: FieldValue.delete(),
      deletion_requested_by: FieldValue.delete(),
      deletion_scheduled_for: FieldValue.delete(),
    })

  console.log(`[teamDeletion] team ${teamId} deletion canceled`)
  return { ok: true as const }
})

/** Sever the Connect link on a team being erased. The Stripe ACCOUNT is left
 *  alone — it is the studio's — but the `connect_accounts` doc keeps its teamId
 *  so a late webhook for a charge the account already took still resolves. */
export async function detachConnectAccount(teamId: string, accountId: string): Promise<void> {
  await admin
    .firestore()
    .collection(CONNECT_ACCOUNTS_COLLECTION)
    .doc(accountId)
    .set(
      {
        status: 'detached',
        detached_at: FieldValue.serverTimestamp(),
        detached_reason: 'team_deleted',
      },
      { merge: true }
    )
    .catch((err) => console.error(`[teamDeletion] detach ${accountId}:`, err))
}
