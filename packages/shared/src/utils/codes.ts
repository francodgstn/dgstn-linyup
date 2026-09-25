// The ONE normalization for a REDEEMABLE CODE — a string a person types in to
// redeem something. Two instruments use it today and both key their Firestore
// DOCUMENT on the result:
//   • gift cards  — teams/{teamId}/gift_cards/{code}      (stored value, a TENDER)
//   • promo codes — teams/{teamId}/promo_codes/{CODE}      (a price MODIFIER)
//
// They must never fork on what "the same code" means. A promo stored as
// `SUMMER26` and looked up as ` summer26` is simply not found; a gift-card code
// copied into checkout metadata by one rule and resolved to a document by
// another commits the drawdown against the wrong card. Both were live risks:
// before this helper existed, `normalizeCode` was module-private to
// connect/giftCards.ts while five other sites (connect/payments.ts,
// booking/dropIn.ts, shared/types/finance.ts) each re-typed
// `.trim().toUpperCase()` inline.
//
// Trim + uppercase, and NOTHING else. Deliberately not stripping inner spaces
// or hyphens: `GC-XXXX-XXXX` carries a meaningful hyphen and a promo code may
// too (`/^[A-Z0-9][A-Z0-9-]{2,23}$/`), so folding them away would collide two
// distinct codes onto one doc id — the one failure this helper exists to make
// impossible.

/** Canonicalise a typed redemption code: trim, then uppercase. Idempotent. */
export function normalizeRedemptionCode(raw: string): string {
  return raw.trim().toUpperCase()
}
