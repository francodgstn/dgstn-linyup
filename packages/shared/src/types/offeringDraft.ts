// ─── AI-drafted offerings ────────────────────────────────────────────────────
//
// THE SCHEMA IS THE SCOPE, and that is the whole security argument.
//
// A prompt can be argued into anything. A return type cannot. So the model in
// `draftOfferings` does not act — it returns one of these, the server validates
// it, a human reviews it, and only then does `applyOfferingDraft` write. If the
// model is talked into "delete every contact", there is no field for that to
// land in: the type has no member for it, and `parseOfferingDraft` drops
// anything it does not name (Franco, 2026-09-02).
//
// Three constraints do the work, and each rules out a class of mistake rather
// than a specific one:
//
//   NO IDS. Nothing here carries a Firestore id, so a draft cannot address an
//   existing record. It cannot rewire an activity's gate, repoint a plan, or
//   overwrite anything — every applied draft CREATES.
//
//   NO TENANT. There is no `teamId`. The server stamps it from the caller's
//   membership, so a draft cannot be aimed at another studio.
//
//   NO CROSS-BATCH REFERENCES. A plan may include an activity only by naming
//   another item IN THE SAME DRAFT, through `key` — a draft-local handle the
//   server resolves to a real id while it writes. There is deliberately no way
//   to spell an id that already exists.
//
// What this leaves the model able to produce is exactly: some activities, some
// plans, and the links between them. Not contacts, not sessions, not promo
// codes, not documents, not team settings, not anything public — those are not
// members of this type, which is a stronger statement than any instruction.

import type { ActivityType, ActivityAccessTier } from './activity'
import type { SubscriptionRecurrence, UsageLimitPeriod } from './contact'

/** Hard caps. One prompt must not be able to produce fifty records — a studio
 *  reviewing a wall of proposals stops reviewing, which defeats the confirm
 *  step that the safety argument rests on. */
export const OFFERING_DRAFT_LIMITS = {
  activities: 8,
  plans: 6,
  /** Per activity. Long enough for a real appointment menu, short enough to read. */
  durations: 6,
  /** Per plan. */
  prices: 4,
  nameChars: 80,
  descriptionChars: 600,
  /** The prompt itself. */
  promptChars: 1200,
} as const

/**
 * A draft-local handle, unique within one draft.
 *
 * It is how a plan says "include the beginners class" without being able to say
 * "include activity `abc123`". Kebab-case and short so the model produces them
 * reliably and a reviewer can read them.
 */
export type DraftKey = string

export interface DraftDuration {
  minutes: number
  /** Major units, team currency. Absent = not sold at this length. */
  priceAmount?: number
}

export interface DraftActivity {
  key: DraftKey
  name: string
  description?: string
  /** Absent ⇒ 'class', matching `resolveActivityType`'s own default. */
  type?: ActivityType
  /**
   * A HEX COLOUR ONLY, and validated as one. The field feeds an inline style on
   * the rail's dot, so anything else here is an injection surface rather than a
   * wrong colour.
   */
  color?: string
  tags?: string[]
  /** APPOINTMENT-ONLY, ignored on a class — same rule the activity form follows. */
  durations?: DraftDuration[]
  /**
   * Who can book. `subscription` is only meaningful alongside `planKeys`, and
   * `parseOfferingDraft` does not enforce that — an activity gated on nothing
   * is a real, if useless, state the studio can see and fix in the review.
   */
  accessTier?: ActivityAccessTier
  /** Plans in THIS draft that open it. Resolved to ids at apply. */
  planKeys?: DraftKey[]
  /** CLASS-ONLY. Sold per visit at this price. */
  dropInPriceAmount?: number
}

export interface DraftPrice {
  amount: number
  recurrence: SubscriptionRecurrence
  label?: string
  /** Credit packs: how many visits this price grants. */
  credits?: number
}

export interface DraftPlan {
  key: DraftKey
  name: string
  description?: string
  prices?: DraftPrice[]
  /** "Up to 8 classes per month". */
  limit?: { count: number; per: UsageLimitPeriod }
  /**
   * Activities in THIS draft this plan includes. The reciprocal of
   * `DraftActivity.planKeys`; either side may express a link and the applier
   * unions them, because a model asked for "a plan that includes X" writes it
   * from whichever side the sentence started.
   */
  activityKeys?: DraftKey[]
}

export interface OfferingDraft {
  activities: DraftActivity[]
  plans: DraftPlan[]
  /** One line the model may use to say what it assumed. Display only — never
   *  stored on any record. */
  note?: string
}

// ─── validation ──────────────────────────────────────────────────────────────

export interface DraftProblem {
  /** Dotted path into the draft, for a message that can point at a row. */
  path: string
  code:
    | 'missing'
    | 'type'
    | 'empty'
    | 'too_long'
    | 'too_many'
    | 'bad_enum'
    | 'bad_number'
    | 'bad_colour'
    | 'duplicate_key'
    | 'unknown_key'
}

const ACTIVITY_TYPES: ActivityType[] = ['class', 'appointment']
const ACCESS_TIERS: ActivityAccessTier[] = ['open', 'members', 'subscription']
// No 'per_class': charged once, it grants unmetered access with no end (UX-104).
const RECURRENCES: SubscriptionRecurrence[] = [
  'one_time',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annual',
]
const LIMIT_PERIODS: UsageLimitPeriod[] = ['day', 'week', 'month']
const HEX = /^#[0-9a-fA-F]{6}$/
const KEY = /^[a-z0-9][a-z0-9-]{0,40}$/

/** Money the studio could actually charge. Rejects NaN, negatives, and the
 *  absurd — a four-figure monthly plan is a typo far more often than a price. */
function money(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000
}

function text(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
}

/**
 * Parse whatever the model returned into a draft, or say why not.
 *
 * DROPS RATHER THAN TRUSTS: every field is read by name and anything else the
 * object carries is discarded, so an extra `teamId` or `id` the model decided
 * to add cannot survive into the applier. That is why this returns a NEW object
 * rather than validating in place.
 */
export function parseOfferingDraft(input: unknown): {
  draft: OfferingDraft | null
  problems: DraftProblem[]
} {
  const problems: DraftProblem[] = []
  const bad = (path: string, code: DraftProblem['code']) => {
    problems.push({ path, code })
    return null
  }
  if (!input || typeof input !== 'object') {
    return { draft: null, problems: [{ path: '', code: 'type' }] }
  }
  const root = input as Record<string, unknown>
  const rawActivities = Array.isArray(root.activities) ? root.activities : []
  const rawPlans = Array.isArray(root.plans) ? root.plans : []

  if (rawActivities.length > OFFERING_DRAFT_LIMITS.activities) bad('activities', 'too_many')
  if (rawPlans.length > OFFERING_DRAFT_LIMITS.plans) bad('plans', 'too_many')

  const seen = new Set<DraftKey>()
  const takeKey = (v: unknown, path: string): DraftKey | null => {
    if (typeof v !== 'string' || !KEY.test(v)) return bad(`${path}.key`, 'missing')
    if (seen.has(v)) return bad(`${path}.key`, 'duplicate_key')
    seen.add(v)
    return v
  }

  const activities: DraftActivity[] = []
  rawActivities.slice(0, OFFERING_DRAFT_LIMITS.activities).forEach((raw, i) => {
    const path = `activities[${i}]`
    if (!raw || typeof raw !== 'object') return void bad(path, 'type')
    const a = raw as Record<string, unknown>
    const key = takeKey(a.key, path)
    if (!key) return
    if (!text(a.name, OFFERING_DRAFT_LIMITS.nameChars)) return void bad(`${path}.name`, 'missing')

    const out: DraftActivity = { key, name: (a.name as string).trim() }
    if (a.description !== undefined) {
      if (text(a.description, OFFERING_DRAFT_LIMITS.descriptionChars)) {
        out.description = (a.description as string).trim()
      } else bad(`${path}.description`, 'too_long')
    }
    if (a.type !== undefined) {
      if (ACTIVITY_TYPES.includes(a.type as ActivityType)) out.type = a.type as ActivityType
      else bad(`${path}.type`, 'bad_enum')
    }
    if (a.color !== undefined) {
      if (typeof a.color === 'string' && HEX.test(a.color)) out.color = a.color
      else bad(`${path}.color`, 'bad_colour')
    }
    if (Array.isArray(a.tags)) {
      const tags = a.tags.filter((t): t is string => text(t, 40)).slice(0, 8)
      if (tags.length) out.tags = tags
    }
    if (Array.isArray(a.durations)) {
      const ds: DraftDuration[] = []
      a.durations.slice(0, OFFERING_DRAFT_LIMITS.durations).forEach((d, j) => {
        const dp = `${path}.durations[${j}]`
        if (!d || typeof d !== 'object') return void bad(dp, 'type')
        const dd = d as Record<string, unknown>
        if (typeof dd.minutes !== 'number' || !Number.isFinite(dd.minutes) || dd.minutes <= 0) {
          return void bad(`${dp}.minutes`, 'bad_number')
        }
        const one: DraftDuration = { minutes: Math.round(dd.minutes) }
        if (dd.priceAmount !== undefined) {
          if (money(dd.priceAmount)) one.priceAmount = dd.priceAmount
          else bad(`${dp}.priceAmount`, 'bad_number')
        }
        ds.push(one)
      })
      if (ds.length) out.durations = ds
    }
    if (a.accessTier !== undefined) {
      if (ACCESS_TIERS.includes(a.accessTier as ActivityAccessTier)) {
        out.accessTier = a.accessTier as ActivityAccessTier
      } else bad(`${path}.accessTier`, 'bad_enum')
    }
    if (Array.isArray(a.planKeys)) {
      const ks = a.planKeys.filter((k): k is string => typeof k === 'string' && KEY.test(k))
      if (ks.length) out.planKeys = ks
    }
    if (a.dropInPriceAmount !== undefined) {
      if (money(a.dropInPriceAmount)) out.dropInPriceAmount = a.dropInPriceAmount
      else bad(`${path}.dropInPriceAmount`, 'bad_number')
    }
    activities.push(out)
  })

  const plans: DraftPlan[] = []
  rawPlans.slice(0, OFFERING_DRAFT_LIMITS.plans).forEach((raw, i) => {
    const path = `plans[${i}]`
    if (!raw || typeof raw !== 'object') return void bad(path, 'type')
    const p = raw as Record<string, unknown>
    const key = takeKey(p.key, path)
    if (!key) return
    if (!text(p.name, OFFERING_DRAFT_LIMITS.nameChars)) return void bad(`${path}.name`, 'missing')

    const out: DraftPlan = { key, name: (p.name as string).trim() }
    if (p.description !== undefined) {
      if (text(p.description, OFFERING_DRAFT_LIMITS.descriptionChars)) {
        out.description = (p.description as string).trim()
      } else bad(`${path}.description`, 'too_long')
    }
    if (Array.isArray(p.prices)) {
      const ps: DraftPrice[] = []
      p.prices.slice(0, OFFERING_DRAFT_LIMITS.prices).forEach((pr, j) => {
        const pp = `${path}.prices[${j}]`
        if (!pr || typeof pr !== 'object') return void bad(pp, 'type')
        const price = pr as Record<string, unknown>
        if (!money(price.amount)) return void bad(`${pp}.amount`, 'bad_number')
        if (!RECURRENCES.includes(price.recurrence as SubscriptionRecurrence)) {
          return void bad(`${pp}.recurrence`, 'bad_enum')
        }
        const one: DraftPrice = {
          amount: price.amount as number,
          recurrence: price.recurrence as SubscriptionRecurrence,
        }
        if (text(price.label, 60)) one.label = (price.label as string).trim()
        if (typeof price.credits === 'number' && price.credits > 0 && price.credits <= 1000) {
          one.credits = Math.round(price.credits)
        }
        ps.push(one)
      })
      if (ps.length) out.prices = ps
    }
    if (p.limit && typeof p.limit === 'object') {
      const l = p.limit as Record<string, unknown>
      const okCount = typeof l.count === 'number' && l.count > 0 && l.count <= 1000
      const okPer = LIMIT_PERIODS.includes(l.per as UsageLimitPeriod)
      if (okCount && okPer) {
        out.limit = { count: Math.round(l.count as number), per: l.per as UsageLimitPeriod }
      } else bad(`${path}.limit`, 'bad_enum')
    }
    if (Array.isArray(p.activityKeys)) {
      const ks = p.activityKeys.filter((k): k is string => typeof k === 'string' && KEY.test(k))
      if (ks.length) out.activityKeys = ks
    }
    plans.push(out)
  })

  if (!activities.length && !plans.length) {
    return { draft: null, problems: problems.length ? problems : [{ path: '', code: 'empty' }] }
  }

  // A key that points at nothing is DROPPED rather than refused: the model
  // inventing one link is not a reason to throw away five good records, and a
  // dangling reference would otherwise reach the applier, which has no way to
  // resolve it.
  const activityKeys = new Set(activities.map((a) => a.key))
  const planKeys = new Set(plans.map((p) => p.key))
  for (const a of activities) {
    if (!a.planKeys) continue
    const kept = a.planKeys.filter((k) => planKeys.has(k))
    if (kept.length !== a.planKeys.length) problems.push({ path: `${a.key}.planKeys`, code: 'unknown_key' })
    if (kept.length) a.planKeys = kept
    else delete a.planKeys
  }
  for (const p of plans) {
    if (!p.activityKeys) continue
    const kept = p.activityKeys.filter((k) => activityKeys.has(k))
    if (kept.length !== p.activityKeys.length) problems.push({ path: `${p.key}.activityKeys`, code: 'unknown_key' })
    if (kept.length) p.activityKeys = kept
    else delete p.activityKeys
  }

  const draft: OfferingDraft = { activities, plans }
  if (text(root.note, 400)) draft.note = (root.note as string).trim()
  return { draft, problems }
}

/**
 * Every plan a given activity should be gated on, unioned from BOTH directions.
 *
 * The two sides are equivalent by design — a model asked for "a plan that
 * includes Yoga" writes it from whichever side the sentence started, and
 * refusing one of them would make the draft's validity depend on English word
 * order. The applier calls this once per activity so the stored `accessRule`
 * has one source.
 */
export function planKeysForActivity(draft: OfferingDraft, activityKey: DraftKey): DraftKey[] {
  const out = new Set<DraftKey>()
  const activity = draft.activities.find((a) => a.key === activityKey)
  activity?.planKeys?.forEach((k) => out.add(k))
  for (const plan of draft.plans) {
    if (plan.activityKeys?.includes(activityKey)) out.add(plan.key)
  }
  return [...out]
}
