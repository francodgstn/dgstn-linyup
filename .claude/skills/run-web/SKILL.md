---
name: run-web
description: Launch the seeded Firebase emulator stack + web dev server and drive the app headlessly (login, click, screenshot) — the cold-start recipe for a fresh Linux container. Use when asked to run the app, smoke-test or screenshot a page, or verify a change in the real app; also the launch companion to persona-ux-test, which assumes this stack is already up.
---

# Run the web app against the seeded emulator (headless container recipe)

Verified cold-start from a fresh remote container (2026-08-31). Every step
below exists because skipping it produced a real failure that session; the
gotchas at the bottom are the ones actually hit, with their symptoms.

## 1. One-time prep (fresh container)

```bash
pnpm install
pnpm bootstrap     # env files from their templates (emulator-first), shared + functions
                   # built when dist is missing/stale, port slot 0 claimed. Idempotent —
                   # the SessionStart hook has usually run it already; re-running is free.
```

`pnpm bootstrap` writes `apps/web/.env.local`, `apps/admin/.env.local`,
`packages/functions/.env.local`, `apps/landing/.env` and
`apps/mobile/.env.staging` from the committed `*.example` beside each; it never
overwrites one that exists. Everything below about their CONTENT is what those
templates already say — read on only when something still misbehaves.

Java is required for the Firestore emulator (`java -version` — the container
ships OpenJDK; the JAVA_TOOL_OPTIONS proxy banner it prints is noise, and it
also appears as a bogus "Unexpected rules runtime error" warning — ignore both).

`apps/web/.env.local` in emulator mode carries `NEXT_PUBLIC_USE_EMULATORS=true`
plus placeholder Firebase client values for `demo-linyup` (the emulators
validate none of them; a non-empty API key only keeps the SDK from throwing).

## 2. THE gotcha: functions params must ALL be in an env file

The functions emulator PROMPTS interactively for every `defineString` param it
cannot find in an env file — **even ones with defaults**. In a non-TTY (any
agent/CI shell) that prompt hangs function loading silently: discovery
succeeds, the CLI says nothing, and the registry ends up EMPTY — every
callable 404s, which the browser reports as a CORS error on
`http://localhost:5001/...` (misleading; it's a 404 with no CORS headers).

`packages/functions/.env.local` (gitignored) must carry a line for EVERY
param. `pnpm bootstrap` copies it from `packages/functions/.env.local.example`,
which is kept complete — when a param is added to the source, add it to the
template in the same change. A paste block used to live here and went stale;
the OWNER of the list is the source — re-derive it with:

```bash
grep -rhoE "define(String|Secret|Int|Bool)\('[A-Z_]+'" packages/functions/src --include='*.ts' | sort -u
```

`MAIL_ENABLED=false` keeps a demo run from trying to send anything real.

## 3. Launch + readiness

Two background processes:

```bash
pnpm emulators:seed   # emulators (auth 9099, firestore 8080, functions 5001, storage 9199) + wipe + seed; stays running
pnpm dev:web          # Next.js on :3000
```

Readiness is **three** checks, not one — "Ready" alone lied once:

1. Seed output contains `✅ Ready` (and no `Enter a string value` line — that
   is the param prompt from §2 firing).
2. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000` answers.
3. **The functions registry is non-empty** — the guard that actually catches §2:

```bash
curl -s -X POST http://127.0.0.1:5001/demo-linyup/europe-west6/nosuchfn -d '{}'
# GOOD: "...valid functions are: europe-west6-createTeam, ..." (long list)
# BAD:  "...valid functions are: "            ← empty registry, fix §2, restart
```

**Stop/restart:** kill the port listeners (TaskStop on the background task
alone can leave orphans):

```bash
for p in 8080 9099 5001 9199 4000 3000; do
  pid=$(lsof -ti:$p -sTCP:LISTEN 2>/dev/null); [ -n "$pid" ] && kill $pid
done
```

## 4. Logins and seeded state

All passwords `linyup123` (seed prints the full table): `studio@linyup.com`
(studio owner — the account to use for owner-gated features),
`coach@`, `org@`, `free@`, `manager@`, `coach2@linyup.com`.

The seed pre-installs plugins per team — the studio team already has
`finance` active with the ch_kmu chart seeded (`[accounting] seeded
team=seed-team-studio` in the seed output), so finance pages work without an
install step. Do NOT reseed while a demo/lead snapshot matters
(persona-ux-test's warning); never point `seed:staging` at the emulator.

## 5. Drive it headlessly

No display and no `chromium-cli` in the container; Playwright browsers are
pre-installed. Install the driver OUTSIDE the repo (scratchpad):

```bash
cd "$SCRATCHPAD" && npm init -y && npm i playwright-core
```

```js
const { chromium } = require('playwright-core')
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',   // pre-installed; never `playwright install`
  args: ['--no-sandbox'],
})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.locator('input[type="email"]').fill('studio@linyup.com')
await page.locator('input[type="password"]').fill('linyup123')
await page.locator('button[type="submit"]').click()
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 60000 })
await page.screenshot({ path: 'dashboard.png' })   // LOOK at it — blank = not running
```

Driver gotchas (each one cost a debugging round):

- **`isVisible()` returns instantly** — it does not wait, so right after a
  `goto` it is false while React still renders. Use
  `locator.waitFor({ state: 'visible', timeout: … })`.
- **First hit per route is slow** (Next dev compiles on demand) — generous
  timeouts on `goto`/`waitFor`, never bare sleeps.
- **Selects resist synthetic clicks** (same quirk persona-ux-test documents):
  prefer keyboard interaction, or design the flow to keep the defaults.
- **Scope card locators tightly.** A broad
  `.filter({ has: text }).getByRole('button')` on a card grid matched a
  NEIGHBORING card's button once. Anchor on the card's own heading and walk
  down, and screenshot after every mutating click.
- **Check browser console errors before declaring success** (collect
  `page.on('console')` / `page.on('pageerror')`).

## 6. Before committing anything afterwards

`next dev` rewrites the auto-generated `apps/web/next-env.d.ts` to its
dev-mode variant. Restore it rather than committing churn:

```bash
git checkout -- apps/web/next-env.d.ts
```
