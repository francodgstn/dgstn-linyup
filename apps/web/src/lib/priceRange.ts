// SAYING a price spread. The DERIVATION is `appointmentPriceRange` in
// @linyup/shared (beside `resolveDurationSale`, which decides what is sold at
// all); this is the half that needs words.
//
// Same division as `activityTerms.ts` next door ("ONE place computes which
// chips apply; each surface renders them"), because the words differ per
// surface and the answer must not: an appointment picker's chip, a class
// card's badge line, the website's pricing block, the shop's pay-per-visit
// strip and the admin catalogue all quote the same activity, out of five i18n
// namespaces.
//
// Before this existed, only the appointment picker knew the 'from' case. The
// other four rendered a range whose floor excluded every free or benefit-only
// length, and two of them said "From CHF 45" when all lengths cost exactly 45.

import type { PriceRange } from '@linyup/shared'

/** The words. Each surface passes its own, so one derivation reads as
 *  "From CHF 45" on a chip and "ab CHF 45" in a sentence. */
export interface PriceRangeCopy {
  money: (amount: number) => string
  from: (price: string) => string
  /** Given already-formatted endpoints. A surface with no range key of its own
   *  joins them with an en dash. */
  range: (min: string, max: string) => string
}

export function priceRangeLabel(range: PriceRange, copy: PriceRangeCopy): string {
  switch (range.kind) {
    case 'one':
      return copy.money(range.amount)
    case 'from':
      return copy.from(copy.money(range.amount))
    case 'range':
      return copy.range(copy.money(range.min), copy.money(range.max))
  }
}
