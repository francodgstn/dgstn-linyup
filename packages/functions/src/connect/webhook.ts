/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Stripe Connect — webhook handler (member → studio payments).
//
// Separate endpoint + signing secret from the SaaS-billing webhook
// (handleStripeWebhook). Connect events carry `event.account` (the connected
// account id), which we map back to a team via connect_accounts/{acctId}.
//
// Invariants:
//   • Verify the signature (constructConnectWebhookEvent).
//   • Idempotent: a per-event marker doc guards against duplicate delivery.
//   • Always return 200 after signature verification so Stripe stops retrying;
//     processing errors are logged, not surfaced as 5xx (except signature/secret).
//   • Reconcile local state from events only — never trust client-reported success.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import {
  AVAILABILITY_COLLECTION,
  CONNECT_ACCOUNTS_COLLECTION,
  CONNECT_WEBHOOK_EVENTS_COLLECTION,
  CONTACTS_COLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  WAITLIST_SUBCOLLECTION,
  buildConnectChargeTxn,
  buildConnectRefundTxn,
  buildDisputeTxn,
  buildPayoutTxn,
  appointmentChargeIsDuplicate,
  countHoldingSeats,
  financeTxnId,
  isExpiredAppointmentHold,
  mapCategory,
  seatsFree,
  toMinorUnits,
  type ConnectOnboardingModel,
  type FinanceCategory,
  type SaasPlan,
  localizedPublicUrl,
} from '@linyup/shared'
import { releaseWaitlistOffer } from '../booking/waitlist/release'
// The paid CLASS booking's receipt — always on, deliberately outside the
// `booking_confirmation` toggle. See that module's header.
import { sendPaidBookingConfirmation } from '../booking/paidConfirmation'
// The SHOP purchase receipts — credit pack/membership, course, product. Same
// posture, one module over. See that module's header.
import {
  sendCoursePurchaseReceipt,
  sendMembershipPurchaseReceipt,
  sendProductPurchaseReceipt,
} from './purchaseReceipts'
import { canCreateContact } from '../utils/contactCap'
import { getSecret } from '../utils/secrets'
import { withErrorReporting } from '../utils/reportError'
import { generateBookingReference, generateSecureToken } from '../utils/crypto'
import { getHostingUrl } from '../utils/env'
import { buildEmailTemplate, sendEmail } from '../utils/email'
import {
  constructConnectWebhookEvent,
  getConnectStripe,
  refundDirectCharge,
  retrieveAccountStatus,
} from '../utils/connect/client'
import { persistAccountStatus } from './access'
import { resolveSingleContact } from '../utils/contacts'
import { grantCourseEntitlement, writeContactSubscriptionFields } from '../payments/effects'
import { recordPlanPurchase } from '../payments/planPurchases'
import {
  commitGiftCardDrawdown,
  giftCardCurrency,
  mintGiftCard,
  releaseGiftCardHold,
  reverseGiftCardDrawdown,
  voidGiftCardValue,
} from './giftCards'
import { withLedgerExpiry } from '../utils/ledgerRetention'
// The promo lifecycle's two webhook entry points. Both are best-effort and
// carry their own try/catch: a promo commit that throws must not stop a booking
// from confirming — the customer paid the discounted price, and owning the seat
// matters more than the count.
import { commitPromoFromMetadata, releasePromoFromMetadata } from './promoCodes'
import { markPolicyFeePaid } from '../booking/policyFees'
import { asLang, runAppointmentSlotTransaction } from '../appointments/booking'
import { releaseAppointmentHold } from '../appointments/holdRelease'
import { sendAppointmentBookingEmails } from '../appointments/emails'
import {
  linkFinanceTxnContact,
  linkFinanceTxnPayout,
  recordFinanceTransaction,
  retrieveChargeFees,
  upgradeChargeFeesIfDegraded,
} from '../finance/journal'
// Stripe moved several of the fields this file reads (Basil → Dahlia). Every one
// of those reads goes through objectShape.ts, which knows the modern location,
// keeps a narrow legacy fallback, and says out loud when a field is in neither.
// Never re-inline one of these reads — see that module for what it cost last
// time.
import {
  INVOICE_PAYMENTS_EXPAND,
  SUBSCRIPTION_LATEST_INVOICE_PAYMENTS_EXPAND,
  invoiceBillsSubscription,
  readInvoicePaymentIntentId,
  readInvoiceSubscriptionId,
  readInvoiceSubscriptionMetadata,
  readOrReport,
  readSubscriptionCancellation,
  readSubscriptionPeriod,
  reportStripeShape,
  type StripeBalanceTransactionListResponse,
  type StripeChargeObject,
  type StripeCheckoutSessionObject,
  type StripeDisputeObject,
  type StripeInvoiceObject,
  type StripePayoutObject,
  type StripePaymentIntentObject,
  type StripeRefundListResponse,
  type StripeSubscriptionObject,
  type StripeWebhookPayload,
} from '../utils/stripe/objectShape'

// Account/capability events → re-fetch the account (source of truth) and persist.
// Covers classic Connect account events and v2 thin account events.
function isAccountEvent(type: string): boolean {
  return (
    type === 'account.updated' ||
    type === 'capability.updated' ||
    type.startsWith('v2.core.account')
  )
}

interface TeamRef {
  teamId: string
  model: ConnectOnboardingModel
}

async function resolveTeam(accountId: string | undefined): Promise<TeamRef | null> {
  if (!accountId) return null
  const snap = await admin.firestore().collection(CONNECT_ACCOUNTS_COLLECTION).doc(accountId).get()
  if (!snap.exists) return null
  const d = snap.data()!
  return { teamId: d.teamId as string, model: (d.model as ConnectOnboardingModel) ?? 'managed' }
}

function memberPaymentRef(teamId: string, paymentIntentId: string) {
  return admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
    .doc(paymentIntentId)
}

function memberSubscriptionRef(teamId: string, subscriptionId: string) {
  return admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .doc(subscriptionId)
}

/** True if the contact holds a LIVE (active/trialing/past_due) member subscription of
 * the given type OTHER than excludeSubId (and not an already-flagged duplicate). The
 * checkout safety net uses this to detect a same-type double purchase. Queries by
 * contactId only (single-field index, like onMemberSubscriptionWrite) and filters in
 * memory — a contact has few subscriptions. */
async function contactHasOtherLiveSameType(
  teamId: string,
  contactId: string,
  subscriptionTypeId: string,
  excludeSubId: string
): Promise<boolean> {
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .where('contactId', '==', contactId)
    .get()
  const live = new Set(['active', 'trialing', 'past_due'])
  return snap.docs.some((d) => {
    if (d.id === excludeSubId) return false
    const s = d.data()
    return (
      s.subscriptionTypeId === subscriptionTypeId && live.has(s.status as string) && !s.duplicate
    )
  })
}

// ─── contact membership linkage (mirror of handlePayrexxWebhook) ─────────────────
// A membership payment carries metadata.kind === 'membership' + subscriptionTypeId.
// On success we update the buying contact's membership, just like Payrexx does.

function addMonths(months: number): Timestamp {
  const d = new Date()
  d.setMonth(d.getMonth() + months)
  return Timestamp.fromDate(d)
}

/** Resolve the contact: prefer metadata.contactId (verified to belong to the team),
 * else fall back to a UNIQUE email match (none/ambiguous → null, never guess). */
async function resolveContactId(
  teamId: string,
  md: Record<string, string>,
  fallbackEmail?: string | null
): Promise<string | null> {
  if (md.contactId) {
    const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(md.contactId).get()
    if (snap.exists && snap.data()?.teamId === teamId) return md.contactId
  }
  if (fallbackEmail) {
    const { contactId } = await resolveSingleContact(teamId, fallbackEmail)
    return contactId
  }
  return null
}

/**
 * Materialise a lesson-credit grant for a paid credit pack (metadata.credits on
 * a one-off membership charge). Doc id = paymentIntentId, so the two webhook
 * events a purchase produces (checkout.session.completed + payment_intent.succeeded)
 * converge on one grant — `create()` refuses the second write. The
 * onCreditGrantWrite sync recomputes Contact.credit_summary.
 */
async function applyCreditGrant(
  teamId: string,
  contactId: string,
  md: Record<string, string>,
  paymentIntentId: string
): Promise<void> {
  const credits = md.credits ? parseInt(md.credits, 10) : 0
  if (!credits || credits <= 0 || !md.subscriptionTypeId) return
  const months = md.includedMonths ? parseInt(md.includedMonths, 10) : 0
  try {
    await admin
      .firestore()
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
      .doc(paymentIntentId)
      .create({
        teamId,
        subscription_type_id: md.subscriptionTypeId,
        subscription_type_name: md.subscriptionTypeName ?? null,
        price_id: md.priceId ?? null,
        credits_total: credits,
        credits_used: 0,
        expires_at: months > 0 ? addMonths(months) : null,
        source: 'stripe',
        payment_intent_id: paymentIntentId,
        // Same value as payment_intent_id on this rail, under the name the
        // shared grantPaymentCredits uses. Provenance has to read the same on
        // every rail: a reversal that looked for `payment_ref` alone would
        // silently miss every Connect credit pack. (The reversal keys off the
        // DOC ID, not either field — but a field that disagrees between rails
        // is an invitation to key off the field.)
        payment_ref: paymentIntentId,
        created_at: FieldValue.serverTimestamp(),
      })
    console.log(
      `[connect] credit grant: ${credits} credits (type=${md.subscriptionTypeId}) → contact ${contactId}`
    )
  } catch (err: unknown) {
    // ALREADY_EXISTS = the sibling webhook event won the race — expected.
    if ((err as { code?: number }).code === 6) return
    throw err
  }
}

/** Write the subscription fields onto a known contact + an activity-log entry.
 *
 * The affiliation axis is still NOT touched here — `membership_expiration` was
 * an affiliation field and stays gone. What the caller passes as
 * `membershipExpiration` is the SUBSCRIPTION grant's own end date, computed from
 * a one-time price's `included_months`, and it now lands on
 * `subscription_expires_at`. It was computed and discarded until the readers to
 * honour it existed; they do now (`planGrantIsCurrent`).
 *
 * ONE-TIME ONLY, guarded here rather than trusted from metadata: a recurring
 * plan's end is Stripe's to say, and a second end date stamped alongside it
 * would cut off a member who is still paying. */
async function writeContactMembership(
  teamId: string,
  contactId: string,
  md: Record<string, string>,
  opts: {
    amountRappen: number
    membershipExpiration: Timestamp | null
    /** The one-off charge these fields were written for, or null on a RECURRING
     *  renewal (handleSubscription), where no single payment owns them. */
    paymentIntentId?: string | null
  }
): Promise<void> {
  const db = admin.firestore()
  const grantExpiry = md.recurrence === 'one_time' ? opts.membershipExpiration : null
  await writeContactSubscriptionFields(db, contactId, {
    subscriptionTypeId: md.subscriptionTypeId,
    subscriptionTypeName: md.subscriptionTypeName ?? null,
    priceId: md.priceId ?? null,
    recurrence: md.recurrence ?? null,
    amountMajor: Math.round(opts.amountRappen) / 100, // contact stores major units
    // NULL on a renewal is load-bearing, not a gap: it OVERWRITES the ref of any
    // earlier one-off purchase, so refunding that old charge can no longer clear
    // a membership this renewal is paying for.
    sourcePaymentRef: opts.paymentIntentId ?? null,
    // Whole-record rule: written every time, null included, so starting a proper
    // subscription ERASES the end date an earlier intro purchase left behind.
    expiresAt: grantExpiry,
  })
  // Counts toward the price's per-contact purchase cap. A renewal carries no
  // paymentIntentId and is deliberately not a purchase — see planPurchases.ts.
  await recordPlanPurchase(db, contactId, {
    teamId,
    subscriptionTypeId: md.subscriptionTypeId,
    priceId: md.priceId ?? null,
    amountMajor: Math.round(opts.amountRappen) / 100,
    source: 'stripe_connect',
    paymentRef: opts.paymentIntentId ?? null,
  })
  await db
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection('activity_log')
    .add(withLedgerExpiry('activity_log', {
      type: 'payment_received',
      source: 'stripe_connect',
      message: `Membership payment received${md.subscriptionTypeName ? ` · ${md.subscriptionTypeName}` : ''}`,
      // Every applyPaymentEffects entry carries this; this one used to omit it,
      // so the contact timeline could not link back to the exact payment.
      ...(opts.paymentIntentId ? { payment_id: opts.paymentIntentId } : {}),
      timestamp: FieldValue.serverTimestamp(),
    }))
}

/** Apply membership to an EXISTING contact (resolved by id/email). Used by the
 * payment_intent / subscription handlers (incl. renewals). No contact creation. */
async function applyMembership(
  teamId: string,
  md: Record<string, string>,
  opts: {
    amountRappen: number
    membershipExpiration: Timestamp | null
    fallbackEmail?: string | null
    paymentIntentId?: string | null
  }
): Promise<void> {
  if (md.kind !== 'membership' || !md.subscriptionTypeId) return
  const contactId = await resolveContactId(teamId, md, opts.fallbackEmail)
  if (!contactId) {
    console.log(`[connect] membership: no existing contact matched (team=${teamId})`)
    return
  }
  await writeContactMembership(teamId, contactId, md, opts)
  if (opts.paymentIntentId) await applyCreditGrant(teamId, contactId, md, opts.paymentIntentId)
}

function splitName(full?: string | null): { firstname: string; lastname: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstname: '', lastname: '' }
  if (parts.length === 1) return { firstname: parts[0], lastname: '' }
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') }
}

/**
 * Resolve a contact by a UNIQUE email match, or CREATE one from the buyer's
 * checkout details. Matching mirrors resolveSingleContact: exactly one active
 * match links; >1 (a shared family email) returns null so the studio assigns it,
 * never the wrong child. Cap-aware: on a plan with a hard contact cap (Free), if
 * the team is already at the limit the contact is NOT created (returns null) — the
 * payment is still recorded; the studio links it after upgrading/freeing a slot.
 */
async function resolveOrCreateContact(
  teamId: string,
  plan: SaasPlan,
  info: {
    email: string
    name?: string | null
    phone?: string | null
    firstname?: string | null
    lastname?: string | null
  },
  pendingSignup = false
): Promise<string | null> {
  const db = admin.firestore()
  const { contactId, count } = await resolveSingleContact(teamId, info.email)
  if (contactId) return contactId
  if (count > 1) {
    console.log(
      `[connect] shop purchase: ${count} contacts share ${info.email} (team=${teamId}) — left unassigned`
    )
    return null
  }

  // count === 0 → create the contact (cap-aware; shared with shop registration).
  if (!(await canCreateContact(teamId, plan))) {
    console.log(
      `[connect] shop purchase: contact cap reached (team=${teamId}, plan=${plan}) — contact not created`
    )
    return null
  }

  // Prefer the first/last name captured in the shop modal (passed via checkout
  // metadata); fall back to splitting Stripe's single `name` (unreliable — e.g. empty
  // for TWINT, or "First Last" merged on the card).
  const metaFirst = (info.firstname ?? '').trim()
  const metaLast = (info.lastname ?? '').trim()
  const { firstname, lastname } =
    metaFirst || metaLast ? { firstname: metaFirst, lastname: metaLast } : splitName(info.name)
  const ref = db.collection(CONTACTS_COLLECTION).doc()
  await ref.set({
    teamId,
    email: info.email,
    firstname,
    lastname,
    ...(info.phone ? { phone: info.phone } : {}),
    // The shop is an OFF-FUNNEL entry route: a buyer who self-creates via the public
    // shop hasn't started the trial→join journey (they may only have bought a one-off
    // product/course, and may never intend to train). So they get NO acquisition_stage
    // ("not applicable"); the purchase is captured on the subscription axis (recurring)
    // or as payment/order history (one-off). If they later book a trial they enter the
    // funnel normally. Their membership (if any) is reflected via active_subscriptions.
    entry: 'shop',
    // 'full' checkout: paid but the buyer still has to finish signup (consent + the
    // studio's required fields). Flag it so the dashboard shows "pending signup" and the
    // signup-finalize page completes it. Set only on CREATE — never flip a returning member.
    ...(pendingSignup ? { pending_signup: true, signup_completed_at: null } : {}),
    archived_at: null,
    deleted_at: null,
    created_at: FieldValue.serverTimestamp(),
  })
  return ref.id
}

/**
 * Resolve the buyer's contact from checkout metadata: a login-first checkout always
 * carries metadata.contactId (the session identity). Re-verified against the team
 * before trusting — metadata is set server-side, but never skip the ownership check.
 * Returns null for legacy sessions without one (caller falls back to email linking).
 */
async function verifiedMetadataContact(
  teamId: string,
  md: Record<string, string>
): Promise<string | null> {
  if (!md.contactId) return null
  const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(md.contactId).get()
  return snap.exists && snap.data()?.teamId === teamId ? md.contactId : null
}

/**
 * First successful payment CONFIRMS a provisional contact (a login-first shop
 * registration — see Contact.provisional): clear the flag + purge deadline so the
 * daily purge task leaves it alone. No-op for normal contacts.
 */
async function confirmProvisionalContact(contactId: string): Promise<void> {
  const ref = admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId)
  const snap = await ref.get()
  if (snap.exists && snap.data()?.provisional === true) {
    await ref.update({
      provisional: FieldValue.delete(),
      provisional_expires_at: FieldValue.delete(),
    })
    console.log(`[connect] payment confirmed provisional contact ${contactId}`)
  }
}

// ─── per-event-type handlers ─────────────────────────────────────────────────────

/** Best-effort: mirror a late-resolved buyer contact onto the finance journal
 * charge row (checkout handlers link the contact AFTER payment_intent.succeeded
 * already journaled the charge). Metadata only — never touches amounts. */
async function stampFinanceContact(teamId: string, piId: string, contactId: string): Promise<void> {
  try {
    await linkFinanceTxnContact(teamId, financeTxnId('connect', 'charge', piId), contactId)
  } catch (err) {
    console.warn(`[connect] finance contact stamp failed (pi=${piId}):`, err)
  }
}

/**
 * Structured "what was bought" for the payments dashboard's assign/edit dialog,
 * mirroring the BYO rail's ExternalPayment.line_item (kind 'membership' maps to
 * the line-item spelling 'subscription'). Built from checkout metadata; renewal
 * invoices get theirs stamped by handleInvoice from the subscription doc.
 *
 * The promo code is attached ONCE, by the wrapper below, rather than in each
 * branch. A promo can ride `drop_in`, `appointment`, `product` and `course` —
 * and repeating the same spread in every branch that could ever carry one is a
 * place to forget it every time a branch is added here or a rail is added to
 * `PROMO_TARGETS`. One wrapper cannot be forgotten in a branch it wraps.
 */
/**
 * The intro offer the checkout was created with, off the session metadata.
 *
 * Written by `introCheckoutMetadata` (connect/introOffer.ts) from an offer that
 * `resolveIntroOffer` had already accepted — so this only has to survive junk,
 * not re-decide validity. Returns null when the checkout carried no offer.
 */
function readIntroMetadata(md: Record<string, string>): { periods: number; amount: number } | null {
  if (!md.introPeriods) return null
  const periods = Number(md.introPeriods)
  const amount = Number(md.introAmount)
  if (!Number.isInteger(periods) || periods < 1) return null
  if (!Number.isFinite(amount) || amount < 0) return null
  return { periods, amount }
}

function baseLineItemFromMetadata(md: Record<string, string>): Record<string, unknown> | null {
  if (md.kind === 'membership' && md.subscriptionTypeId) {
    // The intro offer, if the checkout carried one. Same class of stamp as
    // `promoCode` below (system-written, never client-supplied) and, for the
    // same reason, it writes NO finance journal row: a discount is not a money
    // event on a cash basis — the smaller charge is. It rides the membership
    // branch rather than the wrapper because an intro offer belongs to a PLAN
    // and cannot appear on any other kind.
    const intro = readIntroMetadata(md)
    return {
      kind: 'subscription',
      subscriptionTypeId: md.subscriptionTypeId,
      priceId: md.priceId ?? null,
      label: md.subscriptionTypeName ?? null,
      ...(intro ? { introOffer: { periods: intro.periods, amount: intro.amount } } : {}),
    }
  }
  if (md.kind === 'product' && md.productId) {
    return {
      kind: 'product',
      productId: md.productId,
      variantId: md.variantId ?? null,
      label: md.variantLabel
        ? `${md.productName ?? 'Product'} · ${md.variantLabel}`
        : (md.productName ?? null),
    }
  }
  if (md.kind === 'course' && md.courseId) {
    return { kind: 'course', courseId: md.courseId, label: md.courseTitle ?? null }
  }
  if (md.kind === 'drop_in') {
    // A PAID TRIAL is a drop-in charge whose metadata says it was somebody's
    // first class (`createDropInCheckout({ trial: true })`). Stamped here, on the
    // money row, because until this the money and the trial had no field in
    // common: the payment said `drop_in` and the contact said `trial_used_at`,
    // and neither named the other. Same class of stamp as `promoCode` below —
    // system-written, never client-supplied — and, like it, NOT a journal
    // category: the charge is already booked as the drop-in sale it is.
    return {
      kind: 'drop_in',
      label: md.activityName ?? null,
      ...(md.trial === 'true' ? { trial: true } : {}),
    }
  }
  if (md.kind === 'appointment') {
    return { kind: 'appointment', label: md.activityName ?? null }
  }
  if (md.kind === 'gift_card') {
    // Its own kind, not 'other': the manual rail derives the journal category
    // straight from line_item.kind (buildExternalPaymentTxn → mapCategory), so
    // spelling it 'other' here would leave the two rails disagreeing about what
    // a gift-card sale is. Effect-less on both — see applyPaymentEffects.
    return { kind: 'gift_card', label: 'Gift card' }
  }
  if (md.kind === 'policy_fee') {
    return { kind: 'other', label: 'No-show fee' }
  }
  return null
}

/**
 * …and the promo stamp on top of it. `md.promoCode` is written by
 * `promoCheckoutMetadata` (connect/promoCodes.ts) onto every promo-carrying
 * Checkout Session. It reaches the PaymentIntent because
 * `createOneOffCheckoutSession` (utils/connect/client.ts) passes THE SAME
 * metadata object twice — once as the session's `metadata` and once as
 * `payment_intent_data.metadata`. Stripe copies nothing between the two, so a
 * key added to only one of those two spreads is missing on whichever handler
 * reads the other.
 *
 * This is the payment row's ONLY record of a discount, and it is deliberate: a
 * promo writes no finance journal row and adds no CSV column (docs/promo-codes.md
 * → "Finance"), because a discount is not a money event on a cash basis. So
 * `financeDescription` below is left alone on purpose — a journal row must never
 * mention the code.
 *
 * A promo only ever rides a kind that yields a line item, so there is no case
 * where a code is stamped and the row is null. If that ever stops being true,
 * the code is lost silently — which is why the promo rails are enumerated in
 * `PROMO_TARGETS` (shared/utils/paymentOptions.ts) rather than inferred here.
 */
function lineItemFromMetadata(md: Record<string, string>): Record<string, unknown> | null {
  const base = baseLineItemFromMetadata(md)
  if (!base) return null
  return md.promoCode ? { ...base, promoCode: md.promoCode } : base
}

/** Human "what was paid" label for the finance journal, from checkout metadata. */
function financeDescription(md: Record<string, string>): string | null {
  if (md.kind === 'product') {
    return md.variantLabel
      ? `${md.productName ?? 'Product'} · ${md.variantLabel}`
      : (md.productName ?? null)
  }
  if (md.kind === 'course') return md.courseTitle ?? null
  if (md.kind === 'membership') return md.subscriptionTypeName ?? null
  if (md.kind === 'drop_in') return md.activityName ?? 'Drop-in'
  if (md.kind === 'appointment') return md.activityName ?? 'Appointment'
  if (md.kind === 'gift_card') return 'Gift card'
  if (md.kind === 'policy_fee') return 'No-show fee'
  return md.purpose ?? null
}

async function handlePaymentIntent(
  team: TeamRef,
  pi: StripeWebhookPayload<StripePaymentIntentObject>,
  status: 'succeeded' | 'failed',
  eventId: string,
  accountId?: string
): Promise<void> {
  const md = (pi.metadata ?? {}) as Record<string, string>
  const now = FieldValue.serverTimestamp()

  // ── WHAT THE OTHER HANDLER MAY ALREADY KNOW ────────────────────────────────
  // An invoice-generated PaymentIntent — every subscription charge — carries NO
  // metadata of its own. So on that rail this handler knows the money and
  // `handleCheckoutCompleted` knows the buyer, and which of them runs first is up
  // to Stripe: event order is explicitly not guaranteed, and on the live test
  // account the two are 1–4 seconds apart (on one one-off checkout, the same
  // second). Every field this handler writes from `md` therefore has to be safe
  // in BOTH orders — a `merge` that writes a default over a resolved value is
  // still a write.
  //
  // One read, answering that for `contactId` and `purpose` (the two fields the
  // "unassigned subscription payment" symptom was actually made of) and for the
  // finance journal row further down.
  const prior = (await memberPaymentRef(team.teamId, pi.id).get()).data()
  const knownContactId = md.contactId ?? (prior?.contactId as string | undefined) ?? null

  await memberPaymentRef(team.teamId, pi.id).set(
    {
      teamId: team.teamId,
      paymentIntentId: pi.id,
      chargeId:
        typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? null),
      // OMITTED, never nulled — the same rule handleSubscription already applies
      // to its own identity fields. `contactId: md.contactId ?? null` merged an
      // unconditional null straight over the contact the checkout handler had
      // just resolved.
      ...(knownContactId ? { contactId: knownContactId } : {}),
      // `purpose` has a DEFAULT, so unlike contactId it cannot simply be omitted
      // (a row with no purpose is worse than a stale one). Metadata first, then
      // whatever is already recorded, then the default — so the checkout
      // handler's 'membership' is never overwritten with 'payment'.
      purpose: md.purpose ?? (prior?.purpose as string | undefined) ?? 'payment',
      // Product sales (kind === 'product') carry the catalogue reference so the
      // payments dashboard can show what was bought + which variant.
      ...(md.kind === 'product'
        ? {
            kind: 'product',
            productId: md.productId ?? null,
            productName: md.productName ?? null,
            variantLabel: md.variantLabel ?? null,
          }
        : {}),
      // Course sales (kind === 'course') carry the course reference so the payments
      // dashboard can show which course was bought.
      ...(md.kind === 'course'
        ? {
            kind: 'course',
            courseId: md.courseId ?? null,
            courseName: md.courseTitle ?? null,
          }
        : {}),
      // Membership purchases carry the subscription type name so the dashboard row
      // reads "Monthly Unlimited" instead of a bare "payment". (One-off membership
      // prices only — recurring invoice PIs carry no metadata; handleInvoice and the
      // checkout handler stamp those.)
      ...(md.kind === 'membership'
        ? {
            kind: 'membership',
            subscriptionTypeName: md.subscriptionTypeName ?? null,
          }
        : {}),
      // Drop-in (pay-per-class) charges carry the booked session so the payments
      // dashboard can show what the charge was for.
      ...(md.kind === 'drop_in'
        ? {
            kind: 'drop_in',
            sessionId: md.sessionId ?? null,
          }
        : {}),
      // Appointment (pay-per-1:1) charges carry the booked session likewise.
      ...(md.kind === 'appointment'
        ? {
            kind: 'appointment',
            sessionId: md.sessionId ?? null,
          }
        : {}),
      // Gift card purchases — the minted code is stamped on separately by
      // handleGiftCardCheckout once the card exists (this handler may run
      // before or after checkout.session.completed).
      ...(md.kind === 'gift_card' ? { kind: 'gift_card' } : {}),
      // No-show policy fees (E5) carry the fee id so the payments dashboard can
      // link back to teams/{teamId}/policy_fees/{feeId}.
      ...(md.kind === 'policy_fee' ? { kind: 'policy_fee', feeId: md.feeId ?? null } : {}),
      // Structured "what was bought" — fills the assign/edit dialog's line-item
      // picker, aligned with the BYO rail.
      ...(lineItemFromMetadata(md) ? { line_item: lineItemFromMetadata(md) } : {}),
      amount: pi.amount ?? 0,
      currency: pi.currency ?? 'chf',
      application_fee_amount: pi.application_fee_amount ?? 0,
      status,
      ...(status === 'succeeded' ? { amount_refunded: 0 } : {}),
      last_event_id: eventId,
      updated_at: now,
      created_at: now,
    },
    { merge: true }
  )

  // A successful one-off membership charge updates the buyer's contact membership
  // (and materialises the credit grant when the price is a credit pack).
  if (status === 'succeeded') {
    const months = md.includedMonths ? parseInt(md.includedMonths, 10) : 0
    await applyMembership(team.teamId, md, {
      amountRappen: pi.amount ?? 0,
      membershipExpiration: months > 0 ? addMonths(months) : null,
      fallbackEmail: (pi.receipt_email as string | undefined) ?? null,
      paymentIntentId: (pi.id as string | undefined) ?? null,
    })

    // Finance journal: fetch the authoritative fee split (Stripe fee + application
    // fee + net) from the charge's balance transaction, then append the charge row.
    // Failures never break payment processing — the backfill reconciles.
    try {
      const chargeId =
        typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? null)
      const fees = accountId && chargeId ? await retrieveChargeFees(accountId, chargeId) : null
      // THE OTHER HALF OF THE ORDERING FIX, using the same `knownContactId`
      // resolved at the top. `stampFinanceContact` covers the order we actually
      // observe (payment_intent.succeeded first, then checkout.session.completed):
      // the journal row exists by then, and the checkout handler stamps the
      // contact onto it. In the REVERSE order that stamp silently no-ops —
      // `linkFinanceTxnContact` swallows NOT_FOUND — and this create would write
      // the row with contact_id null and leave it there until someone ran
      // `pnpm backfill:finance`.
      await recordFinanceTransaction(
        buildConnectChargeTxn({
          teamId: team.teamId,
          paymentIntentId: pi.id as string,
          amount: (pi.amount as number) ?? 0,
          currency: pi.currency as string | undefined,
          applicationFeeAmount: (pi.application_fee_amount as number) ?? 0,
          fees,
          kind: md.kind ?? null,
          contactId: knownContactId,
          description: financeDescription(md),
          occurredAtMs: typeof pi.created === 'number' ? pi.created * 1000 : Date.now(),
          eventId,
        })
      )
      // Mirror the fee split onto the member_payments doc for the dashboard.
      if (fees) {
        await memberPaymentRef(team.teamId, pi.id).set(
          { stripe_fee_amount: fees.stripeFee, balance_txn_id: fees.balanceTxnId },
          { merge: true }
        )
      }
    } catch (err) {
      console.error(`[connect] finance journal write failed (pi=${pi.id}):`, err)
    }
  }
}

async function handleChargeRefunded(
  team: TeamRef,
  charge: StripeWebhookPayload<StripeChargeObject>,
  eventId: string,
  accountId?: string
): Promise<void> {
  const piId =
    typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
  if (!piId) return
  const amount: number = charge.amount ?? 0
  const amountRefunded: number = charge.amount_refunded ?? 0
  const appFee: number = charge.application_fee_amount ?? 0

  // The refund list. On current Stripe API versions the charge object in the
  // webhook payload NO LONGER embeds `refunds` — fetch them from the API when
  // absent (without this, refunds[] and the finance-journal refund rows were
  // silently never written even though amount_refunded/status updated).
  let refundObjects = (charge.refunds?.data ?? []) as any[]
  if (refundObjects.length === 0 && amountRefunded > 0 && accountId) {
    try {
      const stripe = await getConnectStripe()
      const list: StripeRefundListResponse = await stripe.refunds.list(
        { payment_intent: piId, limit: 100 },
        { stripeAccount: accountId }
      )
      refundObjects = (list.data ?? []) as any[]
    } catch (err) {
      console.error(`[connect] refund list fetch failed (pi=${piId}):`, err)
    }
  }

  // Proportional application-fee reversal per refund (best-effort: Stripe reverses
  // the fee in proportion to each refund via refund_application_fee).
  const refunds = refundObjects.map((r) => ({
    refundId: r.id as string,
    amount: (r.amount as number) ?? 0,
    feeReversed: amount > 0 ? Math.round((((r.amount as number) ?? 0) / amount) * appFee) : 0,
    reason: (r.reason as string) ?? null,
    created_at: r.created
      ? Timestamp.fromMillis((r.created as number) * 1000)
      : FieldValue.serverTimestamp(),
  }))

  const fullyRefunded = amountRefunded >= amount && amount > 0
  await memberPaymentRef(team.teamId, piId).set(
    {
      amount_refunded: amountRefunded,
      // Don't clobber a previously-written list when the fetch fallback failed.
      ...(refunds.length > 0 ? { refunds } : {}),
      status: fullyRefunded ? 'refunded' : 'partially_refunded',
      last_event_id: eventId,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  // Finance journal: one row PER refund object (partials each get a row; the
  // deterministic re_ id makes redeliveries no-ops). Context (kind/contact/label)
  // comes from the payment doc just updated.
  try {
    const paySnap = await memberPaymentRef(team.teamId, piId).get()
    const pay = paySnap.data() ?? {}
    for (const r of refundObjects) {
      await recordFinanceTransaction(
        buildConnectRefundTxn({
          teamId: team.teamId,
          refundId: r.id as string,
          paymentIntentId: piId,
          amount: (r.amount as number) ?? 0,
          feeReversed: amount > 0 ? Math.round((((r.amount as number) ?? 0) / amount) * appFee) : 0,
          currency: (charge.currency as string | undefined) ?? (pay.currency as string | undefined),
          kind: (pay.kind as string | undefined) ?? null,
          contactId: (pay.contactId as string | undefined) ?? null,
          // "Refund · " prefix so refunds read apart from their charge in the
          // entries list / CSV (disputes get the same treatment).
          description: `Refund · ${(pay.comment as string | undefined) ?? (pay.subscriptionTypeName as string | undefined) ?? (pay.productName as string | undefined) ?? (pay.courseName as string | undefined) ?? piId}`,
          occurredAtMs: typeof r.created === 'number' ? r.created * 1000 : Date.now(),
          eventId,
        })
      )
    }
  } catch (err) {
    console.error(`[connect] finance journal refund write failed (pi=${piId}):`, err)
  }
}

async function handleDispute(
  team: TeamRef,
  dispute: StripeWebhookPayload<StripeDisputeObject>,
  phase: 'created' | 'closed',
  eventId: string
): Promise<void> {
  const piId =
    typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id
  if (!piId) return
  await memberPaymentRef(team.teamId, piId).set(
    {
      dispute_status: dispute.status ?? 'unknown',
      dispute_reason: dispute.reason ?? null,
      dispute_amount: dispute.amount ?? null,
      last_event_id: eventId,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  // A disputed GIFT-CARD PURCHASE: kill the card the moment the chargeback
  // opens. Buying a card with a stolen card, redeeming it in full (which needs
  // no Stripe charge at all) and then charging back is otherwise a clean
  // laundering path — and since the guest purchase flow attaches no identity,
  // the code is the only thing left to stop. Best-effort: a failure here must
  // not cost us the dispute record above.
  if (phase === 'created') {
    try {
      const pay = (await memberPaymentRef(team.teamId, piId).get()).data()
      const soldCode = pay?.giftCardCode as string | undefined
      if (soldCode) {
        await voidGiftCardValue({
          teamId: team.teamId,
          code: soldCode,
          reason: `chargeback on ${piId}`,
        })
      }
    } catch (err) {
      console.error(`[connect] gift card void on dispute failed (pi=${piId}):`, err)
    }
  }

  // Finance journal. Funds movement comes from the dispute's balance transactions
  // (an inquiry/early-warning dispute has none — nothing to journal then):
  //   created      → withdrawal entries (net < 0) → 'dispute' row
  //   closed 'won' → reversal entries  (net > 0) → 'dispute_reversal' row
  // The dispute fee is the residual between balance net and the disputed amount,
  // so the row always ties to what actually moved on the studio's balance.
  try {
    const bts = ((dispute.balance_transactions ?? []) as any[]).filter(
      (bt) => typeof bt?.net === 'number'
    )
    const kind = phase === 'closed' && dispute.status === 'won' ? 'dispute_reversal' : 'dispute'
    if (phase === 'closed' && dispute.status !== 'won') return // lost/warning-closed: nothing new moved
    const relevant = bts.filter((bt) => (kind === 'dispute' ? bt.net < 0 : bt.net > 0))
    if (relevant.length === 0) return
    const balanceNet = relevant.reduce((sum, bt) => sum + (bt.net as number), 0)

    const paySnap = await memberPaymentRef(team.teamId, piId).get()
    const pay = paySnap.data() ?? {}
    await recordFinanceTransaction(
      buildDisputeTxn({
        teamId: team.teamId,
        disputeId: dispute.id as string,
        paymentIntentId: piId,
        amount: (dispute.amount as number) ?? 0,
        balanceNet,
        kind,
        currency: (dispute.currency as string | undefined) ?? (pay.currency as string | undefined),
        contactId: (pay.contactId as string | undefined) ?? null,
        category: mapCategory(pay.kind as string | undefined) as FinanceCategory,
        description: dispute.reason ? `Dispute · ${dispute.reason}` : 'Dispute',
        occurredAtMs: typeof dispute.created === 'number' ? dispute.created * 1000 : Date.now(),
        eventId,
      })
    )
  } catch (err) {
    console.error(`[connect] finance journal dispute write failed (dp=${dispute.id}):`, err)
  }
}

/**
 * charge.updated — the fee-enrichment healer. Async payment methods (TWINT, …)
 * succeed WITHOUT a balance transaction, so their journal row is written with
 * fee_source 'recorded' (Stripe fee unknown); Stripe emits charge.updated once
 * balance_transaction is populated — upgrade the row in place then (accounting
 * re-posts via onFinanceTransactionWrite). Card charges no-op here (already
 * authoritative from payment_intent.succeeded).
 * NOTE (ops): the Connect webhook endpoint must be subscribed to charge.updated
 * — see docs/finance-reports.md.
 */
async function handleChargeUpdated(
  team: TeamRef,
  charge: StripeWebhookPayload<StripeChargeObject>,
  accountId?: string
): Promise<void> {
  const piId =
    typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
  if (!piId || !accountId || !charge.balance_transaction) return
  try {
    const upgraded = await upgradeChargeFeesIfDegraded(
      team.teamId,
      accountId,
      piId,
      charge.id as string
    )
    if (upgraded) console.log(`[finance] fee split upgraded via charge.updated (pi=${piId})`)
  } catch (err) {
    // Healing must never fail the webhook — the backfill (--force-fees) reconciles.
    console.warn(`[finance] charge.updated fee upgrade failed (pi=${piId}):`, err)
  }
}

/**
 * payout.paid / payout.failed on the connected account — the settlement events
 * that let a studio reconcile Linyup's journal against its bank statement.
 * Writes the payout row, then stamps payout_id onto the charge rows whose
 * balance transactions the payout swept (metadata linkage; rows not yet written
 * are picked up by the backfill's payout pass).
 * NOTE (ops): the Stripe Connect webhook endpoint must be subscribed to
 * payout.paid + payout.failed — see docs/finance-reports.md.
 */
async function handlePayout(
  team: TeamRef,
  payout: StripeWebhookPayload<StripePayoutObject>,
  kind: 'paid' | 'failed',
  accountId: string,
  eventId: string
): Promise<void> {
  const created = await recordFinanceTransaction(
    buildPayoutTxn({
      teamId: team.teamId,
      payoutId: payout.id as string,
      amount: (payout.amount as number) ?? 0,
      kind,
      currency: payout.currency as string | undefined,
      occurredAtMs: typeof payout.created === 'number' ? payout.created * 1000 : Date.now(),
      arrivalDateMs: typeof payout.arrival_date === 'number' ? payout.arrival_date * 1000 : null,
      eventId,
    })
  )
  if (!created || kind !== 'paid') return

  // Link the swept charges (bounded pagination; linkage is best-effort metadata).
  try {
    const stripe = await getConnectStripe()
    let startingAfter: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const list: StripeBalanceTransactionListResponse = await stripe.balanceTransactions.list(
        {
          payout: payout.id as string,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
        { stripeAccount: accountId }
      )
      for (const bt of (list.data ?? []) as any[]) {
        if (bt.type === 'payout') continue
        await linkFinanceTxnPayout(team.teamId, bt.id as string, payout.id as string)
      }
      if (!list.has_more || !list.data?.length) break
      startingAfter = list.data[list.data.length - 1].id as string
    }
  } catch (err) {
    console.warn(`[connect] payout linkage failed (po=${payout.id}):`, err)
  }
}

async function handleSubscription(
  team: TeamRef,
  sub: StripeWebhookPayload<StripeSubscriptionObject>,
  eventId: string
): Promise<void> {
  const md = (sub.metadata ?? {}) as Record<string, string>
  const item = sub.items?.data?.[0]
  const now = FieldValue.serverTimestamp()

  // The billing period moved onto the subscription ITEM, and a billing-portal
  // cancellation is expressed as a `cancel_at` TIMESTAMP with the boolean left
  // false. Both were read from their old homes here and came back
  // undefined/false — the second and third symptoms of the Basil→Dahlia field
  // migration (utils/stripe/objectShape.ts).
  const period = readSubscriptionPeriod(sub)
  // A subscription that has ENDED has no current period, so a missing one there
  // is the truth rather than a shape surprise — `customer.subscription.deleted`
  // must not cry wolf on every cancellation.
  if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
    reportStripeShape('subscription.current_period_end', sub.id, period.source, `event ${eventId}`)
  }
  const periodEnd = period.end === null ? null : Timestamp.fromMillis(period.end * 1000)
  // Same item, same rail rule as the end (written whole, null included): the
  // start says WHICH SERVICE PERIOD this invoice bought — accrual readiness
  // (docs/finance-accrual.md, Phase 0). Docs from before 2026-08-31 carry only
  // the end; `backfill:subscription-lifecycle` repairs them.
  const periodStart = period.start === null ? null : Timestamp.fromMillis(period.start * 1000)
  const cancellation = readSubscriptionCancellation(sub)
  await memberSubscriptionRef(team.teamId, sub.id).set(
    {
      teamId: team.teamId,
      subscriptionId: sub.id,
      customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
      // Identity fields are OMITTED (not nulled) when the event's metadata lacks
      // them: Stripe events are unordered, so a pre-backfill subscription event
      // arriving AFTER checkout.session.completed must never wipe the contactId
      // that handler already stamped (it broke the contact's Stripe-billing view).
      ...(md.contactId ? { contactId: md.contactId } : {}),
      priceId: item?.price?.id ?? null,
      // The studio's stable type identity (from checkout metadata) — priceId above is
      // Stripe's ad-hoc inline price, useless for "same type" comparisons.
      ...(md.subscriptionTypeId ? { subscriptionTypeId: md.subscriptionTypeId } : {}),
      ...(md.subscriptionTypeName ? { subscriptionTypeName: md.subscriptionTypeName } : {}),
      ...(md.recurrence ? { recurrence: md.recurrence } : {}),
      amount: item?.price?.unit_amount ?? 0,
      currency: sub.currency ?? 'chf',
      application_fee_percent: sub.application_fee_percent ?? null,
      status: sub.status ?? 'incomplete',
      // Billing freeze (summer break / injury). When set, the rollup → 'paused'.
      pause_collection: sub.pause_collection ?? null,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      cancel_at_period_end: cancellation.cancelsAtPeriodEnd,
      // THE WHOLE CANCELLATION RECORD, and every field written on every event —
      // never omitted, never merged key-by-key. A REACTIVATION clears all of
      // these on Stripe's side, and a merge that skipped the nulls would leave a
      // dead end-date and a dead reason standing on a subscription that is
      // renewing again. `cancellation_details` in particular is set whole or
      // nulled, because Firestore DEEP-merges a nested map: writing just
      // `{reason}` over an older cancellation keeps that one's `feedback`.
      cancel_at:
        cancellation.cancelAt === null ? null : Timestamp.fromMillis(cancellation.cancelAt * 1000),
      canceled_at:
        cancellation.canceledAt === null
          ? null
          : Timestamp.fromMillis(cancellation.canceledAt * 1000),
      cancellation_details: cancellation.details,
      last_event_id: eventId,
      updated_at: now,
      created_at: now,
    },
    { merge: true }
  )

  // While the recurring membership is active, keep the contact's membership in
  // sync (expiry tracks the current period end). Cancellations don't extend it.
  if (sub.status === 'active' || sub.status === 'trialing') {
    await applyMembership(team.teamId, md, {
      amountRappen: item?.price?.unit_amount ?? 0,
      membershipExpiration: periodEnd,
    })
  }
}

/**
 * invoice.paid / invoice.payment_failed — the RENEWAL path.
 *
 * Every read in here used to miss: `invoice.subscription` was removed, so the
 * guard below returned on every delivery and the whole handler was dead. What
 * that silently cost is the contact stamp on every renewal charge — which is why
 * the "unassigned subscription payment" symptom would have recurred monthly even
 * after the checkout path was fixed.
 *
 * It did NOT cost a status: this handler does not own `status` and no longer
 * writes one. See the note at the write below.
 */
async function handleInvoice(
  team: TeamRef,
  invoice: StripeWebhookPayload<StripeInvoiceObject>,
  status: 'paid' | 'failed',
  eventId: string,
  accountId?: string
): Promise<void> {
  // A one-off invoice has no subscription by design and leaves quietly; an
  // invoice that SAYS it bills one and cannot name it is the shape surprise.
  const subRead = readInvoiceSubscriptionId(invoice)
  const subId = invoiceBillsSubscription(invoice)
    ? readOrReport(subRead, 'invoice.subscription', invoice.id, `event ${eventId}`)
    : subRead.value
  if (!subId) return
  const subRef = memberSubscriptionRef(team.teamId, subId)
  // ── WHO OWNS `status`: customer.subscription.*, and ONLY that handler ────────
  //
  // This path deliberately does NOT write `status`, and must not start. It used
  // to derive one from the invoice outcome (paid → 'active', failed →
  // 'past_due') — harmless only for as long as the whole handler was dead. Now
  // that it runs, that write FIGHTS handleSubscription, which stores the status
  // off the subscription object itself.
  //
  // Stripe gives no delivery-order guarantee between the two, so a late or
  // retried `invoice.paid` landing after `customer.subscription.deleted` would
  // flip a cancelled subscription back to 'active' — resurrecting a membership
  // nobody is paying for, and re-granting the entitlement behind it.
  //
  // Nothing is lost by staying out of it: the status an invoice implies is
  // carried by a `customer.subscription.updated` of its own, which is the event
  // this handler's counterpart already consumes. Observed once, on a live Stripe
  // test account (test clock, declining card, 2026-04-22.dahlia): a failed
  // renewal emitted `customer.subscription.updated` with `status: 'past_due'`,
  // in that trace ahead of `invoice.payment_failed`. ONE trace shows the event
  // exists, not an ordering — Stripe promises none, which is the whole reason
  // this handler must not write a status of its own.
  //
  // What the invoice IS authoritative for is the payment outcome, so that is all
  // it writes here.
  await subRef.set(
    {
      last_invoice_id: invoice.id ?? null,
      last_payment_status: status,
      last_event_id: eventId,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  // Link + label the invoice's charge: invoice-generated PaymentIntents carry no
  // metadata, so handlePaymentIntent records them as bare unassigned 'payment' rows.
  // The member_subscriptions doc holds the contact + type name — stamp them on.
  //
  // The invoice→payment link now lives at `payments.data[].payment.payment_intent`,
  // and that list is EXPAND-ONLY: it is not in the delivered payload, so this
  // costs one retrieve. A failed invoice has no payment to link, so it does not
  // pay that cost (and must not report a missing field it never expected).
  let piId = readInvoicePaymentIntentId(invoice).value
  if (!piId && status === 'paid' && accountId && typeof invoice.id === 'string') {
    try {
      const stripe = await getConnectStripe()
      const full: StripeInvoiceObject = await stripe.invoices.retrieve(
        invoice.id,
        { expand: [INVOICE_PAYMENTS_EXPAND] },
        { stripeAccount: accountId }
      )
      piId = readOrReport(
        readInvoicePaymentIntentId(full),
        'invoice.payment_intent',
        invoice.id,
        'after expand: payments'
      )
    } catch (err) {
      console.error(`[connect] invoice payments expand failed (in=${invoice.id}):`, err)
    }
  }
  if (piId) {
    const subSnap = await subRef.get()
    const s = subSnap.data()

    // THE STORED DOC FIRST, THE INVOICE'S OWN METADATA SECOND.
    //
    // `parent.subscription_details.metadata` is the subscription's metadata
    // riding along on the invoice, which is how a RENEWAL invoice can still say
    // what was bought. It matters because Stripe gives no ordering guarantee: an
    // `invoice.paid` that lands before the `customer.subscription.*` event which
    // stamps these fields finds a member_subscriptions doc that does not carry
    // them yet, and the payment row is then labelled from nothing.
    //
    // LABELS ONLY, deliberately. `contactId` is NOT taken from here even though
    // the metadata carries one: metadata is client-supplied at checkout creation,
    // and attributing a journal row to another team's contact is a tenant leak.
    // The checkout path re-verifies it through `verifiedMetadataContact` before
    // trusting it; a renewal has no reason to re-open that question, so this
    // keeps contact assignment on the stored-doc path exactly as it was.
    const md = readInvoiceSubscriptionMetadata(invoice)
    const typeId = (s?.subscriptionTypeId as string | undefined) || md.subscriptionTypeId || null
    const typeName =
      (s?.subscriptionTypeName as string | undefined) || md.subscriptionTypeName || null
    const priceId = (s?.priceId as string | undefined) || md.priceId || null

    await memberPaymentRef(team.teamId, piId).set(
      {
        ...(s?.contactId ? { contactId: s.contactId } : {}),
        kind: 'membership',
        // OMITTED, not nulled, when unknown — the same rule `contactId` above
        // follows and for the same reason. This row is written with
        // `{merge: true}` on a document the checkout path may already have
        // labelled correctly, so an unconditional `?? null` is not "no opinion",
        // it is an opinion that overwrites a resolved value with nothing.
        ...(typeName ? { subscriptionTypeName: typeName } : {}),
        purpose: 'membership',
        ...(typeId
          ? {
              line_item: {
                kind: 'subscription',
                subscriptionTypeId: typeId,
                priceId,
                label: typeName,
              },
            }
          : {}),
      },
      { merge: true }
    )
    if (s?.contactId) await stampFinanceContact(team.teamId, piId, s.contactId as string)
  }
}

/**
 * checkout.session.completed — the authoritative point for linking the buyer's
 * contact (it carries customer_details: email, name, phone). Resolves/creates the
 * contact and applies membership. For subscriptions it also backfills contactId
 * into the Stripe subscription metadata so RENEWAL events (handleSubscription) link
 * the same contact. Covers both the public shop (email only) and the manager flow
 * (metadata.contactId). Idempotent with the payment_intent/subscription handlers.
 */
async function handleCheckoutCompleted(
  team: TeamRef,
  session: StripeWebhookPayload<StripeCheckoutSessionObject>,
  accountId: string | undefined,
  _eventId: string
): Promise<void> {
  const md = (session.metadata ?? {}) as Record<string, string>

  // Gift-card redemption (product/course/drop-in checkouts that reserved a
  // drawdown): commit it BEFORE the per-kind dispatch below, one clean spot
  // for every kind that can carry a gift-card hold. Full-cover redemptions
  // never reach here (no Stripe checkout was created for them). The metadata
  // drawdown is the fallback amount for a payment that landed AFTER the hold
  // lazily expired — the event-id ledger keeps this once-per-event.
  if (md.giftCardCode && md.giftCardHold) {
    const fallback = Number(md.giftCardDrawdown)
    try {
      await commitGiftCardDrawdown({
        teamId: team.teamId,
        code: md.giftCardCode,
        holdKey: md.giftCardHold,
        fallbackAmountMajor: Number.isFinite(fallback) ? fallback : undefined,
        // md.kind is the same field the dispatch below switches on, so the
        // reclassified revenue always lands in the category that was bought.
        targetCategory: mapCategory(md.kind),
        // Re-verified rather than trusted: metadata is client-supplied at
        // checkout creation, and a journal row attributed to another team's
        // contact is a tenant leak that no later step would catch.
        contactId: await verifiedMetadataContact(team.teamId, md),
        // `session.payment_intent` is ALWAYS null on a mode:'subscription'
        // session — but that is not a hole here, because no subscription
        // checkout ever carries a gift card: exactly three rails set
        // `giftCardHold` — drop-in (booking/dropIn.ts), product and course
        // (connect/payments.ts) — and all three are mode:'payment'.
        // `createAppointmentCheckout` is NOT one of them: it takes no
        // `giftCardCode` at all, so an appointment never reaches this block.
        // Should a gift card ever be accepted for a
        // MEMBERSHIP, this null stops the redemption being stamped onto the
        // payment row — and that stamp is what lets a refund restore the card's
        // value (connect/giftCards.ts, commitGiftCardDrawdown). Resolve the
        // intent through the session's `invoice` before adding that rail.
        paymentIntentId:
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : ((session.payment_intent?.id as string | undefined) ?? null),
      })
    } catch (err) {
      console.error(`[connect] gift card hold commit failed (code=${md.giftCardCode}):`, err)
    }
  }

  if (md.kind === 'product') {
    await handleProductCheckout(team, session, md)
    return
  }
  if (md.kind === 'course') {
    await handleCourseCheckout(team, session, md)
    return
  }
  if (md.kind === 'drop_in') {
    await handleDropInCheckout(team, session, accountId, md)
    return
  }
  if (md.kind === 'appointment') {
    await handleAppointmentCheckout(team, session, accountId, md)
    return
  }
  if (md.kind === 'gift_card') {
    await handleGiftCardCheckout(team, session, md)
    return
  }
  if (md.kind === 'policy_fee') {
    await handlePolicyFeeCheckout(team, session, md)
    return
  }
  if (md.kind !== 'membership' || !md.subscriptionTypeId) return

  const email = (session.customer_details?.email ?? session.customer_email ?? '')
    .toLowerCase()
    .trim()
  const name = (session.customer_details?.name as string | undefined) ?? null
  const phone = (session.customer_details?.phone as string | undefined) ?? null

  // Prefer the explicit contactId (login-first shop + manager flow); else
  // resolve/create by email (legacy anonymous sessions).
  let contactId: string | null = await verifiedMetadataContact(team.teamId, md)
  if (!contactId && email) {
    const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(team.teamId).get()
    const plan = (teamSnap.data()?.plan as SaasPlan | undefined) ?? 'free'
    contactId = await resolveOrCreateContact(
      team.teamId,
      plan,
      {
        email,
        name,
        phone,
        firstname: md.firstname ?? null,
        lastname: md.lastname ?? null,
      },
      md.contactMode === 'full'
    )
  }
  if (!contactId) return // cap-blocked or no email — payment is still recorded by other handlers
  await confirmProvisionalContact(contactId)

  // 'full' checkout mode: the buyer owes the FULL signup (profile + consent) after
  // paying. Under login-first the contact already exists at purchase time, so the
  // creation-time flag in resolveOrCreateContact never fires — flag it here instead.
  // Never re-flag someone who already completed the full signup.
  if (md.contactMode === 'full') {
    const pendingSnap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).get()
    const pc = pendingSnap.data()
    if (pendingSnap.exists && !pc?.signup_completed_at && pc?.pending_signup !== true) {
      await pendingSnap.ref.update({ pending_signup: true, signup_completed_at: null })
      console.log(`[connect] flagged contact ${contactId} as pending signup ('full' checkout)`)
    }
  }

  const amountRappen = (session.amount_total as number | undefined) ?? 0
  const sessionCurrency = ((session.currency as string | undefined) ?? 'CHF').toUpperCase()
  // ── WHAT WAS CHARGED vs WHAT THE MEMBERSHIP COSTS ─────────────────────────
  // `amount_total` is the DISCOUNTED first invoice when the plan carries an
  // intro offer, and that is the right number for the receipt — it is what the
  // member paid. It is the WRONG number for the contact's stored subscription
  // amount: an intro offer is a temporary discount on invoices, not a different
  // membership, and the plan still costs the plan price.
  //
  // Without this split the two handlers disagree — `handleSubscription` writes
  // the recurring `unit_amount` (79.00) and this one wrote `amount_total`
  // (1.00) — so the contact record showed whichever Stripe happened to deliver
  // last, and settled only at the first renewal. `fullAmount` is stamped by
  // `introCheckoutMetadata` for exactly this.
  const introFullMajor = Number(md.fullAmount)
  const membershipAmountRappen =
    readIntroMetadata(md) && Number.isFinite(introFullMajor) && introFullMajor > 0
      ? toMinorUnits(introFullMajor)
      : amountRappen
  let membershipExpiration: Timestamp | null = null
  // THE SESSION's OWN PaymentIntent. Stripe's semantics do the case split for
  // us: it is present on a one-off ('payment' mode) checkout and ALWAYS null on
  // a 'subscription' mode session, which puts the first charge on the invoice
  // instead. Hoisted out of the one-off branch below because the
  // writeContactMembership call at the end of this function needs it — see the
  // comment there for why passing the wrong one of these two is a real bug in
  // both directions.
  const sessionPaymentIntentId: string | null =
    (typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id as string | undefined)) ?? null

  if (session.mode === 'subscription' && session.subscription) {
    const subId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription.id
    let latestPaymentIntentId: string | null = null
    if (accountId) {
      try {
        const stripe = await getConnectStripe()
        await stripe.subscriptions.update(
          subId,
          { metadata: { ...md, contactId } },
          { stripeAccount: accountId }
        )
        // `latest_invoice.payment_intent` no longer exists as an expand path, and
        // Stripe SILENTLY IGNORES an unknown expand rather than erroring — so the
        // old call succeeded and handed back two undefineds. The invoice's
        // payments list is the modern route to the first charge.
        const sub: StripeSubscriptionObject = await stripe.subscriptions.retrieve(
          subId,
          { expand: [SUBSCRIPTION_LATEST_INVOICE_PAYMENTS_EXPAND] },
          { stripeAccount: accountId }
        )
        const period = readSubscriptionPeriod(sub)
        reportStripeShape('subscription.current_period_end', subId, period.source, 'checkout')
        membershipExpiration = period.end === null ? null : Timestamp.fromMillis(period.end * 1000)
        latestPaymentIntentId = readInvoicePaymentIntentId(sub.latest_invoice).value

        // Fallback: the session names its own invoice (`payment_intent` is always
        // null on a mode:'subscription' session), so a subscription that came back
        // without an expandable latest_invoice is still reachable from here.
        if (!latestPaymentIntentId) {
          const invoiceId =
            typeof session.invoice === 'string' ? session.invoice : (session.invoice?.id ?? null)
          if (invoiceId) {
            const full: StripeInvoiceObject = await stripe.invoices.retrieve(
              invoiceId,
              { expand: [INVOICE_PAYMENTS_EXPAND] },
              { stripeAccount: accountId }
            )
            latestPaymentIntentId = readOrReport(
              readInvoicePaymentIntentId(full),
              'invoice.payment_intent',
              invoiceId,
              'checkout first charge'
            )
          }
        }
      } catch (err) {
        console.error('[connect] subscription backfill/retrieve failed:', err)
      }
    }
    await memberSubscriptionRef(team.teamId, subId).set(
      { contactId, subscriptionTypeId: md.subscriptionTypeId ?? null },
      { merge: true }
    )

    // Safety net: if the contact already holds a LIVE subscription of THIS SAME type (a
    // duplicate that slipped past the checkout guard — two tabs, or a late email link),
    // cancel this new subscription and refund its charge. A contact may hold several
    // *different* types at once, never two of the same.
    if (
      md.subscriptionTypeId &&
      (await contactHasOtherLiveSameType(team.teamId, contactId, md.subscriptionTypeId, subId))
    ) {
      if (accountId) {
        try {
          const stripe = await getConnectStripe()
          await stripe.subscriptions.cancel(subId, undefined, { stripeAccount: accountId })
          if (latestPaymentIntentId) {
            await refundDirectCharge({
              accountId,
              paymentIntentId: latestPaymentIntentId,
              reason: 'duplicate',
              idempotencyKey: `dup-refund:${subId}`,
            })
          } else {
            // Money, not display: the subscription IS cancelled above, so a
            // charge we cannot name is a charge nobody gives back. This branch
            // ran silently for every duplicate while the PaymentIntent was
            // unreachable — never let it be quiet again.
            console.error(
              `[connect] duplicate subscription ${subId} cancelled but its charge could NOT be ` +
                `resolved — the member has paid and has NOT been refunded. Refund by hand ` +
                `(team=${team.teamId}, contact=${contactId}).`
            )
          }
        } catch (err) {
          console.error('[connect] duplicate subscription cancel/refund failed:', err)
        }
      }
      await memberSubscriptionRef(team.teamId, subId).set(
        { status: 'canceled', duplicate: true, updated_at: FieldValue.serverTimestamp() },
        { merge: true }
      )
      // Say which of the two actually happened. The refund is CONDITIONAL — it
      // is skipped whenever the PaymentIntent could not be resolved, and the
      // branch above logs an error saying the member has NOT been refunded. A
      // success line that claims "cancelled + refunded" regardless contradicts
      // that error five lines up, and the cheerful line is the one a reader
      // believes.
      console.log(
        `[connect] duplicate same-type subscription ${subId} (type=${md.subscriptionTypeId}, ` +
          `contact=${contactId}) — cancelled, ` +
          (latestPaymentIntentId
            ? `refunded (pi=${latestPaymentIntentId})`
            : `NOT refunded (charge unresolved — needs a manual refund)`)
      )
      return // do NOT snapshot the duplicate onto the contact
    }

    // Link + label the FIRST charge: the invoice-generated PaymentIntent carries no
    // metadata of its own, so handlePaymentIntent recorded it as a bare 'payment'
    // with no contact. Renewal invoices are stamped by handleInvoice.
    if (latestPaymentIntentId) {
      await stampFinanceContact(team.teamId, latestPaymentIntentId, contactId)
      await memberPaymentRef(team.teamId, latestPaymentIntentId).set(
        {
          contactId,
          kind: 'membership',
          subscriptionTypeName: md.subscriptionTypeName ?? null,
          purpose: 'membership',
          ...(lineItemFromMetadata({ ...md, kind: 'membership' })
            ? { line_item: lineItemFromMetadata({ ...md, kind: 'membership' }) }
            : {}),
        },
        { merge: true }
      )
    }
  } else {
    const months = md.includedMonths ? parseInt(md.includedMonths, 10) : 0
    membershipExpiration = months > 0 ? addMonths(months) : null
    const piId = sessionPaymentIntentId
    if (piId) {
      await memberPaymentRef(team.teamId, piId).set({ contactId }, { merge: true })
      await stampFinanceContact(team.teamId, piId, contactId)
      // Credit pack purchase → materialise the grant (idempotent vs the
      // payment_intent.succeeded sibling event; doc id = piId).
      await applyCreditGrant(team.teamId, contactId, md, piId)
    }
  }

  await writeContactMembership(team.teamId, contactId, md, {
    // The PLAN's price, not the discounted first invoice — see the split above.
    amountRappen: membershipAmountRappen,
    membershipExpiration,
    // TWO CASES, and confusing them breaks the OPPOSITE one — state which is
    // which, or the next reader "fixes" one by reintroducing the other:
    //
    //  • ONE-OFF ('payment' mode) — a PaymentIntent EXISTS, and this charge is
    //    what set the membership up, so it owns the fields and refunding it may
    //    clear them. This call used to pass nothing here, because `piId` was
    //    scoped to the branch above; that wrote `subscription_source_ref: null`
    //    and raced handlePaymentIntent, overwriting the correct ref. Every
    //    refund of a one-off membership or credit pack then answered
    //    `skipped_not_owner` and revoked nothing — on the main rail.
    //
    //  • RECURRING ('subscription' mode) — `session.payment_intent` is ALWAYS
    //    null (the first charge sits on the invoice, governed by handleInvoice /
    //    handleSubscription, which write null on every renewal). Null is the
    //    truthful answer here, and it is load-bearing: it overwrites the ref of
    //    any earlier one-off purchase, so refunding that old charge cannot clear
    //    a membership this subscription is paying for.
    //
    // One expression covers both, because Stripe's own semantics make the split.
    paymentIntentId: sessionPaymentIntentId,
  })

  // THE RECEIPT (UX-77) — ALWAYS ON, and see connect/purchaseReceipts.ts for
  // why it consults no `SystemEmailKey`. A credit pack is the reason it exists:
  // someone buys ten classes and, until now, the number ten lived only inside a
  // member area they were never told about.
  //
  // WHERE IT SITS. Unlike `handleDropInCheckout`, this handler has no
  // short-circuiting redelivery guard — every step above is a merge, an
  // absolute write or a keyed `create()` (applyCreditGrant swallows
  // ALREADY_EXISTS and returns, it does not stop the handler), so a redelivery
  // re-runs all of it and reaches here. Nothing can strand the receipt by
  // throwing earlier, which is why this can sit at the end and describe the
  // FINAL state rather than having to go first.
  //
  // Both `return`s above skip it correctly: no contact means nobody to write to,
  // and a duplicate same-type subscription has just been cancelled and refunded
  // — announcing that one would be a receipt for money that has gone back.
  await sendMembershipPurchaseReceipt({
    teamId: team.teamId,
    contactId,
    // A 'subscription' mode session carries no PaymentIntent of its own (the
    // first charge is on the invoice), so the Checkout Session id is the tender
    // for keying purposes there.
    tenderRef: sessionPaymentIntentId ?? `cs:${session?.id ?? 'unknown'}`,
    // The grant `applyCreditGrant` just wrote, under the id it used. Null on the
    // recurring rail, where a credit pack cannot exist (credits ride a one_time
    // price only) — the receipt then takes its membership shape.
    creditGrantId: session.mode === 'subscription' ? null : sessionPaymentIntentId,
    planName: md.subscriptionTypeName ?? 'Membership',
    recurring: session.mode === 'subscription',
    // Only the ONE-OFF rail: there `membershipExpiration` is the run of months
    // the payment included. On the recurring rail the same variable holds the
    // period end, which is a renewal date, not an "included until" — labelling
    // one as the other is exactly the confusion this receipt should not add.
    validUntil: session.mode === 'subscription' ? null : (membershipExpiration?.toDate() ?? null),
    paid: amountRappen > 0 ? { amount: amountRappen / 100, currency: sessionCurrency } : null,
    // WHAT THE MEMBER IS TOLD HAS TO MATCH WHAT THEY WERE CHARGED. The pricing
    // card promised "CHF 1 for the first 3 months, then CHF 79/month" before
    // purchase, so the receipt must restate the whole schedule — a receipt that
    // shows only the small figure reads as the new price, which is exactly the
    // confusion a coupon exists to avoid.
    //
    // `session.amount_total` is the DISCOUNTED first-invoice total, so it is
    // also the check: `introReceiptTerms` refuses to restate an offer the charge
    // does not corroborate, and says so loudly instead of printing a promise
    // Stripe did not keep.
    intro: introReceiptTerms(md, amountRappen, sessionCurrency, session?.id),
    fallbackEmail: email || null,
  })
}

/**
 * The intro terms to print on the receipt — CHECKED against the money that
 * actually moved, not merely copied from the metadata.
 *
 * Returns null when there was no offer, and null-with-an-error when there was
 * one and the first charge does not match it. Both produce the ordinary
 * membership receipt; only the second is a defect, and it must never be silent:
 * the alternative is a mail asserting a discount the member did not receive.
 */
function introReceiptTerms(
  md: Record<string, string>,
  chargedMinor: number,
  currency: string,
  sessionId: string | undefined
): {
  periods: number
  amount: number
  fullAmount: number
  recurrence: string
  currency: string
} | null {
  const intro = readIntroMetadata(md)
  if (!intro) return null
  const fullAmount = Number(md.fullAmount)
  if (!Number.isFinite(fullAmount) || fullAmount <= 0) return null
  if (toMinorUnits(intro.amount) !== chargedMinor) {
    console.error(
      `[connect] intro offer MISMATCH on session ${sessionId ?? 'unknown'}: promised ` +
        `${intro.amount} (${toMinorUnits(intro.amount)} minor) for the first ${intro.periods} ` +
        `period(s), charged ${chargedMinor} minor. The coupon did not apply as stated — the ` +
        `receipt omits the offer rather than claiming it.`
    )
    return null
  }
  return {
    periods: intro.periods,
    amount: intro.amount,
    fullAmount,
    recurrence: md.recurrence ?? '',
    currency,
  }
}

/**
 * Product purchase (kind === 'product') — a one-off shop charge for a physical
 * product. The payment_intent handler already records the member_payments doc
 * (with productId/variant). Here we link/create the buyer's contact by email
 * (cap-aware, same as a membership shop purchase), stamp contactId onto the
 * payment, and log a purchase activity entry so the studio sees who bought what.
 * No membership/subscription state changes — products are merch, not memberships.
 */
async function handleProductCheckout(
  team: TeamRef,
  session: StripeWebhookPayload<StripeCheckoutSessionObject>,
  md: Record<string, string>
): Promise<void> {
  // The promo commit sits at the TOP of this handler rather than after the
  // contact work, and that is deliberate: this handler never refunds, and its
  // two early `return`s (no email to link the sale to, contact cap reached)
  // leave the payment standing. The sale happened, so the use IS consumed —
  // and identity comes from the reservation, so the commit needs nothing the
  // early returns are missing.
  await commitPromoFromMetadata({
    teamId: team.teamId,
    md,
    targetKind: 'product',
    checkoutSessionId: session?.id ?? null,
  })

  // Login-first checkouts carry the buyer's exact contact in metadata (e.g. the
  // child a parent selected at sign-in) — prefer it over email matching, which
  // would land on the wrong family member. Email resolution stays as the safety
  // net for in-flight legacy (anonymous) sessions.
  let contactId = await verifiedMetadataContact(team.teamId, md)
  if (!contactId) {
    const email = (session.customer_details?.email ?? session.customer_email ?? '')
      .toLowerCase()
      .trim()
    if (!email) return // nothing to link the sale to; payment is still recorded

    const name = (session.customer_details?.name as string | undefined) ?? null
    const phone = (session.customer_details?.phone as string | undefined) ?? null

    const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(team.teamId).get()
    const plan = (teamSnap.data()?.plan as SaasPlan | undefined) ?? 'free'
    contactId = await resolveOrCreateContact(team.teamId, plan, { email, name, phone })
    if (!contactId) return // cap-blocked — payment still recorded, studio links it later
  }
  await confirmProvisionalContact(contactId)

  const piId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
  if (piId) {
    await memberPaymentRef(team.teamId, piId).set({ contactId }, { merge: true })
    await stampFinanceContact(team.teamId, piId, contactId)
  }

  const label = md.variantLabel
    ? `${md.productName ?? 'Product'} · ${md.variantLabel}`
    : (md.productName ?? 'Product')

  // THE RECEIPT (UX-77) — ALWAYS ON; see connect/purchaseReceipts.ts. It names
  // what was bought and says what happens next, which for a product is "the
  // studio arranges handover" — the truth, because nothing in the product model
  // carries fulfilment or collection terms and the checkout collects no address.
  //
  // WHERE IT SITS: after the payment stamps and before the activity-log tail.
  // This handler has no short-circuiting redelivery guard (its two early
  // `return`s are "nobody to link the sale to", both above), so a throw below
  // re-runs everything and the ledger key is what stops a second mail.
  await sendProductPurchaseReceipt({
    teamId: team.teamId,
    contactId,
    itemLabel: label,
    // Which product, so the receipt can read its collection note (UX-79).
    productId: md.productId ?? null,
    tenderRef: piId ?? `cs:${session?.id ?? 'unknown'}`,
    paid:
      typeof session.amount_total === 'number' && session.amount_total > 0
        ? {
            amount: (session.amount_total as number) / 100,
            currency: (session.currency as string | undefined) ?? 'CHF',
          }
        : null,
    fallbackEmail: (session.customer_details?.email as string | undefined) ?? null,
  })

  await admin
    .firestore()
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection('activity_log')
    .add(withLedgerExpiry('activity_log', {
      type: 'product_purchased',
      source: 'stripe_connect',
      message: `Product purchased · ${label}`,
      timestamp: FieldValue.serverTimestamp(),
    }))
}

/**
 * Course purchase (kind === 'course') — a one-off shop charge for a 'purchase'-tier
 * online course. Like products, the payment_intent handler already records the
 * member_payments doc (with courseId/courseName). Here we link/create the buyer's
 * contact by email (cap-aware), grant a LIFETIME entitlement
 * (courses/{courseId}/purchases/{contactId} — what the security rules check to unlock
 * the course in the Space), stamp contactId onto the payment, and log the purchase.
 */
async function handleCourseCheckout(
  team: TeamRef,
  session: StripeWebhookPayload<StripeCheckoutSessionObject>,
  md: Record<string, string>
): Promise<void> {
  if (!md.courseId) return
  // Same placement and the same reason as handleProductCheckout above: no
  // refund branch, and the early returns leave the payment standing.
  await commitPromoFromMetadata({
    teamId: team.teamId,
    md,
    targetKind: 'course',
    checkoutSessionId: session?.id ?? null,
  })

  // Login-first: grant the entitlement to the EXACT contact from metadata (the one
  // the buyer was signed in as); email matching only for legacy sessions.
  let contactId = await verifiedMetadataContact(team.teamId, md)
  if (!contactId) {
    const email = (session.customer_details?.email ?? session.customer_email ?? '')
      .toLowerCase()
      .trim()
    if (!email) return // nothing to grant the entitlement to; payment is still recorded

    const name = (session.customer_details?.name as string | undefined) ?? null
    const phone = (session.customer_details?.phone as string | undefined) ?? null

    const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(team.teamId).get()
    const plan = (teamSnap.data()?.plan as SaasPlan | undefined) ?? 'free'
    contactId = await resolveOrCreateContact(team.teamId, plan, { email, name, phone })
    if (!contactId) return // cap-blocked — payment still recorded, studio links it later
  }
  await confirmProvisionalContact(contactId)

  const piId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
  if (piId) {
    await memberPaymentRef(team.teamId, piId).set({ contactId }, { merge: true })
    await stampFinanceContact(team.teamId, piId, contactId)
  }

  // Grant the lifetime entitlement. Doc id = contactId → idempotent on redelivery.
  // Through the SHARED writer, not hand-rolled: this is the rail that actually
  // sells courses, and while it wrote its own version it stamped only
  // `paymentIntentId` — so the entitlement a reversal is most likely to meet was
  // the one carrying no `payment_ref` to check ownership against.
  await grantCourseEntitlement(admin.firestore(), {
    teamId: team.teamId,
    courseId: md.courseId,
    contactId,
    amount: (session.amount_total as number | undefined) ?? null,
    currency: (session.currency as string | undefined) ?? null,
    source: 'stripe_connect',
    paymentRef: piId ?? null,
    paymentIntentId: piId ?? null,
  })

  // THE RECEIPT (UX-77) — ALWAYS ON; see connect/purchaseReceipts.ts. It tells
  // the buyer WHERE TO WATCH the thing they bought, which is the Space, and that
  // the entitlement is lifetime. Stripe's own receipt names a charge.
  //
  // WHERE IT SITS: immediately after the grant it announces (never promise
  // access that was not written) and before the remaining effects. This handler
  // has no short-circuiting redelivery guard — the grant is doc-id idempotent
  // and the promo commit is keyed — so a throw in the tail below re-runs the
  // whole handler; the ledger key stops that mailing twice.
  await sendCoursePurchaseReceipt({
    teamId: team.teamId,
    contactId,
    courseId: md.courseId,
    courseTitle: md.courseTitle ?? null,
    tenderRef: piId ?? `cs:${session?.id ?? 'unknown'}`,
    paid:
      typeof session.amount_total === 'number' && session.amount_total > 0
        ? {
            amount: (session.amount_total as number) / 100,
            currency: (session.currency as string | undefined) ?? 'CHF',
          }
        : null,
    fallbackEmail: (session.customer_details?.email as string | undefined) ?? null,
  })

  await admin
    .firestore()
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection('activity_log')
    .add(withLedgerExpiry('activity_log', {
      type: 'course_purchased',
      source: 'stripe_connect',
      message: `Course purchased · ${md.courseTitle ?? 'Course'}`,
      timestamp: FieldValue.serverTimestamp(),
    }))
}

/**
 * Gift card purchase (kind === 'gift_card') — mints the card (mintGiftCard,
 * idempotent on the payment intent id — safe against redelivery/reprocessing)
 * and emails the code to the purchaser. There is no booking/entitlement to
 * confirm here; the card itself IS the product. Best-effort: a mail failure
 * never blocks the mint (the card exists regardless — a manager can look up
 * the code in the dashboard if the email bounced).
 *
 * A GUEST buyer is deliberately NOT turned into a Contact, which is why this
 * handler calls neither resolveOrCreateContact nor confirmProvisionalContact
 * while the membership, product and course handlers all call both. Two reasons,
 * and the next reader should not "fix" the asymmetry:
 *   1. Creating a contact exists to hang a per-person effect off it (a course
 *      entitlement, membership fields, credits). A gift card has none — the
 *      entitlement travels with the code, to whoever the buyer hands it to.
 *   2. The Free plan's 15-contact cap is HARD, and provisional contacts are
 *      deliberately excluded from it (utils/contactCap.ts). A studio selling
 *      twenty Christmas cards would otherwise fill its own allowance with
 *      people who are not its customers, and confirming a provisional buyer
 *      would flip an excluded contact into one that consumes a slot.
 * The lead is not lost: purchaserEmail is stored on the card and reaches
 * member_payments via customer_details, and a unique active match is LINKED
 * below, which costs no slot.
 */
async function handleGiftCardCheckout(
  team: TeamRef,
  session: StripeWebhookPayload<StripeCheckoutSessionObject>,
  md: Record<string, string>
): Promise<void> {
  const piId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
  if (!piId) return

  const amountMajor = md.amount
    ? Number(md.amount)
    : Math.round((session.amount_total as number | undefined) ?? 0) / 100
  const purchaserEmail =
    md.purchaserEmail ?? (session.customer_details?.email as string | undefined) ?? null

  // Identity, in the order that never costs a contact slot: the checkout's own
  // session (re-verified against the team), else a UNIQUE active contact with
  // the same address. resolveSingleContact returns null on ambiguity rather
  // than guessing — email is not a unique key here, and mis-attributing a
  // purchase to a sibling is worse than leaving it unattributed.
  let contactId = await verifiedMetadataContact(team.teamId, md)
  if (!contactId && purchaserEmail) {
    const { contactId: match } = await resolveSingleContact(team.teamId, purchaserEmail)
    contactId = match
  }

  const card = await mintGiftCard({
    teamId: team.teamId,
    amount: amountMajor,
    // The card is denominated in what Stripe ACTUALLY charged, read off the
    // session — not a literal and not the team's configured default, either of
    // which can drift from the rail and leave the card unredeemable. giftCardCurrency
    // is the same value by construction; this is just the closer source.
    currency: ((session.currency as string | undefined) ?? giftCardCurrency(null)).toUpperCase(),
    purchaserContactId: contactId,
    purchaserEmail,
    paymentIntentId: piId,
    issueKind: 'purchase',
  })

  await memberPaymentRef(team.teamId, piId).set(
    { contactId, giftCardCode: card.code },
    { merge: true }
  )
  if (contactId) await stampFinanceContact(team.teamId, piId, contactId)

  if (!purchaserEmail) return
  try {
    const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(team.teamId).get()
    const teamName = (teamSnap.data()?.name as string | undefined) ?? 'the studio'
    const { html, text } = buildEmailTemplate({
      title: 'Your gift card',
      body: `<p>Thank you for your purchase. Here is your gift card code for ${teamName}:</p>
<p style="font-size:22px;font-weight:600;letter-spacing:1px;">${card.code}</p>
<p>Value: ${card.currency} ${amountMajor.toFixed(2)}</p>
<p>Share this code with whoever will redeem it. It can be applied toward any purchase at ${teamName}.</p>`,
    })
    await sendEmail({
      to: purchaserEmail,
      subject: `Your ${teamName} gift card`,
      html,
      text,
      teamId: team.teamId,
    })
  } catch (err) {
    console.error(`[connect] gift card email failed (code=${card.code}):`, err)
  }
}

/**
 * No-show policy fee (kind === 'policy_fee') — settles a fee minted by
 * processNoShowStrike (booking/policyFees.ts) once the contact pays the
 * emailed link. markPolicyFeePaid is idempotent (checkout.session.completed +
 * payment_intent.succeeded both land here across the two sibling events).
 */
async function handlePolicyFeeCheckout(
  team: TeamRef,
  session: StripeWebhookPayload<StripeCheckoutSessionObject>,
  md: Record<string, string>
): Promise<void> {
  if (!md.feeId) return
  const piId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? null)
  await markPolicyFeePaid({ teamId: team.teamId, feeId: md.feeId, paymentIntentId: piId })
  if (piId && md.contactId) await stampFinanceContact(team.teamId, piId, md.contactId)
}

/**
 * Drop-in booking (kind === 'drop_in') — a pay-per-class charge that confirms a
 * PENDING booking hold created by createDropInCheckout. The payment_intent handler
 * already recorded the member_payments doc (with sessionId). Here we flip the pending
 * booking to confirmed/paid, count it toward the session, stamp contactId on the
 * payment, and log it. The contact was resolved at checkout time and passed via
 * metadata.contactId (re-verified to belong to the team). Idempotent on redelivery.
 */
async function handleDropInCheckout(
  team: TeamRef,
  session: StripeWebhookPayload<StripeCheckoutSessionObject>,
  accountId: string | undefined,
  md: Record<string, string>
): Promise<void> {
  const { sessionId, contactId } = md
  if (!sessionId || !contactId) return
  const db = admin.firestore()

  const cSnap = await db.collection(CONTACTS_COLLECTION).doc(contactId).get()
  if (!cSnap.exists || cSnap.data()?.teamId !== team.teamId) return
  const contact = cSnap.data()!
  // A paid drop-in also confirms a provisional (shop-registered) contact.
  if (contact.provisional === true) {
    await cSnap.ref.update({
      provisional: FieldValue.delete(),
      provisional_expires_at: FieldValue.delete(),
    })
  }

  const bookingRef = db.collection('sessions').doc(sessionId).collection('bookings').doc(contactId)
  const bSnap = await bookingRef.get()
  const piId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id

  // ── Does the seat still AWAIT this charge? ──────────────────────────────────
  // `payment_status: 'required'` — not `status` — is what says "this money still
  // buys something". createDropInCheckout writes it on the hold and only a
  // webhook clears it, so a booking that no longer carries it has been settled
  // some other way and this charge buys the person a seat they already have:
  //
  //  • confirmed + paid → an idempotent redelivery of the SAME charge (same
  //    payment intent: nothing to do), or a SECOND charge for one seat (two
  //    tabs) — refund it;
  //  • booked for FREE in the meantime → bookSession's duplicate guards let a
  //    re-book land on top of a `pending` booking, and its `tx.set` is a FULL
  //    REPLACE that wipes `payment_status` and `expires_at` off a hold whose
  //    Stripe session is still open. A guest who opens a drop-in checkout, goes
  //    back, takes the free trial door and then finishes the stale Stripe page
  //    gets charged for a seat they now hold for nothing. The old test
  //    (`status === 'confirmed'` AND a different payment_intent_id) caught
  //    neither shape of it: a free booking carries no payment intent at all,
  //    and one on a class that doesn't auto-confirm isn't 'confirmed' either —
  //    that one fell through and was confirmed as paid.
  //
  // The one confirmed booking that must NOT refund is the hold itself: a coach
  // who confirmed a pending drop-in at the door has not paid for it, and
  // check-in/confirm are `update`s that leave `payment_status: 'required'`
  // standing. That falls through and settles below, exactly as it would have if
  // nobody had touched it.
  if (bSnap.exists && bSnap.data()?.payment_status !== 'required') {
    const existingPi = (bSnap.data()?.payment_intent_id as string | undefined) ?? null
    if (piId && existingPi !== piId && accountId) {
      try {
        await refundDirectCharge({
          accountId,
          paymentIntentId: piId,
          reason: 'duplicate',
          idempotencyKey: `dropin-dup:${piId}`,
        })
        await memberPaymentRef(team.teamId, piId).set(
          { contactId, status: 'refunded', updated_at: FieldValue.serverTimestamp() },
          { merge: true }
        )
        // A duplicate that redeemed a gift card had its drawdown committed
        // before dispatch — restore it, or the buyer loses stored value with
        // nothing delivered. The card's own marker says how much moved, so the
        // metadata drawdown (the RESERVED amount, which the balance floor can
        // have shrunk) is no longer trusted for the amount.
        if (md.giftCardCode && md.giftCardHold) {
          const { restoredMajor } = await reverseGiftCardDrawdown({
            teamId: team.teamId,
            code: md.giftCardCode,
            holdKey: md.giftCardHold,
            targetCategory: 'drop_in',
            contactId,
            description: `Duplicate charge refunded · ${md.giftCardCode}`,
          })
          if (restoredMajor > 0) {
            console.log(
              `[connect] drop-in duplicate: restored gift-card drawdown ${restoredMajor} to ${md.giftCardCode}`
            )
          }
        }
        const settled = bSnap.data()
        console.log(
          `[connect] drop-in charge ${piId} refunded — the seat was already settled ` +
            `without it (session=${sessionId} contact=${contactId} ` +
            `status=${settled?.status ?? 'pending'} ` +
            `payment_status=${settled?.payment_status ?? 'none'})`
        )
      } catch (err) {
        console.error('[connect] drop-in duplicate refund failed:', err)
      }
    }
    return
  }

  // Confirm the pending hold — or recreate the booking from metadata if the hold
  // was already swept before payment landed (a paid charge must never be lost).
  //
  // That resurrection is exactly why capacity is re-checked here. The hold this
  // charge paid for may no longer hold a seat: swept, or lapsed while someone
  // else took the last place. Confirming blindly then oversells the class and
  // hands the buyer a seat that does not exist. So: everyone ELSE holding a seat
  // is counted (the payer's own hold never counts against them — it was held FOR
  // them, and if it survived there is no capacity question at all), and if the
  // class is full without them the honest answer is a refund, not a seat.
  //
  // One transaction: the session doc is the same lock createDropInCheckout and
  // bookSession take, and `bookings_count` is written as an absolute from the
  // read set. The old `increment(1)` here landed ON TOP of trackBookings'
  // recount of the hold, so a filling class read one seat over and refused the
  // next real customer.
  const sessionRef = db.collection('sessions').doc(sessionId)
  // A waitlist claim being paid for. The entry flips in the SAME transaction
  // that confirms the booking, so the state "the booking is paid but the queue
  // still thinks the offer is outstanding" never exists for a sweep to act on.
  const waitlistEntryRef = md.waitlistEntry
    ? sessionRef.collection(WAITLIST_SUBCOLLECTION).doc(md.waitlistEntry)
    : null
  const oversold = await db.runTransaction(async (tx) => {
    const bookingsSnap = await tx.get(sessionRef.collection('bookings'))
    const sSnap = await tx.get(sessionRef)
    // Read rather than blind-update: an entry that was purged (a deleted queue,
    // a wiped session) would make `tx.update` throw, and a paid charge must
    // never be lost to a bookkeeping document.
    const entrySnap = waitlistEntryRef ? await tx.get(waitlistEntryRef) : null
    const others = countHoldingSeats(bookingsSnap.docs, Date.now(), contactId)
    if (seatsFree(sSnap.data()?.max_participants as number | undefined, others) <= 0) return true

    const existing = bookingsSnap.docs.find((d) => d.id === contactId)?.data()
    const isNew = !existing
    // THE MANAGE-BOOKING CREDENTIAL. `createDropInCheckout` minted one onto the
    // hold, and the merge below preserves it — but the hold may have been swept
    // before this payment landed (the resurrection case this whole block exists
    // for), and then there is nothing to preserve. A confirmation carrying no
    // manage link is a booking the buyer cannot cancel, and `cancelBooking`
    // finds a booking ONLY by this token.
    const bookingToken = (existing?.booking_token as string | undefined) ?? generateSecureToken()
    const bookingReference =
      (existing?.booking_reference as string | undefined) ?? generateBookingReference()
    tx.set(
      bookingRef,
      {
        booking_token: bookingToken,
        booking_reference: bookingReference,
        firstname: (contact.firstname as string) ?? '',
        lastname: (contact.lastname as string) ?? '',
        email: (contact.email as string) ?? '',
        phone: (contact.phone as string) ?? null,
        contact: contactId,
        session: sessionId,
        teamId: team.teamId,
        status: 'confirmed',
        payment_status: 'paid',
        payment_intent_id: piId ?? null,
        expires_at: FieldValue.delete(),
        // A paid seat is an ordinary booking from here on. Both claim fields
        // MUST go: a confirmed booking still carrying `waitlist_claim` stops
        // holding its seat the moment `claim_expires_at` passes
        // (bookingHoldsSeat → isExpiredWaitlistClaim), which would hand a seat
        // somebody just paid for to the next person in the queue.
        waitlist_claim: FieldValue.delete(),
        claim_expires_at: FieldValue.delete(),
        ...(waitlistEntryRef ? { claimed_from_waitlist: true } : {}),
        updated_at: FieldValue.serverTimestamp(),
        ...(isNew
          ? { joinedAt: FieldValue.serverTimestamp(), fromBioLink: true, is_new_contact: false }
          : {}),
      },
      { merge: true }
    )
    if (waitlistEntryRef && entrySnap?.exists) {
      tx.update(waitlistEntryRef, {
        status: 'claimed',
        claimed_at: FieldValue.serverTimestamp(),
        // Single use — the credential dies with the offer it belonged to.
        offer_token: FieldValue.delete(),
      })
    }
    tx.set(
      sessionRef,
      {
        has_bookings: true,
        bookings_count: others + 1,
        last_booking_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    return false
  })

  if (oversold) {
    // No seat to give: refund and undo the stored value, mirroring the duplicate
    // branch above. The hold (if one is still there) is left to
    // expirePendingBookings — it holds nothing.
    if (piId && accountId) {
      try {
        await refundDirectCharge({
          accountId,
          paymentIntentId: piId,
          reason: 'requested_by_customer',
          idempotencyKey: `dropin-full:${piId}`,
        })
        await memberPaymentRef(team.teamId, piId).set(
          { contactId, status: 'refunded', updated_at: FieldValue.serverTimestamp() },
          { merge: true }
        )
        if (md.giftCardCode && md.giftCardHold) {
          const { restoredMajor } = await reverseGiftCardDrawdown({
            teamId: team.teamId,
            code: md.giftCardCode,
            holdKey: md.giftCardHold,
            targetCategory: 'drop_in',
            contactId,
            description: `Class full, charge refunded · ${md.giftCardCode}`,
          })
          if (restoredMajor > 0) {
            console.log(
              `[connect] drop-in oversell: restored gift-card drawdown ${restoredMajor} to ${md.giftCardCode}`
            )
          }
        }
      } catch (err) {
        console.error(`[connect] drop-in full-class refund failed (pi=${piId}):`, err)
      }
    }
    // The claim died with the seat: the money went back, so the hold goes back
    // to the queue rather than sitting 'offered' against a booking nobody can
    // ever settle. The same guarded release the sweep runs — it will not touch
    // the booking unless it is still an unclaimed hold, which is exactly the
    // state a refunded claim leaves behind.
    if (waitlistEntryRef) {
      try {
        await releaseWaitlistOffer({
          entryRef: waitlistEntryRef,
          terminalStatus: 'expired',
          from: ['offered'],
        })
      } catch (err) {
        console.error(`[connect] drop-in oversell: releasing waitlist claim failed:`, err)
      }
    }
    console.log(
      `[connect] drop-in payment could not be applied — session ${sessionId} is full (contact=${contactId})`
    )
    return
  }

  // THE RECEIPT (UX-76), and it goes FIRST of the post-confirm effects.
  //
  // ALWAYS ON — not behind the `booking_confirmation` toggle the FREE path
  // honours; see the header of booking/paidConfirmation.ts for why the two
  // differ on purpose. Past both refund branches above (duplicate charge, class
  // full), which return before here, so it only ever announces a seat the buyer
  // actually got.
  //
  // ORDER IS LOAD-BEARING. Every step below can throw, and this handler's
  // redelivery guard is `payment_status !== 'required'` — so a throw after the
  // seat is confirmed means the retry short-circuits at the top and whatever had
  // not run yet NEVER runs. Sending here leaves no window: the mail itself never
  // throws, and the `mail_sends` ledger key carries the PaymentIntent, so a
  // redelivery cannot mail the buyer twice either.
  await sendPaidBookingConfirmation({
    teamId: team.teamId,
    sessionId,
    contactId,
    tenderRef: piId ?? `session:${session?.id ?? 'unknown'}`,
    // What STRIPE charged, read off the session — never recomputed. A gift card
    // that covered part of the price is not added in: the card took its own
    // share, and its own history is where that shows.
    paid:
      typeof session.amount_total === 'number'
        ? {
            amount: (session.amount_total as number) / 100,
            currency: (session.currency as string | undefined) ?? 'CHF',
          }
        : null,
    recipient: {
      firstname: (contact.firstname as string) ?? '',
      lastname: (contact.lastname as string) ?? '',
      email: (contact.email as string) ?? '',
    },
  })

  if (piId) {
    await memberPaymentRef(team.teamId, piId).set({ contactId }, { merge: true })
    await stampFinanceContact(team.teamId, piId, contactId)
  }

  // Paid trial (createDropInCheckout with trial: true): one-trial-per-person
  // enforcement, mirroring bookSession's free trial door stamp. Only reached on
  // the successful-confirm path above (never on the early duplicate-redelivery
  // return), so a redelivered event never double-stamps.
  if (md.trial === 'true') {
    await cSnap.ref.update({ trial_used_at: FieldValue.serverTimestamp() })
  }

  // THE PROMO COMMIT, at this handler's confirm point and NOT beside the
  // gift-card commit above. A USE IS CONSUMED BY A COMPLETED SALE, NEVER BY AN
  // ATTEMPT: the duplicate-charge and class-full branches above refund the whole
  // charge and return before here, so on those the reservation simply lapses and
  // the slot comes back. The gift card answers the same case with a compensating
  // reversal twenty lines up; a promo reversal would be a SECOND writer of
  // `usage_count`, which is the one thing this design forecloses.
  await commitPromoFromMetadata({
    teamId: team.teamId,
    md,
    targetKind: 'drop_in',
    fallbackContactId: contactId,
    // The STRIPE session, not `md.sessionId` (ours). The refusal logs are the
    // only trace the accepted residual leaves, so they must name the payment.
    checkoutSessionId: session?.id ?? null,
  })

  await db
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection('activity_log')
    .add(withLedgerExpiry('activity_log', {
      type: 'drop_in_booked',
      source: 'stripe_connect',
      message: `Drop-in booking · ${md.activityName ?? 'Class'}`,
      timestamp: FieldValue.serverTimestamp(),
    }))
}

/**
 * Appointment checkout (kind === 'appointment') — confirms the paid-booking HOLD
 * created by createAppointmentCheckout. THE HOLD IS THE SESSION: a
 * 'pending_payment' session + a 'pending'/'required' booking already exist;
 * here we flip both to confirmed/paid, or handle the late-payment races:
 *   1. Already confirmed with a DIFFERENT payment_intent_id → a duplicate charge
 *      for an already-paid slot (two tabs) — refund it.
 *   2. Hold still live (not expired) → CONFIRM in place (the common case).
 *   3. Session cancelled/expired-hold (swept, admin-cancelled, lapsed) →
 *      RE-ACQUIRE via the same overlap-safe slot transaction, rebuilt from the
 *      swept doc's own fields (still all present, only status differs).
 *      Conflict (slot retaken) → refund.
 *   4. Session missing entirely → refund (never rebuild the what/when from
 *      metadata alone).
 * Idempotent on redelivery via case 1's short-circuit.
 */
async function handleAppointmentCheckout(
  team: TeamRef,
  session: StripeWebhookPayload<StripeCheckoutSessionObject>,
  accountId: string | undefined,
  md: Record<string, string>
): Promise<void> {
  const { sessionId, contactId } = md
  if (!sessionId || !contactId) return
  const db = admin.firestore()

  const cSnap = await db.collection(CONTACTS_COLLECTION).doc(contactId).get()
  if (!cSnap.exists || cSnap.data()?.teamId !== team.teamId) return
  const contact = cSnap.data()!
  // A paid appointment also confirms a provisional (booking-created) contact.
  // Captured BEFORE clearing: used below to mirror bookAppointment's parity —
  // a brand-new contact already carries pending_bookings_count: 1 from
  // creation, so only a PRE-EXISTING contact gets the post-confirm increment.
  const wasProvisional = contact.provisional === true
  if (wasProvisional) {
    await cSnap.ref.update({
      provisional: FieldValue.delete(),
      provisional_expires_at: FieldValue.delete(),
    })
  }

  const sessionRef = db.collection('sessions').doc(sessionId)
  const bookingRef = sessionRef.collection('bookings').doc(contactId)
  const piId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
  const fullname =
    `${(contact.firstname as string) ?? ''} ${(contact.lastname as string) ?? ''}`.trim()

  const bSnap = await bookingRef.get()

  // 1) Already confirmed: an idempotent redelivery of the SAME charge, OR a
  // second (duplicate) charge for a slot that's already paid — refund the
  // duplicate so the buyer is never charged twice for one appointment.
  if (bSnap.exists && bSnap.data()?.status === 'confirmed') {
    const existingPi = (bSnap.data()?.payment_intent_id as string | undefined) ?? null
    // THE DESK-SETTLED CASE, and the reason this is not just an id comparison.
    // `markAppointmentPaid` can settle a link-mode hold in CASH: it expires the
    // Checkout Session first, but a close can fail (or the hold may predate the
    // stored session id), and this booking then carries no `payment_intent_id`
    // for the comparison below to work with. A confirmed, offline-settled seat
    // meeting an online payment is a SECOND payment for one appointment by
    // definition — whatever its id — so it refunds on the same terms as any
    // other duplicate. See appointments/staffBooking.ts → markAppointmentPaid.
    const settledOffline = bSnap.data()?.settled_offline === true
    const isDuplicateCharge = appointmentChargeIsDuplicate({
      payment_intent_id: existingPi,
      settled_offline: settledOffline,
      incomingPaymentIntentId: piId ?? null,
    })
    // `piId` IS OPTIONAL, which the `any` hid. `session.payment_intent` is null
    // whenever Stripe created no PaymentIntent for the session, so this branch
    // used to be able to call the refund with `paymentIntentId: undefined` and
    // an idempotency key of `apt-dup:undefined`. There is no charge to reverse
    // in that case — but a duplicate detected and NOT refunded is exactly the
    // thing that must never pass in silence, so it says so.
    if (isDuplicateCharge && accountId && !piId) {
      console.error(
        `[connect] appointment duplicate charge for session ${sessionId} carries no ` +
          `payment_intent — nothing to refund, and the seat was already confirmed`
      )
    }
    if (isDuplicateCharge && accountId && piId) {
      try {
        await refundDirectCharge({
          accountId,
          paymentIntentId: piId,
          reason: 'duplicate',
          idempotencyKey: `apt-dup:${piId}`,
        })
        await memberPaymentRef(team.teamId, piId).set(
          { contactId, status: 'refunded', updated_at: FieldValue.serverTimestamp() },
          { merge: true }
        )
        console.log(
          `[connect] appointment duplicate charge ${piId} refunded ` +
            `(booking already confirmed${settledOffline ? ', settled at the desk' : ''})`
        )
      } catch (err) {
        console.error('[connect] appointment duplicate refund failed:', err)
      }
    }
    return
  }

  const sSnap = await sessionRef.get()
  const nowMs = Date.now()
  let bookingToken: string | null = null
  let confirmed = false
  let refundReason: 'missing_session' | 'slot_retaken' | null = null

  if (sSnap.exists) {
    const s = sSnap.data()!
    const isLiveHold =
      s.status === 'pending_payment' &&
      !isExpiredAppointmentHold(s as { status?: string; hold_expires_at?: Timestamp | null }, nowMs)

    if (isLiveHold) {
      // 2) The common case — confirm the hold in place.
      await db.runTransaction(async (tx) => {
        const freshBooking = await tx.get(bookingRef)
        const isNew = !freshBooking.exists
        bookingToken = isNew
          ? generateSecureToken()
          : ((freshBooking.data()!.booking_token as string | undefined) ?? generateSecureToken())
        tx.set(
          sessionRef,
          {
            status: 'full',
            hold_expires_at: FieldValue.delete(),
            has_bookings: true,
            bookings_count: 1,
            last_booking_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        tx.set(
          bookingRef,
          {
            firstname: (contact.firstname as string) ?? '',
            lastname: (contact.lastname as string) ?? '',
            email: (contact.email as string) ?? '',
            phone: (contact.phone as string) ?? null,
            contact: contactId,
            session: sessionId,
            teamId: team.teamId,
            status: 'confirmed',
            payment_status: 'paid',
            payment_intent_id: piId ?? null,
            fullname,
            booking_token: bookingToken,
            expires_at: FieldValue.delete(),
            updated_at: FieldValue.serverTimestamp(),
            ...(isNew
              ? {
                  joinedAt: FieldValue.serverTimestamp(),
                  fromBioLink: true,
                  is_new_contact: false,
                  authenticated_booking: false,
                }
              : {}),
          },
          { merge: true }
        )
      })
      confirmed = true
    } else {
      // 3) Session cancelled or the hold expired (sweep/admin/checkout.session.expired)
      // — RE-ACQUIRE, rebuilding the session doc from the swept doc's OWN fields
      // (the what/when — activityName/providerId/location/… — are all still on
      // it, only status differs). Conflict (slot retaken) → refund.
      bookingToken = generateSecureToken()
      const rebuiltSessionDoc: Record<string, unknown> = { ...s }
      delete rebuiltSessionDoc.hold_expires_at
      rebuiltSessionDoc.status = 'full'
      rebuiltSessionDoc.bookings_count = 1
      rebuiltSessionDoc.has_bookings = true
      rebuiltSessionDoc.last_booking_at = FieldValue.serverTimestamp()
      const start = s.start as Timestamp
      const end = s.end as Timestamp
      // Best-effort recover the original availability's buffer for the overlap
      // check (not persisted on the session doc itself); 0 if the template was
      // since deleted/paused — degrades gracefully, never blocks the re-acquire.
      let bufferMs = 0
      if (s.templateId) {
        try {
          const tplSnap = await db
            .collection(AVAILABILITY_COLLECTION)
            .doc(s.templateId as string)
            .get()
          bufferMs = ((tplSnap.data()?.bufferMinutes as number | undefined) ?? 0) * 60_000
        } catch {
          bufferMs = 0
        }
      }
      try {
        await runAppointmentSlotTransaction({
          sessionRef,
          sessionDoc: rebuiltSessionDoc,
          bookingDocId: contactId,
          bookingDoc: {
            firstname: (contact.firstname as string) ?? '',
            lastname: (contact.lastname as string) ?? '',
            email: (contact.email as string) ?? '',
            phone: (contact.phone as string) ?? null,
            contact: contactId,
            session: sessionId,
            teamId: team.teamId,
            joinedAt: FieldValue.serverTimestamp(),
            fromBioLink: true,
            is_new_contact: false,
            booking_token: bookingToken,
            authenticated_booking: false,
            subscription_type_id: null,
            status: 'confirmed',
            payment_status: 'paid',
            payment_intent_id: piId ?? null,
            fullname,
          },
          teamId: team.teamId,
          providerId: (s.providerId as string | undefined) ?? md.providerId ?? '',
          startMs: start.toMillis(),
          endMs: end.toMillis(),
          bufferMs,
        })
        confirmed = true
      } catch (err) {
        console.warn(`[connect] appointment re-acquire failed (session=${sessionId}):`, err)
        refundReason = 'slot_retaken'
      }
    }
  } else {
    // 4) Session missing entirely — never rebuild the what/when from metadata
    // alone; refund and let the studio/customer re-book if they still want to.
    refundReason = 'missing_session'
  }

  if (refundReason) {
    if (piId && accountId) {
      try {
        await refundDirectCharge({
          accountId,
          paymentIntentId: piId,
          reason: 'requested_by_customer',
          idempotencyKey: `apt-refund:${piId}`,
        })
        await memberPaymentRef(team.teamId, piId).set(
          { contactId, status: 'refunded', updated_at: FieldValue.serverTimestamp() },
          { merge: true }
        )
      } catch (err) {
        console.error(`[connect] appointment refund failed (${refundReason}, pi=${piId}):`, err)
      }
    }
    console.log(
      `[connect] appointment checkout could not be applied (${refundReason}, session=${sessionId})`
    )
    return
  }
  if (!confirmed) return

  // ── post-confirm effects ──
  // Past BOTH refund branches above (`apt-dup:` and `apt-refund:`), which return
  // before here — a use is consumed by a completed sale, never by an attempt.
  await commitPromoFromMetadata({
    teamId: team.teamId,
    md,
    targetKind: 'appointment',
    fallbackContactId: contactId,
    // The STRIPE session, not `md.sessionId` (ours) — see handleDropInCheckout.
    checkoutSessionId: session?.id ?? null,
  })
  if (piId) {
    await stampFinanceContact(team.teamId, piId, contactId)
    await memberPaymentRef(team.teamId, piId).set({ contactId }, { merge: true })
  }
  if (!wasProvisional) {
    try {
      await db
        .collection(CONTACTS_COLLECTION)
        .doc(contactId)
        .update({ pending_bookings_count: FieldValue.increment(1) })
    } catch (err) {
      console.error('[connect] appointment pending_bookings_count increment failed:', err)
    }
  }
  await db
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection('activity_log')
    .add(withLedgerExpiry('activity_log', {
      type: 'appointment_booked',
      source: 'stripe_connect',
      message: `Appointment booked · ${md.activityName ?? 'Appointment'}`,
      timestamp: FieldValue.serverTimestamp(),
    }))

  // Emails — reload the now-confirmed session for the what/when + the team for
  // name/language/slug (not carried on TeamRef).
  try {
    const [freshSessionSnap, teamSnap] = await Promise.all([
      sessionRef.get(),
      db.collection(TEAMS_COLLECTION).doc(team.teamId).get(),
    ])
    const sd = freshSessionSnap.data()
    const td = teamSnap.data()
    if (sd) {
      const teamSlug = (td?.slug as string | undefined) ?? null
      // Locale-pinned on the TEAM's language — the same rule the booking
      // confirmation chain already follows. This mail is written in
      // `td.language`; an unprefixed link would open an English cancel page.
      const cancelUrl =
        teamSlug && bookingToken
          ? localizedPublicUrl(
              getHostingUrl(),
              asLang(td?.language),
              teamSlug,
              'appointments/cancel',
              {
                token: bookingToken,
              }
            )
          : null
      await sendAppointmentBookingEmails({
        teamId: team.teamId,
        teamName: (td?.name as string | undefined) ?? 'Our Team',
        lang: asLang(td?.language),
        activityName: (sd.activityName as string | undefined) ?? md.activityName ?? 'Appointment',
        providerId: (sd.providerId as string | undefined) ?? null,
        providerName: (sd.providerName as string | undefined) ?? 'Coach',
        start: (sd.start as Timestamp).toDate(),
        end: (sd.end as Timestamp).toDate(),
        location: (sd.location as string | undefined) ?? null,
        onlineUrl: (sd.onlineUrl as string | undefined) ?? null,
        cancelUrl,
        bookingId: `${sessionId}-${contactId}`,
        // PAID, by construction: this handler runs only on a completed Stripe
        // checkout, and both branches that reach here stamp the booking
        // `payment_status: 'paid'` (what `bookingWasPaidFor` reads). So the
        // confirmation is a receipt and ignores the `booking_confirmation`
        // toggle — the class rail's rule (booking/paidConfirmation.ts), applied
        // to the appointment that used to sit behind the switch. Redelivery is
        // already handled upstream: an already-confirmed booking short-circuits at
        // case 1, so Stripe's retries cannot mail this twice.
        wasPaidFor: true,
        client: {
          firstname: (contact.firstname as string) ?? '',
          lastname: (contact.lastname as string) ?? '',
          email: (contact.email as string) ?? '',
          phone: (contact.phone as string) ?? null,
        },
      })
    }
  } catch (err) {
    console.error('[connect] appointment booking emails failed:', err)
  }
}

/**
 * checkout.session.expired — releases whatever the checkout reserved:
 *  • ANY kind carrying a gift-card hold (product/course/drop-in redemption
 *    with a partial gift-card drawdown) — releaseGiftCardHold, independent of
 *    the appointment logic below.
 *  • ANY kind carrying a promo reservation — releasePromoFromMetadata,
 *    instance-guarded.
 *  • kind === 'appointment' — prompt release at the Stripe-side expiry
 *    (~31 min for the public rail, up to 7 days for a staff payment link)
 *    instead of waiting for the daily sweep.
 *
 * EVERY ONE OF THOSE IS OWNERSHIP-CHECKED, each by a different mechanism, and
 * the appointment one was the last to get there:
 *  • the GIFT-CARD hold is addressed by a key minted fresh per attempt, so a
 *    superseded attempt's release can only ever reach its own hold — ownership
 *    by construction, and the reason the promo (whose key is deterministic on
 *    purpose) needs an explicit instance marker instead;
 *  • the PROMO reservation compares that instance marker inside its transaction;
 *  • the APPOINTMENT hold compares `booking_token` inside its transaction. It
 *    used to cancel the session and delete the booking on PRESENCE alone, which
 *    is unsound at a deterministic, SHARED session id: a retry by the same
 *    contact rewrites the hold in place (`allowRewriteByHolder`), so an expiry
 *    for the SUPERSEDED attempt cancelled the hold the retry's live, payable
 *    session was guarding — the buyer pays for an appointment that has just been
 *    cancelled out from under them.
 *
 * Phase 3 turned that from rare into likely: a promo refresh EXPIRES the
 * superseded Checkout Session at Stripe before writing anything, so this event
 * now arrives seconds after the retry rather than ~31 minutes later. Exactly the
 * same shape as the promo release beside it, and the same fix — prove ownership
 * inside the transaction that deletes. `releaseAppointmentHold`
 * (appointments/holdRelease.ts) is that transaction, shared with the callable
 * rollbacks; its module header carries the census of every release site and the
 * proof each one rests on, and is the only place that list is written down.
 */
async function handleCheckoutExpired(session: StripeWebhookPayload<StripeCheckoutSessionObject>): Promise<void> {
  const md = (session.metadata ?? {}) as Record<string, string>

  if (md.giftCardCode && md.giftCardHold && md.teamId) {
    try {
      await releaseGiftCardHold({
        teamId: md.teamId,
        code: md.giftCardCode,
        holdKey: md.giftCardHold,
      })
    } catch (err) {
      console.error(`[connect] gift card hold release failed (code=${md.giftCardCode}):`, err)
    }
  }

  // …and the promo reservation, for ANY kind, beside its gift-card neighbour.
  //
  // THIS IS THE PRIMARY RELEASE PATH FOR A PROMO SLOT, not a nicety on top of
  // lazy expiry, and the distinction is the cap. This event is POSITIVE EVIDENCE
  // that the session can never take money again — Stripe emits it (and retries
  // it) at the session's own expiry — so a slot freed here is provably free. The
  // reservation's own deadline sits an hour further out
  // (PROMO_RESERVATION_BACKSTOP_MINUTES) precisely so that it does NOT decide
  // this: a lease measured in minutes cannot outrun Stripe's delivery horizon,
  // which is measured in hours, and a slot re-handed while a paid-but-undelivered
  // session existed is exactly how the counters used to run past their caps.
  //
  // Instance-guarded, and this is the caller that check exists for: Stripe
  // expires abandoned sessions on its own schedule, so an expiry for a session a
  // live retry has already superseded routinely arrives afterwards.
  await releasePromoFromMetadata(md)

  if (md.kind !== 'appointment') return
  const { sessionId, contactId, teamId } = md
  if (!sessionId || !contactId || !teamId) return

  // `md.bookingToken` is THIS session's proof that the hold at the shared
  // `apt_{provider}_{start}` id is still the one it wrote. A session created
  // before that key existed presents none, and is then judged on the named
  // secondary proofs — a hold past its own deadline, or a document that STILL
  // presents no deadline at all — never on presence. See
  // appointments/holdRelease.ts, which owns that ladder and the argument for why
  // presence is not on it.
  const outcome = await releaseAppointmentHold({
    teamId,
    sessionId,
    contactId,
    bookingToken: md.bookingToken || null,
    label: 'checkout.session.expired',
  })
  if (outcome === 'released') {
    console.log(`[connect] appointment checkout expired — released hold (session=${sessionId})`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleConnectWebhook
// ─────────────────────────────────────────────────────────────────────────────
export const handleConnectWebhook = onRequest(
  { invoker: 'public' },
  withErrorReporting('handleConnectWebhook', async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed')
      return
    }

    const signature = req.headers['stripe-signature']
    if (!signature || typeof signature !== 'string') {
      res.status(400).send('Missing stripe-signature header')
      return
    }

    let secret: string
    try {
      secret = await getSecret('stripe-connect-webhook-secret')
    } catch (err) {
      console.error('[connect] failed to load stripe-connect-webhook-secret:', err)
      res.status(500).send('Internal error')
      return
    }

    // THE ONE DELIBERATE `any` LEFT IN THIS FILE, and the reason is worth
    // stating because the rest of it was just retyped.
    //
    // `event.data.object` is a union of eighty-odd Stripe resources that TS
    // cannot narrow from `event.type`, because the verifier returns the general
    // `Event` rather than the discriminated one. Typing it therefore does not
    // buy a check — it buys eighty `as` casts at the dispatch below, and a cast
    // is an assertion exactly like this one, only louder.
    //
    // The value of typing lives in the HANDLER BODIES, where the field reads
    // are: all three of the defects that motivated this work were a moved field
    // read off an `any` inside a handler and returning `undefined` in silence.
    // Those parameters are now typed, so `turbo run typecheck` sees the next
    // one. The router is a `switch` on a string and reads nothing but `.type`,
    // `.id`, `.account` and `.data.object`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let event: any
    try {
      event = await constructConnectWebhookEvent({
        payload: req.rawBody ?? req.body,
        signature,
        secret,
      })
    } catch (err) {
      console.error('[connect] webhook signature verification failed:', err)
      res.status(400).send('Invalid webhook signature')
      return
    }

    // Idempotency: claim the event id; a duplicate delivery fails the create and
    // short-circuits without reprocessing.
    try {
      await admin
        .firestore()
        .collection(CONNECT_WEBHOOK_EVENTS_COLLECTION)
        .doc(event.id)
        .create({
          type: event.type,
          account: event.account ?? null,
          at: FieldValue.serverTimestamp(),
        })
    } catch {
      console.log(`[connect] duplicate event ${event.id} — skipping`)
      res.status(200).send('ok')
      return
    }

    try {
      const accountId: string | undefined = event.account
      const obj = event.data?.object ?? {}

      if (isAccountEvent(event.type)) {
        const team = await resolveTeam(accountId)
        if (team) {
          const status = await retrieveAccountStatus(accountId!)
          await persistAccountStatus(team.teamId, accountId!, team.model, status)
        } else {
          console.log(`[connect] account event for untracked account ${accountId}`)
        }
      } else {
        const team = await resolveTeam(accountId)
        if (!team) {
          console.log(`[connect] event ${event.type} for untracked account ${accountId} — skipping`)
          res.status(200).send('ok')
          return
        }
        switch (event.type) {
          case 'checkout.session.completed':
            await handleCheckoutCompleted(team, obj, accountId, event.id)
            break
          case 'checkout.session.expired':
            await handleCheckoutExpired(obj)
            break
          case 'payment_intent.succeeded':
            await handlePaymentIntent(team, obj, 'succeeded', event.id, accountId)
            break
          case 'payment_intent.payment_failed':
            await handlePaymentIntent(team, obj, 'failed', event.id, accountId)
            break
          case 'charge.refunded':
            await handleChargeRefunded(team, obj, event.id, accountId)
            break
          case 'charge.updated':
            await handleChargeUpdated(team, obj, accountId)
            break
          case 'charge.dispute.created':
            await handleDispute(team, obj, 'created', event.id)
            break
          case 'charge.dispute.closed':
            await handleDispute(team, obj, 'closed', event.id)
            break
          case 'payout.paid':
            await handlePayout(team, obj, 'paid', accountId!, event.id)
            break
          case 'payout.failed':
            await handlePayout(team, obj, 'failed', accountId!, event.id)
            break
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
            await handleSubscription(team, obj, event.id)
            break
          case 'customer.subscription.deleted':
            await handleSubscription(team, { ...obj, status: 'canceled' }, event.id)
            break
          case 'invoice.paid':
            await handleInvoice(team, obj, 'paid', event.id, accountId)
            break
          case 'invoice.payment_failed':
            await handleInvoice(team, obj, 'failed', event.id, accountId)
            break
          default:
            console.log(`[connect] unhandled event type ${event.type}`)
        }
      }
      console.log(`[connect] processed ${event.type} (${event.id}) account=${accountId}`)
    } catch (err) {
      // Log but return 200 — Stripe should not retry forever for our errors. The
      // event marker has already been written; manual reconcile via getConnectStatus
      // / Stripe dashboard if needed.
      console.error(`[connect] failed to process event ${event.id}:`, err)
    }

    res.status(200).send('ok')
  })
)
