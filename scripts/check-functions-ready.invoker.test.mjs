// Tests for check 5 of scripts/check-functions-ready.mjs — run with `pnpm test:scripts`.
//
// THE DEFECT: on 2026-09-20 two staging callables were ACTIVE, Ready, on their
// newest revision and on the latest deploy hash, and refused every caller — their
// Cloud Run service had no invoker. It was fixed before this check existed, so it
// could not be captured the way check-functions-ready.fixture.json captures the
// other two. The fixture here is REAL staging payloads taken after the fix — one
// function of each kind, and the healthy policy of one of the two services — and
// the defect is DERIVED from that policy by taking its binding away, which is
// exactly what `getIamPolicy` returned for those two: a version, an etag, nothing else.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  assessInvokers,
  expectsPublicInvoker,
  grantsPublicInvoker,
  invokerCommands,
} from './check-functions-ready.mjs'

const fixture = JSON.parse(
  readFileSync(new URL('./check-functions-ready.invoker.fixture.json', import.meta.url), 'utf8')
)
const clone = (value) => JSON.parse(JSON.stringify(value))
const fn = (id) => clone(fixture.functions.find((f) => f.name.endsWith(`/${id}`)))
const serviceOf = (f) => f.serviceConfig.service.split('/').pop()
const healthy = () => clone(fixture.healthyPolicy)
/** What the two broken services answered: the same policy, with no bindings at all. */
const noInvoker = () => {
  const { bindings: _dropped, ...rest } = healthy()
  return rest
}
const policiesFor = (functions, policyOf) =>
  new Map(functions.map((f) => [serviceOf(f), policyOf(f)]))

test('WHO is meant to be public is read off what firebase-tools wrote, kind by kind', () => {
  // called from outside: a callable, a callable router, a webhook, the public API
  for (const id of ['inviteOrgMember', 'bookSession', 'rpcMember', 'handleStripeWebhook', 'api']) {
    assert.equal(expectsPublicInvoker(fn(id)), true, `${id} should be judged`)
  }
  // invoked by a service account: a task queue, a schedule, a blocking function,
  // a Firestore trigger, a Pub/Sub trigger — granting them allUsers would be the bug
  for (const id of [
    'remindersForTeam',
    'dailyTasks',
    'beforeSignup',
    'onContactWrite',
    'handleBudgetNotification',
  ]) {
    assert.equal(expectsPublicInvoker(fn(id)), false, `${id} must NOT be judged`)
  }
})

test('the 2026-09-20 defect: healthy by every other check, and nobody can call it', () => {
  const broken = [fn('inviteOrgMember'), fn('getOrgMemberInvitation')]
  const fine = [fn('bookSession'), fn('rpcMember')]
  const policies = new Map([...policiesFor(broken, noInvoker), ...policiesFor(fine, healthy)])
  const verdicts = assessInvokers({ functions: [...broken, ...fine], policies })
  assert.deepEqual(
    verdicts.map((v) => [v.id, v.verdict]),
    [
      ['inviteOrgMember', 'failed'],
      ['getOrgMemberInvitation', 'failed'],
      ['bookSession', 'ok'],
      ['rpcMember', 'ok'],
    ]
  )
  assert.equal(verdicts[0].reason, 'no public invoker')
  // …and they really were healthy by the other checks, which is why nothing said so.
  for (const f of broken) assert.equal(f.state, 'ACTIVE')
})

test('the real healthy policy passes; near-misses do not', () => {
  assert.equal(grantsPublicInvoker(healthy()), true)
  assert.equal(grantsPublicInvoker(noInvoker()), false)
  assert.equal(grantsPublicInvoker(undefined), false)
  assert.equal(grantsPublicInvoker({ bindings: [] }), false)
  // the right role for somebody else, and the wrong role for everybody
  assert.equal(
    grantsPublicInvoker({
      bindings: [
        { role: 'roles/run.invoker', members: ['serviceAccount:x@y.iam.gserviceaccount.com'] },
      ],
    }),
    false
  )
  assert.equal(
    grantsPublicInvoker({ bindings: [{ role: 'roles/run.viewer', members: ['allUsers'] }] }),
    false
  )
  // allAuthenticatedUsers is NOT public: a signed-out visitor's booking would be refused
  assert.equal(
    grantsPublicInvoker({
      bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }],
    }),
    false
  )
})

test('a function that is not meant to be public is never failed for lacking an invoker', () => {
  const internal = [fn('remindersForTeam'), fn('dailyTasks'), fn('onContactWrite')]
  const verdicts = assessInvokers({
    functions: internal,
    policies: policiesFor(internal, noInvoker),
  })
  assert.deepEqual(verdicts, [], 'task queues, schedules and triggers are not judged at all')
})

test('a function whose policy was not read is not judged — readiness already failed it', () => {
  // No service ⇒ no policy to read; assessReadiness reports that one, with a better reason.
  const orphan = fn('bookSession')
  const verdicts = assessInvokers({ functions: [orphan], policies: new Map() })
  assert.deepEqual(verdicts, [])
})

test('the remedy is the IAM binding on the SERVICE — a redeploy would be skipped as unchanged', () => {
  const broken = [fn('inviteOrgMember')]
  const failed = assessInvokers({
    functions: broken,
    policies: policiesFor(broken, noInvoker),
  })
  assert.deepEqual(invokerCommands({ project: 'linyup-staging', region: 'europe-west6', failed }), [
    'gcloud run services add-iam-policy-binding inviteorgmember --region europe-west6 --project linyup-staging --member allUsers --role roles/run.invoker',
  ])
  assert.deepEqual(invokerCommands({ project: 'p', region: 'r', failed: [] }), [])
})
