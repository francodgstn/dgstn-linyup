/* eslint-disable no-console */
// Gift cards (E3) — CODE-based stored value: teams/{teamId}/gift_cards/{code}.
// The public checkout (createGiftCardCheckout) mints nothing itself — a card is
// minted by the webhook (handleGiftCardCheckout in ./webhook.ts) once payment is
// confirmed. This file owns:
//  • createGiftCardCheckout — the public purchase callable.
//  • issueGiftCard — the manager mint (front desk sells for cash, or comps a
//    card). Serialised by a gift_card_issues claim doc, NOT by a query.
//  • mintGiftCard — the collision-safe, idempotent-by-payment-intent minting
//    helper both of those rails call.
//  • reserveGiftCardDrawdown / commitGiftCardDrawdown / reverseGiftCardDrawdown
//    / releaseGiftCardHold — the hold lifecycle shared by every one-off
//    checkout that accepts a `giftCardCode` (product, course, drop-in — see
//    their call sites). commitGiftCardDrawdown is the ONLY exported commit:
//    spending stored value and reclassifying it in the journal are one
//    operation, and nothing outside this file may do the first without the
//    second.
//  • checkGiftCard / voidGiftCard — public balance check + manager void;
//    voidUntouchedGiftCard / voidGiftCardValue serve the refund + chargeback
//    paths in connect/refunds.ts and the dispute webhook.
//
// Holds are a map field on the card doc (keyed by a fresh id the caller mints),
// NOT a subcollection — they can't be queried directly. Expiry is therefore
// LAZY: giftCardAvailable() (shared, pure) simply ignores holds whose
// expires_at has passed when computing available balance, and every
// transaction in this file opportunistically drops expired holds it happens to
// see while it already has the doc loaded. There is no sweep job for gift-card
// holds — see dailyTasks/expirePendingBookings.ts's doc comment, which only
// covers the booking-hold shapes.

import crypto from 'crypto'
import * as admin from 'firebase-admin'
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  GIFT_CARDS_SUBCOLLECTION,
  GIFT_CARD_ISSUES_SUBCOLLECTION,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  applyGiftCardCommit,
  buildGiftCardReclassTxns,
  formatGiftCardCode,
  giftCardAvailable,
  normalizeEmail,
  normalizeRedemptionCode,
  planGiftCardRedemption,
  resolveStripeCurrency,
  round2Major,
  toMinorUnits,
  type FinanceCategory,
  type GiftCard,
  type GiftCardCommittedHold,
  type GiftCardHold,
  type GiftCardIssueKind,
  type GiftCardRedemptionPlan,
  type GiftCardSettings,
  type GiftCardStatus,
} from '@linyup/shared'
import { assertManager, loadEnabledTeam, requireChargeableAccount } from './access'
import {
  buildResultUrls,
  checkoutRateLimit,
  defaultIdempotencyKey,
  requireChargeableAmountFromMajor,
  startOneOffCheckout,
} from './checkout'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import { recordGiftCardReclass } from '../finance/journal'
import { writeManualPaymentEvent } from '../payments/recordManualPayment'
import { APP_CHECK_ENFORCE, monitorAppCheck } from '../utils/appCheck'
import { assertPluginInstalled } from '../utils/plugins'

/** Fallback ONLY, for a caller with no Checkout Session behind its hold. Every
 *  money path passes `holdMinutes` derived from the session it is guarding
 *  (resolveCheckoutHoldWindow in ./checkout.ts) — this constant was that
 *  derivation's answer back when every session was ~31 minutes, and it silently
 *  became wrong the moment a waitlist claim made the session length variable. */
const DEFAULT_HOLD_MINUTES = 35
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** A fat-fingered comp must not be able to mint arbitrary stored value: a
 *  manager mint has no gateway between it and a live balance. */
const MAX_ISSUE_AMOUNT_MAJOR = 10_000
const MAX_ISSUE_REASON_LEN = 200

const round2 = round2Major

/** Codes are case/space-insensitive to the buyer; the doc id is always the
 *  canonical uppercase form formatGiftCardCode produces. Delegates to the ONE
 *  shared normaliser (shared/utils/codes.ts) so gift cards and promo codes can
 *  never fork on what "the same code" means — both key a document on it. */
function normalizeCode(code: string): string {
  return normalizeRedemptionCode(code)
}

function cardRef(teamId: string, code: string): FirebaseFirestore.DocumentReference {
  return admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(GIFT_CARDS_SUBCOLLECTION)
    .doc(normalizeCode(code))
}

/** Drop any holds whose expires_at has passed. Called from inside a
 *  transaction that already has the card loaded — piggybacks the cleanup onto
 *  a write that's happening anyway rather than a dedicated sweep. */
function dropExpiredHolds(
  holds: Record<string, GiftCardHold> | undefined,
  nowMs: number
): Record<string, GiftCardHold> {
  const out: Record<string, GiftCardHold> = {}
  for (const [key, hold] of Object.entries(holds ?? {})) {
    if (hold.expires_at.toMillis() > nowMs) out[key] = hold
  }
  return out
}

/** THE currency a card is minted in and redeemable against — always the
 *  currency the rail actually charges in, never a caller-supplied string: a
 *  card denominated in a currency nothing can charge is unredeemable stored
 *  value. resolveStripeCurrency is CHF-pinned today (see
 *  shared/types/currency.ts), so widening the rail widens cards in the same
 *  one-line change instead of leaving the two to drift apart. */
export function giftCardCurrency(teamDefaultCurrency?: string | null): string {
  return resolveStripeCurrency(teamDefaultCurrency).toUpperCase()
}

// ─────────────────────────────────────────────────────────────────────────────
// mintGiftCard — called by the webhook once a gift-card checkout is paid, and
// by issueGiftCard once a manager's claim has won.
// ─────────────────────────────────────────────────────────────────────────────
export async function mintGiftCard(params: {
  teamId: string
  amount: number // major units
  currency: string
  purchaserContactId?: string | null
  purchaserEmail?: string | null
  /** Null on a rail with no Stripe charge behind it (a manager-issued card).
   *  Such a mint MUST bring its own serialisation — see the guard below. */
  paymentIntentId: string | null
  /** The gift_card_issues claim that serialised a manager mint. Stamped for
   *  audit only — never queried: the claim doc, not this field, is what makes
   *  the mint idempotent. */
  issueRef?: string
  issueKind?: GiftCardIssueKind
  issuedBy?: string
  issuedByName?: string | null
  issueReason?: string | null
}): Promise<GiftCard> {
  const db = admin.firestore()
  const col = db.collection(TEAMS_COLLECTION).doc(params.teamId).collection(GIFT_CARDS_SUBCOLLECTION)

  // Idempotency: a card may already have been minted for this payment intent
  // (webhook redelivery / crash-safe reprocessing) — never mint a second one.
  // Only meaningful WITH an intent: `where('payment_intent_id','==',null)`
  // matches every card minted off the Stripe rail — including the seeded demo
  // card — and would hand somebody else's card back as "already minted".
  if (params.paymentIntentId) {
    const existing = await col
      .where('payment_intent_id', '==', params.paymentIntentId)
      .limit(1)
      .get()
    if (!existing.empty) return existing.docs[0].data() as GiftCard
  }

  const now = FieldValue.serverTimestamp()
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = formatGiftCardCode(crypto.randomBytes(8))
    const ref = col.doc(code)
    const card: GiftCard = {
      code,
      teamId: params.teamId,
      amount: params.amount,
      balance: params.amount,
      currency: params.currency,
      status: 'active',
      purchaserContactId: params.purchaserContactId ?? null,
      purchaserEmail: params.purchaserEmail ?? null,
      payment_intent_id: params.paymentIntentId ?? null,
      issue_kind: params.issueKind ?? 'purchase',
      issued_by: params.issuedBy ?? null,
      issued_by_name: params.issuedByName ?? null,
      issue_reason: params.issueReason ?? null,
      issue_ref: params.issueRef ?? null,
    }
    try {
      await ref.create({ ...card, created_at: now, updated_at: now, issued_at: now })
      return card
    } catch (err: unknown) {
      lastErr = err
      // ALREADY_EXISTS (code 6) — code collision, try another one.
      if ((err as { code?: number }).code === 6) continue
      throw err
    }
  }
  console.error(`[giftCards] mint failed after 3 collision retries (team=${params.teamId}):`, lastErr)
  throw new HttpsError('internal', 'Failed to create the gift card')
}

// ─────────────────────────────────────────────────────────────────────────────
// Hold lifecycle — reserve at checkout time, commit on payment success, release
// on checkout expiry (or by finding no hold at commit time — see commit below).
// ─────────────────────────────────────────────────────────────────────────────

/** Reserve a drawdown against a card's available balance. Throws `not-found`
 *  for an invalid/void/other-team code, and `failed-precondition` (reason:
 *  'gift_card_unusable') when the card can't cover any usable amount. */
export async function reserveGiftCardDrawdown(params: {
  teamId: string
  code: string
  totalMajor: number
  /** Minted by the CALLER (generateSecureToken(16)) before any Stripe session
   *  exists — the reservation has to succeed or fail before a session is worth
   *  creating. It travels to the webhook in checkout metadata as
   *  `giftCardHold`. */
  holdKey: string
  /** How long the hold lives. MUST come from resolveCheckoutHoldWindow
   *  (./checkout.ts), derived from the very instant this checkout's Stripe
   *  session expires at, so the hold always outlives the payment window. A hold
   *  that dies first frees the value for another purchase while the original is
   *  still payable. Optional only so a caller with no session can compile. */
  holdMinutes?: number
  /** Currency of the charge this drawdown is being applied to. A card may only
   *  pay for a charge in its OWN currency — see the guard below. Optional so
   *  existing callers compile, but every money path should pass it. */
  chargeCurrency?: string | null
}): Promise<GiftCardRedemptionPlan> {
  const db = admin.firestore()
  const ref = cardRef(params.teamId, params.code)
  const holdMinutes = params.holdMinutes ?? DEFAULT_HOLD_MINUTES

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.data()?.teamId !== params.teamId) {
      throw new HttpsError('not-found', 'Gift card not found')
    }
    const card = snap.data() as GiftCard
    const nowMs = Date.now()

    // A card may only pay for a charge in its OWN currency.
    //
    // Everything downstream — planGiftCardRedemption, the residual, the reclass
    // pair — is pure NUMBER math with no currency in it. Without this guard a
    // EUR 100 card silently pays a CHF 100 charge unit-for-unit, converting at
    // 1:1. That is reachable today via seeded lead profiles (scripts/seed-lead.ts
    // writes `currency: profile.currency`), and becomes production-reachable the
    // moment `resolveStripeCurrency` stops returning a constant — which its own
    // comment advertises as a one-line change. This is the tripwire that makes
    // that change safe to land.
    //
    // Compared case-insensitively: cards store 'CHF', Stripe speaks 'chf'.
    const cardCurrency = (card.currency ?? '').toUpperCase()
    const wantedCurrency = (params.chargeCurrency ?? '').toUpperCase()
    if (wantedCurrency && cardCurrency && wantedCurrency !== cardCurrency) {
      throw new HttpsError(
        'failed-precondition',
        'This gift card is in a different currency to this purchase.',
        { reason: 'gift_card_currency_mismatch', cardCurrency, chargeCurrency: wantedCurrency }
      )
    }

    const holds = dropExpiredHolds(card.holds, nowMs)

    const available = giftCardAvailable({ ...card, holds }, nowMs)
    const plan = planGiftCardRedemption(available, params.totalMajor)
    if (!plan) {
      throw new HttpsError('failed-precondition', 'Gift card cannot be used for this amount', {
        reason: 'gift_card_unusable',
      })
    }

    holds[params.holdKey] = {
      amount: plan.drawdown,
      expires_at: Timestamp.fromMillis(nowMs + holdMinutes * 60_000),
    }
    // update() REPLACES the holds map wholesale — set(..., {merge:true}) would
    // deep-merge it and resurrect every key we dropped (expired-hold cleanup
    // and releases would never persist).
    tx.update(ref, { holds, updated_at: FieldValue.serverTimestamp() })
    return plan
  })
}

/** How long a committed-hold marker is kept. Long enough to outlive any late
 *  webhook redelivery and the refund window that reads it; short enough that a
 *  card redeemed weekly for years can't grow an unbounded map field. */
const COMMITTED_HOLD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Drop committed-hold markers past the retention window — the same
 *  piggyback-on-a-write-that's-happening-anyway idiom as dropExpiredHolds. */
function pruneCommittedHolds(
  committed: Record<string, GiftCardCommittedHold> | undefined,
  nowMs: number
): Record<string, GiftCardCommittedHold> {
  const cutoff = nowMs - COMMITTED_HOLD_RETENTION_MS
  const out: Record<string, GiftCardCommittedHold> = {}
  for (const [key, entry] of Object.entries(committed ?? {})) {
    // An entry we can't date is KEPT: a marker is a double-spend stop, so the
    // failure mode of guessing wrong is spending the same value twice.
    const atMs = typeof entry?.at?.toMillis === 'function' ? entry.at.toMillis() : nowMs
    if (atMs > cutoff) out[key] = entry
  }
  return out
}

/** Field path for a marker's reclass stamp. Built as a FieldPath, not a dotted
 *  string, so a hold key containing a '.' or '`' could never rewrite a
 *  different field. */
function reclassedAtPath(holdKey: string): FieldPath {
  return new FieldPath('committed_holds', holdKey, 'reclassed_at')
}

interface CommitOutcome {
  /** What actually moved off the card (major units) — never the request. */
  committedMajor: number
  /** The CARD's currency: the reclass pair must be denominated in it. */
  currency: string
  issueKind: GiftCardIssueKind
  /** This hold key had already been committed — nothing moved on this call. */
  replay: boolean
  /** The reclass pair for this hold is already on disk. */
  reclassed: boolean
}

/** The money half of a commit, in ONE transaction on the card doc: subtract the
 *  drawdown, drop the hold, and mark the hold key as spent. Returns null when
 *  the card is gone. Private on purpose — commitGiftCardDrawdown is the only
 *  caller, so no path can move stored value without also reclassifying it.
 *
 *  When the hold is MISSING but the caller knows the drawdown (webhook
 *  metadata), the amount is deducted anyway — a payment that lands after the
 *  35-minute hold expiry must still draw the card down, or the buyer keeps
 *  stored value they already spent. That fallback is exactly why the
 *  committed_holds marker exists: see its doc comment in @linyup/shared. */
async function commitHoldTx(params: {
  teamId: string
  code: string
  holdKey: string
  fallbackAmountMajor?: number
}): Promise<CommitOutcome | null> {
  const db = admin.firestore()
  const ref = cardRef(params.teamId, params.code)

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null // card gone — nothing to commit
    const card = snap.data() as GiftCard
    const nowMs = Date.now()
    const currency = card.currency
    const issueKind = card.issue_kind ?? 'purchase'

    const already = card.committed_holds?.[params.holdKey]
    if (already) {
      // Replay: this drawdown is already off the card. Return WITHOUT writing —
      // there is no other write to piggyback the pruning onto, and a redelivered
      // webhook shouldn't cost a write just to tidy a map.
      return {
        committedMajor: already.amountMajor,
        currency,
        issueKind,
        replay: true,
        reclassed: already.reclassed_at != null,
      }
    }

    const holds = dropExpiredHolds(card.holds, nowMs)
    const committed = pruneCommittedHolds(card.committed_holds, nowMs)
    const hold = holds[params.holdKey]

    const amount = hold?.amount ?? params.fallbackAmountMajor
    if (typeof amount !== 'number') {
      // No hold, no known drawdown — nothing safe to commit; still persist any
      // lazy-expired cleanup we computed.
      tx.update(ref, { holds, committed_holds: committed, updated_at: FieldValue.serverTimestamp() })
      return { committedMajor: 0, currency, issueKind, replay: false, reclassed: false }
    }

    delete holds[params.holdKey]
    const { newBalanceMajor, committedMajor } = applyGiftCardCommit(card.balance, amount)
    // The marker records the MOVEMENT, so a later reversal gives back exactly
    // what was taken rather than what the caller once asked for.
    committed[params.holdKey] = { amountMajor: committedMajor, at: Timestamp.fromMillis(nowMs) }
    // update() replaces both maps wholesale (merge would resurrect dropped
    // keys) — see reserveGiftCardDrawdown.
    tx.update(ref, {
      holds,
      committed_holds: committed,
      balance: newBalanceMajor,
      status: newBalanceMajor <= 0 ? 'depleted' : card.status,
      updated_at: FieldValue.serverTimestamp(),
    })
    return { committedMajor, currency, issueKind, replay: false, reclassed: false }
  })
}

/**
 * THE way a gift-card drawdown is committed. Every rail that can spend stored
 * value goes through here — the partial-redemption webhook and all three
 * full-cover callables — because committing is never just a balance write:
 *
 *  1. the money moves (commitHoldTx, above) — this step MAY throw, it is the
 *     only step that can leave the customer's balance wrong;
 *  2. the payment row learns which card funded it, so a refund can give the
 *     value back (refundMemberPayment had no way to know until this existed);
 *  3. the journal is reclassified (recordGiftCardReclass) so the revenue lands
 *     in the category that was actually bought.
 *
 * Steps 2 and 3 are best-effort and NEVER throw: they run after the goods have
 * been delivered, and finance/journal.ts is explicit that a journal failure must
 * not break payment processing. A missed pair is repaired from the
 * `committed_holds[holdKey].reclassed_at` marker, which is why the marker
 * exists in addition to the rows.
 *
 * Splitting this back into "commit here, journal there" is how the four call
 * sites drift apart: adjustment rows are invisible to reconciliationCheck
 * (it counts only 'charge' rows), so a site that forgot to reclassify would
 * mis-state revenue with nothing to detect it.
 */
export async function commitGiftCardDrawdown(params: {
  teamId: string
  code: string
  holdKey: string
  /** Reserved drawdown from checkout metadata — the late-commit fallback. */
  fallbackAmountMajor?: number
  /** The category the redeemed value should be attributed to. */
  targetCategory: FinanceCategory
  contactId?: string | null
  /** The member_payments doc to stamp, when this redemption had a Stripe
   *  residual. Absent on the full-cover paths — they create no payment intent,
   *  which is also why they are not refundable through refundMemberPayment. */
  paymentIntentId?: string | null
  occurredAtMs?: number
  description?: string | null
  // ── DO NOT ADD A RIDER HERE. This is the SECOND time one has been removed
  // from this signature, so the reason is written down rather than rediscovered:
  //
  //   • `waitlistEntryId` (Wave 3 Phase 2) — deleted; the entry flip is atomic
  //     with the booking write instead.
  //   • `promoRedemptionId` (Wave 3 Phase 3) — deleted; promo commits live at
  //     each webhook handler's per-kind CONFIRM point and in the THREE full-cover
  //     branches, NAMED so the count cannot rot again: `createDropInCheckout`
  //     (booking/dropIn.ts), `createProductCheckout` and `createCourseCheckout`
  //     (connect/payments.ts). There is no fourth — appointments take no gift
  //     card, so that rail has no full-cover branch at all. (This note miscounted
  //     them as 2, and was reported and "fixed" twice — because the correction
  //     landed on the sibling claim in connect/promoCodes.ts and never travelled
  //     to this copy. That is exactly the failure a bare number invites, so
  //     connect/commitSites.test.ts now asserts the count against the source and
  //     the next drift fails a gate instead of waiting for a reader.) See
  //     connect/promoCodes.ts, N17.
  //
  // A rider hung here does not run in three ordinary cases, each of them silent:
  //   1. the early return below when there is nothing left to commit;
  //   2. the early return below for an `admin_comp` card;
  //   3. DECISIVELY — this function only runs when a GIFT-CARD CODE WAS SUPPLIED
  //      (webhook.ts gates on md.giftCardCode && md.giftCardHold; every callable
  //      branch gates on data.giftCardCode). A promo used without a card — the
  //      overwhelmingly common case — would never commit at all: discount given,
  //      count never moved, no error and no alarm.
  //
  // The rule this leaves behind: a rider belongs here ONLY if it must happen
  // after this card's money moves AND is meaningless without a card. Nothing so
  // far has met the second half.
}): Promise<{ committedMajor: number; reclassed: boolean }> {
  const outcome = await commitHoldTx(params)
  if (!outcome || outcome.committedMajor <= 0) {
    return { committedMajor: outcome?.committedMajor ?? 0, reclassed: false }
  }
  const { committedMajor, currency, issueKind, replay, reclassed } = outcome

  // Stamp the funding card onto the payment row even for a comped card and even
  // on a replay (a merge write, so re-stamping is free): a refund must restore
  // the value regardless of how the card was issued.
  if (params.paymentIntentId) {
    try {
      await admin
        .firestore()
        .collection(TEAMS_COLLECTION)
        .doc(params.teamId)
        .collection(MEMBER_PAYMENTS_SUBCOLLECTION)
        .doc(params.paymentIntentId)
        .set(
          {
            gift_card_redeemed: {
              code: normalizeCode(params.code),
              holdKey: params.holdKey,
              amountMajor: committedMajor,
            },
            updated_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
    } catch (err) {
      console.error(`[giftCards] payment gift-card stamp failed (pi=${params.paymentIntentId}):`, err)
    }
  }

  // A COMPED card was never booked as revenue (no money entered — see
  // issueGiftCard), so reclassifying its redemption would drive
  // by_category.gift_card negative and credit the target category with value
  // nobody paid. Suppressed by design; the audit lives on the card.
  if (issueKind === 'admin_comp') return { committedMajor, reclassed: false }
  // Already committed AND already reclassified — nothing left to do. When the
  // marker exists but the stamp does not, the pair may be missing, so fall
  // through and retry it: recordGiftCardReclass is idempotent by doc id.
  if (replay && reclassed) return { committedMajor, reclassed: true }

  try {
    // A `false` return means both rows were already on disk (a replay whose
    // stamp never landed) — indistinguishable from success for our purposes,
    // and the batch guarantees it was never one row.
    await recordGiftCardReclass(
      buildGiftCardReclassTxns({
        teamId: params.teamId,
        code: normalizeCode(params.code),
        holdKey: params.holdKey,
        drawdownMinor: toMinorUnits(committedMajor),
        currency,
        targetCategory: params.targetCategory,
        contactId: params.contactId ?? null,
        occurredAtMs: params.occurredAtMs ?? Date.now(),
        description: params.description ?? null,
      })
    )
    // The marker asserts "the pair is on disk", which is now true either way.
    await cardRef(params.teamId, params.code).update(
      reclassedAtPath(params.holdKey),
      FieldValue.serverTimestamp()
    )
    return { committedMajor, reclassed: true }
  } catch (err) {
    console.error(
      `[giftCards] reclass write failed (team=${params.teamId} code=${normalizeCode(params.code)} hold=${params.holdKey}):`,
      err
    )
    return { committedMajor, reclassed: false }
  }
}

/**
 * THE way a committed drawdown is given back — the mirror of
 * commitGiftCardDrawdown: restore the balance, clear the marker so the hold key
 * can be committed again, and reverse the reclass pair.
 *
 * Idempotent through the marker, which is the point: the amount restored is the
 * one the card recorded at commit time, never a caller's claim, and a second
 * call finds no marker and moves nothing. Without that, a manager double-click
 * (Stripe returns the same refund for the same idempotency key, so the refund
 * itself looks fine both times) would hand back the value twice.
 */
export async function reverseGiftCardDrawdown(params: {
  teamId: string
  code: string
  holdKey: string
  /** What the redeemed value had been attributed to — the pair being reversed. */
  targetCategory: FinanceCategory
  contactId?: string | null
  occurredAtMs?: number
  description?: string | null
}): Promise<{ restoredMajor: number }> {
  const db = admin.firestore()
  const ref = cardRef(params.teamId, params.code)

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    const card = snap.data() as GiftCard
    const marker = card.committed_holds?.[params.holdKey]
    if (!marker) return null // never committed, or already reversed
    const nowMs = Date.now()
    const committed = pruneCommittedHolds(card.committed_holds, nowMs)
    delete committed[params.holdKey]
    const balance = round2(card.balance + marker.amountMajor)
    tx.update(ref, {
      committed_holds: committed,
      balance,
      // A void stays void; a depleted card comes back to life.
      status: card.status === 'depleted' && balance > 0 ? 'active' : card.status,
      updated_at: FieldValue.serverTimestamp(),
    })
    return {
      restoredMajor: marker.amountMajor,
      currency: card.currency,
      // Only reverse a pair that was actually written. A comp never had one,
      // and neither does a commit whose journal write failed — inventing the
      // reversal would subtract revenue that was never recognised.
      hadPair: marker.reclassed_at != null,
    }
  })
  if (!outcome || outcome.restoredMajor <= 0) return { restoredMajor: outcome?.restoredMajor ?? 0 }

  if (outcome.hadPair) {
    try {
      await recordGiftCardReclass(
        buildGiftCardReclassTxns({
          teamId: params.teamId,
          code: normalizeCode(params.code),
          holdKey: params.holdKey,
          drawdownMinor: toMinorUnits(outcome.restoredMajor),
          currency: outcome.currency,
          targetCategory: params.targetCategory,
          contactId: params.contactId ?? null,
          occurredAtMs: params.occurredAtMs ?? Date.now(),
          description: params.description ?? null,
          reverse: true,
        })
      )
    } catch (err) {
      // The value is already back on the card — never fail the caller (a
      // refund) over the journal. The rows are replayable by the backfill.
      console.error(
        `[giftCards] reclass reversal failed (team=${params.teamId} code=${normalizeCode(params.code)} hold=${params.holdKey}):`,
        err
      )
    }
  }
  return { restoredMajor: outcome.restoredMajor }
}

/** Void whatever value is left on a card, whatever state it is in — the FRAUD
 *  path (chargeback on the purchase). Deliberately not the untouched-only check
 *  refunds use: by the time a dispute lands the card may be half spent, and the
 *  remaining value is exactly what must stop being redeemable. No-op when the
 *  card is gone or already void. */
export async function voidGiftCardValue(params: {
  teamId: string
  code: string
  reason: string
}): Promise<boolean> {
  const ref = cardRef(params.teamId, params.code)
  const snap = await ref.get()
  if (!snap.exists || snap.data()?.teamId !== params.teamId) return false
  if (snap.data()?.status === 'void') return false
  await ref.update({
    status: 'void',
    voided_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  console.log(`[giftCards] voided ${normalizeCode(params.code)} (team=${params.teamId}): ${params.reason}`)
  return true
}

/** Void a card that has NOT been used, for refunding the purchase that created
 *  it. Throws `failed-precondition` when any value has already been drawn or is
 *  held by a live checkout: refunding the buyer while somebody spends the code
 *  is stored value leaving twice, and this callable cannot claw back what has
 *  already been consumed.
 *
 *  Returns the status it replaced so the caller can put it back if the refund
 *  it was clearing the way for then fails. */
export async function voidUntouchedGiftCard(params: {
  teamId: string
  code: string
}): Promise<{ previousStatus: GiftCardStatus }> {
  const db = admin.firestore()
  const ref = cardRef(params.teamId, params.code)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.data()?.teamId !== params.teamId) {
      throw new HttpsError('not-found', 'Gift card not found')
    }
    const card = snap.data() as GiftCard
    const nowMs = Date.now()
    const liveHolds = Object.values(dropExpiredHolds(card.holds, nowMs))
    if (round2(card.balance) !== round2(card.amount) || liveHolds.length > 0) {
      throw new HttpsError('failed-precondition', 'This gift card has already been used', {
        reason: 'gift_card_partially_redeemed',
      })
    }
    tx.update(ref, {
      status: 'void',
      voided_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    })
    return { previousStatus: card.status }
  })
}

/** Undo voidUntouchedGiftCard when the refund it preceded failed — the card
 *  must not die for a payment that was never given back. */
export async function unvoidGiftCard(params: {
  teamId: string
  code: string
  previousStatus: GiftCardStatus
}): Promise<void> {
  await cardRef(params.teamId, params.code).update({
    status: params.previousStatus,
    voided_at: null,
    updated_at: FieldValue.serverTimestamp(),
  })
}

/** Release a reserved hold without committing it (checkout cancelled/expired). */
export async function releaseGiftCardHold(params: {
  teamId: string
  code: string
  holdKey: string
}): Promise<void> {
  const db = admin.firestore()
  const ref = cardRef(params.teamId, params.code)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return
    const card = snap.data() as GiftCard
    const nowMs = Date.now()
    const holds = dropExpiredHolds(card.holds, nowMs)
    delete holds[params.holdKey]
    // update() replaces the holds map wholesale — merge would resurrect the
    // deleted key and the release would never persist.
    tx.update(ref, { holds, updated_at: FieldValue.serverTimestamp() })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// createGiftCardCheckout — public purchase of a gift card. GUEST-FRIENDLY,
// unlike the other shop checkouts: a gift card carries no per-person effect
// (the entitlement is the CODE, and the holder is usually somebody else), so
// forcing the buyer to register would gate a present behind an account nobody
// wanted. Mints nothing itself; the webhook (handleGiftCardCheckout) mints the
// card on payment success.
// ─────────────────────────────────────────────────────────────────────────────
export const createGiftCardCheckout = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'createGiftCardCheckout')
  const data = request.data as {
    teamId?: string
    amount?: number
    slug?: string
    locale?: string
    origin?: string
    purchaserEmail?: string
    idempotencyKey?: string
    // NOTE: `giftCardCode` is deliberately not read here — a gift card cannot
    // be bought with another gift card (that would launder stored value into a
    // fresh code with no cash behind it).
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const { teamId } = data
  const locale = data.locale ?? 'en'

  // SELLING is plugin-gated; redeeming is not (utils/plugins.ts). Refused before
  // the rate-limit spend so a studio that never sells gift cards cannot have its
  // quota burned by traffic to an offer it does not make.
  await assertPluginInstalled(teamId, 'gift-cards')

  // Own bucket: buying a gift card must never spend the quota a customer needs
  // to REDEEM one from the same NAT'd network (see checkoutRateLimit).
  await checkoutRateLimit(request.rawRequest?.ip, 'gift-buy')

  // Trust ONLY the verified contact-session token for the caller's identity —
  // never a contactId from the request body, which would let anyone attribute a
  // purchase to (and enumerate) arbitrary contacts. Guests carry no session and
  // supply an address that is PREFILL ONLY: it seeds the Stripe receipt field,
  // it is never identity, and the webhook links it to a contact only when the
  // match is unambiguous.
  const contactSession = optionalContactSessionFromRequest(request)
  const contactId = contactSession?.teamId === teamId ? contactSession.contactId : null
  const rawEmail = typeof data.purchaserEmail === 'string' ? normalizeEmail(data.purchaserEmail) : ''
  const guestEmail = EMAIL_RE.test(rawEmail) ? rawEmail : undefined
  const email = contactId
    ? ((request.auth?.token?.email as string | undefined) ?? guestEmail)
    : guestEmail

  const team = await loadEnabledTeam(teamId)
  requireChargeableAccount(team) // fail before the reads; the orchestrator re-checks

  const settings = (team.data.settings?.giftCards ?? null) as GiftCardSettings | null
  if (!settings?.enabled) {
    throw new HttpsError('failed-precondition', 'Gift cards are not available for this team')
  }
  const amountMajor = data.amount
  if (typeof amountMajor !== 'number' || !settings.amounts.includes(amountMajor)) {
    throw new HttpsError('invalid-argument', 'amount must be one of the configured gift card amounts')
  }
  const amount = requireChargeableAmountFromMajor(amountMajor)

  const slugQuery = data.slug ? `&slug=${encodeURIComponent(data.slug)}&seg=shop` : ''
  const { successUrl, cancelUrl } = await buildResultUrls(locale, {
    extraQuery: slugQuery,
    origin: data.origin,
    teamId,
  })

  // Webhook reads this to mint the card and email the purchaser. Stripe
  // metadata is Record<string,string> and rejects null/undefined values, so the
  // guest-absent fields are spread in conditionally rather than assigned.
  const metadata: Record<string, string> = {
    teamId,
    kind: 'gift_card',
    purpose: 'gift_card',
    amount: String(amountMajor),
    // The buyer's language is only knowable HERE — the webhook fires with no
    // request context, so an unforwarded locale means an English email forever.
    locale,
    ...(contactId ? { contactId } : {}),
    ...(email ? { purchaserEmail: email } : {}),
  }

  // A client-supplied key is honoured only for a signed-in buyer, whose session
  // already binds it to one identity. On the guest path the server mints it: an
  // unauthenticated callable that accepts an idempotency key hands Stripe's
  // dedupe namespace to whoever calls it. defaultIdempotencyKey is wrong here
  // too — it appends only a minute bucket, so two guests buying the same amount
  // from the same team within a minute would collide and the second would be
  // handed the first buyer's Checkout Session. Two Checkout Sessions are
  // harmless (only one can be paid); one shared session is not.
  const idempotencyKey =
    contactId && data.idempotencyKey
      ? `gift-pub:${teamId}:${contactId}:${String(data.idempotencyKey).replace(/[^\w:-]/g, '_').slice(0, 60)}`
      : contactId
        ? defaultIdempotencyKey('gift-pub', teamId, contactId, String(amountMajor))
        : `gift-guest:${crypto.randomUUID()}`

  const checkout = await startOneOffCheckout({
    team,
    amountMinor: amount,
    productName: `Gift card ${giftCardCurrency(team.data.default_currency as string | undefined)} ${amountMajor}`,
    successUrl,
    cancelUrl,
    customerEmail: email,
    metadata,
    idempotencyKey,
    label: 'createGiftCardCheckout',
  })
  return { url: checkout.url, sessionId: checkout.sessionId }
})

// ─────────────────────────────────────────────────────────────────────────────
// issueGiftCard — the MANAGER mint: a front desk sells a card for cash, or a
// studio comps one. No Stripe anywhere on this path.
//
// UNIT BOUNDARY, stated once because the two rails disagree and a literal
// reading of "amount" records 100× the cash:
//   • GiftCard.amount / .balance   → MAJOR units (100 = CHF 100)
//   • writeManualPaymentEvent.amount → MINOR units (Rappen)
// Every variable below is suffixed accordingly; there is no bare `amount`.
// ─────────────────────────────────────────────────────────────────────────────

/** Doc-id-safe, length-capped form of the caller's key. The claim doc id is the
 *  dedupe, so it must never be rejected by Firestore for a stray character. */
function normalizeIssueRef(raw: unknown): string | null {
  const key = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9:_-]/g, '')
    .slice(0, 100)
  return key.length >= 8 ? `admin:${key}` : null
}

/** users/{uid} (firstname+lastname, else displayName/email) → the bare uid.
 *  Snapshotted onto the card so the audit line survives a rename or a departure. */
async function resolveIssuerName(uid: string): Promise<string | null> {
  const snap = await admin.firestore().collection('users').doc(uid).get()
  if (!snap.exists) return null
  const u = snap.data()!
  const full = `${(u.firstname as string | undefined) || ''} ${(u.lastname as string | undefined) || ''}`.trim()
  return full || (u.displayName as string | undefined) || (u.email as string | undefined) || null
}

/**
 * Journal the cash behind a PAID manager-issued card, and stamp the card with
 * the resulting event.
 *
 * Split out of `issueGiftCard` because it must run on BOTH the first attempt
 * and a retry that lands on the duplicate branch: minting the card and booking
 * the cash are two writes, and an attempt that dies between them leaves live
 * stored value that was never journaled. Idempotent by construction — the event
 * is keyed on the code, which is unique per card — so calling it twice is a
 * no-op rather than a second till entry.
 */
async function finishPaidIssue(params: {
  teamId: string
  code: string
  amountMajor: number
  currency: string
  occurredAtMs?: number
  paymentMode?: string
  contactId?: string | null
  uid: string
}): Promise<void> {
  await writeManualPaymentEvent({
    teamId: params.teamId,
    contactId: params.contactId ?? null,
    amount: toMinorUnits(params.amountMajor), // MINOR — the payment rail's unit
    currency: params.currency,
    occurredAtMs: params.occurredAtMs,
    paymentMode: params.paymentMode,
    lineItem: { kind: 'gift_card', label: `Gift card ${params.code}` },
    idempotencyKey: `giftcard:${params.code}`,
    recordedBy: params.uid,
  })
  await cardRef(params.teamId, params.code).update({
    payment_event_id: `manual:giftcard:${params.code}`,
    updated_at: FieldValue.serverTimestamp(),
  })
}

export const issueGiftCard = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid
  const data = request.data as {
    teamId?: string
    amountMajor?: number
    issueKind?: 'paid' | 'comp'
    paymentMode?: string
    occurredAtMs?: number
    issueReason?: string
    purchaserContactId?: string
    idempotencyKey?: string
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const teamId = data.teamId

  // Minting is CREATION — gated. (voidGiftCard is not: retiring an outstanding
  // card is winding DOWN a liability, which an uninstalled studio still needs.)
  await assertPluginInstalled(teamId, 'gift-cards')

  // Same bar as voidGiftCard and recordManualPayment: whoever may destroy a
  // card's value, or record cash, may also create one. Requiring owner here
  // would lock the front desk out of the one till task it exists for; the audit
  // fields stamped below are what makes it attributable instead.
  await assertManager(uid, teamId)

  const kind = data.issueKind
  if (kind !== 'paid' && kind !== 'comp') {
    throw new HttpsError('invalid-argument', "issueKind must be 'paid' or 'comp'")
  }
  const amountMajor = data.amountMajor
  // Validator ONLY — the return value is MINOR units and is deliberately
  // discarded here. Calling it enforces the same authored-price floor the
  // public rail throws on (below_minimum), nothing more.
  requireChargeableAmountFromMajor(amountMajor)
  if (typeof amountMajor !== 'number' || amountMajor > MAX_ISSUE_AMOUNT_MAJOR) {
    throw new HttpsError('invalid-argument', 'amountMajor is above the maximum a card may carry', {
      reason: 'above_maximum',
      max: MAX_ISSUE_AMOUNT_MAJOR,
    })
  }
  const issueReason = (data.issueReason ?? '').toString().trim().slice(0, MAX_ISSUE_REASON_LEN) || null
  if (kind === 'comp' && !issueReason) {
    throw new HttpsError('invalid-argument', 'A reason is required for a complimentary card', {
      reason: 'issue_reason_required',
    })
  }
  const issueRef = normalizeIssueRef(data.idempotencyKey)
  if (!issueRef) throw new HttpsError('invalid-argument', 'idempotencyKey is required')

  const db = admin.firestore()

  // Validate the purchaser link exactly as recordManualPayment does — a card
  // attributed to another team's contact would leak across the tenant boundary.
  let purchaserContactId: string | null = null
  if (data.purchaserContactId) {
    const cid = String(data.purchaserContactId).trim()
    if (cid) {
      const cSnap = await db.collection(CONTACTS_COLLECTION).doc(cid).get()
      if (!cSnap.exists || cSnap.data()?.teamId !== teamId) {
        throw new HttpsError('invalid-argument', 'Contact does not belong to this team')
      }
      if (cSnap.data()?.deleted_at != null) {
        throw new HttpsError('invalid-argument', 'Contact is deleted')
      }
      purchaserContactId = cid
    }
  }

  // Read the team doc DIRECTLY rather than through loadEnabledTeam /
  // requireChargeableAccount: those enforce the CONNECT kill-switch, and a
  // studio taking cash over the counter may have no connected account at all.
  // settings.giftCards.enabled + .amounts are skipped for the same reason —
  // they gate the public shop tab, not the front desk, which sells CHF 73.
  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  if (!teamSnap.exists) throw new HttpsError('not-found', 'Team not found')
  const currency = giftCardCurrency(teamSnap.data()?.default_currency as string | undefined)

  // ── Idempotency: CLAIM FIRST, never query-then-create ──────────────────────
  // The webhook rail gets away with a `.where(payment_intent_id)` lookup only
  // because Stripe delivery is already serialised by the event-id ledger. This
  // rail has no serialiser: two concurrent submits (a double click, a retried
  // request) would both read "no card yet" and both mint — two live cards, and
  // on the paid path two manual payment rows keyed by two different codes,
  // double-counting the cash. The create() below is the serialisation point:
  // exactly one caller can win it, and the loser reads the winner's code back.
  const claimRef = db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(GIFT_CARD_ISSUES_SUBCOLLECTION)
    .doc(issueRef)
  try {
    await claimRef.create({
      status: 'claimed',
      amount_major: amountMajor,
      issue_kind: kind === 'paid' ? 'admin_paid' : 'admin_comp',
      issued_by: uid,
      created_at: FieldValue.serverTimestamp(),
    })
  } catch (err: unknown) {
    if ((err as { code?: number }).code !== 6) throw err // not ALREADY_EXISTS
    const claimed = (await claimRef.get()).data()
    const claimedCode = claimed?.code as string | undefined
    if (claimedCode) {
      // The card exists — but do NOT return blind. The mint and the till row
      // are two writes, and a retry lands here after the FIRST one succeeded.
      // If the original attempt died between minting and journaling the cash,
      // returning now leaves live stored value with no `payment_events` row and
      // no `manual:charge` in the books — and because the card is `admin_paid`
      // the redemption reclass still fires, crediting a category with revenue
      // no charge ever recognised and driving `by_category.gift_card` negative.
      //
      // Re-running the till write is safe: `writeManualPaymentEvent` is
      // idempotent on `giftcard:{code}`, so a genuine duplicate is a no-op and
      // an interrupted one is completed.
      if ((claimed?.issue_kind as string | undefined) === 'admin_paid') {
        await finishPaidIssue({
          teamId,
          code: claimedCode,
          amountMajor: (claimed?.amount_major as number) ?? amountMajor,
          currency,
          occurredAtMs: data.occurredAtMs,
          paymentMode: data.paymentMode,
          contactId: purchaserContactId,
          uid,
        })
      }
      return { code: claimedCode, duplicate: true }
    }
    // Won the race but never got a code stamped back — the mint either is still
    // running or died mid-flight. Refusing is the safe answer: minting now is
    // how you end up with two cards for one payment. The dialog mints a fresh
    // key each time it opens, so the manager's retry gets a clean claim.
    throw new HttpsError('failed-precondition', 'This gift card is already being issued', {
      reason: 'issue_in_flight',
    })
  }

  const issuedByName = await resolveIssuerName(uid)
  const card = await mintGiftCard({
    teamId,
    amount: amountMajor, // MAJOR — the card rail's unit
    currency,
    purchaserContactId,
    purchaserEmail: null,
    paymentIntentId: null,
    issueRef,
    issueKind: kind === 'paid' ? 'admin_paid' : 'admin_comp',
    issuedBy: uid,
    issuedByName,
    issueReason,
  })
  await claimRef.update({
    code: card.code,
    status: 'minted',
    updated_at: FieldValue.serverTimestamp(),
  })

  if (kind === 'paid') {
    await finishPaidIssue({
      teamId,
      code: card.code,
      amountMajor,
      currency,
      occurredAtMs: data.occurredAtMs,
      paymentMode: data.paymentMode,
      contactId: purchaserContactId,
      uid,
    })
  }
  // A comp writes NOTHING to the journal, and that is correct on a cash basis
  // (docs/accounting.md): no cash entered, no gateway balance moved, and this
  // ledger carries no receivables to book against. Recording it as revenue
  // would invent income that never arrived. The audit lives on the card.

  return { code: card.code, duplicate: false }
})

// ─────────────────────────────────────────────────────────────────────────────
// checkGiftCard — public balance check (never reveals the purchaser).
// ─────────────────────────────────────────────────────────────────────────────
export const checkGiftCard = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'checkGiftCard')
  const data = request.data as { teamId?: string; code?: string }
  if (!data?.teamId || !data?.code) {
    throw new HttpsError('invalid-argument', 'teamId and code are required')
  }
  await checkoutRateLimit(request.rawRequest?.ip, 'gift-check')

  const snap = await cardRef(data.teamId, data.code).get()
  if (!snap.exists || snap.data()?.teamId !== data.teamId) {
    return { valid: false, balance: 0, currency: null }
  }
  const card = snap.data() as GiftCard
  const balance = giftCardAvailable(card)
  return { valid: card.status === 'active' && balance > 0, balance, currency: card.currency }
})

// ─────────────────────────────────────────────────────────────────────────────
// voidGiftCard — manager-only, e.g. lost/fraudulent card.
// ─────────────────────────────────────────────────────────────────────────────
export const voidGiftCard = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = request.data as { teamId?: string; code?: string }
  if (!data?.teamId || !data?.code) {
    throw new HttpsError('invalid-argument', 'teamId and code are required')
  }
  await assertManager(request.auth.uid, data.teamId)

  const ref = cardRef(data.teamId, data.code)
  const snap = await ref.get()
  if (!snap.exists || snap.data()?.teamId !== data.teamId) {
    throw new HttpsError('not-found', 'Gift card not found')
  }
  await ref.set(
    { status: 'void', voided_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() },
    { merge: true }
  )
  return { ok: true }
})
