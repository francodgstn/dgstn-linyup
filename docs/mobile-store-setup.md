# Member app — store setup: TestFlight + Play, testing now, public later

The sequel to `docs/mobile-eas-setup.md`. That runbook got the app building and
updating on EAS; this one gets it into the two stores. Same shape: written to be
executed by a Claude Code session **on the owner's laptop**, because every step
that matters here is behind an Apple or Google login.

Paste this into a local session to run it:

> Read `docs/mobile-store-setup.md` and execute it, step by step. Stop and ask
> me whenever a step needs a console login, a downloaded key, or a decision
> about what goes in a store listing.

## The one thing that decides the order

The Play account is a **personal developer account created after 13 November
2023**, so Google requires a **closed test with 12 testers opted in
continuously for 14 days** before the app is eligible for production. It is
per-app, so Linyup owes it once. Internal testing does **not** count.

That 14 days is wall-clock, not work. Nothing compresses it. So the whole
sequence below is arranged around one goal — **get an AAB into a closed track
with 12 testers as early as physically possible** — and everything else,
including all of the iOS work, happens while that clock runs.

Realistic shape: day 1 start the clock, day 15 apply for production access,
review takes up to 7 days, public around day 21.

Apple has no equivalent clock. TestFlight internal testing is available the
moment the first build is uploaded.

## What is already true (do not redo)

- The app builds and ships. `docs/mobile-eas-setup.md` is done: EAS project
  `@francodagostino/linyup`, the `EXPO_TOKEN` robot, the staging lane
  publishing OTA updates and building when the fingerprint changes.
- **The Android keystore exists** on EAS (`credentialsSource: remote`),
  generated on the first `preview` build. Play submissions reuse it.
- **The release lane already auto-submits.** `.github/workflows/mobile.yml`'s
  `release` job passes `auto-submit-builds: true`, so once credentials are on
  EAS, `git tag mobile-v*` builds and submits with no further clicks.
- **Version codes manage themselves**: `eas.json` sets `appVersionSource:
  remote` and `autoIncrement: true` on the `store` profile.
- **The reviewer login exists**, and it is the same one everywhere:
  `app.review@example.com`, code `123456`, studio `linyup-demo`
  (`docs/test-accounts.md`). This is what goes in ASC's "Sign-in required"
  notes and Play's "App access" section. The code's window is 60 days from the
  last seed, so re-seed before submitting if it has lapsed.
- **In-app account deletion exists** — `Profile → Delete account` →
  `requestContactDeletion`, which schedules deletion 30 days out, keeps the
  account working, and cancels on sign-in; `dailyTasks/anonymizeScheduledContacts`
  anonymises at the deadline. Apple guideline 5.1.1(v) is satisfied.
- **The web deletion URL exists**: `linyup.com/delete-account`. Play requires
  one alongside the in-app route.
- **The privacy policy covers app users** — `/privacy` §2.10, written for
  members, matching the deletion behaviour above.
- **The app runs on a real device and the review login works** — verified
  2026-09-03 on build `0e3f3ee6`, which is what the store reviewer will do
  first. Two device checks remain open; see `docs/mobile-eas-setup.md` step 7.
- The app collects **no advertising ID, no third-party analytics and no
  location**. What it writes back is `last_seen_at` plus app/OTA version
  (`utils/mobileAppTelemetry.ts`) and, since 2026-09-04, a **push device token**
  when the member has notifications enabled. This keeps the Data safety and App
  Privacy answers short, but no longer quite as short — see the table below.
- **Android push is NOT wired, and is parked until after the store review**
  (decided 2026-09-04). iOS is done — App ID capability, and an APNs key on EAS.
  Android needs a Firebase Android app per project, `android.googleServicesFile`
  in `app.config.js`, and an FCM V1 key on EAS. It is not a Play Console setting,
  which is where people look for it. The asymmetry that matters: the APNs key is
  server-side so iOS can be switched on with an OTA, while `google-services.json`
  is baked into the binary — Android push needs a NEW STORE BUILD, so it has to
  be wired before the build that ships, not after.
- **Push is present but ASLEEP** (`apps/mobile/src/push/registerPushToken.ts`).
  It never calls `requestPermissionsAsync`, so no member sees a dialog and a
  fresh install registers nothing; a token is stored only for someone who
  enabled notifications in their OS settings. Declare it anyway. The capability
  ships in the binary and switching it on later is an OTA by design — so a
  declaration that waits for the first notification is a declaration that goes
  stale with no store build to hang the correction on.

## Decisions to take before touching a console

**iPad — DECIDED 2026-09-03: no.** `ios.supportsTablet` is `false`. Declaring
iPad support obliges the App Store listing to carry a full iPad screenshot set
on top of iPhone, forever, on every listing update — and this is a phone app: a
QR check-in scanner, a booking list, a profile. Reversing it is one line plus
that screenshot set.

**Store name.** The listing name is not the bundle id and does not have to be
"Linyup" alone; it is what members search for. Decide before creating the
records, because changing it later means a review round on both stores.

## Steps

### 1. Preflight

```bash
node scripts/local-env.mjs status
npx eas-cli whoami                  # francodagostino
gh auth status
```

Have ready: the Apple Developer account, the Google Play Console account, and
a Google Cloud project you can create a service account in.

### 2. Google Play first — it starts the clock

Everything in this step exists to reach "12 testers opted in" today rather than
next week.

**a. Create the app.** Play Console → All apps → Create app. The package name
must be **`com.dgstn.linyup`** and cannot be changed afterwards.

**b. Complete "App content".** Play will not release to *any* track until this
is done, so it is on the critical path. Answers that are already settled:

| Item | Answer |
|---|---|
| Privacy policy URL | `https://linyup.com/privacy` |
| Account deletion URL | `https://linyup.com/delete-account` |
| App access | Not all functionality is public — give `app.review@example.com` / `123456` and say the code is fixed and never emailed |
| Ads | No ads |
| Target audience | Adults; the app is used by a studio's members |
| Data safety | See the table below |

**Data safety — a starting draft, to be checked against the app before
submitting, not pasted blind.** It is derived from what the app actually reads
and writes:

- Collected: **Name, Email address, Phone number, Address, Other personal info**
  (date of birth) — all "collected, not shared", "required for the app to
  function", and user-deletable.
- Collected: **App activity** (bookings, attendance) and **App info and
  performance** (app version) for app functionality and support.
- Collected: **Device or other IDs** — the push device token, stored at
  `contacts/{id}/push_tokens/{token}`. Purpose: app functionality. Not shared.
- Not collected: advertising ID, location, contacts, photos, messages,
  financial info (there is no checkout in the mobile app), health data.
- Encrypted in transit: **yes**. Deletion request route: **yes**, with the URL
  above.

Firebase is a service provider processing on Linyup's behalf, which Play counts
as collection rather than sharing — do not tick "shared with third parties" for it.

**c. Build a store AAB.**

```bash
cd apps/mobile
npx eas-cli build --profile store --platform android
```

**The `store` profile targets `linyup-prod`** — flipped 2026-09-10. It pointed at
`linyup-staging` from 2026-09-03 so the 14-day clock could start before the
production key was settled; that trade is over.

**Flip on a build you were making anyway.** The closed test was going to need a
v1.0.1 AAB regardless — an OTA cannot reach a closed-track build (wrong channel,
and by then a different fingerprint) — so the prod configuration rode along and
got a week of exercise by ~103 testers before it was the thing being submitted.
The alternative was for the FIRST prod-pointed build to be the one going to
production, which is the same big-bang shape that produced the empty demo tenant.

The key lives in BOTH the `store` profile's `env` block and the `production` EAS
environment (`docs/mobile-eas-setup.md` step 5 explains why both, and why omitting
the `env` half fails with an empty error). When both are present EAS says so and
the `env` one wins — they must not be allowed to drift apart.

**The release-lane guard now PASSES.** It refused a `mobile-v*` tag while this
value was anything but `linyup-prod`; from here a tag builds AND auto-submits both
platforms, so tag deliberately.

What changed for testers: they now sign into PRODUCTION's demo tenant rather than
staging's. Same logins, same fixed code — but production infrastructure, so
`pnpm provision:demo --project linyup-prod` is the repair if it drifts, and prod
is not a place to reseed casually.

**d. Upload that AAB by hand.** Google requires the first one to be uploaded
manually before `eas submit` can target a track. Play Console → Testing →
**Closed testing** → create release → upload.

Closed, not internal. Internal testing does not count toward the requirement.

**e. Add the testers, and start the clock.** Closed testing → Testers → email
list or **Google Group** — at any size past a dozen the group is worth it, since
roster churn is then one address to edit rather than a re-pasted list. Recruit
more than 12: one person opting out on day 10 costs your margin, and the 12 must
be opted in *simultaneously and continuously* for the full 14 days.

Since 2026 Google also checks the testers genuinely used the app, so opting in
and never launching fails the review. Whoever the testers are, the instruction
that matters is *open it*.

**What was actually done (2026-09-04): a paid tester service, ~103 testers, ONE
shared login.** Their intake form takes a single demo credential, so every
tester signs in as `tester01@example.com` / `123456` — the code goes in the form's
*Password* field, which their own instructions cover for OTP flows. Not the
reviewer's address: that stays for Google, so nothing 103 people do can reach it.

Sharing one contact is cosmetic, not dangerous, and the two things that would
have made it dangerous are already closed: a contact session may write only
`weight` / `last_seen_at` / `mobile_app`, so nobody can rename the account or
change its email and lock everyone out; and `requestContactDeletion` schedules 30
days ahead while the account keeps working, so a curious tap breaks nothing
inside a 14-day window. What IS shared: one booking per session, one score, one
radar. So tell testers to open the app and look around — **do not tell 103 people
to book a class**, because the first one succeeds and the rest see it already
booked and may report the app as broken.

**Write down the date the twelfth tester opted in.** That is day 0.

**f. Service account, for everything after the first upload.** Google Cloud
Console → IAM & Admin → Service Accounts → create → Keys → add key → JSON.
Then Play Console → Setup → API access → link the Cloud project → grant that
service account release permissions. Store the JSON on EAS:

```bash
cd apps/mobile
npx eas-cli credentials --platform android      # → Google Service Account key
```

Never commit the JSON. From here Play submissions are automated.

### 3. Apple — runs in parallel, no clock

**a. Create the app record.** App Store Connect → Apps → + → New App. Bundle id
`com.dgstn.linyup` (register it in the Developer portal first if it is not
there). Note the numeric **Apple ID** it gets — that is `ascAppId`.

**b. Mint an App Store Connect API key.** Users and Access → Integrations →
App Store Connect API → generate a key with the **App Manager** role. The `.p8`
downloads **once** — losing it means minting a new key. Note the Key ID and the
Issuer ID.

**c. Store it on EAS**, so submissions need no Apple password and no 2FA prompt:

```bash
cd apps/mobile
npx eas-cli credentials --platform ios
```

**d. Wire `eas.json`.** Add to the `submit` section, using the real values:

```json
"submit": {
  "store": {
    "android": { "track": "alpha" },
    "ios": { "ascAppId": "<numeric id>", "appleTeamId": "<team id>" }
  }
}
```

`alpha` is the standard **closed** track — this is what keeps automated
submissions landing where the 14-day requirement can see them. Switch to
`internal` or `production` once production access is granted.

**e. First iOS build and submit.**

```bash
npx eas-cli build --profile store --platform ios
npx eas-cli submit --profile store --platform ios
```

EAS generates the distribution certificate and provisioning profile. TestFlight
**internal** testers (up to 100, people on your ASC team) get the build with no
Beta App Review. External testers need Beta App Review, which is quick but not
instant.

### 4. Automate the listing (optional, worth it)

`eas metadata` keeps the **App Store** listing in the repo instead of the
console:

```bash
cd apps/mobile
npx eas-cli metadata:pull        # writes store.config.json from the live listing
npx eas-cli metadata:push        # pushes local edits back
```

Apple only — there is no Play equivalent, so the Play listing stays manual.
Committing `store.config.json` makes listing copy reviewable in a PR like
everything else.

### 5. The wait, then production access

On **day 15** (not 14 — leave a margin), Play Console → the closed test →
apply for production access. The questionnaire asks how you recruited testers,
how engaged they were, what feedback you got, who the app is for, and what you
changed as a result. Answer it from what actually happened; it is reviewed by a
person, typically within 7 days.

Once granted, the steady state is:

```bash
git tag mobile-v1.1.0 && git push --tags
```

→ checks → build both platforms → auto-submit → TestFlight and Play. And most
changes never need it at all: JS-only work ships as an OTA update through the
staging lane without a store round trip.

### 6. Record what changed

Add the `ascAppId`, the Apple team id, and the Play track to
`docs/mobile-roadmap-2026-09.md` §7 and to
`.claude/skills/mobile-release/SKILL.md` → "Secrets and where they live".

## Traps

- **A green lane does not mean a green build**, and a green build does not mean
  a successful submission. `auto-submit-builds` runs after the build; check
  `eas submit` output or the store consoles, not GitHub.
- **The first Play upload cannot be automated.** Attempting `eas submit` before
  a manual AAB exists fails with a track error that reads like a permissions
  problem.
- **The `.p8` downloads once.** Store it in a password manager the moment it
  lands, not in the repo.
- **A tester who opts out resets their own 14 days**, not everyone's — but
  drops you below 12, which stops the clock for the whole test.
- **The reviewer code expires.** 60 days from the last seed; re-seed before
  submitting or the reviewer cannot get in, which is an automatic rejection.

## Out of scope here

Public launch itself: store screenshots, the App Store description and
keywords, the content rating questionnaire, and the decision about the
production Firebase key. Each is a judgement call about the product rather
than a mechanical step.
