/**
 * Multi-plan holdings, phase 1: give every contact a plan list.
 *
 * ── WHY IT IS NEEDED ────────────────────────────────────────────────────────
 * docs/multi-plan-holdings.md moves a contact's non-Stripe plan out of the
 * single `subscription_type_*` slot and into `contacts/{c}/plan_grants`, and
 * folds every store into one mirror on the contact, `held_plans`. The triggers
 * that keep the mirror only fire on a write AFTER they are deployed, so every
 * contact that exists today has neither a grant for its slot nor a mirror.
 *
 * ── WHAT IT DOES, PER CONTACT ───────────────────────────────────────────────
 * 1. IMPORT THE SLOT AS A GRANT, with the fixed id `import-slot` (so a second
 *    run finds it and moves on), `source: 'import'`, and the slot's own type,
 *    name, price, recurrence, amount, expiry and payment ref. The start is the
 *    slot's last update, else the contact's creation. Skipped when:
 *      • there is no slot;
 *      • the contact is archived or deleted — its history rows keep the record;
 *      • the slot names a type the contact already holds as a LIVE Stripe
 *        subscription — that value was written by the Stripe webhook, and the
 *        subscription is already in the list in its own right.
 * 2. REBUILD THE MIRROR through `recomputeHeldPlans`, the same function the
 *    triggers run, so this script is never a second writer of `held_plans`.
 *
 * ── DRY RUN ─────────────────────────────────────────────────────────────────
 * Without --apply nothing is written. The mirror counts are then computed
 * WITHOUT the grants the run would create, so "mirrors to write" is a floor.
 *
 * DEPLOY ORDER: rules, then functions (so the plan-grant trigger is live), then
 * this. Nothing reads the new fields before phase 3, so running it late costs
 * nothing but a stale mirror nobody looks at.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other backfills.
 * Against the emulator, set FIRESTORE_EMULATOR_HOST and use the demo project.
 *
 * Usage:
 *   pnpm backfill:plan-grants --project linyup-staging [--team t1] [--apply]
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { CONTACTS_COLLECTION, CONTACT_PLAN_GRANTS_SUBCOLLECTION } from '@linyup/shared'
import { recomputeHeldPlans } from '../packages/functions/src/sync/heldPlans'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    team: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error(
    '❌ --project is required (e.g. --project linyup-staging, or demo-linyup for the emulator)'
  )
  process.exit(1)
}

admin.initializeApp({ credential: applicationDefault(), projectId: values.project })
const db = admin.firestore()

/** One per contact: the import of its legacy slot. */
const IMPORT_GRANT_ID = 'import-slot'
const CONCURRENCY = 8

const stats = {
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

type ContactData = Record<string, unknown>

function grantFromSlot(c: ContactData, typeId: string): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    teamId: c.teamId,
    subscription_type_id: typeId,
    subscription_type_name: str(c.subscription_type_name),
    price_id: str(c.subscription_price_id),
    recurrence: str(c.subscription_recurrence),
    amount: typeof c.subscription_amount === 'number' ? c.subscription_amount : null,
    source: 'import',
    source_ref: str(c.subscription_source_ref),
    starts_at:
      (c.subscription_type_updated_at as Timestamp | undefined) ??
      (c.created_at as Timestamp | undefined) ??
      Timestamp.now(),
    expires_at: (c.subscription_expires_at as Timestamp | null | undefined) ?? null,
    ended_at: null,
    ended_reason: null,
    created_by: null,
    created_at: FieldValue.serverTimestamp(),
  }
}

async function processContact(doc: admin.firestore.QueryDocumentSnapshot): Promise<void> {
  const c = doc.data() as ContactData
  const typeId = typeof c.subscription_type_id === 'string' ? c.subscription_type_id.trim() : ''

  if (!typeId) {
    stats.skippedNoSlot++
  } else if (c.archived_at || c.deleted_at) {
    stats.skippedGone++
  } else {
    const stripeTypes = new Set(
      ((c.active_subscriptions as Array<{ subscription_type_id?: string }> | undefined) ?? [])
        .map((s) => s?.subscription_type_id)
        .filter(Boolean)
    )
    if (stripeTypes.has(typeId)) {
      stats.skippedStripeOwned++
    } else {
      const ref = doc.ref.collection(CONTACT_PLAN_GRANTS_SUBCOLLECTION).doc(IMPORT_GRANT_ID)
      if ((await ref.get()).exists) {
        stats.grantAlreadyThere++
      } else {
        stats.grantsCreated++
        if (values.apply) await ref.create(grantFromSlot(c, typeId))
      }
    }
  }

  const result = await recomputeHeldPlans(doc.id, { apply: values.apply })
  if (result.changed) stats.mirrorsChanged++
  else stats.mirrorsUnchanged++
}

async function main(): Promise<void> {
  console.log(
    `\n🔧 plan-grants backfill on '${values.project}'${values.team ? ` (team ${values.team})` : ''} ${values.apply ? '(APPLY)' : '(dry run)'}\n`
  )

  let query: admin.firestore.Query = db.collection(CONTACTS_COLLECTION)
  if (values.team) query = query.where('teamId', '==', values.team)
  const docs = (await query.get()).docs
  stats.contacts = docs.length

  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < docs.length) {
        const doc = docs[next++]
        try {
          await processContact(doc)
        } catch (err) {
          stats.failed++
          console.error(`  ✗ ${doc.id}:`, (err as Error).message)
        }
      }
    })
  )

  const verb = values.apply ? '' : ' (would)'
  console.log(`contacts scanned            ${stats.contacts}`)
  console.log(`grants created${verb}          ${stats.grantsCreated}`)
  console.log(`grant already there         ${stats.grantAlreadyThere}`)
  console.log(`skipped: no slot            ${stats.skippedNoSlot}`)
  console.log(`skipped: archived/deleted   ${stats.skippedGone}`)
  console.log(`skipped: slot is Stripe's   ${stats.skippedStripeOwned}`)
  console.log(`mirrors changed${verb}         ${stats.mirrorsChanged}`)
  console.log(`mirrors unchanged           ${stats.mirrorsUnchanged}`)
  console.log(`failed                      ${stats.failed}`)
  if (!values.apply) console.log('\nDry run: nothing written. Re-run with --apply.')
  if (stats.failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
