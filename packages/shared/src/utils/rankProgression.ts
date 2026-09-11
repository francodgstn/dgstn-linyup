// THE rank-progression evaluator — "what does the next level ask for, and where
// is this person against it?"
//
// Pure function of (progression, system, facts): no Firestore, no firebase
// imports, so it ships to the client bundle. The IMPURE half — reading a
// contact's check-ins and the events they belong to — lives in the snapshot
// loader, exactly as `loadContactPaymentSnapshot` sits behind
// `resolvePaymentOptions`.
//
// IT NEVER PROMOTES ANYBODY AND IT NEVER REFUSES ANYTHING. See the header of
// types/rankProgression.ts. The output is a checklist; the decision is a
// person's.
//
// Fixtures: packages/functions/src/ranks/rankEligibility.test.ts (the vocabulary)
// and hmdRule.test.ts (HMD's own ladder, pinned by name).

import type {
  EventParticipationSpec,
  ParticipationFact,
  PluginRequirementId,
  RankEligibilityResult,
  RankFactsSnapshot,
  RankProgression,
  RankRequirement,
  RequirementProgress,
  RequirementResult,
  TimeUnit,
} from '../types/rankProgression'
import { DEFAULT_PARTICIPATION_ROLE, ruleForLevel } from '../types/rankProgression'
import type { RankRef, RankingSystem } from '../types/team'
import { findRankLevel, nextLevel, rankLevelKey } from './rankLevels'
import { pluginIdOfNamespacedId } from '../types/plugin'

// ─── Plugin requirement registry ──────────────────────────────────────────────

export interface PluginRequirementInput {
  requirement: { kind: PluginRequirementId; config?: Record<string, unknown> }
  facts: RankFactsSnapshot
  /** This plugin's slice of `facts.pluginFacts`, already narrowed. UNDEFINED
   *  means the loader for THIS runtime did not run — resolvers must then return
   *  `unknown`, never a guess. */
  pluginFacts: unknown
  systemId: string
  targetLevel: RankRef
}

export type PluginRequirementResolver = (input: PluginRequirementInput) => {
  status: 'met' | 'unmet' | 'unknown'
  progress: RequirementProgress
}

/**
 * Namespaced requirement id → resolver. Same shape and same reasoning as
 * `pluginActionHandlers` for the automation engine: the manifest DECLARES a
 * requirement, this map IMPLEMENTS it.
 *
 * Registration is a static import barrel, not a dynamic lookup — a resolver that
 * loads lazily would make the evaluator async and stop it being a pure function.
 */
export const rankRequirementResolvers: Record<string, PluginRequirementResolver> = {}

export function registerRankRequirementResolver(
  id: PluginRequirementId,
  resolver: PluginRequirementResolver,
): void {
  rankRequirementResolvers[id] = resolver
}

/** The plugin id inside `plugin:{pluginId}:{name}`. Requirement ids share their
 *  shape with automation action ids, so the parse has ONE owner —
 *  `pluginIdOfNamespacedId` in types/plugin.ts. This is its domain-specific name. */
export const pluginIdOfRequirement = pluginIdOfNamespacedId

// ─── Time ─────────────────────────────────────────────────────────────────────

/**
 * Add a duration in WHOLE MONTHS where the unit allows it.
 *
 * Months, not milliseconds: HMD's clock is "two years from the exam", and a
 * student examined on 29 February must not land on a different day of the month
 * every cycle. Day-precision would also be false precision over dates a backfill
 * had to estimate.
 */
export function addDuration(ms: number, amount: number, unit: TimeUnit): number {
  const d = new Date(ms)
  if (unit === 'days') {
    d.setUTCDate(d.getUTCDate() + amount)
    return d.getTime()
  }
  const months = unit === 'years' ? amount * 12 : amount
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  // Clamp into the target month: 31 Jan + 1 month is 28/29 Feb, not 2/3 March.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d.getTime()
}

/** Whole months between two instants, floored. */
export function monthsBetween(fromMs: number, toMs: number): number {
  if (toMs < fromMs) return 0
  const a = new Date(fromMs)
  const b = new Date(toMs)
  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  if (b.getUTCDate() < a.getUTCDate()) months -= 1
  return Math.max(0, months)
}

// ─── Participation ────────────────────────────────────────────────────────────

function matchesSpec(fact: ParticipationFact, spec: EventParticipationSpec): boolean {
  // The grading occasion is excluded everywhere and always — see ParticipationFact.
  if (fact.isGradingOccasion) return false
  if (!spec.eventTypes.includes(fact.eventType)) return false
  if (spec.roles && !spec.roles.includes(fact.role ?? DEFAULT_PARTICIPATION_ROLE)) return false
  return true
}

function countInWindow(
  facts: RankFactsSnapshot,
  spec: EventParticipationSpec,
  fromMs: number,
  toMs: number,
): number {
  return facts.participation.filter(
    (f) => matchesSpec(f, spec) && f.atMs >= fromMs && f.atMs < toMs,
  ).length
}

/** The most recent exam at or before `nowMs`, or null when there is no history. */
function lastExamMs(facts: RankFactsSnapshot): number | null {
  const past = facts.examsAtMs.filter((t) => t <= facts.nowMs)
  return past.length ? Math.max(...past) : null
}

function anchorFor(facts: RankFactsSnapshot, since: string): number | null {
  if (since === 'always') return 0
  if (since === 'first_exam') return facts.examsAtMs.length ? Math.min(...facts.examsAtMs) : null
  return lastExamMs(facts)
}

const NO_PROGRESS: RequirementProgress = { ratio: 0, have: 0, need: 1 }
const DONE: RequirementProgress = { ratio: 1, have: 1, need: 1 }

// ─── One requirement ──────────────────────────────────────────────────────────

function evaluateRequirement(
  req: RankRequirement,
  facts: RankFactsSnapshot,
  systemId: string,
  targetLevel: RankRef,
): { result: RequirementResult; satisfiedAtMs?: number | null } {
  const base = { id: req.id, kind: req.kind, advisory: req.advisory === true }

  switch (req.kind) {
    case 'time_since_previous_exam':
    case 'time_in_system': {
      const anchor =
        req.kind === 'time_in_system'
          ? anchorFor(facts, 'first_exam')
          : lastExamMs(facts)
      if (anchor == null) {
        // No exam on record. We genuinely cannot measure this — say so rather
        // than reporting a person as short by an amount we invented.
        return {
          result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'no_exam_history' },
          satisfiedAtMs: null,
        }
      }
      const dueAt = addDuration(anchor, req.amount, req.unit)
      const needMonths = req.unit === 'days' ? 0 : req.unit === 'years' ? req.amount * 12 : req.amount
      const haveMonths = monthsBetween(anchor, facts.nowMs)
      const met = facts.nowMs >= dueAt
      return {
        result: {
          ...base,
          status: met ? 'met' : 'unmet',
          progress: {
            ratio: needMonths ? Math.min(1, haveMonths / needMonths) : met ? 1 : 0,
            have: haveMonths,
            need: needMonths,
          },
          ...(met ? {} : { reason: 'time_remaining' as const, reasonData: { months: Math.max(0, needMonths - haveMonths) } }),
        },
        satisfiedAtMs: dueAt,
      }
    }

    case 'event_participation': {
      const anchor = anchorFor(facts, req.since)
      if (anchor == null) {
        return {
          result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'no_exam_history' },
        }
      }
      const have = countInWindow(facts, req.spec, anchor, facts.nowMs + 1)
      const met = have >= req.spec.min
      return {
        result: {
          ...base,
          status: met ? 'met' : 'unmet',
          progress: { ratio: Math.min(1, have / req.spec.min), have, need: req.spec.min },
          ...(met ? {} : { reason: 'missing_participation' as const, reasonData: { short: req.spec.min - have } }),
        },
      }
    }

    case 'qualifying_years': {
      const anchor = lastExamMs(facts)
      if (anchor == null) {
        return {
          result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'no_exam_history' },
        }
      }
      // Consecutive 12-month windows from the previous exam. A window that does
      // not satisfy every spec simply does not count, which is what makes the
      // clock stretch for somebody who stopped turning up.
      const windows: Array<{ fromMs: number; toMs: number; qualifies: boolean; missing: string[] }> = []
      let from = anchor
      // BOUNDED, and both guards are load-bearing rather than defensive habit.
      // `NaN > nowMs` is FALSE, so a single malformed date — an exam timestamp
      // that arrived as NaN, which a bad Firestore value or a failed parse
      // produces — would never satisfy the break and would spin this forever, on
      // the server, holding a request open. The step guard catches any future
      // arithmetic that stops advancing; the century cap catches everything else.
      const MAX_WINDOWS = 100
      while (windows.length < MAX_WINDOWS) {
        const to = addDuration(from, 12, 'months')
        if (!Number.isFinite(to) || to <= from) break
        if (to > facts.nowMs) break
        const missing: string[] = []
        for (const spec of req.perYear) {
          if (countInWindow(facts, spec, from, to) < spec.min) missing.push(spec.eventTypes.join('|'))
        }
        windows.push({ fromMs: from, toMs: to, qualifies: missing.length === 0, missing })
        from = to
      }
      const have = windows.filter((w) => w.qualifies).length
      const met = have >= req.minYears
      return {
        result: {
          ...base,
          status: met ? 'met' : 'unmet',
          progress: {
            ratio: Math.min(1, have / req.minYears),
            have,
            need: req.minYears,
            detail: windows,
          },
          ...(met ? {} : { reason: 'missing_participation' as const, reasonData: { short: req.minYears - have } }),
        },
      }
    }

    case 'sessions_attended': {
      const have = facts.sessionsAttended
      if (have == null) {
        return { result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'facts_unavailable' } }
      }
      const met = have >= req.min
      return {
        result: {
          ...base,
          status: met ? 'met' : 'unmet',
          progress: { ratio: Math.min(1, have / req.min), have, need: req.min },
          ...(met ? {} : { reason: 'missing_participation' as const }),
        },
      }
    }

    case 'min_age': {
      if (facts.birthdateMs == null) {
        return { result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'age' } }
      }
      const years = Math.floor(monthsBetween(facts.birthdateMs, facts.nowMs) / 12)
      const met = years >= req.years
      return {
        result: {
          ...base,
          status: met ? 'met' : 'unmet',
          progress: { ratio: Math.min(1, years / req.years), have: years, need: req.years },
          ...(met ? {} : { reason: 'age' as const }),
        },
        satisfiedAtMs: addDuration(facts.birthdateMs, req.years, 'years'),
      }
    }

    case 'affiliation_active': {
      const aff = facts.affiliations
      if (!aff) {
        return { result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'facts_unavailable' } }
      }
      const met = req.typeKey ? aff.types.includes(req.typeKey) : aff.has_active
      return {
        result: {
          ...base,
          status: met ? 'met' : 'unmet',
          progress: met ? DONE : NO_PROGRESS,
          ...(met ? {} : { reason: 'affiliation' as const }),
        },
      }
    }

    default: {
      // Plugin-contributed. An unregistered resolver, or facts this runtime did
      // not load, resolve to UNKNOWN — never a silent pass and never a silent
      // fail, because the other runtime would answer differently.
      const kind = req.kind as PluginRequirementId
      const resolver = rankRequirementResolvers[kind]
      if (!resolver) {
        return { result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'no_resolver' } }
      }
      const pluginId = pluginIdOfRequirement(kind)
      const slice = pluginId ? facts.pluginFacts?.[pluginId] : undefined
      if (slice === undefined) {
        return { result: { ...base, status: 'unknown', progress: NO_PROGRESS, reason: 'facts_unavailable' } }
      }
      const out = resolver({
        requirement: { kind, config: (req as { config?: Record<string, unknown> }).config },
        facts,
        pluginFacts: slice,
        systemId,
        targetLevel,
      })
      return { result: { ...base, status: out.status, progress: out.progress } }
    }
  }
}

// ─── The two gates ────────────────────────────────────────────────────────────

/**
 * GATE ONE — may this person be considered for the next level?
 *
 * `progression` must already be alias-resolved by the caller (a system that
 * points at another's rules is one hop; resolving it here would need the other
 * document, which the evaluator has no way to fetch).
 */
export function rankEligibility(input: {
  progression: RankProgression | null
  system: RankingSystem
  facts: RankFactsSnapshot
  /** Defaults to the level above the current one. Explicit for "could they skip
   *  to X?" */
  targetLevel?: RankRef
}): RankEligibilityResult {
  const { progression, system, facts } = input
  const systemId = system.id
  const currentLevel = facts.ranks[systemId] ?? null

  // The next rung is READ off the ladder and named by its identity — never
  // `current + 1`, which is how a gap in a numbering became a promotion nobody
  // offered, and never a number at all now that levels have ids.
  const above = input.targetLevel === undefined ? nextLevel(system, currentLevel) : null
  const target: RankRef | null =
    input.targetLevel !== undefined ? input.targetLevel : above ? rankLevelKey(above) : null

  const empty = { systemId, currentLevel, requirements: [], missing: [], eligibleFromMs: null }

  if (target == null) return { ...empty, eligibility: 'at_top', targetLevel: null }
  if (!findRankLevel(system.levels, target)) {
    return { ...empty, eligibility: 'not_configured', targetLevel: target }
  }

  const rule = ruleForLevel(progression, target, system)
  if (!rule) return { ...empty, eligibility: 'not_configured', targetLevel: target }

  const evaluated = rule.requirements.map((r) => evaluateRequirement(r, facts, systemId, target))
  const requirements = evaluated.map((e) => e.result)
  const binding = requirements.filter((r) => !r.advisory)

  const missing = binding.filter((r) => r.status === 'unmet').map((r) => r.id)
  const anyUnknown = binding.some((r) => r.status === 'unknown')

  // Fails to UNKNOWN, never to eligible and never to not_eligible. The question
  // has a legitimate third answer and pretending otherwise would either flatter
  // a candidate or accuse them.
  const eligibility = anyUnknown ? 'unknown' : missing.length === 0 ? 'eligible' : 'not_eligible'

  // A date only when TIME is the only thing outstanding — otherwise waiting
  // changes nothing and offering a date would be a promise the rule cannot keep.
  const onlyTimeOutstanding =
    !anyUnknown &&
    binding.every((r) => r.status === 'met' || r.reason === 'time_remaining' || r.reason === 'age')
  const eligibleFromMs = onlyTimeOutstanding
    ? evaluated
        .filter((e) => !e.result.advisory && e.satisfiedAtMs != null)
        .reduce<number | null>((acc, e) => Math.max(acc ?? 0, e.satisfiedAtMs as number), null)
    : null

  return { eligibility, systemId, currentLevel, targetLevel: target, requirements, missing, eligibleFromMs }
}

/**
 * GATE TWO — has the probation period elapsed, and did it itself count?
 *
 * Asked at a different moment from gate one and about a different thing: gate
 * one is before the exam, this is (for HMD) a year after it. A band with no
 * `promotionDelay` is trivially ready, which is how every grade conferred at the
 * exam behaves.
 *
 * Passing this still awards nothing. Promotion is never automatic, at any level.
 */
export function promotionReadiness(input: {
  progression: RankProgression | null
  system: RankingSystem
  facts: RankFactsSnapshot
  /** The level that was examined, and the instant of that exam. */
  examinedLevel: RankRef
  examAtMs: number
}): RankEligibilityResult {
  const { progression, system, facts, examinedLevel, examAtMs } = input
  const systemId = system.id
  const base = {
    systemId,
    currentLevel: facts.ranks[systemId] ?? null,
    targetLevel: examinedLevel,
  }

  const rule = ruleForLevel(progression, examinedLevel, system)
  const delay = rule?.promotionDelay
  if (!delay) {
    return { ...base, eligibility: 'eligible', requirements: [], missing: [], eligibleFromMs: null }
  }

  const dueAt = addDuration(examAtMs, delay.amount, delay.unit)
  const elapsed: RequirementResult = {
    id: 'probation',
    kind: 'promotion_delay',
    status: facts.nowMs >= dueAt ? 'met' : 'unmet',
    advisory: false,
    progress: {
      ratio: Math.min(1, monthsBetween(examAtMs, facts.nowMs) / Math.max(1, delay.unit === 'years' ? delay.amount * 12 : delay.amount)),
      have: monthsBetween(examAtMs, facts.nowMs),
      need: delay.unit === 'years' ? delay.amount * 12 : delay.amount,
    },
    ...(facts.nowMs >= dueAt ? {} : { reason: 'time_remaining' as const }),
  }

  // The probation window is measured from the EXAM, so a requirement evaluated
  // here sees the same anchor gate one used — which is exactly why HMD's
  // probation year also counts toward the next grade. That overlap is the rule,
  // not an accident of the arithmetic.
  const extra = (delay.requirements ?? []).map(
    (r) => evaluateRequirement(r, facts, systemId, examinedLevel).result,
  )

  const requirements = [elapsed, ...extra]
  const binding = requirements.filter((r) => !r.advisory)
  const missing = binding.filter((r) => r.status === 'unmet').map((r) => r.id)
  const anyUnknown = binding.some((r) => r.status === 'unknown')

  return {
    ...base,
    eligibility: anyUnknown ? 'unknown' : missing.length === 0 ? 'eligible' : 'not_eligible',
    requirements,
    missing,
    eligibleFromMs: missing.length === 1 && missing[0] === 'probation' ? dueAt : null,
  }
}
