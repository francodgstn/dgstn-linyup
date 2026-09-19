#!/usr/bin/env node
// scripts/bootstrap.mjs — the ONE bootstrap for a checkout: a fresh clone, a
// second git worktree, a Codespace, a cloud agent session. Idempotent: it never
// overwrites a file that exists, and a second run on a ready checkout does
// nothing but print that it did nothing.
//
//   pnpm install
//   pnpm bootstrap              # (named `bootstrap` because `pnpm setup` is a
//                               #  pnpm BUILT-IN that installs pnpm itself)
//
// What it does, in order:
//   1. env files — copies each app's committed *.example template into place
//      when the real (gitignored) file is missing. The templates are EMULATOR-
//      first: a fresh checkout runs against the local stack with no edits. The
//      mobile template targets STAGING (the member app's default target) and
//      needs the real web API key pasted in — the one manual step, printed at
//      the end.
//   2. builds packages/shared and packages/functions — but only when `dist/`
//      is missing or older than `src/` (scripts/lib/distState.mjs), so the
//      SessionStart hook that runs this on a ready checkout costs nothing.
//      `--force` rebuilds regardless; `--no-build` skips.
//   3. `local-env init`, ONCE — claims a port slot for this checkout and, for
//      a worktree, imports the untracked env/secret/lead files from the main
//      checkout. Skipped when `.local-env.json` already exists.
//   4. in a worktree, reports lead data that has drifted from the main
//      checkout's since that import (scripts/lib/leadData.mjs). Reports only:
//      refreshing it is `local-env init --refresh-leads`, on purpose.
//   5. prints what to run next.
//
// It deliberately does NOT start anything, seed anything, or touch the cloud.
//
// `--quiet` is the hook mode (.claude/settings.json → SessionStart): one line
// per action actually taken, nothing when there is nothing to do, and a missing
// `pnpm install` is reported rather than fatal.
import { existsSync, copyFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BUILT_PACKAGES, distState } from './lib/distState.mjs'
import { describeLeadDrift, leadDrift, mainCheckout } from './lib/leadData.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))
const QUIET = flags.has('--quiet')
const FORCE = flags.has('--force')
const NO_BUILD = flags.has('--no-build')

const say = (m) => console.log(`[bootstrap] ${m}`)
const detail = (m) => {
  if (!QUIET) say(m)
}
const run = (cmd) => {
  say(`$ ${cmd}`)
  execSync(cmd, { cwd: ROOT, stdio: QUIET ? ['ignore', 'ignore', 'inherit'] : 'inherit' })
}

// ── owner of the env-file list ───────────────────────────────────────────────
// A new app or a new env file is added HERE and nowhere else; local-env's
// worktree IMPORTS table names the same real files.
export const ENV_FILES = [
  { target: 'apps/web/.env.local', template: 'apps/web/.env.local.example' },
  { target: 'apps/admin/.env.local', template: 'apps/admin/.env.local.example' },
  { target: 'packages/functions/.env.local', template: 'packages/functions/.env.local.example' },
  { target: 'apps/landing/.env', template: 'apps/landing/.env.example' },
  // `pnpm dev:mobile` loads .env.staging; the emulator target needs no file.
  { target: 'apps/mobile/.env.staging', template: 'apps/mobile/.env.example', manual: 'FIREBASE_API_KEY' },
]

// 0. prerequisites
if (!existsSync(join(ROOT, 'node_modules', '.bin', 'tsc'))) {
  say('node_modules is missing — run `pnpm install` first, then `pnpm bootstrap`.')
  process.exit(QUIET ? 0 : 1)
}

// 1. env files
const needsManual = []
for (const { target, template, manual } of ENV_FILES) {
  const t = join(ROOT, target)
  const src = join(ROOT, template)
  if (existsSync(t)) {
    detail(`keep    ${target}`)
    if (manual && new RegExp(`^${manual}=\\s*$`, 'm').test(readFileSync(t, 'utf8'))) needsManual.push({ target, manual })
    continue
  }
  if (!existsSync(src)) {
    say(`MISSING template ${template} — nothing written for ${target}`)
    continue
  }
  mkdirSync(dirname(t), { recursive: true })
  copyFileSync(src, t)
  say(`created ${target}  (from ${template})`)
  if (manual) needsManual.push({ target, manual })
}

// In a browser-based Codespace the emulators are not on localhost: the web app
// proxies them through its own origin (apps/web/next.config.ts rewrites) and
// needs the forwarded-host pieces to build the URLs.
if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
  const webEnv = join(ROOT, 'apps/web/.env.local')
  if (existsSync(webEnv) && !/^NEXT_PUBLIC_CODESPACE_NAME=/m.test(readFileSync(webEnv, 'utf8'))) {
    appendFileSync(
      webEnv,
      `\n# Codespaces port-forwarding (written by scripts/bootstrap.mjs)\n` +
        `NEXT_PUBLIC_CODESPACE_NAME=${process.env.CODESPACE_NAME}\n` +
        `NEXT_PUBLIC_CODESPACE_DOMAIN=${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}\n`
    )
    say('patched apps/web/.env.local  (Codespaces mode)')
  }
}

// 2. build what every dev path reads from disk
if (!NO_BUILD) {
  for (const pkg of BUILT_PACKAGES) {
    const { state } = distState(ROOT, pkg)
    if (state === 'fresh' && !FORCE) {
      detail(`fresh   ${pkg.dir}/dist`)
      continue
    }
    say(`${state === 'missing' ? 'missing' : state === 'stale' ? 'stale  ' : 'force  '} ${pkg.dir}/dist — building`)
    run(`pnpm --filter ${pkg.name} build`)
  }
}

// 3. port slot + worktree imports, once
const initNow = !existsSync(join(ROOT, '.local-env.json'))
if (initNow) {
  run('node scripts/local-env.mjs init')
} else {
  detail('slot    claimed (.local-env.json present)')
}

// 4. lead data. The import above runs once per worktree, and the main
// checkout's copy keeps changing after it — so say so at the start of every
// session, not when a lead typecheck or seed goes wrong. Never fixed here: this
// copy may hold a deliberate edit. A visible `init` has just printed the same
// report itself; a quiet one printed nothing.
if (!initNow || QUIET) {
  try {
    const drift = leadDrift(mainCheckout(ROOT), ROOT)
    if (drift.length) {
      const { heading, rows, fix } = describeLeadDrift(drift)
      say(`LEADS   ${heading}`)
      for (const row of rows) say(`          ${row}`)
      if (fix) say(`        ${fix}`)
    }
  } catch (e) {
    say(`LEADS   could not compare with the main checkout's lead data: ${e?.message || e}`)
  }
}

// 5. next steps
for (const { target, manual } of needsManual) {
  say(`TODO    ${target}: set ${manual} (the ${target.includes('mobile') ? 'staging web app key, Firebase console → project settings' : 'value'})`)
}
if (!QUIET) {
  console.log(`
[bootstrap] done. Next:
  node scripts/local-env.mjs status   # what is already running on this machine (ALWAYS first)
  pnpm emulators:seed                 # local stack + demo logins (studio@/coach@/org@linyup.com, linyup123)
  pnpm dev:web                        # :3000        pnpm dev:admin  # :3002
  pnpm dev:mobile:emulators           # Expo against the local stack (Metro :8081)
  pnpm dev:mobile                     # Expo against STAGING (needs the key above)

Priced doors (shop, drop-in, paid appointments) additionally need Stripe test
keys in packages/functions/.env.local and \`pnpm stripe:listen\`.
`)
}
