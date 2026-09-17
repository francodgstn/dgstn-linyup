// ─── API credentials — ONE writer ────────────────────────────────────────────
//
// docs/public-api.md → "API keys" and "OAuth". Every mint, rotation, revocation
// and last-used touch of a public-API credential goes through this module;
// `firestore.rules` denies every client write to `api_keys`, `oauth_grants`,
// `oauth_requests` and `api_credentials`, and nothing else in the functions
// writes them.
//
// Revocation order matters: the PARENT (key or grant) is marked revoked first,
// because that is what the principal resolver reads. Deleting the credential
// rows afterwards is cleanup — a crash between the two leaves a refused secret,
// never a working one.
//
// OAuth codes and refresh tokens are SINGLE USE, each spent inside the
// transaction that mints its successor. Presenting a spent one again is treated
// as theft (RFC 9700 §4.14.2): the whole grant is revoked.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  API_CREDENTIALS_COLLECTION,
  API_FIELD_CATALOG_VERSION,
  API_KEYS_SUBCOLLECTION,
  MAX_ACTIVE_API_KEYS,
  OAUTH_ACCESS_TOKEN_TTL_MS,
  OAUTH_CODE_TTL_MS,
  OAUTH_GRANTS_SUBCOLLECTION,
  OAUTH_REFRESH_TOKEN_TTL_MS,
  OAUTH_REQUESTS_COLLECTION,
  TEAMS_COLLECTION,
  type ApiCredential,
  type ApiKey,
  type ApiScope,
  type OAuthAuthorizationRequest,
  type OAuthGrant,
} from '@linyup/shared'
import { opaqueToken, verifyPkce, withQuery } from '../oauth/pkce'
import { apiCredentialId, apiKeyDisplay, currentApiKeyEnvironment, mintApiKeySecret } from './keyFormat'

/** A key's or grant's `last_used_at` is rewritten at most this often. */
export const LAST_USED_TOUCH_MS = 5 * 60_000

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`A team may hold at most ${MAX_ACTIVE_API_KEYS} active API keys`)
  }
}

function db() {
  return admin.firestore()
}

function keysOf(teamId: string) {
  return db().collection(TEAMS_COLLECTION).doc(teamId).collection(API_KEYS_SUBCOLLECTION)
}

function grantsOf(teamId: string) {
  return db().collection(TEAMS_COLLECTION).doc(teamId).collection(OAUTH_GRANTS_SUBCOLLECTION)
}

function credentialRef(secret: string) {
  return db().collection(API_CREDENTIALS_COLLECTION).doc(apiCredentialId(secret))
}

// ─── API keys ────────────────────────────────────────────────────────────────

export interface MintApiKeyInput {
  teamId: string
  uid: string
  name: string
  scopes: ApiScope[]
  expiresAt: Date | null
}

/**
 * Create a key and the credential that authenticates it, in one transaction
 * that also enforces the active-key ceiling. The secret is returned to the
 * caller once and exists nowhere else.
 */
export async function mintApiKey(input: MintApiKeyInput): Promise<{ key: ApiKey; secret: string }> {
  const secret = mintApiKeySecret(currentApiKeyEnvironment())
  const keyRef = keysOf(input.teamId).doc()
  const now = Timestamp.now()
  const expiresAt = input.expiresAt ? Timestamp.fromDate(input.expiresAt) : null
  const { prefix, last4 } = apiKeyDisplay(secret)

  const key: ApiKey = {
    id: keyRef.id,
    teamId: input.teamId,
    name: input.name,
    prefix,
    last4,
    scopes: input.scopes,
    catalog_version: API_FIELD_CATALOG_VERSION,
    created_by: input.uid,
    created_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    revoked_by: null,
    last_used_at: null,
  }
  const credential: ApiCredential = {
    kind: 'api_key',
    teamId: input.teamId,
    uid: input.uid,
    parent_id: keyRef.id,
    scopes: input.scopes,
    resource: null,
    client_id: null,
    redirect_uri: null,
    code_challenge: null,
    used_at: null,
    created_at: now,
    expires_at: expiresAt,
  }

  await db().runTransaction(async (tx) => {
    // `revoked_at` is always written (null when live), so `== null` matches every
    // live key — the query is safe, unlike a missing-field `== null`.
    const live = await tx.get(keysOf(input.teamId).where('revoked_at', '==', null).limit(MAX_ACTIVE_API_KEYS))
    if (live.size >= MAX_ACTIVE_API_KEYS) throw new ApiKeyLimitError()
    tx.create(keyRef, key)
    tx.create(credentialRef(secret), credential)
  })

  return { key, secret }
}

export type RevokeOutcome = 'revoked' | 'already_revoked' | 'not_found'

async function revokeParent(
  ref: FirebaseFirestore.DocumentReference,
  teamId: string,
  byUid: string
): Promise<RevokeOutcome> {
  const outcome = await db().runTransaction(async (tx): Promise<RevokeOutcome> => {
    const snap = await tx.get(ref)
    if (!snap.exists) return 'not_found'
    if (snap.data()?.revoked_at != null) return 'already_revoked'
    tx.update(ref, { revoked_at: Timestamp.now(), revoked_by: byUid })
    return 'revoked'
  })
  if (outcome !== 'not_found') await deleteCredentialsOf(teamId, ref.id)
  return outcome
}

/** Revoke one key: mark it (the gate), then delete its credential rows (cleanup). */
export async function revokeApiKey(teamId: string, keyId: string, byUid: string): Promise<RevokeOutcome> {
  return revokeParent(keysOf(teamId).doc(keyId), teamId, byUid)
}

/**
 * Revoke every live key of a team — the plugin teardown and the plan downgrade.
 * `byUid` is `'system'` there, which is what the key list shows.
 */
export async function revokeAllApiKeys(teamId: string, byUid: string): Promise<number> {
  const live = await keysOf(teamId).where('revoked_at', '==', null).get()
  for (const doc of live.docs) await revokeApiKey(teamId, doc.id, byUid)
  return live.size
}

async function deleteCredentialsOf(teamId: string, parentId: string): Promise<void> {
  const rows = await db()
    .collection(API_CREDENTIALS_COLLECTION)
    .where('parent_id', '==', parentId)
    .where('teamId', '==', teamId)
    .get()
  if (rows.empty) return
  const batch = db().batch()
  for (const row of rows.docs) batch.delete(row.ref)
  await batch.commit()
}

async function touch(ref: FirebaseFirestore.DocumentReference, lastUsedAtMs: number | null, nowMs: number): Promise<void> {
  if (lastUsedAtMs !== null && nowMs - lastUsedAtMs < LAST_USED_TOUCH_MS) return
  try {
    await ref.update({ last_used_at: Timestamp.fromMillis(nowMs) })
  } catch (err) {
    console.warn(`[api] last_used_at touch failed ${ref.path}:`, err)
  }
}

/** Stamp `last_used_at`, at most every `LAST_USED_TOUCH_MS`. Never throws. */
export async function touchApiKeyLastUsed(
  teamId: string,
  keyId: string,
  lastUsedAtMs: number | null,
  nowMs: number = Date.now()
): Promise<void> {
  await touch(keysOf(teamId).doc(keyId), lastUsedAtMs, nowMs)
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export type ConsentOutcome = { redirect: string } | 'not_found' | 'expired' | 'consumed'

/**
 * The member approved: consume the request, create the grant and mint the
 * authorization code, in one transaction. Returns the client's redirect.
 */
export async function approveAuthorization(input: {
  requestId: string
  teamId: string
  uid: string
  scopes: ApiScope[]
  nowMs?: number
}): Promise<ConsentOutcome> {
  const nowMs = input.nowMs ?? Date.now()
  const requestRef = db().collection(OAUTH_REQUESTS_COLLECTION).doc(input.requestId)
  const grantRef = grantsOf(input.teamId).doc()
  const code = opaqueToken()

  return db().runTransaction(async (tx): Promise<ConsentOutcome> => {
    const snap = await tx.get(requestRef)
    if (!snap.exists) return 'not_found'
    const request = snap.data() as OAuthAuthorizationRequest
    if (request.consumed_at) return 'consumed'
    if (request.expires_at.toMillis() <= nowMs) return 'expired'
    const now = Timestamp.fromMillis(nowMs)

    const grant: OAuthGrant = {
      id: grantRef.id,
      teamId: input.teamId,
      uid: input.uid,
      client_id: request.client_id,
      client_name: request.client_name,
      client_uri: request.client_uri,
      redirect_host: new URL(request.redirect_uri).host,
      scopes: input.scopes,
      resource: request.resource,
      catalog_version: API_FIELD_CATALOG_VERSION,
      created_at: now,
      revoked_at: null,
      revoked_by: null,
      last_used_at: null,
    }
    const credential: ApiCredential = {
      kind: 'oauth_code',
      teamId: input.teamId,
      uid: input.uid,
      parent_id: grantRef.id,
      scopes: input.scopes,
      resource: request.resource,
      client_id: request.client_id,
      redirect_uri: request.redirect_uri,
      code_challenge: request.code_challenge,
      used_at: null,
      created_at: now,
      expires_at: Timestamp.fromMillis(nowMs + OAUTH_CODE_TTL_MS),
    }
    tx.update(requestRef, { consumed_at: now })
    tx.create(grantRef, grant)
    tx.create(credentialRef(code), credential)
    return { redirect: withQuery(request.redirect_uri, { code, state: request.state, iss: request.issuer }) }
  })
}

/** The member declined: consume the request and send the client `access_denied`. */
export async function denyAuthorization(requestId: string, nowMs: number = Date.now()): Promise<ConsentOutcome> {
  const requestRef = db().collection(OAUTH_REQUESTS_COLLECTION).doc(requestId)
  return db().runTransaction(async (tx): Promise<ConsentOutcome> => {
    const snap = await tx.get(requestRef)
    if (!snap.exists) return 'not_found'
    const request = snap.data() as OAuthAuthorizationRequest
    if (request.consumed_at) return 'consumed'
    tx.update(requestRef, { consumed_at: Timestamp.fromMillis(nowMs) })
    return {
      redirect: withQuery(request.redirect_uri, { error: 'access_denied', state: request.state, iss: request.issuer }),
    }
  })
}

export interface TokenSet {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type TokenOutcome =
  | { ok: true; tokens: TokenSet }
  | { ok: false; error: 'invalid_grant' | 'invalid_target' | 'invalid_scope'; description: string }

function tokenPair(
  tx: FirebaseFirestore.Transaction,
  base: Pick<ApiCredential, 'teamId' | 'uid' | 'parent_id' | 'resource' | 'client_id'>,
  scopes: ApiScope[],
  nowMs: number
): TokenSet {
  const access = opaqueToken()
  const refresh = opaqueToken()
  const common = { ...base, scopes, redirect_uri: null, code_challenge: null, used_at: null, created_at: Timestamp.fromMillis(nowMs) }
  tx.create(credentialRef(access), {
    ...common,
    kind: 'oauth_access',
    expires_at: Timestamp.fromMillis(nowMs + OAUTH_ACCESS_TOKEN_TTL_MS),
  } satisfies ApiCredential)
  tx.create(credentialRef(refresh), {
    ...common,
    kind: 'oauth_refresh',
    expires_at: Timestamp.fromMillis(nowMs + OAUTH_REFRESH_TOKEN_TTL_MS),
  } satisfies ApiCredential)
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(OAUTH_ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refresh,
    scope: scopes.join(' '),
  }
}

const invalidGrant = (description: string): TokenOutcome => ({ ok: false, error: 'invalid_grant', description })

/** Spend an authorization code for a token pair. */
export async function exchangeAuthorizationCode(input: {
  code: string
  clientId: string
  redirectUri: string
  codeVerifier: string
  resource: string
  nowMs?: number
}): Promise<TokenOutcome> {
  const nowMs = input.nowMs ?? Date.now()
  const codeRef = credentialRef(input.code)
  let replayedGrant: { teamId: string; grantId: string } | null = null

  const outcome = await db().runTransaction(async (tx): Promise<TokenOutcome> => {
    replayedGrant = null
    const snap = await tx.get(codeRef)
    const cred = snap.data() as ApiCredential | undefined
    if (!cred || cred.kind !== 'oauth_code') return invalidGrant('unknown authorization code')
    const grantRef = grantsOf(cred.teamId).doc(cred.parent_id)
    const grantSnap = await tx.get(grantRef)
    if (cred.client_id !== input.clientId) return invalidGrant('the code was issued to another client')
    if (cred.redirect_uri !== input.redirectUri) return invalidGrant('redirect_uri does not match the authorization request')
    if (cred.resource !== input.resource) return { ok: false, error: 'invalid_target', description: 'resource does not match' }
    if (cred.used_at) {
      replayedGrant = { teamId: cred.teamId, grantId: cred.parent_id }
      if (grantSnap.exists && grantSnap.data()?.revoked_at == null) {
        tx.update(grantRef, { revoked_at: Timestamp.fromMillis(nowMs), revoked_by: 'replay' })
      }
      return invalidGrant('the authorization code was already used')
    }
    if ((cred.expires_at?.toMillis() ?? 0) <= nowMs) return invalidGrant('the authorization code has expired')
    if (!verifyPkce(input.codeVerifier, cred.code_challenge ?? '')) return invalidGrant('code_verifier does not match')
    if (!grantSnap.exists || grantSnap.data()?.revoked_at != null) return invalidGrant('the grant has been revoked')

    tx.update(codeRef, { used_at: Timestamp.fromMillis(nowMs) })
    return { ok: true, tokens: tokenPair(tx, cred, cred.scopes, nowMs) }
  })

  const replay = replayedGrant as { teamId: string; grantId: string } | null
  if (replay) await deleteCredentialsOf(replay.teamId, replay.grantId)
  return outcome
}

/** Rotate a refresh token: spend it, mint a new pair, optionally narrower. */
export async function refreshAccessToken(input: {
  refreshToken: string
  clientId: string
  resource: string
  scopes: ApiScope[] | null
  nowMs?: number
}): Promise<TokenOutcome> {
  const nowMs = input.nowMs ?? Date.now()
  const refreshRef = credentialRef(input.refreshToken)
  let replayedGrant: { teamId: string; grantId: string } | null = null

  const outcome = await db().runTransaction(async (tx): Promise<TokenOutcome> => {
    replayedGrant = null
    const snap = await tx.get(refreshRef)
    const cred = snap.data() as ApiCredential | undefined
    if (!cred || cred.kind !== 'oauth_refresh') return invalidGrant('unknown refresh token')
    const grantRef = grantsOf(cred.teamId).doc(cred.parent_id)
    const grantSnap = await tx.get(grantRef)
    if (cred.client_id !== input.clientId) return invalidGrant('the refresh token was issued to another client')
    if (cred.resource !== input.resource) return { ok: false, error: 'invalid_target', description: 'resource does not match' }
    if (cred.used_at) {
      replayedGrant = { teamId: cred.teamId, grantId: cred.parent_id }
      if (grantSnap.exists && grantSnap.data()?.revoked_at == null) {
        tx.update(grantRef, { revoked_at: Timestamp.fromMillis(nowMs), revoked_by: 'replay' })
      }
      return invalidGrant('the refresh token was already used')
    }
    if ((cred.expires_at?.toMillis() ?? 0) <= nowMs) return invalidGrant('the refresh token has expired')
    if (!grantSnap.exists || grantSnap.data()?.revoked_at != null) return invalidGrant('the grant has been revoked')

    const scopes = input.scopes ?? cred.scopes
    if (scopes.length === 0 || !scopes.every((s) => cred.scopes.includes(s))) {
      return { ok: false, error: 'invalid_scope', description: 'a refresh may only narrow the granted scopes' }
    }
    tx.update(refreshRef, { used_at: Timestamp.fromMillis(nowMs) })
    return { ok: true, tokens: tokenPair(tx, cred, scopes, nowMs) }
  })

  const replay = replayedGrant as { teamId: string; grantId: string } | null
  if (replay) await deleteCredentialsOf(replay.teamId, replay.grantId)
  return outcome
}

/** Disconnect an app: revoke its grant and every token issued under it. */
export async function revokeOAuthGrant(teamId: string, grantId: string, byUid: string): Promise<RevokeOutcome> {
  return revokeParent(grantsOf(teamId).doc(grantId), teamId, byUid)
}

/** Revoke every live grant of a team — the plugin teardown. */
export async function revokeAllOAuthGrants(teamId: string, byUid: string): Promise<number> {
  const live = await grantsOf(teamId).where('revoked_at', '==', null).get()
  for (const doc of live.docs) await revokeOAuthGrant(teamId, doc.id, byUid)
  return live.size
}

/**
 * RFC 7009: a client revoking a token it holds ends its grant. An API key is
 * not revocable this way (it is managed on Settings → API keys), and an unknown
 * token is not an error — the endpoint answers the same either way.
 */
export async function revokePresentedToken(token: string, clientId: string | null): Promise<void> {
  const snap = await credentialRef(token).get()
  const cred = snap.data() as ApiCredential | undefined
  if (!cred || (cred.kind !== 'oauth_access' && cred.kind !== 'oauth_refresh')) return
  if (clientId && cred.client_id !== clientId) return
  await revokeOAuthGrant(cred.teamId, cred.parent_id, 'client')
}

export async function touchOAuthGrantLastUsed(
  teamId: string,
  grantId: string,
  lastUsedAtMs: number | null,
  nowMs: number = Date.now()
): Promise<void> {
  await touch(grantsOf(teamId).doc(grantId), lastUsedAtMs, nowMs)
}
