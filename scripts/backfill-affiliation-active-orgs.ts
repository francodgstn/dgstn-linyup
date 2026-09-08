/**
 * Stamp `affiliation_summary.active_org_ids` on every contact that holds an
 * org-issued affiliation.
 *
 * ── WHY IT IS NEEDED ────────────────────────────────────────────────────────
 * `AffiliationSummary` gained a second org list. `org_ids` is every org that has
 * EVER put the contact on its books; `active_org_ids` is the orgs whose
 * affiliation currently counts. The org dashboard's affiliation figure, its
 * coverage percentage and the Studios column all read the new one — they read
 * the old one until 2026-09-08 and so counted a licence that lapsed last season
 * as a current member.
 *
 * `onAffiliationWrite` fills the field, but a trigger only ever fires on a
 * WRITE: every affiliation recorded before it was deployed leaves a summary with
 * no `active_org_ids` at all. A Firestore `array-contains` never matches a
 * missing field, so an un-backfilled contact drops OUT of the count. That is the
 * safer direction — a number that is visibly too low rather than invisibly too
 * high — but it is still wrong, which makes this a DEPLOY PRECONDITION in the
 * same sense as `backfill-document-versions.ts`: deploy the trigger, run this,
 * then the federation's numbers tell the truth.
 *
 * ── WHERE IT ACTUALLY APPLIES ───────────────────────────────────────────────
 * Anywhere contacts were written before the field existed. As of 2026-09-08 that
 * is the persisted EMULATOR SNAPSHOTS — `snapshots/hmd-migration`, `demo`, `all`
 * and the lead tenants — because a snapshot is loaded, not recomputed, so no
 * trigger fires over it. Re-running the migration or the seeders fixes them too
 * (both write the field now); this is the cheaper route when the snapshot itself
 * is worth keeping.
 *
 * It is a no-op against an environment whose data was all written after the
 * trigger shipped — which it reports rather than assumes ("N already correct").
 *
 * ── WHAT IT READS ───────────────────────────────────────────────────────────
 * A collection-group scan of `affiliations`, grouped by parent contact, so it
 * costs one read per AFFILIATION rather than one query per contact. A contact
 * with none never appears and is never written — which is correct: with no
 * org-issued affiliation there is nothing for either list to hold.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * `affiliation_summary.active_org_ids` and `affiliation_summary.org_ids`, by
 * FIELD PATH, so the rest of the summary is untouched. Both, not just the new
 * one: recomputing `org_ids` from the same read set is free and makes the two
 * lists agree by construction — writing only one would leave a summary whose
 * "now" could contain an org its "ever" does not, which is nonsense no reader
 * would expect to have to handle.
 *
 * It does NOT touch `has_active` or `types`. Those have been maintained by the
 * trigger since the beginning and this pass has no better information about
 * them; recomputing them would turn a narrow repair into a rewrite of every
 * summary in the database, with `updated_at` churn to match.
 *
 * ── RE-RUNNABLE ─────────────────────────────────────────────────────────────
 * It computes ABSOLUTE lists from the subcollection, exactly as the trigger
 * does, so a second run writes nothing and a run after the trigger is live
 * simply agrees with it.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other scripts.
 * Against the emulator, set FIRESTORE_EMULATOR_HOST and use the demo project.
 *
 * Usage:
 *   tsx scripts/backfill-affiliation-active-orgs.ts --project linyup-staging [--team t1] [--apply]
 *
 * Without --apply it only reports what it would write.
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { FieldPath } from 'firebase-admin/firestore'
import { CONTACTS_COLLECTION, CONTACT_AFFILIATIONS_SUBCOLLECTION } from '@linyup/shared'
import type { Affiliation } from '@linyup/shared'

/** One scan page. Small enough to keep memory flat on a collection group that
 *  grows with every affiliation any studio has ever recorded. */
const PAGE = 1000

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

const stats = {
  affiliations: 0,
  contacts: 0,
  written: 0,
  unchanged: 0,
  missing: 0,
  skippedTeam: 0,
}

/** Same sort-and-compare the trigger uses for its idempotency check. */
function sameSet(a: string[], b: string[] | undefined): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...(b ?? [])].sort())
}

async function main() {
  console.log(
    `\n🔧 affiliation_summary.active_org_ids backfill on '${values.project}'${
      values.team ? ` (team ${values.team})` : ''
    } ${values.apply ? '(APPLY)' : '(dry-run)'}\n`
  )

  // GROUP FIRST, WRITE SECOND — one read per affiliation, and none at all for a
  // contact that has none.
  const orgIssued = new Map<string, { ever: Set<string>; now: Set<string> }>()
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null

  for (;;) {
    let q = db
      .collectionGroup(CONTACT_AFFILIATIONS_SUBCOLLECTION)
      .orderBy(FieldPath.documentId())
      .limit(PAGE)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break

    for (const doc of snap.docs) {
      // The parent of an `affiliations` document is the contact. Guard rather
      // than assume: a collection-group scan matches the subcollection NAME
      // wherever it appears, and a future writer could put one elsewhere.
      const contactRef = doc.ref.parent.parent
      if (!contactRef || contactRef.parent.id !== CONTACTS_COLLECTION) continue
      stats.affiliations++

      const a = doc.data() as Affiliation
      // Exactly the trigger's predicate: org-issued, with an issuer named.
      if (a.issuer !== 'org' || !a.org_id) continue

      const entry = orgIssued.get(contactRef.id) ?? { ever: new Set(), now: new Set() }
      entry.ever.add(a.org_id)
      if (a.active === true) entry.now.add(a.org_id)
      orgIssued.set(contactRef.id, entry)
    }

    cursor = snap.docs[snap.docs.length - 1]
    if (snap.size < PAGE) break
  }

  stats.contacts = orgIssued.size
  console.log(
    `   scanned ${stats.affiliations} affiliation(s); ` +
      `${stats.contacts} contact(s) hold an org-issued one`
  )

  for (const [contactId, entry] of orgIssued) {
    const ref = db.collection(CONTACTS_COLLECTION).doc(contactId)
    const snap = await ref.get()
    if (!snap.exists) {
      // An affiliation whose contact was hard-deleted. Nothing to write, and
      // worth reporting rather than silently ignoring.
      stats.missing++
      continue
    }
    const data = snap.data()!
    if (values.team && data.teamId !== values.team) {
      stats.skippedTeam++
      continue
    }

    const ever = [...entry.ever]
    const now = [...entry.now]
    const existing = data.affiliation_summary as
      | { org_ids?: string[]; active_org_ids?: string[] }
      | undefined
    if (sameSet(ever, existing?.org_ids) && sameSet(now, existing?.active_org_ids)) {
      stats.unchanged++
      continue
    }

    if (values.apply) {
      // FIELD PATHS, so `has_active` and `types` survive untouched — an
      // `update({ affiliation_summary: {...} })` would replace the whole map.
      await ref.update({
        'affiliation_summary.org_ids': ever,
        'affiliation_summary.active_org_ids': now,
      })
    }
    stats.written++
  }

  console.log(
    `\n${values.apply ? '✅ wrote' : '📋 would write'} ${stats.written} contact(s); ` +
      `${stats.unchanged} already correct` +
      (stats.missing ? `; ${stats.missing} affiliation(s) whose contact is gone` : '') +
      (stats.skippedTeam ? `; ${stats.skippedTeam} outside --team` : '')
  )
  if (!values.apply) console.log('\n   Re-run with --apply to write.\n')
}

main().catch((err) => {
  console.error('❌ backfill failed:', err)
  process.exit(1)
})
