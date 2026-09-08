/* eslint-disable no-console */
// Stripe Connect — payment callables (one-off + recurring), member → studio.
//
// Both create a Checkout Session ON THE CONNECTED ACCOUNT (direct charge): money
// settles on the studio's balance and Linyup takes an application fee. The fee is
// always computed centrally (computePlatformFee / takeRatePercent) from the
// studio's plan tier — never hardcoded. Amounts are integer Rappen.
//
// The returned Checkout URL is shared with the member to pay. The resulting
// member_payments / member_subscriptions records are written by the webhook
// (Phase E) from Stripe events — never from client-reported success.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  recurrenceToStripeInterval,
  isRecurringRecurrence,
  normalizeRedemptionCode,
  resolveProductPrice,
  resolvePaymentOptions,
  resolveStripeCurrency,
  toMinorUnits,
  GUEST_SNAPSHOT,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  PRODUCTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  CONTACTS_COLLECTION,
  type SubscriptionType,
  type Product,
} from '@linyup/shared'
import { getConnectStripe } from '../utils/connect/client'
import { generateSecureToken } from '../utils/crypto'
import { applyPaymentEffects } from '../payments/effects'
import { assertPlanPurchaseAllowance } from '../payments/planPurchases'
import { assertManager, loadEnabledTeam, requireChargeableAccount } from './access'
import {
  assertQuotedAmount,
  buildResultUrls,
  checkoutRateLimit,
  closeTeamCheckoutSession,
  defaultIdempotencyKey,
  requireChargeableAmountFromMajor,
  requireChargeableMinorAmount,
  resolveCheckoutHoldWindow,
  startOneOffCheckout,
  startSubscriptionCheckout,
} from './checkout'
import {
  reserveGiftCardDrawdown,
  commitGiftCardDrawdown,
  releaseGiftCardHold,
  giftCardCurrency,
} from './giftCards'
import { loadCoursePricing } from './coursePricing'
// The plan's intro offer — a coupon on the checkout, never a lower price. See
// connect/introOffer.ts; the validity rule itself lives in @linyup/shared.
import { introCheckoutMetadata, introCouponSpec } from './introOffer'
// The shop purchase receipts — ALWAYS ON. Needed HERE, not only in the webhook:
// a gift card that covers the whole price creates no Stripe session, so the
// full-cover branches below are the only place those sales can confirm
// themselves. See connect/purchaseReceipts.ts.
import { sendCoursePurchaseReceipt, sendProductPurchaseReceipt } from './purchaseReceipts'
import {
  NO_PROMO_ATTEMPT,
  bindPromoCheckoutSession,
  commitPromoRedemption,
  instrumentKeyParts,
  loadPromoAttempt,
  loadPromoCaller,
  promoCallerNotAsked,
  promoCheckoutMetadata,
  promoCheckoutOutcome,
  promoScopeOf,
  releasePromoReservation,
  reservePromoRedemption,
  resolvePromoCaller,
  type PromoAttempt,
  type PromoCaller,
  type PromoQuoteTarget,
  type PromoReservationTicket,
} from './promoCodes'
import { requireContactSessionForTeam } from '../utils/contactSession'
import { APP_CHECK_ENFORCE, monitorAppCheck } from '../utils/appCheck'

// Amount guards, result URLs, idempotency defaults, fee computation and Stripe
// error mapping all live in ./checkout — the one money core. Kept here: business
// validation + the metadata each webhook kind reads.

const SUB_INTERVALS = ['month', 'year'] as const
type SubInterval = (typeof SUB_INTERVALS)[number]

// ─────────────────────────────────────────────────────────────────────────────
// createMemberPayment — one-off direct charge (drop-in, belt test, shop item).
// ─────────────────────────────────────────────────────────────────────────────
export const createMemberPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    amount?: number
    purpose?: string
    productName?: string
    contactId?: string
    customerEmail?: string
    successUrl?: string
    cancelUrl?: string
    locale?: string
    idempotencyKey?: string
    origin?: string
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const teamId = data.teamId
  const amount = requireChargeableMinorAmount(data.amount)
  const purpose = (data.purpose ?? 'payment').slice(0, 64)
  const locale = data.locale ?? 'en'

  await assertManager(request.auth.uid, teamId)
  const team = await loadEnabledTeam(teamId)

  const { successUrl, cancelUrl } = await buildResultUrls(locale, {
    successUrl: data.successUrl,
    cancelUrl: data.cancelUrl,
    origin: data.origin,
    teamId,
  })

  const metadata: Record<string, string> = { teamId, purpose, kind: 'one_off' }
  if (data.contactId) metadata.contactId = data.contactId

  return startOneOffCheckout({
    team,
    amountMinor: amount,
    productName: data.productName ?? purpose,
    successUrl,
    cancelUrl,
    customerEmail: data.customerEmail,
    metadata,
    idempotencyKey:
      data.idempotencyKey ??
      defaultIdempotencyKey('member-pay', teamId, request.auth.uid, String(amount), purpose),
    label: 'createMemberPayment',
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// createMemberSubscription — recurring membership (card + TWINT). Fee is taken
// per invoice via application_fee_percent.
//
// TWINT recurring constraint to validate in test mode: only ONE active TWINT
// mandate per studio↔member pair (see the Connect README / brief §6).
// ─────────────────────────────────────────────────────────────────────────────
export const createMemberSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    amount?: number
    interval?: string
    productName?: string
    contactId?: string
    customerEmail?: string
    successUrl?: string
    cancelUrl?: string
    locale?: string
    idempotencyKey?: string
    origin?: string
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const teamId = data.teamId
  const amount = requireChargeableMinorAmount(data.amount)
  const interval = (data.interval ?? 'month') as SubInterval
  if (!SUB_INTERVALS.includes(interval)) {
    throw new HttpsError('invalid-argument', `interval must be one of: ${SUB_INTERVALS.join(', ')}`)
  }
  const locale = data.locale ?? 'en'

  await assertManager(request.auth.uid, teamId)
  const team = await loadEnabledTeam(teamId)

  const { successUrl, cancelUrl } = await buildResultUrls(locale, {
    successUrl: data.successUrl,
    cancelUrl: data.cancelUrl,
    origin: data.origin,
    teamId,
  })

  const metadata: Record<string, string> = { teamId, kind: 'subscription' }
  if (data.contactId) metadata.contactId = data.contactId

  return startSubscriptionCheckout({
    team,
    amountMinor: amount,
    interval,
    productName: data.productName ?? 'Membership',
    successUrl,
    cancelUrl,
    customerEmail: data.customerEmail,
    metadata,
    idempotencyKey:
      data.idempotencyKey ??
      defaultIdempotencyKey('member-sub', teamId, request.auth.uid, String(amount), interval),
    label: 'createMemberSubscription',
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// createMembershipPayment — sell one of the team's subscription types to a member.
// Resolves the chosen price, routes recurring→subscription / one-off→single charge,
// and embeds metadata so the webhook updates the member's contact membership.
// ─────────────────────────────────────────────────────────────────────────────
export const createMembershipPayment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    subscriptionTypeId?: string
    priceId?: string
    contactId?: string
    customerEmail?: string
    successUrl?: string
    cancelUrl?: string
    locale?: string
    idempotencyKey?: string
    origin?: string
  }
  if (!data?.teamId || !data?.subscriptionTypeId || !data?.priceId) {
    throw new HttpsError('invalid-argument', 'teamId, subscriptionTypeId and priceId are required')
  }
  const { teamId, subscriptionTypeId, priceId } = data
  const locale = data.locale ?? 'en'

  await assertManager(request.auth.uid, teamId)
  const team = await loadEnabledTeam(teamId)
  requireChargeableAccount(team) // fail before the reads; the orchestrator re-checks

  // Resolve the subscription type + the chosen price.
  const typeSnap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .doc(subscriptionTypeId)
    .get()
  if (!typeSnap.exists) throw new HttpsError('not-found', 'Subscription type not found')
  const subType = typeSnap.data() as SubscriptionType
  const price = (subType.prices ?? []).find((p) => p.id === priceId)
  if (!price) throw new HttpsError('not-found', 'Price not found on this subscription type')

  // Amount: subscription prices are stored in MAJOR units (e.g. 49.9) → Rappen.
  const amount = requireChargeableAmountFromMajor(price.amount)

  const { successUrl, cancelUrl } = await buildResultUrls(locale, {
    successUrl: data.successUrl,
    cancelUrl: data.cancelUrl,
    origin: data.origin,
    teamId,
  })
  const productName = price.label ? `${subType.name} — ${price.label}` : subType.name

  // Metadata the webhook reads to update the member's contact membership.
  const metadata: Record<string, string> = {
    teamId,
    kind: 'membership',
    subscriptionTypeId,
    subscriptionTypeName: subType.name,
    priceId,
    recurrence: price.recurrence,
  }
  if (data.contactId) metadata.contactId = data.contactId
  if (price.included_months) metadata.includedMonths = String(price.included_months)
  // Credit pack: the webhook materialises a CreditGrant alongside the membership.
  if (price.credits) metadata.credits = String(price.credits)

  const interval = recurrenceToStripeInterval(price.recurrence)
  const idempotencyKey =
    data.idempotencyKey ??
    defaultIdempotencyKey('membership', teamId, request.auth.uid, priceId)

  if (isRecurringRecurrence(price.recurrence) && interval) {
    // The plan's intro offer, if it names THIS price and Stripe can express it.
    // `amount` stays the full per-period price — the offer is a coupon.
    const intro = introCouponSpec({
      subType,
      subscriptionTypeId,
      priceId,
      currency: resolveStripeCurrency(team.data.default_currency as string | undefined),
    })
    const session = await startSubscriptionCheckout({
      team,
      amountMinor: amount,
      interval: interval.interval,
      intervalCount: interval.interval_count,
      productName,
      successUrl,
      cancelUrl,
      customerEmail: data.customerEmail,
      metadata: { ...metadata, ...(intro ? introCheckoutMetadata(intro.offer) : {}) },
      idempotencyKey,
      label: 'createMembershipPayment',
      ...(intro ? { introCoupon: intro.spec } : {}),
    })
    return { url: session.url, sessionId: session.sessionId, recurring: true }
  }

  // per_class / one_time → single charge.
  const session = await startOneOffCheckout({
    team,
    amountMinor: amount,
    productName,
    successUrl,
    cancelUrl,
    customerEmail: data.customerEmail,
    metadata,
    idempotencyKey,
    label: 'createMembershipPayment',
  })
  return { url: session.url, sessionId: session.sessionId, recurring: false }
})

// ─────────────────────────────────────────────────────────────────────────────
// createMembershipCheckout — the member-facing shop's subscription checkout.
// LOGIN-FIRST: requires a contact session for the team (the buyer signed in or
// registered via the OTP flow before paying); metadata.contactId always links the
// sale to that exact contact. Guarded by the Connect kill-switch + a chargeable
// account + rate limit. Sibling of the manager-side createMembershipPayment.
// ─────────────────────────────────────────────────────────────────────────────
export const createMembershipCheckout = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'createMembershipCheckout')
  const data = request.data as {
    teamId?: string
    subscriptionTypeId?: string
    priceId?: string
    slug?: string
    locale?: string
    idempotencyKey?: string
    origin?: string
  }
  if (!data?.teamId || !data?.subscriptionTypeId || !data?.priceId) {
    throw new HttpsError('invalid-argument', 'teamId, subscriptionTypeId and priceId are required')
  }
  const { teamId, subscriptionTypeId, priceId } = data
  const locale = data.locale ?? 'en'

  await checkoutRateLimit(request.rawRequest?.ip)

  // Login-first: every shop purchase runs as a verified contact of this team (the
  // sign-in/register flow precedes checkout). The session is the ONLY trusted
  // identity source; its email claim doubles as the Stripe receipt address.
  const session = await requireContactSessionForTeam(request, teamId)
  const email = session.email ?? undefined

  // Remaining gates: the team's Connect kill-switch + chargeable account.
  const team = await loadEnabledTeam(teamId)
  requireChargeableAccount(team) // fail before the reads; the orchestrator re-checks

  const typeSnap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .doc(subscriptionTypeId)
    .get()
  if (!typeSnap.exists) throw new HttpsError('not-found', 'Subscription type not found')
  const subType = typeSnap.data() as SubscriptionType
  // Only public + active types are sellable from the public shop.
  if (subType.public !== true || subType.active === false) {
    throw new HttpsError('failed-precondition', 'This item is not available')
  }
  // Contact-capture mode is read server-side (never trust the client). Under
  // login-first the buyer IS a contact already, so 'off'/'minimal' are moot; only
  // 'full' still matters — it routes the success page to the finish-signup nudge.
  const contactMode = subType.checkout_contact_mode ?? 'minimal'
  const price = (subType.prices ?? []).find((p) => p.id === priceId && p.active !== false)
  if (!price) throw new HttpsError('not-found', 'Price not found on this subscription type')

  const amount = requireChargeableAmountFromMajor(price.amount)

  // Block buying a subscription type the buyer ALREADY actively holds (recurring only —
  // one-off drop-ins may legitimately stack). A contact may hold several *different*
  // types at once, but never two of the same. Login-first gives us the exact contact;
  // races (two tabs) still fall through to the webhook safety net (cancel + refund).
  // Query by contactId only (single-field index, like onMemberSubscriptionWrite) and
  // filter type/status in memory — a contact has few subscriptions.
  if (isRecurringRecurrence(price.recurrence)) {
    const subsSnap = await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
      .where('contactId', '==', session.contactId)
      .get()
    const LIVE = new Set(['active', 'trialing', 'past_due'])
    const holdsSameType = subsSnap.docs.some((d) => {
      const s = d.data()
      return (
        s.subscriptionTypeId === subscriptionTypeId && LIVE.has(s.status as string) && !s.duplicate
      )
    })
    if (holdsSameType) {
      throw new HttpsError('already-exists', 'You already have this subscription.')
    }
  }

  // The price's own per-contact purchase cap ("this 2-month intro is once per
  // person"). One-time prices only, self-service only, and it accepts the same
  // two-tab race the check above does — see payments/planPurchases.ts.
  await assertPlanPurchaseAllowance(admin.firestore(), session.contactId, price)

  // A 'full' purchase lands the buyer on the signup-finalize page (email prefilled)
  // — the finish-your-profile nudge — but ONLY if this contact hasn't completed
  // registration yet (signup_completed_at unset): a returning buyer shouldn't be
  // asked to register again after every purchase. Everyone else returns to the
  // shop. The result page only honours seg=signup on success.
  let seg = 'shop'
  if (contactMode === 'full') {
    const contactSnap = await admin
      .firestore()
      .collection(CONTACTS_COLLECTION)
      .doc(session.contactId)
      .get()
    if (!contactSnap.data()?.signup_completed_at) seg = 'signup'
  }
  const emailQuery = seg === 'signup' && email ? `&email=${encodeURIComponent(email)}` : ''
  const slugQuery = data.slug
    ? `&slug=${encodeURIComponent(data.slug)}&seg=${seg}${emailQuery}`
    : ''
  const { successUrl, cancelUrl } = await buildResultUrls(locale, {
    extraQuery: slugQuery,
    origin: data.origin,
    teamId,
  })
  const productName = price.label ? `${subType.name} — ${price.label}` : subType.name

  // Webhook reads this to link the sale to the buyer's exact contact.
  const metadata: Record<string, string> = {
    teamId,
    kind: 'membership',
    subscriptionTypeId,
    subscriptionTypeName: subType.name,
    priceId,
    recurrence: price.recurrence,
    contactId: session.contactId,
    contactMode,
  }
  if (price.included_months) metadata.includedMonths = String(price.included_months)
  // Credit pack: the webhook materialises a CreditGrant alongside the membership.
  if (price.credits) metadata.credits = String(price.credits)

  const interval = recurrenceToStripeInterval(price.recurrence)
  const idempotencyKey =
    data.idempotencyKey ??
    defaultIdempotencyKey('membership-pub', teamId, priceId, session.contactId)

  if (isRecurringRecurrence(price.recurrence) && interval) {
    // Same resolver the public pricing card rendered from, so the buyer is
    // charged exactly what the card said. `amount` is the FULL per-period price
    // in both places — the offer rides the coupon and expires on its own.
    const intro = introCouponSpec({
      subType,
      subscriptionTypeId,
      priceId,
      currency: resolveStripeCurrency(team.data.default_currency as string | undefined),
    })
    const checkout = await startSubscriptionCheckout({
      team,
      amountMinor: amount,
      interval: interval.interval,
      intervalCount: interval.interval_count,
      productName,
      successUrl,
      cancelUrl,
      customerEmail: email,
      metadata: { ...metadata, ...(intro ? introCheckoutMetadata(intro.offer) : {}) },
      idempotencyKey,
      label: 'createMembershipCheckout',
      ...(intro ? { introCoupon: intro.spec } : {}),
    })
    return { url: checkout.url, sessionId: checkout.sessionId, recurring: true }
  }

  const checkout = await startOneOffCheckout({
    team,
    amountMinor: amount,
    productName,
    successUrl,
    cancelUrl,
    customerEmail: email,
    metadata,
    idempotencyKey,
    label: 'createMembershipCheckout',
  })
  return { url: checkout.url, sessionId: checkout.sessionId, recurring: false }
})

// ─────────────────────────────────────────────────────────────────────────────
// createProductCheckout — one-off checkout for the member-facing shop's PRODUCTS
// section. LOGIN-FIRST (see createMembershipCheckout): the buyer holds a contact
// session; metadata.contactId links the sale. Always a single charge (never
// recurring) on the studio's connected account. The optional variantId selects a
// size/colour; the price is the variant override or the product's base price.
// ─────────────────────────────────────────────────────────────────────────────
export const createProductCheckout = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'createProductCheckout')
  const data = request.data as {
    teamId?: string
    productId?: string
    variantId?: string
    slug?: string
    locale?: string
    idempotencyKey?: string
    origin?: string
    /** Optional gift-card code to draw down against this purchase. */
    giftCardCode?: string
    /** Optional promo code — a Stage A price MODIFIER, applied inside the
     *  resolver. Never applied here: that is what the Stage A / Stage B rule
     *  forbids, and it is why this rail had to stop pricing itself first. */
    promoCode?: string
    /** The price the surface rendered, major units. Disagreement → refuse with
     *  `price_changed` rather than charge a figure the buyer never saw. */
    quotedAmount?: number
  }
  if (!data?.teamId || !data?.productId) {
    throw new HttpsError('invalid-argument', 'teamId and productId are required')
  }
  const { teamId, productId } = data
  const variantId = data.variantId
  const locale = data.locale ?? 'en'

  await checkoutRateLimit(request.rawRequest?.ip)

  // Login-first: the buyer is a verified contact of this team (see membership above).
  const session = await requireContactSessionForTeam(request, teamId)
  const email = session.email ?? undefined

  // Remaining gates: the team's Connect kill-switch + chargeable account.
  const team = await loadEnabledTeam(teamId)
  // Chargeable-account gate: a FULL-COVER gift-card redemption moves no money
  // and must work without Stripe onboarding — when a code is supplied, the
  // check is deferred to the orchestrator (which re-checks before any charge;
  // the reserved hold is released if that late check throws).
  if (!data.giftCardCode) requireChargeableAccount(team)

  const productSnap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(PRODUCTS_SUBCOLLECTION)
    .doc(productId)
    .get()
  if (!productSnap.exists) throw new HttpsError('not-found', 'Product not found')
  const product = productSnap.data() as Product
  // Only active products are sellable from the public shop.
  if (product.active === false) {
    throw new HttpsError('failed-precondition', 'This item is not available')
  }

  // Resolve the chosen variant (if any) and validate it is active.
  let variantLabel: string | undefined
  if (variantId) {
    const variant = (product.variants ?? []).find((v) => v.id === variantId)
    if (!variant || variant.active === false) {
      throw new HttpsError('not-found', 'Variant not available')
    }
    variantLabel = variant.label
  }

  // Config sanity: the AUTHORED price must be chargeable. Authored values below
  // the floor are a configuration error and throw here, before anything is
  // derived from them — the same pre-flight the drop-in rail runs on its base
  // price (booking/dropIn.ts), with the return discarded.
  const listMajor = resolveProductPrice(product, variantId)
  requireChargeableAmountFromMajor(listMajor)

  // ── The promo, loaded before Stage A and never throwing ──
  // The AUDIENCE gate is the ONLY reason this login-first callable reads the
  // buyer's contact at all, and it reads it only when a code was typed. It is a
  // question about the EMAIL, not about that one document, so a not-yet-joined
  // buyer costs one further query (the household case). The product ARM stays
  // snapshot-invariant; the gate is a separate question, and it lives in the
  // loader.
  const promoTarget: PromoQuoteTarget = {
    kind: 'product',
    productId,
    variantId: variantId ?? null,
  }
  const promoCaller: PromoCaller = data.promoCode
    ? await loadPromoCaller({ teamId, contactId: session.contactId, email: email ?? null })
    : // No code typed ⇒ the identity gates are never consulted, so nothing here
      // answers "is this person already a member?" — and a hand-built
      // `joined: false` literal is exactly how that question got answered wrong
      // three times. The named helper says out loud that it is a placeholder.
      promoCallerNotAsked({ contactId: session.contactId, email: email ?? null })
  const promo: PromoAttempt = data.promoCode
    ? await loadPromoAttempt({
        teamId,
        code: data.promoCode,
        target: promoTarget,
        caller: promoCaller,
        chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
      })
    : NO_PROMO_ATTEMPT

  // Through the ONE resolver. Until now this rail priced itself, which is why a
  // price MODIFIER (a promo code) could not exist on merchandise without
  // violating the Stage A / Stage B rule — the modifier would have had to be
  // applied at the callable, where tenders live.
  //
  // GUEST_SNAPSHOT is correct rather than lazy: the product arm reads NOTHING
  // from the snapshot (it never covers and never denies, and `Product` carries
  // no benefit), so loading this buyer's subscription facts would be Firestore
  // reads that cannot change the answer. The day `Product` gains a benefit this
  // must become a real snapshot via loadContactPaymentSnapshot — the resolver
  // fixture "the product arm ignores the snapshot" is the tripwire.
  const priced = resolvePaymentOptions(
    GUEST_SNAPSHOT,
    { kind: 'product', priceAmount: listMajor, benefit: null },
    promo.modifier ? { promo: promo.modifier } : undefined
  )
  if (promo.modifier && !priced.promo) {
    // A supplied modifier that produced no outcome is a missed resolver call
    // site — loud, never a silent full-price charge.
    throw new HttpsError('internal', 'The promo code did not reach the resolver')
  }
  const payOption = priced.options.find((o) => o.type === 'pay')
  if (!payOption) {
    // Unreachable by construction (the arm returns exactly one pay option for
    // every snapshot). Loud rather than silently charging the list price.
    throw new HttpsError('internal', 'Product pricing did not resolve')
  }
  // The one number everything downstream reads — the gift-card reservation, the
  // full-cover branch and the Stripe charge. Equal to the list price when no
  // code applies; the point of routing through the resolver is that it stops
  // being so.
  const priceMajor = payOption.amount
  const amount = requireChargeableAmountFromMajor(priceMajor)
  // Promo-carrying checkouts only — see assertQuotedAmount (and the course
  // branch below, which has the same stale-catalogue exposure). `promo.refusal`
  // rides along so a refused code is reported AS a refused code: a buyer who
  // applied it before signing in, then signed in as a member, must be told the
  // code is for new customers, not that the studio moved the price.
  assertQuotedAmount(data.quotedAmount, priceMajor, {
    promoAttempted: Boolean(data.promoCode),
    promoRefusal: promo.refusal,
  })
  const promoApplied = priced.promo?.status === 'applied'

  const slugQuery = data.slug ? `&slug=${encodeURIComponent(data.slug)}&seg=shop` : ''
  const { successUrl, cancelUrl } = await buildResultUrls(locale, {
    extraQuery: slugQuery,
    origin: data.origin,
    teamId,
  })
  const productName = variantLabel ? `${product.name} — ${variantLabel}` : product.name

  // Webhook reads this to record the sale + link it to the buyer's exact contact.
  const metadata: Record<string, string> = {
    teamId,
    kind: 'product',
    purpose: 'product',
    productId,
    productName: product.name,
    contactId: session.contactId,
    // The promo's mirror of the gift card's giftCardCode/Hold/Drawdown trio is
    // NOT spread here — it is stamped below, from the reservation ticket, so it
    // cannot exist without a reservation behind it.
  }
  if (variantId) metadata.variantId = variantId
  if (variantLabel) metadata.variantLabel = variantLabel

  // ONE instant for the Stripe session and for anything reserved against it.
  // A purchase that reserves NOTHING keeps Stripe's 24-hour default and the
  // buyer keeps the option to think it over overnight; the moment a finite thing
  // rides the session — a gift-card hold, a promo reservation, or both — the
  // window shortens so that thing is released promptly instead of being held
  // hostage by an abandoned cart for a day.
  //
  // And the moment it shortens, the work below it starts spending
  // CHECKOUT_WINDOW_WORK_BUDGET_SECONDS — the promo reserve and the gift-card
  // reserve on this rail. Overspending is refused at startOneOffCheckout; the
  // 24-hour branch has no budget to spend (nothing is reserved against it).
  const holdWindow = resolveCheckoutHoldWindow({
    nowMs: Date.now(),
    carriesReservation: Boolean(data.giftCardCode) || promoApplied,
  })

  // ── RESERVE: the promo first, then the gift card ──
  // The promo goes first because the drawdown is computed against `priceMajor`;
  // a promo failure after it would leave the card reserved against a price that
  // no longer applies.
  //
  // THE TICKET IS THE ONLY PROOF ANYTHING WAS RESERVED — null unless the resolver
  // said `applied`, and required by everything that touches the reservation.
  let promoTicket: PromoReservationTicket | null = null
  if (promoApplied && promo.code) {
    promoTicket = await reservePromoRedemption({
      teamId,
      code: promo.code,
      contactId: session.contactId,
      identityKey: promo.identityKey,
      reservationKey: promo.reservationKey,
      targetKey: promo.targetKey,
      scope: promoScopeOf(promoTarget),
      caller: promoCaller,
      // The same instant the Stripe session gets, plus the promo BACKSTOP —
      // longer than the gift card's margin on purpose, because this slot is
      // freed by the expiry webhook and its lazy expiry must not race the
      // delivery of the completion webhook that decides the same slot.
      expiresAt: Timestamp.fromMillis(Date.now() + (holdWindow.promoHoldMinutes ?? 0) * 60_000),
      amountMajor: priceMajor,
      baseAmount: payOption.appliedPromo?.baseAmount ?? priceMajor,
      chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
      // Supersede the session this slot was already backing, or refuse. Without
      // it, a retry leaves the previous Checkout Session payable and one slot
      // backs two genuine discounted product orders.
      closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
    })
  }
  // Stamped from the TICKET and only after the reserve returned: metadata exists
  // IFF a reservation exists, so the webhook can never commit one that does not.
  Object.assign(metadata, promoCheckoutMetadata(promoTicket, priceMajor))

  // HOISTED ABOVE THE IDEMPOTENCY KEY, not minted where it is used: the hold key
  // is stamped into the session metadata (`giftCardHold`) and is therefore a
  // request PARAMETER, so a key that omits it is reused across attempts whose
  // parameters differ and Stripe refuses the second one. Same reasoning as the
  // promo's `instanceId` — see instrumentKeyParts.
  const giftCardHoldKey = data.giftCardCode ? generateSecureToken(16) : null

  const idempotencyKey =
    data.idempotencyKey ??
    // Instruments appended LAST, never reordered, and ZERO parts when none
    // applied — see instrumentKeyParts.
    defaultIdempotencyKey(
      'product-pub',
      teamId,
      productId,
      variantId ?? '_',
      session.contactId,
      ...instrumentKeyParts(
        promoTicket,
        data.giftCardCode && giftCardHoldKey
          ? { code: data.giftCardCode, holdKey: giftCardHoldKey }
          : null
      )
    )

  /** Idempotent no-op when nothing was reserved, or once it is committed. */
  const releaseReservedPromo = async (): Promise<void> => {
    if (promoTicket) {
      await releasePromoReservation({
        teamId,
        code: promoTicket.code,
        reservationKey: promoTicket.reservationKey,
        // OUR instance — a newer attempt at this purchase owns the entry now, and
        // this release must not free the slot guarding its live session.
        instanceId: promoTicket.instanceId,
      }).catch(() => undefined)
    }
  }

  try {
  // Optional gift-card redemption: reserve a drawdown against the total, then
  // either FULL COVER (apply effects directly, no Stripe) or reduce the Stripe
  // charge to the residual and carry the hold through checkout metadata.
  if (data.giftCardCode) {
    // Minted above, with the idempotency key that carries it.
    const holdKey = giftCardHoldKey as string
    const plan = await reserveGiftCardDrawdown({
      teamId,
      code: data.giftCardCode,
      // Post-promo — the resolver already applied the modifier, so the card
      // draws against the discounted total with no change to its own code.
      totalMajor: priceMajor,
      holdKey,
      // Same instant the Stripe session below gets, plus the margin — the hold
      // must outlive the payment window it is guarding.
      holdMinutes: holdWindow.holdMinutes,
      // Card currency must match the charge — see reserveGiftCardDrawdown.
      chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
    })
    const paymentRef = `gift:${normalizeRedemptionCode(data.giftCardCode)}:${holdKey}`

    if (plan.residual === 0) {
      await applyPaymentEffects(admin.firestore(), {
        teamId,
        contactId: session.contactId,
        lineItem: { kind: 'product', productId, variantId, label: productName },
        amountRappen: toMinorUnits(plan.drawdown),
        currency: 'CHF',
        source: 'gift_card',
        paymentRef,
      })
      // The wrapper also writes the journal pair — this branch creates NO
      // Stripe session, so no webhook ever runs for it and this is the only
      // place the sale can be recorded at all.
      await commitGiftCardDrawdown({
        teamId,
        code: data.giftCardCode,
        holdKey,
        targetCategory: 'product',
        contactId: session.contactId,
        description: productName,
      })
      // …and, for the same reason, the promo — separately. It cannot ride on
      // commitGiftCardDrawdown, which returns early for a card with nothing left
      // to commit and again for an `admin_comp` card, and which only runs when a
      // gift-card code was supplied at all.
      if (promoTicket) {
        await commitPromoRedemption({
          teamId,
          code: promoTicket.code,
          reservationKey: promoTicket.reservationKey,
          instanceId: promoTicket.instanceId,
          // Our own claim deadline: only the attempt still holding the slot
          // spends it. Here the reserve is seconds old, so it is always ours.
          reservationExpiresMs: promoTicket.expiresAtMs,
          fallbackContactId: session.contactId,
          fallbackIdentityKey: promoTicket.identityKey,
          fallbackAmountMajor: priceMajor,
          targetKind: 'product',
        }).catch((err) => {
          // Best-effort: the buyer paid and owning the goods matters more than
          // the count. A lapsed reservation under-reports by one — the safe
          // direction.
          console.error('[promo] full-cover product commit failed:', err)
        })
      }
      // THE SAME RECEIPT THE STRIPE-PAID ORDER GETS (UX-77). Stored value is
      // money, and this branch creates NO Stripe session — so `handleProductCheckout`
      // never runs for it and it is the only place the buyer can be told
      // anything at all. Exactly the hole UX-76 found on the drop-in rail.
      // `holdKey` is the tender ref, minted once per attempt, so a client retry
      // cannot mail twice.
      await sendProductPurchaseReceipt({
        teamId,
        contactId: session.contactId,
        itemLabel: productName,
        productId,
        tenderRef: `gc:${holdKey}`,
        paid: {
          amount: plan.drawdown,
          currency: giftCardCurrency(team.data?.default_currency as string | undefined),
          giftCard: true,
        },
      })
      return {
        url: null,
        sessionId: null,
        recurring: false,
        paidWithGiftCard: true,
        amount: 0,
        drawdown: plan.drawdown,
        ...promoCheckoutOutcome(promo, priced),
      }
    }

    metadata.giftCardCode = normalizeRedemptionCode(data.giftCardCode)
    metadata.giftCardHold = holdKey
    metadata.giftCardDrawdown = String(plan.drawdown)
    const residualAmount = requireChargeableAmountFromMajor(plan.residual)
    let checkout
    try {
      checkout = await startOneOffCheckout({
        team,
        amountMinor: residualAmount,
        productName,
        successUrl,
        cancelUrl,
        customerEmail: email,
        metadata,
        idempotencyKey,
        expiresAtEpochSeconds: holdWindow.expiresAtEpochSeconds,
        label: 'createProductCheckout',
      })
      // The slot now names the session that may be paid against it. Inside this
      // try so a bind refusal releases the drawdown too.
      await bindPromoCheckoutSession({
        teamId,
        ticket: promoTicket,
        sessionId: checkout.sessionId,
        closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
      })
    } catch (err) {
      // Don't leave the reserved drawdown dangling until its lazy expiry.
      await releaseGiftCardHold({ teamId, code: data.giftCardCode, holdKey }).catch(() => undefined)
      throw err
    }
    return {
      url: checkout.url,
      sessionId: checkout.sessionId,
      recurring: false,
      amount: residualAmount,
      drawdown: plan.drawdown,
      residual: plan.residual,
      ...promoCheckoutOutcome(promo, priced),
    }
  }

  const checkout = await startOneOffCheckout({
    team,
    amountMinor: amount,
    productName,
    successUrl,
    cancelUrl,
    customerEmail: email,
    metadata,
    idempotencyKey,
    // TWO PATHS REACH THIS LINE, and the window differs on each. "No gift card"
    // is not "no instrument": this is also the flagship promo case — a code
    // applied WITHOUT a gift card — and `holdWindow` was derived above from
    // `Boolean(data.giftCardCode) || promoApplied`.
    //
    //  • no code, no card → undefined → Stripe's documented 24-hour default, and
    //    the buyer keeps the option to think it over overnight;
    //  • a promo reservation is live → ~31 minutes, because a finite thing rides
    //    this session and one abandoned cart must not hold a scarce campaign
    //    closed for a day (§10 Q10, answered "ship the short window").
    //
    // Threaded as a VALUE rather than an omission so the two paths are one line
    // rather than two branches — which is what stops B3b (the 24-hour hole) being
    // rediscovered on whichever path grows an instrument next.
    expiresAtEpochSeconds: holdWindow.expiresAtEpochSeconds,
    label: 'createProductCheckout',
  })
  // Bind the slot to the ONE session that may be paid against it, before the URL
  // leaves this function — a bind that cannot happen closes that session and
  // refuses, rather than returning a payable URL nothing is holding a use for.
  await bindPromoCheckoutSession({
    teamId,
    ticket: promoTicket,
    sessionId: checkout.sessionId,
    closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
  })
  return {
    url: checkout.url,
    sessionId: checkout.sessionId,
    recurring: false,
    ...promoCheckoutOutcome(promo, priced),
  }
  } catch (err) {
    // THE guard: every path from the promo reserve to a successful return passes
    // through here, so a reservation is never stranded until its lazy expiry —
    // including reserveGiftCardDrawdown's three throws, which is the flagship
    // "valid code plus a mistyped gift card" case.
    await releaseReservedPromo()
    throw err
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// createCourseCheckout — one-off purchase of a 'purchase'-tier online course (LMS).
// LOGIN-FIRST (see createMembershipCheckout): the buyer holds a contact session,
// so the webhook grants the lifetime entitlement (courses/{id}/purchases/{contactId})
// to exactly that contact — already signed in to watch. Mirrors createProductCheckout;
// the success page lands in the Space (seg=space).
// ─────────────────────────────────────────────────────────────────────────────
export const createCourseCheckout = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'createCourseCheckout')
  const data = request.data as {
    teamId?: string
    courseId?: string
    slug?: string
    locale?: string
    idempotencyKey?: string
    origin?: string
    /** Optional gift-card code to draw down against this purchase. */
    giftCardCode?: string
    /** Optional promo code — a Stage A price MODIFIER, applied inside the
     *  resolver and never here. */
    promoCode?: string
    /** The price the surface rendered, major units. Disagreement → refuse with
     *  `price_changed` rather than charge a figure the buyer never saw. */
    quotedAmount?: number
  }
  if (!data?.teamId || !data?.courseId) {
    throw new HttpsError('invalid-argument', 'teamId and courseId are required')
  }
  const { teamId, courseId } = data
  const locale = data.locale ?? 'en'

  await checkoutRateLimit(request.rawRequest?.ip)

  // Login-first: the buyer is a verified contact of this team — the entitlement is
  // granted to exactly this contact (e.g. the child a parent selected at sign-in).
  const session = await requireContactSessionForTeam(request, teamId)
  const email = session.email ?? undefined

  // Remaining gates: the team's Connect kill-switch + chargeable account.
  const team = await loadEnabledTeam(teamId)
  // Chargeable-account gate: a FULL-COVER gift-card redemption moves no money
  // and must work without Stripe onboarding — when a code is supplied, the
  // check is deferred to the orchestrator (which re-checks before any charge;
  // the reserved hold is released if that late check throws).
  if (!data.giftCardCode) requireChargeableAccount(team)

  // ── ONE assembly of this rail's pricing inputs (N22) ──
  // The course refusals ("not found" / "not available" / "not for sale"), the
  // contact document, the purchase entitlement, the benefit and the snapshot's
  // relevantTypeIds union all live in loadCoursePricing — which is exactly what
  // previewPromoCode calls. Two independent assemblies is how a preview starts
  // quoting a price this callable would not charge; the helper existed for that
  // reason and this callable was still doing it by hand.
  const pricing = await loadCoursePricing({ teamId, courseId, contactId: session.contactId })
  const course = pricing.course

  // ── The promo, loaded before Stage A and never throwing ──
  // The contact document came back with the pricing, so this rail hands it
  // straight to `resolvePromoCaller` — the ONE definition of "new customer"
  // every rail shares. Holding a document does NOT settle the gate: a buyer
  // whose own contact has not joined still shares a mailbox with one that may
  // have, so the email is consulted unless the held document already says joined.
  const promoTarget: PromoQuoteTarget = { kind: 'course', courseId }
  const promoCaller: PromoCaller = await resolvePromoCaller({
    teamId,
    contact: pricing.contact,
    email: email ?? null,
    codeTyped: Boolean(data.promoCode),
  })
  const promo: PromoAttempt = data.promoCode
    ? await loadPromoAttempt({
        teamId,
        code: data.promoCode,
        target: promoTarget,
        caller: promoCaller,
        chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
      })
    : NO_PROMO_ATTEMPT

  const priced = resolvePaymentOptions(
    pricing.snapshot,
    pricing.target,
    promo.modifier ? { promo: promo.modifier } : undefined
  )
  if (promo.modifier && !priced.promo) {
    // A supplied modifier that produced no outcome is a missed resolver call
    // site — loud, never a silent full-price charge.
    throw new HttpsError('internal', 'The promo code did not reach the resolver')
  }
  const payOption = priced.options[0]
  // Refuse selling only when the buyer's access is GRANTABLE BY THE RULES:
  // owning the course, or coverage via their PRIMARY subscription type (the
  // only one canReadPublishedCourse checks). A resolver-covered-but-not-
  // rules-grantable state (e.g. coverage via a secondary held type) must fall
  // through to a normal sale — refusing would deadlock the buyer between a
  // checkout that says "you already have access" and rules that deny the read.
  const primaryTypeId = pricing.primaryTypeId
  if (payOption?.type !== 'pay') {
    const via = payOption?.type === 'covered' ? payOption.via : null
    const rulesGrantable =
      via !== null &&
      (via.reason === 'owned' ||
        (('subscriptionTypeId' in via ? via.subscriptionTypeId : null) === primaryTypeId &&
          primaryTypeId !== null))
    if (rulesGrantable) {
      throw new HttpsError('failed-precondition', 'You already have access to this course', {
        reason: 'covered',
      })
    }
  }
  // Effective amount: the pay option's (benefit-discounted) price, or the base
  // course price on the fall-through path above.
  const priceMajor = payOption?.type === 'pay' ? payOption.amount : pricing.listMajor
  const amount = requireChargeableAmountFromMajor(priceMajor)
  // Promo-carrying checkouts only — the shop fetches its catalogue once with no
  // listener, so a price raised underneath an open tab would otherwise refuse
  // that tab's every attempt forever. See assertQuotedAmount; `promo.refusal`
  // rides along so a refused code is named rather than blamed on the price.
  assertQuotedAmount(data.quotedAmount, priceMajor, {
    promoAttempted: Boolean(data.promoCode),
    promoRefusal: promo.refusal,
  })
  const promoApplied = priced.promo?.status === 'applied'

  // Land the buyer back in the Space (where they watch), not the shop.
  const slugQuery = data.slug ? `&slug=${encodeURIComponent(data.slug)}&seg=space` : ''
  const { successUrl, cancelUrl } = await buildResultUrls(locale, {
    extraQuery: slugQuery,
    origin: data.origin,
    teamId,
  })

  // Webhook reads this to grant the entitlement to the buyer's exact contact.
  const metadata: Record<string, string> = {
    teamId,
    kind: 'course',
    purpose: 'course',
    courseId,
    courseTitle: course.title,
    contactId: session.contactId,
    // The promo's mirror of the gift card's metadata trio is NOT spread here —
    // it is stamped below, from the reservation ticket, so it cannot exist
    // without a reservation behind it.
  }

  // ONE instant for the session and for anything reserved against it — see the
  // product branch above, including the work budget the reserves below spend.
  // A plain course purchase reserves nothing and keeps Stripe's 24-hour default.
  const holdWindow = resolveCheckoutHoldWindow({
    nowMs: Date.now(),
    carriesReservation: Boolean(data.giftCardCode) || promoApplied,
  })

  // ── RESERVE: the promo first, then the gift card ──
  // The promo goes first because the drawdown is computed against `priceMajor`;
  // a promo failure after it would leave the card reserved against a price that
  // no longer applies.
  //
  // THE TICKET IS THE ONLY PROOF ANYTHING WAS RESERVED — null unless the resolver
  // said `applied`, and required by everything that touches the reservation.
  let promoTicket: PromoReservationTicket | null = null
  if (promoApplied && promo.code) {
    promoTicket = await reservePromoRedemption({
      teamId,
      code: promo.code,
      contactId: session.contactId,
      identityKey: promo.identityKey,
      reservationKey: promo.reservationKey,
      targetKey: promo.targetKey,
      scope: promoScopeOf(promoTarget),
      caller: promoCaller,
      // The same instant the Stripe session gets, plus the promo BACKSTOP — see
      // the product branch above and PROMO_RESERVATION_BACKSTOP_MINUTES.
      expiresAt: Timestamp.fromMillis(Date.now() + (holdWindow.promoHoldMinutes ?? 0) * 60_000),
      amountMajor: priceMajor,
      baseAmount: payOption?.type === 'pay' ? (payOption.appliedPromo?.baseAmount ?? priceMajor) : priceMajor,
      chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
      // A course is bought once but CAN be re-attempted; the previous session
      // must be closed before a second discounted one exists.
      closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
    })
  }
  // Stamped from the TICKET and only after the reserve returned: metadata exists
  // IFF a reservation exists, so the webhook can never commit one that does not.
  Object.assign(metadata, promoCheckoutMetadata(promoTicket, priceMajor))

  // Hoisted above the idempotency key for the same reason as the product branch:
  // the hold key is a request parameter (metadata `giftCardHold`), so it belongs
  // in the key that dedupes those requests.
  const giftCardHoldKey = data.giftCardCode ? generateSecureToken(16) : null

  const idempotencyKey =
    data.idempotencyKey ??
    // Instruments appended LAST, never reordered, and ZERO parts when none
    // applied — see instrumentKeyParts.
    defaultIdempotencyKey(
      'course-pub',
      teamId,
      courseId,
      session.contactId,
      ...instrumentKeyParts(
        promoTicket,
        data.giftCardCode && giftCardHoldKey
          ? { code: data.giftCardCode, holdKey: giftCardHoldKey }
          : null
      )
    )

  /** Idempotent no-op when nothing was reserved, or once it is committed. */
  const releaseReservedPromo = async (): Promise<void> => {
    if (promoTicket) {
      await releasePromoReservation({
        teamId,
        code: promoTicket.code,
        reservationKey: promoTicket.reservationKey,
        // OUR instance — a newer attempt at this purchase owns the entry now, and
        // this release must not free the slot guarding its live session.
        instanceId: promoTicket.instanceId,
      }).catch(() => undefined)
    }
  }

  try {
  // Optional gift-card redemption — same shape as createProductCheckout above.
  if (data.giftCardCode) {
    // Minted above, with the idempotency key that carries it.
    const holdKey = giftCardHoldKey as string
    const plan = await reserveGiftCardDrawdown({
      teamId,
      code: data.giftCardCode,
      totalMajor: priceMajor,
      holdKey,
      // Same instant the Stripe session below gets, plus the margin — the hold
      // must outlive the payment window it is guarding.
      holdMinutes: holdWindow.holdMinutes,
      // Card currency must match the charge — see reserveGiftCardDrawdown.
      chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
    })
    const paymentRef = `gift:${normalizeRedemptionCode(data.giftCardCode)}:${holdKey}`

    if (plan.residual === 0) {
      await applyPaymentEffects(admin.firestore(), {
        teamId,
        contactId: session.contactId,
        lineItem: { kind: 'course', courseId, label: course.title },
        amountRappen: toMinorUnits(plan.drawdown),
        currency: 'CHF',
        source: 'gift_card',
        paymentRef,
      })
      // Journal pair included — see the product branch above: a full-cover
      // course sale has no Stripe session and therefore no webhook to record it.
      await commitGiftCardDrawdown({
        teamId,
        code: data.giftCardCode,
        holdKey,
        targetCategory: 'course',
        contactId: session.contactId,
        description: course.title,
      })
      // …and, for the same reason, the promo — separately. It cannot ride on
      // commitGiftCardDrawdown, which returns early for a card with nothing
      // left to commit and again for an `admin_comp` card, and which only runs
      // when a gift-card code was supplied at all.
      if (promoTicket) {
        await commitPromoRedemption({
          teamId,
          code: promoTicket.code,
          reservationKey: promoTicket.reservationKey,
          instanceId: promoTicket.instanceId,
          // Our own claim deadline: only the attempt still holding the slot
          // spends it. Here the reserve is seconds old, so it is always ours.
          reservationExpiresMs: promoTicket.expiresAtMs,
          fallbackContactId: session.contactId,
          fallbackIdentityKey: promoTicket.identityKey,
          fallbackAmountMajor: priceMajor,
          targetKind: 'course',
        }).catch((err) => {
          // Best-effort: the buyer paid and owning the course matters more than
          // the count. A lapsed reservation under-reports by one — the safe
          // direction.
          console.error('[promo] full-cover course commit failed:', err)
        })
      }
      // THE SAME RECEIPT THE STRIPE-PAID COURSE GETS (UX-77) — and for the same
      // reason as the product branch above: no Stripe session means no webhook,
      // so without this a buyer who spent stored value on a course would be
      // granted lifetime access and never told where to watch it.
      await sendCoursePurchaseReceipt({
        teamId,
        contactId: session.contactId,
        courseId,
        courseTitle: course.title,
        tenderRef: `gc:${holdKey}`,
        paid: {
          amount: plan.drawdown,
          currency: giftCardCurrency(team.data?.default_currency as string | undefined),
          giftCard: true,
        },
      })
      return {
        url: null,
        sessionId: null,
        recurring: false,
        paidWithGiftCard: true,
        amount: 0,
        drawdown: plan.drawdown,
        ...promoCheckoutOutcome(promo, priced),
      }
    }

    metadata.giftCardCode = normalizeRedemptionCode(data.giftCardCode)
    metadata.giftCardHold = holdKey
    metadata.giftCardDrawdown = String(plan.drawdown)
    const residualAmount = requireChargeableAmountFromMajor(plan.residual)
    let checkout
    try {
      checkout = await startOneOffCheckout({
        team,
        amountMinor: residualAmount,
        productName: course.title,
        successUrl,
        cancelUrl,
        customerEmail: email,
        metadata,
        idempotencyKey,
        expiresAtEpochSeconds: holdWindow.expiresAtEpochSeconds,
        label: 'createCourseCheckout',
      })
      // Inside this try so a bind refusal releases the drawdown too.
      await bindPromoCheckoutSession({
        teamId,
        ticket: promoTicket,
        sessionId: checkout.sessionId,
        closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
      })
    } catch (err) {
      // Don't leave the reserved drawdown dangling until its lazy expiry.
      await releaseGiftCardHold({ teamId, code: data.giftCardCode, holdKey }).catch(() => undefined)
      throw err
    }
    return {
      url: checkout.url,
      sessionId: checkout.sessionId,
      recurring: false,
      amount: residualAmount,
      drawdown: plan.drawdown,
      residual: plan.residual,
      ...promoCheckoutOutcome(promo, priced),
    }
  }

  const checkout = await startOneOffCheckout({
    team,
    amountMinor: amount,
    productName: course.title,
    successUrl,
    cancelUrl,
    customerEmail: email,
    metadata,
    idempotencyKey,
    // Undefined only when NOTHING is reserved — a promo applied without a gift
    // card reaches this same line with a live reservation and a ~31-minute
    // window. See the product branch above for both paths.
    expiresAtEpochSeconds: holdWindow.expiresAtEpochSeconds,
    label: 'createCourseCheckout',
  })
  // One slot, one payable session — bound before the URL leaves this function.
  await bindPromoCheckoutSession({
    teamId,
    ticket: promoTicket,
    sessionId: checkout.sessionId,
    closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
  })
  return {
    url: checkout.url,
    sessionId: checkout.sessionId,
    recurring: false,
    ...promoCheckoutOutcome(promo, priced),
  }
  } catch (err) {
    // THE guard: every path from the promo reserve to a successful return passes
    // through here, so a reservation is never stranded until its lazy expiry.
    await releaseReservedPromo()
    throw err
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// pause / resume member subscription — the BILLING FREEZE (summer break, injury).
// Suspends invoicing, not belonging. Uses Stripe pause_collection on the connected
// account; also mirrors the flag onto the member_subscriptions record so the
// contact-level subscription_status rollup (onMemberSubscriptionWrite) updates
// immediately, without waiting for the webhook round-trip.
// ─────────────────────────────────────────────────────────────────────────────
async function setSubscriptionPause(
  uid: string,
  teamId: string | undefined,
  subscriptionId: string | undefined,
  pause: boolean
): Promise<{ ok: true; paused: boolean }> {
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!subscriptionId) throw new HttpsError('invalid-argument', 'subscriptionId is required')

  await assertManager(uid, teamId)
  const team = await loadEnabledTeam(teamId)
  const { accountId } = requireChargeableAccount(team)

  const stripe = await getConnectStripe()
  // pause_collection: { behavior: 'void' } freezes invoicing; '' clears it (resume).
  const pauseValue = pause ? { behavior: 'void' as const } : ''
  try {
    await stripe.subscriptions.update(
      subscriptionId,
      { pause_collection: pauseValue },
      { stripeAccount: accountId }
    )
  } catch (err) {
    console.error('[connect] setSubscriptionPause failed:', err)
    throw new HttpsError('internal', `Failed to ${pause ? 'pause' : 'resume'} the subscription`)
  }

  // Optimistic mirror → triggers the rollup recompute right away.
  await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .doc(subscriptionId)
    .set(
      { pause_collection: pause ? { behavior: 'void' } : null, updated_at: FieldValue.serverTimestamp() },
      { merge: true }
    )

  return { ok: true, paused: pause }
}

export const pauseMemberSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = request.data as { teamId?: string; subscriptionId?: string }
  return setSubscriptionPause(request.auth.uid, data?.teamId, data?.subscriptionId, true)
})

export const resumeMemberSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = request.data as { teamId?: string; subscriptionId?: string }
  return setSubscriptionPause(request.auth.uid, data?.teamId, data?.subscriptionId, false)
})

// Cancel a member's recurring subscription on the studio's connected account. Used when
// a manager reassigns a contact's plan and chooses to STOP their current billing (the
// manual-assign "stop current" path). Idempotent-ish: cancelling an already-cancelled
// sub throws, which we surface as 'internal'.
export const cancelMemberSubscription = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const { teamId, subscriptionId } = (request.data ?? {}) as {
    teamId?: string
    subscriptionId?: string
  }
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!subscriptionId) throw new HttpsError('invalid-argument', 'subscriptionId is required')

  await assertManager(request.auth.uid, teamId)
  const team = await loadEnabledTeam(teamId)
  const { accountId } = requireChargeableAccount(team)

  const stripe = await getConnectStripe()
  try {
    await stripe.subscriptions.cancel(subscriptionId, undefined, { stripeAccount: accountId })
  } catch (err) {
    console.error('[connect] cancelMemberSubscription failed:', err)
    throw new HttpsError('internal', 'Failed to cancel the subscription')
  }

  // Optimistic mirror → onMemberSubscriptionWrite recomputes the rollup + drops it from
  // active_subscriptions immediately (the webhook confirms shortly after).
  await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(MEMBER_SUBSCRIPTIONS_SUBCOLLECTION)
    .doc(subscriptionId)
    .set({ status: 'canceled', updated_at: FieldValue.serverTimestamp() }, { merge: true })

  return { ok: true, canceled: true }
})
