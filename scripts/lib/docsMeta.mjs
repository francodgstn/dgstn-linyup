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
import { readFileSync } from 'node:fs'

/**
 * Read a text file with its line endings normalised to LF.
 *
 * Every parse here is line-based, and a Windows checkout (core.autocrlf=true,
 * `* text=auto`) hands us CRLF while the committed blobs — and CI's Linux
 * checkout — are LF. Unnormalised, the trailing `\r` defeats every `(.*)$`, so
 * each frontmatter line fails to parse and the index is built from failed
 * parses: a local-only failure CI never sees. \r\n → \n keeps the line count,
 * so every reported line number still points at the right line.
 */
export const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

/** The `area` values, in reading order. A doc's area groups it in the index
 *  (docs/README.md), the docs site's sidebar and its home page — all three read
 *  this list and AREA_TITLE, so they cannot disagree.
 *
 *  `start` and `architecture` come first because they are where a newcomer
 *  starts; the domain areas follow (DOMAIN_AREAS, nested under "Domains" in the
 *  site); `ops` and `product` close. Records are NOT an area: a dated or closed
 *  document is grouped by its `status`, wherever its area says it belongs. */
export const AREAS = [
  'start',
  'architecture',
  'contacts',
  'booking',
  'payments',
  'public',
  'messaging',
  'plugins',
  'orgs',
  'mobile',
  'ops',
  'product',
]

export const DOMAIN_AREAS = ['contacts', 'booking', 'payments', 'public', 'messaging', 'plugins', 'orgs', 'mobile']

export const AREA_TITLE = {
  start: 'Start here',
  architecture: 'Architecture',
  contacts: 'Contacts',
  booking: 'Booking',
  payments: 'Payments & finance',
  public: 'Public surfaces',
  messaging: 'Messaging',
  plugins: 'Plugins',
  orgs: 'Organisations',
  mobile: 'Member app',
  ops: 'Operations',
  product: 'Product',
}

/** Sort key inside an area: `order` (frontmatter, optional) first, then title.
 *  Foundations get a low number so they are read before what builds on them —
 *  alphabetical order put "Accounting" above "Member payments". */
export const byOrder = (a, b) =>
  (Number(a.order ?? 999) - Number(b.order ?? 999)) || String(a.title).localeCompare(String(b.title))

/**
 * Documentation that lives OUTSIDE docs/, next to the code it describes, and is
 * pulled into the docs site as-is. Not moved: CLAUDE.md, agent skills and code
 * comments point at these paths, and a second copy would be a second thing to
 * go stale. These files carry no frontmatter, so their metadata is here.
 */
export const EXTERNAL_DOCS = [
  { path: '.claude/skills/local-env/SKILL.md', id: 'repo/local-env', title: 'Worktrees & ports', area: 'start', order: 4 },
  { path: 'apps/web/messages/_pending/README.md', id: 'repo/i18n-fragments', title: 'i18n fragments', area: 'architecture', order: 9 },
  { path: 'infra/workers/tenant-router/README.md', id: 'repo/tenant-router', title: 'Tenant router', area: 'public', order: 6 },
  { path: 'packages/functions/src/mail/README.md', id: 'repo/mail', title: 'Email sending', area: 'messaging', order: 1 },
  { path: 'apps/mobile/ARCHITECTURE.md', id: 'repo/mobile-architecture', title: 'App architecture', area: 'mobile', order: 1 },
  { path: 'apps/mobile/README.md', id: 'repo/mobile-readme', title: 'Getting started', area: 'mobile', order: 2 },
  { path: '.claude/skills/mobile-release/SKILL.md', id: 'repo/mobile-release', title: 'Releasing', area: 'mobile', order: 3 },
  { path: 'apps/mobile/store/README.md', id: 'repo/store-listing', title: 'Store listing assets', area: 'mobile', order: 6 },
  { path: 'infra/README.md', id: 'repo/infra', title: 'Infrastructure', area: 'ops', order: 1 },
  { path: 'docs/launch/README.md', id: 'repo/launch-model', title: 'Sandbox → promote', area: 'ops', order: 2 },
  { path: 'scripts/leads/README.md', id: 'repo/leads', title: 'Lead sandboxes', area: 'ops', order: 8 },
  { path: 'scripts/MIGRATE-HMD.md', id: 'repo/migrate-hmd', title: 'HMD data import', area: 'ops', order: 9 },
  { path: 'packages/functions/integration/README.md', id: 'repo/integration-tests', title: 'Integration tests', area: 'ops', order: 12 },
  { path: 'apps/web/e2e/README.md', id: 'repo/e2e', title: 'E2E tests', area: 'ops', order: 13 },
]

/**
 * CLAUDE.md, split into one site page per section. CLAUDE.md stays the single
 * source — it is what every agent session loads — and the site renders it
 * rather than restating it.
 *
 * Keyed by the START of the heading text, so a heading can grow a subtitle
 * without falling off the map. A section is its own text up to the next `##` or
 * `###`; `whole: true` takes its `###` children with it. `skip` marks sections
 * a dedicated document already covers in full (the doc wins; the CLAUDE.md
 * summary would be a second, shorter copy in the same sidebar). A heading that
 * matches NOTHING here still appears, under Architecture with its own text as
 * the label — a new section must not silently vanish from the site.
 */
export const CLAUDE_SECTIONS = {
  // Covered by docs/overview.md, stale, or only about the HMD port.
  "What this project is": { skip: true },
  'Monorepo layout': { skip: true },
  'Reference project structure': { skip: true },
  "What's done": { skip: true },
  "What's NOT done": { skip: true, whole: true },
  'Key patterns': { skip: true },
  'Using the reference project': { skip: true },
  // A dedicated doc covers these.
  'Event programmes': { skip: true },
  'Embeds': { skip: true },
  'Email sending': { skip: true },
  'WhatsApp': { skip: true },
  'Waitlist': { skip: true },
  'Promo codes': { skip: true },
  'Waivers': { skip: true },
  'Site translations': { skip: true },
  'Tarif 595': { skip: true },
  'Lead demo tenants': { skip: true },

  'Development commands': { id: 'rules/local-development', title: 'Local development', area: 'start', order: 3 },
  'Firebase emulators': { id: 'rules/emulators', title: 'Emulators', area: 'start', order: 5 },
  'Emulator data modes': { id: 'rules/emulator-datasets', title: 'Emulator datasets', area: 'start', order: 6 },
  'Seeded tenants show priced doors': { id: 'rules/seeded-stripe', title: 'Seeded Stripe accounts', area: 'start', order: 7 },
  'Firebase projects': { id: 'rules/environments', title: 'Environments', area: 'start', order: 8 },

  'Architecture decisions': { id: 'rules/decisions', title: 'Decisions', area: 'architecture', order: 1 },
  'Cloud Functions': { id: 'rules/cloud-functions', title: 'Cloud Functions', area: 'architecture', order: 2 },
  'Public tenant routes': { id: 'rules/public-data', title: 'Public data boundary', area: 'architecture', order: 3 },
  'Firestore security rules': { id: 'rules/security-rules', title: 'Security rules', area: 'architecture', order: 4 },
  'Firebase client SDK': { id: 'rules/firebase-sdk', title: 'Firebase SDK split', area: 'architecture', order: 5 },
  'Scheduled jobs fan out': { id: 'rules/scheduled-jobs', title: 'Scheduled jobs', area: 'architecture', order: 6 },
  'Stripe fields move': { id: 'rules/stripe-shape', title: 'Stripe object shape', area: 'architecture', order: 7 },
  'Internationalisation': { id: 'rules/i18n', title: 'i18n', area: 'architecture', order: 8 },
  'Next.js specifics': { id: 'rules/nextjs', title: 'Next.js notes', area: 'architecture', order: 10 },
  'Comments must not assert a COUNT': { id: 'rules/no-counts', title: 'No counts in comments', area: 'architecture', order: 11 },
  'A guard that SAMPLES a race': { id: 'rules/race-guards', title: 'Race guards', area: 'architecture', order: 12 },
  'UI/UX porting principles': { id: 'rules/ui-principles', title: 'UI principles', area: 'architecture', order: 14, whole: true },

  'Contact lifecycle': { id: 'rules/contact-lifecycle', title: 'Lifecycle rules', area: 'contacts', order: 2 },
  'Contact filtering': { id: 'rules/contact-filters', title: 'Filters & groups', area: 'contacts', order: 3 },
  'Appointments (1:1) vs classes': { id: 'rules/classes-vs-appointments', title: 'Classes vs appointments', area: 'booking', order: 1 },
  'Book-form fields': { id: 'rules/booking-form-fields', title: 'Booking form fields', area: 'booking', order: 4 },
  'SaaS plan tiers': { id: 'rules/plan-tiers', title: 'Plan tiers', area: 'payments', order: 3 },
  'A cancellation is a RECORD': { id: 'rules/cancellations', title: 'Cancellations', area: 'payments', order: 6 },
  'Public tenant route structure': { id: 'rules/public-routes', title: 'Route structure', area: 'public', order: 1 },
  'Public Space': { id: 'rules/public-space', title: 'Member Space', area: 'public', order: 2 },
  'Sandbox safety model': { id: 'rules/sandbox-safety', title: 'Sandbox safety', area: 'ops', order: 3 },
  'Roadmap board': { id: 'rules/roadmap', title: 'Roadmap', area: 'product', order: 2 },
}

const slugify = (s) =>
  s.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

/**
 * Split CLAUDE.md into the pages CLAUDE_SECTIONS describes. Returns
 * [{ id, title, area, order, heading, body }] with `body` WITHOUT its heading
 * (the site prints the title itself). Pure: takes the source text.
 */
export function claudeSections(src) {
  const lines = src.split('\n')
  const heads = []
  let inFence = false
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence
    if (inFence) return
    const m = /^(##|###)\s+(.*?)\s*$/.exec(l)
    if (m) heads.push({ level: m[1].length, text: m[2], line: i })
  })
  const find = (text) => {
    const key = Object.keys(CLAUDE_SECTIONS)
      .filter((k) => text.replace(/`/g, '').startsWith(k))
      .sort((a, b) => b.length - a.length)[0]
    return key ? CLAUDE_SECTIONS[key] : null
  }
  const out = []
  let consumedUntil = -1
  heads.forEach((h, i) => {
    if (h.line < consumedUntil) return
    const spec = find(h.text)
    const next = heads.slice(i + 1).find((n) => (spec?.whole ? n.level <= h.level : true))
    const end = next ? next.line : lines.length
    if (spec?.whole) consumedUntil = end
    const body = lines.slice(h.line + 1, end).join('\n').trim()
    if (spec?.skip || !body) return
    out.push({
      id: spec?.id ?? `rules/${slugify(h.text)}`,
      title: spec?.title ?? h.text.replace(/`/g, ''),
      area: spec?.area ?? 'architecture',
      order: spec?.order ?? 900,
      heading: h.text,
      body,
    })
  })
  return out
}

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

const unquote = (s) => {
  const t = s.trim()
  // Unescape only when the value was actually quoted — a bare value containing
  // a backslash is not an escape sequence.
  if (/^"(.*)"$/s.test(t)) return t.slice(1, -1).replace(/\\"/g, '"')
  if (/^'(.*)'$/s.test(t)) return t.slice(1, -1)
  return t
}

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
