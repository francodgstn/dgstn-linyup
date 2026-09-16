/**
 * The shared reader for documentation metadata: frontmatter, headings, and the
 * heading NUMBERS the `§N` idiom resolves against.
 *
 * Kept beside scripts/lib/icuMessages.mjs and scripts/lib/usedKeys.mjs for the
 * same reason those exist: the parse is needed by more than one guard
 * (docs-check today, docs-index next), and two parsers of one grammar drift.
 *
 * WHY A HAND-ROLLED FRONTMATTER PARSE: the block is a flat map of scalars and
 * one-level lists, which is the subset every doc here uses. Pulling in a YAML
 * dependency to read it would touch pnpm-lock.yaml, and the repo pins
 * `engines.pnpm <12` to the App Hosting buildpack (see the root package.json's
 * `//engines.pnpm` note) — a lockfile change is not free here. Anything richer
 * than this subset should fail loudly rather than be guessed at, so it does.
 */

/** The `area` values. A doc's area groups it in the index and, later, in the
 *  Starlight sidebar. Kept here so both readers share one list. */
export const AREAS = [
  'payments',
  'booking',
  'contacts',
  'content',
  'platform',
  'mobile',
  'ops',
  'product',
]

/** What `status` answers: is the imperative prose in this file a work list today?
 *  - living: how the system works now; imperatives are RULES
 *  - plan:   work to do; imperatives are TASKS
 *  - record: true as of a date, never re-run; imperatives are HISTORY
 *  - closed: finished; nothing here is a work list
 *  The distinction, and why it matters, is docs/archive/README.md's. */
export const STATUSES = ['living', 'plan', 'record', 'closed']

/**
 * Split a `---` frontmatter block off the top of a markdown source.
 * Returns { data, body, bodyStartLine, error }. `data` is null when there is
 * no block at all — which is not an error here; the caller decides.
 */
export function parseFrontmatter(src) {
  const lines = src.split('\n')
  if (lines[0]?.trim() !== '---') return { data: null, body: src, bodyStartLine: 1, error: null }

  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) return { data: null, body: src, bodyStartLine: 1, error: 'unterminated frontmatter block' }

  const data = {}
  for (let i = 1; i < end; i++) {
    const raw = lines[i]
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const m = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(raw)
    if (!m) return { data: null, body: src, bodyStartLine: 1, error: `cannot parse frontmatter line ${i + 1}: ${raw.trim()}` }
    const [, key, rest] = m
    data[key] = parseScalarOrList(rest.trim())
  }
  return { data, body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2, error: null }
}

function parseScalarOrList(v) {
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    return splitTopLevel(inner).map(unquote)
  }
  return unquote(v)
}

function splitTopLevel(s) {
  const out = []
  let cur = ''
  let quote = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const unquote = (s) => s.replace(/^['"]|['"]$/g, '').trim()

/**
 * Every ATX heading, with the section number the `§` idiom points at.
 *
 * `## 17. The census` → num '17';  `### 5b. Rotate` → num '5b';
 * `## 2.9 Retention`  → num '2.9'. A heading with no leading number has
 * num null, which is how "this doc has no numbered sections at all" is
 * detected — docs/finance-accrual.md is cited as `§4` and is exactly that.
 */
export function parseHeadings(src) {
  const out = []
  let inFence = false
  src.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) return
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (!m) return
    const text = m[2]
    const num = /^(\d+(?:\.\d+)*[a-z]?)[.)]?\s+/.exec(text)
    out.push({ level: m[1].length, text, line: i + 1, num: num ? num[1] : null })
  })
  return out
}

/** Does this document have a section numbered `n`? Used by the `§N` resolver. */
export function hasNumberedHeading(headings, n) {
  return headings.some((h) => h.num === n)
}

/** Does this document have a heading containing `needle`? Used by the
 *  `docs/x.md → "Section"` resolver, which is how the census-owner convention
 *  points a reader at the one place a list is enumerated. Compared loosely
 *  (case-insensitive, whitespace-collapsed) because the prose quoting a
 *  heading rarely reproduces its punctuation exactly. */
export function hasHeadingContaining(headings, needle) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[`*_]/g, '').trim()
  const n = norm(needle)
  return headings.some((h) => norm(h.text).includes(n))
}
