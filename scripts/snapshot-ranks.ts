/**
 * CAPTURE EVERY CONTACT'S CURRENT BELT BY NAME, BEFORE ANY SCALE CHANGE.
 *
 * ── WHY A NUMBER IS NOT ENOUGH ──────────────────────────────────────────────
 * `RankLevel.value` is simultaneously the identity of a level, its ORDER in the
 * ladder, and the number stored in `Contact.ranks`. Inserting a belt therefore
 * renumbers every level above it, and the moment that happens every stored
 * number means something different — silently, with nothing in the product
 * noticing. A contact who was `hmd: 9` (Red) becomes `hmd: 9` (something else).
 *
 * A LABEL does not move. "Red" is still Red after the insertion, so a snapshot
 * that records `{ value, label }` can answer "what belt did this person actually
 * hold?" no matter how many times the scale is renumbered afterwards. That is
 * the whole reason this script writes the name and not just the number.
 *
 * ── IT IS A PRECONDITION OF THE REMAP, NOT AN OPTIONAL EXTRA ────────────────
 * Franco, 2026-09-05, on the belt-scale change: "whichever we pick, let's make
 * sure the old belt is stored somewhere … anything but we should not lose that
 * info." Run this, verify it, and only then remap. Once the values have been
 * rewritten there is nothing left to snapshot — the information is gone, and no
 * later script can reconstruct it.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * `Contact.ranks_legacy`, a map keyed by ranking-system id:
 *
 *   ranks_legacy: {
 *     hmd: { value: 9, label: 'Red', system_name: 'Hwal Moo Do', captured_at: <ts> }
 *   }
 *
 * On the contact document rather than in a subcollection because it must survive
 * every read path that already loads a contact, and because it is one small map
 * that is written once and never queried.
 *
 * ── IT NEVER OVERWRITES ITSELF ──────────────────────────────────────────────
 * A contact that already carries `ranks_legacy` is skipped. Re-running after a
 * remap would otherwise capture the NEW numbering over the old — turning the
 * safety net into a copy of the thing it was protecting against. That check is
 * the single most important line in this file.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other backfills.
 *
 * Usage:
 *   pnpm snapshot:ranks --project linyup-prod [--apply]
 *
 * Without --apply it only reports what it would capture.
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    org: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error('❌ --project is required (e.g. --project linyup-prod)')
  process.exit(1)
}

admin.initializeApp({ credential: applicationDefault(), projectId: values.project })
const db = admin.firestore()

interface RankLevelLike {
  id?: string
  value: number
  label: string
}
interface RankingSystemLike {
  id: string
  name?: string
  levels?: RankLevelLike[]
}

/**
 * The scales in force, org-first.
 *
 * An org's `ranking_systems` OVERRIDE a team's, which is the same precedence
 * `effectiveRankingSystems` applies — reproduced here rather than imported
 * because this script must read exactly what is STORED, not what a resolver
 * would compute today.
 */
async function loadScales(orgId?: string): Promise<Map<string, RankingSystemLike>> {
  const scales = new Map<string, RankingSystemLike>()

  const orgs = orgId
    ? [await db.collection('organizations').doc(orgId).get()]
    : (await db.collection('organizations').get()).docs

  for (const org of orgs) {
    if (!org.exists) continue
    for (const s of (org.data()?.ranking_systems ?? []) as RankingSystemLike[]) {
      scales.set(s.id, s)
    }
  }
  return scales
}

/** A ref is the level's id, or a legacy number on a record the data flip has
 *  not reached; both resolve here. */
function labelFor(scale: RankingSystemLike | undefined, ref: string | number): string | null {
  const exact = scale?.levels?.find((l) => (typeof ref === 'string' ? l.id === ref : l.value === ref))
  return exact?.label ?? null
}

async function main() {
  console.log(
    `\n📌 Rank snapshot on '${values.project}' ${values.apply ? '(APPLY)' : '(dry-run)'}\n`
  )

  const scales = await loadScales(values.org)
  console.log(`   ${scales.size} ranking system(s) in force: ${[...scales.keys()].join(', ')}\n`)

  const contacts = await db.collection('contacts').get()
  let captured = 0
  let skippedExisting = 0
  let skippedNoRanks = 0
  let unknownLevel = 0
  let batch = db.batch()
  let pending = 0

  for (const doc of contacts.docs) {
    const data = doc.data()
    const ranks = data.ranks as Record<string, string | number> | undefined
    if (!ranks || Object.keys(ranks).length === 0) {
      skippedNoRanks += 1
      continue
    }
    // THE LINE THAT MATTERS. Re-running after a remap must never overwrite the
    // pre-remap capture with the post-remap numbering.
    if (data.ranks_legacy) {
      skippedExisting += 1
      continue
    }

    const legacy: Record<string, unknown> = {}
    for (const [systemId, value] of Object.entries(ranks)) {
      if (typeof value !== 'number' && typeof value !== 'string') continue
      const scale = scales.get(systemId)
      const label = labelFor(scale, value)
      if (!label) {
        // Recorded ANYWAY, with the label null. A value the scale does not
        // contain is exactly the case where the number alone is worthless, so
        // dropping it would lose the most fragile record of all.
        unknownLevel += 1
      }
      legacy[systemId] = {
        value,
        label,
        system_name: scale?.name ?? null,
      }
    }
    if (Object.keys(legacy).length === 0) continue

    captured += 1
    if (captured <= 10) {
      console.log(
        `   ${values.apply ? 'capture' : 'would capture'} ${doc.id}: ` +
          Object.entries(legacy)
            .map(([sys, v]) => `${sys}=${(v as { value: number }).value} (${(v as { label: string | null }).label ?? '?'})`)
            .join(', ')
      )
    }

    if (values.apply) {
      batch.update(doc.ref, {
        ranks_legacy: { ...legacy, captured_at: admin.firestore.FieldValue.serverTimestamp() },
      })
      pending += 1
      if (pending === 400) {
        await batch.commit()
        batch = db.batch()
        pending = 0
      }
    }
  }

  if (values.apply && pending > 0) await batch.commit()

  if (captured > 10) console.log(`   … and ${captured - 10} more`)
  console.log(
    `\n   captured: ${captured}   already snapshotted: ${skippedExisting}   ` +
      `no ranks: ${skippedNoRanks}   levels not in any scale: ${unknownLevel}`
  )
  if (!values.apply && captured > 0) console.log('\n   Re-run with --apply to write.')
  console.log(values.apply ? '\n✅ Done.\n' : '\n✅ Dry-run complete.\n')
}

main().catch((err) => {
  console.error('❌ Snapshot failed:', err)
  process.exit(1)
})
