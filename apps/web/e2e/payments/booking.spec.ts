/**
 * The public booking funnel's priced doors, each paid for real:
 *
 *   open drop-in (guest)       → createDropInCheckout → Stripe → the booking confirmed
 *   sign-up-only drop-in       → a registered member signs in, then pays; a stranger is
 *                                sent to sign up, and the server refuses before any write
 *   drop-in paid by gift card  → no Stripe at all (`paidWithGiftCard`), booking confirmed
 *   priced trial (guest)       → the trial door of a plan-gated class, trial_used_at stamped
 *   paid appointment (guest)   → the hold IS the session: pending_payment → full on payment
 *
 * Guests, deliberately: every one of these doors takes a newcomer without an
 * account, and that is the path a studio's first customers will use.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  ACCT,
  FUNCTIONS_BASE,
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
  admin,
} from './lib'

const DROPIN = 'e2e-dropin-guest@example.com'
const GIFT = 'e2e-dropin-gift@example.com'
const TRIAL = 'e2e-trial-guest@example.com'
const APPT = 'e2e-appointment-guest@example.com'
const OPEN = 'e2e-open-dropin@example.com'
const YOGA = 'seed-team-studio-act-yoga'

const MMA = 'seed-team-studio-act-mma'
const KICKBOX = 'seed-team-studio-act-kickbox'
const APPOINTMENT = 'seed-team-studio-act-appointment'
const GIFT_CODE = 'GC-E2E-BOOKING'
/** A seeded contact who has signed up (joined) and holds no plan. */
const EMMA = {
  id: 'seed-team-studio-contact-005',
  first: 'Emma',
  last: 'Schneider',
  email: 'emma.schneid.seed-team-studio@email.com',
}

let kickboxBefore: FirebaseFirestore.DocumentData | undefined
let yogaBefore: FirebaseFirestore.DocumentData | undefined

test.beforeAll(async () => {
  for (const e of [DROPIN, GIFT, TRIAL, APPT, OPEN]) await deleteContactsByEmail(STUDIO.teamId, e)
  // An OPEN drop-in (anyone may pay, plan holders free): the commonest setup.
  const yoga = db.doc(`activities/${YOGA}`)
  yogaBefore = (await yoga.get()).data()
  await yoga.update({
    dropIn: { mode: 'custom', priceAmount: 25 },
    accessRule: { audience: 'anyone', subscriptionTypeIds: ['seed-team-studio-sub-starter'] },
  })
  // A fresh CHF 100 card for the gift-card door, so a rerun never meets a spent one.
  await db.doc(`teams/${STUDIO.teamId}/gift_cards/${GIFT_CODE}`).set({
    code: GIFT_CODE,
    teamId: STUDIO.teamId,
    amount: 100,
    balance: 100,
    currency: 'CHF',
    status: 'active',
    purchaserContactId: null,
    purchaserEmail: null,
    payment_intent_id: null,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  })
  // A priced trial needs a PLAN-GATED class: a plan includes it and no door sells
  // it (docs/class-access-derived.md). Kickboxing is made one for this spec.
  const ref = db.doc(`activities/${KICKBOX}`)
  kickboxBefore = (await ref.get()).data()
  await ref.update({
    accessRule: { audience: 'anyone', subscriptionTypeIds: ['seed-team-studio-sub-starter'] },
    trialEnabled: true,
    trialPriceAmount: 20,
  })
  await waitFor('the kickboxing mirror to carry the trial price', async () => {
    const q = await db.collectionGroup('public_profile').where('type', '==', 'activity').get()
    const m = q.docs.find((d) => d.id === KICKBOX || d.data().id === KICKBOX)?.data()
    return m && m.trialPriceAmount === 20 ? true : null
  }, 120_000)
})

test.afterAll(async () => {
  if (kickboxBefore) await db.doc(`activities/${KICKBOX}`).set(kickboxBefore)
  if (yogaBefore) await db.doc(`activities/${YOGA}`).set(yogaBefore)
})

/** Open a class's first bookable session and return its id (from the URL). */
async function openFirstSession(page: Page, activityId: string) {
  await page.goto(`/public/${STUDIO.slug}/booking?activity=${activityId}`, { waitUntil: 'domcontentloaded' })
  // The first slot button carries a time range "HH:MM – HH:MM".
  const slot = page.getByRole('button', { name: /\d{2}:\d{2} – \d{2}:\d{2}/ }).first()
  await slot.click()
  await page.waitForURL(/session=/)
  return new URL(page.url()).searchParams.get('session')!
}

async function fillDetails(page: Page, first: string, last: string, email: string) {
  await page.getByLabel(/^First name/).fill(first)
  await page.getByLabel(/^Last name/).fill(last)
  await page.getByLabel(/^Email/).fill(email)
}

/**
 * Press the funnel's Confirm, and sign the studio's required waiver when the
 * funnel asks for it (it does for anyone who has not signed the current version,
 * docs/waivers.md). Returns once the click that leaves the funnel is made.
 */
async function confirmAndSign(page: Page) {
  await page.getByRole('button', { name: 'Confirm' }).last().click()
  const accept = page.getByRole('checkbox', { name: /I have read and accept/ })
  const waiver = await Promise.race([
    accept.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true),
    page.waitForURL(/checkout\.stripe\.com|\/pay\/result/, { timeout: 30_000 }).then(() => false),
  ]).catch(() => false)
  if (!waiver) return
  await accept.check()
  await page.getByRole('radio', { name: 'I am the participant' }).check()
  await page.getByRole('button', { name: 'Confirm' }).last().click()
}

async function bookingOf(sessionId: string, email: string) {
  const [c] = await findContactsByEmail(STUDIO.teamId, email)
  if (!c) return null
  const b = await db.doc(`sessions/${sessionId}/bookings/${c.id}`).get()
  return b.exists ? { contact: c, booking: b.data()! } : null
}

test('drop-in, sign-up-only class: a registered member signs in, then pays CHF 30', async ({ page }) => {
  // MMA is seeded behind "Only people who signed up with you". Its drop-in door
  // signs the member in first (no guest form), then the member step takes the
  // payment as that contact.
  const errors = watchErrors(page)
  const sessionId = await openFirstSession(page, MMA)
  await db.doc(`sessions/${sessionId}/bookings/${EMMA.id}`).delete() // a rerun's leftover
  await expect(page.getByText(/Sign in and pay CHF\s30\.00/)).toBeVisible()
  await clearCodesFor(EMMA.email)
  await clearRateLimits()
  await page.getByRole('button', { name: /Pay for a single class/ }).click()
  await contactSignIn(page, EMMA.email)
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  const box = await captureCallable(page, 'createDropInCheckout')
  await confirmAndSign(page)
  await payOnStripeCheckout(page, { email: EMMA.email, name: `${EMMA.first} ${EMMA.last}` })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(page.url()).toContain('status=success')

  const csId = box.body?.result?.url?.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  const cs = await stripe.checkout.sessions.retrieve(csId, undefined, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(cs.amount_total).toBe(3000)

  const booking = await waitFor('the paid drop-in booking', async () => {
    const b = (await db.doc(`sessions/${sessionId}/bookings/${EMMA.id}`).get()).data()
    return b && b.status === 'confirmed' && b.payment_status !== 'required' ? b : null
  })
  expect(booking.payment_intent_id ?? booking.paymentIntentId).toBeTruthy()
  expect(errors, errors.join('\n')).toEqual([])
})

test('drop-in, sign-up-only class: a stranger is sent to sign up, and the server writes nothing', async ({ page }) => {
  // "Visitors cannot book even paying" (docs/class-access-derived.md).
  const errors = watchErrors(page)
  const sessionId = await openFirstSession(page, MMA)
  await clearCodesFor(DROPIN)
  await clearRateLimits()
  await page.getByRole('button', { name: /Pay for a single class/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('your@email.com').fill(DROPIN)
  await dialog.getByRole('button', { name: /send verification code/i }).click()
  const code = await waitFor('the code', async () => {
    const q = await db.collection('verification_codes').where('email', '==', DROPIN).get()
    return q.docs[0]?.data().code as string | undefined
  })
  await dialog.getByPlaceholder('000000').fill(code)
  await dialog.getByRole('button', { name: /^verify$/i }).click()
  // No registration on this door: the way in is the studio's own sign-up.
  await expect(dialog.getByText('Sign up for membership')).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByRole('button', { name: /create account/i })).toHaveCount(0)

  // The server's own guard, for a request that skips the page: refused before
  // any write, with the reason the funnel turns into words.
  const res = await fetch(`${FUNCTIONS_BASE}/rpcCheckout/createDropInCheckout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        teamId: STUDIO.teamId,
        sessionId,
        contactDetails: { firstname: 'Dora', lastname: 'Dropin', email: DROPIN },
        locale: 'en',
      },
    }),
  })
  const body = await res.json()
  expect(res.status).toBe(400)
  expect(body.error?.details?.reason).toBe('guest')
  expect(await findContactsByEmail(STUDIO.teamId, DROPIN)).toHaveLength(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('drop-in: a gift card covering the whole price books without Stripe', async ({ page }) => {
  const errors = watchErrors(page)
  const sessionId = await openFirstSession(page, YOGA)
  await page.getByRole('button', { name: /Pay for a single class/ }).click()
  await fillDetails(page, 'Gina', 'Giftcard', GIFT)
  const gift = page.getByPlaceholder('GC-XXXX-XXXX')
  await gift.fill(GIFT_CODE)
  await gift.locator('xpath=..').getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText(/available/i).first()).toBeVisible()
  const box = await captureCallable(page, 'createDropInCheckout')
  await confirmAndSign(page)
  await expect.poll(() => box.status, { timeout: 120_000 }).toBe(200)
  expect(box.body?.result?.paidWithGiftCard).toBe(true)
  expect(page.url()).not.toContain('checkout.stripe.com')

  await waitFor('the gift-card booking', async () => {
    const r = await bookingOf(sessionId, GIFT)
    return r && r.booking.status === 'confirmed' ? r : null
  })
  const card = (await db.doc(`teams/${STUDIO.teamId}/gift_cards/${GIFT_CODE}`).get()).data()!
  expect(card.balance).toBe(75)
  expect(errors, errors.join('\n')).toEqual([])
})

test('priced trial: a newcomer pays CHF 20 for a first kickboxing class', async ({ page }) => {
  const errors = watchErrors(page)
  const sessionId = await openFirstSession(page, KICKBOX)
  await page.getByRole('button', { name: /First time here/ }).click()
  await fillDetails(page, 'Tina', 'Trial', TRIAL)
  const box = await captureCallable(page, 'createDropInCheckout')
  await confirmAndSign(page)
  await payOnStripeCheckout(page, { email: TRIAL, name: 'Tina Trial' })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })

  const csId = box.body?.result?.url?.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  const cs = await stripe.checkout.sessions.retrieve(csId, undefined, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(cs.amount_total).toBe(2000)

  const got = await waitFor('the paid trial booking', async () => {
    const r = await bookingOf(sessionId, TRIAL)
    return r && r.booking.status === 'confirmed' && r.booking.payment_status !== 'required' ? r : null
  })
  const contact = (await got.contact.ref.get()).data()!
  expect(contact.trial_used_at).toBeTruthy()
  expect(errors, errors.join('\n')).toEqual([])
})

test('paid appointment: a guest books and pays a 30-minute session', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(`/public/${STUDIO.slug}/booking?activity=${APPOINTMENT}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /30m · CHF 45\.00/ }).click()
  // The LAST offered start of the first day with any, so reruns and the other
  // appointment spec rarely collide on one slot.
  const starts = page.getByRole('button', { name: /^\d{2}:\d{2}$/ })
  await starts.first().waitFor()
  await starts.last().click()
  await page.waitForURL(/start=\d+/)
  const startMs = Number(new URL(page.url()).searchParams.get('start'))
  await fillDetails(page, 'Arno', 'Appointment', APPT)
  const box = await captureCallable(page, 'createAppointmentCheckout')
  await confirmAndSign(page)
  await payOnStripeCheckout(page, { email: APPT, name: 'Arno Appointment' })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(page.url()).toContain('status=success')

  const csId = box.body?.result?.url?.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  const cs = await stripe.checkout.sessions.retrieve(csId, undefined, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(cs.amount_total).toBe(4500)

  const session = await waitFor('the appointment session confirmed', async () => {
    const q = await db.collection('sessions').where('activityId', '==', APPOINTMENT).get()
    const s = q.docs.find((d) => {
      const x = d.data()
      const t = x.start?.toMillis?.() ?? x.startTime?.toMillis?.() ?? x.date?.toMillis?.()
      return t === startMs
    })
    const x = s?.data()
    return x && x.status !== 'pending_payment' ? x : null
  })
  expect(session.hold_expires_at ?? null).toBeNull()
  expect(errors, errors.join('\n')).toEqual([])
})

test('open drop-in: a guest pays the CHF 25 drop-in of a class anyone may pay for', async ({ page }) => {
  // The commonest studio setup: "CHF 25 per class, plan holders free". Yoga is
  // made one for this spec (restored in afterAll).
  const errors = watchErrors(page)
  const sessionId = await openFirstSession(page, YOGA)
  await page.getByRole('button', { name: /First time here|Pay for a single class/ }).first().click()
  await expect(page.getByText(/25[.,]00/).first()).toBeVisible()
  await fillDetails(page, 'Opal', 'Open', OPEN)
  const drop = await captureCallable(page, 'createDropInCheckout')
  const free = await captureCallable(page, 'bookSession')
  await confirmAndSign(page)
  await payOnStripeCheckout(page, { email: OPEN, name: 'Opal Open' })
  await page.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(free.status, 'the free rail must not be asked').toBe(0)
  const csId = drop.body?.result?.url?.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  const cs = await stripe.checkout.sessions.retrieve(csId, undefined, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(cs.amount_total).toBe(2500)
  await waitFor('the paid booking', async () => {
    const r = await bookingOf(sessionId, OPEN)
    return r && r.booking.status === 'confirmed' && r.booking.payment_status !== 'required' ? r : null
  })
  expect(errors, errors.join('\n')).toEqual([])
})
