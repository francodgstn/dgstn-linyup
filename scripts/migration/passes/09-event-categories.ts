import type { MigrationConfig } from '../config'
import { sourceDb, targetDb, RANKING_HMD, rankingSystemLevelId } from '../config'
import { BatchWriter } from '../batch-writer'

/**
 * Pass 9 — rebuild the fighting-cup categories the migrated check-ins point at.
 *
 * hmd-lineup kept competition categories in ONE GLOBAL top-level `categories`
 * collection, shared by every event; Linyup keeps them per event, at
 * `events/{eventId}/categories/{categoryId}`. No pass migrated them, so a
 * migrated cup check-in carries a `categories: [id]` array whose ids resolve to
 * nothing — the check-in still says the competitor entered three divisions and
 * the app can name none of them.
 *
 * This pass reads the ids the check-ins actually reference, fetches those docs
 * from the SOURCE global collection and writes them under each event that uses
 * them, PRESERVING THE DOC ID so the arrays that already exist resolve.
 * Categories nobody entered are not copied: a global list shared by a decade of
 * cups would otherwise land on every event that ever ran one.
 *
 * The two shapes and how they map:
 *
 *   source: { style, level, gender, age_range: [min, max],
 *             rank_range: [min, max], deleted_at }
 *   target: EventCategory (packages/shared/src/types/event.ts)
 *
 * `style` and `level` are free text with no field of their own on this side, so
 * they become the NAME; gender and both ranges have real fields and are not
 * repeated in it. What could not be mapped is called out at each site below
 * rather than guessed at.
 *
 * Note on `--dry-run`: this pass reads the check-ins in the TARGET, so a dry run
 * against a target where pass08 has never really run finds nothing to do. That
 * is the truth about that target, not a fault in the pass.
 */

// The source never linked a category to a ranking system because it did not have
// any: `rank_range` was compared against `contact.rank`, the primary Hwal Moo Do
// belt (see FightingCupForm.hook.js in hmd-lineup). That scale is RANKING_HMD.
const RANK_RANGE_SYSTEM_ID = RANKING_HMD

// Source gender tokens, as written by hand in the Firebase console over the
// years. Anything not listed leaves `gender` unset and warns — better an
// unrestricted category the studio can correct than a division that quietly
// excludes half its entrants.
const GENDER_TOKENS: Record<string, 'M' | 'F' | 'both'> = {
  M: 'M',
  MALE: 'M',
  MASCHILE: 'M',
  MASCHI: 'M',
  UOMINI: 'M',
  F: 'F',
  FEMALE: 'F',
  FEMMINILE: 'F',
  FEMMINE: 'F',
  DONNE: 'F',
  BOTH: 'both',
  ALL: 'both',
  MIXED: 'both',
  MISTO: 'both',
  'M/F': 'both',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `[min, max]` → two numbers, tolerating a missing or half-filled pair. */
function readRange(value: unknown): { min?: number; max?: number } {
  if (!Array.isArray(value)) return {}
  const min = Number(value[0])
  const max = Number(value[1])
  return {
    min: Number.isFinite(min) ? min : undefined,
    max: Number.isFinite(max) ? max : undefined,
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Sort key reproducing the printed lineup order (PdfFightingCupExport). */
function sortKey(src: Record<string, unknown>): string {
  const { min } = readRange(src.age_range)
  return [
    text(src.style).toUpperCase(),
    text(src.gender).toUpperCase(),
    text(src.level).toUpperCase(),
    String(min ?? 0).padStart(3, '0'),
  ].join('|')
}

function mapCategory(
  categoryId: string,
  src: Record<string, unknown>,
  sortOrder: number,
): Record<string, unknown> {
  const style = text(src.style)
  const level = text(src.level)
  const age = readRange(src.age_range)
  const rank = readRange(src.rank_range)

  const out: Record<string, unknown> = {
    // No `id` field: the app's own writer (CategoryManager) doesn't store one
    // either — useCategories reads it off the doc id.
    name: [style, level].filter(Boolean).join(' · ') || categoryId,
    // sort_order is NOT optional in practice: useCategories orders by it, and
    // Firestore omits any document missing the ordered field. A category
    // written without one would exist and be invisible in both the manager and
    // the check-in form.
    sort_order: sortOrder,
  }

  // An unmappable token leaves the category unrestricted; it is reported once
  // per category by the caller, not once per event that references it.
  const gender = GENDER_TOKENS[text(src.gender).toUpperCase()]
  if (gender) out.gender = gender

  if (age.min !== undefined) out.min_age = age.min
  if (age.max !== undefined) out.max_age = age.max

  if (rank.min !== undefined || rank.max !== undefined) {
    out.ranking_system_id = RANK_RANGE_SYSTEM_ID
    // The LEVEL'S ID (docs/rank-scale-decoupling.md), like every other rank
    // ref this migration writes; a source ordinal the ladder does not carry is
    // written as the number it was, which the check-in form then cannot
    // resolve — an unrestricted bound rather than a silently wrong one.
    if (rank.min !== undefined) out.min_rank = rankingSystemLevelId(RANK_RANGE_SYSTEM_ID, rank.min) ?? rank.min
    if (rank.max !== undefined) out.max_rank = rankingSystemLevelId(RANK_RANGE_SYSTEM_ID, rank.max) ?? rank.max
  }

  // NOT MAPPED, deliberately:
  //   min_weight / max_weight — a source category has no weight bracket. HMD
  //     recorded weight on the CHECK-IN and matched divisions by age and rank
  //     only, so there is nothing to carry across and nothing to invent.
  //   color — the source had none; the manager falls back to grey.
  //
  // CARRIED VERBATIM: `deleted_at`. EventCategory has no soft-delete field of
  // its own, but a category still referenced by a check-in has to be written or
  // that check-in points at nothing again — so the fact travels with it rather
  // than being dropped, which would resurrect a retired division as pristine.
  //
  // THE READER THAT HONOURS IT is the check-in form's eligibility filter
  // (plugins/hmd-fighting-cup/CheckinForm.tsx), which refuses to OFFER a
  // retired division for a new entry. The categories hook still returns it, on
  // purpose: the lineup export has to be able to name what a twenty-year-old
  // check-in says the competitor entered. Naming a past division and offering it
  // today are different questions.
  if (src.deleted_at != null) out.deleted_at = src.deleted_at

  return out
}

export async function pass09EventCategories(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 9: fighting-cup categories → events/{eventId}/categories')
  const src = sourceDb()
  const tgt = targetDb()
  const bw = new BatchWriter(tgt, cfg.dryRun)

  // ONE scan of the target check-ins, grouped by event. The alternative — a
  // check-ins query per event — asks the same question once per exam and camp
  // too, and most events have no categories at all. Only the ids are kept.
  const checkinsSnap = await tgt.collection('checkins').get()
  const byEvent = new Map<string, Set<string>>()

  for (const cd of checkinsSnap.docs) {
    const data = cd.data() as Record<string, unknown>
    const eventId = asRecord(data.event)?.id
    if (typeof eventId !== 'string' || !eventId) continue

    // `checkin_data.categories` is the Linyup shape; the top-level array is the
    // legacy one pass08 copied verbatim. Both are read because a migrated cup
    // carries the second and anything checked in since carries the first.
    const checkinData = asRecord(data.checkin_data)
    const raw = Array.isArray(checkinData?.categories)
      ? checkinData.categories
      : Array.isArray(data.categories)
        ? data.categories
        : []
    if (raw.length === 0) continue

    const ids = byEvent.get(eventId) ?? new Set<string>()
    for (const id of raw) if (typeof id === 'string' && id) ids.add(id)
    if (ids.size > 0) byEvent.set(eventId, ids)
  }

  const referencedIds = new Set<string>()
  for (const ids of byEvent.values()) for (const id of ids) referencedIds.add(id)
  console.log(
    `  ${byEvent.size} event(s) reference ${referencedIds.size} distinct categor(ies)`,
  )
  if (referencedIds.size === 0) {
    await bw.done()
    return
  }

  // Fetch only what is referenced, in getAll-sized chunks.
  const sourceCategories = new Map<string, Record<string, unknown>>()
  const idList = [...referencedIds]
  for (let i = 0; i < idList.length; i += 100) {
    const refs = idList.slice(i, i + 100).map((id) => src.collection('categories').doc(id))
    const snaps = await src.getAll(...refs)
    for (const snap of snaps) {
      if (snap.exists) sourceCategories.set(snap.id, snap.data() as Record<string, unknown>)
    }
  }

  for (const [id, data] of sourceCategories) {
    const raw = text(data.gender)
    if (raw && !GENDER_TOKENS[raw.toUpperCase()]) {
      console.warn(`  category ${id}: gender '${raw}' has no mapping — left unrestricted`)
    }
  }

  let written = 0
  let missing = 0

  for (const [eventId, ids] of byEvent) {
    // sort_order is per event, so the order is computed within each event's own
    // referenced set — the printed lineup order the club already knows.
    const present = [...ids]
      .filter((id) => sourceCategories.has(id))
      .sort((a, b) => sortKey(sourceCategories.get(a)!).localeCompare(sortKey(sourceCategories.get(b)!)))

    for (const id of ids) {
      if (!sourceCategories.has(id)) {
        console.warn(
          `  event ${eventId}: category ${id} is referenced by a checkin but does not` +
            ` exist in the source global collection — cannot reconstruct`,
        )
        missing++
        bw.skip()
      }
    }

    for (const [index, id] of present.entries()) {
      const tgtRef = tgt.collection('events').doc(eventId).collection('categories').doc(id)
      if (!cfg.dryRun) {
        const existing = await tgtRef.get()
        if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
      }
      bw.set(tgtRef, mapCategory(id, sourceCategories.get(id)!, index))
      written++
    }
  }

  await bw.done()
  console.log(`  reconstructed ${written} category doc(s), ${missing} unresolvable reference(s)`)
}
