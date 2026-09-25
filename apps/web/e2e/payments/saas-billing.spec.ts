/**
 * The studio paying LINYUP: the free seed studio (Sunrise Yoga, free@linyup.com)
 * upgrades to Coach through the platform's own Stripe Checkout, then manages it.
 *
 *   upgrade  → Settings → Billing → Coach "Select" → Stripe Checkout (platform
 *              account, not Connect) → back to /billing?checkout=success →
 *              handleStripeWebhook writes saas_subscriptions and the team's plan
 *   portal   → "Update payment method" opens the Stripe billing portal
 *   cancel   → "Cancel subscription" → the subscription cancels at period end
 *   resume   → "Resume plan" → it renews again
 *
 * Every run starts the team from Free: a previous run's Stripe subscription is
 * canceled on Stripe and the Firestore state reset, so the upgrade is real
 * each time.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { captureCallable, db, payOnStripeCheckout, staffContext, stripe, waitFor, watchErrors } from './lib'

const TEAM = 'seed-team-free'

test.describe.configure({ mode: 'serial' })

let context: BrowserContext
let page: Page
let errors: string[]

test.beforeAll(async ({ browser }) => {
  const subRef = db.doc(`saas_subscriptions/${TEAM}`)
  const prev = (await subRef.get()).data()
  const subId = prev?.gateway_data?.subscription_id as string | undefined
  if (subId) await stripe.subscriptions.cancel(subId).catch(() => {})
  await subRef.delete()
  await db.doc(`teams/${TEAM}`).set({ plan: 'free', plan_status: 'active' }, { merge: true })
  const attempts = await db.collection('saas_checkout_attempts').where('teamId', '==', TEAM).get()
  for (const d of attempts.docs) await d.ref.delete()

  context = await staffContext(browser, 'free@linyup.com')
  page = await context.newPage()
  errors = watchErrors(page, [/status of 500/, /Encountered a script tag/])
})

test.afterAll(async () => {
  await context?.close()
})

let subscriptionId = ''

test('upgrade: the free studio buys Coach on Stripe and lands back on an active plan', async () => {
  await page.goto('/settings/billing', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Choose a plan')).toBeVisible({ timeout: 60_000 })
  const coach = page.locator('div', { has: page.getByRole('button', { name: 'Select' }) }).filter({ hasText: /Coach/ }).last()
  const box = await captureCallable(page, 'createCheckoutSession')
  await coach.getByRole('button', { name: 'Select' }).click()
  await payOnStripeCheckout(page, { name: 'Luca Bianchi' })
  await page.waitForURL(/\/billing\?checkout=success/, { timeout: 120_000 })
  expect(new URL(page.url()).origin).toBe(new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000').origin) // back on THIS app
  await expect(page.getByText('Your plan is active.')).toBeVisible({ timeout: 60_000 })

  const url: string = box.body?.result?.url
  const session = await stripe.checkout.sessions.retrieve(url.match(/cs_test_[A-Za-z0-9]+/)![0])
  expect(session.mode).toBe('subscription')
  expect(session.amount_total).toBe(900)

  const sub = await waitFor('saas_subscriptions written by the webhook', async () => {
    const d = (await db.doc(`saas_subscriptions/${TEAM}`).get()).data()
    return d?.gateway_data?.subscription_id && d.status === 'active' ? d : null
  })
  expect(sub.plan).toBe('coach')
  subscriptionId = sub.gateway_data.subscription_id
  await waitFor('the team on Coach', async () => {
    const t = (await db.doc(`teams/${TEAM}`).get()).data()
    return t?.plan === 'coach' && t.plan_status === 'active' ? true : null
  })
})

test('portal: "Update payment method" opens the Stripe billing portal', async () => {
  test.skip(!subscriptionId, 'needs the subscription from the upgrade')
  await page.goto('/settings/billing', { waitUntil: 'domcontentloaded' })
  const box = await captureCallable(page, 'getBillingPortalUrl')
  await page.getByRole('button', { name: 'Update payment method' }).click()
  await page.waitForURL(/billing\.stripe\.com/, { timeout: 120_000 })
  expect(box.status).toBe(200)
})

test('cancel, then resume: the plan cancels at period end and renews again', async () => {
  test.skip(!subscriptionId, 'needs the subscription from the upgrade')
  await page.goto('/settings/billing', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Cancel subscription' }).first().click()
  const confirm = page.locator('[role=dialog], [role=alertdialog]').last()
  const cancel = await captureCallable(page, 'cancelSaasSubscription')
  await confirm.getByRole('button', { name: 'Cancel subscription' }).click()
  await expect.poll(() => cancel.status, { timeout: 120_000 }).toBe(200)
  await waitFor('Stripe says cancel at period end', async () => {
    const s = await stripe.subscriptions.retrieve(subscriptionId)
    return s.cancel_at_period_end || s.cancel_at ? true : null
  })
  await waitFor('the studio still on Coach until the period ends', async () => {
    const t = (await db.doc(`teams/${TEAM}`).get()).data()
    return t?.plan === 'coach' ? true : null
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  const resume = await captureCallable(page, 'reactivateSaasSubscription')
  await page.getByRole('button', { name: 'Resume plan' }).click()
  await expect.poll(() => resume.status, { timeout: 120_000 }).toBe(200)
  await waitFor('Stripe renews again', async () => {
    const s = await stripe.subscriptions.retrieve(subscriptionId)
    return !s.cancel_at_period_end && !s.cancel_at ? true : null
  })
})

test('add-on: a Coach studio adds Gamification and the subscription gains the item', async () => {
  test.skip(!subscriptionId, 'needs the subscription from the upgrade')
  await db.doc(`teams/${TEAM}/installed_plugins/gamification`).delete()
  await page.goto('/plugins', { waitUntil: 'domcontentloaded' })
  const card = page.locator('[role=button]').filter({ hasText: 'Gamification' }).first()
  const box = await captureCallable(page, 'activatePluginAddon')
  await card.locator('button', { hasText: 'Add · CHF 5/mo' }).click()
  // "Gamification will be added to your subscription for CHF 5/mo."
  await page.getByRole('button', { name: 'Add to subscription' }).click()
  await expect.poll(() => box.status, { timeout: 120_000 }).toBe(200)
  await waitFor('the add-on on the Stripe subscription', async () => {
    const s = await stripe.subscriptions.retrieve(subscriptionId)
    return s.items.data.some((i) => i.price.lookup_key === 'linyup_addon_gamification_monthly') ? true : null
  })
  await waitFor('the plugin installed', async () => {
    const d = (await db.doc(`teams/${TEAM}/installed_plugins/gamification`).get()).data()
    return d?.status === 'active' ? true : null
  })
})

test('no console errors on the billing pages', async () => {
  expect(errors, errors.join('\n')).toEqual([])
})
