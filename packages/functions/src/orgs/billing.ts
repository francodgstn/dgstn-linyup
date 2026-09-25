/**
 * An ORGANIZATION's own Linyup billing — cancel, reactivate, billing portal,
 * invoices (UX-75).
 *
 * WHY THESE EXIST AT ALL. An organization and a team are both billed through
 * `saas_subscriptions/{id}`, but they are authorized through completely
 * different documents: a team's owner lives at `teams/{teamId}/team_members/{uid}`,
 * an org's admin at `organizations/{orgId}/org_members/{uid}`. The four team
 * callables in `../saas-billing/index.ts` guard with the first of those, so an
 * org admin calling them was refused `permission-denied` — she could not stop
 * her organization's subscription, restart it, or fix an expiring card, and the
 * charges continued. It stayed invisible because the org billing page rendered
 * every outcome through one banner styled green, so the refusal read as success.
 *
 * The choice was to widen the team guard or to give the org its own rail. This
 * is the second, and the reason is that `createOrgCheckoutSession` (next door in
 * `./index.ts`) already existed: org checkout ALREADY needed different arguments
 * and a different guard, so the asymmetry was evidence that org billing was
 * always going to be its own surface, not that one callable should learn two
 * authorization models. What is shared is the part worth sharing — the Stripe
 * work in `../saas-billing/actions.ts` — so "cancel" cannot come to mean two
 * different things.
 *
 * The wire parameter is `orgId` and it holds an org id. The team callables keep
 * `teamId` and it holds a team id. No parameter anywhere on this rail is named
 * for one entity while carrying the other; that naming is how the bug hid.
 */
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getHostingUrl } from '../utils/env'
import { assertOrgAdmin } from './index'
import {
  cancelSubscriptionFor,
  reactivateSubscriptionFor,
  billingPortalUrlFor,
  invoicesFor,
} from '../saas-billing/actions'

/** Auth + org-admin, the two lines every callable here opens with. */
async function requireOrgAdmin(
  auth: { uid: string } | undefined,
  orgId: string | undefined,
): Promise<string> {
  if (!auth) throw new HttpsError('unauthenticated', 'Authentication required')
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId is required')
  await assertOrgAdmin(auth.uid, orgId)
  return orgId
}

/** Marks the organization's subscription to stop at the end of the paid period. */
export const cancelOrgSubscription = onCall(async (request) => {
  const data = request.data as { orgId?: string }
  const orgId = await requireOrgAdmin(request.auth, data?.orgId)

  await cancelSubscriptionFor(orgId)
  return { success: true }
})

/** Undoes a pending cancellation before the period ends. */
export const reactivateOrgSubscription = onCall(async (request) => {
  const data = request.data as { orgId?: string }
  const orgId = await requireOrgAdmin(request.auth, data?.orgId)

  await reactivateSubscriptionFor(orgId)
  return { success: true }
})

/** Stripe billing portal — the only way to change the card that is being charged. */
export const getOrgBillingPortalUrl = onCall(async (request) => {
  const data = request.data as { orgId?: string; returnUrl?: string }
  const orgId = await requireOrgAdmin(request.auth, data?.orgId)

  const returnUrl = data.returnUrl ?? `${getHostingUrl()}/org/${orgId}/billing`
  return { url: await billingPortalUrlFor(orgId, returnUrl) }
})

/**
 * The organization's invoices. Included because the org billing page called
 * `getSaasInvoices` with an org id and was refused by the same guard — and a
 * refused list renders as "No invoices yet", which is a lie an org admin has no
 * way to see through.
 */
export const getOrgInvoices = onCall(async (request) => {
  const data = request.data as { orgId?: string; limit?: number }
  const orgId = await requireOrgAdmin(request.auth, data?.orgId)

  return invoicesFor(orgId, data.limit ?? 10)
})
