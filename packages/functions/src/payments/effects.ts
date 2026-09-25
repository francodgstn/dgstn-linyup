/* eslint-disable no-console */
// applyPaymentEffects — the single "apply what was bought" path, shared by every
// non-Connect-webhook rail: the BYO webhooks (via a subscription line-item), the
// manual cash/bank-transfer entry, and updatePaymentRecord when a manager assigns
// or links a payment. It runs the SAME effects a Connect purchase would:
//
//   • subscription → set the contact's subscription fields (+ a credit grant when
//                    the price carries credits). NO affiliation/expiry write —
//                    the subscription axis is separate from the affiliation axis.
//   • course       → grant the LIFETIME entitlement (courses/{id}/purchases/{cid},
//                    which the security rules check to unlock the course in the Space).
//   • product      → record-only (merch): an activity-log entry, no entitlement.
//   • gift_card    → record-only: the CODE is the entitlement and the card doc
//                    already carries it (teams/{id}/gift_cards).
//   • drop_in/other→ last_payment_at + an activity-log entry.
//
// Every branch appends ONE activity_log entry carrying the payment id + source so
// the contact timeline links back to the exact payment. A plan a payment buys is a
// plan grant keyed by the payment (writePaymentPlanGrant), never a field on the contact.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  COURSES_COLLECTION,
  COURSE_PURCHASES_SUBCOLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  planGrantExpiryMs,
  type PaymentLineItem,
  type PaymentLineItemKind,
  type SubscriptionType,
  type SubscriptionPrice,
} from '@linyup/shared'
import type { firestore } from 'firebase-admin'
import { recordPlanPurchase } from './planPurchases'
import { planGrantSourceForRail, writePaymentPlanGrant } from '../contacts/planGrants'
import { withLedgerExpiry } from '../utils/ledgerRetention'

type Db = firestore.Firestore

const LINE_ITEM_KINDS: PaymentLineItemKind[] = [
  'subscription',
  'course',
  'product',
  'drop_in',
  'appointment',
  'gift_card',
  'other',
]

/** Validate + normalize a client-supplied line-item. Returns null for junk;
 * downgrades an effect-less subscription/course link (missing id) to 'other' so
 * applyPaymentEffects never silently no-ops on what looked like a real link.
 *
 * `promoCode` is DELIBERATELY NOT READ HERE. It is a system stamp written by the
 * webhook from Checkout Session metadata, and this function's input is whatever
 * a manager's dialog sent — reading it would let a client write a redemption
 * onto any payment row. `updatePaymentRecord` carries the STORED value forward
 * across an edit instead, so the field is neither forgeable nor loseable. */
export function normalizePaymentLineItem(raw: unknown): PaymentLineItem | null {
  if (!raw || typeof raw !== 'object') return null
  const li = raw as Partial<PaymentLineItem>
  if (!li.kind || !LINE_ITEM_KINDS.includes(li.kind)) return null
  const out: PaymentLineItem = { kind: li.kind }
  if (li.subscriptionTypeId) out.subscriptionTypeId = String(li.subscriptionTypeId)
  if (li.priceId) out.priceId = String(li.priceId)
  if (li.courseId) out.courseId = String(li.courseId)
  if (li.productId) out.productId = String(li.productId)
  if (li.variantId) out.variantId = String(li.variantId)
  if (li.label) out.label = String(li.label).slice(0, 200)
  const downgrade = out.label ? { kind: 'other' as const, label: out.label } : { kind: 'other' as const }
  if (out.kind === 'subscription' && !out.subscriptionTypeId) return downgrade
  if (out.kind === 'course' && !out.courseId) return downgrade
  return out
}

function addMonths(months: number): Timestamp {
  const d = new Date()
  d.setMonth(d.getMonth() + months)
  return Timestamp.fromDate(d)
}

/** The shared rule (`planGrantExpiryMs`), in the admin SDK's Timestamp. */
export function planGrantExpiry(
  price: Pick<SubscriptionPrice, 'recurrence' | 'included_months'> | null | undefined
): Timestamp | null {
  const ms = planGrantExpiryMs(price)
  return ms === null ? null : Timestamp.fromMillis(ms)
}

/** Append a contact activity-log entry that references the originating payment. */
async function logPaymentActivity(
  db: Db,
  contactId: string,
  entry: { type: string; source: string; message: string; paymentRef: string }
): Promise<void> {
  await db
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection('activity_log')
    .add(withLedgerExpiry('activity_log', {
      type: entry.type,
      source: entry.source,
      message: entry.message,
      payment_id: entry.paymentRef,
      timestamp: FieldValue.serverTimestamp(),
    }))
}

/** Stamp the contact's `last_payment_at`. A plan a payment buys is a plan
 *  grant (`writePaymentPlanGrant`), never a field on the contact — the single
 *  plan slot that used to live here is gone (docs/multi-plan-holdings.md,
 *  phase 5). Also used by the Connect webhook. */
export async function stampLastPayment(db: Db, contactId: string): Promise<void> {
  await db
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .set({ last_payment_at: FieldValue.serverTimestamp() }, { merge: true })
}

/** Idempotent credit grant, keyed by the payment ref (create() refuses a second
 * write, so a retried webhook / re-saved assignment never double-grants). */
export async function grantPaymentCredits(
  db: Db,
  contactId: string,
  grant: {
    teamId: string
    subscriptionTypeId: string
    subscriptionTypeName?: string | null
    priceId?: string | null
    credits: number
    months: number
    source: string
    paymentRef: string
  }
): Promise<void> {
  if (!grant.credits || grant.credits <= 0) return
  try {
    await db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
      .doc(grant.paymentRef)
      .create({
        teamId: grant.teamId,
        subscription_type_id: grant.subscriptionTypeId,
        subscription_type_name: grant.subscriptionTypeName ?? null,
        price_id: grant.priceId ?? null,
        credits_total: grant.credits,
        credits_used: 0,
        expires_at: grant.months > 0 ? addMonths(grant.months) : null,
        source: grant.source,
        payment_ref: grant.paymentRef,
        created_at: FieldValue.serverTimestamp(),
      })
  } catch (err: unknown) {
    // ALREADY_EXISTS (code 6) = a sibling event already wrote it — expected.
    if ((err as { code?: number }).code === 6) return
    throw err
  }
}

/** Grant the lifetime course entitlement. Doc id = contactId → idempotent.
 *
 * THE ONLY WRITER of courses/{id}/purchases/{contactId}. The Connect shop rail
 * used to hand-roll this write and stamped `paymentIntentId` where this one
 * stamps `payment_ref`, which meant the rail that actually SELLS courses did not
 * write the field a reversal would check. Keep every grant going through here:
 * the doc id is the CONTACT, so `payment_ref` is the only thing that says which
 * payment bought it. */
export async function grantCourseEntitlement(
  db: Db,
  grant: {
    teamId: string
    courseId: string
    contactId: string
    amount?: number | null
    currency?: string | null
    source: string
    /** null only when the caller genuinely has no payment to point at (a Connect
     *  session with no PaymentIntent). Stored as null, never as '' — a reversal
     *  compares it against a real ref, and an empty string is a value that could
     *  accidentally be produced on both sides of that comparison. */
    paymentRef: string | null
    /** Stripe PaymentIntent id, when there is one. Kept alongside `payment_ref`
     *  because CoursePurchase declares it and the Connect rail has it; on that
     *  rail the two carry the same value. */
    paymentIntentId?: string | null
  }
): Promise<void> {
  await db
    .collection(COURSES_COLLECTION)
    .doc(grant.courseId)
    .collection(COURSE_PURCHASES_SUBCOLLECTION)
    .doc(grant.contactId)
    .set(
      {
        courseId: grant.courseId,
        teamId: grant.teamId,
        contactId: grant.contactId,
        amount: grant.amount ?? null,
        currency: grant.currency ?? null,
        source: grant.source,
        payment_ref: grant.paymentRef ?? null,
        ...(grant.paymentIntentId !== undefined
          ? { paymentIntentId: grant.paymentIntentId }
          : {}),
        purchasedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
}

export interface ApplyPaymentEffectsInput {
  teamId: string
  contactId: string
  lineItem: PaymentLineItem
  /** Gross amount in minor units (Rappen), or null when unknown. */
  amountRappen: number | null
  currency: string
  /** Rail label for the activity + grant provenance: 'manual' | 'payrexx' | 'stripe' | 'stripe_connect'. */
  source: string
  /** Stable payment reference (doc id) — idempotency key for credits/course. */
  paymentRef: string
}

/**
 * Apply a payment's structured line-item to a contact. Resolves the subscription
 * type/price from Firestore when needed. Safe to call more than once for the same
 * paymentRef (credits + course grants are idempotent; field writes are merges) —
 * but callers should only invoke it on assign / line-item change, not on every
 * comment edit, to avoid duplicate activity-log entries.
 */
export async function applyPaymentEffects(db: Db, input: ApplyPaymentEffectsInput): Promise<void> {
  const { teamId, contactId, lineItem: li, amountRappen, currency, source, paymentRef } = input

  switch (li.kind) {
    case 'subscription': {
      if (!li.subscriptionTypeId) return
      const typeSnap = await db
        .collection(TEAMS_COLLECTION)
        .doc(teamId)
        .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
        .doc(li.subscriptionTypeId)
        .get()
      const type = typeSnap.data() as SubscriptionType | undefined
      const typeName = li.label ?? type?.name ?? null
      const price: SubscriptionPrice | undefined = li.priceId
        ? (type?.prices ?? []).find((p) => p.id === li.priceId)
        : undefined
      const amountMajor =
        amountRappen != null ? Math.round(amountRappen) / 100 : (price?.amount ?? null)

      await stampLastPayment(db, contactId)
      // The grant this payment made (docs/multi-plan-holdings.md), keyed by the
      // payment so a refund ends exactly it.
      await writePaymentPlanGrant(db, contactId, {
        teamId,
        subscriptionTypeId: li.subscriptionTypeId,
        subscriptionTypeName: typeName,
        priceId: li.priceId ?? null,
        recurrence: price?.recurrence ?? null,
        amountMajor,
        expiresAt: planGrantExpiry(price),
        source: planGrantSourceForRail(source),
        paymentRef,
      })
      // Counts toward the price's per-contact purchase cap. Recorded on EVERY
      // rail (a manager's cash entry included), enforced on the self-service one
      // — see the header of payments/planPurchases.ts.
      await recordPlanPurchase(db, contactId, {
        teamId,
        subscriptionTypeId: li.subscriptionTypeId,
        priceId: li.priceId ?? null,
        amountMajor,
        source,
        paymentRef,
      })
      if (price?.credits) {
        await grantPaymentCredits(db, contactId, {
          teamId,
          subscriptionTypeId: li.subscriptionTypeId,
          subscriptionTypeName: typeName,
          priceId: li.priceId ?? null,
          credits: price.credits,
          months: price.included_months ?? 0,
          source,
          paymentRef,
        })
      }
      await logPaymentActivity(db, contactId, {
        type: 'payment_received',
        source,
        message: `Payment · ${typeName ?? 'Membership'}`,
        paymentRef,
      })
      return
    }

    case 'course': {
      if (!li.courseId) return
      const courseSnap = await db.collection(COURSES_COLLECTION).doc(li.courseId).get()
      // Guard: only grant for a course that belongs to this team.
      if (!courseSnap.exists || courseSnap.data()?.teamId !== teamId) return
      const title = (li.label ?? (courseSnap.data()?.title as string | undefined)) ?? 'Course'
      await grantCourseEntitlement(db, {
        teamId,
        courseId: li.courseId,
        contactId,
        amount: amountRappen,
        currency,
        source,
        paymentRef,
      })
      await logPaymentActivity(db, contactId, {
        type: 'course_purchased',
        source,
        message: `Course · ${title}`,
        paymentRef,
      })
      return
    }

    case 'product': {
      await db
        .collection(CONTACTS_COLLECTION)
        .doc(contactId)
        .set({ last_payment_at: FieldValue.serverTimestamp() }, { merge: true })
      await logPaymentActivity(db, contactId, {
        type: 'product_purchased',
        source,
        message: `Product · ${li.label ?? 'Product'}`,
        paymentRef,
      })
      return
    }

    case 'gift_card': {
      // Record-only ON PURPOSE — this branch must never mint a card. The card is
      // minted once by whoever took the money (the Connect webhook, or the
      // manager mint), whereas applyPaymentEffects is re-run every time a manager
      // re-assigns or re-links the payment row: minting here would hand out a
      // fresh code, and a fresh chunk of stored value, on each of those edits.
      await db
        .collection(CONTACTS_COLLECTION)
        .doc(contactId)
        .set({ last_payment_at: FieldValue.serverTimestamp() }, { merge: true })
      await logPaymentActivity(db, contactId, {
        type: 'payment_received',
        source,
        // The label carries the code when the caller knows it ("Gift card GC-…").
        message: li.label ?? 'Gift card',
        paymentRef,
      })
      return
    }

    default: {
      // drop_in | other → record-only.
      await db
        .collection(CONTACTS_COLLECTION)
        .doc(contactId)
        .set({ last_payment_at: FieldValue.serverTimestamp() }, { merge: true })
      await logPaymentActivity(db, contactId, {
        type: 'payment_received',
        source,
        message:
          li.kind === 'drop_in'
            ? 'Drop-in payment'
            : li.kind === 'appointment'
              ? (li.label ?? 'Appointment payment')
              : (li.label ?? 'Payment'),
        paymentRef,
      })
      return
    }
  }
}
