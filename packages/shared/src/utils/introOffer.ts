// THE ONE validator for a plan's intro offers ("first 3 months at CHF 1, then
// CHF 79/month"). Pure and client-safe: the subscription-type editor, the
// public_profile mirror, the public pricing card, the shop checkout modal and
// both membership checkout callables all resolve through THIS function, so an
// offer that cannot be sold is never advertised and an offer that is advertised
// is exactly the one that gets applied.
//
// A plan may carry one offer PER PRICE. Every entry point below is already
// per-price — `resolveIntroOffer(type, priceId)` is the only way in, and it was
// so before the list existed, which is why widening the storage changed no
// caller. `introOffersOf` is the one place that reads the storage shape.
//
// ─── What this is NOT ────────────────────────────────────────────────────────
// It is NOT an arm of `resolvePaymentOptions`, and must never become one. That
// resolver answers `covered | spend_credits | pay(amount)` — ONE amount. An
// intro offer is a SCHEDULE: an amount AND how many periods it survives. The
// mismatch is the whole reason memberships sit outside the promo rails, and it
// is not a bug to fix. The offer is a property of the CHECKOUT (a Stripe Coupon
// on the connected account), not of the price the resolver would return.
//
// ─── The Stripe constraint that shapes everything below ───────────────────────
// A Coupon expresses its lifetime as `duration`:
//
//   • 'once'      — discounts the FIRST invoice, at any interval. Always
//                   expressible, for every recurrence.
//   • 'repeating' — expressed in `duration_in_months`, AND NOTHING ELSE. There
//                   is no `duration_in_weeks`, no interval count, no
//                   "number of invoices". (Pinned at compile time by
//                   `_assert_coupon_has_duration_in_months` in
//                   functions/src/utils/stripe/objectShape.ts.)
//
// So "the first N periods" is expressible only when N periods is a WHOLE NUMBER
// OF MONTHS:
//
//   recurrence   period      N = 1            N > 1
//   ──────────   ────────    ─────────────    ────────────────────────────────
//   weekly       1 week      once ✔           REFUSED — N weeks is not months
//   biweekly     2 weeks     once ✔           REFUSED — same
//   monthly      1 month     once ✔           repeating, duration_in_months = N
//   quarterly    3 months    once ✔           repeating, = 3N
//   annual       12 months   once ✔           repeating, = 12N
//   one_time     —           REFUSED — same
//
// The refusals are enforced HERE rather than at the editor, so the editor and
// the server cannot drift: the editor asks this module what to offer, and the
// server asks it what to apply.

import { MIN_CHARGE_MINOR, toMinorUnits } from './money'
import {
  isRecurringRecurrence,
  type SubscriptionIntroOffer,
  type SubscriptionPrice,
  type SubscriptionRecurrence,
  type SubscriptionType,
} from '../types/contact'

/** Upper bound on the number of discounted periods the editor will accept.
 *  Not a Stripe limit — a sanity limit, so a typo cannot mint a coupon that
 *  discounts a plan for a decade. */
export const INTRO_OFFER_MAX_PERIODS = 12

/** How Stripe will be asked to express this offer's lifetime. */
export type IntroOfferDuration =
  | { duration: 'once' }
  | { duration: 'repeating'; durationInMonths: number }

/** Whole months in ONE billing period, or null when the recurrence has no whole
 *  number of months (weekly, biweekly) or is not billed as a subscription. */
export function monthsPerBillingPeriod(r: SubscriptionRecurrence): number | null {
  switch (r) {
    case 'monthly':
      return 1
    case 'quarterly':
      return 3
    case 'annual':
      return 12
    default:
      // weekly / biweekly are recurring but not month-aligned; one_time and
      // one_time are not subscriptions.
      return null
  }
}

/** What an intro offer can promise on this recurrence:
 *   • 'periods'    — any N from 1 to INTRO_OFFER_MAX_PERIODS
 *   • 'first_only' — N = 1 and nothing else (Stripe cannot state N weeks)
 *   • 'none'       — not a subscription; no offer of any length */
export type IntroOfferSupport = 'periods' | 'first_only' | 'none'

export function introOfferSupport(r: SubscriptionRecurrence): IntroOfferSupport {
  if (!isRecurringRecurrence(r)) return 'none'
  return monthsPerBillingPeriod(r) === null ? 'first_only' : 'periods'
}

/** The Stripe lifetime for N periods of this recurrence, or null when Stripe
 *  cannot state it. `once` for N = 1 at ANY interval — deliberately preferred
 *  over `repeating` with duration_in_months = 1, because 'once' means exactly
 *  "the first invoice" with no boundary arithmetic at all. */
export function introOfferDurationFor(
  r: SubscriptionRecurrence,
  periods: number
): IntroOfferDuration | null {
  if (!Number.isInteger(periods) || periods < 1 || periods > INTRO_OFFER_MAX_PERIODS) return null
  if (!isRecurringRecurrence(r)) return null
  if (periods === 1) return { duration: 'once' }
  const months = monthsPerBillingPeriod(r)
  if (months === null) return null
  return { duration: 'repeating', durationInMonths: periods * months }
}

/** Why an offer is unsellable. Named, so the editor can say which rule was
 *  broken instead of greying a control with no explanation. */
export type IntroOfferProblem =
  | 'no_price' // the named price is gone or deactivated
  | 'not_recurring' // one_time — nothing recurs, so nothing "returns to full"
  | 'periods_invalid' // not an integer in 1 … INTRO_OFFER_MAX_PERIODS
  | 'interval_not_monthly' // weekly/biweekly with N > 1 — see the table above
  | 'amount_invalid' // negative, or not a number
  | 'below_minimum' // > 0 but under Stripe's 0.50 floor (0 itself is FREE, and fine)
  | 'not_cheaper' // >= the full price, so it is not an offer

/**
 * The offer, fully resolved against the price it names — or null.
 *
 * `null` is the ONE answer every surface acts on: no card copy, no coupon, full
 * price charged. There is deliberately no "partially valid" state.
 */
export interface ResolvedIntroOffer {
  priceId: string
  periods: number
  /** Per-period price while the offer runs, MAJOR units. 0 = free. */
  amount: number
  /** The plan's ordinary per-period price, MAJOR units — what it returns to. */
  fullAmount: number
  recurrence: SubscriptionRecurrence
  /** How Stripe will be asked to express the lifetime. */
  stripe: IntroOfferDuration
  /** The first period(s) cost nothing. A different Stripe shape from a discount:
   *  a 100%-off coupon produces a ZERO invoice (no charge at all), which is why
   *  the 0.50 floor does not apply to it. */
  free: boolean
}

/** A human span for N billing periods — what the copy actually says. Quarterly
 *  and biweekly are converted rather than named ("your first 6 months", not
 *  "your first 2 quarters"), because that is how a member counts. Shared by the
 *  public pricing card and the purchase receipt, so the promise and the
 *  confirmation are the same sentence. */
export type IntroSpanUnit = 'week' | 'month' | 'year'

export function introOfferSpan(
  r: SubscriptionRecurrence,
  periods: number
): { count: number; unit: IntroSpanUnit } {
  switch (r) {
    case 'weekly':
      return { count: periods, unit: 'week' }
    case 'biweekly':
      return { count: periods * 2, unit: 'week' }
    case 'quarterly':
      return { count: periods * 3, unit: 'month' }
    case 'annual':
      return { count: periods, unit: 'year' }
    default:
      return { count: periods, unit: 'month' }
  }
}

/** Which rule an offer breaks against a given price, or null when it is sound. */
export function introOfferProblem(
  offer: SubscriptionIntroOffer,
  price: Pick<SubscriptionPrice, 'amount' | 'recurrence'> | null | undefined
): IntroOfferProblem | null {
  if (!price) return 'no_price'
  if (!isRecurringRecurrence(price.recurrence)) return 'not_recurring'
  if (
    !Number.isInteger(offer.periods) ||
    offer.periods < 1 ||
    offer.periods > INTRO_OFFER_MAX_PERIODS
  ) {
    return 'periods_invalid'
  }
  if (!introOfferDurationFor(price.recurrence, offer.periods)) return 'interval_not_monthly'
  if (typeof offer.amount !== 'number' || !Number.isFinite(offer.amount) || offer.amount < 0) {
    return 'amount_invalid'
  }
  // A ZERO intro is free — Stripe charges nothing, so there is no minimum to
  // clear. Anything ABOVE zero is a real charge and must clear the same 0.50
  // floor every other authored price does (shared/utils/money.ts).
  if (offer.amount > 0 && toMinorUnits(offer.amount) < MIN_CHARGE_MINOR) return 'below_minimum'
  if (typeof price.amount !== 'number' || offer.amount >= price.amount) return 'not_cheaper'
  return null
}

/**
 * Every intro offer this plan carries, whichever shape it is stored in.
 *
 * THE ONE PLACE that knows there are two shapes: `introOffers` (one per price,
 * current) and `introOffer` (a single plan-level offer, legacy). A stored
 * document is never rewritten to be readable — it is read.
 *
 * At most one offer survives per priceId, FIRST WINS. Two offers on one price is
 * not a state the editor can produce; if hand-edited data ever holds it, taking
 * the first is stable and order-independent for every caller, which "last wins"
 * would not be.
 */
export function introOffersOf(
  type: Pick<SubscriptionType, 'introOffer' | 'introOffers'>
): SubscriptionIntroOffer[] {
  const list = type.introOffers ?? (type.introOffer ? [type.introOffer] : [])
  const seen = new Set<string>()
  return list.filter((o) => {
    if (!o || typeof o.priceId !== 'string' || seen.has(o.priceId)) return false
    seen.add(o.priceId)
    return true
  })
}

/**
 * Resolve the plan's intro offer for ONE of its prices.
 *
 * Returns null when no offer names this price, or when the one that does breaks
 * any rule above. Callers that want to explain the refusal call
 * `introOfferProblem` themselves — the editor does; nothing else needs to.
 */
export function resolveIntroOffer(
  type: Pick<SubscriptionType, 'introOffer' | 'introOffers' | 'prices'>,
  priceId: string
): ResolvedIntroOffer | null {
  const offer = introOffersOf(type).find((o) => o.priceId === priceId)
  if (!offer) return null
  const price = (type.prices ?? []).find((p) => p.id === priceId && p.active !== false)
  if (!price) return null
  if (introOfferProblem(offer, price)) return null
  const stripe = introOfferDurationFor(price.recurrence, offer.periods)
  if (!stripe) return null // unreachable via introOfferProblem; narrows the type
  return {
    priceId,
    periods: offer.periods,
    amount: offer.amount,
    fullAmount: price.amount,
    recurrence: price.recurrence,
    stripe,
    free: offer.amount === 0,
  }
}
