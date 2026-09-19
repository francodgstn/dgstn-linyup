---
title: Mobile scan 2026-09
description: Member app — scan and roadmap (2026-09-02)
status: record
area: mobile
---
# Mobile scan 2026-09

The member app (`apps/mobile`, Expo 54 / React Native 0.81) was ported from
`hmd-lineup/student-app` on 2026-08-19 and has not shipped. This document is
the result of a full scan of the app, the delivery pipeline, the local
environment and the test-account story, followed by the decisions taken to get
it to the stores with a solo developer's automation budget. It is the plan the
`mobile-step*` branches implement; the findings are recorded so the next reader
does not have to rediscover them.

Repo state at scan time: `main @ ff83d551`. Reference project (`hmd-lineup`)
was not on disk; everything below is from this repo.

---

## 1. What the scan found

### 1.1 The app is HMD's app underneath

- `eas.json` points every non-development profile at HMD's Firebase projects
  (`hmdlineupt` / `hmdlineup`), which `app.config.js` rejects with
  `Unknown FIREBASE_PROJECT_ID` — **no cloud build can succeed as committed**.
  `submit.*.ascAppId` is HMD's App Store record.
- Three versions disagree: `package.json` `1.1.16` (HMD's), `app.config.js`
  `0.1.0`, EAS `appVersionSource: remote`. Package name `student-app`, slug
  `linyup-student-app`, in-app header "Linyup Member", display name "Linyup".
- `README.md`, `ARCHITECTURE.md` and `.claude/agents/mobile-agent/AGENT.md`
  describe a `student_auth_tokens` auth that exists nowhere; the real flow is
  `sendContactVerificationCode` → `loginContactWithCode` →
  `signInWithCustomToken`.
- Residue: AsyncStorage keys `@hmd_student_*`, "Scan Dojo QR", "contact your
  master or instructor", a 15-belt HMD rank table in `profileUtils.ts`, "Ready
  to fight." welcome strings.
- Missing for a store app: EAS project id (`extra.eas.projectId: ''`),
  `updates.url` (OTA is inert), `expo-dev-client` (despite
  `developmentClient: true`), push (`expo-notifications`), secure token
  storage (`expo-secure-store` — audit finding D20), i18n, crash reporting,
  lint, tests. CI runs exactly one thing for the app: `tsc` via turbo.

### 1.2 Two live defects make it non-functional against today's backend

Both come from hand-mirrored types: the app does not depend on
`@linyup/shared`, and the mirror was already stale at import.

1. Every session query filters `where('doc_type', '==', 'session')`; the sync
   (`syncSessionPublicProfile.ts`) writes `type: 'session'` /
   `'appointment_session'`. **Agenda, attendance calendar, bookings and
   book/cancel are all empty.** An orphan composite index on `doc_type` kept it
   from erroring.
2. `AppointmentBookingModal` reads `activity.accessRule.type`;
   `listAvailability` no longer returns `accessRule` ("appointments dropped the
   access gate entirely"). **Render crash → "Error Loading App"** for any coach
   with activities.

Adopting `@linyup/shared` needs **no Metro configuration** on SDK 54 (Expo's
default config resolves pnpm workspace symlinks; the "needs a monorepo
resolution change" comments are from the SDK ≤49 era). Declaring the dependency
is the whole wiring; replacing the mirrors is a small refactor.

### 1.3 Reads the rules deny to a contact token — all swallowed by `catch`

A contact session has uid `contact:{id}` and no `team_members` row, so
`isTeamMember` and friends are false. The app reads, and silently loses:

| Read | Effect |
|---|---|
| `teams/{id}` (`ranking_systems`, `settings.gamification`, coaching axes, goal categories) | belt = "NO BELT", default thresholds |
| `organizations/{org}` (`affiliation_term`) | always "Affiliation" |
| `teams/{id}/subscription_types/{id}` | plan name never shown |
| root `sessions` list (own appointments) | **a member can never see or cancel a booked appointment** |

The web Space reads the world-readable `public_profile` mirror and the
`getMyBookings` callable for every one of these. Mobile now does the same
(step 1), and the mirror gains the fields it lacked.

Verified empirically against the emulator: the foreground telemetry write
(`last_seen_at` + `app_version` + `ota_*`) is refused whole by the
`hasOnly(['weight','last_seen_at'])` arm — **`last_seen_at` had no successful
writer in the system**.

### 1.4 Pipeline and environment facts that shape the plan

- No workflow touches the app. The five workflows (`verify`, `deploy` →
  staging on `main`, `deploy-prod` on `v*` tags, `deploy-sandbox` on
  `sandbox-*` tags, nightly `reseed-sandbox`) use keyless WIF; `verify` is a
  `workflow_call` gate. No `concurrency` groups; no post-deploy smoke; index
  builds are never awaited; **the Firestore rules test suite never runs in CI
  and is red at HEAD** (`subscription_history` catch-all).
- The manual-action census (release: hand-written tag notes, approvals,
  preconditions, index polling, smoke; twelve backfills with no ledger;
  thirteen one-time per-environment steps) lives in the CI/CD scan report and
  is the input for the automation work in step 2.
- Local dev: `scripts/local-env.mjs` slots ports per worktree for
  web/admin/emulators, but Metro (8081) is unmodelled and the app hard-codes
  emulator ports (slot 0 only). Four gitignored env files with four different
  provenance stories; `packages/functions/.env.local` has no template and one
  missing param silently empties the functions registry; `.vscode/tasks.json`
  is gitignored and does not exist in any clone; `pnpm install` never builds
  `packages/shared/dist` (the main checkout's dist was built from another
  branch at scan time).
- Test accounts: same two callables serve web and mobile, but the app cannot
  target `linyup-sandbox` (not in its config map); a mobile OTP (no `teamId`)
  goes out on the `system` mail stream, which sandbox drops silently; staging's
  `TEST_MODE` routes every OTP to the owner's inbox (ideal for solo testing);
  on the emulator the code is readable only in the Emulator UI. The seeded
  `contact:{teamId}:{contactId}` password users are a fossil of a deleted
  minter with no consumer. No test exercises the login chain.

### 1.5 Product intent on record

`docs/product-strategy.md`: **one app**, plan-gated content — a basic
booking/check-in portal from Coach, "lit up" by Studio add-ons; never on Free;
never sold à la carte. The landing already sells "a branded iOS and Android
app". "Linyup Coach" and white-label variants: zero mentions anywhere. The plan
capability `student_app` was declared and enforced nowhere.

---

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| App identity | package `@linyup/mobile`, display name **Linyup**, Expo slug `linyup`, bundle/package `com.dgstn.linyup` (unchanged) | one identity before the Expo project binds the slug |
| Plan gating | **enforced at login for the mobile client**; capability renamed `member_app` | recorded intent "never on Free"; the app tells a refused member where the web Space is |
| Release coupling | **decoupled**: `v*` tags never touch the app; the app releases on `mobile-v*` tags | different cadence, reversibility and definition of done |
| Naming, "Linyup Coach" | deferred | the coach-at-the-door job is covered by the Kiosk web surface; a second binary is a second release train |
| White-label | **runtime tenant theming inside the one app now**; per-org variant binaries deferred | see §5 — the deciding implication is the per-org developer account |
| Dev default | staging is the default `pnpm dev:mobile` target; emulator via explicit script | staging's `TEST_MODE` delivers every OTP to the owner |
| Test login | fixed-code `app_settings/review_access` seeded in every environment | the mechanism exists for App Store review; reuse it for one-tap test login |

---

## 3. Release lanes (step 2)

| Trigger | Outcome | Intent |
|---|---|---|
| PR | `verify.yml` gains mobile lint + unit tests + `expo config` evaluation per profile, plus Firestore rules tests and `concurrency` groups for the whole repo | fail in CI, not on EAS's clock |
| `main` merge touching `apps/mobile/**` or `packages/shared/**` | the `staging` channel: an OTA update when a `preview` build with the current native fingerprint exists, a `preview` build otherwise (Expo's `continuous-deploy-fingerprint` action) | automatic, test devices |
| `mobile-v*` tag | the `production` channel, same rule with the `store` profile; a build is auto-submitted to TestFlight and the Play internal track | explicit, the owner's call |
| `v*` tag | backend + web + landing, exactly as today | unchanged |

Two consequences the web never had, built into step 1:

- **Backend changes must stay backward-compatible with the oldest app version
  still installed.** The `accessRule` crash is exactly a removed-field break.
  Callable payloads are additive; the `listAvailability` result now has ONE
  typed owner in `packages/shared`.
- **A minimum-supported-version gate** (an `app_settings` document the app
  reads at start) is the escape hatch, so an old contract is never supported
  forever. Designed in step 4.

EAS traps found in the scan, all fixed in step 2: `"${FIREBASE_API_KEY}"` in
`eas.json` `env` is a literal (EAS does not interpolate — the key must be an
EAS environment variable); the `production` profile is `distribution:
internal` + APK and **not submittable** (only `store` is); `expo-camera`'s
plugin defaults add a microphone purpose string and `RECORD_AUDIO` to a
QR-only app unless configured.

---

## 4. Sequence

1. **Mobile hygiene** (`claude/mobile-step1-hygiene`): adopt `@linyup/shared`;
   fix `doc_type`, the `accessRule` crash, the denied reads (mirror +
   `getMyBookings`), the telemetry rule arm (+ the red `subscription_history`
   rules gap); one identity and one version source; `member_app` gate; camera
   plugin; delete HMD residue and the stale nested lockfile; lint + jest.
2. **EAS + CI lanes**: profiles/channels/env vars, the three lanes above,
   rules tests + concurrency in `verify`, a `mobile-release` skill, ops-agent
   refresh.
3. **Dev bootstrap** (`claude/mobile-step3-dev-bootstrap`): one idempotent
   `pnpm bootstrap` (`setup` is a pnpm built-in) copying every env file from a
   committed emulator-first template and building shared + functions when
   their `dist` is missing or older than `src` (`scripts/lib/distState.mjs`,
   also what `local-env status` warns from); Metro in the slot model; mobile
   reads emulator ports from `EXPO_PUBLIC_*_EMULATOR_PORT`; `app.config.js`
   refuses a real project without a key; `fingerprint.config.js` so the
   OTA-vs-build decision ignores `extra` and version fields; SessionStart hook
   running the bootstrap; devcontainer + root README. No root `postinstall`
   (§6).
4. **Accounts + tests** (`claude/mobile-step4-accounts-tests`): every seeded
   environment provisions THE SAME review studio production does
   (`scripts/lib/mobile.ts` → `provisionDemoTenant`) plus the fixed code, so
   the member app has one test login everywhere (`docs/test-accounts.md`);
   the unfiltered `collectionGroup('public_profile')` discovery is gone
   (studio names come from `teamSummaries`; a re-sent code is scoped to the
   chosen studio); fossil `contact:{teamId}:{contactId}` users deleted from
   both cloud seeders; console action for `flags.internal` (account page)
   and a `Settings → Member app` page for the min-version gate; the login
   chain's decisions lifted into pure modules with mocha tests incl.
   `login_emails` (`auth/loginChain.test.ts`) and `switchActiveContact` now
   honours `login_emails` like the login does; `app_settings/mobile` rule +
   rules test; the update-required screen (fails open); a Maestro smoke flow
   (`apps/mobile/.maestro/login.yaml`, not in CI). Sandbox was already in the
   config map since step 1.
5. **Runtime tenant theming** (`claude/mobile-step5-theming`): the signed-in
   member's studio look — `bioLinkThemePreset` + `bioLinkAccentColor` +
   `profileImage` off the `public_profile` mirror — drives the whole Paper
   theme (`utils/tenantTheme.ts`, pure + tested: the SAME preset registry and
   dark-mode rule as the web, the accent derived into every MD3 primary role,
   WCAG-checked), persisted for the next cold start and cleared with the
   session (`contexts/TenantThemeContext.tsx`); the logo on the team card;
   semantic tokens (`theme.semantic`) replacing the brand-adjacent hex
   literals (team card, alerts, social actions, profile icons, navigator,
   header); `APP_VARIANT` in `app.config.js` with one entry (§6). Data
   palettes deliberately left (§6).

---

## 5. White-label — what it would take, recorded so it is not re-derived

- *Runtime theming in the one app* (step 5) honours the marketing claim with
  zero new data: `TeamPublicProfile` already carries `bioLinkThemePreset`,
  accent, background, `profileImage`, `heroImage`.
- *Per-org variant binaries* are mechanically cheap (`APP_VARIANT` env →
  name / bundle id / icon / `extra.orgId`; discovery narrowed to
  `public_profile.org_id`) but two facts decide it: **`Organization` has no
  branding data and no public mirror**, and Apple's guidelines (4.2.6 / 4.3)
  push templated apps to be published under the *client's own* developer
  account. Each org variant therefore means a per-org Apple and Google
  developer account, per-org credentials in EAS, and per-org review cycles.
  That is a priced service on the Organization tier, not a checkbox. Not built
  until an org asks and accepts the account requirement.

---

## 6. Decisions parked for the owner

Collected during autonomous execution; none blocks the current steps.

- **Marketing version for the first store submission** — set to `1.0.0` in
  step 1 (single source: `package.json`, read by `app.config.js`). Change if a
  different first version is wanted.
- **`Linyup Coach`** — deferred; revisit when a concrete coach workflow is
  unmet by the Kiosk surface and the admin web.
- **Secure token storage** (audit D20) — `expo-secure-store` is a small change
  but needs a custom Firebase Auth persistence adapter and a device test;
  scheduled after step 2 so it ships in a real build.
- **Org-change fan-out to team mirrors** — org-level `affiliation_term` and
  ranking systems are mirrored onto each team's `public_profile` at team-sync
  time; an org edit does not re-sync member teams until they next write.
  Acceptable for now; a fan-out trigger is the fix if it bites.
- **No root `postinstall` building `@linyup/shared`** (step 3 deviated from
  the plan here). Every `pnpm install` would then also build on the App
  Hosting buildpack — whose pnpm handling has already broken once this month
  (`package.json` → `engines.pnpm`) — and twice on EAS (its
  `eas-build-post-install` already builds shared). Instead `pnpm bootstrap`
  builds only when `dist` is older than `src`, the SessionStart hook runs it
  for every agent session, the mobile `start*` scripts build first, and
  `local-env status` prints `! STALE`. Add the `postinstall` if a stale
  `dist` still bites a human developer after this.
- **The review-login code is a committed default (`123456`)** on the
  emulator, staging and the sandbox (`REVIEW_ACCESS_CODE` overrides at seed
  time; production is set from the console only). It opens one synthetic
  contact on an internal, silent, payment-less studio in environments whose
  owner passwords are already committed. Change the default, or make the
  cloud seeders require the env var, if that trade is not wanted.
- **`switchActiveContact` now accepts `login_emails`** (a parent signed in
  through a child's allow-list can switch to the sibling), matching what
  `buildContactSession` already allowed for the login itself. A widening,
  deliberate, pinned by `loginChain.test.ts`; revert the one predicate call
  if the old primary-only rule was intended.
- **Hex literals in the DATA palettes were left as they are** — badge
  gradients, chart series, the attendance calendar, the gamification card
  (`BadgesCard`, `PerformanceProfileSection`, `GamificationCard`,
  `AttendanceCalendar`, most of `ProfileScreen`'s detail rows). They are
  categorical colours, many per file, and remapping them without a device to
  look at is a visual regression waiting to happen. The brand-adjacent ones
  (anything that was Linyup purple/indigo and now fights the studio accent)
  are tokenised; the rest is a device-verified pass.
- **`APP_VARIANT` has one entry and no consumer.** An org-branded build is a
  second entry (name, slug, scheme, bundle id, icon set) plus its own EAS
  project and credentials — i.e. the per-organisation developer accounts §5
  names as the deciding cost. Nothing in `src/` would change: the runtime
  theme already follows the studio.
- **Maestro is not in CI.** The flow exists and runs locally against any
  seeded environment; a device lane needs a Maestro Cloud (or EAS Workflows)
  account and a `development` build per platform — an account decision.
- **SessionStart hook runs `pnpm bootstrap --quiet` in every checkout**,
  including the owner's own sessions: on a ready checkout it prints at most
  one line (the missing mobile key) and rebuilds nothing. Remove the hook from
  `.claude/settings.json` if that is unwanted.
- **A light / dark / system appearance setting** (PrimeTestLab report 7107,
  S-01). The app follows the system scheme (`userInterfaceStyle:
  'automatic'`), and a studio's non-adaptive preset (`ink`) overrides it —
  there is no in-app control. One is small (a preference in AsyncStorage
  feeding `buildTheme`, plus a row on the profile tab) but it is a product
  choice: whether a member may override the look the studio chose.
- **The Feed tab shows "coming soon"** (report 7107, S-02). Either studio
  posts land there or the tab leaves the bar until they do. Hiding it is one
  entry in `ProfileScreen`'s tab list; kept as is until what the feed carries
  is decided.
- **Landscape on Android** (report 7107, M-04) is NOT a defect in the app:
  the config locks `orientation: 'portrait'` and the built manifest carries
  `android:screenOrientation="portrait"` (verified with `expo config --type
  introspect`). The tester's ASUS ROG Phone forced a rotation on a
  portrait-locked activity, and Android letterboxes that as a narrow portrait
  strip — the "thin column, black bars" the report describes. A real
  landscape layout would mean lifting the lock and reflowing every screen;
  not planned for a phone-only member app.

---

## 7. What only the owner can do (needed for step 2 to run end to end)

The staging half — EAS project, the staging key, `EXPO_TOKEN`, the first
`preview` build — is written as a runbook a local agent can execute:
`docs/mobile-eas-setup.md`. It was run on 2026-09-03 and is **DONE**. The
EAS project is **`@francodagostino/linyup`**,
`f941b285-002a-4bdb-8c42-8c3e5edfab66` (the default in `app.config.js`); CI
authenticates as the robot user `linyup-eas-robot`.

Both halves of the lane are proven on `main`: a finished `preview` APK, and
EAS updates published to the `staging` branch at a runtime version that APK
matches — so the next push that changes only JS publishes an OTA instead of
building. Everything still listed below is Apple, Google, or the prod key.

- ~~`eas init` in `apps/mobile` (writes `extra.eas.projectId`)~~ — done; the
  id is a literal in `app.config.js` because the config is dynamic.
  ~~An `EXPO_TOKEN` repository secret for CI~~ — done, a robot token.
- `FIREBASE_API_KEY` in BOTH eas.json `env` and the EAS environment:
  ~~`development` + `preview` → staging~~ done. The `store` profile TEMPORARILY
  targets staging too (2026-09-03) so the Play closed test could start; the prod
  key is still owed in both channels, and the release lane refuses a `mobile-v*`
  tag until `store` points at `linyup-prod` again.
  ~~`messagingSenderId` for staging~~ done (`157648925506`); prod + sandbox
  still carry the TODO, and `appId` is read by nothing yet (Terraform outputs).
- App Store Connect record for `com.dgstn.linyup` → `ascAppId`; ASC API key
  for `eas submit`; Play service-account JSON in EAS. **Runbook:**
  `docs/mobile-store-setup.md`. The long pole is not the setup but Play's
  12-testers-for-14-days closed test (personal account, post-2023-11-13,
  per app), which gates production only — internal testing is unaffected. Until the Apple side
  exists the **staging lane is `platform: android`** — an iOS internal build
  needs an ad hoc profile listing device UDIDs (`eas device:create`), so `all`
  would make every run on main red on its iOS half. Widening that one input
  back to `all` is the last step of setting up the Apple account.
- Store metadata: screenshots (~~iPhone + iPad~~ **iPhone only** —
  `supportsTablet` is now `false`), ~~a privacy policy that
  covers the app's users~~ done (`/privacy` §2.10, plus the
  `/delete-account` page Play requires alongside the in-app route),
  Terms/DPA without the DRAFT banner, a support URL, and the fixed
  review-access code entered in ASC/Play.
