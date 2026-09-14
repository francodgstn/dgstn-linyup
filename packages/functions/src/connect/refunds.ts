/* eslint-disable no-console */
// Stripe Connect — refund a member payment, reversing the platform fee.
//
// The actual fee reversal (refund_application_fee) happens in the client; the
// resulting state (amount_refunded, status) is reconciled onto the member_payments
// doc by the charge.refunded webhook. This callable only authorizes + initiates.
//
// GIFT CARDS. A charge can touch stored value in two opposite ways, and both
// have to be handled here or a refund destroys or duplicates it:
//   • the payment was FUNDED by a card (gift_card_redeemed, stamped by
//     commitGiftCardDrawdown) → giving the cash back must give the drawdown
//     back too, or the customer pays for the booking with value they never get
//     to use again;
//   • the payment BOUGHT a card (giftCardCode, stamped by handleGiftCardCheckout)
//     → giving the cash back must kill the card, or the buyer keeps live stored
//     value they were refunded for.
// A purchase paid ENTIRELY by gift card has no payment intent and therefore no
// member_payments doc at all (see the full-cover branches in connect/payments.ts
// and booking/dropIn.ts), so it cannot be refunded here — the manager path is to
// void or adjust the card and cancel the booking/entitlement. That is a Phase-2
// callable (restoreGiftCardValue), not a silent gap: this one answers not-found.
//
// ACCESS. Giving the money back also gives back what the money bought — the
// membership snapshot, the unused credits, the course entitlement. That is
// `reversePaymentEffects` (payments/reversal.ts), which owns the rules; this
// file owns only the ORDERING, and the ordering is the part that can lose money:
//
//   1. Both reversal REFUSALS are decided FIRST — before the gift-card void and
//      before Stripe. A refusal after the void would leave a card dead with no
//      compensating un-void (only the Stripe call is wrapped in that recovery).
//   2. The gift-card void, then the Stripe refund (unchanged).
//   3. The reversal, AFTER the money has moved — and therefore inside a catch
//      that never rethrows. Throwing here would tell the manager the refund
//      failed when it did not, and invite her to do it again.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  mapCategory,
  type GiftCardStatus,
  type MemberPaymentEffectsReversal,
  type PaymentLineItem,
  type SubscriptionType,
} from '@linyup/shared'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { refundDirectCharge } from '../utils/connect/client'
import { assertManager, loadEnabledTeam, requireChargeableAccount } from './access'
import { reverseGiftCardDrawdown, unvoidGiftCard, voidUntouchedGiftCard } from './giftCards'
import {
  lineItemForReversal,
  reversalPlanFor,
  reversePaymentEffects,
  type DivisibleGrant,
  type ReversalActions,
} from '../payments/reversal'

/**
 * Is the thing this payment granted DIVISIBLE — i.e. is it a lesson-credit pack,
 * and how much of it has been taken?
 *
 * DELIBERATELY NOT GATED ON `contactId`. Whether a refund may be partial is a
 * property of WHAT WAS SOLD, not of whether a manager has got round to assigning
 * the row: making legality hinge on assignment means the same course sale is
 * half-refundable on Tuesday and not on Wednesday. So the price lookup runs
 * whether or not there is a contact, and it is the REVERSAL that no-ops when
 * there is nobody to revoke from.
 *
 * The grant document is the source of truth when a contact is known, and it is
 * reached BY DOC ID (contacts/{contactId}/credit_grants/{paymentRef}) — never by
 * a field query, because the provenance field name differed by rail.
 * `credits_used` / `credits_total` on that doc is what both spenders re-read
 * inside their own transactions; `Contact.credit_summary` is a rollup the
 * booking gate reads optimistically and must NOT be read here.
 *
 * The fallback — the subscription price's `credits` — covers an unassigned row
 * and a contact resolved after purchase. It errs toward ALLOWING the refund:
 * without it a genuine credit-pack payment would look indivisible and a
 * legitimate partial refund would be refused.
 *
 * EXPORTED because two more manager actions ask the same question of the same
 * numbers, and a second copy of this lookup is a second answer waiting to
 * disagree: `voidManualPayment` (payments/voidManualPayment.ts) and the
 * re-assign half of `updatePaymentRecord` (connect/updatePayment.ts). What each
 * caller DOES with a consumed pack differs — refuse, proceed, refuse — but they
 * all have to see the same pack.
 */
export async function resolveDivisible(
  teamId: string,
  contactId: string | null,
  paymentRef: string,
  lineItem: PaymentLineItem | null
): Promise<DivisibleGrant | null> {
  if (lineItem?.kind !== 'subscription') return null
  const db = admin.firestore()
  if (contactId) {
    const grantSnap = await db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
      .doc(paymentRef)
      .get()
    if (grantSnap.exists) {
      const g = grantSnap.data()!
      const total = (g.credits_total as number | undefined) ?? 0
      const used = (g.credits_used as number | undefined) ?? 0
      const revoked = (g.credits_revoked as number | undefined) ?? 0
      return {
        // The pack as SOLD. An earlier reversal lowered credits_total; reading
        // that alone would tell the member she used "3 of the 3".
        unitsGranted: total + revoked,
        unitsConsumed: used,
      }
    }
  }
  if (!lineItem.subscriptionTypeId || !lineItem.priceId) return null
  const typeSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .doc(lineItem.subscriptionTypeId)
    .get()
  const price = ((typeSnap.data() as SubscriptionType | undefined)?.prices ?? []).find(
    (p) => p.id === lineItem.priceId
  )
  if (!price?.credits || price.credits <= 0) return null
  return { unitsGranted: price.credits, unitsConsumed: 0 }
}

export const refundMemberPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    paymentIntentId?: string
    amount?: number // partial refund in Rappen; omit for full
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer'
  }
  if (!data?.teamId || !data?.paymentIntentId) {
    throw new HttpsError('invalid-argument', 'teamId and paymentIntentId are required')
  }
  const { teamId, paymentIntentId } = data

  if (data.amount !== undefined && (!Number.isInteger(data.amount) || data.amount <= 0)) {
    throw new HttpsError('invalid-argument', 'amount must be a positive integer in Rappen')
  }
  const fullRefund = data.amount === undefined
  const uid = request.auth.uid

  await assertManager(uid, teamId)
  const team = await loadEnabledTeam(teamId)
  const { accountId } = requireChargeableAccount(team)

  // The payment must belong to this team (prevents refunding another team's charge).
  const paymentSnap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
    .doc(paymentIntentId)
    .get()
  if (!paymentSnap.exists) {
    throw new HttpsError('not-found', 'Payment not found for this team')
  }
  const payment = paymentSnap.data()!
  if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
    throw new HttpsError('failed-precondition', 'Only a succeeded payment can be refunded')
  }
  if (data.amount !== undefined) {
    const already = (payment.amount_refunded as number) ?? 0
    const total = (payment.amount as number) ?? 0
    if (already + data.amount > total) {
      throw new HttpsError('invalid-argument', 'Refund exceeds the remaining refundable amount')
    }
  }

  // ── What this refund should take back ──────────────────────────────────────
  // Decided BEFORE the gift-card void and before Stripe, because it can REFUSE.
  // A refusal raised after the void would leave the card dead with no
  // compensating un-void; a refusal raised after the charge would be a refusal
  // of something that already happened.
  // WHAT WAS SOLD decides whether this refund is legal — not whether the row has
  // been assigned to a contact yet. Both are resolved unconditionally; only the
  // reversal below is skipped when there is nobody to revoke from.
  const contactId = (payment.contactId as string | undefined) ?? null
  const lineItem = lineItemForReversal(payment)
  const divisible = await resolveDivisible(teamId, contactId, paymentIntentId, lineItem)
  const reversalPlan = reversalPlanFor({
    lineItem,
    divisible,
    refundAmountMinor: data.amount,
  })
  if (reversalPlan.refuse === 'partial_refund_on_indivisible') {
    throw new HttpsError(
      'failed-precondition',
      'This payment can only be refunded in full',
      { reason: 'partial_refund_on_indivisible' }
    )
  }
  if (reversalPlan.refuse === 'partial_refund_on_pack') {
    throw new HttpsError(
      'failed-precondition',
      'A class pack can only be refunded in full',
      { reason: 'partial_refund_on_pack' }
    )
  }
  if (reversalPlan.refuse === 'full_refund_on_consumed_pack') {
    // The details carry the two numbers that make the RULE concrete on screen
    // ("3 of 10 used"), and no amount. A used pack is not refundable here — see
    // reversalPlanFor; a figure would imply an action that does not exist.
    throw new HttpsError(
      'failed-precondition',
      'A class pack that has been used cannot be refunded',
      { reason: 'full_refund_on_consumed_pack', ...reversalPlan.facts }
    )
  }
  const reversalActions: ReversalActions = reversalPlan

  // ── This payment BOUGHT a gift card ────────────────────────────────────────
  const soldCode = (payment.giftCardCode as string | undefined) ?? null
  let voidedFrom: { code: string; previousStatus: GiftCardStatus } | null = null
  if (soldCode) {
    if (!fullRefund) {
      // Half the money back while 100% of the value stays redeemable is a leak
      // with no defensible split — a card is not partially unsold.
      throw new HttpsError(
        'failed-precondition',
        'A gift-card purchase can only be refunded in full',
        { reason: 'gift_card_partial_refund_unsupported' }
      )
    }
    // Void BEFORE the refund, not after: between a check and the Stripe call
    // somebody holding the code could spend it, and then the studio has paid
    // the money back AND delivered the value. Voiding first inverts the failure
    // into a recoverable one — the compensating un-void below, plus a refund
    // the manager can simply retry (refundDirectCharge is idempotent).
    // Throws failed-precondition/gift_card_partially_redeemed when the card has
    // already been drawn on; clawing spent value back is not solvable here.
    const { previousStatus } = await voidUntouchedGiftCard({ teamId, code: soldCode })
    voidedFrom = { code: soldCode, previousStatus }
  }

  try {
    const refund = await refundDirectCharge({
      accountId,
      paymentIntentId,
      amount: data.amount,
      reason: data.reason,
      idempotencyKey: `refund:${paymentIntentId}:${data.amount ?? 'full'}`,
    })

    // ── This payment was FUNDED by a gift card ───────────────────────────────
    const redeemed = payment.gift_card_redeemed as
      | { code?: string; holdKey?: string; amountMajor?: number }
      | undefined
    if (redeemed?.code && redeemed.holdKey) {
      if (fullRefund) {
        // Best-effort by design: the money is already back with the customer,
        // so failing the call now would only invite a second refund. The
        // reversal is idempotent (the card's committed-hold marker gates it),
        // so a retry heals it.
        await reverseGiftCardDrawdown({
          teamId,
          code: redeemed.code,
          holdKey: redeemed.holdKey,
          targetCategory: mapCategory(payment.kind as string | undefined),
          contactId: (payment.contactId as string | undefined) ?? null,
          description: `Refund · ${paymentIntentId}`,
        }).catch((err) =>
          console.error(
            `[connect] gift-card restore after refund failed (pi=${paymentIntentId} code=${redeemed.code}):`,
            err
          )
        )
      } else {
        // A partial refund of a mixed-tender charge has no defensible split
        // between the card and the residual, so the card is left alone.
        console.log(
          `[connect] partial refund on a gift-funded payment (pi=${paymentIntentId}) — card ${redeemed.code} untouched`
        )
      }
    }

    // ── Take back what the money bought ──────────────────────────────────────
    // THE MONEY IS ALREADY GONE. Everything below catches and reports; nothing
    // below throws. A failure here is a manager who has to remove the access by
    // hand — bad, and visible on the row. Throwing instead would tell her the
    // refund itself failed, and the natural response to that is to refund again.
    let reversal: MemberPaymentEffectsReversal | null = null
    const touchesSomething =
      reversalActions.subscription === 'clear_if_owned' ||
      reversalActions.credits.op === 'reduce_to' ||
      reversalActions.course === 'delete_if_owned'
    if (contactId && touchesSomething) {
      try {
        const outcome = await reversePaymentEffects(admin.firestore(), {
          teamId,
          contactId,
          paymentRef: paymentIntentId,
          lineItem,
          plan: reversalActions,
        })
        reversal = {
          state: 'done',
          at: Timestamp.now(),
          by: uid,
          refund_amount: data.amount ?? null,
          subscription: outcome.subscription,
          credits: outcome.credits,
          credits_revoked: outcome.creditsRevoked,
          course: outcome.course,
          plan_grant: outcome.planGrant,
        }
      } catch (err) {
        console.error(
          `[connect] effects reversal failed after refund (pi=${paymentIntentId}):`,
          err
        )
        reversal = {
          state: 'failed',
          at: Timestamp.now(),
          by: uid,
          refund_amount: data.amount ?? null,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      // The stamp is REPORTING, deliberately outside the reversal transaction:
      // the transaction is the correctness boundary, and making its commit
      // depend on a write to a different collection would only widen it.
      await paymentSnap.ref.set({ effects_reversal: reversal }, { merge: true }).catch((e) =>
        console.error(`[connect] effects_reversal stamp failed (pi=${paymentIntentId}):`, e)
      )
    }

    // ── Say what just happened, without waiting for Stripe to tell us ────────
    // The `charge.refunded` webhook is still the RECONCILER — it writes the
    // authoritative amount_refunded / status / refunds[] — but it lands on its
    // own schedule, and until it did, this row read exactly as it had a second
    // earlier. The manager refunded, the table did not move, and the only way
    // to see the refund was to reload the page a few seconds later.
    //
    // So the outcome this call KNOWS is written here. Both fields are ABSOLUTE
    // values computed from the amounts already read above, never increments, so
    // the webhook's own absolute write reconciles rather than double-counts —
    // whichever of the two lands second is correct.
    //
    // Best-effort: the money has moved, and failing the call over a display
    // write would invite a second refund. The webhook heals a miss.
    const refundedNow = data.amount ?? (payment.amount as number) ?? 0
    const alreadyRefunded = (payment.amount_refunded as number) ?? 0
    const totalRefunded = alreadyRefunded + refundedNow
    const total = (payment.amount as number) ?? 0
    await paymentSnap.ref
      .set(
        {
          amount_refunded: totalRefunded,
          status: totalRefunded >= total ? 'refunded' : 'partially_refunded',
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      .catch((e) =>
        console.error(`[connect] optimistic refund stamp failed (pi=${paymentIntentId}):`, e)
      )

    return { refundId: refund.id, status: refund.status, reversal }
  } catch (err) {
    // The card was voided in anticipation of a refund that never happened —
    // put it back, or the buyer loses the value AND keeps paying for it.
    if (voidedFrom) {
      await unvoidGiftCard({
        teamId,
        code: voidedFrom.code,
        previousStatus: voidedFrom.previousStatus,
      }).catch((e) =>
        console.error(`[connect] gift card un-void after failed refund failed (${voidedFrom!.code}):`, e)
      )
    }
    console.error('[connect] refundMemberPayment failed:', err)
    throw new HttpsError('internal', 'Failed to refund the payment')
  }
})
