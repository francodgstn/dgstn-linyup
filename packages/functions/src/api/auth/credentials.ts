// ─── API credentials — ONE writer ────────────────────────────────────────────
//
// docs/public-api.md → "API keys". Every mint, revocation and last-used touch of
// a public-API credential goes through this module; `firestore.rules` denies
// every client write to `api_keys` and `api_credentials`, and nothing else in
// the functions writes them. Phase 2 adds the OAuth grant and token writers
// HERE, beside these, for the same reason.
//
// Revocation order matters: the KEY is marked revoked first, because that is
// what the principal resolver reads (the parent is the gate). Deleting the
// credential rows afterwards is cleanup — a crash between the two leaves a
// refused secret, never a working one.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  API_CREDENTIALS_COLLECTION,
  API_FIELD_CATALOG_VERSION,
  API_KEYS_SUBCOLLECTION,
  MAX_ACTIVE_API_KEYS,
  TEAMS_COLLECTION,
  type ApiCredential,
  type ApiKey,
  type ApiScope,
} from '@linyup/shared'
import { apiCredentialId, apiKeyDisplay, currentApiKeyEnvironment, mintApiKeySecret } from './keyFormat'

/** A key's `last_used_at` is rewritten at most this often. */
export const LAST_USED_TOUCH_MS = 5 * 60_000

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`A team may hold at most ${MAX_ACTIVE_API_KEYS} active API keys`)
  }
}

function keysOf(teamId: string) {
  return admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(API_KEYS_SUBCOLLECTION)
}

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
  const db = admin.firestore()
  const secret = mintApiKeySecret(currentApiKeyEnvironment())
  const keyRef = keysOf(input.teamId).doc()
  const credentialRef = db.collection(API_CREDENTIALS_COLLECTION).doc(apiCredentialId(secret))
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

  await db.runTransaction(async (tx) => {
    // `revoked_at` is always written (null when live), so `== null` matches every
    // live key — the query is safe, unlike a missing-field `== null`.
    const live = await tx.get(keysOf(input.teamId).where('revoked_at', '==', null).limit(MAX_ACTIVE_API_KEYS))
    if (live.size >= MAX_ACTIVE_API_KEYS) throw new ApiKeyLimitError()
    tx.create(keyRef, key)
    tx.create(credentialRef, credential)
  })

  return { key, secret }
}

export type RevokeOutcome = 'revoked' | 'already_revoked' | 'not_found'

/** Revoke one key: mark it (the gate), then delete its credential rows (cleanup). */
export async function revokeApiKey(teamId: string, keyId: string, byUid: string): Promise<RevokeOutcome> {
  const ref = keysOf(teamId).doc(keyId)
  const outcome = await admin.firestore().runTransaction(async (tx): Promise<RevokeOutcome> => {
    const snap = await tx.get(ref)
    if (!snap.exists) return 'not_found'
    if (snap.data()?.revoked_at != null) return 'already_revoked'
    tx.update(ref, { revoked_at: Timestamp.now(), revoked_by: byUid })
    return 'revoked'
  })
  if (outcome !== 'not_found') await deleteCredentialsOf(teamId, keyId)
  return outcome
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
  const db = admin.firestore()
  const rows = await db
    .collection(API_CREDENTIALS_COLLECTION)
    .where('parent_id', '==', parentId)
    .where('teamId', '==', teamId)
    .get()
  if (rows.empty) return
  const batch = db.batch()
  for (const row of rows.docs) batch.delete(row.ref)
  await batch.commit()
}

/** Stamp `last_used_at`, at most every `LAST_USED_TOUCH_MS`. Never throws. */
export async function touchApiKeyLastUsed(
  teamId: string,
  keyId: string,
  lastUsedAtMs: number | null,
  nowMs: number = Date.now()
): Promise<void> {
  if (lastUsedAtMs !== null && nowMs - lastUsedAtMs < LAST_USED_TOUCH_MS) return
  try {
    await keysOf(teamId).doc(keyId).update({ last_used_at: Timestamp.fromMillis(nowMs) })
  } catch (err) {
    console.warn(`[api] last_used_at touch failed team=${teamId} key=${keyId}:`, err)
  }
}
