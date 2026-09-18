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
import { resolveActivityDropIn, type DropInPrice, type ResolvedDropIn } from './dropIn'
import { classAccessTierOf, resolveClassGate } from './paymentOptions'

/** The fields these helpers read. A public activity mirror satisfies it, so the
 *  catalogue, the pricing tab and the public pages ask the same questions. */
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
 * THE ACCESS RULE TO STORE, derived from what the studio answered.
 *
 * Every writer of a class's `accessRule` goes through this — the pricing form
 * and the plan matcher alike — so the stored `requirePlan` and `type` can never
 * disagree with what `classAccessFacts` derives while both still exist. After
 * stage 5's backfill the two projections go and this returns the pair.
 *
 * `subscriptionTypeIds` is passed in rather than read back: the caller is
 * usually mid-write (the matcher is adding or removing exactly one plan).
 */
export function classAccessRuleFor(args: {
  signupRequired: boolean
  includedPlanIds: string[]
  /** The RESOLVED door — `resolveActivityDropIn(...).enabled`. */
  paidDoor: boolean
}): ActivityAccessRule {
  const requirePlan = args.includedPlanIds.length > 0 && !args.paidDoor
  const audience = requirePlan || args.signupRequired ? 'members' : 'anyone'
  return {
    type: classAccessTierOf({ audience, requirePlan }),
    audience,
    requirePlan,
    ...(args.includedPlanIds.length ? { subscriptionTypeIds: args.includedPlanIds } : {}),
  }
}
