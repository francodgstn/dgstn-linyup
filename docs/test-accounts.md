---
title: "Test accounts — every environment, web and member app"
status: living
area: ops
---
# Test accounts — every environment, web and member app

The one page that says who can sign in where, so nobody re-derives a login
from a seeder's source. Two kinds of person exist in Linyup and they sign in
differently:

| Persona                                      | Signs in with                                                | Where                                                           |
| -------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| **Staff** (owner, manager, coach, org admin) | Firebase Auth email + password                               | `apps/web` dashboard, `apps/admin` console (operators only)     |
| **Contact** (member, parent, prospect)       | Passwordless six-digit code → contact session (custom token) | `apps/mobile`, the web Space (`/public/{slug}/space`), the Shop |

A contact never has a Firebase Auth user of its own: `loginContactWithCode`
mints a session on demand after the code is verified (the seeders no longer
create `contact:{teamId}:{contactId}` password users — those were a fossil of
a deleted minter with no consumer).

## The member app's test login is the review studio — everywhere

Production provisions a demo studio for app-store review from the operator
console (`Settings → Demo tenant`: `manageDemoTenant` → `provisionDemoTenant`,
`packages/functions/src/ops/demoTenant.ts`). Every seeded environment now runs
**the same provisioner** (`scripts/lib/mobile.ts`), so the studio a reviewer
meets in production is the one every developer and every Maestro run signs
into:

|         | Value                                                                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio  | `linyup-demo` — "Linyup Demo Studio", `/public/linyup-demo`, plan `studio`, `flags.internal`                                                                                                                                                        |
| Contact | `app.review@example.com` (Alex Reviewer, id `linyup-demo-reviewer`)                                                                                                                                                                                 |
| Code    | **`123456`** on the emulator, staging and the sandbox (`REVIEW_ACCESS_CODE` overrides at seed time). Production: whatever the operator typed into the console for the review window.                                                                |
| Window  | `app_settings/review_access.expires_at` — the maximum the callable allows (60 days) from the seed. The sandbox reseeds nightly and never lapses; staging is seeded by hand and **will** — re-run `pnpm staging:seed` or re-enable from the console. |

The code is never mailed (`sendContactVerificationCode` logs `[review-otp]`
instead) and bypasses the per-email rate limit. Since 2026-09-04 it applies to
a LIST of addresses rather than one — the reviewer plus `tester01@example.com` …
`tester20@example.com`, twenty synthetic contacts the provisioner creates so
closed-test testers never have to share the account the store reviewer depends
on. The list is operable from `Settings → Demo tenant`, and an address may only
be listed if a contact with that email already exists in the demo tenant, which
is what keeps a fixed code off a real mailbox.

**The closed test uses ONE shared login** (2026-09-04): the tester service takes
a single demo credential, so all of its testers sign in as
`tester01@example.com` / `123456`. Deliberately NOT the reviewer's address —
sharing that one would put the account Google's reviewer needs in 103 people's
hands. What sharing costs is only cosmetic: one booking per session, one score,
one radar. What it cannot cost is the login itself — the contact self-write rule
admits only `weight` / `last_seen_at` / `mobile_app`, so no tester can rename the
contact or change its email, and `requestContactDeletion` merely schedules 30
days out while the account keeps working.

It is a deliberate auth bypass whose guards are its design —
`packages/functions/src/ops/reviewAccess.ts` — and the committed default is
acceptable only because it opens a synthetic contact on an internal, silent,
payment-less studio in environments whose owner passwords are already
committed. **Production is never seeded by a script.**

Other contacts on the emulator: request a code for any seeded contact email
(`{first}.{last}.{teamId}@example.com`); with `MAIL_ENABLED=false` nothing is
sent, and the code is visible in the functions emulator log line
`Verification code sent to …` and in the Emulator UI under
`verification_codes`. On staging, `TEST_MODE=true` routes every OTP to the
owner's inbox. On the sandbox the system stream is dropped, so use the review
login.

## Staff logins

Password `linyup123` everywhere a seeder runs. Production has no seeded
staff.

| Environment                        | Logins                                                                           | Seeded by                                                |
| ---------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Emulator (`demo-linyup`)           | `free@`, `coach@` (trial), `studio@` (+ `manager@`, `coach2@`), `org@linyup.com` | `pnpm emulators:seed` (`scripts/seed-emulator.ts`)       |
| Staging (`linyup-staging`)         | `coach@`, `studio@`, `org@linyup.com` + named staff `@…example.com`              | `pnpm staging:seed`                                      |
| Sandbox (`linyup-sandbox`, `/try`) | `{sector}@linyup.com` per demo team, `{sector}-manager@linyup.com`               | nightly `reseed-sandbox.yml`, `pnpm sandbox:seed`        |
| Lead tenants (sandbox)             | per lead profile, gitignored                                                     | `pnpm lead:seed --lead <id>` (`scripts/leads/README.md`) |

Operator console access is the `OPERATOR_EMAILS` allowlist (mirrored in
`packages/functions/.env.<alias>`), not a seeded account.

## The member app against each environment

| Target            | Command                                                                                              | Notes                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Emulator          | `pnpm dev:mobile:emulators`                                                                          | ports from this checkout's slot (`local-env`); Metro :8081                                     |
| Staging (default) | `pnpm dev:mobile`                                                                                    | needs the staging web API key in `apps/mobile/.env.staging` (`pnpm bootstrap` writes the file) |
| Sandbox           | `FIREBASE_PROJECT_ID=linyup-sandbox FIREBASE_API_KEY=… pnpm --filter @linyup/mobile exec expo start` | rarely wanted — prospect demos live here                                                       |
| Production        | a `store` build only                                                                                 | never a dev client                                                                             |

A studio's plan must include `member_app` (Coach and above, active or
trialing) or the app refuses the sign-in by name and points at the web Space;
`linyup-demo` is `studio`, so it always qualifies.

## Automated checks on the login chain

- `packages/functions/src/auth/loginChain.test.ts` — the pure decisions behind
  the three callables (candidate selection incl. `login_emails`, the
  anonymous-response projection, the shared "may this email sign in as this
  contact" predicate) plus source assertions that the callables use them.
- `packages/functions/src/ops/reviewAccess.test.ts` — every way the fixed code
  stays shut.
- `packages/functions/src/ops/appSettings.rules-test.ts` — `app_settings/mobile`
  is world-readable, `review_access` is denied to everyone.
- `apps/mobile/.maestro/login.yaml` — the device smoke flow (sign in with the
  review login, land on the profile): `pnpm --filter @linyup/mobile test:e2e`
  with the Maestro CLI and a build on a device or simulator. Not in CI (a
  device lane needs a Maestro Cloud account — owner's call).

## Retiring an old build

`Settings → Member app` in the operator console writes
`app_settings/mobile.min_supported_version`; builds older than it open on an
update-required screen with the store links. The app fails OPEN on a malformed
value, which is why the console validates it. Raise it only when an old build
can no longer follow the backend — an OTA update reaches every build on the
same native fingerprint without it (`.claude/skills/mobile-release/SKILL.md`).
