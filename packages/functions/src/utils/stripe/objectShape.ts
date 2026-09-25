/* eslint-disable no-console */
// Stripe object shape — the ONE place that knows WHERE a moved field lives.
//
// ─── Why this module exists ────────────────────────────────────────────────────
// Stripe moved (or removed) several fields we read, across the Basil (2025-03-31)
// → Dahlia (2026-04-22) API versions. Every one of those reads was `obj.field` on
// an `any`, so each silently produced `undefined`: no exception, no failing test,
// just wrong data written confidently. Three shipped defects came from exactly
// that — a subscription's first payment showing "unassigned", a null membership
// expiry, and a billing-portal cancellation surfacing nowhere. All three are
// described in the intro of docs/open-defects.md, which records them as shipped;
// THIS MODULE is their owner, so point new readers here rather than at a section
// number in a file that renumbers every time an entry ships.
//
// So every one of those reads now goes through this module, which:
//
//   1. reads the MODERN location first and falls back NARROWLY to the legacy one,
//      so a deployment pinned to an older apiVersion still works;
//   2. reports WHERE it found the value, so a caller can log loudly when the
//      answer is "nowhere" — a migration must arrive as an error, not as a null;
//   3. is TYPE-CHECKED against the installed SDK's own declarations (the
//      `_assert_*` types at the bottom of this file), so the next time Stripe
//      moves one of these fields the build fails instead of the data going quiet.
//
// ─── Why the SDK's types can be used here but not at the call sites ────────────
// `Stripe.Subscription` / `Stripe.Invoice` are NOT reachable from the default
// import in this SDK build (the namespace is not merged onto it — the note in
// utils/connect/client.ts is right about that). But the resource interfaces are
// still reachable indirectly, through the return type of the method that fetches
// them: `Awaited<ReturnType<StripeInstance['subscriptions']['retrieve']>>`. That
// is what the `Stripe*Object` aliases below do, and it is what makes the
// compile-time assertions at the bottom possible at all.
//
// Webhook payloads arrive as untyped JSON, so the READERS take `unknown` — the
// assertions, not the parameter types, are what pin the field locations.
//
// ─── The apiVersion decision (see also utils/connect/client.ts) ────────────────
// `apiVersion` stays UNPINNED, and the reasoning is recorded there. The guard
// that replaces a pin is here: `_assert_wire_version` fails `turbo run typecheck`
// the moment a `pnpm update stripe` moves the bundled wire version off the one
// these readers and their fixtures were verified against.

import Stripe from 'stripe'
import type {
  SubscriptionCancellationDetails,
  SubscriptionCancellationFeedback,
  SubscriptionCancellationReason,
} from '@linyup/shared'

/**
 * The API version the installed SDK actually talks. Not a pin — a fact about the
 * bundle, read from the SDK so it can never drift from what the wire does.
 */
export const STRIPE_WIRE_API_VERSION: string = Stripe.API_VERSION

/**
 * The version every reader below was verified against, with live captured
 * payloads (see objectShape.test.ts). `_assert_wire_version` compares the two.
 */
export const STRIPE_VERIFIED_API_VERSION = '2026-04-22.dahlia'

// ─── SDK-derived object types (used by the assertions, not by the readers) ──────

type StripeInstance = InstanceType<typeof Stripe>

export type StripeSubscriptionObject = Awaited<
  ReturnType<StripeInstance['subscriptions']['retrieve']>
>
export type StripeSubscriptionItemObject = StripeSubscriptionObject['items']['data'][number]
export type StripeInvoiceObject = Awaited<ReturnType<StripeInstance['invoices']['retrieve']>>
export type StripePaymentIntentObject = Awaited<
  ReturnType<StripeInstance['paymentIntents']['retrieve']>
>
export type StripeChargeObject = Awaited<ReturnType<StripeInstance['charges']['retrieve']>>
export type StripeCouponObject = Awaited<ReturnType<StripeInstance['coupons']['retrieve']>>
// The remaining webhook payload shapes, derived the same way so the Connect
// handlers can stop taking `any`. Three shipped defects came from a field
// Stripe moved being read off an `any` and returning `undefined` in silence;
// these are what let `turbo run typecheck` see the next one.
export type StripeCheckoutSessionObject = Awaited<
  ReturnType<StripeInstance['checkout']['sessions']['retrieve']>
>
export type StripeDisputeObject = Awaited<ReturnType<StripeInstance['disputes']['retrieve']>>
export type StripePayoutObject = Awaited<ReturnType<StripeInstance['payouts']['retrieve']>>
export type StripeRefundObject = Awaited<ReturnType<StripeInstance['refunds']['retrieve']>>
export type StripeBalanceTransactionObject = Awaited<
  ReturnType<StripeInstance['balanceTransactions']['retrieve']>
>
// The LIST responses, which are not `{ data: Object[] }`: a listed item carries
// no `lastResponse`, and the envelope carries `has_more`. Derived rather than
// hand-written for the same reason as everything else here — a shape written
// out twice is a shape that can disagree with itself.
/**
 * The same object as it arrives in a WEBHOOK, which is not quite the object as
 * it arrives from the API.
 *
 * Every alias above is derived from a `retrieve()`, so each carries
 * `lastResponse` — the HTTP envelope the SDK staples onto an API response.
 * `event.data.object` has no such thing. Typing a handler parameter with the
 * bare alias therefore demands a field that is never present, and the first
 * thing to touch it would be reading `undefined` with the compiler's blessing —
 * exactly the failure mode this module exists to stop.
 */
export type StripeWebhookPayload<T> = Omit<T, 'lastResponse'>

export type StripeRefundListResponse = Awaited<ReturnType<StripeInstance['refunds']['list']>>
export type StripeBalanceTransactionListResponse = Awaited<
  ReturnType<StripeInstance['balanceTransactions']['list']>
>
/** The CREATE params, not the object — the intro-offer coupon is minted with a
 *  DETERMINISTIC `id`, so `id` disappearing is a silent behavior change (Stripe
 *  would generate a random code and every retry would mint a new coupon). */
export type StripeCouponCreateParams = NonNullable<
  Parameters<StripeInstance['coupons']['create']>[0]
>
export type StripeCheckoutSessionCreateParams = NonNullable<
  Parameters<StripeInstance['checkout']['sessions']['create']>[0]
>

// ─── where a value was found ────────────────────────────────────────────────────

/**
 *  • `modern` — read from the location the current API version uses.
 *  • `legacy` — read from the pre-Basil location. Only reachable on a deployment
 *    pinned to an old apiVersion; worth a warning, never an error.
 *  • `absent` — in neither. For a field we require, this is the shape of a
 *    migration that has already happened, and must be shouted about.
 */
export type StripeFieldSource = 'modern' | 'legacy' | 'absent'

export interface StripeFieldRead<T> {
  value: T | null
  source: StripeFieldSource
}

const ABSENT = { value: null, source: 'absent' as const }

function modern<T>(value: T): StripeFieldRead<T> {
  return { value, source: 'modern' }
}
function legacy<T>(value: T): StripeFieldRead<T> {
  return { value, source: 'legacy' }
}

// A Stripe reference is either the id string or the expanded object.
function refId(ref: unknown): string | null {
  if (typeof ref === 'string' && ref) return ref
  if (ref && typeof ref === 'object') {
    const id = (ref as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
  }
  return null
}

function epochSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Untyped view of a webhook payload — deliberately permissive: the point of this
// module is that the JSON may or may not carry a given key.
type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function asObj(value: unknown): Obj {
  return (value ?? {}) as Obj
}

// ─── Subscription: the billing period ───────────────────────────────────────────

export interface StripeSubscriptionPeriod {
  /** Unix seconds, or null. */
  start: number | null
  /** Unix seconds, or null. */
  end: number | null
  source: StripeFieldSource
}

/**
 * The current billing period.
 *
 * MOVED: `subscription.current_period_start` / `current_period_end` were removed
 * from the Subscription object and now live on each SubscriptionItem.
 *
 * Start and end are taken from THE SAME item, so the pair is always a coherent
 * period. The item chosen is the one whose period ends SOONEST: items can in
 * principle bill on different cycles, and the soonest boundary is the one the
 * next invoice — and therefore a member's paid-through date — actually turns on.
 */
export function readSubscriptionPeriod(subscription: unknown): StripeSubscriptionPeriod {
  const sub = asObj(subscription)
  const items = (sub.items?.data ?? []) as Obj[]

  let best: Obj | null = null
  let bestEnd = Number.POSITIVE_INFINITY
  for (const item of items) {
    const end = epochSeconds(item?.current_period_end)
    if (end !== null && end < bestEnd) {
      best = item
      bestEnd = end
    }
  }
  if (best) {
    return {
      start: epochSeconds(best.current_period_start),
      end: bestEnd,
      source: 'modern',
    }
  }

  // Legacy (pre-Basil): the period sat on the subscription itself.
  const legacyEnd = epochSeconds(sub.current_period_end)
  if (legacyEnd !== null) {
    return { start: epochSeconds(sub.current_period_start), end: legacyEnd, source: 'legacy' }
  }
  return { start: null, end: null, source: 'absent' }
}

// ─── Subscription: the cancellation ─────────────────────────────────────────────

export interface StripeSubscriptionCancellation {
  /**
   * The subscription is scheduled to end rather than renew. TRUE for both
   * expressions below — this is the fact the UI and the stored flag want.
   */
  cancelsAtPeriodEnd: boolean
  /** When it ends, Unix seconds. Null when Stripe only set the boolean. */
  cancelAt: number | null
  /** When the cancellation was REQUESTED, Unix seconds. */
  canceledAt: number | null
  /** e.g. 'cancellation_requested'. Shorthand for `details.reason`. */
  reason: string | null
  /**
   * The whole of Stripe's `cancellation_details`, or null when it says nothing.
   *
   * Null-when-empty is what lets a writer clear the stored field in one move: a
   * partial object merged over a previous cancellation would leave that
   * cancellation's `feedback` standing behind a new `reason`. See
   * SubscriptionCancellationDetails in shared/utils/subscriptionLifecycle.ts.
   */
  details: SubscriptionCancellationDetails | null
  /**
   * How Stripe expressed it. `'none'` is the ordinary "not canceling" answer —
   * NOT a missing field — which is why this is not a `StripeFieldSource`.
   */
  expression: 'cancel_at' | 'cancel_at_period_end' | 'none'
}

/** Narrow an unknown to a member of a closed set, or null. Stripe may add members. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

const CANCELLATION_REASONS = [
  'cancellation_requested',
  'payment_disputed',
  'payment_failed',
] as const satisfies readonly SubscriptionCancellationReason[]

const CANCELLATION_FEEDBACKS = [
  'customer_service',
  'low_quality',
  'missing_features',
  'other',
  'switched_service',
  'too_complex',
  'too_expensive',
  'unused',
] as const satisfies readonly SubscriptionCancellationFeedback[]

/**
 * Whether the subscription is winding down.
 *
 * SEMANTIC CHANGE, not a move: a cancellation made in the Stripe BILLING PORTAL
 * is expressed as a `cancel_at` TIMESTAMP and leaves `cancel_at_period_end`
 * FALSE. The boolean is still set when WE cancel through the API with that
 * parameter — which is exactly why this survived testing for so long: the
 * Linyup-initiated path set the flag and looked correct, and only the
 * portal-initiated path went silent.
 *
 * Note this reports a SCHEDULED end. A subscription that has already ended
 * carries `canceled_at` (and possibly a past `cancel_at`) too — callers combine
 * this with `status` before showing "cancels on …".
 *
 * WHY the details are read here rather than at the two call sites: `reason` is
 * the field that separates "the member chose to leave" from "their card gave
 * out", which are the same stored state and completely different studio
 * actions. A boolean could not carry that, which is most of why this defect was
 * worth more than a date.
 */
export function readSubscriptionCancellation(
  subscription: unknown
): StripeSubscriptionCancellation {
  const sub = asObj(subscription)
  const cancelAt = epochSeconds(sub.cancel_at)
  const flag = sub.cancel_at_period_end === true
  const raw = asObj(sub.cancellation_details)
  const reason = oneOf(raw.reason, CANCELLATION_REASONS)
  const feedback = oneOf(raw.feedback, CANCELLATION_FEEDBACKS)
  const comment = typeof raw.comment === 'string' && raw.comment ? raw.comment : null
  return {
    cancelsAtPeriodEnd: flag || cancelAt !== null,
    cancelAt,
    canceledAt: epochSeconds(sub.canceled_at),
    reason,
    // Null when Stripe said nothing, so a writer clears the stored field in one
    // move instead of three — see the interface note above.
    details: reason || feedback || comment ? { reason, feedback, comment } : null,
    expression: cancelAt !== null ? 'cancel_at' : flag ? 'cancel_at_period_end' : 'none',
  }
}

// ─── Invoice → subscription ─────────────────────────────────────────────────────

/**
 * The subscription an invoice bills for.
 *
 * MOVED: `invoice.subscription` was removed; the link now hangs off
 * `invoice.parent.subscription_details.subscription`. Verified present in the
 * DELIVERED webhook payload (not just in a retrieve), so this needs no API call.
 */
export function readInvoiceSubscriptionId(invoice: unknown): StripeFieldRead<string> {
  const inv = asObj(invoice)
  const parentSub = refId(inv.parent?.subscription_details?.subscription)
  if (parentSub) return modern(parentSub)
  const legacySub = refId(inv.subscription)
  if (legacySub) return legacy(legacySub)
  return ABSENT
}

/**
 * Does this invoice bill a SUBSCRIPTION at all?
 *
 * A one-off invoice — one a studio raises by hand, say — has no subscription BY
 * DESIGN. Without this, every such invoice would be reported as a missing field
 * and the `[stripe-shape] MISSING` alarm would cry wolf until nobody read it.
 * Asks the question through the MARKERS rather than through the id, so an
 * invoice that says it bills a subscription and then cannot name one is still
 * loud.
 */
export function invoiceBillsSubscription(invoice: unknown): boolean {
  const inv = asObj(invoice)
  if (inv.parent?.type === 'subscription_details') return true
  if (inv.parent?.subscription_details != null) return true
  return inv.subscription != null // legacy marker
}

/**
 * Checkout metadata carried on a subscription invoice. Same move as above — the
 * subscription's metadata now rides `parent.subscription_details.metadata`,
 * which is how a renewal invoice can still say what was bought.
 *
 * CALLER: `handleInvoice` in connect/webhook.ts, as the FALLBACK label source
 * for the payment row when the member_subscriptions doc has not been stamped
 * yet (Stripe orders `invoice.paid` and `customer.subscription.*` however it
 * likes). Labels only — see the note there for why `contactId` is not taken
 * from here.
 */
export function readInvoiceSubscriptionMetadata(invoice: unknown): Record<string, string> {
  const md = asObj(invoice).parent?.subscription_details?.metadata
  return md && typeof md === 'object' ? (md as Record<string, string>) : {}
}

// ─── Invoice → payment intent ───────────────────────────────────────────────────

/**
 * The expand paths that MAKE `readInvoicePaymentIntentId` able to answer.
 *
 * These are named, exported constants rather than strings typed at the call
 * sites, because getting one wrong FAILS SILENTLY. Stripe ignores an unrecognised
 * expand path instead of erroring — which is precisely how the original defect
 * survived: the call site asked for `latest_invoice.payment_intent`, Stripe
 * returned 200 with no such field, and the reader handed back undefined. Nothing
 * anywhere said no.
 *
 * So the reader and the fetch that feeds it are ONE fact and live together. If
 * Stripe moves the list again, both move here.
 */
/** For `invoices.retrieve(id, { expand: [...] })`. */
export const INVOICE_PAYMENTS_EXPAND = 'payments'
/** For `subscriptions.retrieve(id, { expand: [...] })`, reaching the first charge. */
export const SUBSCRIPTION_LATEST_INVOICE_PAYMENTS_EXPAND = 'latest_invoice.payments'

/**
 * The PaymentIntent that paid an invoice.
 *
 * MOVED: `invoice.payment_intent` was removed; the link now lives at
 * `invoice.payments.data[].payment.payment_intent`.
 *
 * ⚠ `payments` is EXPAND-ONLY and is CONFIRMED ABSENT from the webhook payload.
 * Re-pointing the read is therefore not enough on its own: a caller holding only
 * the delivered invoice must re-fetch it with `expand: ['payments']` (or reach
 * the same list through `subscriptions.retrieve(…, { expand:
 * ['latest_invoice.payments'] })`). Both are verified working; see the callers in
 * connect/webhook.ts.
 */
export function readInvoicePaymentIntentId(invoice: unknown): StripeFieldRead<string> {
  const inv = asObj(invoice)
  for (const entry of (inv.payments?.data ?? []) as Obj[]) {
    const pi = refId(entry?.payment?.payment_intent)
    if (pi) return modern(pi)
  }
  const legacyPi = refId(inv.payment_intent)
  if (legacyPi) return legacy(legacyPi)
  return ABSENT
}

// ─── PaymentIntent → the payer's email ──────────────────────────────────────────

/**
 * The buyer's email as far as a PaymentIntent knows it.
 *
 * REMOVED (back in 2022-11-15, superseded by `latest_charge`):
 * `payment_intent.charges`. An invoice-generated PI usually has
 * `receipt_email: null`, so on a rail that cannot call the Stripe API the answer
 * is genuinely "unknown" — the charge object carries `billing_details.email`,
 * and reaching it needs either an API call or a `charge.*` event.
 */
export function readPaymentIntentEmail(paymentIntent: unknown): StripeFieldRead<string> {
  const pi = asObj(paymentIntent)
  if (typeof pi.receipt_email === 'string' && pi.receipt_email) return modern(pi.receipt_email)
  const fromCharges = pi.charges?.data?.[0]?.billing_details?.email
  if (typeof fromCharges === 'string' && fromCharges) return legacy(fromCharges)
  return ABSENT
}

// ─── Coupon: the intro offer's terms ────────────────────────────────────────────

/**
 * What a coupon actually promises, as Stripe currently states it.
 *
 * `duration_in_months` is the ONLY way Stripe expresses a repeating discount —
 * there is no weeks/invoices equivalent — and that single fact is what forces
 * the weekly/biweekly refusal in `shared/utils/introOffer.ts`. It is read
 * through here (rather than inline) for the ordinary reason this module exists:
 * an `obj.field` on an `any` that stops matching returns `undefined` SILENTLY,
 * and here that would mean reusing a coupon whose terms are no longer the terms
 * the pricing card promised.
 */
export interface StripeCouponTerms {
  duration: 'once' | 'repeating' | 'forever' | null
  /** Only meaningful for `duration: 'repeating'`. */
  durationInMonths: number | null
  /** Fixed discount in MINOR units, or null when the coupon is percentage-based. */
  amountOffMinor: number | null
  /** Percentage discount (1–100), or null when the coupon is amount-based. */
  percentOff: number | null
  /** Stripe's own verdict on whether it can still be applied. */
  valid: boolean
}

const COUPON_DURATIONS = ['once', 'repeating', 'forever'] as const

export function readCouponTerms(coupon: unknown): StripeCouponTerms {
  const c = asObj(coupon)
  return {
    duration: oneOf(c.duration, COUPON_DURATIONS),
    durationInMonths: typeof c.duration_in_months === 'number' ? c.duration_in_months : null,
    amountOffMinor: typeof c.amount_off === 'number' ? c.amount_off : null,
    percentOff: typeof c.percent_off === 'number' ? c.percent_off : null,
    valid: c.valid === true,
  }
}

/** The billing email on a Charge — unmoved, and the only place it survives. */
export function readChargeBillingEmail(charge: unknown): string | null {
  const ch = asObj(charge)
  const email = ch.billing_details?.email ?? ch.receipt_email
  return typeof email === 'string' && email ? email : null
}

/**
 * The hosted receipt link on a Charge — unmoved, and NULLABLE BY DESIGN rather
 * than by accident: Stripe documents `receipt_url` as nullable, and a charge
 * that never produced a receipt simply has none. A caller must render that as
 * "no receipt", never as a failure.
 *
 * It goes through this module like every other Charge field so there is one
 * place to change if it ever moves, not so it can be defaulted — there is no
 * sensible fallback for a URL.
 */
export function readChargeReceiptUrl(charge: unknown): string | null {
  const url = asObj(charge).receipt_url
  return typeof url === 'string' && url ? url : null
}

// ─── the loud guard ─────────────────────────────────────────────────────────────

/** Greppable in Cloud Logging: every shape surprise carries this prefix. */
export const STRIPE_SHAPE_LOG_PREFIX = '[stripe-shape]'

/**
 * Say out loud where a field was found, when that is news.
 *
 * `absent` is an ERROR: the field we require is in neither location, which is
 * what a silent migration looks like from the inside. `legacy` is a WARNING: the
 * narrow fallback engaged, so something is talking an older API version than the
 * SDK bundles. `modern` says nothing.
 *
 * It deliberately does not throw. These readers run inside webhook handlers that
 * must still return 200 and must still record the payment they were given; a
 * throw would trade a wrong field for a lost row. The guard that DOES fail hard
 * is `_assert_wire_version` below — it breaks the build, before deploy.
 */
export function reportStripeShape(
  field: string,
  objectId: string | null | undefined,
  source: StripeFieldSource,
  context?: string
): void {
  if (source === 'modern') return
  const where = `${field} on ${objectId ?? 'unknown'}${context ? ` (${context})` : ''}`
  if (source === 'legacy') {
    console.warn(
      `${STRIPE_SHAPE_LOG_PREFIX} LEGACY ${where} — read from the pre-Basil location; ` +
        `SDK wire version is ${STRIPE_WIRE_API_VERSION}`
    )
    return
  }
  console.error(
    `${STRIPE_SHAPE_LOG_PREFIX} MISSING ${where} — present in neither the modern nor the ` +
      `legacy location (SDK wire version ${STRIPE_WIRE_API_VERSION}). Stripe has probably ` +
      `moved it again: see packages/functions/src/utils/stripe/objectShape.ts`
  )
}

/** `reportStripeShape` + unwrap, for the common one-line call site. */
export function readOrReport<T>(
  read: StripeFieldRead<T>,
  field: string,
  objectId: string | null | undefined,
  context?: string
): T | null {
  reportStripeShape(field, objectId, read.source, context)
  return read.value
}

// ─── compile-time assertions ────────────────────────────────────────────────────
// These are the tripwire. Each one states, against the SDK's OWN declarations,
// where a field is and is not. They erase at emit and cost nothing at runtime —
// but a `pnpm update stripe` that moves any of them turns `turbo run typecheck`
// red, which is the failure this whole module exists to produce.
//
// If one of these fails: read the migrated field's doc comment above, move the
// read, re-capture the fixtures in objectShape.test.ts, and bump
// STRIPE_VERIFIED_API_VERSION.

// `Because` puts the explanation INSIDE the compiler error: a failed check
// resolves to its message string, and `Assert` then reports
//   Type '"…"' does not satisfy the constraint 'true'
// so whoever hits it reads the reason, not just a bare `false`.
type Assert<T extends true> = T
type Because<Passed extends boolean, Why extends string> = Passed extends true ? true : Why
type Has<O, K extends string> = K extends keyof O ? true : false
type Lacks<O, K extends string> = K extends keyof O ? false : true

// THE VERSION TRIPWIRE. `Stripe.API_VERSION` is a string LITERAL type in the
// SDK's declarations, so this compares the bundled wire version against the one
// these readers and their fixtures were verified against. Bump the SDK and this
// is the first thing that fails.
type _assert_wire_version = Assert<
  Because<
    typeof Stripe.API_VERSION extends typeof STRIPE_VERIFIED_API_VERSION ? true : false,
    'The installed stripe SDK talks a DIFFERENT API version than these readers were verified against. Re-capture the fixtures in dahlia-payloads.json, re-check every reader in this file, bump STRIPE_VERIFIED_API_VERSION, and re-run `pnpm stripe:sync` so the webhook endpoints deliver the new shape.'
  >
>

// Subscription: the period moved to the item.
type _assert_sub_has_no_period_end = Assert<
  Because<
    Lacks<StripeSubscriptionObject, 'current_period_end'>,
    'Subscription.current_period_end is back. readSubscriptionPeriod reads the ITEM first — re-check which one is authoritative now.'
  >
>
type _assert_sub_has_no_period_start = Assert<
  Because<
    Lacks<StripeSubscriptionObject, 'current_period_start'>,
    'Subscription.current_period_start is back — see the note on current_period_end.'
  >
>
type _assert_item_has_period_end = Assert<
  Because<
    Has<StripeSubscriptionItemObject, 'current_period_end'>,
    'SubscriptionItem.current_period_end has MOVED. readSubscriptionPeriod cannot find the billing period any more, and a membership expiry will be written null.'
  >
>
type _assert_item_has_period_start = Assert<
  Because<
    Has<StripeSubscriptionItemObject, 'current_period_start'>,
    'SubscriptionItem.current_period_start has MOVED — see current_period_end.'
  >
>

// Subscription: the cancellation is expressed by three fields, all still present.
type _assert_sub_has_cancel_at = Assert<
  Because<
    Has<StripeSubscriptionObject, 'cancel_at'>,
    'Subscription.cancel_at is gone. It is how a BILLING-PORTAL cancellation is expressed, so readSubscriptionCancellation would stop seeing portal cancellations entirely.'
  >
>
type _assert_sub_has_cancel_at_period_end = Assert<
  Because<
    Has<StripeSubscriptionObject, 'cancel_at_period_end'>,
    'Subscription.cancel_at_period_end is gone — the API-initiated cancel path (cancelSubscription) sets it, so both the write and the read need moving together.'
  >
>
type _assert_sub_has_canceled_at = Assert<
  Because<Has<StripeSubscriptionObject, 'canceled_at'>, 'Subscription.canceled_at is gone.'>
>
type _assert_sub_has_cancellation_details = Assert<
  Because<
    Has<StripeSubscriptionObject, 'cancellation_details'>,
    'Subscription.cancellation_details is gone — readSubscriptionCancellation reports its reason.'
  >
>
// …and the three keys INSIDE it that are stored and displayed. `reason` is the
// load-bearing one: it is what separates a member who left from a card that
// failed, and the studio-facing copy branches on it.
type StripeCancellationDetails = NonNullable<StripeSubscriptionObject['cancellation_details']>
type _assert_cancellation_details_shape = Assert<
  Because<
    Has<StripeCancellationDetails, 'reason'> extends true
      ? Has<StripeCancellationDetails, 'feedback'> extends true
        ? Has<StripeCancellationDetails, 'comment'>
        : false
      : false,
    'cancellation_details lost one of reason/feedback/comment. readSubscriptionCancellation stores all three and the admin subscription views display them — a studio would stop being told WHY a member left.'
  >
>
// The stored enums are OUR narrowing of Stripe's, and `oneOf` drops anything
// outside them. These check the narrowing is still a SUBSET of what Stripe can
// send — a new Stripe member is fine (it lands as null), but a member of ours
// that Stripe no longer sends is dead copy in four locales.
type _assert_reason_enum_is_subset = Assert<
  Because<
    SubscriptionCancellationReason extends NonNullable<StripeCancellationDetails['reason']>
      ? true
      : false,
    'SubscriptionCancellationReason has a member Stripe no longer sends. Drop it here and remove its subCancelReason_* key from all four message files.'
  >
>
type _assert_feedback_enum_is_subset = Assert<
  Because<
    SubscriptionCancellationFeedback extends NonNullable<StripeCancellationDetails['feedback']>
      ? true
      : false,
    'SubscriptionCancellationFeedback has a member Stripe no longer sends. Drop it here and remove its subCancelFeedback_* key from all four message files.'
  >
>

// Invoice: subscription + payment_intent both gone, replaced by parent + payments.
type _assert_invoice_has_no_subscription = Assert<
  Because<
    Lacks<StripeInvoiceObject, 'subscription'>,
    'Invoice.subscription is back. readInvoiceSubscriptionId treats it as the LEGACY location — re-check which one is authoritative.'
  >
>
type _assert_invoice_has_no_payment_intent = Assert<
  Because<
    Lacks<StripeInvoiceObject, 'payment_intent'>,
    'Invoice.payment_intent is back. If it is in the webhook payload again, the expand-and-retrieve fallbacks in connect/webhook.ts are now a wasted API call.'
  >
>
type _assert_invoice_has_parent = Assert<
  Because<
    Has<StripeInvoiceObject, 'parent'>,
    'Invoice.parent has MOVED. handleInvoice can no longer find the subscription an invoice bills, and the whole renewal path goes silent.'
  >
>
type _assert_invoice_has_payments = Assert<
  Because<
    Has<StripeInvoiceObject, 'payments'>,
    'Invoice.payments has MOVED. Every subscription charge loses its contact, on both the payment row and the finance journal.'
  >
>

// PaymentIntent: `charges` is long gone; `latest_charge` replaced it. And a PI can
// no longer name its own invoice, which is why the invoice→PI direction is the
// only one available.
type _assert_pi_has_no_charges = Assert<
  Because<Lacks<StripePaymentIntentObject, 'charges'>, 'PaymentIntent.charges is back — readPaymentIntentEmail treats it as legacy.'>
>
type _assert_pi_has_latest_charge = Assert<
  Because<
    Has<StripePaymentIntentObject, 'latest_charge'>,
    'PaymentIntent.latest_charge has MOVED — handlePaymentIntent stamps chargeId and the fee split from it.'
  >
>
type _assert_pi_has_no_invoice = Assert<
  Because<
    Lacks<StripePaymentIntentObject, 'invoice'>,
    'PaymentIntent.invoice is back — the BYO rail could then converge invoice and payment events on one key, which would close the BYO double-count entry in docs/open-defects.md.'
  >
>

// Coupon: the intro offer (docs/…: SubscriptionType.introOffer) is a COUPON on
// the connected account, applied via the Checkout Session's `discounts`. Four
// facts hold that feature up, and each is load-bearing in a different way.
type _assert_coupon_has_duration = Assert<
  Because<
    Has<StripeCouponObject, 'duration'>,
    'Coupon.duration is gone — readCouponTerms can no longer tell a first-invoice discount from a repeating one, and the intro offer would be reused blind.'
  >
>
type _assert_coupon_has_duration_in_months = Assert<
  Because<
    Has<StripeCouponObject, 'duration_in_months'>,
    'Coupon.duration_in_months has MOVED or gone. It is the ONLY way Stripe expresses a repeating discount, and the whole weekly/biweekly refusal in shared/utils/introOffer.ts exists because of it. If Stripe has added a weeks/invoices equivalent, introOfferDurationFor should stop refusing "first N periods" on a weekly plan.'
  >
>
type _assert_coupon_has_amount_off = Assert<
  Because<
    Has<StripeCouponObject, 'amount_off'>,
    'Coupon.amount_off is gone — a priced intro offer ("CHF 1 for the first month") is expressed as a fixed amount off the full price.'
  >
>
type _assert_coupon_has_percent_off = Assert<
  Because<
    Has<StripeCouponObject, 'percent_off'>,
    'Coupon.percent_off is gone — a FREE intro offer is percent_off: 100, which produces a zero invoice rather than a charge below the 0.50 floor.'
  >
>
// Our narrowing of Stripe's duration enum must stay a SUBSET of theirs, exactly
// as the cancellation enums above do.
type _assert_coupon_duration_enum_is_subset = Assert<
  Because<
    'once' | 'repeating' extends NonNullable<StripeCouponObject['duration']> ? true : false,
    'Coupon.duration no longer offers once/repeating. introOfferDurationFor emits both — re-derive it from whatever replaced them.'
  >
>
// CREATE params: the deterministic id is what makes a retry a REUSE rather than
// a second coupon, and duration_in_months is how N periods is stated.
type _assert_coupon_create_takes_id = Assert<
  Because<
    Has<StripeCouponCreateParams, 'id'>,
    'coupons.create no longer accepts an `id`. The intro-offer coupon id is DERIVED from the offer so a retried checkout reuses it — without a caller-supplied id, every click mints a new coupon.'
  >
>
type _assert_coupon_create_takes_duration_in_months = Assert<
  Because<
    Has<StripeCouponCreateParams, 'duration_in_months'>,
    'coupons.create no longer accepts duration_in_months — see the note on the object field above.'
  >
>
// …and the session must still be able to carry the coupon at all.
type _assert_session_create_takes_discounts = Assert<
  Because<
    Has<StripeCheckoutSessionCreateParams, 'discounts'>,
    'checkout.sessions.create no longer takes `discounts`. The intro offer would silently stop applying — and the pricing card promises it BEFORE purchase, so the member is charged full price against a stated offer.'
  >
>

// Charge: still carries the billing email — the last place it survives.
type _assert_charge_has_billing_details = Assert<
  Because<
    Has<StripeChargeObject, 'billing_details'>,
    'Charge.billing_details has MOVED — it is the last place the payer email survives, so BYO payments would stop being assignable to a contact.'
  >
>
