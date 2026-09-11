import type { RankLevel } from '../types/team'

/**
 * STABLE IDENTITIES FOR RANK LEVELS — Phase 1 of docs/rank-scale-decoupling.md.
 *
 * `RankLevel.value` was doing three jobs at once: the identity stored on every
 * record, the ladder's sort order, and the key the progression rules match on.
 * Inserting or reordering a level therefore renumbered everything above it and
 * silently changed what every stored number meant. The cure is an identity
 * that is minted once and never touched again, which is what these produce.
 *
 * TWO WAYS TO MINT, deliberately:
 *
 *   `withRankLevelIds`   DETERMINISTIC, from the label. For seeds, presets, the
 *                        HMD migration and the backfill — anything that must
 *                        produce the SAME ids on every run, or a re-seed would
 *                        orphan every contact the previous run ranked.
 *   `newRankLevelId`     RANDOM. For a level a person adds in an editor, whose
 *                        label is empty at that moment and may be retyped
 *                        several times before it is saved.
 *
 * Both are OPAQUE by contract. A slug happens to be readable in Firestore, which
 * helps operations, but nothing may parse it, derive order from it, or assume
 * it still matches the label — a level renamed from "Yellow" to "Gold" keeps
 * the id `yellow`, and that is correct.
 */

/** Lowercase ASCII slug: diacritics stripped, everything else collapsed to `-`. */
function slugOf(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A deterministic id for `label`, unique against `taken`. An empty slug (an
 * emoji-only label, say) falls back to the level's position at mint time — a
 * position that is then frozen into the id and never recomputed.
 */
export function slugRankLevelId(label: string, taken: Iterable<string>, position = 0): string {
  const used = new Set(taken)
  const base = slugOf(label) || `level-${position}`
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A random id for a level created in an editor. Ten base-36 characters. */
export function newRankLevelId(): string {
  let out = ''
  for (let i = 0; i < 10; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

/**
 * The same levels with every missing `id` filled in deterministically.
 *
 * IDEMPOTENT and ORDER-PRESERVING: a level that already carries an id keeps
 * it, ids are deduplicated within the array, and running it twice yields the
 * same result — which is what lets the backfill be re-run and lets a fresh
 * migration agree with a backfilled one.
 */
export function withRankLevelIds(levels: ReadonlyArray<RankLevel>): RankLevel[] {
  const taken = new Set(levels.map((l) => l.id).filter((id): id is string => !!id))
  return levels.map((level, i) => {
    if (level.id) return level
    const id = slugRankLevelId(level.label, taken, i)
    taken.add(id)
    return { ...level, id }
  })
}
