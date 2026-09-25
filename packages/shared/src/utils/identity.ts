// ONE definition of "the same person", for every feature that needs a durable
// identity for someone who may not have a stable contact document.
//
// It moved here from types/promoCode.ts when waivers needed the same
// derivation: two hashers that disagree by so much as an encoding would mean a
// promo cap and a consent export disagreed about who a person is. The promo
// helper now delegates, and a test pins that the two produce identical strings.

/**
 * A hex SHA-256 of a UTF-8 string. INJECTED rather than imported so this module
 * stays crypto-free and browser-safe. The functions package supplies
 * `sha256Hex` (utils/crypto.ts); there must be exactly one implementation.
 */
export type Sha256Hex = (input: string) => string

import { normalizeEmail } from './normalizeEmail'

/**
 * The strongest identity a public rail actually has.
 *
 * NOT the contact id. On the rails a guest can reach, the contact document is
 * minted BY THE VISITOR at purchase/booking time and is matched on
 * (teamId, email, lowercased firstname, lowercased lastname), so a
 * contact-keyed identity would read "once per (email, exact spelling of name)"
 * — "Ann Smith" and "A. Smith" would be two people. It can also be
 * hard-deleted: `purgeProvisionalContacts` removes abandoned provisional
 * contacts overnight.
 *
 * So: the normalized EMAIL, because every rail collects one and every rail
 * normalizes it the same way. Hashed so a ledger's DOC IDS are not a
 * harvestable list of a studio's customer addresses, and hex so the result is
 * always safe as a Firestore doc id, a map key and a FieldPath segment.
 * Prefixed so the two kinds of key can never collide.
 *
 * WHAT THIS DOES NOT PROMISE: it is not unforgeable. A second mailbox, or a +1
 * alias, is a different identity — and, in the other direction, a shared family
 * mailbox gives a parent and a child the SAME key. That over-inclusion is
 * harmless for a redemption cap and is a FABRICATION in a consent artefact,
 * which is why the waiver ledger keys its signer rows on `contactId` and uses
 * this only as a SECONDARY query, rendered in its own labeled section.
 */
export function contactIdentityKey(
  input: { email?: string | null; contactId: string },
  sha256Hex: Sha256Hex
): string {
  const email = input.email ? normalizeEmail(input.email) : ''
  if (email) return `e_${sha256Hex(email).slice(0, 32)}`
  return `c_${input.contactId}`
}
