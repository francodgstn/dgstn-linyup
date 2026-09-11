// Contact-facing payments for the Space portal.
//   • listMyContactPayments        — read-only, SANITIZED payment history (no
//                                     platform-fee/internal fields) + whether a
//                                     Stripe billing portal is available.
//   • createContactBillingPortalSession — mints a Stripe billing-portal session on
//                                     the studio's CONNECTED account so a recurring
//                                     subscriber can update their card / view
//                                     invoices / manage their subscription.
//
// Auth is the passwordless CONTACT SESSION — the custom-token claims
// { contactId, teamId, sessionExpires } minted by buildContactSession (the same
// mechanism requestContactUpdate trusts). Never a team-member role: these run for
// the member themselves, scoped to their own contactId.
import * as admin from 'firebase-admin'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import {
  TEAMS_COLLECTION,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  localizedPublicSubUrl,
  publicLocalePrefix,
} from '@linyup/shared'
import { getConnectStripe } from '../utils/connect/client'
import { loadEnabledTeam, requireChargeableAccount } from '../connect/access'
import { resolveBaseUrl } from '../utils/env'

// Validate the contact session and return its identity. Throws on a missing or
// expired session (7-day window minted server-side).
function requireContactSession(request: CallableRequest<unknown>): {
  contactId: string
  teamId: string
} {
  const contactId = request.auth?.token?.contactId as string | undefined
  const teamId = request.auth?.token?.teamId as string | undefined
  const sessionExpires = request.auth?.token?.sessionExpires as number | undefined
  if (!contactId || !teamId) {
    throw new HttpsError('unauthenticated', 'A contact session is required')
  }
  if (typeof sessionExpires === 'number' && sessionExpires < Date.now()) {
    throw new HttpsError('deadline-exceeded', 'Your session has expired. Please sign in again.')
  }
  return { contactId, teamId }
}

// Buyer-appropriate projection of a member_payments record. Deliberately DROPS
// application_fee_amount, chargeId, paymentIntentId, last_event_id — studio/Linyup
// internals the member must not see.
interface ContactPayment {
  id: string
  kind: string // membership | product | course | drop_in | payment
  label: string
  amount: number // minor units (Rappen)
  currency: string
  status: string // succeeded | failed | …
  refundedAmount: number // minor units
  createdAt: number | null // epoch ms
  /** The promo code the buyer used, when this sale carried one. Buyer-appropriate
   *  by construction — it is their own code, and the field discloses nothing
   *  internal (no fee, no ids). Read off the stamped line item, the payment row's
   *  only record of a discount. */
  promoCode: string | null
}

function tsToMillis(v: unknown): number | null {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return (v as { toMillis(): number }).toMillis()
  }
  return typeof v === 'number' ? v : null
}

function paymentLabel(d: FirebaseFirestore.DocumentData): string {
  if (d.kind === 'product') return (d.productName as string) || 'Product'
  if (d.kind === 'course') return (d.courseName as string) || 'Course'
  if (d.kind === 'drop_in') return 'Drop-in'
  if (d.subscriptionTypeName) return d.subscriptionTypeName as string
  return (d.purpose as string) || 'Payment'
}

/** How much of a contact's payment history the Space shows — the newest rows. */
export const SPACE_PAYMENTS_PAGE = 100

/** The contact's own payment history + billing-portal availability. */
export const listMyContactPayments = onCall(async (request) => {
  const { contactId, teamId } = requireContactSession(request)
  const db = admin.firestore()

  // Newest first, capped at the page the Space renders. This used to read EVERY
  // payment of the contact and slice in memory to avoid a composite index; a
  // member with a weekly drop-in habit was then a few hundred reads for a
  // hundred-row answer, growing with every year they stay
  // (docs/scalability-2026-09.md §17 B6). The (`contactId`, `created_at`)
  // index is declared in firestore.index.json — and because the emulator does
  // not enforce indexes, a deployment that drops it fails HERE, on a real
  // project, not in any test.
  const paySnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
    .where('contactId', '==', contactId)
    .orderBy('created_at', 'desc')
    .limit(SPACE_PAYMENTS_PAGE)
    .get()

  const payments: ContactPayment[] = paySnap.docs
    .map((doc) => {
      const d = doc.data()
      return {
        id: doc.id,
        kind: (d.kind as string) || 'payment',
        label: paymentLabel(d),
        amount: typeof d.amount === 'number' ? d.amount : 0,
        currency: (d.currency as string) || 'chf',
        status: (d.status as string) || 'succeeded',
        refundedAmount: typeof d.amount_refunded === 'number' ? d.amount_refunded : 0,
        createdAt: tsToMillis(d.created_at),
        promoCode: (d.line_item as { promoCode?: string } | undefined)?.promoCode ?? null,
      }
    })

  // Billing portal is offered only to contacts with a Connect Stripe customer —
  // i.e. a recurring subscription. Cash / BYO / one-off payers have none, so the
  // button stays hidden (matches "hide if paid other ways").
  const subSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .where('contactId', '==', contactId)
    .get()
  const billingAvailable = subSnap.docs.some((d) => typeof d.data().customerId === 'string' && d.data().customerId)

  return { payments, billingAvailable }
})

/** Deep link to Stripe's hosted billing portal for the signed-in contact. */
export const createContactBillingPortalSession = onCall(async (request) => {
  const { contactId, teamId } = requireContactSession(request)
  const data = (request.data ?? {}) as { slug?: string; locale?: string; origin?: string }
  const db = admin.firestore()

  // Resolve the contact's Stripe customer (on the connected account) from any of
  // their member_subscriptions — prefer a live one, else any that carries a customer.
  const subSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .where('contactId', '==', contactId)
    .get()
  const withCustomer = subSnap.docs
    .map((d) => d.data())
    .filter((d) => typeof d.customerId === 'string' && d.customerId)
  if (withCustomer.length === 0) {
    throw new HttpsError('failed-precondition', 'No billing account found for this contact')
  }
  const LIVE = new Set(['active', 'trialing', 'past_due'])
  const chosen = withCustomer.find((d) => LIVE.has(d.status as string)) ?? withCustomer[0]
  const customerId = chosen.customerId as string

  // The connected account must be present + enabled to open its portal.
  const team = await loadEnabledTeam(teamId)
  const { accountId } = requireChargeableAccount(team)

  // `localePrefix: 'as-needed'` — the default locale carries NO prefix, so
  // hand-concatenating one produced `/en/public/…` and a 302 on the way back
  // from Stripe. `localizedPublicSubUrl` owns that rule.
  const locale = data.locale ?? 'en'
  const base = resolveBaseUrl(data.origin)
  const returnUrl = data.slug
    ? localizedPublicSubUrl(base, locale, data.slug, 'space', 'payments')
    : `${base}${publicLocalePrefix(locale)}`

  const stripe = await getConnectStripe()
  try {
    const session = await stripe.billingPortal.sessions.create(
      { customer: customerId, return_url: returnUrl },
      { stripeAccount: accountId }
    )
    return { url: session.url }
  } catch (err) {
    // Most commonly: the connected account has no billing-portal configuration yet.
    console.error('[space] createContactBillingPortalSession failed:', err) // eslint-disable-line no-console
    throw new HttpsError('failed-precondition', 'Billing management is not available right now')
  }
})
