// Do the app's callables REALLY go through their routers, from a browser?
//
// Everything else that proves routing runs from Node (scripts/router-spike.mjs,
// the functions suite), and Node has no CORS and no module-load-on-the-server. A
// browser has both, and `src/lib/callFunction.ts` is lazy precisely because of the
// second. So this walks real screens and watches the network:
//
//   - a callable the route table routes must be requested at `/{router}/{name}`
//   - and NEVER at `/{name}` — that would be `withRouterFallback` having fired,
//     i.e. the browser could not reach a router that is there
//   - and the router must answer as a callable does: a 2xx, or a callable-protocol
//     error body. A CORS failure or a platform 404 has neither.
//
// It asserts on what the pages happen to call rather than on a fixed list of
// names, so a screen that stops calling something does not fail it; it asserts
// that SOMETHING was routed on each surface, so a walk that calls nothing does.
import { CALLABLE_ROUTES } from '@linyup/shared'
import type { Page, Request } from '@playwright/test'
import { test, expect } from './fixtures'

const REGION_PATH = '/europe-west6/'

// Next dev compiles each route on its first visit (a minute is normal) and the
// functions emulator has the same cold cost per callable — see README.md. The
// walk visits several cold routes in one test, so it gets a budget to match.
const WALK_TIMEOUT_MS = 900_000
// 'networkidle' never settles under next dev (HMR keeps a socket busy), so a page
// gets a fixed moment to make the calls it makes on load.
const SETTLE_MS = 6_000

type Seen = { name: string; router: string | null; status: number; url: string }

/** Every POST to the functions host, as `{router?}/{name}` + the status it got. */
function watchCallables(page: Page): Seen[] {
  const seen: Seen[] = []
  const pending = new Map<Request, true>()
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes(REGION_PATH)) pending.set(req, true)
  })
  page.on('requestfinished', async (req) => {
    if (!pending.delete(req)) return
    const path = new URL(req.url()).pathname.split(REGION_PATH)[1] ?? ''
    const segments = path.split('/').filter(Boolean)
    const name = segments[segments.length - 1] ?? ''
    const router = segments.length > 1 ? segments[0] : null
    const res = await req.response()
    seen.push({ name, router, status: res?.status() ?? 0, url: req.url() })
  })
  page.on('requestfailed', (req) => {
    if (!pending.delete(req)) return
    const path = new URL(req.url()).pathname.split(REGION_PATH)[1] ?? ''
    const segments = path.split('/').filter(Boolean)
    seen.push({
      name: segments[segments.length - 1] ?? '',
      router: segments.length > 1 ? segments[0] : null,
      status: -1, // never got a response: CORS, connection refused
      url: req.url(),
    })
  })
  return seen
}

function assertRouted(seen: Seen[], surface: string) {
  const summary = seen.map((s) => `${s.router ?? '(direct)'}/${s.name} → ${s.status}`).join('\n  ')
  const routed = seen.filter((s) => s.router !== null)
  expect(
    routed.length,
    `${surface}: no routed callable was requested at all\n  ${summary}`
  ).toBeGreaterThan(0)

  for (const s of seen) {
    const expected = CALLABLE_ROUTES[s.name]
    if (s.router === null) {
      // A direct call to a name the table routes = the fallback fired (or a call
      // site bypasses callFunction). Either way the router was not used.
      expect(
        expected,
        `${surface}: ${s.name} was called DIRECTLY but is routed to ${expected}\n  ${summary}`
      ).toBeUndefined()
      continue
    }
    expect(s.router, `${surface}: ${s.name} went to ${s.router}, the table says ${expected}`).toBe(
      expected
    )
    // -1 = no response (CORS / refused). 404 = no such router or name. 5xx from a
    // callable is `internal`, which a healthy seeded screen should not produce.
    expect(
      s.status,
      `${surface}: ${s.router}/${s.name} got no usable answer\n  ${summary}`
    ).toBeGreaterThanOrEqual(200)
    expect(
      [404, 500, 502, 503],
      `${surface}: ${s.router}/${s.name} → ${s.status}\n  ${summary}`
    ).not.toContain(s.status)
  }
  return routed
}

test('staff screens: callables go through their routers', async ({ page }) => {
  test.setTimeout(WALK_TIMEOUT_MS)
  const seen = watchCallables(page)
  // Each of these calls at least one callable on load for the seeded studio.
  for (const path of ['/settings/members', '/settings/billing', '/payments', '/dashboard']) {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 240_000 })
    await page.waitForTimeout(SETTLE_MS)
  }
  const routed = assertRouted(seen, 'staff screens')
  console.log(
    'staff screens — routed calls:\n  ' +
      routed.map((s) => `${s.router}/${s.name} → ${s.status}`).join('\n  ')
  )
})

test('public surfaces: a signed-out visitor goes through rpcMember', async ({ browser }) => {
  test.setTimeout(WALK_TIMEOUT_MS)
  // A FRESH context: the public pages must route for somebody with no session.
  const context = await browser.newContext()
  const page = await context.newPage()
  const seen = watchCallables(page)
  for (const path of [
    '/public/iron-circle-gym/booking',
    '/public/iron-circle-gym/appointments',
    '/public/samurai-fight-academy/appointments',
  ]) {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 240_000 })
    await page.waitForTimeout(SETTLE_MS)
  }
  const routed = assertRouted(seen, 'public surfaces')
  console.log(
    'public surfaces — routed calls:\n  ' +
      routed.map((s) => `${s.router}/${s.name} → ${s.status}`).join('\n  ')
  )
  await context.close()
})
