// scripts/lib/leadData.mjs — does this checkout's copy of the lead data still
// match the main checkout's?
//
// Lead data is one `scripts/leads/{lead}/` folder per lead (profile + assets)
// plus `scripts/leads/.env.local` beside them (the per-lead password pins and
// Stripe test accounts). All of it is gitignored — prospective-customer data
// never lands in the repo — so the main checkout holds the only authoritative
// copy, and a worktree runs on the copy `local-env init` took when it was
// bootstrapped. Nothing refreshes that copy on its own, and a stale one never
// says so: `pnpm typecheck:seeds` fails in that worktree only (its profile
// still spells a shape a later PR removed), `pnpm lead:seed` seeds an
// out-of-date offering onto a live prospect sandbox, and a missing
// `LEAD_DEMO_PASSWORD_*` pin rotates that lead's login.
//
// So `pnpm bootstrap` (the SessionStart hook) and `local-env status` / `init`
// report the drift from here, and `local-env init --refresh-leads` is what
// copies over a file that already exists — never by default, because a
// worktree's copy may hold a deliberate edit, and an ignored file has no
// history to get one back from.
//
// "Edited here" is read from mtimes, which is a hint rather than proof: among
// files that differ, the newer side is the one written last. The blanket
// refresh keeps a file that is newer here; naming its lead
// (`--refresh-leads nicole`) is how a local edit is discarded on purpose.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export const LEADS_DIR = 'scripts/leads'

// Every lead folder is ignored by scripts/leads/.gitignore, and this file by the
// root `*.local` rule. Every other file in scripts/leads is tracked, so git
// already keeps it in step.
const ENV_FILE = '.env.local'

const samePath = (a, b) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)

/** The main checkout (git lists it first), or null outside a git checkout. */
export function mainCheckout(cwd) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = out.match(/^worktree (.+)$/m)
    return m ? resolve(m[1].trim()) : null
  } catch {
    return null
  }
}

/** name -> 'dir' | 'file' for the lead data in one checkout. */
function leadEntries(checkout) {
  const out = new Map()
  const dir = join(checkout, LEADS_DIR)
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.set(e.name, 'dir')
    else if (e.isFile() && e.name === ENV_FILE) out.set(e.name, 'file')
  }
  return out
}

/** Every file under `base/rel`, as a `/`-separated path relative to `base`. */
function filesUnder(base, rel) {
  const out = []
  for (const e of readdirSync(join(base, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...filesUnder(base, child))
    else if (e.isFile()) out.push(child)
  }
  return out
}

/**
 * null when both hold the same bytes, else which side was written last. Sizes
 * first, then the rsync quick check — a copy keeps its source's mtime, so the
 * same size at the same mtime is the same file without reading either (within
 * a millisecond: a copy's timestamp can lose the sub-millisecond part) — and
 * only then the bytes.
 */
function compareFile(theirs, mine) {
  const a = statSync(theirs)
  const b = statSync(mine)
  if (
    a.size === b.size &&
    (Math.abs(a.mtimeMs - b.mtimeMs) < 1 || readFileSync(theirs).equals(readFileSync(mine)))
  ) {
    return null
  }
  return b.mtimeMs > a.mtimeMs ? 'newer' : 'older'
}

/** KEY -> value, read the way seed-lead.ts's loadLeadEnv reads the file. */
function envKeys(file) {
  const keys = new Map()
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq > 0) keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return keys
}

/** Which keys differ — NAMES only: the values are live credentials. */
function envKeyDiff(theirs, mine) {
  const a = envKeys(theirs)
  const b = envKeys(mine)
  const missing = [...a.keys()].filter((k) => !b.has(k))
  const extra = [...b.keys()].filter((k) => !a.has(k))
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k))
  const parts = []
  if (missing.length) parts.push(`missing here: ${missing.join(', ')}`)
  if (extra.length) parts.push(`only here: ${extra.join(', ')}`)
  if (changed.length) parts.push(`different value: ${changed.join(', ')}`)
  return parts.join('; ') || 'comments or spacing only'
}

/**
 * Every lead entry — a lead folder, or `.env.local` — whose copy in `here`
 * differs from the one in `main`, sorted by name; empty when they match, and
 * always empty for the main checkout itself. Each is
 *   { name, kind: 'dir'|'file', state, outOfDate, newerHere, keys? }
 * with state
 *   'missing' — only in the main checkout (plain `init` imports it too)
 *   'stale'   — files differ or are missing here, and none is newer here
 *   'edited'  — some file here is newer than the main checkout's: a local edit?
 *   'extra'   — only here; the main checkout has no copy of it
 * `outOfDate` / `newerHere` are paths relative to scripts/leads. A file that
 * exists only here, inside a lead both checkouts have, is not drift: nothing
 * reads an asset its profile does not name.
 */
export function leadDrift(main, here) {
  if (!main || samePath(main, here)) return []
  const base = join(main, LEADS_DIR)
  const theirs = leadEntries(main)
  const ours = leadEntries(here)
  const drift = []
  for (const [name, kind] of theirs) {
    if (!ours.has(name)) {
      drift.push({ name, kind, state: 'missing', outOfDate: [], newerHere: [] })
      continue
    }
    const outOfDate = []
    const newerHere = []
    for (const rel of kind === 'dir' ? filesUnder(base, name) : [name]) {
      const mine = join(here, LEADS_DIR, rel)
      const cmp = existsSync(mine) ? compareFile(join(base, rel), mine) : 'older'
      if (cmp === 'older') outOfDate.push(rel)
      else if (cmp === 'newer') newerHere.push(rel)
    }
    if (!outOfDate.length && !newerHere.length) continue
    const d = { name, kind, state: newerHere.length ? 'edited' : 'stale', outOfDate, newerHere }
    if (kind === 'file') d.keys = envKeyDiff(join(base, name), join(here, LEADS_DIR, name))
    drift.push(d)
  }
  for (const [name, kind] of ours) {
    if (!theirs.has(name)) drift.push({ name, kind, state: 'extra', outOfDate: [], newerHere: [] })
  }
  return drift.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Copy lead data from `main` into `here`. An entry only `main` has is always
 * imported whole — that overwrites nothing. `refresh` decides what else:
 *   true           every out-of-date file; a file newer here is kept
 *   'swimli,nicole' every differing file of the NAMED entries, newer-here
 *                   files included
 * A file that exists only here is never deleted. Timestamps are preserved, so
 * a refreshed file reads as "same" to leadDrift without its bytes being read.
 * @returns {{ imported: string[], refreshed: string[], unknown: string[] }}
 *   paths relative to scripts/leads; `unknown` = named but not in `main`
 */
export function importLeads(main, here, refresh = false) {
  const named =
    typeof refresh === 'string' ? new Set(refresh.split(',').map((s) => s.trim())) : null
  named?.delete('')
  const known = leadEntries(main)
  const result = {
    imported: [],
    refreshed: [],
    unknown: named ? [...named].filter((n) => !known.has(n)) : [],
  }
  const from = join(main, LEADS_DIR)
  const to = join(here, LEADS_DIR)
  for (const d of leadDrift(main, here)) {
    if (d.state === 'missing') {
      mkdirSync(to, { recursive: true }) // absent on a branch that predates scripts/leads
      cpSync(join(from, d.name), join(to, d.name), { recursive: true, preserveTimestamps: true })
      result.imported.push(d.kind === 'dir' ? `${d.name}/` : d.name)
      continue
    }
    let take = []
    if (named) take = named.has(d.name) ? [...d.outOfDate, ...d.newerHere] : []
    else if (refresh === true) take = d.outOfDate
    for (const rel of take) {
      mkdirSync(dirname(join(to, rel)), { recursive: true })
      cpSync(join(from, rel), join(to, rel), { preserveTimestamps: true })
      result.refreshed.push(rel)
    }
  }
  return result
}

const sample = (list) =>
  list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} +${list.length - 3} more`

/**
 * The drift in words, for every caller to print under its own prefix: a
 * heading, one row per entry, and — when something is out of date — the
 * command that refreshes it without touching a file edited here. Never
 * prints a value from `.env.local`, only which of its keys differ.
 */
export function describeLeadDrift(drift) {
  const paths = drift.map((d) => `${LEADS_DIR}/${d.name}${d.kind === 'dir' ? '/' : ''}`)
  const width = Math.max(...paths.map((p) => p.length))
  const rows = drift.map((d, i) => {
    let what
    if (d.state === 'missing') what = 'only in the main checkout'
    else if (d.state === 'extra') {
      what = 'only here — the main checkout has no copy, and removing this worktree deletes it'
    } else {
      const inLead = (list) => sample(list.map((p) => p.slice(d.name.length + 1)))
      const parts =
        d.kind === 'file'
          ? [`${d.newerHere.length ? 'newer here' : 'out of date'} (${d.keys})`]
          : [
              d.outOfDate.length && `out of date: ${inLead(d.outOfDate)}`,
              d.newerHere.length && `newer here: ${inLead(d.newerHere)}`,
            ].filter(Boolean)
      if (d.newerHere.length) {
        parts.push(`a local edit? kept unless named (init --refresh-leads ${d.name})`)
      }
      what = parts.join('; ')
    }
    return `${paths[i].padEnd(width)}  ${what}`
  })
  const fixable = drift.some((d) => d.state === 'missing' || d.outOfDate.length)
  return {
    heading:
      "lead data here differs from the main checkout's, which is the authority — " +
      'lead:seed and typecheck:seeds read this copy',
    rows,
    // A `#` comment rather than a parenthesis, so the line pastes into bash or
    // PowerShell as it stands.
    fix: fixable
      ? 'node scripts/local-env.mjs init --refresh-leads   # copies what is out of date, keeps what is newer here'
      : null,
  }
}
