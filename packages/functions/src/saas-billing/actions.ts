/* eslint-disable no-console */
/**
 * The four Linyup-billing ACTIONS — cancel, reactivate, billing portal, invoices
 * — with NO authorization in them.
 *
 * WHY THEY LIVE HERE (UX-75). A `saas_subscriptions/{id}` document is billed to
 * either a team or an organization: `entity_type: 'team' | 'org'`, and the doc id
 * is that entity's id. The four callables in `./index.ts` were written when only
 * teams paid, so each took `data.teamId` and guarded with `assertOwner` →
 * `hasTeamRole` → `teams/{teamId}/team_members/{uid}`. An ORG id put through that
 * guard reads a team-members subcollection under an organization id, finds
 * nothing, and refuses `permission-denied` — so an org admin could not cancel her
 * own organization's subscription, reactivate it, or open the portal to fix an
 * expiring card, while the charges kept coming.
 *
 * The fix is two authorization models, one implementation. The org rail gets its
 * own callables (`../orgs/billing.ts`, guarded by `assertOrgAdmin` against
 * `organizations/{orgId}/org_members/{uid}`), the team rail keeps its own, and
 * the Stripe work below is shared so the two can never drift on what "cancel"
 * does.
 *
 * THE PARAMETER IS `entityId`, NEVER `teamId`. Calling it `teamId` in a place
 * that may hold an org id is precisely how this bug stayed invisible; `entityId`
 * is the word the webhook router already uses for the same union (`./index.ts`,
 * `event.teamId ?? event.orgId`). Nothing here decides WHO may act on it — the
 * guard that precedes the call is what binds an id to its rail.
 */
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { readGatewayData } from '@linyup/shared'
import { getSecret } from '../utils/secrets'
import { StripeAdapter } from '../utils/gateway/stripe'

/**
 * A StripeAdapter on Linyup's PLATFORM Stripe secret key. SaaS billing always
 * uses Linyup's own account — never a tenant's payment-gateway integration,
 * which exists for a studio charging its own members.
 */
export async function getPlatformStripeAdapter(): Promise<StripeAdapter> {
  const secretKey = await getSecret('stripe-secret-key')
  return StripeAdapter.withSecretKey(
    { type: 'stripe', publishable_key: '', currency: 'chf' },
    secretKey,
  )
}

/** The subscription document, or the refusal the UI knows how to explain. */
async function loadSubscription(entityId: string, missing: string) {
  const snap = await admin.firestore().collection('saas_subscriptions').doc(entityId).get()
  if (!snap.exists) throw new HttpsError('not-found', missing)
  return snap
}

/** Marks the subscription to stop at the end of the paid period. */
export async function cancelSubscriptionFor(entityId: string): Promise<void> {
  const subDoc = await loadSubscription(entityId, 'No active subscription found')

  const subscriptionId = readGatewayData(subDoc.data()).subscription_id
  if (!subscriptionId)
    throw new HttpsError('failed-precondition', 'Subscription ID not found — contact support')

  const adapter = await getPlatformStripeAdapter()
  try {
    await adapter.cancelSubscription({ subscriptionId })
  } catch (err) {
    console.error('cancelSubscription failed:', err)
    throw new HttpsError('internal', 'Failed to cancel subscription')
  }

  // The webhook writes the authoritative record when Stripe fires the event.
  // Set the flag optimistically so the badge moves before it arrives.
  await admin.firestore().collection('saas_subscriptions').doc(entityId).update({
    cancel_at_period_end: true,
    updated_at: FieldValue.serverTimestamp(),
  })
}

/** Undoes a pending cancellation, erasing the whole record it left behind. */
export async function reactivateSubscriptionFor(entityId: string): Promise<void> {
  const subDoc = await loadSubscription(entityId, 'No subscription found')

  const subscriptionId = readGatewayData(subDoc.data()).subscription_id
  if (!subscriptionId)
    throw new HttpsError('failed-precondition', 'Subscription ID not found — contact support')

  const adapter = await getPlatformStripeAdapter()
  try {
    await adapter.reactivateSubscription({ subscriptionId })
  } catch (err) {
    console.error('reactivateSubscription failed:', err)
    throw new HttpsError('internal', 'Failed to reactivate subscription')
  }

  await admin.firestore().collection('saas_subscriptions').doc(entityId).update({
    cancel_at_period_end: false,
    // Clear the whole record, not just the boolean. Reactivating after a
    // BILLING-PORTAL cancel is the case where the DATE, not the boolean, was
    // carrying the state — and a reason left behind would outlive the
    // cancellation it describes.
    cancel_at: null,
    canceled_at: null,
    cancellation_details: null,
    updated_at: FieldValue.serverTimestamp(),
  })
}

/** A Stripe billing-portal session (change card, see receipts, cancel). */
export async function billingPortalUrlFor(entityId: string, returnUrl: string): Promise<string> {
  const subDoc = await loadSubscription(entityId, 'No subscription found')

  const customerId = readGatewayData(subDoc.data()).customer_id
  if (!customerId)
    throw new HttpsError('failed-precondition', 'No Stripe customer found — contact support')

  const adapter = await getPlatformStripeAdapter()

  let session: { url: string }
  try {
    session = await adapter.createBillingPortalSession({ customerId, returnUrl })
  } catch (err) {
    console.error('createBillingPortalSession failed:', err)
    throw new HttpsError('internal', 'Failed to open billing portal')
  }

  if (!session.url.startsWith('https://billing.stripe.com/')) {
    throw new HttpsError('internal', 'Unexpected billing portal URL')
  }
  return session.url
}

/**
 * Invoices, live from Stripe (never stored in Firestore). An entity that has
 * never paid has none rather than an error — "no invoices yet" is the honest
 * answer for a trial, and it is not a refusal.
 */
export async function invoicesFor(entityId: string, limit: number): Promise<{ invoices: unknown[] }> {
  const subDoc = await admin.firestore().collection('saas_subscriptions').doc(entityId).get()
  if (!subDoc.exists) return { invoices: [] }

  const customerId = readGatewayData(subDoc.data()).customer_id
  if (!customerId) return { invoices: [] }

  const adapter = await getPlatformStripeAdapter()
  try {
    const invoices = await adapter.fetchInvoices({ customerId, limit })
    return { invoices }
  } catch (err) {
    console.error('fetchInvoices failed:', err)
    throw new HttpsError('internal', 'Failed to fetch invoices')
  }
}
