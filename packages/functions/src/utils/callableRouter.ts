// ─── Callable routers: many `onCall`s behind ONE deployed function ───────────
//
// THE PROBLEM THIS EXISTS FOR. Every gen2 function is its own Cloud Run
// service, and nearly every recurring deploy failure scales with how many there
// are: the rate quota, the CPU capacity quota that reports SUCCESS while
// revisions are refused, the deploy that abandons a whole memory-size group.
// Callables are most of the count and nothing outside the repo binds to their
// names the way a webhook URL or a task queue does, so they are the part that
// can fold. The plan, the grouping and the exit criteria for the old names are
// docs/functions-consolidation-plan.md.
//
// HOW, AND WHY SO LITTLE IS WRITTEN HERE. A v2 `onCall(...)` value is already an
// Express-style `(req, res)` handler (`CallableFunction extends HttpsFunction`),
// and the SDK's `onCallHandler` verifies the ID token, enforces App Check, runs
// the member's own CORS middleware and serialises `HttpsError` IN-PROCESS. So a
// router is an `onRequest` that reads the callable's name from the LAST path
// segment — `{base}/{router}/{callableName}`, built by `callableRouteUrl` in
// @linyup/shared — and hands `(req, res)` to the existing value, untouched.
// Auth, App Check and error codes are the SDK's, not a re-implementation, and a
// member keeps its own `enforceAppCheck` and `cors` because those live in the
// closure `onCall` built, not in the deployed service's configuration.
//
// ── WHAT DOES NOT SURVIVE ROUTING: THE MEMBER'S RUNTIME OPTIONS ─────────────
//
// `memory`, `timeoutSeconds`, `cpu`, `concurrency`, `maxInstances` and
// `minInstances` are properties of the deployed SERVICE. Reached through a
// router, a member runs under the ROUTER's values and its own are ignored —
// silently, with no error. So a router's options must cover its hungriest
// member, and a member that genuinely needs more belongs in a router sized for
// it rather than in a general one.
//
// ── NO `invoker` ────────────────────────────────────────────────────────────
//
// The router sets none, exactly as today's callables set none: the service is
// publicly invocable and the gate is the ID token / App Check verification the
// member performs. Routing carries that posture over unchanged; it neither
// tightens nor loosens it.
//
// ── A KNOWN NAME IS PASSED THROUGH WHOLE, EVERY METHOD ──────────────────────
//
// Including OPTIONS: the member's own cors middleware answers its preflight
// with the member's own origin policy. The router answers a request itself
// only when the name is unknown, and then with the callable protocol's error
// body so the client SDK surfaces `functions/not-found` rather than an opaque
// `internal`.

import * as logger from 'firebase-functions/logger'
import { HttpsError, onRequest } from 'firebase-functions/v2/https'
import type { CallableFunction, HttpsFunction, HttpsOptions } from 'firebase-functions/v2/https'
import type { RouterName } from '@linyup/shared'

type RouterRequest = Parameters<HttpsFunction>[0]
type RouterResponse = Parameters<HttpsFunction>[1]

/** What a table member has to be at DISPATCH time: something that takes
 *  `(req, res)`. `callableRouter` demands real `onCall` values on top of this;
 *  the looser type is what lets the dispatch be unit-tested with plain fakes. */
export type RouterMember = (req: RouterRequest, res: RouterResponse) => void | Promise<void>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallableTable = Record<string, CallableFunction<any, any>>

/** A deployed router. `__router` and `__members` are own, non-enumerable and
 *  frozen — they exist so a test can ask a router what it serves without
 *  parsing source (utils/routerCoverage.test.ts). */
export type CallableRouterFunction = HttpsFunction & {
  readonly __router: RouterName
  readonly __members: readonly string[]
}

/** The line that becomes a log-based metric once the standalone names are gone
 *  (the plan → "Compatibility and aliases"). The field names `router` and
 *  `callable` are the metric's label extractors: renaming either breaks it
 *  without failing anything. */
export const ROUTER_LOG_MESSAGE = 'callable-router'

export interface RouterLogLine {
  router: RouterName
  callable: string
  status: number
  ms: number
}

/**
 * The callable's name: the last non-empty path segment, percent-decoded.
 * `null` when there is none or it is malformed. Works on cloudfunctions.net,
 * where the path the service sees is `/name`, and wherever a prefix is left in
 * front of it, because only the LAST segment is read.
 */
export function resolveCallableName(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null
  const bare = path.split(/[?#]/, 1)[0]
  const segments = bare.split('/').filter((s) => s.length > 0)
  const last = segments[segments.length - 1]
  if (last === undefined) return null
  try {
    const name = decodeURIComponent(last)
    return name.length > 0 ? name : null
  } catch {
    // `%E0%A4%A` and friends — a URIError must be a 404, not an unhandled throw.
    return null
  }
}

/**
 * CORS for the router's OWN answers only — an unknown name. Permissive on
 * purpose and safe because of what it guards: a constant error body, no
 * cookies (the callable protocol authenticates with a header), nothing
 * reflected from the request but the header NAMES the browser asked about.
 */
function allowAnyOrigin(req: RouterRequest, res: RouterResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')
  if (req.method !== 'OPTIONS') return
  res.setHeader('Access-Control-Allow-Methods', 'POST')
  const asked = req.headers?.['access-control-request-headers']
  if (typeof asked === 'string' && asked.length > 0 && asked.length <= 512) {
    res.setHeader('Access-Control-Allow-Headers', asked)
  }
}

function respondNotFound(router: RouterName, req: RouterRequest, res: RouterResponse): void {
  allowAnyOrigin(req, res)
  if (req.method === 'OPTIONS') {
    // 204, not 404: a refused preflight reaches the caller as a CORS failure,
    // which the client SDK reports as `internal`. Letting it through means the
    // POST that follows gets the NOT_FOUND below and the caller can read it.
    res.status(204).send('')
    return
  }
  // The SDK's own error type, so the body and the HTTP status are whatever the
  // callable protocol says they are rather than a copy of it.
  const err = new HttpsError('not-found', `No such callable on ${router}`)
  res.status(err.httpErrorCode.status).send({ error: err.toJSON() })
}

/**
 * The dispatch, without `onRequest` around it — what the unit tests drive.
 * `log` is injectable for the same reason.
 */
export function createRouterHandler(
  router: RouterName,
  table: Readonly<Record<string, RouterMember>>,
  log: (line: RouterLogLine) => void = (line) => logger.info(ROUTER_LOG_MESSAGE, { ...line })
): RouterMember {
  // A Map of the table's OWN enumerable keys: `constructor`, `__proto__` and
  // `hasOwnProperty` are reachable on a plain object and must never dispatch.
  const members = new Map<string, RouterMember>(Object.entries(table))

  return (req, res) => {
    const name = resolveCallableName(req.path)
    const member = name === null ? undefined : members.get(name)
    if (name === null || member === undefined) {
      // Deliberately NOT the metric line and deliberately no `callable` field:
      // the name here is whatever a stranger typed, and an unbounded label is
      // how a log-based metric gets dropped.
      logger.warn('callable-router: unknown callable', {
        router,
        requested: name === null ? null : name.slice(0, 100),
        method: req.method,
      })
      respondNotFound(router, req, res)
      return
    }
    const started = Date.now()
    res.on('finish', () => {
      log({ router, callable: name, status: res.statusCode, ms: Date.now() - started })
    })
    return member(req, res)
  }
}

/**
 * One deployed `onRequest` serving every callable in `table`, keyed by the name
 * clients call it by. `opts` are the ROUTER's runtime options and the only ones
 * in force (see the header) — `region` and the instance ceiling still come from
 * `setGlobalOptions` in src/index.ts unless `opts` says otherwise.
 *
 * Throws at load, which fails function discovery and therefore the deploy
 * BEFORE anything is touched, when a member is not an `onCall` value: a plain
 * `onRequest` handed the callable protocol would answer it with no token
 * verification at all.
 */
export function callableRouter(
  router: RouterName,
  opts: HttpsOptions,
  table: CallableTable
): CallableRouterFunction {
  const names = Object.keys(table)
  if (names.length === 0) throw new Error(`callableRouter(${router}): the table is empty`)
  for (const name of names) {
    const member = table[name] as unknown
    const endpoint = (member as { __endpoint?: { callableTrigger?: unknown } } | null)?.__endpoint
    if (typeof member !== 'function' || !endpoint || endpoint.callableTrigger === undefined) {
      throw new Error(`callableRouter(${router}): "${name}" is not an onCall function`)
    }
  }

  const fn = onRequest(opts, createRouterHandler(router, table))
  Object.defineProperty(fn, '__router', { value: router, enumerable: false, writable: false })
  Object.defineProperty(fn, '__members', {
    value: Object.freeze([...names]),
    enumerable: false,
    writable: false,
  })
  return fn as CallableRouterFunction
}

export function isCallableRouter(value: unknown): value is CallableRouterFunction {
  if (typeof value !== 'function') return false
  const own = (key: string) => Object.prototype.hasOwnProperty.call(value, key)
  return own('__router') && own('__members')
}

/** The callable names a router serves, in table order. Throws on anything that
 *  was not built by `callableRouter`, so a test cannot pass on `undefined`. */
export function routerMembers(fn: unknown): readonly string[] {
  if (!isCallableRouter(fn)) throw new Error('routerMembers: not a callableRouter function')
  return fn.__members
}

export function routerNameOf(fn: unknown): RouterName {
  if (!isCallableRouter(fn)) throw new Error('routerNameOf: not a callableRouter function')
  return fn.__router
}
