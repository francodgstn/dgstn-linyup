/**
 * REPAIR MIGRATED SUBSCRIPTIONS — give a member back the plan they hold.
 *
 *   tsx --tsconfig tsconfig.scripts.json scripts/repair-hmd-subscriptions.ts \
 *     --source-creds keys/hmd-prod-sa.json \
 *     --target-creds keys/linyup-staging-sa.json [--team <id>] [--apply]
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * The migration matched a contact's plan by NAME, and hmd-lineup does not put a
 * name on a contact — only `subscription_type_id`, with the name on the type
 * document. The real source carries the name on 0 of 137 contacts, so the
 * matcher was handed `undefined` every time and fell through to "leave the
 * subscription fields as they are".
 *
 * Nothing errored. Every migrated member kept the SOURCE's type id and gained no
 * `subscription_type_name`, no price, no amount, no `active_subscriptions`. The
 * contact page gates its subscription panel on the NAME, so a member with a live
 * plan read "No subscription history yet" while the history list directly below
 * showed that plan as active.
 *
 * Separately, pass 11 copied the source's own plans AND seeded the canonical
 * ones, so four plans existed twice — a rich copy with prices and a bare copy
 * with a name. Deleting the bare copies (by hand, or by the migration's new
 * skip) leaves every member who held one pointing at a document that is gone.
 *
 * Both are fixed in the migration. This repairs what the migration already
 * wrote, because fixing an import repairs nothing already imported.
 *
 * ── THE MAP COMES FROM THE SOURCE, NOT THE TARGET ───────────────────────────
 * The source is immutable and still holds every type document, including the
 * ones deleted from the target as duplicates. So `id → name → canonical` is
 * always answerable here, even for an id that now resolves to nothing.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 * A contact already carrying the right id and a name is left alone, and reported
 * as such. Re-running writes nothing.
 */

import { parseArgs } from 'node:util'
import { readFileSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import {
  CANONICAL_SUBSCRIPTION_TYPES,
  matchSubscriptionType,
  pickSubscriptionPrice,
  sourceTypeDuplicatesCanonical,
} from './migration/transforms/subscriptions'

const { values } = parseArgs({
  options: {
    'source-creds': { type: 'string' },
    'target-creds': { type: 'string' },
    team: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (!values['source-creds'] || !values['target-creds']) {
  console.error('Error: --source-creds and --target-creds are both required')
  process.exit(1)
}
const apply = values.apply ?? false

function db(path: string, name: string): Firestore {
  const sa = JSON.parse(readFileSync(path, 'utf8'))
  return getFirestore(initializeApp({ credential: cert(sa), projectId: sa.project_id }, name))
}
const src = db(values['source-creds']!, 'src')
const tgt = db(values['target-creds']!, 'tgt')

const CANONICAL_IDS = new Set(CANONICAL_SUBSCRIPTION_TYPES.map((t) => t.id))

interface Resolved {
  typeId: string
  typeName: string
  priceId?: string
  amount?: number
  recurrence?: string
  canonical: boolean
  /** A canonical plan can still be priceless — Complimentary is. */
  priced?: boolean
}

/** What a source type id should become on the target. */
function resolve(sourceTypeId: string, sourceName: string | null, recurrence: unknown): Resolved | null {
  if (!sourceName) return null
  const m = matchSubscriptionType(sourceName)
  if (!m) {
    // Kept as its own plan (Fitpass, ClassPass, Instructor, Free) — the id is
    // still valid on the target, only the name was missing.
    return { typeId: sourceTypeId, typeName: sourceName, canonical: false }
  }
  // A COMPED PLAN HAS NO PRICES — `pickSubscriptionPrice` would hand back
  // undefined and the next read would throw. The member still gets the plan and
  // its name; there is simply no amount, because that is what a comp is.
  const price =
    m.prices.length > 0
      ? pickSubscriptionPrice(m.prices, typeof recurrence === 'string' ? recurrence : null)
      : null
  return {
    typeId: m.typeId,
    typeName: m.typeName,
    ...(price
      ? { priceId: price.id, amount: price.amount, recurrence: price.recurrence }
      : {}),
    canonical: true,
    priced: price !== null,
  }
}

async function main() {
  console.log(apply ? '=== APPLY ===' : '=== DRY RUN — pass --apply to write ===')

  const teamIds = values.team
    ? [values.team]
    : (await tgt.collection('teams').where('org_id', '==', 'hmd').get()).docs.map((d) => d.id)
  console.log(`teams: ${teamIds.length}`)

  let contactsFixed = 0
  let historyFixed = 0
  let activitiesLinked = 0
  let dupTypesDeleted = 0
  let alreadyOk = 0
  let unresolved = 0

  for (const teamId of teamIds) {
    // id → name, from the SOURCE (which still has the deleted duplicates).
    const srcTypes = await src.collection('teams').doc(teamId).collection('subscription_types').get()
    if (srcTypes.empty) continue
    const nameById = new Map(
      srcTypes.docs.map((d) => [d.id, String((d.data() as { name?: string }).name ?? '')])
    )

    // 1) Duplicate source plans still sitting on the target.
    for (const d of srcTypes.docs) {
      const name = nameById.get(d.id)!
      if (!matchSubscriptionType(name)) continue
      const onTarget = tgt.collection('teams').doc(teamId).collection('subscription_types').doc(d.id)
      if (!(await onTarget.get()).exists) continue
      console.log(`  ${teamId}: delete duplicate plan "${name}" [${d.id}]`)
      if (apply) await onTarget.delete()
      dupTypesDeleted += 1
    }

    // 2) THE DOOR. A migrated class arrived with no `accessRule`, which reads as
    //    legacy `open`: anybody books free and no plan is ever part of the
    //    transaction — so Essential's 4-per-month allowance had nothing to bind
    //    on, because `resolvePaymentOptions` only consults an allowance for a
    //    plan the activity lists. Link every plan, and let `trialEnabled` carry
    //    the newcomer: "public booking is done by enabling the trial, only
    //    trials can book free" (Franco, 2026-09-08).
    //
    //    MERGED FIELD-BY-FIELD, never as a whole document: the studio's own
    //    edits to a class (name, tags, drop-in, prices) are not this script's to
    //    replace, and `accessRule` is a shared map whose other keys must survive.
    const planIds = [
      ...CANONICAL_SUBSCRIPTION_TYPES.map((t) => t.id),
      ...srcTypes.docs
        .filter((d) => !sourceTypeDuplicatesCanonical(nameById.get(d.id)))
        .map((d) => d.id),
    ]
    const activities = await tgt.collection('activities').where('teamId', '==', teamId).get()
    for (const a of activities.docs) {
      const v = a.data() as Record<string, unknown>
      if (v.type === 'appointment') continue // class-only gate, by design
      const rule = (v.accessRule ?? {}) as Record<string, unknown>
      const linked = (rule.subscriptionTypeIds as string[] | undefined) ?? []
      const sameLinks =
        linked.length === planIds.length && planIds.every((id) => linked.includes(id))
      if (sameLinks && rule.requirePlan === true && v.trialEnabled === true) continue
      console.log(`  ${teamId}: gate "${v.name}" on ${planIds.length} plans + trial`)
      if (apply) {
        await a.ref.update({
          'accessRule.subscriptionTypeIds': planIds,
          'accessRule.audience': 'members',
          'accessRule.requirePlan': true,
          'accessRule.type': 'subscription',
          isFreeTrial: false,
          trialEnabled: true,
        })
      }
      activitiesLinked += 1
    }

    // 3) Contacts, and their history rows.
    const contacts = await tgt.collection('contacts').where('teamId', '==', teamId).get()
    for (const c of contacts.docs) {
      const v = c.data() as Record<string, unknown>
      const held = v.subscription_type_id as string | undefined | null

      if (held) {
        const r = resolve(held, nameById.get(held) ?? null, v.subscription_recurrence)
        if (!r) {
          if (!CANONICAL_IDS.has(held)) unresolved += 1
        } else if (v.subscription_type_name && v.subscription_type_id === r.typeId) {
          alreadyOk += 1
        } else {
          const patch: Record<string, unknown> = {
            subscription_type_id: r.typeId,
            subscription_type_name: r.typeName,
          }
          if (r.canonical) {
            if (r.priced) {
              patch.subscription_price_id = r.priceId
              patch.subscription_amount = r.amount
              patch.subscription_recurrence = r.recurrence
            }
            // Mirrors ActiveSubscriptionSummary, exactly as the transform writes
            // it — the weekly report counts subscriptions by type off this array.
            // A COMP IS STILL A LIVE PLAN, so it belongs in this array; `amount`
            // is required and zero is the honest figure for one.
            patch.active_subscriptions = [
              {
                subscription_type_id: r.typeId,
                subscription_type_name: r.typeName,
                recurrence: r.recurrence ?? null,
                amount: r.amount ?? 0,
                status: 'active',
              },
            ]
          }
          if (apply) await c.ref.set(patch, { merge: true })
          contactsFixed += 1
        }
      }

      const hist = await c.ref.collection('subscription_history').get()
      for (const h of hist.docs) {
        const hv = h.data() as Record<string, unknown>
        const hid = hv.subscription_type_id as string | undefined | null
        if (!hid) continue
        const r = resolve(hid, nameById.get(hid) ?? null, hv.recurrence)
        if (!r) continue
        // A history row's stored name is sometimes the ID (a source quirk), so
        // correct the name even when the id already points at the right plan.
        if (hv.subscription_type_id === r.typeId && hv.subscription_type_name === r.typeName) continue
        if (apply) {
          await h.ref.set(
            { subscription_type_id: r.typeId, subscription_type_name: r.typeName },
            { merge: true }
          )
        }
        historyFixed += 1
      }
    }
  }

  console.log('')
  console.log(`duplicate plans deleted : ${dupTypesDeleted}`)
  console.log(`activities gated on plans: ${activitiesLinked}${apply ? '' : ' (dry run)'}`)
  console.log(`contacts repaired       : ${contactsFixed}${apply ? '' : ' (dry run)'}`)
  console.log(`history rows repaired   : ${historyFixed}${apply ? '' : ' (dry run)'}`)
  console.log(`contacts already correct: ${alreadyOk}`)
  if (unresolved > 0) {
    console.log(`⚠️  contacts whose type id is neither canonical nor a source type: ${unresolved}`)
  }
}

main().then(() => process.exit(0))
