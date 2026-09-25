// ─── Plan grants: the ONE writer of contacts/{c}/plan_grants ──────────────────
//
// docs/multi-plan-holdings.md, phase 2. A grant is every holding that is not a
// Stripe subscription or a credit pack: assigned by staff, bought one-off, paid
// through the studio's own gateway, or imported from the legacy slot. Every
// code path that creates or ends a grant goes through this module; the rules
// deny every client write, and `recomputeHeldPlans` (sync/heldPlans.ts) folds
// the rows into `Contact.held_plans` from its plan-grant trigger.
//
// ── ROWS ARE EVENTS ──────────────────────────────────────────────────────────
// A grant is never edited into a different plan. Ending one sets `ended_at` and
// `ended_reason`; changing one ends it and creates another. The one exception
// is a CORRECTION of the payment that made it: a manager re-linking a payment
// to a different plan rewrites that payment's own grant, because the purchase
// never was the old plan.
//
// ── DOC IDS ──────────────────────────────────────────────────────────────────
// A payment's grant is keyed by the payment doc id — the id a reversal already
// reaches every other target by — so a redelivered webhook, a second event about
// the same charge and a later manual assignment of an unassigned gateway payment
// all converge on one row, and a refund finds it without a query. Staff grants
// take an auto id or a sanitized idempotency key; the legacy slot's import takes
// IMPORTED_SLOT_GRANT_ID.
//
// ── THE BRIDGE ───────────────────────────────────────────────────────────────
// Until phase 3 moves the readers (course rules, booking access, displays) onto
// the mirror, every caller of this module ALSO keeps writing the legacy
// `subscription_type_*` slot it wrote before. That is a bridge, not a derived
// primary: nothing computes the slot from the grants, and phase 5 deletes it.
// The census of slot writers is contacts/legacyPlanSlot.test.ts.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import type { firestore } from 'firebase-admin'
import {
  CONTACTS_COLLECTION,
  CONTACT_PLAN_GRANTS_SUBCOLLECTION,
  type PlanGrantEndedReason,
  type PlanGrantSource,
} from '@linyup/shared'

type Db = firestore.Firestore

export function planGrantsCollection(db: Db, contactId: string): firestore.CollectionReference {
  return db.collection(CONTACTS_COLLECTION).doc(contactId).collection(CONTACT_PLAN_GRANTS_SUBCOLLECTION)
}

/** What a grant gives: the plan, its price and its own end. */
export interface PlanGrantPlan {
  subscriptionTypeId: string
  subscriptionTypeName: string | null
  priceId: string | null
  recurrence: string | null
  /** Major units. */
  amountMajor: number | null
  /** Null = no end of its own. */
  expiresAt: Timestamp | null
}

export interface PlanGrantOrigin {
  source: PlanGrantSource
  /** The payment doc id that created it, or null. */
  sourceRef: string | null
  /** uid, or null for a payment rail. */
  createdBy: string | null
}

/**
 * A payment rail's label, as `applyPaymentEffects` receives it, to the grant's
 * source. The studio's own gateways are 'gateway'; everything else that took
 * money — a manual cash or bank entry, a Connect purchase — is 'purchase'.
 */
export function planGrantSourceForRail(rail: string): PlanGrantSource {
  return rail === 'payrexx' || rail === 'stripe' || rail === 'byo' ? 'gateway' : 'purchase'
}

/**
 * A new grant row, whole. `starts_at` is THIS process's clock rather than the
 * server's: `recomputeHeldPlans` compares it with `Date.now()`, and a start a
 * few milliseconds in its future would read as a grant that has not begun.
 */
export function newPlanGrantDoc(
  teamId: string,
  plan: PlanGrantPlan,
  origin: PlanGrantOrigin
): Record<string, unknown> {
  return {
    teamId,
    subscription_type_id: plan.subscriptionTypeId,
    subscription_type_name: plan.subscriptionTypeName,
    price_id: plan.priceId,
    recurrence: plan.recurrence,
    amount: plan.amountMajor,
    source: origin.source,
    source_ref: origin.sourceRef,
    starts_at: Timestamp.now(),
    expires_at: plan.expiresAt,
    ended_at: null,
    ended_reason: null,
    created_by: origin.createdBy,
    created_at: FieldValue.serverTimestamp(),
  }
}

/**
 * Is this row still open: not ended, and not past its own expiry. A grant that
 * has not started yet is open — it is still going to be held — which is what
 * "end every current plan" has to reach.
 */
export function planGrantIsOpen(
  grant: { ended_at?: unknown; expires_at?: unknown },
  nowMs: number
): boolean {
  if (grant.ended_at != null) return false
  const expires = grant.expires_at as { toMillis?: () => number } | null | undefined
  const end = expires && typeof expires.toMillis === 'function' ? expires.toMillis() : null
  return end === null || end > nowMs
}

/** WHICH plan a payment bought. A re-apply that changes neither is no change. */
function samePlan(stored: Record<string, unknown>, plan: PlanGrantPlan): boolean {
  return (
    stored.subscription_type_id === plan.subscriptionTypeId &&
    ((stored.price_id as string | null | undefined) ?? null) === plan.priceId
  )
}

export interface PaymentPlanGrantInput extends PlanGrantPlan {
  teamId: string
  source: PlanGrantSource
  /** The payment doc id — and therefore the grant's doc id. */
  paymentRef: string
}

export type PaymentPlanGrantResult = 'created' | 'corrected' | 'unchanged' | 'ended'

/**
 * The grant a payment made. Creates it; a second event about the same payment
 * finds it and changes nothing; a manager re-linking the payment to a different
 * plan corrects it in place. A grant already ended — refunded, or ended by
 * staff — is never revived by a re-apply: the studio ended it for a reason this
 * call cannot see.
 *
 * Not a transaction, on purpose: `create()` is the guard against two events for
 * one charge racing, and the correction writes the same values whichever call
 * lands it.
 */
export async function writePaymentPlanGrant(
  db: Db,
  contactId: string,
  input: PaymentPlanGrantInput
): Promise<PaymentPlanGrantResult> {
  const ref = planGrantsCollection(db, contactId).doc(input.paymentRef)
  const snap = await ref.get()
  if (!snap.exists) {
    try {
      await ref.create(
        newPlanGrantDoc(input.teamId, input, {
          source: input.source,
          sourceRef: input.paymentRef,
          createdBy: null,
        })
      )
      return 'created'
    } catch (err: unknown) {
      // ALREADY_EXISTS (code 6): the sibling event for the same charge won.
      if ((err as { code?: number }).code === 6) return 'unchanged'
      throw err
    }
  }
  const stored = snap.data() ?? {}
  if (stored.ended_at != null) return 'ended'
  if (samePlan(stored, input)) return 'unchanged'
  await ref.set(
    {
      subscription_type_id: input.subscriptionTypeId,
      subscription_type_name: input.subscriptionTypeName,
      price_id: input.priceId,
      recurrence: input.recurrence,
      amount: input.amountMajor,
      expires_at: input.expiresAt,
      corrected_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
  return 'corrected'
}

/**
 * The same row for a rail that already runs a transaction (the own-gateway
 * webhooks): read `ref` in the read phase, then call this in the write phase.
 * `tx.set` on an absent row, nothing on a present one — never `create()`, whose
 * collision would fail the whole commit and take the payment record with it.
 */
export function setPaymentPlanGrantInTx(
  tx: firestore.Transaction,
  ref: firestore.DocumentReference,
  snap: { exists: boolean },
  input: PaymentPlanGrantInput
): boolean {
  if (snap.exists) return false
  tx.set(
    ref,
    newPlanGrantDoc(input.teamId, input, {
      source: input.source,
      sourceRef: input.paymentRef,
      createdBy: null,
    })
  )
  return true
}

/** End a grant inside a transaction. The row stays: it is the record. */
export function endPlanGrantInTx(
  tx: firestore.Transaction,
  ref: firestore.DocumentReference,
  reason: PlanGrantEndedReason,
  endedBy: string | null
): void {
  tx.update(ref, {
    ended_at: FieldValue.serverTimestamp(),
    ended_reason: reason,
    ended_by: endedBy,
  })
}

// ─── the legacy slot, imported ────────────────────────────────────────────────

/** The doc id a contact's legacy slot is imported under — one per contact, so a
 *  second import finds it and moves on. */
export const IMPORTED_SLOT_GRANT_ID = 'import-slot'

/**
 * A contact's legacy slot as a grant row, or null when the contact has no slot.
 * The start is the slot's last change, else the contact's creation. Shared by
 * the phase 1 backfill, the seeders, the HMD migration and the demo tenant, so
 * every one of them produces the same row. WHICH contacts to import (archived,
 * deleted, a slot that duplicates a live Stripe subscription) is the caller's
 * question — see scripts/lib/planGrantImport.ts.
 */
export function importedSlotGrantDoc(contact: Record<string, unknown>): Record<string, unknown> | null {
  const typeId =
    typeof contact.subscription_type_id === 'string' ? contact.subscription_type_id.trim() : ''
  if (!typeId) return null
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    teamId: contact.teamId ?? null,
    subscription_type_id: typeId,
    subscription_type_name: str(contact.subscription_type_name),
    price_id: str(contact.subscription_price_id),
    recurrence: str(contact.subscription_recurrence),
    amount: typeof contact.subscription_amount === 'number' ? contact.subscription_amount : null,
    source: 'import',
    source_ref: str(contact.subscription_source_ref),
    starts_at: contact.subscription_type_updated_at ?? contact.created_at ?? Timestamp.now(),
    expires_at: contact.subscription_expires_at ?? null,
    ended_at: null,
    ended_reason: null,
    created_by: null,
    created_at: FieldValue.serverTimestamp(),
  }
}
