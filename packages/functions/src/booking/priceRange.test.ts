import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appointmentPriceRange } from '@linyup/shared'

// WHAT A PUBLIC CARD SAYS AN APPOINTMENT COSTS.
//
// Five surfaces quote the same activity, the appointment picker's chip, the
// class booking card's badge line, the website's pricing block, the shop's
// pay-per-visit strip and the admin catalogue, and each one wrote the
// arithmetic out again. Four of them arrived at a range over the PRICED
// lengths, which is a floor that is not the floor as soon as one length is
// free or benefit-only.
//
// Run with: pnpm --filter @linyup/functions test

describe('appointmentPriceRange', () => {
  it('says nothing when nothing is sold individually', () => {
    assert.equal(appointmentPriceRange([{ minutes: 60 }]), null)
    assert.equal(appointmentPriceRange([{ minutes: 60, priceAmount: 45, benefitOnly: true }]), null)
    assert.equal(appointmentPriceRange([]), null)
    assert.equal(appointmentPriceRange(undefined), null)
  })

  it('quotes the plain price when every sold length agrees', () => {
    assert.deepEqual(appointmentPriceRange([{ minutes: 60, priceAmount: 45 }]), {
      kind: 'one',
      amount: 45,
    })
    // A free length beside it does not make this a range: 45 is exact, and
    // "from 45" would invent a spread. The free length is not cheaper in a way
    // a price chip can say.
    assert.deepEqual(
      appointmentPriceRange([
        { minutes: 30 },
        { minutes: 60, priceAmount: 45 },
        { minutes: 90, priceAmount: 45 },
      ]),
      { kind: 'one', amount: 45 }
    )
  })

  it('gives the range only when the range covers every length', () => {
    assert.deepEqual(
      appointmentPriceRange([
        { minutes: 30, priceAmount: 45 },
        { minutes: 60, priceAmount: 85 },
      ]),
      { kind: 'range', min: 45, max: 85 }
    )
  })

  it('falls back to "from" when a length sits outside the spread', () => {
    // THE CASE FOUR SURFACES GOT WRONG. A free intro, an hour and a double:
    // "CHF 45–80" states a floor of 45 while a length costs nothing.
    assert.deepEqual(
      appointmentPriceRange([
        { minutes: 30 },
        { minutes: 60, priceAmount: 45 },
        { minutes: 90, priceAmount: 80 },
      ]),
      { kind: 'from', amount: 45 }
    )
    // Same when the outsider is benefit-only, stale number and all (UX-70).
    assert.deepEqual(
      appointmentPriceRange([
        { minutes: 30, priceAmount: 20, benefitOnly: true },
        { minutes: 60, priceAmount: 45 },
        { minutes: 90, priceAmount: 80 },
      ]),
      { kind: 'from', amount: 45 }
    )
  })
})

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

/** Every surface that quotes an appointment's price spread. Named rather than
 *  counted. Each renders it through `priceRangeLabel`, whose input can only be
 *  the resolved shape, so a surface cannot re-derive the answer without
 *  re-introducing the comparison this file exists to remove. */
const QUOTING_SURFACES = [
  'apps/web/src/app/[locale]/(public)/public/[slug]/appointments/AppointmentPicker.tsx',
  'apps/web/src/app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx',
  'apps/web/src/app/[locale]/(public)/public/[slug]/shop/ShopHome.tsx',
  'apps/web/src/components/site/sections.tsx',
  'apps/web/src/lib/activityTerms.ts',
]

describe('no surface decides a price spread for itself', () => {
  for (const file of QUOTING_SURFACES) {
    it(`${file.split('/').pop()} renders the resolved shape`, () => {
      const src = read(file)
      assert.ok(
        /priceRangeLabel\(/.test(src),
        `${file} quotes an appointment price without priceRangeLabel`
      )
      // The symptom that was shared between all four: `min === max` as the
      // question, which cannot see a length outside the spread.
      assert.ok(
        !/\bmin\s*===\s*[\w.]*\bmax\b/.test(src),
        `${file} compares min with max again: ask appointmentPriceRange instead`
      )
    })
  }

  // A source-reading assertion is green on the day it is written whether or not
  // it works, so the pattern is run against the code as it WAS, in BOTH
  // spellings, because the first draft of this pin named the receivers it had
  // seen (`term.` and `d.`) and could not match `d.appointmentPrice.max` at all.
  // It passed against four surfaces that still held the defect.
  const AS_IT_WAS = [
    `d.appointmentPrice.min === d.appointmentPrice.max
       ? t('termFrom', { price: formatCurrency(d.appointmentPrice.min, currency) })
       : null`,
    `return term.min === term.max
       ? formatMoney(term.min ?? 0, currency)
       : null`,
    `if (min === max) return formatCurrency(min, currency, locale)`,
  ]
  for (const [i, asItWas] of AS_IT_WAS.entries()) {
    it(`the pin is capable of failing (${i + 1})`, () => {
      assert.ok(/\bmin\s*===\s*[\w.]*\bmax\b/.test(asItWas))
    })
  }
})
