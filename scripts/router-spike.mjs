#!/usr/bin/env node
// Does a callable behave the same through its ROUTER as it does on its own?
//
// A router (packages/functions/src/utils/callableRouter.ts) hands the request to
// the existing `onCall` value, so in principle nothing can differ. This script is
// the proof at runtime rather than from reading the SDK: every call is made
// TWICE — straight at the callable with `httpsCallable`, and through the router
// with `httpsCallableFromURL` — and the two outcomes must be identical, error
// code and message included. It is the checklist in
// docs/functions-consolidation-plan.md → "Phase 0: tooling and spike".
//
//   node scripts/router-spike.mjs --target emulator [--functions-port 5001] [--auth-port 9099]
//   node scripts/router-spike.mjs --target linyup-staging --api-key <web API key>
//   … --routers rpcOps,rpcFinance     also compare every member of those routers
//   … --routes-ref origin/main        use THAT commit's route table, not this checkout's
//
// THE ROUTE TABLE MUST BE THE DEPLOYED ONE. By default it is this checkout's
// (@linyup/shared's build), which is right only when the checkout IS what is
// deployed. Run from a branch that has already moved a name to a new router and
// every such name "fails" with a not-found the deployed project is right to give.
// `--routes-ref <git ref>` reads packages/shared/src/functions/routes.ts at that
// ref instead — pass the commit the target was deployed from.
//
// Comparing is what makes it safe to point at a deployed project: it needs no
// fixture data, because "the same refusal both ways" is as good a proof as the
// same result. The members it calls are read-only. `--routers` calls each member of
// the named routers SIGNED OUT with an empty payload, which every callable refuses
// or rejects before it does anything — so it proves the route exists and the
// refusal is the member's own, without performing a single operation.
//
// SIGNED-IN CHECK. Against the emulator it mints a contact-session custom token
// itself (the Auth emulator accepts an unsigned one). Against a deployed project
// it signs in with ROUTER_SPIKE_EMAIL / ROUTER_SPIKE_PASSWORD from the
// environment when both are set, and says it skipped the check when they are
// not. It never takes a password as a flag, so one cannot land in shell history.
//
// WHAT IT CANNOT SEE, and the plan still owes on a deployed project: the
// service's cpu and concurrency (`gcloud run services describe <router> --region
// europe-west6`), and App Check enforcement, which is off in every environment
// today (APP_CHECK_ENFORCE in packages/functions/.env.*) and is therefore proven
// in-process only, by utils/callableRouter.test.ts.
//
// A KNOWN DIFFERENCE, emulator only: the functions emulator switches on the SDK's
// `enableCors` debug feature for every onRequest, so that wrapper answers a
// router's preflight before the member does and lists more methods. Origin and
// headers still match. On a deployed function the feature is off. The preflight
// check therefore compares methods only off the emulator.
//
// Exit codes: 0 every check passed · 1 a check failed · 2 could not run.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGION = 'europe-west6'
const EMULATOR_PROJECT = 'demo-linyup'

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true
    else flags[a.slice(2)] = argv[++i]
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))
const target = flags.target
if (typeof target !== 'string') {
  console.error(
    'usage: node scripts/router-spike.mjs --target emulator | --target <projectId> --api-key <key>'
  )
  process.exit(2)
}
const onEmulator = target === 'emulator'
const projectId = onEmulator ? EMULATOR_PROJECT : target
const ports = {
  functions: Number(flags['functions-port'] ?? 5001),
  auth: Number(flags['auth-port'] ?? 9099),
}
if (!onEmulator && typeof flags['api-key'] !== 'string') {
  console.error(
    '--api-key is required off the emulator (the web API key, e.g. from apps/web/apphosting.yaml)'
  )
  process.exit(2)
}

// The client SDK and @linyup/shared resolve from the web app, firebase-admin
// from functions — scripts/ is not a workspace and has neither.
const web = createRequire(join(ROOT, 'apps/web/package.json'))
const fns = createRequire(join(ROOT, 'packages/functions/package.json'))
const { initializeApp } = web('firebase/app')
const { getAuth, connectAuthEmulator, signInWithCustomToken, signInWithEmailAndPassword, signOut } =
  web('firebase/auth')
const { getFunctions, connectFunctionsEmulator, httpsCallable, httpsCallableFromURL } =
  web('firebase/functions')
const { functionsBaseUrl, callableRouteUrl } = web('@linyup/shared')
const CALLABLE_ROUTES =
  typeof flags['routes-ref'] === 'string'
    ? routesAtRef(flags['routes-ref'])
    : web('@linyup/shared').CALLABLE_ROUTES
const routerForCallable = (name) =>
  Object.prototype.hasOwnProperty.call(CALLABLE_ROUTES, name) ? CALLABLE_ROUTES[name] : null

/** The route table as committed at `ref`. Read as SOURCE, not built: the table is
 *  one object literal of `name: 'router'` lines, and building another commit's
 *  package to read forty strings would need a second checkout. */
function routesAtRef(ref) {
  const src = execFileSync('git', ['show', `${ref}:packages/shared/src/functions/routes.ts`], {
    cwd: ROOT,
    encoding: 'utf8',
  }).replace(/\r\n/g, '\n')
  const body = src.split('export const CALLABLE_ROUTES')[1]?.split('\n}\n')[0]
  if (!body) throw new Error(`no CALLABLE_ROUTES in routes.ts at ${ref}`)
  const table = {}
  for (const m of body.matchAll(/^\s*(\w+):\s*'(\w+)',\s*$/gm)) table[m[1]] = m[2]
  if (Object.keys(table).length === 0) throw new Error(`CALLABLE_ROUTES at ${ref} parsed as empty`)
  return table
}

const app = initializeApp({
  projectId,
  apiKey: onEmulator ? 'demo-key' : flags['api-key'],
  authDomain: `${projectId}.firebaseapp.com`,
})
const auth = getAuth(app)
const functions = getFunctions(app, REGION)
if (onEmulator) {
  connectAuthEmulator(auth, `http://127.0.0.1:${ports.auth}`, { disableWarnings: true })
  connectFunctionsEmulator(functions, '127.0.0.1', ports.functions)
}
const base = functionsBaseUrl({
  projectId,
  region: REGION,
  emulator: onEmulator ? { host: '127.0.0.1', port: ports.functions } : null,
})

const direct = (name) => httpsCallable(functions, name)
const routed = (name, router = routerForCallable(name)) => {
  if (!router) throw new Error(`${name} is not in CALLABLE_ROUTES`)
  return httpsCallableFromURL(functions, callableRouteUrl({ base, router, name }))
}
async function outcome(fn, data) {
  try {
    return { ok: (await fn(data)).data }
  } catch (e) {
    return { code: e.code, message: e.message, details: e.details ?? null }
  }
}

let failed = 0
const show = (v) => JSON.stringify(v).slice(0, 240)
function report(pass, label, lines = []) {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}`)
  for (const l of lines) console.log(`        ${l}`)
}
async function same(label, name, data) {
  const d = await outcome(direct(name), data)
  const r = await outcome(routed(name), data)
  report(show(d) === show(r), label, [`direct  ${show(d)}`, `routed  ${show(r)}`])
  return r
}

async function preflight(url, origin) {
  const res = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  const h = (k) => res.headers.get(k)
  return {
    status: res.status,
    allowOrigin: h('access-control-allow-origin'),
    allowHeaders: h('access-control-allow-headers'),
    ...(onEmulator ? {} : { allowMethods: h('access-control-allow-methods') }),
  }
}

async function main() {
  console.log(`target ${target} — ${base}\n`)
  const teamId = 'router-spike-no-such-team'

  await same('anonymous listAvailability, empty payload', 'listAvailability', {})
  await same('anonymous listAvailability, unknown team', 'listAvailability', {
    teamId,
    activityId: 'x',
    from: '2030-01-01',
    to: '2030-01-02',
  })
  const signedOut = await same('signed-out getMyBookings', 'getMyBookings', { teamId })
  report(signedOut.code === 'functions/unauthenticated', 'signed-out is refused as unauthenticated')

  let signedIn = false
  if (onEmulator) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${ports.auth}`
    process.env.GCLOUD_PROJECT = projectId
    const admin = fns('firebase-admin')
    admin.initializeApp({ projectId })
    const token = await admin.auth().createCustomToken('router-spike-uid', {
      contactId: 'router-spike-contact',
      teamId,
      sessionExpires: Date.now() + 3_600_000,
    })
    await signInWithCustomToken(auth, token)
    signedIn = true
  } else if (process.env.ROUTER_SPIKE_EMAIL && process.env.ROUTER_SPIKE_PASSWORD) {
    await signInWithEmailAndPassword(
      auth,
      process.env.ROUTER_SPIKE_EMAIL,
      process.env.ROUTER_SPIKE_PASSWORD
    )
    signedIn = true
  }
  if (signedIn) {
    const r = await same('signed-in getMyBookings', 'getMyBookings', { teamId })
    report(
      r.code !== 'functions/unauthenticated',
      'the ID token reaches the member through the router'
    )
    await signOut(auth)
  } else {
    console.log(
      'skip  signed-in check — set ROUTER_SPIKE_EMAIL and ROUTER_SPIKE_PASSWORD to run it'
    )
  }

  const wanted = typeof flags.routers === 'string' ? flags.routers.split(',') : []
  for (const r of wanted) {
    const members = Object.keys(CALLABLE_ROUTES).filter((n) => CALLABLE_ROUTES[n] === r)
    report(members.length > 0, `${r} has members in CALLABLE_ROUTES`)
    for (const name of members) {
      const out = await same(`signed-out ${name}, empty payload (${r})`, name, {})
      report(out.code !== undefined, `${name} refused a signed-out empty call`)
    }
  }

  const router = routerForCallable('listAvailability')
  const unknown = await outcome(routed('noSuchCallable', router), {})
  report(unknown.code === 'functions/not-found', 'unknown name through the router is not-found', [
    show(unknown),
  ])

  const origin = typeof flags.origin === 'string' ? flags.origin : 'https://app.linyup.com'
  const pd = await preflight(`${base}/listAvailability`, origin)
  const pr = await preflight(callableRouteUrl({ base, router, name: 'listAvailability' }), origin)
  report(show(pd) === show(pr), `CORS preflight from ${origin}`, [
    `direct  ${show(pd)}`,
    `routed  ${show(pr)}`,
  ])

  console.log(failed ? `\n${failed} check(s) failed` : '\nevery check passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
