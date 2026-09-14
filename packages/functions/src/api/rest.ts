// ─── REST /v1 — GET only ─────────────────────────────────────────────────────
//
// docs/public-api.md. Every route reads through api/resources/*; the router
// only parses, dispatches and shapes errors.

import { API_SCOPES, type ApiScope } from '@linyup/shared'
import { principalMay, type ApiPrincipal } from './auth/principal'
import type { ApiRequest, ApiResponse } from './access'
import { loadTeamContext } from './context'
import { ApiError, toApiError } from './errors'
import { getContact, listContacts } from './resources/contacts'
import { getSession, listSessions } from './resources/sessions'
import { contactListShape, parseInput, sessionListShape } from './schemas'
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

export async function handleRest(req: ApiRequest, res: ApiResponse, principal: ApiPrincipal, nowMs: number): Promise<void> {
  try {
    if (req.method !== 'GET') {
      res.set('Allow', 'GET')
      throw new ApiError('invalid_request', `${req.method} is not supported; this API is read-only`)
    }
    const [version, resource, id, ...rest] = req.path.split('/').filter(Boolean)
    if (version !== 'v1' || rest.length > 0) throw new ApiError('not_found', 'No such endpoint')

    const team = await loadTeamContext(principal.teamId)

    switch (resource) {
      case 'me': {
        if (id) break
        res.json({
          object: 'credential',
          team: { id: team.teamId, name: team.name },
          role: principal.role,
          via: principal.via.kind,
          scopes: describeScopes(principal),
        })
        return
      }
      case 'team': {
        if (id) break
        res.json({
          object: 'team',
          id: team.teamId,
          name: team.name,
          slug: team.slug,
          language: team.language,
          currency: team.currency,
          time_zone: team.timeZone,
        })
        return
      }
      case 'contacts': {
        if (id) {
          res.json(await getContact(principal, team, id, nowMs))
          return
        }
        const q = parseInput(contactListShape(50, 200), req.query)
        res.json(
          await listContacts(
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
        )
        return
      }
      case 'sessions': {
        if (id) {
          res.json(await getSession(principal, id, nowMs))
          return
        }
        const q = parseInput(sessionListShape(50, 200), req.query)
        res.json(
          await listSessions(
            principal,
            {
              fromMs: parseApiInstant(q.from, team.timeZone, 'from'),
              toMs: parseApiInstant(q.to, team.timeZone, 'to'),
              limit: q.limit,
              cursor: q.cursor,
              activityId: q.activity_id,
            },
            nowMs
          )
        )
        return
      }
    }
    throw new ApiError('not_found', 'No such endpoint')
  } catch (err) {
    sendApiError(res, err)
  }
}
