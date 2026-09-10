/**
 * Pass 16 — AFFILIATIONS RE-SYNC: the licence record follows the old system
 * while the old system is still where the organisation manages it.
 *
 * During the cutover the org's managers keep renewing memberships in
 * hmd-lineup; a club that has moved to Linyup would otherwise show no member
 * chips for a whole season. This pass re-derives every migrated contact's
 * affiliation rows from the source — the SAME transform pass 05 used, so a
 * status, its `contact_live` flag and an archived person's coercion to
 * 'expired' cannot come out differently here — and writes them over the rows
 * the migration owns:
 *
 *   contacts/{id}/affiliations/{id}-aff-{n}
 *
 * Those positional ids are the migration's namespace. A row the organisation
 * created IN LINYUP has a generated id and is never touched; a positional row
 * the source no longer justifies (two licences became one) is DELETED, which
 * is the part `--overwrite` cannot do — it re-sets what still exists and leaves
 * the stale extra standing.
 *
 * `affiliation_summary` is deliberately NOT written here. `onAffiliationWrite`
 * is its one writer and recomputes it from every row on any row write — a copy
 * derived from the source rows alone would drop the Linyup-created ones from
 * the count for as long as the trigger took to run.
 *
 *   pnpm migrate:hmd ... --only affiliations --teams "Basel,Ardovini"
 *
 * Always a sync, never skip-if-exists: that is what a re-sync is for.
 */
import { FieldPath } from 'firebase-admin/firestore'
import type { MigrationConfig } from '../config'
import { sourceDb, targetDb } from '../config'
import { BatchWriter } from '../batch-writer'
import { transformContact, AFFILIATIONS_OUTPUT_KEY } from '../transforms/contacts'

// Mirrors @linyup/shared CONTACT_AFFILIATIONS_SUBCOLLECTION — and pass 05.
const AFFILIATIONS_SUBCOLLECTION = 'affiliations'

export async function pass16Affiliations(cfg: MigrationConfig, teamIds: string[]): Promise<void> {
  console.log('Pass 16: affiliations re-sync (source is master for the licence record)')
  const src = sourceDb()
  const tgt = targetDb()

  for (const teamId of teamIds) {
    if (cfg.fromTeam && teamId < cfg.fromTeam) continue
    console.log(`  team ${teamId}`)
    const bw = new BatchWriter(tgt, cfg.dryRun)

    // The transform needs the type NAME to resolve a plan — same lookup pass 05
    // does, for the same reason (the contact carries only the id).
    const srcTypes = await src.collection('teams').doc(teamId).collection('subscription_types').get()
    const sourceTypeNames = new Map<string, string>(
      srcTypes.docs
        .map((d) => [d.id, String((d.data() as Record<string, unknown>).name ?? '')] as const)
        .filter(([, name]) => name.length > 0),
    )

    const snap = await src.collection('contacts').where('teamId', '==', teamId).get()
    let synced = 0
    let rowsWritten = 0
    let stale = 0
    let missing = 0

    for (const d of snap.docs) {
      const contactRef = tgt.collection('contacts').doc(d.id)
      // A contact the target has never seen is a job for the contacts pass,
      // not this one — writing rows under a document that does not exist would
      // leave orphans the org dashboard's collection-group count still finds.
      if (!(await contactRef.get()).exists) { missing++; continue }

      const transformed = transformContact(d.data() as Record<string, unknown>, sourceTypeNames)
      const affs = (transformed[AFFILIATIONS_OUTPUT_KEY] as Array<Record<string, unknown>> | undefined) ?? []
      const prefix = `${d.id}-aff-`

      affs.forEach((aff, idx) => {
        bw.set(contactRef.collection(AFFILIATIONS_SUBCOLLECTION).doc(`${prefix}${idx}`), aff)
        rowsWritten++
      })

      // Every positional row beyond what the source justifies today is stale.
      const existing = await contactRef
        .collection(AFFILIATIONS_SUBCOLLECTION)
        .orderBy(FieldPath.documentId())
        .startAt(prefix)
        .endAt(`${prefix}\uf8ff`)
        .get()
      for (const row of existing.docs) {
        const idx = Number(row.id.slice(prefix.length))
        if (!Number.isInteger(idx) || idx < affs.length) continue
        bw.delete(row.ref)
        stale++
      }
      synced++
    }

    await bw.done()
    console.log(
      `    ${synced} contact(s) synced · ${rowsWritten} row(s) written · ${stale} stale row(s) removed` +
        (missing ? ` · ${missing} not on target (run the contacts pass first)` : ''),
    )
  }
}
