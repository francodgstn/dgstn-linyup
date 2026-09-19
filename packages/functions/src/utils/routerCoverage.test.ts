// THE ROUTER TABLES AND THE SHARED ROUTE MAP SAY THE SAME THING.
//
// A routed call is built by the CLIENT from `CALLABLE_ROUTES` in @linyup/shared
// (`{base}/{router}/{callableName}`) and answered by a SERVER table in
// src/routers/. Nothing at runtime connects the two: a name the map routes to a
// router whose table lacks it is a 404 in production, for every client at once,
// found by the first user to press the button. This file is that connection.
//
// The router set is RE-DERIVED — every module in src/routers/ is loaded and
// asked what it exports — rather than listed here, so a router added in a later
// phase is covered the day its file exists. What a router serves is read off
// the deployed value itself (`routerMembers`), not parsed from its source.
//
// index.ts is NOT imported: loading every function in the codebase to check a
// handful of names is slow and drags in parameters that want a deploy
// environment. It is read as source instead (line endings normalised, comments
// stripped), and the extractors are checked against synthetic source below.
//
// NOT ENFORCED YET, ON PURPOSE: that every callable is routed. Routing moves a
// domain at a time and an unrouted callable is simply called the way it always
// was, so full coverage — every `onCall` in exactly one router or on an
// explicit not-routed list — switches on when the migration is nearly complete.
// docs/functions-consolidation-plan.md → "Phases".
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { CALLABLE_ROUTES, ROUTER_NAMES, routerForCallable } from '@linyup/shared'
import {
  isCallableRouter,
  routerMembers,
  routerNameOf,
  type CallableRouterFunction,
} from './callableRouter'

const SRC = join(__dirname, '..')
const ROUTERS_DIR = join(SRC, 'routers')

const readText = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

/** CODE only: block comments and whole-line `//` comments removed. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** A module specifier, resolved from the file that wrote it, relative to src/
 *  and without an extension — so `./appointments/window` written in index.ts
 *  and `../appointments/window` written in routers/x.ts compare equal. */
function moduleKey(fromFile: string, specifier: string): string {
  return relative(SRC, resolve(join(fromFile, '..'), specifier))
    .split(sep)
    .join('/')
}

/** Is `definedIn` (a file key) what the specifier `moduleKeyOf` resolves to? A
 *  specifier names a file, or a FOLDER — `./ops` is ops/index.ts — and a folder's
 *  barrel may re-export from a file beside it (`./booking` → booking/myBookings.ts),
 *  so a definition anywhere under that folder counts. A namesake in ANOTHER folder
 *  still fails, which is the defect this guards. */
function definesModule(moduleKeyOf: string, definedIn: string): boolean {
  return definedIn === moduleKeyOf || definedIn.startsWith(moduleKeyOf + '/')
}

/** The same key, for a module's own file. */
const fileKey = (file: string) => relative(SRC, file).split(sep).join('/').replace(/\.ts$/, '')

/** `export { a, b as c } from '…'` or `import { a, b as c } from '…'` → the
 *  LOCAL/EXPORTED name and the module it comes from. Relative modules only. */
function namedBindings(
  file: string,
  source: string,
  keyword: 'export' | 'import'
): Map<string, string> {
  const out = new Map<string, string>()
  const re = new RegExp(`${keyword}\\s*\\{([^}]*)\\}\\s*from\\s*['"](\\.[^'"]*)['"]`, 'g')
  for (const m of code(source).matchAll(re)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim()
      if (!spec || spec.startsWith('type ')) continue
      const alias = spec.split(/\s+as\s+/)
      out.set(alias[alias.length - 1].trim(), moduleKey(file, m[2]))
    }
  }
  return out
}

/** `export const X = onCall(` — annotation, generics, a break after `=`. */
function onCallNames(source: string): string[] {
  const re = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=\s*(?:[\w$]+\.)*onCall\s*[<(]/g
  return [...code(source).matchAll(re)].map((m) => m[1])
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.ts$/.test(entry.name) && !/\.(test|rules-test|d)\.ts$/.test(entry.name))
      out.push(full)
  }
  return out
}

describe('router coverage — the extractors see what they claim to see', () => {
  it('namedBindings: multi-line, aliases, and the SAME key from two directories', () => {
    const index = join(SRC, 'index.ts')
    const router = join(SRC, 'routers', 'x.ts')
    const exported = namedBindings(
      index,
      [
        "export { a } from './m/one'",
        'export {',
        '  b,',
        '  c as d,',
        "} from './m/two'",
        "// export { z } from './m/z'",
      ].join('\n'),
      'export'
    )
    assert.deepEqual(
      [...exported],
      [
        ['a', 'm/one'],
        ['b', 'm/two'],
        ['d', 'm/two'],
      ]
    )
    const imported = namedBindings(
      router,
      [
        "import { a } from '../m/one'",
        "import { b } from '../m/elsewhere'",
        "import { x } from '@linyup/shared'",
      ].join('\n'),
      'import'
    )
    assert.deepEqual(
      [...imported],
      [
        ['a', 'm/one'],
        ['b', 'm/elsewhere'],
      ]
    )
    // The point of the key: same module ⇒ equal, a namesake elsewhere ⇒ not.
    assert.equal(imported.get('a'), exported.get('a'))
    assert.notEqual(imported.get('b'), exported.get('b'))
  })

  it('definesModule: a file, a folder index, a barrel — and never a namesake elsewhere', () => {
    assert.ok(definesModule('appointments/window', 'appointments/window'))
    assert.ok(definesModule('ops', 'ops/index'))
    assert.ok(definesModule('booking', 'booking/myBookings'))
    assert.ok(!definesModule('ops', 'opsLegacy/index'))
    assert.ok(!definesModule('ops', 'contacts/ops'))
    assert.ok(!definesModule('booking/myBookings', 'booking/index'))
  })

  it('onCallNames: annotation, generics, a break after `=` — and nothing that is not an onCall', () => {
    const src = [
      'export const plain = onCall(async (request) => {})',
      'export const withOpts = onCall({ enforceAppCheck: true }, h)',
      'export const generic = onCall<In, Out>(h)',
      'export const annotated: CallableFunction<In, Out> = onCall(h)',
      'export const broken =',
      '  onCall(h)',
      'export const http = onRequest(h)',
      'export const genkit = onCallGenkit(h)',
      '// export const commented = onCall(h)',
      'const notExported = onCall(h)',
    ].join('\n')
    assert.deepEqual(onCallNames(src), ['plain', 'withOpts', 'generic', 'annotated', 'broken'])
  })
})

describe('router coverage — src/routers agrees with CALLABLE_ROUTES', () => {
  // Every router module, loaded. Keyed by EXPORT name, which is the deployed
  // function's name and therefore the path segment a client has to use.
  const routers = new Map<string, { fn: CallableRouterFunction; file: string }>()
  const routerFiles = walk(ROUTERS_DIR)

  // Loaded in a hook, not at collection time: a router that throws at load
  // (callableRouter refuses a non-onCall member) then fails THIS block by name
  // instead of taking the whole mocha run down before a single test reports.
  before(function () {
    this.timeout(60_000) // ts-node compiles the members' whole import graph
    for (const file of routerFiles) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(file) as Record<string, unknown>
      for (const [exportName, value] of Object.entries(mod)) {
        if (isCallableRouter(value)) routers.set(exportName, { fn: value, file })
      }
    }
  })

  const indexFile = join(SRC, 'index.ts')
  const indexExports = namedBindings(indexFile, readText(indexFile), 'export')
  const routedNames = Object.keys(CALLABLE_ROUTES)

  it('found the routers, the route map and the index exports it is about to compare', () => {
    assert.ok(routerFiles.length > 0, 'src/routers holds no modules — the path is wrong')
    assert.ok(routers.size > 0, 'no module in src/routers exports a callableRouter function')
    assert.ok(routedNames.length > 0, 'CALLABLE_ROUTES is empty')
    assert.ok(indexExports.size > 0, 'no exports were extracted from src/index.ts')
  })

  it('a router is exported under the name it was built with', () => {
    // `callableRouter('rpcStudio', …)` exported as `rpcStaff` deploys as
    // rpcStaff while every client asks for /rpcStudio/….
    for (const [exportName, { fn }] of routers) {
      assert.equal(routerNameOf(fn), exportName)
    }
  })

  it('every router is a declared RouterName, and is deployed — exported from index.ts, from its own module', () => {
    for (const [name, { file }] of routers) {
      assert.ok(
        (ROUTER_NAMES as readonly string[]).includes(name),
        `${name} is not in ROUTER_NAMES`
      )
      assert.equal(
        indexExports.get(name),
        fileKey(file),
        `${name} is built in src/routers but src/index.ts does not export it from there, so it is never deployed`
      )
    }
  })

  it('every router exported from index.ts is one this test loaded, and a declared RouterName', () => {
    const fromRouters = [...indexExports]
      .filter(([, mod]) => mod.startsWith('routers/'))
      .map(([name]) => name)
    assert.ok(fromRouters.length > 0, 'src/index.ts exports nothing from ./routers/')
    for (const name of fromRouters) {
      assert.ok(
        (ROUTER_NAMES as readonly string[]).includes(name),
        `${name} is not in ROUTER_NAMES`
      )
      assert.ok(
        routers.has(name),
        `${name} is exported from ./routers/ but is not a callableRouter function`
      )
    }
  })

  it('each router serves exactly the names CALLABLE_ROUTES sends to it', () => {
    for (const [name, { fn }] of routers) {
      const served = [...routerMembers(fn)].sort()
      const routed = routedNames.filter((n) => CALLABLE_ROUTES[n] === name).sort()
      assert.deepEqual(
        served,
        routed,
        `${name}: the table (actual) and CALLABLE_ROUTES (expected) disagree. A name only in the map ` +
          'is a 404 for every client; a name only in the table is dead weight nobody can reach.'
      )
    }
  })

  it('CALLABLE_ROUTES never points at a router that does not exist', () => {
    for (const name of routedNames) {
      const router = routerForCallable(name)
      assert.ok(
        router !== null && routers.has(router),
        `${name} → ${router}, which src/routers does not build`
      )
    }
  })

  it('no callable sits in two routers', () => {
    const seen = new Map<string, string>()
    for (const [router, { fn }] of routers) {
      for (const member of routerMembers(fn)) {
        assert.equal(
          seen.get(member),
          undefined,
          `${member} is in both ${seen.get(member)} and ${router}`
        )
        seen.set(member, router)
      }
    }
  })

  it('no callable shares a name with a router', () => {
    // The name is the LAST path segment; a request that names no callable ends
    // in the router's own name wherever the platform leaves the prefix on.
    for (const { fn } of routers.values()) {
      for (const member of routerMembers(fn)) {
        assert.ok(
          !(ROUTER_NAMES as readonly string[]).includes(member),
          `${member} is also a router name`
        )
      }
    }
  })

  it('every member is the SAME onCall that index.ts still exports under that name', () => {
    const onCalls = new Map<string, string[]>()
    for (const file of walk(SRC)) {
      for (const name of onCallNames(readText(file))) {
        onCalls.set(name, [...(onCalls.get(name) ?? []), fileKey(file)])
      }
    }
    assert.ok(onCalls.size > 0, 'found no onCall definitions at all — the extractor is broken')

    for (const [router, { fn, file }] of routers) {
      const imports = namedBindings(file, readText(file), 'import')
      for (const member of routerMembers(fn)) {
        const exportedFrom = indexExports.get(member)
        assert.ok(
          exportedFrom !== undefined,
          `${router} serves ${member}, which src/index.ts does not export. While the name is in its ` +
            'alias window the standalone function must stay deployed (utils/frozenFunctions.test.ts).'
        )
        // Same module on both sides ⇒ the same object ⇒ no duplicated logic,
        // and never a namesake from another folder. A renamed table key
        // (`{ other: listAvailability }`) has no import of its own and fails here.
        assert.equal(
          imports.get(member),
          exportedFrom,
          `${router} must take ${member} from the module index.ts exports it from (${exportedFrom})`
        )
        assert.ok(
          (onCalls.get(member) ?? []).some((file) => definesModule(exportedFrom, file)),
          `${member} is not an \`export const ${member} = onCall(\` in ${exportedFrom}`
        )
      }
    }
  })
})
