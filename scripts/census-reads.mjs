#!/usr/bin/env node
/**
 * The LOG-list tripwire. Run by CI's Lint job and by `pnpm census:reads`.
 *
 * docs/scalability-2026-09.md Part 3 sorted every list the apps read by what
 * it GROWS WITH. Config and per-entity lists are fine read whole; roster lists
 * are fine up to a stated size; a LOG list — one row per event, growing with
 * time — read without a bound is a defect at some date, and the only question
 * is which date. Phase 1 put a window, a cap or a status filter on every one
 * the census found. This script is what stops the next one from arriving
 * unnoticed, in the same shape as the path-literal tripwire in Part 1 §7: a
 * named set of LOG collections, a scan of every direct read on them in the web
 * and member apps, and a failure for any read that carries no bound and is not
 * acknowledged below with a reason.
 *
 * WHAT COUNTS AS A BOUND: `limit(`, `limitToLast(`, a cursor (`startAfter(` /
 * `startAt(` / `endBefore(`), a range comparison on a `where`, or a by-id read
 * (`documentId()`). A STATUS filter is deliberately NOT a bound the script can
 * see — "pending only" is a work queue that a studio drains, and "live only" a
 * roster; each is acknowledged by name in ACKNOWLEDGED with why it is bounded.
 *
 * WHAT IT CANNOT SEE: a query built in a helper more than a few lines from its
 * `getDocs`, and anything behind a callable. `usePagedQuery` adds its own
 * limit, so a paged list is never flagged; a whole read that a helper hides
 * still has to be found by a person. The census in §17 is that person's list.
 *
 * The ACKNOWLEDGED list is checked both ways: an entry that no longer matches a
 * flagged site fails too, so a bound added later retires its own exemption.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// fileURLToPath (not URL.pathname), and forward slashes in every relative path
// below, so the census runs the same on a Windows checkout as in CI.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const paths = require(join(ROOT, 'packages/shared/dist/paths.js'))

/** The LOG collections — one row per event, growing with time. A constant
 *  named here must exist in @linyup/shared's paths, so the list cannot rot. */
const LOG_COLLECTIONS = [
  'NOTIFICATIONS_SUBCOLLECTION',
  'EVENTS_COLLECTION',
  'SESSIONS_COLLECTION',
  'AVAILABILITY_EXCEPTIONS_COLLECTION',
  'CONTACT_REQUESTS_SUBCOLLECTION',
  'FORM_SUBMISSIONS_SUBCOLLECTION',
  'REFERRALS_COLLECTION',
  'MEMBER_PAYMENTS_SUBCOLLECTION',
  'MEMBER_SUBSCRIPTIONS_SUBCOLLECTION',
  'PAYMENT_EVENTS_SUBCOLLECTION',
  'PARTNER_VISITS_SUBCOLLECTION',
  'FINANCE_TRANSACTIONS_SUBCOLLECTION',
  'ACCOUNTING_ENTRIES_SUBCOLLECTION',
  'TEAM_ACTIVITY_LOG_SUBCOLLECTION',
  'AUTOMATION_LOGS_SUBCOLLECTION',
  'TEAM_WEEKLY_REPORTS_SUBCOLLECTION',
  'CONTACT_WEEKLY_REPORTS_SUBCOLLECTION',
  'TARIF595_RECEIPTS_SUBCOLLECTION',
  'INVOICES_SUBCOLLECTION',
]

/**
 * Unbounded reads that are bounded by something the scan cannot see. Each
 * entry names the file (repo-relative), the collection constant, and why.
 * `line` is not part of the match on purpose — a file edit above the site
 * must not turn an acknowledgement stale.
 */
const ACKNOWLEDGED = [
  {
    file: 'apps/web/src/app/[locale]/(auth)/contacts/[id]/page.tsx',
    constant: 'TEAM_ACTIVITY_LOG_SUBCOLLECTION',
    why: 'limit(PAGE_SIZE) rides in a spread constraints array the scan cannot see',
  },
  {
    file: 'apps/web/src/app/[locale]/(auth)/contacts/page.tsx',
    constant: 'CONTACT_REQUESTS_SUBCOLLECTION',
    why: "status == 'pending' — a work queue the studio drains; history is never listed",
  },
  {
    file: 'apps/web/src/app/[locale]/(auth)/payments/page.tsx',
    constant: 'SESSIONS_COLLECTION',
    why: "status == 'pending_payment' — appointment holds that expire in minutes",
  },
  {
    file: 'apps/web/src/components/contacts/MemberSubscriptionsSection.tsx',
    constant: 'MEMBER_SUBSCRIPTIONS_SUBCOLLECTION',
    why: 'one contact — their own subscriptions, a handful per lifetime',
  },
  {
    file: 'apps/web/src/hooks/useConnect.ts',
    constant: 'MEMBER_SUBSCRIPTIONS_SUBCOLLECTION',
    why: 'status in the live set — a roster, one row per member holding a plan',
  },
  {
    file: 'apps/web/src/hooks/useConnect.ts',
    constant: 'MEMBER_PAYMENTS_SUBCOLLECTION',
    why: 'one contact — accepted per-person history (docs/scalability-2026-09.md §17 B7)',
  },
  {
    file: 'apps/web/src/hooks/useConnect.ts',
    constant: 'PAYMENT_EVENTS_SUBCOLLECTION',
    why: 'one contact — the BYO half of the same per-person read',
  },
  {
    file: 'apps/web/src/plugins/finance/hooks.ts',
    constant: 'ACCOUNTING_ENTRIES_SUBCOLLECTION',
    why: "one accounting period (`period ==`), and `source == 'closing'` (at most one row per closed year)",
  },
]

const SCAN_ROOTS = ['apps/web/src', 'apps/mobile/src']
const READ_CALL = /\b(getDocs|onSnapshot)\s*\(/g
const BOUND = /\blimit(?:ToLast)?\s*\(|\bstartAfter\s*\(|\bstartAt\s*\(|\bendBefore\s*\(|\bdocumentId\s*\(|'(?:>=|<=|>|<)'/

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'ui') continue
      yield* walk(p)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) {
      yield p
    }
  }
}

/** Text of the balanced parenthesised argument starting at `open` (index of `(`). */
function balanced(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return src.slice(open + 1)
}

/** Top-level comma split of an argument list. */
function splitArgs(text) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** The LOG constants a query text targets — the LAST segment of each collection() call. */
function logTargets(queryText) {
  const found = new Set()
  const re = /\bcollection(?:Group)?\s*\(/g
  let m
  while ((m = re.exec(queryText))) {
    const args = splitArgs(balanced(queryText, m.index + m[0].length - 1))
    const last = args[args.length - 1]
    if (last && LOG_COLLECTIONS.includes(last)) found.add(last)
  }
  return [...found]
}

const missing = LOG_COLLECTIONS.filter((c) => !(c in paths))
if (missing.length) {
  console.error(`census-reads: unknown path constants (fix LOG_COLLECTIONS): ${missing.join(', ')}`)
  process.exit(2)
}

const flagged = []
for (const root of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file).split('\\').join('/')
    let m
    READ_CALL.lastIndex = 0
    while ((m = READ_CALL.exec(src))) {
      const open = m.index + m[0].length - 1
      let expr = balanced(src, open)
      // `getDocs(q)` — resolve the identifier to its `const q = query(...)` a few lines up.
      const ident = expr.trim().match(/^([A-Za-z_$][\w$]*)$/)
      if (ident) {
        const before = src.slice(Math.max(0, m.index - 2000), m.index)
        const decl = new RegExp(`\\b${ident[1]}\\s*=\\s*(query|collection|collectionGroup)\\s*\\(`, 'g')
        let d
        let last = null
        while ((d = decl.exec(before))) last = d
        if (last) expr = balanced(before, last.index + last[0].length - 1)
      }
      const targets = logTargets(expr)
      if (targets.length === 0 || BOUND.test(expr)) continue
      const line = src.slice(0, m.index).split('\n').length
      for (const t of targets) flagged.push({ file: rel, line, constant: t })
    }
  }
}

const key = (e) => `${e.file}::${e.constant}`
const acknowledged = new Set(ACKNOWLEDGED.map(key))
const unexpected = flagged.filter((e) => !acknowledged.has(key(e)))
const stale = ACKNOWLEDGED.filter((a) => !flagged.some((e) => key(e) === key(a)))

let failed = false
if (unexpected.length) {
  failed = true
  console.error('census-reads: unbounded reads of a LOG collection (add a limit/window/cursor, or acknowledge with a reason):')
  for (const e of unexpected) console.error(`  ${e.file}:${e.line}  ${e.constant}`)
}
if (stale.length) {
  failed = true
  console.error('census-reads: stale acknowledgements (the read is bounded now, or moved — remove the entry):')
  for (const a of stale) console.error(`  ${a.file}  ${a.constant}`)
}
console.log(
  `census-reads: ${flagged.length} unbounded LOG read${flagged.length === 1 ? '' : 's'} found, ${acknowledged.size} acknowledged, ${unexpected.length} unexpected, ${stale.length} stale`
)
process.exit(failed ? 1 : 0)
