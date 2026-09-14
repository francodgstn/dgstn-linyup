// ─── REST /v1 — GET only ─────────────────────────────────────────────────────
//
// docs/public-api.md. Every route reads through api/resources/* (or an insight);
// the router only parses, dispatches and shapes errors. The OpenAPI document
// (api/openapi.ts) is keyed by `RestRouteKey` and reads its query parameters
// from `REST_QUERY`, so a route cannot exist undocumented and a parameter cannot
// be documented differently from how it is parsed.

import { API_SCOPES, type ApiScope, type TeamRole } from '@linyup/shared'
import { principalMay, type ApiPrincipal } from './auth/principal'
import type { ApiRequest, ApiResponse } from './access'
import { loadTeamContext, type TeamReadContext } from './context'
import { ApiError, toApiError } from './errors'
import { getClassFill } from './insights/classFill'
import { getContact, listContacts } from './resources/contacts'
import { listEvents } from './resources/events'
import { listActivities, listPlans } from './resources/offerings'
import { getContactHistory, getSessionRoster } from './resources/people'
import { getFinanceMonths, getWeeklyReports } from './resources/reports'
import { getSession, listSessions } from './resources/sessions'
import { listSubscriptions } from './resources/subscriptions'
import {
  classFillShape,
  contactListShape,
  eventListShape,
  financeReportShape,
  historyShape,
  parseInput,
  sessionListShape,
  subscriptionListShape,
  weeklyReportShape,
} from './schemas'
import { parseApiInstant } from './time'

export function sendApiError(res: ApiResponse, err: unknown): void {
  const e = toApiError(err)
  if (e.code === 'rate_limited' && typeof e.details?.retry_after === 'number') {
    res.set('Retry-After', String(e.details.retry_after))
  }
  res.status(e.status).json({
    error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.details ? { details: e.details } : {}) },
  })
}

/** The scopes granted to this credential, split by whether the member can use them now. */
export function describeScopes(principal: ApiPrincipal): { usable: ApiScope[]; unusable: ApiScope[] } {
  const granted = API_SCOPES.filter((s) => principal.scopes.has(s))
  return {
    usable: granted.filter((s) => principalMay(principal, s)),
    unusable: granted.filter((s) => !principalMay(principal, s)),
  }
}

/** `GET /v1/me`. */
export interface ApiCredentialInfo {
  object: 'credential'
  team: { id: string; name: string }
  role: TeamRole
  via: 'api_key' | 'oauth'
  scopes: { usable: ApiScope[]; unusable: ApiScope[] }
}

/** `GET /v1/team`. */
export interface ApiTeamInfo {
  object: 'team'
  id: string
  name: string
  slug: string | null
  language: string
  currency: string
  time_zone: string
}

/** The query parameters of each list route — parsed here, documented from here. */
export const REST_QUERY = {
  contacts: contactListShape(50, 200),
  contactHistory: historyShape(20, 100),
  sessions: sessionListShape(50, 200),
  subscriptions: subscriptionListShape(50, 200),
  events: eventListShape(50, 200),
  weeklyReports: weeklyReportShape,
  financeReports: financeReportShape,
  classFill: classFillShape,
}

type Route = (ctx: {
  req: ApiRequest
  principal: ApiPrincipal
  team: TeamReadContext
  nowMs: number
  id?: string
}) => Promise<unknown>

const range = (q: { from: string; to: string }, team: TeamReadContext) => ({
  fromMs: parseApiInstant(q.from, team.timeZone, 'from'),
  toMs: parseApiInstant(q.to, team.timeZone, 'to'),
})

/** `resource` → `id` present? → `sub` → handler. `*` stands for "any id". */
const ROUTES = {
  me: async ({ principal, team }): Promise<ApiCredentialInfo> => ({
    object: 'credential',
    team: { id: team.teamId, name: team.name },
    role: principal.role,
    via: principal.via.kind,
    scopes: describeScopes(principal),
  }),
  team: async ({ team }): Promise<ApiTeamInfo> => ({
    object: 'team',
    id: team.teamId,
    name: team.name,
    slug: team.slug,
    language: team.language,
    currency: team.currency,
    time_zone: team.timeZone,
  }),
  contacts: async ({ req, principal, team, nowMs }) => {
    const q = parseInput(REST_QUERY.contacts, req.query)
    return listContacts(
      principal,
      team,
      {
        limit: q.limit,
        cursor: q.cursor,
        lifecycle: q.lifecycle,
        query: q.q,
        engagement: q.engagement,
        tags: q.tags,
        coachId: q.coach_id,
        stages: q.stages,
        inactiveDays: q.inactive_days,
        hasPlan: q.has_plan,
        needsAttention: q.needs_attention,
      },
      nowMs
    )
  },
  'contacts/*': async ({ principal, team, nowMs, id }) => getContact(principal, team, id!, nowMs),
  'contacts/*/history': async ({ req, principal, team, nowMs, id }) =>
    getContactHistory(principal, team, id!, parseInput(REST_QUERY.contactHistory, req.query).limit, nowMs),
  sessions: async ({ req, principal, team, nowMs }) => {
    const q = parseInput(REST_QUERY.sessions, req.query)
    return listSessions(principal, { ...range(q, team), limit: q.limit, cursor: q.cursor, activityId: q.activity_id }, nowMs)
  },
  'sessions/*': async ({ principal, nowMs, id }) => getSession(principal, id!, nowMs),
  'sessions/*/roster': async ({ principal, team, nowMs, id }) => getSessionRoster(principal, team, id!, nowMs),
  activities: async ({ principal, team }) => listActivities(principal, team),
  plans: async ({ principal, team }) => listPlans(principal, team),
  subscriptions: async ({ req, principal, team, nowMs }) => {
    const q = parseInput(REST_QUERY.subscriptions, req.query)
    return listSubscriptions(principal, team, { state: q.state, limit: q.limit }, nowMs)
  },
  events: async ({ req, principal, team }) => {
    const q = parseInput(REST_QUERY.events, req.query)
    return listEvents(principal, team, { ...range(q, team), limit: q.limit })
  },
  'reports/weekly': async ({ req, principal, nowMs }) =>
    getWeeklyReports(principal, parseInput(REST_QUERY.weeklyReports, req.query).weeks, nowMs),
  'reports/finance': async ({ req, principal }) => {
    const q = parseInput(REST_QUERY.financeReports, req.query)
    return getFinanceMonths(principal, q.from, q.to)
  },
  'insights/class-fill': async ({ req, principal, team, nowMs }) => {
    const q = parseInput(REST_QUERY.classFill, req.query)
    return getClassFill(principal, team, { ...range(q, team), groupBy: q.group_by, activityId: q.activity_id }, nowMs)
  },
} satisfies Record<string, Route>

export type RestRouteKey = keyof typeof ROUTES
export const REST_ROUTE_KEYS = Object.keys(ROUTES) as RestRouteKey[]

const isRouteKey = (key: string): key is RestRouteKey => Object.prototype.hasOwnProperty.call(ROUTES, key)

/** Resolve `/v1/<resource>[/<id>[/<sub>]]` to a route key and the id, or null. */
export function matchRoute(path: string): { key: RestRouteKey; id?: string } | null {
  const [version, resource, second, third, ...rest] = path.split('/').filter(Boolean)
  if (version !== 'v1' || !resource || rest.length > 0) return null
  // Fixed two-segment routes first (`reports/weekly`), then id routes.
  const fixed = `${resource}/${second}`
  if (second && !third && isRouteKey(fixed)) return { key: fixed }
  if (!second) return isRouteKey(resource) ? { key: resource } : null
  const key = third ? `${resource}/*/${third}` : `${resource}/*`
  return isRouteKey(key) ? { key, id: decodeURIComponent(second) } : null
}

export async function handleRest(req: ApiRequest, res: ApiResponse, principal: ApiPrincipal, nowMs: number): Promise<void> {
  try {
    if (req.method !== 'GET') {
      res.set('Allow', 'GET')
      throw new ApiError('invalid_request', `${req.method} is not supported; this API is read-only`)
    }
    const match = matchRoute(req.path)
    if (!match) throw new ApiError('not_found', 'No such endpoint')
    const team = await loadTeamContext(principal.teamId)
    const route: Route = ROUTES[match.key]
    res.json(await route({ req, principal, team, nowMs, id: match.id }))
  } catch (err) {
    sendApiError(res, err)
  }
}
