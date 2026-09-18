import { test, expect } from '@playwright/test'
import Stripe from 'stripe'
import { resolve } from 'node:path'

// Exercises the promo-code MODIFIER end to end (CLAUDE.md → "Promo codes — a
// Stage A MODIFIER, never a tender"): the seeded `WELCOME10` code (10% off,
// applies_to includes 'product') against the seeded "Insulated Water Bottle"
// (CHF 28 -> CHF 25.20 at 10% off), verified not by re-deriving the resolver's
// own arithmetic but by reading the ACTUAL Stripe Checkout Session
// `createProductCheckout` created — the same authoritative number Stripe would
// charge. Stops there: no card is filled in, no payment completes, nothing is
// charged even in test mode.
//
// Buying a product requires a signed-in CONTACT session (ShopHome's
// `startCheckout`: every kind except 'giftcard' requires `isAuthenticated`) —
// this is NOT the gift-card guest-email path, and there is no backdoor around
// it, so the test goes through the real passwordless sign-in + registration
// flow for a brand-new contact. The OTP itself uses this repo's existing
// APP-STORE-REVIEW bypass (`packages/functions/src/ops/reviewAccess.ts`) —
// the one sanctioned way to get a KNOWN code instead of a real one mailed via
// Brevo, written directly to this slot's local Firestore emulator only.
//
// FIXED email, not a per-run Date.now() one: reviewAccessCodeFor() caches the
// whole doc for 60s IN THE FUNCTIONS PROCESS, which outlives any one test run
// — a second run inside that window inherited the FIRST run's cached (now
// mismatched) email and got a genuinely random code no test input could ever
// match ("Incorrect code", observed twice). A stale cache hit on the SAME
// content is harmless, so the email is constant and `beforeAll` deletes any
// contact it left behind instead, keeping the register step deterministic.
const TEST_EMAIL = 'e2e-promo-tester@example.com'
const TEST_CODE = '482913'
// FIXED, not `Date.now() + 10min`: a stale cache hit (see above) can serve an
// OLDER write's copy of this doc, and a relative expiry means that older
// copy's `expires_at` may have already passed even though a fresher write has
// since landed in Firestore — the bypass then silently falls through to the
// real (long since exhausted, from today's repeated runs) rate limit
// ("Too many attempts", observed). A fixed date makes every write across
// every run byte-identical, so a stale hit is exactly as valid as a fresh one.
const REVIEW_ACCESS_EXPIRES_AT = '2027-01-01T00:00:00.000Z'
// The Stripe TEST connected account `pnpm connect:test-account` linked to
// seed-team-studio (Iron Circle Gym). createProductCheckout creates a Connect
// DIRECT CHARGE (`{ stripeAccount }`, same as connect/payments.ts's other
// mutations) — the resulting Checkout Session lives in THIS account's own
// namespace, not the platform's, so retrieving it needs the same header or
// Stripe answers "No such checkout.session" (observed) even with a valid id.
const STRIPE_CONNECT_ACCOUNT_ID = 'acct_1TlfblGz6xnbfIzN'

// Mirrors scripts/local-env.mjs's own slot arithmetic (every port offset by
// the same N*10000) so this test finds the RIGHT Firestore emulator for
// whichever slot PLAYWRIGHT_BASE_URL points the browser at, rather than
// hardcoding slot 0's :8080.
function slotOffset(): number {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
  return Number(new URL(baseURL).port || '3000') - 3000
}

function firestoreRestBase(): string {
  return `http://localhost:${8080 + slotOffset()}/v1/projects/demo-linyup/databases/(default)/documents`
}

function functionsRestBase(): string {
  return `http://localhost:${5001 + slotOffset()}/demo-linyup/europe-west6`
}

// The functions emulator's FIRST-EVER invocation of a given callable in a
// fresh process can take well over a minute (a cold-load path, the same
// species of delay as Next dev's first hit of a route, just on the functions
// side) — confirmed by hand: a bare curl to `sendContactVerificationCode`
// right after restarting the emulator took over 60s before this warm-up
// existed, well past any reasonable UI-interaction timeout. Paying that cost
// here, against a throwaway address, keeps it off the timed steps below.
async function warmUpVerificationCodeFunction() {
  await fetch(`${functionsRestBase()}/sendContactVerificationCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { email: 'warmup-probe@example.com', teamId: 'seed-team-studio' } }),
  }).catch(() => {}) // outcome irrelevant — this call exists only to pay the cold-start cost
}

// sendContactVerificationCode ALSO enforces a per-IP limit (20/hour,
// `auth_code_attempts`, packages/functions/src/auth/sendContactVerificationCode.ts)
// that the review-access bypass deliberately does NOT skip (by design — see
// that file's header). On this local emulator `request.rawRequest.ip` isn't
// populated, so every caller collapses onto one `"unknown"` bucket — dozens of
// runs today (this test, its own retries, manual warm-up probes) blew straight
// through the limit for EVERYONE, surfacing as "Too many attempts" with no
// connection at all to the review_access doc being perfectly correct
// (confirmed by hand: the doc was right; a `count: 26` bucket was the actual
// cause). Clearing it here makes the test self-contained regardless of how
// many times it or anything else has run this hour.
async function resetAuthCodeRateLimit() {
  const res = await fetch(`${firestoreRestBase()}/auth_code_attempts`, {
    headers: { Authorization: 'Bearer owner' },
  })
  const { documents = [] }: { documents?: Array<{ name: string }> } = await res.json()
  await Promise.all(
    documents.map((d) =>
      fetch(`http://localhost:${8080 + slotOffset()}/v1/${d.name}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner' },
      })
    )
  )
}

// So a repeat run still hits the register step (a contact with this email
// already existing would short-circuit straight to a token, per
// loginContactWithCode's `requiresContactSelection`/`customToken` branches) —
// deletes rather than reuses, since reuse would test a different, easier path
// than the one this test means to exercise.
async function deleteExistingTestContact() {
  const res = await fetch(`${firestoreRestBase()}:runQuery`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'contacts' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: TEST_EMAIL } } },
              { fieldFilter: { field: { fieldPath: 'teamId' }, op: 'EQUAL', value: { stringValue: 'seed-team-studio' } } },
            ],
          },
        },
      },
    }),
  })
  const rows: Array<{ document?: { name: string } }> = await res.json()
  await Promise.all(
    rows
      .filter((r) => r.document)
      .map((r) =>
        fetch(`http://localhost:${8080 + slotOffset()}/v1/${r.document!.name}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer owner' },
        })
      )
  )
}

async function grantReviewAccess(email: string, code: string) {
  const res = await fetch(`${firestoreRestBase()}/app_settings/review_access`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        enabled: { booleanValue: true },
        email: { stringValue: email },
        code: { stringValue: code },
        expires_at: { timestampValue: REVIEW_ACCESS_EXPIRES_AT },
        note: { stringValue: 'apps/web/e2e/promo-code-checkout.spec.ts — local emulator only' },
      },
    }),
  })
  if (!res.ok) {
    throw new Error(`Failed to write app_settings/review_access: ${res.status} ${await res.text()}`)
  }
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000) // the cold-load warm-up below can genuinely take over a minute
  await deleteExistingTestContact() // idempotent — a prior run's leftover, or nothing
  await resetAuthCodeRateLimit() // idempotent — clears a bucket that may not exist
  // SEQUENCED, not Promise.all: the warm-up call below reads app_settings/
  // review_access through reviewAccess.ts's 60s in-process cache — racing it
  // against the write let the read win once and cache a stale/absent value
  // for the next minute. The write must land, and be readable, before
  // anything reads that doc — a fixed TEST_EMAIL (see above) is what makes a
  // STALE cache hit harmless from here on.
  await grantReviewAccess(TEST_EMAIL, TEST_CODE)
  await warmUpVerificationCodeFunction()
})

test('a 10%-off promo code discounts a product checkout, verified against the real Stripe Checkout Session', async ({ page }) => {
  await page.goto('/public/iron-circle-gym/shop', { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: 'Products', exact: true }).click()

  // Scoped to the card containing the product's own name — an unscoped "Buy"
  // locator would match a sibling product's button just as easily (the
  // run-web skill documents exactly this trap for card grids).
  const bottleCard = page.locator('div.rounded-2xl', { hasText: 'Insulated Water Bottle' })
  await bottleCard.getByRole('button', { name: 'Buy' }).click()

  // ── Sign-in dialog (space/SignInDialog.tsx, mounted on every public
  // surface) — anonymous, so this opens instead of the product modal.
  const dialog = page.getByRole('dialog')

  await dialog.getByPlaceholder('your@email.com').fill(TEST_EMAIL)
  await dialog.getByRole('button', { name: 'Send verification code' }).click()

  await dialog.getByPlaceholder('000000').fill(TEST_CODE)
  await dialog.getByRole('button', { name: 'Verify' }).click()

  // Brand-new email -> the register step (firstname/lastname), not
  // selectContact. Neither input has an id/htmlFor pairing its <label>, but
  // at this step these are the ONLY two text inputs in the dialog (the code
  // input is a sibling step, mutually exclusive with this one).
  const registerInputs = dialog.locator('input[type="text"]')
  const firstNameInput = registerInputs.nth(0)
  const lastNameInput = registerInputs.nth(1)
  await firstNameInput.fill('E2E')
  await lastNameInput.fill('Tester')
  // An async state settle right after the Verify step's response can reset an
  // already-filled field (observed: 'Last name' stuck, 'First name' reverted
  // to empty between the two fills) — verify and re-fill rather than trust
  // the first pass landed after that settle finished.
  if ((await firstNameInput.inputValue()) !== 'E2E') await firstNameInput.fill('E2E')
  if ((await lastNameInput.inputValue()) !== 'Tester') await lastNameInput.fill('Tester')
  await expect(firstNameInput).toHaveValue('E2E')
  await expect(lastNameInput).toHaveValue('Tester')
  await dialog.getByRole('button', { name: 'Create account & continue' }).click()

  // Now authenticated — ShopHome's pendingCheckout effect reopens the product
  // modal on its own.
  const promoInput = page.getByPlaceholder('e.g. SUMMER26')
  await promoInput.waitFor({ state: 'visible' })
  await promoInput.fill('WELCOME10')
  // Scoped to the promo input's own row — the checkout modal ALSO has a gift-
  // card field with its own "Apply" button (GiftCardRedeemField), so an
  // unscoped locator matches two.
  await promoInput.locator('xpath=..').getByRole('button', { name: 'Apply' }).click()

  await expect(page.getByText('Code WELCOME10 applied')).toBeVisible()
  // 28.00 x 0.9 = 25.20 — the modal's own display, ahead of the authoritative
  // check below against what Stripe actually received.
  await expect(page.getByText(/25[.,]20/)).toBeVisible()

  // A SUCCESSFUL response here makes the page redirect to Stripe immediately
  // (`window.location.href = res.data.url`) — `page.waitForResponse` resolved
  // the response object fine, but reading its body via `.json()` afterward
  // raced the navigation and lost ("No resource with given identifier
  // found": the frame had already moved on). Routing instead: `route.fetch()`
  // reads the body through Playwright's own independent fetch, immune to
  // whatever the live page does with the response afterward, then relays the
  // exact original response so the app's own redirect logic runs unchanged.
  let checkoutBody: { result?: { url?: string | null } } | null = null
  await page.route('**/createProductCheckout', async (route) => {
    const response = await route.fetch()
    checkoutBody = await response.json()
    await route.fulfill({ response })
  })

  await page.getByRole('button', { name: 'Continue to payment' }).click()
  // Generous, explicit timeout: unlike sendContactVerificationCode above,
  // this callable's cold-load cost is not pre-paid by a warm-up.
  await expect.poll(() => checkoutBody !== null, { timeout: 120_000 }).toBe(true)

  const body = checkoutBody!
  // Firebase's onCall HTTP protocol wraps a success as { result: ... }.
  const checkoutUrl: string | undefined | null = body?.result?.url
  expect(checkoutUrl, `createProductCheckout did not return a URL — got ${JSON.stringify(body)}`).toBeTruthy()
  expect(checkoutUrl).toContain('checkout.stripe.com')

  const sessionId = checkoutUrl!.match(/cs_test_[A-Za-z0-9]+/)?.[0]
  expect(sessionId, `could not find a cs_test_ session id in ${checkoutUrl}`).toBeTruthy()

  // THE authoritative check: what Stripe itself recorded for this Checkout
  // Session, not a re-derivation of the resolver's own arithmetic — the class
  // of bug this test exists for is the server and Stripe disagreeing about
  // the number, which only reading Stripe's side can catch.
  process.loadEnvFile(resolve(__dirname, '../../../packages/functions/.env.local')) // same technique apps/admin/dev-sandbox.mjs uses
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  const session = await stripe.checkout.sessions.retrieve(sessionId!, undefined, {
    stripeAccount: STRIPE_CONNECT_ACCOUNT_ID,
  })

  expect(session.currency).toBe('chf')
  expect(session.amount_total).toBe(2520) // CHF 25.20, in Rappen
})
