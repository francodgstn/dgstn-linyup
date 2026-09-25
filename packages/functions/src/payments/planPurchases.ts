/* eslint-disable no-console */
// Plan-purchase allowance — "this 2-month intro can be bought once per person".
//
// THE WHOLE FEATURE IS THREE FUNCTIONS, and keeping them in one file is the
// point: the cap is only ever as good as the agreement between what COUNTS a
// purchase and what REFUSES one, and those two used to be the kind of pair that
// drifts across a codebase.
//
//   • `recordPlanPurchase`  — the ONE writer. Every rail that completes a plan
//                             purchase calls it.
//   • `countPlanPurchases`  — the ONE reader.
//   • `assertPlanPurchaseAllowance` — the ONE refusal.
//
// ── IDEMPOTENCY IS THE DOC ID, NOT A COUNTER ────────────────────────────────
// The row's id IS the payment ref, so a Connect purchase that arrives through
// both `checkout.session.completed` and `payment_intent.succeeded` writes ONE
// row, and a redelivered webhook writes none. There is deliberately no counter
// field anywhere in this feature — nothing to contend over, nothing to repair,
// and no second writer to introduce later (the same reasoning that keeps
// `usage_count` and `bookings_count` single-writer in CLAUDE.md, reached by
// removing the counter instead of guarding it).
//
// ── WHAT IS COUNTED, AND WHAT IS NOT ────────────────────────────────────────
// ONE-TIME prices only — `resolvePlanPurchaseCap` is the one place that says so.
// A recurring price is not something a member buys repeatedly; she subscribes to
// it, and buying it twice is already refused by the "you already have this
// subscription" gate in `createMembershipCheckout`. Applying a purchase cap
// there as well would give one fact two enforcement points that could disagree.
//
// ── WHO IS REFUSED, AND WHO IS MERELY COUNTED ───────────────────────────────
// SELF-SERVICE is refused; a MANAGER is not. `createMembershipCheckout` (the
// public shop, login-first) calls the guard. `createMembershipPayment` (a
// manager selling to a member) and `recordManualPayment` (a manager recording
// cash) deliberately do NOT — a studio selling the same offer a second time is
// exercising judgment, and the app does not overrule it. Both still RECORD the
// purchase, so the member cannot then take the offer again herself.
//
// ── A REFUND DOES NOT GIVE THE ALLOWANCE BACK ───────────────────────────────
// `reversePaymentEffects` clears what a payment GRANTED; it deliberately does
// not delete the row here. Restoring a consumed allowance is the second writer
// this feature has no other reason to have (the same reasoning that keeps a
// promo redemption un-restored on refund — CLAUDE.md, "Promo codes"), and it is
// not needed: a manager rail is exempt from the cap, so a studio that refunded a
// mistaken purchase can simply sell the offer again in one click. The row stays
// as the record that the sale happened.
//
// ── THE RACE IS ACCEPTED, DELIBERATELY ──────────────────────────────────────
// Two tabs can pass the guard and buy twice. This is the same posture the
// already-holds-this-type refusal beside it takes, and the same one
// `Contact.trial_used_at` takes: the cost of losing the race is that a studio
// receives money twice for an intro offer and can refund it — money IN, visible
// on the contact, fixable in one click. Nothing here is a scarce resource, so
// none of the reserve/commit/release machinery the seat and promo paths need
// applies. Do not add it.

import { HttpsError } from 'firebase-functions/v2/https'
import { FieldValue } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  CONTACT_PLAN_PURCHASES_SUBCOLLECTION,
  type SubscriptionPrice,
} from '@linyup/shared'
import type { firestore } from 'firebase-admin'

type Db = firestore.Firestore

/**
 * The cap this price actually enforces, or null for "unlimited".
 *
 * THE ONE PLACE that decides a cap applies. A cap stored on a recurring price
 * (only reachable by hand-edited or seeded data — the editor offers the control
 * on one-time prices alone) is ignored rather than honored, so a stray value
 * can never lock a member out of a subscription she is entitled to renew.
 */
export function resolvePlanPurchaseCap(
  price: Pick<SubscriptionPrice, 'recurrence' | 'maxPurchasesPerContact'>
): number | null {
  if (price.recurrence !== 'one_time') return null
  const max = price.maxPurchasesPerContact
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) return null
  return max
}

/** How many times this contact has already completed a purchase of this price. */
export async function countPlanPurchases(
  db: Db,
  contactId: string,
  priceId: string
): Promise<number> {
  const agg = await db
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection(CONTACT_PLAN_PURCHASES_SUBCOLLECTION)
    .where('price_id', '==', priceId)
    .count()
    .get()
  return agg.data().count
}

/**
 * Refuse a self-service purchase that would exceed the price's cap.
 *
 * FAILS OPEN on a read error, deliberately: this is a commercial nicety, and a
 * Firestore hiccup must not take a studio's shop down. The studio sees one
 * purchase too many at worst — the same outcome the accepted race already
 * allows — instead of every buyer seeing an error nobody can explain.
 */
export async function assertPlanPurchaseAllowance(
  db: Db,
  contactId: string,
  price: Pick<SubscriptionPrice, 'id' | 'recurrence' | 'maxPurchasesPerContact'>
): Promise<void> {
  const max = resolvePlanPurchaseCap(price)
  if (max === null) return
  let used: number
  try {
    used = await countPlanPurchases(db, contactId, price.id)
  } catch (err) {
    console.error(`[planPurchases] allowance read failed (contact=${contactId}):`, err)
    return
  }
  if (used >= max) {
    throw new HttpsError(
      'failed-precondition',
      max === 1
        ? 'This offer can only be purchased once.'
        : `This offer can only be purchased ${max} times.`,
      { reason: 'purchase_limit_reached', max, used }
    )
  }
}

/**
 * Record ONE completed purchase of a subscription price.
 *
 * Called by every rail that completes one, AFTER the money is settled — never
 * at checkout creation, because an abandoned checkout must not spend a member's
 * one allowed purchase. A missing `paymentRef` means no single payment owns this
 * (a recurring renewal), and nothing is written.
 */
export async function recordPlanPurchase(
  db: Db,
  contactId: string,
  purchase: {
    teamId: string
    subscriptionTypeId: string
    priceId: string | null
    amountMajor?: number | null
    source: string
    /** Doc id — the payment that produced this purchase. */
    paymentRef: string | null
  }
): Promise<void> {
  if (!purchase.paymentRef || !purchase.priceId) return
  try {
    await db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_PLAN_PURCHASES_SUBCOLLECTION)
      .doc(purchase.paymentRef)
      .create({
        teamId: purchase.teamId,
        subscription_type_id: purchase.subscriptionTypeId,
        price_id: purchase.priceId,
        amount: purchase.amountMajor ?? null,
        source: purchase.source,
        created_at: FieldValue.serverTimestamp(),
      })
  } catch (err: unknown) {
    // ALREADY_EXISTS (code 6) = the same purchase reached us twice. Expected.
    if ((err as { code?: number }).code === 6) return
    // Never fail the purchase over its own bookkeeping: the member has paid.
    console.error(`[planPurchases] record failed (contact=${contactId}):`, err)
  }
}
