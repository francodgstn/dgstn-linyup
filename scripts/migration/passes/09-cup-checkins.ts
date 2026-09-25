import type { MigrationConfig } from '../config'
import { targetDb, SOURCE_EVENT_TYPE_MAP } from '../config'
import { BatchWriter } from '../batch-writer'

/**
 * Pass 9 — remap hmd-lineup's fighting-cup check-in payload onto the shape
 * Linyup reads. The sibling of `09-exam-checkins.ts`, and the same defect: pass
 * 8 copies check-ins verbatim, which is right for every field except the
 * type-specific payload.
 *
 * hmd-lineup kept the cup result at the TOP LEVEL of the check-in:
 *
 *   { categories: [categoryId, …], weight: number }
 *
 * Linyup reads `checkin_data` — `CheckinPanel` hands the form
 * `existing={checkin.checkin_data}`, and the cup form reads `categories` and
 * `weight` off that. So a migrated cup check-in opens EMPTY: no divisions
 * ticked, no weight, on a competitor whose entry is sitting right there in the
 * document one level up.
 *
 * That also made pass 9's category reconstruction land on nothing. It rebuilds
 * `events/{id}/categories` from the ids the check-ins reference — and it reads
 * those ids from BOTH shapes precisely because this pass had not been written
 * yet. With this pass the two agree.
 *
 * NOTHING IS DELETED, the same rule the exam pass follows: the legacy fields are
 * copied under `checkin_data.legacy` and left exactly where they were. A
 * migration that drops the only copy of a field cannot give it back.
 *
 * IS_COMPLETED IS NOT RECOMPUTED HERE, and that is the one real difference from
 * the exam pass. `isCheckinCompleted` auto-confirms any type it has no rule for
 * and otherwise asks for a non-empty `categories` array — which, before this
 * pass, it looked for in `checkin_data` and never found. Recomputing would
 * therefore flip rows whose stored answer came from the SOURCE app's own
 * judgment, which is the better record of what a grader decided a decade ago.
 * The stored value stands.
 *
 * Note on `--dry-run`: this pass reads the check-ins in the TARGET, so a dry run
 * against a target where pass08 has never really run finds nothing to do. That
 * is the truth about that target, not a fault in the pass.
 */

// The legacy top-level fields that made up a cup entry. Preserved verbatim under
// `checkin_data.legacy`.
const LEGACY_CUP_FIELDS = ['categories', 'weight'] as const

// The event types this pass covers, as they stand in the TARGET — i.e. AFTER
// `mapSourceEventType` has run in pass 8. Deriving them from the map rather
// than restating the slug keeps the two from drifting apart.
const CUP_EVENT_TYPES = [...new Set(Object.values(SOURCE_EVENT_TYPE_MAP))]

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function pass09CupCheckins(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 9: fighting-cup checkins → checkin_data.categories / weight')
  const tgt = targetDb()
  const bw = new BatchWriter(tgt, cfg.dryRun)

  let remapped = 0
  let alreadyMigrated = 0
  let noLegacyPayload = 0

  for (const eventType of CUP_EVENT_TYPES) {
    // The EVENT doc is the authority on its own type; `checkin.event.type` is a
    // denormalised copy. Same reasoning as the exam pass — collect the events
    // first, then their check-ins.
    const eventsSnap = await tgt.collection('events').where('type', '==', eventType).get()
    console.log(`  ${eventsSnap.size} '${eventType}' event(s)`)

    for (const eventDoc of eventsSnap.docs) {
      const checkinsSnap = await tgt
        .collection('checkins')
        .where('event.id', '==', eventDoc.id)
        .get()

      for (const cd of checkinsSnap.docs) {
        const data = cd.data() as Record<string, unknown>
        const checkinData = asRecord(data.checkin_data) ?? {}

        // Idempotent: a doc already carrying categories in the new place has
        // been through this pass (or was written by the live app).
        if (checkinData.categories !== undefined) {
          alreadyMigrated++
          bw.skip()
          continue
        }

        const legacyCategories = Array.isArray(data.categories) ? data.categories : null
        const legacyWeight = typeof data.weight === 'number' ? data.weight : null

        if (legacyCategories === null && legacyWeight === null) {
          noLegacyPayload++
          bw.skip()
          continue
        }

        const legacy: Record<string, unknown> = {}
        for (const key of LEGACY_CUP_FIELDS) {
          if (data[key] !== undefined) legacy[key] = data[key]
        }

        const next: Record<string, unknown> = { ...checkinData, legacy }
        // Only the ids that are actually strings. A malformed entry would
        // otherwise reach the category resolver as an id that matches nothing,
        // which is indistinguishable from a deleted division.
        if (legacyCategories) {
          const ids = legacyCategories.filter((v): v is string => typeof v === 'string' && !!v)
          if (ids.length !== legacyCategories.length) {
            console.warn(
              `  checkin ${cd.id}: ${legacyCategories.length - ids.length} category` +
                ` reference(s) were not ids — dropped (kept under checkin_data.legacy)`,
            )
          }
          next.categories = ids
        }
        if (legacyWeight !== null) next.weight = legacyWeight

        bw.merge(cd.ref, { checkin_data: next })
        remapped++
      }
    }
  }

  await bw.done()
  console.log(
    `  remapped ${remapped}, already migrated ${alreadyMigrated},` +
      ` no legacy payload ${noLegacyPayload}`,
  )
}
