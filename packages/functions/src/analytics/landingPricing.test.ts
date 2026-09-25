// THE LANDING SITE'S COPY OF THE ORGANIZATION'S PRICING NUMBERS.
//
// `apps/landing` cannot import `@linyup/shared`: it compiles to CommonJS and
// Astro's Rollup build fails on it outright, which is why every price on that
// page is hand-copied — the plan prices into four locale files, the
// contact-block note into four more, the payment fees again.
//
// The organization's numbers, and the per-tier CONTACT CAPS, are mirrored into
// ONE place (the Pricing.astro
// frontmatter) instead of being scattered, and this test keeps that mirror honest.
// It reads the .astro source and compares it to plan.ts, so raising the rate in
// one place and forgetting the other fails the build rather than quietly showing
// visitors a price the product does not charge.
//
// It spans the functions/landing boundary on purpose — the same technique as
// connect/commitSites.test.ts, and for the same reason: that boundary is where
// corrections stop traveling.

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ORG_MAX_LISTED_STUDIOS, ORG_MIN_STUDIOS, ORG_PER_STUDIO, PLAN_PRICING } from '@linyup/shared'

const ROOT = join(__dirname, '..', '..', '..', '..')
const PRICING = join(ROOT, 'apps', 'landing', 'src', 'components', 'Pricing.astro')

function constant(src: string, name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(src)
  assert.ok(m, `${name} is not declared in Pricing.astro — did the mirror move?`)
  return Number(m[1])
}

describe('the landing page mirrors the organization pricing exactly', () => {
  const src = readFileSync(PRICING, 'utf8')

  it('the per-studio rate matches', () => {
    assert.equal(
      constant(src, 'ORG_RATE_MONTHLY'),
      ORG_PER_STUDIO.monthly,
      'the landing page would advertise a rate the product does not charge'
    )
  })

  it('the minimum matches', () => {
    assert.equal(
      constant(src, 'ORG_MIN_STUDIOS'),
      ORG_MIN_STUDIOS,
      'the card would state a floor the tier does not have'
    )
  })

  it('the listed maximum matches', () => {
    assert.equal(
      constant(src, 'ORG_MAX_LISTED_STUDIOS'),
      ORG_MAX_LISTED_STUDIOS,
      'the calculator would switch to a quote at a different size than the product does'
    )
  })

  it('says "per studio", never "from"', () => {
    // "From CHF 25" describes a price that climbs with size. This rate is flat —
    // the tenth studio costs what the second did — so the word is wrong, and it
    // is the framing the tier carried before the 2026-08-28 change.
    assert.ok(
      !/plans\.orgFrom/.test(src),
      'the org card still renders the "From" label'
    )
    assert.ok(
      /plans\.perStudioMonth/.test(src),
      'the org card must state the unit — a bare number reads as the whole price'
    )
  })

  // The caps used to be four literals in the comparison row. A cap raised in
  // plan.ts and forgotten here shows a visitor an allowance the product does not
  // grant — the same failure mode as the org rate, one row down.
  const CAPS: [string, 'free' | 'coach' | 'studio'][] = [
    ['FREE_CONTACTS', 'free'],
    ['COACH_CONTACTS', 'coach'],
    ['STUDIO_CONTACTS', 'studio'],
  ]

  for (const [name, plan] of CAPS) {
    it(`the ${plan} contact cap matches`, () => {
      assert.equal(
        constant(src, name),
        PLAN_PRICING[plan].includedContacts,
        `the comparison table would advertise a ${plan} allowance the product does not grant`
      )
    })
  }

  it('the org card never goes through the currency/amount split', () => {
    // The other cards store "CHF 18" and split on the first space. "CHF 25 per
    // studio" splits into currency "CHF" and amount "25 per studio", rendered at
    // 34px — no error, just a broken card. The org branch renders the mirrored
    // NUMBER instead, which also keeps the rate out of four locale files.
    const guarded = /isOrg\s*\n?\s*\?\s*\['CHF',\s*String\(ORG_RATE_MONTHLY\)\]/.test(src)
    assert.ok(guarded, 'the org branch must bypass the split and render the mirrored rate')
  })
})
