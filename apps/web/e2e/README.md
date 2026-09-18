# E2E tests (Playwright)

Real browser, real clicks — added specifically because the in-app Browser
pane's synthetic input (ref-clicks, dispatched PointerEvents, keyboard) could
not open this app's base-ui dropdown menus, while a real Playwright `.click()`
does. If a future base-ui/Radix upgrade ever regresses that for real, this
suite is what should catch it.

## Precondition

This suite drives an **already-running** local stack — it has no `webServer`
config and does not seed anything. Bring one up first:
`.claude/skills/local-env/SKILL.md` / `node scripts/local-env.mjs status`.
Default target is slot 0 (`http://localhost:3000`); point at another slot with:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:13000 pnpm test:e2e:web   # slot 1
```

Login is `studio@linyup.com` / `linyup123` unless overridden via
`E2E_LOGIN_EMAIL` / `E2E_LOGIN_PASSWORD`.

## Running

```bash
pnpm test:e2e:web          # from repo root
pnpm --filter @linyup/web test:e2e       # equivalent
pnpm --filter @linyup/web test:e2e:ui    # Playwright's interactive UI mode
```

Not wired into `pnpm test` / CI — it needs a live seeded stack, which the rest
of that pipeline doesn't assume. Local-only for now (see `fixtures.ts`'s
worker-scoped login instead of a `webServer` + CI reporter setup).

## Auth: not `storageState`

Tests get an already-authenticated `page` from `./fixtures` (not
`@playwright/test` directly). This app's Firebase Auth session lives in
**IndexedDB**, which Playwright's `storageState` file does not capture — a
fresh browser reading a saved storageState landed back on `/login` with an
empty session (verified, not assumed — global-setup-plus-storageState was the
first thing tried here and it silently produced a signed-out test). Instead
`fixtures.ts` logs in **once per worker**, into a `BrowserContext` that stays
alive across every test that worker runs, so there is nothing to serialize.

## Known gotchas

- **Cold first navigation/callable.** Next dev compiles a route on its first
  hit, in real time — `/automations` alone took over a minute once. The
  functions emulator has the same species of delay on a callable's
  first-ever invocation in a fresh process (`sendContactVerificationCode`
  once took over 60s cold). Neither is flakiness. `playwright.config.ts` sets
  a 180s test timeout and 60s action/navigation timeouts for exactly this;
  `promo-code-checkout.spec.ts` also pre-warms the callable it needs most in
  `beforeAll` rather than eat the cost mid-flow.
- **A response that triggers a same-tick redirect** (`window.location.href =
  ...`, as every Stripe Checkout call here does) races Playwright's
  `response.json()` against the navigation and can lose ("No resource with
  given identifier found") — read the body via `page.route()`'s own
  `route.fetch()` instead (immune to what the page does afterward), not
  `page.waitForResponse(...).json()`.
- **A Connect DIRECT CHARGE's Checkout Session lives in the connected
  account's own Stripe namespace**, not the platform's — retrieving one via
  the Stripe API needs `{ stripeAccount: acctId }` on the call or Stripe
  answers "No such checkout.session" even for a valid id.
- **In-process caches outlive a single test run.** `reviewAccessCodeFor()`
  (see below) caches its Firestore doc for 60s **in the functions emulator
  process** — a second test run inside that window can inherit the first
  run's cached, now-mismatched value. Keep bypass inputs that must survive
  repeat runs content-identical (a fixed email, not `Date.now()`-based) rather
  than racing the cache's natural expiry.

## What's here

- `automations-kebab.spec.ts` — the base-ui dropdown regression described up
  top. Scoped to `main` to avoid the sidebar studio-switcher, which uses the
  same `data-slot="dropdown-menu-trigger"` and sits earlier in the DOM.
- `promo-code-checkout.spec.ts` — the promo-code MODIFIER end to end (CLAUDE.md
  → "Promo codes — a Stage A MODIFIER, never a tender"), verified against the
  REAL Stripe Checkout Session `createProductCheckout` creates, not a
  re-derivation of the resolver's own arithmetic. Needs a Stripe Connect
  **test** account wired to `seed-team-studio` first — CLAUDE.md → "Seeded
  tenants show priced doors ONLY with a Stripe test account" — `pnpm
  connect:test-account --list` / `--team seed-team-studio --account acct_...`.
  Buying a product requires a signed-in contact, so this also drives the real
  passwordless sign-in + registration flow, using this repo's existing
  App-Store-review OTP bypass (`packages/functions/src/ops/reviewAccess.ts`)
  rather than an improvised one — see the file header and the gotchas above
  before touching its email/cache handling.

## Not here yet

`apps/admin` (login-gated, a different auth mechanism entirely) isn't covered.
