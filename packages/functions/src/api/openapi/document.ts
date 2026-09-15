// ─── The OpenAPI document for /v1 ────────────────────────────────────────────
//
// docs/public-api.md. Built, not hand-maintained:
//
//   • OPERATIONS is a `Record<RestRouteKey, …>`, so a REST route without
//     documentation fails the typecheck (and the test checks every documented
//     path resolves back to its route through `matchRoute`).
//   • Query parameters come from `REST_QUERY` — the very shapes the router
//     parses with — through zod-to-json-schema.
//   • Response schemas live in components.ts, checked key-for-key against the
//     projection types.
//
// Served unauthenticated at GET /v1/openapi.json: it describes the API, holds
// no studio data, and a client needs it before it has a key.

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { API_SCOPE_REQUIREMENTS, type ApiScope } from '@linyup/shared'
import { REST_QUERY, REST_ROUTE_KEYS, type RestRouteKey } from '../rest'
import { COMPONENT_SCHEMAS, listOf, ref, type JsonSchema } from './components'

export const OPENAPI_DOCUMENT_VERSION = '1.0.0'

interface OperationDoc {
  path: string
  tag: 'Account' | 'People' | 'Schedule' | 'Offerings' | 'Memberships' | 'Reports'
  summary: string
  description?: string
  /** Scopes the credential needs, all of them. Empty = any valid credential. */
  scopes: ApiScope[]
  query?: z.ZodRawShape
  response: JsonSchema
}

export const OPERATIONS: Record<RestRouteKey, OperationDoc> = {
  me: {
    path: '/v1/me',
    tag: 'Account',
    summary: 'The credential in use',
    description: 'The team, the member it acts as, and which granted scopes the member’s current role lets it use.',
    scopes: [],
    response: ref('Credential'),
  },
  team: {
    path: '/v1/team',
    tag: 'Account',
    summary: 'The studio',
    description: 'Name, language, currency and the time zone bare dates in requests are read in.',
    scopes: [],
    response: ref('Team'),
  },
  contacts: {
    path: '/v1/contacts',
    tag: 'People',
    summary: 'List contacts',
    description:
      'Current contacts ordered by last name, filtered in memory within a read budget: when `scan_exhausted` is true the page stopped early, continue with `next_cursor`. A coach’s credential lists only the coach’s own contacts.',
    scopes: ['contacts:read'],
    query: REST_QUERY.contacts,
    response: listOf('Contact'),
  },
  'contacts/*': {
    path: '/v1/contacts/{id}',
    tag: 'People',
    summary: 'Get a contact',
    description: 'The same 404 for a contact that does not exist, belongs to another team, is outside a coach’s scope, or was deleted.',
    scopes: ['contacts:read'],
    response: ref('Contact'),
  },
  'contacts/*/history': {
    path: '/v1/contacts/{id}/history',
    tag: 'People',
    summary: "A contact's bookings and check-ins",
    scopes: ['contacts:read', 'schedule:read'],
    query: REST_QUERY.contactHistory,
    response: ref('ContactHistory'),
  },
  sessions: {
    path: '/v1/sessions',
    tag: 'Schedule',
    summary: 'List sessions',
    description: 'Classes and appointments starting in a window of at most 62 days. Blocked time and lapsed payment holds are left out.',
    scopes: ['schedule:read'],
    query: REST_QUERY.sessions,
    response: listOf('Session'),
  },
  'sessions/*': {
    path: '/v1/sessions/{id}',
    tag: 'Schedule',
    summary: 'Get a session',
    scopes: ['schedule:read'],
    response: ref('Session'),
  },
  'sessions/*/roster': {
    path: '/v1/sessions/{id}/roster',
    tag: 'Schedule',
    summary: "A session's bookings and check-ins",
    description:
      'Names come from the contact documents. A row about someone this credential may not name is left out and counted in `hidden_bookings` / `hidden_attendance`; without contacts:read every row is hidden.',
    scopes: ['schedule:read'],
    response: ref('SessionRoster'),
  },
  activities: {
    path: '/v1/activities',
    tag: 'Offerings',
    summary: 'List activities',
    description: 'Classes and appointment types with their access rules, drop-in and trial prices, and appointment lengths.',
    scopes: ['offerings:read'],
    response: listOf('Activity'),
  },
  plans: {
    path: '/v1/plans',
    tag: 'Offerings',
    summary: 'List plans',
    scopes: ['offerings:read'],
    response: listOf('Plan'),
  },
  subscriptions: {
    path: '/v1/subscriptions',
    tag: 'Memberships',
    summary: 'List memberships',
    description: 'Stripe memberships by state, newest first. Amounts only for members holding reports.view.',
    scopes: ['subscriptions:read'],
    query: REST_QUERY.subscriptions,
    response: listOf('Subscription'),
  },
  events: {
    path: '/v1/events',
    tag: 'Schedule',
    summary: 'List events',
    description: 'The team’s own events starting in a window of at most 366 days.',
    scopes: ['schedule:read'],
    query: REST_QUERY.events,
    response: listOf('Event'),
  },
  'reports/weekly': {
    path: '/v1/reports/weekly',
    tag: 'Reports',
    summary: 'Weekly figures',
    description: 'The stored weekly reports for the last N weeks, oldest first.',
    scopes: ['reports:read'],
    query: REST_QUERY.weeklyReports,
    response: listOf('WeeklyReport'),
  },
  'reports/finance': {
    path: '/v1/reports/finance',
    tag: 'Reports',
    summary: 'Monthly revenue',
    description: 'The stored monthly finance reports, at most 24 months. 409 `feature_unavailable` without the Finance plugin.',
    scopes: ['finance:read'],
    query: REST_QUERY.financeReports,
    response: listOf('FinanceMonth'),
  },
  'insights/class-fill': {
    path: '/v1/insights/class-fill',
    tag: 'Schedule',
    summary: 'Class fill rates',
    description:
      'How full classes were over at most 92 days, grouped by class, weekly slot or instructor. Needs a view of the whole schedule (not a coach limited to their own sessions).',
    scopes: ['schedule:read'],
    query: REST_QUERY.classFill,
    response: ref('ClassFill'),
  },
}

/**
 * zod-to-json-schema's generic signature instantiates too deeply against these
 * shapes (the same wall `registerReadTool` works around for the MCP SDK); the
 * conversion itself needs nothing from it, so it is called through this alias.
 */
const toJsonSchema = zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: Record<string, unknown>) => JsonSchema

function isArraySchema(schema: JsonSchema): boolean {
  return schema.type === 'array'
}

/** A zod shape as OpenAPI query parameters, straight from the schemas the router parses with. */
export function queryParameters(shape: z.ZodRawShape): JsonSchema[] {
  return Object.entries(shape).map(([name, zodType]) => {
    // Optionality is the parameter's `required: false`, not part of its schema:
    // converted as-is, an optional becomes `anyOf: [{ not: {} }, …]`, which hides
    // the type and is not valid OpenAPI 3.0. `.describe()` usually sits on the
    // optional wrapper, so the description is taken before unwrapping.
    let inner: z.ZodTypeAny = zodType
    while (inner instanceof z.ZodOptional) inner = inner.unwrap()
    const schema = toJsonSchema(inner, { target: 'openApi3', $refStrategy: 'none' })
    const { description: innerDescription, ...rest } = schema
    const description = zodType.description ?? innerDescription
    return {
      name,
      in: 'query',
      required: !zodType.isOptional(),
      ...(typeof description === 'string' ? { description } : {}),
      schema: rest,
      // Lists are sent comma-separated: `engagement=at_risk,inactive`.
      ...(isArraySchema(rest) ? { style: 'form', explode: false } : {}),
    }
  })
}

function scopeText(scopes: ApiScope[]): string {
  if (scopes.length === 0) return 'Any valid credential.'
  const parts = scopes.map((s) => {
    const cap = API_SCOPE_REQUIREMENTS[s].capability
    return cap ? `\`${s}\` (and the member must currently hold \`${cap}\`)` : `\`${s}\``
  })
  return `Requires ${parts.join(' and ')}.`
}

export function buildOpenApiDocument(serverUrl: string): JsonSchema {
  const paths: Record<string, JsonSchema> = {}
  for (const key of REST_ROUTE_KEYS) {
    const op = OPERATIONS[key]
    const pathParams = op.path.includes('{id}')
      ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
      : []
    paths[op.path] = {
      get: {
        operationId: key.replace(/\/\*\//g, '_').replace(/\/\*$/, '_get').replace(/[/-]/g, '_'),
        tags: [op.tag],
        summary: op.summary,
        description: [op.description, scopeText(op.scopes)].filter(Boolean).join('\n\n'),
        'x-linyup-scopes': op.scopes,
        security: [{ bearer: [] }],
        parameters: [...pathParams, ...(op.query ? queryParameters(op.query) : [])],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: op.response } } },
          '4XX': { $ref: '#/components/responses/Error' },
        },
      },
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Linyup API',
      version: OPENAPI_DOCUMENT_VERSION,
      description: [
        'Read-only access to one studio’s data. Authenticate with `Authorization: Bearer <key>`, a key created by the studio owner under Settings → API keys.',
        'A key acts as the member who created it: what it may read is its scopes intersected with that member’s CURRENT role, re-checked on every request.',
        'Money is in integer minor units beside its currency. Instants are ISO 8601 UTC. A bare date (YYYY-MM-DD) in a request is a day in the studio’s time zone (GET /v1/team).',
        'Personal contact details (email, phone, birthdate, address) appear only with the `contacts:read:pii` scope. Notes, AI summaries, custom fields, booking answers and payment identifiers are never returned.',
      ].join('\n\n'),
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: 'Account' },
      { name: 'People' },
      { name: 'Schedule' },
      { name: 'Offerings' },
      { name: 'Memberships' },
      { name: 'Reports' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'lyp_live_… API key' },
      },
      responses: {
        Error: {
          description: 'An error: 400 invalid_request / invalid_cursor, 401 unauthenticated, 403 insufficient_scope, 404 not_found, 409 feature_unavailable, 422 window_too_wide, 429 rate_limited (with Retry-After).',
          content: { 'application/json': { schema: ref('Error') } },
        },
      },
      schemas: COMPONENT_SCHEMAS,
    },
  }
}
