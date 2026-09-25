// "Cancels at period end" is a THIRD state, and this is the one place that says so.
//
// A subscription is not simply active or canceled. Between the two sits a
// subscription that is still LIVE — the member still trains, the studio still has
// access — but will not renew. Every surface that shows a subscription needs that
// state, and every one of them was getting it wrong in a different way, because
// Stripe expresses it in two ways and we only stored one of them.
//
// WHAT THE TWO EXPRESSIONS ACTUALLY ARE — verified against a live Stripe test
// account on 2026-04-22.dahlia, because the earlier description of them here was
// wrong in a way that leads a reader straight back into the bug:
//
//   • WE cancel through the API (`update{cancel_at_period_end:true}`)
//       → boolean TRUE **and** `cancel_at` = the period end, plus `canceled_at`
//         and `cancellation_details.reason: 'cancellation_requested'`.
//       It is NOT "the boolean and no timestamp" — Dahlia fills all four in.
//   • the member/studio cancels in the Stripe BILLING PORTAL, or anything that
//     sets an explicit `cancel_at` (including the modern
//     `update{cancel_at:'max_period_end'}` spelling)
//       → `cancel_at: <timestamp>`, and the boolean stays FALSE.
//
// So the BOOLEAN is what distinguishes the two paths; the TIMESTAMP is now
// common to both. Which is why nothing here may key off the presence of a date:
// see `subscriptionIsCancelling`.
//
// The webhook readers (functions/src/utils/stripe/objectShape.ts) collapse those
// two into the stored `cancel_at_period_end` + `cancel_at`. This file collapses
// the STORED fields into the three questions a UI asks: is it winding down
// (`subscriptionIsCancelling`), when does it stop (`subscriptionEndsAt`), and
// what is the record of the cancellation (`subscriptionCancellation`).
//
// Applies to both subscription kinds — a member's Stripe subscription on a
// studio's connected account (MemberSubscription) and a studio's own Linyup
// subscription (SaasSubscription). They had the same bug for the same reason, so
// they get the same predicate rather than two that can drift.

import type { Timestamp } from '../types/common'

/**
 * WHY the subscription is ending — Stripe's `cancellation_details.reason`.
 *
 * This is the field that changes what a studio should DO, which is why it is
 * stored rather than collapsed into the boolean: a member who chose to leave
 * needs a win-back, a member whose card gave out needs a new card. Treating
 * those two as one "cancelled" state was the whole point of the old boolean.
 */
export type SubscriptionCancellationReason =
  | 'cancellation_requested'
  | 'payment_disputed'
  | 'payment_failed'

/**
 * The churn survey answer, when the billing portal collected one. Stripe's
 * `cancellation_details.feedback` — a fixed enum, so it is translatable, unlike
 * the free-text comment beside it.
 *
 * Stripe also returns `feedback_option` (the id of a portal-configured custom
 * option). It is deliberately NOT stored: it is an opaque `pcfo_…` handle whose
 * label needs a second API call against the portal configuration, so storing it
 * would give a reader something it cannot display.
 */
export type SubscriptionCancellationFeedback =
  | 'customer_service'
  | 'low_quality'
  | 'missing_features'
  | 'other'
  | 'switched_service'
  | 'too_complex'
  | 'too_expensive'
  | 'unused'

/**
 * The stored mirror of Stripe's `cancellation_details`.
 *
 * WRITTEN WHOLE OR NOT AT ALL. Both rails persist their subscription with
 * `set(…, { merge: true })`, and Firestore DEEP-merges a nested map — so writing
 * only the keys that have values would leave a previous cancellation's
 * `feedback` standing behind a new `reason`. Every writer sets all three keys
 * (nulls included) or sets the whole field to null.
 */
export interface SubscriptionCancellationDetails {
  reason: SubscriptionCancellationReason | null
  feedback: SubscriptionCancellationFeedback | null
  /** Free text the member typed into the portal. Never translated, never parsed. */
  comment: string | null
}

/** The stored shape both subscription kinds share, as far as this question goes. */
export interface SubscriptionLifecycleFields {
  status?: string | null
  cancel_at_period_end?: boolean | null
  cancel_at?: Timestamp | null
  canceled_at?: Timestamp | null
  cancellation_details?: SubscriptionCancellationDetails | null
  current_period_end?: Timestamp | null
}

/**
 * Statuses in which the subscription has already STOPPED, and therefore has a
 * cancellation worth narrating in the past tense.
 *
 * Both spellings of canceled are here on purpose: Stripe writes `canceled`, the
 * SaaS rail's own vocabulary writes `cancelled`, and a set that knew only one of
 * them would silently drop half the ended subscriptions.
 *
 * `unpaid` is here deliberately, and it is the one that looks inconsistent: the
 * contact ROLLUP maps it to `past_due`, because that is the status a studio
 * chases. For THIS question it belongs on the ended side — dunning is exhausted,
 * and `cancellation_details.reason` will say `payment_failed`, which is exactly
 * the sentence worth showing.
 *
 * THIS SET IS THE ONLY STATUS GATE, and it disqualifies rather than qualifies —
 * see `subscriptionIsCancelling`. It does not need to be exhaustive over either
 * vocabulary, and that is now a safe property rather than a load-bearing one: an
 * unrecognised status (or a missing one) leaves a stored cancellation VISIBLE,
 * which is the direction that fails safe.
 */
const ENDED_STATUSES = new Set([
  'canceled',
  'cancelled',
  'unpaid',
  'incomplete_expired',
  'expired',
])

/**
 * Is this subscription winding down — still LIVE, but not renewing?
 *
 * WHETHER, ASKED SEPARATELY FROM WHEN, and that separation is the whole point of
 * this function existing beside `subscriptionEndsAt`.
 *
 * A stored doc can carry the WHETHER without the WHEN. Between Stripe moving the
 * period onto the subscription ITEM and the readers being fixed, every
 * `saas_subscriptions` and `member_subscriptions` doc was written by a writer
 * still reading it off the SUBSCRIPTION — so it stored `current_period_end: null`
 * and, having never read the field at all, no `cancel_at`. A CANCELING doc from
 * that window therefore carries `cancel_at_period_end: true` and no date
 * whatsoever. That window is every doc this codebase has ever written under
 * Dahlia, which is what makes it the working population rather than an edge case.
 *
 * So any surface that asks `subscriptionEndsAt(sub) !== null` to decide whether a
 * subscription is canceling gets `false` for exactly the studios that ARE
 * canceled and still live — hiding "Reactivate" from the only people who need
 * it, and showing an operator nothing where there is something. Ask THIS instead,
 * and treat the date as optional detail.
 *
 * Either expression counts (see the file header): the boolean, or a `cancel_at`
 * timestamp with the boolean left false.
 *
 * ── THE STATUS GATE DISQUALIFIES; IT DOES NOT QUALIFY ───────────────────────
 * This asked `LIVE_STATUSES.has(status)` for one round, which is the same
 * mistake as the date one level up: it demanded a SECOND fact to believe the
 * first. A doc whose `status` is absent then read as NOT canceling — and
 * status-less docs are not hypothetical. The SaaS webhook's
 * `subscription.updated` branch writes no `status` at all, and it persists with
 * `set(…, {merge:true})`, so a `customer.subscription.updated` that arrives for
 * a doc that does not exist yet (Stripe guarantees no ordering between it and
 * `…created`) CREATES one carrying the cancellation and no status. One such doc
 * was sitting in the emulator while this was being written:
 *
 *   saas_subscriptions/hmd — cancel_at_period_end: true, cancel_at set,
 *   current_period_end set, NO status. Written by event evt_1U4wq0Gz6xwscm1e…
 *
 * Under the old gate that org's billing page hid "Reactivate" from the owner and
 * the operator console showed an em-dash, which is the exact pair of symptoms
 * this whole file exists to end.
 *
 * So the question is "has it ALREADY ENDED", not "is it certified live". Every
 * status previously accepted still is (the two sets are disjoint), and the ones
 * in NEITHER set — absent, empty, `incomplete`, any future vocabulary — now
 * report the cancellation the doc plainly carries instead of swallowing it.
 */
export function subscriptionIsCancelling(
  sub: SubscriptionLifecycleFields | null | undefined
): boolean {
  if (!sub) return false
  if (!sub.cancel_at_period_end && !sub.cancel_at) return false
  return !ENDED_STATUSES.has((sub.status ?? '').toString())
}

/**
 * When this subscription STOPS, if it is winding down AND the date is known —
 * otherwise null.
 *
 * Returns null for a subscription that is simply renewing (nothing to announce),
 * for one that has already ended (that is the past, and the UI already says so
 * through `status`), and for one that is canceling on a date we do not have.
 * The date prefers Stripe's explicit `cancel_at`, falling back to the period end.
 *
 * ⚠ NULL HERE DOES NOT MEAN "NOT CANCELING" — see `subscriptionIsCancelling`.
 * Gate UI on that; use this only to fill in a date.
 */
export function subscriptionEndsAt(sub: SubscriptionLifecycleFields | null | undefined): Timestamp | null {
  if (!subscriptionIsCancelling(sub)) return null
  return sub!.cancel_at ?? sub!.current_period_end ?? null
}

/** `subscriptionEndsAt` as epoch milliseconds, for mirrors that store plain numbers. */
export function subscriptionEndsAtMs(
  sub: SubscriptionLifecycleFields | null | undefined
): number | null {
  const ts = subscriptionEndsAt(sub)
  if (!ts) return null
  return typeof ts.toMillis === 'function' ? ts.toMillis() : ts.seconds * 1000
}

/** Everything a surface needs to narrate a cancellation, or null when there is none. */
export interface SubscriptionCancellationRecord {
  /**
   * When it stops. Null once it already has — `ended` then says so — and ALSO
   * null on a doc that is canceling without a stored date (the pre-migration
   * population). A reader that needs "is it canceling" must not infer it from
   * this field; the record being non-null is that answer.
   */
  endsAt: Timestamp | null
  /** True once the subscription has actually stopped. */
  ended: boolean
  /** When the cancellation was REQUESTED. Null on docs written before it was stored. */
  requestedAt: Timestamp | null
  reason: SubscriptionCancellationReason | null
  feedback: SubscriptionCancellationFeedback | null
  comment: string | null
}

/**
 * The cancellation record, or null when there is nothing to narrate.
 *
 * Built on `subscriptionIsCancelling` rather than beside it, so "is it winding
 * down" has exactly one definition. Two states qualify:
 *
 *   • winding down — still live and not renewing, WHETHER OR NOT the stop date
 *     is known (a doc written before the Dahlia migration carries the boolean
 *     and no date; narrating it without the date beats not narrating it);
 *   • ended — the reason is still worth showing, and is the difference between
 *     "they left us" and "their card expired".
 *
 * A REACTIVATED subscription returns null even if a stale `canceled_at` survived
 * on the doc: the gate is the current lifecycle state, never the presence of a
 * cancellation field. That is deliberate — it means a writer that forgets to
 * clear one of these on reactivation produces stale data, not a wrong screen.
 */
export function subscriptionCancellation(
  sub: SubscriptionLifecycleFields | null | undefined
): SubscriptionCancellationRecord | null {
  if (!sub) return null
  const ended = ENDED_STATUSES.has((sub.status ?? '').toString())
  if (!subscriptionIsCancelling(sub) && !ended) return null
  const endsAt = subscriptionEndsAt(sub)
  const d = sub.cancellation_details ?? null
  return {
    endsAt,
    ended,
    requestedAt: sub.canceled_at ?? null,
    reason: d?.reason ?? null,
    feedback: d?.feedback ?? null,
    comment: d?.comment ?? null,
  }
}

/**
 * The statuses a member subscription is LIVE under — what the payments page
 * lists and what the public API calls "live". `paused` is not in
 * `MemberSubscriptionStatus` (Stripe's `pause_collection` keeps `active`), kept
 * for a doc that carries it anyway. Queried with `in` on the (`status`,
 * `created_at`) index (firestore.index.json).
 */
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'paused'] as const
