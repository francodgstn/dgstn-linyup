import type { MigrationConfig } from '../config'
import { targetDb, RANKING_HMD, RANKING_KD, rankingSystemLevelId } from '../config'
import { BatchWriter } from '../batch-writer'

/**
 * Pass 9 — remap hmd-lineup's exam check-in payload onto the shape Linyup reads.
 *
 * pass08 copies the global `checkins` docs verbatim, which is right for every
 * field EXCEPT the exam result. hmd-lineup kept that at the TOP LEVEL of the
 * check-in:
 *
 *   { exams: { hmd_rank: n, kd_rank: n }, is_hmd_exam, is_kd_exam, is_graded }
 *
 * where `n` is the rank the candidate was AWARDED — its ExamCheckinForm wrote
 * `contact.disciplines[slug_rank] + 1`. Linyup reads
 * `checkin_data.disciplines: { [rankingSystemId]: level }` (see EventCheckin in
 * packages/shared/src/types/event.ts). So without this pass every migrated exam
 * carries its whole grading history in a shape no reader looks at: present in
 * Firestore, invisible on every screen — and invisible to the rank-progression
 * backfill, whose entire input this is.
 *
 * NOTHING IS DELETED. The legacy payload is copied to `checkin_data.legacy` and
 * also left exactly where it was. `is_graded` in particular records that the
 * award was already applied to the contact's own rank, which is what stops a
 * later backfill promoting somebody a second time; a migration that drops the
 * only copy of a field cannot give it back without a full re-run.
 *
 * Scope is exams only. The fighting cup has the same top-level →
 * `checkin_data` drift and is handled by its sibling `09-cup-checkins.ts`; camp
 * (`join_as`) is still unmapped, because nothing reads a migrated camp's role
 * yet — participation capture is a later phase, and a pass written before its
 * reader would be guessing at the shape.
 *
 * Note on `--dry-run`: this pass reads the check-ins in the TARGET, so a dry run
 * against a target where pass08 has never really run finds nothing to do. That
 * is the truth about that target, not a fault in the pass.
 */

// hmd-lineup discipline slug → Linyup ranking system id. Both disciplines run
// on the SAME belt ladder (config.ts HMD_BELT_LEVELS), so the awarded value
// crosses over unchanged — only the key it hangs on changes.
const LEGACY_EXAM_DISCIPLINES: Array<{ legacyKey: string; systemId: string }> = [
  { legacyKey: 'hmd_rank', systemId: RANKING_HMD },
  { legacyKey: 'kd_rank', systemId: RANKING_KD },
]

// The fields that together made up the legacy exam payload. Preserved verbatim
// under `checkin_data.legacy`.
const LEGACY_PAYLOAD_FIELDS = ['exams', 'is_hmd_exam', 'is_kd_exam', 'is_graded'] as const

/**
 * The exam arm of `isCheckinCompleted` (@linyup/shared utils/checkins.ts),
 * re-declared here because the migration scripts run under
 * tsconfig.scripts.json and cannot import the shared package — the same reason
 * config.ts re-declares the path constants.
 *
 * A level of 0 IS a result: every ranking preset's first level is `value: 0`
 * (HMD "No belt"), so "not examined" is the ABSENCE of the discipline key.
 */
function examCheckinIsCompleted(disciplines: Record<string, string | number>): boolean {
  return Object.values(disciplines).some((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function pass09ExamCheckins(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 9: exam checkins → checkin_data.disciplines')
  const tgt = targetDb()
  const bw = new BatchWriter(tgt, cfg.dryRun)

  // The EVENT doc is the authority on its own type; `checkin.event.type` is a
  // denormalised copy that the oldest HMD check-ins predate. So collect the
  // exam events first and read their check-ins, rather than filtering the
  // check-ins on a field that may not be there.
  const eventsSnap = await tgt.collection('events').where('type', '==', 'exam').get()
  console.log(`  ${eventsSnap.size} exam event(s)`)

  let remapped = 0        // legacy payload found and rewritten
  let alreadyMigrated = 0 // already carries checkin_data.disciplines
  let noLegacyPayload = 0 // an exam check-in that never recorded a result
  let flipped = 0         // is_completed changed under the recomputed rule
  const flippedEventIds = new Set<string>()

  for (const eventDoc of eventsSnap.docs) {
    const checkinsSnap = await tgt
      .collection('checkins')
      .where('event.id', '==', eventDoc.id)
      .get()

    for (const cd of checkinsSnap.docs) {
      const data = cd.data() as Record<string, unknown>
      const checkinData = asRecord(data.checkin_data) ?? {}

      // Idempotent: a doc already carrying disciplines has been through this
      // pass (or was written by the live app) — never rewrite it.
      if (checkinData.disciplines !== undefined) {
        alreadyMigrated++
        bw.skip()
        continue
      }

      const exams = asRecord(data.exams)
      if (!exams) {
        noLegacyPayload++
        bw.skip()
        continue
      }

      const disciplines: Record<string, string | number> = {}
      for (const { legacyKey, systemId } of LEGACY_EXAM_DISCIPLINES) {
        const raw = exams[legacyKey]
        if (raw == null) continue
        const level = Number(raw)
        if (!Number.isFinite(level)) {
          console.warn(
            `  checkin ${cd.id}: exams.${legacyKey} = ${JSON.stringify(raw)} is not a level` +
              ` — dropped from disciplines (kept under checkin_data.legacy)`,
          )
          continue
        }
        // The LEVEL'S ID, as every rank record is written since the scale
        // decoupling; the source's number stays only when the scale lacks it.
        disciplines[systemId] = rankingSystemLevelId(systemId, level) ?? level
      }

      // A discipline slug this migration has no ranking system for would be
      // silently lost, so say so — the value still survives in `legacy`.
      for (const key of Object.keys(exams)) {
        if (!LEGACY_EXAM_DISCIPLINES.some((d) => d.legacyKey === key)) {
          console.warn(
            `  checkin ${cd.id}: unknown legacy exam discipline '${key}'` +
              ` — no ranking system to map it to (kept under checkin_data.legacy)`,
          )
        }
      }

      const legacy: Record<string, unknown> = {}
      for (const key of LEGACY_PAYLOAD_FIELDS) {
        if (data[key] !== undefined) legacy[key] = data[key]
      }

      const isCompleted = examCheckinIsCompleted(disciplines)
      if (isCompleted !== (data.is_completed === true)) {
        flipped++
        flippedEventIds.add(eventDoc.id)
      }

      bw.merge(cd.ref, {
        checkin_data: { ...checkinData, disciplines, legacy },
        is_completed: isCompleted,
      })
      remapped++
    }
  }

  await bw.done()
  console.log(
    `  remapped ${remapped}, already migrated ${alreadyMigrated},` +
      ` no legacy payload ${noLegacyPayload}`,
  )

  // pass08 wrote each event's `completed_checkins_count` from the check-ins as
  // they stood BEFORE this pass. Recomputing is_completed can therefore leave
  // that number stale — rare, but silent, and it is the number the event page
  // shows. Re-running the events pass recounts it from the target docs.
  if (flipped > 0) {
    console.warn(
      `  ⚠ is_completed changed on ${flipped} checkin(s) across ${flippedEventIds.size} event(s).` +
        ` Re-run \`--only events\` to recompute completed_checkins_count:` +
        ` ${[...flippedEventIds].join(', ')}`,
    )
  }
}
