import * as assert from 'node:assert'
import { API_SCOPES, type ApiMoney, type ApiPerson } from '@linyup/shared'
import { REST_QUERY, REST_ROUTE_KEYS, matchRoute } from '../rest'
import { objectOf } from './components'
import { OPERATIONS, buildOpenApiDocument } from './document'

// The document is built from the router, its query shapes and the projection
// types, so these tests pin the joins: every route documented at a path that
// resolves back to it, every reference defined, every parameter the router
// parses and nothing else.

type Json = Record<string, any>

const doc = buildOpenApiDocument('https://api.example.test') as Json
const operations = () =>
  Object.entries(doc.paths as Json).map(([path, item]) => ({ path, op: (item as Json).get as Json }))

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v)
      else collectRefs(v, out)
    }
  }
  return out
}

describe('openapi document', () => {
  it('is an OpenAPI 3.0.3 document that survives JSON', () => {
    assert.strictEqual(doc.openapi, '3.0.3')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(doc)), doc)
    assert.strictEqual(doc.servers[0].url, 'https://api.example.test')
  })

  it('documents every REST route at a path that resolves back to that route', () => {
    assert.strictEqual(Object.keys(doc.paths).length, REST_ROUTE_KEYS.length)
    for (const key of REST_ROUTE_KEYS) {
      const concrete = OPERATIONS[key].path.replace('{id}', 'some-id')
      const match = matchRoute(concrete)
      assert.ok(match, `${OPERATIONS[key].path} does not resolve`)
      assert.strictEqual(match.key, key, `${OPERATIONS[key].path} resolves to ${match.key}, documented as ${key}`)
    }
  })

  it('defines every schema and response it references', () => {
    for (const r of collectRefs(doc)) {
      const [, section, name] = /^#\/components\/(schemas|responses)\/(.+)$/.exec(r) ?? []
      assert.ok(section && doc.components[section][name], `dangling reference ${r}`)
    }
  })

  it('gives every operation a unique id, bearer security, a 200 schema and real scopes', () => {
    const ids = new Set<string>()
    for (const { path, op } of operations()) {
      assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`)
      ids.add(op.operationId)
      assert.deepStrictEqual(op.security, [{ bearer: [] }], path)
      assert.ok(op.responses['200'].content['application/json'].schema, path)
      for (const scope of op['x-linyup-scopes']) assert.ok((API_SCOPES as readonly string[]).includes(scope), `${path}: ${scope}`)
      assert.strictEqual(op.parameters.some((p: Json) => p.in === 'path'), path.includes('{id}'), `${path} path parameter`)
    }
  })

  it('documents exactly the query parameters the router parses, as it parses them', () => {
    const contacts = (doc.paths['/v1/contacts'].get as Json).parameters as Json[]
    assert.deepStrictEqual(contacts.map((p) => p.name).sort(), Object.keys(REST_QUERY.contacts).sort())
    const byName = Object.fromEntries(contacts.map((p) => [p.name, p]))
    assert.strictEqual(byName.lifecycle.required, false)
    assert.strictEqual(byName.lifecycle.schema.default, 'live')
    assert.ok(byName.lifecycle.schema.enum.includes('roster'))
    assert.strictEqual(byName.inactive_days.schema.type, 'integer')
    assert.strictEqual(byName.engagement.schema.type, 'array')
    assert.strictEqual(byName.engagement.explode, false, 'lists are comma-separated')
    assert.strictEqual(byName.has_plan.schema.type, 'boolean')

    const sessions = Object.fromEntries(((doc.paths['/v1/sessions'].get as Json).parameters as Json[]).map((p) => [p.name, p]))
    assert.strictEqual(sessions.from.required, true)
    assert.strictEqual(sessions.limit.schema.maximum, 200)
  })

  it('writes optionality as `required: false`, never as a JSON Schema union OpenAPI 3.0 cannot read', () => {
    for (const { path, op } of operations()) {
      for (const p of op.parameters as Json[]) {
        const text = JSON.stringify(p.schema)
        assert.ok(!text.includes('"anyOf"') && !text.includes('"not"'), `${path} ${p.name}: ${text}`)
        assert.ok(p.schema.type, `${path} ${p.name} has no type`)
      }
    }
  })

  it('refuses, at compile time, a response schema that forgets a field or mislabels an optional one', () => {
    // These lines are the test: ts-node compiles this file, and an unused
    // `@ts-expect-error` is itself an error, so the guard must keep firing.
    const money = objectOf<ApiMoney>()
    // @ts-expect-error — `currency` is not documented
    money({ amount: {} }, [])
    const person = objectOf<ApiPerson>()
    // @ts-expect-error — `email` and `phone` are optional on ApiPerson and must be listed as such
    person({ contact_id: {}, first_name: {}, last_name: {}, email: {}, phone: {} }, [])
    // @ts-expect-error — `first_name` is not optional
    person({ contact_id: {}, first_name: {}, last_name: {}, email: {}, phone: {} }, ['email', 'phone', 'first_name'])
    const ok = person({ contact_id: {}, first_name: {}, last_name: {}, email: {}, phone: {} }, ['email', 'phone'])
    assert.deepStrictEqual((ok as Json).required, ['contact_id', 'first_name', 'last_name'])
  })

  it('marks personal details optional and nullable on a contact', () => {
    const contact = doc.components.schemas.Contact
    for (const field of ['email', 'phone', 'birthdate', 'address']) {
      assert.ok(contact.properties[field], field)
      assert.ok(!contact.required.includes(field), `${field} must not be required`)
    }
    assert.ok(contact.required.includes('lifecycle'))
    assert.strictEqual(contact.additionalProperties, false)
  })
})
