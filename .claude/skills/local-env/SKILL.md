---
name: local-env
description: Own the LOCAL Linyup stack on this machine — Firebase emulators, web/admin/landing dev servers, seed data. Use whenever the user asks to start, check, stop, kill, restart or reset the local environment, and BEFORE any local verification (clicking through the app, screenshots, persona tests, reproducing a bug) so you know what is already running and whether it is serving your code. Handles several git worktrees running side by side on separate port slots, and bootstraps a fresh worktree from the untracked env/secret/lead files that only the main checkout has. Local only — deployed environments belong to ops-agent.
---

# Local environment

`node scripts/local-env.mjs` is the control surface (`pnpm local <cmd>` is the
same thing). Everything below explains what it reports and what to do about it.

```
status [--json]                      what is running, in which slot, owned by which checkout
init [--slot N] [--no-copy]          claim a slot; import the main checkout's untracked
                                     env / lead / key files; generate firebase.local.json;
                                     point this checkout's apps at its own ports
env [--slot N] [--shell bash|pwsh]   emulator-host exports, for running a script against a slot
stop [--slot N|--all] [--yes]        graceful shutdown
kill [--slot N|--all] [--yes]        forced, plus orphaned listeners
reset [--slot N] --yes [--force]     wipe + reseed a RUNNING slot
```

## Rule zero — `status` before you start anything

Never launch an emulator or a dev server without running `status` first, and
never trust a local observation you made without one.

The reason is that both ways of getting this wrong are **silent**. A second
emulator suite cannot bind `:8080`, so `pnpm emulators:seed` fails to start its
own emulator but **still runs the seed step** — which wipes Firestore and Auth
on whoever *is* listening, prints a clean `✅ Ready`, and destroys another
session's data (and its `--export-on-exit` snapshot when that emulator stops).
And the functions emulator serves `packages/functions/dist` **from the checkout
that started it, without ever reloading it** — so a worktree can rebuild all
afternoon and keep watching another branch's code behave, with no error
anywhere.

`status` answers both: which checkout owns each running slot, and whether that
emulator predates the owning checkout's last build (it prints `! STALE` when it
does — restart before believing anything you see through a callable).

## The slot model

One slot per checkout. Slot 0 is the main checkout on the documented default
ports; slot N adds `N × 10000` to every port.

| | slot 0 (main) | slot 1 | slot 2 | slot 3 |
|---|---|---|---|---|
| web | 3000 | 13000 | 23000 | 33000 |
| admin | 3002 | 13002 | 23002 | 33002 |
| emulator UI | 4000 | 14000 | 24000 | 34000 |
| functions | 5001 | 15001 | 25001 | 35001 |
| firestore | 8080 | 18080 | 28080 | 38080 |
| metro (Expo) | 8081 | 18081 | 28081 | 38081 |
| auth | 9099 | 19099 | 29099 | 39099 |
| storage | 9199 | 19199 | 29199 | 39199 |

Also offset, and easy to forget because `firebase.json` never names them: the
emulator **hub** (4400), **logging** (4500) and the Firestore **UI websocket**
(9150). The CLI binds all three, and a port it took from a config never
auto-shifts — an undeclared hub is a hard collision with slot 0. `init`
generates them; the older tracked `firebase.worktree.json` does not, which is
why that file is a fallback rather than the recommended path.

There is no slot 4: it would put auth on `:49099`, inside Windows' dynamic port
range, and a stack that works until the day the OS happened to take the port
first is worse than one slot fewer.

## A fresh checkout: `pnpm bootstrap` (which runs `init`)

A worktree is a clean checkout of tracked files, and **everything the local
stack needs to run is untracked**. It is not there, git will not tell you it is
missing, and each absence surfaces as something that looks like a code bug:

| Missing | What it looks like |
|---|---|
| `apps/web/.env.local` | `auth/invalid-api-key`, or the app silently talking to a real project |
| `apps/admin/.env.local` | operator console rejects every login |
| `packages/functions/.env.local` | **every callable returns a bare `internal`** — see below |
| `apps/mobile/.env.staging` | `pnpm dev:mobile` refuses at config time (it names the file) |
| `packages/shared/dist`, `packages/functions/dist` | `X is not a function`, or last week's behaviour — see traps |
| `scripts/leads/.env.local`, `scripts/leads/{lead}/` | `pnpm lead:seed` cannot find the profile |
| `keys/` | `pnpm migrate:hmd` has no source credentials |

```bash
pnpm bootstrap
```

copies every env file from the committed `*.example` beside it (emulator-first;
`scripts/bootstrap.mjs` owns that list), builds shared + functions when their
`dist` is missing or older than `src`, and — once, when `.local-env.json` is
absent — runs `init`, which imports the untracked files only the main checkout
has (`IMPORTS` in `local-env.mjs`: the env files above, the mobile staging key,
lead profiles, `keys/`; never overwriting one that is already there), claims the
lowest free slot, writes `firebase.local.json`, and patches a managed block into
`apps/web/.env.local`, `apps/admin/.env.local` and `apps/mobile/.env.local`
pointing them at this slot. Every generated file is gitignored. The SessionStart
hook in `.claude/settings.json` runs the same bootstrap for every agent session.

To make a worktree talk to the **main checkout's** emulator instead — occasionally
what you want for a read-only look at seeded data — delete the managed block
from the `.env.local` files. Do not do it to save starting a suite: the
functions you would be exercising are the main checkout's build, not yours.

## Starting

Always `status` first. Then, for **slot 0** (the main checkout):

```bash
pnpm emulators:seed
```

and in separate terminals `pnpm dev:web` (:3000), `pnpm dev:admin` (:3002),
`pnpm dev:mobile:emulators` (Metro :8081, Expo against this stack; the app
reads the slot's emulator ports from `apps/mobile/.env.local`).
Datasets are alternatives, not additions — pick one:

| Command | Data | Destructive |
|---|---|---|
| `pnpm emulators:seed` | fresh seed, four plan-tier demo teams | **wipes first** |
| `pnpm emulators:demo` | `snapshots/demo/`, auto-saved on exit | no |
| `pnpm emulators:swimli` | swimli lead rehearsal snapshot | no |
| `pnpm emulators:hmd` | migrated HMD data | no |
| `pnpm emulators:all` | everything — 28 teams | no |

For **slot N ≥ 1**, `init` prints the exact commands. They are:

```bash
node scripts/emulators-run.mjs --config firebase.local.json --only auth,firestore,functions,storage --project demo-linyup
```

then the apps, which need their port passed explicitly (`pnpm dev:web` hardcodes
nothing but defaults to 3000; `dev:admin` hardcodes `--port 3002`):

```bash
PORT=13000 pnpm dev:web                                                    # bash
pnpm --filter @linyup/admin exec next dev --turbopack --port 13002
```

```powershell
$env:PORT=13000; pnpm dev:web                                              # PowerShell
```

and the member app, whose Metro port must move too or Expo prompts
interactively for the next free one: `pnpm dev:mobile:emulators -- --port 18081`.

Then seed it: `node scripts/local-env.mjs reset --slot 1 --yes`.

**Always launch through `scripts/emulators-run.mjs`, never `firebase
emulators:start` directly.** It sets `FUNCTIONS_DISCOVERY_TIMEOUT=120`, without
which the emulator regularly loads **zero** functions on this machine and says
so only in one line of startup noise.

Run these as background processes (`run_in_background`) — they stay up until
stopped.

## Readiness is three checks, not one

"All emulators ready!" is compatible with a completely non-functional stack.

1. `node scripts/local-env.mjs status` — the slot shows `RUNNING`, no `! STALE`
   (neither kind: an emulator older than the functions build, or a `dist`
   older than its `src` in the header), no `! EMPTY`, and the app rows answer
   HTTP.
2. The seed output ends in `✅ Ready` and contains no `Enter a string value`
   line (that is the `defineString` prompt below, firing). Expect it to sit on
   `⏳ Waiting for the functions emulator to work through the trigger queue…`
   for **about ten minutes** before that — see the trap below. A seed run
   without `SEED_FUNCTIONS_EMULATOR_HOST` (a hand-run `tsx`) skips the wait and
   says so; its `✅` then means only that the seed's own writes are done.
3. The functions registry is non-empty — `status` reports `functions N loaded`.
   `! EMPTY` means every callable will answer a bare `internal`, which surfaces
   in the browser as a misleading CORS error on `localhost:5001`.

## Stopping, killing, resetting

```bash
node scripts/local-env.mjs stop                    # this checkout's slot
node scripts/local-env.mjs kill                    # forced, plus orphaned listeners
node scripts/local-env.mjs stop --slot 0 --yes     # someone else's slot — needs --yes
node scripts/local-env.mjs reset --yes             # wipe + reseed a RUNNING slot
```

Both take the emulator supervisor down first (it carries its children with it),
then mop up whatever still holds a port. **Killing the background task alone is
not enough** — it leaves the Firestore JVM and the functions workers behind, and
the next start then fails with "port taken".

**On Windows `stop` usually cannot succeed, and that is not a bug.** `taskkill`
without `/F` asks politely through a window message, which node and java have no
way to receive; `stop` reports `needs kill` in one line and you move on to
`kill`. The only genuinely graceful shutdown is **Ctrl+C in the terminal that
owns the emulator** — which matters exactly once: a slot started with
`--export-on-exit` writes its snapshot in that shutdown hook, so `kill` would
silently leave the snapshot holding whatever it held last time. `kill` refuses
such a slot unless you pass `--force`.

`reset` refuses more than it does, on purpose:

- it needs the slot **already running** (it seeds a live emulator, it does not
  launch one);
- it refuses another checkout's slot outright — reset it from where its code
  lives;
- it refuses a slot started with `--import` / `--export-on-exit` unless
  `--force`, because reseeding wipes the snapshot and the exit then overwrites
  it on disk. **Lead and demo tenants live in those snapshots.**

Before resetting anything, ask whether the data is reproducible. `emulators:seed`
data is; a lead sandbox rehearsal or `snapshots/all` is not.

## Running a script against a slot

Seeders, migrations and one-off probes talk to whatever `*_EMULATOR_HOST` says,
defaulting to slot 0. Point them at your slot:

```bash
eval "$(node scripts/local-env.mjs env --shell bash)"     # bash
node scripts/local-env.mjs env --shell pwsh               # paste into PowerShell
```

## Seeded logins

Password `linyup123` for all of them (the seed prints the table):
`studio@linyup.com` (studio owner — use this for owner-gated features),
`coach@`, `org@`, `free@`, `manager@`, `coach2@linyup.com`.

Member app / web Space (a CONTACT, passwordless): `app.review@example.com`,
code `123456`, on the review studio `linyup-demo` — the same studio production
provisions from the console. Everything else: `docs/test-accounts.md`.

## Traps, with their symptoms

- **Every callable returns `internal`, nothing else is wrong.** The functions
  emulator loaded zero functions. Two causes: discovery timing out (use
  `emulators-run.mjs`), or a `defineString` param absent from
  `packages/functions/.env.local` — the emulator **prompts** for it, even for
  params that have defaults, and in a non-TTY that prompt hangs discovery
  forever. Re-derive the required set rather than trusting a copied list:
  ```bash
  grep -rhoE "define(String|Secret|Int|Bool)\('[A-Z_]+'" packages/functions/src --include='*.ts' | sort -u
  ```
- **A Firestore trigger "never runs" on a freshly seeded slot** (an
  `installed_plugins` status flip, a missing public mirror, a zero counter). It
  is queued, not broken. The Firestore emulator delivers trigger events one at a
  time and a full seed causes ~6,500 of them, so a write made right after the
  seed runs 9–11 minutes later — same on firebase-tools 15.18 and 15.30. The
  log hides it: an event's `time` is when it was DELIVERED, not written. `reset`
  and `emulators:seed` now hold `✅` until the queue drains
  (`scripts/lib/triggerDrain.ts`); set `SEED_FUNCTIONS_EMULATOR_HOST=` (empty)
  to skip that wait and accept the lag.
- **Your change is built but the app behaves like the old code.** The functions
  emulator does not reload `dist`. `status` flags this as `! STALE`. Restart
  the slot; rebuilding alone changes nothing.
- **`resolveSomething is not a function`, or a shared resolver behaving like
  last week.** `@linyup/shared` resolves to its BUILT `dist/`, and nothing
  rebuilds it on its own — `pnpm install` does not, `dev:web` does not, a
  filtered `typecheck` does not. `status` prints `! STALE packages/shared/dist`
  in its header; `pnpm bootstrap` rebuilds exactly what is stale.
- **The app behaves like a branch you are not on.** You are pointed at another
  checkout's slot. `status` names the owner.
- **`pnpm --filter @linyup/web build` fails on a missing `@tiptap/...` module in
  a deep worktree.** Worktree path + pnpm's store path exceeds Windows MAX_PATH;
  Node resolves it, Turbopack does not. Verify through the dev server and let
  CI do the build — this is not a code defect.
- **In a deep worktree, run the web dev server with `--webpack`.** Turbopack
  (the default) cannot resolve `@tiptap/extension-drag-handle-react` when the
  real path runs past ~260 characters, so every page with the rich-text editor
  500s with `Can't resolve …`. Node resolves it and webpack serves the same
  tree fine: `pnpm --filter @linyup/web exec next dev --webpack` (add
  `--port` on slot N). Dev only — CI and the real build are unaffected.
  `docs/ux-review-open-decisions.md` §41 has the investigation.
- **`next dev` rewrites `apps/web/next-env.d.ts`.** Restore it before
  committing: `git checkout -- apps/web/next-env.d.ts`.
- **Emulator start fails with "port taken" right after a stop.** A previous run
  is still tearing down, or left an orphan. `kill`, then `status`, then retry.
- **Java is required** for the Firestore emulator. If VS Code's integrated
  terminal cannot find it, use an external one.
- **The seeder prints `http://localhost:3000/...` portal links unconditionally.**
  On slot N they are wrong — substitute your slot's web port.
- **`stop` reporting `needs kill` is normal on Windows**, not a failure. See
  above.

## Boundaries

- **Deployed environments are not this skill's.** Anything touching
  `linyup-sandbox`, `linyup-staging` or `linyup-prod` — deploys, rules, secrets,
  backfills, Terraform — goes to **`ops-agent`**. This skill never leaves
  `demo-linyup` on localhost.
- **A fresh headless Linux container** (cold `pnpm install`, no Java yet,
  Playwright driving the browser) is `.claude/skills/run-web/SKILL.md`. This
  skill assumes a developed machine with several worktrees on it.
- **`persona-ux-test`** and **`ux-review`** assume the stack is already up; bring
  it up here first, and do **not** reseed for them.
- **`apps/web/e2e`** (Playwright, real browser — not the Browser pane) is the
  same story: it drives an already-up slot rather than starting its own, and
  needs `PLAYWRIGHT_BASE_URL` pointed at your slot if it isn't slot 0. See
  `apps/web/e2e/README.md`.
