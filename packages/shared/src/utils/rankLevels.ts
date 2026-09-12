import type { RankLevel, RankRef, RankingSystem } from '../types/team'

/**
 * RESOLVING A LEVEL BY ITS IDENTITY — Phase 2 of docs/rank-scale-decoupling.md.
 *
 * Every record that names a level (`Contact.ranks`, an exam's `disciplines`, a
 * filter band, a progression rule) holds a `RankRef`: the level's `id`, or — on
 * a record written before ids existed — its legacy `value`. These helpers are
 * the ONLY place that distinction lives. A reader asks for a level by ref and
 * never looks at `value` itself; a writer stores `rankLevelKey(level)` and
 * never invents a number.
 *
 * ── ORDER IS ARRAY POSITION ─────────────────────────────────────────────────
 *
 * Phase 3 of the plan, landed here because the two cannot be separated: once a
 * record points at an identity, "is Blue above Yellow" can only be answered by
 * where the two sit in the ladder, and the ladder is `system.levels` in the
 * order the studio keeps it. `value` is no longer consulted for order anywhere.
 *
 * That reverses the rule `expandRankRange` used to state ("order is by value,
 * not by position"). It is safe to reverse because no writer ever produced an
 * out-of-order array — both editors append one above the highest, and every
 * seed, preset and the migration list their levels ascending — and because a
 * drag-and-drop reorder (Phase 5) will make array order the studio's explicit
 * intent, which is the whole point.
 *
 * ── THE LEGACY ARM IS NOT A CONVENIENCE ─────────────────────────────────────
 *
 * A number is resolved against the `value` a ladder document written before
 * Phase 4 still carries, so that a record the data flip (`backfill:rank-refs`)
 * has not yet reached, and an installed member app that still writes numbers,
 * keep resolving to the right belt. `RankLevel` no longer declares that field
 * (Phase 4): `legacyRankValue` below is the ONE place that peeks at it, and
 * `rankValueCensus.test.ts` pins who may call it. Both go when the flip has
 * run everywhere and `backfill:rank-refs --strip-values` has removed the field
 * from the ladders (Phase 4b). Nothing new may write a number.
 */

/**
 * The one field identity resolution needs. Every helper below takes this
 * rather than a full `RankLevel`, so a mirror, a fixture or a test double
 * that carries only an `id` can be resolved against.
 */
export type RankLevelLike = { id: string }

/**
 * The ordinal a ladder document written before Phase 4 still carries on a
 * level, or undefined. THE ONE READER of the field `RankLevel` no longer
 * declares — for resolving a record that still holds a number, and for the
 * two ranking editors' holder counts, which must still find those records.
 * Deleted with the field in Phase 4b; see the module header.
 */
export function legacyRankValue(level: RankLevelLike): number | undefined {
  const v = (level as { value?: unknown }).value
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** The ref a writer stores for `level`: its id. Nothing else, any more. */
export function rankLevelKey(level: RankLevelLike): RankRef {
  return level.id
}

/** Same level? Compares identities, never values, once ids exist. */
export function sameRankRef(a: RankRef | null | undefined, b: RankRef | null | undefined): boolean {
  if (a == null || b == null) return false
  return String(a) === String(b)
}

/**
 * The level `ref` names, or undefined. A string is an id; a number is a legacy
 * value. A numeric STRING is still an id — a label "3" slugs to "3" — so no
 * coercion happens here, deliberately.
 */
export function findRankLevel<L extends RankLevelLike>(
  levels: ReadonlyArray<L> | undefined | null,
  ref: RankRef | null | undefined,
): L | undefined {
  if (ref == null || !levels) return undefined
  if (typeof ref === 'string') return levels.find((l) => l.id === ref)
  return levels.find((l) => legacyRankValue(l) === ref)
}

/** Position of `ref` in the ladder, or -1. Array order IS the order. */
export function rankLevelIndex(
  levels: ReadonlyArray<RankLevelLike> | undefined | null,
  ref: RankRef | null | undefined,
): number {
  const level = findRankLevel(levels, ref)
  return level && levels ? levels.indexOf(level) : -1
}

/** The ladder in its own order. Kept as a function so every reader goes through
 *  ONE place, which is where the rule about order is written down. */
export function orderedLevels(system: Pick<RankingSystem, 'levels'>): RankLevel[] {
  return [...(system.levels ?? [])]
}

/** The level immediately above `current`, or null at the top. With no current
 *  level, the first one. Reads the ladder, never arithmetic on a number. */
export function nextLevel(
  system: Pick<RankingSystem, 'levels'>,
  current: RankRef | null | undefined,
): RankLevel | null {
  const levels = orderedLevels(system)
  if (current == null) return levels[0] ?? null
  const i = rankLevelIndex(levels, current)
  if (i < 0) return null
  return levels[i + 1] ?? null
}

/** The label of `ref` in this system, or null when the ladder no longer carries
 *  it — which happens to a record written before the level was removed. */
export function levelLabel(system: Pick<RankingSystem, 'levels'>, ref: RankRef | null | undefined): string | null {
  return findRankLevel(system.levels, ref)?.label ?? null
}

/**
 * Is `ref` inside the inclusive band [min, max] by ladder POSITION?
 *
 * An open end is unbounded. A bound naming a level the ladder no longer has
 * makes the band unsatisfiable rather than open: a deleted bound must never
 * widen who a saved filter or dynamic group reaches.
 */
export function rankRefWithin(
  levels: ReadonlyArray<RankLevelLike> | undefined | null,
  ref: RankRef | null | undefined,
  min: RankRef | null | undefined,
  max: RankRef | null | undefined,
): boolean {
  const i = rankLevelIndex(levels, ref)
  if (i < 0) return false
  if (min != null) {
    const lo = rankLevelIndex(levels, min)
    if (lo < 0 || i < lo) return false
  }
  if (max != null) {
    const hi = rankLevelIndex(levels, max)
    if (hi < 0 || i > hi) return false
  }
  return true
}
