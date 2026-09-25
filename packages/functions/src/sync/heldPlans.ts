// ─── Plan holdings: the ONE writer of Contact.held_plans ─────────────────────
//
// docs/multi-plan-holdings.md, phase 1. A contact's plans come from three
// stores — plan grants, Stripe member subscriptions and credit grants — and the
// contact carries one mirror of all three: `held_plans`, the flat
// `held_plan_type_ids`, and `held_plans_next_change_at_ms`. `recomputeHeldPlans`
// is the only writer of those three fields. The rules deny them to every
// client, and the triggers below run it whenever any of the stores is written.
//
// ── ITS OWN TRIGGERS, NOT A CALL IN THE EXISTING ONES ───────────────────────
// The credit-grant and member-subscription triggers stay exactly as they were.
// This module imports `buildCreditSummary` from the credit-grant trigger's
// module, so calling back from there would be an import cycle; a second
// trigger on the same path costs nothing a cycle would not.
//
// ── READ AND WRITTEN IN ONE TRANSACTION ─────────────────────────────────────
// Two stores written at the same moment must not land a mirror built from a
// stale read over a fresher one. It writes the three fields whole and only when
// they differ, compared by value with sorted keys: Firestore does not preserve
// map key order, and a naive JSON compare would rewrite an unchanged mirror on
// every event.
//
// ── WHEN A DATE SIMPLY PASSES ───────────────────────────────────────────────
// A grant ending or starting, or a credit pack expiring, is not a write, so no
// trigger here fires. The daily `refreshHeldPlans` job
// (dailyTasks/refreshHeldPlans.ts) recomputes every contact whose
// `held_plans_next_change_at_ms` has passed — which matters to the security
// rules, the one reader that cannot compare dates per list element. The import
// backfill (scripts/backfill-plan-grants.ts) calls this same function, so there
// is never a second writer.

import * as admin from 'firebase-admin'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import {
  CONTACTS_COLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  CONTACT_PLAN_GRANTS_SUBCOLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  buildHeldPlans,
  type CreditGrant,
  type HeldPlanMemberSubscriptionInput,
  type HeldPlansMirror,
  type PlanGrantInput,
} from '@linyup/shared'
import { buildCreditSummary } from './onCreditGrantWrite'

/** Sorted-key serialization, so a mirror read back from Firestore compares equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export interface RecomputeResult {
  /** The contact document does not exist. */
  missing: boolean
  /** The mirror differs from what the contact carries (and was written, when applying). */
  changed: boolean
  mirror: HeldPlansMirror | null
}

/**
 * Rebuild one contact's plan list from the three stores and write it.
 * `apply: false` computes and compares without writing — the backfill's dry run.
 */
export async function recomputeHeldPlans(
  contactId: string,
  opts: {
    nowMs?: number
    apply?: boolean
    /** A script holding more than one app (the HMD migration) names its target. */
    db?: admin.firestore.Firestore
  } = {}
): Promise<RecomputeResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const apply = opts.apply ?? true
  const db = opts.db ?? admin.firestore()
  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)

  return db.runTransaction(async (tx) => {
    const contactSnap = await tx.get(contactRef)
    if (!contactSnap.exists) return { missing: true, changed: false, mirror: null }
    const contact = contactSnap.data() ?? {}
    const teamId = typeof contact.teamId === 'string' ? contact.teamId : null

    const [grantsSnap, creditSnap, subsSnap] = await Promise.all([
      tx.get(contactRef.collection(CONTACT_PLAN_GRANTS_SUBCOLLECTION)),
      tx.get(contactRef.collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)),
      // Scoped to the contact's OWN team, so a subscription document in another
      // tenant naming this contact id never counts.
      teamId
        ? tx.get(
            db
              .collection(TEAMS_COLLECTION)
              .doc(teamId)
              .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
              .where('contactId', '==', contactId)
          )
        : Promise.resolve(null),
    ])

    const mirror = buildHeldPlans({
      grants: grantsSnap.docs.map((d) => ({ ...(d.data() as Omit<PlanGrantInput, 'id'>), id: d.id })),
      memberSubscriptions: (subsSnap?.docs ?? []).map((d) => {
        const data = d.data() as HeldPlanMemberSubscriptionInput
        return { ...data, subscriptionId: data.subscriptionId || d.id }
      }),
      creditSummary: buildCreditSummary(
        creditSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as CreditGrant),
        new Date(nowMs)
      ),
      nowMs,
    })

    const current = {
      held_plans: contact.held_plans ?? null,
      held_plan_type_ids: contact.held_plan_type_ids ?? null,
      held_plans_next_change_at_ms: contact.held_plans_next_change_at_ms ?? null,
    }
    if (stable(current) === stable(mirror)) return { missing: false, changed: false, mirror }
    if (apply) tx.update(contactRef, { ...mirror })
    return { missing: false, changed: true, mirror }
  })
}

async function recomputeLogged(contactId: string, cause: string): Promise<void> {
  try {
    await recomputeHeldPlans(contactId)
  } catch (err) {
    console.error(`[heldPlans] recompute failed for ${contactId} after a ${cause} write:`, err) // eslint-disable-line no-console
  }
}

export const onPlanGrantWrite = onDocumentWritten(
  `${CONTACTS_COLLECTION}/{contactId}/${CONTACT_PLAN_GRANTS_SUBCOLLECTION}/{grantId}`,
  async (event) => {
    await recomputeLogged(event.params.contactId, 'plan grant')
  }
)

export const heldPlansOnCreditGrantWrite = onDocumentWritten(
  `${CONTACTS_COLLECTION}/{contactId}/${CONTACT_CREDIT_GRANTS_SUBCOLLECTION}/{grantId}`,
  async (event) => {
    await recomputeLogged(event.params.contactId, 'credit grant')
  }
)

export const heldPlansOnMemberSubscriptionWrite = onDocumentWritten(
  `${TEAMS_COLLECTION}/{teamId}/${MEMBER_SUBSCRIPTIONS_SUBCOLLECTION}/{subscriptionId}`,
  async (event) => {
    // Both sides: a subscription reassigned to another contact changes two lists.
    const ids = new Set(
      [event.data?.before?.data()?.contactId, event.data?.after?.data()?.contactId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      )
    )
    for (const id of ids) await recomputeLogged(id, 'member subscription')
  }
)
