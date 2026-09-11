---
name: mobile-release
description: Release the Linyup member app (apps/mobile) — decide OTA vs store build, cut a mobile-v* tag, watch the EAS lanes, and finish a store submission. Use when asked to ship, hotfix, roll back or submit the mobile app, or to explain why a change needs a native build.
---

# Mobile release — the member app ships on its own tag

The app (`apps/mobile`, package `@linyup/mobile`, Expo slug `linyup`) releases
on **`mobile-v*` tags**, never on the backend's `v*` tags. The two cadences are
deliberately decoupled (`docs/mobile-roadmap-2026-09.md` §3): a web rollout is
instant and pinnable, a store build takes days and cannot be un-shipped.

## The three lanes (`.github/workflows/mobile.yml`)

| Trigger | What runs | You do |
|---|---|---|
| PR touching `apps/mobile/**` or `packages/shared/**` | lint, jest, `tsc`, `expo config` per project (catches config-time throws) | nothing |
| `main` merge touching the same | Expo's `continuous-deploy-fingerprint` action against the `preview` profile / `staging` branch: a build with the current fingerprint exists → OTA update; none → a preview build (internal distribution, staging Firebase). It comments the result on the commit. | install the preview build link on your phone |
| `mobile-v*` tag | same action, `store` profile / `production` branch: OTA when possible, otherwise a store build. It does **NOT** submit. | approve the `production` gate, then `eas submit` the build CI made |

## Where a store binary must come from

**From CI. Never from `eas build` on your laptop.**

The fingerprint is computed by whichever machine runs the command, and a dev
machine does not agree with the runner. Same commit, measured:

| | iOS | Android |
|---|---|---|
| GitHub runner (Linux) | `b817ef4f…` | `a4093b56…` |
| Windows checkout | `88d18f6f…` | `4e1cc6df…` |

`.gitattributes` sets `* text=auto`, so a Windows working tree holds CRLF where
the runner holds LF — and `@expo/fingerprint` reads `.gitignore` to decide what
to SKIP, so the CRLF copy's patterns stop matching and 172 `node_modules`
paths get hashed in that CI correctly ignores.

Two consequences, and the second is the one that bites:

- CI will never find a locally-built build, so the lane rebuilds every time
  instead of publishing an update. Wasteful, visible, harmless.
- **An OTA only reaches builds carrying ITS fingerprint.** Publish from CI
  while the store binary was built locally and the update targets a build
  nobody installed — the lane reports success, the dashboard shows the update,
  and not one phone changes. Nothing anywhere reports this.

So whichever machine builds the binary that ships must also be the machine that
publishes updates to it. CI is the one that can do both unattended, which is why
it is CI and not the laptop.

**Where this stands (2026-09-11).** Both binaries in the stores today were built
on the Windows checkout — TestFlight 1.0.1(3) (`88d18f6f…`) and Play closed
testing version code 3 (`4e1cc6df…`) — so a CI-published OTA reaches NEITHER.
Until the next store binary comes from a `mobile-v*` tag, publish updates the way
1.0.1's safe-area fix went out: `eas update --branch production --environment
production` from the machine that built them. The switchover costs one release,
once.

A local `eas build` is still right for anything you are NOT shipping: a
`preview` build for your own phone, or reproducing a build failure.

## OTA or native build? The fingerprint decides — but know the rule

`runtimeVersion.policy: 'fingerprint'`: Expo hashes the native project (deps
with native code, config plugins, `app.config.js` native fields). A change
that alters the fingerprint **cannot** ship over the air; the lane builds
instead. JS/TS-only changes, assets, copy, most `packages/shared` changes → OTA.
Adding/removing a dependency with native code, touching `plugins`, permissions,
icons/splash, bundle ids → build.

`apps/mobile/fingerprint.config.js` makes the hash ignore `extra` and the
version fields (`SourceSkips.ExpoConfigExtraSection | ExpoConfigVersions`).
Without it the lane's runner — which evaluates `app.config.js` with no
`FIREBASE_API_KEY`, i.e. the demo project — would never hash the same as the
EAS build carrying the real key, every push would look native, and OTA would
never be chosen. Keep runtime data in `extra`; never move native config there.
`npx @expo/fingerprint apps/mobile` prints the hash and its sources.

Never bump `runtimeVersion` by hand; never set `updates.url` or
`extra.eas.projectId` by hand (owner-set once via `eas init`).

**Retiring a build that can no longer follow the backend** is a separate
lever: operator console → `Settings → Member app` → minimum supported version
(`app_settings/mobile`). Older builds open on an update-required screen with
the store links. It fails OPEN on a malformed value; the console validates.
Use it rarely — an OTA reaches every build on the same fingerprint without it.

## Cutting a release

```bash
git checkout main && git pull
# version is ONE source: apps/mobile/package.json — app.config.js reads it
pnpm --filter @linyup/mobile version <major|minor|patch> --no-git-tag-version
git commit -am "chore(mobile): v1.2.0"
git tag -a mobile-v1.2.0 -m "<one line: what members get>"
git push origin main mobile-v1.2.0
```

The tag body is the release note (same convention as the backend's `v*`
tags). Store build numbers are EAS-managed (`appVersionSource: remote`,
`autoIncrement` on `store`).

## An update during the Play closed test (before production access)

A mid-test update is a STORE build, not an OTA: Play only sees a new version code on the
closed track, and an EAS Update is invisible to it. Testers who uninstall a
broken build drop the count below twelve and the fourteen days restart, so the
order below puts your own phone before theirs.

```bash
# 1. version — the notes live beside the listing assets
pnpm --filter @linyup/mobile version patch --no-git-tag-version
#    write apps/mobile/store/release-notes/<version>/{en-US,de-DE,fr-FR,it-IT}.txt
git commit -am "chore(mobile): v1.0.1 — <what testers get>"     # PR, merge

# 2. tag — CI builds it. Do NOT `eas build` a store binary from here:
#    see "Where a store binary must come from".
git tag -a mobile-v1.0.2 -m "<why>" && git push origin mobile-v1.0.2
#    then approve the `production` environment gate and wait for the build

# 3. submit the build CI made (submit.store.android.track = alpha)
cd apps/mobile
npx eas-cli submit --profile store --platform android --latest

# 4. Play Console → Closed testing → the new release: paste the notes per
#    language, but install it on YOUR phone from the tester link and sign in
#    with the review login before rolling it out to the group.
# 5. Tell the testers what changed and ask for ONE concrete thing
#    ("switch the phone to German, book a class, reply with what annoyed you") —
#    the production-access questionnaire asks for feedback and what you changed.
```

## Backend compatibility — the rule the web never needed

A phone can be several store versions behind. Before merging a backend change:

- callable **responses are additive** — never remove or rename a field a
  shipped app reads (the `accessRule` removal crashed the appointment modal);
- the `listAvailability` and `getMyBookings` payloads have ONE typed owner in
  `packages/shared` — change the type, and every consumer's typecheck fails
  loudly;
- if a break is unavoidable, raise `app_settings/mobile.min_supported_version`
  (step 4 of the roadmap) so old builds are told to update instead of failing
  silently.

## Hotfix and rollback

- JS-only fix: merge to `main`, tag `mobile-vX.Y.Z` → OTA in minutes.
- Roll back an OTA: `eas update:republish --branch production --group <id>`
  (EAS keeps every update group; pick the previous one).
- Roll back a store build: you can't. Ship a fix forward; use the min-version
  gate to stop the broken build from running if it is data-damaging.

## Store submission checklist (first time and every native release)

- Build profiles are `development` (dev client, staging Firebase), `preview`
  (internal distribution, staging Firebase, `staging` channel) and `store`
  (store distribution, prod Firebase, `production` channel, auto-incremented
  build numbers). Only `store` is submittable; there is deliberately no
  internal "production" profile — it used to exist and produced builds that
  looked shippable and were not.
- Review login: operator console → Settings → Demo tenant → review access
  (fixed OTP for `app.review@example.com`, ≤ 60 days) — paste into ASC/Play
  "App access" notes (`docs/launch/prod-demo-and-store-review.md`).
- Account deletion is in-app (Profile → Delete my account) — Apple 5.1.1(v).
- Camera purpose string is explicit and the microphone permission is off
  (`expo-camera` plugin config in `app.config.js`).
- **Push credentials must be uploaded BEFORE the first build carrying
  `expo-notifications`.** The plugin is in `app.config.js` and the app registers
  a token when permission is already granted (`src/push/registerPushToken.ts`) —
  but delivery needs an FCM V1 service account (Android) and an APNs key (iOS)
  in EAS (`eas credentials`), and neither lives in this repo. Ship without them
  and the app happily stores tokens that can never be delivered to; you find out
  the day someone wires the first send, not at build time. Nothing prompts and
  nothing sends yet, so a build that goes out ahead of the credentials is not
  broken — it is just not yet useful.
- iPad screenshots are required while `ios.supportsTablet` is true.
- Privacy policy must cover the app's users (studio contacts); Terms/DPA must
  not carry the DRAFT banner.

## Secrets and where they live

The one-time staging setup (project, key, token, first build) is a runbook
for a local session: `docs/mobile-eas-setup.md`. Run 2026-09-03 — the EAS
project is `@francodagostino/linyup`, `f941b285-002a-4bdb-8c42-8c3e5edfab66`.

**The staging half is COMPLETE and both halves of the lane are proven on
`main`**: the project, the `EXPO_TOKEN` robot (`linyup-eas-robot`), the key
in both channels, a finished `preview` APK, and EAS updates landing on the
`staging` branch at a runtime version that APK matches. What remains is all
Apple/Google (see the roadmap §7), plus the prod key.

- `EXPO_TOKEN` — GitHub repository secret (the CI's EAS identity).
- `EAS_PROJECT_ID` — the project id is now the DEFAULT in `app.config.js`
  (`extra.eas.projectId` + `updates.url` are live, so OTA is armed). The env
  var only redirects a build at another EAS project; an empty value falls
  back to the default (which is why the config uses `||`, not `??` — the
  `.env.*` templates ship `EAS_PROJECT_ID=`).
- First Play submission is manual: Google requires the very first AAB to be
  uploaded by hand before `eas submit` can target a track. The whole store
  path — both consoles, the credentials, and the 14-day Play closed-testing
  clock that gates going public — is `docs/mobile-store-setup.md`.
- `FIREBASE_API_KEY` — **both** `eas.json`'s `env` block per profile **and**
  an EAS environment variable per environment. Not redundancy: the `env`
  block is the only thing in scope when `eas build` evaluates app.config.js
  LOCALLY (eas-cli sets `EXPO_NO_DOTENV=1` there), while the EAS environment
  variable is what the builder gets and what `eas update --environment`
  resolves for the OTA path. `development` and `preview` carry the staging key
  in both. The `store` profile TEMPORARILY carries the STAGING key too, so the
  Play closed test could start before the prod key was decided — the release
  lane refuses a `mobile-v*` tag while its `FIREBASE_PROJECT_ID` is anything but
  `linyup-prod`, so this cannot ship by accident. The `production` EAS
  environment still carries nothing. Write the literal value —
  `"${FIREBASE_API_KEY}"` is not interpolated and gets baked in as that string.
- Apple ASC API key, Play service-account JSON — stored on EAS
  (`credentialsSource: remote`).

## Traps recorded

- `"${FIREBASE_API_KEY}"` in `eas.json` bakes the literal into the app: auth
  fails at runtime, build succeeds.
- The opposite trap, which cost the first green run on main: NO key in
  `eas.json` `env` at all. `eas build` evaluates app.config.js locally before
  upload, the config's own guard throws, `expo config --json` exits 1 with
  EMPTY stderr, and expo-github-action reports only "failed with exit code
  1". Nothing anywhere names the cause. An EAS environment variable does not
  cover this — it is not in scope for that local read.
- **A green lane does not mean a green build.** The action starts builds with
  `--no-wait`, so the job goes green the moment the build is QUEUED. The first
  run after the key fix reported success while its build failed four minutes
  later, and nothing in GitHub ever says so — the commit comment carries a
  link, not an outcome. After any lane run that STARTS a build (rather than
  publishing an update), check EAS: `eas build:list --platform android
  --limit 3`, or `--json` for the `error` field, which is the only place the
  reason appears.
- Gradle failures on EAS can be transient. Two builds of the SAME fingerprint
  errored with `EAS_BUILD_UNKNOWN_GRADLE_ERROR` and a third finished, same
  native inputs. Identical fingerprint + different outcome = infrastructure,
  not code; re-run before investigating.
- A stale `packages/shared/dist` on the EAS builder: `eas-build-post-install`
  builds shared; if that script is removed, Metro fails to resolve
  `@linyup/shared`.
- `expo config` throws on an unknown `FIREBASE_PROJECT_ID` — every profile's
  env must name a project the `environments` map in `app.config.js` knows.
- **A CONFIG EDIT COSTS A REBUILD, and the scoping you wrote it with does not
  survive.** Both config files are hashed WHOLE, so a change aimed at one
  platform or one profile invalidates every fingerprint. Two mechanisms, both
  measured on 2026-09-03, both of which look like bugs until you know:

  | Edit | Hashed as | What actually happens |
  |---|---|---|
  | `app.config.js` | one `expoConfig` source, no platform filter | an `ios.*` field rebuilds ANDROID — the Android fingerprint's config blob contains `ios.supportsTablet` |
  | `eas.json` | one `easBuild` file source, no profile filter | a `store`-only `env` change rebuilds `preview` |

  The lane then finds no build matching the new fingerprint and BUILDS instead
  of publishing an update. Expected, not a fault.

  **So batch config changes.** Three separate config commits on 2026-09-03
  produced three Android builds back to back, and because EAS runs them on a
  queue they serialised — the third (the one actually wanted) started last. Each
  merge also strands the previously installed APK: OTA updates only reach a
  build whose fingerprint matches, so a tester on the older APK silently stops
  receiving them. One commit, one rebuild, one reinstall.

  `fingerprint.config.js` already skips the two parts that would otherwise churn
  on EVERY push (`extra` and the version fields). What is left genuinely
  describes the native project, so there is nothing further to skip — the answer
  is fewer config commits, not more `sourceSkips`.
