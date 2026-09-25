/**
 * Organisation billing: the ORG pays Linyup for its member studios.
 *
 *   member studio → its own Billing page says the organisation pays, in the
 *                   studio's language, and offers no checkout of its own
 *   org, unpaid   → offered "Talk to us" (the tier is sales-led), never a
 *                   self-serve checkout
 *
 * Nothing in an organisation sells to MEMBERS (events carry a free-text fee,
 * affiliations are labels), so there is no member-side org payment to test.
 */
import { test, expect } from '@playwright/test'
import { db, staffContext, watchErrors } from './lib'

const ORG = 'seed-org'

test('member studio: billing is the organisation\'s, said in the studio\'s language', async ({ browser }) => {
  const ctx = await staffContext(browser, 'studio@linyup.com')
  const page = await ctx.newPage()
  await page.goto('/settings/billing', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Billing managed by your organisation')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Select' })).toHaveCount(0)
  await page.goto('/de/settings/billing', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Die Abrechnung läuft über Ihre Organisation')).toBeVisible({ timeout: 60_000 })
  await ctx.close()
  // Visiting /de saved German as studio@'s language (AuthContext mirrors an
  // explicit choice onto the profile); put it back so the other specs read English.
  await db.doc('users/seed-studio-uid').set({ locale: 'en' }, { merge: true })
})

// SALES-LED (decided 2026-09-25). The organisation tier has no live self-serve
// price (`linyup_organization_monthly` is archived; scripts/stripe-sync.ts
// treats the tier as quoted), so the "Subscribe" this page used to offer always
// failed at Stripe. An organisation without a paid plan is offered "Talk to us",
// the same door as the Organisation card on a studio's plan picker, and nothing
// reaches Stripe.
test('org without a paid plan: "Talk to us", never a checkout', async ({ browser }) => {
  // The seed marks the org active with no Stripe subscription behind it; show
  // the page what a new, unpaid organisation looks like, and put it back after.
  const subRef = db.doc(`saas_subscriptions/${ORG}`)
  const before = (await subRef.get()).data()
  await subRef.set({ status: 'trialing', gateway_type: null, gateway_data: null }, { merge: true })
  const ctx = await staffContext(browser, 'org@linyup.com')
  const page = await ctx.newPage()
  const errors = watchErrors(page, [/status of 500/, /Encountered a script tag/])
  let checkoutCalls = 0
  page.on('request', (r) => {
    if (r.url().includes('createOrgCheckoutSession')) checkoutCalls++
  })
  try {
    await page.goto(`/org/${ORG}/billing`, { waitUntil: 'domcontentloaded' })
    const talk = page.getByRole('button', { name: 'Talk to us' })
    await expect(talk).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Subscribe' })).toHaveCount(0)
    await talk.click()
    await page.waitForTimeout(2_000)
    expect(checkoutCalls).toBe(0)
    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await ctx.close()
    if (before) await subRef.set(before)
  }
})
