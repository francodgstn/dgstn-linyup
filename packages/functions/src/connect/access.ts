// Shared access-control + persistence helpers for the Connect feature, reused by
// the onboarding callables, the payment callables, the refund flow, and the
// webhook handler.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  CONNECT_ACCOUNTS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  TEAMS_COLLECTION,
  resolveTakeRate,
  type ConnectOnboardingModel,
  type ResolvedTakeRate,
  type SaasPlan,
  type TenantFlags,
} from '@linyup/shared'
import { hasTeamRole } from '../utils/teams'
import { resolveBaseUrl } from '../utils/env'
import type { NormalizedAccountStatus } from '../utils/connect/client'

export async function assertOwner(uid: string, teamId: string): Promise<void> {
  if (!(await hasTeamRole(uid, teamId, 'owner'))) {
    throw new HttpsError('permission-denied', 'Owner access required')
  }
}

/** Managers and owners can take payments; only owners change onboarding. */
export async function assertManager(uid: string, teamId: string): Promise<void> {
  if (!(await hasTeamRole(uid, teamId, 'manager'))) {
    throw new HttpsError('permission-denied', 'Manager access required')
  }
}

export interface EnabledTeam {
  id: string
  plan: SaasPlan
  /**
   * Linyup takes NO platform fee from this studio's member payments.
   *
   * Resolved once, here, by `loadEnabledTeam` — see `resolveFeeWaiver` for where
   * it comes from and why it is read through rather than copied. Every rail that
   * can charge a member reaches Stripe holding one of these objects, so carrying
   * the answer on it is what makes the waiver reach a rail written next year
   * that nobody remembered to tell about comping.
   */
  feeWaived: boolean
  /**
   * The take-rate this studio's member payments are charged at — comped, a
   * negotiated rate (its own or its organisation's) or the plan's published one.
   * Resolved in the same read as `feeWaived`, which is `fee.source === 'comped'`.
   */
  fee: ResolvedTakeRate
  name?: string
  /** ISO 4217, as the studio set it (uppercase). The currency prices are
   *  authored in — asked at signup, editable in Settings → Payments. */
  default_currency?: string
  payments?: {
    connectEnabled?: boolean
    connectAccountId?: string
    connectModel?: ConnectOnboardingModel
    connectStatus?: string
  }
  data: FirebaseFirestore.DocumentData
}

/**
 * The applied rate, as Checkout metadata. The Connect webhook copies it onto the
 * `member_payments` row, so a payment records WHICH rate it was charged at and
 * why — the fee amount alone cannot say whether 0.5 % was a deal or a plan.
 */
export function platformFeeMetadata(team: EnabledTeam): Record<string, string> {
  return {
    platform_fee_bps: String(team.fee.rate.bps),
    platform_fee_source: team.fee.source,
  }
}

/**
 * Loads the team and enforces the Connect kill-switch. Connect is self-serve:
 * owners can set it up by default; an operator can disable a team by setting
 * teams/{teamId}.payments.connectEnabled === false (admin-only, see firestore.rules).
 * Only an explicit `false` blocks — absent/true is allowed.
 */
export async function loadEnabledTeam(teamId: string): Promise<EnabledTeam> {
  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Team not found')
  const data = snap.data()!
  if (data.payments?.connectEnabled === false) {
    throw new HttpsError('failed-precondition', 'Connect payments are disabled for this team')
  }
  const plan = (data.plan as SaasPlan | undefined) ?? 'free'
  const fee = await resolvePlatformFee(data, plan)
  return {
    id: snap.id,
    plan,
    name: data.name as string | undefined,
    default_currency: data.default_currency as string | undefined,
    payments: data.payments,
    feeWaived: fee.source === 'comped',
    fee,
    data,
  }
}

/**
 * Which platform-fee rate applies to this studio — comped, negotiated, or the
 * plan's published rate. The decision is `resolveTakeRate` in @linyup/shared;
 * this only fetches the two flag sets it needs.
 *
 * ── WHY IT IS READ THROUGH TO THE ORGANISATION, NOT COPIED ONTO THE TEAM ─────
 * A comp is normally decided for an ORGANISATION — Linyup's first migrated one
 * is comped in full, org and studios alike — while the fee is charged by each
 * STUDIO, on its own connected account. So the decision and the enforcement sit
 * on different documents and something has to bridge them.
 *
 * Copying the flag onto each team at join time is the cheaper bridge and the
 * wrong one. `acceptOrgInvitation` already copies the org's `plan_status` that
 * way, and a copy is a snapshot: it goes stale the day the comp changes, in
 * whichever direction happens to be wrong, with nothing to notice. It would also
 * need a third and fourth writer (`removeTeamFromOrg` and `lapseOrganization`
 * both have to clear it) and a backfill for the studios that already exist —
 * and a studio that kept a stale `true` after leaving the organisation would be
 * charged nothing, forever, silently.
 *
 * Reading through costs ONE extra document get, only for a team that is actually
 * in an organisation, on a path that is already several reads plus a round-trip
 * to Stripe. It cannot go stale, needs no propagation, no backfill and no second
 * writer, and a studio that joins the organisation next year inherits the comp
 * by construction rather than by somebody remembering.
 *
 * A team's OWN `flags.comped` is honoured too, so a standalone comped studio
 * works without inventing an organisation for it.
 *
 * Both flags are unwritable by any client: `tenantGovernanceUnchanged()` pins
 * `flags` on the team document and (since 2026-08-28) on the organisation
 * document, and `users/{uid}.roles` — which backs the `hasRole('admin')` bypass
 * on the team rule — is pinned in the same change. Without those three the
 * waiver would be self-serve for every studio owner on the platform.
 */
export async function resolvePlatformFee(
  data: FirebaseFirestore.DocumentData,
  plan: SaasPlan
): Promise<ResolvedTakeRate> {
  const nowMs = Date.now()
  const teamFlags = data.flags as TenantFlags | undefined
  // A comp or a rate of the studio's own settles it without the org read.
  if (teamFlags?.comped === true || teamFlags?.fee_rate) {
    const own = resolveTakeRate({ tier: plan, teamFlags, nowMs })
    if (own.source !== 'plan') return own
  }

  const orgId = data.org_id as string | undefined
  if (!orgId) return resolveTakeRate({ tier: plan, teamFlags, nowMs })

  let orgFlags: TenantFlags | undefined
  try {
    const org = await admin.firestore().collection(ORGANIZATIONS_COLLECTION).doc(orgId).get()
    orgFlags = org.data()?.flags as TenantFlags | undefined
  } catch (err) {
    // FAIL TOWARDS THE PUBLISHED RATE. A read that failed is not evidence of a
    // comp or a deal, and the alternative — treating an unavailable organisation
    // document as "bills nothing" — turns a transient Firestore error into free
    // transactions for every studio in every organisation until it clears.
    console.error(`[connect] fee-rate lookup failed for org ${orgId}:`, err)
  }
  return resolveTakeRate({ tier: plan, teamFlags, orgFlags, nowMs })
}

/**
 * Can this studio take an online payment RIGHT NOW?
 *
 * The same question `requireChargeableAccount` asks, as a boolean over the raw
 * `payments` map — for the callers that must BRANCH on the answer rather than
 * refuse on it. It lives here so the two can never drift: `listAvailability`
 * decides what to offer, `bookAppointment` decides which door the offer opens,
 * and a disagreement between them is a visitor shown a price nothing can take.
 */
export function paymentsAreChargeable(payments: EnabledTeam['payments']): boolean {
  return payments?.connectEnabled !== false && payments?.connectStatus === 'enabled'
}

/** Resolve the team's connected account, requiring it be ready to accept charges. */
export function requireChargeableAccount(team: EnabledTeam): {
  accountId: string
  model: ConnectOnboardingModel
} {
  const accountId = team.payments?.connectAccountId
  const model = team.payments?.connectModel ?? 'managed'
  if (!accountId) {
    throw new HttpsError('failed-precondition', 'No payment account — finish onboarding first')
  }
  if (team.payments?.connectStatus !== 'enabled') {
    throw new HttpsError('failed-precondition', 'Payment account setup is not complete')
  }
  return { accountId, model }
}

/** Best-effort owner email for the Stripe account contact / Checkout prefill. */
export async function ownerEmail(uid: string, team: EnabledTeam): Promise<string> {
  const userDoc = await admin.firestore().collection('users').doc(uid).get()
  const email = userDoc.data()?.email as string | undefined
  return email ?? (team.data.contact_email as string | undefined) ?? ''
}

/** Settings → Payments return/refresh targets for the hosted onboarding flow.
 * Prefers the caller's origin (so local dev returns to localhost), else the
 * env-configured hosting URL. */
export function onboardingUrls(
  locale: string,
  origin?: string
): { returnUrl: string; refreshUrl: string } {
  const base = `${resolveBaseUrl(origin)}/${locale}/team/settings`
  return {
    returnUrl: `${base}?tab=payments&connect=return`,
    refreshUrl: `${base}?tab=payments&connect=refresh`,
  }
}

/** Persist a normalized account status to the canonical doc + compact team mirror. */
export async function persistAccountStatus(
  teamId: string,
  accountId: string,
  model: ConnectOnboardingModel,
  status: NormalizedAccountStatus
): Promise<void> {
  const db = admin.firestore()
  const now = FieldValue.serverTimestamp()
  await db
    .collection(CONNECT_ACCOUNTS_COLLECTION)
    .doc(accountId)
    .set(
      {
        teamId,
        stripeAccountId: accountId,
        model,
        status: status.status,
        charges_enabled: status.charges_enabled,
        payouts_enabled: status.payouts_enabled,
        details_submitted: status.details_submitted,
        capabilities: status.capabilities,
        requirements_currently_due: status.requirements_currently_due,
        requirements_disabled_reason: status.requirements_disabled_reason ?? null,
        // `default_currency` is deliberately NOT written here. It is set once,
        // from the team, when the account document is created — and this
        // function runs on every status refresh, so re-writing it meant a
        // hard-coded 'chf' silently overwrote the studio's own currency minutes
        // after onboarding. A status refresh has nothing to say about currency.
        updated_at: now,
      },
      { merge: true }
    )
  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .set(
      {
        payments: {
          connectAccountId: accountId,
          connectModel: model,
          connectStatus: status.status,
        },
        updated_at: now,
      },
      { merge: true }
    )
}
