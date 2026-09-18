// Promo codes (Wave 3, Phase 3) — a code a visitor TYPES to change the price of
// a ONE-OFF purchase: a class drop-in, an appointment, a course, a product.
// Stored at teams/{teamId}/promo_codes/{CODE}, the canonical uppercase code IS
// the doc id.
//
// THE GOVERNING RULE, because everything here depends on it:
//   A price MODIFIER belongs in STAGE A, inside resolvePaymentOptions.
//   A TENDER belongs in STAGE B, at the checkout callable.
//   Nothing may be both.
// A promo is a MODIFIER: it changes the price. A gift card is a TENDER: it pays
// a price. So a promo never appears in a residual split, never reaches
// applyPaymentEffects, and never writes a finance journal row (no money event
// happened — the smaller charge IS the money event). See docs/promo-codes.md.
//
// A promo is NOT stored value. There is no balance, no depleted status, no
// reversal, no reclass pair. A reservation is a SLOT: taken, released, or
// consumed. That is why none of the gift-card balance mechanics
// (planGiftCardRedemption / applyGiftCardCommit / the depleted↔active
// resurrection) have an analogue here, and copying them would create money from
// nothing.
//
// WHAT LIVES IN THIS FILE: the type and its PURE helpers, the same split
// types/giftCard.ts uses (giftCardAvailable / planGiftCardRedemption /
// applyGiftCardCommit sit beside GiftCard; Firestore and crypto live in the
// functions package). Two derivations need a SHA-256 and therefore take one as
// an argument instead of importing node:crypto — this module ships to the
// browser through the shared barrel, and formatGiftCardCode already takes its
// random bytes for exactly that reason.
//
// NO tenantData.ts REGISTRATION. Both path constants are nested under teams/,
// and the completeness test classifies top-level *_COLLECTION constants only
// (tenantData.ts); per-team teardown uses db.recursiveDelete, which reaches
// subcollections already. Adding a constant there would be wrong, not merely
// redundant. Same finding as the waitlist subcollection in Phase 2.

import type { Timestamp } from './common'
import type { BenefitEffect } from './benefit'
import type { SaasPlan } from './team'
import { contactIdentityKey, type Sha256Hex } from '../utils/identity'
import { normalizeRedemptionCode } from '../utils/codes'

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * A promo reuses the price-modifying HALF of the Benefit effect vocabulary and
 * adds no effect of its own. 'included' and 'spend_credits' are COVERAGE
 * answers, not prices — a promo that made a purchase free would need a
 * payment-less confirm path on every rail and would bypass the 0.50 charge
 * floor. Deliberately no 'amount_off' in v1 (decided 2026-08-14): adding it
 * later is a BenefitEffect widening whose blast radius is normalizeBenefit,
 * `resolveBenefitCandidate`'s exhaustive switch over the effect, the
 * `priceAfterModifier` clamp site it calls, every effect allow-set, the benefit
 * editor and every fixture — real but bounded work.
 */
export type PromoEffect = Extract<BenefitEffect, 'percent_off' | 'fixed_price'>

/** A disabled code stops taking NEW reservations; live ones still complete, and
 *  its redemption ledger survives. Codes are never deleted — deleting one would
 *  orphan an in-flight checkout and destroy the audit record. */
export type PromoCodeStatus = 'active' | 'disabled'

/**
 * WHICH RAILS a code may be typed into. Deliberately coarse: these are the four
 * one-off checkouts, not entity ids — entity-level narrowing is the optional
 * *_ids allow-lists on PromoCode. A waitlist claim IS a drop-in and needs no
 * member of its own.
 *
 * Memberships are absent on purpose and that is a product decision, not an
 * omission: the recurring half would be a Stripe coupon rather than an amount
 * we compute, and shipping only the one-off half would make the shop's
 * Subscriptions tab accept a code on some rows and not others.
 */
export type PromoScopeKind = 'drop_in' | 'appointment' | 'course' | 'product'

/**
 * WHO a code is for.
 *  • 'all'          — anyone who can reach the rail (the default).
 *  • 'new_contacts' — people who have not joined yet.
 *
 * The axis exists because of a sharp, cheap-to-prevent failure: a studio with
 * 120 members prints "20% off, 50 uses", its members already hold a 10% member
 * benefit, best-one-wins hands every member the better 20%, the campaign is
 * spent in a week and acquires nobody — and the admin report says "50 of 50
 * used", which reads like a success. Decided BEFORE any code is live, because
 * retrofitting an audience axis changes the meaning of codes already printed on
 * customers' flyers.
 *
 * Absent ⇒ 'all'. See promoAudienceMatches for what "new" means and what it
 * does not.
 */
export type PromoAudience = 'all' | 'new_contacts'

// ─── The document ────────────────────────────────────────────────────────────

/**
 * A LIVE reservation — one person's claim on one use of one code, held while
 * they are in checkout. Keyed deterministically (promoReservationKey), so one
 * person holds at most ONE reservation per (code, target): a retry REFRESHES it
 * instead of taking a second slot, which is what stops a buyer's own
 * Back-button from refusing her with "you have already used this code" for a
 * purchase she never completed.
 *
 * There is deliberately NO committed-reservation map beside this one. Committed
 * history lives in the `redemptions` subcollection, one document per person, so
 * the promo document's size is bounded by PROMO_MAX_LIVE_RESERVATIONS forever.
 * A map of committed entries on a permanent, uncapped code would cross
 * Firestore's 1 MiB document limit, after which reserve, commit, release AND
 * disable all fail — the code becomes both unredeemable and unrepairable.
 */
export interface PromoReservation {
  /** The buying contact — AUTHORITATIVE for the commit, because the callable
   *  that minted this reservation knew exactly who was buying while the webhook
   *  may not (a provisional contact can be purged before the payment lands). */
  contactId: string
  /** promoIdentityKey(...) — what BOTH caps are counted against. */
  identityKey: string
  /**
   * WHICH ATTEMPT owns this entry. Random, minted fresh by every reserve —
   * including a refresh, which is how ownership MOVES to the newest attempt.
   *
   * The KEY is deterministic and must stay so (that is the whole "a retry is a
   * refresh, not a second use" mechanism). This is the other half of the same
   * design: the key says WHICH SLOT, the instance says WHOSE ATTEMPT is holding
   * it right now. Without it, "delete the entry at this key" is an operation
   * every sibling attempt of the same purchase can perform on every other —
   * so a stale checkout's expiry, or a later failed retry, would delete the
   * reservation guarding a session that is still payable, and the cap could
   * then be exceeded. Refusing to over-issue is the settled decision, so an
   * entry may be removed only by the instance that wrote it, by lazy expiry, or
   * by the manager lever.
   */
  instanceId: string
  /**
   * THE Checkout Session this slot currently backs, once one exists.
   *
   * The instance says WHOSE ATTEMPT holds the slot; this says WHICH SESSION can
   * take money against it, and they are not the same fact. A retry refreshes
   * the entry (same deterministic key) while minting a NEW Stripe session, and
   * Stripe will take money for any session that has not expired — so without
   * this field one slot sat behind several still-payable sessions at once, and
   * on the product and course rails each of those was a second GENUINE order
   * rather than a duplicate the webhook refunds.
   *
   * It is written in two steps because a Checkout Session does not exist yet at
   * reserve time: the reserve refuses unless the previously bound session can
   * be CLOSED at Stripe, then the callable attaches the id it just created
   * (`attachPromoCheckoutSession`, instance-guarded). So an entry with no
   * `sessionId` is either mid-flight — sub-second, and a concurrent attempt is
   * refused `promo_busy` on the compare-and-set — or a payment-less gift-card
   * full cover, which never mints a session at all.
   */
  sessionId?: string | null
  /** Bounded on BOTH sides against the Checkout Session this reservation
   *  guards: strictly after the session's own expiry, and past it by
   *  PROMO_RESERVATION_BACKSTOP_MINUTES plus at most a minute of rounding and
   *  the checkout work budget (resolveCheckoutHoldWindow,
   *  functions/connect/checkout.ts, which states both trailing terms and why
   *  they exist — this value is a DURATION applied at the reserve's own clock,
   *  so it drifts later than the instant the session got, always in the safe
   *  direction and never by more than CHECKOUT_WINDOW_WORK_BUDGET_SECONDS on a
   *  checkout that completes).
   *
   *  Reaching this deadline is the BACKSTOP, not the mechanism: a slot is
   *  normally freed by `checkout.session.expired` within seconds of its session
   *  becoming unpayable. */
  expires_at: Timestamp
  /** The quoted price at reservation time, major units. AUDIT ONLY — never read
   *  for a decision. The price the caller was shown is enforced at the callable
   *  by the `quotedAmount` guard, BEFORE anything is reserved. */
  amountMajor: number
  /** The list price the discount was taken from. Audit only, same rule. */
  baseAmount: number
  /** Reservation → purchase, so the admin list can say WHAT is in checkout. */
  targetKey: string
}

export interface PromoCode {
  /** The redeemable code, also the doc id (canonical uppercase). */
  code: string
  teamId: string
  status: PromoCodeStatus

  // ── The discount ──
  effect: PromoEffect
  /** percent_off only: integer 1–99. 100 is not expressible — a free purchase
   *  would need a payment-less confirm path on every rail. */
  percent?: number
  /** fixed_price only: "this thing costs X with this code", major units ≥ 0.50.
   *  Authored, so a value below the floor THROWS at creation rather than
   *  clamping (arithmetic-derived prices clamp; see utils/money.ts). */
  amount?: number
  /** Stamped at creation from the team's charge currency. Guarded at reserve
   *  time for fixed_price ONLY: a percentage has no currency, but a fixed price
   *  is an authored money amount read at one moment and applied at another, so
   *  a team that changes currency in between would otherwise get it applied
   *  1:1 across currencies — the same failure the gift card's tripwire stops. */
  currency?: string

  // ── The window (both ends INCLUSIVE — see promoWindowOpen) ──
  valid_from?: Timestamp | null // absent ⇒ open-ended in the past
  valid_until?: Timestamp | null // absent ⇒ never expires

  // ── The caps ──
  /** Global cap, counted against COMMITTED + LIVE RESERVATIONS. REQUIRED at
   *  creation: `null` means unlimited and must be chosen EXPLICITLY, because an
   *  uncapped code that leaks into a WhatsApp group is unbounded liability and
   *  this phase ships no notification that would surface it. */
  max_uses: number | null
  /** Per-IDENTITY cap, not per contact document. Absent ⇒
   *  PROMO_DEFAULT_MAX_USES_PER_CONTACT (a code is an offer to a person, not a
   *  standing discount). null ⇒ unlimited. */
  max_uses_per_contact?: number | null
  /** Bind the code to ONE person — the service-recovery shape ("sorry you got
   *  bumped, here's 20% off"), the most common manual discount a studio issues.
   *  When set, the reserve refuses any other caller and the preview reports a
   *  bare `invalid` — never "this code is not yours", which would confirm the
   *  code exists to whoever guessed it. */
  restrict_to_contact_id?: string | null
  /** Absent ⇒ 'all'. createPromoCode stamps it explicitly so a stored document
   *  is self-describing rather than relying on a reader knowing the default. */
  audience?: PromoAudience
  /** COMMITTED redemptions. Written by exactly ONE transaction
   *  (commitPromoRedemption), as an ABSOLUTE value computed from its own read
   *  set. NEVER FieldValue.increment — the same one-writer discipline
   *  `bookings_count` is under. A refund does not restore a use in v1, precisely
   *  because a restore path would be a second writer. */
  usage_count: number

  // ── What it applies to ──
  /** Non-empty. */
  applies_to: PromoScopeKind[]
  /** null / absent / empty ⇒ every entity of the listed kinds. Non-empty ⇒ only
   *  these. `activity_ids` covers both class drop-ins and appointments (both are
   *  activities). */
  activity_ids?: string[] | null
  course_ids?: string[] | null
  product_ids?: string[] | null

  // ── Redemption lifecycle state ──
  /** LIVE reservations only, keyed by promoReservationKey. Bounded by
   *  PROMO_MAX_LIVE_RESERVATIONS in the reserve transaction. Expiry is LAZY:
   *  promoLiveReservations drops stale entries inside any transaction that
   *  already holds the document, exactly as gift-card holds work. There is no
   *  sweep job, and nothing may re-derive liveness. */
  reservations?: Record<string, PromoReservation>

  // ── Audit ──
  label?: string | null // internal note ("autumn flyer")
  created_at?: Timestamp
  updated_at?: Timestamp
  created_by?: string | null // uid
  created_by_name?: string | null // snapshot, survives a rename
  disabled_at?: Timestamp | null
}

/**
 * One durable row per PERSON, at
 * teams/{t}/promo_codes/{CODE}/redemptions/{identityKey}.
 *
 * This subcollection is the per-person cap's ONLY source of truth; the promo
 * document holds no committed history at all.
 */
export interface PromoRedemption {
  teamId: string
  code: string
  identityKey: string
  /** The most recent contact document this identity resolved to — for the admin
   *  list and for clearPromoRedemption. NEVER the cap's key. */
  contactId: string
  /** Committed redemptions by this identity. Absolute write, one writer. */
  count: number
  first_at: Timestamp
  last_at: Timestamp
  /** Denormalised for the admin list; never read for a decision. */
  last_amount_major?: number
  last_target?: PromoScopeKind
}

// ─── The resolver's input ────────────────────────────────────────────────────

/**
 * A promo that has ALREADY passed every impure gate — it exists, is active, is
 * inside its window, is in scope for THIS target, matches this caller's
 * audience, is not bound to somebody else, and (fixed_price) matches the charge
 * currency. The resolver decides exactly ONE thing about it: whether it beats
 * the member benefit and the list price.
 *
 * Declared here rather than in utils/paymentOptions.ts for the same reason
 * `Benefit` is declared in types/benefit.ts — it is the promo's own vocabulary,
 * and the resolver imports it. Do not redeclare it there.
 */
export interface PromoModifier {
  /** Canonical uppercase — carried into the display and the reservation key. */
  code: string
  effect: PromoEffect
  percent?: number
  amount?: number
}

/**
 * What a promo is being asked about. Carries the ENTITY ids the allow-lists
 * narrow on, which is why the scope check lives in the impure loader and not in
 * the resolver: PaymentTarget carries no entity ids, and widening every target
 * to carry them would touch every construction site in the repo.
 */
export interface PromoTargetScope {
  kind: PromoScopeKind
  /** Class drop-ins and appointments — both are activities. */
  activityId?: string | null
  courseId?: string | null
  productId?: string | null
  /** True for the paid-trial door. A trial NEVER takes a promo: it is already
   *  an acquisition price, enforced once per person via trial_used_at, and
   *  stacking a code on it double-discounts the cheapest thing in the product.
   *  One predicate, one place — reversing this decision is a one-line change
   *  here plus fixtures. */
  isTrial?: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Hard ceiling on LIVE reservations for ONE code, independent of max_uses.
 *
 * It does TWO jobs, and only one of them is unconditional.
 *
 * 1. IT BOUNDS THE DOCUMENT'S SIZE, ALWAYS. 25 entries is ~5 KB, two orders of
 *    magnitude under Firestore's 1 MiB limit, for any campaign, forever. This
 *    half holds no matter how the code is configured.
 *
 * 2. It makes holding a capped campaign exhausted cost something. THE PRICE OF
 *    THAT IS NOT ONE EMAIL PER RESERVATION, and an earlier version of this
 *    comment said it was. The real bound is a distinct (identity, target) PAIR
 *    per concurrent reservation, throttled by `max_uses_per_contact`:
 *
 *      • at the default of 1, a second live reservation by the same identity
 *        drives `promoUsesLeft().perIdentity` to 0 and is refused whatever the
 *        target — so there, and only there, one email really does buy one slot;
 *      • at any finite N, one email can hold up to N;
 *      • at `null` — "unlimited per person", which the admin form offers as a
 *        checkbox — `perIdentity` is Infinity, so ONE email can hold up to this
 *        ceiling by starting checkouts on 25 different sessions/products, and
 *        each of those consumes global headroom for its window.
 *
 * The value stays 25 anyway, deliberately. Lowering it would refuse genuine
 * concurrent buyers on a popular code (the campaign is *over*, says nothing;
 * `promo_busy` says wait, but a studio should not need to hear it at ten
 * simultaneous buyers), and raising it makes the residual worse. What actually
 * binds the abuse case is elsewhere and is not weakened by an unlimited
 * per-person cap: a reservation is only ever taken INSIDE a checkout callable
 * (the preview reserves nothing), each one costs a Stripe Checkout Session, the
 * public rate limit is 30/hour/IP, and every window is short. So the residual is
 * a transient denial that self-heals on expiry, never an over-issue — which is
 * the direction the whole design refuses to trade away.
 *
 * If that ever needs closing, the fix is a per-identity live ceiling, not a
 * smaller number here: `promoUsesLeft` already counts `liveForIdentity`.
 *
 * Hitting it is reported as `promo_busy`, which is a DIFFERENT sentence from
 * `promo_exhausted` on purpose: "try again in a few minutes" and "the campaign
 * is over" are not the same news.
 */
export const PROMO_MAX_LIVE_RESERVATIONS = 25

/** Absent max_uses_per_contact ⇒ this. A code is an offer to a person, not a
 *  standing discount, so the safe default is once. */
export const PROMO_DEFAULT_MAX_USES_PER_CONTACT = 1

/**
 * How many entity ids ONE allow-list may name. Shared so the create form and
 * `resolveScope` refuse the same payload: the server truncates silently past
 * this, and a form that did not know the number would let a manager tick items
 * that are quietly dropped on save.
 */
export const PROMO_MAX_SCOPE_IDS = 100

/**
 * Code format AFTER normalisation: 3–24 chars, uppercase alphanumerics and
 * hyphens, no leading hyphen. Enforced at creation (authored → throw) and used
 * by the admin form so client and server refuse the same strings.
 */
export const PROMO_CODE_FORMAT_RE = /^[A-Z0-9][A-Z0-9-]{2,23}$/

/** True iff `raw` is a well-formed promo code once normalised. */
export function isValidPromoCodeFormat(raw: string): boolean {
  return PROMO_CODE_FORMAT_RE.test(normalizeRedemptionCode(raw))
}

/**
 * A visitor pasting a gift card into the promo field is a real event, and
 * "invalid code" is the wrong answer to it. Refused at creation too, so a
 * studio can never mint a promo that shadows the gift-card namespace.
 */
export function looksLikeGiftCardCode(raw: string): boolean {
  return normalizeRedemptionCode(raw).startsWith('GC-')
}

/**
 * Per-plan cap on ACTIVE codes, in the shape of PRODUCT_LIMITS. Zero on
 * free/coach is the same statement as the requirePlan(teamId, 'studio') gate on
 * creation, expressed as data so the admin page can render "4 of 20" without a
 * second rule. Free inherits Coach, which is why Coach is zero: a hobbyist at
 * the free contact cap running discount campaigns is not a real persona.
 *
 * The gate is on CREATION ONLY. A team downgraded to free keeps its live codes
 * previewable, reservable, committable and releasable.
 */
export const PROMO_CODE_LIMITS: Record<SaasPlan, { maxActiveCodes: number }> = {
  free: { maxActiveCodes: 0 },
  coach: { maxActiveCodes: 0 },
  studio: { maxActiveCodes: 20 },
  organization: { maxActiveCodes: 100 },
}

export function getPromoCodeLimits(plan: SaasPlan | null): { maxActiveCodes: number } {
  return PROMO_CODE_LIMITS[plan ?? 'free']
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Both ends INCLUSIVE: a code valid_until 23:59:59.999 is redeemable AT that
 *  instant. Absent ends are open. */
export function promoWindowOpen(
  p: Pick<PromoCode, 'valid_from' | 'valid_until'>,
  nowMs: number
): boolean {
  const from = p.valid_from?.toMillis()
  if (typeof from === 'number' && nowMs < from) return false
  const until = p.valid_until?.toMillis()
  if (typeof until === 'number' && nowMs > until) return false
  return true
}

/**
 * THE liveness predicate for reservations — expired entries are simply absent
 * from the result. Returns a MAP, not a list, because every caller needs the
 * keys: the reserve transaction writes the result back with one entry added
 * (dropping the stale ones as a side effect of the write it was making anyway),
 * and the commit writes it back with one entry removed. This is exactly
 * dropExpiredHolds' idiom on the gift-card side.
 *
 * Nothing may re-derive liveness. There is no sweep job for promo reservations,
 * by design: lazy expiry inside a transaction that already holds the document
 * costs nothing and cannot drift from this predicate.
 */
export function promoLiveReservations(
  p: Pick<PromoCode, 'reservations'>,
  nowMs: number
): Record<string, PromoReservation> {
  const out: Record<string, PromoReservation> = {}
  for (const [key, r] of Object.entries(p.reservations ?? {})) {
    // An entry we cannot DATE is treated as expired — the opposite of the
    // gift card's committed-hold marker, and deliberately so. That marker is a
    // double-spend stop, where guessing wrong spends money twice; this is a
    // slot, where guessing wrong strands one use of a campaign FOREVER (nothing
    // but its own expiry ever removes it, and the key needed to release it died
    // with the callable that minted it). Over-issuing by one self-heals; a
    // permanently-consumed use does not.
    const expiresAtMs = typeof r?.expires_at?.toMillis === 'function' ? r.expires_at.toMillis() : 0
    if (expiresAtMs > nowMs) out[key] = r
  }
  return out
}

/** Both cap headrooms plus the live-reservation count, from one read set. */
export interface PromoUsesLeft {
  /** max_uses − committed − live reservations. Infinity ⇒ uncapped. */
  global: number
  /** max_uses_per_contact − this identity's committed − this identity's live
   *  reservations. Infinity ⇒ uncapped. */
  perIdentity: number
  /** Live reservations counted, for the PROMO_MAX_LIVE_RESERVATIONS ceiling. */
  liveTotal: number
}

/**
 * THE cap predicate — the WHOLE boundary, both halves, ONE expression.
 *
 * The reserve transaction, the preview callable and the admin list all call
 * this against the same fields, so "the last use is reserved but not yet paid"
 * is answered once rather than three times. Splitting it (a global-only helper
 * plus an inlined per-person test) is the defect wearing the fix's clothes:
 * two answers to one question, which is how the boundary drifts.
 *
 * A LIVE RESERVATION CONSUMES A USE. That is a business decision — never
 * over-issue — and it is why the refusal side is bounded so hard: the
 * reservation key is deterministic, so N abandonments of ONE purchase are one
 * slot rather than N (taking N slots needs N distinct (identity, target) pairs —
 * which at the DEFAULT max_uses_per_contact of 1 means N distinct email
 * identities, and at `null` does not; see PROMO_MAX_LIVE_RESERVATIONS),
 * PROMO_MAX_LIVE_RESERVATIONS caps concurrency, the checkout window is short on
 * every rail, the admin list shows reserved separately from used, and a manager
 * can release a code's reservations. Flipping the direction is one line: drop
 * `liveTotal` from `global`.
 *
 * `excludeReservationKey` is the caller's OWN reservation for the target they
 * are buying. Excluding it is what makes a retry a REFRESH rather than a second
 * use — without it, a buyer's own live-but-unpaid reservation refuses her
 * permission to pay for the thing she is already holding, which is the shape
 * `countHoldingSeats(docs, now, contactId)` already solves for seats forty
 * lines from where the promo reserve sits.
 */
export function promoUsesLeft(
  p: Pick<PromoCode, 'max_uses' | 'max_uses_per_contact' | 'usage_count' | 'reservations'>,
  nowMs: number,
  identityKey: string,
  perIdentityCommitted: number,
  excludeReservationKey?: string | null
): PromoUsesLeft {
  const live = promoLiveReservations(p, nowMs)
  let liveTotal = 0
  let liveForIdentity = 0
  for (const [key, r] of Object.entries(live)) {
    if (excludeReservationKey && key === excludeReservationKey) continue
    liveTotal += 1
    if (r.identityKey === identityKey) liveForIdentity += 1
  }

  const globalCap = p.max_uses ?? Infinity
  const global =
    globalCap === Infinity ? Infinity : globalCap - (p.usage_count ?? 0) - liveTotal

  // undefined (field absent) ⇒ the default of 1; explicit null ⇒ unlimited.
  const perCap =
    p.max_uses_per_contact === undefined
      ? PROMO_DEFAULT_MAX_USES_PER_CONTACT
      : (p.max_uses_per_contact ?? Infinity)
  const perIdentity =
    perCap === Infinity ? Infinity : perCap - perIdentityCommitted - liveForIdentity

  return { global, perIdentity, liveTotal }
}

/**
 * Does this code apply to THIS target? The scope half of applicability —
 * rail kind, entity allow-lists, and the trial door. Caller identity is a
 * separate question (promoAudienceMatches, restrict_to_contact_id) and the
 * window/status/currency halves belong to the loader.
 *
 * A code that does not apply is REPORTED, never silently charged, and never
 * blocks the purchase: the checkout completes at list price and the surface
 * says so.
 */
export function promoAppliesTo(
  p: Pick<PromoCode, 'applies_to' | 'activity_ids' | 'course_ids' | 'product_ids'>,
  scope: PromoTargetScope
): boolean {
  // The paid-trial door, on every rail that has one. Structural, not a check to
  // remember: the resolver's trial branch never prices via a benefit either.
  if (scope.isTrial === true) return false
  if (!(p.applies_to ?? []).includes(scope.kind)) return false

  switch (scope.kind) {
    case 'drop_in':
    case 'appointment':
      return allowed(p.activity_ids, scope.activityId)
    case 'course':
      return allowed(p.course_ids, scope.courseId)
    case 'product':
      return allowed(p.product_ids, scope.productId)
  }
}

/** An allow-list that is null / absent / empty permits everything. A non-empty
 *  one permits only its members — and refuses a target that cannot name itself,
 *  because "unknown" is not "in scope". */
function allowed(list: string[] | null | undefined, id: string | null | undefined): boolean {
  if (!list || list.length === 0) return true
  return typeof id === 'string' && id.length > 0 && list.includes(id)
}

/**
 * Is this CALLER inside the code's audience?
 *
 * "New" means NOT YET JOINED — the caller's `joined` flag, which is exactly
 * `Contact.acquisition_stage === 'joined'` and is already the fact the resolver
 * and the `members` access rule run on (ContactPaymentSnapshot.joined,
 * booking/access.ts). Reusing it is the point: an audience axis with its own
 * private definition of "member" would immediately disagree with the one the
 * booking gate uses.
 *
 * What this DOES buy: an anonymous guest, a lead captured by a form, a shop
 * buyer with no funnel stage, and someone mid-trial all count as new — which is
 * the population a "new customers only" campaign is aimed at.
 *
 * What it does NOT buy: a long-standing member whose stage was never advanced
 * past 'trial_attended' reads as new. The funnel field is the agreed proxy
 * (chosen over a prior-bookings query for cost); a studio whose data is that
 * stale has a contact-data problem, not a promo problem.
 */
export function promoAudienceMatches(
  p: Pick<PromoCode, 'audience'>,
  caller: { joined: boolean }
): boolean {
  if ((p.audience ?? 'all') === 'all') return true
  return !caller.joined
}

/** Why a code that exists, is live and is in scope is still not this caller's. */
export type PromoCallerRefusal = 'restricted_to_other_contact' | 'audience_mismatch'

/**
 * Is this code FOR THIS CALLER? Both identity gates in ONE expression, for the
 * same reason promoUsesLeft is one expression: the loader, the reserve
 * transaction and the preview must not each decide half of "who may use this".
 *
 * ORDER IS LOAD-BEARING. The binding is checked FIRST, and a code bound to
 * somebody else is reported all the way out as a bare `invalid` —
 * indistinguishable from a code that does not exist, because "this code is not
 * yours" confirms the code IS real to whoever guessed it. An audience mismatch
 * is the opposite: it names itself, because a flyer code is public and "this
 * one is for new customers" is useful, honest and gives nothing away.
 *
 * A caller with no contact id (an anonymous preview) fails a binding: a bound
 * code names one specific person, and an unnamed caller is not that person.
 */
export function promoAllowsCaller(
  p: Pick<PromoCode, 'restrict_to_contact_id' | 'audience'>,
  caller: { contactId?: string | null; joined: boolean }
): { ok: true } | { ok: false; reason: PromoCallerRefusal } {
  const boundTo = p.restrict_to_contact_id
  if (boundTo && boundTo !== caller.contactId) {
    return { ok: false, reason: 'restricted_to_other_contact' }
  }
  if (!promoAudienceMatches(p, caller)) return { ok: false, reason: 'audience_mismatch' }
  return { ok: true }
}

/** The already-qualified modifier the resolver receives. Nothing here decides
 *  applicability — that is settled before this is built. */
export function promoModifier(
  p: Pick<PromoCode, 'code' | 'effect' | 'percent' | 'amount'>
): PromoModifier {
  return {
    code: normalizeRedemptionCode(p.code),
    effect: p.effect,
    ...(typeof p.percent === 'number' ? { percent: p.percent } : {}),
    ...(typeof p.amount === 'number' ? { amount: p.amount } : {}),
  }
}

// ─── Derived keys ────────────────────────────────────────────────────────────

/**
 * A hex SHA-256 of a UTF-8 string. INJECTED rather than imported so this module
 * stays crypto-free and browser-safe — the same split formatGiftCardCode uses
 * for its random bytes. The functions package supplies `sha256Hex`
 * (utils/crypto.ts); there must be exactly one implementation.
 *
 * DECLARED in utils/identity.ts and re-exported here so the many existing
 * `import { Sha256Hex } from '@linyup/shared'` call sites keep resolving to the
 * one binding.
 */
export type { Sha256Hex }

/**
 * The strongest identity a one-off purchase rail actually has — the normalised
 * EMAIL, hashed. See `contactIdentityKey` (utils/identity.ts) for the full
 * reasoning and for what it does NOT promise.
 *
 * THIS IS A NAMED ALIAS, NOT A SECOND DERIVATION. Waivers needed the same
 * identity, and two hashers that disagree by so much as an encoding would mean
 * a promo cap and a consent export disagreed about who a person is. The name
 * stays because `promoIdentityKey` is what the promo docs, the ledger doc ids
 * and `docs/promo-codes.md` call it; the bytes are the shared helper's.
 * `identityKeysAgree` in packages/functions/src/waivers/ledger.test.ts pins
 * that they are byte-identical.
 */
export function promoIdentityKey(
  input: { email?: string | null; contactId: string },
  sha256Hex: Sha256Hex
): string {
  return contactIdentityKey(input, sha256Hex)
}

/**
 * DETERMINISTIC — the same person, the same code, the same target always
 * produces the same key. That is the whole mechanism behind "a retry is a
 * refresh, not a second use": the second attempt at one purchase finds its own
 * reservation and rewrites it instead of taking a second slot from either cap.
 *
 * Caller-minted, before any Stripe session exists — it has to be, because the
 * reservation must succeed or fail before a session is worth creating. (The
 * gift card's hold key has the same ordering constraint; the stale comments
 * that claimed otherwise were corrected in the same change that introduced
 * this.)
 *
 * `targetKey` is the per-rail purchase identity — stable across retries,
 * distinct across purchases. Its derivation is owned by the functions-side
 * promo module and must exist exactly once: the preview and the checkout have
 * to produce the same string or the refresh silently becomes a second use.
 */
export function promoReservationKey(
  input: { code: string; identityKey: string; targetKey: string },
  sha256Hex: Sha256Hex
): string {
  // Length-prefixed, not merely delimiter-joined. A bare `a|b|c` preimage is
  // ambiguous: ('AB', 'x|y', 't') and ('AB', 'x', 'y|t') hash identically, which
  // would merge two DIFFERENT purchases onto one reservation. It is reachable —
  // `targetKey` embeds a product's `variantId`, which is client-generated. This
  // encoding is injective, so a collision needs a SHA-256 collision.
  const parts = [normalizeRedemptionCode(input.code), input.identityKey, input.targetKey]
  return sha256Hex(parts.map((p) => `${p.length}:${p}`).join('|')).slice(0, 32)
}
