// NAMES THAT MUST NEVER DROP OUT OF src/index.ts.
//
// The deploy runs `firebase deploy --force`, so an export removed from index.ts
// is DELETED IN THE CLOUD with no prompt — and `pnpm functions:ready` cannot see
// a function that no longer exists, so the run stays green. For most functions
// that is the intended way to retire one. For the names below it is an outage
// nobody in this repo can undo alone, because something OUTSIDE the repo holds
// the name: a URL pasted into a dashboard, a Cloud Tasks queue path, a store
// binary on somebody's phone.
//
// The callable consolidation (docs/functions-consolidation-plan.md) is what
// makes this urgent: its whole method is "list the callable in a router, later
// delete the standalone export", and this file is the gate on the second step.
// Removing a name from FROZEN is a deliberate act, done in the same PR as the
// removal, with the evidence its group's comment asks for in the PR body.
//
// It reads SOURCE, so: line endings are normalized (Windows checkouts are
// CRLF, CI is LF), comments are stripped (index.ts carries a commented-out
// export), and the hand-kept list is RE-DERIVED where the source can say who
// holds a name — a new webhook, task handler or mobile call site that nobody
// listed fails here rather than being forgotten. The extractors are themselves
// tested against synthetic source below, including the shapes they must NOT
// miss: a source-reading pin is green on the day it is written whether or not
// it works (CLAUDE.md, "A guard that SAMPLES a race is not a guard").
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(__dirname, '..')
/** SRC → packages/functions → packages → the worktree root. */
const ROOT = join(SRC, '..', '..', '..')
const MOBILE = join(ROOT, 'apps', 'mobile')

// ── THE LIST ────────────────────────────────────────────────────────────────
//
// Grouped by WHO holds the name outside this repo, because that is who has to
// be dealt with before a name can go.

const FROZEN: { holder: string; names: string[] }[] = [
  {
    // scripts/stripe-sync.ts matches webhook endpoints BY FUNCTION NAME. A
    // rename registers a NEW endpoint with a NEW signing secret and leaves the
    // old one pointing at nothing.
    holder: 'Stripe, through scripts/stripe-sync.ts',
    names: ['handleStripeWebhook', 'handleConnectWebhook'],
  },
  {
    // Typed or pasted by each studio into ITS OWN account or tool
    // (`…/handleTeamStripeWebhook?teamId=`, docs/payment-contact-studio.md).
    // Linyup cannot edit those; every studio would have to.
    holder: 'each studio, in its own Stripe / Payrexx / third-party account',
    names: ['handleTeamStripeWebhook', 'handlePayrexxWebhook', 'inboundWebhook'],
  },
  {
    // Registered by hand in a vendor console, not by any script here.
    holder: 'the Brevo dashboard, App Store Connect and the Meta app',
    names: ['handleBrevoWebhook', 'handleAppStoreWebhook', 'handleWhatsAppWebhook'],
  },
  {
    // `api` is the target of the Hosting rewrite in firebase.json (re-derived
    // below); getInTouchForm's URL is called by the public bio-link pages.
    holder: 'Hosting rewrites and public pages',
    names: ['api', 'getInTouchForm'],
  },
  {
    // The Pub/Sub topic contract in infra/modules/budget, and the Identity
    // Platform blocking-function registration.
    holder: 'Terraform and Identity Platform',
    names: ['handleBudgetNotification', 'beforeSignup'],
  },
  {
    // The Cloud Tasks queue path IS the function name —
    // locations/europe-west6/functions/<name> — and tasks already enqueued
    // (a delayed rule can wait days) are addressed to it.
    holder: 'Cloud Tasks queues',
    names: [
      'executeDelayedRule',
      'financeReportForTeam',
      'heldPlansForTeam',
      'noShowsForTeam',
      'refreshTeamSentimentRound',
      'remindersForTeam',
      'runSeriesTeardown',
      'runTarif595BulkIssue',
      'scheduledRulesForTeam',
      'sendHeldWhatsApp',
      'weeklyReportForTeam',
    ],
  },
  {
    // Called by the MOBILE app, so the name lives in store binaries that cannot
    // be updated: an OTA reaches only installs whose native fingerprint
    // matches. A name here is removable only when
    // `app_settings/mobile.min_supported_version` has passed the first build
    // that routes it through `callFunction`, AND thirty consecutive days show
    // zero requests on the standalone (alias) service. The plan →
    // "Compatibility and aliases".
    //
    // Deliberately NOT pruned when the current mobile source stops calling a
    // name: the binaries in the field are what matter, not the working tree.
    holder: 'mobile store binaries',
    names: [
      'bookAppointment',
      'bookSession',
      'cancelBooking',
      'cancelContactDeletion',
      'getContactQR',
      'getMyAttendance',
      'getMyBookings',
      'getMyReferralCode',
      'getMyReferralStats',
      'listAvailability',
      'loginContactWithCode',
      'requestContactDeletion',
      'requestContactUpdate',
      'selfCheckIn',
      'sendContactVerificationCode',
      'setMyWhatsAppConsent',
      'switchActiveContact',
    ],
  },
]

const FROZEN_NAMES = new Set(FROZEN.flatMap((g) => g.names))

// ── Reading source ──────────────────────────────────────────────────────────

const readText = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

/** CODE only: block comments and whole-line `//` comments removed. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, keep, out)
    else if (keep(full)) out.push(full)
  }
  return out
}

const isTestFile = (f: string) =>
  /\.(test|spec|rules-test)\.tsx?$/.test(f) || /[\\/]__(tests|mocks)__[\\/]/.test(f)
const isSource = (f: string) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !isTestFile(f)
const rel = (f: string) => relative(ROOT, f).split(sep).join('/')

/** Names re-exported by an index.ts — `export { a, b as c } from '…'`. */
function exportedNames(indexSource: string): string[] {
  const names: string[] = []
  for (const m of code(indexSource).matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim()
      if (!spec || spec.startsWith('type ')) continue
      const alias = spec.split(/\s+as\s+/)
      names.push(alias[alias.length - 1].trim())
    }
  }
  return names
}

/** `export const X = kind(` — tolerating a type annotation, a `ns.` prefix,
 *  generics and a line break after `=`. */
function definedBy(source: string, kind: string): string[] {
  const re = new RegExp(
    `export\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+?)?=\\s*(?:[\\w$]+\\.)*${kind}\\s*[<(]`,
    'g'
  )
  return [...code(source).matchAll(re)].map((m) => m[1])
}

/** Every call of `kind`, however its result is bound. */
function callCount(source: string, kind: string): number {
  return [...code(source).matchAll(new RegExp(`(?<![\\w$])${kind}\\s*[<(]`, 'g'))].length
}

/**
 * The callable NAME at each call of `callee` — `argIndex` says which argument
 * holds it. `null` for a call whose name is not a string literal. Skips
 * generics (nested, multi-line, `=>` inside) and splits arguments at top-level
 * commas only.
 */
function callableNames(source: string, callee: string, argIndex: number): (string | null)[] {
  const text = code(source)
  const found: (string | null)[] = []
  const re = new RegExp(`(?<![\\w$.])${callee}(?![\\w$])`, 'g')
  for (const m of text.matchAll(re)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    let i = m.index + callee.length
    const skipSpace = () => {
      while (/\s/.test(text[i] ?? '')) i++
    }
    skipSpace()
    if (text[i] === '<') {
      let depth = 0
      for (; i < text.length; i++) {
        if (text[i] === '<') depth++
        else if (text[i] === '>' && text[i - 1] !== '=') depth--
        if (depth === 0) break
      }
      i++
      skipSpace()
    }
    if (text[i] !== '(') continue // an import specifier or a bare reference, not a call
    const args: string[] = ['']
    let depth = 0
    let quote: string | null = null
    for (i++; i < text.length; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === '\\') args[args.length - 1] += ch + (text[++i] ?? '')
        else {
          if (ch === quote) quote = null
          args[args.length - 1] += ch
        }
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
      if (ch === '(' || ch === '[' || ch === '{') depth++
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break
        depth--
      }
      if (ch === ',' && depth === 0) args.push('')
      else args[args.length - 1] += ch
    }
    const literal = /^(['"`])([\w$]+)\1$/.exec((args[argIndex] ?? '').trim())
    found.push(literal ? literal[2] : null)
  }
  return found
}

/** Every `functionId` a firebase.json rewrite names (either spelling). */
function rewriteTargets(firebaseJson: string): string[] {
  const out: string[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'function' && typeof value === 'string') out.push(value)
      else if (key === 'functionId' && typeof value === 'string') out.push(value)
      else visit(value)
    }
  }
  visit(JSON.parse(firebaseJson))
  return out
}

// ── The extractors, against source they must and must not match ─────────────

describe('frozen functions — the extractors see what they claim to see', () => {
  it('exportedNames: multi-line lists, aliases, and NOT comments or type exports', () => {
    const src = [
      "export { a } from './a'",
      'export {',
      '  b,',
      '  c as d,',
      '  type E,',
      "} from './b'",
      "// export { commentedOut } from './c'",
      "/* export { alsoCommentedOut } from './d' */",
    ].join('\r\n')
    assert.deepEqual(exportedNames(src.replace(/\r\n/g, '\n')), ['a', 'b', 'd'])
  })

  it('definedBy: annotation, namespace prefix, generics, a break after `=`', () => {
    const src = [
      'export const plain = onRequest(async (req, res) => {})',
      'export const annotated: HttpsFunction = onRequest({ cors: true }, h)',
      'export const generic = onTaskDispatched<Payload>(',
      'export const broken =',
      '  onTaskDispatched<Payload>({ retryConfig }, h)',
      'export const spaced = https.onRequest(h)',
      '// export const commented = onRequest(h)',
      'export const router = callableRouter("rpcMember", {}, {})',
      'export const callable = onCall(h)',
      'const notExported = onRequest(h)',
    ].join('\n')
    assert.deepEqual(definedBy(src, 'onRequest'), ['plain', 'annotated', 'spaced'])
    assert.deepEqual(definedBy(src, 'onTaskDispatched'), ['generic', 'broken'])
    // …and the un-exported one is still COUNTED, which is how it gets caught.
    assert.equal(callCount(src, 'onRequest'), 4)
  })

  it('callableNames: generics, line breaks, either quote — and null for a computed name', () => {
    const src = [
      "import { httpsCallable, httpsCallableFromURL } from 'firebase/functions'",
      "const a = httpsCallable(getFunctions(), 'alpha')",
      'const b = httpsCallable<',
      '  { teamId: string; at: (x: number) => void },',
      '  Result<A, B>',
      '>(getFunctions(), "beta")',
      'const c = httpsCallable(',
      '  getFunctions(undefined, region),',
      "  'gamma',",
      '  { timeout: 1 }',
      ')',
      'const d = httpsCallable(getFunctions(), name, options)',
      "// const e = httpsCallable(getFunctions(), 'inAComment')",
      "const f = httpsCallableFromURL(getFunctions(), 'https://x/notAName')",
      "export function callFunction<Req, Res>(name: string) { return callFunction('recursed') }",
      "const g = callFunction<In, Out>('delta', { timeout: 1 })",
      'const h = callFunction(someVariable)',
    ].join('\n')
    assert.deepEqual(callableNames(src, 'httpsCallable', 1), ['alpha', 'beta', 'gamma', null])
    assert.deepEqual(callableNames(src, 'callFunction', 0), ['recursed', 'delta', null])
  })

  it('rewriteTargets: both spellings, at any depth', () => {
    const json = JSON.stringify({
      hosting: [
        { rewrites: [{ source: '**', function: { functionId: 'api', region: 'x' } }] },
        {
          rewrites: [
            { source: '/f', function: 'legacyForm' },
            { source: '**', destination: '/' },
          ],
        },
      ],
    })
    assert.deepEqual(rewriteTargets(json), ['api', 'legacyForm'])
  })
})

// ── The pins ────────────────────────────────────────────────────────────────

describe('frozen functions — names held outside this repo stay exported', () => {
  const indexSource = readText(join(SRC, 'index.ts'))
  const exported = new Set(exportedNames(indexSource))
  const functionSources = walk(SRC, isSource).map((file) => ({ file, source: readText(file) }))

  it('index.ts is readable by this test: only `export { … } from`, never `export *`', () => {
    assert.ok(exported.size > 0, 'no exports were extracted from src/index.ts')
    assert.doesNotMatch(
      code(indexSource),
      /export\s*\*/,
      'an `export *` in src/index.ts hides names from every source-reading guard — list them'
    )
  })

  it('no name is listed under two holders', () => {
    const all = FROZEN.flatMap((g) => g.names)
    const twice = all.filter((n, i) => all.indexOf(n) !== i)
    assert.deepEqual(twice, [])
  })

  for (const group of FROZEN) {
    it(`still exports every name held by ${group.holder}`, () => {
      const missing = group.names.filter((n) => !exported.has(n))
      assert.deepEqual(
        missing,
        [],
        `src/index.ts no longer exports ${missing.join(', ')}. The deploy runs with --force, so ` +
          `that DELETES the function in the cloud, and the name is held by ${group.holder}.`
      )
    })
  }

  // THE ONES THAT CATCH A NEW NAME. Each kind below is bound to something
  // outside the repo by its very type, so a new one belongs on the list the day
  // it is written. Routers built by `callableRouter(` are not `onRequest(`
  // definitions and are deliberately not swept up: nothing external holds a
  // router's name but this repo's own clients, through CALLABLE_ROUTES.
  const EXTERNALLY_BOUND_KINDS = [
    'onRequest',
    'onTaskDispatched',
    'onMessagePublished',
    'beforeUserCreated',
    'beforeUserSignedIn',
  ]
  /** Where a kind is CALLED without defining a deployed function of its own. */
  const FACTORIES: Record<string, string[]> = {
    onRequest: ['packages/functions/src/utils/callableRouter.ts'],
  }
  /** Kinds this codebase may legitimately not use at all. */
  const MAY_BE_ABSENT = new Set(['beforeUserSignedIn'])

  for (const kind of EXTERNALLY_BOUND_KINDS) {
    it(`every ${kind} function is on the frozen list`, () => {
      const derived: string[] = []
      for (const { file, source } of functionSources) {
        const names = definedBy(source, kind)
        derived.push(...names)
        // A call this test cannot NAME is a function it cannot protect:
        // `const x = onRequest(…); export { x }`, a handler map, a wrapper.
        if (!(FACTORIES[kind] ?? []).includes(rel(file))) {
          assert.equal(
            callCount(source, kind),
            names.length,
            `${rel(file)} calls ${kind} in a shape other than \`export const X = ${kind}(\` — ` +
              'write it that way, or teach this test the new shape'
          )
        }
      }
      if (!MAY_BE_ABSENT.has(kind)) {
        assert.ok(
          derived.length > 0,
          `found no ${kind} definitions at all — the extractor is broken`
        )
      }
      const unlisted = derived.filter((n) => !FROZEN_NAMES.has(n))
      assert.deepEqual(
        unlisted,
        [],
        `${unlisted.join(', ')}: a ${kind} function is bound to something outside this repo by ` +
          'its name. Add it to FROZEN under whoever holds that name.'
      )
    })
  }

  it('every function a firebase.json rewrite targets is on the frozen list', () => {
    const targets = rewriteTargets(readText(join(ROOT, 'firebase.json')))
    assert.ok(
      targets.length > 0,
      'found no function rewrites in firebase.json — the extractor is broken'
    )
    assert.deepEqual(
      targets.filter((n) => !FROZEN_NAMES.has(n)),
      []
    )
  })

  it('every callable the mobile app names is on the frozen list', () => {
    const files = walk(MOBILE, isSource)
    assert.ok(files.length > 0, 'found no mobile sources — the path is wrong')
    // The one module allowed to pass a name it was GIVEN: the wrapper itself.
    const WRAPPER = 'apps/mobile/src/services/callFunction.ts'
    const named: string[] = []
    for (const file of files) {
      const source = readText(file)
      const sites = [
        ...callableNames(source, 'httpsCallable', 1),
        ...callableNames(source, 'callFunction', 0),
      ]
      for (const name of sites) {
        if (name !== null) named.push(name)
        else {
          assert.equal(
            rel(file),
            WRAPPER,
            `${rel(file)} calls a callable by a COMPUTED name. Spell it as a string literal: a ` +
              'name this test cannot read is a name it cannot keep deployed.'
          )
        }
      }
    }
    assert.ok(named.length > 0, 'found no mobile callable call sites — the extractor is broken')
    const unlisted = [...new Set(named)].filter((n) => !FROZEN_NAMES.has(n))
    assert.deepEqual(
      unlisted,
      [],
      `the mobile app calls ${unlisted.join(', ')}, so the name will live in store binaries. ` +
        'Add it to the mobile group of FROZEN.'
    )
  })
})
