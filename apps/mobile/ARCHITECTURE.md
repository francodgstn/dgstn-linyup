# Linyup mobile app — architecture

This describes what actually exists today. See `README.md` for setup and
`docs/mobile-roadmap-2026-09.md` (repo root) for the plan this was scanned
into and what's still ahead.

## Screens

Two screens, gated on `AuthContext.isAuthenticated`:

- **`LoginScreen`** — email → 6-digit code → (if the email matches more than
  one contact) team/contact selection. Also renders the `appNotIncluded`
  state when every matched contact's team plan lacks the `member_app`
  feature (see Auth below).
- **`ProfileScreen`** — the whole authenticated app: a tab bar (Dashboard /
  Feed (placeholder) / Train / Team / Self) built from the `components/profile/*`
  cards, all data loaded once in `loadData()` and refreshed by pull-to-refresh.

`AppNavigator` swaps between two single-screen `Stack.Navigator`s
(`unauthenticated` → Login, `authenticated` → Profile) rather than hiding one
screen — this is what makes `navigation.reset()` on sign-in/sign-out safe
(no back-stack into the other mode).

## Auth flow

```
LoginScreen (email)
  → FirestoreService.sendVerificationCode          [sendContactVerificationCode callable]
  → user enters the 6-digit code
  → FirestoreService.verifyCode({ client: 'mobile' }) [loginContactWithCode callable]
       ├─ appNotIncluded: true         → LoginScreen shows the plan-gate screen (no session)
       ├─ requiresContactSelection     → LoginScreen shows a contact picker
       ├─ requiresSignup               → AuthContext returns a "no membership found" error
       └─ customToken + contact        → signInWithCustomToken(auth, customToken)
                                          AuthContext.setContact(contact)
```

`client: 'mobile'` is the one thing that distinguishes this login from the
web Space's — it activates the `member_app` plan gate server-side
(`packages/functions/src/auth/loginContactWithCode.ts`). The custom token's
claims (`contactId`, `teamId`, `sessionExpires`, epoch ms) are what every
Firestore rule and callable trusts; there is no `contacts/{id}` document a
client could read/write to fake identity.

`AuthContext` persists (via `StorageService`/AsyncStorage) the email, an
in-flight code id, the selected contact id and `sessionExpires`, and
refreshes the session (`switchActiveContact`) when `sessionExpires` is within
24h — `sessionExpires` is a **custom claim**, and unlike a Firebase Auth ID
token it does not auto-renew.

## Data flow

```
Component
  → FirestoreService (src/services/firestore.ts)     — the ONLY Firestore/callables gateway
      ├─ teams/{id}/public_profile/{id}   (world-readable mirror; mapPublicProfileMirror)
      ├─ contacts/{id}                    (self-read/self-update only; firestore.rules)
      ├─ contacts/{id}/{goals,contact_alerts,performance_checkins,...} (self-scoped subcollections)
      ├─ {teams|orgs}/*/sessions/{id}/public_profile/{id}  (collectionGroup, `type == 'session'`)
      └─ Cloud Functions callables: getMyBookings, listAvailability, bookAppointment,
         bookSession, cancelBooking, selfCheckIn, requestContactUpdate, getContactQR,
         getMyReferralCode/Stats, requestContactDeletion/cancelContactDeletion, …
```

A contact session cannot read `teams/{id}`, `organizations/{id}` or
`teams/{id}/subscription_types/*` — firestore.rules refuses it (no
`team_members` row). Everything the member surfaces need from those
collections (ranking systems, the org's affiliation-concept label,
gamification settings, coaching axes, goal categories) is denormalised onto
`public_profile` by `syncTeamPublicProfile` specifically so this app never
has to try. The contact's own plan name is read off `Contact
.active_subscriptions` / `.subscription_type_name` — never a
`subscription_types` document.

"My bookings" (class **and** appointment, including ones the studio entered)
comes from **one** `getMyBookings` call, never a per-session
`bookings/{contactId}` read in a loop — see the module header of
`packages/functions/src/booking/myBookings.ts` for the three ways that used
to go wrong. Past attendance (`getContactAttendance`) is the one legitimate
remaining per-session fan-out: it checks the contact's own
`sessions/{id}/participants/{contactId}` doc, a fact `getMyBookings` (upcoming
bookings only) cannot answer.

## Types

`src/types/index.ts` re-exports `@linyup/shared` for every shape the rest of
the platform also uses (Contact, ranking systems, gamification settings,
goals/evaluations/check-ins, contact alerts, the `listAvailability` and
`getMyBookings` payloads). Local types are either a documented extension of a
shared one (`TeamPublicProfile`, for two real fields `@linyup/shared` hasn't
caught up to declaring) or genuinely mobile-only view/wire shapes with no
platform-wide owner (the appointment carousel's row, the leaderboard/weekly
report shapes, `SessionPublicProfile`).

## Theming

`App.tsx` → `TenantThemeProvider` (above `PaperProvider`) → `buildTheme(systemDark,
resolveTenantTheme(brand, systemDark))`. The brand (`TenantBrand`: preset id,
accent, logo, name) is set by `ProfileScreen` from the team's `public_profile`
mirror (`brandFromProfile`), persisted in AsyncStorage, and cleared by
`AppNavigator` whenever there is no session. `resolveTenantTheme`
(`src/utils/tenantTheme.ts`) is pure: it resolves the studio's preset through
`@linyup/shared`'s `resolveSurfacePalette` (a non-adaptive preset such as `ink`
is dark in both system schemes), lifts the accent in dark mode, and derives
primary / container / inverse roles, tinted elevation levels and the gradient
stops. Null = Linyup's own theme, for no brand or anything malformed.
`theme.semantic` carries the brand-independent colors; `useAppTheme()` is the
typed accessor.

## Update channel

`AppNavigator` calls `Updates.checkForUpdateAsync()` on foreground/cold-start
(`useAppUpdates`) and reports `mobile_app` telemetry (app version + OTA
runtime version/channel/embedded flag/update id — `buildMobileAppTelemetry`)
via `FirestoreService.updateLastSeen`, which writes exactly `last_seen_at` +
`mobile_app` on the contact doc (the two keys the self-update rules arm
admits). `app.config.js`'s `updates.url` is unset until `EAS_PROJECT_ID` is
set (`eas init` — see the mobile roadmap's "What only the owner can do"), so
OTA is currently inert everywhere.

## What's deliberately not here

Push notifications, encrypted token storage (`expo-secure-store`), i18n,
payment/checkout surfaces, a minimum-supported-version gate, and any EAS
release lane or CI check for this app — see `README.md` → "What's not here
yet" and `docs/mobile-roadmap-2026-09.md`'s sequence.
