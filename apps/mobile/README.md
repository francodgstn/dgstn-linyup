# Linyup mobile app

The member app for Linyup studios — Expo 54 / React Native 0.81 / TypeScript.
A signed-in contact can view their profile, ranks, upcoming classes and
appointments, book/cancel, and check in via QR.

## Stack

- Expo 54 (managed workflow), React Native 0.81, TypeScript (strict)
- Firebase SDK v12, modular API (`firebase/firestore`, `firebase/auth`,
  `firebase/functions`) — **no Firebase Auth accounts**, see Auth below
- React Navigation 7 (native-stack)
- React Native Paper (Material Design 3) for all UI
- `@linyup/shared` (workspace package) for every type and pure helper this
  app shares with the rest of the platform — see "Data access" below

## Auth — passwordless, custom-token, no Firebase Auth users

There are no Firebase Auth accounts and no `student_auth_tokens` collection
(older docs describing one predate this app and were wrong). The real flow:

1. `sendContactVerificationCode` — emails a 6-digit code for an email address.
2. `loginContactWithCode` — validates the code and mints a **custom token**
   whose claims are `{ contactId, teamId, sessionExpires }`. The app sends
   `client: 'mobile'`, which activates the `member_app` plan gate: a contact
   whose team's plan doesn't include the mobile app gets `appNotIncluded`
   back (no session minted) instead of a token — see `LoginScreen.tsx` /
   `AuthContext.tsx` for how that's shown.
3. `signInWithCustomToken` — the client then holds a Firebase Auth session
   (uid `contact:{id}`) purely as the *carrier* for those claims; Firestore
   security rules and callables read `request.auth.token.contactId` /
   `.teamId` / `.sessionExpires`, never a `contacts/{id}` document a client
   could forge.
4. The session is refreshed via `switchActiveContact` before its 7-day
   `sessionExpires` window lapses (`AuthContext`'s `checkInitialStorage` /
   `onAuthStateChanged` handler).

`src/services/storage.ts` persists the email, an in-flight code id, the
selected contact id and `sessionExpires` in AsyncStorage — **not encrypted**
(see "What's not here yet" below).

## Data access — mirror + callables, never a private collection

A contact session has no `team_members` row, so Firestore rules refuse it on
every private team/organization collection. Every read in this app therefore
goes through one of two doors:

- **The `teams/{id}/public_profile/{id}` mirror** — world-readable, carries
  everything the app needs about the studio (ranking systems, affiliation
  term, gamification settings, coaching axes, goal categories, links, theme).
  `FirestoreService.getTeamPublicProfile` is the one reader;
  `src/utils/publicProfileMapper.ts` is the one mapping function.
- **Callables** — `getMyBookings` (the contact's own class + appointment
  bookings — never a root `sessions` query), `listAvailability` /
  `bookAppointment` / `cancelBooking` / `bookSession` / `selfCheckIn` /
  `requestContactUpdate`, etc.

`src/services/firestore.ts` (`FirestoreService`) is the **only** place that
touches Firestore or calls a Cloud Function — components never do either
directly.

## Types

`src/types/index.ts` re-exports shared shapes from `@linyup/shared` (Contact,
ranking systems, gamification settings, goals/check-ins, contact alerts, the
`listAvailability` and `getMyBookings` payload types) rather than
hand-mirroring them. What remains local: `TeamPublicProfile` (the shared type
extended with two fields real mirror docs carry that `@linyup/shared` hasn't
caught up to declaring — see the file for why) and genuinely mobile-only view
models (the appointment carousel's row shape, the leaderboard/weekly-report
wire shapes, `SessionPublicProfile`).

## Project structure

```
src/
├── config/firebase.ts        # Firebase app/auth/firestore/functions init + emulator wiring
├── contexts/AuthContext.tsx  # Passwordless auth state (see Auth above)
├── navigation/AppNavigator.tsx
├── screens/                  # LoginScreen, ProfileScreen (one screen per file)
├── components/               # Reusable UI, components/profile/ for the profile screen's cards
├── services/
│   ├── firestore.ts          # The ONE Firestore + callables gateway (FirestoreService)
│   ├── sessionMirror.ts      # The session mirror's `type` discriminator constant
│   └── storage.ts            # AsyncStorage (auth state persistence)
├── utils/                    # Pure helpers — profileUtils, contactAlerts, goalContract
│                              # (thin re-exports of @linyup/shared where it already owns
│                              # the logic), publicProfileMapper, appointmentAccess,
│                              # mobileAppTelemetry, waiverRefusal
└── types/index.ts            # @linyup/shared re-exports + genuinely mobile-local types
```

## Environments

`app.config.js` picks a Firebase project from `FIREBASE_PROJECT_ID`:
`demo-linyup` (local emulator, no key needed), `linyup-staging`,
`linyup-sandbox`, `linyup-prod`. See `.env.example`. Each environment also
carries a `webAppUrl` (used to point a member at their studio's web Space
when the mobile app isn't in their plan).

## Theming — the app wears the studio's look

The app is "Linyup" (one listing, one bundle id), but after sign-in it re-themes
to the member's studio: `bioLinkThemePreset` + `bioLinkAccentColor` (the same
presets and dark-mode rule as the studio's public site, `@linyup/shared`
`themePreset.ts`) and the studio logo, all read off the `public_profile` mirror
the app loads anyway. `src/utils/tenantTheme.ts` derives every MD3 primary role
from the one accent (pure, WCAG-checked in tests); `TenantThemeContext` holds
and persists the brand (a cold start opens in the studio's colours) and clears
it with the session. Colours that mean something regardless of brand — status,
category, a third-party mark — come from `theme.semantic` (`useAppTheme`), never
from a hex in a component. An org-branded *build* is a different thing
(`app.config.js` → `APP_VARIANT`, one entry; roadmap §5).

## Running locally

**Read `.claude/skills/local-env/SKILL.md` and run
`node scripts/local-env.mjs status` before starting anything** — several
worktrees share the same emulator ports. This app is in the slot model: the
emulator PORTS come from `.env.local` (`EXPO_PUBLIC_*_EMULATOR_PORT`, written by
`local-env init` for this checkout's slot; Expo loads that file itself before
`app.config.js` runs), Metro is slot port 8081, and the emulator HOST is
resolved from the Metro/Expo dev-server IP so a phone on the LAN reaches the
dev machine.

```bash
pnpm install && pnpm bootstrap   # from repo root — writes .env.staging (fill FIREBASE_API_KEY)
pnpm emulators:seed              # Terminal 1 — backend (see root README / SKILL.md)
pnpm dev:mobile:emulators        # Terminal 2 — this app, against the emulators
# or: pnpm dev:mobile            # against linyup-staging (the default, non-emulator target)
```

`app.config.js` refuses a real project without `FIREBASE_API_KEY` at config
time, naming the env file to fill — rather than running against it with a
placeholder and failing later as `auth/invalid-api-key`.

**Sign in as** `app.review@example.com`, code `123456` — the review studio
(`linyup-demo`) every seeded environment provisions; `docs/test-accounts.md`
has every other login. Builds older than `app_settings/mobile.
min_supported_version` (operator console → Member app) open on an
update-required screen; the gate fails open.

Scripts (see `package.json`): `start` / `start:clear` / `start:prod` (staging
/ production), `start:emulators` / `start:emulators:web` (local emulators),
`android` / `ios` (native builds), `typecheck`, `lint` (`expo lint`), `test`
(`jest`). Every `start*`/`android`/`ios` script runs `shared:build` first —
`@linyup/shared`'s `dist/` must be current or the app runs stale shared code
with no error anywhere.

## Testing

`pnpm test` runs Jest (`jest-expo` preset) over pure logic only — the
public-profile mapper, the appointment-benefit badge helper, the mobile
telemetry payload shape, the affiliation-term locale pick, the session-mirror
type constant, the min-version decision. No emulator, no rendering.

`pnpm test:e2e` runs the Maestro smoke flow (`.maestro/login.yaml`: sign in
with the review login, land on the profile) against a build on a device or
simulator — needs the Maestro CLI; not wired into CI. The login chain's
server-side decisions are tested in
`packages/functions/src/auth/loginChain.test.ts`.

## Releases

The app ships on its own **`mobile-v*` tag**, decoupled from the backend's `v*`
releases. `.github/workflows/mobile.yml` runs these lanes — PR checks; `main` →
the `staging` channel (OTA update, or a `preview` build when the native
fingerprint changed); `mobile-v*` → the `production` channel (OTA, or a `store`
build — never submitted, that stays a deliberate `eas submit`); and a manual run
with `store_build` that forces a `store` build even when the fingerprint is
unchanged (e.g. a binary App Review needs for a JS-only fix). How to cut a release, what
needs a native build, rollback, and the store checklist:
`.claude/skills/mobile-release/SKILL.md`.

## What's not here yet

- Push notifications (`expo-notifications`)
- Encrypted token storage (`expo-secure-store` — AsyncStorage today; audit
  finding D20, scheduled after the EAS/CI lane so it ships in a real build)
- i18n (English only, by design for now — see `utils/waiverRefusal.ts`'s
  header for the reasoning)
- Payments / checkout surfaces (appointments stay on the free path; a priced
  duration a contact isn't covered for is refused server-side)
- EAS release lanes, CI checks for this app, a minimum-supported-version gate

See `docs/mobile-roadmap-2026-09.md` (repo root) for the full plan and the
scan this app's hygiene pass was built from.
