// THE ROUTER DISPATCHES BY THE LAST PATH SEGMENT AND CHANGES NOTHING ELSE.
//
// The first part drives the dispatch with plain fakes — no SDK, no
// network — and pins the name resolution and the unknown-name answer. The
// second part puts REAL `onCall` values behind a real `callableRouter` and speaks the
// callable protocol to it over a loopback socket, then compares every answer
// with the one the same member gives when called DIRECTLY. That comparison is
// the claim utils/callableRouter.ts rests on: routing preserves the protocol
// because it re-implements none of it.
//
// Why a loopback server rather than a fake `res` for the second part: the SDK's
// handler leans on the real response object (`finish`/`close` events, the cors
// middleware's header bookkeeping), and a fake faithful enough to satisfy it
// would mostly be testing the fake. `express` is not resolvable from this
// package, so the few things the functions framework adds to `(req, res)` are
// shimmed by hand in `serve()` below.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as logger from 'firebase-functions/logger'
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import {
  ROUTER_LOG_MESSAGE,
  callableRouter,
  createRouterHandler,
  isCallableRouter,
  resolveCallableName,
  routerMembers,
  routerNameOf,
  type RouterLogLine,
  type RouterMember,
} from './callableRouter'

// ── Fakes for the dispatch part ─────────────────────────────────────────────

type Req = Parameters<RouterMember>[0]
type Res = Parameters<RouterMember>[1]

function fakeReq(method: string, path: string, headers: Record<string, string> = {}): Req {
  const get = (name: string) => headers[name.toLowerCase()]
  return { method, path, headers, header: get, get, body: { data: null } } as unknown as Req
}

class FakeRes extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
  body: unknown = undefined
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
    return this
  }
  getHeader(name: string) {
    return this.headers[name.toLowerCase()]
  }
  status(code: number) {
    this.statusCode = code
    return this
  }
  send(body: unknown) {
    this.body = body
    this.emit('finish')
    return this
  }
}

const asRes = (res: FakeRes) => res as unknown as Res

/** A table of recording members plus what they saw. */
function recordingTable(names: string[]) {
  const calls: { name: string; req: Req; res: Res }[] = []
  const table: Record<string, RouterMember> = {}
  for (const name of names) {
    table[name] = (req, res) => {
      calls.push({ name, req, res })
      res.status(200).send({ result: name })
    }
  }
  return { table, calls }
}

describe('resolveCallableName — the last non-empty path segment', () => {
  const cases: [string | null | undefined, string | null][] = [
    ['/listAvailability', 'listAvailability'],
    ['/demo-linyup/europe-west6/rpcMember/listAvailability', 'listAvailability'],
    ['/rpcMember/listAvailability/', 'listAvailability'],
    ['//listAvailability//', 'listAvailability'],
    ['listAvailability', 'listAvailability'],
    ['/listAvailability?x=/other', 'listAvailability'],
    ['/get%4DyBookings', 'getMyBookings'],
    ['', null],
    ['/', null],
    ['///', null],
    [undefined, null],
    [null, null],
    // Malformed percent-encoding is a miss, never a throw.
    ['/%E0%A4%A', null],
    ['/%', null],
  ]
  for (const [path, expected] of cases) {
    it(`${JSON.stringify(path)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(resolveCallableName(path), expected)
    })
  }

  it('an encoded slash stays inside the name, so it can never select another member', () => {
    assert.equal(resolveCallableName('/a%2Fb'), 'a/b')
  })
})

describe('createRouterHandler — dispatch', () => {
  it('hands (req, res) to the member named by the last segment, with or without a prefix', () => {
    for (const path of ['/beta', '/prefix/beta', '/p/europe-west6/rpcMember/beta', '/beta/']) {
      const { table, calls } = recordingTable(['alpha', 'beta'])
      const req = fakeReq('POST', path)
      const res = new FakeRes()
      void createRouterHandler('rpcMember', table, () => undefined)(req, asRes(res))
      assert.deepEqual(
        calls.map((c) => c.name),
        ['beta'],
        path
      )
      // Untouched means the SAME objects, not copies.
      assert.equal(calls[0].req, req)
      assert.equal(calls[0].res, asRes(res))
      assert.deepEqual(res.body, { result: 'beta' })
    }
  })

  it('returns whatever the member returns, so an async member is awaited by the platform', async () => {
    let settled = false
    const table: Record<string, RouterMember> = {
      slow: async (_req, res) => {
        await new Promise((r) => setTimeout(r, 5))
        settled = true
        res.status(200).send({ result: 1 })
      },
    }
    await createRouterHandler(
      'rpcMember',
      table,
      () => undefined
    )(fakeReq('POST', '/slow'), asRes(new FakeRes()))
    assert.equal(settled, true)
  })

  it('an unknown name gets the callable protocol NOT_FOUND, readable cross-origin', () => {
    const { table, calls } = recordingTable(['alpha'])
    const res = new FakeRes()
    void createRouterHandler(
      'rpcMember',
      table,
      () => undefined
    )(fakeReq('POST', '/nope', { origin: 'https://studio.example' }), asRes(res))
    assert.deepEqual(calls, [])
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.body, {
      error: { status: 'NOT_FOUND', message: 'No such callable on rpcMember' },
    })
    assert.equal(res.headers['access-control-allow-origin'], '*')
  })

  it('an empty path gets the same 404', () => {
    for (const path of ['', '/', '//']) {
      const { table, calls } = recordingTable(['alpha'])
      const res = new FakeRes()
      void createRouterHandler(
        'rpcMember',
        table,
        () => undefined
      )(fakeReq('POST', path), asRes(res))
      assert.deepEqual(calls, [], path)
      assert.equal(res.statusCode, 404, path)
      assert.equal((res.body as { error: { status: string } }).error.status, 'NOT_FOUND', path)
    }
  })

  it('a prototype key never dispatches', () => {
    // Names reachable on a plain object without being an own key. A bare
    // `table[name]` lookup finds something for each of them, and the ones that
    // are functions would be CALLED with (req, res).
    for (const key of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']) {
      const { table, calls } = recordingTable(['alpha'])
      const res = new FakeRes()
      assert.doesNotThrow(() => {
        void createRouterHandler(
          'rpcMember',
          table,
          () => undefined
        )(fakeReq('POST', `/${key}`), asRes(res))
      }, key)
      assert.deepEqual(calls, [], key)
      assert.equal(res.statusCode, 404, key)
    }
  })

  it('the router name itself is not a member', () => {
    const { table, calls } = recordingTable(['alpha'])
    const res = new FakeRes()
    void createRouterHandler(
      'rpcMember',
      table,
      () => undefined
    )(fakeReq('POST', '/p/r/rpcMember'), asRes(res))
    assert.deepEqual(calls, [])
    assert.equal(res.statusCode, 404)
  })

  it('OPTIONS for a KNOWN name reaches the member untouched — its own cors answers', () => {
    const { table, calls } = recordingTable(['alpha'])
    const req = fakeReq('OPTIONS', '/alpha', { origin: 'https://studio.example' })
    const res = new FakeRes()
    void createRouterHandler('rpcMember', table, () => undefined)(req, asRes(res))
    assert.deepEqual(
      calls.map((c) => c.name),
      ['alpha']
    )
    assert.equal(calls[0].req.method, 'OPTIONS')
    // The router wrote NO header of its own on the way through.
    assert.deepEqual(res.headers, {})
  })

  it('OPTIONS for an UNKNOWN name is let through (204) so the POST can carry the NOT_FOUND', () => {
    const { table, calls } = recordingTable(['alpha'])
    const res = new FakeRes()
    void createRouterHandler(
      'rpcMember',
      table,
      () => undefined
    )(
      fakeReq('OPTIONS', '/nope', {
        origin: 'https://studio.example',
        'access-control-request-headers': 'authorization,content-type',
      }),
      asRes(res)
    )
    assert.deepEqual(calls, [])
    assert.equal(res.statusCode, 204)
    assert.equal(res.headers['access-control-allow-origin'], '*')
    assert.equal(res.headers['access-control-allow-methods'], 'POST')
    assert.equal(res.headers['access-control-allow-headers'], 'authorization,content-type')
  })

  it('logs ONE line per dispatched request, on finish, with the metric field names', () => {
    const lines: RouterLogLine[] = []
    const table: Record<string, RouterMember> = {
      alpha: (_req, res) => {
        // Nothing is logged before the response is finished.
        assert.deepEqual(lines, [])
        res.status(409).send({ error: {} })
      },
    }
    void createRouterHandler('rpcMember', table, (l) => lines.push(l))(
      fakeReq('POST', '/alpha'),
      asRes(new FakeRes())
    )
    assert.equal(lines.length, 1)
    // `router` and `callable` are the log-based metric's label extractors.
    assert.deepEqual(Object.keys(lines[0]).sort(), ['callable', 'ms', 'router', 'status'])
    assert.equal(lines[0].router, 'rpcMember')
    assert.equal(lines[0].callable, 'alpha')
    assert.equal(lines[0].status, 409)
    assert.ok(Number.isFinite(lines[0].ms) && lines[0].ms >= 0)
  })

  it('an unknown name writes no metric line — a stranger cannot mint label values', () => {
    const lines: RouterLogLine[] = []
    const { table } = recordingTable(['alpha'])
    void createRouterHandler('rpcMember', table, (l) => lines.push(l))(
      fakeReq('POST', '/nope'),
      asRes(new FakeRes())
    )
    assert.deepEqual(lines, [])
  })
})

describe('callableRouter — the deployed function', () => {
  const echo = onCall((r) => ({ echoed: r.data }))

  it('is an https endpoint (not a callable one) exposing its router name and members', () => {
    const fn = callableRouter('rpcMember', { cpu: 1, concurrency: 40 }, { echo })
    assert.equal(isCallableRouter(fn), true)
    assert.equal(routerNameOf(fn), 'rpcMember')
    assert.deepEqual([...routerMembers(fn)], ['echo'])
    const endpoint = fn.__endpoint as unknown as Record<string, unknown>
    assert.ok(endpoint.httpsTrigger, 'a router is deployed as an onRequest')
    assert.equal(endpoint.callableTrigger, undefined)
    // No `invoker`: the same posture as the callables it serves.
    assert.deepEqual(endpoint.httpsTrigger, {})
    assert.equal(endpoint.concurrency, 40)
    assert.equal(endpoint.cpu, 1)
  })

  it('keeps the accessor off the enumerable surface and immutable', () => {
    const fn = callableRouter('rpcMember', {}, { echo })
    assert.deepEqual(
      Object.keys(fn).filter((k) => k === '__members' || k === '__router'),
      []
    )
    assert.throws(() => (routerMembers(fn) as string[]).push('x'))
  })

  it('refuses at load a member that is not an onCall — it would skip token verification', () => {
    const plain = onRequest((_req, res) => void res.send('ok'))
    assert.throws(
      () => callableRouter('rpcMember', {}, { plain } as never),
      /"plain" is not an onCall function/
    )
    assert.throws(() => callableRouter('rpcMember', {}, { nope: undefined } as never), /"nope"/)
    assert.throws(() => callableRouter('rpcMember', {}, {}), /table is empty/)
  })

  it('routerMembers refuses anything callableRouter did not build', () => {
    assert.equal(isCallableRouter(echo), false)
    assert.throws(() => routerMembers(echo))
    assert.throws(() => routerMembers(undefined))
  })
})

// ── The protocol part: real onCall members, a real socket ───────────────────

type Handler = (req: Req, res: Res) => void | Promise<void>

/** What the functions framework (express + a JSON body parser) adds to the raw
 *  node objects, and no more: `path`, `header()`/`get()`, `body`, `rawBody`,
 *  `status()`, `send()`, `json()`. */
async function serve(handler: Handler): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const r = req as unknown as Record<string, unknown>
      const get = (name: string) => {
        const v = req.headers[name.toLowerCase()]
        return Array.isArray(v) ? v.join(', ') : v
      }
      r.path = new URL(req.url ?? '/', 'http://localhost').pathname
      r.header = get
      r.get = get
      r.rawBody = raw
      const isJson = String(req.headers['content-type'] ?? '')
        .toLowerCase()
        .startsWith('application/json')
      r.body = isJson && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
      const s = res as unknown as Record<string, unknown>
      s.status = (code: number) => {
        res.statusCode = code
        return res
      }
      const send = (body: unknown) => {
        if (body !== null && typeof body === 'object') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        } else {
          res.end(body === undefined ? undefined : String(body))
        }
        return res
      }
      s.send = send
      s.json = send
      Promise.resolve(handler(req as unknown as Req, res as unknown as Res)).catch((err) => {
        res.statusCode = 599
        res.end(String(err))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // A request left hanging by a defect must fail ITS test, not wedge the
        // teardown: `close()` alone waits for every open socket.
        server.closeAllConnections()
      }),
  }
}

interface Answer {
  status: number
  body: unknown
  headers: Record<string, string>
}

async function call(url: string, init: RequestInit): Promise<Answer> {
  const res = await fetch(url, init)
  const text = await res.text()
  const headers: Record<string, string> = {}
  // The ones the protocol and CORS are made of; `date` and friends would make
  // the routed-versus-direct comparison fail for no reason.
  for (const name of [
    'content-type',
    'vary',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
  ]) {
    const v = res.headers.get(name)
    if (v !== null) headers[name] = v
  }
  return { status: res.status, body: text ? JSON.parse(text) : null, headers }
}

const post = (url: string, data: unknown, headers: Record<string, string> = {}) =>
  call(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ data }),
  })

describe('callableRouter — the callable protocol survives routing, end to end', () => {
  const ORIGIN = 'https://only-this.example'
  const members = {
    echo: onCall((r) => ({ echoed: r.data, uid: r.auth?.uid ?? null })),
    boom: onCall(() => {
      throw new HttpsError('failed-precondition', 'nope', { reason: 'because' })
    }),
    crash: onCall(() => {
      throw new Error('a secret the client must never see')
    }),
    // Its OWN cors policy — what proves a preflight was answered by the member
    // and not by the router, whose own answer is `*`.
    fenced: onCall({ cors: [ORIGIN] }, () => 'ok'),
    guarded: onCall({ enforceAppCheck: true }, () => 'ok'),
  }

  let routed: { base: string; close: () => Promise<void> }
  let direct: Record<keyof typeof members, { base: string; close: () => Promise<void> }>
  const logged: { message: unknown; fields: Record<string, unknown> }[] = []
  const realInfo = logger.info
  const hadProject = process.env.GCLOUD_PROJECT

  before(async () => {
    // firebase-admin's verifyIdToken looks for a project id before it looks at
    // the token; without one it asks the metadata server, which on a laptop or
    // a CI runner is a multi-second network wait for a test that needs none.
    if (!hadProject)
      process.env.GCLOUD_PROJECT = 'demo-linyup'
      // The module under test reads `logger.info` at call time, so the DEFAULT
      // log sink — the one production uses — is what gets captured here.
    ;(logger as { info: typeof logger.info }).info = (...args: unknown[]) => {
      const last = args[args.length - 1]
      if (args[0] === ROUTER_LOG_MESSAGE) {
        logged.push({ message: args[0], fields: last as Record<string, unknown> })
        return
      }
      realInfo(...(args as Parameters<typeof logger.info>))
    }
    routed = await serve(callableRouter('rpcMember', { cpu: 1, concurrency: 40 }, members))
    direct = {} as typeof direct
    for (const name of Object.keys(members) as (keyof typeof members)[]) {
      direct[name] = await serve(members[name])
    }
  })

  after(async () => {
    ;(logger as { info: typeof logger.info }).info = realInfo
    if (!hadProject) delete process.env.GCLOUD_PROJECT
    await routed.close()
    for (const s of Object.values(direct)) await s.close()
  })

  it('a result comes back as { result }', async () => {
    const answer = await post(`${routed.base}/rpcMember/echo`, { a: 1, nested: { b: [true, null] } })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      result: { echoed: { a: 1, nested: { b: [true, null] } }, uid: null },
    })
  })

  it('an HttpsError keeps its code, message, details and HTTP status', async () => {
    const answer = await post(`${routed.base}/rpcMember/boom`, {})
    assert.equal(answer.status, 400)
    assert.deepEqual(answer.body, {
      error: { status: 'FAILED_PRECONDITION', message: 'nope', details: { reason: 'because' } },
    })
  })

  it('an unexpected throw is still masked as INTERNAL by the SDK', async () => {
    const answer = await post(`${routed.base}/rpcMember/crash`, {})
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { status: 'INTERNAL', message: 'INTERNAL' } })
  })

  it('the ID token is verified in-process: a bad one is UNAUTHENTICATED before the handler runs', async () => {
    const answer = await post(
      `${routed.base}/rpcMember/echo`,
      {},
      { authorization: 'Bearer not-a-jwt' }
    )
    assert.equal(answer.status, 401)
    assert.deepEqual(answer.body, {
      error: { status: 'UNAUTHENTICATED', message: 'Unauthenticated' },
    })
  })

  it('a member keeps its OWN enforceAppCheck', async () => {
    const refused = await post(`${routed.base}/rpcMember/guarded`, {})
    assert.equal(refused.status, 401)
    // …and it is the member's, not the router's: its neighbour answers the same call.
    assert.equal((await post(`${routed.base}/rpcMember/echo`, {})).status, 200)
  })

  it('a preflight for a known name is answered by the member’s own cors policy', async () => {
    const answer = await call(`${routed.base}/rpcMember/fenced`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://somewhere-else.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    assert.equal(answer.status, 204)
    // The member's single allowed origin — NOT the `*` the router uses for its
    // own 404, and not a reflection of the caller.
    assert.equal(answer.headers['access-control-allow-origin'], ORIGIN)
    assert.equal(answer.headers['access-control-allow-methods'], 'POST')
  })

  it('a protocol violation is refused by the SDK exactly as it is today', async () => {
    const get = await call(`${routed.base}/rpcMember/echo`, { method: 'GET' })
    assert.equal(get.status, 400)
    assert.deepEqual(get.body, { error: { status: 'INVALID_ARGUMENT', message: 'Bad Request' } })
  })

  it('EVERY answer is identical to the one the member gives when called directly', async () => {
    const probes: { name: keyof typeof members; init: () => Promise<[Answer, Answer]> }[] = []
    const both = (name: keyof typeof members, send: (url: string) => Promise<Answer>) =>
      probes.push({
        name,
        init: async () => [
          await send(`${routed.base}/rpcMember/${name}`),
          await send(`${direct[name].base}/${name}`),
        ],
      })
    const preflight = (url: string) =>
      call(url, {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      })
    for (const name of Object.keys(members) as (keyof typeof members)[]) {
      both(name, (url) => post(url, { x: name }, { origin: ORIGIN }))
      both(name, (url) => post(url, {}, { authorization: 'Bearer not-a-jwt' }))
      both(name, (url) => call(url, { method: 'GET' }))
      both(name, preflight)
    }
    assert.ok(probes.length > 0)
    for (const probe of probes) {
      const [viaRouter, straight] = await probe.init()
      assert.deepEqual(viaRouter, straight, `${probe.name} answered differently through the router`)
    }
  })

  it('an unknown name over the wire: 404 NOT_FOUND, and a preflight that lets the POST happen', async () => {
    const answer = await post(`${routed.base}/rpcMember/doesNotExist`, {}, { origin: ORIGIN })
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, {
      error: { status: 'NOT_FOUND', message: 'No such callable on rpcMember' },
    })
    assert.equal(answer.headers['access-control-allow-origin'], '*')
    const preflight = await call(`${routed.base}/rpcMember/constructor`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], '*')
  })

  it('the default sink logged one { router, callable, status, ms } line per dispatched request', () => {
    // Runs last in this block on purpose: it reads what the requests above left.
    assert.ok(logged.length > 0, 'nothing was logged through firebase-functions/logger')
    for (const { fields } of logged) {
      assert.deepEqual(Object.keys(fields).sort(), ['callable', 'ms', 'router', 'status'])
      assert.equal(fields.router, 'rpcMember')
      assert.ok(Object.prototype.hasOwnProperty.call(members, fields.callable as string))
    }
    // The status is the one the MEMBER wrote, read after it finished — the
    // opening requests of this block, in the order mocha ran them.
    assert.deepEqual(
      logged.slice(0, 3).map((l) => [l.fields.callable, l.fields.status]),
      [
        ['echo', 200],
        ['boom', 400],
        ['crash', 500],
      ]
    )
    // Unknown names never reach the metric line.
    assert.deepEqual(
      logged.filter((l) => l.fields.callable === 'doesNotExist'),
      []
    )
  })
})
