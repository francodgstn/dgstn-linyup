#!/usr/bin/env node
/**
 * functions-inventory — every deployable Cloud Function, read from the BUILT
 * bundle, so the list cannot drift from what firebase-tools deploys.
 *
 *   pnpm functions:inventory [--md | --json | --tsv]
 *                            [--dist packages/functions/dist] [--index <index.ts>]
 *
 * Build first (`pnpm --filter @linyup/functions build`): this reads whatever
 * `dist` holds, and says when that was built.
 *
 * WHY. `docs/functions-consolidation-plan.md` sizes every phase from "how many
 * functions of which kind, in which domain, with which options". Counted from
 * source with ripgrep, that answer depends on how an export happens to be
 * spelled (a wrapped `onCall`, a type annotation, a re-export under another
 * name) and cannot see an option's EFFECTIVE value. The build can: each export
 * of a firebase-functions 6.x bundle carries `__endpoint`, the manifest entry
 * firebase-tools discovery turns into a deployed function
 * (`lib/runtime/manifest.d.ts` → ManifestEndpoint), with the global options
 * already merged in.
 *
 * HOW THE BUNDLE IS LOADED. A plain `require()` of `dist/index.js` from this
 * process — verified on 2026-09-19 against firebase-functions 6.6.0. It needs
 * NO environment: no GCLOUD_PROJECT, no FIREBASE_CONFIG, no credentials, no
 * emulator flag. `admin.initializeApp()` at the top of the index only builds a
 * lazy app, and `defineString`/`defineInt` params are Expressions that are
 * never evaluated at load. Nothing here calls `.value()`, which is the one
 * thing that would warn or throw without an env. What it does cost is time: the
 * whole index is one module graph, so a cold load takes tens of seconds on
 * Windows — the same load FUNCTIONS_DISCOVERY_TIMEOUT exists for.
 *
 * The alternative, if a future SDK stops exposing `__endpoint`, is the SDK's
 * own discovery binary, run with `packages/functions` as the working directory:
 *
 *   FUNCTIONS_MANIFEST_OUTPUT_PATH=<file> \
 *     node node_modules/firebase-functions/lib/bin/firebase-functions.js
 *
 * which writes the wire manifest (`endpoints`, `params`, `requiredAPIs`) and
 * exits — also verified on 2026-09-19, same endpoint set. firebase-tools itself
 * uses that binary's HTTP mode instead (FUNCTIONS_CONTROL_API=true and PORT,
 * then GET `/__/functions.yaml` and `/__/quitquitquit`); that mode was read in
 * the 6.6.0 source, not run here. Either gives the same endpoints as JSON, with
 * params already flattened to CEL strings; neither gives the global options.
 *
 * HOW OPTION VALUES READ. An option is a literal, an Expression or the SDK's
 * ResetValue sentinel:
 *
 *   - a param reads `param:API_MIN_INSTANCES` (any other expression `expr:…`);
 *   - ResetValue reads `reset`. It is what the SDK writes for every resettable
 *     option a function does NOT set ("put the platform default back"), so it
 *     means unset. `--json` keeps it; the other outputs leave the cell blank.
 *
 * "Non-default" is therefore: set by the function, or different from the
 * global options read from the same SDK instance the bundle configured
 * (`getGlobalOptions()`). A function that sets an option to exactly the global
 * value is indistinguishable from one that inherits it, and is not listed.
 * `enforceAppCheck`, `cors` and `consumeAppCheckToken` are runtime behaviour of
 * the callable, not part of the manifest, so they are NOT visible here — the
 * ripgrep recipe in the plan doc still owns those.
 *
 * DOMAIN is the top-level folder under `packages/functions/src` that the index
 * re-exports the name from. The bundle does not know that, so it is parsed from
 * `src/index.ts` — which doubles as a cross-check: a name the bundle deploys
 * that the index does not re-export (an `export *`, a definition in the index
 * itself, a stale dist) or the reverse (a re-export that is not a function, or
 * a dist older than the source) is printed and fails the run.
 *
 * Exit 0: inventory printed, bundle and index agree. Exit 1: printed, but they
 * disagree. Exit 2: the bundle or the index could not be loaded.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIST = join(REPO_ROOT, 'packages', 'functions', 'dist')

const TRIGGER_KEYS = [
  'callableTrigger',
  'httpsTrigger',
  'eventTrigger',
  'scheduleTrigger',
  'taskQueueTrigger',
  'blockingTrigger',
]

// ─── Pure ────────────────────────────────────────────────────────────────────

/**
 * Block and line comments out, CRLF normalised. A `//` inside a string literal
 * would be eaten too; module specifiers never hold one. Pure.
 */
export function stripComments(source) {
  return String(source)
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * The names `index.ts` re-exports, with where each comes from. Pure.
 *
 * Handles `export { a, b as c } from './folder/file'` across lines; the key is
 * the EXPORTED name (`c`), which is the deployed function's name. Type-only
 * re-exports are skipped. Anything else that exports (`export *`, a definition
 * in the index itself) is returned in `unparsed`, so the caller can say why a
 * cross-check failed rather than only that it did.
 *
 * @returns {{ exports: Map<string, { local: string, from: string, domain: string }>,
 *   duplicates: string[], unparsed: string[] }}
 */
export function parseIndexExports(source) {
  const text = stripComments(source)
  const exports = new Map()
  const duplicates = []
  const reExport = /export\s*(type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const [, typeOnly, members, from] of text.matchAll(reExport)) {
    if (typeOnly) continue
    for (const raw of members.split(',')) {
      const member = raw.trim()
      if (!member || /^type\s/.test(member)) continue
      const [local, exported = local] = member.split(/\s+as\s+/).map((s) => s.trim())
      if (exports.has(exported)) duplicates.push(exported)
      exports.set(exported, { local, from, domain: domainOf(from) })
    }
  }
  const unparsed = text
    .replace(reExport, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^export\b/.test(line))
  return { exports, duplicates, unparsed }
}

/** `./teams/createTeam` → `teams`; `./api` → `api`. Pure. */
export function domainOf(from) {
  return (
    String(from)
      .replace(/^(\.\/)+/, '')
      .split('/')[0]
      .replace(/\.[cm]?[jt]s$/, '') || '?'
  )
}

/**
 * One option value, readable and JSON-safe, without ever evaluating it. Pure.
 * See the header, "How option values read".
 */
export function renderOption(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') return value
  if (value.constructor?.name === 'ResetValue') return 'reset'
  if (typeof value.toCEL === 'function') {
    return typeof value.name === 'string' ? `param:${value.name}` : `expr:${String(value)}`
  }
  if (Array.isArray(value)) return value.map(renderOption)
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderOption(v)]))
}

/** Set by something, as opposed to absent or reset to the platform default. */
const isSet = (rendered) =>
  rendered !== null &&
  rendered !== undefined &&
  rendered !== 'reset' &&
  !(Array.isArray(rendered) && rendered.length === 0) &&
  !(typeof rendered === 'object' && !Array.isArray(rendered) && Object.keys(rendered).length === 0)

/**
 * What kind of function an endpoint is, and what it listens to. Pure.
 *
 * kind: callable | https | firestore.<written|created|updated|deleted> |
 * schedule | taskQueue | pubsub | blocking.<event> | other.
 */
export function classify(endpoint) {
  const triggers = TRIGGER_KEYS.filter((key) => endpoint?.[key] !== undefined)
  const none = { eventType: null, path: null, topic: null, retry: null }
  if (triggers.length !== 1) return { kind: 'other', ...none }
  const [trigger] = triggers
  if (trigger === 'callableTrigger') return { kind: 'callable', ...none }
  if (trigger === 'httpsTrigger') return { kind: 'https', ...none }
  if (trigger === 'scheduleTrigger') return { kind: 'schedule', ...none }
  if (trigger === 'taskQueueTrigger') return { kind: 'taskQueue', ...none }
  if (trigger === 'blockingTrigger') {
    const eventType = String(endpoint.blockingTrigger.eventType ?? '')
    const event = eventType.split(/[./]/).pop() || 'unknown'
    return { kind: `blocking.${event}`, ...none, eventType }
  }
  const et = endpoint.eventTrigger
  const eventType = String(et.eventType ?? '')
  const filters = { ...renderOption(et.eventFilters ?? {}) }
  const patterns = { ...renderOption(et.eventFilterPathPatterns ?? {}) }
  const retry = renderOption(et.retry)
  const firestore = /firestore\.document\.v\d+\.(written|created|updated|deleted)/.exec(eventType)
  if (firestore) {
    const path = patterns.document ?? filters.document ?? null
    return { kind: `firestore.${firestore[1]}`, eventType, path, topic: null, retry }
  }
  if (/pubsub\.topic\.v\d+\.messagePublished/.test(eventType)) {
    return { kind: 'pubsub', eventType, path: null, topic: filters.topic ?? null, retry }
  }
  return { kind: 'other', eventType, path: null, topic: null, retry }
}

/**
 * One flat record per function. `globals` is the rendered `getGlobalOptions()`
 * (may be empty). Pure.
 */
export function toRecord(name, endpoint, origin, globals = {}) {
  const c = classify(endpoint)
  const record = {
    name,
    domain: origin?.domain ?? '?',
    source: origin?.from ?? null,
    kind: c.kind,
    platform: endpoint.platform ?? null,
    region: renderOption(endpoint.region) ?? [],
    memoryMb: renderOption(endpoint.availableMemoryMb),
    timeoutSeconds: renderOption(endpoint.timeoutSeconds),
    cpu: renderOption(endpoint.cpu),
    concurrency: renderOption(endpoint.concurrency),
    minInstances: renderOption(endpoint.minInstances),
    maxInstances: renderOption(endpoint.maxInstances),
    invoker: renderOption(endpoint.httpsTrigger?.invoker),
    serviceAccount: renderOption(endpoint.serviceAccountEmail),
    secrets: (endpoint.secretEnvironmentVariables ?? []).map((s) => s.key),
    vpc: renderOption(endpoint.vpc),
    ingress: renderOption(endpoint.ingressSettings),
    labels: renderOption(endpoint.labels) ?? {},
    eventType: c.eventType,
    path: c.path,
    topic: c.topic,
    retry: c.retry,
    schedule: renderOption(endpoint.scheduleTrigger?.schedule),
    timeZone: renderOption(endpoint.scheduleTrigger?.timeZone),
    scheduleRetry: renderOption(endpoint.scheduleTrigger?.retryConfig),
    taskQueue: endpoint.taskQueueTrigger ? renderOption(endpoint.taskQueueTrigger) : null,
    blockingOptions: renderOption(endpoint.blockingTrigger?.options),
  }
  record.nonDefault = nonDefaultOptions(record, globals)
  return record
}

/** The options a function sets itself, or that differ from the global ones, as `key=value` strings. Pure. */
export function nonDefaultOptions(record, globals = {}) {
  const out = []
  const differs = (key, value, globalValue) => {
    if (isSet(value) && JSON.stringify(value) !== JSON.stringify(globalValue ?? null))
      out.push(`${key}=${Array.isArray(value) ? value.join('|') : value}`)
  }
  differs('memory', record.memoryMb, globals.memoryMb)
  differs('timeout', record.timeoutSeconds, globals.timeoutSeconds)
  differs('cpu', record.cpu, globals.cpu)
  differs('concurrency', record.concurrency, globals.concurrency)
  differs('minInstances', record.minInstances, globals.minInstances)
  differs('maxInstances', record.maxInstances, globals.maxInstances)
  differs('region', record.region, globals.region)
  differs('invoker', record.invoker, null)
  if (record.retry === true || (typeof record.retry === 'string' && record.retry !== 'reset'))
    out.push(`retry=${record.retry}`)
  differs('secrets', record.secrets, null)
  differs('serviceAccount', record.serviceAccount, globals.serviceAccount)
  if (isSet(record.vpc)) out.push('vpc=set')
  differs('ingress', record.ingress, globals.ingress)
  if (isSet(record.labels)) out.push(`labels=${Object.keys(record.labels).join('|')}`)
  return out
}

/** `getGlobalOptions()` in the record's vocabulary. Pure. */
export function renderGlobals(options = {}) {
  const region = renderOption(options.region)
  return {
    region: region == null ? null : [].concat(region),
    memoryMb: memoryToMb(renderOption(options.memory)),
    timeoutSeconds: renderOption(options.timeoutSeconds),
    cpu: renderOption(options.cpu),
    concurrency: renderOption(options.concurrency),
    minInstances: renderOption(options.minInstances),
    maxInstances: renderOption(options.maxInstances),
    serviceAccount: renderOption(options.serviceAccount),
    ingress: renderOption(options.ingressSettings),
  }
}

function memoryToMb(memory) {
  const match = /^(\d+)(MiB|GiB)$/.exec(String(memory ?? ''))
  if (!match) return memory ?? null
  return Number(match[1]) * (match[2] === 'GiB' ? 1024 : 1)
}

/** Names on one side only. Pure. */
export function crossCheck(bundleNames, indexNames) {
  const bundle = new Set(bundleNames)
  const index = new Set(indexNames)
  return {
    onlyInBundle: [...bundle].filter((n) => !index.has(n)).sort(),
    onlyInIndex: [...index].filter((n) => !bundle.has(n)).sort(),
  }
}

const KIND_ORDER = ['callable', 'https', 'firestore', 'pubsub', 'schedule', 'taskQueue', 'blocking']
const kindRank = (kind) => {
  const rank = KIND_ORDER.indexOf(kind.split('.')[0])
  return rank === -1 ? KIND_ORDER.length : rank
}
const byKind = (a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b)

/**
 * The counts and lists every output mode prints. Pure.
 *
 * `sharedPaths` is the input for the plan's trigger-merge phase: Firestore
 * triggers grouped by document path + event kind + retry, groups with more
 * than one member only — the same-path, same-event, same-retry condition the
 * plan requires before a merge is even considered.
 */
export function summarise(records) {
  const count = (keyOf) => {
    const counts = new Map()
    for (const r of records) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1)
    return counts
  }
  const kinds = [...count((r) => r.kind)].sort((a, b) => byKind(a[0], b[0]))
  const families = [...count((r) => r.kind.split('.')[0])].sort((a, b) => byKind(a[0], b[0]))

  const matrix = new Map()
  for (const r of records) {
    const row = matrix.get(r.domain) ?? {}
    row[r.kind] = (row[r.kind] ?? 0) + 1
    row.total = (row.total ?? 0) + 1
    matrix.set(r.domain, row)
  }
  const domains = [...matrix]
    .map(([domain, row]) => ({ domain, ...row }))
    .sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain))

  const groups = new Map()
  for (const r of records) {
    if (!r.kind.startsWith('firestore.')) continue
    const key = JSON.stringify([r.path, r.kind, r.retry === true])
    groups.set(key, [...(groups.get(key) ?? []), r.name])
  }
  const sharedPaths = [...groups]
    .filter(([, names]) => names.length > 1)
    .map(([key, names]) => {
      const [path, kind, retry] = JSON.parse(key)
      return { path, kind, retry, names: names.sort() }
    })
    .sort((a, b) => b.names.length - a.names.length || String(a.path).localeCompare(String(b.path)))

  return {
    total: records.length,
    kinds: kinds.map(([kind, n]) => ({ kind, count: n })),
    families: families.map(([family, n]) => ({ family, count: n })),
    kindColumns: kinds.map(([kind]) => kind),
    domains,
    nonDefault: records
      .filter((r) => r.nonDefault.length)
      .map(({ name, domain, kind, nonDefault }) => ({ name, domain, kind, nonDefault }))
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name)),
    sharedPaths,
  }
}

// ─── Formatting (pure) ───────────────────────────────────────────────────────

const describeGlobals = (globals) =>
  Object.entries(globals)
    .filter(([, v]) => isSet(v))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
    .join(', ') || 'none read'

function alignedTable(header, rows, { leftAlign = false } = {}) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) =>
    cells
      .map((cell, i) =>
        leftAlign || i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i])
      )
      .join('  ')
      .trimEnd()
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)]
}

/** Column headers for the domain matrix: `firestore.written` → `fs.written`, `blocking.beforeCreate` → `blocking`. */
const shortKind = (kind) => kind.replace(/^firestore\./, 'fs.').replace(/^blocking\..*/, 'blocking')

const domainRows = (summary) =>
  summary.domains.map((d) => [d.domain, ...summary.kindColumns.map((k) => d[k] ?? ''), d.total])
const totalsRow = (summary) => [
  'TOTAL',
  ...summary.kindColumns.map((k) => summary.kinds.find((x) => x.kind === k).count),
  summary.total,
]

export function formatText(summary, meta) {
  const lines = [
    `${summary.total} deployable functions — ${meta.entry}, built ${meta.built}`,
    `global options: ${describeGlobals(meta.globals)}`,
    '',
    'By kind',
    ...alignedTable(
      ['kind', 'count'],
      summary.kinds.map((k) => [k.kind, k.count])
    ).map((l) => `  ${l}`),
    '',
    'By domain × kind',
    ...alignedTable(
      ['domain', ...summary.kindColumns.map(shortKind), 'total'],
      [...domainRows(summary), totalsRow(summary)]
    ).map((l) => `  ${l}`),
    '',
    'Non-default options (set by the function, or different from the global options)',
  ]
  if (summary.nonDefault.length)
    lines.push(
      ...alignedTable(
        ['function', 'domain', 'kind', 'options'],
        summary.nonDefault.map((r) => [r.name, r.domain, r.kind, r.nonDefault.join('  ')]),
        { leftAlign: true }
      ).map((l) => `  ${l}`)
    )
  else lines.push('  none')
  lines.push(
    '',
    'Firestore trigger paths listened to by more than one trigger (same event, same retry)'
  )
  for (const g of summary.sharedPaths) {
    lines.push(`  ${g.names.length} × ${g.path}  [${g.kind}${g.retry ? ', retry' : ''}]`)
    lines.push(`      ${g.names.join(', ')}`)
  }
  if (!summary.sharedPaths.length) lines.push('  none')
  return lines.join('\n')
}

export function formatMarkdown(summary, meta) {
  const table = (header, rows) => [
    `| ${header.join(' | ')} |`,
    `| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ]
  const code = (s) => `\`${s}\``
  const lines = [
    `**${summary.total} deployable functions** — \`${meta.entry}\`, built ${meta.built}. Global options: ${describeGlobals(meta.globals)}.`,
    '',
    '**By kind**',
    '',
    ...table(
      ['Kind', 'Count'],
      summary.kinds.map((k) => [code(k.kind), k.count])
    ),
    '',
    '**By domain × kind** (domain = the folder under `packages/functions/src` the index re-exports the name from; `fs.` = Firestore trigger)',
    '',
    ...table(
      ['Domain', ...summary.kindColumns.map(shortKind), 'Total'],
      [
        ...domainRows(summary).map(([d, ...rest]) => [code(d), ...rest]),
        totalsRow(summary).map((c, i) => (i === 0 ? '**Total**' : `**${c}**`)),
      ]
    ),
    '',
    '**Non-default options** (set by the function, or different from the global options)',
    '',
    '| Function | Domain | Kind | Options |',
    '| --- | --- | --- | --- |',
    ...summary.nonDefault.map(
      (r) =>
        `| ${code(r.name)} | ${code(r.domain)} | ${r.kind} | ${r.nonDefault.map(code).join(' ')} |`
    ),
    '',
    '**Firestore trigger paths listened to by more than one trigger** (same event type, same `retry`)',
    '',
    '| Path | Event | Retry | Triggers |',
    '| --- | --- | --- | --- |',
    ...summary.sharedPaths.map(
      (g) =>
        `| ${code(g.path)} | ${g.kind.split('.')[1]} | ${g.retry ? 'yes' : 'no'} | ${g.names.map(code).join(', ')} |`
    ),
  ]
  return lines.join('\n')
}

const TSV_COLUMNS = [
  'name',
  'domain',
  'kind',
  'source',
  'region',
  'memoryMb',
  'timeoutSeconds',
  'cpu',
  'concurrency',
  'minInstances',
  'maxInstances',
  'invoker',
  'retry',
  'path',
  'topic',
  'schedule',
  'timeZone',
  'secrets',
  'serviceAccount',
  'nonDefault',
]

export function formatTsv(records) {
  const cell = (value) => {
    if (!isSet(value) && value !== false) return ''
    if (Array.isArray(value)) return value.join('|')
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return [
    TSV_COLUMNS.join('\t'),
    ...records.map((r) => TSV_COLUMNS.map((c) => cell(r[c])).join('\t')),
  ].join('\n')
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: 'text', dist: DEFAULT_DIST, index: null }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=')
    if (flag === '--json' || flag === '--tsv' || flag === '--md') args.mode = flag.slice(2)
    else if (flag === '--dist') args.dist = inline ?? argv[++i]
    else if (flag === '--index') args.index = inline ?? argv[++i]
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!args.dist) throw new Error('--dist takes a path')
  const dist = isAbsolute(args.dist) ? args.dist : resolve(process.cwd(), args.dist)
  args.entry = dist.endsWith('.js') ? dist : join(dist, 'index.js')
  args.index = args.index
    ? resolve(process.cwd(), args.index)
    : join(dirname(args.entry), '..', 'src', 'index.ts')
  return args
}

function loadBundle(entry) {
  if (!existsSync(entry))
    throw new Error(`${entry} does not exist — run pnpm --filter @linyup/functions build`)
  const require = createRequire(entry)
  // Anything a module prints while loading would corrupt --json / --tsv.
  const { log, info } = console
  console.log = console.info = (...args) => console.error(...args)
  let mod
  try {
    mod = require(entry)
  } finally {
    console.log = log
    console.info = info
  }
  // The SAME SDK instance the bundle configured, resolved from the bundle's
  // own location — a copy resolved from here would hold no global options.
  let globals = {}
  try {
    globals = renderGlobals(require('firebase-functions/v2/options').getGlobalOptions())
  } catch {
    // Context only: without it every maxInstances reads as non-default.
  }
  return { mod, globals }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  let bundle
  let parsed
  try {
    bundle = loadBundle(args.entry)
    parsed = parseIndexExports(readFileSync(args.index, 'utf8'))
  } catch (err) {
    console.error(`functions-inventory: could not load — ${err.stack ?? err.message}`)
    return { code: 2, output: '' }
  }

  const records = Object.entries(bundle.mod)
    .filter(([, value]) => value?.__endpoint)
    .map(([name, value]) =>
      toRecord(name, value.__endpoint, parsed.exports.get(name), bundle.globals)
    )
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))

  const summary = summarise(records)
  const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/')
  const meta = {
    entry: rel(args.entry),
    built: `${statSync(args.entry).mtime.toISOString().slice(0, 16)}Z`,
    globals: bundle.globals,
  }
  const mismatch = crossCheck(
    records.map((r) => r.name),
    parsed.exports.keys()
  )

  let output
  if (args.mode === 'json')
    output = JSON.stringify({ ...meta, mismatch, summary, functions: records }, null, 2)
  else if (args.mode === 'tsv') output = formatTsv(records)
  else if (args.mode === 'md') output = formatMarkdown(summary, meta)
  else output = formatText(summary, meta)

  const failed = mismatch.onlyInBundle.length || mismatch.onlyInIndex.length
  if (failed) {
    const bar = '!'.repeat(78)
    console.error(`\n${bar}\nBUNDLE AND ${rel(args.index)} DISAGREE`)
    if (mismatch.onlyInBundle.length)
      console.error(
        `  deployed by the bundle, not re-exported by the index (domain reads "?"):\n    ${mismatch.onlyInBundle.join(', ')}`
      )
    if (mismatch.onlyInIndex.length)
      console.error(
        `  re-exported by the index, not a function in the bundle (stale dist? not a function?):\n    ${mismatch.onlyInIndex.join(', ')}`
      )
    if (parsed.unparsed.length)
      console.error(
        `  export statements this parser does not read:\n    ${parsed.unparsed.join('\n    ')}`
      )
    console.error(bar)
  }
  if (parsed.duplicates.length)
    console.error(`note: re-exported more than once by the index: ${parsed.duplicates.join(', ')}`)
  return { code: failed ? 1 : 0, output }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result
  try {
    result = main()
  } catch (err) {
    console.error(`functions-inventory: ${err.message}`)
    result = { code: 2, output: '' }
  }
  // firebase-admin and gRPC handles opened by the bundle keep node alive, so
  // the exit is explicit — after stdout has drained, or a piped --json is cut.
  process.stdout.write(result.output ? `${result.output}\n` : '', () => process.exit(result.code))
}
