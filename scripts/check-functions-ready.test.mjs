// Tests for scripts/check-functions-ready.mjs — run with `pnpm test:scripts`.
//
// The fixture is the defect itself, twice: real list payloads captured on
// 2026-09-18 from the two green deploys that had not deployed — sandbox after
// the CPU quota refused its revisions, and production after firebase-tools
// abandoned every 512Mi function. Every case below that is not in it is DERIVED
// from one of its entries, and says so.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  assessReadiness,
  latestDeployHash,
  redeployCommands,
  summariseReasons,
} from './check-functions-ready.mjs'

const fixture = JSON.parse(
  readFileSync(new URL('./check-functions-ready.fixture.json', import.meta.url), 'utf8')
)
const { sandboxQuota, prodUntouched } = fixture
const clone = (value) => JSON.parse(JSON.stringify(value))
const byId = (verdicts) => Object.fromEntries(verdicts.map((v) => [v.id, v]))
const pick = (state, kind, id) => clone(state[kind].find((x) => x.name.endsWith(`/${kind}/${id}`)))
const fn = (id, state = sandboxQuota) => pick(state, 'functions', id)
const svc = (id, state = sandboxQuota) => pick(state, 'services', id)

test('sandbox, 2026-09-18: every stale function is caught, the healthy one passes', () => {
  const v = byId(assessReadiness(sandboxQuota))

  assert.equal(v.createTeam.verdict, 'ok')

  // ACTIVE in Cloud Functions and still answering requests — from a 2026-09-04 revision.
  assert.equal(v.onContactWrite.state, 'ACTIVE')
  assert.equal(v.onContactWrite.verdict, 'failed')
  assert.equal(v.onContactWrite.reason, 'HEALTH_CHECK_CONTAINER_ERROR')
  assert.equal(v.onContactWrite.serving, 'oncontactwrite-00095-ner')
  assert.equal(v.onContactWrite.newest, 'oncontactwrite-00102-fos')
  assert.match(v.onContactWrite.message, /Quota exceeded for total allowable CPU/)
  assert.doesNotMatch(v.onContactWrite.message, /Logs URL/)

  // Created in that state: nothing to fall back on.
  assert.equal(v.runTarif595BulkIssue.verdict, 'failed')
  assert.equal(v.runTarif595BulkIssue.serving, null)
})

test('prod, 2026-09-18: a healthy function the deploy never reached is caught by its hash', () => {
  const v = byId(assessReadiness(prodUntouched))

  assert.equal(v.createTeam.verdict, 'ok')

  // Nothing about dailyTasks is unhealthy — it simply runs the previous release.
  assert.equal(v.dailyTasks.state, 'ACTIVE')
  assert.equal(v.dailyTasks.serving, v.dailyTasks.newest)
  assert.equal(v.dailyTasks.verdict, 'failed')
  assert.equal(v.dailyTasks.reason, 'not updated by the latest deploy')
  assert.equal(v.dailyTasks.message, 'on deploy hash 03dadf98, not a15b3942')
})

test('the latest deploy is the most recently updated function, not the most common hash', () => {
  // Derived from prod: the deploy reached only createTeam, and two copies of
  // dailyTasks stand for the majority it never reached.
  const functions = [fn('createTeam', prodUntouched), fn('dailyTasks', prodUntouched)]
  const twin = fn('dailyTasks', prodUntouched)
  twin.name = twin.name.replace('dailyTasks', 'weeklyReports')
  functions.push(twin)
  const services = [svc('createteam', prodUntouched), svc('dailytasks', prodUntouched)]
  const weekly = svc('dailytasks', prodUntouched)
  weekly.name = weekly.name.replace('dailytasks', 'weeklyreports')
  twin.serviceConfig.service = weekly.name
  services.push(weekly)

  assert.equal(latestDeployHash(functions), 'a15b394230916addcd9e0d210315d749898c3ac9')
  assert.deepEqual(
    assessReadiness({ functions, services }).map((v) => [v.id, v.verdict]),
    [
      ['createTeam', 'ok'],
      ['dailyTasks', 'failed'],
      ['weeklyReports', 'failed'],
    ]
  )
})

test('one hash across the project passes; a function without the label is not judged by it', () => {
  // Derived from prod: dailyTasks brought onto the latest hash, then stripped of it.
  const current = fn('dailyTasks', prodUntouched)
  current.labels['firebase-functions-hash'] = fn('createTeam', prodUntouched).labels[
    'firebase-functions-hash'
  ]
  const services = prodUntouched.services
  assert.equal(
    assessReadiness({ functions: [fn('createTeam', prodUntouched), current], services }).every(
      (v) => v.verdict === 'ok'
    ),
    true
  )

  const unlabelled = fn('dailyTasks', prodUntouched)
  delete unlabelled.labels
  const [, v] = assessReadiness({
    functions: [fn('createTeam', prodUntouched), unlabelled],
    services,
  })
  assert.equal(v.verdict, 'ok')
})

test('a FAILED function with no Cloud Run service is caught through the functions list', () => {
  // The case a services-only check cannot see: there is no service to list.
  assert.equal(
    sandboxQuota.services.some((s) => s.name.endsWith('/handlebudgetnotification')),
    false
  )

  const v = byId(assessReadiness(sandboxQuota)).handleBudgetNotification
  assert.equal(v.verdict, 'failed')
  assert.equal(v.reason, 'function FAILED')
  assert.equal(v.service, null)
  assert.match(v.message, /Cloud Run service .* was not found/)
})

test('an ACTIVE function whose service is missing fails rather than passing', () => {
  const [v] = assessReadiness({ functions: [fn('createTeam')], services: [] })
  assert.equal(v.verdict, 'failed')
  assert.equal(v.reason, 'no Cloud Run service')
})

test('Ready SUCCEEDED is not trusted on its own: the newest revision must be the one serving', () => {
  // Derived from createTeam: a newer revision exists that is not the ready one.
  const service = svc('createteam')
  service.latestCreatedRevision = service.latestCreatedRevision.replace('00017', '00018')
  const [v] = assessReadiness({ functions: [fn('createTeam')], services: [service] })
  assert.equal(v.verdict, 'failed')
  assert.equal(v.reason, 'newest revision not serving')
})

test('reconciling services and deploying functions are settling, not failed', () => {
  // Derived from createTeam.
  const reconciling = svc('createteam')
  reconciling.reconciling = true
  reconciling.terminalCondition = { type: 'Ready', state: 'CONDITION_RECONCILING' }
  assert.equal(
    assessReadiness({ functions: [fn('createTeam')], services: [reconciling] })[0].verdict,
    'settling'
  )

  const deploying = fn('createTeam')
  deploying.state = 'DEPLOYING'
  assert.equal(
    assessReadiness({ functions: [deploying], services: [svc('createteam')] })[0].verdict,
    'settling'
  )
})

test('a Cloud Run service no function owns is ignored', () => {
  // Derived: a failed service that belongs to no function.
  const orphan = svc('oncontactwrite')
  orphan.name = orphan.name.replace('oncontactwrite', 'somethingelse')
  const verdicts = assessReadiness({
    functions: [fn('createTeam')],
    services: [svc('createteam'), orphan],
  })
  assert.deepEqual(
    verdicts.map((v) => [v.id, v.verdict]),
    [['createTeam', 'ok']]
  )
})

test('reasons group across functions once the revision names are taken out', () => {
  const failed = assessReadiness(sandboxQuota).filter((v) => v.verdict === 'failed')
  const reasons = summariseReasons(failed)
  assert.deepEqual(reasons[0], {
    reason:
      'HEALTH_CHECK_CONTAINER_ERROR: Quota exceeded for total allowable CPU per project per region.',
    count: 2,
  })
  assert.equal(reasons.length, 2)
  assert.match(reasons[1].reason, /^function FAILED: Cloud Run service/)
})

test('the redeploy names every failed function, and deletes a FAILED one first', () => {
  const failed = assessReadiness(sandboxQuota).filter((v) => v.verdict === 'failed')
  const commands = redeployCommands({ project: 'linyup-sandbox', region: 'europe-west6', failed })
  assert.deepEqual(commands, [
    'npx firebase-tools functions:delete handleBudgetNotification --region europe-west6 --project linyup-sandbox --force',
    'npx firebase-tools deploy --project linyup-sandbox --only ' +
      'functions:onContactWrite,functions:runTarif595BulkIssue,functions:handleBudgetNotification',
  ])
  assert.deepEqual(redeployCommands({ project: 'p', region: 'r', failed: [] }), [])
})
