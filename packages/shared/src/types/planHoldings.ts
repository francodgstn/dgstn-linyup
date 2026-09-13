import type { Timestamp } from './common'

// ─── Plan holdings — a contact holds a LIST of plans ─────────────────────────
//
// docs/multi-plan-holdings.md. What a contact is on comes from three stores:
// Stripe subscriptions (`teams/{t}/member_subscriptions`), credit packs
// (`contacts/{c}/credit_grants`) and, new in phase 1, plan GRANTS
// (`contacts/{c}/plan_grants`) — every other holding: staff-assigned, bought
// one-off, paid through the studio's own gateway, imported. The contact
// carries ONE mirror of all three, built by `buildHeldPlans`
// (utils/heldPlans.ts) and written by ONE function, `recomputeHeldPlans`
// (packages/functions/src/sync/heldPlans.ts).

/** Where a grant came from. */
export type PlanGrantSource = 'staff' | 'purchase' | 'gateway' | 'import'

/** Why a grant stopped before its own end. */
export type PlanGrantEndedReason = 'staff' | 'refund' | 'changed'

/**
 * `contacts/{contactId}/plan_grants/{grantId}` — one holding that is not a
 * Stripe subscription or a credit pack. Written only by Cloud Functions and
 * the import backfill; the rules deny every client write.
 *
 * ROWS ARE EVENTS. Changing a plan ends one row and creates another; a row is
 * never edited into a different plan, so history and refunds stay exact.
 *
 * Doc id: the payment ref when a payment created it (idempotent against a
 * redelivered webhook, the idiom `credit_grants` and `plan_purchases` use),
 * otherwise an auto id. The import backfill uses one fixed id per contact.
 */
export interface PlanGrant {
  id?: string
  teamId: string
  subscription_type_id: string
  subscription_type_name: string | null
  price_id: string | null
  recurrence: string | null
  /** Major units, as the contact's legacy slot stored it. */
  amount: number | null
  source: PlanGrantSource
  /** The payment document id that created it, or null. */
  source_ref: string | null
  starts_at: Timestamp
  /** Null = no end of its own. */
  expires_at: Timestamp | null
  /** Set when it stopped early — staff ended it, a refund, a change of plan. */
  ended_at: Timestamp | null
  ended_reason: PlanGrantEndedReason | null
  created_by: string | null
  created_at: Timestamp
}

/** Which store an entry of `Contact.held_plans` comes from. */
export type HeldPlanSource = 'grant' | 'stripe' | 'credits'

/**
 * `cancelling` is a Stripe subscription that is still live but will not renew.
 * The rest mirror the member-subscription rollup's live statuses; grants and
 * credit packs are always `active`.
 */
export type HeldPlanStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'cancelling'

/**
 * One entry of `Contact.held_plans` — one plan the contact holds right now.
 *
 * TIMES ARE EPOCH MILLISECONDS, not Timestamps, for the reason
 * `ActiveSubscriptionSummary.cancels_at_ms` gives: a display mirror inside an
 * array, compared whole by value, and built by a pure function that cannot
 * mint an SDK Timestamp.
 *
 * Grants of one type are merged into ONE entry, the latest end winning
 * (decision D4). A Stripe subscription is one entry per subscription. A credit
 * pack is one entry per type, as `credit_summary` has it.
 */
export interface HeldPlan {
  subscription_type_id: string
  subscription_type_name: string | null
  source: HeldPlanSource
  /** Grants only: how the grant came to be. */
  grant_source?: PlanGrantSource
  status: HeldPlanStatus
  /** Null when the store does not know (a Stripe subscription, a credit pack). */
  starts_at_ms: number | null
  /** A grant's expiry, a Stripe subscription's end date, a pack's next expiry. */
  ends_at_ms: number | null
  /** Stripe only: the period end it renews at, while it will renew. */
  next_charge_at_ms?: number | null
  price_id: string | null
  /** Major units. */
  amount: number | null
  recurrence: string | null
  /** Credit packs only. */
  credits_remaining?: number
  /** The grant id, the Stripe subscription id, or the type id for credits. */
  ref: string
}

/** The three contact fields `recomputeHeldPlans` writes, always together. */
export interface HeldPlansMirror {
  held_plans: HeldPlan[]
  /** Unique and sorted — the flat list the rules and array-contains queries read. */
  held_plan_type_ids: string[]
  /**
   * The earliest future instant the list changes ON ITS OWN — a grant starting
   * or ending, a credit pack expiring — or null. Stripe changes arrive as
   * webhook events and trigger a recompute, so they are not counted.
   */
  held_plans_next_change_at_ms: number | null
}
