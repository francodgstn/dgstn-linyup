/**
 * "SUBSCRIBED" MEANS ON ONE OF THE STUDIO'S OWN PLANS — one predicate.
 *
 * A partner-app type (`SubscriptionType.source: 'aggregator'` — FitPass,
 * ClassPass, SportPass…) is a subscription the studio did not sell: the
 * partner sells it, the studio is paid per visit, and the person is very often
 * an external (see `contactLifecycle`). Folding those into "subscribed" made
 * every headcount of subscribers flatter the studio — a ClassPass visitor read
 * as a paying member in the weekly trend and on the dashboard.
 *
 * So every count that answers "how many people are subscribed" asks it here:
 * the studio's OWN plans are `holdsOwnPlan`, the partner ones `holdsPartnerPlan`,
 * and a person may be both. Per-type breakdowns keep every type by id — a
 * partner type is honest by NAME; it is only the aggregate that lied.
 *
 * `'aggregator'` is the stored machine identifier (renamed to "partner" for
 * display in 2026-08 and deliberately not in the data — see
 * `SubscriptionType.source`); this module is where that string lives.
 */

export interface SubscriptionSourceFacts {
  source?: string | null
}

export interface LiveSubscriptionFacts {
  subscription_type_id: string
}

/** Sold by a partner app, not by the studio. */
export function isPartnerSubscriptionType(t: SubscriptionSourceFacts): boolean {
  return t.source === 'aggregator'
}

/** The ids to hold a contact's live subscriptions against. */
export function partnerSubscriptionTypeIds(
  types: ReadonlyArray<SubscriptionSourceFacts & { id: string }>,
): Set<string> {
  return new Set(types.filter(isPartnerSubscriptionType).map((t) => t.id))
}

/** At least one live subscription on one of the studio's OWN plans. */
export function holdsOwnPlan(
  live: ReadonlyArray<LiveSubscriptionFacts> | null | undefined,
  partnerIds: ReadonlySet<string>,
): boolean {
  return (live ?? []).some((s) => !partnerIds.has(s.subscription_type_id))
}

/** At least one live subscription on a partner-app plan. */
export function holdsPartnerPlan(
  live: ReadonlyArray<LiveSubscriptionFacts> | null | undefined,
  partnerIds: ReadonlySet<string>,
): boolean {
  return (live ?? []).some((s) => partnerIds.has(s.subscription_type_id))
}
