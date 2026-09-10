// The coaching spine — ONE model behind what the UI shows as goals, steps and
// check-ins.
//
// Goals and tasks were never two collections: both are `contacts/{id}/goals/{id}`
// docs discriminated by `type`. What was missing is the CONTAINMENT — a task is
// almost always in service of a goal — and that is what `parent_goal_id` adds.
// A task with no parent is not an orphan: it falls into a VIRTUAL "General"
// group that no document backs, so there is nothing to create, migrate, or
// clean up when the last unparented task is filed.
//
// TWO VOCABULARIES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
//
// A DIMENSION — Consistency, Effort, Focus, Recharge, Sense of progress —
// describes HOW SOMEONE IS DOING. It is self-rated, it is an axis of the
// check-in radar, and its value is a number between 1 and 5.
// A GOAL CATEGORY — Technique, Attitude, Attendance, Physical, Mental —
// describes WHAT A GOAL IS ABOUT. It is a label on a piece of work, and it has
// no scale at all.
//
// They were merged into one team-configurable list on 2026-08-28 ("Coaching
// becomes a loop", PR #128), on the argument that a check-in's weakest axis
// could then point straight at a goal category — the connection that turns a
// self-rating widget into the front of a coaching loop. That connection was
// worth having. The classification was not, and did not survive first contact
// with the product: "Learn a spinning kick" is Technique, and filing it under
// "Sense of progress" is a category error — the link between a skill and a
// mood is far too indirect to be a filing system.
//
// So the lists are split again — `resolveCoachingDimensions` for the radar,
// `resolveGoalCategories` for goals — and the loop is KEPT, in the one place it
// belongs: `Goal.from_dimension` records the axis a goal was created FROM.
// That is PROVENANCE (why this goal exists), never classification (what it is
// about), which is why it is a separate field and not a value in `categories`.

import type { Timestamp } from './common'

export type GoalType = 'goal' | 'task'
export type GoalStatus = 'open' | 'in_progress' | 'achieved' | 'abandoned'

/** Every status, in lifecycle order — the list a status picker offers. Declared
 *  once beside the type so the pickers on the admin tab, the Space and the
 *  member app cannot disagree about what the statuses are; each used to carry
 *  its own copy of this literal. */
export const GOAL_STATUSES: GoalStatus[] = ['open', 'in_progress', 'achieved', 'abandoned']
export type GoalCreatedBy = 'coach' | 'student'

// ─── the two vocabularies ────────────────────────────────────────────────────

/**
 * One entry of a team-configurable vocabulary: a stable `key` plus the label a
 * studio shows for it.
 *
 * ONE SHAPE, TWO LISTS — deliberately, so both read the same way at every call
 * site: the check-in axes at `teams|organizations/{id}.performance_indicators`
 * (see `resolveCoachingDimensions`) and the goal categories at
 * `teams|organizations/{id}.goal_categories` (see `resolveGoalCategories`).
 * Sharing the shape is not sharing the list — see the header for why they are
 * two.
 */
export interface PerformanceIndicator {
  key: string
  label: string
}

/**
 * The five default dimensions.
 *
 * These are the axes the profile heuristic below is built around, and the only
 * set for which it can name a profile — see `detectPerformanceProfile`. A team
 * that replaces them still gets a weakest/strongest axis (that calculation is
 * generic) but no named profile, which is the honest outcome rather than a
 * silently wrong one.
 */
export const DEFAULT_COACHING_DIMENSIONS: readonly PerformanceIndicator[] = [
  { key: 'consistency', label: 'Consistency' },
  { key: 'effort', label: 'Effort' },
  { key: 'focus', label: 'Focus' },
  { key: 'recharge', label: 'Recharge' },
  { key: 'sense_of_progress', label: 'Sense of progress' },
]

/** The canonical axis keys, in the order the heuristic reasons about them. */
export const CANONICAL_DIMENSION_KEYS = [
  'consistency',
  'effort',
  'focus',
  'recharge',
  'sense_of_progress',
] as const

/**
 * The dimensions this tenant actually uses.
 *
 * ONE resolver, run identically by the admin tab, the member surfaces and the
 * functions — the same shape `resolveBookingContactFields` follows. An empty or
 * absent list means "never configured", which falls back to the defaults; a
 * team that genuinely wants none is not a case worth modelling, since a
 * check-in with no axes is a form with nothing to rate.
 */
export function resolveCoachingDimensions(
  source: { performance_indicators?: PerformanceIndicator[] | null } | null | undefined,
): PerformanceIndicator[] {
  const configured = source?.performance_indicators
  if (!configured || configured.length === 0) return [...DEFAULT_COACHING_DIMENSIONS]
  return configured.filter((d) => typeof d?.key === 'string' && d.key.length > 0)
}

/** Display label for a dimension key, falling back to the raw key so a value
 *  the team has since renamed or dropped still renders as itself rather than
 *  vanishing from the check-in that recorded it. */
export function dimensionLabel(key: string, dimensions: PerformanceIndicator[]): string {
  return dimensions.find((d) => d.key === key)?.label ?? key
}

/**
 * The five default goal categories — what a goal is ABOUT.
 *
 * These are the pre-#128 list, restored: they were the categories the coaching
 * tab shipped with before goal categories and check-in axes were briefly
 * merged (see the header). Unlike the dimensions, no heuristic reasons about
 * these keys — a category is a label, so a team replacing the whole list loses
 * nothing.
 */
export const DEFAULT_GOAL_CATEGORIES: readonly PerformanceIndicator[] = [
  { key: 'technique', label: 'Technique' },
  { key: 'attitude', label: 'Attitude' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'physical', label: 'Physical' },
  { key: 'mental', label: 'Mental' },
]

/**
 * The goal categories this tenant actually uses.
 *
 * Same fallback semantics as `resolveCoachingDimensions` above, deliberately —
 * the two resolvers are read side by side and any difference between them
 * would be read as meaning something. An empty or absent list means "never
 * configured", which falls back to the defaults.
 */
export function resolveGoalCategories(
  source: { goal_categories?: PerformanceIndicator[] | null } | null | undefined,
): PerformanceIndicator[] {
  const configured = source?.goal_categories
  if (!configured || configured.length === 0) return [...DEFAULT_GOAL_CATEGORIES]
  return configured.filter((c) => typeof c?.key === 'string' && c.key.length > 0)
}

/** Display label for a goal-category key, falling back to the raw key — mirrors
 *  `dimensionLabel`, for the same reason: a category the team has since renamed
 *  or dropped still renders as itself rather than vanishing from the goal that
 *  carries it. */
export function goalCategoryLabel(key: string, categories: PerformanceIndicator[]): string {
  return categories.find((c) => c.key === key)?.label ?? key
}

// ─── goals and steps ─────────────────────────────────────────────────────────

export interface Goal {
  id: string
  type: GoalType           // 'goal' = long-term with evaluations; 'task' = boolean homework
  title: string
  description?: string | null
  status: GoalStatus
  categories: string[]     // goal-category keys — see resolveGoalCategories
  created_by: GoalCreatedBy
  created_at: Timestamp
  target_date?: Timestamp | null
  /**
   * When the work is meant to BEGIN — informational only.
   *
   * Deliberately inert: it does not feed `goalIsOverdue`, the daily
   * `stampOverdueGoals` job, the contact's coaching counters or the
   * `task_overdue` automation, all of which run off `target_date` alone. A
   * start date that silenced an overdue check would be a scheduling state
   * ("not started yet") with consequences in three more places; this is a date
   * a coach writes down and can sort by, nothing more.
   */
  start_date?: Timestamp | null
  completed_at?: Timestamp | null  // set when task is marked done (status → 'achieved')

  /**
   * Filed away: hidden from every surface, kept in full.
   *
   * ORTHOGONAL TO `status`, which records the OUTCOME — an achieved goal is the
   * common thing to archive, and folding this into the status enum would have
   * forced 'abandoned' onto goals that were in fact completed. Un-archiving is
   * writing null; nothing else about the document changes, which is why there
   * is no separate restore path.
   *
   * Archived goals leave `coaching_open_count`/`coaching_overdue_count` and stop
   * being stamped overdue, so filing one away also stops its automations.
   *
   * ⚠ ABSENT on every goal written before 2026-09-01, so readers must test
   * `!goal.archived_at` in memory — `where('archived_at','==',null)` matches
   * only documents where the field EXISTS and is null, i.e. none of them. The
   * same trap is documented on `overdue_at` in `stampOverdueGoals`.
   */
  archived_at?: Timestamp | null

  /**
   * The check-in axis this goal was created FROM, when it was created from a
   * weak axis (a check-in's `primary_lever` — see PerformanceCheckin below).
   *
   * PROVENANCE, not classification: it records WHY the goal exists, and is
   * deliberately NOT `categories`, which says what the goal is ABOUT. A step
   * created from a low Focus rating is provenance-Focus and category-whatever
   * the work actually is; writing 'focus' into `categories` was the category
   * error that split the two vocabularies apart again (see the header).
   *
   * Absent on every goal nobody created from an axis, which is most of them.
   */
  from_dimension?: string | null

  /**
   * The goal this step serves, for `type: 'task'`.
   *
   * Null / absent = unparented, which the UI groups under a VIRTUAL "General"
   * heading. Deliberately not a real document: a placeholder goal would need
   * creating on first use, hiding when empty, and cleaning up when the last
   * step leaves it — three lifecycle problems bought for nothing.
   *
   * Always null on `type: 'goal'`. Goals do not nest.
   */
  parent_goal_id?: string | null

  /**
   * Manual position within its list — a goal's steps, or the virtual "General"
   * bucket. TASKS ONLY; goals keep their query order.
   *
   * SPARSE, like `SiteSection.order`: unset entries sort after the configured
   * ones and keep their natural (query) order among themselves, so turning a
   * list manual costs no backfill and a task created later simply lands at the
   * end. Compare with `order ?? Number.MAX_SAFE_INTEGER` — `sortSteps` does.
   */
  order?: number

  /**
   * Denormalized from the newest evaluation, written ONLY by the `onGoalWrite`
   * trigger. They exist so a collapsed goal card can show how the goal is
   * actually going — before this, finding the one stale goal in a list meant
   * expanding every card to fetch its evaluations.
   */
  latest_score?: number | null
  last_evaluated_at?: Timestamp | null

  /**
   * When this goal was first observed past its `target_date`, stamped by the
   * daily job.
   *
   * A GOAL GOING OVERDUE INVOLVES NO WRITE — the date does not move, the clock
   * does — so nothing would otherwise wake the trigger that maintains the
   * contact's counters. Stamping here is that wake-up, and it keeps the counter
   * single-writer: the daily job touches the goal, `onGoalWrite` recomputes.
   * Cleared when the goal is completed, abandoned, or given a new target date.
   */
  overdue_at?: Timestamp | null
}

export interface GoalEvaluation {
  id: string
  evaluated_at: Timestamp
  evaluated_by: GoalCreatedBy
  score: number            // 1–5
  notes?: string | null
  status_after: GoalStatus
  edited?: boolean
}

/** Still open, and past its target date. Derived — `overdue_at` is the stored
 *  stamp that drives the counters, this is what a UI asks. */
export function goalIsOverdue(goal: Pick<Goal, 'status' | 'target_date'>, nowMs = Date.now()): boolean {
  if (goal.status === 'achieved' || goal.status === 'abandoned') return false
  const due = toMillis(goal.target_date)
  return due !== null && due < nowMs
}

/** Filed away by a coach. THE predicate — every surface (admin, Space, mobile)
 *  and both coaching triggers ask this, in memory, never as a query filter. See
 *  the warning on `archived_at`. */
export function goalIsArchived(goal: Pick<Goal, 'archived_at'>): boolean {
  return !!goal.archived_at
}

/** How a task list is ordered. `manual` is the drag-and-drop order; the two date
 *  modes are what a coach reaches for when the list has got long. */
export type StepSortMode = 'manual' | 'start_date' | 'target_date'

/**
 * Order a task list for display. Pure, and NOT applied inside
 * `groupGoalsWithSteps` — that helper's contract is to preserve input order, and
 * it is mirrored byte-for-byte in the mobile app.
 *
 * Unset sorts LAST in every mode: a task with no `order` has not been placed,
 * and a task with no date has not been scheduled — neither belongs at the top.
 *
 * TIES BREAK ON `created_at` ASCENDING, and that is not a detail. `order` is
 * written ONLY by a drag (GoalsTab's reorderSteps) and never on create, so
 * until somebody drags something EVERY step of a goal ties at
 * MAX_SAFE_INTEGER. Leaning on the stable sort there meant inheriting the
 * caller's incoming order — the `created_at desc` every surface queries — and
 * a goal's steps are a SEQUENCE ("drill the entry", "spar it", "register"),
 * so the untouched, overwhelmingly common case rendered backwards on both the
 * coach's tab and the member's portal. Oldest-first is the order they were
 * written in, which is the order they are meant to be read in.
 */
export function sortSteps(steps: Goal[], mode: StepSortMode = 'manual'): Goal[] {
  const key = (g: Goal): number => {
    if (mode === 'manual') return g.order ?? Number.MAX_SAFE_INTEGER
    return toMillis(mode === 'start_date' ? g.start_date : g.target_date) ?? Number.MAX_SAFE_INTEGER
  }
  return [...steps].sort((a, b) => {
    const byKey = key(a) - key(b)
    if (byKey !== 0) return byKey
    return (toMillis(a.created_at) ?? 0) - (toMillis(b.created_at) ?? 0)
  })
}

/**
 * The goals a surface should SHOW: everything not archived, minus the steps of
 * an archived goal.
 *
 * The second half is the rule worth owning once. `goalIsArchived` answers one
 * document — but a step's own `archived_at` is never set, because archiving a
 * goal stamps the goal and not its steps. Filter on the predicate alone and
 * every step of an archived goal stays alive, and `groupGoalsWithSteps` then
 * files each one under the virtual "General" bucket as an orphan. The admin
 * tab, the Space and the member app had each re-derived that cascade by hand,
 * and one of them had re-spelled the predicate as `!!archived_at` on the way.
 *
 * In memory, not a query: `archived_at` is ABSENT on every goal written before
 * the field existed, and a `where('archived_at', '==', null)` matches none of
 * them.
 */
export function visibleGoals(goals: Goal[]): Goal[] {
  const archivedGoalIds = new Set(
    goals.filter((g) => g.type !== 'task' && goalIsArchived(g)).map((g) => g.id),
  )
  return goals.filter(
    (g) =>
      !goalIsArchived(g) &&
      !(g.type === 'task' && g.parent_goal_id && archivedGoalIds.has(g.parent_goal_id)),
  )
}

/**
 * Goals with their steps nested, plus the virtual "General" bucket.
 *
 * Shared because three surfaces group the same way (admin tab, member Space,
 * mobile) and three copies of the parent/orphan rule is how they would start
 * disagreeing about where an unparented step belongs. A step whose parent is
 * missing — deleted goal, partial fetch — falls back to General rather than
 * disappearing.
 */
export function groupGoalsWithSteps(goals: Goal[]): {
  goals: { goal: Goal; steps: Goal[] }[]
  generalSteps: Goal[]
} {
  const parents = goals.filter((g) => g.type !== 'task')
  const steps = goals.filter((g) => g.type === 'task')
  const known = new Set(parents.map((g) => g.id))
  const byParent = new Map<string, Goal[]>()
  const generalSteps: Goal[] = []
  for (const s of steps) {
    const pid = s.parent_goal_id
    if (pid && known.has(pid)) {
      const list = byParent.get(pid)
      if (list) list.push(s)
      else byParent.set(pid, [s])
    } else {
      generalSteps.push(s)
    }
  }
  return {
    goals: parents.map((goal) => ({ goal, steps: byParent.get(goal.id) ?? [] })),
    generalSteps,
  }
}

// ─── performance check-ins ───────────────────────────────────────────────────

/** Who the check-in is about the relationship with: a private self-rating, or
 *  one taken together in a 1:1. */
export type PerformanceContext = 'self' | '1to1'

/** A named pattern the heuristic recognises. `default` = no pattern matched,
 *  which is a normal outcome and not an error. */
export type ProfileKey =
  | 'burnout_risk'
  | 'overreaching'
  | 'stuck'
  | 'coasting'
  | 'inconsistent'
  | 'balanced'
  | 'default'

export interface PerformanceCheckin {
  id: string
  taken_at: Timestamp
  filled_by: GoalCreatedBy
  /** dimension key → 1–5 */
  scores: Record<string, number>
  notes?: string | null
  context: PerformanceContext
  /** Absent when the team's dimensions are not the canonical five — see
   *  `detectPerformanceProfile`. */
  profile_key?: ProfileKey | null
  /** Weakest and strongest dimension keys. Generic: computed for ANY dimension
   *  set, which is what makes the "work on your weakest axis" prompt survive a
   *  team customising its vocabulary. */
  primary_lever?: string | null
  anchor?: string | null
}

export interface ProfileResult {
  profile_key: ProfileKey | null
  primary_lever: string | null
  anchor: string | null
}

/**
 * The ONE copy of the profile heuristic.
 *
 * It used to exist twice — `apps/mobile/src/utils/performanceProfile.ts` and an
 * inline function in the admin contact page — with the web copy typing
 * `profile_key` as a bare string. Thresholds are unchanged from those copies;
 * what is new is the honesty about custom vocabularies.
 *
 * `primary_lever` / `anchor` are computed from whatever keys the check-in
 * actually carries, so they work for any dimension set. `profile_key` is
 * returned ONLY when all five canonical axes are present: the rules below are
 * statements about consistency, effort, focus, recharge and sense of progress
 * specifically, and running them against a team's own axes would default every
 * missing one to 3 and report a confidently wrong profile.
 *
 * Rules are checked top-to-bottom; first match wins.
 */
export function detectPerformanceProfile(scores: Record<string, number>): ProfileResult {
  const entries = Object.entries(scores ?? {}).filter(([, v]) => typeof v === 'number')
  const sorted = [...entries].sort(([, a], [, b]) => a - b)
  const primary_lever = sorted.length > 0 ? sorted[0][0] : null
  const anchor = sorted.length > 0 ? sorted[sorted.length - 1][0] : null

  const canonical = CANONICAL_DIMENSION_KEYS.every((k) => typeof scores?.[k] === 'number')
  if (!canonical) return { profile_key: null, primary_lever, anchor }

  const C = scores['consistency']
  const E = scores['effort']
  const F = scores['focus']
  const R = scores['recharge']
  const P = scores['sense_of_progress']

  let profile_key: ProfileKey
  if (C >= 3.5 && E <= 2.5 && F <= 2.5 && P <= 2.5) profile_key = 'burnout_risk'
  else if (E >= 4 && R <= 2) profile_key = 'overreaching'
  else if (C >= 3.5 && E >= 3.5 && P <= 2) profile_key = 'stuck'
  else if (C >= 3.5 && E >= 3.5 && F <= 2.5) profile_key = 'coasting'
  else if (C <= 2.5 && (E + F + P) / 3 >= 3) profile_key = 'inconsistent'
  else if (C >= 3.5 && E >= 3.5 && F >= 3.5 && R >= 3.5 && P >= 3.5) profile_key = 'balanced'
  else profile_key = 'default'

  return { profile_key, primary_lever, anchor }
}

// ─── internal ────────────────────────────────────────────────────────────────

function toMillis(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null
  const v = ts as unknown
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'object' && v !== null && 'toDate' in v) {
    const d = (v as { toDate(): Date }).toDate()
    return d instanceof Date ? d.getTime() : null
  }
  if (typeof v === 'object' && v !== null && 'seconds' in v) {
    return (v as { seconds: number }).seconds * 1000
  }
  if (typeof v === 'number') return v
  return null
}
