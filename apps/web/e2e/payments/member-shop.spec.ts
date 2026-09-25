/**
 * One member buys everything the studio's public shop sells, paying each time
 * on Stripe's hosted Checkout with a test card, and every purchase is checked
 * where it lands: the Connect webhook's writes in Firestore, and the member's own
 * Space afterwards.
 *
 *   membership (monthly)  → a Stripe subscription on the studio's account, a
 *                           member_subscriptions row, the plan on the contact
 *   course block          → an enrolment on the block
 *   online course         → a lifetime purchase entitlement, unlocked in Space
 *   gift card (guest)     → a minted card with its code…
 *   …redeemed as a tender → on a product checkout, lowering what Stripe charges
 *
 * The tests run in order on one browser context: the member signs in once.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  ACCT,
  BASE_URL,
  STUDIO,
  type CallableBox,
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

const EMAIL = 'e2e-member-shop@example.com'
const GIFT_BUYER = 'e2e-gift-buyer@example.com'

test.describe.configure({ mode: 'serial' })

let context: BrowserContext
let page: Page
let errors: string[]
let contactId: string

test.beforeAll(async ({ browser }) => {
  for (const e of [EMAIL, GIFT_BUYER]) {
    await deleteContactsByEmail(STUDIO.teamId, e)
    await clearCodesFor(e)
  }
  await clearRateLimits()
  context = await browser.newContext({ baseURL: BASE_URL })
  page = await context.newPage()
  // The shop asks the FREE rail first for a course block and treats the
  // `payment_required` refusal as "go to checkout" (ShopHome.tsx): a 400 by design.
  errors = watchErrors(page, [/joinCourseBlock/, /status of 400/])
})

test.afterAll(async () => {
  await context?.close()
})

async function openShopTab(tab: string) {
  await page.goto(`/public/${STUDIO.slug}/shop`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: tab, exact: true }).click()
}

function sessionIdOf(box: CallableBox) {
  const id: string | undefined = box.body?.result?.url?.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  expect(id, `no checkout URL in ${JSON.stringify(box.body)}`).toBeTruthy()
  return id!
}

async function paidSession(sessionId: string) {
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] }, { stripeAccount: ACCT[STUDIO.teamId] })
}

test('membership: a new member buys Starter monthly', async () => {
  await openShopTab('Subscriptions')
  const starter = page.locator('div.rounded-2xl', { hasText: 'Starter' }).filter({ hasText: 'CHF 89.00' }).first()
  await starter.getByRole('button', { name: 'Buy' }).first().click()
  await contactSignIn(page, EMAIL, { first: 'Mia', last: 'Member' })
  contactId = (await findContactsByEmail(STUDIO.teamId, EMAIL))[0].id

  const box = await captureCallable(page, 'createMembershipCheckout')
  await page.getByRole('button', { name: /continue to payment/i }).click()
  await payOnStripeCheckout(page, { email: EMAIL, name: 'Mia Member' })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(page.url()).toContain('status=success')

  const session = await paidSession(sessionIdOf(box))
  expect(session.mode).toBe('subscription')
  expect(session.status).toBe('complete')
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription!.id

  const sub = await waitFor('member_subscriptions row', async () => {
    const d = await db.doc(`teams/${STUDIO.teamId}/member_subscriptions/${subId}`).get()
    return d.exists ? d.data()! : null
  })
  expect(sub.status).toMatch(/active|trialing/)
  expect(sub.contactId ?? sub.contact_id).toBe(contactId)

  const contact = await waitFor('the plan on the contact', async () => {
    const c = (await db.doc(`contacts/${contactId}`).get()).data()!
    const held = JSON.stringify([c.held_plans, c.active_subscriptions, c.subscription_type_id])
    return /starter|Starter/.test(held) || (c.active_subscriptions?.length ?? 0) > 0 ? c : null
  })
  expect(contact.provisional).not.toBe(true)
})

test('course block: the member enrols in the 8-week course', async () => {
  await openShopTab('Courses')
  const box = await captureCallable(page, 'createCourseBlockCheckout')
  await page.locator('div.rounded-2xl', { hasText: 'Beginners BJJ' }).getByRole('button', { name: 'Buy' }).click()
  const cont = page.getByRole('button', { name: /continue to payment/i })
  if (await cont.isVisible({ timeout: 10_000 }).catch(() => false)) await cont.click()
  await payOnStripeCheckout(page, { email: EMAIL })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(page.url()).toContain('status=success')

  const session = await paidSession(sessionIdOf(box))
  expect(session.payment_status).toBe('paid')
  expect(session.amount_total).toBe(32000)
  const blockId = session.metadata?.blockId
  expect(blockId).toBeTruthy()
  await waitFor('the enrolment', async () => {
    const d = await db.doc(`course_blocks/${blockId}/enrolments/${contactId}`).get()
    if (d.exists) return d.data()
    const q = await db.collection(`course_blocks/${blockId}/enrolments`).where('contactId', '==', contactId).get()
    return q.empty ? null : q.docs[0].data()
  })
})

test('online course: the member buys a lifetime course and it opens in Space', async () => {
  await openShopTab('Online courses')
  const box = await captureCallable(page, 'createCourseCheckout')
  await page.locator('div.rounded-2xl', { hasText: 'Competition Masterclass' }).getByRole('button', { name: 'Buy' }).click()
  const cont = page.getByRole('button', { name: /continue to payment/i })
  if (await cont.isVisible({ timeout: 10_000 }).catch(() => false)) await cont.click()
  await payOnStripeCheckout(page, { email: EMAIL })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })

  const session = await paidSession(sessionIdOf(box))
  expect(session.amount_total).toBe(4900)
  const courseId = session.metadata?.courseId
  await waitFor('the purchase entitlement', async () => {
    const d = await db.doc(`courses/${courseId}/purchases/${contactId}`).get()
    return d.exists ? d.data() : null
  })

  await page.goto(`/public/${STUDIO.slug}/space`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Competition Masterclass').first()).toBeVisible({ timeout: 60_000 })
})

let giftCode = ''

test('gift card: a guest buys a CHF 50 card', async ({ browser }) => {
  // A different, signed-out visitor: gift cards are the one guest-email path.
  const guest = await browser.newContext({ baseURL: BASE_URL })
  const g = await guest.newPage()
  const gErrors = watchErrors(g)
  await g.goto(`/public/${STUDIO.slug}/shop`, { waitUntil: 'domcontentloaded' })
  await g.getByRole('button', { name: 'Gift cards', exact: true }).click()
  await g.getByRole('button', { name: /CHF 50\.00/ }).click()

  await g.getByLabel('Your email').fill(GIFT_BUYER)
  const box: CallableBox = { body: null, status: 0 }
  await g.route('**/createGiftCardCheckout', async (route) => {
    const r = await route.fetch()
    box.status = r.status()
    box.body = await r.json().catch(() => null)
    await route.fulfill({ response: r })
  })
  await g.getByRole('button', { name: 'Continue to payment' }).click()
  await payOnStripeCheckout(g, { email: GIFT_BUYER, name: 'Gift Buyer' })
  await g.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(g.url()).toContain('status=success')

  const session = await paidSession(sessionIdOf(box))
  expect(session.amount_total).toBe(5000)
  const piId = (session.payment_intent as { id: string }).id
  const card = await waitFor('the minted gift card', async () => {
    const q = await db.collection(`teams/${STUDIO.teamId}/gift_cards`).where('payment_intent_id', '==', piId).get()
    return q.empty ? null : q.docs[0]
  })
  const data = card.data()
  giftCode = data.code ?? card.id
  expect(data.balance).toBe(50)
  expect(data.purchaserEmail).toBe(GIFT_BUYER)
  expect(gErrors, gErrors.join('\n')).toEqual([])
  await guest.close()
})

test('gift card tender: the member pays part of a hoodie with the card', async () => {
  test.skip(!giftCode, 'needs the gift card from the previous test')
  await openShopTab('Products')
  await page.locator('div.rounded-2xl', { hasText: 'Heavyweight Hoodie' }).getByRole('button', { name: 'Buy' }).click()
  const giftInput = page.getByPlaceholder('GC-XXXX-XXXX')
  await giftInput.fill(giftCode)
  await giftInput.locator('xpath=..').getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText(/25[.,]00/).first()).toBeVisible()

  const box = await captureCallable(page, 'createProductCheckout')
  await page.getByRole('button', { name: /continue to payment/i }).click()
  await payOnStripeCheckout(page, { email: EMAIL })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  const session = await paidSession(sessionIdOf(box))
  expect(session.amount_total).toBe(2500) // CHF 75 − CHF 50

  await waitFor('the gift card drawn down to zero', async () => {
    const d = (await db.doc(`teams/${STUDIO.teamId}/gift_cards/${giftCode}`).get()).data()
    return d?.balance === 0 ? true : null
  })
})

test('Space: the member sees every payment and can open the Stripe billing portal', async () => {
  await page.goto(`/public/${STUDIO.slug}/space/payments`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Payment history')).toBeVisible({ timeout: 60_000 })
  // membership 89, course block 320, online course 49, hoodie 25 (after the gift card)
  for (const amount of [/89[.,]00/, /320[.,]00/, /49[.,]00/, /25[.,]00/]) {
    await expect(page.getByText(amount).first()).toBeVisible()
  }
  const portal = await captureCallable(page, 'createContactBillingPortalSession')
  await page.getByRole('button', { name: 'Manage billing in Stripe' }).click()
  await page.waitForURL(/billing\.stripe\.com/, { timeout: 120_000 })
  expect(portal.status).toBe(200)
  await expect(page.getByText(/Starter|89/).first()).toBeVisible({ timeout: 60_000 })
})

test('no console errors on our pages', async () => {
  expect(errors, errors.join('\n')).toEqual([])
})
