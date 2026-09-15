// ─── API key callables — create and revoke ───────────────────────────────────
//
// docs/public-api.md → "API keys". The Settings → Integrations screen calls
// these; every write goes through api/auth/credentials.ts.
//
// Both require `integrations.manage` (owner-only today). ONLY CREATION is behind
// the `api-connectors` install gate (utils/plugins.ts `assertPluginInstalled`):
// revoking a key is winding a door DOWN, and must keep working after the plugin
// is gone — the teardown arm in sync/onInstalledPluginStatusChange.ts revokes
// every key on removal anyway, and an owner must never be unable to close one.
//
// A key's scopes are not checked against its creator's capabilities here. The
// principal resolver intersects them with the member's LIVE capabilities on
// every request, which is the only check that stays true after a role changes.

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { API_CONNECTORS_PLUGIN_ID, API_KEY_NAME_MAX, normalizeApiScopes } from '@linyup/shared'
import { assertPluginInstalled } from '../utils/plugins'
import { requireCapability } from '../utils/teams'
import { ApiKeyLimitError, mintApiKey, revokeApiKey as revokeKey } from './auth/credentials'

/** A key may be set to expire within this many days, or never. */
export const API_KEY_MAX_EXPIRY_DAYS = 366

function requireString(value: unknown, field: string, max = 200): string {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s || s.length > max) {
    throw new HttpsError('invalid-argument', `A valid ${field} is required`, { reason: `invalid_${field}` })
  }
  return s
}

function resolveExpiry(value: unknown, nowMs: number): Date | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > API_KEY_MAX_EXPIRY_DAYS) {
    throw new HttpsError('invalid-argument', 'expiresInDays must be a whole number of days', {
      reason: 'invalid_expiry',
    })
  }
  return new Date(nowMs + value * 86_400_000)
}

export const createApiKey = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to create an API key')
  const data = (request.data ?? {}) as Record<string, unknown>
  const teamId = requireString(data.teamId, 'teamId')

  await requireCapability(uid, teamId, 'integrations.manage')
  await assertPluginInstalled(teamId, API_CONNECTORS_PLUGIN_ID)

  const name = requireString(data.name, 'name', API_KEY_NAME_MAX)
  const scopes = normalizeApiScopes(data.scopes)
  if (scopes.length === 0) {
    throw new HttpsError('invalid-argument', 'Choose at least one scope', { reason: 'invalid_scopes' })
  }
  const expiresAt = resolveExpiry(data.expiresInDays, Date.now())

  try {
    const { key, secret } = await mintApiKey({ teamId, uid, name, scopes, expiresAt })
    return {
      // Shown once. The caller must not persist it anywhere but in front of the owner.
      secret,
      key: {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        last4: key.last4,
        scopes: key.scopes,
        expires_at_ms: key.expires_at?.toMillis() ?? null,
      },
    }
  } catch (err) {
    if (err instanceof ApiKeyLimitError) {
      throw new HttpsError('resource-exhausted', err.message, { reason: 'api_key_limit' })
    }
    throw err
  }
})

export const revokeApiKey = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to revoke an API key')
  const data = (request.data ?? {}) as Record<string, unknown>
  const teamId = requireString(data.teamId, 'teamId')
  const keyId = requireString(data.keyId, 'keyId')

  await requireCapability(uid, teamId, 'integrations.manage')

  const outcome = await revokeKey(teamId, keyId, uid)
  if (outcome === 'not_found') throw new HttpsError('not-found', 'No such API key', { reason: 'api_key_not_found' })
  return { outcome }
})
