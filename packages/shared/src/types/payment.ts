// BYO (bring-your-own gateway) payment ledger — the minimal counterpart to the
// fully-integrated Stripe Connect rail (member_payments / member_subscriptions).
//
// A studio that wires its OWN Payrexx or Stripe account (no platform fee, money
// never touches Linyup) gets exactly one thing from Linyup: the payment is
// RECORDED against a contact. We do not run the checkout, manage refunds, or hold
// any credentials. Each confirmed payment lands here as an ExternalPayment, and a
// manager can (re)assign the contact + edit the comment from the payments
// dashboard / per-contact Payments tab.
//
// Stored at teams/{teamId}/payment_events/{id} (PAYMENT_EVENTS_SUBCOLLECTION),
// doc id = `${gateway}:${gatewayRef}` so a duplicate webhook delivery is a no-op.

import type { Timestamp } from './common'

// 'payrexx' | 'stripe' arrive via a gateway webhook; 'manual' is a cash / bank-
// transfer / TWINT payment a manager records by hand (no gateway, no webhook).
export type ExternalPaymentGateway = 'payrexx' | 'stripe' | 'manual'

// Whether the payment has been linked to a Linyup contact. We record the payment
// either way — email is NOT a unique key (a parent's address can control several
// child contacts), so when zero or multiple active contacts match we leave it
// 'unassigned' and a manager links it, rather than silently guessing.
export type PaymentAssignmentStatus = 'assigned' | 'unassigned'

// ─── Structured "what was paid" ──────────────────────────────────────────────
// The line_item is the STRUCTURED link (drives entitlements) — distinct from the
// free-text `comment` (a human note). Applying a line-item to a contact runs the
// same effects a Connect purchase would: subscription → set subscription fields
// (+ credits if the price carries them); course → grant the lifetime entitlement
// (unlocks in the Space); product → record only. See applyPaymentEffects.
//
// 'gift_card' is deliberately effect-less here: the entitlement is the CODE, and
// the card doc under teams/{id}/gift_cards is what carries it. This kind exists
// so the sale is CATEGORISED as a gift-card sale in the journal — without it,
// normalizePaymentLineItem rejects the kind and the row lands in 'other'.
export type PaymentLineItemKind =
  | 'subscription'
  | 'course'
  /** A scheduled COURSE, a bounded set of lessons sold once. Its own kind
   *  rather than 'course': that one is the online-courses plugin, and the two
   *  are different products with different entitlements. */
  | 'course_block'
  | 'product'
  | 'drop_in'
  | 'appointment'
  | 'gift_card'
  | 'other'

export interface PaymentLineItem {
  kind: PaymentLineItemKind
  /** Subscription-type link (kind === 'subscription'). priceId selects credits/recurrence. */
  subscriptionTypeId?: string | null
  /** Which course was bought (kind === 'course_block'). */
  courseBlockId?: string | null
  priceId?: string | null
  /** Course link (kind === 'course') — grants the lifetime entitlement on apply. */
  courseId?: string | null
  /** Product link (kind === 'product') — record-only (merch, no entitlement). */
  productId?: string | null
  variantId?: string | null
  /** Denormalized display label ("what was bought") for the payments list. */
  label?: string | null
  /**
   * The promo code this purchase was discounted with (canonical uppercase), or
   * absent. A SYSTEM STAMP, never manager-editable: the webhook copies it from
   * the Checkout Session metadata (`lineItemFromMetadata` in connect/webhook.ts)
   * and `normalizePaymentLineItem` deliberately does NOT read it off a client
   * payload — `updatePaymentRecord` carries the stored value forward instead, so
   * editing "what was paid" can never invent or erase a redemption.
   *
   * This is the ONLY place the code touches the money side. A promo writes no
   * finance journal row and no CSV column (docs/promo-codes.md → "Finance"), so
   * "who used this code and what did they pay" is answered from here and from
   * the redemptions ledger — nowhere else.
   */
  promoCode?: string | null
  /**
   * The plan's intro offer this membership was sold under (kind ===
   * 'subscription'), or absent. Same rules as `promoCode` above, and for the
   * same reason: a SYSTEM STAMP copied by the webhook from the Checkout Session
   * metadata, never read off a client payload by `normalizePaymentLineItem`,
   * and carried forward across a manager's edit by `updatePaymentRecord`.
   *
   * `amount` is what was charged per period WHILE the offer ran (major units,
   * 0 = free) and `periods` how many periods that was. Neither is a money event
   * of its own: like a promo, an intro offer writes NO finance journal row —
   * the money event is the smaller charge, which the payment row already
   * carries. This exists so "why did this member pay 1.00 for an 79.00 plan"
   * has an answer on the row itself.
   */
  introOffer?: { periods: number; amount: number } | null
  /**
   * This drop-in charge was a PAID TRIAL — a newcomer's first class, charged at
   * `Activity.trialPriceAmount` through `createDropInCheckout({ trial: true })`
   * — rather than an ordinary drop-in. A SYSTEM STAMP, with exactly the rules of
   * `promoCode` and `introOffer` above: written by the Connect webhook from the
   * Checkout Session metadata (`md.trial`), never read off a client payload by
   * `normalizePaymentLineItem`, carried forward across a manager's edit by
   * `updatePaymentRecord`.
   *
   * WHAT IT IS FOR. The money side of a paid trial was already complete — a
   * `member_payments` row, a finance-journal charge row, `payment_status: 'paid'`
   * on the booking — but every one of them said `drop_in`, so nothing anywhere
   * connected the studio's revenue to the trial that earned it. The contact side
   * had the mirror gap: `Contact.trial_used_at` is stamped identically by the
   * free door (`bookSession`) and the paid one, so after the fact a paid trial
   * and a free one were indistinguishable. This one stamp closes both, because
   * the payments table it feeds is also the contact's Payments tab.
   *
   * IT IS NOT A CATEGORY. There is no `FinanceCategory` member for a trial and
   * no journal row of its own: a paid trial is a drop-in sale that happened to
   * be somebody's first, and the money event is the charge that is already
   * booked. It is also not a subscription, and nothing here may make it look
   * like one.
   */
  trial?: boolean
}

/**
 * The receipt a DESK SALE of this line-item would send, or null for one that
 * warrants none (UX-80).
 *
 * ONE PREDICATE, shared: the functions rail dispatches on it
 * (`payments/deskReceipt.ts`) and the manager dialogs mount their "send the
 * buyer a receipt" checkbox on it, so the box cannot offer a mail the server
 * would then decline to send.
 *
 * Only the three kinds that have a body: a credit pack / membership, a course,
 * a product. The rest are excluded because a receipt would be worse than
 * silence, not because nobody has written one yet — a gift card's own mail
 * carries the CODE, a drop-in and an appointment are confirmed by the BOOKING
 * (which can name the class and the time, as a payment row cannot), and `other`
 * grants nothing a buyer does not already hold.
 */
export function deskReceiptKindFor(
  lineItem: Pick<PaymentLineItem, 'kind'> | null | undefined
): 'subscription' | 'course' | 'product' | null {
  const k = lineItem?.kind
  return k === 'subscription' || k === 'course' || k === 'product' ? k : null
}

/**
 * Whether the "send the buyer a receipt" box should START TICKED for this sale.
 *
 * THE DEFAULT FOLLOWS WHAT THE SALE GRANTS, not which rail it came down. A
 * receipt earns its send when it tells the buyer something that exists nowhere
 * else in their world:
 *
 *   • a credit pack — the NUMBER. Ten classes, and the only other place the ten
 *     lives is a member area nobody has told them about yet. Ticked.
 *   • a course — WHERE TO WATCH IT. Ticked.
 *   • a membership — what they hold and until when. Ticked.
 *   • a product — they are holding the hoodie. The collection terms may still be
 *     worth sending, but the studio just said them out loud, so this one starts
 *     UNticked and is one click away.
 *
 * The counter-argument to ticking anything — the money changed hands in front of
 * a person who already knows what they bought — is real, and it is exactly why
 * this is a visible checkbox rather than an always-on send or a settings toggle.
 * The studio can see it, and untick it, at the moment of the sale.
 */
export function deskReceiptDefaultOn(
  lineItem: Pick<PaymentLineItem, 'kind'> | null | undefined
): boolean {
  const kind = deskReceiptKindFor(lineItem)
  return kind === 'subscription' || kind === 'course'
}

export interface ExternalPayment {
  /** Firestore doc id = `${gateway}:${gatewayRef}` (idempotency key). */
  id: string
  gateway: ExternalPaymentGateway
  /** For manual payments: the studio-configured mode it was taken with (free label,
   * e.g. "Cash" / "Bank transfer" / "TWINT"). Unset for gateway rows. */
  payment_mode?: string | null
  /** The gateway's own reference: Payrexx transaction id / Stripe event id / manual autoId. */
  gatewayRef: string
  /**
   * Whether `gatewayRef` names the PAYMENT (the intended dedup key, so every
   * event about one payment converges on one row) or something else the event
   * happened to carry. `'fallback'` warns that a sibling event about the same
   * money would write a SECOND row — see the caveat in
   * functions/src/billing/handleTeamStripeWebhook.ts. Absent on rows written
   * before the field existed, and on rails that never fall back.
   */
  gateway_ref_kind?: 'payment' | 'fallback'
  /** Linked Linyup contact, or null when unassigned (manager assigns later). */
  contact_id: string | null
  assignment_status: PaymentAssignmentStatus
  /** Payer email as reported by the gateway — used for matching + display. */
  email: string | null
  /** Gross amount in MINOR units (Rappen/cents), aligned with MemberPayment.amount. */
  amount: number | null
  currency: string
  /** Optional membership linkage, when the payment maps to a subscription type.
   * Superseded by `line_item` (kept for back-compat + the webhook default). */
  subscription_type_id?: string | null
  membership_expiration?: Timestamp | null
  /** Structured "what was bought" — drives entitlements (subscription/course/credits). */
  line_item?: PaymentLineItem
  /** Free-text "what was paid" note — prefilled with a default suggestion on record. */
  comment?: string | null
  /** The gateway's raw status string (e.g. 'confirmed', 'succeeded'). */
  raw_status: string
  processed_at: Timestamp
  /** Set when a manager (re)assigns the contact via updatePaymentRecord. */
  assigned_by?: string | null
  assigned_at?: Timestamp | null
  /**
   * VOIDED — a manager un-recorded this payment (`voidManualPayment`, manual
   * rows only). The row survives as the audit record of the mistake, and its
   * effects have been taken back.
   *
   * This is the one status the record-only rail has. A gateway refund on a BYO
   * row happens in the studio's own gateway and never reaches us, so `amount`
   * remains the whole story there — but a void says the money never arrived at
   * all, so EVERY money reader must skip these rows (byoToUnified,
   * useMonthlyRevenue) and `updatePaymentRecord` refuses to edit one.
   */
  voided_at?: Timestamp | null
  voided_by?: string | null
  void_reason?: string | null
}

// ─── Comment presets ─────────────────────────────────────────────────────────
// Stable machine keys for the "what was paid" comment quick-pick. The displayed
// label is resolved in the frontend from the `PaymentComment` i18n namespace
// (`preset_<key>`); the STORED value is the resolved free-text string (free-text
// custom entries are also allowed). Keys are the stable identifier — never reuse
// or repurpose one. Surfaced as a combobox/datalist in the assign-payment dialog.
export const PAYMENT_COMMENT_PRESETS = [
  'subscription_signup',
  'subscription_renewal',
  'product',
  'course',
  'drop_in',
  'event',
  'other',
] as const

export type PaymentCommentPreset = (typeof PAYMENT_COMMENT_PRESETS)[number]

// Default MANUAL payment modes a team starts with (Settings → Payments). Plain
// labels the studio can rename/remove; seeded onto new teams (createTeamRecord +
// the seed scripts) and used as the Record-payment dialog fallback when a team
// has none configured. TWINT is Swiss-first; edit per market.
export const DEFAULT_PAYMENT_MODES: readonly string[] = [
  'Cash',
  'Bank transfer',
  'TWINT',
  'Other',
]
