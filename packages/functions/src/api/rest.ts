// ─── REST /v1 — GET only ─────────────────────────────────────────────────────
//
// docs/public-api.md. Every route reads through api/resources/* (or an insight);
// the router only parses, dispatches and shapes errors.

import { API_SCOPES, type ApiScope } from '@linyup/shared'
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
const ROUTES: Record<string, Route> = {
  me: async ({ principal, team }) => ({
    object: 'credential',
    team: { id: team.teamId, name: team.name },
    role: principal.role,
    via: principal.via.kind,
    scopes: describeScopes(principal),
  }),
  team: async ({ team }) => ({
    object: 'team',
    id: team.teamId,
    name: team.name,
    slug: team.slug,
    language: team.language,
    currency: team.currency,
    time_zone: team.timeZone,
  }),
  contacts: async ({ req, principal, team, nowMs }) => {
    const q = parseInput(contactListShape(50, 200), req.query)
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
    getContactHistory(principal, team, id!, parseInput(historyShape(20, 100), req.query).limit, nowMs),
  sessions: async ({ req, principal, team, nowMs }) => {
    const q = parseInput(sessionListShape(50, 200), req.query)
    return listSessions(principal, { ...range(q, team), limit: q.limit, cursor: q.cursor, activityId: q.activity_id }, nowMs)
  },
  'sessions/*': async ({ principal, nowMs, id }) => getSession(principal, id!, nowMs),
  'sessions/*/roster': async ({ principal, team, nowMs, id }) => getSessionRoster(principal, team, id!, nowMs),
  activities: async ({ principal, team }) => listActivities(principal, team),
  plans: async ({ principal, team }) => listPlans(principal, team),
  subscriptions: async ({ req, principal, team, nowMs }) => {
    const q = parseInput(subscriptionListShape(50, 200), req.query)
    return listSubscriptions(principal, team, { state: q.state, limit: q.limit }, nowMs)
  },
  events: async ({ req, principal, team }) => {
    const q = parseInput(eventListShape(50, 200), req.query)
    return listEvents(principal, team, { ...range(q, team), limit: q.limit })
  },
  'reports/weekly': async ({ req, principal, nowMs }) =>
    getWeeklyReports(principal, parseInput(weeklyReportShape, req.query).weeks, nowMs),
  'reports/finance': async ({ req, principal }) => {
    const q = parseInput(financeReportShape, req.query)
    return getFinanceMonths(principal, q.from, q.to)
  },
  'insights/class-fill': async ({ req, principal, team, nowMs }) => {
    const q = parseInput(classFillShape, req.query)
    return getClassFill(principal, team, { ...range(q, team), groupBy: q.group_by, activityId: q.activity_id }, nowMs)
  },
}

/** Resolve `/v1/<resource>[/<id>[/<sub>]]` to a route key and the id, or null. */
export function matchRoute(path: string): { key: string; id?: string } | null {
  const [version, resource, second, third, ...rest] = path.split('/').filter(Boolean)
  if (version !== 'v1' || !resource || rest.length > 0) return null
  // Fixed two-segment routes first (`reports/weekly`), then id routes.
  if (second && !third && ROUTES[`${resource}/${second}`]) return { key: `${resource}/${second}` }
  if (!second) return ROUTES[resource] ? { key: resource } : null
  const key = third ? `${resource}/*/${third}` : `${resource}/*`
  return ROUTES[key] ? { key, id: decodeURIComponent(second) } : null
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
    res.json(await ROUTES[match.key]({ req, principal, team, nowMs, id: match.id }))
  } catch (err) {
    sendApiError(res, err)
  }
}
