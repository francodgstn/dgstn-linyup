import type { MigrationConfig } from '../config'
import { sourceDb, targetDb, ORG_ID } from '../config'
import { BatchWriter } from '../batch-writer'
import { transformContact, AFFILIATIONS_OUTPUT_KEY } from '../transforms/contacts'
import { matchSubscriptionType } from '../transforms/subscriptions'

// Affiliation subcollection name (mirrors @linyup/shared CONTACT_AFFILIATIONS_SUBCOLLECTION).
const AFFILIATIONS_SUBCOLLECTION = 'affiliations'

// Most subcollections keep their name. HMD stored the performance radar data as
// 'training_checkins'; Linyup renamed it to 'performance_checkins', so that one
// reads from the old name and writes to the new.
const CONTACT_SUBCOLLECTIONS: Array<string | { from: string; to: string }> = [
  'subscription_history',
  'goals',
  'monthly_scores',
  'contact_alerts',
  'contact_weekly_reports',
  { from: 'training_checkins', to: 'performance_checkins' },
]

/**
 * A weekly report recording that somebody did not turn up. DO NOT MIGRATE IT.
 *
 * hmd-lineup's `weeklyReports` cron looped EVERY active contact of EVERY team
 * once a week and wrote a row whether they attended or not — and its own
 * `// TODO: - delete if older than 3 years` was never done. Measured on the
 * three-club sample: 93,587 rows for 804 contacts, of which 92,439 (98.8%)
 * carry `sessions_count: 0`. Across all sixteen clubs that is roughly 190,000
 * documents, ~188,000 of them recording an absence.
 *
 * Dropping them loses NOTHING, because Linyup's own writer is already sparse —
 * `weeklyReports` in functions/src/analytics builds its map from session
 * participants, so a contact who did not attend gets no document — and both
 * readers now treat a missing week as a zero (`densifyWeeklyCounts` in
 * @linyup/shared). A stored zero and an absent week are the same fact; only one
 * of them costs a document.
 *
 * Filtering on ATTENDANCE rather than on age is deliberate. The obvious
 * alternative — the cutoff hmd-lineup meant to write — would throw away real
 * attendance history, which is exactly what the belt progression engine reads
 * to answer whether a qualifying year was qualifying.
 */
function isEmptyWeeklyReport(sub: string, data: Record<string, unknown>): boolean {
  if (sub !== 'contact_weekly_reports') return false
  const n = data.sessions_count
  // Absent counts as empty too: a row that never recorded a number is not a
  // record of attendance, and the readers coalesce both to zero anyway.
  return typeof n !== 'number' || n <= 0
}

export async function pass05Contacts(
  cfg: MigrationConfig,
  teamIds: string[],
): Promise<void> {
  console.log('Pass 5: contacts + subcollections')
  const src = sourceDb()
  const tgt = targetDb()

  for (const teamId of teamIds) {
    if (cfg.fromTeam && teamId < cfg.fromTeam) continue
    console.log(`  team ${teamId}`)
    const bw   = new BatchWriter(tgt, cfg.dryRun)
    const snap = await src.collection('contacts').where('teamId', '==', teamId).get()

    // Flag the team so the affiliation axis is enabled. (org_id / organization_ids
    // set in pass02.) No team-local affiliation type is seeded any more: every
    // migrated row is ORG-issued (the federation card — see the transform), and
    // the org-level 'club' type + statuses are seeded once in pass00Setup. The
    // team-local "Club membership" this used to write offered the studio a second
    // type of the same name that nothing referenced.
    bw.merge(tgt.collection('teams').doc(teamId), { affiliations_enabled: true })

    // THE NAME LIVES ON THE TYPE, NOT ON THE CONTACT. hmd-lineup stores only
    // `subscription_type_id` on a contact; the matcher needs a name. Read the
    // source team's own types once and hand the transform the lookup — see the
    // subscription block in transforms/contacts.ts for the defect this fixes.
    const srcTypes = await src.collection('teams').doc(teamId).collection('subscription_types').get()
    const sourceTypeNames = new Map<string, string>(
      srcTypes.docs
        .map((d) => [d.id, String((d.data() as Record<string, unknown>).name ?? '')] as const)
        .filter(([, name]) => name.length > 0),
    )

    // HEURISTIC subscription matching counters — review these after migration
    // to validate the name-based matching against the real source data.
    let subMatched   = 0
    let subUnmatched = 0
    let emptyWeeklyReports = 0

    for (const d of snap.docs) {
      const tgtRef = tgt.collection('contacts').doc(d.id)
      if (!cfg.dryRun) {
        const existing = await tgtRef.get()
        if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
      }

      // Track subscription match rate before transforming (transform logs nothing)
      const srcData = d.data() as Record<string, unknown>
      // Counted through the SAME resolution the transform uses, or the counters
      // report on a question nobody asked: the old version read the contact's
      // own `subscription_type_name`, which is never set, so both counters sat
      // at zero and the run looked like it had nothing to match.
      const srcSubTypeId = srcData.subscription_type_id as string | undefined | null
      const srcSubName =
        (srcData.subscription_type_name as string | undefined | null) ??
        (srcSubTypeId ? (sourceTypeNames.get(srcSubTypeId) ?? null) : null)
      if (srcSubName) {
        if (matchSubscriptionType(srcSubName) !== null) { subMatched++ }
        else { subUnmatched++ }
      }

      // Transform the contact. The transform attaches derived affiliation docs
      // under AFFILIATIONS_OUTPUT_KEY (they are not a source subcollection); peel
      // them off and write them into the affiliations subcollection, then persist
      // the contact doc without that reserved key.
      const transformed = transformContact(srcData, sourceTypeNames)
      const affiliations =
        (transformed[AFFILIATIONS_OUTPUT_KEY] as Array<Record<string, unknown>> | undefined) ?? []
      delete transformed[AFFILIATIONS_OUTPUT_KEY]
      bw.set(tgtRef, transformed)

      affiliations.forEach((aff, idx) => {
        const affId = `${d.id}-aff-${idx}`
        const affRef = tgt.collection('contacts').doc(d.id).collection(AFFILIATIONS_SUBCOLLECTION).doc(affId)
        bw.set(affRef, aff)
      })

      // Subcollections
      for (const sub of CONTACT_SUBCOLLECTIONS) {
        const fromName = typeof sub === 'string' ? sub : sub.from
        const toName = typeof sub === 'string' ? sub : sub.to
        const subSnap = await src.collection('contacts').doc(d.id).collection(fromName).get()
        for (const sd of subSnap.docs) {
          if (isEmptyWeeklyReport(fromName, sd.data() as Record<string, unknown>)) {
            emptyWeeklyReports++
            continue
          }
          const subRef = tgt.collection('contacts').doc(d.id).collection(toName).doc(sd.id)
          if (!cfg.dryRun) {
            const existing = await subRef.get()
            if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
          }
          const data = transformSubcollectionDoc(fromName, sd.id, sd.data() as Record<string, unknown>)
          bw.set(subRef, data)
        }
      }

      // goals/{goalId}/evaluations
      const goalsSnap = await src.collection('contacts').doc(d.id).collection('goals').get()
      for (const gd of goalsSnap.docs) {
        const evSnap = await src.collection('contacts').doc(d.id).collection('goals').doc(gd.id).collection('evaluations').get()
        for (const ev of evSnap.docs) {
          const evRef = tgt.collection('contacts').doc(d.id).collection('goals').doc(gd.id).collection('evaluations').doc(ev.id)
          if (!cfg.dryRun) {
            const existing = await evRef.get()
            if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
          }
          bw.set(evRef, ev.data())
        }
      }
    }

    if (emptyWeeklyReports > 0) {
      console.log(`    skipped ${emptyWeeklyReports} empty weekly reports (no attendance)`)
    }

    // Log subscription matching stats for this team (HEURISTIC — needs review)
    const subTotal = subMatched + subUnmatched
    if (subTotal > 0) {
      console.log(
        `    subscription match: ${subMatched}/${subTotal} matched` +
        (subUnmatched > 0 ? ` (${subUnmatched} unmatched — review source names)` : ''),
      )
    }

    await bw.done()
  }
}

function transformSubcollectionDoc(
  sub: string,
  _id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (sub !== 'contact_alerts') return data

  // contact_alerts: flatten schedule_type/schedule_value from nested schedule object
  const schedule = data.schedule as Record<string, unknown> | undefined
  if (schedule) {
    return {
      ...data,
      schedule_type:  schedule.type,
      schedule_value: schedule.value,
      schedule:       undefined,
    }
  }
  return data
}
