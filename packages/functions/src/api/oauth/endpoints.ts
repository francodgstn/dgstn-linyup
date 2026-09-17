// ─── /oauth/authorize, /oauth/token, /oauth/revoke ───────────────────────────
//
// docs/public-api.md → "OAuth". The member's decision happens on the web app's
// consent page (apps/web …/oauth/consent), which holds the Firebase session;
// these endpoints validate the client, park the request, and exchange codes.
//
// Error handling follows RFC 6749 §4.1.2.1: until the client and its
// redirect_uri are verified, an error is shown on OUR page and never redirected
// (a redirect to an unverified URI is an open redirect); after, it goes back to
// the client with `error`, `state` and `iss`.

import * as crypto from 'crypto'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  API_SCOPES,
  DEFAULT_API_SCOPES,
  OAUTH_AUTHORIZATION_REQUEST_TTL_MS,
  OAUTH_REQUESTS_COLLECTION,
  isApiScope,
  normalizeApiScopes,
  type ApiScope,
  type OAuthAuthorizationRequest,
} from '@linyup/shared'
import { getHostingUrl } from '../../utils/env'
import type { ApiRequest, ApiResponse } from '../access'
import { exchangeAuthorizationCode, refreshAccessToken, revokePresentedToken } from '../auth/credentials'
import { ClientMetadataError, loadClientMetadata, redirectUriAllowed } from './clientMetadata'
import { mcpResource } from './metadata'
import { isValidCodeChallenge, withQuery } from './pkce'

function param(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function errorPage(res: ApiResponse, status: number, title: string, detail: string): void {
  res
    .status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('X-Frame-Options', 'DENY')
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Linyup — ${escapeHtml(title)}</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2937">` +
        `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`
    )
}

/** The scopes an authorization request asks for: known ones only; none named ⇒ the defaults. */
export function requestedScopes(raw: string | undefined): ApiScope[] | 'invalid' {
  if (raw === undefined) return DEFAULT_API_SCOPES
  const asked = raw.split(/\s+/).filter(Boolean)
  const known = asked.filter(isApiScope)
  if (known.length === 0) return 'invalid'
  // A PII request without contacts keeps contacts: asking for details implies asking for the people.
  const withRequires = known.includes('contacts:read:pii') ? [...known, 'contacts:read' as const] : known
  return normalizeApiScopes(withRequires)
}

export async function handleAuthorize(req: ApiRequest, res: ApiResponse, base: string, nowMs: number): Promise<void> {
  if (req.method !== 'GET') {
    res.set('Allow', 'GET').status(405).end()
    return
  }
  const q = req.query
  const clientId = param(q, 'client_id')
  const redirectUri = param(q, 'redirect_uri')
  if (!clientId || !redirectUri) {
    errorPage(res, 400, 'This connection request is incomplete', 'The app that sent you here did not say who it is or where to return you.')
    return
  }

  let client
  try {
    client = await loadClientMetadata(clientId, nowMs)
  } catch (err) {
    const detail = err instanceof ClientMetadataError ? err.message : 'The app could not be verified.'
    console.warn(`[oauth] client metadata refused client_id=${clientId}: ${detail}`)
    errorPage(res, 400, 'This app could not be verified', detail)
    return
  }
  if (!redirectUriAllowed(redirectUri, client.redirect_uris)) {
    errorPage(res, 400, 'This app could not be verified', 'The return address does not belong to the app that sent you here.')
    return
  }

  // From here the client is verified: errors go back to it.
  const state = param(q, 'state') ?? null
  const back = (error: string, description: string) =>
    res.redirect(302, withQuery(redirectUri, { error, error_description: description, state, iss: base }))

  if (param(q, 'response_type') !== 'code') return back('unsupported_response_type', 'Only the authorization code flow is supported')
  const challenge = param(q, 'code_challenge')
  if (param(q, 'code_challenge_method') !== 'S256' || !isValidCodeChallenge(challenge)) {
    return back('invalid_request', 'PKCE with S256 is required')
  }
  const resource = (param(q, 'resource') ?? mcpResource(base)).replace(/\/+$/, '')
  if (resource !== mcpResource(base)) return back('invalid_target', `The only resource here is ${mcpResource(base)}`)
  const scopes = requestedScopes(param(q, 'scope'))
  if (scopes === 'invalid') return back('invalid_scope', `Known scopes: ${API_SCOPES.join(' ')}`)

  const requestId = crypto.randomBytes(24).toString('base64url')
  const request: OAuthAuthorizationRequest = {
    client_id: client.client_id,
    client_name: client.client_name,
    client_uri: client.client_uri,
    logo_uri: client.logo_uri,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    scopes,
    resource,
    issuer: base,
    created_at: Timestamp.fromMillis(nowMs),
    expires_at: Timestamp.fromMillis(nowMs + OAUTH_AUTHORIZATION_REQUEST_TTL_MS),
    consumed_at: null,
  }
  await admin.firestore().collection(OAUTH_REQUESTS_COLLECTION).doc(requestId).create(request)
  res.redirect(302, `${getHostingUrl().replace(/\/+$/, '')}/oauth/consent?request=${encodeURIComponent(requestId)}`)
}

function tokenError(res: ApiResponse, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description })
}

export async function handleToken(req: ApiRequest, res: ApiResponse, base: string, nowMs: number): Promise<void> {
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache')
  if (req.method !== 'POST') {
    res.set('Allow', 'POST')
    return tokenError(res, 405, 'invalid_request', 'Use POST')
  }
  const body = req.body as Record<string, unknown> | undefined
  const clientId = param(body, 'client_id')
  if (!clientId) return tokenError(res, 400, 'invalid_client', 'client_id is required')
  const resource = (param(body, 'resource') ?? mcpResource(base)).replace(/\/+$/, '')
  if (resource !== mcpResource(base)) return tokenError(res, 400, 'invalid_target', `The only resource here is ${mcpResource(base)}`)

  const grantType = param(body, 'grant_type')
  let outcome
  if (grantType === 'authorization_code') {
    const code = param(body, 'code')
    const redirectUri = param(body, 'redirect_uri')
    const verifier = param(body, 'code_verifier')
    if (!code || !redirectUri || !verifier) {
      return tokenError(res, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required')
    }
    outcome = await exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier: verifier, resource, nowMs })
  } else if (grantType === 'refresh_token') {
    const refreshToken = param(body, 'refresh_token')
    if (!refreshToken) return tokenError(res, 400, 'invalid_request', 'refresh_token is required')
    const scopeParam = param(body, 'scope')
    const scopes = scopeParam ? scopeParam.split(/\s+/).filter(Boolean) : null
    if (scopes && !scopes.every(isApiScope)) return tokenError(res, 400, 'invalid_scope', 'Unknown scope requested')
    outcome = await refreshAccessToken({ refreshToken, clientId, resource, scopes: scopes as ApiScope[] | null, nowMs })
  } else {
    return tokenError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token')
  }

  if (!outcome.ok) {
    console.info(`[oauth] token refused client_id=${clientId} grant_type=${grantType} error=${outcome.error}`)
    return tokenError(res, 400, outcome.error, outcome.description)
  }
  res.status(200).json(outcome.tokens)
}

/** RFC 7009: always 200, whether or not the token was known. */
export async function handleRevoke(req: ApiRequest, res: ApiResponse): Promise<void> {
  res.set('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).end()
    return
  }
  const body = req.body as Record<string, unknown> | undefined
  const token = param(body, 'token')
  if (token) await revokePresentedToken(token, param(body, 'client_id') ?? null)
  res.status(200).json({})
}
