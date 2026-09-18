// Tests for scripts/check-functions-ready.mjs — run with `pnpm test:scripts`.
//
// The fixture is the defect itself: real list payloads from linyup-sandbox on
// the day a green deploy was found to have left 81 functions on stale
// revisions. Every case below that is not in it is DERIVED from one of its
// entries, and says so.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { assessReadiness, redeployCommands, summariseReasons } from './check-functions-ready.mjs'

const fixture = JSON.parse(
  readFileSync(new URL('./check-functions-ready.fixture.json', import.meta.url), 'utf8')
)
const clone = (value) => JSON.parse(JSON.stringify(value))
const byId = (verdicts) => Object.fromEntries(verdicts.map((v) => [v.id, v]))
const fn = (id) => clone(fixture.functions.find((f) => f.name.endsWith(`/functions/${id}`)))
const svc = (id) => clone(fixture.services.find((s) => s.name.endsWith(`/services/${id}`)))

test('the 2026-09-18 sandbox state: every stale function is caught, the healthy one passes', () => {
  const v = byId(assessReadiness(fixture))

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

test('a FAILED function with no Cloud Run service is caught through the functions list', () => {
  // The case a services-only check cannot see: there is no service to list.
  assert.equal(
    fixture.services.some((s) => s.name.endsWith('/handlebudgetnotification')),
    false
  )

  const v = byId(assessReadiness(fixture)).handleBudgetNotification
  assert.equal(v.verdict, 'failed')
  assert.equal(v.reason, 'function FAILED')
  assert.equal(v.service, null)
  assert.match(v.message, /Cloud Run service .* was not found/)
})

test('an ACTIVE function whose service is missing fails rather than passing', () => {
  const functions = [fn('createTeam')]
  const [v] = assessReadiness({ functions, services: [] })
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
  const failed = assessReadiness(fixture).filter((v) => v.verdict === 'failed')
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
  const failed = assessReadiness(fixture).filter((v) => v.verdict === 'failed')
  const commands = redeployCommands({ project: 'linyup-sandbox', region: 'europe-west6', failed })
  assert.deepEqual(commands, [
    'npx firebase-tools functions:delete handleBudgetNotification --region europe-west6 --project linyup-sandbox --force',
    'npx firebase-tools deploy --project linyup-sandbox --only ' +
      'functions:onContactWrite,functions:runTarif595BulkIssue,functions:handleBudgetNotification',
  ])
  assert.deepEqual(redeployCommands({ project: 'p', region: 'r', failed: [] }), [])
})
