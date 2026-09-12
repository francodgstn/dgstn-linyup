import type { RankingSystem, RankLevel, RankRef } from '../types/team'
import { findRankLevel } from './rankLevels'
import { withRankLevelIds } from './rankLevelId'

/**
 * THE rule for which ranking systems apply to a team — the organisation's, or
 * its own.
 *
 * `Organization.ranking_systems` says "when set, overrides individual team
 * ranking_systems for all linked teams", and the load-bearing words are WHEN
 * SET. An organisation that has configured none has not thereby taken the
 * feature away from its studios; it has simply not used it.
 *
 * That distinction was lost in the one place this used to live: the hook
 * returned the org's list whenever an `org_id` existed, so a studio inside an
 * organisation with no systems of its own saw NONE — its own configuration
 * silently invisible. Every other caller then re-derived the rule inline, and
 * two skipped the organisation entirely, which is why an org-managed tenant's
 * dashboard belt breakdown came out blank.
 *
 * One function, so the client hook, the automation builder and the server-side
 * engine cannot disagree about which systems exist.
 */
export function effectiveRankingSystems(
  teamSystems: RankingSystem[] | undefined | null,
  orgSystems: RankingSystem[] | undefined | null,
): RankingSystem[] {
  const chosen = orgSystems && orgSystems.length > 0 ? orgSystems : (teamSystems ?? [])
  // EVERY LEVEL LEAVES HERE WITH AN ID. A ladder document written before
  // Phase 1 of docs/rank-scale-decoupling.md has none; minting it on read with
  // the SAME deterministic slug `backfill:rank-level-ids` writes means a
  // reader never meets an id-less level, and the id it resolves or stores is
  // the one the backfill will put on the document. Idempotent, so a ladder
  // that already carries ids passes through unchanged in content.
  return chosen.map((s) => ({ ...s, levels: withRankLevelIds(s.levels ?? []) }))
}

/** True when the ORGANISATION owns the systems, so a team-level editor locks. */
export function rankingSystemsManagedByOrg(
  orgSystems: RankingSystem[] | undefined | null,
): boolean {
  return (orgSystems?.length ?? 0) > 0
}

/**
 * Is `systemId` one this tenant may actually write to?
 *
 * The membership check every writer of `Contact.ranks` owes: its keys are
 * otherwise arbitrary strings, and an unvalidated write puts a rank under a
 * system id nothing will ever render.
 */
export function isKnownRankingSystem(
  systems: RankingSystem[] | undefined | null,
  systemId: string,
): boolean {
  return (systems ?? []).some((s) => s.id === systemId)
}

/** THE one rank a contact is displayed by — see `primaryRank`. */
export interface PrimaryRank {
  system: RankingSystem
  /** The level the stored ref names — always an exact match; see the note on
   *  orphans below for why there is no stand-in any more. */
  level: RankLevel
  /** The stored ref: the level's id, or a legacy number on a record the data
   *  flip has not reached (resolved through `legacyRankValue`). */
  value: RankRef
}

/**
 * THE one rank a contact is displayed by — the contacts list, the dashboard
 * roster donut, the dashboard preview, the member app's profile card and its
 * rank badges. ONE rule, because it used to be two: the web picked the first
 * system the contact HOLDS a rank in and showed an orphaned value as the
 * nearest lower level; the member app picked the first CONFIGURED system and
 * showed nothing for an orphan — so a member ranked only in a studio's second
 * scale had a belt on the coach's screen and "no belt" in her own app.
 *
 * Picking it is a question about SYSTEMS, never a comparison of numbers. A rank
 * value is an ordinal INSIDE its own system and means nothing outside it: a 7
 * in Korean Dragon and a 3 in Hwal Moo Do are each "the level at that step of
 * that scale", so the larger number is not the higher rank — it is a different
 * scale, with a different number of steps and a different starting point. The
 * web used to fall back to `Object.entries(ranks).sort(([, a], [, b]) => b - a)`,
 * i.e. biggest number wins, which quietly let a beginner in a long scale
 * outrank a black belt in a short one and decided which belt the contact
 * appeared to hold everywhere.
 *
 * So this invents no ranking at all: the tenant's own `is_primary` flag if one
 * is set, otherwise the FIRST system in the tenant's configured order that this
 * contact holds a rank in. That order is the studio's own editorial decision
 * and it is stable, so the same contact shows the same belt on every surface
 * and between renders. A flagged primary wins outright, even for a contact who
 * holds no rank in it — that contact then shows no belt. Back-filling from
 * another system would override an explicit tenant decision about which scale
 * identifies a person here.
 *
 * AN ORPHAN RESOLVES TO NOTHING. A contact holding a ref no level carries any
 * more (a level deleted under them) used to be shown at the nearest level
 * BELOW the old number, behind an `orphaned` flag almost nothing read — a
 * silent demotion, which docs/rank-scale-decoupling.md names as the failure
 * the whole decoupling exists to remove. Identities do not sort, so since
 * Phase 4 there is no stand-in for either kind of ref: the badge is blank,
 * which shows the damage instead of disguising it. The cure is upstream,
 * where the levels are edited: both ranking editors count the holders and
 * warn before a delete orphans anybody.
 *
 * No sport-specific fallback: a tenant that has not configured any ranking
 * system simply has nothing to show, and the caller hides the badge rather
 * than inventing a default belt table.
 */
export function primaryRank(
  contact: { ranks?: Record<string, RankRef> | null },
  systems: RankingSystem[] | undefined | null,
): PrimaryRank | null {
  const list = systems ?? []
  const ranks = contact.ranks ?? {}
  if (!list.length || !Object.keys(ranks).length) return null

  const primary = list.find((s) => s.is_primary)
  const system = primary ?? list.find((s) => ranks[s.id] !== undefined)
  if (!system) return null

  const value = ranks[system.id]
  if (value === undefined || value === null) return null

  const exact = findRankLevel(system.levels ?? [], value)
  return exact ? { system, level: exact, value } : null
}
