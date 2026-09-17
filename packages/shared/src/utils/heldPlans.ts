// ─── The ONE builder of a contact's plan list ────────────────────────────────
//
// Pure: the three stores go in, the mirror comes out. `recomputeHeldPlans`
// (packages/functions/src/sync/heldPlans.ts) is the only caller that writes
// the result; anything else that needs "what does this contact hold" reads the
// mirror or calls this with the same inputs. Fixtures:
// packages/functions/src/contacts/heldPlans.test.ts.

import type { CreditSummaryEntry } from '../types/contact'
import {
  holdingIsCurrent,
  type HeldPlan,
  type HeldPlanSource,
  type HeldPlanStatus,
  type HeldPlansMirror,
  type PlanGrantSource,
} from '../types/planHoldings'
import { memberSubscriptionRollupStatus, type MemberSubscriptionRollupInput } from './subscriptionRollup'
import { subscriptionEndsAtMs, subscriptionIsCancelling } from './subscriptionLifecycle'

type MillisLike = { toMillis(): number } | null | undefined

/** A plan grant as the builder reads it — any SDK's Timestamp will do. */
export interface PlanGrantInput {
  id: string
  subscription_type_id?: string | null
  subscription_type_name?: string | null
  price_id?: string | null
  recurrence?: string | null
  amount?: number | null
  source?: PlanGrantSource | null
  starts_at?: MillisLike
  expires_at?: MillisLike
  ended_at?: MillisLike
}

/** A member subscription as the builder reads it. */
export interface HeldPlanMemberSubscriptionInput extends MemberSubscriptionRollupInput {
  subscriptionId?: string | null
}

export interface HeldPlansInput {
  grants: readonly PlanGrantInput[]
  memberSubscriptions: readonly HeldPlanMemberSubscriptionInput[]
  /** As `buildCreditSummary` produces it: exhausted and expired packs already out. */
  creditSummary: readonly Pick<
    CreditSummaryEntry,
    'subscription_type_id' | 'subscription_type_name' | 'remaining' | 'next_expires_at'
  >[]
  nowMs: number
}

const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused'])
const SOURCE_ORDER: Record<HeldPlanSource, number> = { grant: 0, stripe: 1, credits: 2 }

function ms(t: MillisLike): number | null {
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null
}

/** Code-unit order, so the result is identical in every runtime and locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** One subscription type as the payment snapshot needs it. */
export interface PlanHoldingForPayment {
  /** Studio price ids of the grants holding this type — what decides whether the
   *  holding is unmetered or credit-metered. Stripe entries carry none. */
  priceIds: string[]
  /** Held by a grant or a Stripe subscription, not only by a credit pack. */
  heldAsPlan: boolean
  /** The credit pack holding this type, when one does. */
  credits: { remaining: number; expiresAtMs: number | null } | null
}

/**
 * The plan list, grouped by type, for the payment snapshot
 * (`loadContactPaymentContext`). Only entries held at `nowMs` count. The price
 * id comes from each ENTRY, so every held plan is classified by the price it was
 * given — not only the one the legacy slot happened to name.
 */
export function paymentHoldingsByType(
  contact: { held_plans?: ReadonlyArray<HeldPlan> | null } | null | undefined,
  nowMs: number
): Map<string, PlanHoldingForPayment> {
  const byType = new Map<string, PlanHoldingForPayment>()
  for (const entry of contact?.held_plans ?? []) {
    if (!holdingIsCurrent(entry, nowMs)) continue
    const holding = byType.get(entry.subscription_type_id) ?? {
      priceIds: [],
      heldAsPlan: false,
      credits: null,
    }
    if (entry.source === 'credits') {
      holding.credits = { remaining: entry.credits_remaining ?? 0, expiresAtMs: entry.ends_at_ms }
    } else {
      holding.heldAsPlan = true
      if (entry.price_id && !holding.priceIds.includes(entry.price_id)) holding.priceIds.push(entry.price_id)
    }
    byType.set(entry.subscription_type_id, holding)
  }
  return byType
}

/** Is this grant held right now: not ended, started, and not past its expiry. */
export function planGrantIsHeld(grant: PlanGrantInput, nowMs: number): boolean {
  if (grant.ended_at != null) return false
  const start = ms(grant.starts_at)
  if (start !== null && start > nowMs) return false
  const end = ms(grant.expires_at)
  return end === null || end > nowMs
}

export function buildHeldPlans(input: HeldPlansInput): HeldPlansMirror {
  const { nowMs } = input
  const entries: HeldPlan[] = []
  /** Future instants at which the list changes without any write. */
  const changes: number[] = []

  // ── Grants: one entry per type, the latest end winning (decision D4) ──────
  const byType = new Map<string, { grant: PlanGrantInput; start: number | null; end: number | null }>()
  const endKey = (end: number | null) => (end === null ? Number.POSITIVE_INFINITY : end)
  for (const grant of input.grants) {
    const typeId = grant.subscription_type_id
    if (!typeId || grant.ended_at != null) continue
    const start = ms(grant.starts_at)
    const end = ms(grant.expires_at)
    if (start !== null && start > nowMs) {
      changes.push(start) // not held yet: the list changes when it starts
      continue
    }
    if (end !== null && end <= nowMs) continue
    if (end !== null) changes.push(end)
    const current = byType.get(typeId)
    if (!current) {
      byType.set(typeId, { grant, start, end })
      continue
    }
    const wins =
      endKey(end) > endKey(current.end) ||
      (endKey(end) === endKey(current.end) && cmp(grant.id, current.grant.id) < 0)
    byType.set(typeId, {
      grant: wins ? grant : current.grant,
      end: wins ? end : current.end,
      start: current.start === null ? start : start === null ? current.start : Math.min(current.start, start),
    })
  }
  for (const [typeId, { grant, start, end }] of byType) {
    entries.push({
      subscription_type_id: typeId,
      subscription_type_name: grant.subscription_type_name ?? null,
      source: 'grant',
      ...(grant.source ? { grant_source: grant.source } : {}),
      status: 'active',
      starts_at_ms: start,
      ends_at_ms: end,
      price_id: grant.price_id ?? null,
      amount: grant.amount ?? null,
      recurrence: grant.recurrence ?? null,
      ref: grant.id,
    })
  }

  // ── Stripe: one entry per live subscription ──────────────────────────────
  for (const sub of input.memberSubscriptions) {
    const typeId = sub.subscriptionTypeId
    if (!typeId || sub.duplicate) continue
    const rollup = memberSubscriptionRollupStatus(sub)
    if (!LIVE_STRIPE_STATUSES.has(rollup)) continue
    const cancelling = subscriptionIsCancelling(sub)
    const status: HeldPlanStatus =
      cancelling && (rollup === 'active' || rollup === 'trialing') ? 'cancelling' : (rollup as HeldPlanStatus)
    entries.push({
      subscription_type_id: typeId,
      subscription_type_name: sub.subscriptionTypeName ?? null,
      source: 'stripe',
      status,
      starts_at_ms: null,
      ends_at_ms: subscriptionEndsAtMs(sub),
      next_charge_at_ms: cancelling || rollup === 'paused' ? null : ms(sub.current_period_end),
      price_id: null,
      amount: typeof sub.amount === 'number' ? Math.round(sub.amount) / 100 : null, // Rappen → major units
      recurrence: sub.recurrence ?? null,
      ref: sub.subscriptionId || typeId,
    })
  }

  // ── Credit packs: one entry per type ─────────────────────────────────────
  for (const pack of input.creditSummary) {
    if (!pack.subscription_type_id || !(pack.remaining > 0)) continue
    const end = ms(pack.next_expires_at)
    if (end !== null && end <= nowMs) continue
    if (end !== null) changes.push(end)
    entries.push({
      subscription_type_id: pack.subscription_type_id,
      subscription_type_name: pack.subscription_type_name ?? null,
      source: 'credits',
      status: 'active',
      starts_at_ms: null,
      ends_at_ms: end,
      price_id: null,
      amount: null,
      recurrence: null,
      credits_remaining: pack.remaining,
      ref: pack.subscription_type_id,
    })
  }

  entries.sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      cmp(a.subscription_type_id, b.subscription_type_id) ||
      cmp(a.ref, b.ref)
  )
  const future = changes.filter((t) => t > nowMs)
  return {
    held_plans: entries,
    held_plan_type_ids: [...new Set(entries.map((e) => e.subscription_type_id))].sort(cmp),
    held_plans_next_change_at_ms: future.length ? Math.min(...future) : null,
  }
}
