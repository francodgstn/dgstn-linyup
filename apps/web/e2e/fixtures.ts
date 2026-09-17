import { test as base, type BrowserContext } from '@playwright/test'

// Overrides the default `page` fixture so every test starts already signed in
// as the seeded studio owner, without re-doing the login per test.
//
// This does NOT use Playwright's `storageState` file (the more common
// pattern) because that only serializes cookies + localStorage, and this
// app's Firebase Auth session lives in IndexedDB — a fresh `browser.launch()`
// reading a saved storageState landed back on /login with an empty session.
// Instead this logs in ONCE per WORKER, into one BrowserContext that every
// test in that worker reuses — since the context (and its IndexedDB) simply
// stays alive across tests, there is nothing to serialize or round-trip.
// This is Playwright's own documented fallback for exactly this class of app.
type WorkerFixtures = {
  authenticatedContext: BrowserContext
}

// `baseURL` is a test-scoped fixture — a worker-scoped fixture can't depend
// on it, so this reads the same env var playwright.config.ts does rather than
// threading it through.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

export const test = base.extend<object, WorkerFixtures>({
  authenticatedContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext()
      const page = await context.newPage()
      const email = process.env.E2E_LOGIN_EMAIL ?? 'studio@linyup.com'
      const password = process.env.E2E_LOGIN_PASSWORD ?? 'linyup123'

      try {
        await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' })
        await page.locator('input[type="email"]').fill(email)
        await page.locator('input[type="password"]').fill(password)
        await page.locator('button[type="submit"]').click()
        await page.waitForURL((u) => !u.pathname.includes('/login'))
      } catch (err) {
        throw new Error(
          `[fixtures] login at ${baseURL}/login did not complete — is the local stack up and ` +
            `seeded? Run \`node scripts/local-env.mjs status\` first (see .claude/skills/local-env). ` +
            `Original error: ${(err as Error).message}`
        )
      }
      await page.close()

      await use(context)
      await context.close()
    },
    { scope: 'worker' },
  ],

  page: async ({ authenticatedContext }, use) => {
    const page = await authenticatedContext.newPage()
    await use(page)
    await page.close()
  },
})

export { expect } from '@playwright/test'
