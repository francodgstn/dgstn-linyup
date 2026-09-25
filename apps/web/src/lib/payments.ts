// Shared helpers for the unified payments view (general /payments page + the
// per-contact Payments tab). Connect (member_payments) and BYO (payment_events)
// have different shapes; we normalize both into UnifiedPaymentRow so the UI treats
// them the same — amount, status, contact assignment, and the "what was paid"
// label (linked line item → explicit comment → derived gateway default).

import type { MemberPayment, ExternalPayment, PaymentLineItem, HeldPlan } from '@linyup/shared'

export type PaymentSource = 'connect' | 'byo'

export interface UnifiedPaymentRow {
  /** Stable React key. */
  key: string
  source: PaymentSource
  /** PaymentIntent id (Connect) or payment_events doc id (BYO) — for updatePaymentRecord. */
  paymentId: string
  /** Human gateway label key suffix: 'connect' | 'payrexx' | 'stripe'. */
  gateway: string
  contactId: string | null
  assigned: boolean
  email: string | null
  amount: number // minor units (Rappen/cents)
  currency: string
  /** Raw status; Connect = MemberPaymentStatus, BYO = 'paid' | 'voided'. */
  status: string
  /** The record was un-recorded (manual rows only). The row is inert: it counts
   *  toward no total, offers no action, and renders struck through. */
  voided: boolean
  /** Can a manager void this row? Manual rows only, and only once — the BYO
   *  gateway rails carry money we do not control, so their ledger row may not be
   *  contradicted here (enforced server-side by voidManualPayment). */
  voidable: boolean
  /** Explicit free-text comment, if set. */
  comment: string | null
  /** Structured link (BYO/manual), for the assign dialog. Connect rows leave it null. */
  lineItem: PaymentLineItem | null
  /** The promo code this sale was discounted with, or null. Read off the line
   * item on BOTH rails — the Connect webhook stamps it from checkout metadata,
   * and a manual row can carry one only if a manager's row already had it (it is
   * never client-writable). This is the only place a discount is visible on the
   * money side: a promo writes no journal row and no CSV column. */
  promoCode: string | null
  /** This drop-in charge was somebody's PAID TRIAL (`PaymentLineItem.trial`, a
   *  system stamp written by the Connect webhook). The only place a trial and
   *  the money it earned meet: the payment row said `drop_in` and the contact
   *  said `trial_used_at`, and neither named the other. Never a category — the
   *  charge is booked as the drop-in sale it is. */
  trial: boolean
  /** The BYO row is keyed on something other than the payment
   *  (`ExternalPayment.gateway_ref_kind === 'fallback'`), so a sibling webhook
   *  event about the SAME money would have written a second row that this one
   *  cannot dedupe against. See `handleTeamStripeWebhook` — a studio subscribed
   *  to both an invoice event and a payment event gets one payment twice, and
   *  this is the only thing in the data that says which rows are exposed to it. */
  refKindFallback: boolean
  /** Studio-configured mode for manual payments (Cash / TWINT / …); null otherwise. */
  paymentMode: string | null
  /** Derived "what was paid" label, used when comment is empty. */
  defaultLabel: string
  /** Timestamp-like (has .toDate()) for date formatting / sorting. */
  createdAt: { toDate?: () => Date } | null
  /** Platform application fee taken (Connect only; minor units). */
  feeAmount: number
  /** WHICH PLAN TYPE this payment bought, when the row itself records it — and
   *  `null` when it does not. Read for the contact ledger's "what did they pay
   *  for" column.
   *
   *  THIS IS A PLAN **TYPE**, NEVER A SUBSCRIPTION INSTANCE. Which subscription
   *  a charge paid is `subscriptionId` below, and only where the row recorded
   *  it; this field must never be used to imply one.
   *
   *  A null is a FACT, not a gap to fill: it must never be resolved by inferring
   *  from an overlapping plan span, from the contact's current plan, or from
   *  proximity in time. Two reasons it is legitimately absent — legacy rows
   *  predate the line item entirely, and a renewal that reaches us before its
   *  subscription webhook carries no plan id at all (see the ordering note in
   *  connect/webhook.ts). Guessing would put a confident wrong plan on a real
   *  payment. */
  planTypeId: string | null
  /** Where `planTypeId` came from, so the UI can be honest about how firm it is:
   *  'line_item'    — the structured line item on either rail (firmest)
   *  'legacy_field' — a BYO row's top-level `subscription_type_id` (pre-line-item)
   *  'none'         — the row does not record a plan */
  planAttribution: 'line_item' | 'legacy_field' | 'none'
  /** Connect only: WHICH Stripe subscription this charge paid
   *  (`MemberPayment.subscriptionId`, stamped on the first charge by checkout
   *  and on every renewal by handleInvoice). Null on rows written before it
   *  existed and on every non-subscription charge. */
  subscriptionId: string | null
  // Connect-only management affordances:
  refundable: boolean
  disputed: boolean
  amountRefunded: number
}

export function formatMoneyMinor(minor: number | null | undefined, currency: string): string {
  const cur = (currency || 'CHF').toUpperCase()
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(
      (minor ?? 0) / 100
    )
  } catch {
    // Unknown currency code — fall back to a plain number + code.
    return `${((minor ?? 0) / 100).toFixed(2)} ${cur}`
  }
}

/** Same as formatMoneyMinor but for values already in major units (e.g. the
 * partner-visit payout ledger, entered in the studio's own currency). */
export function formatMoneyMajor(amount: number | null | undefined, currency: string): string {
  const cur = (currency || 'CHF').toUpperCase()
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(
      amount ?? 0
    )
  } catch {
    return `${(amount ?? 0).toFixed(2)} ${cur}`
  }
}

export function formatPaymentDate(ts: { toDate?: () => Date } | null | undefined): string {
  const d = ts?.toDate?.()
  return d ? d.toLocaleDateString() : ''
}

/** Primary "what was paid" label: the linked line item (subscription / course /
 * product) wins, then the explicit comment, then the derived gateway default. */
export function paymentLabel(row: UnifiedPaymentRow): string {
  return (
    (row.lineItem?.label && row.lineItem.label.trim()) ||
    (row.comment && row.comment.trim()) ||
    row.defaultLabel
  )
}

/** Secondary note under the label: the comment, when the primary label already
 * shows the linked line item (avoids repeating identical text). */
export function paymentNote(row: UnifiedPaymentRow): string | null {
  const li = row.lineItem?.label?.trim()
  const c = row.comment?.trim()
  return li && c && c !== li ? c : null
}

function connectDefaultLabel(p: MemberPayment): string {
  if (p.kind === 'product') {
    return p.variantLabel
      ? `${p.productName ?? 'Product'} · ${p.variantLabel}`
      : (p.productName ?? 'Product')
  }
  if (p.kind === 'course') return p.courseName ?? 'Course'
  // A SCHEDULED course. Without this the row fell through to `p.purpose`, which
  // the checkout sets to the literal `course_block`, so the payments list showed
  // a machine name to a studio looking for "Level 2 Seepferd".
  if (p.kind === 'course_block') return p.courseName ?? 'Course'
  if (p.kind === 'membership') return p.subscriptionTypeName ?? 'Membership'
  return p.purpose || 'Payment'
}

/** Structured line item for a Connect row: the webhook-stamped one when
 * present, else a label-only fallback derived from kind/names (legacy rows) so
 * the assign/edit dialog's "What was paid" is never empty for a linked sale. */
function connectLineItem(p: MemberPayment): PaymentLineItem | null {
  if (p.line_item) return p.line_item
  if (p.kind === 'membership') {
    return { kind: 'subscription', label: p.subscriptionTypeName ?? 'Membership' }
  }
  if (p.kind === 'product') return { kind: 'product', label: connectDefaultLabel(p) }
  if (p.kind === 'course') return { kind: 'course', label: p.courseName ?? 'Course' }
  if (p.kind === 'course_block') {
    return {
      kind: 'course_block',
      courseBlockId: (p as { courseBlockId?: string | null }).courseBlockId ?? null,
      label: p.courseName ?? 'Course',
    }
  }
  if (p.kind === 'drop_in') return { kind: 'drop_in', label: connectDefaultLabel(p) }
  return null
}

/** The plan TYPE a row records, and how firmly — see `UnifiedPaymentRow.planTypeId`
 *  for why a `'none'` must never be resolved by inference.
 *
 *  `stored` is the row's OWN line item, never `connectLineItem`'s synthesised
 *  fallback: that fallback is built from `kind`/names to keep the assign dialog's
 *  label non-empty, and it carries no plan id. Reading it here would report
 *  `'line_item'` confidence for a row that records no plan at all.
 *
 *  `legacyTypeId` is the BYO rail's pre-line-item carrier
 *  (`ExternalPayment.subscription_type_id`), which the adapter used to drop —
 *  costing those rows the only plan link they have. */
function resolvePlanAttribution(
  stored: PaymentLineItem | null | undefined,
  legacyTypeId?: string | null
): { planTypeId: string | null; planAttribution: UnifiedPaymentRow['planAttribution'] } {
  if (stored?.kind === 'subscription' && stored.subscriptionTypeId) {
    return { planTypeId: stored.subscriptionTypeId, planAttribution: 'line_item' }
  }
  if (legacyTypeId) return { planTypeId: legacyTypeId, planAttribution: 'legacy_field' }
  return { planTypeId: null, planAttribution: 'none' }
}

export function connectToUnified(payments: MemberPayment[]): UnifiedPaymentRow[] {
  return payments.map((p) => ({
    key: `connect:${p.paymentIntentId}`,
    source: 'connect' as const,
    paymentId: p.paymentIntentId,
    gateway: 'connect',
    contactId: p.contactId ?? null,
    assigned: !!p.contactId,
    email: null,
    amount: p.amount ?? 0,
    currency: p.currency ?? 'chf',
    status: p.status,
    // A Connect charge is never voided — its correction is a refund, which moves
    // real money and has its own row status.
    voided: false,
    voidable: false,
    comment: p.comment ?? null,
    lineItem: connectLineItem(p),
    // From the stored line item only — connectLineItem's legacy fallbacks are
    // synthesised from kind/names and can never carry a code.
    promoCode: p.line_item?.promoCode ?? null,
    // Same source and the same reason as promoCode: the stored line item only.
    trial: p.line_item?.trial === true,
    // Connect rows converge on the PaymentIntent by construction — the fallback
    // key exists only on the BYO rail, which cannot bridge an invoice event to
    // its payment.
    refKindFallback: false,
    paymentMode: null,
    defaultLabel: connectDefaultLabel(p),
    createdAt: (p.created_at as unknown as { toDate?: () => Date }) ?? null,
    feeAmount: p.application_fee_amount ?? 0,
    // The Connect rail has no legacy top-level carrier — the plan id has always
    // lived in the line item here.
    ...resolvePlanAttribution(p.line_item),
    subscriptionId: p.subscriptionId ?? null,
    refundable: p.status === 'succeeded' || p.status === 'partially_refunded',
    disputed: !!p.dispute_status,
    amountRefunded: p.amount_refunded ?? 0,
  }))
}

export function byoToUnified(events: Array<ExternalPayment & { id: string }>): UnifiedPaymentRow[] {
  return events.map((e) => {
    // The rail's ONE status. It used to be hardcoded 'paid' because a BYO row
    // exists only because money arrived — true of the gateway rails still, and
    // no longer true of a manual row a manager has voided.
    const voided = !!e.voided_at
    return {
      key: `byo:${e.id}`,
      source: 'byo' as const,
      paymentId: e.id,
      gateway: e.gateway, // 'payrexx' | 'stripe' | 'manual'
      contactId: e.contact_id ?? null,
      assigned: (e.assignment_status ?? (e.contact_id ? 'assigned' : 'unassigned')) === 'assigned',
      email: e.email ?? null,
      amount: e.amount ?? 0,
      currency: e.currency ?? 'CHF',
      status: voided ? 'voided' : 'paid',
      voided,
      voidable: e.gateway === 'manual' && !voided,
      comment: e.comment ?? null,
      lineItem: e.line_item ?? null,
      promoCode: e.line_item?.promoCode ?? null,
      trial: e.line_item?.trial === true,
      // ABSENT means 'payment' — the field post-dates the rail, and every rail
      // but BYO Stripe keys on the payment by construction. Only an explicit
      // 'fallback' is a warning, so an older row is never accused of a
      // duplication it is not exposed to.
      refKindFallback: e.gateway_ref_kind === 'fallback',
      paymentMode: e.payment_mode ?? null,
      defaultLabel:
        e.gateway === 'payrexx'
          ? 'Payrexx payment'
          : e.gateway === 'manual'
            ? 'Manual payment'
            : 'Stripe payment',
      createdAt: (e.processed_at as unknown as { toDate?: () => Date }) ?? null,
      feeAmount: 0, // BYO has no platform fee — money never touches Linyup
      ...resolvePlanAttribution(e.line_item, e.subscription_type_id),
      subscriptionId: null,
      refundable: false, // BYO is record-only — refunds happen in the studio's own gateway
      disputed: false,
      amountRefunded: 0,
    }
  })
}

/**
 * WHICH PLAN CARD A PAYMENT PAID FOR, among the plans the contact holds now
 * (docs/multi-plan-holdings.md §5). Exact where the data records it:
 *
 *   - a Stripe charge that recorded its subscription → that subscription's card;
 *   - a payment that CREATED a grant → that grant's card (a payment's grant is
 *     keyed by the payment id, see functions/contacts/planGrants.ts).
 *
 * Otherwise, and only for a row that records its plan TYPE, the one held card
 * of that type — `exact: false`, so the UI can say it matched by type. Two
 * cards of one type is ambiguous and gets no link; so does a row that recorded
 * a subscription the contact no longer holds. Never a guess from dates or from
 * what they hold now: see `planTypeId`.
 */
export function planCardForPayment(
  row: Pick<UnifiedPaymentRow, 'paymentId' | 'subscriptionId' | 'planTypeId'>,
  plans: ReadonlyArray<HeldPlan>
): { plan: HeldPlan; exact: boolean } | null {
  if (row.subscriptionId) {
    const sub = plans.find((p) => p.source === 'stripe' && p.ref === row.subscriptionId)
    return sub ? { plan: sub, exact: true } : null
  }
  const grant = plans.find((p) => p.source === 'grant' && p.ref === row.paymentId)
  if (grant) return { plan: grant, exact: true }
  if (!row.planTypeId) return null
  const sameType = plans.filter((p) => p.subscription_type_id === row.planTypeId)
  return sameType.length === 1 ? { plan: sameType[0], exact: false } : null
}

/** Merge + sort newest-first across both rails. */
export function mergePaymentRows(
  connect: UnifiedPaymentRow[],
  byo: UnifiedPaymentRow[]
): UnifiedPaymentRow[] {
  return [...connect, ...byo].sort((a, b) => {
    const ta = a.createdAt?.toDate?.()?.getTime() ?? 0
    const tb = b.createdAt?.toDate?.()?.getTime() ?? 0
    return tb - ta
  })
}
