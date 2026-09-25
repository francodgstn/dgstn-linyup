// Pure, no-JSX resolver for an activity's public "commercial terms" — the money
// (and access) chips shown on activity cards across every surface that lists
// them: the admin activities manager, the public booking flow, the public
// website/embeds, and the shop's "pay per visit" strip. ONE place computes
// WHICH chips apply; each surface renders them with its own styling/labels
// (label copy differs slightly per surface — see each surface's i18n
// namespace) via its own i18n namespace.
//
// Design rule (locked with the user): terms chips live on the activity card,
// on every surface where activity cards appear. Prices are NEVER purchasable
// in the shop — payment always happens in the booking flows; the chips are
// information + routing only.
//
// Input is a structural subset shared by `Activity` (admin, full doc) and
// `ActivityPublicProfile` (public mirrors) — both shapes satisfy it, so
// callers can pass either without adapting field names.

import {
  appointmentPriceRange,
  classAccessFacts,
  resolveDurationBenefit,
  resolveDurationSale,
  normalizeBenefit,
  type PriceRange,
  type ActivityAccessRule,
  type ActivityDurationBenefit,
  type ActivityMemberBenefit,
  type Benefit,
  type DurationParty,
} from '@linyup/shared'
import { priceRangeLabel } from './priceRange'

export type ActivityTermKind =
  | 'trial'
  | 'dropIn'
  | 'gate'
  | 'price'
  | 'benefitIncluded'
  | 'benefitDiscount'

export interface ActivityTerm {
  kind: ActivityTermKind
  /** dropIn — the flat per-class price. trial — the paid-trial price (major
   *  units); absent/undefined means the trial is FREE (today's behaviour). */
  amount?: number
  /** price only (appointments) — lowest priced duration. Equal to `max` when
   *  every priced duration shares the same price. */
  min?: number
  /** price only (appointments) — highest priced duration. */
  max?: number
  /** price only (appointments). WHAT THAT SPREAD SAYS, which `min`/`max` alone
   *  cannot express: a range excluding a length that is free or benefit-only
   *  states a floor that is not the floor. Render it through
   *  `priceRangeLabel`, never by comparing `min` and `max` again. */
  range?: PriceRange
  /** benefitDiscount only — 1-99. */
  percent?: number
  /** gate only — which access tier is gating the class. Both tiers resolve to
   *  the SAME 'gate' kind (surfaces decide how much to differentiate). */
  tier?: 'members' | 'subscription'
  /** benefitIncluded / benefitDiscount only — the subscription types that
   *  grant the benefit, so a surface with the plan list loaded (admin, shop)
   *  may resolve names ("Included · Premium"). Surfaces without that context
   *  (the public website) use a generic label instead. */
  subscriptionTypeIds?: string[]
}

/** Structural subset of `Activity` / `ActivityPublicProfile` this resolves
 *  from — loose so both the admin form/list and every public mirror shape
 *  satisfy it without adapting field names. */
export interface ActivityTermsInput {
  /** Defaults to 'class' when absent, matching `Activity.type`'s own default. */
  type?: 'class' | 'appointment' | string
  /** CLASS-ONLY. Legacy trial flag — combines with `accessRule`/`trialEnabled`;
   *  see `resolveActivityAccessRule`. */
  isFreeTrial?: boolean
  /** CLASS-ONLY. Independent of the access tier — a gated class may still
   *  take a newcomer's trial booking. */
  trialEnabled?: boolean
  /** CLASS-ONLY. Reduced trial price (major units), sitting next to
   *  `trialEnabled`. Absent/null ⇒ FREE trial (today's behaviour); a number ⇒
   *  the trial costs that instead of the class's normal price. */
  trialPriceAmount?: number | null
  /** CLASS-ONLY. Ignored for appointments (money is the only gate there). */
  accessRule?: ActivityAccessRule | null
  /** CLASS-ONLY. */
  dropIn?: { enabled?: boolean; priceAmount?: number | null } | null
  /** APPOINTMENT-ONLY. `benefitOnly` lengths carry no individual price and are
   *  excluded from the price chip — see `resolveDurationSale` (UX-70). */
  durations?: Array<{
    minutes: number
    priceAmount?: number | null
    benefitOnly?: boolean
    /** A party length: its price is per person (`appointmentPriceRange`). */
    party?: DurationParty | null
  }> | null
  /** APPOINTMENT-ONLY (as a money term here — classes also carry a
   *  `memberBenefit` now, a drop-in member rate, but it isn't surfaced as a
   *  term/chip by this resolver; see the class branch below). Accepts the
   *  legacy appointment shape or the generalized `Benefit`; normalized via
   *  `normalizeBenefit`. */
  memberBenefit?: ActivityMemberBenefit | Benefit | null
  /** APPOINTMENT-ONLY. The per-length rules — read WITH `memberBenefit`
   *  through `resolveDurationBenefit`, never on their own. */
  durationBenefits?: ActivityDurationBenefit[] | null
}

/** Resolves the structured list of commercial/access terms for one activity.
 *  Order is stable: gate, trial, drop-in for classes; price, benefit for
 *  appointments — surfaces may render a subset (e.g. the admin list and the
 *  booking flow already have their own gate/trial badges and only want the
 *  money kinds from here). */
export function resolveActivityTerms(a: ActivityTermsInput): ActivityTerm[] {
  const terms: ActivityTerm[] = []

  if (a.type === 'appointment') {
    // Through the shared reader: a length sold only through the member benefit
    // has NO price to advertise, and a stale `priceAmount` beside it must never
    // become a "from CHF …" on a public card (UX-70). `appointmentPriceRange`
    // owns that reading, and also the distinction `min`/`max` cannot carry:
    // whether the spread covers every length or only the sold ones.
    const priced = (a.durations ?? [])
      .map((d) => resolveDurationSale(d).priceAmount)
      .filter((p): p is number => typeof p === 'number')
    const range = appointmentPriceRange(a.durations)
    if (range) {
      terms.push({ kind: 'price', min: Math.min(...priced), max: Math.max(...priced), range })
    }

    // Display logic stays keyed on included/percent semantics — a fixed_price
    // benefit doesn't earn a term/chip here (no "from X" story to summarize in
    // one line); the public surfaces that show it do so via the resolver's
    // `appliedBenefit` on the actual priced option instead (see BookingForm /
    // ShopHome / AppointmentPicker).
    // ── ONE CHIP FOR SEVERAL LENGTHS, OR NONE ──────────────────────────────
    // The rule is per length now, and this is a ONE-LINE summary of the whole
    // appointment on a public card. "Included with Premium" when only the
    // 30-minute length is included would be a lie told to a stranger — so the
    // chip is shown only when every length says the SAME thing, and otherwise
    // the card carries its price range alone and the picker quotes the real
    // per-length price.
    const perLength = (a.durations?.length ? a.durations : [{ minutes: 60 }]).map((d) =>
      normalizeBenefit(resolveDurationBenefit(a, d.minutes))
    )
    const first = perLength[0] ?? null
    const unanimous = perLength.every((b) => JSON.stringify(b) === JSON.stringify(first))
    const benefit = unanimous ? first : null
    const benefitTypeIds = benefit?.subscriptionTypeIds ?? []
    if (benefit && benefitTypeIds.length > 0) {
      if (benefit.effect === 'included') {
        terms.push({ kind: 'benefitIncluded', subscriptionTypeIds: benefitTypeIds })
      } else if (benefit.effect === 'percent_off' && typeof benefit.percent === 'number') {
        terms.push({ kind: 'benefitDiscount', percent: benefit.percent, subscriptionTypeIds: benefitTypeIds })
      }
    }

    return terms
  }

  // class (default when `type` is absent/'class')
  //
  // WHO MAY BOOK, DERIVED (docs/class-access-derived.md) — through the same
  // `classAccessFacts` the booking path reads, never off the legacy tier. The
  // studio default is `null` here: every caller hands in a document whose
  // drop-in is already RESOLVED (a public mirror, or the admin list after
  // `resolveActivityDropIn`), so there is no default left to follow.
  const facts = classAccessFacts(
    {
      type: 'class',
      accessRule: a.accessRule ?? undefined,
      isFreeTrial: a.isFreeTrial,
      dropIn:
        a.dropIn && typeof a.dropIn.priceAmount === 'number' && a.dropIn.enabled !== false
          ? { mode: 'custom', priceAmount: a.dropIn.priceAmount }
          : { mode: 'off' },
    },
    null
  )
  // The wall: only people who signed up with the studio.
  if (facts.signupRequired && !facts.planHoldersOnly) terms.push({ kind: 'gate', tier: 'members' })
  // The plans that include it. Plan-holders-only is a GATE (nobody else gets
  // in); otherwise the same plans are simply a way in for free, beside the door.
  if (facts.planHoldersOnly) {
    terms.push({ kind: 'gate', tier: 'subscription', subscriptionTypeIds: facts.includedPlanIds })
  } else if (facts.includedPlanIds.length > 0) {
    terms.push({ kind: 'benefitIncluded', subscriptionTypeIds: facts.includedPlanIds })
  }
  // The newcomer's trial, where it grants something (mirrors `bookSession`'s
  // trial door): never on a class free to anyone.
  if (a.trialEnabled === true && facts.trialAvailable) {
    terms.push({
      kind: 'trial',
      ...(typeof a.trialPriceAmount === 'number' ? { amount: a.trialPriceAmount } : {}),
    })
  }
  if (facts.dropIn.enabled && typeof facts.dropIn.priceAmount === 'number') {
    terms.push({ kind: 'dropIn', amount: facts.dropIn.priceAmount })
  }

  return terms
}

// ─── structured pricing display (named subscriptions) ──────────────────────────
// The activity-card commercial display the PUBLIC surfaces render (booking flow +
// website). Resolves the raw terms into NAMED access routes, given a lookup from
// a subscription-type id → its display name + price label. Each surface supplies
// the lookup from the team's `aggregator_subscription_types`, formatted in its own
// locale/currency; a surface without the aggregator (or a sub it can't resolve)
// simply omits that line — never a generic "Subscription required".

export interface ResolvedSub {
  /** Subscription type id — lets a surface deep-link /shop?type={id}. */
  id: string
  name: string
  /** e.g. "CHF 89 / mo" — the surface formats it; null when the sub has no price. */
  priceLabel: string | null
}
export type SubLookup = (subscriptionTypeId: string) => ResolvedSub | null

export interface ActivityPricingDisplay {
  type: 'class' | 'appointment'
  /** null ⇒ no trial offered. `{ priceAmount: null }` ⇒ FREE trial (today's
   *  behaviour). `{ priceAmount: 15 }` ⇒ a paid trial at that price. */
  trial: { priceAmount: number | null } | null
  /** "Included with {name} — {priceLabel}" — a class gated at the 'subscription'
   *  tier OR an appointment's INCLUDED member benefit. One per resolvable
   *  subscription. ALWAYS EMPTY for a 'members'-tier class, and that is load
   *  bearing — see `signedUpOnly`. */
  includedWith: ResolvedSub[]
  /** TRUE for a class gated at the 'members' tier.
   *
   *  THE TIER IS NOT ABOUT MONEY. `members` gates on `acquisition_stage ===
   *  'joined'` (`resolveClassCoverage`, `shared/utils/paymentOptions.ts`), i.e.
   *  on being SIGNED UP with the studio — which the public signup form grants
   *  for free, with no plan and no payment (`completeSignup` is the only writer
   *  of 'joined', and it charges nothing). A contact with no subscription at all
   *  books these classes.
   *
   *  So a surface must NOT name subscription plans or quote a price here: the
   *  true answer to "what do I have to buy?" is NOTHING, and a price would send
   *  a prospect to the shop for something they do not need. It points at the
   *  signup surface instead. This resolver takes no plan catalogue for exactly
   *  that reason — the wrong line is not merely discouraged, it is
   *  unrepresentable.
   *
   *  Contrast 'subscription' (`includedWith`), where the named plans genuinely
   *  ARE the key and their prices are the right thing to show. Never merge the
   *  two tiers. */
  signedUpOnly: boolean
  /** TRUE for a 'subscription'-tier class whose gate names NO plan this surface
   *  can resolve — either the rule lists no ids at all, or every id it lists is
   *  missing from the public plan catalogue (a legacy plan the studio no longer
   *  sells still gates its classes, and `public: false` hides it from the
   *  lookup).
   *
   *  HIDING A PRICE MUST NEVER HIDE A GATE. Before this flag existed the
   *  unresolvable ids were simply dropped and the card rendered NO access line
   *  whatever — so a gated class looked open, and the visitor met the refusal
   *  after clicking Book. A surface renders a generic "requires a plan"
   *  sentence off this flag: the class does require one, and that is true
   *  without naming which.
   *
   *  Mutually exclusive with `signedUpOnly` (the tiers are exclusive) and never
   *  set together with a non-empty `includedWith` from the gate. It is NOT the
   *  'members' sentence: that tier costs nothing and points at signup, this one
   *  requires a plan and points at the shop. */
  planRequired: boolean
  /** "Discount with {name} — {percent}%" — an appointment's DISCOUNT benefit. */
  discountWith: Array<{ name: string; percent: number }>
  /** Class drop-in price (major units), or null. */
  dropInAmount: number | null
  /** Appointment direct/base price spread (major units), or null. Rendered
   *  through `priceRangeLabel`. The shape says which of "CHF 45", "CHF 45–85"
   *  and "from CHF 45" is the true sentence, which a bare `{min,max}` could
   *  not. */
  appointmentPrice: PriceRange | null
}

export function resolveActivityPricingDisplay(
  a: ActivityTermsInput,
  subLookup: SubLookup
): ActivityPricingDisplay {
  const terms = resolveActivityTerms(a)
  const type: 'class' | 'appointment' = a.type === 'appointment' ? 'appointment' : 'class'

  const includedIds = new Set<string>()
  // The gate's OWN ids, kept apart from `includedIds` (which an appointment's
  // benefit also feeds) so `planRequired` can ask "did the GATE resolve to
  // anything?" rather than "is the merged list empty?".
  const gateIds: string[] = []
  let subscriptionGated = false
  let signedUpOnly = false
  let discount: { percent: number; ids: string[] } | null = null
  let dropInAmount: number | null = null
  let appointmentPrice: PriceRange | null = null
  let trial: { priceAmount: number | null } | null = null

  for (const term of terms) {
    if (term.kind === 'trial') trial = { priceAmount: term.amount ?? null }
    else if (term.kind === 'dropIn') dropInAmount = term.amount ?? null
    else if (term.kind === 'price') appointmentPrice = term.range ?? null
    else if (term.kind === 'gate' && term.tier === 'subscription') {
      subscriptionGated = true
      ;(term.subscriptionTypeIds ?? []).forEach((id) => {
        includedIds.add(id)
        gateIds.push(id)
      })
    }
    else if (term.kind === 'gate' && term.tier === 'members') signedUpOnly = true
    else if (term.kind === 'benefitIncluded')
      (term.subscriptionTypeIds ?? []).forEach((id) => includedIds.add(id))
    else if (term.kind === 'benefitDiscount')
      discount = { percent: term.percent ?? 0, ids: term.subscriptionTypeIds ?? [] }
  }

  const includedWith = [...includedIds]
    .map((id) => subLookup(id))
    .filter((s): s is ResolvedSub => !!s)
  const discountWith = discount
    ? discount.ids
        .map((id) => {
          const s = subLookup(id)
          return s ? { name: s.name, percent: discount!.percent } : null
        })
        .filter((x): x is { name: string; percent: number } => !!x)
    : []
  // Silence would read as "open". See `planRequired`.
  const planRequired = subscriptionGated && !gateIds.some((id) => !!subLookup(id))

  return {
    type,
    trial,
    includedWith,
    signedUpOnly,
    planRequired,
    discountWith,
    dropInAmount,
    appointmentPrice,
  }
}

// ─── the ADMIN money chips ────────────────────────────────────────────────────

/**
 * The money chips an ADMIN surface shows for one activity, as ready labels.
 *
 * Extracted from the activities list (2026-08-31) when the catalogue's detail
 * pane started showing the same facts. Two surfaces deriving "what does this
 * cost" from `resolveActivityTerms` in two places is how they end up disagreeing
 * about, say, whether a benefit chip names its plan — and the catalogue exists
 * precisely to be believed about pricing.
 *
 * It stays HERE rather than in a component because it is the same kind of thing
 * as `resolveActivityTerms` above: a pure derivation, rendered differently per
 * surface. The `t` it takes is bound to the `Activities` namespace, which owns
 * this copy.
 *
 * The GATE and the FREE trial are deliberately excluded: both are access facts
 * with their own badges, not money. A PRICED trial is money and is kept.
 */
export function activityMoneyChipLabels(
  activity: ActivityTermsInput,
  currency: string,
  subscriptionTypes: Array<{ id: string; name: string }>,
  t: (key: string, values?: Record<string, string | number>) => string,
  formatMoney: (amount: number, currency: string) => string
): string[] {
  const nameFor = (ids?: string[]) =>
    ids?.length === 1 ? subscriptionTypes.find((s) => s.id === ids[0])?.name : undefined

  return resolveActivityTerms(activity)
    .filter(
      (term) =>
        (term.kind !== 'trial' && term.kind !== 'gate') ||
        (term.kind === 'trial' && typeof term.amount === 'number')
    )
    .map((term): string | null => {
      switch (term.kind) {
        case 'trial':
          return typeof term.amount === 'number'
            ? t('chipTrialPriced', { amount: formatMoney(term.amount, currency) })
            : null
        case 'dropIn':
          return t('chipDropIn', { amount: formatMoney(term.amount ?? 0, currency) })
        case 'price':
          return term.range
            ? priceRangeLabel(term.range, {
                money: (amount) => formatMoney(amount, currency),
                from: (price) => t('chipPriceFrom', { price }),
                range: (min, max) => `${min}–${max}`,
                perPerson: (price) => t('chipPricePerPerson', { price }),
              })
            : null
        case 'benefitIncluded': {
          const name = nameFor(term.subscriptionTypeIds)
          return name ? t('chipBenefitIncludedNamed', { name }) : t('chipBenefitIncluded')
        }
        case 'benefitDiscount': {
          const name = nameFor(term.subscriptionTypeIds)
          return name
            ? t('chipBenefitDiscountNamed', { percent: term.percent ?? 0, name })
            : t('chipBenefitDiscount', { percent: term.percent ?? 0 })
        }
        default:
          return null
      }
    })
    .filter((label): label is string => label !== null)
}
