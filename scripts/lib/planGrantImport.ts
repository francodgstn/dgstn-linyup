/**
 * Plan grants for scripts (docs/multi-plan-holdings.md): the seeders' own plan
 * rows, the plan-list rebuild every seeder and the HMD migration finish with,
 * and the legacy-slot import the backfill runs against data written before the
 * slot was removed.
 *
 * ── SEEDED PLANS ────────────────────────────────────────────────────────────
 * A seeder gives a contact a plan with `seedPlanGrant` — one staff grant, the
 * row the studio's own "Add plan" writes — and never a field on the contact.
 * `rebuildPlanLists` then builds each plan list through `recomputeHeldPlans`,
 * the one writer of `held_plans`, so a seeder with no functions emulator
 * running still ends with a correct list.
 *
 * ── THE LEGACY SLOT, IMPORTED ───────────────────────────────────────────────
 * `importPlanGrants` reads a slot still standing on data written before phase
 * 5 and imports it as the grant `import-slot` (`importedSlotGrantDoc`, in
 * packages/functions/src/contacts/planGrants.ts). Run by the backfill only.
 *
 * ── PER CONTACT ─────────────────────────────────────────────────────────────
 * 1. IMPORT THE SLOT as the grant `import-slot`. Skipped when:
 *      • there is no slot;
 *      • the contact is archived or deleted — its history rows keep the record;
 *      • the slot names a plan the contact's list already holds from the real
 *        stores (typically a LIVE Stripe subscription, whose webhook wrote
 *        that value) — it is in the list in its own right. The contact's
 *        `active_subscriptions` is not asked: see `importOne`;
 *      • the grant is already there — a second run moves on.
 *    Then, for every contact, DROP THE SYNTHETIC `active_subscriptions` ROWS:
 *    rows naming a plan type with no `member_subscriptions` document behind it
 *    at all. That array mirrors live Stripe subscriptions only; the pre-phase-5
 *    HMD migration also wrote one row per imported plan, which a fresh
 *    migration no longer does. A row backed by a subscription document, in any
 *    status, is left alone.
 * 2. REBUILD THE MIRROR through `recomputeHeldPlans`, the one writer of
 *    `held_plans`, so nothing here is a second writer — and a seeder with no
 *    functions emulator running still ends with a correct plan list.
 *
 * Without `apply` nothing is written, and the mirror counts are computed
 * WITHOUT the grants the run would create, so "mirrors changed" is a floor.
 */

import type { firestore } from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { CONTACTS_COLLECTION, MEMBER_SUBSCRIPTIONS_SUBCOLLECTION, TEAMS_COLLECTION } from '@linyup/shared'
import {
  IMPORTED_SLOT_GRANT_ID,
  importedSlotGrantDoc,
  newPlanGrantDoc,
  planGrantsCollection,
} from '../../packages/functions/src/contacts/planGrants'
import { recomputeHeldPlans } from '../../packages/functions/src/sync/heldPlans'

// ─── seeded plans ─────────────────────────────────────────────────────────────

/** The doc id a seeder's plan is written under — one per contact, so a reseed
 *  rewrites it rather than adding a second. */
export const SEED_PLAN_GRANT_ID = 'seed-plan'

export interface SeedPlan {
  teamId: string
  subscriptionTypeId: string
  subscriptionTypeName: string | null
  priceId?: string | null
  recurrence?: string | null
  /** Major units. */
  amount?: number | null
  /** When the plan started; defaults to now. */
  startsAt?: Date | null
  /** Null = no end of its own. */
  expiresAt?: Date | null
}

/** Give a seeded contact a plan: one staff grant under `SEED_PLAN_GRANT_ID`. */
export async function seedPlanGrant(db: firestore.Firestore, contactId: string, plan: SeedPlan): Promise<void> {
  const doc = newPlanGrantDoc(
    plan.teamId,
    {
      subscriptionTypeId: plan.subscriptionTypeId,
      subscriptionTypeName: plan.subscriptionTypeName,
      priceId: plan.priceId ?? null,
      recurrence: plan.recurrence ?? null,
      amountMajor: plan.amount ?? null,
      expiresAt: plan.expiresAt ? Timestamp.fromDate(plan.expiresAt) : null,
    },
    { source: 'staff', sourceRef: null, createdBy: null }
  )
  if (plan.startsAt) doc.starts_at = Timestamp.fromDate(plan.startsAt)
  await planGrantsCollection(db, contactId).doc(SEED_PLAN_GRANT_ID).set(doc)
}

/** The first open grant on each of these contacts, or none — what a fixture
 *  reads to learn which plan a seeder gave somebody. */
export async function seededPlanOf(
  db: firestore.Firestore,
  contactId: string
): Promise<firestore.DocumentData | null> {
  const snap = await planGrantsCollection(db, contactId).get()
  const open = snap.docs.map((d) => d.data()).filter((g) => g.ended_at == null)
  return open[0] ?? null
}

/**
 * Build every plan list — of the named teams, or of the whole database — through
 * `recomputeHeldPlans`. Returns how many lists changed.
 */
export async function rebuildPlanLists(
  db: firestore.Firestore,
  opts: { teamIds?: readonly string[]; concurrency?: number; onError?: (contactId: string, err: unknown) => void } = {}
): Promise<{ contacts: number; changed: number; failed: number }> {
  const ids: string[] = []
  if (opts.teamIds) {
    for (const teamId of opts.teamIds) {
      ids.push(...(await db.collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).select().get()).docs.map((d) => d.id))
    }
  } else {
    ids.push(...(await db.collection(CONTACTS_COLLECTION).select().get()).docs.map((d) => d.id))
  }
  const out = { contacts: ids.length, changed: 0, failed: 0 }
  let next = 0
  await Promise.all(
    Array.from({ length: opts.concurrency ?? 8 }, async () => {
      while (next < ids.length) {
        const id = ids[next++]
        try {
          if ((await recomputeHeldPlans(id, { db })).changed) out.changed++
        } catch (err) {
          out.failed++
          opts.onError?.(id, err)
        }
      }
    })
  )
  return out
}

// ─── the legacy slot, imported (the backfill) ────────────────────────────────

export interface PlanGrantImportStats {
  contacts: number
  grantsCreated: number
  grantAlreadyThere: number
  skippedNoSlot: number
  skippedGone: number
  skippedAlreadyHeld: number
  syntheticRowsDropped: number
  mirrorsChanged: number
  mirrorsUnchanged: number
  failed: number
}

function emptyStats(): PlanGrantImportStats {
  return {
    contacts: 0,
    grantsCreated: 0,
    grantAlreadyThere: 0,
    skippedNoSlot: 0,
    skippedGone: 0,
    skippedAlreadyHeld: 0,
    syntheticRowsDropped: 0,
    mirrorsChanged: 0,
    mirrorsUnchanged: 0,
    failed: 0,
  }
}

async function importOne(
  db: firestore.Firestore,
  doc: firestore.QueryDocumentSnapshot,
  apply: boolean,
  stats: PlanGrantImportStats
): Promise<void> {
  const contact = doc.data() as Record<string, unknown>
  const grant = importedSlotGrantDoc(contact)

  if (!grant) {
    stats.skippedNoSlot++
  } else if (contact.archived_at || contact.deleted_at) {
    stats.skippedGone++
  } else {
    // Asked of the plan list built from the real stores, NOT of the contact's
    // `active_subscriptions`: the HMD migration before phase 5 wrote a synthetic
    // row there for every imported plan (no Stripe subscription behind it), and
    // reading those as Stripe's skipped exactly the plans the import exists for.
    const held = await recomputeHeldPlans(doc.id, { apply: false, db })
    const heldTypes = new Set(held.mirror?.held_plan_type_ids ?? [])
    if (heldTypes.has(grant.subscription_type_id as string)) {
      stats.skippedAlreadyHeld++
    } else {
      const ref = planGrantsCollection(db, doc.id).doc(IMPORTED_SLOT_GRANT_ID)
      if ((await ref.get()).exists) {
        stats.grantAlreadyThere++
      } else {
        stats.grantsCreated++
        if (apply) await ref.create(grant)
      }
    }
  }
  await dropSyntheticRows(db, doc, contact, apply, stats)

  const result = await recomputeHeldPlans(doc.id, { apply, db })
  if (result.changed) stats.mirrorsChanged++
  else stats.mirrorsUnchanged++
}

/** See the header, step 1. */
async function dropSyntheticRows(
  db: firestore.Firestore,
  doc: firestore.QueryDocumentSnapshot,
  contact: Record<string, unknown>,
  apply: boolean,
  stats: PlanGrantImportStats
): Promise<void> {
  const rows = (contact.active_subscriptions as Array<{ subscription_type_id?: string }> | undefined) ?? []
  if (!rows.length || typeof contact.teamId !== 'string') return
  const subs = await db
    .collection(TEAMS_COLLECTION)
    .doc(contact.teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .where('contactId', '==', doc.id)
    .get()
  const backed = new Set(subs.docs.map((d) => d.get('subscriptionTypeId') ?? d.get('subscription_type_id')))
  const kept = rows.filter((r) => backed.has(r?.subscription_type_id))
  if (kept.length === rows.length) return
  stats.syntheticRowsDropped += rows.length - kept.length
  if (apply) await doc.ref.update({ active_subscriptions: kept })
}

/**
 * Import every contact's slot — of the named teams, or of the whole database
 * when `teamIds` is omitted — and rebuild each plan list.
 */
export async function importPlanGrants(
  db: firestore.Firestore,
  opts: {
    teamIds?: readonly string[]
    apply: boolean
    concurrency?: number
    onError?: (contactId: string, err: unknown) => void
  }
): Promise<PlanGrantImportStats> {
  const stats = emptyStats()
  const docs: firestore.QueryDocumentSnapshot[] = []
  if (opts.teamIds) {
    for (const teamId of opts.teamIds) {
      docs.push(...(await db.collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).get()).docs)
    }
  } else {
    docs.push(...(await db.collection(CONTACTS_COLLECTION).get()).docs)
  }
  stats.contacts = docs.length

  let next = 0
  await Promise.all(
    Array.from({ length: opts.concurrency ?? 8 }, async () => {
      while (next < docs.length) {
        const doc = docs[next++]
        try {
          await importOne(db, doc, opts.apply, stats)
        } catch (err) {
          stats.failed++
          opts.onError?.(doc.id, err)
        }
      }
    })
  )
  return stats
}

/** The stats as report lines, for a script's console. */
export function formatPlanGrantImportStats(stats: PlanGrantImportStats, apply: boolean): string[] {
  const would = apply ? '' : ' (would)'
  return [
    `contacts scanned            ${stats.contacts}`,
    `grants created${would.padEnd(14)}${stats.grantsCreated}`,
    `grant already there         ${stats.grantAlreadyThere}`,
    `skipped: no slot            ${stats.skippedNoSlot}`,
    `skipped: archived/deleted   ${stats.skippedGone}`,
    `skipped: already held       ${stats.skippedAlreadyHeld}`,
    `${`synthetic rows dropped${would}`.padEnd(27)} ${stats.syntheticRowsDropped}`,
    `mirrors changed${would.padEnd(13)}${stats.mirrorsChanged}`,
    `mirrors unchanged           ${stats.mirrorsUnchanged}`,
    `failed                      ${stats.failed}`,
  ]
}
