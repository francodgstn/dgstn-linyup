// Stripe Connect — member → studio payments.
//
// This is the THIRD, distinct payment concern in Linyup; keep it separate from:
//   1. Linyup SaaS billing  (Linyup charges studios — saas-billing/, getPlatformStripeAdapter)
//   2. BYO team gateways    (studio charges members on an INDEPENDENT account, no platform fee —
//                            integration.ts / handlePayrexxWebhook)
//   3. THIS: Connect        (studio charges members; money settles on the STUDIO's Stripe
//                            balance; Linyup takes a configurable application fee)
//
// Architecture (locked — see the implementation brief):
//   • Accounts v2 API + controller properties (NOT legacy Standard/Express/Custom).
//   • Direct charges on the connected (studio) account with application_fee_amount.
//     Member funds NEVER pass through or settle into Linyup's own Stripe balance.
//   • controller.fees.payer = account on BOTH models (studio bears Stripe processing fees;
//     the application fee is clean platform margin).
//   • CHF only in Phase 1. All monetary amounts are INTEGER minor units (Rappen) — never floats.

import type { Timestamp } from './common'
import type { PaymentLineItem } from './payment'
import type { SaasPlan, TenantFlags } from './team'
import type { SubscriptionCancellationDetails } from '../utils/subscriptionLifecycle'

// ─── Onboarding model (HISTORICAL — the two members are indistinguishable) ──────
// This began as a real choice: `byo` would link a studio's PRE-EXISTING Stripe
// account (studio bears losses), `managed` would create a platform-branded one
// (Stripe bears losses). The implementation never split that way — a Stripe
// test-mode constraint collapsed both onto ONE account configuration in June
// 2026 — and this comment went on describing the abandoned design, in the
// present tense, until 2026-08-23.
//
// What onboarding ACTUALLY produces — dashboard access, responsibilities, and
// why there is only one configuration — is stated ONCE, at the owner:
// packages/functions/src/utils/connect/client.ts, on MODEL_DASHBOARD. Do not
// restate it here. This comment restated it once and was wrong for two months.
//
// Both members therefore produce a byte-identical connected account. The value
// is carried and persisted (teams/{id}.payments.connectModel,
// connect_accounts/{acct}.model) but branches NO behaviour — computePlatformFee
// accepts it and deliberately ignores it. It survives because existing documents
// store it; new onboarding always records 'managed'.
//
// Nothing in this repo links a pre-existing Stripe account: that needs the
// Standard OAuth flow (connect.stripe.com/oauth/authorize), which is not
// implemented. Signing into Stripe from the hosted onboarding link only prefills
// verified details onto the new account. The studio-facing copy and the
// two-option picker that promised otherwise were removed on 2026-08-23.
export type ConnectOnboardingModel = 'byo' | 'managed'

// ─── Take-rate (platform application fee) ────────────────────────────────────────
// Per Linyup plan tier. Configurable — NEVER hardcode a fee anywhere else; always
// go through computePlatformFee(). Stored in basis points (1% = 100 bps) so every
// value is an integer and the fee math stays in integer Rappen.
//
// Take-rates (revised 2026-08-29, pre-launch commercial review): Free 2.5 /
// Coach 1.5 / Studio 0.8 / Org 0.5 %. Supersedes the 2026-06-20 set
// (1.7 / 1.2 / 0.7 / 0.4). "Studio" is the tier the brief calls "Club"
// (renamed pre-launch; the id `studio` is the stable machine identifier).
export interface ConnectTakeRate {
  /** Platform application fee in basis points (integer). 100 bps = 1%. */
  bps: number
  /**
   * Minimum platform fee in Rappen, applied when the percentage rounds below it.
   * 0 = no minimum. The fee is always clamped to never exceed the charge amount.
   */
  minFeeRappen: number
}

export const CONNECT_TAKE_RATE: Record<SaasPlan, ConnectTakeRate> = {
  free: { bps: 250, minFeeRappen: 0 }, // 2.5%
  coach: { bps: 150, minFeeRappen: 0 }, // 1.5%
  studio: { bps: 80, minFeeRappen: 0 }, // 0.8%
  organization: { bps: 50, minFeeRappen: 0 }, // 0.5%
}

export interface PlatformFeeInput {
  /** The studio's Linyup plan tier — selects the take-rate. */
  tier: SaasPlan
  /** Gross charge amount in Rappen (integer minor units). */
  amount: number
  /**
   * The tenant is COMPED — Linyup takes nothing from this payment.
   *
   * An EXPLICIT boolean, and deliberately not a fifth `CONNECT_TAKE_RATE` row or
   * a nullable tier. The fallback below answers an unknown tier with the HIGHEST
   * rate specifically so a misconfiguration cannot ship a free transaction; a
   * zero rate reachable by omitting or mistyping something would undo that in
   * the one direction that costs money silently. Absent still means CHARGE.
   *
   * Resolved server-side by `loadEnabledTeam` from `flags.comped` on the team,
   * or on its organisation — never read off a client payload.
   */
  waived?: boolean
  /**
   * The tenant's RESOLVED rate — `resolveTakeRate(...).rate`, carried on the
   * server's `EnabledTeam`. Absent = the tier's published rate, so a caller
   * that forgets it charges the published rate, never less.
   */
  rate?: ConnectTakeRate
  /**
   * Onboarding model. Reserved: both models currently use the same take-rate and
   * fee-payer (account), but the fee function takes the model so per-model
   * adjustments can be added without touching call sites. See the brief §6.
   */
  model?: ConnectOnboardingModel
}

/**
 * Pure take-rate math against an explicit rate. Kept separate from
 * computePlatformFee so the rounding / min-fee / clamp branches are unit-testable
 * with synthetic rates (the live config currently has minFeeRappen = 0).
 *
 * Returns the fee in INTEGER Rappen:
 *   • amount <= 0   → 0                       (zero-fee handling)
 *   • otherwise     → floor(amount * bps / 10000), raised to minFeeRappen, then
 *                     clamped to never exceed `amount`.
 *
 * Throws if `amount` is not an integer — guards against accidental float Rappen.
 */
export function applyTakeRate(amount: number, rate: ConnectTakeRate): number {
  if (!Number.isInteger(amount)) {
    throw new Error(`applyTakeRate: amount must be an integer (Rappen), got ${amount}`)
  }
  if (amount <= 0) return 0

  // Integer math only: floor(amount * bps / 10000).
  let fee = Math.floor((amount * rate.bps) / 10000)

  // Minimum-fee handling (e.g. cover fixed costs on tiny charges).
  if (rate.minFeeRappen > 0) fee = Math.max(fee, rate.minFeeRappen)

  // The platform fee can never exceed the charge itself (Stripe rejects it, and
  // a min-fee on a sub-min charge would otherwise over-charge).
  return Math.min(fee, amount)
}

/**
 * THE central platform-fee calculation. One function, config-driven, used by both
 * the Cloud Functions (to set application_fee_amount) and the web UI (to display
 * the take-rate). No magic numbers anywhere else. Unknown tier falls back to the
 * highest (free) rate, never zero — so a misconfiguration never silently ships a
 * free transaction.
 */
export function computePlatformFee({ tier, amount, waived, rate }: PlatformFeeInput): number {
  if (waived === true) return 0
  return applyTakeRate(amount, rate ?? CONNECT_TAKE_RATE[tier] ?? CONNECT_TAKE_RATE.free)
}

/**
 * The take-rate as a PERCENT, for recurring subscriptions where Stripe applies
 * the platform fee per invoice via `application_fee_percent` (a percentage, not a
 * fixed Rappen amount). 200 bps → 2. Min-fee does not apply to the percent path.
 * Same central config as computePlatformFee — never hardcode a percentage.
 */
export function takeRatePercent(tier: SaasPlan, waived?: boolean, rate?: ConnectTakeRate): number {
  if (waived === true) return 0
  return (rate ?? CONNECT_TAKE_RATE[tier] ?? CONNECT_TAKE_RATE.free).bps / 100
}

// ─── Per-tenant rate: THE ONE RESOLVER ───────────────────────────────────────────
// Which take-rate applies to one studio's member payment. Pure, so the web, the
// functions and the operator console answer identically. Order:
//
//   comped (team or org) → the team's negotiated rate → its org's → the plan.
//
// Two rules, both in the direction of never charging MORE than was published:
//   • a negotiated rate is capped at the plan's published rate — it is a
//     discount, and a studio that later upgrades to a cheaper tier gets the
//     cheaper tier rather than keeping an old deal that is now worse;
//   • anything malformed (non-integer bps, out of range, unreadable expiry) is
//     ignored and the published rate applies — the fallback CHARGES.

/** Where the applied rate came from. `plan` also covers a negotiated rate that
 *  is no lower than the published one, since it changed nothing. */
export type TakeRateSource = 'plan' | 'team_rate' | 'org_rate' | 'comped'

export interface ResolvedTakeRate {
  rate: ConnectTakeRate
  source: TakeRateSource
  /** Epoch ms the negotiated rate stops applying; null when open-ended or not negotiated. */
  expiresAtMs: number | null
}

/** A negotiated rate that is well-formed and in force at `nowMs`, or null. */
export function activeNegotiatedRate(
  flags: TenantFlags | null | undefined,
  nowMs: number
): { bps: number; expiresAtMs: number | null } | null {
  const r = flags?.fee_rate
  if (!r) return null
  if (!Number.isInteger(r.bps) || r.bps < 0 || r.bps > 10_000) return null
  if (r.expires_at == null) return { bps: r.bps, expiresAtMs: null }
  const expiresAtMs = typeof r.expires_at.toMillis === 'function' ? r.expires_at.toMillis() : NaN
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null
  return { bps: r.bps, expiresAtMs }
}

/**
 * The `expires_at` instant for a rate whose LAST DAY is `lastDay` ('YYYY-MM-DD'):
 * the start of the following day in `timeZone`. A deal "until 31 December" is
 * agreed in the studio's calendar, not in UTC, so the rate must still apply at
 * 23:30 Zurich time on the 31st. Null for a malformed date.
 */
export function negotiatedRateExpiresAtMs(lastDay: string, timeZone = 'Europe/Zurich'): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastDay)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null // 2026-02-30 and the like
  }
  // Midnight of the NEXT day as a wall-clock reading, then corrected by the
  // zone's offset at that instant. Two passes settle a DST boundary.
  const wall = Date.UTC(y, mo - 1, d + 1)
  const offsetAt = (ms: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ms
  }
  const first = wall - offsetAt(wall)
  return wall - offsetAt(first)
}

export function resolveTakeRate(input: {
  tier: SaasPlan
  teamFlags?: TenantFlags | null
  /** The team's organisation's flags; null/absent when it has none or the read failed. */
  orgFlags?: TenantFlags | null
  nowMs: number
}): ResolvedTakeRate {
  const published = CONNECT_TAKE_RATE[input.tier] ?? CONNECT_TAKE_RATE.free

  if (input.teamFlags?.comped === true || input.orgFlags?.comped === true) {
    return { rate: { bps: 0, minFeeRappen: 0 }, source: 'comped', expiresAtMs: null }
  }

  const team = activeNegotiatedRate(input.teamFlags, input.nowMs)
  const org = team ? null : activeNegotiatedRate(input.orgFlags, input.nowMs)
  const negotiated = team ?? org
  if (!negotiated || negotiated.bps >= published.bps) {
    return { rate: published, source: 'plan', expiresAtMs: null }
  }
  return {
    // A zero rate means no fee at all, so the minimum must not reintroduce one.
    rate: { bps: negotiated.bps, minFeeRappen: negotiated.bps === 0 ? 0 : published.minFeeRappen },
    source: team ? 'team_rate' : 'org_rate',
    expiresAtMs: negotiated.expiresAtMs,
  }
}

/**
 * Does a zero fee mean "no application fee object" to Stripe?
 *
 * YES, and it matters at exactly one place. `application_fee_amount: 0` is
 * ACCEPTED on a direct charge (verified against a live test-mode connected
 * account, 2026-08-28) — but the charge it produces has NO application fee, so a
 * later refund carrying `refund_application_fee: true` is REFUSED outright:
 *
 *   "Attempting to refund_application_fee on ch_..., but it has no application fee"
 *
 * So the refund flag must be conditional on the charge actually having one.
 * This is not new with comping: at 80 bps any charge under CHF 1.25 already
 * floors to a zero fee, so the same refusal has always been reachable — comping
 * only makes it every refund at the tenant rather than a rare small one.
 */
export function chargeHasApplicationFee(applicationFeeAmount: number | null | undefined): boolean {
  return typeof applicationFeeAmount === 'number' && applicationFeeAmount > 0
}

// ─── Connected-account state ────────────────────────────────────────────────────
// Persisted at connect_accounts/{stripeAccountId} (TOP-LEVEL, keyed by the Stripe
// account id) so the Connect webhook can resolve event.account → teamId with a
// single direct doc read — no reverse query, no composite index. A pointer
// (teams/{teamId}.payments.connectAccountId) is mirrored for the dashboard.
export type ConnectAccountStatus =
  | 'pending' // account created, onboarding not yet complete
  | 'restricted' // requirements due or a capability disabled — needs attention
  | 'enabled' // charges_enabled && payouts_enabled
  | 'rejected' // Stripe rejected the account

export interface ConnectAccount {
  teamId: string
  /** Stripe connected account id (acct_...). Also the Firestore doc id. */
  stripeAccountId: string
  model: ConnectOnboardingModel
  status: ConnectAccountStatus
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  /**
   * Capability → state map (e.g. { card_payments: 'active', twint_payments: 'pending' }).
   * Phase 1 requires card_payments + twint_payments active before charging.
   */
  capabilities: Record<string, string>
  /** Requirements Stripe needs now, for the "finish setup" UX. Never contains PII values. */
  requirements_currently_due: string[]
  /** Set when a capability is disabled (e.g. 'requirements.past_due'). */
  requirements_disabled_reason?: string | null
  default_currency: string // 'chf' in Phase 1
  /** Idempotency: last processed account.updated / capability.updated event id. */
  last_event_id?: string
  created_at: Timestamp
  updated_at: Timestamp
}

// ─── One-off payments (direct charge) ────────────────────────────────────────────
// Persisted at teams/{teamId}/member_payments/{paymentIntentId}. Function-written
// only; never trusted from the client. Reconciled from webhook events.
export type MemberPaymentStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'refunded' // fully refunded
  | 'partially_refunded'

export interface MemberPaymentRefund {
  refundId: string // re_...
  amount: number // Rappen refunded
  /** Application fee reversed for this refund (Rappen) — proportional to the refund. */
  feeReversed: number
  reason?: string
  created_at: Timestamp
}

export interface MemberPayment {
  teamId: string
  /** Stripe PaymentIntent id (pi_...). Also the Firestore doc id. */
  paymentIntentId: string
  chargeId?: string // ch_... (populated on success)
  /** Linyup contact this payment is for, when known. */
  contactId?: string | null
  /** Free-form purpose tag, e.g. 'drop_in' | 'belt_test' | 'shop'. */
  purpose: string
  /** Sale kind for display, denormalized from checkout metadata (absent on plain
   *  manager-created charges). Drives the payments-dashboard row label.
   *
   *  The union is DERIVED FROM ITS SINGLE WRITER — `handlePaymentIntent` in
   *  `connect/webhook.ts`, which is the only code that ever sets this field.
   *  It declared four members for a long time while the writer stamped seven;
   *  `'appointment'`, `'gift_card'` and `'policy_fee'` were being written into a
   *  type that said they could not exist. If you add a `kind` branch there, add
   *  it here in the same edit — and check the writer, not this comment. */
  kind?:
    | 'product'
    | 'course'
    | 'course_block'
    | 'drop_in'
    | 'membership'
    | 'appointment'
    | 'gift_card'
    | 'policy_fee'
  productName?: string | null
  variantLabel?: string | null
  /** kind 'course' (the online-courses plugin) or 'course_block' (a scheduled
   *  course): the name that goes on the payments row. One field for both,
   *  because a row carries one or the other and both answer "what was bought". */
  courseName?: string | null
  /** kind 'course_block': WHICH scheduled course. The top-level `kind` is what
   *  puts the sale in the accounts (`mapCategory` reads it and nothing else),
   *  and this is what links the row back to the course. */
  courseBlockId?: string | null
  /** kind 'membership': the subscription type's display name (also stamped onto
   *  recurring invoice charges by the webhook, which carry no metadata of their own). */
  subscriptionTypeName?: string | null
  /** kind 'membership' on a subscription's charges: WHICH Stripe subscription
   *  it paid — stamped on the first charge by checkout and on every renewal by
   *  handleInvoice — so a payment links to its plan card exactly, not by plan
   *  type (docs/multi-plan-holdings.md §5). Absent on rows written before. */
  subscriptionId?: string | null
  /** Set for drop-in (pay-per-class) charges — the booked session. */
  sessionId?: string | null
  /**
   * Structured "what was bought", aligned with ExternalPayment.line_item so the
   * unified payments view + assign/edit dialog treat both rails the same.
   * Stamped by the webhook from checkout metadata (kind 'membership' →
   * line-item kind 'subscription'); a manager can adjust it via
   * updatePaymentRecord. Absent on legacy rows — the UI falls back to a
   * label-only value derived from kind/names.
   */
  line_item?: PaymentLineItem | null
  description?: string
  /**
   * Generic "what was paid" note, aligned with ExternalPayment.comment so the
   * unified payments view treats both rails the same. Connect rows derive a
   * default from their structured detail (subscription type / product / course /
   * purpose); a manager can override it via updatePaymentRecord.
   */
  comment?: string | null
  amount: number // gross Rappen
  currency: string // 'chf'
  /** Platform application fee taken (Rappen) — from computePlatformFee. */
  application_fee_amount: number
  /** The rate that fee was charged at (bps), stamped at checkout. Absent on older payments. */
  platform_fee_bps?: number
  /** Why that rate applied. Absent on older payments. */
  platform_fee_source?: TakeRateSource | null
  status: MemberPaymentStatus
  amount_refunded: number // cumulative Rappen refunded
  refunds: MemberPaymentRefund[]
  // Dispute / chargeback (set by charge.dispute.* events). Liability depends on
  // the onboarding model: BYO → studio; Managed → Stripe.
  dispute_status?: string
  dispute_reason?: string | null
  dispute_amount?: number | null
  /** Idempotency: last processed payment_intent/charge event id for this doc. */
  last_event_id?: string
  /**
   * What happened to the ACCESS this payment bought when it was refunded.
   * Reporting, not correctness: the reversal itself is one transaction and does
   * not read this back. It exists so a manager can see, on the row, that the
   * money went back but the entitlement did not — the one failure mode a refund
   * has that is otherwise completely silent.
   */
  effects_reversal?: MemberPaymentEffectsReversal | null
  created_at: Timestamp
  updated_at: Timestamp
}

/** Per-target result of one reversal attempt. `skipped_not_owner` means the
 *  thing is still there and SHOULD be: a later payment, a manual grant or a
 *  gift-card purchase owns it. `absent` means there was nothing there. */
export type ReversalTargetOutcome =
  | 'left' // the plan said not to touch it
  | 'absent'
  | 'skipped_not_owner'
  | 'cleared' // the retired plan slot, on rows written before the plan list
  | 'reduced' // credit grant
  | 'deleted' // course entitlement
  | 'ended' // plan grant — the row stays, with ended_at set

export interface MemberPaymentEffectsReversal {
  /** 'done' — the transaction committed. 'failed' — the MONEY moved and this
   *  did not; the studio has to take the access back by hand. */
  state: 'done' | 'failed'
  at: Timestamp
  /** uid of the manager who asked for the refund. */
  by?: string | null
  /** Whether the refund that triggered it was full or partial (Rappen). */
  refund_amount?: number | null
  /** Rows written before the plan list replaced the single plan slot only:
   *  what happened to that slot. Nothing writes it now — see `plan_grant`. */
  subscription?: ReversalTargetOutcome
  credits?: ReversalTargetOutcome
  /** Credits taken back by this reversal (0 when none were). */
  credits_revoked?: number
  course?: ReversalTargetOutcome
  /** The plan grant the refunded payment made (docs/multi-plan-holdings.md). */
  plan_grant?: ReversalTargetOutcome
  /** Present only when state === 'failed'. */
  error?: string | null
}

// ─── Recurring memberships (subscription on the connected account) ────────────────
// Persisted at teams/{teamId}/member_subscriptions/{subscriptionId}.
export type MemberSubscriptionStatus =
  | 'incomplete'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'

export interface MemberSubscription {
  teamId: string
  /** Stripe Subscription id (sub_...), on the connected account. Also the doc id. */
  subscriptionId: string
  /** Stripe Customer id (cus_...) on the connected account. */
  customerId: string
  contactId?: string | null
  priceId: string
  /**
   * The STUDIO's stable subscription-type identity (from checkout metadata), as opposed
   * to `priceId` which is Stripe's ad-hoc price id (regenerated each checkout because
   * prices are inline price_data). Used to detect/prevent a second subscription of the
   * same type and to roll up Contact.active_subscriptions. Absent on legacy docs.
   */
  subscriptionTypeId?: string | null
  subscriptionTypeName?: string | null
  recurrence?: string | null
  amount: number // per-period Rappen
  currency: string // 'chf'
  /** Platform fee taken per invoice, as a percent (Stripe application_fee_percent). */
  application_fee_percent?: number
  status: MemberSubscriptionStatus
  /**
   * Start of the current billing period — WHICH SERVICE PERIOD the latest
   * invoice bought. Stored for accrual readiness (spreading a quarterly/annual
   * charge over its covered months needs the pair, and Stripe's period data is
   * not re-fetchable for the BYO/manual rails — see docs/finance-accrual.md,
   * Phase 0): nothing in web or admin reads it yet. Same source as the end
   * (`readSubscriptionPeriod`, always the same item, so the pair is coherent).
   * Absent on docs written before 2026-08-31; `backfill:subscription-lifecycle`
   * repairs those from Stripe. Readers must tolerate absence.
   */
  current_period_start: Timestamp | null
  /**
   * End of the current billing period. Sourced from the subscription ITEM
   * (Stripe removed the subscription-level field in Basil) — see
   * `readSubscriptionPeriod` in functions/src/utils/stripe/objectShape.ts.
   */
  current_period_end: Timestamp | null
  /**
   * The subscription is scheduled to end rather than renew. TRUE for both ways
   * Stripe expresses that: the `cancel_at_period_end` boolean (set when WE
   * cancel through the API) and a `cancel_at` timestamp (how the BILLING PORTAL
   * expresses it, leaving the boolean false). Never read the raw Stripe boolean
   * in a handler — read it through `readSubscriptionCancellation`.
   */
  cancel_at_period_end: boolean
  /**
   * WHEN it ends, when Stripe told us.
   *
   * Absent on DOCS WRITTEN BEFORE THIS FIELD EXISTED — the entire pre-Dahlia
   * population, which stored the boolean and nothing else — so a reader wanting
   * a date falls back to `current_period_end`. That fallback is exactly what
   * `subscriptionEndsAt()` does; use it rather than repeating the choice.
   *
   * It is NOT absent on a cancellation made through our own API call. That was
   * stated here and is wrong: on 2026-04-22.dahlia, verified against a live test
   * account, `update{cancel_at_period_end: true}` comes back with `cancel_at`,
   * `canceled_at` AND `cancellation_details` all set. Both cancellation paths
   * carry a date today; only the BOOLEAN tells them apart (see the file header
   * of shared/utils/subscriptionLifecycle.ts). A reader that treats a missing
   * date as "cancelled by us" is reading a fact that has not been true since the
   * Dahlia migration.
   */
  cancel_at?: Timestamp | null
  /**
   * WHEN the cancellation was requested — the start of the notice period, where
   * `cancel_at` is the end of it. The gap between the two is the studio's
   * win-back window, which is the only reason it is worth a field.
   */
  canceled_at?: Timestamp | null
  /**
   * WHY it is ending. Written WHOLE or set to null — never key-by-key; both
   * writers merge, and Firestore deep-merges a nested map (see
   * SubscriptionCancellationDetails in shared/utils/subscriptionLifecycle.ts).
   *
   * Read it through `subscriptionCancellation()`, which gates on the current
   * lifecycle state rather than on the presence of these fields — so a stale
   * record left behind by a reactivation is stale data, not a wrong screen.
   */
  cancellation_details?: SubscriptionCancellationDetails | null
  /**
   * Payment method used, e.g. 'card' | 'twint'. TWINT recurring has a hard
   * constraint: only ONE active TWINT mandate per studio↔member pair.
   */
  payment_method_kind?: string
  // Latest invoice outcome (set by invoice.paid / invoice.payment_failed).
  last_invoice_id?: string
  last_payment_status?: 'paid' | 'failed'
  /** Idempotency: last processed subscription/invoice event id for this doc. */
  last_event_id?: string
  /**
   * Set true when the webhook auto-cancelled this subscription because the contact
   * already held a live subscription of the same type (duplicate that slipped past the
   * checkout guard). The Stripe sub is cancelled and its charge refunded.
   */
  duplicate?: boolean
  /**
   * Mirrors the Stripe pause_collection object when billing is frozen.
   * Present (non-null) when the subscription is paused; absent or null otherwise.
   * The backend sets this optimistically on pauseMemberSubscription /
   * resumeMemberSubscription before the webhook confirms.
   */
  pause_collection?: { behavior: string } | null
  created_at: Timestamp
  updated_at: Timestamp
}
