import type { RankProgression } from './rankProgression'
import type { PluginId } from './plugin'

/**
 * CONTENT A PLUGIN BRINGS WITH IT — applied when the plugin is installed.
 *
 * A plugin's install is normally just a permission: the document exists, so the
 * gates open. Some plugins also carry DATA the tenant would otherwise have to
 * type in — HMD's belt progression rules are twelve requirements across four
 * bands, and asking a federation to re-enter its own grading ladder in a form is
 * not a product, it is a chore with typos in it.
 *
 * ── WHY THIS IS NOT `PluginManifest.seeds` ───────────────────────────────────
 * That is where it was designed to go, and it cannot: the manifests live in
 * `apps/web/src/plugins/*` and the seeder runs in Cloud Functions, which cannot
 * import them. Same constraint, same answer, as `PLUGIN_BUNDLES`,
 * `PLUGIN_ADDONS` and `PLUGIN_CHECKIN_COMPLETION` — `@linyup/shared` is the only
 * module both sides reach, and declaring it twice would be a copy for a test to
 * police.
 *
 * ── THE FOUR RULES OF A SEED ─────────────────────────────────────────────────
 *
 *  1. FIXED DOCUMENT IDS. A seeded document's id is derived from the seed, never
 *     generated — `rank_progressions/{systemId}`, not an auto-id. That is what
 *     makes re-application converge instead of accumulating duplicates, and it
 *     is the same discipline `onTeamCreated` already follows with `system_key`.
 *
 *  2. A HUMAN'S EDIT WINS, FOREVER. `updated_by` set on the target document
 *     means somebody changed it, and a later seed version leaves it entirely
 *     alone. A federation that tuned its own ladder must not have that reverted
 *     by a deploy — and the alternative, merging, would make "which rule applied
 *     to this grading" stop having one answer.
 *
 *  3. UNINSTALL LEAVES EVERYTHING. There is deliberately no teardown. A seeded
 *     rule that has been in use for a year is the organisation's, not the
 *     plugin's, and deleting one would strand every grading recorded against it.
 *     Re-installing therefore finds its own documents and converges on
 *     `seed_version` rather than starting again.
 *
 *  4. IT NEVER TOUCHES A TENANT'S OWN COLLECTIONS. A seed writes only where the
 *     plugin's own model lives. It cannot create contacts, sessions or money.
 */

/** One rank-progression document to lay down, keyed by the system it governs. */
export interface RankProgressionSeed {
  /** Doc id under `rank_progressions`, and equal to the RankingSystem.id. */
  systemId: string
  /** Everything but the provenance, which the applier stamps. */
  progression: Omit<
    RankProgression,
    'id' | 'seed_plugin_id' | 'seed_version' | 'updated_by' | 'updated_at'
  >
}

export interface PluginSeedBundle {
  /**
   * Bump to re-apply. A target whose stored `seed_version` is >= this one is
   * already current and is skipped, so an install, a reinstall and a retry all
   * write the same thing exactly once.
   */
  version: number
  /**
   * ORG-SCOPED ONLY, deliberately.
   *
   * Progression rules are read org-first (`organizations/{id}/rank_progressions`
   * wins over a team's), and every plugin that seeds them today installs at org
   * level. A TEAM-scoped seed would additionally have to fan out to every active
   * `org_teams` member on an org install and seed again on join — real
   * machinery, with nothing yet asking for it. When something does, it goes
   * beside this field rather than inside it.
   */
  rankProgressions?: RankProgressionSeed[]
}

// ─── HMD's belt ladder ────────────────────────────────────────────────────────

/**
 * Cup, tournament and competition are ONE bucket to HMD.
 *
 * Declared once and referenced by each band, because `eventTypes` is already a
 * list — core needs no notion of "synonym" for the organisation to say that its
 * own cup counts as a tournament.
 */
const TOURNAMENT_TYPES = ['competition', 'hmd_fighting_cup']

/**
 * ONE CAMP, ONE TOURNAMENT, ONE BELT TEST — HMD's participation rule, and the
 * same three requirements at every dan.
 *
 * `roles` is deliberately ABSENT on all three: turning up as support — staff,
 * coach, volunteer — counts exactly as competing does. That is the
 * organisation's rule, and omitting the field is how it is written.
 */
const ONE_ONE_ONE = [
  { eventTypes: TOURNAMENT_TYPES, min: 1 },
  { eventTypes: ['camp'], min: 1 },
  { eventTypes: ['exam'], min: 1 },
]

/**
 * HMD's rules, as the organisation actually grades.
 *
 * ── COLOUR BELTS HAVE NO ENTRY, AND THAT IS THE RULE ────────────────────────
 * Everything up to and including Red/Black is graded at the instructor's
 * discretion. There is no band for those levels, so the engine answers
 * `not_configured` — which is a different answer from "not eligible" and the UI
 * must not render it as a refusal. Writing a permissive band instead would be a
 * claim the organisation never made.
 *
 * ── THE CLOCK RUNS FROM THE PREVIOUS EXAM ───────────────────────────────────
 * Not the promotion, and not the calendar year. A dan belt is conferred a year
 * AFTER the exam that earned it, so anchoring on the promotion would silently
 * add that year to every subsequent interval.
 *
 * ── YEARS REQUIRED = THE DAN BEING TAKEN ────────────────────────────────────
 * 1st→2nd is two years, 2nd→3rd is three. Both the elapsed time and the number
 * of qualifying years scale together, and each qualifying year needs its own
 * 1-1-1. Written out per band rather than as a formula: there are four of them,
 * a human can check each line, and the Phase 7 settings editor can present rows
 * without becoming a formula editor.
 *
 * ── THE SECOND GATE IS THE PROBATION YEAR ───────────────────────────────────
 * `promotionDelay` on each dan band: the belt is awarded twelve months after the
 * exam, and that year must itself have been a qualifying one. It ALSO counts
 * toward the next dan — the one place a year is deliberately shared between two
 * gradings, which `rankEligibility`'s own header warns is not a bug to fix.
 *
 * ── THE BANDS NAME LEVELS BY IDENTITY ───────────────────────────────────────
 * `from`/`to` are the levels' stable ids (docs/rank-scale-decoupling.md), the
 * same strings scripts/migration/config.ts writes on the HMD ladder. Inserting
 * or reordering a belt moves nothing here, which is the whole point of the
 * change from the numbers these used to be.
 *
 * Seed `version` was bumped to 2 with that change so every organisation on
 * version 1 is re-seeded with ids. The one hazard the reconciler cannot fix:
 * an organisation whose progression a HUMAN edited (`updated_by` set) is never
 * rewritten, and keeps its old numeric bands. Those still evaluate — the
 * matcher resolves a legacy number by `value` while `value` exists — but the
 * Phase 2 data flip must report them so they are converted by hand.
 */
const HMD_BELT_RULES: RankProgressionSeed = {
  systemId: 'hmd',
  progression: {
    rules: [
      // → Black I Dan. Six months, not a year: the window is shorter than the
      // qualifying-year machinery describes, so it is three flat participation
      // requirements rather than `qualifying_years`.
      {
        from: 'black-i-dan',
        to: 'black-i-dan',
        requirements: [
          { id: 'time', kind: 'time_since_previous_exam', amount: 6, unit: 'months' },
          ...ONE_ONE_ONE.map((spec, i) => ({
            id: `part_${i}`,
            kind: 'event_participation' as const,
            spec,
            since: 'previous_exam' as const,
          })),
        ],
        promotionDelay: {
          amount: 12,
          unit: 'months' as const,
          requirements: ONE_ONE_ONE.map((spec, i) => ({
            id: `probation_${i}`,
            kind: 'event_participation' as const,
            spec,
            since: 'previous_exam' as const,
          })),
        },
      },
      // → Black II Dan. Two years, two qualifying years.
      {
        from: 'black-ii-dan',
        to: 'black-ii-dan',
        requirements: [
          { id: 'time', kind: 'time_since_previous_exam', amount: 24, unit: 'months' },
          { id: 'active', kind: 'qualifying_years', minYears: 2, perYear: ONE_ONE_ONE },
        ],
        promotionDelay: {
          amount: 12,
          unit: 'months' as const,
          requirements: ONE_ONE_ONE.map((spec, i) => ({
            id: `probation_${i}`,
            kind: 'event_participation' as const,
            spec,
            since: 'previous_exam' as const,
          })),
        },
      },
      // → Black III Dan. Three years, three qualifying years.
      {
        from: 'black-iii-dan',
        to: 'black-iii-dan',
        requirements: [
          { id: 'time', kind: 'time_since_previous_exam', amount: 36, unit: 'months' },
          { id: 'active', kind: 'qualifying_years', minYears: 3, perYear: ONE_ONE_ONE },
        ],
        promotionDelay: {
          amount: 12,
          unit: 'months' as const,
          requirements: ONE_ONE_ONE.map((spec, i) => ({
            id: `probation_${i}`,
            kind: 'event_participation' as const,
            spec,
            since: 'previous_exam' as const,
          })),
        },
      },
      // → Master. FOUR years by the same arithmetic (years = the grade being
      // taken), and it is here rather than omitted so the ladder does not end
      // in `not_configured` at its top step — which would read as "no rule"
      // where the organisation does in fact have one.
      {
        from: 'master',
        to: 'master',
        requirements: [
          { id: 'time', kind: 'time_since_previous_exam', amount: 48, unit: 'months' },
          { id: 'active', kind: 'qualifying_years', minYears: 4, perYear: ONE_ONE_ONE },
        ],
        promotionDelay: {
          amount: 12,
          unit: 'months' as const,
          requirements: ONE_ONE_ONE.map((spec, i) => ({
            id: `probation_${i}`,
            kind: 'event_participation' as const,
            spec,
            since: 'previous_exam' as const,
          })),
        },
      },
    ],
    system_key: 'hmd_belts',
  },
}

/**
 * Korean Dragon follows Hwal Moo Do's ladder exactly.
 *
 * An alias rather than a copy: one document to edit, and "which rule governs
 * this system" stays a lookup instead of becoming a query. `alias_of` is
 * resolved in one hop and never chains.
 */
const KD_BELT_RULES: RankProgressionSeed = {
  systemId: 'kd',
  progression: { alias_of: 'hmd', rules: [], system_key: 'hmd_belts' },
}

/**
 * Seed content by plugin id.
 *
 * A plugin absent from this map seeds nothing, which is every plugin but one.
 */
export const PLUGIN_SEEDS: Partial<Record<PluginId, PluginSeedBundle>> = {
  'hmd-belts': {
    // 2: the bands name levels by id instead of by number — see HMD_BELT_RULES.
    version: 2,
    rankProgressions: [HMD_BELT_RULES, KD_BELT_RULES],
  },
}

/** The seed bundle for `id`, or undefined when it carries none. */
export function pluginSeeds(id: PluginId): PluginSeedBundle | undefined {
  return PLUGIN_SEEDS[id]
}
