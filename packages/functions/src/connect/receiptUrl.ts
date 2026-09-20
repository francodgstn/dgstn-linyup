// "Open Stripe receipt" on a payment row — the hosted receipt Stripe already
// keeps for every successful charge, fetched on demand.
//
// ── WHY THIS IS NOT STORED ON THE PAYMENT DOC ───────────────────────────────
// Stamping `receipt_url` in the Connect webhook would save this call, and it
// would rot: "Receipts don't expire, but for security reasons, links to
// receipts expire after 30 days" (docs.stripe.com/receipts). A stored link is
// therefore correct for a month and quietly broken afterwards, which is worse
// than no link — and the rows a studio wants a receipt for are the OLD ones, at
// year end. So the URL is read at the moment it is wanted and never persisted.
//
// The receipt itself is always current: "The receipt is kept up-to-date to the
// latest state of the charge, including any refunds"
// (docs.stripe.com/api/charges/object). A refunded payment's link shows the
// refund, which is exactly what a member asking about one needs to see.
//
// ── WHY THERE IS NO "RESEND RECEIPT" BESIDE IT ──────────────────────────────
// It was asked for and it is not buildable on documented behaviour. Stripe has
// no resend endpoint; the only documented trigger is UPDATING the charge's
// `receipt_email` — "If this field is updated, then a new email receipt will be
// sent to the updated address" (docs.stripe.com/api/charges/update), which says
// nothing about writing the SAME address back, and a resend-to-the-same-person
// is the whole request. Two further facts make it the studio's business rather
// than ours: on a DIRECT charge "Receipts use the connected account's Customer
// emails, Branding, and Public details settings", and automatic receipts go out
// only when that account has Settings > Business > Customer emails > "Successful
// payments" switched on (docs.stripe.com/receipts). The studio owns that
// account and its Dashboard has a "Send receipt" action; we would be guessing at
// an undocumented API to duplicate it.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { MEMBER_PAYMENTS_SUBCOLLECTION, TEAMS_COLLECTION } from '@linyup/shared'
import { getConnectStripe } from '../utils/connect/client'
import { readChargeReceiptUrl } from '../utils/stripe/objectShape'
import { assertManager, loadEnabledTeam, requireChargeableAccount } from './access'

export interface PaymentReceiptUrlRequest {
  teamId: string
  paymentIntentId: string
}

export interface PaymentReceiptUrlResult {
  /** Null when the charge carries none — see the `not_available` reasons. */
  receiptUrl: string | null
  reason: 'ok' | 'no_charge' | 'no_receipt'
}

export const getPaymentReceiptUrl = onCall(
  async (request): Promise<PaymentReceiptUrlResult> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
    const d = (request.data ?? {}) as Partial<PaymentReceiptUrlRequest>
    const teamId = typeof d.teamId === 'string' ? d.teamId.trim() : ''
    const paymentIntentId = typeof d.paymentIntentId === 'string' ? d.paymentIntentId.trim() : ''
    if (!teamId || !paymentIntentId) {
      throw new HttpsError('invalid-argument', 'teamId and paymentIntentId are required')
    }

    await assertManager(request.auth.uid, teamId)
    const team = await loadEnabledTeam(teamId)
    const { accountId } = requireChargeableAccount(team)

    // The payment must belong to THIS team — the same tenant check the refund
    // rail makes, and for the same reason: the id alone would otherwise reach
    // another studio's charge.
    const snap = await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
      .doc(paymentIntentId)
      .get()
    if (!snap.exists) throw new HttpsError('not-found', 'Payment not found for this team')

    // A failed intent never produced a charge, so it has no receipt and never
    // will. That is an answer, not an error.
    const chargeId = (snap.data()?.chargeId as string | undefined) ?? null
    if (!chargeId) return { receiptUrl: null, reason: 'no_charge' }

    // DIRECT CHARGES LIVE ON THE CONNECTED ACCOUNT, so the read carries its id —
    // without `stripeAccount` this is a lookup on the platform, where the charge
    // does not exist.
    const stripe = await getConnectStripe()
    const charge = await stripe.charges.retrieve(chargeId, {}, { stripeAccount: accountId })
    const receiptUrl = readChargeReceiptUrl(charge)
    return receiptUrl
      ? { receiptUrl, reason: 'ok' }
      : { receiptUrl: null, reason: 'no_receipt' }
  }
)
