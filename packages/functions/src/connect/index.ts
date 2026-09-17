/* eslint-disable no-console */
// Stripe Connect — onboarding callables (member → studio payments).
//
// Onboarding creates ONE kind of connected account — see the note on
// MODEL_DASHBOARD in utils/connect/client.ts for what it is and why there is only
// one. The whole feature is feature-flagged per team (teams/{teamId}.payments.connectEnabled)
// so it can ship dark and be enabled per studio. Money settles on the studio's
// Stripe balance; Linyup never holds member funds.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONNECT_ACCOUNTS_COLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type ConnectOnboardingModel,
} from '@linyup/shared'
import {
  createAccountLink,
  createConnectedAccount,
  retrieveAccountStatus,
  type NormalizedAccountStatus,
} from '../utils/connect/client'
import {
  assertOwner,
  loadEnabledTeam,
  onboardingUrls,
  ownerEmail,
  persistAccountStatus,
} from './access'

const VALID_MODELS: ConnectOnboardingModel[] = ['byo', 'managed']

// ─────────────────────────────────────────────────────────────────────────────
// startConnectOnboarding — create the connected account (once) and return a
// hosted onboarding link. Idempotent: reuses the team's existing account.
// ─────────────────────────────────────────────────────────────────────────────
export const startConnectOnboarding = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    model?: string
    country?: string
    entityType?: 'company' | 'individual'
    locale?: string
    origin?: string
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const teamId = data.teamId
  const locale = data.locale ?? 'en'

  await assertOwner(request.auth.uid, teamId)
  const team = await loadEnabledTeam(teamId)

  // Reuse an existing connected account if one is already linked; the model is
  // fixed at creation, so we keep the stored model and ignore a changed param.
  let accountId = team.payments?.connectAccountId
  let model: ConnectOnboardingModel = team.payments?.connectModel ?? 'managed'

  if (!accountId) {
    // The onboarding model is historical and branches no behaviour — see the note
    // on ConnectOnboardingModel in @linyup/shared. The UI no longer sends one, so
    // absent means 'managed'; a value that IS sent is still validated, so an older
    // client cannot persist a junk string onto the account document.
    if (data.model !== undefined && !VALID_MODELS.includes(data.model as ConnectOnboardingModel)) {
      throw new HttpsError('invalid-argument', `model must be one of: ${VALID_MODELS.join(', ')}`)
    }
    model = (data.model as ConnectOnboardingModel | undefined) ?? 'managed'
    const email = await ownerEmail(request.auth.uid, team)

    try {
      const created = await createConnectedAccount({
        model,
        teamId,
        email,
        country: data.country,
        entityType: data.entityType,
        displayName: team.name ?? email,
        idempotencyKey: `connect-acct:${teamId}`,
      })
      accountId = created.accountId
    } catch (err) {
      console.error('[connect] createConnectedAccount failed:', err)
      throw new HttpsError('internal', 'Failed to create the payment account')
    }

    const now = FieldValue.serverTimestamp()
    await admin
      .firestore()
      .collection(CONNECT_ACCOUNTS_COLLECTION)
      .doc(accountId)
      .set(
        {
          teamId,
          stripeAccountId: accountId,
          model,
          status: 'pending',
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          capabilities: {},
          requirements_currently_due: [],
          requirements_disabled_reason: null,
          // The STUDIO's currency, not a constant. This was hard-coded 'chf',
          // so every account opened outside Switzerland was recorded against
          // the wrong one from the moment it was created — and the signup
          // wizard now asks for the currency precisely so there is a real
          // answer here. Stripe still decides what the account can settle in;
          // this is our record of what the studio prices in.
          default_currency: (team.default_currency ?? 'chf').toLowerCase(),
          created_at: now,
          updated_at: now,
        },
        { merge: true }
      )
    await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .set(
        { payments: { connectAccountId: accountId, connectModel: model, connectStatus: 'pending' } },
        { merge: true }
      )
  }

  const { returnUrl, refreshUrl } = onboardingUrls(locale, data.origin)
  let url: string
  try {
    ;({ url } = await createAccountLink({ accountId, refreshUrl, returnUrl }))
  } catch (err) {
    console.error('[connect] createAccountLink failed:', err)
    throw new HttpsError('internal', 'Failed to start onboarding')
  }

  return { accountId, model, url }
})

// ─────────────────────────────────────────────────────────────────────────────
// getConnectStatus — refresh the account status from Stripe, persist, return it.
// Used by the dashboard "finish setup" path and after onboarding return.
// ─────────────────────────────────────────────────────────────────────────────
export const getConnectStatus = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const teamId = data.teamId

  await assertOwner(request.auth.uid, teamId)
  const team = await loadEnabledTeam(teamId)

  const accountId = team.payments?.connectAccountId
  const model: ConnectOnboardingModel = team.payments?.connectModel ?? 'managed'

  // THE STUDIO IS TOLD WHAT IT ACTUALLY PAYS. Settings → Payments renders the
  // take-rate from the CLIENT's plan, which for a comped studio names a fee the
  // platform does not charge — the studio then reconciles its Stripe payouts
  // against a rate that was never taken. The waiver is server state (it can come
  // from the studio's organisation), so the answer travels with the status
  // rather than being recomputed in the browser: one resolver, not two.
  // The same holds for a NEGOTIATED rate, which the browser cannot know at all.
  const feeWaived = team.feeWaived
  const fee = {
    feeWaived,
    feePercent: team.fee.rate.bps / 100,
    feeSource: team.fee.source,
    feeExpiresAtMs: team.fee.expiresAtMs,
  }
  if (!accountId) return { connected: false as const, ...fee }

  let status: NormalizedAccountStatus
  try {
    status = await retrieveAccountStatus(accountId)
  } catch (err) {
    console.error('[connect] retrieveAccountStatus failed:', err)
    throw new HttpsError('internal', 'Failed to fetch payment account status')
  }

  await persistAccountStatus(teamId, accountId, model, status)

  return {
    connected: true as const,
    ...fee,
    accountId,
    model,
    status: status.status,
    charges_enabled: status.charges_enabled,
    payouts_enabled: status.payouts_enabled,
    details_submitted: status.details_submitted,
    capabilities: status.capabilities,
    requirements_currently_due: status.requirements_currently_due,
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// disconnectConnectAccount — UNLINK the studio's Stripe account from this team.
//
// WHY THIS HAS TO EXIST. `startConnectOnboarding` is idempotent by reusing the
// stored `connectAccountId` forever — "the model is fixed at creation" — so a
// studio that began onboarding under the wrong Stripe login had no way out at
// all: every subsequent "Start setup" walked them back into the same account,
// and nothing in the app could point at a different one. Found on the prod
// canary of 2026-08-23.
//
// WHAT IT IS NOT. It does not delete, close or touch the Stripe account itself —
// that account belongs to the studio, holds their money and their history, and
// is theirs to keep or close in Stripe. This severs the LINK: Linyup stops
// routing charges to it and stops claiming the team can take money.
//
// WHY THE `connect_accounts` DOC SURVIVES, teamId and all. That collection is
// the ONLY account → team map the Connect webhook has. Deleting the doc (or
// nulling its teamId) would strand every late event for charges the account has
// already taken — a refund, a dispute, a renewal — with nowhere to write them.
// So it is marked detached and left readable, and a new onboarding simply
// creates a second doc. One account still belongs to exactly one team; a team
// may have several accounts over its life, one of which is current.
//
// THE ONE REFUSAL. A live subscription on the account would go on charging a
// member every month into an account this product no longer watches — nobody
// would see the money and nobody would see it stop. Those are cancelled first,
// from the contact page, which is where the control is.
export const disconnectConnectAccount = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const teamId = data.teamId

  await assertOwner(request.auth.uid, teamId)
  const team = await loadEnabledTeam(teamId)

  const accountId = team.payments?.connectAccountId
  if (!accountId) return { ok: true as const, disconnected: false as const }

  const db = admin.firestore()

  // Live = anything Stripe can still charge for, PAUSED INCLUDED: a frozen
  // subscription is one `resume` away from billing again, and after this call
  // there would be no screen in Linyup showing it exists.
  const liveSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .where('status', 'in', ['active', 'trialing', 'past_due', 'paused'])
    .get()
  const live = liveSnap.docs.filter((d) => d.data().duplicate !== true)
  if (live.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      'Cancel the remaining member subscriptions before disconnecting',
      { reason: 'live_subscriptions', count: live.length }
    )
  }

  const now = FieldValue.serverTimestamp()
  await db
    .collection(CONNECT_ACCOUNTS_COLLECTION)
    .doc(accountId)
    .set({ status: 'detached', detached_at: now, updated_at: now }, { merge: true })

  // Deleting the keys rather than nulling them: `startConnectOnboarding` tests
  // `if (!accountId)`, and `payments_enabled` on the public profile fails closed
  // on anything that is not an enabled account — so an absent key is the state
  // both readers already handle correctly.
  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .update({
      'payments.connectAccountId': FieldValue.delete(),
      'payments.connectModel': FieldValue.delete(),
      'payments.connectStatus': FieldValue.delete(),
    })

  console.log(`[connect] account ${accountId} detached from team ${teamId}`)
  return { ok: true as const, disconnected: true as const, accountId }
})
