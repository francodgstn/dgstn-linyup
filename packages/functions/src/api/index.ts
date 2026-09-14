// ─── `api` — the public API and remote MCP server, one HTTPS function ────────
//
// docs/public-api.md. Serves `/v1/*` (REST) and `/mcp` (MCP) from one origin;
// Phase 2 adds `/oauth/*` and `/.well-known/*` here too, so the issuer and the
// resource share a host. Every request resolves its principal ONCE
// (`resolveApiPrincipal`) before anything is read.

import { onRequest } from 'firebase-functions/v2/https'
import type { ApiAuthRefusal } from './auth/principal'
import { resolveApiPrincipal } from './auth/principal'
import { touchApiKeyLastUsed } from './auth/credentials'
import type { ApiRequest, ApiResponse } from './access'
import { ApiError } from './errors'
import { handleRest, sendApiError } from './rest'
import { TokenBuckets, recordApiUsage } from './usage'

const buckets = new TokenBuckets()

const REFUSAL_MESSAGE: Record<ApiAuthRefusal, string> = {
  missing_token: 'Send a credential as `Authorization: Bearer <token>`',
  malformed_token: 'That is not a Linyup API key',
  unknown_token: 'The credential is not valid',
  expired: 'The credential has expired',
  revoked: 'The credential has been revoked',
  wrong_surface: 'This credential cannot be used here',
  not_a_member: 'The member this credential acts for is no longer on the team',
}

/**
 * The URL clients should call, for the OpenAPI `servers` entry. It cannot be read
 * off the request path: the functions runtime strips the function's own prefix
 * (`/<project>/<region>/api` on the emulator, `/api` on cloudfunctions.net)
 * before the app sees the request, so the path looks the same everywhere.
 * `API_BASE_URL` wins when the environment sets it.
 */
export function publicBaseUrl(
  req: Pick<ApiRequest, 'get' | 'protocol'>,
  env: Record<string, string | undefined> = process.env
): string {
  if (env.API_BASE_URL) return env.API_BASE_URL.replace(/\/+$/, '')
  const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol
  const host = req.get('host') ?? 'localhost'
  if (env.FUNCTIONS_EMULATOR === 'true') {
    return `${proto}://${host}/${env.GCLOUD_PROJECT ?? 'demo-linyup'}/${API_FUNCTION_REGION}/api`
  }
  if (host.endsWith('.cloudfunctions.net')) return `${proto}://${host}/api`
  return `${proto}://${host}`
}

/** The region `setGlobalOptions` deploys every function to (functions/src/index.ts). */
const API_FUNCTION_REGION = 'europe-west6'

function setCommonHeaders(res: ApiResponse): void {
  res.set('Cache-Control', 'private, no-store')
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id')
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After')
}

export async function handleApiRequest(req: ApiRequest, res: ApiResponse): Promise<void> {
  const nowMs = Date.now()
  setCommonHeaders(res)
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  const path = req.path.replace(/\/+$/, '') || '/'
  if (path === '/' || path === '/health') {
    res.json({ ok: true, service: 'linyup-api' })
    return
  }
  // The reference describes the API and holds no studio data, so it answers
  // before any credential is asked for.
  if (path === '/v1/openapi.json') {
    if (req.method !== 'GET') {
      res.set('Allow', 'GET').status(405).end()
      return
    }
    const { buildOpenApiDocument } = await import('./openapi/document')
    res.set('Cache-Control', 'public, max-age=300')
    res.json(buildOpenApiDocument(publicBaseUrl(req)))
    return
  }
  const surface = path === '/mcp' ? 'mcp' : path.startsWith('/v1/') || path === '/v1' ? 'rest' : null
  if (!surface) {
    sendApiError(res, new ApiError('not_found', 'No such endpoint'))
    return
  }

  const decision = await resolveApiPrincipal(req.get('authorization'), surface, nowMs)
  if ('refusal' in decision) {
    const error = decision.refusal === 'missing_token' ? '' : ', error="invalid_token"'
    res.set('WWW-Authenticate', `Bearer realm="linyup"${error}`)
    console.info(`[api] refused surface=${surface} reason=${decision.refusal}`)
    sendApiError(res, new ApiError('unauthenticated', REFUSAL_MESSAGE[decision.refusal]))
    return
  }
  const principal = decision.principal
  const credentialKey = principal.via.kind === 'api_key' ? principal.via.keyId : principal.via.grantId

  const wait = buckets.take(credentialKey, nowMs)
  if (wait > 0) {
    void recordApiUsage(principal.teamId, 'denied', nowMs)
    sendApiError(res, new ApiError('rate_limited', 'Too many requests', `Retry in ${wait}s`, { retry_after: wait }))
    return
  }

  const bookkeeping = Promise.all([
    recordApiUsage(principal.teamId, 'ok', nowMs),
    principal.via.kind === 'api_key'
      ? touchApiKeyLastUsed(principal.teamId, principal.via.keyId, principal.lastUsedAtMs, nowMs)
      : Promise.resolve(),
  ])

  try {
    if (surface === 'mcp') {
      const { handleMcp } = await import('./mcp/server')
      await handleMcp(req, res, principal, nowMs)
    } else {
      await handleRest(req, res, principal, nowMs)
    }
  } catch (err) {
    if (!res.headersSent) sendApiError(res, err)
    else console.error('[api] error after response started:', err)
  } finally {
    console.info(
      `[api] team=${principal.teamId} uid=${principal.uid} via=${principal.via.kind} surface=${surface} ` +
        `${req.method} ${path} status=${res.statusCode} ms=${Date.now() - nowMs}`
    )
    await bookkeeping
  }
}

export const api = onRequest(
  { invoker: 'public', maxInstances: 10, timeoutSeconds: 60, memory: '512MiB', concurrency: 40 },
  handleApiRequest
)
