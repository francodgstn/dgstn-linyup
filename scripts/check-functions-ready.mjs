#!/usr/bin/env node
/**
 * check-functions-ready — fail when a Cloud Function is not serving the code
 * that was just deployed.
 *
 *   pnpm functions:ready --project linyup-prod [--region europe-west6]
 *                        [--timeout 300] [--interval 15]
 *
 * WHY. `firebase deploy` can finish green while Cloud Run refused the new
 * revisions ("Container Healthcheck failed. Quota exceeded for total allowable
 * CPU per project per region"), and three things then hide it:
 *
 *   - the function still reads ACTIVE in the Cloud Functions API, and its Cloud
 *     Run service keeps serving the PREVIOUS revision, so every request succeeds
 *     — against old code;
 *   - its `firebase-functions-hash` label already carries the new hash, so the
 *     deploy step's own retry, and any later deploy of the same tree, skips it
 *     as "No changes detected". Only `--only functions:<id>` forces it: the
 *     FUNCTIONS_DEPLOY_UNCHANGED=true that firebase-tools suggests is read
 *     nowhere in firebase-tools 15.18;
 *   - a function CREATED in that state has no earlier revision to fall back on,
 *     and a FAILED one can have no Cloud Run service at all — invisible to any
 *     check that only lists services.
 *
 * On 2026-09-16 that left 81 sandbox and 61 production functions serving code
 * up to two weeks old behind two green runs.
 *
 * The SECOND way, found on 2026-09-18: firebase-tools 15.18 builds each group
 * of functions (codebase + region + memory size) once and hands the build to
 * the rest of the group. If the first call in a group is rate-limited (a 429),
 * its retry waits for the very build it was supposed to start — and the whole
 * group waits with it, holding no timer or socket, so node's event loop drains
 * and the CLI exits 0 half-way: no "Deploy complete!", no summary. Every 512Mi
 * function in prod and sandbox was never deployed, and a brand-new one never
 * created, behind two more green runs. Fixed upstream in firebase-tools 15.30.0
 * (firebase/firebase-tools#11044). Those functions stay perfectly healthy — on
 * the previous release — so no Cloud Run condition shows it; their deploy hash
 * does (4 below).
 *
 * So this reads the state where it actually is. A function is serving the
 * deployed code only when
 *
 *   1. Cloud Functions reports it ACTIVE (the one signal for a function whose
 *      Cloud Run service does not exist), and
 *   2. its Cloud Run service's Ready condition SUCCEEDED, and
 *   3. latestReadyRevision == latestCreatedRevision — the newest revision is
 *      the one taking traffic, and
 *   4. it carries the latest deploy's `firebase-functions-hash`. That label is
 *      sha1(source + env + the secrets a function BINDS), and no function here
 *      binds a secret at deploy time (they are read at runtime), so one complete
 *      deploy leaves exactly one hash on every function it processed — updated,
 *      created or skipped as unchanged. The latest deploy's hash is the one on
 *      the most recently updated function. If functions ever bind secrets, the
 *      hashes legitimately split by secret set and this rule has to learn that.
 *
 * The THIRD way, found on 2026-09-20: a function can be ACTIVE, Ready, on its
 * newest revision and on the latest hash — every one of 1–4 — and still refuse
 * every caller, because its Cloud Run service has NO INVOKER. Two staging
 * callables (`inviteOrgMember`, `getOrgMemberInvitation`) had an empty IAM
 * policy: Cloud Run answered 403 before the code ran, the client SDK reported a
 * bare `permission-denied`, and inviting somebody to an organization was simply
 * broken there behind green deploys. How they lost the binding was never
 * established — a deploy that creates a function and then fails to set its IAM
 * is the likely cause — and it was found by accident (scripts/router-spike.mjs
 * compares a callable with its router, and the two disagreed). So:
 *
 *   5. a function that is meant to be called from outside — a callable, or a
 *      plain HTTP function: the webhooks, `api`, the callable routers — must
 *      grant `roles/run.invoker` to `allUsers`. WHICH functions those are is
 *      read off the labels firebase-tools writes (`deployment-callable`,
 *      `-taskqueue`, `-scheduled`, `-blocking`) and the presence of an event
 *      trigger, not listed here: a task queue, a schedule, a blocking function
 *      and an event trigger are invoked by a service account and are NOT judged.
 *      A redeploy does not repair this one — the hash is current, so the deploy
 *      skips the function — which is why the remedy printed is the IAM binding.
 *
 * A function missing from the project entirely (a create that never ran) is
 * not visible here: the deploy step's "Deploy complete!" check owns that case.
 *
 * Anything still reconciling is re-read until it settles or --timeout passes.
 * Exit 0: every function serves its newest revision. Exit 1: the list, with the
 * reason, the revision each one is actually serving and its date, and the
 * commands that redeploy them. Exit 2: the project's state could not be read.
 *
 * Auth: Application Default Credentials — in CI the credential file the
 * google-github-actions/auth step writes, locally
 * `gcloud auth application-default login`. Read-only; it needs
 * run.services.list, run.services.getIamPolicy, run.revisions.get,
 * cloudfunctions.functions.list and serviceusage.services.use on the project
 * (roles/run.admin, which the deploy identity holds, and roles/viewer both
 * carry getIamPolicy). A policy that cannot be READ is exit 2, never a pass.
 */
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const RUN_API = 'https://run.googleapis.com/v2'
const FUNCTIONS_API = 'https://cloudfunctions.googleapis.com/v2'

/** Function states that are still moving; any other state but ACTIVE is a failure. */
const FUNCTION_SETTLING = new Set(['DEPLOYING', 'DELETING'])
/** Cloud Run terminal-condition states that are still moving. */
const SERVICE_SETTLING = new Set(['CONDITION_PENDING', 'CONDITION_RECONCILING'])

const lastSegment = (name) => (name ? String(name).split('/').pop() : '')

/** The first paragraph of a Cloud Run / Cloud Functions message — drops the logs URL and the troubleshooting link. */
function firstParagraph(message) {
  if (!message) return null
  return (
    String(message)
      .split(/\n\s*\n/)[0]
      .replace(/\s+/g, ' ')
      .trim() || null
  )
}

/**
 * One verdict per function, from the Cloud Functions v2 and Cloud Run Admin v2
 * list payloads for one region. Pure.
 *
 * Driven by the FUNCTIONS, not the services: a Cloud Run service no function
 * owns is not this check's business, and a function with no service is exactly
 * the case a service list cannot see.
 *
 * @returns {Array<{ id: string, state: string|null, service: string|null,
 *   verdict: 'ok'|'settling'|'failed', reason?: string, message?: string|null,
 *   serving?: string|null, newest?: string|null }>}
 */
export function assessReadiness({ functions, services }) {
  const byService = new Map(services.map((s) => [lastSegment(s.name), s]))
  const latestHash = latestDeployHash(functions)
  return functions.map((fn) => {
    const base = {
      id: lastSegment(fn.name),
      state: fn.state ?? null,
      service: lastSegment(fn.serviceConfig?.service) || null,
    }
    const fnMessage = firstParagraph(fn.stateMessages?.[0]?.message)

    if (FUNCTION_SETTLING.has(fn.state)) return { ...base, verdict: 'settling', reason: fn.state }
    if (fn.state !== 'ACTIVE') {
      return {
        ...base,
        verdict: 'failed',
        reason: `function ${fn.state ?? 'state unknown'}`,
        message: fnMessage,
      }
    }

    const svc = base.service ? byService.get(base.service) : undefined
    if (!svc)
      return { ...base, verdict: 'failed', reason: 'no Cloud Run service', message: fnMessage }

    const serving = lastSegment(svc.latestReadyRevision) || null
    const newest = lastSegment(svc.latestCreatedRevision) || null
    const condition = svc.terminalCondition ?? {}

    if (svc.reconciling || SERVICE_SETTLING.has(condition.state)) {
      return { ...base, verdict: 'settling', reason: 'reconciling', serving, newest }
    }
    if (condition.state !== 'CONDITION_SUCCEEDED') {
      return {
        ...base,
        verdict: 'failed',
        reason: condition.revisionReason ?? condition.reason ?? condition.state ?? 'not ready',
        message: firstParagraph(condition.message),
        serving,
        newest,
      }
    }
    // Ready can read SUCCEEDED while an older revision still takes the traffic,
    // so the revision names are compared rather than trusted to agree.
    if (!serving || serving !== newest) {
      return { ...base, verdict: 'failed', reason: 'newest revision not serving', serving, newest }
    }
    // Healthy is not the same as deployed: a function the deploy never reached
    // keeps serving the previous release without a single failed condition.
    const hash = deployHash(fn)
    if (latestHash && hash && hash !== latestHash) {
      return {
        ...base,
        verdict: 'failed',
        reason: 'not updated by the latest deploy',
        message: `on deploy hash ${hash.slice(0, 8)}, not ${latestHash.slice(0, 8)}`,
        serving,
        newest,
      }
    }
    return { ...base, verdict: 'ok', serving, newest }
  })
}

const deployHash = (fn) => fn.labels?.['firebase-functions-hash'] ?? null

/**
 * The hash the latest deploy wrote: the one on the most recently updated
 * function — not the most common one, which after a deploy that reached fewer
 * than half the functions would be the OLD release's. Functions without the
 * label (not deployed by firebase-tools) are not judged by it. Pure.
 */
export function latestDeployHash(functions) {
  let latest = null
  for (const fn of functions) {
    const hash = deployHash(fn)
    const at = Date.parse(fn.updateTime ?? '')
    if (hash && Number.isFinite(at) && (!latest || at > latest.at)) latest = { hash, at }
  }
  return latest?.hash ?? null
}

/**
 * The commands that bring the failed functions back, in order. A plain
 * redeploy of the same tree skips any whose hash is already current (see the
 * header), so every one is named with --only; a FAILED function is deleted
 * first, because updating a function whose service is gone is not reliable.
 * Pure.
 */
export function redeployCommands({ project, region, failed }) {
  if (!failed.length) return []
  const deletes = failed
    .filter((f) => f.state === 'FAILED')
    .map(
      (f) =>
        `npx firebase-tools functions:delete ${f.id} --region ${region} --project ${project} --force`
    )
  const only = failed.map((f) => `functions:${f.id}`).join(',')
  return [...deletes, `npx firebase-tools deploy --project ${project} --only ${only}`]
}

// ─── invoker (check 5) ───────────────────────────────────────────────────────

/** Labels firebase-tools puts on a function that a SERVICE ACCOUNT invokes. */
const NOT_CALLED_FROM_OUTSIDE = [
  'deployment-taskqueue',
  'deployment-scheduled',
  'deployment-blocking',
]

/**
 * HTTP functions that are PRIVATE on purpose (`invoker: 'private'` or a named
 * service account). Each entry says why. Empty is the expected state: every
 * plain HTTP function here is a webhook, the public API or a callable router.
 */
const PRIVATE_ON_PURPOSE = new Set([])

/** Is this function meant to be called by anyone on the internet? Pure. */
export function expectsPublicInvoker(fn) {
  if (fn.eventTrigger) return false
  const labels = fn.labels ?? {}
  if (NOT_CALLED_FROM_OUTSIDE.some((l) => l in labels)) return false
  return !PRIVATE_ON_PURPOSE.has(lastSegment(fn.name))
}

/** Does this IAM policy let anyone invoke the service? Pure. */
export function grantsPublicInvoker(policy) {
  return (policy?.bindings ?? []).some(
    (b) => b.role === 'roles/run.invoker' && (b.members ?? []).includes('allUsers')
  )
}

/**
 * One verdict per function that is meant to be public. `policies` maps a Cloud
 * Run service name to its IAM policy. A function with no service is not judged
 * here — assessReadiness already failed it, for a better reason. Pure.
 *
 * @returns {Array<{ id: string, service: string, verdict: 'ok'|'failed', reason?: string }>}
 */
export function assessInvokers({ functions, policies }) {
  const out = []
  for (const fn of functions) {
    if (!expectsPublicInvoker(fn)) continue
    const service = lastSegment(fn.serviceConfig?.service)
    if (!service || !policies.has(service)) continue
    const id = lastSegment(fn.name)
    if (grantsPublicInvoker(policies.get(service))) out.push({ id, service, verdict: 'ok' })
    else out.push({ id, service, verdict: 'failed', reason: 'no public invoker' })
  }
  return out
}

/** The commands that restore the binding. A redeploy does not: see the header. Pure. */
export function invokerCommands({ project, region, failed }) {
  return failed.map(
    (f) =>
      `gcloud run services add-iam-policy-binding ${f.service} --region ${region} --project ${project} --member allUsers --role roles/run.invoker`
  )
}

/** The reasons behind the failures, most common first, with revision names taken out so identical causes group. Pure. */
export function summariseReasons(failed) {
  const counts = new Map()
  for (const f of failed) {
    const message =
      f.message?.replace(/^Revision '[^']+' is not ready and cannot serve traffic\.\s*/, '') ?? null
    const key = message ? `${f.reason}: ${message}` : f.reason
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { region: 'europe-west6', timeout: 300, interval: 15 }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=')
    const value = inline ?? argv[++i]
    if (flag === '--project') args.project = value
    else if (flag === '--region') args.region = value
    else if (flag === '--timeout') args.timeout = Number(value)
    else if (flag === '--interval') args.interval = Number(value)
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!args.project) throw new Error('--project is required (a project id, e.g. linyup-prod)')
  if (!(args.timeout >= 0) || !(args.interval > 0))
    throw new Error('--timeout and --interval take seconds')
  return args
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** GET with a short retry on 429/5xx: a blip must not read as "not ready", nor as ready. */
async function getJson(url, headers) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, { headers })
    if (res.ok) return res.json()
    const body = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(attempt * 2000)
      continue
    }
    throw new Error(`${res.status} from ${new URL(url).pathname}: ${body.slice(0, 300)}`)
  }
}

async function listAll(url, key, headers) {
  const items = []
  let pageToken
  do {
    const page = new URL(url)
    page.searchParams.set('pageSize', '500')
    if (pageToken) page.searchParams.set('pageToken', pageToken)
    const body = await getJson(page, headers)
    items.push(...(body[key] ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)
  return items
}

/** When each failed function's SERVING revision was created — how old the code is that it still runs. */
async function servingDates({ project, region, failed, headers }) {
  const dates = new Map()
  const queue = failed.filter((f) => f.service && f.serving).slice(0, 300)
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const url = `${RUN_API}/projects/${project}/locations/${region}/services/${f.service}/revisions/${f.serving}`
      try {
        const revision = await getJson(url, headers)
        if (revision.createTime) dates.set(f.id, revision.createTime.slice(0, 10))
      } catch {
        // the date is context, not the verdict
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return dates
}

/**
 * The IAM policy of every service a public function runs on. Eight at a time,
 * like servingDates. A policy that cannot be read THROWS: "could not check" must
 * never look like "checked, fine" — main turns it into exit 2.
 */
async function invokerPolicies({ project, region, functions, headers }) {
  const services = [
    ...new Set(
      functions
        .filter(expectsPublicInvoker)
        .map((fn) => lastSegment(fn.serviceConfig?.service))
        .filter(Boolean)
    ),
  ]
  const policies = new Map()
  const queue = [...services]
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const url = `${RUN_API}/projects/${project}/locations/${region}/services/${s}:getIamPolicy`
      policies.set(s, await getJson(url, headers))
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return policies
}

/** Prints check 5's verdict; returns its exit code (0 or 1). */
function reportInvokers({ project, region, invokers }) {
  const failed = invokers
    .filter((v) => v.verdict === 'failed')
    .sort((a, b) => a.id.localeCompare(b.id))
  if (!failed.length) {
    console.log(
      `✔ every function meant to be called from outside can be (${invokers.length} checked for a public invoker)`
    )
    return 0
  }
  const headline = `${project} (${region}): ${failed.length} of ${invokers.length} public functions have NO public invoker — every call to them is refused with 403 before the code runs`
  console.log(`\n${headline}`)
  for (const f of failed) console.log(`  ${f.id}`)
  console.log(
    '\nA redeploy does not repair this: the deploy hash is current, so the function is skipped.' +
      '\nRestore the binding:'
  )
  for (const c of invokerCommands({ project, region, failed })) console.log(`  ${c}`)
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Functions with no public invoker::${headline}. See this step's log.`)
  }
  stepSummary([
    '',
    `### Cloud Functions: NO public invoker`,
    '',
    headline,
    '',
    ...failed.slice(0, 150).map((f) => `- \`${f.id}\``),
  ])
  return 1
}

async function accessToken() {
  // Imported here so the pure functions above load without firebase-admin.
  const { applicationDefault } = await import('firebase-admin/app')
  const { access_token: token } = await applicationDefault().getAccessToken()
  return token
}

function stepSummary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { project, region } = args
  // The checked project doubles as the quota project: its APIs are enabled by
  // definition, and a local user credential is refused without one.
  const headers = { Authorization: `Bearer ${await accessToken()}`, 'x-goog-user-project': project }
  const deadline = Date.now() + args.timeout * 1000

  let verdicts
  let functions
  for (;;) {
    let services
    ;[functions, services] = await Promise.all([
      listAll(
        `${FUNCTIONS_API}/projects/${project}/locations/${region}/functions`,
        'functions',
        headers
      ),
      listAll(`${RUN_API}/projects/${project}/locations/${region}/services`, 'services', headers),
    ])
    verdicts = assessReadiness({ functions, services })
    const settling = verdicts.filter((v) => v.verdict === 'settling')
    if (!settling.length || Date.now() + args.interval * 1000 > deadline) break
    const names = settling
      .slice(0, 6)
      .map((v) => v.id)
      .join(', ')
    console.log(
      `${settling.length} still settling (${names}${settling.length > 6 ? ', …' : ''}); re-reading in ${args.interval}s`
    )
    await sleep(args.interval * 1000)
  }

  const ok = verdicts.filter((v) => v.verdict === 'ok')
  const failed = verdicts
    .filter((v) => v.verdict === 'failed')
    .sort((a, b) => a.id.localeCompare(b.id))
  const settling = verdicts.filter((v) => v.verdict === 'settling')
  const headline =
    `${project} (${region}): ${verdicts.length} functions — ${ok.length} serving the deployed code` +
    (failed.length ? `, ${failed.length} not` : '') +
    (settling.length ? `, ${settling.length} still settling after ${args.timeout}s` : '')
  console.log(headline)

  // Check 5 runs on its own: a function can pass 1–4 and still refuse everybody.
  const invokers = assessInvokers({
    functions,
    policies: await invokerPolicies({ project, region, functions, headers }),
  })

  if (!failed.length && !settling.length) {
    console.log('✔ every function is serving the code that was deployed')
    stepSummary([`### Cloud Functions: ready`, '', headline])
    return reportInvokers({ project, region, invokers })
  }

  const dates = await servingDates({ project, region, failed, headers })
  console.log('\nWhy:')
  for (const { reason, count } of summariseReasons(failed)) console.log(`  ${count} × ${reason}`)

  console.log('\nNot serving the deployed code:')
  const rows = failed.map((f) => {
    const serving = f.serving
      ? `serving ${f.serving}${dates.has(f.id) ? ` (${dates.get(f.id)})` : ''}`
      : f.service
        ? 'serving nothing — its newest revision never became ready'
        : `no Cloud Run service (function ${f.state})`
    const newest =
      f.serving && f.newest && f.newest !== f.serving ? `; newest ${f.newest} did not come up` : ''
    const untouched =
      f.reason === 'not updated by the latest deploy' ? '; the latest deploy never reached it' : ''
    return { id: f.id, text: `${serving}${newest}${untouched}` }
  })
  const width = Math.max(...rows.map((r) => r.id.length))
  for (const r of rows) console.log(`  ${r.id.padEnd(width)}  ${r.text}`)
  if (settling.length)
    console.log(`\nStill settling after ${args.timeout}s: ${settling.map((v) => v.id).join(', ')}`)

  const commands = redeployCommands({ project, region, failed })
  if (commands.length) {
    console.log(
      '\nA plain redeploy of the same tree skips any whose hash is already current; naming them with' +
        '\n--only redeploys them regardless. From a checkout of the deployed commit, built and vendored' +
        '\nthe way the deploy workflow does it, once the cause is fixed:'
    )
    for (const c of commands) console.log(`  ${c}`)
  }

  if (process.env.GITHUB_ACTIONS) {
    console.log(
      `::error title=Functions not serving the deployed code::${headline}. See this step's log.`
    )
  }
  stepSummary([
    `### Cloud Functions: NOT all serving the deployed code`,
    '',
    headline,
    '',
    ...summariseReasons(failed).map(({ reason, count }) => `- ${count} × ${reason}`),
    '',
    '| Function | State |',
    '| --- | --- |',
    ...rows.slice(0, 150).map((r) => `| \`${r.id}\` | ${r.text} |`),
  ])
  // Still say what check 5 found: the two failures have different remedies.
  reportInvokers({ project, region, invokers })
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`check-functions-ready: could not read the project's state — ${err.message}`)
      process.exit(2)
    }
  )
}
