import type { RankLevel, RankRef, RankingSystem } from '../types/team'
// The ONE contact predicate — "does this contact match this filter?" — shared by
// every surface: the contacts list, saved filter presets, dynamic contact groups,
// and the automation engine's `in_group` condition. Pure function of
// (contact, filter, ctx): no Firestore, no firebase imports (it ships to the
// client bundle).
//
// It replaces the previously-divergent implementations:
//  • apps/web contacts/page.tsx applyFiltersAndSearch (the contacts list)
//  • packages/functions automationEngine evaluateContactConditions (partially —
//    the automation conditions remain their own vocabulary; only group
//    membership is resolved through here)
//
// NEVER add a parallel contact-matching check. Extend this resolver, the same
// way resolvePaymentOptions owns coverage/pricing. Fixtures live in
// contactFilter.test.ts.
//
// Membership of a DYNAMIC group is always DERIVED here, never stored: there is
// no materialization step and nothing to invalidate. Every membership question
// is asked from a position that already holds the data — a page holding the
// contact list filters it, a page holding one contact tests that contact, and
// the automation scan tests the contact already in hand.

import type { Contact, ContactGroup } from '../types/contact'
import { planGrantIsCurrent } from '../types/activity'
import type { EngagementBand, EngagementThresholds } from '../types/engagement'
import { computeEngagementBand } from '../types/engagement'
import { waiverAcceptanceState, type WaiverAcceptanceState, type WaiverSignerFacts } from '../types/waiver'
import { expandGroupSelection } from './contactGroups'

// ─── filter shape ─────────────────────────────────────────────────────────────

export type InactivityPreset = 'never' | '30d' | '60d' | '90d'

/** systemId → selected level values */
export type RankFilter = Record<string, RankRef[]>

/**
 * systemId → an inclusive band on that system's level VALUES. `null` on either
 * end is open: `{ min: blue, max: null }` is "Blue and above", which is how a
 * coach actually thinks about a roster and what a tick-list cannot say without
 * going wrong the moment a belt is inserted into the scale.
 *
 * ─── WHY THIS IS A SECOND KEY AND NOT A RICHER `RankFilter` VALUE ────────────
 *
 * The obvious design turns each `RankFilter` entry into
 * `{ mode, levels, min, max }`. It is unshippable here, and the reason is a
 * deployment fact rather than a taste one.
 *
 * ON STAGING the web app and the Cloud Functions roll out through INDEPENDENT
 * pipelines — functions from `deploy.yml`, the web app from App Hosting's own
 * GitHub integration — so neither order is guaranteed and a skew window exists
 * on every push. (`deploy-prod.yml` and the sandbox workflow are deliberately
 * different: auto-rollout is disabled on those backends and the frontend is
 * rolled out AFTER the backend, in lockstep. So the hazard is not universal —
 * it is real exactly where a studio first meets a change.)
 *
 * During that window an OLD resolver reads a NEW-shape value, and the failure
 * is silent and OPEN, not closed: the dimension guard is
 * `Object.values(f.rankFilter).some((l) => l.length > 0)`, and on an object
 * `l.length` is `undefined`, so the guard is false and the ENTIRE rank block —
 * including its `if (!matched) return false` — is skipped. The rank restriction
 * does not fail; it VANISHES, and the filter matches everyone it otherwise
 * would. `matchesFilter` backs dynamic contact groups, which back the
 * automation engine, which sends mail.
 *
 * THE REVERSE SKEW is survivable and worth knowing: an OLD web bundle
 * normalising a filter it loaded will drop `rankRanges` on re-save, degrading a
 * live "Blue and above" into the frozen snapshot its mirror already holds. That
 * loses the dynamic property, never widens the audience, and is the direction
 * this design deliberately trades toward.
 *
 * So `RankFilter` keeps its shape and its meaning exactly, and the band rides
 * alongside it. An old resolver ignores a key it has never heard of.
 *
 * ─── THE BAND IS THE TRUTH; THE LEVEL LIST IS ITS MIRROR ─────────────────────
 *
 * When a band is set for a system, the writer ALSO writes the levels that band
 * currently covers into `rankFilter[systemId]` — the same denormalised-mirror
 * pattern this codebase uses everywhere else. A reader that understands bands
 * uses the band and gets the dynamic answer; one that does not falls back to
 * the mirror and gets the correct-as-of-write answer, which is exactly what a
 * hand-ticked list would have given it anyway. Neither reader is ever wrong in
 * a way that widens the audience.
 *
 * `expandRankRange` is the ONLY way that mirror is produced, so the two cannot
 * be computed differently in two places.
 *
 * A CONSEQUENCE WORTH KNOWING: `rankFilter` is still a map of number arrays, so
 * a reader that only counts levels keeps working against a banded filter. That
 * is a property of the SHAPE, not a promise about the call sites — ask
 * `rankFilterIsActive` rather than counting levels yourself, and never write a
 * comment claiming every site does the right thing.
 *
 * NOT INCLUDED, deliberately: an `includeUnranked` arm. A contact with no rank
 * in the system cannot be represented in the mirror at all, so it would behave
 * differently for old and new readers — a real divergence rather than mere
 * staleness. It needs its own decision; see docs/open-defects.md.
 */
import { findRankLevel, rankLevelKey, rankRefWithin, sameRankRef, type RankLevelLike } from './rankLevels'

export interface RankRangeFilter {
  /** Each end a RankRef — the level's id, or a legacy value on a filter saved
   *  before ids existed. Inclusive, by ladder position. */
  min: RankRef | null
  max: RankRef | null
}

/**
 * The levels of `system` that fall inside the band, as the refs a record stores.
 *
 * ORDER IS ARRAY POSITION. This reversed on 2026-09-11 with the scale
 * decoupling: it used to sort by `value` because nothing validated the array on
 * write, and now `value` is not consulted for order anywhere — see
 * utils/rankLevels.ts for why array order is safe to trust and why it has to be
 * (a drag-and-drop reorder makes it the studio's explicit intent).
 *
 * It takes the levels rather than a `RankingSystem` so that a caller holding a
 * mirror, a seed fixture or a test double can use it too. The refs come back in
 * ladder order. A bound naming a level the ladder no longer has yields NOTHING:
 * a deleted bound must never widen a saved filter.
 *
 * THE PAIRING IS A WRITER'S OBLIGATION, and this module cannot check it: the
 * mirror can only be produced from the tenant's ranking systems, which a filter
 * does not carry. A band stored WITHOUT its mirror is still safe here — the
 * matcher below uses the band, and `rankFilterIsActive` sees it — so the failure
 * is confined to a resolver that predates bands, which is the transient case the
 * mirror exists for.
 */
export function expandRankRange(
  levels: ReadonlyArray<RankLevelLike>,
  range: RankRangeFilter,
): RankRef[] {
  return levels
    .filter((l) => rankRefWithin(levels, rankLevelKey(l), range.min, range.max))
    .map((l) => rankLevelKey(l))
}

/** A band that constrains nothing is not a filter — both ends open means "any". */
export function rankRangeIsActive(range: RankRangeFilter | undefined | null): boolean {
  return !!range && (range.min != null || range.max != null)
}

/**
 * "Is the rank dimension doing anything?" — THE one answer, because there is
 * more than one way to express a rank constraint now and a second opinion is a
 * bug rather than a nuance.
 *
 * It had one, briefly: the shared `activeFilterKeys` counted a band OR a mirror
 * while the contacts page counted the mirror alone, so a band that somehow
 * reached storage without its mirror produced an empty result list, a filter
 * badge reading 1, and no chip on screen to clear it. Both now call this.
 */
export function rankFilterIsActive(
  f: { rankFilter?: RankFilter | null; rankRanges?: Record<string, RankRangeFilter> | null } | null | undefined,
): boolean {
  if (!f) return false
  return (
    Object.values(f.rankFilter ?? {}).some((l) => l.length > 0) ||
    Object.values(f.rankRanges ?? {}).some(rankRangeIsActive)
  )
}

/**
 * Age / birth-year window.
 *
 * Two modes, because they are genuinely different questions and sports use both:
 *  • 'age'        — the contact's age TODAY (min/max inclusive). "Kids 8–12".
 *  • 'birth_year' — the calendar year of birth (min/max inclusive). Competition
 *    and roster categories are year-based: a child born in December and one born
 *    the following January are the same category all season, but their current
 *    ages differ for eleven months of it.
 *
 * `includeUnknown` keeps contacts with no birthdate in the result — off by
 * default, since a missing birthdate is common and silently dropping those
 * contacts from an age-based group is the kind of thing nobody notices.
 */
export interface AgeFilter {
  mode: 'age' | 'birth_year'
  min: number | null
  max: number | null
  includeUnknown?: boolean
}

export type CustomFieldOp =
  | 'equals'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'is_set'
  | 'is_empty'

/**
 * One condition against a Custom Fields plugin value (Contact.custom_fields,
 * keyed by CustomFieldDefinition.id). Dates are stored as ISO 'YYYY-MM-DD'
 * strings, so gt/lt compare correctly as plain string comparisons.
 */
export interface CustomFieldCondition {
  fieldId: string
  op: CustomFieldOp
  value?: string | number | boolean
}

/**
 * "Has this person accepted document X, and if not, what happened?"
 *
 * ONE document × the states it may be in. The states are `waiverAcceptanceState`'s
 * five, evaluated by that function and never re-derived here: supersession and
 * expiry are DERIVED facts (a `require_resign` publish moves one number and writes
 * zero signer rows), so a second state machine in a filter would disagree with the
 * gate the day a studio republished.
 *
 * It covers BOTH consent surfaces, because both write the same ledger: a document
 * shown at signup and a document required before booking each produce a signer
 * row, and this dimension asks about the row.
 *
 * `states: []` (or no documentId) = the dimension is off. The usual selection is
 * `['none']` — "everyone I have never got a signature from" — which is the whole
 * reason the dimension exists: a studio that makes a document mandatory needs to
 * find the people already on its books.
 */
export interface ConsentFilter {
  documentId: string
  states: WaiverAcceptanceState[]
}

export interface ContactFilter {
  /** Free-text over name + email. Part of the filter so saved presets capture it. */
  search: string
  stages: string[]           // AcquisitionStage values
  sources: string[]          // ContactSource values
  statuses: string[]         // 'active' (affiliated) / 'none'
  subscriptions: string[]    // subscription_type_id values; 'none' = no subscription
  /** contact_groups IDs; parents include subgroups. `GROUP_NONE` = in NO group
   *  at all — see `matchesGroupSelection` for why that has to be asked here and
   *  cannot be a saved list of ids. */
  groups: string[]
  /** Assigned-coach uids (`Contact.assigned_coach_ids`); `COACH_NONE` = nobody
   *  is assigned. A manager who can see everyone still needs to narrow to one
   *  coach's people, and "unassigned" is the follow-up question that makes the
   *  dimension worth having. */
  coaches: string[]
  engagement: EngagementBand[]
  tags: string[]
  hasAlerts: boolean
  /** Somebody has written a note on this contact. Reads `notes_count`, which the
   *  `trackContactNotes` trigger maintains — a note is a subcollection document
   *  and this predicate never leaves the contact it was handed. */
  hasNotes: boolean
  /**
   * NO EMAIL ON FILE — the people a studio cannot reach or identify by mail.
   *
   * Its use is the data-collection campaign: filter to these, select all, print
   * their QR slips. Without it "Select all" means the whole roster, so a club
   * with one gap prints fifty slips to close it.
   *
   * "Missing" counts `login_emails` too, not just the primary field. That list
   * is what `loginCandidates` resolves a sign-in through — a child whose parent's
   * address is on it can already reach their Space, so putting a slip in their
   * hand collects an address nobody needed.
   */
  missingEmail: boolean
  pendingSignup: boolean
  /** "Who needs me today" — derived, never stored; see
   *  `contactAttentionReasons` for exactly what counts and why the answer is a
   *  LIST of reasons rather than a flag. */
  needsAttention: boolean
  sessionsMin: number | null
  sessionsMax: number | null
  inactivity: InactivityPreset | null
  rankFilter: RankFilter | null
  /** systemId → an inclusive band. When set for a system it OVERRIDES that
   *  system's entry in `rankFilter`, which is the band's mirror. Optional so
   *  every stored filter written before bands existed is already valid. */
  rankRanges?: Record<string, RankRangeFilter> | null
  age: AgeFilter | null
  customFields: CustomFieldCondition[]
  consent: ConsentFilter | null
}

/** "In no group at all" — a sentinel inside the `groups` dimension, mirroring
 *  the `'none'` the `subscriptions` dimension already uses. A group id can
 *  never collide with it (Firestore ids are 20 chars). */
export const GROUP_NONE = 'none'
/** "No coach assigned" — the same sentinel convention inside `coaches`. A uid
 *  can never be this string. */
export const COACH_NONE = 'none'

/**
 * Any address that would let this person sign in — the primary field or the
 * `login_emails` allow-list. Exported because "do we have an email for them"
 * is asked by the filter and is exactly the question a campaign asks; a second
 * spelling of it elsewhere is how the roster and the slips would disagree
 * about who still needs one.
 *
 * Whitespace counts as absent: an imported `" "` is not an address.
 */
export function contactHasEmail(subject: {
  email?: string
  login_emails?: string[]
}): boolean {
  if (typeof subject.email === 'string' && subject.email.trim()) return true
  return (subject.login_emails ?? []).some((e) => typeof e === 'string' && e.trim().length > 0)
}

export const EMPTY_CONTACT_FILTER: ContactFilter = {
  search: '',
  stages: [], sources: [], statuses: [], subscriptions: [], groups: [], coaches: [],
  engagement: [], tags: [],
  hasAlerts: false, hasNotes: false, missingEmail: false,
  pendingSignup: false, needsAttention: false,
  sessionsMin: null, sessionsMax: null,
  inactivity: null, rankFilter: null, age: null, customFields: [],
  consent: null,
}

/**
 * Normalize a persisted/partial filter to a complete one. Saved presets and
 * group rules written before a dimension existed simply lack the key.
 *
 * Array/object fields are CLONED: a plain spread of EMPTY_CONTACT_FILTER would
 * hand every caller the same array instances, so one in-place edit anywhere
 * would silently rewrite every other filter in the app.
 */
export function normalizeContactFilter(filter: Partial<ContactFilter> | null | undefined): ContactFilter {
  const f = filter ?? {}
  return {
    search: f.search ?? '',
    stages: [...(f.stages ?? [])],
    sources: [...(f.sources ?? [])],
    statuses: [...(f.statuses ?? [])],
    subscriptions: [...(f.subscriptions ?? [])],
    groups: [...(f.groups ?? [])],
    coaches: [...(f.coaches ?? [])],
    engagement: [...(f.engagement ?? [])],
    tags: [...(f.tags ?? [])],
    hasAlerts: f.hasAlerts ?? false,
    // `?? false` is what makes every filter document written before this
    // dimension existed still valid — saved presets and dynamic group rules are
    // both stored, and neither is migrated.
    hasNotes: f.hasNotes ?? false,
    missingEmail: f.missingEmail ?? false,
    pendingSignup: f.pendingSignup ?? false,
    needsAttention: f.needsAttention ?? false,
    sessionsMin: f.sessionsMin ?? null,
    sessionsMax: f.sessionsMax ?? null,
    inactivity: f.inactivity ?? null,
    rankFilter: f.rankFilter ? { ...f.rankFilter } : null,
    // Cloned PER ENTRY, not just at the top: the shallow spread above would
    // hand every caller the same band objects, and one in-place edit on the
    // contacts page would reach into saved presets held in the same tree.
    // An inert band (both ends open) is dropped so it cannot make the
    // dimension read as active.
    rankRanges: f.rankRanges
      ? Object.fromEntries(
          Object.entries(f.rankRanges)
            .filter(([, r]) => rankRangeIsActive(r))
            .map(([k, r]) => [k, { min: r.min ?? null, max: r.max ?? null }]),
        )
      : null,
    age: f.age ? { ...f.age } : null,
    customFields: (f.customFields ?? []).map((c) => ({ ...c })),
    consent: f.consent ? { ...f.consent, states: [...(f.consent.states ?? [])] } : null,
  }
}

/** A fresh empty filter — safe to mutate, unlike the shared EMPTY_CONTACT_FILTER. */
export function emptyContactFilter(): ContactFilter {
  return normalizeContactFilter(null)
}

/** Which dimensions carry a value — drives the chip row and the "N active" badge. */
export function activeFilterKeys(filter: Partial<ContactFilter> | null | undefined): (keyof ContactFilter)[] {
  const f = normalizeContactFilter(filter)
  const keys: (keyof ContactFilter)[] = []
  if (f.search.trim()) keys.push('search')
  if (f.stages.length) keys.push('stages')
  if (f.sources.length) keys.push('sources')
  if (f.statuses.length) keys.push('statuses')
  if (f.subscriptions.length) keys.push('subscriptions')
  if (f.groups.length) keys.push('groups')
  if (f.coaches.length) keys.push('coaches')
  if (f.engagement.length) keys.push('engagement')
  if (f.tags.length) keys.push('tags')
  if (f.hasAlerts) keys.push('hasAlerts')
  if (f.hasNotes) keys.push('hasNotes')
  if (f.missingEmail) keys.push('missingEmail')
  if (f.pendingSignup) keys.push('pendingSignup')
  if (f.needsAttention) keys.push('needsAttention')
  if (f.sessionsMin != null || f.sessionsMax != null) keys.push('sessionsMin')
  if (f.inactivity) keys.push('inactivity')
  if (rankFilterIsActive(f)) keys.push('rankFilter')
  if (f.age && (f.age.min != null || f.age.max != null)) keys.push('age')
  if (f.customFields.length) keys.push('customFields')
  if (f.consent?.documentId && f.consent.states.length) keys.push('consent')
  return keys
}

export function countActiveFilters(filter: Partial<ContactFilter> | null | undefined): number {
  return activeFilterKeys(filter).length
}

/**
 * Every document id a set of filters asks about — the shopping list a caller
 * loads ledgers for before it evaluates anything.
 *
 * ONE derivation, shared by the contacts page (its own filter), the group
 * surfaces (every dynamic group's rule) and the automation engine (the same
 * rules, server-side). A caller that computed this itself would eventually load a
 * different set from the one the predicate reads, and the consent dimension fails
 * CLOSED — so the symptom would be a filter that silently matches nobody.
 */
export function consentDocumentIds(
  filters: (Partial<ContactFilter> | null | undefined)[]
): string[] {
  const ids = new Set<string>()
  for (const f of filters) {
    const consent = f?.consent
    if (consent?.documentId && (consent.states?.length ?? 0) > 0) ids.add(consent.documentId)
  }
  return [...ids].sort()
}

export function isEmptyContactFilter(filter: Partial<ContactFilter> | null | undefined): boolean {
  return activeFilterKeys(filter).length === 0
}

// ─── subject + context ────────────────────────────────────────────────────────

/** Tolerant timestamp: client Timestamp, admin Timestamp, raw doc data, or ISO. */
export type TimestampLike =
  | { toDate(): Date }
  | { seconds: number; nanoseconds?: number }
  | { _seconds: number }
  | Date
  | string
  | number
  | null
  | undefined

export function resolveTimestampMs(value: TimestampLike): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? null : ms
  }
  if (value instanceof Date) return value.getTime()
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      return (value as { toDate(): Date }).toDate().getTime()
    } catch {
      return null
    }
  }
  const secs =
    (value as { seconds?: number }).seconds ?? (value as { _seconds?: number })._seconds
  return typeof secs === 'number' ? secs * 1000 : null
}

/**
 * What the predicate may read off a contact. Deliberately structural and fully
 * optional so BOTH the client `Contact` and the functions' raw doc data satisfy
 * it without conversion.
 */
export interface ContactFilterSubject {
  /**
   * The contact's document id. Optional like everything else here — but the
   * `consent` dimension is the one that NEEDS it: a signer row is keyed on
   * contactId, so a subject with no id cannot be answered and is excluded rather
   * than defaulted into the "never signed" bucket.
   */
  id?: string
  firstname?: string
  lastname?: string
  email?: string
  /** The sign-in allow-list (a parent's address on a child's record). Read by
   *  the `missingEmail` dimension, which must not offer a slip to somebody who
   *  can already sign in through it. */
  login_emails?: string[]
  acquisition_stage?: string
  source?: string
  affiliation_summary?: { has_active?: boolean }
  subscription_type_id?: string
  /** End of a one-off plan grant ("2 months included"), compared rather than
   *  trusted — see `planGrantIsCurrent`. */
  subscription_expires_at?: { toMillis(): number } | null
  /** `cancelling` is read by the attention reasons: a member who has asked
   *  Stripe to stop is still live, still training, and is the one the studio has
   *  the shortest window to talk to. */
  active_subscriptions?: { subscription_type_id: string; cancelling?: boolean }[]
  group_ids?: string[]
  assigned_coach_ids?: string[]
  tags?: string[]
  alerts_count?: number
  notes_count?: number
  pending_signup?: boolean
  /** `false` = a lead nobody has opened yet. Absent/true = seen. */
  lead_acknowledged?: boolean
  /** Off the roster (see `contactLifecycle`). Read ONLY by the attention
   *  reasons: an external is never waiting on the studio. */
  external?: boolean
  total_sessions?: number
  last_session_at?: TimestampLike
  /** Denormalized coaching counters — see the attention reasons below. */
  coaching_overdue_count?: number
  last_checkin_at?: TimestampLike
  created_at?: TimestampLike
  birthdate?: TimestampLike
  /** systemId → RankRef (the level's id, or a legacy number). */
  ranks?: Record<string, RankRef>
  custom_fields?: Record<string, string | number | boolean>
}

export interface ContactFilterContext {
  /** All groups of the team — needed to expand parents and resolve dynamic rules. */
  groups?: ContactGroup[]
  engagementThresholds?: EngagementThresholds
  /**
   * The tenant's EFFECTIVE ranking systems, so a rank band can be evaluated by
   * ladder position and a legacy numeric rank compared with an id-based mirror.
   * Optional: without it the matcher falls back to the band's stored mirror
   * (exact refs) and, for a numeric band against a numeric rank, to the old
   * numeric compare — it never widens a result for lack of context.
   */
  rankingSystems?: RankingSystem[]
  /**
   * documentId → that document's whole signature ledger, for every document the
   * `consent` dimension (or a dynamic group's consent rule) names.
   *
   * THIS IS HOW THE DIMENSION AVOIDS A PER-CONTACT FAN-OUT. `matchesFilter` is
   * pure and reads what the caller already holds, and "has this contact signed
   * document X" is not on the contact document — it is a row under
   * `documents/{X}/signers/{contactId}`. Asking per contact would be one read per
   * row of the list. So the CALLER loads the ledger ONCE PER DOCUMENT (a single
   * subcollection query, bounded by how many people ever signed that document —
   * never by how many contacts are being filtered) and hands the map in here.
   * The same map answers every contact in the list, every dynamic-group count and
   * every automation scan.
   *
   * A documentId with NO entry cannot be answered, and the predicate then matches
   * NOBODY — the same direction the group fallback takes: a partial context must
   * never silently widen a result set. A caller that forgets to load the ledger
   * therefore shows an empty list (visible) rather than everybody (wrong).
   */
  consent?: Record<string, ConsentLedger>
  /** Injectable clock — pass in tests; defaults to Date.now(). */
  nowMs?: number
  /** How long without a performance check-in counts as lapsed. Defaults to
   *  `DEFAULT_CHECKIN_LAPSE_DAYS`. */
  checkinLapseDays?: number
}

/** One document's signature ledger, as the filter reads it. */
export interface ConsentLedger {
  /**
   * The floor a signature must meet: the policy entry's `min_valid_version` where
   * the document is a required waiver, else the document's own. Moved by a
   * `require_resign` publish, which is what makes a signature `superseded`.
   */
  minValidVersion: number
  /** contactId → the four facts `waiverAcceptanceState` reads. ABSENT means never
   *  signed, which is `none` — the common case, and the one a studio filters for. */
  signers: Record<string, WaiverSignerFacts>
}

// ─── age ──────────────────────────────────────────────────────────────────────

/** Calendar-correct age in whole years (not a 365.25-day division). */
export function calcAgeYears(birthMs: number, nowMs: number): number {
  const b = new Date(birthMs)
  const n = new Date(nowMs)
  let age = n.getFullYear() - b.getFullYear()
  const monthDelta = n.getMonth() - b.getMonth()
  if (monthDelta < 0 || (monthDelta === 0 && n.getDate() < b.getDate())) age--
  return age
}

function matchesAge(subject: ContactFilterSubject, age: AgeFilter, nowMs: number): boolean {
  const birthMs = resolveTimestampMs(subject.birthdate)
  if (birthMs === null) return age.includeUnknown === true
  const value = age.mode === 'birth_year'
    ? new Date(birthMs).getFullYear()
    : calcAgeYears(birthMs, nowMs)
  if (age.min != null && value < age.min) return false
  if (age.max != null && value > age.max) return false
  return true
}

// ─── custom fields ────────────────────────────────────────────────────────────

function matchesCustomField(subject: ContactFilterSubject, cond: CustomFieldCondition): boolean {
  const raw = subject.custom_fields?.[cond.fieldId]
  const isEmpty = raw === undefined || raw === null || raw === ''
  switch (cond.op) {
    case 'is_set':   return !isEmpty
    case 'is_empty': return isEmpty
    case 'equals':
      if (isEmpty) return false
      if (typeof raw === 'boolean') return raw === (cond.value === true || cond.value === 'true')
      return String(raw).toLowerCase() === String(cond.value ?? '').toLowerCase()
    case 'contains':
      if (isEmpty) return false
      return String(raw).toLowerCase().includes(String(cond.value ?? '').toLowerCase())
    case 'gt':
    case 'lt': {
      if (isEmpty) return false
      // Numbers compare numerically; ISO 'YYYY-MM-DD' dates compare lexically.
      if (typeof raw === 'number') {
        const other = Number(cond.value)
        if (Number.isNaN(other)) return false
        return cond.op === 'gt' ? raw > other : raw < other
      }
      const a = String(raw)
      const b = String(cond.value ?? '')
      return cond.op === 'gt' ? a > b : a < b
    }
    default:
      return true
  }
}

// ─── group membership ─────────────────────────────────────────────────────────

/**
 * Is this contact in this group?
 *
 * Manual group  → membership is the stored `group_ids` array.
 * Dynamic group → membership is DERIVED by evaluating the group's rule right
 *   here, right now. Nothing is stored and nothing can go stale.
 *
 * The `groups` dimension is stripped when evaluating a dynamic rule: a dynamic
 * group whose rule filters on group membership could recurse (A → B → A), so
 * the dimension is structurally unavailable inside a rule rather than merely
 * discouraged in the editor.
 */
export function contactMatchesGroup(
  subject: ContactFilterSubject,
  group: ContactGroup,
  ctx: ContactFilterContext = {},
): boolean {
  if (group.rule) {
    return matchesFilter(subject, toGroupRule(group.rule), ctx)
  }
  return (subject.group_ids ?? []).includes(group.id)
}

/**
 * Every group the contact belongs to, manual or dynamic. Asked from the contact
 * side (detail-page chips): O(groups), and it needs no contact list at all.
 */
export function groupsForContact(
  subject: ContactFilterSubject,
  groups: ContactGroup[],
  ctx: ContactFilterContext = {},
): ContactGroup[] {
  return groups.filter((g) => contactMatchesGroup(subject, g, ctx))
}

/**
 * Members of a group out of an already-loaded list. Asked from the list side
 * (groups page, counts, bulk targets).
 */
export function membersOfGroup<T extends ContactFilterSubject>(
  contacts: T[],
  group: ContactGroup,
  ctx: ContactFilterContext = {},
): T[] {
  return contacts.filter((c) => contactMatchesGroup(c, group, ctx))
}

/**
 * Is the contact in NO group at all?
 *
 * It has to be ASKED, not stored: half the groups in this product are dynamic,
 * so "ungrouped" is not `group_ids.length === 0` — a contact with an empty array
 * can still be derived into three dynamic groups, and a materialized "ungrouped"
 * flag would be wrong the moment a rule (or the contact's birthday) changed.
 * Asking is cheap and correct: it is `groupsForContact` with an early exit, over
 * the group list the caller already holds.
 *
 * With NO group context loaded it falls back to the stored membership — the
 * caller cannot be told about groups it did not load, and every real caller
 * (contacts page, group surfaces, automation scan) loads them.
 */
function contactIsUngrouped(subject: ContactFilterSubject, ctx: ContactFilterContext): boolean {
  const all = ctx.groups ?? []
  if (all.length === 0) return (subject.group_ids ?? []).length === 0
  return !all.some((g) => contactMatchesGroup(subject, g, ctx))
}

/** Does the contact belong to ANY of the selected groups (descendants included),
 *  or — for `GROUP_NONE` — to none at all? */
function matchesGroupSelection(
  subject: ContactFilterSubject,
  selected: string[],
  ctx: ContactFilterContext,
): boolean {
  if (selected.includes(GROUP_NONE) && contactIsUngrouped(subject, ctx)) return true
  const all = ctx.groups ?? []
  // The sentinel is not an id and must never reach the tree expansion.
  const wanted = expandGroupSelection(all, selected.filter((id) => id !== GROUP_NONE))
  const byId = new Map(all.map((g) => [g.id, g]))
  const memberIds = subject.group_ids ?? []
  for (const gid of wanted) {
    const group = byId.get(gid)
    if (!group) {
      // Group not loaded (or deleted): fall back to the stored membership so a
      // partial context can never silently widen the result set.
      if (memberIds.includes(gid)) return true
      continue
    }
    if (contactMatchesGroup(subject, group, ctx)) return true
  }
  return false
}

// ─── "who needs me today" ─────────────────────────────────────────────────────

/**
 * WHY THIS EXISTS. A contacts list ordered by surname answers "where is
 * Meier?" — the question you ask when you already know the name. It cannot
 * answer the question a studio actually opens the page with in the morning:
 * *who is waiting on me?* That was UX-44, and the surname ordering was only its
 * symptom: no ordering of an alphabet can answer it, because the answer is not
 * a property of the name.
 *
 * So the answer is a derived LIST OF REASONS, not a flag and not a score:
 * "needs attention" with no reason attached is a badge nobody trusts, and the
 * studio has to be able to see WHY a person is at the top of the list before
 * they will believe the list.
 *
 * Every reason reads a fact that is already ON the contact document — no extra
 * read, no fan-out, nothing stored, nothing to invalidate. That is deliberate
 * and it is also the constraint: a reason that would need another query
 * (unpaid invoice, unanswered message) belongs here only once its fact is
 * denormalized onto the contact, the same rule `affiliation_summary` and
 * `active_subscriptions` already follow.
 */
export type ContactAttentionReason =
  /** An open alert on the record — the studio's own explicit flag. */
  | 'alerts'
  /** A signup request the studio has not processed. */
  | 'pending_signup'
  /** A lead nobody has looked at yet (`lead_acknowledged === false`). */
  | 'new_lead'
  /** Booked a trial and has not attended it — the highest-intent moment in the
   *  funnel, and the one that goes cold fastest. */
  | 'trial_pending'
  /** Someone who used to come and has stopped: engagement resolves to the
   *  lowest band AND they have attended at least once. Never fires for a
   *  brand-new contact, whose "inactivity" is just newness. */
  | 'gone_quiet'
  /**
   * A live subscription that will not renew — the member cancelled in Stripe's
   * billing portal, and the studio found out when the money stopped.
   *
   * IT READS A FACT THE CONTACT ALREADY CARRIES. `active_subscriptions` mirrors
   * only LIVE subscriptions and each summary is stamped `cancelling` by
   * `rollupMemberSubscriptions` — so this needed no new field, no new writer and
   * no backfill. It also cannot outlive the thing it describes: the moment the
   * subscription actually lapses it drops out of the mirror, and the reason goes
   * with it.
   */
  | 'cancelling'
  /**
   * Stripe is still billing for a plan this contact is no longer assigned.
   *
   * The two systems CAN diverge in one click — clearing or reassigning a
   * contact's plan does not, by itself, stop a live Stripe subscription — and
   * until this existed the divergence was invisible: the contact showed no
   * membership, the money kept arriving, and the only apparent way back was to
   * RESUME the billing, which reinstated the very thing the studio had removed.
   *
   * Like `cancelling`, it reads facts the contact document already carries:
   * `active_subscriptions` (live Stripe subscriptions, by type id) against
   * `subscription_type_id` (the plan the studio has actually assigned).
   */
  | 'billing_unlinked'
  /**
   * A coaching goal or step is past its target date and still open.
   *
   * Reads `coaching_overdue_count`, maintained by the `onGoalWrite` trigger.
   * It needs a denormalized counter for the reason stated in this block's
   * header — the alternative is a subcollection query per row of the list —
   * and it needs the daily job's `overdue_at` stamp because a goal falling
   * overdue involves NO write of its own: the date stays put and the clock
   * moves. That is the same reason dynamic contact groups exist.
   */
  | 'goal_overdue'
  /**
   * Someone who was checking in and has stopped.
   *
   * Fires ONLY for a contact who has checked in at least once. A contact who
   * never has is not lapsed, they are unstarted — and flagging every contact on
   * the day the feature ships is exactly how a badge stops being trusted. Same
   * shape as `gone_quiet`, which requires `total_sessions > 0` for the same
   * reason.
   */
  | 'checkin_lapsed'

/**
 * How long a contact who HAS checked in can go without checking in again before
 * the studio should hear about it.
 *
 * Fourteen days rather than seven: a check-in is a reflection, not a habit
 * tracker, and a fortnight is the first point at which silence says something a
 * coach could not have guessed. Overridable per call so a studio that runs a
 * different rhythm is not arguing with a constant.
 */
export const DEFAULT_CHECKIN_LAPSE_DAYS = 14

function checkinLapseMs(ctx: ContactFilterContext): number {
  const days = ctx.checkinLapseDays ?? DEFAULT_CHECKIN_LAPSE_DAYS
  return days * 24 * 60 * 60 * 1000
}

/** Descending urgency — the sort order and nothing else. Kept beside the union
 *  so a new reason cannot be added without placing it. */
const ATTENTION_WEIGHT: Record<ContactAttentionReason, number> = {
  alerts: 5,
  pending_signup: 4,
  // Above `trial_pending`, below an explicit flag: a member on the way out is a
  // conversation with a DEADLINE — the period end — and unlike a quiet member
  // there is a known date after which the chance is gone.
  cancelling: 4,
  // Below the people-facing reasons and above "gone quiet": money is moving that
  // the studio has not accounted for, which is urgent — but a person going cold
  // is not recoverable later and a billing record is.
  billing_unlinked: 2,
  trial_pending: 3,
  new_lead: 2,
  // Coaching sits with the other "this relationship is drifting" reasons: above
  // a quiet member (there is a commitment on the record that has been missed,
  // which is more specific than absence) and below anything with money or a
  // deadline attached.
  goal_overdue: 2,
  checkin_lapsed: 1,
  gone_quiet: 1,
}

/**
 * Is Stripe billing this contact for something the studio has not assigned them?
 *
 * TRUE when there is at least one LIVE subscription and NONE of them matches the
 * plan on the contact — which covers both ways the two can drift apart: the plan
 * cleared while the billing ran on, and the plan replaced by a different type
 * while the old billing ran on. A member holding a second, additional membership
 * is NOT flagged: one of their live subscriptions still matches.
 *
 * Exported because three surfaces ask it — the contact page, the payments
 * Subscriptions tab and this file's attention reasons — and a second copy of the
 * comparison is how they would start disagreeing about whose billing is orphaned.
 */
export function contactBillingIsUnlinked(subject: ContactFilterSubject): boolean {
  const live = subject.active_subscriptions ?? []
  if (live.length === 0) return false
  const assigned = subject.subscription_type_id
  if (!assigned) return true
  return !live.some((s) => s.subscription_type_id === assigned)
}

/** Every reason this contact is waiting on the studio, most urgent first. */
export function contactAttentionReasons(
  subject: ContactFilterSubject,
  ctx: ContactFilterContext = {},
): ContactAttentionReason[] {
  const nowMs = ctx.nowMs ?? Date.now()
  const reasons: ContactAttentionReason[] = []
  // An EXTERNAL is never waiting on the studio. Every reason below describes a
  // person the studio looks after — a trial to convert, a member gone quiet, a
  // lead nobody opened — and a ClassPass visitor who attended once and never
  // came back is none of those; before this bucket existed they filled the
  // attention queue with "gone quiet" rows nobody could act on. Decided before
  // any reason so a stored alert on an external stays on their page and off
  // the queue.
  if (subject.external === true) return reasons
  if ((subject.alerts_count ?? 0) > 0) reasons.push('alerts')
  if (subject.pending_signup === true) reasons.push('pending_signup')
  if (subject.acquisition_stage === 'trial_booked') reasons.push('trial_pending')
  if (subject.lead_acknowledged === false) reasons.push('new_lead')
  if ((subject.active_subscriptions ?? []).some((s) => s.cancelling === true))
    reasons.push('cancelling')
  if (contactBillingIsUnlinked(subject)) reasons.push('billing_unlinked')
  if ((subject.coaching_overdue_count ?? 0) > 0) reasons.push('goal_overdue')
  const lastCheckinMs = resolveTimestampMs(subject.last_checkin_at)
  if (lastCheckinMs !== null && nowMs - lastCheckinMs > checkinLapseMs(ctx)) {
    reasons.push('checkin_lapsed')
  }
  if ((subject.total_sessions ?? 0) > 0) {
    const refMs =
      resolveTimestampMs(subject.last_session_at) ?? resolveTimestampMs(subject.created_at)
    if (computeEngagementBand(refMs, ctx.engagementThresholds, nowMs) === 'inactive') {
      reasons.push('gone_quiet')
    }
  }
  return reasons.sort((a, b) => ATTENTION_WEIGHT[b] - ATTENTION_WEIGHT[a])
}

export function contactNeedsAttention(
  subject: ContactFilterSubject,
  ctx: ContactFilterContext = {},
): boolean {
  return contactAttentionReasons(subject, ctx).length > 0
}

/** The urgency of the single most urgent reason (0 = nothing waiting). */
export function contactAttentionScore(
  subject: ContactFilterSubject,
  ctx: ContactFilterContext = {},
): number {
  const top = contactAttentionReasons(subject, ctx)[0]
  return top ? ATTENTION_WEIGHT[top] : 0
}

/**
 * Sort comparator: most urgent first, alphabetical within equal urgency.
 *
 * A CLIENT sort on an already-loaded list, and that is a decision rather than a
 * shortcut — this ordering CANNOT be a Firestore query. It is derived (the
 * engagement band moves with the clock, with no write), so there is no field to
 * index and no composite index to add; the surname index the list query needs
 * stays exactly as it is.
 */
export function compareContactsByAttention(
  a: ContactFilterSubject,
  b: ContactFilterSubject,
  ctx: ContactFilterContext = {},
): number {
  const diff = contactAttentionScore(b, ctx) - contactAttentionScore(a, ctx)
  if (diff !== 0) return diff
  return (
    (a.lastname ?? '').localeCompare(b.lastname ?? '') ||
    (a.firstname ?? '').localeCompare(b.firstname ?? '')
  )
}

// ─── the predicate ────────────────────────────────────────────────────────────

/**
 * Does this contact match this filter? Every dimension is ANDed; within a
 * dimension, selected values are ORed.
 */
export function matchesFilter(
  subject: ContactFilterSubject,
  filter: Partial<ContactFilter> | null | undefined,
  ctx: ContactFilterContext = {},
): boolean {
  const f = normalizeContactFilter(filter)
  const nowMs = ctx.nowMs ?? Date.now()

  if (f.stages.length > 0) {
    if (!subject.acquisition_stage || !f.stages.includes(subject.acquisition_stage)) return false
  }

  if (f.sources.length > 0) {
    if (!subject.source || !f.sources.includes(subject.source)) return false
  }

  // Affiliation: 'active' (has_active) vs 'none' (not affiliated). Both = no filter.
  if (f.statuses.length > 0) {
    const wantsActive = f.statuses.includes('active')
    const wantsNone = f.statuses.includes('none')
    if (wantsActive && !wantsNone && subject.affiliation_summary?.has_active !== true) return false
    if (wantsNone && !wantsActive && subject.affiliation_summary?.has_active === true) return false
  }

  // Subscription — reads BOTH the primary snapshot and active_subscriptions. The
  // contacts list renders from active_subscriptions, so a contact whose
  // subscriptions live only in that array used to be misfiltered as "none".
  if (f.subscriptions.length > 0) {
    const held = new Set<string>()
    // The flat grant is honoured only while it is CURRENT — the same
    // `planGrantIsCurrent` comparison the booking gate makes, so "on the intro
    // plan" stops meaning her the moment it stops covering her. Without this the
    // list, and every dynamic group built on it, would keep chasing a lapsed
    // member with plan-holder messaging that the gate itself refuses.
    if (subject.subscription_type_id && planGrantIsCurrent(subject, nowMs)) {
      held.add(subject.subscription_type_id)
    }
    for (const s of subject.active_subscriptions ?? []) {
      if (s?.subscription_type_id) held.add(s.subscription_type_id)
    }
    const wantsNone = f.subscriptions.includes('none')
    const wantedTypes = f.subscriptions.filter((s) => s !== 'none')
    const matched =
      (wantsNone && held.size === 0) ||
      wantedTypes.some((t) => held.has(t))
    if (!matched) return false
  }

  if (f.groups.length > 0) {
    if (!matchesGroupSelection(subject, f.groups, ctx)) return false
  }

  // Coach — ORed within the dimension, with COACH_NONE meaning unassigned. Read
  // off `assigned_coach_ids`, the SAME array the own-scope Firestore rules and
  // `useActiveContacts`' coach-scoped query use, so "one coach's people" means
  // one thing everywhere.
  if (f.coaches.length > 0) {
    const assigned = subject.assigned_coach_ids ?? []
    const wantsNone = f.coaches.includes(COACH_NONE)
    const wantedUids = f.coaches.filter((c) => c !== COACH_NONE)
    const matched =
      (wantsNone && assigned.length === 0) || wantedUids.some((uid) => assigned.includes(uid))
    if (!matched) return false
  }

  if (f.tags.length > 0) {
    const tags = subject.tags ?? []
    if (!f.tags.some((t) => tags.includes(t))) return false
  }

  if (f.hasAlerts && (subject.alerts_count ?? 0) <= 0) return false
  if (f.hasNotes && (subject.notes_count ?? 0) <= 0) return false
  if (f.missingEmail && contactHasEmail(subject)) return false

  if (f.needsAttention && contactAttentionReasons(subject, ctx).length === 0) return false

  if (f.pendingSignup && subject.pending_signup !== true) return false

  if (f.sessionsMin != null && (subject.total_sessions ?? 0) < f.sessionsMin) return false
  if (f.sessionsMax != null && (subject.total_sessions ?? 0) > f.sessionsMax) return false

  if (f.inactivity) {
    const last = resolveTimestampMs(subject.last_session_at)
    if (f.inactivity === 'never') {
      if (last !== null) return false
    } else {
      const days = f.inactivity === '30d' ? 30 : f.inactivity === '60d' ? 60 : 90
      const cutoff = nowMs - days * 86_400_000
      if (!(last === null || last < cutoff)) return false
    }
  }

  // Systems are ORed: holding a matching rank in any one of them is a match.
  //
  // A BAND OVERRIDES ITS MIRROR. `rankFilter[systemId]` is written from the band
  // by `expandRankRange` so that resolvers which predate bands still filter
  // correctly (see RankRangeFilter for why that mirror exists at all). Here, in
  // a resolver that DOES understand bands, the band is the authority — it is the
  // one that survives a level being inserted into the scale.
  //
  // Every comparison happens under the SAME `systemId` the threshold was keyed
  // by, which is what makes it meaningful: a level value is an ordinal inside
  // its own system and means nothing across systems.
  const rankSystemIds = new Set([
    ...Object.keys(f.rankFilter ?? {}),
    ...Object.keys(f.rankRanges ?? {}),
  ])
  if (rankFilterIsActive(f)) {
    const matched = [...rankSystemIds].some((systemId) => {
      const range = f.rankRanges?.[systemId]
      const rank = subject.ranks?.[systemId]
      if (rank == null) return false
      const ladder = ctx.rankingSystems?.find((s) => s.id === systemId)?.levels
      if (rankRangeIsActive(range)) {
        // With the ladder in hand the band is answered by POSITION, which is
        // what makes a legacy number and an id comparable and what survives a
        // level being inserted. Without it, a numeric band against a numeric
        // rank keeps the old compare; a band naming ids cannot be evaluated
        // and falls through to its mirror below.
        if (ladder) return rankRefWithin(ladder, rank, range!.min, range!.max)
        const numeric =
          typeof rank === 'number' &&
          (range!.min == null || typeof range!.min === 'number') &&
          (range!.max == null || typeof range!.max === 'number')
        if (numeric) {
          if (range!.min != null && rank < (range!.min as number)) return false
          if (range!.max != null && rank > (range!.max as number)) return false
          return true
        }
      }
      const levels = f.rankFilter?.[systemId]
      if (!levels?.length) return false
      // The mirror holds refs. Resolve both sides through the ladder when we
      // have it, so a contact still on a legacy number matches an id-based
      // mirror and vice versa; otherwise compare refs as stored.
      if (ladder) {
        const held = findRankLevel(ladder, rank)
        return !!held && levels.some((ref) => findRankLevel(ladder, ref) === held)
      }
      return levels.some((ref) => sameRankRef(ref, rank))
    })
    if (!matched) return false
  }

  // Engagement band — derived from attendance recency (last attended session,
  // falling back to join date) against the team's thresholds. Never stored.
  if (f.engagement.length > 0) {
    const refMs =
      resolveTimestampMs(subject.last_session_at) ?? resolveTimestampMs(subject.created_at)
    const band = computeEngagementBand(refMs, ctx.engagementThresholds, nowMs)
    if (!f.engagement.includes(band)) return false
  }

  if (f.age && (f.age.min != null || f.age.max != null)) {
    if (!matchesAge(subject, f.age, nowMs)) return false
  }

  for (const cond of f.customFields) {
    if (!cond.fieldId) continue
    if (!matchesCustomField(subject, cond)) return false
  }

  // Consent — "has this person accepted document X". The STATE comes from
  // `waiverAcceptanceState` and from nowhere else, so the filter and the booking
  // gate can never disagree about what a signature is worth.
  if (f.consent?.documentId && f.consent.states.length > 0) {
    const ledger = ctx.consent?.[f.consent.documentId]
    // No ledger, or a subject with no id: unanswerable. Excluded rather than
    // guessed — see ContactFilterContext.consent.
    if (!ledger || !subject.id) return false
    const state = waiverAcceptanceState(
      { min_valid_version: ledger.minValidVersion },
      ledger.signers[subject.id] ?? null,
      nowMs,
    )
    if (!f.consent.states.includes(state)) return false
  }

  const sq = f.search.trim().toLowerCase()
  if (sq) {
    const haystack = `${subject.firstname ?? ''} ${subject.lastname ?? ''}`.toLowerCase()
    if (!haystack.includes(sq) && !(subject.email ?? '').toLowerCase().includes(sq)) return false
  }

  return true
}

/** Convenience: filter a loaded list. */
export function filterContacts<T extends ContactFilterSubject>(
  contacts: T[],
  filter: Partial<ContactFilter> | null | undefined,
  ctx: ContactFilterContext = {},
): T[] {
  return contacts.filter((c) => matchesFilter(c, filter, ctx))
}

/**
 * The filter a dynamic group will ACTUALLY evaluate.
 *
 * The `groups` dimension cannot survive into a rule — a dynamic group filtering
 * on group membership can recurse (A -> B -> A), so it is stripped structurally
 * rather than merely discouraged. That makes this a LOSSY conversion: callers
 * that save a rule must save THIS, and preview from THIS, or the group will
 * quietly resolve to something wider than the list the user was looking at.
 */
export function toGroupRule(filter: Partial<ContactFilter> | null | undefined): ContactFilter {
  return { ...normalizeContactFilter(filter), groups: [] }
}

/** Would saving this filter as a dynamic rule drop a constraint? */
export function ruleWouldDropGroups(filter: Partial<ContactFilter> | null | undefined): boolean {
  return (filter?.groups?.length ?? 0) > 0
}

/** Narrowing helper so callers can pass a full `Contact` without casting. */
export type FilterableContact = Contact & ContactFilterSubject
