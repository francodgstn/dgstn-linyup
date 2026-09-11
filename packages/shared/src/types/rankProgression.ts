import type { Timestamp } from './common'
import type { RankRef } from './team'
import { rankRefWithin } from '../utils/rankLevels'
import type { RankLevel, RankingSystem } from './team'

/**
 * RANK PROGRESSION — what a person must do to be considered for the next level
 * of a ranking system.
 *
 * ── IT NEVER PROMOTES ANYBODY ────────────────────────────────────────────────
 * Promotion is a human act, at every level, without exception. This engine
 * answers "what does the next grade ask for, and where is this person against
 * it" and nothing else: it does not award, it does not block a check-in, and no
 * caller may treat its answer as permission. A grading panel is standing in the
 * room with the student; software that overrules them would simply be worked
 * around by editing data, which is worse than being advisory.
 *
 * That is why the result carries a per-requirement CHECKLIST rather than a
 * verdict — the useful output is "2027 is missing a tournament", not "no".
 *
 * ── IT IS GENERIC, AND HMD IS ONLY ITS FIRST CUSTOMER ────────────────────────
 * Nothing here knows about belts, dan grades or martial arts. A swim school
 * whose levels require a number of attended lessons, or a dance school with
 * graded exams, expresses that with the same vocabulary. HMD contributes RULE
 * DATA (seeded per organisation), never code.
 *
 * Plugins may contribute new requirement kinds through a namespaced
 * `plugin:{id}:{name}` id — the same shape `PluginActionId` uses for the
 * automation engine, and resolved the same way: the manifest DECLARES, a
 * registry IMPLEMENTS.
 */

// ─── Where the rules live ─────────────────────────────────────────────────────
//
//   organizations/{orgId}/rank_progressions/{systemId}   ← wins when present
//   teams/{teamId}/rank_progressions/{systemId}          ← used when no org doc
//
// Per-system DOCUMENTS, not an array field on the tenant: rules are much larger
// than `levels`, they are edited independently, and the org document is read on
// every `useRankingSystems()` call. Resolution is ALL-OR-NOTHING per system —
// the org document or the team's, never a field-level merge, because merging is
// how "which rule applied to this grading" stops having one answer.

export const RANK_PROGRESSIONS_SUBCOLLECTION = 'rank_progressions'

// ─── Requirement vocabulary ───────────────────────────────────────────────────

/** A requirement contributed by a plugin. Mirrors PluginActionId/PluginTriggerId. */
export type PluginRequirementId = `plugin:${string}:${string}`

export type TimeUnit = 'days' | 'months' | 'years'

/** Roles a person can hold at an event. */
export const PARTICIPATION_ROLES = ['participant', 'staff', 'coach', 'volunteer'] as const
export type ParticipationRole = (typeof PARTICIPATION_ROLES)[number]

/**
 * A completed check-in with NO recorded role means the person took part.
 *
 * Every non-camp check-in in HMD's migrated history is in exactly that state —
 * `join_as` has only ever been collected for camps — and reading those as
 * anything but participation would erase twenty years of the organisation's own
 * record.
 */
export const DEFAULT_PARTICIPATION_ROLE: ParticipationRole = 'participant'

/**
 * "Turned up to N of these."
 *
 * `roles` ABSENT means any role counts, which is how "actively or as support" is
 * written — and it is the common case, not the exception. A club that wants
 * participants only writes `roles: ['participant']`.
 */
export interface EventParticipationSpec {
  /**
   * Event types that satisfy this. Built-in slugs AND plugin event-type ids
   * ('hmd_fighting_cup'), so a plugin's own event type is expressible as DATA
   * and needs no requirement kind of its own. Several ids here is how synonyms
   * are handled — cup, tournament and competition are one bucket to HMD, and
   * core needs no notion of synonymy to say so.
   */
  eventTypes: string[]
  /** Minimum number of COMPLETED check-ins. */
  min: number
  roles?: ParticipationRole[]
}

/** Where a window starts. Anchored on the previous EXAM, never the promotion —
 *  the exam date is what a certificate records and what the next exam counts
 *  from, and the two differ by the probation year. */
export type RequirementSince = 'previous_exam' | 'first_exam' | 'always'

export interface RequirementBase {
  /**
   * Stable id within the rule. It is the key the result is reported under, so
   * it is never reused and never renamed — a renamed id silently detaches any
   * progress or override recorded against it.
   */
  id: string
  /** Optional per-locale override. Absent = the UI renders a sentence from the
   *  requirement's own shape, which is the normal case. */
  label?: Partial<Record<'en' | 'de' | 'fr' | 'it', string>>
  /** Shown and evaluated, but never counts toward eligibility. The escape hatch
   *  for "we track it, we don't decide on it". */
  advisory?: boolean
}

export type RankRequirement =
  | (RequirementBase & { kind: 'time_since_previous_exam'; amount: number; unit: TimeUnit })
  | (RequirementBase & { kind: 'time_in_system'; amount: number; unit: TimeUnit })
  | (RequirementBase & {
      kind: 'event_participation'
      spec: EventParticipationSpec
      since: RequirementSince
    })
  | (RequirementBase & {
      kind: 'qualifying_years'
      /** How many 12-month windows must each satisfy `perYear` in full. */
      minYears: number
      perYear: EventParticipationSpec[]
    })
  | (RequirementBase & { kind: 'sessions_attended'; min: number; since: RequirementSince })
  | (RequirementBase & { kind: 'min_age'; years: number })
  | (RequirementBase & { kind: 'affiliation_active'; typeKey?: string })
  | (RequirementBase & { kind: PluginRequirementId; config?: Record<string, unknown> })

// ─── The rule ─────────────────────────────────────────────────────────────────

export interface RankLevelRule {
  /**
   * The TARGET level band this governs, inclusive, by LADDER POSITION of the two
   * named levels. A band lets "every kyu needs three months" be one entry rather
   * than six. Each end is a `RankRef` — the level's id, or a legacy value on a
   * document seeded before ids existed.
   */
  from: RankRef
  to: RankRef
  requirements: RankRequirement[]
  /**
   * How long AFTER the exam the level is actually conferred, and the
   * requirements that period must itself satisfy.
   *
   * This is the second gate, and it is a different question asked at a different
   * time: `rankEligibility` answers "may they sit the exam", `promotionReadiness`
   * answers "has the probation period elapsed, and did it count". Absent means
   * the level is conferred at the exam, which is how every non-dan grade works.
   *
   * Note the deliberate overlap: HMD's probation year counts toward the NEXT
   * grade as well as this one. That is not a bug in the window arithmetic — it
   * is the rule, and `hmdRule.test.ts` pins it by name so it is not "fixed".
   */
  promotionDelay?: { amount: number; unit: TimeUnit; requirements?: RankRequirement[] }
}

export interface RankProgression {
  /** Doc id, and equal to the RankingSystem.id it governs. */
  id: string
  /**
   * When set, this system has no rules of its own and follows another system's.
   * One hop, never a chain. HMD's Korean Dragon shares Hwal Moo Do's ladder, and
   * a shared document would make "which rule governs this system" a query rather
   * than a lookup.
   */
  alias_of?: string
  /**
   * Ordered. The FIRST band containing the target level wins — bands are never
   * merged, so "which rule applied" has exactly one answer.
   *
   * A level with NO band is not an error and not a refusal: it means the
   * organisation grades it by judgement alone, and the engine says
   * `not_configured` so the UI can say so too.
   */
  rules: RankLevelRule[]
  /** Seed provenance, so a re-seed converges instead of duplicating. */
  system_key?: string
  seed_plugin_id?: string
  seed_version?: number
  /** Set once a human edits the document — a later seed bump then leaves it
   *  alone rather than reverting their work. */
  updated_by?: string
  updated_at?: Timestamp
}

// ─── Facts ────────────────────────────────────────────────────────────────────

/**
 * Everything the evaluator is allowed to know.
 *
 * The evaluator is PURE and ships to the browser, so every Firestore read
 * happens in a loader instead — the same split `resolvePaymentOptions` uses,
 * for the same reason. The server builds the authoritative snapshot; the client
 * may build an optimistic one.
 *
 * There is a hard reason the server's is authoritative here and not merely
 * preferable: `checkins` are readable only by the team that recorded them or by
 * an org admin, so a studio cannot see the camps a student attended with a
 * sister studio. Assembled client-side, a member of a multi-studio organisation
 * would appear to have done less than they have.
 */
export interface RankFactsSnapshot {
  /** Evaluation instant, passed in and never read from the clock inside — the
   *  same discipline `waiverAcceptanceState` follows, and what makes the
   *  fixtures deterministic. */
  nowMs: number
  /** Current level per system id (Contact.ranks) — a RankRef each. */
  ranks: Record<string, RankRef>
  /**
   * Every COMPLETED check-in, flattened to what a rule can ask about. Sorted
   * ascending by `atMs`.
   */
  participation: ParticipationFact[]
  /** Exam dates, ascending — the anchors every window is measured from. Derived
   *  from participation, but kept separate because "which exams" is a question
   *  about this system, not about attendance in general. */
  examsAtMs: number[]
  sessionsAttended?: number
  birthdateMs?: number | null
  affiliations?: { has_active: boolean; types: string[] }
  /**
   * Plugin-contributed facts, keyed by plugin id. THE ONLY channel by which a
   * plugin requirement receives data — its Firestore reads happen in the loader,
   * never in the resolver, which is what keeps the evaluator pure.
   *
   * A key that is ABSENT means UNKNOWN, never false.
   */
  pluginFacts?: Record<string, unknown>
}

export interface ParticipationFact {
  eventId: string
  eventType: string
  atMs: number
  role: ParticipationRole
  /**
   * True when this event IS the grading occasion — the exam itself, or the camp
   * hosting it (`Event.hosted_by_event_id`).
   *
   * Excluded from every participation tally, permanently and for every grade.
   * Dan exams are held during a camp, so counting them would hand each candidate
   * two of their three requirements for free — twice, since the same occasion
   * would also count toward the following grade.
   */
  isGradingOccasion?: boolean
}

// ─── Result ───────────────────────────────────────────────────────────────────

export type RequirementStatus = 'met' | 'unmet' | 'unknown'

export interface RequirementProgress {
  /** 0..1, for a bar. */
  ratio: number
  have: number
  need: number
  /** Requirement-specific detail, e.g. the per-year breakdown of
   *  `qualifying_years` so the UI can say WHICH year is short. */
  detail?: unknown
}

export type RequirementReason =
  | 'time_remaining'
  | 'missing_participation'
  | 'no_exam_history'
  | 'facts_unavailable'
  | 'no_resolver'
  | 'age'
  | 'affiliation'

export interface RequirementResult {
  id: string
  kind: string
  status: RequirementStatus
  advisory: boolean
  progress: RequirementProgress
  reason?: RequirementReason
  /** Values for the UI sentence, e.g. { months: 7 } or { year: 2027 }. */
  reasonData?: Record<string, number | string>
}

export type RankEligibility =
  | 'eligible'
  | 'not_eligible'
  /** The organisation set no rule for this step — it grades by judgement. NOT a
   *  refusal, and the UI must not render it as one. */
  | 'not_configured'
  /** Already at the highest level the system defines. */
  | 'at_top'
  /** A non-advisory requirement could not be evaluated here. Never guessed in
   *  either direction — a client that cannot load a plugin's facts must say it
   *  cannot tell, not invent an answer the server would contradict. */
  | 'unknown'

export interface RankEligibilityResult {
  eligibility: RankEligibility
  systemId: string
  currentLevel: RankRef | null
  targetLevel: RankRef | null
  /** EVERY requirement in rule order, met and unmet alike — the UI shows a
   *  checklist, not a verdict. */
  requirements: RequirementResult[]
  /** Ids of the unmet, non-advisory requirements. Empty iff eligible. */
  missing: string[]
  /**
   * Earliest instant every TIME requirement is satisfied, when time is the only
   * thing outstanding. Null when unknowable — which includes the common case of
   * a participation requirement that no amount of waiting will meet.
   */
  eligibleFromMs: number | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The band governing `targetLevel`, or null when the organisation set none.
 *
 * Bands are matched by LADDER POSITION: the target sits between `from` and `to`
 * in `system.levels`. A band whose bound names a level the ladder no longer has
 * matches nothing — a rule pointing at a deleted grade governs no grade.
 */
export function ruleForLevel(
  progression: RankProgression | null | undefined,
  targetLevel: RankRef,
  system: Pick<RankingSystem, 'levels'>,
): RankLevelRule | null {
  if (!progression) return null
  const levels = system.levels ?? []
  return progression.rules.find((r) => rankRefWithin(levels, targetLevel, r.from, r.to)) ?? null
}

// `orderedLevels`, `nextLevel` and `levelLabel` moved to utils/rankLevels.ts,
// where the rule about order (array position, not `value`) is written down
// once. They reach the package surface through that module's export; a second
// re-export here would make the two `export *` in index.ts ambiguous.
