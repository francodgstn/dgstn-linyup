// THE contact-level rollup of a member's Stripe subscriptions — "most live wins",
// plus the deduped LIVE list the contact document carries.
//
// It lives here, pure, because it now has TWO callers that must agree by
// construction: `onMemberSubscriptionWrite` (the trigger that maintains it in
// production) and the seed fixture that writes member subscriptions directly
// through the Admin SDK, where no trigger fires. A seed that computed its own
// rollup would put every demo tenant one refactor away from a contact whose
// badge and whose subscription list disagree — and that disagreement is
// invisible until somebody opens the contact.
//
// Deliberately data-only: no firebase-admin, no Timestamp. Callers pass plain
// records, so this stays importable from the web, the functions and the scripts.

import type { ActiveSubscriptionSummary, SubscriptionRollupStatus } from '../types/contact'
import type { SubscriptionLifecycleFields } from './subscriptionLifecycle'
import { subscriptionEndsAtMs, subscriptionIsCancelling } from './subscriptionLifecycle'

/** Lower index = "more live". The best (min) across a contact's subscriptions wins. */
export const SUBSCRIPTION_ROLLUP_PRIORITY: SubscriptionRollupStatus[] = [
  'active',
  'trialing',
  'past_due',
  'paused',
  'cancelled',
  'none',
]

/**
 * The fields of a `member_subscriptions` record this computation reads.
 *
 * Extends `SubscriptionLifecycleFields` rather than redeclaring the cancellation
 * shape, so the "whether/when" questions are answered by the same predicates
 * every other surface uses and a record accepted here is a record they accept.
 */
export interface MemberSubscriptionRollupInput extends SubscriptionLifecycleFields {
  pause_collection?: unknown
  subscriptionTypeId?: string | null
  subscriptionTypeName?: string | null
  recurrence?: string | null
  amount?: number
  duplicate?: boolean
}

/**
 * Map ONE record to a rollup status. A set `pause_collection` wins — a
 * deliberate billing freeze — otherwise the Stripe lifecycle status maps over.
 */
export function memberSubscriptionRollupStatus(
  rec: MemberSubscriptionRollupInput
): SubscriptionRollupStatus {
  if (rec.pause_collection) return 'paused'
  switch (rec.status ?? undefined) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'paused':
      return 'paused'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    default:
      return 'none' // incomplete, incomplete_expired, …
  }
}

export interface MemberSubscriptionRollup {
  /** The single value the contacts list, detail and automation conditions read. */
  status: SubscriptionRollupStatus
  /** The LIVE subscriptions, deduped by the studio's stable type id. */
  activeSubscriptions: ActiveSubscriptionSummary[]
}

/**
 * Roll ALL of one contact's member subscriptions up into the two fields the
 * contact document carries.
 *
 * Refunded duplicates and legacy records with no `subscriptionTypeId` are
 * skipped from the LIST but still count toward the STATUS — a past_due record
 * with no type id still means the member is past due.
 */
export function rollupMemberSubscriptions(
  records: MemberSubscriptionRollupInput[]
): MemberSubscriptionRollup {
  let best: SubscriptionRollupStatus = 'none'
  const byType = new Map<string, ActiveSubscriptionSummary>()

  for (const data of records) {
    const s = memberSubscriptionRollupStatus(data)
    if (SUBSCRIPTION_ROLLUP_PRIORITY.indexOf(s) < SUBSCRIPTION_ROLLUP_PRIORITY.indexOf(best)) {
      best = s
    }

    const typeId = data.subscriptionTypeId ?? undefined
    const isLive = s === 'active' || s === 'trialing' || s === 'past_due' || s === 'paused'
    if (!typeId || !isLive || data.duplicate) continue
    const existing = byType.get(typeId)
    if (
      !existing ||
      SUBSCRIPTION_ROLLUP_PRIORITY.indexOf(s) < SUBSCRIPTION_ROLLUP_PRIORITY.indexOf(existing.status)
    ) {
      byType.set(typeId, {
        subscription_type_id: typeId,
        subscription_type_name: data.subscriptionTypeName ?? null,
        recurrence: data.recurrence ?? null,
        amount: Math.round(data.amount ?? 0) / 100, // Rappen → major units
        status: s,
        // A subscription that is canceled but still LIVE stays 'active' here —
        // the member still trains until it lapses. The date is what says it is
        // winding down, and it rides the summary so the member's own Space can
        // show it without reading member_subscriptions (which it cannot).
        cancels_at_ms: subscriptionEndsAtMs(data),
        // …and WHETHER, which the date cannot express on its own: a
        // pre-migration doc is canceling with no date to give, and a Space
        // keyed only on the date told that member nothing.
        cancelling: subscriptionIsCancelling(data),
      })
    }
  }

  return { status: best, activeSubscriptions: Array.from(byType.values()) }
}
