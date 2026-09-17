import { defineConfig, devices } from '@playwright/test'

// This suite drives an ALREADY-RUNNING local stack — it deliberately has no
// `webServer` block. The stack is one of several concurrent slots (see
// `.claude/skills/local-env/SKILL.md`); starting one here would either collide
// with a running slot or point tests at the wrong build. Bring the stack up
// with `node scripts/local-env.mjs status` + the seeded login before running
// this, then point PLAYWRIGHT_BASE_URL at that slot's web port if it isn't the
// default (slot 0, :3000).
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Local default (undefined) parallelizes across CPU cores — but every test
  // here shares ONE local dev stack (one Next dev server, one functions
  // emulator process), not an isolated CI runner each. Two workers hitting it
  // at once pushed a normally-fast callable response past its 60s action
  // timeout (contention, not a bug) — running sequentially locally trades a
  // bit of wall-clock time for not fighting the shared stack for resources.
  workers: 1,
  reporter: 'html',

  // Cold Next-dev compiles the first hit of any route in real time — the
  // automations route alone took >60s, <120s the first time in the spike that
  // motivated this suite. The functions emulator has the same species of
  // cold-load delay on a callable's first-ever invocation in a fresh process
  // (a bare curl to sendContactVerificationCode once took over 60s). Neither
  // is flakiness; a short global timeout makes the FIRST test of a fresh
  // stack look broken when it is only slow. Generous here, not per-test, so a
  // warm stack still fails fast on a real hang.
  timeout: 180_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    // NOT using Playwright's `storageState` file for auth — it only captures
    // cookies + localStorage, and this app's Firebase Auth session lives in
    // IndexedDB. A fresh browser reading a saved storageState landed back on
    // /login with an empty session (confirmed by trying it). Tests get an
    // already-authenticated `page` from `./fixtures` instead, which logs in
    // once per worker into a context that stays alive across that worker's
    // tests — see fixtures.ts for why.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The functions emulator's first-ever invocation of a given callable in a
    // fresh process can genuinely take over a minute — the same species of
    // delay as Next dev's first hit of a route (see `timeout` above), just on
    // the functions side. 15s clipped a real (successful) response once.
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Uses the machine's installed Chrome rather than a Playwright-managed
        // browser binary — nothing to download for local runs. CI (or any
        // machine without Chrome installed) needs either
        // `npx playwright install --with-deps chromium` and drop `channel`
        // here, or a Chrome-preinstalled image.
        channel: 'chrome',
      },
    },
  ],
})
