#!/usr/bin/env node
/**
 * Merges per-lane message fragments into the four locale files.
 *
 * WHY THIS EXISTS. `apps/web/messages/{en,de,fr,it}.json` is the single busiest
 * contention point in the repo — six of the last twenty commits touched all four —
 * and it is the reason UI work has been serialised to one agent at a time. The
 * race is at FILE level, not key level: an agent reads the whole file, edits, and
 * writes it back, so two agents adding keys to completely different namespaces
 * still lose one another's work. Locking keys would not have helped.
 *
 * So each lane writes its own fragment and never opens a locale file:
 *
 *   apps/web/messages/_pending/<lane>.json
 *   {
 *     "PublicBooking": {
 *       "signedUpOnlyLine": {
 *         "en": "Members only — signing up is free",
 *         "de": "Nur für Mitglieder — die Registrierung ist kostenlos",
 *         "fr": "…", "it": "…"
 *       }
 *     }
 *   }
 *
 * THE FOUR TRANSLATIONS OF ONE KEY LIVE TOGETHER, deliberately. A translation is
 * one unit of work; splitting a key across four fragment files is how locales
 * drift, which is the failure this whole scheme exists to prevent. A leaf is
 * recognised BY that shape — an object whose keys are locale codes — so
 * namespaces may nest to any depth.
 *
 * Usage:
 *   pnpm i18n:merge              apply every fragment, then delete it
 *   pnpm i18n:merge --dry-run    report what would change, write nothing
 *   pnpm i18n:merge --keep       apply but leave the fragments in place
 *   pnpm i18n:merge --force      allow overwriting an existing key (see below)
 *
 * It REFUSES rather than guesses, in three cases:
 *   1. A leaf missing a locale — the drift this is meant to stop.
 *   2. Two lanes defining the same key differently — neither lane can be
 *      preferred without knowing which shipped last, and silently picking one
 *      is how a lane's copy vanishes with no diff to notice.
 *   3. A key that already exists with different text — that is either a lane
 *      stomping shipped copy or a stale fragment, and both want a human.
 *      Identical text is a no-op, so re-running is safe. "Identical" means all
 *      FOUR locales: comparing English alone made a translation-only fix
 *      unexpressible, since it was skipped as a re-run before --force could
 *      apply.
 */

import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { LOCALES, placeholderProblems } from './lib/icuMessages.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MESSAGES = join(ROOT, 'apps/web/messages')
const PENDING = join(MESSAGES, '_pending')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const keep = args.includes('--keep')
const force = args.includes('--force')

const errors = []
const fail = (msg) => errors.push(msg)

/** A leaf is an object whose keys are locale codes and whose values are strings. */
function isLeaf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  const keys = Object.keys(node)
  return keys.length > 0 && keys.every((k) => LOCALES.includes(k))
}

function walk(node, path, visit) {
  for (const [key, value] of Object.entries(node)) {
    const next = [...path, key]
    if (isLeaf(value)) visit(next, value)
    else if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, next, visit)
    else fail(`${next.join('.')} is a bare ${typeof value} — a fragment leaf must carry all four locales`)
  }
}

if (!existsSync(PENDING)) {
  console.log(`No ${PENDING} directory — nothing to merge.`)
  process.exit(0)
}

const fragmentFiles = readdirSync(PENDING).filter((f) => f.endsWith('.json'))
if (fragmentFiles.length === 0) {
  console.log('No fragments pending.')
  process.exit(0)
}

// ── Collect every leaf, remembering which lane claimed it ────────────────────
/** @type {Map<string, {value: Record<string,string>, lane: string}>} */
const claimed = new Map()

for (const file of fragmentFiles) {
  const lane = basename(file, '.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(PENDING, file), 'utf8'))
  } catch (err) {
    fail(`${file} is not valid JSON: ${err.message}`)
    continue
  }
  walk(parsed, [], (path, leaf) => {
    const dotted = path.join('.')
    const missing = LOCALES.filter((l) => typeof leaf[l] !== 'string' || leaf[l].trim() === '')
    if (missing.length) {
      fail(`${lane}: ${dotted} is missing ${missing.join(', ')} — every key ships in all four locales`)
      return
    }
    // A placeholder dropped in translation is a runtime error in next-intl, not
    // a cosmetic slip, and it surfaces only in the locale nobody tests in. The
    // comparison lives in ./lib/icuMessages.mjs so this and `i18n:check` cannot
    // drift — an earlier draft inlined a cruder regex here and it flagged every
    // ICU plural in the file.
    for (const l of LOCALES.slice(1)) {
      const problem = placeholderProblems(dotted, leaf.en, leaf[l], l)
      if (problem) fail(`${lane}: ${problem}`)
    }
    const prior = claimed.get(dotted)
    if (prior && JSON.stringify(prior.value) !== JSON.stringify(leaf)) {
      fail(
        `${dotted} claimed by BOTH ${prior.lane} and ${lane} with different copy — ` +
          `resolve by hand, do not let one win silently`
      )
      return
    }
    claimed.set(dotted, { value: leaf, lane })
  })
}

// ── Apply against the live files ─────────────────────────────────────────────
const files = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(MESSAGES, `${l}.json`), 'utf8'))])
)

const added = []
const skipped = []

for (const [dotted, { value, lane }] of claimed) {
  const path = dotted.split('.')
  const read = (locale) =>
    path.reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), files[locale])
  const existingEn = read('en')
  if (typeof existingEn === 'string') {
    // COMPARED ACROSS ALL FOUR, not just English.
    //
    // This used to short-circuit on `existingEn === value.en`, which made a
    // TRANSLATION-ONLY fix unexpressible: a fragment correcting the Italian of
    // a key whose English is already right was reported as an "idempotent
    // re-run" and silently dropped — before `--force` was ever consulted, so
    // even asking for it did nothing. The lane's only way through was to edit
    // the locale file by hand, which is the one thing this scheme exists to
    // stop. Found fixing `{count} selezionato/i` (2026-09-09).
    const differing = LOCALES.filter((l) => read(l) !== value[l])
    if (differing.length === 0) {
      skipped.push(dotted) // idempotent re-run
      continue
    }
    if (!force) {
      // Name the locales AND show English, because the two cases want
      // different judgements: changed English is a lane stomping shipped copy,
      // while changed translations alone is usually a correction.
      const detail = differing.includes('en')
        ? `"${existingEn}" vs "${value.en}"`
        : `English unchanged; differs in ${differing.join(', ')}`
      fail(
        `${lane}: ${dotted} already exists with different copy — ${detail}. ` +
          `Re-run with --force only if you mean to replace it.`
      )
      continue
    }
  }
  for (const l of LOCALES) {
    let node = files[l]
    for (const key of path.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
      node = node[key]
    }
    node[path.at(-1)] = value[l]
  }
  added.push(dotted)
}

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem${errors.length === 1 ? '' : 's'} — nothing written:\n`)
  for (const e of errors) console.error(`  • ${e}`)
  console.error('')
  process.exit(1)
}

if (dryRun) {
  console.log(`Would add ${added.length} key(s) from ${fragmentFiles.length} fragment(s):`)
  for (const k of added) console.log(`  + ${k}`)
  if (skipped.length) console.log(`  (${skipped.length} already present and identical)`)
  process.exit(0)
}

for (const l of LOCALES) {
  writeFileSync(join(MESSAGES, `${l}.json`), JSON.stringify(files[l], null, 2) + '\n', 'utf8')
}

if (!keep) for (const f of fragmentFiles) rmSync(join(PENDING, f))

console.log(`✓ merged ${added.length} key(s) into all four locales from ${fragmentFiles.length} fragment(s)`)
for (const k of added) console.log(`  + ${k}`)
if (skipped.length) console.log(`  (${skipped.length} already present, unchanged)`)
if (!keep && fragmentFiles.length) console.log(`  consumed: ${fragmentFiles.join(', ')}`)
