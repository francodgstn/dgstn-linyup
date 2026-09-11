/* eslint-disable no-console */
// Promo codes (Wave 3 Phase 3) — the IMPURE half: the Firestore lifecycle
// (load → reserve → commit → release) and the public `previewPromoCode`
// callable. The PURE half — the document type, the cap predicate, the identity
// and reservation key derivations — lives in @linyup/shared
// (types/promoCode.ts) and ships to the browser.
//
// ── THE GOVERNING RULE ──────────────────────────────────────────────────────
// A promo is a Stage A price MODIFIER, applied ONLY inside
// resolvePaymentOptions. A gift card is a Stage B TENDER, applied at the
// checkout callable against `pay.amount`. Nothing is both. So NOTHING in this
// file computes a discounted amount: it decides only WHETHER a code applies
// (the impure gates the pure resolver cannot see) and owns the finite resource
// behind it (the caps).
//
// The converse is narrower than it once read here, and the old wording ("`grep
// promo connect/checkout.ts` is empty by design") was simply false: that file
// owns PROMO_RESERVATION_MARGIN_MINUTES and resolveCheckoutHoldWindow (the ONE
// derivation of the window a reservation must outlive) and the `promoAttempted`
// scope on assertQuotedAmount. What it must never gain is ARITHMETIC — no
// discount is computed there, no promo document is read there, and no cap is
// decided there. That is the invariant; the grep never was.
//
// ── THE FOUR THINGS THAT MAKE THIS SAFE ─────────────────────────────────────
//
// 1. ONE WRITER OF `usage_count`. AFTER CREATION, `commitPromoRedemption`'s
//    transaction and nothing else ever writes PromoCode.usage_count or
//    PromoRedemption.count — as an ABSOLUTE value computed from its own read
//    set, never FieldValue.increment. (`createPromoCode` stamps the initial
//    `usage_count: 0`; `updatePromoCode` writes the definition only and omits
//    the field, so no edit can reset a count.) There is no restore-on-refund path, because that
//    would be a second writer. The two manager corrections
//    (clearPromoRedemption, releasePromoReservations) DELETE lifecycle state;
//    neither touches a counter.
//
// 2. A USE IS CONSUMED BY A COMPLETED SALE, NEVER BY AN ATTEMPT. The commit
//    lives at each webhook handler's per-kind CONFIRM point and at the THREE
//    gift-card full-cover branches, NAMED so the next reader can check the claim
//    without counting: `createDropInCheckout` (booking/dropIn.ts),
//    `createProductCheckout` and `createCourseCheckout` (connect/payments.ts).
//    There is no fourth — appointments take no gift card by design, so nothing
//    on that rail can be fully covered. It is never before the per-kind
//    dispatch, because four branches inside that dispatch are system-initiated FULL
//    refunds (drop-in duplicate, drop-in oversell, appointment duplicate,
//    appointment slot-retaken/missing). On those the platform itself decided
//    the purchase did not happen: nothing is committed and the reservation
//    simply lapses. That needs no compensating reversal, which is precisely why
//    it beats the gift card's reverse-the-drawdown answer here — a promo
//    reversal would be a second writer of the counter.
//
// 3. A RETRY IS A REFRESH, NOT A SECOND USE. The reservation key is
//    sha256(len-prefixed code|identity|target), so one person holds at most ONE
//    reservation per (code, target). A Back-button, a double-click or a dropped
//    redirect rewrites that same entry instead of taking a second slot — which
//    is what stops a buyer's own live-but-unpaid reservation from refusing her
//    with "you have already used this code" for a purchase she never completed.
//    (The seat side of the codebase solved this shape first: countHoldingSeats
//    excludes the caller's own hold, booking/dropIn.ts.)
//
// 3b. …WHICH IS WHY A RESERVATION ALSO CARRIES AN INSTANCE. The lettered rules
//    below are all consequences of that one deterministic key, and they only
//    work together; each was a live bug in this phase before it was written
//    down. THEY ARE DEFINED, ONCE, IN `docs/promo-codes.md` → "The ownership
//    rules" — what follows is a pointer with just enough text to make the code
//    below readable, deliberately NOT a second copy of the list. (Three
//    summaries of that list once carried three different counts of it, none of
//    which matched the list. A lettered list is its own count; the prose no
//    longer offers a rival one.)
//
//    (a) A RESERVATION IS TAKEN ONLY WHEN THE RESOLVER SAID `applied`. A code
//        that loaded fine but LOST best-one-wins (a member whose own benefit
//        beats the public code, who typed the code anyway) reserves nothing.
//
//    (b) METADATA IS STAMPED IF AND ONLY IF A RESERVATION WAS TAKEN. That is
//        structural, not a convention to remember: `promoCheckoutMetadata`
//        takes the TICKET that `reservePromoRedemption` returns, and there is
//        no other way to mint one. The webhook can therefore never commit a
//        reservation that does not exist — which would consume a global use and
//        permanently burn the buyer's per-person cap for a discount that was
//        never given.
//
//    (c) AN ENTRY IS REMOVED ONLY BY THE INSTANCE THAT WROTE IT — or by lazy
//        expiry, or by the manager lever. The key is shared by every attempt at
//        one purchase, so without the instance check a stale sibling checkout's
//        expiry (or a later failed retry) deletes the reservation guarding a
//        still-payable session, and the cap can be exceeded. Refuse, never
//        over-issue, is the settled decision (§Q9), so the comparison happens
//        INSIDE the release/commit transaction, against the entry it is about
//        to delete.
//
//    (d) AND THE SLOT IS SPENT ONCE. Ownership decides more than deletion: a
//        retry mints a NEW Checkout Session each time while refreshing the same
//        entry, so one slot can be shared by many still-payable sessions — and
//        on the product and course rails a second payment is not a duplicate to
//        refund, it is a second genuine order. Counting a use per completed
//        session therefore ran `usage_count` and `PromoRedemption.count` past
//        their caps with nothing failing anywhere. The commit now spends the
//        slot only when it still holds it (instance match), and treats an entry
//        that has vanished INSIDE its own claim window as taken rather than
//        lapsed. See `decidePromoCommit`; a refused spend is logged at ERROR,
//        because "the system does not even notice" was half the defect.
//
// 3c. …AND A SLOT BACKS AT MOST ONE PAYABLE SESSION. (d) makes one slot yield at
//    most one COUNTED use; it does not stop one slot yielding several PAID
//    orders, because ownership is decided after the money has moved. The bound
//    therefore also sits on the thing that can take money:
//
//      • `PromoReservation.sessionId` records which Checkout Session the slot is
//        backing right now;
//      • a refresh CLOSES that session at Stripe before writing anything, and
//        refuses (`promo_purchase_paid` / `promo_busy`) if it cannot — so a
//        refusal leaves the previous owner's entry untouched;
//      • the reserve transaction compare-and-sets on that same session id, so a
//        sibling that bound one in between cannot be refreshed over;
//      • `bindPromoCheckoutSession` attaches the new session under the instance
//        check and CLOSES the session it just created if the slot has moved on.
//
//    See `reservePromoRedemption`. The counters have their own last-resort gate
//    in `commitPromoRedemption`, which refuses to write past either cap.
//
// 4. THE DOCUMENT IS SIZE-BOUNDED, FOREVER. Committed history is NOT on the
//    promo document — it lives one-doc-per-person in the `redemptions`
//    subcollection. The only map field holds LIVE reservations, capped at
//    PROMO_MAX_LIVE_RESERVATIONS (25 ≈ 5 KB). Firestore's 1 MiB document limit
//    is a hard wall with a nasty property: once crossed, reserve, commit,
//    release AND disable all fail, so the code becomes both unredeemable and
//    unrepairable.
//
// ── WHY A LIVE RESERVATION CONSUMES A USE ───────────────────────────────────
// Decided 2026-08-14: NEVER over-issue. A contested code refuses rather than
// exceeding its cap. The refusal side is bounded hard so that is survivable —
// the deterministic key (N abandonments of ONE purchase are one slot, not N —
// they need N distinct (identity, target) PAIRS, which at the default
// max_uses_per_contact of 1 means N distinct email identities; a manager who
// ticks "unlimited per person" trades that half away, see
// PROMO_MAX_LIVE_RESERVATIONS), the PROMO_MAX_LIVE_RESERVATIONS ceiling with its
// own `promo_busy` message, short checkout windows on every rail, reserved shown
// separately from used in the admin list, and a manager release lever. Flipping
// the direction is one line in `promoUsesLeft` (drop `liveTotal` from `global`).
//
// ── RELEASE IS PROMPT; EXPIRY IS THE BACKSTOP ───────────────────────────────
// A slot is freed on POSITIVE EVIDENCE that its session can no longer be paid:
// `checkout.session.expired` → `handleCheckoutExpired` → `releasePromoFromMetadata`,
// within seconds, instance-guarded. The callables' own failure guards release
// what they reserved, and the manager lever clears everything.
//
// Lazy expiry remains underneath all of that: `promoLiveReservations` is THE
// predicate, and every transaction here drops stale entries while it already
// holds the document — the gift card's dropExpiredHolds idiom. There is no sweep
// job and no cron entry. What CHANGED is that it is no longer the mechanism: at
// the old +4 minutes it fired the moment the session died and therefore raced
// Stripe's own webhook delivery, which is measured in hours when Stripe retries.
// It now sits an hour out (PROMO_RESERVATION_BACKSTOP_MINUTES) so that a late
// `checkout.session.completed` normally finds its slot still standing.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  GUEST_SNAPSHOT,
  PRODUCTS_SUBCOLLECTION,
  PROMO_CODES_SUBCOLLECTION,
  PROMO_DEFAULT_MAX_USES_PER_CONTACT,
  PROMO_MAX_LIVE_RESERVATIONS,
  PROMO_MAX_SCOPE_IDS,
  PROMO_REDEMPTIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  getPromoCodeLimits,
  isValidPromoCodeFormat,
  looksLikeGiftCardCode,
  normalizeEmail,
  normalizeRedemptionCode,
  promoAllowsCaller,
  promoAppliesTo,
  promoIdentityKey,
  promoLiveReservations,
  promoModifier,
  promoReservationKey,
  promoUsesLeft,
  promoWindowOpen,
  resolveDurationSale,
  resolvePaymentOptions,
  resolveProductPrice,
  type PaymentOptionsResult,
  type Product,
  type PromoAudience,
  type PromoCode,
  type PromoEffect,
  type PromoModifier,
  type PromoRedemption,
  type PromoReservation,
  type PromoScopeKind,
  type PromoTargetScope,
  type SaasPlan,
  studioDropInOf,
} from '@linyup/shared'
import { generateSecureToken, sha256Hex } from '../utils/crypto'
import { assertPluginInstalled } from '../utils/plugins'
import { assertManager } from './access'
import { checkoutRateLimit, requireChargeableAmountFromMajor } from './checkout'
import { giftCardCurrency } from './giftCards'
import { loadCoursePricing } from './coursePricing'
import { loadContactPaymentSnapshot } from '../booking/access'
import { buildDropInTarget, resolveDropInForContact } from '../booking/dropInPricing'
import { loadBookingSettings } from '../booking/bookingSettings'
import { loadAppointmentBookingContext } from '../appointments/booking'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import { APP_CHECK_ENFORCE, monitorAppCheck } from '../utils/appCheck'

// ─── Refs ───────────────────────────────────────────────────────────────────

function promoRef(teamId: string, code: string): FirebaseFirestore.DocumentReference {
  return admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(PROMO_CODES_SUBCOLLECTION)
    .doc(normalizeRedemptionCode(code))
}

function redemptionRef(
  teamId: string,
  code: string,
  identityKey: string
): FirebaseFirestore.DocumentReference {
  return promoRef(teamId, code).collection(PROMO_REDEMPTIONS_SUBCOLLECTION).doc(identityKey)
}

// ─── The target, and its ONE key derivation ─────────────────────────────────

/**
 * A purchase a promo can be asked about, carrying the entity ids BOTH the scope
 * allow-lists and the reservation key need. Deliberately not `PaymentTarget`:
 * that type carries no entity ids at all (widening it would touch every
 * construction site in the repo), which is exactly why the impure half of promo
 * applicability lives out here in a loader.
 */
export type PromoQuoteTarget =
  | { kind: 'drop_in'; sessionId: string; activityId: string; trial?: boolean }
  | {
      kind: 'appointment'
      providerId: string
      activityId: string
      startMs: number
      durationMinutes: number
    }
  | { kind: 'course'; courseId: string }
  | { kind: 'product'; productId: string; variantId?: string | null }

/**
 * THE per-rail purchase identity: stable across retries of ONE purchase,
 * distinct across different purchases. It exists exactly once — the preview and
 * the checkout must produce the same string, or a refresh silently becomes a
 * second use and the buyer's own cap refuses her.
 *
 * It is fed into `promoReservationKey`, whose preimage is LENGTH-PREFIXED
 * rather than merely joined, because a product's `variantId` is client-generated
 * and a bare `a|b|c` preimage would let two different purchases hash onto one
 * reservation.
 */
export function promoTargetKey(target: PromoQuoteTarget): string {
  switch (target.kind) {
    // A waitlist claim IS a drop-in — same rail, same key, no scope kind of its
    // own.
    case 'drop_in':
      return `drop_in:${target.sessionId}`
    case 'appointment':
      return `apt:${target.providerId}:${target.startMs}:${target.durationMinutes}`
    case 'course':
      return `course:${target.courseId}`
    case 'product':
      return `product:${target.productId}:${target.variantId ?? ''}`
  }
}

/** The scope half of applicability — rail kind, entity ids, and the trial door. */
export function promoScopeOf(target: PromoQuoteTarget): PromoTargetScope {
  switch (target.kind) {
    case 'drop_in':
      return { kind: 'drop_in', activityId: target.activityId, isTrial: target.trial === true }
    case 'appointment':
      return { kind: 'appointment', activityId: target.activityId }
    case 'course':
      return { kind: 'course', courseId: target.courseId }
    case 'product':
      return { kind: 'product', productId: target.productId }
  }
}

// ─── The loader — never throws (§2.4 step 1) ────────────────────────────────

/**
 * Why a typed code produced NO modifier. Reported to the visitor; never a throw
 * and never a blocked purchase — a code that does not apply is REPORTED and the
 * purchase completes at list price.
 *
 *  • `invalid`               unknown, disabled, outside its window, malformed,
 *                            or BOUND TO SOMEBODY ELSE. Those are deliberately
 *                            one answer: "this code is not yours" confirms the
 *                            code is real to whoever guessed it.
 *  • `not_applicable`        a live code, the wrong item (rail, allow-list, or
 *                            the paid-trial door).
 *  • `looks_like_gift_card`  a visitor pasted a GC- code into the promo field.
 *                            A real event, and "invalid code" is the wrong
 *                            answer to it.
 *  • `audience_mismatch`     a new-customers-only code typed by a member. Names
 *                            itself, unlike a binding: a flyer code is public,
 *                            and "this one is for new customers" is honest and
 *                            gives nothing away.
 *  • `currency_mismatch`     a fixed_price code stamped in another currency.
 */
export type PromoLoadRefusal =
  | 'invalid'
  | 'not_applicable'
  | 'looks_like_gift_card'
  | 'audience_mismatch'
  | 'currency_mismatch'

export type PromoLoadResult =
  | { ok: true; modifier: PromoModifier; promo: PromoCode }
  | { ok: false; reason: PromoLoadRefusal }

/** Who is asking. `joined` is EXACTLY `acquisition_stage === 'joined'` — the
 *  same fact ContactPaymentSnapshot.joined and the `members` access rule run
 *  on, deliberately not a second definition of "member". */
export interface PromoCaller {
  contactId?: string | null
  email?: string | null
  joined: boolean
}

type ContactDoc = FirebaseFirestore.DocumentData & { id: string }

// ── THE AUDIENCE INVARIANT ──────────────────────────────────────────────────
//
//   "JOINED" IS A PROPERTY OF THE EMAIL ADDRESS, NEVER OF ONE CONTACT DOCUMENT.
//   A `new_contacts` code is refused whenever ANY ACTIVE contact of the team
//   under the caller's email has joined — whichever document the rail happens to
//   be buying as.
//
// That sentence is the whole feature of this section, and it is written here
// because the axis has now been broken THREE times, each a layer deeper: first
// the predicate itself, then what each rail FED the predicate, then what the
// resolver DID with what it was fed (it threw the email evidence away whenever
// the rail happened to hold a contact document, so a member's household member
// — or their own differently-spelled duplicate — walked straight through).
//
// All three were one mistake: treating ONE contact document as the answer to a
// question about a PERSON, when on these rails a person owns as many contact
// documents as they care to create (`createDropInCheckout` mints one per
// (email, exact first, exact last) spelling; a household shares a mailbox).
//
// So the seam is the EVIDENCE, not the rail. `promoCallerFrom` is the only
// constructor of a gate-bearing `PromoCaller`, and it takes both halves of the
// evidence as REQUIRED properties: a call site cannot silently be missing the
// email half, because it will not compile without naming it. The only producer
// of that evidence is `resolvePromoCaller`, which ALWAYS consults the email when
// a code was typed — with one skip that cannot change the answer (see below).

/**
 * THE one constructor. `joined` is the UNION over every admissible piece of
 * evidence, and `contactId` is the never-guess identity — the asymmetry is
 * deliberate:
 *
 *  • `joined` is true when the held document has joined **or** when any active
 *    contact under the email has. "Never guess when ambiguous" is right for
 *    ATTRIBUTING a payment (`resolveSingleContact`) and exactly wrong for a
 *    gate: it turns a second contact on one mailbox into a one-step evasion.
 *  • `contactId` is the held document when the rail has one, else an
 *    UNAMBIGUOUS single active match and otherwise nothing — because it feeds
 *    `restrict_to_contact_id`, where naming the wrong person hands somebody
 *    else's code away.
 *
 * `emailMatches` is REQUIRED and non-nullable. An empty array is a claim ("the
 * team has no contact under this address"), and a caller that has not looked has
 * to write that claim out rather than omit a field.
 */
export function promoCallerFrom(evidence: {
  /** The document the rail is buying AS, when it holds one. Authoritative for
   *  `contactId`; NEVER on its own authoritative for `joined`. */
  contact: ContactDoc | null
  /** EVERY contact stored under the caller's email — archived and deleted
   *  included; they are filtered here, once, in one place. */
  emailMatches: ContactDoc[]
  email?: string | null
}): PromoCaller {
  const held = evidence.contact ?? null
  const active = evidence.emailMatches.filter((c) => c.archived_at == null && c.deleted_at == null)
  const unambiguous = active.length === 1 ? active[0].id : null
  return {
    contactId: held?.id ?? unambiguous,
    email:
      (held?.email as string | undefined) ??
      evidence.email ??
      (active[0]?.email as string | undefined) ??
      null,
    joined:
      held?.acquisition_stage === 'joined' || active.some((c) => c.acquisition_stage === 'joined'),
  }
}

/**
 * The caller for a checkout where NO CODE WAS TYPED. `joined: false` here is not
 * an answer — it is a placeholder for a question nobody asked, and it is safe
 * only because every path that reads it (`promoAllowsCaller`, via the loader and
 * the reserve) is unreachable without a code. Never reach for this on a path a
 * code can travel; use `resolvePromoCaller`.
 */
export function promoCallerNotAsked(i: {
  contactId?: string | null
  email?: string | null
}): PromoCaller {
  return { contactId: i.contactId ?? null, email: i.email ?? null, joined: false }
}

/**
 * ONE audience answer for EVERY rail — so drop-ins, appointments, courses and
 * products cannot each decide what "new customer" means, and so no rail can
 * decide it from a single document.
 *
 * A HELD CONTACT DOCUMENT DOES NOT SHORT-CIRCUIT THE EMAIL. It used to, and that
 * was the third break of this axis: `createDropInCheckout` holds a document
 * whenever the (email + exact first + exact last) match hits, so a household's
 * non-member — or a member's own second document — is exactly the case where the
 * rail HAS a document and the document is not the answer.
 *
 * The one skip that remains cannot change the answer: `joined` is a UNION, so it
 * only ever moves false → true, and a held document that has already joined
 * settles it. Everything else consults the email.
 *
 * `emailMatches` exists because THE DROP-IN RAIL MUST PASS ITS OWN. That callable
 * mints a fresh provisional contact for an unmatched guest BEFORE the promo
 * loads, so a query issued here would see that brand-new document too, come back
 * with two matches, and the gate would fall open exactly where it matters. The
 * matches captured BEFORE the mint are the correct read set — that ordering is
 * load-bearing on the drop-in rail and must not regress.
 */
export async function resolvePromoCaller(params: {
  teamId: string
  contact?: ContactDoc | null
  email?: string | null
  /** Contacts under this email the rail already fetched. Omit to let this helper
   *  query for them; pass them when the rail is about to mutate the contact set. */
  emailMatches?: ContactDoc[] | null
  /** Nothing but a typed code needs any of this. */
  codeTyped: boolean
}): Promise<PromoCaller> {
  const held = params.contact ?? null
  const email = (held?.email as string | undefined) ?? params.email ?? null
  if (!params.codeTyped) return promoCallerNotAsked({ contactId: held?.id, email })

  let matches = params.emailMatches ?? null
  if (!matches && held?.acquisition_stage !== 'joined') {
    // The SAME normalisation every rail stores its contacts' emails with, so the
    // equality query cannot miss a match on casing or a stray space.
    const normalized = normalizeEmail(email ?? '')
    matches = normalized
      ? (
          await admin
            .firestore()
            .collection(CONTACTS_COLLECTION)
            .where('teamId', '==', params.teamId)
            .where('email', '==', normalized)
            .get()
        ).docs.map((d) => ({ ...d.data(), id: d.id }))
      : []
  }
  return promoCallerFrom({ contact: held, emailMatches: matches ?? [], email })
}

/**
 * The same answer for a rail that holds only a contact ID (the login-first shop
 * checkouts). ONE document read, and only when a code was actually typed —
 * `createProductCheckout` deliberately reads no contact document otherwise,
 * because the product arm is snapshot-invariant. The audience gate is the one
 * thing that genuinely needs the buyer's funnel stage.
 *
 * It ends in `resolvePromoCaller` like every other rail, so "one definition of a
 * new customer" is true by call graph rather than by four rails agreeing — and
 * that includes the email fan-out: a login-first buyer holding a not-yet-joined
 * contact document is precisely the household case, so the fetched document
 * narrows nothing on its own.
 */
export async function loadPromoCaller(params: {
  teamId: string
  contactId?: string | null
  email?: string | null
}): Promise<PromoCaller> {
  const snap = params.contactId
    ? await admin.firestore().collection(CONTACTS_COLLECTION).doc(params.contactId).get()
    : null
  const c = snap?.exists && snap.data()?.teamId === params.teamId ? snap.data()! : null
  return resolvePromoCaller({
    teamId: params.teamId,
    contact: c && params.contactId ? { ...c, id: params.contactId } : null,
    email: params.email ?? null,
    codeTyped: true,
  })
}

/**
 * Resolve the IMPURE half of promo applicability: exists · active · window ·
 * this caller's · in scope for this target · currency. Returns a
 * `PromoModifier` the pure resolver can take as-is, or a reason.
 *
 * NEVER THROWS. That is the single rule §2.4 step 1 exists to state: the most
 * common real interaction with this feature is a visitor pasting a flyer code
 * onto the wrong item, and refusing the purchase for it would be absurd.
 *
 * ORDER IS LOAD-BEARING: the caller-identity gates run BEFORE the scope check,
 * so a code bound to somebody else reports the secretive `invalid` rather than
 * a `not_applicable` that would confirm the code exists.
 */
export async function loadPromoForTarget(params: {
  teamId: string
  code: string
  scope: PromoTargetScope
  caller: PromoCaller
  /** The currency this purchase will actually be charged in. Guarded for
   *  `fixed_price` ONLY: a percentage has no currency, but a fixed price is an
   *  authored money amount read at one moment and applied at another. */
  chargeCurrency?: string | null
}): Promise<PromoLoadResult> {
  const raw = normalizeRedemptionCode(params.code)
  if (looksLikeGiftCardCode(raw)) return { ok: false, reason: 'looks_like_gift_card' }
  if (!isValidPromoCodeFormat(raw)) return { ok: false, reason: 'invalid' }

  const snap = await promoRef(params.teamId, raw).get()
  if (!snap.exists || snap.data()?.teamId !== params.teamId) return { ok: false, reason: 'invalid' }
  const promo = snap.data() as PromoCode

  if (promo.status !== 'active') return { ok: false, reason: 'invalid' }
  if (!promoWindowOpen(promo, Date.now())) return { ok: false, reason: 'invalid' }

  const allowed = promoAllowsCaller(promo, params.caller)
  if (!allowed.ok) {
    return {
      ok: false,
      reason: allowed.reason === 'audience_mismatch' ? 'audience_mismatch' : 'invalid',
    }
  }

  if (!promoAppliesTo(promo, params.scope)) return { ok: false, reason: 'not_applicable' }
  if (!promoCurrencyMatches(promo, params.chargeCurrency)) {
    return { ok: false, reason: 'currency_mismatch' }
  }

  return { ok: true, modifier: promoModifier(promo), promo }
}

/** fixed_price only, compared case-insensitively (docs store 'CHF', Stripe
 *  speaks 'chf'). An unstamped code or an unknown charge currency passes — the
 *  guard is a tripwire for a team that changed currency between authoring and
 *  redemption, not a second source of truth. */
function promoCurrencyMatches(
  promo: Pick<PromoCode, 'effect' | 'currency'>,
  chargeCurrency?: string | null
): boolean {
  if (promo.effect !== 'fixed_price') return true
  const stamped = (promo.currency ?? '').toUpperCase()
  const wanted = (chargeCurrency ?? '').toUpperCase()
  if (!stamped || !wanted) return true
  return stamped === wanted
}

// ─── The attempt — what every checkout callable holds ───────────────────────

/**
 * One code, loaded once, with every key the lifecycle needs already derived.
 * Built BEFORE Stage A (the resolver takes the modifier) and carried through to
 * the reserve, the metadata, the release and the commit — so the four rails
 * cannot drift on how a code becomes a reservation.
 *
 * `modifier === null` means either no code was typed or the code produced none;
 * `refusal` distinguishes those and is what a surface renders.
 */
export interface PromoAttempt {
  /** Canonical uppercase, or null when no code was typed. */
  code: string | null
  modifier: PromoModifier | null
  refusal: PromoLoadRefusal | null
  identityKey: string
  reservationKey: string
  targetKey: string
}

export const NO_PROMO_ATTEMPT: PromoAttempt = {
  code: null,
  modifier: null,
  refusal: null,
  identityKey: '',
  reservationKey: '',
  targetKey: '',
}

/**
 * Load a typed code for a specific purchase. Call this AFTER the caller's
 * contact is resolved (the audience gate and the identity key both need it) and
 * BEFORE Stage A.
 *
 * The identity key prefers the caller's normalised EMAIL over their contact id,
 * and that is the whole reason the per-person cap means anything on the guest
 * rails: `createDropInCheckout` reuses an existing contact only on an exact
 * (email, lowercased firstname, lowercased lastname) match and otherwise mints a
 * fresh one, so a contact-keyed cap would read "once per exact spelling of a
 * name" — and would reset every time purgeProvisionalContacts sweeps an
 * abandoned provisional contact overnight.
 */
export async function loadPromoAttempt(params: {
  teamId: string
  code?: string | null
  target: PromoQuoteTarget
  caller: PromoCaller
  chargeCurrency?: string | null
}): Promise<PromoAttempt> {
  const raw = typeof params.code === 'string' ? params.code.trim() : ''
  if (!raw) return NO_PROMO_ATTEMPT

  const code = normalizeRedemptionCode(raw)
  const targetKey = promoTargetKey(params.target)
  const identityKey = promoIdentityKey(
    { email: params.caller.email, contactId: params.caller.contactId ?? '' },
    sha256Hex
  )
  const reservationKey = promoReservationKey({ code, identityKey, targetKey }, sha256Hex)

  const loaded = await loadPromoForTarget({
    teamId: params.teamId,
    code,
    scope: promoScopeOf(params.target),
    caller: params.caller,
    chargeCurrency: params.chargeCurrency,
  })

  return {
    code,
    modifier: loaded.ok ? loaded.modifier : null,
    refusal: loaded.ok ? null : loaded.reason,
    identityKey,
    reservationKey,
    targetKey,
  }
}

/**
 * PROOF THAT A RESERVATION EXISTS. Minted by `reservePromoRedemption` and by
 * nothing else, so a caller cannot hold one without having taken a slot.
 *
 * That is the whole point of the type. The three lifecycle operations that act
 * on a live reservation — stamping it into the Checkout Session's metadata,
 * releasing it, committing it — all require this object, so none of them can be
 * reached by a code that merely LOADED. (It was reachable: `promoCheckoutMetadata`
 * used to gate on "a modifier was built", which is true of a valid-but-superseded
 * code, and stamped a reservation key that nothing had reserved. The webhook then
 * committed it: a global use consumed and the buyer's per-person cap permanently
 * burned, for a discount they were never given.)
 */
export interface PromoReservationTicket {
  /** Canonical uppercase. */
  code: string
  reservationKey: string
  identityKey: string
  /** The generation marker written onto the entry. Release and commit compare it
   *  INSIDE their transaction against the entry they are about to delete, so a
   *  stale sibling attempt can never free a slot that is still guarding a
   *  payable session — and so only ONE of the sessions sharing this slot can
   *  ever spend it (see `decidePromoCommit`). */
  instanceId: string
  /** THIS attempt's own reservation deadline, epoch ms — the same instant the
   *  entry carries and the same instant the Checkout Session was bounded by.
   *  Carried into the session's metadata because the commit needs it to tell a
   *  genuinely LATE delivery (our slot lapsed on its own timer) from a slot that
   *  was taken away from us while it should still have been live. */
  expiresAtMs: number
}

/**
 * The metadata keys a promo-carrying Checkout Session stamps, mirroring the
 * gift card's giftCardCode / giftCardHold / giftCardDrawdown trio.
 *
 * IT TAKES THE TICKET, NOT THE ATTEMPT, and `null` produces `{}` — which is how
 * "metadata is stamped IFF a reservation was taken" is made true by construction
 * rather than by a boolean somebody has to remember to pass. A losing code (one
 * the resolver reported `superseded` / `not_needed` / `not_applicable`) never
 * produces a ticket, so it can never reach the webhook's commit.
 *
 * `promoIdentity` is not decoration: the commit takes its identity from the
 * reservation, and on a genuinely late Stripe delivery (Stripe retries over
 * hours) the reservation may already have lapsed. Without this key the global
 * counter would still move but the person's durable ledger row would not —
 * quietly giving them a second use of a once-per-person code. It is a hash, so
 * it discloses no address.
 *
 * `promoInstance` and `promoExpires` are the two halves of SLOT OWNERSHIP, and
 * they travel with the session because the webhook has nothing else to reason
 * from: the instance says which attempt this session is, the deadline says when
 * this attempt's own claim on the slot was due to lapse. Together they let the
 * commit spend a slot exactly once no matter how many sessions share it.
 */
export function promoCheckoutMetadata(
  ticket: PromoReservationTicket | null,
  amountMajor: number
): Record<string, string> {
  if (!ticket) return {}
  return {
    promoCode: ticket.code,
    promoReservation: ticket.reservationKey,
    promoIdentity: ticket.identityKey,
    promoInstance: ticket.instanceId,
    promoExpires: String(ticket.expiresAtMs),
    promoAmount: String(amountMajor),
  }
}

/**
 * What a checkout tells the client about the code they typed: the RESOLVER's
 * outcome when a modifier reached Stage A, else the LOADER's refusal. Empty when
 * no code was typed, so it spreads into a response without changing it.
 *
 * A checkout is never blocked by either — the purchase completes at list price
 * and the surface says why. The only thing a checkout refuses over is a price
 * the caller was not shown (`assertQuotedAmount`).
 */
export function promoCheckoutOutcome(
  attempt: PromoAttempt,
  result: PaymentOptionsResult
): Record<string, unknown> {
  if (!attempt.code) return {}
  if (result.promo) return { promo: result.promo }
  return {
    promo: { code: attempt.code, status: 'not_applicable' as const },
    ...(attempt.refusal ? { promoRefusal: attempt.refusal } : {}),
  }
}

/**
 * Idempotency-key parts for the instruments applied to a purchase.
 *
 * Stripe REJECTS a reused idempotency key whose request parameters differ, and
 * `defaultIdempotencyKey` buckets by minute — so "submit at 40.00, get bounced,
 * type a code, resubmit twelve seconds later" is the same key with a different
 * amount, which surfaces as a bare `internal` "Failed to start checkout". A
 * promo makes re-price-and-resubmit the PRIMARY interaction rather than an
 * exotic one.
 *
 * IT TAKES THE ATTEMPT, NOT THE CODE, AND THAT IS THE WHOLE FIX — for BOTH
 * instruments. A code alone is CONSTANT across every attempt at one purchase
 * while the request is not: each attempt stamps a fresh `promoInstance`, a
 * freshly derived `promoExpires` and, on the rails that take one, a fresh
 * `giftCardHold` into the session metadata. Same key, different parameters — so a
 * buyer who resubmitted inside the same minute bucket hit Stripe with an
 * idempotency-parameter mismatch and got `internal`. On the promo path the
 * reserve's pre-flight had by then closed their still-live Checkout Session, so
 * the failure left them with NO payable session at all.
 *
 * So BOTH instruments contribute their per-attempt marker, not just their code:
 * `instanceId` for the promo (minted by `reservePromoRedemption` and by nothing
 * else) and `holdKey` for the gift card (minted per attempt by every rail that
 * reserves a drawdown). Phase 3 shipped with only the promo half, which left the
 * plain gift-card resubmit — the same defect, one instrument over — failing with
 * a bare `internal` inside its minute bucket. Fixed here rather than left as
 * pre-existing: it is one parameter in the same expression, and the cost was two
 * call sites hoisting a token they already mint.
 *
 * The trade is named. With the hold key in, a resubmit inside the bucket creates
 * a SECOND Stripe session and a second hold instead of failing outright — which
 * is precisely what already happens one second later, across the minute boundary,
 * and is bounded by the card's own balance (the second reserve refuses when there
 * is not enough left). A guaranteed dead end becomes the behaviour the same
 * request already has at t+60s.
 *
 * The alternative — keep the instance out of the key and instead not re-instance
 * inside a bucket — was rejected on two counts, and the second is decisive:
 *
 *  1. the instance is not the only per-attempt parameter. `promoExpires`, the
 *     session's own `expires_at` and `giftCardHold` are all derived afresh at
 *     each attempt, and freezing them means freezing the window instant — which
 *     is the two-computations-of-one-instant bug the hold window exists to
 *     close. The mismatch would survive the fix;
 *  2. even byte-identical, an idempotent replay returns the CACHED response —
 *     the URL of the session the pre-flight has just expired. The buyer is handed
 *     a dead link, which is the same sessionless outcome by a quieter route.
 *
 * Nothing is lost on the dedupe side: re-submission is deduped by the reserve
 * (close the superseded session, then compare-and-set) and by the bind, never by
 * Stripe's key. See `reservePromoRedemption` — "AT MOST ONE PAYABLE SESSION PER
 * SLOT".
 *
 * Returns ZERO parts when nothing was applied, which is what keeps a plain
 * checkout's key byte-identical to the pre-Phase-3 one (moneyCore.test.ts
 * snapshot-tests all eight legacy shapes — appending empty strings would add
 * colons and break every one of them).
 */
export function instrumentKeyParts(
  promoTicket?: Pick<PromoReservationTicket, 'code' | 'instanceId'> | null,
  /** The gift card AND the hold this attempt reserved against it — the hold key
   *  is the card's `instanceId`, and it is a request parameter (it goes into the
   *  session metadata), so leaving it out is the same mismatch the promo half
   *  closes. Callers that mint the hold key later than the idempotency key must
   *  hoist it; there are two, both in connect/payments.ts. */
  giftCard?: { code: string; holdKey: string } | null
): string[] {
  const parts: string[] = []
  if (promoTicket?.code) {
    parts.push(`promo=${normalizeRedemptionCode(promoTicket.code)}`)
    // The attempt marker. A retry that took a fresh slot generation is a
    // genuinely new Stripe request and must not collide with the one it just
    // superseded.
    parts.push(`try=${promoTicket.instanceId}`)
  }
  if (giftCard?.code) {
    parts.push(`gift=${normalizeRedemptionCode(giftCard.code)}`)
    // The card's attempt marker, for the identical reason: `giftCardHold` is
    // stamped into the metadata afresh on every attempt.
    parts.push(`hold=${giftCard.holdKey}`)
  }
  return parts
}

// ─── Reserve ────────────────────────────────────────────────────────────────

export type PromoReserveRefusal =
  | 'promo_not_found'
  | 'promo_inactive'
  | 'promo_expired'
  | 'promo_not_applicable'
  | 'promo_audience_mismatch'
  | 'promo_currency_mismatch'
  | 'promo_exhausted'
  | 'promo_busy'
  | 'promo_already_used'
  /** The session this slot was already backing has been PAID. A new discounted
   *  session for the same purchase would be a second discounted order against
   *  one slot, which is the breach; and refusing costs nothing the buyer wanted,
   *  because the thing they were buying is bought. */
  | 'promo_purchase_paid'

const RESERVE_ERRORS: Record<
  PromoReserveRefusal,
  { code: 'not-found' | 'failed-precondition' | 'resource-exhausted'; message: string }
> = {
  promo_not_found: { code: 'not-found', message: 'We could not find that code.' },
  promo_inactive: { code: 'not-found', message: 'We could not find that code.' },
  promo_expired: { code: 'failed-precondition', message: 'This code has expired.' },
  promo_not_applicable: {
    code: 'failed-precondition',
    message: 'This code does not apply to this purchase.',
  },
  promo_audience_mismatch: {
    code: 'failed-precondition',
    message: 'This code is for new customers only.',
  },
  promo_currency_mismatch: {
    code: 'failed-precondition',
    message: 'This code cannot be used for this purchase.',
  },
  promo_exhausted: {
    code: 'resource-exhausted',
    message: 'This code has just been fully used.',
  },
  // A DIFFERENT sentence from promo_exhausted on purpose: "try again in a few
  // minutes" and "the campaign is over" are not the same news.
  promo_busy: {
    code: 'resource-exhausted',
    message: 'This code is busy right now — please try again in a few minutes.',
  },
  promo_already_used: {
    code: 'failed-precondition',
    message: 'You have already used this code.',
  },
  promo_purchase_paid: {
    code: 'failed-precondition',
    message: 'This purchase has already been paid.',
  },
}

function reserveError(reason: PromoReserveRefusal): HttpsError {
  const { code, message } = RESERVE_ERRORS[reason]
  return new HttpsError(code, message, { reason })
}

export type PromoReserveDecision =
  /** The caller's OWN reservation for this exact purchase — rewritten, nothing
   *  consumed. It is the same slot, already counted. */
  | { kind: 'refresh'; reservations: Record<string, PromoReservation> }
  | { kind: 'take'; reservations: Record<string, PromoReservation> }
  | { kind: 'refuse'; reason: PromoReserveRefusal }

/**
 * THE reserve decision, as a pure function of one read set — so the ordering
 * that makes it correct is testable without an emulator.
 *
 * READ SET: the promo document, and this identity's redemption row. Two single
 * document `get`s BY ID — no query, therefore no phantom to reason about, which
 * is why the serializability argument here needs no caveat.
 *
 * REFRESH IS CHECKED FIRST, before either cap. A purchase already in flight must
 * never be refused by the reservation it is itself holding.
 */
export function decidePromoReservation(input: {
  promo: PromoCode | null
  teamId: string
  nowMs: number
  scope: PromoTargetScope
  caller: PromoCaller
  identityKey: string
  reservationKey: string
  perIdentityCommitted: number
  chargeCurrency?: string | null
  /**
   * COMPARE-AND-SET: the `sessionId` this caller found on the entry and has
   * already CLOSED at Stripe (`null` when it found no entry, or an entry with no
   * session bound yet).
   *
   * REQUIRED — a call site that omits it does not compile, and that is
   * deliberate. The close happens outside this transaction (it is a network
   * call), so between the read that produced this value and the write below, a
   * sibling attempt at the same purchase could have bound a session of its own.
   * Refreshing over that would leave TWO payable sessions on one slot, which is
   * the whole breach. Mismatch ⇒ `promo_busy`.
   */
  expectedSessionId: string | null
  /** The entry to write. `expires_at` is bounded on BOTH sides against the
   *  Checkout Session it guards (resolveCheckoutHoldWindow), and `sessionId`
   *  starts null — it is attached once the session exists. */
  reservation: PromoReservation
}): PromoReserveDecision {
  const p = input.promo
  if (!p || p.teamId !== input.teamId) return { kind: 'refuse', reason: 'promo_not_found' }
  if (p.status !== 'active') return { kind: 'refuse', reason: 'promo_inactive' }
  if (!promoWindowOpen(p, input.nowMs)) return { kind: 'refuse', reason: 'promo_expired' }

  // Both identity gates in ONE expression — the same call the loader made, so
  // the loader and the transaction cannot each decide half of "who may use
  // this". A binding maps out as `promo_not_found` and never leaks that the
  // code exists.
  const allowed = promoAllowsCaller(p, input.caller)
  if (!allowed.ok) {
    return {
      kind: 'refuse',
      reason:
        allowed.reason === 'audience_mismatch' ? 'promo_audience_mismatch' : 'promo_not_found',
    }
  }
  // Re-validated from the transaction's OWN read set: the loader ran outside it,
  // so scope/window/status can have moved in between. Unreachable in normal
  // flow — an inapplicable code never produces a modifier and is never
  // reserved — this is the transaction's tripwire, not a user-facing outcome.
  if (!promoAppliesTo(p, input.scope)) return { kind: 'refuse', reason: 'promo_not_applicable' }
  if (!promoCurrencyMatches(p, input.chargeCurrency)) {
    return { kind: 'refuse', reason: 'promo_currency_mismatch' }
  }

  // Stale entries are dropped HERE, inside the write that is happening anyway.
  const live = promoLiveReservations(p, input.nowMs)

  const mine = live[input.reservationKey]
  if (mine) {
    // The retry path. Its contactId can only be this caller's — contactId's
    // identity is baked into the key's preimage.
    //
    // But the slot may back a payable session, and this attempt is about to mint
    // ANOTHER one. It may only proceed against the session it has already
    // closed: anything else means a sibling bound a session between the caller's
    // read and this transaction, and refreshing over it would put two payable
    // sessions behind one slot.
    if ((mine.sessionId ?? null) !== input.expectedSessionId) {
      return { kind: 'refuse', reason: 'promo_busy' }
    }
    return {
      kind: 'refresh',
      reservations: { ...live, [input.reservationKey]: input.reservation },
    }
  }

  const left = promoUsesLeft(p, input.nowMs, input.identityKey, input.perIdentityCommitted)
  if (left.global <= 0) return { kind: 'refuse', reason: 'promo_exhausted' }
  if (left.liveTotal >= PROMO_MAX_LIVE_RESERVATIONS) return { kind: 'refuse', reason: 'promo_busy' }
  if (left.perIdentity <= 0) return { kind: 'refuse', reason: 'promo_already_used' }

  return { kind: 'take', reservations: { ...live, [input.reservationKey]: input.reservation } }
}

/**
 * How a rail closes a superseded Checkout Session. Injected rather than imported
 * so this module stays free of Stripe and so the ordering below is testable, and
 * REQUIRED at every call site: a reserve that cannot close the session it is
 * superseding is a reserve that can put two payable sessions behind one slot.
 * The implementation is `closeTeamCheckoutSession` (connect/checkout.ts).
 */
export type CloseCheckoutSession = (sessionId: string) => Promise<'closed' | 'paid' | 'failed'>

/**
 * Take (or refresh) this caller's reservation on one use of one code. THROWS an
 * HttpsError carrying `details.reason` when it cannot — and that refusal must
 * refuse the CHECKOUT, never silently re-price it: the caller was quoted a
 * discount we can no longer honour.
 *
 * Returns THE TICKET, which is the only proof anything was reserved. Every later
 * operation on this reservation takes it, so a caller that did not reserve
 * cannot stamp, release or commit one.
 *
 * ── AT MOST ONE PAYABLE SESSION PER SLOT ────────────────────────────────────
 *
 * The reservation key is deterministic, so a retry refreshes the same entry —
 * load-bearing, and it survives. What did NOT survive is the assumption that one
 * entry therefore means one order: every retry mints a NEW Checkout Session while
 * refreshing the same entry, Stripe takes money for any session that has not
 * expired, and on the product and course rails a second payment is a second
 * GENUINE order rather than a duplicate the webhook refunds. A slot that can be
 * paid N times is not a cap, however carefully the counter is written.
 *
 * So the bound is on the thing that can take money. Before the entry is
 * refreshed, the session it is currently backing is CLOSED at Stripe:
 *
 *   closed  → proceed. Nothing can be paid against the old session.
 *   paid    → REFUSE (`promo_purchase_paid`) and write NOTHING. The money already
 *             moved on that session, so it — and not this attempt — owns the
 *             slot, and leaving the entry untouched is what lets its commit
 *             still count. A second discounted session for a purchase already
 *             paid for is exactly the over-issue Q9 forbids.
 *   failed  → REFUSE (`promo_busy`) and write NOTHING. Stripe could not tell us
 *             whether the old session is still payable, and "assume it is dead"
 *             is the assumption that costs a use. The session's own short expiry
 *             resolves this within the window; the message says so.
 *
 * The close is a network call and therefore outside the transaction, so the
 * transaction carries a COMPARE-AND-SET on `expectedSessionId` (see
 * `decidePromoReservation`) — a sibling that bound a session in between makes
 * this attempt `promo_busy` rather than a second live session.
 *
 * THE CUSTOMER-FACING TRADE, named rather than discovered: a buyer with an older
 * Stripe page still open in another tab loses it the moment they retry — the
 * newest attempt wins and the older page reports an expired session. That is the
 * same trade Stripe's own "expire the abandoned cart" pattern makes, and the
 * alternative is two live discounted carts for one slot, which is the breach.
 *
 * The entry is written with NO session; `attachPromoCheckoutSession` binds the
 * new one the moment it exists, and a bind that loses the entry expires the
 * session it just created (`bindPromoCheckoutSession`).
 *
 * A FRESH `instanceId` IS MINTED ON EVERY CALL, INCLUDING A REFRESH, and that is
 * the ownership half of the deterministic key: the newest attempt takes over the
 * slot, and the older sibling's release becomes a no-op instead of freeing a
 * reservation that is still guarding a payable session. The refresh itself is
 * unchanged — same key, nothing consumed from either cap.
 *
 * Serialisation: every reservation for one code both reads and writes the same
 * document, and Firestore read-write transactions are serializable, so two
 * transactions cannot commit against the same snapshot — the loser re-reads and
 * sees the winner's reservation in `live`. The promo document is therefore a hot
 * document while a campaign runs; at studio scale that is correct behaviour, not
 * a bottleneck. If a tenant ever needs more throughput than a few writes per
 * second on ONE code, the remedy is more codes, not a sharded counter.
 */
export async function reservePromoRedemption(params: {
  teamId: string
  code: string
  contactId: string
  identityKey: string
  reservationKey: string
  targetKey: string
  scope: PromoTargetScope
  caller: PromoCaller
  /** Bounded on both sides against the Checkout Session this guards. */
  expiresAt: Timestamp
  /** The quoted price, major units. AUDIT ONLY — never read for a decision; the
   *  price the caller was shown is enforced by the `quotedAmount` guard at the
   *  callable, before anything is reserved. */
  amountMajor: number
  baseAmount: number
  chargeCurrency?: string | null
  /** REQUIRED — see CloseCheckoutSession. */
  closeCheckoutSession: CloseCheckoutSession
}): Promise<PromoReservationTicket> {
  const db = admin.firestore()
  const ref = promoRef(params.teamId, params.code)
  const redRef = redemptionRef(params.teamId, params.code, params.identityKey)
  const instanceId = generateSecureToken(8)

  // ── Pre-flight: close whatever session this slot is currently backing. ──
  // Deliberately BEFORE the transaction and therefore before any write: every
  // refusal below leaves the existing entry exactly as it stands, so the attempt
  // that owns it keeps it and its commit still counts. Doing this after the
  // refresh would have stolen ownership from a session that then turned out to
  // be paid, and a genuine sale would have stopped counting.
  const preSnap = await ref.get()
  const previous = preSnap.exists
    ? promoLiveReservations(preSnap.data() as PromoCode, Date.now())[params.reservationKey]
    : undefined
  const expectedSessionId = previous?.sessionId ?? null
  if (expectedSessionId) {
    const outcome = await params.closeCheckoutSession(expectedSessionId)
    if (outcome === 'paid') {
      console.error(
        `[promo] refused a second discounted session for a PAID purchase ` +
          `(code=${normalizeRedemptionCode(params.code)} team=${params.teamId} ` +
          `reservation=${params.reservationKey} session=${expectedSessionId})`
      )
      throw reserveError('promo_purchase_paid')
    }
    if (outcome === 'failed') {
      // Loud, not swallowed: this is the one branch where we do not KNOW whether
      // a payable session is still out there, and the safe answer is to refuse.
      console.error(
        `[promo] could not close the superseded checkout session — refusing rather ` +
          `than risking two payable sessions on one slot ` +
          `(code=${normalizeRedemptionCode(params.code)} team=${params.teamId} ` +
          `reservation=${params.reservationKey} session=${expectedSessionId})`
      )
      throw reserveError('promo_busy')
    }
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const redSnap = await tx.get(redRef)
    const decision = decidePromoReservation({
      promo: snap.exists ? (snap.data() as PromoCode) : null,
      teamId: params.teamId,
      nowMs: Date.now(),
      scope: params.scope,
      caller: params.caller,
      identityKey: params.identityKey,
      reservationKey: params.reservationKey,
      perIdentityCommitted: (redSnap.data() as PromoRedemption | undefined)?.count ?? 0,
      chargeCurrency: params.chargeCurrency,
      expectedSessionId,
      reservation: {
        contactId: params.contactId,
        identityKey: params.identityKey,
        instanceId,
        // No session yet — this is the mid-flight state, and it is what the
        // compare-and-set above reads on a concurrent sibling.
        sessionId: null,
        expires_at: params.expiresAt,
        amountMajor: params.amountMajor,
        baseAmount: params.baseAmount,
        targetKey: params.targetKey,
      },
    })
    if (decision.kind === 'refuse') throw reserveError(decision.reason)

    // update(), never set(..., {merge:true}): a merge deep-merges the map and
    // resurrects every expired key this transaction just dropped, so cleanup and
    // releases would never persist. Same trap the gift-card holds map documents.
    tx.update(ref, {
      reservations: decision.reservations,
      updated_at: FieldValue.serverTimestamp(),
    })
  })

  return {
    code: normalizeRedemptionCode(params.code),
    reservationKey: params.reservationKey,
    identityKey: params.identityKey,
    instanceId,
    // The deadline this attempt wrote onto the entry — not a fresh computation.
    expiresAtMs: params.expiresAt.toMillis(),
  }
}

// ─── Bind the slot to the session it backs ──────────────────────────────────

/**
 * THE attach decision, pure. `null` means "not ours to bind" — the entry is gone
 * (lazy expiry, or the manager lever) or a newer attempt at the same purchase
 * has taken it. Both mean the session we just created must not be handed to the
 * buyer, because nothing is holding a use for it.
 */
export function decidePromoSessionAttach(input: {
  promo: Pick<PromoCode, 'reservations'>
  nowMs: number
  reservationKey: string
  instanceId: string
  sessionId: string
}): { reservations: Record<string, PromoReservation> } | null {
  const live = promoLiveReservations(input.promo, input.nowMs)
  const entry = live[input.reservationKey]
  if (!entry || entry.instanceId !== input.instanceId) return null
  live[input.reservationKey] = { ...entry, sessionId: input.sessionId }
  return { reservations: live }
}

/** Bind a freshly created Checkout Session to the slot this attempt holds.
 *  Returns false when the slot is no longer ours — see decidePromoSessionAttach. */
export async function attachPromoCheckoutSession(params: {
  teamId: string
  code: string
  reservationKey: string
  instanceId: string
  sessionId: string
}): Promise<boolean> {
  const db = admin.firestore()
  const ref = promoRef(params.teamId, params.code)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false
    const decision = decidePromoSessionAttach({
      promo: snap.data() as PromoCode,
      nowMs: Date.now(),
      reservationKey: params.reservationKey,
      instanceId: params.instanceId,
      sessionId: params.sessionId,
    })
    if (!decision) return false
    tx.update(ref, {
      reservations: decision.reservations,
      updated_at: FieldValue.serverTimestamp(),
    })
    return true
  })
}

/**
 * The rail-facing one-liner: bind the session that was just created to the slot,
 * or make sure that session can never take money.
 *
 * This is the third side of "at most one payable session per slot". The reserve
 * closes the old session and the compare-and-set stops a sibling binding one in
 * between — but a sibling that was ALREADY mid-flight (reserved, no session yet)
 * can still create its session after we took the entry from it. Its bind then
 * fails, and this is where that session dies. It has not been returned to any
 * client at that point (the URL is the last thing a callable hands back), so
 * closing it costs the buyer nothing.
 *
 * A close that itself fails is logged at ERROR and the checkout is STILL
 * refused: an unreturned Checkout Session URL is not reachable by a buyer, so the
 * residual is a dangling session that expires on its own schedule, not a payable
 * one. That is stated rather than assumed, because "it is fine, nobody has the
 * URL" is exactly the kind of reasoning that should be written down or not
 * relied on.
 *
 * No ticket ⇒ nothing was reserved ⇒ no-op, so every rail can call it
 * unconditionally.
 */
export async function bindPromoCheckoutSession(params: {
  teamId: string
  ticket: PromoReservationTicket | null
  sessionId: string
  closeCheckoutSession: CloseCheckoutSession
}): Promise<void> {
  const ticket = params.ticket
  if (!ticket) return
  const attached = await attachPromoCheckoutSession({
    teamId: params.teamId,
    code: ticket.code,
    reservationKey: ticket.reservationKey,
    instanceId: ticket.instanceId,
    sessionId: params.sessionId,
  }).catch((err) => {
    console.error(`[promo] attach threw (code=${ticket.code}):`, err)
    return false
  })
  if (attached) return

  const outcome = await params.closeCheckoutSession(params.sessionId)
  console.error(
    `[promo] the slot was taken while this checkout was being created — ` +
      `session closed=${outcome} (code=${ticket.code} team=${params.teamId} ` +
      `reservation=${ticket.reservationKey} instance=${ticket.instanceId} ` +
      `session=${params.sessionId})`
  )
  throw reserveError('promo_busy')
}

// ─── Commit ─────────────────────────────────────────────────────────────────

/** Why a completed checkout did NOT consume a use. Both values mean the same
 *  thing — this session no longer holds the slot it was quoted against — and
 *  they are separated because they say different things in a log line.
 *
 *  • `not_ours`      an entry is sitting at our key and it belongs to a NEWER
 *                    attempt at the same purchase. That attempt's session is the
 *                    one entitled to spend the slot.
 *  • `removed_early` no entry, and our own claim was not due to lapse yet — so
 *                    something took it: the newer sibling's commit already spent
 *                    it, the sibling's failure path released it, or a manager
 *                    cleared the campaign's reservations. */
export type PromoCommitLoss = 'not_ours' | 'removed_early'

export interface PromoCommitDecision {
  /** Whether this completed checkout consumes a use. FALSE when the slot it was
   *  quoted against is no longer this session's — see PromoCommitLoss. */
  counted: boolean
  /** ABSOLUTE, from the read set. Never FieldValue.increment. `null` when
   *  `counted` is false: nothing is written at all. */
  usageCount: number | null
  reservations: Record<string, PromoReservation>
  identityKey: string | null
  contactId: string | null
  amountMajor: number | null
  /** A live entry sits at our key. */
  reservationFound: boolean
  /** …and it is OURS (the instance matches), so the commit removed it. */
  reservationOwned: boolean
  /** Set iff `counted` is false because the slot was not ours. `null` when the
   *  slot WAS ours and the cap gate is what refused (see `overCap`). */
  lostTo: PromoCommitLoss | null
  /**
   * THE CAP GATE. Counting this sale would have pushed `usage_count` past
   * `max_uses`, so it is NOT counted — `counted` is false and `usageCount` is
   * null. Q9 is refuse, never over-issue, and a counter that can be talked past
   * by an unlucky delivery ordering is not a cap however loudly it complains.
   *
   * THE PRODUCT CONSEQUENCE, STATED RATHER THAN MADE SILENTLY: the buyer has
   * already paid the discounted price by the time this fires. This code does not
   * refund them and does not undo the sale — the goods/booking are theirs and the
   * money is the studio's. What it refuses is the BOOKKEEPING: the campaign does
   * not record a use it has no room for. So the honest description of the
   * residual is "a campaign can give one more discount than it counts", never "a
   * campaign can count more uses than it has", and this fires an ERROR log so the
   * studio's own reconciliation can see it. Honouring-and-not-counting is chosen
   * over refunding because a system-initiated refund of a completed, wanted
   * purchase is a worse surprise than a discount the studio gave one extra time.
   */
  overCap: boolean
}

/**
 * THE commit decision, pure, so the one-writer arithmetic is testable.
 *
 * ── ONE SLOT IS SPENT ONCE, WHATEVER THE ORDERING ───────────────────────────
 *
 * The reservation key is DETERMINISTIC, which is what makes a retry a refresh
 * rather than a second use — load-bearing, and it survives untouched. Its cost
 * is that one slot can be shared by MANY still-payable Checkout Sessions: every
 * retry mints a new session and refreshes the same entry, and Stripe will happily
 * take money for any session that has not expired. On the product and course
 * rails a second payment is not a duplicate to be refunded — it is a second
 * genuine order — so before this rule each of those sessions committed a use and
 * `usage_count` and `PromoRedemption.count` sailed past their caps with nothing
 * failing anywhere. Q9 is REFUSE, NEVER OVER-ISSUE, so that is not a residual to
 * accept; it is the invariant broken.
 *
 * The slot is therefore a single-use claim, and this function is where it is
 * spent. Three states, not two:
 *
 *   entry present AND ours          → SPEND it: count, and delete the entry.
 *   entry present, NOT ours         → a newer attempt holds the slot. Do not
 *                                     count, and do not touch its entry.
 *   entry absent                    → count ONLY if our own claim was already
 *                                     due to lapse (`reservationExpiresMs`).
 *                                     Inside our own window an absent entry
 *                                     means somebody took it — including the
 *                                     sibling that already spent it — so
 *                                     counting there is the same breach seen
 *                                     from the other ordering.
 *
 * ── WHY THE LAPSED CASE COUNTS, AND WHAT IT COSTS ───────────────────────────
 *
 * Stripe cannot take money for an EXPIRED session, so a payment whose delivery
 * lands after our deadline was made while the session was still open — and, with
 * one payable session per slot, that session was the slot's rightful owner. The
 * lapse only means the reservation's own backstop ran out first, which is now an
 * hour past the session rather than four minutes
 * (PROMO_RESERVATION_BACKSTOP_MINUTES), because the slot is normally freed by
 * `checkout.session.expired` within seconds instead.
 *
 * The residual it leaves is real and is not hidden: if the delivery is later than
 * even that backstop AND the freed slot has been re-handed and spent in the
 * meantime, this row and that other sale both want the same use. Counting both is
 * over-issue, so THE CAP GATE below refuses the second one outright. The campaign
 * therefore never counts past `max_uses` in ANY ordering; what it can do, in that
 * narrow ordering, is hand out one more discounted price than it counted.
 *
 * TWO THINGS ABOUT THAT RESIDUAL THAT ARE EASY TO OVERSTATE, so they are written
 * down rather than assumed:
 *
 *  • It is one extra discount PER OCCURRENCE, not one per campaign. Nothing here
 *    limits it to a single occurrence, and the occurrences are POSITIVELY
 *    CORRELATED, because "delivery more than an hour late" is normally a webhook
 *    outage rather than an independent coin flip — one outage can strand many
 *    paid sessions at once. What bounds the blast radius is not this code: it is
 *    that the SAME late event carries the sale's own confirmation, so a delivery
 *    regime bad enough to multiply this residual is one where bookings are not
 *    confirming and entitlements are not granting either. It cannot be a quiet
 *    promo-only leak.
 *  • The residual's ONLY log is the cap gate below. It is NOT also logged as
 *    `lostTo` — on that ordering `lostTo` is null by construction (the entry is
 *    absent AND our own deadline has passed, which is exactly the case that
 *    counts). `lostTo` covers different orderings, described next.
 *
 * The other cost is the mirror image: a sale we do not own is not counted, so a
 * code can UNDER-report. That is the safe direction under Q9 and it is loud
 * (`lostTo`, logged at ERROR by the caller) rather than silent.
 */
export function decidePromoCommit(input: {
  promo: PromoCode
  nowMs: number
  reservationKey: string
  /** OUR instance — which attempt at this purchase this session is. Absent means
   *  we can prove nothing, and an unprovable claim on a live entry is not ours. */
  instanceId?: string | null
  /** OUR OWN reservation deadline, epoch ms (the ticket's `expiresAtMs`, or the
   *  session's `promoExpires` metadata). REQUIRED — a call site that does not
   *  name it cannot compile, because omitting it silently restores the
   *  count-whatever-happened behaviour this rule replaces. `null` means no
   *  deadline is known, which is treated as "lapsed": every session this phase
   *  creates stamps one, so it is reachable only for a payload from outside. */
  reservationExpiresMs: number | null
  fallbackContactId?: string | null
  fallbackIdentityKey?: string | null
  fallbackAmountMajor?: number | null
}): PromoCommitDecision {
  const live = promoLiveReservations(input.promo, input.nowMs)
  const res = live[input.reservationKey]
  // OWNERSHIP, not merely presence. The key is shared by every attempt at one
  // purchase; the instance says which attempt is holding the slot right now.
  // Identity is still read off a sibling's entry: the identityKey is baked into
  // the key's preimage, so it is necessarily the same person and purchase.
  const reservationOwned = !!res && !!input.instanceId && res.instanceId === input.instanceId
  const lapsed = input.reservationExpiresMs == null || input.nowMs >= input.reservationExpiresMs
  const lostTo: PromoCommitLoss | null = reservationOwned
    ? null
    : res
      ? 'not_ours'
      : lapsed
        ? null
        : 'removed_early'
  const ownsTheClaim = lostTo === null

  // IDENTITY COMES FROM THE RESERVATION, not from the webhook. The callable that
  // minted it knew exactly who was buying; the webhook only knows what survived
  // — `verifiedMetadataContact` returns null whenever the contact document is
  // gone (a guest whose provisional contact was purged overnight), and this
  // value is the DOC ID of a durable ledger.
  const identityKey = res?.identityKey ?? input.fallbackIdentityKey ?? null
  const contactId = res?.contactId ?? input.fallbackContactId ?? null
  const amountMajor =
    res?.amountMajor ??
    (typeof input.fallbackAmountMajor === 'number' && Number.isFinite(input.fallbackAmountMajor)
      ? input.fallbackAmountMajor
      : null)

  // THE CAP GATE — a HARD bound, and the last one. Everything above bounds how
  // many slots exist and who may spend one; this bounds the counter itself, so
  // no ordering anywhere (a late webhook against a re-handed slot, a manager
  // release that hands live slots away, a document restored from a backup) can
  // walk `usage_count` past `max_uses`. It is depth, not the mechanism: if it
  // ever fires, something above it is broken, and the ERROR log says so.
  const provisionalCount = ownsTheClaim ? (input.promo.usage_count ?? 0) + 1 : null
  const overCap =
    provisionalCount != null &&
    input.promo.max_uses != null &&
    provisionalCount > input.promo.max_uses
  const counted = ownsTheClaim && !overCap
  const usageCount = counted ? provisionalCount : null
  // Only a spent slot is cleared. A refusal — lost OR over cap — writes nothing
  // at all, so the entry stays put and keeps consuming global headroom rather
  // than being handed to yet another buyer.
  if (counted && reservationOwned) delete live[input.reservationKey]

  return {
    counted,
    usageCount,
    reservations: live,
    identityKey,
    contactId,
    amountMajor,
    reservationFound: !!res,
    reservationOwned,
    lostTo,
    overCap,
  }
}

/**
 * The per-person half of the cap gate, pure. `true` ⇒ recording one more
 * redemption for this identity would breach `max_uses_per_contact`.
 *
 * It reads the cap EXACTLY as `promoUsesLeft` does — absent ⇒ the default of 1,
 * explicit `null` ⇒ unlimited — because a gate that disagreed with the reserve
 * about what the cap IS would be the two-answers-to-one-question defect again,
 * just at the other end of the lifecycle.
 */
export function promoPerIdentityCapExceeded(
  promo: Pick<PromoCode, 'max_uses_per_contact'>,
  existingCount: number
): boolean {
  const cap =
    promo.max_uses_per_contact === undefined
      ? PROMO_DEFAULT_MAX_USES_PER_CONTACT
      : (promo.max_uses_per_contact ?? Infinity)
  return existingCount + 1 > cap
}

/**
 * Consume one use. AFTER CREATION, THE ONLY WRITER of `usage_count` and
 * `PromoRedemption.count` (`createPromoCode` stamps the initial zero and nothing
 * else touches either field).
 *
 * Called at each webhook handler's per-kind CONFIRM point and inside the THREE
 * gift-card full-cover branches — `createDropInCheckout` (booking/dropIn.ts),
 * `createProductCheckout` and `createCourseCheckout` (connect/payments.ts).
 * Nowhere else, and NEVER on a branch that refunds the whole charge. (Three, not
 * four: the appointment rail takes no gift card, so it has no full-cover branch
 * to commit from — its only commit is the webhook's confirm point.)
 *
 * ONCE-ONLY comes from the callers, not from a marker on the document:
 *  • the Stripe path claims `connect_webhook_events/{eventId}` with .create()
 *    BEFORE dispatching, and a Checkout Session completes exactly once;
 *  • the full-cover path runs synchronously inside a callable whose booking
 *    write already refuses a second attempt.
 * A per-reservation `committed` marker was tried and dropped: it is what made
 * the document unbounded, and it would have collided with the deterministic
 * reservation key on a second legitimate purchase of the same target.
 *
 * It commits even when the reservation is already gone, PROVIDED our own claim
 * on the slot had lapsed: the reservation outlives the Checkout Session by
 * design, so an absence after our deadline means a genuinely LATE delivery of a
 * payment that did happen. An absence BEFORE it means the slot was taken from us
 * — see `decidePromoCommit`, where the one-slot-one-use rule lives.
 *
 * AND IT IS A GATE, not only a writer. BOTH counters are hard-bounded here:
 * `usage_count` against `max_uses` (in `decidePromoCommit`) and
 * `PromoRedemption.count` against `max_uses_per_contact` (below, once the ledger
 * row has been read). A commit that would breach either writes NOTHING — not the
 * counter, not the ledger, not the reservations map — and logs at ERROR. The
 * buyer keeps what they paid for; the campaign does not record a use it has no
 * room for. See `PromoCommitDecision.overCap` for why honour-and-don't-count
 * rather than refund.
 */
export async function commitPromoRedemption(params: {
  teamId: string
  code: string
  reservationKey: string
  /** OUR instance (PromoReservationTicket.instanceId, or the Checkout Session's
   *  `promoInstance` metadata). Only the attempt that holds the slot may spend
   *  it, and only it may delete the entry. */
  instanceId?: string | null
  /** OUR reservation deadline, epoch ms (PromoReservationTicket.expiresAtMs, or
   *  the session's `promoExpires` metadata). Required — see decidePromoCommit. */
  reservationExpiresMs: number | null
  /** Fallbacks ONLY — the reservation is authoritative for identity. */
  fallbackContactId?: string | null
  fallbackIdentityKey?: string | null
  fallbackAmountMajor?: number | null
  targetKind?: PromoScopeKind
  /** The STRIPE Checkout Session this commit is settling, for the ERROR logs
   *  only — never read for a decision. Absent on the gift-card full-cover
   *  branches, which create no Stripe session at all; that absence is itself the
   *  answer to "which session was this?" and is logged as `full_cover`.
   *
   *  It is here because the two ERROR logs below are the ONLY trace the accepted
   *  residual leaves, and a log that cannot be joined to a payment is not a
   *  reconciliation trail. Deliberately NOT `md.sessionId` on the drop-in and
   *  appointment rails — that is OUR class/appointment session, a different
   *  thing with the same name. */
  checkoutSessionId?: string | null
}): Promise<{
  committed: boolean
  reservationFound: boolean
  /** The cap gate refused this sale, and which cap did it. `null` when nothing
   *  was over cap (whether or not the sale counted). */
  overCap: 'global' | 'per_identity' | null
  lostTo: PromoCommitLoss | null
}> {
  const db = admin.firestore()
  const ref = promoRef(params.teamId, params.code)

  const result = await db.runTransaction(async (tx) => {
    // ALL READS BEFORE WRITES. The redemption row's id comes out of the promo
    // document (the reservation names the identity), so the two gets are
    // necessarily sequential — still two single-document reads, still no query.
    const snap = await tx.get(ref)
    if (!snap.exists || snap.data()?.teamId !== params.teamId) {
      return {
        committed: false,
        reservationFound: false,
        overCap: null as 'global' | 'per_identity' | null,
        identityKey: null,
        contactId: null as string | null,
        lostTo: null,
      }
    }
    const promo = snap.data() as PromoCode
    const nowMs = Date.now()
    const decision = decidePromoCommit({
      promo,
      nowMs,
      reservationKey: params.reservationKey,
      instanceId: params.instanceId,
      reservationExpiresMs: params.reservationExpiresMs,
      fallbackContactId: params.fallbackContactId,
      fallbackIdentityKey: params.fallbackIdentityKey,
      fallbackAmountMajor: params.fallbackAmountMajor,
    })

    // NOT OURS TO SPEND, or over the global cap. Write NOTHING — not the counter,
    // not the ledger row, and above all not the reservations map, whose entry may
    // be guarding the sibling session that IS entitled to spend it.
    if (!decision.counted) {
      return {
        committed: false,
        reservationFound: decision.reservationFound,
        overCap: (decision.overCap ? 'global' : null) as 'global' | 'per_identity' | null,
        identityKey: decision.identityKey,
        contactId: decision.contactId,
        lostTo: decision.lostTo,
      }
    }

    let existingCount = 0
    let firstAt: Timestamp | null = null
    const redRef = decision.identityKey
      ? redemptionRef(params.teamId, params.code, decision.identityKey)
      : null
    if (redRef) {
      const redSnap = await tx.get(redRef)
      const existing = redSnap.data() as PromoRedemption | undefined
      existingCount = existing?.count ?? 0
      firstAt = (existing?.first_at as Timestamp | undefined) ?? null
    }

    // THE SECOND HALF OF THE CAP GATE, and it has to live here rather than in
    // `decidePromoCommit`: the ledger row's id comes OUT of the promo document
    // (the reservation names the identity), so it cannot be read any earlier.
    // Same rule, same direction — a commit that would push this person past
    // `max_uses_per_contact` writes nothing at all, including the global counter,
    // because a sale the per-person ledger refuses to record is not a sale the
    // global counter should claim either.
    if (redRef && promoPerIdentityCapExceeded(promo, existingCount)) {
      return {
        committed: false,
        reservationFound: decision.reservationFound,
        overCap: 'per_identity' as 'global' | 'per_identity' | null,
        identityKey: decision.identityKey,
        contactId: decision.contactId,
        lostTo: null as PromoCommitLoss | null,
      }
    }

    tx.update(ref, {
      usage_count: decision.usageCount,
      reservations: decision.reservations,
      updated_at: FieldValue.serverTimestamp(),
    })
    if (redRef && decision.identityKey) {
      tx.set(
        redRef,
        {
          teamId: params.teamId,
          code: normalizeRedemptionCode(params.code),
          identityKey: decision.identityKey,
          contactId: decision.contactId,
          count: existingCount + 1,
          first_at: firstAt ?? Timestamp.fromMillis(nowMs),
          last_at: Timestamp.fromMillis(nowMs),
          ...(decision.amountMajor != null ? { last_amount_major: decision.amountMajor } : {}),
          ...(params.targetKind ? { last_target: params.targetKind } : {}),
        },
        { merge: true }
      )
    }
    return {
      committed: true,
      reservationFound: decision.reservationFound,
      overCap: null as 'global' | 'per_identity' | null,
      identityKey: decision.identityKey,
      contactId: decision.contactId,
      lostTo: null as PromoCommitLoss | null,
    }
  })

  if (result.committed && !result.identityKey) {
    // The global count must not silently under-report just because one person
    // became unidentifiable — but the per-person ledger row cannot be written
    // without an id, so this is loud.
    console.error(
      `[promo] committed ${normalizeRedemptionCode(params.code)} with NO identity ` +
        `(team=${params.teamId} reservation=${params.reservationKey}) — per-person ledger row skipped`
    )
  }
  // WHO AND WHICH, on both refusal logs. These two lines are the ONLY trace
  // either refusal leaves — the accepted residual has no other record anywhere —
  // and a studio reconciling "we gave one more discount than we counted" needs to
  // find the buyer and the payment, not just the campaign. `identity` is the
  // redemption row's doc id (so it addresses `redemptions/{identity}` directly),
  // `contact` is the contact document, `session` is the Stripe Checkout Session.
  const who =
    `team=${params.teamId} contact=${result.contactId ?? 'unknown'} ` +
    `identity=${result.identityKey ?? 'unknown'} ` +
    `session=${params.checkoutSessionId ?? 'full_cover'} ` +
    `reservation=${params.reservationKey} instance=${params.instanceId ?? 'none'}`
  if (result.lostTo) {
    // THE SYSTEM NOTICES. A completed, paid checkout that consumed no use means
    // two sessions shared one reservation slot — the buyer got the discounted
    // price on both, and only one of them was ever entitled to it. The count is
    // correct and the campaign is intact; the sale is not attributed to the code.
    //
    // This is NOT the accepted residual's log. `lostTo` requires an entry at OUR
    // key held by another attempt (`not_ours`) or an entry gone before our own
    // deadline (`removed_early`); the residual's ordering has neither — its entry
    // lapsed after our deadline, which is precisely the case that counts. The
    // residual's only log is the cap gate below.
    console.error(
      `[promo] a paid checkout did NOT consume a use of ${normalizeRedemptionCode(params.code)} ` +
        `(${who} lostTo=${result.lostTo}) — ` +
        `the slot is held by another attempt at the same purchase, or was cleared`
    )
  }
  if (result.overCap) {
    // THE CAP GATE FIRED, which means something above it let a slot be spent
    // twice — the one narrow ordering left is a `checkout.session.completed`
    // delivered more than PROMO_RESERVATION_BACKSTOP_MINUTES after its session
    // expired, against a slot that lazily lapsed and was re-handed. The counter
    // is intact; the buyer keeps the discounted purchase they paid for; the
    // campaign gave one more discount than it recorded. That last sentence is the
    // whole reason this is ERROR and names the money.
    //
    // THIS IS THE ACCEPTED RESIDUAL'S ONLY LOG, and one line is emitted per
    // occurrence — the residual is one extra discount PER occurrence, not one per
    // campaign, so counting these lines is how a studio learns how many.
    console.error(
      `[promo] CAP GATE: refused to count a paid checkout of ` +
        `${normalizeRedemptionCode(params.code)} — it would have breached ` +
        `${result.overCap === 'global' ? 'max_uses' : 'max_uses_per_contact'} ` +
        `(${who}). The buyer WAS charged the ` +
        `discounted price and keeps the purchase; the use is not recorded.`
    )
  }
  return {
    committed: result.committed,
    reservationFound: result.reservationFound,
    overCap: result.overCap,
    lostTo: result.lostTo,
  }
}

// ─── Release ────────────────────────────────────────────────────────────────

/**
 * THE release decision, pure, so the ownership rule is testable without an
 * emulator. `null` means "nothing to do" — no entry, or an entry that is not
 * ours.
 *
 * WHY OWNERSHIP AND NOT MERELY PRESENCE. The reservation key is DETERMINISTIC,
 * which is exactly what makes a retry a refresh rather than a second use — that
 * property is load-bearing and must survive. Its cost is that every attempt at
 * one purchase addresses the SAME map entry, so "delete the entry at this key"
 * is an operation any sibling attempt can perform on any other:
 *
 *   attempt A reserves (instance 1) → Stripe session A
 *   attempt B refreshes (instance 2) → Stripe session B, still payable
 *   session A expires → handleCheckoutExpired releases … and, without this
 *   check, deletes the entry guarding B.
 *
 * The slot is then unguarded while B can still be paid, so the code can be
 * reserved past `max_uses` — and Q9 is REFUSE, NEVER OVER-ISSUE. The same shape
 * fires for a later failed retry whose catch releases after the successful
 * attempt has already refreshed the entry.
 *
 * So the fix is not a unique key (that would destroy the refresh property); it
 * is that the deleter must prove it owns what it is deleting, compared INSIDE
 * the transaction against the entry as it stands right now.
 *
 * A stored entry with no `instanceId` is unreachable — every reserve writes one
 * — and is treated as not-ours rather than as a free-for-all: lazy expiry
 * removes it a few minutes later, and over-holding a slot is the safe direction.
 */
export function decidePromoRelease(input: {
  promo: Pick<PromoCode, 'reservations'>
  nowMs: number
  reservationKey: string
  instanceId?: string | null
}): { reservations: Record<string, PromoReservation> } | null {
  const live = promoLiveReservations(input.promo, input.nowMs)
  const entry = live[input.reservationKey]
  if (!entry) return null
  if (!input.instanceId || entry.instanceId !== input.instanceId) return null
  delete live[input.reservationKey]
  return { reservations: live }
}

/** Give one reservation back rather than waiting for its lazy expiry — but only
 *  OUR reservation (see decidePromoRelease). `tx.get` + `tx.update`; a missing
 *  document, a missing key or a key a newer attempt now owns are all no-ops, so
 *  it stays idempotent and safe to call from every failure path. */
export async function releasePromoReservation(params: {
  teamId: string
  code: string
  reservationKey: string
  instanceId?: string | null
}): Promise<void> {
  const db = admin.firestore()
  const ref = promoRef(params.teamId, params.code)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return
    const decision = decidePromoRelease({
      promo: snap.data() as PromoCode,
      nowMs: Date.now(),
      reservationKey: params.reservationKey,
      instanceId: params.instanceId,
    })
    if (!decision) return
    tx.update(ref, {
      reservations: decision.reservations,
      updated_at: FieldValue.serverTimestamp(),
    })
  })
}

/**
 * THE manager lever: clear EVERY live reservation on one code.
 *
 * "The code says exhausted but nothing sold" is the support ticket this feature
 * will generate most — a burst of abandoned carts, a studio testing its own
 * code, a `promo_busy` ceiling hit — and without a lever the answer is "wait".
 * It writes only the `reservations` map and NEVER `usage_count`, so it is not a
 * second counter writer.
 *
 * It is also the ONE deliberate exemption from the ownership rule: a manager
 * clearing a stuck code is saying "drop every claim on this campaign", which is
 * precisely an operation no instance owns. The honest consequence, since the
 * commit now spends a slot only while it still holds it: a checkout that was
 * holding one of these and then pays inside its own window records the sale and
 * the money, but consumes NO use, and logs `lostTo: 'removed_early'`. That is
 * the direction Q9 requires — the manager has just handed those slots to other
 * customers, so counting them again is exactly how the cap gets exceeded.
 *
 * It does NOT close the sessions those slots were backing, and that is
 * deliberate: those buyers are mid-checkout for a purchase they still want, and
 * cancelling their carts to tidy a counter is the wrong trade. So this lever is
 * the one route by which more discounted sessions than slots can be live at
 * once — which is exactly why `commitPromoRedemption`'s CAP GATE exists and why
 * it names this lever in its ERROR line.
 *
 * The manager-facing callable that wraps this (with assertManager) is P3-J's;
 * the engine lives here beside the reserve it undoes.
 */
export async function releaseAllPromoReservations(params: {
  teamId: string
  code: string
}): Promise<{ released: number }> {
  const db = admin.firestore()
  const ref = promoRef(params.teamId, params.code)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.data()?.teamId !== params.teamId) return { released: 0 }
    const live = promoLiveReservations(snap.data() as PromoCode, Date.now())
    tx.update(ref, { reservations: {}, updated_at: FieldValue.serverTimestamp() })
    return { released: Object.keys(live).length }
  })
}

// ─── The webhook's two entry points ─────────────────────────────────────────

/** Checkout metadata → the promo lifecycle, or nothing. Kept here so the four
 *  confirm points in the webhook are one line each and cannot drift on which
 *  keys they read. */
function promoFromMetadata(md: Record<string, string>): {
  code: string
  reservationKey: string
  /** Which attempt's reservation this session is holding — the ownership half of
   *  the deterministic key, and what the release and the commit compare before
   *  touching anything. */
  instanceId: string | null
  /** When that attempt's claim on the slot was due to lapse. The other half of
   *  ownership: it is how the commit tells a late delivery of a payment we DID
   *  own from a slot that was taken from us while it should still have been ours. */
  expiresAtMs: number | null
  identityKey: string | null
  amountMajor: number | null
} | null {
  // Both keys are stamped together by promoCheckoutMetadata, and ONLY from a
  // ticket — so their presence here is the webhook's proof that a reservation
  // was actually taken, not merely that a code was typed.
  if (!md.promoCode || !md.promoReservation) return null
  const amount = Number(md.promoAmount)
  const expires = Number(md.promoExpires)
  return {
    code: md.promoCode,
    reservationKey: md.promoReservation,
    instanceId: md.promoInstance || null,
    expiresAtMs: md.promoExpires && Number.isFinite(expires) ? expires : null,
    identityKey: md.promoIdentity || null,
    amountMajor: Number.isFinite(amount) ? amount : null,
  }
}

/**
 * Commit the promo carried by a completed checkout. BEST-EFFORT: a promo commit
 * that throws must not stop a booking from confirming — the customer paid the
 * discounted price and owning the seat matters more than the count. The cost is
 * a reservation that lapses instead of committing, which under-reports by one:
 * the safe direction, since a lapsed reservation frees a slot while a lost
 * booking does not come back.
 *
 * Call it ONLY where the sale is confirmed. Never before the per-kind dispatch.
 */
export async function commitPromoFromMetadata(params: {
  teamId: string
  md: Record<string, string>
  targetKind: PromoScopeKind
  /** The webhook's re-verified contact, used only if the reservation is gone. */
  fallbackContactId?: string | null
  /** The STRIPE Checkout Session id (`session.id`), for the refusal logs only.
   *  NOT `md.sessionId`, which on the drop-in and appointment rails is our own
   *  class/appointment session — a different thing with the same name. */
  checkoutSessionId?: string | null
}): Promise<void> {
  const promo = promoFromMetadata(params.md)
  if (!promo) return
  try {
    await commitPromoRedemption({
      teamId: params.teamId,
      code: promo.code,
      reservationKey: promo.reservationKey,
      instanceId: promo.instanceId,
      checkoutSessionId: params.checkoutSessionId ?? null,
      // THIS session's own claim deadline — not "now plus something". Only the
      // attempt that still holds the slot may spend it.
      reservationExpiresMs: promo.expiresAtMs,
      fallbackIdentityKey: promo.identityKey,
      fallbackContactId: params.fallbackContactId ?? null,
      fallbackAmountMajor: promo.amountMajor,
      targetKind: params.targetKind,
    })
  } catch (err) {
    console.error(`[promo] commit failed (code=${promo.code}):`, err)
  }
}

/** Release the promo carried by an EXPIRED checkout, for any kind.
 *
 *  THE PRIMARY RELEASE PATH. `checkout.session.expired` is positive evidence
 *  that this session can never take money again, which is the only evidence that
 *  makes re-handing its slot safe. Lazy expiry sits an hour further out
 *  (PROMO_RESERVATION_BACKSTOP_MINUTES) as the backstop for a lost event, rather
 *  than racing Stripe's own delivery of the OTHER event that decides the same
 *  slot.
 *
 *  Best-effort, and instance-guarded — THIS is the caller that check exists for.
 *  Stripe expires abandoned sessions on its own schedule, so an expiry for a
 *  SUPERSEDED sibling session routinely arrives after the buyer's live retry has
 *  refreshed the same deterministic key. (A superseded session is now usually
 *  expired by US, at the refresh, which produces exactly the same event and the
 *  same harmless no-op.) */
export async function releasePromoFromMetadata(md: Record<string, string>): Promise<void> {
  const promo = promoFromMetadata(md)
  if (!promo || !md.teamId) return
  try {
    await releasePromoReservation({
      teamId: md.teamId,
      code: promo.code,
      reservationKey: promo.reservationKey,
      instanceId: promo.instanceId,
    })
  } catch (err) {
    console.error(`[promo] reservation release failed (code=${promo.code}):`, err)
  }
}


// ─── previewPromoCode — the public quote ────────────────────────────────────

type PreviewInput = {
  teamId?: string
  code?: string
  target?: {
    kind?: PromoScopeKind
    sessionId?: string
    activityId?: string
    providerId?: string
    startMs?: number
    durationMinutes?: number
    courseId?: string
    productId?: string
    variantId?: string
    trial?: boolean
  }
}

/**
 * The refusal vocabulary a preview can return.
 *
 * `exhausted` / `busy` / `already_used` are AVAILABILITY answers and are
 * ADVISORY — the reserve transaction is the authority and may still refuse at
 * pay time, so every mount must handle a refusal when the visitor PAYS, not only
 * when they apply. The PRICE, by contrast, is AUTHORITATIVE: `quotedAmount` is
 * the figure the client sends back as `quotedAmount` at checkout, which is what
 * turns "the preview and the checkout disagreed" from a silent overcharge into
 * an explicit `price_changed` refusal.
 */
type PreviewRefusal = PromoLoadRefusal | 'exhausted' | 'busy' | 'already_used'

/**
 * One rail, loaded ONCE: its server-resolved target (never the client's copy of
 * an entity id — the scope allow-lists are checked against what the session
 * actually points at) plus a closure that prices it.
 *
 * Loading before the promo is deliberate: the scope check needs the real
 * `activityId`, and a drop-in preview only knows the sessionId.
 */
interface PreviewRail {
  target: PromoQuoteTarget
  price(promo: PromoModifier): Promise<PaymentOptionsResult | null>
}

/**
 * Quote what a code does to ONE purchase, for THIS caller, right now.
 *
 * It builds its target and its snapshot through the SAME helpers the
 * corresponding callable uses — `buildDropInTarget` + `resolveDropInForContact`
 * with `usageAt = session.start`, `loadAppointmentBookingContext`,
 * `loadCoursePricing`, `resolveProductPrice`. That is a hard requirement (N22),
 * not tidiness: `createDropInCheckout` meters usage limits against the class's
 * OWN week, so a preview metering against `now` would quote a discounted drop-in
 * to a "3 per week" member booking nine days out — and the checkout would then
 * refuse them with "You can already book this class for free". Quoted a price
 * for a class they can have for nothing, then refused.
 *
 * It reads main collections through the Admin SDK, like `checkGiftCard`: the
 * "public routes read only public_profile" rule binds the CLIENT, not a
 * callable. And it charges its OWN rate-limit bucket — unlike a waitlist claim,
 * whose token is unguessable and single-use, a promo preview is an enumeration
 * surface, so every attempt must cost quota.
 */
export const previewPromoCode = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'previewPromoCode')
  const data = (request.data ?? {}) as PreviewInput
  if (!data.teamId || !data.code) {
    throw new HttpsError('invalid-argument', 'teamId and code are required')
  }
  const teamId = data.teamId
  await checkoutRateLimit(request.rawRequest?.ip, 'promo-check')

  const db = admin.firestore()

  // The caller, if they hold a contact session. An anonymous caller still gets a
  // PRICE but no per-person availability answer: an anonymous probe is the
  // cheapest way to test a code, and it is also the only way a genuine guest can
  // see a price before typing their name.
  const contactSession = optionalContactSessionFromRequest(request)
  let contact: (FirebaseFirestore.DocumentData & { id: string }) | null = null
  if (contactSession && contactSession.teamId === teamId) {
    const cSnap = await db.collection('contacts').doc(contactSession.contactId).get()
    if (cSnap.exists && cSnap.data()?.teamId === teamId) {
      contact = { ...cSnap.data()!, id: cSnap.id }
    }
  }
  // Through the shared resolver like every checkout rail, so a preview cannot
  // answer the audience question differently from the pay button. With a contact
  // session it short-circuits on that document; with only a signed-in email and
  // no session it resolves that email, which is the manager-testing-their-own-code
  // case. Anonymous (no session, no email) still previews the PRICE — deliberate,
  // and the only way a genuine guest sees a figure before typing their name.
  const caller = await resolvePromoCaller({
    teamId,
    contact,
    email: (request.auth?.token?.email as string | undefined) ?? null,
    codeTyped: true,
  })

  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  if (!teamSnap.exists) throw new HttpsError('not-found', 'Team not found')
  const chargeCurrency = giftCardCurrency(teamSnap.data()?.default_currency as string | undefined)

  const rail = await loadPreviewRail({ teamId, input: data, contact })
  if (!rail) return { valid: false as const, reason: 'not_applicable' as PreviewRefusal }

  const loaded = await loadPromoForTarget({
    teamId,
    code: data.code,
    scope: promoScopeOf(rail.target),
    caller,
    chargeCurrency,
  })
  if (!loaded.ok) return { valid: false as const, reason: loaded.reason as PreviewRefusal }
  const code = loaded.modifier.code

  // ── Availability peek, only when we know who is asking ──
  if (caller.email || caller.contactId) {
    const identityKey = promoIdentityKey(
      { email: caller.email, contactId: caller.contactId ?? '' },
      sha256Hex
    )
    const reservationKey = promoReservationKey(
      { code, identityKey, targetKey: promoTargetKey(rail.target) },
      sha256Hex
    )
    const redSnap = await redemptionRef(teamId, code, identityKey).get()
    const left = promoUsesLeft(
      loaded.promo,
      Date.now(),
      identityKey,
      (redSnap.data() as PromoRedemption | undefined)?.count ?? 0,
      // The caller's OWN reservation must not count against them. Without this
      // exclusion, someone who reached Stripe and came back would be told they
      // had already used the code — for the purchase they are still holding.
      reservationKey
    )
    if (left.global <= 0) return { valid: false as const, reason: 'exhausted' as PreviewRefusal }
    if (left.liveTotal >= PROMO_MAX_LIVE_RESERVATIONS) {
      return { valid: false as const, reason: 'busy' as PreviewRefusal }
    }
    if (left.perIdentity <= 0) {
      return { valid: false as const, reason: 'already_used' as PreviewRefusal }
    }
  }

  // ── The price ──
  const priced = await rail.price(loaded.modifier)
  const outcome = priced?.promo
  if (!priced || !outcome || outcome.status === 'not_applicable') {
    return { valid: false as const, reason: 'not_applicable' as PreviewRefusal }
  }

  const pay = priced.options.find((o) => o.type === 'pay')
  const baseAmount =
    pay?.appliedPromo?.baseAmount ?? pay?.appliedBenefit?.baseAmount ?? pay?.amount ?? null

  return {
    valid: true as const,
    code,
    effect: loaded.modifier.effect,
    ...(typeof loaded.modifier.percent === 'number' ? { percent: loaded.modifier.percent } : {}),
    ...(typeof loaded.modifier.amount === 'number' ? { amount: loaded.modifier.amount } : {}),
    baseAmount,
    quotedAmount: pay?.amount ?? null,
    outcome: outcome.status,
    // `by` is READ from the resolver, never re-derived by the client from two
    // numbers: "your member price is already lower than this code" and "this
    // code does not lower this price" are different sentences.
    ...(outcome.status === 'superseded' ? { by: outcome.by } : {}),
  }
})

/** Validate the payload, load the rail's documents once, and hand back a
 *  server-resolved target plus its pricing closure. Null ⇒ this rail has no
 *  priced door at all here, which the preview reports as `not_applicable`. */
async function loadPreviewRail(params: {
  teamId: string
  input: PreviewInput
  contact: (FirebaseFirestore.DocumentData & { id: string }) | null
}): Promise<PreviewRail | null> {
  const { teamId, contact } = params
  const t = params.input.target ?? {}
  const db = admin.firestore()

  switch (t.kind) {
    case 'drop_in': {
      if (!t.sessionId) throw new HttpsError('invalid-argument', 'target.sessionId is required')
      const sessionSnap = await db.collection('sessions').doc(t.sessionId).get()
      if (!sessionSnap.exists || sessionSnap.data()?.teamId !== teamId) return null
      const sessionData = sessionSnap.data()!
      if (sessionData.activityType === 'appointment') return null
      const activityId = sessionData.activityId as string | undefined
      if (!activityId) return null
      const actSnap = await db.collection('activities').doc(activityId).get()
      if (!actSnap.exists) return null
      // The studio default, for a class that follows it — the same settings
      // read createDropInCheckout makes, so a quote and a charge resolve the
      // same price.
      const door = buildDropInTarget(
        actSnap.data()!,
        { asTrial: t.trial === true },
        studioDropInOf(await loadBookingSettings(teamId))
      )
      if (!door.ok) return null
      // The class's OWN start — the divergence N22 exists to prevent.
      const usageAt = (sessionData.start as Timestamp | undefined)?.toDate()
      const sessionId = t.sessionId
      return {
        target: { kind: 'drop_in', sessionId, activityId, trial: t.trial === true },
        price: (promo) =>
          contact
            ? resolveDropInForContact(teamId, door.target, contact, usageAt, { promo })
            : Promise.resolve(resolvePaymentOptions(GUEST_SNAPSHOT, door.target, { promo })),
      }
    }

    case 'appointment': {
      if (
        !t.providerId ||
        !t.activityId ||
        typeof t.startMs !== 'number' ||
        typeof t.durationMinutes !== 'number'
      ) {
        throw new HttpsError(
          'invalid-argument',
          'target.providerId, target.activityId, target.startMs and target.durationMinutes are required'
        )
      }
      const target: PromoQuoteTarget = {
        kind: 'appointment',
        providerId: t.providerId,
        activityId: t.activityId,
        startMs: t.startMs,
        durationMinutes: t.durationMinutes,
      }
      const ctx = await loadAppointmentBookingContext({
        teamId,
        providerId: t.providerId,
        activityId: t.activityId,
        startMs: t.startMs,
        durationMinutes: t.durationMinutes,
      })
      // Only a 'priced' length has a price a code could modify: a free one has
      // nothing to discount, and a benefit_only one (UX-70) is not sold here at
      // all — quoting it would invent an individual price the studio removed.
      if (resolveDurationSale(ctx.chosenDuration).mode !== 'priced') return null
      const benefit = ctx.activity.memberBenefit ?? null
      return {
        target,
        price: async (promo) => {
          // Exactly createAppointmentCheckout's snapshot: appointments have no
          // access gate, so only the benefit's types are relevant.
          const snapshot = contact
            ? await loadContactPaymentSnapshot({
                teamId,
                contact,
                relevantTypeIds: benefit?.subscriptionTypeIds ?? [],
              })
            : GUEST_SNAPSHOT
          return resolvePaymentOptions(
            snapshot,
            { kind: 'appointment', duration: ctx.chosenDuration, benefit },
            { promo }
          )
        },
      }
    }

    case 'course': {
      if (!t.courseId) throw new HttpsError('invalid-argument', 'target.courseId is required')
      const courseId = t.courseId
      const pricing = await loadCoursePricing({
        teamId,
        courseId,
        contactId: contact?.id ?? null,
      })
      return {
        target: { kind: 'course', courseId },
        price: (promo) =>
          Promise.resolve(resolvePaymentOptions(pricing.snapshot, pricing.target, { promo })),
      }
    }

    case 'product': {
      if (!t.productId) throw new HttpsError('invalid-argument', 'target.productId is required')
      const productId = t.productId
      const variantId = t.variantId ?? null
      const productSnap = await db
        .collection(TEAMS_COLLECTION)
        .doc(teamId)
        .collection(PRODUCTS_SUBCOLLECTION)
        .doc(productId)
        .get()
      if (!productSnap.exists) return null
      const product = productSnap.data() as Product
      if (product.active === false) return null
      if (variantId) {
        const variant = (product.variants ?? []).find((v) => v.id === variantId)
        if (!variant || variant.active === false) return null
      }
      return {
        target: { kind: 'product', productId, variantId },
        // GUEST_SNAPSHOT is correct here for the same reason it is correct in
        // createProductCheckout, and for the same reason it is not laziness: the
        // product arm never covers, never denies, and `Product` carries no
        // benefit, so it is snapshot-INVARIANT. The AUDIENCE gate is a separate
        // question and lives in the loader, which read the caller's contact.
        price: (promo) =>
          Promise.resolve(
            resolvePaymentOptions(
              GUEST_SNAPSHOT,
              {
                kind: 'product',
                priceAmount: resolveProductPrice(product, variantId ?? undefined),
                benefit: null,
              },
              { promo }
            )
          ),
      }
    }

    default:
      throw new HttpsError('invalid-argument', 'target.kind is required')
  }
}

// ─── Manager callables ──────────────────────────────────────────────────────
//
// WHY CALLABLES AND NOT CLIENT WRITES. Products are authored content with no
// global counter, so they take the client-`addDoc` route. A promo carries
// `usage_count`, a `max_uses` cap and a plan-tiered creation gate, and a client
// write bypasses all three — "these fields yes, that field no" rules are exactly
// the fragile surface every coded instrument in this codebase has avoided
// (`gift_cards` and `referral_codes` both deny client writes outright).
//
// THE GATE IS ON CREATION ONLY. A team that downgrades, or uninstalls the
// promo-codes plugin, keeps its live codes previewable, reservable, committable
// and releasable — a visitor part-way through a checkout did nothing wrong, and
// a studio winding a campaign down still needs to manage what it issued.
// `createPromoCode` is the only function in this file that gates at all.

const MAX_LABEL_LEN = 80
// Shared with the admin form (@linyup/shared) rather than declared twice: the
// truncation below is silent, so a form that did not know the number would let
// a manager tick items that never reach the document.
const MAX_SCOPE_IDS = PROMO_MAX_SCOPE_IDS

/** Every authored refusal carries a `details.reason` the admin form renders.
 *  The client validates the same rules first, so these are the backstop a
 *  hand-made request or a race would hit — never the normal path. */
function authoringError(reason: string, message: string): HttpsError {
  return new HttpsError('invalid-argument', message, { reason })
}

const SCOPE_KINDS: readonly PromoScopeKind[] = ['drop_in', 'appointment', 'course', 'product']

function requireTeamId(data: { teamId?: string } | undefined): string {
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  return data.teamId
}

/** The same bar `issueGiftCard` / `voidGiftCard` set: whoever may destroy a
 *  card's value may also mint a discount. The audit fields stamped at creation
 *  are what makes it attributable. */
function requireAuthedManager(
  request: { auth?: { uid: string } | null },
  teamId: string
): Promise<void> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  return assertManager(request.auth.uid, teamId)
}

/** Normalise + format-check the authored code. The gift-card namespace is
 *  refused here as well as in the preview, so a studio can never mint a promo
 *  that shadows it and turns a visitor's real gift card into "invalid code". */
function requireAuthoredCode(raw: unknown): string {
  const code = normalizeRedemptionCode(typeof raw === 'string' ? raw : '')
  if (looksLikeGiftCardCode(code)) {
    throw authoringError('looks_like_gift_card', 'A promo code may not start with GC-')
  }
  if (!isValidPromoCodeFormat(code)) {
    throw authoringError('code_format_invalid', 'Use 3-24 letters, digits or hyphens')
  }
  return code
}

/** The optional window, as ONE decision so `until <= from` cannot be authored:
 *  a window that can never open is a support ticket, not data. */
function resolveWindow(input: Record<string, unknown>): {
  valid_from: Timestamp | null
  valid_until: Timestamp | null
} {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const fromMs = num(input.validFromMs)
  const untilMs = num(input.validUntilMs)
  if (fromMs != null && untilMs != null && untilMs <= fromMs) {
    throw authoringError('window_invalid', 'The end of the window must be after its start')
  }
  return {
    valid_from: fromMs != null ? Timestamp.fromMillis(fromMs) : null,
    valid_until: untilMs != null ? Timestamp.fromMillis(untilMs) : null,
  }
}

/** The discount itself. AUTHORED values THROW rather than clamp — the resolver's
 *  clamp exists for arithmetic-derived prices, and silently rewriting a
 *  manager's typo into a different discount is how a campaign ships wrong. */
function resolveEffect(input: Record<string, unknown>): {
  effect: PromoEffect
  percent?: number
  amount?: number
} {
  if (input.effect === 'percent_off') {
    const percent = input.percent
    // 100 is deliberately inexpressible: a free purchase would need a
    // payment-less confirm path on every rail. The resolver's `>= 100` clamp
    // survives only as the backstop for legacy hand-written benefit data.
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 99) {
      throw authoringError('percent_invalid', 'Percent must be a whole number between 1 and 99')
    }
    return { effect: 'percent_off', percent }
  }
  if (input.effect === 'fixed_price') {
    // Validator ONLY — the MINOR-unit return is deliberately discarded, exactly
    // as `issueGiftCard` and the drop-in base-price pre-flight use it. Calling
    // it enforces the identical 0.50 floor every authored price throws on.
    requireChargeableAmountFromMajor(input.amount)
    return { effect: 'fixed_price', amount: input.amount as number }
  }
  throw authoringError('effect_invalid', "effect must be 'percent_off' or 'fixed_price'")
}

/**
 * The GLOBAL cap, and it is REQUIRED — `null` is accepted only when the caller
 * sends it explicitly.
 *
 * The reason is the fastest path through the create form. Made optional it
 * defaults to "no limit", and combined with the per-person default of 1 that
 * produces an UNCAPPED code each person may use once — precisely the shape a
 * leaked WhatsApp message turns into unbounded liability, with no notification
 * anywhere in this phase that would ever surface it.
 */
function resolveMaxUses(data: Record<string, unknown>): number | null {
  if (!('maxUses' in data)) {
    throw authoringError('max_uses_required', 'A total limit is required, or "no limit" explicitly')
  }
  const v = data.maxUses
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw authoringError('max_uses_required', 'The total limit must be a whole number of at least 1')
  }
  return v
}

function resolvePerContact(v: unknown): number | null {
  if (v === undefined) return PROMO_DEFAULT_MAX_USES_PER_CONTACT
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw authoringError(
      'per_contact_invalid',
      'The per-person limit must be a whole number of at least 1'
    )
  }
  return v
}

function resolveScope(data: Record<string, unknown>): {
  applies_to: PromoScopeKind[]
  activity_ids: string[] | null
  course_ids: string[] | null
  product_ids: string[] | null
} {
  const raw = Array.isArray(data.appliesTo) ? (data.appliesTo as unknown[]) : []
  const applies_to = SCOPE_KINDS.filter((k) => raw.includes(k))
  if (applies_to.length === 0) {
    throw authoringError('scope_required', 'Choose at least one thing the code applies to')
  }
  const ids = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null
    const list = v
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .slice(0, MAX_SCOPE_IDS)
    // An EMPTY allow-list means "everything of these kinds" (promoAppliesTo's
    // rule), so it is stored as null rather than as [] — one representation per
    // meaning, and the reserve transaction reads the same helper.
    return list.length ? list : null
  }
  return {
    applies_to,
    activity_ids: ids(data.activityIds),
    course_ids: ids(data.courseIds),
    product_ids: ids(data.productIds),
  }
}

function resolveAudience(v: unknown): PromoAudience {
  if (v === undefined || v === null || v === 'all') return 'all'
  if (v === 'new_contacts') return 'new_contacts'
  throw authoringError('audience_invalid', "audience must be 'all' or 'new_contacts'")
}

/** A binding names ONE person, so the contact must exist and be this team's —
 *  the same tenant check `issueGiftCard` runs on its purchaser link. */
async function resolveRestrictToContact(teamId: string, v: unknown): Promise<string | null> {
  if (typeof v !== 'string' || !v.trim()) return null
  const cid = v.trim()
  const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(cid).get()
  if (!snap.exists || snap.data()?.teamId !== teamId || snap.data()?.deleted_at != null) {
    throw authoringError('contact_invalid', 'Contact does not belong to this team')
  }
  return cid
}

function resolveLabel(v: unknown): string | null {
  return typeof v === 'string' ? v.trim().slice(0, MAX_LABEL_LEN) || null : null
}

/** How many ACTIVE codes the team holds. A single-field equality query, which
 *  Firestore indexes automatically — no composite, and deliberately no entry in
 *  `firestore.index.json` (gift cards have none, for the same reason). */
async function countActivePromoCodes(teamId: string): Promise<number> {
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(PROMO_CODES_SUBCOLLECTION)
    .where('status', '==', 'active')
    .get()
  return snap.size
}

async function assertUnderActiveCap(teamId: string): Promise<void> {
  const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  if (!teamSnap.exists) throw new HttpsError('not-found', 'Team not found')
  const limits = getPromoCodeLimits((teamSnap.data()?.plan as SaasPlan | undefined) ?? 'free')
  if ((await countActivePromoCodes(teamId)) >= limits.maxActiveCodes) {
    throw new HttpsError('resource-exhausted', 'The active promo-code limit is reached', {
      reason: 'cap_reached',
      max: limits.maxActiveCodes,
    })
  }
}

export const createPromoCode = onCall(async (request) => {
  const data = (request.data ?? {}) as Record<string, unknown> & { teamId?: string }
  const teamId = requireTeamId(data)
  await requireAuthedManager(request, teamId)
  // CREATION ONLY, and ONE door. The plan requirement moved into the plugin
  // manifest's `minPlan: 'studio'`, so `requirePlan(teamId, 'studio')` is gone
  // from here: stacking it on the install gate would mean a Studio user could be
  // refused by either and get a different explanation each time. Install state
  // is the single runtime answer, matching every other plugin-delivered feature.
  //
  // PROMO_CODE_LIMITS survives as the ceiling (0/0/20/100) — a cap, not a door.
  await assertPluginInstalled(teamId, 'promo-codes')
  await assertUnderActiveCap(teamId)

  const db = admin.firestore()
  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  const code = requireAuthoredCode(data.code)
  const now = Timestamp.now()

  const doc: PromoCode = {
    code,
    teamId,
    status: 'active',
    ...resolveEffect(data),
    // Stamped at creation, guarded at reserve time for fixed_price ONLY: a
    // percentage has no currency, but a fixed price is an authored money amount
    // read at one moment and applied at another.
    currency: giftCardCurrency(teamSnap.data()?.default_currency as string | undefined),
    ...resolveWindow(data),
    max_uses: resolveMaxUses(data),
    max_uses_per_contact: resolvePerContact(data.maxUsesPerContact),
    restrict_to_contact_id: await resolveRestrictToContact(teamId, data.restrictToContactId),
    // Stamped EXPLICITLY even when it is the default, so a stored document is
    // self-describing rather than relying on a reader knowing what absent means.
    audience: resolveAudience(data.audience),
    usage_count: 0,
    ...resolveScope(data),
    label: resolveLabel(data.label),
    created_at: now,
    updated_at: now,
    created_by: request.auth?.uid ?? null,
    created_by_name: (request.auth?.token?.name as string | undefined) ?? null,
  }

  // .create(), and ALREADY_EXISTS is a USER-FACING REFUSAL, never a retry with a
  // different code. A gift card's code is GENERATED, so minting a new one on
  // collision is right; a promo code is CHOSEN by a manager, and silently
  // storing SUMMER26-X7 would put a code on the flyer that nobody can redeem.
  try {
    await promoRef(teamId, code).create(doc as FirebaseFirestore.DocumentData)
  } catch (err) {
    if ((err as { code?: number })?.code === 6) {
      throw new HttpsError('already-exists', 'That code already exists', { reason: 'code_taken' })
    }
    throw err
  }
  return { code }
})

export const updatePromoCode = onCall(async (request) => {
  const data = (request.data ?? {}) as Record<string, unknown> & { teamId?: string }
  const teamId = requireTeamId(data)
  await requireAuthedManager(request, teamId)

  const code = requireAuthoredCode(data.code)
  const ref = promoRef(teamId, code)
  const snap = await ref.get()
  if (!snap.exists || snap.data()?.teamId !== teamId) {
    throw new HttpsError('not-found', 'We could not find that code.', { reason: 'promo_not_found' })
  }

  // The DEFINITION only. `usage_count` and `reservations` are absent from this
  // object by construction rather than by a filter someone could widen: the
  // counter has exactly one writer (commitPromoRedemption) and the reservations
  // map has three (reserve / commit / release), all transactional.
  const patch: Record<string, unknown> = {
    ...resolveEffect(data),
    ...resolveWindow(data),
    max_uses: resolveMaxUses(data),
    max_uses_per_contact: resolvePerContact(data.maxUsesPerContact),
    restrict_to_contact_id: await resolveRestrictToContact(teamId, data.restrictToContactId),
    audience: resolveAudience(data.audience),
    ...resolveScope(data),
    label: resolveLabel(data.label),
    updated_at: FieldValue.serverTimestamp(),
  }
  // Switching effect must not leave the other effect's parameter behind, or a
  // later reader sees a percent_off code still carrying an `amount`.
  patch.percent = patch.percent ?? FieldValue.delete()
  patch.amount = patch.amount ?? FieldValue.delete()

  await ref.update(patch)
  return { ok: true }
})

/**
 * Disable (or re-enable) a code. A disabled code stops taking NEW reservations;
 * live ones still complete, and its redemption ledger survives.
 *
 * There is deliberately NO delete: deleting the document would orphan every
 * in-flight checkout holding a reservation on it, and destroy the audit record
 * that is the only place a promo is recorded at all (it writes no journal row).
 */
export const setPromoCodeStatus = onCall(async (request) => {
  const data = (request.data ?? {}) as { teamId?: string; code?: string; status?: string }
  const teamId = requireTeamId(data)
  await requireAuthedManager(request, teamId)
  if (data.status !== 'active' && data.status !== 'disabled') {
    throw authoringError('status_invalid', "status must be 'active' or 'disabled'")
  }
  const code = requireAuthoredCode(data.code)
  const ref = promoRef(teamId, code)
  const snap = await ref.get()
  if (!snap.exists || snap.data()?.teamId !== teamId) {
    throw new HttpsError('not-found', 'We could not find that code.', { reason: 'promo_not_found' })
  }
  // Re-enabling counts against the cap too, or the cap is one
  // disable-and-re-enable away from meaningless.
  if (data.status === 'active' && snap.data()?.status !== 'active') {
    await assertUnderActiveCap(teamId)
  }
  await ref.update({
    status: data.status,
    disabled_at: data.status === 'disabled' ? FieldValue.serverTimestamp() : null,
    updated_at: FieldValue.serverTimestamp(),
  })
  return { ok: true }
})

/**
 * MANAGER CORRECTION 1 — forgive ONE person's per-code bar.
 *
 * Takes `{ code, contactId }` OR `{ code, email }` and resolves the SAME
 * identity key from either, because the ledger is keyed on a hash of the
 * normalised email: a manager looking at a booking has a contact, a manager
 * reading a support email has an address.
 *
 * It deletes one `redemptions/{identityKey}` document and NEVER touches
 * `usage_count` — this forgives the per-person cap, it does not give the
 * campaign a use back. That is how the global counter stays down to one writer
 * while the feature still has a support story.
 */
export const clearPromoRedemption = onCall(async (request) => {
  const data = (request.data ?? {}) as {
    teamId?: string
    code?: string
    contactId?: string
    email?: string
  }
  const teamId = requireTeamId(data)
  await requireAuthedManager(request, teamId)
  const code = requireAuthoredCode(data.code)

  let email = data.email ?? null
  const contactId = data.contactId ?? ''
  if (!email && contactId) {
    const cSnap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).get()
    if (cSnap.exists && cSnap.data()?.teamId === teamId) {
      email = (cSnap.data()?.email as string | undefined) ?? null
    }
  }
  if (!email && !contactId) {
    throw authoringError('identity_required', 'A contact or an email address is required')
  }
  await redemptionRef(teamId, code, promoIdentityKey({ email, contactId }, sha256Hex)).delete()
  return { ok: true }
})

/**
 * MANAGER CORRECTION 2 — the stuck-code lever.
 *
 * "The code says exhausted but nothing sold" is the support ticket this feature
 * generates most: a burst of abandoned carts, a studio testing its own code, a
 * `promo_busy` ceiling hit. Without a lever the answer is "wait for the
 * reservations to lapse".
 *
 * Like clearPromoRedemption it is a DELETE of lifecycle state, never an
 * adjustment of a counter: it writes only the `reservations` map.
 */
export const releasePromoReservations = onCall(async (request) => {
  const data = (request.data ?? {}) as { teamId?: string; code?: string }
  const teamId = requireTeamId(data)
  await requireAuthedManager(request, teamId)
  const code = requireAuthoredCode(data.code)
  return releaseAllPromoReservations({ teamId, code })
})
