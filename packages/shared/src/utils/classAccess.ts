// WHO MAY BOOK A CLASS — DERIVED FROM ITS PRICES, NEVER ASKED.
//
// The studio answers three things about a class: which plans INCLUDE it, what
// it costs at the door (`dropIn`), and whether newcomers get a trial. Who may
// book falls out of those answers, so no form asks it:
//
//   drop-in price   a plan includes it   someone with no covering plan…
//   ─────────────   ──────────────────   ─────────────────────────────────────
//   yes             —                    pays the drop-in (anyone, no sign-up)
//   no              yes                  cannot book — plan holders only
//   no              no                   books free
//
// ONLY AN "INCLUDED" PLAN DECIDES ACCESS. A plan that merely earns a MEMBER
// PRICE (percent off, fixed price) changes what its holders pay and never who
// may book — which is why a class with a drop-in price and a discounting plan
// stays open to everyone, and why a member price has nothing to bite on once
// the drop-in is off. The included list is `gatedPlanIds`; the rate list is
// `ratedPlanIds`, and they are read for different questions.
//
// The ONE thing still stored and asked is the club case: `audience: 'members'`
// — only people who signed up with the studio may book, even paying. It is a
// switch under "More options", off by default.
//
// `requirePlan` is therefore no longer a studio's answer but a CONSEQUENCE, and
// this is not a new engine: the legacy `subscription` tier already meant exactly
// "a plan is required unless there is a price a non-holder can pay"
// (`resolveClassGate`). What changes is that every class is read that way.
//
// TRANSITION (docs/class-access-derived.md): stage 1 is this module and its
// fixtures; the deciders switch in stage 2, the form in stage 3, and the stored
// `requirePlan` / `type` / `isFreeTrial` fields go in stage 5's backfill. Until
// then writers keep `requirePlan` in step with what this derives
// (`classAccessRuleFor`), so nothing reads one answer while something else
// stores another.

import {
  resolveActivityAccessRule,
  type Activity,
  type ActivityAccessRule,
} from '../types/activity'
import { gatedPlanIds, isAppointmentActivity, type ActivityEdgeFields } from './activityPlanLink'
import { dropInModeOf, resolveActivityDropIn, type DropInPrice, type ResolvedDropIn } from './dropIn'
import { classDoorIsInert, classIsFreeForEveryone, resolveClassGate } from './paymentOptions'

/** The fields these helpers read. A public activity mirror satisfies it, so the
 *  catalog, the pricing tab and the public pages ask the same questions. */
export type ClassAccessInput = Pick<Activity, 'type'> &
  Partial<Pick<Activity, 'accessRule' | 'isFreeTrial' | 'trialEnabled'>> & {
    /** Nullable, like every other reader of it: a document that carries no
     *  drop-in field and one that carries an explicit null mean the same. */
    dropIn?: Activity['dropIn'] | null
  }

export interface ClassAccessFacts {
  /** The door, through THE ONE READER — the studio default applied. */
  dropIn: ResolvedDropIn
  /** Plans that include this class: the only plans that decide who may book. */
  includedPlanIds: string[]
  /** Only people who signed up with the studio may book (the club case). */
  signupRequired: boolean
  /** No door to pay at, so only a holder of an included plan gets in. */
  planHoldersOnly: boolean
  /** Free for everyone it admits — no door, no plan to hold. */
  free: boolean
  /** May this class offer a newcomer trial? Anything a newcomer cannot already
   *  do — so every class EXCEPT one that is free to anyone, where the door
   *  grants nothing and would only burn a guest's once-per-person trial (and
   *  deadlock a mispriced trial against a free booking). A class that is free
   *  but walled to people who signed up DOES need it: that is the newcomer's
   *  one way in. */
  trialAvailable: boolean
}

const APPOINTMENT_FACTS: ClassAccessFacts = {
  dropIn: { enabled: false, source: 'off' },
  includedPlanIds: [],
  signupRequired: false,
  planHoldersOnly: false,
  free: false,
  trialAvailable: false,
}

/**
 * Everything a surface needs to say who may book this class and what it costs
 * them — asked once, from the class and the studio's default drop-in price.
 *
 * APPOINTMENTS ARE NOT CLASSES: they carry no access rule at all (the price is
 * the gate), so they answer nothing here rather than answering "free".
 */
export function classAccessFacts(
  activity: ClassAccessInput,
  studioDropIn: DropInPrice | null | undefined
): ClassAccessFacts {
  if (isAppointmentActivity(activity)) return APPOINTMENT_FACTS
  const dropIn = resolveActivityDropIn(activity, studioDropIn)
  // The access facet reads the rule and nothing else — handed exactly that, so
  // a caller may pass a mirror, a form draft or a Firestore document alike.
  const includedPlanIds = gatedPlanIds({
    type: activity.type,
    accessRule: activity.accessRule,
    isFreeTrial: activity.isFreeTrial,
  } as ActivityEdgeFields)
  const rule = resolveActivityAccessRule(activity)
  const free = !dropIn.enabled && includedPlanIds.length === 0
  // Read through the gate so a legacy `members` tier keeps its wall and a
  // legacy `subscription` one keeps letting a payer in.
  const signupRequired = resolveClassGate(rule, dropIn.enabled).audience === 'members'
  return {
    dropIn,
    includedPlanIds,
    signupRequired,
    planHoldersOnly: includedPlanIds.length > 0 && !dropIn.enabled,
    free,
    trialAvailable: !free || signupRequired,
  }
}

/** Two words for a list: what this class is, before anybody opens it. */
export type ClassAccessChip =
  | 'free_anyone'
  | 'free_members'
  | 'plan_holders'
  | 'paid_anyone'
  | 'paid_members'

export function classAccessChip(facts: ClassAccessFacts): ClassAccessChip {
  if (facts.planHoldersOnly) return 'plan_holders'
  if (facts.free) return facts.signupRequired ? 'free_members' : 'free_anyone'
  return facts.signupRequired ? 'paid_members' : 'paid_anyone'
}

/**
 * THE ACCESS RULE TO STORE: the sign-up wall and the plans that include the
 * class. Nothing else — "plan required" is derived from these and the door by
 * `resolveClassGate` on every read, so there is no second answer to keep in
 * step (docs/class-access-derived.md, stage 5). Every writer of a class's
 * `accessRule` goes through this: the pricing form, the plan matcher, the AI
 * drafter, the review studio, the seeds.
 *
 * `includedPlanIds` is passed in rather than read back: the caller is usually
 * mid-write (the matcher is adding or removing exactly one plan).
 */
export function classAccessRuleFor(args: {
  signupRequired: boolean
  includedPlanIds: string[]
}): ActivityAccessRule {
  return {
    audience: args.signupRequired ? 'members' : 'anyone',
    ...(args.includedPlanIds.length ? { subscriptionTypeIds: args.includedPlanIds } : {}),
  }
}

// ─── THE MIGRATION, AS ONE PURE MAPPING ─────────────────────────────────────
//
// Stage 5 (docs/class-access-derived.md) rewrites every class into the derived
// shape: `accessRule` holds only the sign-up wall and the included plans,
// `dropIn` names its `mode`. This is the mapping, written once so the backfill
// script and its fixtures read the same thing. It PRESERVES WHO MAY BOOK for
// every class whose old answer the derived rule can express, and says which of
// the rewrites it had to make when the old answer could not survive as stored:
//
//   legacy_open_door_closed   a legacy `open` class carrying a stray drop-in
//                             price — it was free to everyone and the price never
//                             fired, so the door is stated as off.
//   legacy_members_door_closed the same for a legacy `members` class: every
//                             member was covered first, so the price never fired.
//   plan_required_door_closed "plan required" AND a drop-in price — the price
//                             only ever served a plan holder earning a member
//                             rate, and under the derived rule a price opens the
//                             class to anyone who pays. Kept plan-holders-only by
//                             closing the door (members lose that member rate).
//   inert_plans_cleared       plans listed on a class that required none and
//                             sold nothing at the door — free anyway, so the
//                             plans did nothing; derived, they would make it
//                             plan-holders-only. Cleared to keep it free.
//   dead_end_reopened         "plan required" with NO plan named — nobody could
//                             book it (the Pricing page's error). The derived
//                             rule cannot say "nobody", so it becomes whatever
//                             its door says (paid, or free). Reported so the
//                             studio's dead end is not silently widened unseen.
//
// THE WALL IS KEPT (Franco, 2026-09-18): a class stored as members-only keeps
// `audience: 'members'` even where a required plan made it moot, so nobody
// gains access if a price is added later. A legacy `subscription` class never
// had a wall — its paid door was open to anyone — and gets none.

export type ClassAccessMigrationNote =
  | 'legacy_open_door_closed'
  | 'legacy_members_door_closed'
  | 'plan_required_door_closed'
  | 'inert_plans_cleared'
  | 'dead_end_reopened'

export interface MigratedClassAccess {
  accessRule: { audience: 'anyone' | 'members'; subscriptionTypeIds?: string[] }
  dropIn: { mode: 'studio' | 'custom' | 'off'; priceAmount?: number }
  notes: ClassAccessMigrationNote[]
}

export function migrateClassAccess(
  activity: ClassAccessInput,
  studioDropIn: DropInPrice | null | undefined
): MigratedClassAccess {
  const rule = resolveActivityAccessRule(activity)
  const notes: ClassAccessMigrationNote[] = []
  const storedMode = dropInModeOf(activity.dropIn)
  const ownPrice =
    storedMode === 'custom' && typeof activity.dropIn?.priceAmount === 'number'
      ? activity.dropIn.priceAmount
      : undefined
  const stated = (mode: 'studio' | 'custom' | 'off') =>
    mode === 'custom' && ownPrice !== undefined ? { mode, priceAmount: ownPrice } : { mode }

  // A legacy OPEN class: free to everyone, whatever else the document says.
  if (classIsFreeForEveryone(rule)) {
    const doorWasPriced = storedMode === 'custom' || (storedMode === 'studio' && !!studioDropIn?.enabled)
    if (doorWasPriced) notes.push('legacy_open_door_closed')
    return { accessRule: { audience: 'anyone' }, dropIn: { mode: 'off' }, notes }
  }

  // A legacy MEMBERS class covered every member before looking at a price, and
  // walled everyone else — the price never fired. Stated as off, so it stays
  // free for members when a usual price is set later.
  if (classDoorIsInert(rule)) {
    const doorWasPriced = storedMode === 'custom' || (storedMode === 'studio' && !!studioDropIn?.enabled)
    if (doorWasPriced) notes.push('legacy_members_door_closed')
    return { accessRule: { audience: 'members' }, dropIn: { mode: 'off' }, notes }
  }

  const door = resolveActivityDropIn(activity, studioDropIn).enabled
  let ids = gatedPlanIds({
    type: activity.type,
    accessRule: activity.accessRule,
    isFreeTrial: activity.isFreeTrial,
  } as ActivityEdgeFields)
  // The CURRENT answer, as the resolver that wrote this document read it: a
  // stored `requirePlan` won (the two-question form wrote one); a document
  // ALREADY in the derived shape carries none and means "plans and no door";
  // a legacy `subscription` tier meant "no door". Reading a derived-shape
  // document's missing `requirePlan` as false would clear the plans of every
  // plan-holders-only class the new form saves — the backfill must be a no-op
  // on its own output.
  const gate = {
    audience: resolveClassGate(rule, door).audience,
    requirePlan:
      rule.requirePlan ??
      (rule.audience !== undefined
        ? ids.length > 0 && !door
        : rule.type === 'subscription'
          ? !door
          : false),
  }
  let mode: 'studio' | 'custom' | 'off' = storedMode

  if (gate.requirePlan && ids.length === 0) {
    notes.push('dead_end_reopened')
  } else if (gate.requirePlan && door) {
    notes.push('plan_required_door_closed')
    mode = 'off'
  } else if (!gate.requirePlan && !door && ids.length > 0) {
    notes.push('inert_plans_cleared')
    ids = []
  }

  return {
    accessRule: {
      audience: gate.audience,
      ...(ids.length ? { subscriptionTypeIds: ids } : {}),
    },
    dropIn: stated(mode),
    notes,
  }
}

/**
 * A WHOLE ACTIVITY DOCUMENT, READY TO WRITE in the derived shape — for the
 * writers that author a document in one go (the seeders, the HMD migration, the
 * backfill). A class gets `migrateClassAccess`'s answer; an appointment carries
 * no access rule and no drop-in at all (the price is its gate). Either way the
 * legacy `isFreeTrial` flag goes, and nothing the derived rule would read back
 * differently is kept.
 */
export function activityDocForWrite<T extends ClassAccessInput>(
  doc: T,
  studioDropIn: DropInPrice | null | undefined
): Omit<T, 'isFreeTrial' | 'accessRule' | 'dropIn'> & {
  accessRule?: MigratedClassAccess['accessRule']
  dropIn?: MigratedClassAccess['dropIn']
} {
  const { isFreeTrial: _legacy, accessRule: _rule, dropIn: _door, ...rest } = doc
  void _legacy
  void _rule
  void _door
  if (isAppointmentActivity(doc)) return rest
  const m = migrateClassAccess(doc, studioDropIn)
  return { ...rest, accessRule: m.accessRule, dropIn: m.dropIn }
}
