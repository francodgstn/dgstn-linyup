---
name: mobile-release
description: Release the Linyup member app (apps/mobile) — decide OTA vs store build, cut a mobile-v* tag, watch the EAS lanes, and finish a store submission. Use when asked to ship, hotfix, roll back or submit the mobile app, or to explain why a change needs a native build.
---

# Mobile release — the member app ships on its own tag

The app (`apps/mobile`, package `@linyup/mobile`, Expo slug `linyup`) releases
on **`mobile-v*` tags**, never on the backend's `v*` tags. The two cadences are
deliberately decoupled (`docs/mobile-roadmap-2026-09.md` §3): a web rollout is
instant and pinnable, a store build takes days and cannot be un-shipped.

## The lanes (`.github/workflows/mobile.yml`)

| Trigger | What runs | You do |
|---|---|---|
| PR touching `apps/mobile/**` or `packages/shared/**` | lint, jest, `tsc`, `expo config` per project (catches config-time throws) | nothing |
| `main` merge touching the same | Expo's `continuous-deploy-fingerprint` action against the `preview` profile / `staging` branch: a build with the current fingerprint exists → OTA update; none → a preview build (internal distribution, staging Firebase). It comments the result on the commit. | install the preview build link on your phone |
| `mobile-v*` tag | same action, `store` profile / `production` branch: OTA when possible, otherwise a store build. It does **NOT** submit. | approve the `production` gate, then `eas submit` the build CI made |
| manual run, `store_build` = `ios` / `android` / `all` | `eas build --profile store --no-wait` on the runner, **whatever the fingerprint says**. Same `production` gate and "store targets linyup-prod" guard; does **NOT** submit. | approve the gate, wait for EAS, `eas submit --id <build>` |

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

**Where this stands (2026-09-16).** The switchover is done. Both stores carry
the CI builds from `mobile-v1.0.1-ci1` — Play closed testing version code 5
(`a4093b56…`) and TestFlight 1.0.1(5) (`b817ef4f…`) — and `mobile-v1.0.2`
reached them over the air. So a tag now reaches real phones, and **the laptop
must not publish updates any more**: a local `eas update` hashes the Windows
fingerprint and targets the old locally-built binaries, which the Play track no
longer carries. Play shows versionName **1.0.1** while the channel serves
**1.0.2**; that is correct — the shipped artifact is the build CI made, and the
1.0.2 changes arrive on first launch.

**One thing to check on iOS before the App Store release goes live:** which
build is attached to the version. A 1.0.1(3) submitted for review before the
switchover is locally built (`88d18f6f…`); if that is what ships, no App Store
user ever receives a CI-published update. Swap it for 1.0.1(5) on the version
page — TestFlight testers still on build 3 should update for the same reason.

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

## A new binary when the fingerprint did not change

The tag lane can only answer "unchanged fingerprint → publish an update", so a
JS-only change can never produce a binary from a tag. Usually that is exactly
right. It is wrong when a store needs a NEW BINARY to look at, most often
**App Review**: a rejection fixed in JS still has to be resubmitted as a build,
and a reviewer on a fresh install sees the embedded bundle, not the OTA
(expo-updates applies a downloaded update on the NEXT cold start).

Do not build it on the laptop (see "Where a store binary must come from").
Force it on the runner instead. First run of this: 2026-09-19, App Review
5.1.1(iv), the camera pre-prompt (#448, #449), which gave iOS 1.0.3(6).

```bash
# 1. Fix + version bump + release notes merged to main (as in "Cutting a release")
# 2. Tag it anyway: the OTA brings existing installs the fix
git tag -a mobile-vX.Y.Z origin/main -m "<why>" && git push origin mobile-vX.Y.Z
# 3. Force the binary (dispatch from main or the tag)
gh workflow run mobile.yml --ref main -f store_build=ios
#    approve the production gate. The job goes green when the build is QUEUED,
#    so follow the EAS build itself (note: build:view takes --json but
#    REJECTS --non-interactive; a poll loop with that flag never sees a status)
cd apps/mobile && npx eas-cli build:list --platform ios --limit 2 --json
npx eas-cli build:view <build-id> --json
# 4. Submit THAT build by id, not --latest
npx eas-cli submit --profile store --platform ios --id <build-id> --non-interactive
```

The binary carries the same fingerprint as the one already in the store, so
later updates reach both. On iOS the version string is the ASC version: attach
the new build to a version with THAT number (rename the rejected version or
create one), then reply in the Resolution Center naming the build.

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

## A native Android update (production track)

Play production access was granted on 2026-09-19, and 1.0.3 (version code 6)
was the first production release. `submit.store.android.track` is now
`production`, so `eas submit` puts a build in front of the public (after
Google's review) — there is no closed-track stop on the way any more.

```bash
# 1. version — the notes live beside the listing assets
pnpm --filter @linyup/mobile version patch --no-git-tag-version
#    write apps/mobile/store/release-notes/<version>/{en-US,de-DE,fr-FR,it-IT}.txt
git commit -am "chore(mobile): vX.Y.Z — <what members get>"     # PR, merge

# 2. tag — CI builds it when the fingerprint changed; a JS-only change is an
#    OTA and needs none of this. To force a binary anyway, use the manual
#    `store_build` run. Do NOT `eas build` a store binary from the laptop:
#    see "Where a store binary must come from".
git tag -a mobile-vX.Y.Z -m "<why>" && git push origin mobile-vX.Y.Z
#    then approve the `production` environment gate and wait for the build

# 3. submit the build CI made — FROM apps/mobile. The repo root has no app
#    config, so eas-cli says "EAS project not configured" there; never answer
#    that with `eas init`, which creates a second EAS project.
cd apps/mobile
npx eas-cli submit --profile store --platform android --id <build-id>

# 4. The upload carries NO release notes — paste store/release-notes/<version>/*
#    per language in Play Console. Changes then collect on Publishing overview
#    and go to review; managed publishing is OFF, so approval = live.
```

Want your own phone first? Set `submit.store.android.releaseStatus` to
`"draft"` in `eas.json` (or temporarily `track: "alpha"`) and promote in
Play Console after testing.

**A version code uploads once.** Play refuses a re-upload of a version code it
already holds, so `eas submit` cannot move a build between tracks — a build
already on closed testing reaches production through Play Console
(Production → Create new release → *Add from library*), not through EAS.

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
- **Uploading to Play is automated** (since 2026-09-16). `eas submit -p android`
  authenticates as `linyup-play-publisher@linyup-prod.iam.gserviceaccount.com`
  and needs no console visit; the very first AAB had to go by hand, long done.
  How it was set up, should it ever need redoing — a rotated key, say:

  1. **The account is Terraform** — `infra/modules/iam`, flag
     `create_play_publisher`, prod only. `terraform -chdir=infra/environments/prod
     output play_publisher_sa` prints its address. It has NO GCP role: its power
     comes from the Play invitation, not from IAM on the project.
  2. **Play Console → Users and permissions** → that address, with at least
     *Release to testing tracks*. Developer-account membership is not a GCP
     resource, so Terraform cannot do this step. Without it the submit fails
     AFTER authenticating — *"The service account is missing the necessary
     permissions"* — and a new grant can take a few minutes to land.
  3. **A JSON key, uploaded once** — `eas credentials -p android` → Google
     Service Account → *…for Play Store Submissions* → Set up. Interactive only
     (`--non-interactive` refuses). The key lives on EAS; never commit it. The
     `google-play-service-account` container in Secret Manager stays EMPTY on
     purpose — nothing server-side calls the Play API, and two copies of one
     credential can disagree.

  **The same key is what FCM V1 needs for Android push**, which is parked. It
  goes in the SEPARATE *…for FCM V1* slot, and it must be the `linyup-prod` key:
  the app resolves one android package for every profile (from `APP_VARIANT`,
  not the Firebase env), so EAS has one credentials slot — push will work on
  store builds and not on preview builds. The whole store path — both consoles,
  the credentials, and the 14-day Play closed-testing clock that gated going
  public (passed 2026-09-19) — is `docs/mobile-store-setup.md`.
- `FIREBASE_API_KEY` — **both** `eas.json`'s `env` block per profile **and**
  an EAS environment variable per environment. Not redundancy: the `env`
  block is the only thing in scope when `eas build` evaluates app.config.js
  LOCALLY (eas-cli sets `EXPO_NO_DOTENV=1` there), while the EAS environment
  variable is what the builder gets and what `eas update --environment`
  resolves for the OTA path. `development` and `preview` carry the staging key
  in both. The `store` profile carries the PROD key and
  `FIREBASE_PROJECT_ID=linyup-prod`; the release lane refuses a `mobile-v*` tag
  while that id is anything else. The `production` EAS environment carries BOTH
  `FIREBASE_API_KEY` and `FIREBASE_PROJECT_ID` — the id was added 2026-09-10
  because `app.config.js` falls back to `linyup-staging` when it is absent, so an
  OTA resolved with only the key would have published a STAGING-pointed bundle to
  the production channel. The build path was never exposed: it reads eas.json.
  Write the literal value —
  `"${FIREBASE_API_KEY}"` is not interpolated and gets baked in as that string.
- **Apple ASC API key and the Play service-account key: both on EAS**
  (`credentialsSource: remote`). The Play key was the last to land, on
  2026-09-16 — see "Uploading to Play" above. The FCM V1 slot is still empty.

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
