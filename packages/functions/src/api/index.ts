// ─── `api` — the public API and remote MCP server, one HTTPS function ────────
//
// docs/public-api.md. Serves `/v1/*` (REST), `/mcp` (MCP), `/oauth/*` (the
// authorization server) and `/.well-known/*` (discovery) from one origin, so the
// issuer and the resource share a host. Every data request resolves its
// principal ONCE (`resolveApiPrincipal`) before anything is read.

import { onRequest } from 'firebase-functions/v2/https'
import { defineInt } from 'firebase-functions/params'
import type { ApiAuthRefusal } from './auth/principal'
import { resolveApiPrincipal } from './auth/principal'
import { touchApiKeyLastUsed, touchOAuthGrantLastUsed } from './auth/credentials'
import type { ApiRequest, ApiResponse } from './access'
import { ApiError } from './errors'
import { authorizationServerMetadata, mcpResource, protectedResourceMetadata, resourceMetadataUrl } from './oauth/metadata'
import { handleRest, sendApiError } from './rest'
import { TokenBuckets, recordApiUsage } from './usage'

const buckets = new TokenBuckets()

/**
 * Warm instances for this function. Production runs 1: a cold start measured
 * 5.3 s on the Phase 0 spike and an MCP connector gives up around 10 s, so the
 * first call of a quiet morning would fail rather than be slow. Everywhere else
 * it is 0. Every .env file must carry it — a param the emulator cannot resolve
 * makes it prompt, and a prompt in a non-TTY loads zero functions.
 */
const API_MIN_INSTANCES = defineInt("API_MIN_INSTANCES", {
  description: "Warm instances for the public API function (production: 1)",
  default: 0,
})

const REFUSAL_MESSAGE: Record<ApiAuthRefusal, string> = {
  missing_token: 'Send a credential as `Authorization: Bearer <token>`',
  malformed_token: 'That is not a Linyup API key',
  unknown_token: 'The credential is not valid',
  expired: 'The credential has expired',
  revoked: 'The credential has been revoked',
  wrong_surface: 'This credential cannot be used here',
  wrong_resource: 'This token was issued for a different resource',
  not_a_member: 'The member this credential acts for is no longer on the team',
}

/**
 * The URL clients should call — the OpenAPI `servers` entry, the OAuth issuer
 * and the base of the MCP resource. It cannot be read off the request path: the
 * functions runtime strips the function's own prefix (`/<project>/<region>/api`
 * on the emulator, `/api` on cloudfunctions.net) before the app sees it, and
 * behind a Hosting rewrite the Host is the Cloud Run host. `API_BASE_URL` wins
 * when the environment sets it, and every deployed environment must.
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

function clientIp(req: ApiRequest): string {
  return req.get('x-forwarded-for')?.split(',')[0]?.trim() || req.ip || 'unknown'
}

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
  const base = publicBaseUrl(req)
  if (path === '/' || path === '/health') {
    res.json({ ok: true, service: 'linyup-api' })
    return
  }

  // ── Discovery and reference: no studio data, answered before any credential.
  if (path === '/.well-known/oauth-protected-resource' || path === `/.well-known/oauth-protected-resource/mcp`) {
    res.set('Cache-Control', 'public, max-age=300').json(protectedResourceMetadata(base))
    return
  }
  if (path === '/.well-known/oauth-authorization-server') {
    res.set('Cache-Control', 'public, max-age=300').json(authorizationServerMetadata(base))
    return
  }
  if (path === '/v1/openapi.json') {
    if (req.method !== 'GET') {
      res.set('Allow', 'GET').status(405).end()
      return
    }
    const { buildOpenApiDocument } = await import('./openapi/document')
    res.set('Cache-Control', 'public, max-age=300')
    res.json(buildOpenApiDocument(base))
    return
  }

  // ── The authorization server. Rate-limited per caller address, since none of
  // these requests carries a credential to key on.
  if (path.startsWith('/oauth/')) {
    const wait = buckets.take(`ip:${clientIp(req)}`, nowMs)
    if (wait > 0) {
      res.set('Retry-After', String(wait)).status(429).json({ error: 'slow_down', error_description: 'Too many requests' })
      return
    }
    try {
      const oauth = await import('./oauth/endpoints')
      if (path === '/oauth/authorize') await oauth.handleAuthorize(req, res, base, nowMs)
      else if (path === '/oauth/token') await oauth.handleToken(req, res, base, nowMs)
      else if (path === '/oauth/revoke') await oauth.handleRevoke(req, res)
      else sendApiError(res, new ApiError('not_found', 'No such endpoint'))
    } catch (err) {
      console.error(`[oauth] ${path} failed:`, err)
      if (!res.headersSent) res.status(500).json({ error: 'server_error', error_description: 'Something went wrong on our side' })
    }
    return
  }

  const surface = path === '/mcp' ? 'mcp' : path.startsWith('/v1/') || path === '/v1' ? 'rest' : null
  if (!surface) {
    sendApiError(res, new ApiError('not_found', 'No such endpoint'))
    return
  }

  const decision = await resolveApiPrincipal(
    req.get('authorization'),
    surface,
    nowMs,
    surface === 'mcp' ? mcpResource(base) : undefined
  )
  if ('refusal' in decision) {
    const error = decision.refusal === 'missing_token' ? '' : ', error="invalid_token"'
    // On the MCP endpoint the 401 is also discovery: it names the protected
    // resource metadata, which names the authorization server (RFC 9728).
    const challenge =
      surface === 'mcp'
        ? `Bearer resource_metadata="${resourceMetadataUrl(base)}"${error}`
        : `Bearer realm="linyup"${error}`
    res.set('WWW-Authenticate', challenge)
    console.info(`[api] refused surface=${surface} reason=${decision.refusal}`)
    sendApiError(res, new ApiError('unauthenticated', REFUSAL_MESSAGE[decision.refusal]))
    return
  }
  const principal = decision.principal
  // Bearers only: `resolveApiPrincipal` never yields a credential-less `member`
  // principal (that is the in-app assistant's), so its uid is a formality here.
  const credentialKey =
    principal.via.kind === 'api_key'
      ? principal.via.keyId
      : principal.via.kind === 'oauth'
        ? principal.via.grantId
        : principal.uid

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
      : principal.via.kind === 'oauth'
        ? touchOAuthGrantLastUsed(principal.teamId, principal.via.grantId, principal.lastUsedAtMs, nowMs)
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
  {
    invoker: 'public',
    minInstances: API_MIN_INSTANCES,
    maxInstances: 10,
    timeoutSeconds: 60,
    memory: '512MiB',
    concurrency: 40,
  },
  handleApiRequest
)
