// Gift cards (E3) — CODE-based stored value: the buyer pays, whoever holds the
// code redeems. Cards live at teams/{teamId}/gift_cards/{code} (the readable
// code IS the doc id — treat it as a secret: Firestore rules give managers
// read; the public checks balances only through the checkGiftCard callable).
//
// V1 redemption surface: the ONE-OFF public checkouts (product, course,
// drop-in). Recurring memberships are excluded (stored value can't be mixed
// into a Stripe subscription cleanly). Two redemption shapes:
//  • PARTIAL — the Stripe charge is reduced by the drawdown; the residual must
//    still clear the 0.50 minimum (planGiftCardRedemption enforces it).
//  • FULL COVER — no Stripe at all: the callable applies the manual-rail
//    payment effects directly and commits the drawdown immediately.
// Double-spend safety: a checkout RESERVES its drawdown as a hold on the card;
// the webhook COMMITS it on payment success, and checkout.session.expired / the
// daily sweep RELEASE stale holds.
//
// The hold key is minted by the CALLER (generateSecureToken(16)) — it is NOT the
// Stripe Checkout Session id, and cannot be: the reservation has to succeed or
// fail before a session is worth creating, so at the moment the key is chosen no
// session exists yet. It is minted at connect/payments.ts (the product and
// course branches) and booking/dropIn.ts — one per rail that takes a card —
// with the matching note in connect/giftCards.ts's header. This file and that
// header drifted apart once already, so the tally is asserted against the
// source in connect/commitSites.test.ts rather than kept true by hand. The key
// travels to the webhook in checkout metadata as `giftCardHold`.
//
// Cards do not expire in v1 (Swiss-friendly default); studios can void.

import type { Timestamp } from './common'
import { MIN_CHARGE_MAJOR, round2Major } from '../utils/money'

export type GiftCardStatus = 'active' | 'depleted' | 'void'

/**
 * How the card came into existence — an AUDIT axis, orthogonal to status.
 *  • purchase   — somebody paid through the public shop (the Connect charge is
 *                 the journal row).
 *  • admin_paid — a manager took the money outside any gateway (cash/TWINT/bank)
 *                 and recorded it; a manual payment_events row carries the cash.
 *  • admin_comp — a manager gave the value away. NO journal row exists, and that
 *                 is correct on a cash basis: no money moved (docs/accounting.md).
 *                 The card itself is the audit record, which is why issue_reason
 *                 is mandatory for this kind.
 * Absent on every card minted before the manager mint existed ⇒ read as
 * 'purchase' (those could only come from the shop).
 */
export type GiftCardIssueKind = 'purchase' | 'admin_paid' | 'admin_comp'

export interface GiftCardHold {
  /** Drawdown reserved by a pending checkout (major units). */
  amount: number
  /** Hold expiry — DERIVED from the Checkout Session this drawdown guards, not
   *  a constant: the session's own `expires_at` plus a small margin, computed
   *  once by `resolveCheckoutHoldWindow` (functions/connect/checkout.ts) and
   *  handed to `reserveGiftCardDrawdown` as `holdMinutes`.
   *
   *  It used to be a flat +35 minutes, which was correct only while every
   *  session was also ~31. A waitlist claim's session lives for the studio's
   *  whole claim window (120 minutes by default, up to Stripe's 24-hour
   *  ceiling), so the flat hold died first and the value it was guarding became
   *  spendable again while the claim was still payable. */
  expires_at: Timestamp
}

/**
 * A drawdown that has already been committed, keyed by the SAME hold key the
 * checkout minted. This is the double-spend stop, and it is why a hold alone is
 * not enough: holds expire lazily (35 min) while a payment can land later
 * (async payment methods, a dropped `checkout.session.expired`), at which point
 * the committer falls back to the drawdown recorded in checkout metadata. Two
 * deliveries of that late payment would then deduct twice — the second one
 * absorbed by the studio, because the balance clamps at zero. A key present
 * here means "already spent": re-committing it moves nothing and the finance
 * reclass fires exactly once.
 */
export interface GiftCardCommittedHold {
  /** What ACTUALLY left the card (major units) — the movement, not the request. */
  amountMajor: number
  at: Timestamp
  /** Stamped once the reclass pair for this commit is on disk. Absent means the
   *  pair may be missing (the commit succeeded, the journal write did not) —
   *  the query hook a backfill needs to find one-sided state. */
  reclassed_at?: Timestamp | null
}

export interface GiftCard {
  /** The redeemable code, also the doc id (GC-XXXX-XXXX). */
  code: string
  teamId: string
  /** Face value at purchase (major units, team currency). */
  amount: number
  /** Remaining committed balance (major units) — holds NOT yet subtracted. */
  balance: number
  currency: string
  status: GiftCardStatus
  /** Active reservations, keyed by the caller-minted hold key (see the file
   *  header — NOT the Stripe Checkout Session id, which does not exist yet when
   *  the key is chosen). */
  holds?: Record<string, GiftCardHold>
  /** Committed reservations, same keys. Pruned after 90 days by the committer. */
  committed_holds?: Record<string, GiftCardCommittedHold>
  purchaserContactId?: string | null
  purchaserEmail?: string | null
  payment_intent_id?: string | null
  // ── Origin / audit. Every field is optional: legacy cards predate them. ──
  issue_kind?: GiftCardIssueKind
  /** uid of the manager who minted it (admin_* only). */
  issued_by?: string | null
  /** Their display name at mint time — a snapshot, so a later rename or a
   *  removed team member still leaves a readable audit line. */
  issued_by_name?: string | null
  /** Why value was given away. REQUIRED for admin_comp — a comp with no reason
   *  is indistinguishable from a mistake. */
  issue_reason?: string | null
  issued_at?: Timestamp
  /** The gift_card_issues claim doc that serialized this mint (admin_* only). */
  issue_ref?: string | null
  /** payment_events doc id holding the cash an admin_paid card was sold for. */
  payment_event_id?: string | null
  created_at?: Timestamp
  updated_at?: Timestamp
  voided_at?: Timestamp | null
}

/** Shop configuration under teams/{id}.settings.giftCards. */
export interface GiftCardSettings {
  enabled: boolean
  /** Purchasable face values (major units), e.g. [50, 100]. */
  amounts: number[]
}

/** Balance a NEW redemption may draw on: committed balance minus live holds. */
export function giftCardAvailable(
  card: Pick<GiftCard, 'status' | 'balance' | 'holds'>,
  nowMs: number = Date.now()
): number {
  if (card.status !== 'active') return 0
  const held = Object.values(card.holds ?? {})
    .filter((h) => h.expires_at.toMillis() > nowMs)
    .reduce((sum, h) => sum + h.amount, 0)
  return Math.max(0, round2(card.balance - held))
}

export interface GiftCardRedemptionPlan {
  /** What the card contributes (major units). */
  drawdown: number
  /** What Stripe still charges (major units). 0 = full cover, skip Stripe. */
  residual: number
}

/**
 * Split a total between the card and Stripe. The residual, when non-zero, must
 * clear Stripe's 0.50 floor — a card that can't full-cover but would leave a
 * sub-minimum residual has its drawdown REDUCED so the charge stays valid.
 * Returns null when the card contributes nothing (no available balance).
 */
export function planGiftCardRedemption(
  availableMajor: number,
  totalMajor: number
): GiftCardRedemptionPlan | null {
  const available = round2(availableMajor)
  const total = round2(totalMajor)
  if (available <= 0 || total <= 0) return null
  if (available >= total) return { drawdown: total, residual: 0 }
  let drawdown = available
  let residual = round2(total - drawdown)
  if (residual < MIN_CHARGE_MAJOR) {
    // Keep the Stripe charge valid: shrink the drawdown to leave the floor.
    residual = MIN_CHARGE_MAJOR
    drawdown = round2(total - residual)
    if (drawdown <= 0) return null // total itself is at/below the floor
  }
  return { drawdown, residual }
}

/**
 * Apply a committed drawdown to a card's balance. `committedMajor` is the
 * value that ACTUALLY moved, which is NOT always the requested amount: a
 * balance of 20 against a requested 25 moves 20, not 25 (the balance floors at
 * zero rather than going negative). Callers that book the movement — finance
 * rows, refund reversals — must use the returned figure, or they record value
 * that never left the card.
 */
export function applyGiftCardCommit(
  balanceMajor: number,
  requestedMajor: number
): { newBalanceMajor: number; committedMajor: number } {
  const newBalanceMajor = Math.max(0, round2(balanceMajor - requestedMajor))
  return { newBalanceMajor, committedMajor: round2(balanceMajor - newBalanceMajor) }
}

const round2 = round2Major

/** GC-XXXX-XXXX from 8 unambiguous chars (no 0/O/1/I). Caller supplies random
 *  bytes so this stays pure (crypto lives in the functions package). */
export function formatGiftCardCode(randomBytes: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[randomBytes[i] % ALPHABET.length]
    if (i === 3) out += '-'
  }
  return `GC-${out}`
}
