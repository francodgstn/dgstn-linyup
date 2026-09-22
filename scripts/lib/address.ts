/**
 * A seeded contact's postal address.
 *
 * WHY IT EXISTS. `buildReceiptDraft` refuses with `contact_address_incomplete`
 * unless the contact carries `postal_code` AND `locality`
 * (packages/functions/src/tarif595/draft.ts), and no seeder wrote a contact
 * address at all — so on every demo tenant a Tarif 595 receipt previewed and
 * then died at the last click. The Swiss QR-bill invoice wants the same four
 * parts for its debtor, and the contact detail page has an address block that
 * was empty on all seeded data.
 *
 * THE ONE RULE: A SWISS POSTAL CODE NAMES EXACTLY ONE LOCALITY, so the zip and
 * the city are never invented here. They are the STUDIO's own, handed in by the
 * seeder that already holds them (its legal profile carries the same pair), and
 * only the street and the house number vary per contact. "8001 Basel" is not
 * fictional, it is WRONG — and it would be wrong on a document a member sends
 * to their insurer.
 *
 * The street names are chosen for the same reason: each is common enough to
 * exist in most Swiss towns, so pairing one with whatever locality the seeder
 * passes stays plausible rather than becoming locality-specific nonsense. The
 * house number is the only freely invented part, which is as far as demo data
 * can honestly go — a real address would belong to a real household.
 *
 * Callers: seed-emulator, seed-sandbox, seed-staging, seed-lead. Each keys it on
 * the contact's own id, so a reseed reproduces the same roster of addresses.
 */

import type { ContactAddress } from '@linyup/shared'

/** The locality every contact of one seeded studio lives in — the studio's own. */
export interface SeedPostalArea {
  zip: string
  city: string
}

/**
 * Common enough to exist in most Swiss towns — see the header for why that
 * matters. Deliberately no `Musterstrasse`: a prospect reading the roster
 * should see a plausible town, not a form template.
 */
const SEED_STREETS = [
  'Bahnhofstrasse',
  'Seestrasse',
  'Kirchgasse',
  'Schulstrasse',
  'Dorfstrasse',
  'Hauptstrasse',
  'Rosenweg',
  'Lindenstrasse',
  'Bergstrasse',
  'Feldweg',
  'Sonnenbergstrasse',
  'Mühlegasse',
] as const

/** FNV-1a, the same shape the seeders' own `seededRand` uses — kept local so
 *  this file imports nothing from any one seeder. */
function hashOf(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/** A stable, plausible address for one seeded contact in `area`. */
export function seedContactAddress(seed: string, area: SeedPostalArea): ContactAddress {
  const h = hashOf(seed)
  return {
    route: SEED_STREETS[h % SEED_STREETS.length],
    street_number: String(1 + (Math.floor(h / SEED_STREETS.length) % 120)),
    postal_code: area.zip,
    locality: area.city,
  }
}
