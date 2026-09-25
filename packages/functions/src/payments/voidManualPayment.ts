/* eslint-disable no-console */
// voidManualPayment — un-record a manual payment. The inverse of
// `recordManualPayment`, for the case that callable makes easy to get wrong:
// a manager types CHF 1'800 for CHF 180, or records the same cash twice.
//
// A VOID IS NOT A REFUND, and every difference below follows from that one
// sentence:
//
//   • A refund says "the money came back". A void says "the money never came" —
//     the record was wrong. So this callable moves NO money, calls no gateway,
//     and there is nothing here to fail halfway.
//   • Because it moves no money, it may only touch a ledger row that no gateway
//     owns. `gateway === 'manual'` is enforced HERE, server-side, not merely
//     unmounted in the UI: `payment_events` also holds `payrexx` and BYO-`stripe`
//     rows, equally `refundable: false`, and voiding one of those would make our
//     books disagree with a gateway we do not control and cannot correct.
//   • The redo is a fresh `recordManualPayment`, not an edit of the row that was
//     wrong. The wrong row stays, voided, as the audit record — which is also why
//     `updatePaymentRecord` refuses a voided row outright.
//
// THE CONSUMED-PACK REFUSAL DOES NOT APPLY HERE, and this is the one place the
// void and the refund deliberately diverge on the reversal rules rather than the
// money. A refund of a used pack is refused because *refunding money for classes
// already delivered* is a policy question the app declines to answer with
// arithmetic (docs/payment-contact-studio.md). A void answers no such question:
// no money is going anywhere. It says the record was a mistake, and the honest
// consequence of that is the one the executor already implements — reduce
// `credits_total` to `credits_used`. The classes she actually took stand; the
// remainder she never paid for is withdrawn. Same principle as the refund path
// ("delivered value is owed"), opposite outcome, because the question is
// different.
//
// ORDER: REVERSE, THEN STAMP. If the reversal fails, nothing is voided and the
// manager sees an error she can retry (the reversal is idempotent). The other
// order would show a voided row next to a member who still holds what it gave —
// the one failure that is completely silent.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  PAYMENT_EVENTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  financeTxnId,
  type PaymentLineItem,
} from '@linyup/shared'
import { assertManager } from '../connect/access'
import { resolveDivisible } from '../connect/refunds'
import { markFinanceTxnCorrected } from '../finance/journal'
import {
  lineItemForReversal,
  reversalPlanFor,
  reversePaymentEffects,
  type DivisibleGrant,
  type ReversalActions,
} from './reversal'

const MAX_REASON_LEN = 200

/**
 * What a VOID takes back. `reversalPlanFor` owns the rules and is asked as for a
 * FULL reversal (a void has no amount — half a mistake is not a thing), then the
 * one refusal a void does not honor is translated into the actions it would
 * have produced for an untouched pack.
 *
 * `reduce_to: 0` is a TARGET, not a delta, and the executor clamps it up to the
 * `credits_used` it reads inside its own transaction — which is exactly the
 * "delivered classes stand" behavior, with no second code path and no second
 * set of numbers to keep in step.
 */
export function voidActionsFor(
  lineItem: PaymentLineItem | null,
  divisible: DivisibleGrant | null
): ReversalActions {
  const plan = reversalPlanFor({ lineItem, divisible })
  if (!plan.refuse) return plan
  if (plan.refuse === 'full_refund_on_consumed_pack') {
    return {
      subscription: 'clear_if_owned',
      credits: { op: 'reduce_to', total: 0 },
      course: 'leave',
    }
  }
  // Unreachable by construction: the other two refusals are partial-refund-only
  // and this call passes no amount. Loud rather than silently under-revoking, so
  // a future change to reversalPlanFor cannot quietly turn a void into a no-op.
  throw new HttpsError('internal', `Unexpected reversal refusal on a void: ${plan.refuse}`)
}

export const voidManualPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    /** payment_events doc id (`manual:{ref}`). */
    paymentId?: string
    reason?: string | null
  }
  if (!data?.teamId || !data?.paymentId) {
    throw new HttpsError('invalid-argument', 'teamId and paymentId are required')
  }
  const { teamId, paymentId } = data
  const uid = request.auth.uid

  // Whoever can record can un-record: both are the same manager correcting the
  // same ledger, and a role split would leave the mistake standing until the
  // owner is free.
  await assertManager(uid, teamId)

  const db = admin.firestore()
  const docRef = db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(PAYMENT_EVENTS_SUBCOLLECTION)
    .doc(paymentId)

  const snap = await docRef.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Payment not found')
  const payment = snap.data()!

  if (payment.gateway !== 'manual') {
    throw new HttpsError(
      'failed-precondition',
      'Only a manually recorded payment can be voided',
      { reason: 'not_manual' }
    )
  }
  if (payment.voided_at) {
    throw new HttpsError('failed-precondition', 'This payment is already voided', {
      reason: 'already_voided',
    })
  }

  const reason = (data.reason ?? '').toString().trim().slice(0, MAX_REASON_LEN) || null

  // ── Take back what the record gave ─────────────────────────────────────────
  // The paymentRef is the DOC ID, because that is what applyPaymentEffects
  // stamped as provenance when the row was recorded (recordManualPayment) or
  // re-assigned (updatePaymentRecord).
  const contactId = (payment.contact_id as string | null | undefined) ?? null
  const lineItem = lineItemForReversal(payment)
  const divisible = await resolveDivisible(teamId, contactId, paymentId, lineItem)
  const actions = voidActionsFor(lineItem, divisible)

  let reversal = null
  if (contactId) {
    // Called unconditionally when there is a contact — a plan that touches
    // nothing reads nothing and writes nothing, so a "does this touch anything"
    // pre-check here would only be a second copy of a decision the plan already
    // carries.
    try {
      reversal = await reversePaymentEffects(db, {
        teamId,
        contactId,
        paymentRef: paymentId,
        lineItem,
        plan: actions,
      })
    } catch (err) {
      console.error(`[payments] void reversal failed team=${teamId} payment=${paymentId}:`, err)
      throw new HttpsError(
        'internal',
        'Could not take back what this payment gave, so nothing was voided',
        { reason: 'reversal_failed' }
      )
    }
  }

  // ── Mark the record wrong ──────────────────────────────────────────────────
  // No `status` field: the BYO/manual rail has never had one (`raw_status` is the
  // gateway's own word), and `voided_at` is the fact. Every money reader derives
  // the state from it — see byoToUnified + useMonthlyRevenue on the web.
  await docRef.set(
    {
      voided_at: FieldValue.serverTimestamp(),
      voided_by: uid,
      void_reason: reason,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  // ── The books ──────────────────────────────────────────────────────────────
  // Best-effort, exactly as the row's own journal write is (recordManualPayment):
  // a journal failure must never break the correction of a payment record, and
  // the payments row is already right. The id is deterministic, so a retry of the
  // whole void converges.
  const gatewayRef = (payment.gatewayRef as string | undefined) ?? paymentId.replace(/^manual:/, '')
  try {
    await markFinanceTxnCorrected(teamId, financeTxnId('manual', 'charge', gatewayRef))
  } catch (err) {
    console.error(`[payments] void journal correction failed team=${teamId} ref=${gatewayRef}:`, err)
  }

  console.log(
    `[payments] voided team=${teamId} payment=${paymentId} by=${uid} contact=${contactId ?? '-'}`
  )
  return { ok: true, reversal }
})
