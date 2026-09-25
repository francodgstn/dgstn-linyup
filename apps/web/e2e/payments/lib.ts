/**
 * Shared plumbing for the payments e2e suite (apps/web/e2e/payments).
 *
 * The suite drives REAL money paths in Stripe TEST mode against one local slot:
 * the browser clicks through Linyup, fills Stripe's hosted Checkout with a test
 * card, `stripe listen` forwards the resulting webhooks to the slot's functions
 * emulator, and the assertions read what the webhook wrote in Firestore, plus,
 * where the number matters, what Stripe itself recorded. Preconditions are in
 * ./README.md; nothing here seeds or starts anything.
 *
 * Firestore is read and written with the Admin SDK against the slot's emulator.
 * The emulator host MUST be set before firebase-admin initialises, which is why
 * it is assigned at module load, from the same slot arithmetic local-env uses.
 */
import { resolve } from 'node:path'
import { expect, type Page, type Browser, type BrowserContext } from '@playwright/test'
import Stripe from 'stripe'

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
export const SLOT_OFFSET = Number(new URL(BASE_URL).port || '3000') - 3000
export const FIRESTORE_HOST = `127.0.0.1:${8080 + SLOT_OFFSET}`
export const AUTH_HOST = `127.0.0.1:${9099 + SLOT_OFFSET}`
export const FUNCTIONS_BASE = `http://127.0.0.1:${5001 + SLOT_OFFSET}/demo-linyup/europe-west6`

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST
process.env.GCLOUD_PROJECT = 'demo-linyup'

// Imported after the env is set, on purpose.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const admin: typeof import('firebase-admin') = require('firebase-admin')
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-linyup' })
export const db = admin.firestore()
export const adminAuth = admin.auth()
export { admin }

process.loadEnvFile(resolve(__dirname, '../../../../packages/functions/.env.local'))
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// The Stripe TEST connected accounts the seed links (see README.md).
export const ACCT = {
  'seed-team-studio': 'acct_1TlfblGz6xnbfIzN',
  'seed-team-org': 'acct_1TotVEGz6x8sQ98q',
  'seed-team-free': 'acct_1TkCaqGz6xp8VQ38',
} as const

export const STUDIO = { teamId: 'seed-team-studio', slug: 'iron-circle-gym' } as const

// ─── Polling ─────────────────────────────────────────────────────────────────

/** Poll `fn` until it returns a truthy value (returned) or the timeout passes (throws with `what`). */
export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000, stepMs = 1_000): Promise<T> {
  const until = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < until) {
    try {
      const v = await fn()
      if (v) return v as T
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`)
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export async function findContactsByEmail(teamId: string, email: string) {
  const snap = await db.collection('contacts').where('teamId', '==', teamId).where('email', '==', email).get()
  return snap.docs
}

/** Hard-delete every contact of `teamId` with this email plus the subcollections tests touch. */
export async function deleteContactsByEmail(teamId: string, email: string) {
  const contacts = await findContactsByEmail(teamId, email)
  if (!contacts.length) return
  // Entitlements that live OUTSIDE the contact, keyed by its id: a course place
  // left behind would keep a seat taken on every rerun until the course sells out.
  const blocks = await db.collection('course_blocks').where('teamId', '==', teamId).get()
  const courses = await db.collection('courses').where('teamId', '==', teamId).get()
  for (const c of contacts) {
    for (const b of blocks.docs) await b.ref.collection('enrolments').doc(c.id).delete()
    for (const k of courses.docs) await k.ref.collection('purchases').doc(c.id).delete()
    await db.recursiveDelete(c.ref)
  }
}

/** Clears the per-IP / per-team buckets a repeated local run would otherwise exhaust. */
export async function clearRateLimits() {
  for (const c of ['auth_code_attempts', 'shop_registration_attempts', 'checkout_claim_attempts']) {
    const snap = await db.collection(c).get()
    await Promise.all(snap.docs.map((d) => d.ref.delete()))
  }
}

async function latestCodeFor(email: string): Promise<string | null> {
  const snap = await db.collection('verification_codes').where('email', '==', email.toLowerCase()).get()
  const rows = snap.docs
    .map((d) => d.data())
    .filter((r) => !r.used)
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
  return rows[0]?.code ?? null
}

export async function clearCodesFor(email: string) {
  const snap = await db.collection('verification_codes').where('email', '==', email.toLowerCase()).get()
  await Promise.all(snap.docs.map((d) => d.ref.delete()))
}

/**
 * Drive the public passwordless sign-in dialog (space/SignInDialog.tsx) for `email`.
 * Reads the issued code straight from the emulator: the code is stored as issued,
 * and MAIL_ENABLED=false means nothing is mailed. Registers a new contact when the
 * email matches none (`register` names), otherwise signs the existing one in.
 */
export async function contactSignIn(page: Page, email: string, register?: { first: string; last: string }) {
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('your@email.com').waitFor({ state: 'visible', timeout: 60_000 })
  await dialog.getByPlaceholder('your@email.com').fill(email)
  await dialog.getByRole('button', { name: /send verification code/i }).click()
  const code = await waitFor(`a verification code for ${email}`, () => latestCodeFor(email), 90_000)
  await dialog.getByPlaceholder('000000').fill(code)
  await dialog.getByRole('button', { name: /^verify$/i }).click()
  if (register) {
    const inputs = dialog.locator('input[type="text"]')
    await inputs.nth(0).waitFor({ state: 'visible' })
    for (let i = 0; i < 3; i++) {
      await inputs.nth(0).fill(register.first)
      await inputs.nth(1).fill(register.last)
      if ((await inputs.nth(0).inputValue()) === register.first && (await inputs.nth(1).inputValue()) === register.last) break
    }
    await dialog.getByRole('button', { name: /create account/i }).click()
  }
  await expect(dialog).toBeHidden({ timeout: 90_000 })
}

// ─── Stripe hosted Checkout ──────────────────────────────────────────────────

export const CARD_OK = '4242424242424242'
export const CARD_DECLINED = '4000000000000002'

/**
 * Pay on Stripe's hosted Checkout page with a test card. The page is Stripe's,
 * not ours: selectors follow its public ids (#cardNumber, #cardExpiry, …) and
 * the card accordion appears only when the session offers several methods.
 */
export async function payOnStripeCheckout(page: Page, opts: { email?: string; name?: string; card?: string } = {}) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 120_000 })
  await page.locator('#cardNumber, [data-testid="card-accordion-item-button"], #payment-method-accordion-item-title-card').first().waitFor({ timeout: 60_000 })
  const email = page.locator('#email')
  if (opts.email && (await email.isVisible().catch(() => false)) && (await email.isEditable().catch(() => false))) {
    await email.fill(opts.email)
  }
  const accordion = page.locator('[data-testid="card-accordion-item-button"], #payment-method-accordion-item-title-card').first()
  if (!(await page.locator('#cardNumber').isVisible().catch(() => false)) && (await accordion.isVisible().catch(() => false))) {
    // The accordion's cover div sits over the button and takes the pointer event.
    await accordion.click({ force: true })
    await page.locator('#cardNumber').waitFor({ state: 'visible', timeout: 30_000 })
  }
  await page.locator('#cardNumber').fill(opts.card ?? CARD_OK)
  await page.locator('#cardExpiry').fill('12 / 34')
  await page.locator('#cardCvc').fill('123')
  const name = page.locator('#billingName')
  if (await name.isVisible().catch(() => false)) await name.fill(opts.name ?? 'E2E Tester')
  const country = page.locator('#billingCountry')
  if (await country.isVisible().catch(() => false)) await country.selectOption('CH').catch(() => {})
  const zip = page.locator('#billingPostalCode')
  if (await zip.isVisible().catch(() => false)) await zip.fill('8000')
  // Link's "save my info" opt-in would ask for a phone number; keep it off.
  const link = page.locator('#enableStripePass')
  if (await link.isChecked().catch(() => false)) await link.uncheck().catch(() => {})
  await page.locator('[data-testid="hosted-payment-submit-button"], button.SubmitButton').first().click()
}

/**
 * A callable's JSON reply as the onCall wire protocol shapes it. The payload is
 * whatever that callable returns, so each spec reads the fields it knows about.
 */
export interface CallableBody {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON, read per callable
  result?: any
  error?: { message?: string; status?: string; details?: { reason?: string } }
}

export interface CallableBox {
  body: CallableBody | null
  status: number
}

/** Capture a callable's JSON body without racing the redirect it triggers (see e2e/README.md). */
export async function captureCallable(page: Page, name: string): Promise<CallableBox> {
  const box: CallableBox = { body: null, status: 0 }
  await page.route(`**/${name}`, async (route) => {
    const response = await route.fetch()
    box.status = response.status()
    box.body = await response.json().catch(() => null)
    if (box.status >= 400) console.log(`[e2e] ${name} → ${box.status} ${JSON.stringify(box.body)}`)
    await route.fulfill({ response })
  })
  return box
}

// ─── Staff sessions ──────────────────────────────────────────────────────────

/** A fresh browser context signed in as a seeded staff user (password login). */
export async function staffContext(browser: Browser, email = 'studio@linyup.com', password = 'linyup123'): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 120_000 })
  await page.close()
  return context
}

/** Collect console errors + failed callables on a page, for the report. */
export function watchErrors(page: Page, allow: RegExp[] = []) {
  const errors: string[] = []
  const push = (e: string) => {
    if (!allow.some((a) => a.test(e))) errors.push(e)
  }
  // Only OUR pages: Stripe's hosted Checkout logs its own noise (wallet manifests…).
  const ours = () => page.url().startsWith(new URL(BASE_URL).origin)
  page.on('pageerror', (e) => {
    if (ours()) push(`pageerror: ${e.message}`)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && ours()) push(`console: ${m.text().slice(0, Number(process.env.E2E_ERR_CHARS ?? 300))} [on ${new URL(page.url()).pathname}]`)
  })
  page.on('response', (r) => {
    if (r.url().includes(`:${5001 + SLOT_OFFSET}/`) && r.status() >= 400) push(`callable ${r.status()}: ${r.url()}`)
  })
  return errors
}
