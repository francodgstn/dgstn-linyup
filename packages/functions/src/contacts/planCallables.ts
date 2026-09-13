// ─── Staff plan callables: assignPlan, changePlan, endPlan ───────────────────
//
// docs/multi-plan-holdings.md, phase 2. These replace the browser's direct
// writes to the contact's plan slot — the contact page's plan dialog and the
// contacts list's bulk assign — which the rules now refuse. Every grant write
// goes through contacts/planGrants.ts.
//
// ── WHO MAY CALL ─────────────────────────────────────────────────────────────
// A client write that moves behind a callable stops being gated by the rules,
// so this re-asks exactly what the rules asked: `canWriteContact` — the
// `contacts.manage` capability, and for an own-scoped coach a contact of their
// own — or the platform admin role.
//
// ── THE BRIDGE ───────────────────────────────────────────────────────────────
// Each call also writes the legacy slot the dialog used to write (see the
// header of planGrants.ts): assign and change set it to the plan just given,
// and ending clears it when nothing open still holds that plan. The slot write
// carries `subscription_source_ref: null` — nobody paid, so no refund may
// clear it — and never `last_payment_at`.
//
// ── NOT HERE ─────────────────────────────────────────────────────────────────
// Stopping Stripe billing stays `cancelMemberSubscription`, which already names
// one subscription. The per-plan card that asks it for the right one is phase 4.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type Contact,
  type SubscriptionPrice,
  type SubscriptionType,
} from '@linyup/shared'
import { callerIsAllScoped, hasCapability, isAdmin } from '../utils/teams'
import { planGrantExpiry } from '../payments/effects'
import { coachOwnsContact } from './aiSummaryDossier'
import {
  endPlanGrantInTx,
  newPlanGrantDoc,
  planGrantIsOpen,
  planGrantsCollection,
  type PlanGrantPlan,
} from './planGrants'

type Db = admin.firestore.Firestore

// ─── the bridge, pure ─────────────────────────────────────────────────────────

/** The legacy slot for a plan staff just gave: the whole record, nulls
 *  included, and no `last_payment_at`. */
export function slotFieldsForStaffPlan(plan: PlanGrantPlan): Record<string, unknown> {
  return {
    subscription_type_id: plan.subscriptionTypeId,
    subscription_type_name: plan.subscriptionTypeName,
    subscription_price_id: plan.priceId,
    subscription_recurrence: plan.recurrence,
    subscription_amount: plan.amountMajor,
    subscription_source_ref: null,
    subscription_expires_at: plan.expiresAt,
    subscription_type_updated_at: FieldValue.serverTimestamp(),
  }
}

/** The legacy slot emptied, as the dialog's "clear" wrote it. */
export function clearedSlotFields(): Record<string, unknown> {
  return {
    subscription_type_id: null,
    subscription_type_name: null,
    subscription_price_id: null,
    subscription_recurrence: null,
    subscription_amount: null,
    subscription_source_ref: null,
    subscription_expires_at: null,
    subscription_type_updated_at: FieldValue.serverTimestamp(),
  }
}

/**
 * Does ending these grants empty the slot? Ending EVERY current plan does, as
 * the dialog's clear always did. Ending one does only when the slot names its
 * plan and no other open grant still holds that plan (decision D4: two grants
 * of one type may coexist).
 */
export function shouldClearSlot(input: {
  allCurrent: boolean
  slotTypeId: string | null
  endedTypeIds: readonly string[]
  openTypeIdsAfter: readonly string[]
}): boolean {
  if (!input.slotTypeId) return false
  if (input.allCurrent) return true
  return (
    input.endedTypeIds.includes(input.slotTypeId) && !input.openTypeIdsAfter.includes(input.slotTypeId)
  )
}

// ─── shared checks ────────────────────────────────────────────────────────────

/** The rules' `canWriteContact(resource) || hasRole('admin')`, server-side. */
export async function mayWriteContactPlans(
  uid: string,
  teamId: string,
  contact: Record<string, unknown>
): Promise<boolean> {
  if (await isAdmin(uid)) return true
  if (!(await hasCapability(uid, teamId, 'contacts.manage'))) return false
  if (await callerIsAllScoped(uid, teamId)) return true
  return coachOwnsContact(contact as Pick<Contact, 'assigned_coach_ids' | 'createdBy'>, uid)
}

interface StaffContext {
  db: Db
  uid: string
  contactId: string
  contactRef: admin.firestore.DocumentReference
  teamId: string
}

async function staffContext(request: CallableRequest, contactId: unknown): Promise<StaffContext> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.')
  if (typeof contactId !== 'string' || !contactId) {
    throw new HttpsError('invalid-argument', 'contactId is required.')
  }
  const db = admin.firestore()
  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const snap = await contactRef.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Contact not found.')
  const contact = snap.data() ?? {}
  const teamId = typeof contact.teamId === 'string' ? contact.teamId : null
  if (!teamId) throw new HttpsError('failed-precondition', 'Contact is not associated with a team.')
  const uid = request.auth.uid
  if (!(await mayWriteContactPlans(uid, teamId, contact))) {
    throw new HttpsError('permission-denied', "You do not have permission to change this contact's plans.")
  }
  return { db, uid, contactId, contactRef, teamId }
}

/** The plan a staff call names, resolved against the studio's own catalogue. */
async function resolvePlan(
  db: Db,
  teamId: string,
  data: { subscriptionTypeId?: unknown; priceId?: unknown; recurrence?: unknown }
): Promise<PlanGrantPlan> {
  const typeId = typeof data.subscriptionTypeId === 'string' ? data.subscriptionTypeId.trim() : ''
  if (!typeId) throw new HttpsError('invalid-argument', 'subscriptionTypeId is required.')
  const typeSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .doc(typeId)
    .get()
  if (!typeSnap.exists) throw new HttpsError('not-found', 'Subscription type not found.')
  const type = typeSnap.data() as SubscriptionType
  const priceId = typeof data.priceId === 'string' && data.priceId ? data.priceId : null
  const price: SubscriptionPrice | undefined = priceId
    ? (type.prices ?? []).find((p) => p.id === priceId)
    : undefined
  if (priceId && !price) throw new HttpsError('not-found', 'Price not found on this type.')
  const recurrence = price
    ? price.recurrence
    : typeof data.recurrence === 'string' && data.recurrence
      ? data.recurrence.slice(0, 32)
      : null
  return {
    subscriptionTypeId: typeId,
    subscriptionTypeName: type.name ?? null,
    priceId: price?.id ?? null,
    recurrence: recurrence ?? null,
    amountMajor: price?.amount ?? null,
    expiresAt: planGrantExpiry(price),
  }
}

/** A client idempotency key becomes a DOCUMENT ID, so only characters that
 *  cannot change the path survive (a '/' would address another collection). */
function sanitiseKey(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 120) : ''
}

// ─── the callables ────────────────────────────────────────────────────────────

/**
 * Give a contact a plan. Adds by default — a member may hold several plans.
 * `replace: true` first ends every open grant (reason 'changed'), which is what
 * the contact page's single-plan dialog means by saving.
 */
export const assignPlan = onCall(async (request) => {
  const data = (request.data ?? {}) as {
    contactId?: unknown
    subscriptionTypeId?: unknown
    priceId?: unknown
    recurrence?: unknown
    replace?: unknown
    idempotencyKey?: unknown
  }
  const ctx = await staffContext(request, data.contactId)
  const plan = await resolvePlan(ctx.db, ctx.teamId, data)
  const grants = planGrantsCollection(ctx.db, ctx.contactId)
  const key = sanitiseKey(data.idempotencyKey)
  const newRef = key ? grants.doc(key) : grants.doc()
  const replace = data.replace === true
  const nowMs = Date.now()

  return ctx.db.runTransaction(async (tx) => {
    // Reads first, all of them.
    const existing = key ? await tx.get(newRef) : null
    if (existing?.exists) return { grantId: newRef.id, duplicate: true, ended: [] as string[] }
    const open = replace
      ? (await tx.get(grants)).docs.filter((d) => planGrantIsOpen(d.data(), nowMs))
      : []

    for (const d of open) endPlanGrantInTx(tx, d.ref, 'changed', ctx.uid)
    tx.set(newRef, newPlanGrantDoc(ctx.teamId, plan, { source: 'staff', sourceRef: null, createdBy: ctx.uid }))
    tx.update(ctx.contactRef, {
      ...slotFieldsForStaffPlan(plan),
      // Assigning a plan materialises a provisional lead (offline-paid members
      // count toward the cap too). See Contact.provisional.
      provisional: FieldValue.delete(),
      provisional_expires_at: FieldValue.delete(),
    })
    return { grantId: newRef.id, duplicate: false, ended: open.map((d) => d.id) }
  })
})

/** End one open grant and give its replacement, in one commit. */
export const changePlan = onCall(async (request) => {
  const data = (request.data ?? {}) as {
    contactId?: unknown
    grantId?: unknown
    subscriptionTypeId?: unknown
    priceId?: unknown
    recurrence?: unknown
  }
  const ctx = await staffContext(request, data.contactId)
  const grantId = typeof data.grantId === 'string' ? data.grantId : ''
  if (!grantId) throw new HttpsError('invalid-argument', 'grantId is required.')
  const plan = await resolvePlan(ctx.db, ctx.teamId, data)
  const grants = planGrantsCollection(ctx.db, ctx.contactId)
  const oldRef = grants.doc(grantId)
  const newRef = grants.doc()

  return ctx.db.runTransaction(async (tx) => {
    const old = await tx.get(oldRef)
    if (!old.exists) throw new HttpsError('not-found', 'Plan not found.')
    if (!planGrantIsOpen(old.data() ?? {}, Date.now())) {
      throw new HttpsError('failed-precondition', 'This plan has already ended.')
    }
    endPlanGrantInTx(tx, oldRef, 'changed', ctx.uid)
    tx.set(newRef, newPlanGrantDoc(ctx.teamId, plan, { source: 'staff', sourceRef: null, createdBy: ctx.uid }))
    tx.update(ctx.contactRef, slotFieldsForStaffPlan(plan))
    return { grantId: newRef.id, ended: [grantId] }
  })
})

/**
 * End a contact's plan: one grant by id, or every open grant with
 * `allCurrent: true` (the dialog's clear). Ending an already-ended grant is a
 * no-op, not an error — a double click lands here.
 */
export const endPlan = onCall(async (request) => {
  const data = (request.data ?? {}) as { contactId?: unknown; grantId?: unknown; allCurrent?: unknown }
  const ctx = await staffContext(request, data.contactId)
  const grantId = typeof data.grantId === 'string' && data.grantId ? data.grantId : null
  const allCurrent = data.allCurrent === true
  if (Boolean(grantId) === allCurrent) {
    throw new HttpsError('invalid-argument', 'Name one grantId, or pass allCurrent: true.')
  }
  const grants = planGrantsCollection(ctx.db, ctx.contactId)
  const nowMs = Date.now()

  return ctx.db.runTransaction(async (tx) => {
    const contactSnap = await tx.get(ctx.contactRef)
    const docs = (await tx.get(grants)).docs
    const open = docs.filter((d) => planGrantIsOpen(d.data(), nowMs))

    let targets = open
    if (grantId) {
      const target = docs.find((d) => d.id === grantId)
      if (!target) throw new HttpsError('not-found', 'Plan not found.')
      targets = open.filter((d) => d.id === grantId)
    }
    for (const d of targets) endPlanGrantInTx(tx, d.ref, 'staff', ctx.uid)

    const endedIds = new Set(targets.map((d) => d.id))
    const typeOf = (d: admin.firestore.QueryDocumentSnapshot) => String(d.data().subscription_type_id ?? '')
    const slotTypeId = (contactSnap.data()?.subscription_type_id as string | null | undefined) ?? null
    const slotCleared = shouldClearSlot({
      allCurrent,
      slotTypeId,
      endedTypeIds: targets.map(typeOf),
      openTypeIdsAfter: open.filter((d) => !endedIds.has(d.id)).map(typeOf),
    })
    if (slotCleared) tx.update(ctx.contactRef, clearedSlotFields())
    return { ended: [...endedIds], slotCleared }
  })
})
