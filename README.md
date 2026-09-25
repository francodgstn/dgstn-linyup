# Linyup

Studio management for coaches, clubs and multi-club organizations: sessions,
contacts, bookings, memberships, payments, a public site per studio and a member
app. A pnpm + Turborepo monorepo; Node 22.

| Package              | What                                                                | Runs on                              |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| `apps/web`           | studio dashboard + every public tenant surface (`/public/{slug}/…`) | Next.js 15, Firebase App Hosting     |
| `apps/admin`         | operator console                                                    | Next.js, App Hosting                 |
| `apps/landing`       | marketing site                                                      | Astro                                |
| `apps/mobile`        | member app "Linyup"                                                 | Expo 54 / EAS                        |
| `packages/functions` | backend — Cloud Functions v2                                        | Firebase, `europe-west6`             |
| `packages/shared`    | types, Firestore paths, the shared resolvers                        | built to `dist/`, read by everything |
| `infra/`             | Terraform for the GCP/Firebase projects                             | —                                    |
| `scripts/`           | seeders, backfills, migrations, the local-stack control surface     | —                                    |

`CLAUDE.md` is the project's working knowledge — architecture decisions, the
invariants each area relies on, and where each feature is documented under
`docs/`. Read it before changing anything.

## Quickstart

```bash
pnpm install
pnpm bootstrap                       # env files from templates, shared + functions built, a port slot
node scripts/local-env.mjs status    # ALWAYS before starting anything: what is already running here

pnpm emulators:seed                  # terminal 1 — Firebase emulators + demo studios (wipes first)
pnpm dev:web                         # terminal 2 — http://localhost:3000
pnpm dev:admin                       # operator console, :3002
pnpm dev:mobile:emulators            # Expo against the local stack
pnpm dev:mobile                      # Expo against STAGING (needs FIREBASE_API_KEY in apps/mobile/.env.staging)
```

Demo logins after a seed: `studio@` / `coach@` / `org@linyup.com`, password
`linyup123` (the seed prints the full table). Java is required for the
Firestore emulator.

`pnpm bootstrap` is idempotent and runs again at the start of every Claude
Code session (`.claude/settings.json`), so a fresh clone, a second git
worktree, a Codespace and a cloud agent session all start the same way. It
never starts, seeds or deploys anything. Several checkouts on one machine each
get their own port slot — `.claude/skills/local-env/SKILL.md` owns that model
and its traps.

## Checks

```bash
pnpm typecheck · pnpm lint · pnpm test · pnpm build · pnpm i18n:check
pnpm --filter @linyup/functions test:rules      # Firestore rules suite (emulator)
```

CI: `.github/workflows/verify.yml` on every PR; `deploy.yml` releases the
backend + web on `v*` tags; `mobile.yml` releases the member app on
`mobile-v*` tags (`.claude/skills/mobile-release/SKILL.md`).

## Environments

|                          | Firebase project              | Web                        |
| ------------------------ | ----------------------------- | -------------------------- |
| local                    | `demo-linyup` (emulator only) | http://localhost:3000      |
| staging                  | `linyup-staging`              | https://app-stg.linyup.com |
| sandbox (prospect demos) | `linyup-sandbox`              | https://demo.linyup.com    |
| production               | `linyup-prod`                 | https://app.linyup.com     |

Anything touching a deployed environment goes through `.claude/agents/ops-agent`
and `infra/README.md`.
