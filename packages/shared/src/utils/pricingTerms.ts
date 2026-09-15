// ─── Pricing terms — how long a price commits a member ─────────────────────────
//
// A plan's term is not a field of its own: it lives on each price. "6 months"
// is a monthly price with `included_months: 6` (a minimum term), "12 months" an
// annual price or a monthly one with 12 included months, "1 month" a plain
// monthly price. The website's pricing tabs group prices by this number, and
// this is the ONE place that reads it off a price.

const RECURRENCE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
}

/** The minimal price shape — satisfied by SubscriptionPrice and the public mirror entry. */
export interface TermedPrice {
  recurrence: string
  included_months?: number
  credits?: number
}

/**
 * How many months a price commits to, or null when it has no term to group by:
 * a credit pack (its months are a validity window, not a commitment), a
 * per-class or weekly price, or a one-time price with no included months.
 */
export function priceTermMonths(price: TermedPrice): number | null {
  if (typeof price.credits === 'number' && price.credits > 0) return null
  if (typeof price.included_months === 'number' && price.included_months > 0) {
    return Math.round(price.included_months)
  }
  return RECURRENCE_MONTHS[price.recurrence] ?? null
}

/** The distinct terms across a set of plans' prices, shortest first. */
export function pricingTerms(plans: readonly { prices?: readonly TermedPrice[] }[]): number[] {
  const terms = new Set<number>()
  for (const plan of plans) {
    for (const price of plan.prices ?? []) {
      const months = priceTermMonths(price)
      if (months !== null) terms.add(months)
    }
  }
  return [...terms].sort((a, b) => a - b)
}
