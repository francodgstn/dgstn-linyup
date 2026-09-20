// node --test scripts/alias-usage.test.mjs   (run by `pnpm test:scripts`)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MEMBER_APP_NAMES,
  buildReport,
  parseArgs,
  serviceNameOf,
  totalsByService,
} from './alias-usage.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const series = (service, cls, ...values) => ({
  resource: { labels: { service_name: service } },
  metric: { labels: { response_code_class: cls } },
  points: values.map((v) => ({ value: { int64Value: String(v) } })),
})

test('totalsByService: 2xx is `ok`, every other class is `other`, summed per service', () => {
  const totals = totalsByService([
    series('booksession', '2xx', 3, 4),
    series('booksession', '4xx', 10),
    series('booksession', '5xx', 1),
    series('deletecontact', '4xx', 18),
    { resource: { labels: {} }, points: [{ value: { int64Value: '99' } }] },
  ])
  assert.deepEqual(totals.get('booksession'), { ok: 7, other: 11 })
  assert.deepEqual(totals.get('deletecontact'), { ok: 0, other: 18 })
  assert.equal(
    totals.size,
    2,
    'a series with no service name is dropped, not filed under undefined'
  )
})

test('the PROBE PAIRS do not make a name look used — quiet means no 2xx', () => {
  // What a never-called callable looks like on a real project: 400s and 404s in
  // pairs on deploy days, and not one success.
  const totals = totalsByService([series('deletecontact', '4xx', 2, 2, 2, 2, 2, 2, 2, 2, 2)])
  const [row] = buildReport({ deleteContact: 'rpcStudio' }, totals)
  assert.equal(row.aliasOther, 18)
  assert.equal(row.aliasOk, 0)
  assert.equal(row.quiet, true)
})

test('buildReport: one successful call is enough to NOT be quiet', () => {
  const totals = totalsByService([series('booksession', '2xx', 1), series('rpcmember', '2xx', 40)])
  const rows = buildReport({ bookSession: 'rpcMember', listMyWaitlist: 'rpcMember' }, totals)
  const book = rows.find((r) => r.name === 'bookSession')
  const list = rows.find((r) => r.name === 'listMyWaitlist')
  assert.equal(book.quiet, false)
  assert.equal(book.routerOk, 40)
  assert.equal(book.memberApp, true, 'the member app calls bookSession')
  assert.equal(list.quiet, true)
  assert.equal(list.memberApp, false)
  assert.deepEqual(
    rows.map((r) => r.name),
    ['bookSession', 'listMyWaitlist'],
    'sorted, so two runs diff cleanly'
  )
})

test('a function is its Cloud Run service, lowercased', () => {
  assert.equal(serviceNameOf('getMyBookings'), 'getmybookings')
  assert.equal(serviceNameOf('rpcMember'), 'rpcmember')
})

test('parseArgs: the window is capped at what Cloud Monitoring keeps', () => {
  assert.equal(parseArgs(['--project', 'p', '--days', '400']).days, 42)
  assert.equal(parseArgs(['--project', 'p', '--days', '14']).days, 14)
  assert.equal(parseArgs(['--project', 'p', '--days', 'x']).days, 30)
  assert.equal(parseArgs(['--project', 'p']).region, 'europe-west6')
  assert.equal(parseArgs([]).project, null)
})

test('MEMBER_APP_NAMES is the frozen list’s member-app group, name for name', () => {
  // The frozen list OWNS these names (it re-derives them from apps/mobile). This
  // copy exists so the report can mark them; if the two disagree the report would
  // clear a name a store binary still calls.
  const src = readFileSync(
    join(ROOT, 'packages/functions/src/utils/frozenFunctions.test.ts'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  for (const name of MEMBER_APP_NAMES) {
    assert.match(src, new RegExp(`['"]${name}['"]`), `${name} is not on the frozen list`)
  }
  // …and the other direction: every literal the member app calls today is here.
  const mobile = readFileSync(join(ROOT, 'apps/mobile/src/services/firestore.ts'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  const called = [...mobile.matchAll(/callFunction(?:<[^()]*>)?\(\s*'([A-Za-z0-9_]+)'/g)].map(
    (m) => m[1]
  )
  assert.ok(
    called.length > 0,
    'found no callFunction call in the member app — the pattern is stale'
  )
  for (const name of called) {
    assert.ok(MEMBER_APP_NAMES.includes(name), `the member app calls ${name}; add it here`)
  }
})
