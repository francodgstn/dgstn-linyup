#!/usr/bin/env node
// Is a callable's OWN name still being called?
//
// Callables are served by routers now (docs/functions-consolidation-plan.md), and
// each one ALSO still deploys under its own name — its alias — until that name is
// provably unused. "Provably" is this script. An alias is its own Cloud Run
// service, so the platform already counts who calls it:
// `run.googleapis.com/request_count`, by service. Nothing had to be added to the
// code to know, and nothing in the code can be wrong about it.
//
//   node scripts/alias-usage.mjs --project linyup-prod [--days 30] [--region europe-west6]
//   … --json            machine-readable
//   … --quiet-only      list only the aliases with no successful call
//
// A RAW REQUEST COUNT NEVER REACHES ZERO, so it is not what is counted. Every
// function — including callables no client has ever called — shows requests in
// fixed pairs, a 400 and a 404, on a handful of days that line up with deploys:
// something probes each service, and a probe is a request. (Observed on all three
// projects, 2026-09-20; what sends them was not established.) A client that really
// calls a callable gets a 2xx, so the report separates `ok` (2xx) from `other`,
// and QUIET MEANS NO 2xx. `other` is printed so a name that is only ever refused —
// a caller with a bad token, say — is still visible to whoever reads the table.
//
// READ THE WINDOW BEFORE THE NUMBER. Quiet means "unused" only if the clients had
// stopped using the name BEFORE the window opened. A callable that runs once a
// year (closing a fiscal year) is quiet in almost any window while being very much
// in use. So the rule in the plan is not "quiet": it is "the clients route, AND
// THEN N quiet days". This script reports the second half; whether the first half
// holds for a project is the deploy record's to say.
//
// What it prints, per routed callable: successful calls to the ALIAS, its other
// requests, and — for context — successful calls to the ROUTER that serves it. A
// quiet alias beside a busy router is the picture of a finished migration; a quiet
// alias beside a quiet router is a project where nothing called either, which
// proves nothing.
//
// Names the MEMBER APP calls are marked `app`. They have a second gate no request
// count can stand in for: store binaries that cannot be updated keep calling the
// name until `app_settings/mobile.min_supported_version` has moved past the first
// build that routes (packages/functions/src/utils/frozenFunctions.test.ts).
//
// Cloud Monitoring keeps this metric for about six weeks, so --days is capped
// there. Auth is Application Default Credentials, as in check-functions-ready.mjs;
// it reads and never writes.
//
// Exit codes: 0 ok · 2 could not read the project.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MONITORING_API = 'https://monitoring.googleapis.com/v3'
const MAX_DAYS = 42

// The member app's names — the frozen list's mobile group. Kept in step with it by
// scripts/alias-usage.test.mjs, which reads frozenFunctions.test.ts.
export const MEMBER_APP_NAMES = [
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
]

export function parseArgs(argv) {
  const args = { project: null, region: 'europe-west6', days: 30, json: false, quietOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') args.project = argv[++i]
    else if (a === '--region') args.region = argv[++i]
    else if (a === '--days') args.days = Number(argv[++i])
    else if (a === '--json') args.json = true
    else if (a === '--quiet-only') args.quietOnly = true
  }
  if (!Number.isFinite(args.days) || args.days < 1) args.days = 30
  args.days = Math.min(Math.floor(args.days), MAX_DAYS)
  return args
}

/** A function's Cloud Run service is its name, lowercased. */
export const serviceNameOf = (functionName) => functionName.toLowerCase()

/** timeSeries → Map(service_name → { ok, other }). One series per service AND
 *  response-code class once the query reduces across codes and revisions; `ok` is
 *  the 2xx class, `other` everything else (probes, refusals, crashes). */
export function totalsByService(timeSeries) {
  const totals = new Map()
  for (const series of timeSeries ?? []) {
    const service = series.resource?.labels?.service_name
    if (!service) continue
    let sum = 0
    for (const point of series.points ?? []) {
      const v = point.value ?? {}
      sum += Number(v.int64Value ?? v.doubleValue ?? 0)
    }
    const row = totals.get(service) ?? { ok: 0, other: 0 }
    if (series.metric?.labels?.response_code_class === '2xx') row.ok += sum
    else row.other += sum
    totals.set(service, row)
  }
  return totals
}

/** One row per routed callable. `routes` is CALLABLE_ROUTES. */
export function buildReport(routes, totals, memberAppNames = MEMBER_APP_NAMES) {
  const app = new Set(memberAppNames)
  const none = { ok: 0, other: 0 }
  return Object.keys(routes)
    .sort()
    .map((name) => {
      const router = routes[name]
      const alias = totals.get(serviceNameOf(name)) ?? none
      const routed = totals.get(serviceNameOf(router)) ?? none
      return {
        name,
        router,
        aliasOk: alias.ok,
        aliasOther: alias.other,
        routerOk: routed.ok,
        memberApp: app.has(name),
        // quiet = no call to the alias SUCCEEDED. It is evidence only beside a
        // router that was called; the row says both, the reader decides.
        quiet: alias.ok === 0,
      }
    })
}

async function accessToken() {
  // firebase-admin resolves from packages/functions — scripts/ is not a workspace.
  const fns = createRequire(join(ROOT, 'packages/functions/package.json'))
  const { applicationDefault } = fns('firebase-admin/app')
  const { access_token: token } = await applicationDefault().getAccessToken()
  return token
}

async function fetchTotals({ project, region, days }) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, 'x-goog-user-project': project }
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  const all = []
  let pageToken = ''
  do {
    const q = new URLSearchParams({
      filter: `metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.labels.location="${region}"`,
      'interval.startTime': start.toISOString(),
      'interval.endTime': end.toISOString(),
      // one point per series for the whole window, summed across revisions
      'aggregation.alignmentPeriod': `${days * 86_400}s`,
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
      pageSize: '1000',
    })
    q.append('aggregation.groupByFields', 'resource.labels.service_name')
    q.append('aggregation.groupByFields', 'metric.labels.response_code_class')
    if (pageToken) q.set('pageToken', pageToken)
    const res = await fetch(`${MONITORING_API}/projects/${project}/timeSeries?${q}`, { headers })
    if (!res.ok)
      throw new Error(`Monitoring API ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = await res.json()
    all.push(...(body.timeSeries ?? []))
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)
  return totalsByService(all)
}

function printTable(rows, { project, days, quietOnly }) {
  const shown = quietOnly ? rows.filter((r) => r.quiet) : rows
  const w = Math.max(4, ...shown.map((r) => r.name.length))
  const col = (v, n) => String(v).padStart(n)
  console.log(`${project} — the last ${days} days\n`)
  console.log(
    `  ${'name'.padEnd(w)}  ${col('alias ok', 9)}  ${col('other', 7)}  ${col('router ok', 9)}  served by`
  )
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(9)}  ${'-'.repeat(7)}  ${'-'.repeat(9)}  ---------`)
  for (const r of shown) {
    console.log(
      `  ${r.name.padEnd(w)}  ${col(r.aliasOk, 9)}  ${col(r.aliasOther, 7)}  ${col(r.routerOk, 9)}  ${r.router}${r.memberApp ? '  app' : ''}`
    )
  }
  const quiet = rows.filter((r) => r.quiet)
  console.log(`\n${quiet.length} of ${rows.length} aliases had no successful call.`)
  const routerSilent = quiet.filter((r) => r.routerOk === 0)
  if (routerSilent.length) {
    console.log(
      `${routerSilent.length} of those sit beside a router that had none either — that is a quiet PROJECT, not a finished migration.`
    )
  }
  const appQuiet = quiet.filter((r) => r.memberApp)
  if (appQuiet.length) {
    console.log(
      `${appQuiet.length} quiet aliases are names the member app calls (app): a request count cannot clear them — the minimum supported version has to.`
    )
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.project) {
    console.error(
      'usage: node scripts/alias-usage.mjs --project <projectId> [--days 30] [--json] [--quiet-only]'
    )
    process.exit(2)
  }
  const web = createRequire(join(ROOT, 'apps/web/package.json'))
  const { CALLABLE_ROUTES } = web('@linyup/shared')
  let totals
  try {
    totals = await fetchTotals(args)
  } catch (e) {
    console.error(`could not read ${args.project}: ${e.message}`)
    process.exit(2)
  }
  const rows = buildReport(CALLABLE_ROUTES, totals)
  if (args.json) {
    console.log(JSON.stringify({ project: args.project, days: args.days, rows }, null, 2))
  } else {
    printTable(rows, { project: args.project, days: args.days, quietOnly: args.quietOnly })
  }
  process.exit(0)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
