#!/usr/bin/env node
/**
 * The documentation reference tripwire. Run by CI's Lint job and `pnpm docs:check`.
 *
 * This repo's architecture discipline runs on POINTERS. CLAUDE.md does not
 * restate the promo ownership rules; it says to read them at
 * `docs/promo-codes.md → "Redemption integrity"` *rather than from a summary*,
 * because the summaries disagreed with the list in every review round. The
 * module header of waivers/gate.ts owns a census and forbids restating it. That
 * only works while the pointers resolve, and nothing checked them: a heading
 * rename silently turns "read it there" into "read it nowhere".
 *
 * SIX IDIOMS ARE IN USE, and an off-the-shelf link checker sees only the first:
 *
 *   1. markdown links            [x](./y.md)
 *   2. bare repo-relative paths  docs/x.md, packages/…/y.ts
 *   3. named sections            docs/x.md → "Section", CLAUDE.md → "Section"
 *   4. file-qualified anchors    docs/scalability-2026-09.md §17
 *   5. bare anchors              §6.1  (this document's own)
 *   6. cross-repo                hmd-lineup/docs/portal-security.md
 *
 * Every run prints the live per-idiom tally, which is the only count of them
 * that cannot go stale. The figures this table used to carry did exactly that,
 * and silently: idiom 3 was blind to a pointer whose quoted heading wrapped,
 * and to any target without a docs|packages|apps|scripts|infra prefix, so
 * those went unchecked — every CLAUDE.md pointer among them — while the table
 * still advertised a number. See RE_NAMED and NAMED_TARGET below.
 *
 * Idiom 2 lives mostly in .ts COMMENTS, which is why a markdown link checker
 * would validate a small fraction of the surface while implying it had
 * validated all of it.
 *
 * ERROR vs WARNING. Everything a reader is INSTRUCTED TO GO READ is an error:
 * an explicit markdown link, a path cited from source or from a workflow, a
 * named section, a file-qualified §. Two things are warnings on purpose:
 *
 *   - A bare path inside markdown PROSE. That bucket holds the legitimate
 *     "this does not exist yet" cases — docs/launch/analysis-2026-08-25.md
 *     says `**Do:** Write docs/launch/restore-runbook.md`, and
 *     .claude/agents/ux-reviewer/AGENT.md says "If docs/ux-principles.md
 *     exists". The prose is correct and the absence is the point; erroring
 *     would force writers to stop naming files they intend to create.
 *   - A bare §N, which is self-referential and lower-stakes.
 *
 * NEVER FLAGGED, each for a stated reason:
 *   - `hmd-lineup/…` — the legacy reference repo, not checked out here.
 *     CLAUDE.md § "Reference project structure" documents it.
 *   - Anything matched by .gitignore — scripts/leads/{lead}/ is local-only by
 *     design so prospective-customer data never lands in the repo. Reported
 *     once as info, never as a finding.
 *   - Placeholder templates containing YYYY, {, <, * or … —
 *     e.g. docs/ux-review-YYYY-MM.md in the ux-review skill.
 *
 * The ACKNOWLEDGED list is checked BOTH WAYS, following census-reads.mjs: an
 * entry that no longer matches a finding fails too, so a fix retires its own
 * exemption. It is empty, and should stay that way while the error surface is
 * small enough to just fix.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve as resolvePath } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseHeadings, hasNumberedHeading, hasHeadingContaining, parseFrontmatter, AREAS, STATUSES } from './lib/docsMeta.mjs'

// fileURLToPath, not `.pathname`: on Windows the latter is `/C:/…`.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/** Sites whose finding is accepted, with a reason. Checked both ways. */
const ACKNOWLEDGED = []

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'snapshots', 'coverage', '.turbo', '.astro'])

// .agents/skills/ is a byte-identical mirror of three .claude/skills/ trees;
// scanning both double-reports every finding. The stripe-* skills and every
// */references/ tree are vendored upstream content we do not author.
const SKIP_PATHS = [
  /^\.agents\//,
  /^\.claude\/skills\/stripe-/,
  /^\.claude\/skills\/[^/]+\/references\//,
  // The marketing site's legal pages are PRODUCT CONTENT, not documentation.
  // Their links are Astro site routes (`/dpa`), not file paths, so resolving
  // them as files reports fifteen breakages that are all correct as written.
  /^apps\/landing\/src\/pages\//,
  // This checker and its parser document the idioms by quoting real examples,
  // including deliberately absent ones. Scanning them flags their own prose.
  /^scripts\/docs-check\.mjs$/,
  /^scripts\/lib\/docsMeta\.mjs$/,
]

const MD_ROOTS = ['docs', 'CLAUDE.md', 'README.md', 'infra', 'scripts', 'packages', 'apps', '.claude', '.github']
const SRC_EXT = /\.(ts|tsx|mjs|js)$/
const isMd = (p) => p.endsWith('.md')
const isWorkflow = (p) => /^\.github\/workflows\/.*\.ya?ml$/.test(p)

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e)
    const rel = relative(ROOT, full).replaceAll('\\', '/')
    if (SKIP_DIRS.has(e)) continue
    if (SKIP_PATHS.some((re) => re.test(rel))) continue
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else out.push(rel)
  }
  return out
}

const allFiles = []
for (const r of MD_ROOTS) {
  const full = join(ROOT, r)
  if (!existsSync(full)) continue
  if (statSync(full).isDirectory()) walk(full, allFiles)
  else allFiles.push(r)
}
const files = [...new Set(allFiles)].filter((p) => isMd(p) || SRC_EXT.test(p) || isWorkflow(p))

// ── reference extraction ────────────────────────────────────────────────────

const REPO_DIR = '(?:docs|packages|apps|scripts|infra)'
// Longest alternative FIRST: `ts|tsx` matches `.ts` inside `.tsx` and reports
// a file that does not exist. Same for `js` before `json`.
const EXT = '(?:tsx|ts|mjs|json|js|mdx|md|tf|yaml|yml|rules)'
const PATHISH = `${REPO_DIR}\\/[A-Za-z0-9_@.\\/-]+\\.${EXT}`

// A NAMED pointer is SELF-ANCHORING — `x.md → "Section"` cannot be matched by
// accident. REPO_DIR exists to stop RE_BARE_PATH claiming every word with a dot
// in it, a risk this idiom does not have; requiring it here instead made every
// pointer at a root-level or sibling file invisible — among them EVERY pointer
// at CLAUDE.md, including the ones guarding CLAUDE.md's own section headings.
// The file that tells agents to follow pointers had none of its own checked.
const NAMED_TARGET = `(?:[A-Za-z0-9_@.-]+\\/)*[A-Za-z0-9_@.-]+\\.${EXT}`

const RE_MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
// The quoted heading MAY WRAP. `[^"\n]+` looks harmless and is not: a pointer
// broken over two lines stopped being a named reference at all and silently
// degraded to a bare path, so the file was checked and the heading never was.
// Bounded so an unbalanced quote cannot run away; RE_NAMED_OPEN below reports
// anything that runs past it rather than letting it vanish the same way.
const RE_NAMED = new RegExp(
  '(?<![\\w/`.-])`?(' + NAMED_TARGET + ')`?\\s*(?:§\\s*[\\w.]+\\s*)?→\\s*"([^"]{1,200}?)"', 'g')
const RE_NAMED_OPEN = new RegExp(
  '(?<![\\w/`.-])`?(' + NAMED_TARGET + ')`?\\s*(?:§\\s*[\\w.]+\\s*)?→\\s*"', 'g')
const RE_QUALIFIED = new RegExp('`?(' + PATHISH + ')`?[^\\n§/]{0,40}§\\s*(\\d+(?:\\.\\d+)*[a-z]?)', 'g')
const RE_BARE_PATH = new RegExp('(?<![\\w/`])(' + PATHISH + ')', 'g')
const RE_BARE_SECTION = /(?<![\w/.])§\s*(\d+(?:\.\d+)*[a-z]?)/g

const isPlaceholder = (p) => /YYYY|\{|<|\*|…/.test(p)
const isCrossRepo = (p) => /(^|\/)hmd-lineup\//.test(p)

// A wrapped pointer's continuation carries its file's comment leader. Strip it
// in SOURCE only: a markdown heading may legitimately open with `*` or `#`, and
// mangling one here would invent a mismatch rather than find one.
const normalizeSection = (s, md) =>
  (md ? s : s.replace(/\n[ \t]*(?:\/\/+|\*|#)?[ \t]*/g, ' ')).replace(/\s+/g, ' ').trim()

// Resolve a named target the way a READER does: the file next to the citing one
// if there is one, else the repo root. `README.md` cited from
// apps/mobile/ARCHITECTURE.md is the mobile README, not the root one (both
// exist); `CLAUDE.md` cited from scripts/ has no sibling and means the root.
const resolveNamedTarget = (from, raw) => {
  const sibling = relative(ROOT, resolvePath(join(ROOT, dirname(from)), raw)).replaceAll('\\', '/')
  return existsSync(join(ROOT, sibling)) ? sibling : raw
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length

const findings = []
const missingCandidates = new Set()
const refs = []

for (const rel of files) {
  let src
  try { src = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
  const md = isMd(rel)
  const claimed = new Set() // spans already consumed by a richer idiom

  const add = (kind, target, extra, idx) => {
    refs.push({ kind, from: rel, line: lineOf(src, idx), target, ...extra })
  }

  // 3. named sections — richest idiom, extracted first
  const closed = new Set()
  for (const m of src.matchAll(RE_NAMED)) {
    claimed.add(m.index)
    closed.add(m.index)
    if (isCrossRepo(m[1]) || isPlaceholder(m[1])) continue
    add('named', resolveNamedTarget(rel, m[1]), { section: normalizeSection(m[2], md) }, m.index)
  }
  // A pointer that opens but never closes inside RE_NAMED's bound is REPORTED,
  // never dropped. Silently skipping one is the exact defect this pass fixes.
  for (const m of src.matchAll(RE_NAMED_OPEN)) {
    if (closed.has(m.index) || isCrossRepo(m[1]) || isPlaceholder(m[1])) continue
    add('named-unterminated', resolveNamedTarget(rel, m[1]), {}, m.index)
  }
  // 4. file-qualified §
  for (const m of src.matchAll(RE_QUALIFIED)) {
    claimed.add(m.index)
    if (isCrossRepo(m[1]) || isPlaceholder(m[1])) continue
    add('qualified', m[1], { num: m[2] }, m.index)
  }
  // 1. markdown links
  if (md) {
    for (const m of src.matchAll(RE_MD_LINK)) {
      const href = m[1].split('#')[0]
      if (!href || /^(https?:|mailto:|#|\/)/.test(href)) continue
      if (isCrossRepo(href) || isPlaceholder(href)) continue
      const abs = relative(ROOT, resolvePath(join(ROOT, dirname(rel)), href)).replaceAll('\\', '/')
      add('link', abs, {}, m.index)
    }
  }
  // 2. bare repo-relative paths
  for (const m of src.matchAll(RE_BARE_PATH)) {
    if ([...claimed].some((c) => m.index >= c && m.index <= c + 200)) continue
    if (isCrossRepo(m[1]) || isPlaceholder(m[1])) continue
    add(md ? 'bare-md' : isWorkflow(rel) ? 'bare-workflow' : 'bare-src', m[1], {}, m.index)
  }
  // 5. bare § — resolved against this file's own headings
  if (md) {
    for (const m of src.matchAll(RE_BARE_SECTION)) {
      if ([...claimed].some((c) => m.index >= c && m.index <= c + 200)) continue
      add('bare-section', rel, { num: m[1] }, m.index)
    }
  }
}

for (const r of refs) if (!existsSync(join(ROOT, r.target))) missingCandidates.add(r.target)

// One `git check-ignore` for every missing path at once — a path that is
// missing because it is deliberately untracked is information, never a finding.
const ignored = new Set()
if (missingCandidates.size) {
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT, input: [...missingCandidates].join('\n'), encoding: 'utf8',
    })
    for (const l of out.split('\n')) if (l.trim()) ignored.add(l.trim())
  } catch { /* exit 1 simply means none were ignored */ }
}

// ── classification ──────────────────────────────────────────────────────────

const headingCache = new Map()
function headingsOf(rel) {
  if (!headingCache.has(rel)) {
    try {
      headingCache.set(rel, parseHeadings(readFileSync(join(ROOT, rel), 'utf8')))
    } catch {
      headingCache.set(rel, [])
    }
  }
  return headingCache.get(rel)
}

const errors = []
const warnings = []
const infos = []

for (const r of refs) {
  const exists = existsSync(join(ROOT, r.target))

  if (!exists) {
    if (ignored.has(r.target)) {
      infos.push({ ...r, why: 'gitignored by design' })
      continue
    }
    const msg = `${r.target} does not exist`
    // A bare path in markdown prose is a warning: that bucket holds the
    // legitimate "does not exist yet" cases the prose is right to name.
    if (r.kind === 'bare-md') warnings.push({ ...r, why: msg })
    else errors.push({ ...r, why: msg })
    continue
  }

  if (r.kind === 'named-unterminated') {
    warnings.push({ ...r, why: 'pointer opens a quoted section that never closes' })
  } else if (r.kind === 'named' && isMd(r.target)) {
    if (!hasHeadingContaining(headingsOf(r.target), r.section)) {
      errors.push({ ...r, why: `${r.target} has no heading matching "${r.section}"` })
    }
  } else if (r.kind === 'qualified' && isMd(r.target)) {
    const hs = headingsOf(r.target)
    if (!hasNumberedHeading(hs, r.num)) {
      const numbered = hs.filter((h) => h.num).length
      errors.push({
        ...r,
        why: numbered === 0
          ? `${r.target} has no numbered headings at all, so §${r.num} cannot resolve`
          : `${r.target} has no section numbered ${r.num}`,
      })
    }
  } else if (r.kind === 'bare-section') {
    if (!hasNumberedHeading(headingsOf(r.target), r.num)) {
      warnings.push({ ...r, why: `§${r.num} does not resolve in this file` })
    }
  }
}

// ── frontmatter schema ──────────────────────────────────────────────────────
//
// Enforced only under docs/, which is where the index and the docs site read
// from. A folder README is an entry point, not a document in the index.

for (const rel of files.filter((f) => f.startsWith('docs/') && isMd(f))) {
  if (rel === 'docs/README.md' || rel.endsWith('/README.md')) continue
  const src = readFileSync(join(ROOT, rel), 'utf8')
  const { data, error } = parseFrontmatter(src)
  const at = { from: rel, line: 1, kind: 'frontmatter', target: rel }

  if (error) { errors.push({ ...at, why: error }); continue }
  if (!data) { errors.push({ ...at, why: 'no frontmatter block' }); continue }

  if (!data.title) errors.push({ ...at, why: 'frontmatter has no `title`' })
  if (!STATUSES.includes(data.status)) {
    errors.push({ ...at, why: `\`status: ${data.status ?? '(absent)'}\` is not one of ${STATUSES.join(' | ')}` })
  }
  if (!AREAS.includes(data.area)) {
    errors.push({ ...at, why: `\`area: ${data.area ?? '(absent)'}\` is not one of ${AREAS.join(' | ')}` })
  }
  // The title is what the index and the site's sidebar print. If it drifts
  // from the H1 the page shows one name and the link another.
  const h1 = /^#\s+(.+)$/m.exec(parseFrontmatter(src).body.split('\n').slice(0, 6).join('\n'))
  if (data.title && h1 && h1[1].trim() !== String(data.title).trim()) {
    errors.push({ ...at, why: `frontmatter title does not match the H1 ("${data.title}" vs "${h1[1].trim()}")` })
  }
}

// ── report ──────────────────────────────────────────────────────────────────

const key = (e) => `${e.from}::${e.target}::${e.section ?? e.num ?? ''}`
const acknowledged = new Set(ACKNOWLEDGED.map(key))
const unexpected = errors.filter((e) => !acknowledged.has(key(e)))
const stale = ACKNOWLEDGED.filter((a) => !errors.some((e) => key(e) === key(a)))

const LABEL = {
  link: 'markdown link',
  named: 'named section',
  'named-unterminated': 'unterminated pointer',
  qualified: 'section anchor',
  'bare-src': 'path cited in source',
  'bare-workflow': 'path cited in a workflow',
  'bare-md': 'path in prose',
  'bare-section': 'bare section anchor',
  frontmatter: 'frontmatter',
}

let failed = false
if (unexpected.length) {
  failed = true
  console.error('\ndocs-check: broken documentation references:')
  for (const e of unexpected) console.error(`  ${e.from}:${e.line}  [${LABEL[e.kind]}]  ${e.why}`)
}
if (stale.length) {
  failed = true
  console.error('\ndocs-check: stale acknowledgements (the reference resolves now, or moved — remove the entry):')
  for (const a of stale) console.error(`  ${a.from}  ${a.target}`)
}
if (warnings.length && !process.env.CI) {
  console.warn('\ndocs-check: warnings (a named-but-absent file, or an unresolved bare §):')
  for (const w of warnings.slice(0, 40)) console.warn(`  ${w.from}:${w.line}  [${LABEL[w.kind]}]  ${w.why}`)
  if (warnings.length > 40) console.warn(`  … and ${warnings.length - 40} more`)
}

const byKind = (k) => refs.filter((r) => r.kind === k).length
console.log(
  `\ndocs-check: ${refs.length} references across ${files.length} files ` +
    `(${byKind('link')} links, ${byKind('named')} named sections, ${byKind('qualified')} anchors, ` +
    `${byKind('bare-src') + byKind('bare-workflow')} cited from source, ${byKind('bare-md')} in prose) ` +
    `— ${unexpected.length} error${unexpected.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` +
    (infos.length ? `, ${infos.length} gitignored by design` : '')
)
process.exit(failed ? 1 : 0)
