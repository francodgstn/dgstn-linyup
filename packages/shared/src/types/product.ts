import type { Timestamp } from './common'
import type { SaasPlan } from './team'

// Sellable physical/merchandise products (e.g. a club's own equipment, apparel).
//
// Deliberately minimal — this is NOT a retailer/inventory tool:
//   • No stock tracking (sell freely; the studio fulfills manually).
//   • One-off purchase only (physical goods) — never recurring. Payment rides the
//     same Stripe Connect one-off rail as a drop-in / shop-item charge.
//   • Variants exist for non-priced dimensions like size/colour. A variant may
//     optionally override the base price (e.g. XXL costs more); absent → base price.
//
// Stored at teams/{teamId}/products/{productId}. The public storefront reads the
// world-readable summary at teams/{teamId}/public_profile/{teamId}.products
// (written by syncProductsToPublicProfile), never the raw collection.

/** A non-priced product dimension instance (a size, a color, a bundle option). */
export interface ProductVariant {
  id: string // client-generated; stable across edits
  label: string // e.g. "M", "Large", "Red / XL"
  // Optional override of the product's base price, in the team default currency
  // (major units, e.g. 49.9). Absent → the variant sells at the base price.
  priceAmount?: number
  active?: boolean // default true; inactive variants are hidden from the storefront
}

export interface Product {
  id: string
  teamId: string
  name: string
  description?: string
  imageUrl?: string
  // Base price in the team default currency (Team.default_currency), major units
  // (e.g. 49.9). Variants without their own priceAmount sell at this price.
  priceAmount: number
  // Optional label for the variant dimension shown to the buyer, e.g. "Size".
  variantLabel?: string
  variants?: ProductVariant[] // optional; absent = a single, variant-less product
  active?: boolean // default true; false hides the product from the storefront
  // Display order (lower = first) in the storefront and the admin list. Absent
  // values sort last (by name).
  order?: number
  // HOW THE BUYER GETS IT — free text, per product, falling back to the team
  // default at `teams/{teamId}.settings.productCollectionNote`. Read through
  // `resolveProductCollectionNote`, never directly, so the shop card and the
  // receipt cannot disagree about which of the two applies.
  //
  // DELIBERATELY TEXT, and deliberately not a fulfillment MODEL. A studio handing
  // over a gi at the front desk and one posting a water bottle need the same
  // field to say different things; a shipping-method enum plus an address the
  // checkout does not collect would be a bigger feature answering a smaller
  // question. This says what is true and nothing more.
  collectionNote?: string
  created_at?: Timestamp
  updated_at?: Timestamp
  createdBy?: string
}

/** Stable sort for products: explicit `order` first (asc), then name. */
export function compareProducts(a: Product, b: Product): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  return (a.name ?? '').localeCompare(b.name ?? '')
}

/**
 * Resolve the effective price (major units) for a product + optional variant.
 * Returns the variant override when present, else the product base price.
 */
export function resolveProductPrice(
  product: Pick<Product, 'priceAmount' | 'variants'>,
  variantId?: string | null
): number {
  if (variantId) {
    const v = (product.variants ?? []).find((x) => x.id === variantId)
    if (v && typeof v.priceAmount === 'number') return v.priceAmount
  }
  return product.priceAmount
}

// ─── Per-team catalog cap ───────────────────────────────────────────────────
// The number of DISTINCT products a team may list for sale. The product catalog
// is intentionally capped so the feature stays a light "sell your own equipment"
// surface rather than a storefront. Variants do NOT count against the cap.
// Plan IDs are stable machine identifiers — see plan.ts. Coach reaches this via the
// paid add-on; free is upgrade-locked (no add-ons) so it has no practical cap.
export const PRODUCT_LIMITS: Record<SaasPlan, { maxProductsPerTeam: number }> = {
  free: { maxProductsPerTeam: 5 },
  coach: { maxProductsPerTeam: 10 },
  studio: { maxProductsPerTeam: 30 },
  organization: { maxProductsPerTeam: 100 },
}

export function getProductLimits(plan: SaasPlan | null): { maxProductsPerTeam: number } {
  return PRODUCT_LIMITS[plan ?? 'free']
}

// Max variants per product — keeps the editor and storefront tidy.
export const MAX_PRODUCT_VARIANTS = 20

// Max length of a collection/fulfilment note (per product AND the team default).
// Long enough for "Collect at the front desk during opening hours, or ask us to
// post it (CHF 8)" and short enough that it stays a note rather than a page.
export const MAX_PRODUCT_COLLECTION_NOTE = 500

/**
 * The collection note that applies to one product: its own, else the team's
 * default, else null.
 *
 * THE ONE RESOLVER — the shop card, the checkout modal and the purchase receipt
 * all call this, so a studio that sets only the team default sees the same
 * sentence in all three. A blank string is NOT a note (an emptied field falls
 * back to the default rather than silencing it), which is the same convention
 * `bookingCancellationPolicy` uses one level up.
 */
export function resolveProductCollectionNote(
  product: Pick<Product, 'collectionNote'> | null | undefined,
  teamDefault?: string | null
): string | null {
  const own = (product?.collectionNote ?? '').trim()
  if (own) return own
  const fallback = (teamDefault ?? '').trim()
  return fallback || null
}
