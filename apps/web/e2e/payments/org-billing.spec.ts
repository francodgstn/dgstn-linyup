/**
 * Organisation billing: the ORG pays Linyup for its member studios.
 *
 *   member studio → its own Billing page says the organisation pays, in the
 *                   studio's language, and offers no checkout of its own
 *   org subscribe → an org with no paid subscription subscribes on the
 *                   platform's Stripe Checkout, comes back to its billing page,
 *                   and handleStripeWebhook writes saas_subscriptions/{orgId}
 *
 * Nothing in an organisation sells to MEMBERS (events carry a free-text fee,
 * affiliations are labels), so there is no member-side org payment to test.
 */
import { test, expect } from '@playwright/test'
import { captureCallable, db, payOnStripeCheckout, staffContext, stripe, waitFor, watchErrors } from './lib'

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

// OPEN DECISION (docs/launch/payments-e2e-2026-09.md, "Organisation checkout").
// The org Billing page offers a self-serve "Subscribe", but the price it looks up,
// `linyup_organization_monthly`, is ARCHIVED on the platform (scripts/stripe-sync.ts
// treats the org tier as sales-led and never creates it), so the callable fails
// with "The price specified is inactive" and the page says "Failed to create
// checkout session". Either the button becomes "Talk to us", or the price goes
// live; this test is the self-serve half and waits on that call.
test.fixme('org subscribe: an organisation without a paid plan subscribes on Stripe', async ({ browser }) => {
  // The seed marks the org active with no Stripe subscription behind it; put it
  // back to what a new organisation looks like before it pays.
  const subRef = db.doc(`saas_subscriptions/${ORG}`)
  const prev = (await subRef.get()).data()
  const prevId = prev?.gateway_data?.subscription_id as string | undefined
  if (prevId) await stripe.subscriptions.cancel(prevId).catch(() => {})
  await subRef.set(
    { entity_type: 'organization', entity_id: ORG, plan: 'organization', status: 'trialing', gateway_type: null, gateway_data: null },
    { merge: false }
  )
  await db.doc(`organizations/${ORG}`).set({ plan_status: 'trialing' }, { merge: true })
  const attempts = await db.collection('saas_checkout_attempts').where('orgId', '==', ORG).get()
  for (const d of attempts.docs) await d.ref.delete()

  const ctx = await staffContext(browser, 'org@linyup.com')
  const page = await ctx.newPage()
  const errors = watchErrors(page, [/status of 500/, /Encountered a script tag/])
  await page.goto(`/org/${ORG}/billing`, { waitUntil: 'domcontentloaded' })
  const box = await captureCallable(page, 'createOrgCheckoutSession')
  await page.getByRole('button', { name: 'Subscribe' }).click()
  await expect.poll(() => box.status, { timeout: 120_000 }).not.toBe(0)
  expect(box.status, JSON.stringify(box.body)).toBe(200)
  await payOnStripeCheckout(page, { name: 'Rafael Torres' })
  await page.waitForURL(new RegExp(`/org/${ORG}/billing\\?checkout=success`), { timeout: 120_000 })

  const sub = await waitFor('the org subscription written by the webhook', async () => {
    const d = (await subRef.get()).data()
    return d?.gateway_data?.subscription_id && d.status === 'active' ? d : null
  })
  const s = await stripe.subscriptions.retrieve(sub.gateway_data.subscription_id)
  expect(s.items.data.map((i) => i.price.lookup_key)).toContain('linyup_organization_monthly')
  expect(errors, errors.join('\n')).toEqual([])
  await ctx.close()
})
