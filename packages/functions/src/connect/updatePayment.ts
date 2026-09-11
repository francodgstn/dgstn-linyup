/* eslint-disable no-console */
// updatePaymentRecord — the one manager action that spans both payment rails:
// (re)assign the contact and/or edit the free-text "what was paid" comment.
//
//   • Connect → teams/{teamId}/member_payments/{paymentId} (contactId, comment)
//   • BYO     → teams/{teamId}/payment_events/{paymentId}  (contact_id,
//               assignment_status, comment)
//
// On assigning a contact we stamp last_payment_at and write an activity-log entry;
// BYO docs additionally carry the subscription linkage (subscription_type_id /
// membership_expiration) so we re-apply the membership — Connect member_payments
// don't persist that detail, so only last_payment_at is touched there.
//
// ── A RE-ASSIGN IS SYMMETRIC ─────────────────────────────────────────────────
// One payment, one holder. Moving a row from Ana to Ben must TAKE THE MEMBERSHIP
// OFF ANA, not merely give a second copy to Ben — this used to apply to the new
// contact and reverse nothing, so a mis-typed assignment left two people holding
// one purchase and no way to see which was real. Three rules make it symmetric,
// and each of them was a defect first:
//
//   1. REVERSE OLD, THEN APPLY NEW. Applying first makes the double-hold the
//      failure state — i.e. the bug itself is what a crash leaves behind.
//   2. THE CONTACT FIELD LANDS LAST, after the effects succeed. The row is what
//      says who holds this payment, so it may not say "Ben" until Ben does.
//   3. UNASSIGNING REVERSES TOO. `contactId: ''` used to skip the apply branch
//      and do nothing else, which left the grant standing on a row that named
//      nobody — the same orphan, harder to find.
//
// A COMMENT-ONLY EDIT NEITHER APPLIES NOR REVERSES: nothing about who holds what
// changed, and a note is not a money event.
//
// THE BUYER'S RECEIPT IS OPTIONAL AND EXPLICIT (UX-80). Assigning an orphaned
// bank transfer to the member it belonged to is the moment their pack becomes
// real, and until now they were told nothing; re-linking a mis-assigned row is a
// correction and usually warrants silence. The caller decides — `sendReceipt`,
// omitted means no — and it is honoured only when this edit actually APPLIED
// effects to somebody. Deliberately after step 4, so no mail can describe a
// holder the row does not yet name.
//
// A REVERSAL NEVER TOUCHES A PROMO REDEMPTION. `reversePaymentEffects` knows
// nothing about codes by design — there is no restore-on-refund path anywhere
// (docs/promo-codes.md), and the manager levers delete lifecycle state rather
// than adjusting a counter. `carrySystemStamps` below keeps the stamp on the row
// across the move, so the sale's provenance survives the correction.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  TEAMS_COLLECTION,
  CONTACTS_COLLECTION,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  PAYMENT_EVENTS_SUBCOLLECTION,
  type PaymentLineItem,
} from '@linyup/shared'
import { assertManager } from './access'
import { resolveDivisible } from './refunds'
import { applyPaymentEffects, normalizePaymentLineItem } from '../payments/effects'
import { sendDeskSaleReceipt } from '../payments/deskReceipt'
import { lineItemForReversal, reversalPlanFor, reversePaymentEffects } from '../payments/reversal'
import { withLedgerExpiry } from '../utils/ledgerRetention'

const MAX_COMMENT_LEN = 500

/** Re-attach the SYSTEM STAMPS to a manager's edited line-item.
 *
 * `line_item` is REPLACED wholesale on edit, and the picker
 * (PaymentLineItemPicker) builds a fresh object on every change, so without this
 * the first "what was paid" correction on a discounted sale would erase the only
 * record of why it was discounted — the payments row is that record, by
 * decision: neither a promo code nor a plan's intro offer writes a journal row
 * or a CSV column (docs/promo-codes.md; the same reasoning applies to an intro
 * offer, and for the same reason — a discount is not a money event on a cash
 * basis).
 *
 * The values come from the STORED document, never from the request, which is the
 * other half of the rule `normalizePaymentLineItem` states: not forgeable by a
 * client, not loseable by an edit. */
function carrySystemStamps(
  next: PaymentLineItem | null,
  payment: FirebaseFirestore.DocumentData
): PaymentLineItem | null {
  if (!next) return next
  const stored = payment.line_item as PaymentLineItem | undefined
  return {
    ...next,
    ...(stored?.promoCode ? { promoCode: stored.promoCode } : {}),
    ...(stored?.introOffer ? { introOffer: stored.introOffer } : {}),
    // Whether this drop-in charge was somebody's paid trial is a fact about the
    // sale, not a manager's choice — and it is the only place the money and the
    // trial meet, so an edit to "what was paid" must not be able to erase it.
    ...(stored?.trial ? { trial: true } : {}),
  }
}

/** The line-item to apply on assign: the manager's explicit pick, else the row's
 * stored line_item, else a bare subscription link derived from subscription_type_id. */
function effectiveLineItem(
  explicit: PaymentLineItem | null,
  payment: FirebaseFirestore.DocumentData
): PaymentLineItem | null {
  if (explicit) return explicit
  if (payment.line_item) return normalizePaymentLineItem(payment.line_item)
  const subTypeId = payment.subscription_type_id as string | undefined
  if (subTypeId) return { kind: 'subscription', subscriptionTypeId: subTypeId }
  return null
}

export const updatePaymentRecord = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    source?: 'connect' | 'byo'
    paymentId?: string
    // contactId: a non-empty id assigns; '' or null unassigns; omit → unchanged.
    contactId?: string | null
    // comment: any string sets it; omit → unchanged.
    comment?: string | null
    // lineItem: structured "what was bought"; omit → unchanged.
    lineItem?: unknown
    // "Send the buyer a receipt" — see the header. Omitted ⇒ no mail.
    sendReceipt?: boolean
  }
  if (!data?.teamId || !data?.paymentId) {
    throw new HttpsError('invalid-argument', 'teamId and paymentId are required')
  }
  const source = data.source ?? 'connect'
  if (source !== 'connect' && source !== 'byo') {
    throw new HttpsError('invalid-argument', 'source must be "connect" or "byo"')
  }
  const { teamId, paymentId } = data

  const changingContact = Object.prototype.hasOwnProperty.call(data, 'contactId')
  const changingComment = Object.prototype.hasOwnProperty.call(data, 'comment')
  const changingLineItem = Object.prototype.hasOwnProperty.call(data, 'lineItem')
  if (!changingContact && !changingComment && !changingLineItem) {
    throw new HttpsError('invalid-argument', 'Nothing to update')
  }
  const newLineItem = changingLineItem ? normalizePaymentLineItem(data.lineItem) : null

  await assertManager(request.auth.uid, teamId)

  const db = admin.firestore()
  const docRef =
    source === 'byo'
      ? db
          .collection(TEAMS_COLLECTION)
          .doc(teamId)
          .collection(PAYMENT_EVENTS_SUBCOLLECTION)
          .doc(paymentId)
      : db
          .collection(TEAMS_COLLECTION)
          .doc(teamId)
          .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
          .doc(paymentId)

  const snap = await docRef.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Payment not found')
  const payment = snap.data()!

  // A VOIDED ROW IS CLOSED. It has already had its effects taken back, so
  // re-assigning it would re-apply them from a record the studio has declared
  // wrong — silently undoing the manager's own correction. The redo of a voided
  // payment is a fresh recordManualPayment, never an edit of this row.
  if (payment.voided_at) {
    throw new HttpsError('failed-precondition', 'A voided payment cannot be edited', {
      reason: 'payment_voided',
    })
  }

  // The manager's line-item, with the system-stamped promo code carried across
  // (the picker rebuilds the object from scratch, so it never round-trips).
  const finalLineItem = carrySystemStamps(newLineItem, payment)

  // Validate the target contact when assigning a non-empty id.
  let newContactId: string | null = null
  if (changingContact) {
    const cid = (data.contactId ?? '').trim()
    if (cid) {
      const cSnap = await db.collection(CONTACTS_COLLECTION).doc(cid).get()
      if (!cSnap.exists || cSnap.data()?.teamId !== teamId) {
        throw new HttpsError('invalid-argument', 'Contact does not belong to this team')
      }
      if (cSnap.data()?.deleted_at != null) {
        throw new HttpsError('invalid-argument', 'Contact is deleted')
      }
      newContactId = cid
    }
  }

  // Who this row is linked to now, who it will be linked to, and therefore
  // whether this edit MOVES the purchase off somebody.
  const existingContact = (source === 'byo' ? payment.contact_id : payment.contactId) as
    | string
    | null
    | undefined
  const oldContactId = existingContact ?? null
  const targetContactId = changingContact ? newContactId : oldContactId
  const shouldApply = !!targetContactId && (changingContact ? !!newContactId : changingLineItem)
  // Unassigning counts: `newContactId` is null and this is still a move away.
  const movingAway = changingContact && !!oldContactId && oldContactId !== newContactId

  // ── 1. Take it off the previous contact — BEFORE anything is written ───────
  // Nothing above this has changed a document, so a refusal or a failure here
  // leaves the row exactly as the manager found it.
  if (movingAway && oldContactId) {
    // What the OLD contact was given: read off the STORED row, never off the
    // manager's edit — the effects being reversed are the ones that were applied.
    const oldLineItem = lineItemForReversal(payment) ?? effectiveLineItem(null, payment)
    const divisible = await resolveDivisible(teamId, oldContactId, docRef.id, oldLineItem)
    // No amount: a move is all-or-nothing. Half a purchase cannot change hands.
    const plan = reversalPlanFor({ lineItem: oldLineItem, divisible })
    if (plan.refuse === 'full_refund_on_consumed_pack') {
      // A pack she has drawn on is not movable: the classes were taken by HER,
      // and handing the remainder to somebody else would rewrite who attended.
      // Same rule as the refund path, same reason — the answer is a void plus a
      // fresh record, which is a decision the studio makes explicitly.
      //
      // THIS ALSO REFUSES AN UNASSIGN, which is not pedantry: the grant doc is
      // keyed by (contact, paymentRef), so unassign-then-reassign would leave the
      // used pack on the first contact and mint a FULL one on the second — the
      // same payment sold twice, assembled from two steps that each looked fine.
      throw new HttpsError(
        'failed-precondition',
        'A class pack that has been used cannot be moved',
        { reason: 'consumed_pack_reassign', ...plan.facts }
      )
    }
    if (plan.refuse) {
      // Unreachable: the remaining refusals are partial-refund-only and this
      // call passes no amount. Loud, so a change to the rules cannot quietly
      // turn a move into a one-sided apply again.
      throw new HttpsError('internal', `Unexpected reversal refusal: ${plan.refuse}`)
    }
    try {
      await reversePaymentEffects(db, {
        teamId,
        contactId: oldContactId,
        paymentRef: docRef.id,
        lineItem: oldLineItem,
        plan,
      })
    } catch (err) {
      console.error(
        `[connect] re-assign reversal failed team=${teamId} payment=${docRef.id} from=${oldContactId}:`,
        err
      )
      throw new HttpsError(
        'internal',
        'Could not take this payment back from the previous contact, so nothing was changed',
        { reason: 'reassign_reversal_failed' }
      )
    }
  }

  // ── 2. Write everything EXCEPT who holds it ───────────────────────────────
  const now = FieldValue.serverTimestamp()
  const update: Record<string, unknown> = { updated_at: now }

  let finalComment: string | null | undefined
  if (changingComment) {
    finalComment = (data.comment ?? '').toString().trim().slice(0, MAX_COMMENT_LEN) || null
    update.comment = finalComment
  }
  if (changingLineItem) {
    update.line_item = finalLineItem
    if (finalLineItem?.kind === 'subscription') {
      update.subscription_type_id = finalLineItem.subscriptionTypeId ?? null
    }
  }

  await docRef.set(update, { merge: true })

  // ── 3. Give it to the new contact ─────────────────────────────────────────
  if (shouldApply && targetContactId) {
    const rowSource =
      source === 'byo' ? ((payment.gateway as string | undefined) ?? 'byo') : 'stripe_connect'
    const li = effectiveLineItem(finalLineItem, payment)
    if (li) {
      // Full effects: subscription fields / course entitlement / credits + activity.
      // THROWS ON FAILURE, deliberately: the contact field below is then never
      // written, so the row still names the previous holder (who no longer holds
      // it) rather than naming somebody who was given nothing. The manager sees
      // an error, and the same save retried is idempotent in both directions.
      try {
        await applyPaymentEffects(db, {
          teamId,
          contactId: targetContactId,
          lineItem: li,
          amountRappen: typeof payment.amount === 'number' ? payment.amount : null,
          currency: (payment.currency as string | undefined) ?? 'CHF',
          source: rowSource,
          paymentRef: docRef.id,
        })
      } catch (err) {
        console.error(
          `[connect] re-assign apply failed team=${teamId} payment=${docRef.id} to=${targetContactId}:`,
          err
        )
        throw new HttpsError(
          'internal',
          'Could not give this payment to the new contact — the payment was not moved',
          { reason: 'reassign_apply_failed' }
        )
      }
    } else {
      // No structured item — just stamp + log the bare assignment.
      await db.collection(CONTACTS_COLLECTION).doc(targetContactId).set({ last_payment_at: now }, { merge: true })
      const label = changingComment ? finalComment : (payment.comment as string | undefined) ?? null
      await db
        .collection(CONTACTS_COLLECTION)
        .doc(targetContactId)
        .collection('activity_log')
        .add(withLedgerExpiry('activity_log', {
          type: 'payment_assigned',
          source: rowSource,
          message: `Payment assigned to this contact${label ? ` · ${label}` : ''}`,
          payment_id: docRef.id,
          timestamp: now,
        }))
    }
  }

  // ── 4. …and only now does the row say who holds it ────────────────────────
  // LAST, on purpose. Until this lands the row still names the previous holder,
  // which is a visible, self-correcting inconsistency; naming the new one before
  // the effects succeeded would be an invisible, wrong one.
  if (changingContact) {
    await docRef.set(
      source === 'byo'
        ? {
            contact_id: newContactId,
            assignment_status: newContactId ? 'assigned' : 'unassigned',
            assigned_by: request.auth.uid,
            assigned_at: now,
          }
        : { contactId: newContactId },
      { merge: true }
    )
  }

  // ── 5. …and only now, if asked, tell the buyer ────────────────────────────
  // LAST, after the row names its holder: a receipt that arrives describing a
  // purchase the ledger does not yet attribute is worse than a late one. Sent
  // only when this edit APPLIED effects — a comment-only save, an unassign and a
  // row with no structured line-item all grant nothing and so announce nothing.
  // Re-saving the same dialog re-keys identically and the mail ledger drops it.
  if (data.sendReceipt === true && shouldApply && targetContactId) {
    const li = effectiveLineItem(finalLineItem, payment)
    if (li) {
      await sendDeskSaleReceipt({
        teamId,
        contactId: targetContactId,
        lineItem: li,
        paymentRef: docRef.id,
        amountRappen: typeof payment.amount === 'number' ? payment.amount : null,
        currency: (payment.currency as string | undefined) ?? 'CHF',
        // The row's own tender when it has one ("Cash" on a manual row); a
        // gateway row leaves it unset and the receipt prints a bare amount,
        // which is right — the buyer paid that gateway and knows how.
        methodLabel: (payment.payment_mode as string | undefined) ?? null,
      })
    }
  }

  return { ok: true, contactId: newContactId, source }
})
