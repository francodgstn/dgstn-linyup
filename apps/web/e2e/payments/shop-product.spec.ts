/**
 * A NEW customer buys a product in the public shop and pays with a test card.
 *
 * Proves the whole Connect one-off rail for a first-time buyer: login-first
 * registration (a provisional contact), createProductCheckout (a DIRECT charge on
 * the studio's connected account), Stripe's hosted Checkout, the return to
 * /pay/result, and the Connect webhook that records the member payment, stamps
 * the contact on it and confirms the provisional contact.
 */
import { test, expect } from '@playwright/test'
import {
  ACCT,
  CARD_DECLINED,
  STUDIO,
  captureCallable,
  clearCodesFor,
  clearRateLimits,
  contactSignIn,
  db,
  deleteContactsByEmail,
  findContactsByEmail,
  payOnStripeCheckout,
  stripe,
  waitFor,
  watchErrors,
} from './lib'

const EMAIL = 'e2e-shop-product@example.com'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await deleteContactsByEmail(STUDIO.teamId, EMAIL)
  await clearCodesFor(EMAIL)
  await clearRateLimits()
})

test('new customer buys a product and the payment lands on their contact', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(`/public/${STUDIO.slug}/shop`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Products', exact: true }).click()

  const card = page.locator('div.rounded-2xl', { hasText: 'Insulated Water Bottle' })
  await card.getByRole('button', { name: 'Buy' }).click()
  await contactSignIn(page, EMAIL, { first: 'Erin', last: 'Shopper' })

  const checkout = await captureCallable(page, 'createProductCheckout')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await payOnStripeCheckout(page, { email: EMAIL, name: 'Erin Shopper' })

  // Back on our result page.
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(page.url()).toContain('status=success')
  await expect(page.locator('body')).not.toContainText(/something went wrong|error/i)

  const sessionId: string = checkout.body?.result?.url?.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  expect(sessionId, JSON.stringify(checkout.body)).toBeTruthy()
  const session = await stripe.checkout.sessions.retrieve(sessionId, undefined, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(session.payment_status).toBe('paid')
  expect(session.amount_total).toBe(2800)
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent!.id

  // The webhook wrote the member payment, with the buyer's contact on it.
  const payment = await waitFor('member_payments row with a contactId', async () => {
    const d = await db.doc(`teams/${STUDIO.teamId}/member_payments/${piId}`).get()
    return d.exists && d.data()!.contactId ? d.data()! : null
  })
  const [contact] = await findContactsByEmail(STUDIO.teamId, EMAIL)
  expect(contact, 'the registered contact').toBeTruthy()
  expect(payment.contactId).toBe(contact.id)
  expect(payment.amount ?? payment.amount_minor ?? null).not.toBeNull()

  // The purchase confirmed the provisional registration: it must not be purged.
  await waitFor('contact confirmed (not provisional)', async () => {
    const c = (await contact.ref.get()).data()!
    return c.provisional !== true
  })

  expect(errors, errors.join('\n')).toEqual([])
})

test('a declined card is refused on Stripe, and going back records nothing', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(`/public/${STUDIO.slug}/shop`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Products', exact: true }).click()
  await page.locator('div.rounded-2xl', { hasText: 'Training Tee' }).getByRole('button', { name: 'Buy' }).click()
  // A fresh browser: the now-registered buyer signs in, no registration step.
  await clearCodesFor(EMAIL)
  await contactSignIn(page, EMAIL)
  const checkout = await captureCallable(page, 'createProductCheckout')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await payOnStripeCheckout(page, { email: EMAIL, name: 'Erin Shopper', card: CARD_DECLINED })
  // Stripe keeps the buyer on its page and says why.
  await expect(page.getByText(/declined/i).first()).toBeVisible({ timeout: 60_000 })
  expect(page.url()).toContain('checkout.stripe.com')

  const sessionId: string = checkout.body?.result?.url?.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  const session = await stripe.checkout.sessions.retrieve(sessionId, undefined, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(session.payment_status).toBe('unpaid')

  // Stripe's back link returns to our cancelled result, and nothing was sold.
  await page.goto(session.cancel_url!)
  await expect(page.getByText('Payment cancelled')).toBeVisible({ timeout: 60_000 })
  const [contact] = await findContactsByEmail(STUDIO.teamId, EMAIL)
  const q = await db.collection(`teams/${STUDIO.teamId}/member_payments`).where('contactId', '==', contact.id).get()
  expect(q.docs.filter((d) => d.data().status === 'succeeded' && d.data().amount === 3500)).toHaveLength(0)
  expect(errors, errors.join('\n')).toEqual([])
})
