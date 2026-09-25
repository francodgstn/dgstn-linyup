#!/usr/bin/env node
/**
 * Which Firebase targets a push to `main` can change on STAGING, as the
 * `--only` list the staging deploy passes to `firebase deploy`.
 *
 *   node scripts/staging-deploy-targets.mjs <base> <head>   # prints e.g. "hosting:landing"
 *   node scripts/staging-deploy-targets.mjs <base> <head> --explain
 *
 * An empty line means nothing this workflow deploys was touched, and the
 * deploy job is skipped.
 *
 * WHY. Every merge ran a full five to seventeen minute deploy, and merges now
 * land minutes apart. Measured over twenty commits on 2026-09-25, seven could
 * not change staging at all (skills, docs, Terraform, mobile, the web app,
 * which App Hosting builds on its own) and four touched only the static
 * landing site. Skipping those is what stops deploys queueing behind each
 * other, which is what was being cancelled by hand.
 *
 * WHAT THIS MUST NEVER DO IS SKIP `verify`. It decides the DEPLOY job only;
 * verify runs on every push regardless, because it is the only thing that
 * ever checks `main` itself. That is why this is a job output and not an
 * `on: push: paths:` filter on the workflow, which would skip verify too.
 * deploy.yml's header records the incident behind the same rule for
 * concurrency.
 *
 * WHEN UNSURE, DEPLOY EVERYTHING. A needless deploy costs minutes; a skipped
 * one leaves staging silently behind `main`, which is the failure nobody
 * notices. So:
 *   - anything that can change what every target builds (firebase.json, the
 *     lockfile, the workspace manifests, this script, the workflow itself)
 *     deploys everything;
 *   - an unknown base (a branch's first push, a force-push that rewrote the
 *     previous tip) deploys everything rather than diffing against a guess.
 *
 * The mapping is by what each target is BUILT FROM, not by what a path is
 * named. `packages/shared` is bundled into functions and nothing else: landing
 * and help declare no @linyup dependency, and Pricing.astro mirrors its plan
 * values on purpose rather than importing them (a functions test keeps the
 * two in step). `hosting:api` is only rewrites to the `api` function, whose
 * code rides in with `functions`.
 */
import { execFileSync } from 'node:child_process'

// The order firebase-tools has always been given, kept so that "everything"
// is byte-identical to the list deploy.yml used before this existed.
const ALL =['functions', 'hosting:landing', 'hosting:help', 'hosting:api', 'firestore', 'storage']

const EVERYTHING = [
  /^firebase\.json$/,
  /^\.firebaserc$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.github\/workflows\/deploy\.yml$/,
  /^scripts\/staging-deploy-targets\.mjs$/,
]

const BUILT_FROM = {
  functions: [/^packages\/functions\//, /^packages\/shared\//, /^scripts\/vendor-shared-for-deploy\.mjs$/],
  'hosting:landing': [/^apps\/landing\//],
  'hosting:help': [/^apps\/help\//],
  'hosting:api': [/^infra\/hosting\/api\//],
  firestore: [/^firestore\.rules$/, /^firestore\.index\.json$/],
  storage: [/^storage\.rules$/],
}

/** The targets `files` can change, in ALL's order. */
function targetsFor(files) {
  if (files.some((f) => EVERYTHING.some((re) => re.test(f)))) return [...ALL]
  return ALL.filter((t) => files.some((f) => BUILT_FROM[t].some((re) => re.test(f))))
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** True when `sha` names a commit this clone actually has. */
function knownCommit(sha) {
  if (!sha || /^0+$/.test(sha)) return false
  try {
    git('cat-file', '-e', `${sha}^{commit}`)
    return true
  } catch {
    return false
  }
}

const [base, head = 'HEAD'] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const explain = process.argv.includes('--explain')

let targets
let why
if (!knownCommit(base)) {
  targets = [...ALL]
  why = `unknown base "${base ?? ''}", deploying everything`
} else {
  const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean)
  targets = targetsFor(files)
  why = `${files.length} file(s) changed`
}

console.log(targets.join(','))
if (explain) console.error(`${why} -> ${targets.length ? targets.join(', ') : 'nothing to deploy'}`)
