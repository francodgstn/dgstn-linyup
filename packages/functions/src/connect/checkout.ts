/* eslint-disable no-console */
// The ONE money core for Connect checkout callables. Every member→studio
// checkout (membership, product, course, drop-in, appointment, manager one-off)
// funnels its amount guarding, currency resolution, fee computation, result
// URLs, idempotency default and Stripe-error mapping through here — the five
// callables keep only their own business validation and metadata.
//
// The webhook contract is untouched by construction: metadata is built at each
// call site and passed through verbatim.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  MIN_CHARGE_MINOR,
  computePlatformFee,
  isChargeableMinorAmount,
  resolveStripeCurrency,
  takeRatePercent,
  toMinorUnits,
} from '@linyup/shared'
import {
  closeCheckoutSession,
  createOneOffCheckoutSession,
  createSubscriptionCheckoutSession,
  ensureIntroCoupon,
  type CheckoutSessionCloseOutcome,
  type IntroCouponSpec,
} from '../utils/connect/client'
import { activeCustomDomainHost } from '../domains/activeDomain'
import { resolveBaseUrl } from '../utils/env'
import { sha256Hex } from '../utils/crypto'
import { requireChargeableAccount, type EnabledTeam } from './access'

// ─── Amount guards — ONE floor, ONE error shape ─────────────────────────────────
// Authored prices below Stripe's 0.50 floor are a configuration error → throw.
// (Arithmetic-derived prices clamp instead — see shared/utils/money.ts.)

function belowMinimumError(): HttpsError {
  return new HttpsError('failed-precondition', 'Amount is below the minimum charge of 0.50', {
    reason: 'below_minimum',
    min: MIN_CHARGE_MINOR,
  })
}

/** MAJOR-units price from stored config (e.g. 49.9) → integer Rappen, or throws. */
export function requireChargeableAmountFromMajor(major: unknown): number {
  if (typeof major !== 'number' || !Number.isFinite(major)) {
    throw new HttpsError('failed-precondition', 'A price is required', { reason: 'not_priced' })
  }
  const amount = toMinorUnits(major)
  if (!isChargeableMinorAmount(amount)) throw belowMinimumError()
  return amount
}

/**
 * THE price the caller was SHOWN, checked against the price the server just
 * resolved. Absent → proceed (an older client, or a surface with no price
 * display). HIGHER than shown → refuse, carrying the current figure so the
 * surface can render it and let the visitor accept it.
 *
 * The rule it enforces is short — A PROMO-CARRYING CHECKOUT NEVER CHARGES MORE
 * THAN THE CALLER WAS SHOWN — and it is the only thing a checkout refuses over
 * that is not an eligibility question.
 *
 * ── WHY IT IS SCOPED TO PROMO-CARRYING CHECKOUTS ───────────────────────────
 * `scope.promoAttempted` is REQUIRED, so no call site can be silently in or out
 * of scope, and the answer is "a code was typed", not "a code won": the case the
 * guard exists for is precisely the one where the client thought the code
 * applied and the server says it did not.
 *
 * Off the promo path there is nothing to guard, because THE CLIENT'S NUMBER IS
 * NOT A QUOTE. Public surfaces price from an OPTIMISTIC snapshot documented as
 * partial (`clientPaymentSnapshot`, and the same note in BookingForm / ShopHome):
 * the contact session carries only the PRIMARY `subscription_type_id`, every held
 * id is reported unmetered, `joined` is assumed, and the catalogue is fetched
 * once with no listener. The server loads the real thing. The two are two
 * implementations of one resolver and are ALLOWED to disagree — a subscription
 * that lapsed between page load and pay is a legitimate divergence, not an
 * attack. Enforcing the quote universally turned those divergences into refused
 * SALES, and DETERMINISTICALLY, not transiently:
 *
 *   • a member whose primary type is a credit pack with 0 remaining, listed in
 *     the activity's `memberBenefit` — the client counts it as held (benefit
 *     applies, 32.00), the server sees `remaining: 0` so the benefit does not
 *     apply (40.00). Refused, and refused identically on every retry;
 *   • a studio that raises a product/course price while a shop tab is open —
 *     the tab re-quotes the old figure forever (`getDocs`, no listener).
 *
 * Neither buyer can reach the real price by trying again, and neither was ever
 * promised the lower one by anything but an optimistic render. With a CODE the
 * surface made a specific promise — "Code SUMMER25 applied", a struck-through
 * base, a discount row — and a server that then charges list price breaks it. So
 * that is where the guard lives, and the refusal there is informative (the code
 * expired, was superseded, stopped applying) rather than a dead end.
 *
 * ── WHY IT IS ONE-SIDED, AND NOT `!==` ─────────────────────────────────────
 * A member whose benefit comes from a SECONDARY held type is quoted BASE by the
 * client and the DISCOUNTED price by the server — routinely, with nothing wrong
 * anywhere. Under `!==` that member is refused `price_changed` and the studio
 * loses the sale for being cheaper than advertised. Being charged MORE than the
 * screen said is the harm; being charged LESS needs no consent.
 *
 * ── THE REFUSAL IS RECOVERABLE, AND THAT IS PART OF THE CONTRACT ───────────
 * `details.amount` is the server's own figure. Every mount renders it and offers
 * the visitor the purchase at that price; confirming re-sends it as
 * `quotedAmount`, which then agrees and the sale completes (see
 * `priceChangedAmount` in `components/booking/PromoCodeField.tsx`). A refusal a
 * buyer cannot act on is a lost sale, not a safety feature — and the client
 * cannot re-render its way out of one, because it would re-derive the same
 * optimistic number.
 *
 * ── AND IT SAYS WHAT ACTUALLY HAPPENED ─────────────────────────────────────
 * `details.promoRefusal` carries the LOADER's verdict on the typed code when
 * there is one, and it is the reason this guard fires at all in the commonest
 * case: the code did not apply, so the server priced at list, so the client's
 * discounted quote is lower. Without it the visitor was told "the price changed
 * while you were checking out" — a sentence about the studio's pricing — when
 * the truth was "this code is for new customers only", which is a sentence about
 * them and one they can act on. That gap is reachable without anything being
 * wrong anywhere: `previewPromoCode` is never sent the guest form's email — it
 * resolves the caller from a contact session or the Firebase auth token alone —
 * so for a signed-out visitor it answers as an anonymous caller and accepts a
 * `new_contacts` code. The checkout then resolves that same code against the
 * email actually typed, which may belong to a member, and refuses it.
 *
 * `reason` deliberately STAYS `price_changed`. It is still true — the charge is
 * higher than the quote — and it is the token every mount's recovery branch
 * keys on, so the promo cause is additive: a mount that ignores it recovers
 * exactly as before, and one that reads it replaces the sentence, never the
 * mechanism. The vocabulary is `PromoLoadRefusal` (connect/promoCodes.ts); it is
 * typed as a bare string here only so this module keeps no promo import.
 *
 * Compared in MAJOR units and to the cent, because that is the unit the surface
 * rendered; the minor-unit conversion happens after.
 */
export function assertQuotedAmount(
  quoted: unknown,
  resolvedMajor: number,
  scope: { promoAttempted: boolean; promoRefusal?: string | null }
): void {
  if (!scope.promoAttempted) return
  if (typeof quoted !== 'number' || !Number.isFinite(quoted)) return
  if (Math.round(resolvedMajor * 100) <= Math.round(quoted * 100)) return
  throw new HttpsError('failed-precondition', 'The price changed while you were checking out', {
    reason: 'price_changed',
    amount: resolvedMajor,
    ...(scope.promoRefusal ? { promoRefusal: scope.promoRefusal } : {}),
  })
}

/** Already-minor amount (manager-entered Rappen) → validated, or throws. */
export function requireChargeableMinorAmount(amount: unknown): number {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    throw new HttpsError('failed-precondition', 'amount must be an integer in Rappen', {
      reason: 'not_integer',
    })
  }
  if (!isChargeableMinorAmount(amount)) throw belowMinimumError()
  return amount
}

// ─── Result URLs + idempotency ──────────────────────────────────────────────────

/**
 * Stripe's own template variable, substituted into `success_url` when it
 * redirects. It is what lets `/pay/result` name the buyer without asking them
 * to sign in again (UX-88) — the page hands it to `claimCheckoutSession`, which
 * verifies the session on the studio's connected account and mints a contact
 * session through `buildContactSession`.
 *
 * SUCCESS ONLY, deliberately. A cancelled checkout identifies nobody and took no
 * money, so there is nothing to claim and no reason to put an id in that URL.
 */
const CHECKOUT_SESSION_ID_PARAM = '&cs={CHECKOUT_SESSION_ID}'

/**
 * Default `pay/result` URLs (success/cancel), honouring caller overrides.
 *
 * ASYNC because of `teamId`: the return origin is validated against THAT
 * tenant's verified custom domain, which is a Firestore read. Resolving it here
 * rather than at each of the callers keeps one site making that security
 * decision — ten of them making it independently is how one quietly stops.
 */
export async function buildResultUrls(
  locale: string,
  opts?: {
    successUrl?: string
    cancelUrl?: string
    /** Appended to the default result URLs so the page can link back (e.g. &slug=…&seg=shop). */
    extraQuery?: string
    /** Caller's origin — prefers localhost in dev, falls back to the hosting URL. */
    origin?: string
    /**
     * The tenant this checkout belongs to. Supplying it lets a visitor who paid
     * on the studio's own domain come back to it; omitting it is safe and simply
     * returns them to the canonical app host.
     */
    teamId?: string
  }
): Promise<{ successUrl: string; cancelUrl: string }> {
  // Only worth a read when the caller actually came from somewhere else — an
  // origin we already trust, or none at all, cannot be improved on.
  const tenantHost =
    opts?.teamId && opts?.origin ? await activeCustomDomainHost(opts.teamId) : null
  const base = `${resolveBaseUrl(opts?.origin, tenantHost)}/${locale}/pay/result`
  const extra = opts?.extraQuery ?? ''
  return {
    successUrl: opts?.successUrl ?? `${base}?status=success${extra}${CHECKOUT_SESSION_ID_PARAM}`,
    cancelUrl: opts?.cancelUrl ?? `${base}?status=cancelled${extra}`,
  }
}

/**
 * `${prefix}:${parts…}:${minuteBucket}` — the shared idempotency default. The
 * per-callable prefixes and part orders are load-bearing for Stripe retry dedup
 * across a deploy window — snapshot-tested, never reorder.
 */
export function defaultIdempotencyKey(prefix: string, ...parts: string[]): string {
  return `${prefix}:${parts.join(':')}:${Math.floor(Date.now() / 60_000)}`
}

/** Stripe rejects a Checkout Session whose `expires_at` is less than 30 minutes
 *  away. The floor is measured against the moment the CREATE call lands on
 *  Stripe — never against the moment we decided the instant, which is what makes
 *  the gap between the two a budget (CHECKOUT_WINDOW_WORK_BUDGET_SECONDS). */
export const STRIPE_MIN_CHECKOUT_EXPIRY_MINUTES = 30

/** Stripe's Checkout Session `expires_at` minimum is 30 minutes from creation;
 *  31 (not 30) leaves one minute of headroom. Shared by every checkout that
 *  needs a SHORT, prompt-release expiry instead of Stripe's default (24h):
 *  paid appointments (the hold IS the session) and any one-off checkout
 *  carrying a gift-card hold (product/course/drop-in redemption) — see
 *  connect/giftCards.ts.
 *
 *  The 31 is ALSO pinned from the other side on the drop-in rail: it is one
 *  minute past the 30-minute booking hold, so the payment window closes just
 *  after the seat is released, and `31 + PROMO_RESERVATION_MARGIN_MINUTES === 35`
 *  reproduces the former DEFAULT_HOLD_MINUTES exactly. Both relations are
 *  fixtures. Raising this number to buy headroom would widen the oversell window
 *  it exists to close — which is why the headroom is instead named, bounded and
 *  enforced below rather than enlarged. */
export const SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES = 31

/**
 * THE WORK BUDGET — the headroom above, named because it is SPENT and can run
 * out, and because at 4b3177f nothing spent it.
 *
 * Every rail that reserves something fixes its expiry instant BEFORE it reserves.
 * It has to: each reservation's own window is derived from that instant, and
 * deriving the two separately is B3 (a reservation dying under a live session).
 * So everything between choosing the instant and calling Stripe spends the gap
 * between the instant we chose and Stripe's floor — and on a SHORT window that
 * gap is exactly one minute.
 *
 * What now runs inside that minute, on the drop-in rail: `reservePromoRedemption`
 * (a Firestore transaction plus up to two Stripe calls, because superseding a
 * slot closes the Checkout Session it was already backing), `reserveGiftCardDrawdown`
 * (a second transaction), and the booking-hold transaction. Before promos it was
 * a `Date.now()` and two awaits.
 *
 * Derived from the two ends rather than typed, so it cannot drift out of step
 * with either; checked at the ONE choke point every rail funnels through
 * (`startOneOffCheckout`); pinned by fixtures in checkoutWindow.test.ts.
 */
export const CHECKOUT_WINDOW_WORK_BUDGET_SECONDS =
  (SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES - STRIPE_MIN_CHECKOUT_EXPIRY_MINUTES) * 60

/** The other end of the same Stripe constraint: `expires_at` may be at most 24
 *  hours after creation. Callers that derive an expiry from something else —
 *  a waitlist claim window, which a studio may configure well past a day — must
 *  clamp to this or Stripe rejects the session outright. */
export const STRIPE_MAX_CHECKOUT_EXPIRY_MINUTES = 24 * 60

// ─── The reservation timer rule (ONE instant, two consumers) ────────────────────

/**
 * How long a reservation guarding a Checkout Session outlives that session.
 *
 * The generalisation of the old 35-vs-31 constant pair: a gift-card hold used to
 * be a flat 35 minutes because every session it guarded happened to be ~31. Four
 * minutes of slack absorbs clock skew and the gap between "Stripe stopped
 * accepting payment" and "we noticed", and nothing more — a longer margin holds
 * a scarce thing hostage after the sale can no longer happen.
 */
export const PROMO_RESERVATION_MARGIN_MINUTES = 4

/**
 * The PROMO reservation's backstop, and why it is an hour rather than four
 * minutes.
 *
 * Lazy expiry used to be the mechanism that freed a promo slot, and at +4 it
 * fires essentially the moment the Checkout Session dies. That is one minute of
 * Stripe delivery slack — and Stripe's delivery horizon is HOURS, because it
 * retries. So a session PAID at expiry−1s whose `checkout.session.completed`
 * arrives late found its slot already lapsed, re-handed to another buyer, and
 * counted a second time.
 *
 * The slot is now freed by POSITIVE EVIDENCE: `checkout.session.expired`, which
 * Stripe emits (and retries) the moment a session can no longer be paid, and
 * which `handleCheckoutExpired` turns into a release within seconds. Lazy expiry
 * is what remains when that event is lost, so it is set to a horizon that
 * swallows ordinary webhook lateness instead of racing it.
 *
 * The cost is stated rather than hidden: a slot whose expiry event never arrives
 * is held for about 91 minutes instead of 35 before it self-heals. The manager's
 * `releasePromoReservations` lever is the immediate answer, and holding a slot
 * too long is the Q9-required direction — refuse, never over-issue.
 *
 * A GIFT-CARD hold keeps the 4-minute margin: it is guarded by a committed-hold
 * marker rather than by a lapse, and 31 + 4 === 35 === DEFAULT_HOLD_MINUTES is
 * pinned behaviour.
 */
export const PROMO_RESERVATION_BACKSTOP_MINUTES = 60

export interface CheckoutHoldWindow {
  /** Stripe's `expires_at`, in epoch SECONDS. Undefined ⇒ pass nothing and let
   *  Stripe apply its documented 24-hour default, which is correct ONLY when
   *  nothing finite is reserved against the session. */
  expiresAtEpochSeconds?: number
  /** How long a GIFT-CARD hold guarding this session must live, in minutes.
   *  Undefined exactly when `expiresAtEpochSeconds` is. */
  holdMinutes?: number
  /** How long a PROMO reservation guarding this session must live, in minutes —
   *  the same instant plus the longer backstop, for the reason in
   *  PROMO_RESERVATION_BACKSTOP_MINUTES. Undefined exactly when
   *  `expiresAtEpochSeconds` is. */
  promoHoldMinutes?: number
}

/**
 * Derive, ONCE per checkout, the single instant the Stripe session expires at
 * and the window every reservation riding it must outlive. Two copies of one
 * instant, never two computations — the same discipline a waitlist claim's
 * three deadlines are under.
 *
 * WHY THIS EXISTS AT ALL (both halves were live bugs at 4b3177f):
 *
 *  • A reservation must never die BEFORE the session it guards. A drop-in paid
 *    by gift card on a 120-minute waitlist claim gave Stripe the claim's own
 *    deadline while reserving the drawdown for the constant 35 minutes. Between
 *    +35 and +120 the held value was available again (giftCardAvailable ignores
 *    expired holds), another purchase could spend it, and when the claim's
 *    payment finally landed the committer found no hold, fell back to the
 *    drawdown in checkout metadata, and either double-spent the value or
 *    clamped at zero so the studio silently absorbed the difference.
 *
 *  • A reservation must never live MUCH LONGER either. The plain product and
 *    course branches pass no `expires_at` at all and therefore take Stripe's
 *    24-hour default. Bounding a reservation only from below would force a
 *    24-hour reservation on those rails, so one abandoned cart could hold a
 *    scarce campaign closed for a day. Hence: anything that reserves a finite
 *    thing gets a SHORT session; a checkout with no instrument keeps its 24
 *    hours untouched.
 *
 * The resulting invariant, checkable on every rail:
 *   session.expires_at  <  hold.expires_at  ≤  session.expires_at
 *                                            + MARGIN (+ 1 minute + BUDGET)
 *   session.expires_at  <  promo.expires_at ≤  session.expires_at
 *                                            + BACKSTOP (+ 1 minute + BUDGET)
 * and on every rail except a waitlist claim
 *   session.expires_at  ≤  now + SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES.
 *
 * THE TWO TRAILING TERMS ARE NOT NOISE — they are stated because each is a real
 * way the stored deadline sits later than this function's output, and an upper
 * bound that omits them is an overclaim:
 *  • `+ 1 minute` is `Math.ceil` on a minute-granular hold parameter;
 *  • `+ BUDGET` is elapsed work. `holdMinutes` / `promoHoldMinutes` are
 *    DURATIONS, applied at each reserve's own `Date.now()` — necessarily later
 *    than the `nowMs` this function saw. That drift is in the safe direction (a
 *    longer-lived reservation), and it is bounded at
 *    CHECKOUT_WINDOW_WORK_BUDGET_SECONDS on any checkout that COMPLETES,
 *    because one that spends more than the budget is refused by
 *    `assertCheckoutWindowPayable` and its reservations are released.
 * The pure relations without the drift are what checkoutWindow.test.ts pins.
 *
 * The two upper bounds differ deliberately — see
 * PROMO_RESERVATION_BACKSTOP_MINUTES. A gift-card hold is released by a marker
 * on the card, so a tight margin costs nothing; a promo slot is released by the
 * `checkout.session.expired` webhook, and its lazy expiry must not race the
 * delivery of the OTHER webhook that decides the same slot.
 *
 * A waitlist claim is the ONE exception and it is deliberate: its booking hold,
 * its queue entry's `offer_expires_at` and its Stripe session are ONE instant,
 * and clamping the session down to 31 minutes would give a seat two timers,
 * which is how a seat gets sold twice.
 *
 * WHAT THIS FUNCTION DOES NOT DECIDE: whether the instant is still usable by the
 * time Stripe is actually called. Fixing the instant here and reserving against
 * it afterwards spends CHECKOUT_WINDOW_WORK_BUDGET_SECONDS, and
 * `assertCheckoutWindowPayable` (at `startOneOffCheckout`) is what refuses when
 * the budget ran out. This function is pure and knows nothing about elapsed work.
 */
export function resolveCheckoutHoldWindow(input: {
  nowMs: number
  /** True when something FINITE is reserved against this session — a gift-card
   *  hold, a promo reservation, or both. Forces a bounded expiry. */
  carriesReservation: boolean
  /** A deadline this rail already owns and has already reconciled with its other
   *  timers (a waitlist claim's single instant). Used VERBATIM — never
   *  re-derived and never clamped here, or the seat gets a second timer. */
  fixedExpiresAtEpochSeconds?: number | null
  /** Rails whose session must be short-lived even with nothing reserved,
   *  because their own hold frees something at a deadline: a drop-in's booking
   *  hold releases the seat at +30 whatever the buyer paid with. */
  alwaysBounded?: boolean
}): CheckoutHoldWindow {
  const expiresAtEpochSeconds =
    input.fixedExpiresAtEpochSeconds ??
    (input.carriesReservation || input.alwaysBounded === true
      ? Math.floor(input.nowMs / 1000) + SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES * 60
      : undefined)

  if (expiresAtEpochSeconds === undefined) return {}

  const minutesToExpiry = Math.ceil((expiresAtEpochSeconds * 1000 - input.nowMs) / 60_000)
  return {
    expiresAtEpochSeconds,
    // Never below the margin itself: an already-past expiry (a claim window that
    // ran out between validation and here) must still leave the reservation
    // alive long enough for the release path to find it.
    holdMinutes: Math.max(
      PROMO_RESERVATION_MARGIN_MINUTES,
      minutesToExpiry + PROMO_RESERVATION_MARGIN_MINUTES
    ),
    promoHoldMinutes: Math.max(
      PROMO_RESERVATION_BACKSTOP_MINUTES,
      minutesToExpiry + PROMO_RESERVATION_BACKSTOP_MINUTES
    ),
  }
}

/**
 * Seconds of Stripe's 30-minute floor still to spare on a session about to be
 * created, or `null` when this checkout passes no `expires_at` at all (Stripe's
 * 24-hour default — nothing finite rides it, so there is no budget to blow).
 *
 * On a SHORT window this starts at exactly CHECKOUT_WINDOW_WORK_BUDGET_SECONDS
 * and counts down as the reservations are taken. Negative ⇒ Stripe WILL reject
 * the create.
 */
export function checkoutWindowBudgetLeftSeconds(input: {
  expiresAtEpochSeconds?: number
  nowMs: number
}): number | null {
  if (input.expiresAtEpochSeconds === undefined) return null
  return (
    input.expiresAtEpochSeconds -
    Math.floor(input.nowMs / 1000) -
    STRIPE_MIN_CHECKOUT_EXPIRY_MINUTES * 60
  )
}

/**
 * THE ENFORCED BUDGET. Called once, immediately before the Stripe create, inside
 * `startOneOffCheckout` — the choke point every rail that derives an instant from
 * `resolveCheckoutHoldWindow` funnels through. That qualifier is load-bearing and
 * is stated in full on `startOneOffCheckout` itself: `createStaffAppointment`
 * bypasses the helper and computes a 7-day link expiry one statement before its
 * own Stripe call, so it has no window to overspend and nothing here to enforce.
 *
 * ── WHY IT REFUSES RATHER THAN MOVING THE INSTANT ──────────────────────────
 * Pushing `expires_at` out to `now + 30 min` here would keep the sale, and it is
 * the wrong answer, because the instant is not ours to move by the time we get
 * here — it has already been reconciled with everything riding it:
 *
 *   • the drop-in's booking hold, which frees the SEAT at +30 whatever the buyer
 *     pays with. A session that outlives it is an oversell AND a wrong charge —
 *     the seat goes to somebody else and `handleDropInCheckout` still confirms
 *     the late payment, because a real charge can never be dropped;
 *   • the appointment's slot hold, which IS the session;
 *   • a waitlist claim's ONE instant, shared with the queue entry;
 *   • every gift-card hold and promo reservation derived from it, each of which
 *     is bounded ABOVE relative to this number (MARGIN / BACKSTOP).
 *
 * Extending it silently breaks all four, and breaks them in data rather than in
 * an error — which is the failure shape this phase exists to foreclose. Refusing
 * loses one attempt at one sale, transiently, and loses nothing else: the
 * caller's own guard hands every reservation back, no Stripe session is created,
 * no idempotency key is consumed, and a retry re-derives a fresh instant.
 *
 * ── WHY IT REFUSES RATHER THAN LETTING STRIPE REFUSE ───────────────────────
 * Stripe rejects the same create with an `Invalid expires_at`, so the customer
 * sees the same thing either way. What it does not do is say WHY in terms of our
 * own timers, and nothing tests it — so the budget could be eroded to zero by
 * adding one more `await` inside the window and the first sign of it would be a
 * customer. Hence the named constant, the WARN tripwire at half spent, and the
 * fixtures.
 *
 * The thrown error is byte-identical to the one `startOneOffCheckout`'s own catch
 * produces for a Stripe failure, so no surface changes and no copy is needed;
 * `details.reason` is additive, for anyone who later wants to say more.
 */
export function assertCheckoutWindowPayable(input: {
  expiresAtEpochSeconds?: number
  nowMs: number
  /** Log tag, e.g. 'createDropInCheckout' — names the rail that overspent. */
  label: string
}): void {
  const leftSeconds = checkoutWindowBudgetLeftSeconds(input)
  if (leftSeconds === null) return
  if (leftSeconds < 0) {
    console.error(
      `[connect] ${input.label}: checkout window lapsed before Stripe was called — ` +
        `${-leftSeconds}s past Stripe's ${STRIPE_MIN_CHECKOUT_EXPIRY_MINUTES}-minute floor, ` +
        `against a ${CHECKOUT_WINDOW_WORK_BUDGET_SECONDS}s budget. Refusing rather than moving ` +
        `the instant: it is already reconciled with the hold, the seat and every reservation ` +
        `riding it. Everything reserved is released by the caller's guard.`
    )
    throw new HttpsError('internal', 'Failed to start checkout', {
      reason: 'checkout_window_lapsed',
    })
  }
  if (leftSeconds < CHECKOUT_WINDOW_WORK_BUDGET_SECONDS / 2) {
    // The tripwire, and the whole point of naming the budget: erosion is visible
    // here BEFORE it is visible as a refused sale. On a SHORT window this means
    // the work between fixing the instant and calling Stripe took longer than
    // half the minute it has; on a long waitlist-claim window it means the claim
    // itself is about to run out.
    console.warn(
      `[connect] ${input.label}: only ${leftSeconds}s of Stripe's expiry floor left ` +
        `(budget ${CHECKOUT_WINDOW_WORK_BUDGET_SECONDS}s). The work between fixing the ` +
        `checkout instant and creating the session is close to overspending it.`
    )
  }
}

/**
 * Close a Checkout Session on THIS team's connected account, so it can never
 * take money again. The account-resolving half of `closeCheckoutSession`, kept
 * here beside `startOneOffCheckout` because the two are the open and the shut of
 * one thing.
 *
 * The three-valued result is passed through unflattened on purpose: a caller
 * that cannot distinguish `failed` from `closed` will hand a still-payable
 * session's reservation to somebody else, which is the exact breach this exists
 * to stop.
 */
export async function closeTeamCheckoutSession(
  team: EnabledTeam,
  sessionId: string
): Promise<CheckoutSessionCloseOutcome> {
  try {
    const { accountId } = requireChargeableAccount(team)
    return await closeCheckoutSession({ sessionId, accountId })
  } catch (err) {
    console.error(`[connect] closeTeamCheckoutSession failed (session=${sessionId}):`, err)
    return 'failed'
  }
}

// ─── Rate limit (moved verbatim from connect/payments.ts) ───────────────────────

export const CHECKOUT_RATE_LIMIT_PER_HOUR = 30

/**
 * The public waiver probe's own bucket.
 *
 * `prefix` exists so unrelated public surfaces do not share one counter, and
 * this is the case that most needs it: a gym's NAT burning its checkout quota
 * on booking attempts must not lock the same IP out of merely READING the
 * document it is being asked to sign. Naming it here (rather than as a literal
 * at the call site) keeps the taken prefixes visible in one place — the others
 * are the default `'checkout'`, `'gift-buy'`, `'gift-check'`, `'promo-check'`
 * and `WAITLIST_CLAIM_RATE_LIMIT_BUCKET`.
 *
 * Two prefixes are DERIVED from the constant below rather than declared beside
 * it, by suffixing it (`-mint`, `-to`, `-team`). Derivation is what makes them
 * unable to collide with anything named here, and it keeps the counters that
 * bound a MESSAGE — which are keyed on a recipient and on a tenant, not on an
 * IP — out of a module about money. Their sizes and their reasoning live at the
 * single site that owns them.
 *
 * This constant is the ONLY waiver-shaped identifier permitted in this module:
 * a waiver has no price, so no waiver logic may appear anywhere on the money
 * path. (There was a second, `waiver-guardian`, for the emailed guardian link's
 * mint and redemption. That mechanism was removed and the bucket with it.)
 */
export const WAIVER_CHECK_RATE_LIMIT_BUCKET = 'waiver-check'

/**
 * THE COUNTER'S SUBJECT — whatever the quota belongs to, sanitised into a
 * document-id fragment.
 *
 * An IP is the commonest subject and was the only one this module used to
 * accept. It is the WRONG subject whenever the cost being bounded is not the
 * caller's: a message costs the recipient's inbox and the sender's reputation,
 * so its counters are keyed on a hashed address and on a tenant id. Same
 * mechanism, same doc shape, different subject — which is the point of naming
 * the key rather than the IP.
 */
export function rateLimitKey(raw: string | undefined): string {
  return (raw || 'unknown').replace(/[^\w.:-]/g, '_').slice(0, 60)
}

/**
 * The IP as a bucket key — HASHED. An IP is only ever a bucket key here (the doc
 * id and the stored `ip` field both derive from it), never read back as an
 * address, so there is no reason to keep the raw client address at all — and
 * keeping it in `connect_checkout_attempts`, which had no purge, meant an
 * unbounded store of identifiable access logs against the 30-day retention the
 * privacy policy promises (A11). Hashing the way the promo per-person cap hashes
 * emails preserves the bucketing (same IP → same bucket) while storing no
 * address. 'unknown' (the shared no-IP bucket) is not an address and stays
 * readable. Both the spend and the peek go through here, so they cannot drift.
 */
export function rateLimitIp(ipRaw: string | undefined): string {
  const trimmed = ipRaw?.trim()
  return trimmed ? sha256Hex(trimmed) : 'unknown'
}

function currentRateLimitBucket(nowMs = Date.now()): number {
  return Math.floor(nowMs / 3_600_000)
}

/** When the current hour bucket rolls. A refusal that can quote this reads as a
 *  delay; one that cannot reads as a permanent lockout. */
export function rateLimitWindowEndMs(nowMs = Date.now()): number {
  return (currentRateLimitBucket(nowMs) + 1) * 3_600_000
}

/** Read one counter without spending it. */
export async function rateLimitCount(key: string | undefined, prefix: string): Promise<number> {
  const snap = await rateLimitBucketRef(rateLimitKey(key), prefix, currentRateLimitBucket()).get()
  return (snap.data()?.count as number | undefined) ?? 0
}

/**
 * Spend one unit and report the new total. The CALLER decides what exceeding it
 * means, because one mechanism serves surfaces that owe the visitor different
 * sentences — "too many attempts" is right for a probe and wrong for a family
 * who has been told a link is on its way.
 */
export async function spendRateLimit(key: string | undefined, prefix: string): Promise<number> {
  const id = rateLimitKey(key)
  const bucket = currentRateLimitBucket()
  const ref = rateLimitBucketRef(id, prefix, bucket)
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const next = ((snap.data()?.count as number | undefined) ?? 0) + 1
    tx.set(
      ref,
      // `ip` is the stored field name and stays one, so existing counter
      // documents keep working. It holds the SUBJECT, whatever that is.
      { prefix, ip: id, bucket, count: next, updated_at: FieldValue.serverTimestamp() },
      { merge: true }
    )
    return next
  })
}

/** The bucket doc id shape is shared by the charge and the peek below — one
 *  counter per `{prefix, ip, hour}`, never two views of it that could drift. */
function rateLimitBucketRef(
  ip: string,
  prefix: string,
  bucket: number
): FirebaseFirestore.DocumentReference {
  return admin.firestore().collection('connect_checkout_attempts').doc(`${prefix}:${ip}:${bucket}`)
}

/**
 * The READ-ONLY half of the same bucket: refuse an IP that has already spent its
 * hour, without spending anything itself.
 *
 * For a surface where the entitled caller must never be throttled. A waitlist
 * claim is the case that forced this: the offer token is unguessable, single-use
 * and time-boxed, and there is exactly ONE person on earth who may use it — so
 * charging their attempt to a per-IP counter means a busy gym's NAT can cost
 * that person the only seat they will be offered. Those callers peek first
 * (which is what bounds an enumerator BEFORE any query runs) and call
 * `checkoutRateLimit` to charge only the attempts that turn out to be entitled
 * to nothing. See `booking/waitlist/claim.ts`.
 */
export async function assertUnderCheckoutRateLimit(
  ipRaw: string | undefined,
  prefix = 'checkout',
  limitPerHour = CHECKOUT_RATE_LIMIT_PER_HOUR
): Promise<void> {
  if ((await rateLimitCount(rateLimitIp(ipRaw), prefix)) >= limitPerHour) {
    throw new HttpsError('resource-exhausted', 'Too many attempts. Please try again later.', {
      reason: 'rate_limited',
    })
  }
}

/**
 * Index-free hourly rate limit for the public checkout: a
 * `{prefix}:{ip}:{hourBucket}` counter doc, incremented in a transaction.
 * Avoids composite indexes (and the emulator-hides-missing-index trap).
 * 'unknown' IPs share one bucket.
 *
 * `prefix` SEPARATES the buckets of unrelated public surfaces. One shared
 * counter means a burst of purchase attempts from an office/gym NAT locks the
 * same IP out of *checking* a gift-card balance — two different people, one
 * quota. `limitPerHour` is a parameter so a cheaper read-only surface can get
 * its own ceiling without a second copy of this function.
 */
export async function checkoutRateLimit(
  ipRaw: string | undefined,
  prefix = 'checkout',
  limitPerHour = CHECKOUT_RATE_LIMIT_PER_HOUR
): Promise<void> {
  const count = await spendRateLimit(rateLimitIp(ipRaw), prefix)
  if (count > limitPerHour) {
    // Reason code, because 'resource-exhausted' also means "this class is full"
    // on the booking callables — and a full class offers the waitlist while a
    // throttled IP must not.
    throw new HttpsError('resource-exhausted', 'Too many attempts. Please try again later.', {
      reason: 'rate_limited',
    })
  }
}

// ─── Checkout orchestrators ─────────────────────────────────────────────────────

/** One-off direct charge: window budget → account gate → currency → platform fee
 *  → Checkout Session, with the unified error mapping. Metadata passes through
 *  verbatim.
 *
 *  THE ONE CHOKE POINT for `expires_at`: every rail that derives an instant from
 *  `resolveCheckoutHoldWindow` (drop-in incl. waitlist claim, appointment,
 *  product, course) reaches Stripe through here, so the budget check covers all
 *  of them and any rail added later without that rail remembering to ask. The
 *  single caller that bypasses this helper is `createStaffAppointment`, which
 *  computes a 7-day link expiry one statement before its own Stripe call and so
 *  has no window to overspend. */
export async function startOneOffCheckout(params: {
  team: EnabledTeam
  amountMinor: number
  productName: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  metadata: Record<string, string>
  idempotencyKey: string
  expiresAtEpochSeconds?: number
  /** Log tag, e.g. 'createProductCheckout'. */
  label: string
}): Promise<{ url: string; sessionId: string; applicationFeeAmount: number }> {
  const { team, amountMinor } = params
  // BEFORE the try, deliberately: this refusal is ours and must not be rewritten
  // by the Stripe-failure mapping below into an error that says nothing about
  // which timer ran out.
  assertCheckoutWindowPayable({
    expiresAtEpochSeconds: params.expiresAtEpochSeconds,
    nowMs: Date.now(),
    label: params.label,
  })
  const { accountId, model } = requireChargeableAccount(team)
  const applicationFeeAmount = computePlatformFee({
    tier: team.plan,
    amount: amountMinor,
    model,
    waived: team.feeWaived,
  })
  try {
    const session = await createOneOffCheckoutSession({
      accountId,
      amount: amountMinor,
      currency: resolveStripeCurrency(team.data.default_currency as string | undefined),
      applicationFeeAmount,
      productName: params.productName,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      customerEmail: params.customerEmail,
      metadata: params.metadata,
      idempotencyKey: params.idempotencyKey,
      expiresAtEpochSeconds: params.expiresAtEpochSeconds,
    })
    return { url: session.url, sessionId: session.sessionId, applicationFeeAmount }
  } catch (err) {
    console.error(`[connect] ${params.label} failed:`, err)
    throw new HttpsError('internal', 'Failed to start checkout')
  }
}

/** Recurring subscription on the connected account: fee per invoice via
 *  application_fee_percent. Same shell as startOneOffCheckout.
 *
 *  `amountMinor` is ALWAYS the full per-period price. An intro offer never
 *  lowers it — that would make the intro figure the recurring one — it rides
 *  `introCoupon` as a Stripe Coupon, which expires on its own.
 *
 *  THE COUPON IS FAIL-CLOSED, deliberately. If it cannot be created the whole
 *  checkout fails, because the pricing card stated the offer BEFORE purchase:
 *  quietly charging the full price instead is the one outcome worse than an
 *  error. */
export async function startSubscriptionCheckout(params: {
  team: EnabledTeam
  amountMinor: number
  interval: 'day' | 'week' | 'month' | 'year'
  intervalCount?: number
  productName: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  metadata: Record<string, string>
  idempotencyKey: string
  label: string
  introCoupon?: IntroCouponSpec
}): Promise<{ url: string; sessionId: string; applicationFeePercent: number }> {
  const { team } = params
  const { accountId } = requireChargeableAccount(team)
  const applicationFeePercent = takeRatePercent(team.plan, team.feeWaived)
  try {
    const discountCouponId = params.introCoupon
      ? await ensureIntroCoupon({ accountId, spec: params.introCoupon })
      : undefined
    const session = await createSubscriptionCheckoutSession({
      accountId,
      amount: params.amountMinor,
      currency: resolveStripeCurrency(team.data.default_currency as string | undefined),
      interval: params.interval,
      intervalCount: params.intervalCount,
      applicationFeePercent,
      productName: params.productName,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      customerEmail: params.customerEmail,
      metadata: params.metadata,
      idempotencyKey: params.idempotencyKey,
      discountCouponId,
    })
    return { url: session.url, sessionId: session.sessionId, applicationFeePercent }
  } catch (err) {
    console.error(`[connect] ${params.label} failed:`, err)
    throw new HttpsError('internal', 'Failed to start checkout')
  }
}
