// Tests for scripts/functions-inventory.mjs — run with `pnpm test:scripts`.
//
// Synthetic input only: the pure half (index parsing, option rendering,
// classification, the summary) is what can rot silently. Loading the real
// bundle is the CLI's job and takes tens of seconds, so it is not done here.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classify,
  crossCheck,
  formatTsv,
  parseIndexExports,
  renderOption,
  summarise,
  toRecord,
} from './functions-inventory.mjs'

// The SDK's two non-literal option values, by the shape renderOption keys on.
class ResetValue {
  toJSON() {
    return null
  }
}
class IntParam {
  constructor(name) {
    this.name = name
  }
  toCEL() {
    return `{{ params.${this.name} }}`
  }
  toString() {
    return `params.${this.name}`
  }
  value() {
    throw new Error('renderOption must never evaluate a param')
  }
}
const RESET = new ResetValue()

const base = {
  platform: 'gcfv2',
  region: ['europe-west6'],
  availableMemoryMb: RESET,
  timeoutSeconds: RESET,
  minInstances: RESET,
  maxInstances: 20,
  concurrency: RESET,
  serviceAccountEmail: RESET,
  labels: {},
}
const firestore = (verb, document, retry = false) => ({
  ...base,
  eventTrigger: {
    eventType: `google.cloud.firestore.document.v1.${verb}`,
    eventFilters: { database: '(default)', namespace: '(default)' },
    eventFilterPathPatterns: { document },
    retry,
  },
})
const GLOBALS = { region: ['europe-west6'], maxInstances: 20 }

test('parseIndexExports: multi-line, aliases, comments, CRLF, type-only', () => {
  const source = [
    "import * as admin from 'firebase-admin'",
    "// export { ghost } from './nowhere'",
    "export { createTeam } from './teams/createTeam'",
    'export {',
    '  bookSession, // the class rail',
    '  cancelBooking as cancelBookingV2,',
    "} from './booking'",
    "/* export { alsoGhost } from './nowhere' */",
    "export type { Thing } from './types'",
    "export { type Other, realOne } from './mixed/file'",
    "export * from './star'",
    'export const inline = 1',
  ].join('\r\n')
  const { exports, duplicates, unparsed } = parseIndexExports(source)

  assert.deepEqual([...exports.keys()].sort(), [
    'bookSession',
    'cancelBookingV2',
    'createTeam',
    'realOne',
  ])
  assert.deepEqual(exports.get('createTeam'), {
    local: 'createTeam',
    from: './teams/createTeam',
    domain: 'teams',
  })
  // The DEPLOYED name is the exported one; the domain is the folder, also for a bare './booking'.
  assert.deepEqual(exports.get('cancelBookingV2'), {
    local: 'cancelBooking',
    from: './booking',
    domain: 'booking',
  })
  assert.deepEqual(duplicates, [])
  assert.deepEqual(unparsed, ["export * from './star'", 'export const inline = 1'])
})

test('parseIndexExports: a name re-exported twice is reported', () => {
  const { duplicates } = parseIndexExports("export { a } from './x/a'\nexport { a } from './y/a'")
  assert.deepEqual(duplicates, ['a'])
})

test('renderOption: params and the reset sentinel read without being evaluated', () => {
  assert.equal(renderOption(new IntParam('API_MIN_INSTANCES')), 'param:API_MIN_INSTANCES')
  assert.equal(renderOption(RESET), 'reset')
  assert.equal(renderOption(undefined), null)
  assert.equal(renderOption(512), 512)
  assert.deepEqual(renderOption({ retryConfig: { maxAttempts: RESET, maxBackoffSeconds: 60 } }), {
    retryConfig: { maxAttempts: 'reset', maxBackoffSeconds: 60 },
  })
})

test('classify: one kind per trigger', () => {
  assert.equal(classify({ ...base, callableTrigger: {} }).kind, 'callable')
  assert.equal(classify({ ...base, httpsTrigger: {} }).kind, 'https')
  assert.equal(
    classify({ ...base, scheduleTrigger: { schedule: 'every 5 minutes' } }).kind,
    'schedule'
  )
  assert.equal(classify({ ...base, taskQueueTrigger: {} }).kind, 'taskQueue')
  assert.equal(
    classify({
      ...base,
      blockingTrigger: { eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate' },
    }).kind,
    'blocking.beforeCreate'
  )
  assert.deepEqual(classify(firestore('written', 'teams/{teamId}', true)), {
    kind: 'firestore.written',
    eventType: 'google.cloud.firestore.document.v1.written',
    path: 'teams/{teamId}',
    topic: null,
    retry: true,
  })
  // A literal path arrives in eventFilters rather than the path patterns.
  const literal = firestore('created', 'unused')
  literal.eventTrigger.eventFilterPathPatterns = {}
  literal.eventTrigger.eventFilters.document = 'app_settings/public'
  assert.equal(classify(literal).path, 'app_settings/public')
  assert.equal(
    classify(firestore('written.withAuthContext', 'teams/{teamId}')).kind,
    'firestore.written'
  )
  const pubsub = classify({
    ...base,
    eventTrigger: {
      eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
      eventFilters: { topic: 'budget' },
      retry: false,
    },
  })
  assert.equal(pubsub.kind, 'pubsub')
  assert.equal(pubsub.topic, 'budget')
  assert.equal(classify({ ...base }).kind, 'other')
  assert.equal(
    classify({
      ...base,
      eventTrigger: {
        eventType: 'google.cloud.storage.object.v1.finalized',
        eventFilters: {},
        retry: false,
      },
    }).kind,
    'other'
  )
})

test('toRecord: only what the function sets, or what differs from the globals, is non-default', () => {
  const plain = toRecord(
    'createTeam',
    { ...base, callableTrigger: {} },
    { from: './teams/createTeam', domain: 'teams' },
    GLOBALS
  )
  assert.deepEqual(plain.nonDefault, [])
  assert.equal(plain.memoryMb, 'reset')

  const api = toRecord(
    'api',
    {
      ...base,
      availableMemoryMb: 512,
      timeoutSeconds: 60,
      concurrency: 40,
      minInstances: new IntParam('API_MIN_INSTANCES'),
      maxInstances: 10,
      httpsTrigger: { invoker: ['public'] },
    },
    { from: './api', domain: 'api' },
    GLOBALS
  )
  assert.deepEqual(api.nonDefault, [
    'memory=512',
    'timeout=60',
    'concurrency=40',
    'minInstances=param:API_MIN_INSTANCES',
    'maxInstances=10',
    'invoker=public',
  ])

  const retried = toRecord(
    'onBundle',
    firestore('written', 'teams/{teamId}', true),
    undefined,
    GLOBALS
  )
  assert.deepEqual(retried.nonDefault, ['retry=true'])
  assert.equal(retried.domain, '?')

  // The TSV leaves a reset cell blank.
  const [, row] = formatTsv([retried]).split('\n')
  assert.match(row, /^onBundle\t\?\tfirestore\.written\t/)
  assert.ok(!row.includes('reset'))
})

test('summarize: counts, the domain matrix, and only genuinely mergeable trigger groups', () => {
  const at = (name, domain, endpoint) =>
    toRecord(name, endpoint, { from: `./${domain}/${name}`, domain }, GLOBALS)
  const records = [
    at('createContact', 'contacts', { ...base, callableTrigger: {} }),
    at('onContactWrite', 'contacts', firestore('written', 'contacts/{contactId}')),
    at('trackContacts', 'analytics', firestore('written', 'contacts/{contactId}')),
    // Same path, but a different event and a different retry: not the same group.
    at('onContactCreated', 'contacts', firestore('created', 'contacts/{contactId}')),
    at('retriedContactWrite', 'plugins', firestore('written', 'contacts/{contactId}', true)),
  ]
  const s = summarise(records)

  assert.equal(s.total, 5)
  assert.deepEqual(s.kinds, [
    { kind: 'callable', count: 1 },
    { kind: 'firestore.created', count: 1 },
    { kind: 'firestore.written', count: 3 },
  ])
  assert.deepEqual(s.families, [
    { family: 'callable', count: 1 },
    { family: 'firestore', count: 4 },
  ])
  assert.deepEqual(s.domains[0], {
    domain: 'contacts',
    callable: 1,
    'firestore.written': 1,
    'firestore.created': 1,
    total: 3,
  })
  assert.deepEqual(s.sharedPaths, [
    {
      path: 'contacts/{contactId}',
      kind: 'firestore.written',
      retry: false,
      names: ['onContactWrite', 'trackContacts'],
    },
  ])
  assert.deepEqual(
    s.nonDefault.map((r) => r.name),
    ['retriedContactWrite']
  )
})

test('crossCheck: a mismatch is reported in both directions', () => {
  assert.deepEqual(crossCheck(['a', 'b', 'stale'], ['a', 'b', 'rpcSpike']), {
    onlyInBundle: ['stale'],
    onlyInIndex: ['rpcSpike'],
  })
  assert.deepEqual(crossCheck(['a'], new Map([['a', {}]]).keys()), {
    onlyInBundle: [],
    onlyInIndex: [],
  })
})
