// Pure logic for the unified Pricing surface (offer/pricing) — personas, price
// cells and health checks, all driven by the ONE shared resolver so the page
// can never disagree with what a booking/checkout would actually charge.
// No firebase imports; everything here is derived from already-loaded docs.

import {
  GUEST_SNAPSHOT,
  normalizeBenefit,
  resolveActivityAccessRule,
  resolveClassGate,
  resolveAppointmentDurations,
  resolveDurationBenefit,
  resolveDurationSale,
  resolvePaymentOptions,
  resolveProductPrice,
  resolveUsageLimit,
  type Activity,
  type Benefit,
  type ContactPaymentSnapshot,
  type Course,
  type PaymentDenial,
  type Product,
  type SubscriptionType,
  type SubscriptionUsageLimit,
} from '@linyup/shared'

// ─── Personas ───────────────────────────────────────────────────────────────────

export interface PricingPersona {
  id: string
  /** 'guest' | 'member' | 'type:{subscriptionTypeId}' */
  kind: 'guest' | 'member' | 'type'
  subscriptionTypeId?: string
  /** Display name (subscription type name for 'type' personas). */
  label: string
  /** True when the type is credit-only (every active price carries credits) —
   *  the page offers a "pack empty" toggle for these. */
  creditOnly: boolean
  /** Usable credits of a fresh pack (largest active credit price). */
  packSize?: number
  /** Usage limit ("up to N classes per period"), when the type has one — the
   *  page offers an "allowance used up" toggle for these. */
  limit?: SubscriptionUsageLimit
}

/** Classify a subscription type the same way the server's coverage loader does
 *  (lenient: any non-credit active price ⇒ unmetered access). */
export function isCreditOnlyType(t: SubscriptionType): boolean {
  const prices = (t.prices ?? []).filter((p) => p.active !== false)
  if (prices.length === 0) return false
  return prices.every((p) => !!p.credits)
}

function packSize(t: SubscriptionType): number {
  return Math.max(0, ...(t.prices ?? []).filter((p) => p.active !== false).map((p) => p.credits ?? 0))
}

export function buildPersonas(subscriptionTypes: SubscriptionType[]): PricingPersona[] {
  const personas: PricingPersona[] = [
    { id: 'guest', kind: 'guest', label: '', creditOnly: false },
    { id: 'member', kind: 'member', label: '', creditOnly: false },
  ]
  for (const t of subscriptionTypes) {
    if (t.active === false) continue
    const creditOnly = isCreditOnlyType(t)
    const limit = resolveUsageLimit(t)
    personas.push({
      id: `type:${t.id}`,
      kind: 'type',
      subscriptionTypeId: t.id,
      label: t.name,
      creditOnly,
      packSize: creditOnly ? packSize(t) : undefined,
      ...(limit ? { limit } : {}),
    })
  }
  return personas
}

/** The snapshot a persona resolves with. `packEmpty` only affects credit-only
 *  personas — it demos the exhausted-pack state (denied free path, offered the
 *  drop-in pay path instead). `allowanceUsedUp` only affects usage-limited
 *  personas — it demos the spent-window state (limit_reached denial, or the
 *  drop-in pay path when one exists). */
export function personaSnapshot(
  persona: PricingPersona,
  packEmpty = false,
  allowanceUsedUp = false
): ContactPaymentSnapshot {
  if (persona.kind === 'guest') return GUEST_SNAPSHOT
  if (persona.kind === 'member' || !persona.subscriptionTypeId) {
    return { authenticated: true, joined: true, heldUnmeteredTypeIds: [], heldCreditTypes: [] }
  }
  if (persona.creditOnly) {
    return {
      authenticated: true,
      joined: true,
      heldUnmeteredTypeIds: [],
      heldCreditTypes: [
        {
          subscriptionTypeId: persona.subscriptionTypeId,
          remaining: packEmpty ? 0 : (persona.packSize ?? 1),
        },
      ],
    }
  }
  return {
    authenticated: true,
    joined: true,
    heldUnmeteredTypeIds: [persona.subscriptionTypeId],
    heldCreditTypes: [],
    ...(persona.limit
      ? {
          usageRemaining: {
            [persona.subscriptionTypeId]: allowanceUsedUp ? 0 : persona.limit.count,
          },
        }
      : {}),
  }
}

// ─── Price cells ────────────────────────────────────────────────────────────────

export type PriceCell =
  | {
      kind: 'free'
      reason: 'open' | 'members' | 'unpriced' | 'included' | 'registered' | 'free_tier' | 'subscription'
      viaTypeId?: string
      /** For usage-limited subscription coverage: bookings left in the
       *  current window AFTER this one. */
      remaining?: number
    }
  | { kind: 'credit'; typeId: string; remaining: number }
  | {
      kind: 'pay'
      /** Major units, team currency. */
      amount: number
      /** Set when a member rate OR a promo code lowered the price — render the
       *  base struck through. */
      baseAmount?: number
      viaTypeId?: string
      /** The promo code that priced this cell, when one beat both the list price
       *  and the member benefit. Display only — this page never applies a code
       *  itself (personas have none); the field exists so a real quote flowing
       *  through the same helper renders the same way a checkout charges. */
      promoCode?: string
      source: 'base' | 'drop_in' | 'trial' | 'course_price' | 'product'
    }
  | {
      kind: 'blocked'
      denial: PaymentDenial
      /** The trial door this persona could still take — a guest on a gated
       *  class that offers one. `priceAmount` null ⇒ the trial is free. */
      trial?: ClassDoors['trial']
    }

/**
 * THE STANDING DOORS OF A CLASS — what it offers a newcomer regardless of who
 * is asking. The preview shows them beside every persona's answer, because
 * "Included with Premium" is what one member pays and says nothing about the
 * drop-in price or the trial the same class also sells.
 *
 * Both mirror the server: the trial door is `bookSession`'s `isTrialDoor`
 * (`trialEnabled` on a class whose display tier is not `open` — on an open
 * class a newcomer already books through the front door and the flag is
 * inert), the drop-in is the resolver's `hasPaidDoor`.
 */
export interface ClassDoors {
  trial: { priceAmount: number | null } | null
  dropInAmount: number | null
}

export function classDoors(activity: Activity): ClassDoors {
  const accessRule = resolveActivityAccessRule(activity)
  const trial =
    activity.trialEnabled === true && accessRule.type !== 'open'
      ? { priceAmount: typeof activity.trialPriceAmount === 'number' ? activity.trialPriceAmount : null }
      : null
  const dropInAmount =
    activity.dropIn?.enabled && typeof activity.dropIn.priceAmount === 'number'
      ? activity.dropIn.priceAmount
      : null
  return { trial, dropInAmount }
}

function fromResult(
  result: ReturnType<typeof resolvePaymentOptions>,
  trialForGuest: ClassDoors['trial']
): PriceCell {
  const option = result.options[0]
  if (!option) {
    return {
      kind: 'blocked',
      denial: result.denial ?? 'no_subscription',
      ...(trialForGuest ? { trial: trialForGuest } : {}),
    }
  }
  if (option.type === 'covered') {
    const via = option.via
    const remaining = option.remaining
    switch (via.reason) {
      case 'open':
        return { kind: 'free', reason: 'open' }
      case 'members':
        return { kind: 'free', reason: 'members' }
      case 'unpriced':
        return { kind: 'free', reason: 'unpriced' }
      case 'free_tier':
        return { kind: 'free', reason: 'free_tier' }
      case 'registered':
        return { kind: 'free', reason: 'registered' }
      case 'owned':
        return { kind: 'free', reason: 'free_tier' }
      case 'subscription':
        return { kind: 'free', reason: 'subscription', viaTypeId: via.subscriptionTypeId, remaining }
      case 'benefit_included':
        return { kind: 'free', reason: 'included', viaTypeId: via.subscriptionTypeId, remaining }
    }
  }
  if (option.type === 'spend_credits') {
    return { kind: 'credit', typeId: option.via.subscriptionTypeId, remaining: option.remaining }
  }
  // A modifier priced this cell: EITHER a member benefit or a promo code, never
  // both (best-one-wins, and the resolver stamps at most one). Both carry the
  // same `baseAmount` — the list price the discount was taken from — so the
  // struck-through figure is one field read from whichever won.
  //
  // `viaTypeId` falls through to `appliedPromo.supersededBenefit` on purpose:
  // without it, every running campaign would blank the member badge on this page
  // for exactly the members who used the code — the studio's own attribution,
  // gone while a campaign runs. (`supersededBenefit` carries no `baseAmount` of
  // its own, and needs none: `appliedPromo.baseAmount` IS the same list price
  // `appliedBenefit.baseAmount` would have carried.)
  const promo = option.appliedPromo
  return {
    kind: 'pay',
    amount: option.amount,
    baseAmount: option.appliedBenefit?.baseAmount ?? promo?.baseAmount,
    viaTypeId: option.appliedBenefit?.subscriptionTypeId ?? promo?.supersededBenefit?.subscriptionTypeId,
    ...(promo ? { promoCode: promo.code } : {}),
    source: option.source,
  }
}

/** One resolver call answers the whole class row: covered → free/credit,
 *  uncovered → the drop-in pay path (member rate applied), else blocked. */
export function resolveClassCell(snapshot: ContactPaymentSnapshot, activity: Activity): PriceCell {
  const accessRule = resolveActivityAccessRule(activity)
  const result = resolvePaymentOptions(snapshot, {
    kind: 'drop_in',
    accessRule,
    dropIn: activity.dropIn ?? null,
    trial: { enabled: activity.trialEnabled === true, priceAmount: activity.trialPriceAmount ?? null },
    asTrial: false,
    benefit: activity.memberBenefit ?? null,
  })
  // Guest-only: the trial door is how a stranger becomes a member, and an
  // authenticated contact is past it.
  const trialForGuest = snapshot.authenticated ? null : classDoors(activity).trial
  return fromResult(result, trialForGuest)
}

export interface AppointmentCellRow {
  minutes: number
  cell: PriceCell
}

export function resolveAppointmentCells(
  snapshot: ContactPaymentSnapshot,
  activity: Activity
): AppointmentCellRow[] {
  return resolveAppointmentDurations(activity).map((duration) => ({
    minutes: duration.minutes,
    cell: fromResult(
      resolvePaymentOptions(snapshot, {
        kind: 'appointment',
        duration,
        // THE ONE READER — one rule per length now, so the row for 30 min must
        // not be priced by the rule the studio wrote for 90.
        benefit: resolveDurationBenefit(activity, duration.minutes),
      }),
      null
    ),
  }))
}

export function resolveCourseCell(snapshot: ContactPaymentSnapshot, course: Course): PriceCell {
  return fromResult(
    resolvePaymentOptions(snapshot, {
      kind: 'course',
      accessRule: course.accessRule,
      benefit: course.benefit ?? null,
    }),
    null
  )
}

/** Products are flat-priced for everyone; variants may override the base. */
export function productPriceRange(product: Product): { min: number; max: number } {
  const base = resolveProductPrice(product)
  const variantPrices = (product.variants ?? [])
    .filter((v) => v.active !== false)
    .map((v) => resolveProductPrice(product, v.id))
  const all = [base, ...variantPrices]
  return { min: Math.min(...all), max: Math.max(...all) }
}

// ─── "You sell" reverse lookups ────────────────────────────────────────────────

export interface TypeGrantSummary {
  /** Class activities whose accessRule lists this type. */
  coveredClassNames: string[]
  /** Benefit connections this type unlocks, across activities and courses. */
  benefits: Array<{
    targetName: string
    targetKind: 'appointment' | 'class' | 'course'
    effect: Benefit['effect']
    percent?: number
    amount?: number
  }>
}

export function grantsForType(
  typeId: string,
  activities: Activity[],
  courses: Course[]
): TypeGrantSummary {
  const coveredClassNames: string[] = []
  const benefits: TypeGrantSummary['benefits'] = []
  for (const a of activities) {
    const isAppointment = a.type === 'appointment'
    if (!isAppointment) {
      const rule = resolveActivityAccessRule(a)
      if (rule.type === 'subscription' && (rule.subscriptionTypeIds ?? []).includes(typeId)) {
        coveredClassNames.push(a.name)
      }
    }
    // AN APPOINTMENT HAS ONE RULE PER LENGTH, so it can grant this plan several
    // different things — 60 min included, 90 min at 20% off. Each is its own
    // row, named by its length, because collapsing them would have to pick one
    // effect to report and there is no right one to pick.
    if (isAppointment) {
      for (const d of resolveAppointmentDurations(a)) {
        const benefit = normalizeBenefit(resolveDurationBenefit(a, d.minutes))
        if (!benefit?.subscriptionTypeIds.includes(typeId)) continue
        benefits.push({
          targetName: `${a.name} · ${d.minutes} min`,
          targetKind: 'appointment',
          effect: benefit.effect,
          percent: benefit.percent,
          amount: benefit.amount,
        })
      }
      continue
    }
    const benefit = normalizeBenefit(a.memberBenefit)
    if (benefit && benefit.subscriptionTypeIds.includes(typeId)) {
      benefits.push({
        targetName: a.name,
        targetKind: 'class',
        effect: benefit.effect,
        percent: benefit.percent,
        amount: benefit.amount,
      })
    }
  }
  for (const c of courses) {
    const benefit = normalizeBenefit(c.benefit)
    if (benefit && benefit.subscriptionTypeIds.includes(typeId)) {
      benefits.push({
        targetName: c.title,
        targetKind: 'course',
        effect: benefit.effect,
        percent: benefit.percent,
        amount: benefit.amount,
      })
      continue
    }
    // Legacy free-inclusion list (only meaningful without an explicit benefit).
    if (
      !benefit &&
      c.accessRule.type === 'purchase' &&
      (c.accessRule.subscriptionTypeIds ?? []).includes(typeId)
    ) {
      benefits.push({ targetName: c.title, targetKind: 'course', effect: 'included' })
    }
    if (c.accessRule.type === 'subscription' && (c.accessRule.subscriptionTypeIds ?? []).includes(typeId)) {
      benefits.push({ targetName: c.title, targetKind: 'course', effect: 'included' })
    }
  }
  return { coveredClassNames, benefits }
}

// ─── Health checks ──────────────────────────────────────────────────────────────

export type PricingWarningCode =
  | 'gated_empty_allowlist'
  | 'benefit_unknown_type'
  | 'purchase_course_unpriced'
  | 'benefit_bad_percent'
  | 'gated_no_newcomer_path'
  | 'credits_unusable'
  | 'appointment_no_way_in'

export interface PricingWarning {
  code: PricingWarningCode
  severity: 'error' | 'warning' | 'info'
  /** What the warning is about, for display + the fix link. */
  subjectName: string
  subjectKind: 'activity' | 'course' | 'subscription_type'
  subjectId: string
}

export function computePricingHealth(
  activities: Activity[],
  subscriptionTypes: SubscriptionType[],
  courses: Course[]
): PricingWarning[] {
  const warnings: PricingWarning[] = []
  const knownTypeIds = new Set(subscriptionTypes.map((t) => t.id))

  const checkBenefit = (
    benefitRaw: Activity['memberBenefit'] | Course['benefit'] | null,
    subjectName: string,
    subjectKind: 'activity' | 'course',
    subjectId: string
  ) => {
    const benefit = normalizeBenefit(benefitRaw)
    if (!benefit) return
    if (benefit.subscriptionTypeIds.some((id) => !knownTypeIds.has(id))) {
      warnings.push({ code: 'benefit_unknown_type', severity: 'warning', subjectName, subjectKind, subjectId })
    }
    if (
      benefit.effect === 'percent_off' &&
      (typeof benefit.percent !== 'number' || benefit.percent <= 0 || benefit.percent >= 100)
    ) {
      warnings.push({ code: 'benefit_bad_percent', severity: 'warning', subjectName, subjectKind, subjectId })
    }
  }

  const acceptedTypeIds = new Set<string>()
  for (const a of activities) {
    const isAppointment = a.type === 'appointment'
    if (isAppointment) {
      // ASKED PER LENGTH, because the rule is per length. Checking the
      // activity-wide field alone would pass an appointment whose 90-minute row
      // names a plan that no longer exists, and — worse — would report
      // `appointment_no_way_in` against a length whose OWN rule opens it fine.
      let anyNoWayIn = false
      for (const d of resolveAppointmentDurations(a)) {
        const rule = resolveDurationBenefit(a, d.minutes)
        checkBenefit(rule, `${a.name} · ${d.minutes} min`, 'activity', a.id)
        // UX-70's own failure mode: a length sold ONLY through the member
        // benefit (`benefitOnly`), with no benefit that actually covers it, is
        // bookable by NOBODY — the appointment twin of
        // `gated_no_newcomer_path`. Only an INCLUDED benefit is a way in: a
        // percentage off a price that does not exist opens nothing (see the
        // resolver's appointment arm).
        if (resolveDurationSale(d).mode !== 'benefit_only') continue
        const benefit = normalizeBenefit(rule)
        const opensDoor =
          !!benefit &&
          (benefit.effect === 'included' || benefit.effect === 'spend_credits') &&
          benefit.subscriptionTypeIds.length > 0
        // Those types ARE where a credit pack gets spent, so they count for
        // `credits_unusable` exactly as a subscription-gated class does.
        if (opensDoor) benefit!.subscriptionTypeIds.forEach((id) => acceptedTypeIds.add(id))
        else anyNoWayIn = true
      }
      // ONE warning for the activity, not one per length. The health list is
      // read as a to-do and the fix is the same visit either way; a row per
      // length would bury the other activities behind one misconfigured
      // appointment.
      if (anyNoWayIn) {
        warnings.push({
          code: 'appointment_no_way_in',
          severity: 'error',
          subjectName: a.name,
          subjectKind: 'activity',
          subjectId: a.id,
        })
      }
      continue
    }
    checkBenefit(a.memberBenefit, a.name, 'activity', a.id)
    const rule = resolveActivityAccessRule(a)
    // 'open' is the only tier a newcomer can always walk into. BOTH gated tiers
    // ('members' and 'subscription') refuse a stranger — resolveClassCoverage
    // denies 'guest'/'not_joined' before it ever looks at subscriptions — so the
    // newcomer-path check below must run on both. It used to `continue` on
    // anything but 'subscription', which blinded it to 'members': the DEFAULT
    // tier of every new class.
    if (rule.type === 'open') continue
    const hasDropIn = a.dropIn?.enabled === true && typeof a.dropIn.priceAmount === 'number'
    const gate = resolveClassGate(rule, hasDropIn)
    if (gate.requirePlan) {
      const allowed = rule.subscriptionTypeIds ?? []
      allowed.forEach((id) => acceptedTypeIds.add(id))
      // NOW IT IS A REAL DEAD END, and only now. Under the old tiers "gated to
      // subscriptions with none ticked" was ambiguous — usually a studio that
      // had not finished, occasionally one that meant "nobody books this free" —
      // so the warning had to guess. Requiring a plan is an explicit answer, and
      // combined with no plan to hold it means the class cannot be booked by
      // anyone at all, which is never what was meant.
      //
      // `acceptedTypeIds` stays scoped to this branch for the other reason it
      // always was: it feeds `credits_unusable`, which asks where a credit gets
      // SPENT. A class that covers its audience outright burns no credit.
      if (allowed.length === 0) {
        warnings.push({
          code: 'gated_empty_allowlist',
          severity: 'error',
          subjectName: a.name,
          subjectKind: 'activity',
          subjectId: a.id,
        })
      }
    }
    if (!hasDropIn && a.trialEnabled !== true) {
      warnings.push({
        code: 'gated_no_newcomer_path',
        severity: 'info',
        subjectName: a.name,
        subjectKind: 'activity',
        subjectId: a.id,
      })
    }
  }

  for (const c of courses) {
    if (c.archived_at) continue
    checkBenefit(c.benefit, c.title, 'course', c.id)
    if (c.accessRule.type === 'purchase' && typeof c.accessRule.priceAmount !== 'number') {
      warnings.push({
        code: 'purchase_course_unpriced',
        severity: 'error',
        subjectName: c.title,
        subjectKind: 'course',
        subjectId: c.id,
      })
    }
  }

  for (const t of subscriptionTypes) {
    if (t.active === false) continue
    if (isCreditOnlyType(t) && !acceptedTypeIds.has(t.id)) {
      warnings.push({
        code: 'credits_unusable',
        severity: 'warning',
        subjectName: t.name,
        subjectKind: 'subscription_type',
        subjectId: t.id,
      })
    }
  }

  return warnings
}
