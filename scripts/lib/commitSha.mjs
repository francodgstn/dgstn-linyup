/**
 * WHICH COMMIT IS THIS BUILD FROM — resolved once, at build time, for every
 * Next.js app in the monorepo.
 *
 * `/api/health` has always reported the Cloud Run revision
 * (`linyup-web-eu-build-2026-09-08-006`), which names a BUILD but not a COMMIT.
 * On 2026-09-08 a merge appeared not to have reached staging and answering
 * "which code is actually live" took a conversation instead of one GET — the
 * health route's own comment already anticipated this ("Present only if a build
 * ever chooses to stamp it; null is honest").
 *
 * ── WHY IT IS A CHAIN AND NOT ONE LOOKUP ────────────────────────────────────
 *
 * Firebase App Hosting documents NO build-time variable carrying the commit —
 * its reserved set is `FIREBASE_CONFIG` / `FIREBASE_WEBAPP_CONFIG` and the
 * `X_FIREBASE_`/`X_GOOGLE_`/`CLOUD_RUN_` prefixes. And because its builds run on
 * Cloud Build via buildpacks, whether the checkout keeps a `.git` directory, and
 * whether `git` is even on PATH, are not things this repo gets to decide.
 *
 * So it tries the sources in order of trustworthiness and REPORTS WHICH ONE
 * ANSWERED. That last part is the point: the mechanism cannot be verified from a
 * developer machine, so the first deploy verifies it — `commitSource` in the
 * health payload says `env`, `git`, `git-file`, or nothing at all, and nobody has
 * to guess why.
 *
 * NEVER THROWS. A build must not fail because a diagnostic field could not be
 * filled in; an unknown commit is a worse health payload, not a worse deploy.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Walk up from `from` looking for a `.git` (a directory, or a worktree file). */
function findGitDir(from) {
  let dir = resolve(from)
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.git')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * `.git/HEAD` without shelling out — for a build image that has the checkout but
 * no `git` binary, which buildpack images genuinely vary on.
 */
function readHeadFromGitFiles(gitPath) {
  // A worktree's `.git` is a FILE pointing at the real directory.
  let gitDir = gitPath
  const stat = readFileSync
  if (!existsSync(join(gitPath, 'HEAD'))) {
    const pointer = stat(gitPath, 'utf8').trim()
    const m = /^gitdir:\s*(.+)$/.exec(pointer)
    if (!m) return null
    gitDir = resolve(dirname(gitPath), m[1])
  }
  const head = stat(join(gitDir, 'HEAD'), 'utf8').trim()
  // Detached HEAD: the file IS the sha.
  if (/^[0-9a-f]{40}$/i.test(head)) return head
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]
  if (!ref) return null
  const looseRef = join(gitDir, ref)
  if (existsSync(looseRef)) return stat(looseRef, 'utf8').trim()
  // A freshly cloned checkout keeps its refs packed.
  const packed = join(gitDir, 'packed-refs')
  if (!existsSync(packed)) return null
  for (const line of stat(packed, 'utf8').split('\n')) {
    const [sha, name] = line.trim().split(/\s+/)
    if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return sha
  }
  return null
}

/**
 * @param {string} [cwd] where to start looking for the checkout
 * @returns {{ sha: string | null, source: 'env' | 'git' | 'git-file' | null }}
 */
export function resolveCommitSha(cwd = process.cwd()) {
  // 1. STATED OUTRIGHT — CI, apphosting.yaml, or a local .env. Wins over any
  //    derivation: if somebody went to the trouble of saying it, they mean it.
  const given =
    process.env.NEXT_PUBLIC_COMMIT_SHA || process.env.COMMIT_SHA || process.env.GITHUB_SHA
  if (given && given.trim()) return { sha: given.trim().slice(0, 40), source: 'env' }

  // 2. THE CHECKOUT, via git.
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5_000,
    }).trim()
    if (/^[0-9a-f]{40}$/i.test(out)) return { sha: out, source: 'git' }
  } catch {
    // No git binary, no checkout, or a shallow/odd clone. Try the files.
  }

  // 3. THE CHECKOUT, by hand.
  try {
    const gitPath = findGitDir(cwd)
    if (gitPath) {
      const sha = readHeadFromGitFiles(gitPath)
      if (sha && /^[0-9a-f]{40}$/i.test(sha)) return { sha, source: 'git-file' }
    }
  } catch {
    // Fall through to unknown.
  }

  return { sha: null, source: null }
}

/**
 * The two `NEXT_PUBLIC_*` values to hand Next's `env` config, ready to spread.
 * Keys are OMITTED rather than set to undefined — Next warns on an undefined
 * value and an absent key reads as null at the other end, which is the honest
 * answer for a build that could not tell.
 */
export function commitEnv(cwd = process.cwd()) {
  const { sha, source } = resolveCommitSha(cwd)
  return {
    ...(sha ? { NEXT_PUBLIC_COMMIT_SHA: sha } : {}),
    ...(source ? { NEXT_PUBLIC_COMMIT_SOURCE: source } : {}),
  }
}
