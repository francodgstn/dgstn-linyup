/**
 * The legacy plan slot, imported as a plan grant (docs/multi-plan-holdings.md).
 *
 * ONE implementation, run by the backfill (scripts/backfill-plan-grants.ts),
 * every seeder, and the HMD migration's plan-grants pass — so each of them
 * produces the same rows, and a re-import after the production cutover lands in
 * the same shape as everything else. The row itself is `importedSlotGrantDoc`
 * in packages/functions/src/contacts/planGrants.ts, shared with the demo tenant.
 *
 * ── PER CONTACT ─────────────────────────────────────────────────────────────
 * 1. IMPORT THE SLOT as the grant `import-slot`. Skipped when:
 *      • there is no slot;
 *      • the contact is archived or deleted — its history rows keep the record;
 *      • the slot names a plan the contact already holds as a LIVE Stripe
 *        subscription — the Stripe webhook wrote that value, and the
 *        subscription is in the list in its own right;
 *      • the grant is already there — a second run moves on.
 * 2. REBUILD THE MIRROR through `recomputeHeldPlans`, the one writer of
 *    `held_plans`, so nothing here is a second writer — and a seeder with no
 *    functions emulator running still ends with a correct plan list.
 *
 * Without `apply` nothing is written, and the mirror counts are computed
 * WITHOUT the grants the run would create, so "mirrors changed" is a floor.
 */

import type { firestore } from 'firebase-admin'
import { CONTACTS_COLLECTION } from '@linyup/shared'
import {
  IMPORTED_SLOT_GRANT_ID,
  importedSlotGrantDoc,
  planGrantsCollection,
} from '../../packages/functions/src/contacts/planGrants'
import { recomputeHeldPlans } from '../../packages/functions/src/sync/heldPlans'

export interface PlanGrantImportStats {
  contacts: number
  grantsCreated: number
  grantAlreadyThere: number
  skippedNoSlot: number
  skippedGone: number
  skippedStripeOwned: number
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
    skippedStripeOwned: 0,
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
    const stripeTypes = new Set(
      ((contact.active_subscriptions as Array<{ subscription_type_id?: string }> | undefined) ?? [])
        .map((s) => s?.subscription_type_id)
        .filter(Boolean)
    )
    if (stripeTypes.has(grant.subscription_type_id as string)) {
      stats.skippedStripeOwned++
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

  const result = await recomputeHeldPlans(doc.id, { apply, db })
  if (result.changed) stats.mirrorsChanged++
  else stats.mirrorsUnchanged++
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
    `skipped: slot is Stripe's   ${stats.skippedStripeOwned}`,
    `mirrors changed${would.padEnd(13)}${stats.mirrorsChanged}`,
    `mirrors unchanged           ${stats.mirrorsUnchanged}`,
    `failed                      ${stats.failed}`,
  ]
}
