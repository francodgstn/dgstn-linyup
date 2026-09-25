// ─── THE OFFERING WRITER: one set of documents, two ways in ──────────────────
//
// The setup wizard (`applyOfferingSetup`) and the AI draft
// (`applyOfferingDraft`) both create classes, appointments and plans. They take
// different inputs on purpose (see packages/shared/src/types/offeringSetup.ts),
// and they build the documents HERE, so a class created either way is the same
// document (Franco, 2026-09-26). A field added to a new class is added in one
// place, and neither path can drift into a shape the other no longer writes:
// that is how the AI applier came to be storing the drop-in as
// `{ enabled, priceAmount }` after the forms had moved to `mode`.
//
// Pure builders: no reads, no writes. The callers own the gate, the order read
// and the batch or transaction.
//
// What a NEW class looks like follows the forms: ActivityDialog's create seeds
// the money fields and ActivityPricingForm is the shape they are edited in. The
// plan-link facets (which plans include it, who pays a member rate) are written
// through `activityPlanEdgeUpdate`, THE edge writer, never assembled here.

import { FieldValue } from 'firebase-admin/firestore'
import {
  activityPlanEdgeUpdate,
  classAccessFacts,
  classAccessRuleFor,
  courseBlockPlanEdgeUpdate,
  type ActivityDuration,
  type ActivityEdgeFields,
  type ActivityRateChoice,
  type CourseBlockEdgeFields,
  type DropInPrice,
  type RecurrencePattern,
  type SetupAppointment,
  type SetupClass,
  type SetupCourse,
  type SetupPlan,
  type SubscriptionPrice,
  type SubscriptionUsageLimit,
} from '@linyup/shared'
import type { CourseBlockWrite, NewCourseBlockLinks } from '../courseBlocks'
import type { CourseScheduleInput } from '../courseBlocks/schedule'

/** Who created it, where it sorts, and which way in it came. */
export interface OfferingStamp {
  teamId: string
  uid: string
  order: number
  createdVia: 'wizard' | 'ai-draft'
}

/** A URL-safe slug from a name, accents folded ("Café Yoga" → "cafe-yoga"). */
export function offeringSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function stampFields(stamp: OfferingStamp) {
  return {
    teamId: stamp.teamId,
    createdBy: stamp.uid,
    isActive: true,
    order: stamp.order,
    created_at: FieldValue.serverTimestamp(),
    created_via: stamp.createdVia,
  }
}

/** Presentation the AI draft may carry and the wizard does not ask for. */
export interface OfferingExtras {
  color?: string
  tags?: string[]
}

/**
 * A NEW CLASS. Who may book is derived from the plans that include it and the
 * drop-in it sells (docs/class-access-derived.md); the trial only where that
 * door grants something (`trialAvailable`, the pricing form's own rule); and a
 * member rate only where there is a drop-in price for it to lower, written
 * through the edge writer.
 */
export function newClassDocument(
  cls: SetupClass,
  stamp: OfferingStamp,
  studioDropIn: DropInPrice | null,
  extras: OfferingExtras = {}
): Record<string, unknown> {
  let doc: Record<string, unknown> = {
    name: cls.name,
    slug: offeringSlug(cls.name),
    description: cls.description ?? '',
    type: 'class',
    ...(extras.color ? { color: extras.color } : {}),
    ...(extras.tags?.length ? { tags: extras.tags } : {}),
    accessRule: classAccessRuleFor({
      signupRequired: cls.signupRequired,
      includedPlanIds: cls.includedPlanIds,
    }),
    dropIn: cls.dropIn.mode === 'custom' ? { mode: 'custom', priceAmount: cls.dropIn.priceAmount } : { mode: cls.dropIn.mode },
    trialEnabled: false,
    trialPriceAmount: null,
    memberBenefit: null,
    durations: null,
    waitlistEnabled: false,
    ...stampFields(stamp),
  }

  const facts = classAccessFacts(doc as unknown as ActivityEdgeFields, studioDropIn)
  if (cls.trial && facts.trialAvailable) {
    doc.trialEnabled = true
    doc.trialPriceAmount = cls.trial.priceAmount ?? null
  }
  if (cls.memberRate && facts.dropIn.enabled) {
    const { effect, percent, amount } = cls.memberRate
    for (const planId of cls.memberRate.planIds) {
      const update = activityPlanEdgeUpdate(
        doc as unknown as ActivityEdgeFields,
        planId,
        // The access facet is left exactly as it is: this adds the RATE.
        { access: cls.includedPlanIds.includes(planId), rate: true },
        { effect, percent: percent ?? null, amount: amount ?? null },
        undefined,
        studioDropIn
      )
      if (update) doc = { ...doc, ...update }
    }
  }
  return doc
}

/** A NEW APPOINTMENT: its lengths and their prices. No access rule, no drop-in:
 *  the price is the gate. */
export function newAppointmentDocument(
  appt: { name: string; description?: string; durations: ActivityDuration[] },
  stamp: OfferingStamp,
  extras: OfferingExtras = {}
): Record<string, unknown> {
  return {
    name: appt.name,
    slug: offeringSlug(appt.name),
    description: appt.description ?? '',
    type: 'appointment',
    ...(extras.color ? { color: extras.color } : {}),
    ...(extras.tags?.length ? { tags: extras.tags } : {}),
    ...(appt.durations.length ? { durations: appt.durations } : {}),
    ...stampFields(stamp),
  }
}

/**
 * A NEW APPOINTMENT from the wizard: its lengths and how each is sold, then the
 * member deal written as EACH LENGTH'S rule through the edge writer (the rule
 * is per length, `resolveDurationBenefit`). The one answer lands only where it
 * means something:
 *
 *   included      a priced or plan-only length (a free one is free already)
 *   percent_off   a priced length (there is no price elsewhere to take it off)
 *   fixed_price   a priced length, at that length's own member price
 */
export function setupAppointmentDocument(appt: SetupAppointment, stamp: OfferingStamp): Record<string, unknown> {
  const durations: ActivityDuration[] = appt.lengths.map((l) =>
    l.sale === 'priced'
      ? { minutes: l.minutes, priceAmount: l.priceAmount ?? null }
      : l.sale === 'plan_only'
        ? { minutes: l.minutes, priceAmount: null, benefitOnly: true }
        : { minutes: l.minutes, priceAmount: null }
  )
  let doc = newAppointmentDocument({ name: appt.name, description: appt.description, durations }, stamp)
  const deal = appt.memberDeal
  if (!deal) return doc
  for (const l of appt.lengths) {
    const applies = deal.effect === 'included' ? l.sale !== 'free' : l.sale === 'priced'
    if (!applies) continue
    const choice =
      deal.effect === 'percent_off'
        ? { effect: deal.effect, percent: deal.percent ?? null }
        : deal.effect === 'fixed_price'
          ? { effect: deal.effect, amount: l.memberAmount ?? null }
          : { effect: deal.effect }
    for (const planId of deal.planIds) {
      const update = activityPlanEdgeUpdate(
        doc as unknown as ActivityEdgeFields,
        planId,
        { access: false, rate: true },
        choice,
        l.minutes
      )
      if (update) doc = { ...doc, ...update }
    }
  }
  return doc
}

/** The plan links a wizard course is born with, built through the course's own
 *  edge writer from an empty edge, the way the Offerings pane would add them one
 *  by one. A free course gets none (`courseBlockPlanFacets`). */
export function setupCourseLinks(course: SetupCourse): NewCourseBlockLinks {
  let edge: CourseBlockEdgeFields = {
    includedSubscriptionTypeIds: [],
    benefit: null,
    priceAmount: course.priceAmount ?? null,
  }
  const apply = (planId: string, next: { access: boolean; rate: boolean }, choice?: ActivityRateChoice) => {
    const update = courseBlockPlanEdgeUpdate(edge, planId, next, choice)
    if (update) edge = { ...edge, ...update } as CourseBlockEdgeFields
  }
  for (const planId of course.includedPlanIds) apply(planId, { access: true, rate: false })
  const rate = course.memberRate
  if (rate) {
    for (const planId of rate.planIds) {
      // Free wins where a plan is on both: it stays on the gate.
      if (course.includedPlanIds.includes(planId)) continue
      apply(
        planId,
        { access: false, rate: true },
        { effect: rate.effect, percent: rate.percent ?? null, amount: rate.amount ?? null }
      )
    }
  }
  return { includedSubscriptionTypeIds: edge.includedSubscriptionTypeIds ?? [], benefit: edge.benefit ?? null }
}

/** The wizard's course answers as what the course creator reads. A weekly
 *  course is the same rule `CourseBlockDialog` sends: weekly, ending on a date,
 *  with its skip days. */
export function setupCourseWrite(course: SetupCourse): CourseBlockWrite {
  const sc = course.schedule
  const schedule: CourseScheduleInput =
    sc.kind === 'weekly'
      ? {
          kind: 'repeating',
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            daysOfWeek: [sc.weekday],
            duration: sc.minutes,
            startDate: sc.startMs,
            endCondition: 'date',
            endDate: sc.endMs,
            excludeDates: sc.skipMs,
          } as unknown as RecurrencePattern,
        }
      : { kind: 'dates', meetings: sc.meetings.map((m) => ({ startMs: m.startMs, durationMinutes: m.minutes })) }
  return {
    name: course.name,
    description: course.description ?? '',
    places: course.places ?? null,
    priceAmount: course.priceAmount ?? null,
    audience: course.signupRequired ? 'members' : 'anyone',
    closeDaysBefore: course.closeDaysBefore ?? null,
    schedule,
  }
}

/** A plan's body before its prices get ids. */
export interface PlanFields {
  name: string
  description?: string
  source: 'internal' | 'aggregator'
  public: boolean
  prices: Omit<SubscriptionPrice, 'id'>[]
  limits?: SubscriptionUsageLimit[]
  /** An intro price on the price at this index. */
  intro?: { priceIndex: number; amount: number; periods: number }
  payoutPerVisit?: number
}

/** A NEW PLAN, from fields either way in has already decided. */
export function planDocument(
  fields: PlanFields,
  stamp: OfferingStamp,
  newPriceId: (index: number) => string
): Record<string, unknown> {
  const prices = fields.prices.map((p, i) => ({ ...p, id: newPriceId(i), active: true }))
  const introPrice = fields.intro ? prices[fields.intro.priceIndex] : undefined
  const { isActive: _isActive, ...stamped } = stampFields(stamp)
  return {
    name: fields.name,
    ...(fields.description ? { description: fields.description } : {}),
    source: fields.source,
    active: true,
    public: fields.public,
    ...(prices.length ? { prices } : {}),
    ...(fields.limits?.length ? { limits: fields.limits } : {}),
    ...(introPrice && fields.intro
      ? { introOffers: [{ priceId: introPrice.id, periods: fields.intro.periods, amount: fields.intro.amount }] }
      : {}),
    ...(fields.source === 'aggregator' && typeof fields.payoutPerVisit === 'number'
      ? { payoutPerVisit: fields.payoutPerVisit }
      : {}),
    ...stamped,
  }
}

/** The wizard's plan answers as plan fields. A pack is `one_time` + `credits`,
 *  its validity `included_months`; a complimentary plan carries NO prices,
 *  which is what "the studio charges nothing" means (planTemplates.ts). */
export function setupPlanFields(plan: SetupPlan): PlanFields {
  const prices: Omit<SubscriptionPrice, 'id'>[] = []
  if (plan.kind === 'membership') {
    if (typeof plan.monthlyAmount === 'number') prices.push({ amount: plan.monthlyAmount, recurrence: 'monthly' })
    if (typeof plan.annualAmount === 'number') prices.push({ amount: plan.annualAmount, recurrence: 'annual' })
  } else if (plan.kind === 'pack' && typeof plan.packAmount === 'number') {
    prices.push({
      amount: plan.packAmount,
      recurrence: 'one_time',
      ...(plan.credits ? { credits: plan.credits } : {}),
      ...(plan.validMonths ? { included_months: plan.validMonths } : {}),
    })
  }
  return {
    name: plan.name,
    ...(plan.description ? { description: plan.description } : {}),
    source: plan.kind === 'partner' ? 'aggregator' : 'internal',
    public: plan.public,
    prices,
    ...(plan.kind === 'membership' && plan.limit ? { limits: [plan.limit] } : {}),
    // On the FIRST recurring price, monthly when there is one.
    ...(plan.kind === 'membership' && plan.intro && prices.length
      ? { intro: { priceIndex: 0, ...plan.intro } }
      : {}),
    ...(plan.kind === 'partner' && typeof plan.payoutPerVisit === 'number'
      ? { payoutPerVisit: plan.payoutPerVisit }
      : {}),
  }
}
