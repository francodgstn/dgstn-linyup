// ─── THE ACTIVITY ↔ PLAN EDGE ────────────────────────────────────────────────
//
// "Premium includes Yoga Basics" is a relationship, and it is stored on the
// ACTIVITY — the SubscriptionType document holds nothing about activities. It
// was nonetheless authored from two places (the activity form's access tier +
// benefit editor, and "Activities this subscription unlocks" on the plan side),
// each carrying its own copy of where to write.
//
// This is that write, once. BOTH directions call `activityPlanEdgeUpdate` with
// the same arguments, so "editing the edge from the plan produces the same
// document as editing it from the activity" holds BY CONSTRUCTION rather than by
// two implementations agreeing — which is the property the catalogue page exists
// to offer, and the one that quietly stopped holding before (UX-69: the plan
// side read only `accessRule`, so every appointment benefit looked unlinked, and
// an unlinked-looking tick gets wiped on the next save).
//
// ── THE EDGE HAS TWO FACETS, AND THEY ARE INDEPENDENT ────────────────────────
//
//   ACCESS — may a holder of this plan book it at all?  `accessRule`
//   RATE   — what does a holder pay?                    `memberBenefit`
//
// A class can carry BOTH: gated to Premium AND giving Premium a drop-in rate.
// Collapsing them into one "linked" boolean cannot express that, and quietly
// picks one of the two to write.
//
// An appointment has **no access facet at all** — the price is the gate — so
// `access` is meaningless there and is ignored rather than stored. That is why
// this returns a payload instead of the caller assembling fields: the difference
// between the kinds is a fact about where the edge lives, not a UI choice, and
// it belongs on this side of the boundary.
//
// ── THE RATE IS ONE RULE PER ACTIVITY, SHARED BY EVERY PLAN ON IT ────────────
//
// There is no per-pair payload: `memberBenefit` carries ONE effect for the whole
// id list (the per-pair `subscriptionPricing` matrix was deliberately cut in
// 2026-07 — see the note on `Activity`). So changing the rate "for Premium"
// changes it for every plan on that rule. This module cannot soften that; it is
// a property of the storage. What it CAN do is refuse to guess — see the
// `choice` parameter — and name who else is affected, which is what
// `plansSharingRate` is for.

import type { Activity, ActivityDurationBenefit } from '../types/activity'
import {
  resolveActivityAccessRule,
  resolveAppointmentDurations,
  resolveDurationBenefit,
} from '../types/activity'
import type { Benefit, BenefitEffect } from '../types/benefit'
import { normalizeBenefit } from '../types/benefit'
// The effect sets the RESOLVER honours — the editor offers exactly these.
import {
  APPOINTMENT_EFFECTS,
  COURSE_EFFECTS,
  DROP_IN_EFFECTS,
  canonicalClassGate,
  classAccessTierOf,
  hasModernGate,
} from './paymentOptions'

/** The fields the edge is read from and written to — narrow on purpose, so a
 *  caller can pass a form's partial state or a Firestore snapshot alike.
 *  `dropIn` / `durations` are not written by the edge: they are read to answer
 *  whether a member rate would have any price to reduce (`rateHasAPriceToApplyTo`). */
export type ActivityEdgeFields = Pick<
  Activity,
  | 'type'
  | 'accessRule'
  | 'isFreeTrial'
  | 'memberBenefit'
  | 'durationBenefits'
  | 'dropIn'
  | 'durations'
>

/**
 * WHICH RULE AN EDGE IS ABOUT — the appointment case, in one place.
 *
 * A class has ONE member rate (on its drop-in price), so every edge function
 * below takes an activity and a plan and that is the whole address. An
 * APPOINTMENT has one per session length, so the address needs a third
 * component, and `minutes` is it.
 *
 * `undefined` means "the activity-wide rule" and is what a class always passes.
 * On an appointment it is the pre-2026-09 reading, kept because two callers
 * still legitimately ask the activity-wide question: the summary line on the
 * offer pane ("# plans on the member rate") and the seeds.
 */
export type RateAddress = number | undefined

/** One (activity, plan) pair, as two independent facts. */
export interface ActivityPlanEdge {
  /** On the activity's access gate. CLASS ONLY — always false for an
   *  appointment, which has no gate. */
  access: boolean
  /** On the activity's member-rate rule. */
  rate: boolean
}

/** The rate itself, WITHOUT the id list — the ids come from the edge, never
 *  passed in, so the two cannot disagree. */
export interface ActivityRateChoice {
  effect: BenefitEffect
  /** percent_off only: 1–99. */
  percent?: number | null
  /** fixed_price only: major units (>= 0.50). */
  amount?: number | null
}

export function isAppointmentActivity(a: Pick<Activity, 'type'>): boolean {
  return a.type === 'appointment'
}

/** Plans on the activity's ACCESS gate — the ones whose holders book free.
 *  Empty for an appointment.
 *
 *  A class that has been asked the two questions (`hasModernGate`) carries its
 *  list whatever its display tier says: the resolver reads
 *  `subscriptionTypeIds` without branching on `type`, so "members only, no
 *  plan required, Premium included" is a real state and the list on it is
 *  live. Only a LEGACY rule ties the list to the `subscription` tier, because
 *  there the tier was the only thing that made the list mean anything. */
export function gatedPlanIds(a: ActivityEdgeFields): string[] {
  if (isAppointmentActivity(a)) return []
  const rule = resolveActivityAccessRule(a)
  if (hasModernGate(rule)) return rule.subscriptionTypeIds ?? []
  return rule.type === 'subscription' ? (rule.subscriptionTypeIds ?? []) : []
}

/** Plans on the activity's RATE rule, for either kind. Goes through
 *  `normalizeBenefit`, so a rule stored in the legacy appointment shape is not
 *  mistaken for no rule — reading past it is the bug that made a saved benefit
 *  look unlinked, and an unlinked-looking tick gets wiped on the next save. */
export function ratedPlanIds(
  a: Pick<Activity, 'memberBenefit' | 'durationBenefits'>,
  minutes?: RateAddress
): string[] {
  return normalizeBenefit(rateRuleAt(a, minutes))?.subscriptionTypeIds ?? []
}

/** The raw rule an address points at — the ONE place the class/appointment
 *  split is decided, so no reader below has to know about it. */
function rateRuleAt(
  a: Pick<Activity, 'memberBenefit' | 'durationBenefits'>,
  minutes: RateAddress
) {
  return minutes === undefined ? (a.memberBenefit ?? null) : resolveDurationBenefit(a, minutes)
}

/** How one plan stands against one activity right now. */
export function activityPlanEdge(
  a: ActivityEdgeFields,
  subTypeId: string,
  minutes?: RateAddress
): ActivityPlanEdge {
  return {
    access: gatedPlanIds(a).includes(subTypeId),
    rate: ratedPlanIds(a, minutes).includes(subTypeId),
  }
}

/** The rate an activity's rule carries today, or the default for a fresh one:
 *  'included' — right for a credit pack, where a booking spends a credit. */
export function activityRateChoiceOf(
  a: Pick<Activity, 'memberBenefit' | 'durationBenefits'>,
  minutes?: RateAddress
): ActivityRateChoice {
  const n = normalizeBenefit(rateRuleAt(a, minutes))
  if (!n) return { effect: 'included' }
  return {
    // `spend_credits` is a resolver effect no editor offers; show it as the
    // closest thing a studio can pick rather than dropping the rule on the floor.
    effect: n.effect === 'spend_credits' ? 'included' : n.effect,
    percent: n.percent ?? null,
    amount: n.amount ?? null,
  }
}

/** Builds the stored rule, or null to CLEAR it — an empty id list means NO rule,
 *  not an empty one. */
function buildRate(ids: string[], choice: ActivityRateChoice): Benefit | null {
  if (ids.length === 0) return null
  return {
    subscriptionTypeIds: ids,
    effect: choice.effect,
    ...(choice.effect === 'percent_off' && choice.percent != null
      ? { percent: Number(choice.percent) }
      : {}),
    ...(choice.effect === 'fixed_price' && choice.amount != null
      ? { amount: Number(choice.amount) }
      : {}),
  }
}

function sameRate(a: Benefit | null, b: Benefit | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.effect === b.effect &&
    (a.percent ?? null) === (b.percent ?? null) &&
    (a.amount ?? null) === (b.amount ?? null) &&
    a.subscriptionTypeIds.length === b.subscriptionTypeIds.length &&
    a.subscriptionTypeIds.every((id, i) => id === b.subscriptionTypeIds[i])
  )
}

/**
 * The whole per-length array after setting ONE length's rule.
 *
 * ── WHY IT SEEDS EVERY LENGTH, NOT JUST THE ONE ─────────────────────────────
 * On the FIRST per-duration write the activity still carries an activity-wide
 * `memberBenefit` that applies to all of them. Writing only the edited entry
 * would leave the others reading a field this same update is about to clear —
 * so every length the activity has is seeded with the rule that was in force
 * for it a moment ago, and only the addressed one changes. Nothing a member
 * held yesterday is lost by a studio touching one row.
 *
 * Lengths come from `fresh.durations`, plus any the stored array already names
 * (an orphan is kept rather than silently dropped — re-adding that length
 * restores its rule), plus the addressed one even when it is neither.
 */
function nextDurationBenefits(
  fresh: ActivityEdgeFields,
  minutes: number,
  rule: Benefit | null
): ActivityDurationBenefit[] {
  const lengths = new Set<number>([
    ...(fresh.durations ?? []).map((d) => d.minutes),
    ...(fresh.durationBenefits ?? []).map((d) => d.minutes),
    minutes,
  ])
  return [...lengths]
    .sort((a, b) => a - b)
    .map((m) => ({
      minutes: m,
      benefit: m === minutes ? rule : normalizeBenefit(resolveDurationBenefit(fresh, m)),
    }))
}

/**
 * The ONE edge write. Returns the Firestore update payload, or **null when
 * nothing would change** — so a caller skips the document rather than writing an
 * identical one. That is not merely a saving: an identical class write would
 * stamp `isFreeTrial: false` onto an activity nobody asked to change.
 *
 * `fresh` must be the document as READ INSIDE THE TRANSACTION, not the copy the
 * form was hydrated from: both id lists are recomputed from it, so two studios
 * ticking different plans on the same activity merge instead of clobbering.
 *
 * @param subTypeId the plan on the other end of the edge
 * @param next      what the two facets should be afterwards
 * @param choice    the rate to store. Read ONLY when `next.rate` is true — when
 *                  a plan comes OFF the rule the effect on `fresh` is kept for
 *                  whoever remains, because a draft left behind in a row whose
 *                  controls were hidden must not be written onto the others.
 */
export function activityPlanEdgeUpdate(
  fresh: ActivityEdgeFields,
  subTypeId: string,
  next: ActivityPlanEdge,
  choice?: ActivityRateChoice,
  minutes?: RateAddress
): Record<string, unknown> | null {
  const now = activityPlanEdge(fresh, subTypeId, minutes)
  const update: Record<string, unknown> = {}

  // ── the RATE facet, on both kinds ──
  const rateIds = ratedPlanIds(fresh, minutes)
  const nextRateIds = next.rate
    ? rateIds.includes(subTypeId)
      ? rateIds
      : [...rateIds, subTypeId]
    : rateIds.filter((id) => id !== subTypeId)
  const nextRate = buildRate(
    nextRateIds,
    next.rate
      ? (choice ?? activityRateChoiceOf(fresh, minutes))
      : activityRateChoiceOf(fresh, minutes)
  )
  if (minutes === undefined) {
    if (!sameRate(normalizeBenefit(fresh.memberBenefit), nextRate)) {
      update.memberBenefit = nextRate
    }
  } else if (!sameRate(normalizeBenefit(resolveDurationBenefit(fresh, minutes)), nextRate)) {
    // WRITTEN WHOLE, and it has to be: `foldOfferingPlanEdgeUpdates` shallow-
    // merges these payloads, so a per-length array can only ever be replaced,
    // never patched at an index.
    update.durationBenefits = nextDurationBenefits(fresh, minutes, nextRate)
    // The legacy activity-wide rule is ABSORBED by the write above (see
    // `nextDurationBenefits`) and cleared here, so there is ONE home going
    // forward and `resolveDurationBenefit` never has to arbitrate. Same move
    // the course gate makes with its own legacy spelling — an absorption on
    // first write rather than a backfill to deploy.
    if (fresh.memberBenefit) update.memberBenefit = null
  }

  // ── the ACCESS facet, classes only ──
  if (!isAppointmentActivity(fresh) && next.access !== now.access) {
    const gateIds = gatedPlanIds(fresh)
    const nextGateIds = next.access
      ? [...gateIds, subTypeId]
      : gateIds.filter((id) => id !== subTypeId)
    // THE TWO ANSWERS SURVIVE A PLAN EDIT. This map is written whole (see the
    // fold), and until 2026-09-10 it was rebuilt from the id list alone —
    // `{type:'subscription', ids}`, or `{type:'members'}` once the list was
    // empty — which dropped `audience` / `requirePlan`, so "members only" with
    // a drop-in price came back through `resolveClassGate`'s legacy legs as
    // OPEN TO EVERYONE the moment a plan was ticked "included". Linking a plan
    // says who books FREE; it never says who may book.
    //
    // So the pair is read through the same canonical translation the pricing
    // form opens with, carried forward, and `type` stays its projection. A
    // legacy document is upgraded to the two-field shape by this write exactly
    // as the form's first save would upgrade it — and `isFreeTrial` is kept in
    // step the way the form keeps it, for the public card's legacy reading.
    // Dropping the last plan therefore never widens the door either: a class
    // that required a plan still requires one, and the pricing page's health
    // check says so until the studio changes its mind in "Who can book".
    const gate = canonicalClassGate(
      resolveActivityAccessRule(fresh),
      !!fresh.dropIn?.enabled && typeof fresh.dropIn.priceAmount === 'number'
    )
    update.accessRule = {
      type: classAccessTierOf(gate),
      audience: gate.audience,
      requirePlan: gate.requirePlan,
      ...(nextGateIds.length ? { subscriptionTypeIds: nextGateIds } : {}),
    }
    update.isFreeTrial = gate.audience === 'anyone' && !gate.requirePlan
  }

  return Object.keys(update).length ? update : null
}

/**
 * EVERY PLAN ON ANY OF THIS ACTIVITY'S RATE RULES — the whole-activity
 * question, for summaries and counts.
 *
 * `ratedPlanIds(a)` with no length answers the ACTIVITY-WIDE field, which on an
 * appointment is the legacy one and is CLEARED the moment a per-length rule is
 * written. A summary reading it therefore went from "3 plans on the member
 * rate" to "no member rate" as a reward for using the new editor. This asks the
 * union instead, so the count means what it says on both shapes.
 */
export function anyRatedPlanIds(a: ActivityEdgeFields): string[] {
  const lengths = offeringRateLengths({ kind: 'activity', doc: a })
  if (!lengths.length) return ratedPlanIds(a)
  return [...new Set(lengths.flatMap((m) => ratedPlanIds(a, m)))]
}

/**
 * Can a `benefit_only` length actually be opened by anything? Only an INCLUDED
 * rule is a way in — a percentage off a price that does not exist opens
 * nothing, which is what the resolver's appointment arm does with it.
 *
 * ASKED PER LENGTH, because the rule is per length: a coach who includes 60 min
 * in a pack and leaves 90 min unlinked has one bookable length and one dead
 * one, and a single activity-wide answer would call both fine or both broken.
 */
export function benefitOpensDoorAt(a: ActivityEdgeFields, minutes: number): boolean {
  const choice = activityRateChoiceOf(a, minutes)
  return choice.effect === 'included' && ratedPlanIds(a, minutes).length > 0
}

/**
 * Every plan that shares an activity's rate rule, minus the one being edited.
 *
 * The catalogue needs this BEFORE a change lands, not after: the rate is one
 * rule for the whole list, so setting "20% off" from Premium reprices Basic and
 * Gold too, and a warning that names them is the only thing standing between the
 * studio and doing that unknowingly. Returns ids; the caller resolves names.
 */
export function plansSharingRate(
  a: Pick<Activity, 'memberBenefit' | 'durationBenefits'>,
  subTypeId: string,
  minutes?: RateAddress
): string[] {
  return ratedPlanIds(a, minutes).filter((id) => id !== subTypeId)
}

// ─── COURSES ─────────────────────────────────────────────────────────────────
//
// A course carries THE SAME TWO FACETS AS A CLASS, in different fields: a GATE
// (`accessRule.subscriptionTypeIds` — the plans that get it free) and a RATE
// (`benefit` — one price rule for the plans that get it cheaper). Both are live
// on both plan-bearing tiers, and they are ADDITIVE: free wins where a plan is
// on both lists.
//
//   free         neither. It is free to everyone; there is nothing to gate.
//   registered   neither. Any signed-in contact opens it.
//   subscription both, but the rate is INERT until there is a price — exactly a
//                class that sells no drop-in yet. `rateHasAPriceToApplyTo` says
//                so, and the editor dims it and explains.
//   purchase     both, both live.
//
// HISTORY, because the shape used to be the opposite of this one. Until
// 2026-09-01 the gate and the rate were mutually exclusive per tier, and the
// resolver enforced it with `if (!benefit && included)` — a benefit made the
// gate list INVISIBLE. `firestore.rules` had always ORed the two instead, so
// "Premium free, Elite 20% off" would have let Premium READ the course while
// the shop quoted them full price. The editor hid the contradiction by never
// offering both controls at once; making the resolver additive is what fixes
// it, and per-plan rates on a course are what falls out (Franco, 2026-09-01).
//
// THE LEGACY SPELLING. A `benefit` with effect `included` is the OLD way to say
// "these plans get it free", and both rule files still honour it. It is read
// here as part of the GATE, and the first edge write ABSORBS it into
// `accessRule.subscriptionTypeIds` and clears it — so there is one canonical
// home going forward and no backfill to deploy.

import type { Course, CourseAccessRule } from '../types/course'

export type CourseEdgeFields = Pick<Course, 'accessRule' | 'benefit'>

/** Which facets an offering can actually carry. The UI renders a control only
 *  where this says the field is honoured. */
export interface OfferingFacets {
  access: boolean
  rate: boolean
}

export function activityPlanFacets(
  a: Pick<Activity, 'type'> & Partial<Pick<Activity, 'accessRule' | 'isFreeTrial'>>
): OfferingFacets {
  // An appointment has no gate — the price is the gate.
  if (isAppointmentActivity(a)) return { access: false, rate: true }

  // AN OPEN CLASS HAS NEITHER, and this is the one place it can be said once.
  //
  // Read off `resolvePaymentOptions`, not assumed: its drop_in arm calls
  // `resolveClassCoverage` FIRST and an open class comes back covered, so the
  // arm returns before `applyModifiers` is ever reached. Nobody pays for an
  // open class, which makes a member rate on it a discount on nothing.
  //
  // The gate is worse than dead — it is a trap. Ticking "Included" on an open
  // class writes `{type:'subscription', subscriptionTypeIds:[…]}`, silently
  // NARROWING a class from everyone to one plan. Widening is a decision for the
  // activity's own "Who can book", not a side effect of linking a plan
  // (Franco, 2026-09-01).
  //
  // THAT IS THE LEGACY `open` TIER ONLY. A class asked the two questions may be
  // open to anyone AND sell a drop-in, and there a plan is exactly what makes
  // its holders free ("members free, visitors pay") — so both facets are live
  // whatever the display tier says. The pricing form shows the table in every
  // state for the same reason.
  const rule = resolveActivityAccessRule(a)
  return !hasModernGate(rule) && rule.type === 'open'
    ? { access: false, rate: false }
    : { access: true, rate: true }
}

export function coursePlanFacets(c: { accessRule?: CourseAccessRule | null }): OfferingFacets {
  // Both, or neither. A course no plan can open or discount is one that is
  // already open to everybody.
  const bearsPlans = c.accessRule?.type === 'subscription' || c.accessRule?.type === 'purchase'
  return { access: bearsPlans, rate: bearsPlans }
}

/**
 * The ids on a `benefit` that mean "free" rather than "cheaper" — the legacy
 * spelling of the gate. `spend_credits` is here because the resolver treats it
 * as coverage too, and no course editor has ever offered it.
 */
function legacyIncludedIds(c: Pick<Course, 'benefit'>): string[] {
  const n = normalizeBenefit(c.benefit)
  if (!n) return []
  return n.effect === 'included' || n.effect === 'spend_credits' ? n.subscriptionTypeIds : []
}

/** Plans that get a course FREE — the gate, plus its legacy spelling. */
export function courseGatedPlanIds(c: CourseEdgeFields): string[] {
  if (!coursePlanFacets(c).access) return []
  const gate = c.accessRule?.subscriptionTypeIds ?? []
  const legacy = legacyIncludedIds(c)
  return legacy.length ? [...new Set([...gate, ...legacy])] : gate
}

/** Plans that get a course CHEAPER. A benefit meaning "free" is the gate, so it
 *  is deliberately not counted here — it would otherwise show as both. */
export function courseRatedPlanIds(c: Pick<Course, 'benefit'>): string[] {
  const n = normalizeBenefit(c.benefit)
  if (!n || n.effect === 'included' || n.effect === 'spend_credits') return []
  return n.subscriptionTypeIds
}

export function coursePlanEdge(c: CourseEdgeFields, subTypeId: string): ActivityPlanEdge {
  return {
    access: courseGatedPlanIds(c).includes(subTypeId),
    rate: courseRatedPlanIds(c).includes(subTypeId),
  }
}

/** The price rule a course carries today, or the default for a fresh one.
 *  `percent_off`, NOT the `included` an activity defaults to: on a course
 *  "included" is the GATE column, and offering it in both places is what the
 *  two overlapping tiers used to do. */
export function courseRateChoiceOf(c: Pick<Course, 'benefit'>): ActivityRateChoice {
  const n = normalizeBenefit(c.benefit)
  if (!n || n.effect === 'included' || n.effect === 'spend_credits') {
    return { effect: 'percent_off' }
  }
  return { effect: n.effect, percent: n.percent ?? null, amount: n.amount ?? null }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * The course half of the ONE edge write. Same contract as
 * `activityPlanEdgeUpdate`: the fresh document read INSIDE the transaction, and
 * null when nothing would change.
 *
 * Both facets are computed every time — a course, unlike an appointment, has no
 * tier where one of them is unwritable, so the caller can always have offered
 * both controls. A tier that bears no plans at all writes nothing.
 */
export function coursePlanEdgeUpdate(
  fresh: CourseEdgeFields,
  subTypeId: string,
  next: ActivityPlanEdge,
  choice?: ActivityRateChoice
): Record<string, unknown> | null {
  if (!coursePlanFacets(fresh).access) return null
  const update: Record<string, unknown> = {}

  const gateIds = courseGatedPlanIds(fresh)
  const rateIds = courseRatedPlanIds(fresh)

  const nextGateIds = next.access
    ? gateIds.includes(subTypeId)
      ? gateIds
      : [...gateIds, subTypeId]
    : gateIds.filter((id) => id !== subTypeId)
  const nextRateIds = next.rate
    ? rateIds.includes(subTypeId)
      ? rateIds
      : [...rateIds, subTypeId]
    : rateIds.filter((id) => id !== subTypeId)

  const nextRate = buildRate(
    nextRateIds,
    next.rate ? (choice ?? courseRateChoiceOf(fresh)) : courseRateChoiceOf(fresh)
  )
  // A legacy `included` benefit has just been read as part of the GATE, so
  // leaving it in place would count its plans twice. Writing the (price-only)
  // rate here clears it — the absorption, and the only migration there is.
  const legacyAbsorbed = legacyIncludedIds(fresh).length > 0
  if (legacyAbsorbed || !sameRate(normalizeBenefit(fresh.benefit), nextRate)) {
    update.benefit = nextRate
  }

  // Compared against what is STORED, not against the union read above, so that
  // absorbing the legacy list registers as a change and gets written.
  if (!sameIds(nextGateIds, fresh.accessRule?.subscriptionTypeIds ?? [])) {
    // The tier is NOT changed here. Emptying a course's gate leaves the tier as
    // it was with nobody on it, which the pricing health check reports — the
    // same shape as a class with an empty allow-list. Silently demoting it to
    // 'registered' would hand a paid course to every signed-in contact, which is
    // not what removing one plan asked for.
    update.accessRule = { ...fresh.accessRule, subscriptionTypeIds: nextGateIds }
  }

  return Object.keys(update).length ? update : null
}

/** Every plan that shares a course's rate rule, minus the one being edited. */
export function plansSharingCourseRate(c: Pick<Course, 'benefit'>, subTypeId: string): string[] {
  return courseRatedPlanIds(c).filter((id) => id !== subTypeId)
}

// ─── ONE ENTRY POINT FOR BOTH KINDS ──────────────────────────────────────────
//
// The catalogue lists activities and courses side by side, and every row does
// the same thing to a different document. Dispatching here rather than in the
// component keeps that decision on the tested side of the boundary — and means
// a third kind is added in this file, not in a `switch` inside some JSX.
//
// PRODUCTS AND GIFT CARDS ARE NOT MEMBERS, and not by oversight. A plan can only
// open or discount something that has a gate or a benefit to write to. `Product`
// has neither (`resolvePaymentOptions`' product arm threads `benefit` purely for
// uniformity and documents it as "ALWAYS null today"), and a gift card is a
// TENDER — it pays for things, so there is nothing for a plan to unlock. A row
// for either would show controls that write nowhere.

export type PlanLinkTarget =
  | {
      kind: 'activity'
      doc: ActivityEdgeFields
      /** APPOINTMENT-ONLY: WHICH SESSION LENGTH this target addresses. An
       *  appointment carries one member rule per length, so a target without
       *  it addresses the whole activity — which is the legacy reading, and
       *  correct only for a class. Every editor row on an appointment sets it;
       *  see `RateAddress`. */
      minutes?: number
    }
  | { kind: 'course'; doc: CourseEdgeFields }

export function offeringFacets(t: PlanLinkTarget): OfferingFacets {
  return t.kind === 'activity' ? activityPlanFacets(t.doc) : coursePlanFacets(t.doc)
}

export function offeringPlanEdge(t: PlanLinkTarget, subTypeId: string): ActivityPlanEdge {
  return t.kind === 'activity'
    ? activityPlanEdge(t.doc, subTypeId, t.minutes)
    : coursePlanEdge(t.doc, subTypeId)
}

export function offeringRateChoiceOf(t: PlanLinkTarget): ActivityRateChoice {
  return t.kind === 'activity'
    ? activityRateChoiceOf(t.doc, t.minutes)
    : courseRateChoiceOf(t.doc)
}

/**
 * The rate effects an editor may OFFER for this offering — derived from the very
 * sets `resolvePaymentOptions` honours, so the two cannot drift.
 *
 * THE CASE THIS EXISTS FOR: a CLASS. Its rate rule is applied to the DROP-IN
 * price and price-modifying effects are the only ones the resolver reads there,
 * because being covered is what the ACCESS facet already says. An editor with
 * its own list offered `included` anyway, which made the two controls on a class
 * row look like two ways to say "free" — and the second one silently did
 * nothing. An appointment is the mirror image: it has no access facet at all
 * (the price is the gate), so `included` there is the ONLY way to say a holder
 * books free, and it must stay on offer.
 *
 * `spend_credits` is filtered out for every kind: the resolver honours it on an
 * appointment, but no editor writes it and the UI story for it does not exist
 * yet (see BenefitEditor's module doc). Offering it here would ship a control
 * ahead of the feature.
 */
/**
 * Is there a price here for a member RATE to reduce?
 *
 * A rate is a discount on something, and on two of the three kinds that
 * something can simply be absent:
 *
 *   • a CLASS discounts its DROP-IN price — a members-only class that sells no
 *     drop-in has no other price, so "20% off" reduces nothing;
 *   • an APPOINTMENT discounts THE PRICED LENGTH the row is about — a length
 *     with no price is already free to everyone, whatever the others cost;
 *   • a PURCHASE-tier course always has a price; that is what the tier means.
 *
 * `included` is exempt and never asks this: making something free does not need
 * a price to start from. This answers only for the price-modifying effects, and
 * the editor uses it to MUTE them rather than to hide them — the studio should
 * see that the option exists and why it cannot bite yet.
 */
export function rateHasAPriceToApplyTo(t: PlanLinkTarget): boolean {
  // A course's price IS its sale, so an unsold course has nothing to reduce —
  // the same inert-until-priced state a class with no drop-in is in, and shown
  // the same way (dimmed, with a reason) rather than withheld.
  if (t.kind === 'course') {
    const r = t.doc.accessRule
    return r?.type === 'purchase' && typeof r.priceAmount === 'number' && r.priceAmount > 0
  }
  if (isAppointmentActivity(t.doc)) {
    // ASKED OF THE ADDRESSED LENGTH when there is one. A rule about 90 minutes
    // is not made applicable by the 30-minute row carrying a price, and dimming
    // is the only signal the studio gets that a rate would do nothing.
    const priced = (m: number) =>
      (t.doc.durations ?? []).some((d) => d.minutes === m && (d.priceAmount ?? 0) > 0)
    return t.minutes === undefined
      ? (t.doc.durations ?? []).some((d) => (d.priceAmount ?? 0) > 0)
      : priced(t.minutes)
  }
  const dropIn = t.doc.dropIn
  return !!dropIn?.enabled && (dropIn.priceAmount ?? 0) > 0
}

export type OfferableRateEffect = 'included' | 'percent_off' | 'fixed_price'

export function offeringRateEffects(t: PlanLinkTarget): OfferableRateEffect[] {
  const allowed =
    t.kind === 'course'
      ? COURSE_EFFECTS
      : isAppointmentActivity(t.doc as Pick<Activity, 'type'>)
        ? APPOINTMENT_EFFECTS
        : DROP_IN_EFFECTS
  // A fixed order, so the chips do not reshuffle between offerings.
  return (['included', 'percent_off', 'fixed_price'] as const).filter((e) => allowed.has(e))
}

/**
 * THE SESSION LENGTHS AN EDITOR MUST ASK ABOUT SEPARATELY — empty for anything
 * that carries one rule for the whole offering (a class, a course), and the
 * appointment's duration menu otherwise.
 *
 * Derived from `resolveAppointmentDurations`, so an appointment with no lengths
 * set yet asks about the same single fallback length everything else assumes,
 * rather than showing no table at all.
 */
export function offeringRateLengths(t: PlanLinkTarget): number[] {
  if (t.kind !== 'activity' || !isAppointmentActivity(t.doc)) return []
  return resolveAppointmentDurations(t.doc).map((d) => d.minutes)
}

export function plansSharingOfferingRate(t: PlanLinkTarget, subTypeId: string): string[] {
  return t.kind === 'activity'
    ? plansSharingRate(t.doc, subTypeId, t.minutes)
    : plansSharingCourseRate(t.doc, subTypeId)
}

/**
 * MANY EDGES, ONE DOCUMENT, ONE UPDATE.
 *
 * THE BUG THIS EXISTS FOR. In the `from-offering` direction every row is a
 * different PLAN but the SAME offering document, so ticking several rows and
 * saving produced several `offeringPlanEdgeUpdate` calls against one ref —
 * each computed from the same pre-transaction snapshot, each overwriting the
 * last. Only the bottom-most edited row survived, silently (Franco,
 * 2026-09-02). "Set all" was the fastest way to hit it.
 *
 * Folding is the fix, not batching: the second edit has to see the first, or
 * two plans added to one allow-list produce two lists of one. Each update is
 * applied to a running copy of the document and the accumulated payload is
 * written once.
 *
 * Shallow merge is correct here because every key these updates produce is
 * written WHOLE — `accessRule` is rebuilt by spread, `benefit`/`memberBenefit`/
 * `durationBenefits` are replaced or nulled. Nothing is a partial map.
 *
 * ── AND WHY AN EDIT CARRIES ITS OWN `minutes` ───────────────────────────────
 * An appointment now shows one plan table PER SESSION LENGTH, so a save can
 * hold edits addressed at different lengths — of the SAME document, whose
 * `durationBenefits` array they all rewrite whole. Folding per target would put
 * the original bug straight back, one fold per length, each blind to the last.
 * So the address travels with the edit and the target's own `minutes` is only
 * the default.
 */
export function foldOfferingPlanEdgeUpdates(
  target: PlanLinkTarget,
  edits: {
    subTypeId: string
    next: ActivityPlanEdge
    choice?: ActivityRateChoice
    /** APPOINTMENT-ONLY: which session length this edit is about. */
    minutes?: number
  }[]
): Record<string, unknown> | null {
  let doc = target.doc as Record<string, unknown>
  const acc: Record<string, unknown> = {}
  for (const e of edits) {
    const update = offeringPlanEdgeUpdate(
      {
        kind: target.kind,
        doc,
        ...(target.kind === 'activity'
          ? { minutes: e.minutes ?? target.minutes }
          : {}),
      } as PlanLinkTarget,
      e.subTypeId,
      e.next,
      e.choice
    )
    if (!update) continue
    Object.assign(acc, update)
    doc = { ...doc, ...update }
  }
  return Object.keys(acc).length ? acc : null
}

export function offeringPlanEdgeUpdate(
  t: PlanLinkTarget,
  subTypeId: string,
  next: ActivityPlanEdge,
  choice?: ActivityRateChoice
): Record<string, unknown> | null {
  return t.kind === 'activity'
    ? activityPlanEdgeUpdate(t.doc, subTypeId, next, choice, t.minutes)
    : coursePlanEdgeUpdate(t.doc, subTypeId, next, choice)
}
