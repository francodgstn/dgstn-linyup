/**
 * ES256 JWTs for the App Store Connect API.
 *
 * ── NO JWT LIBRARY, AND THAT IS DELIBERATE ─────────────────────────────────
 * `crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })` returns the
 * 64-byte raw R‖S concatenation that JOSE mandates for ES256. WITHOUT that
 * option Node returns a variable-length DER structure (~70-72 bytes), which
 * Apple rejects with an opaque 401 that reads as a bad key. Verified on this
 * repo's Node 22: 64 bytes with the option, 71 without, and `crypto.verify`
 * round-trips only the former. So `jsonwebtoken` / `jose` buy nothing here —
 * do not add one.
 *
 * ── THE KEY MAY ARRIVE IN TWO SHAPES ───────────────────────────────────────
 * `getSecret` trims, which is only ever helpful. What it cannot fix is INTERIOR
 * newline damage: a `.p8` pasted through a form or an editor that normalises
 * line endings yields a value `createPrivateKey` rejects, again opaquely. So a
 * single-line base64 of the whole PEM is accepted too, and is the RECOMMENDED
 * way to store it — it makes the secret immune to that entire class.
 *
 * ── SECRETS, NOT PARAMS ────────────────────────────────────────────────────
 * The key id and issuer id are identifiers rather than credentials, but
 * `packages/functions/.env.production` and its siblings are tracked in git, so
 * a `defineString` for either would sit in the history forever. Same reasoning
 * as `utils/operator.ts`. They live in Secret Manager beside the key.
 */
import { createPrivateKey, sign } from 'node:crypto'
import { readSecret } from '../utils/secrets'

/** Apple caps the token lifetime at 20 minutes; 15 leaves room for clock skew. */
const TTL_SECONDS = 15 * 60
/** Re-mint inside this much of the expiry rather than risk a 401 mid-run. */
const REFRESH_MARGIN_SECONDS = 60

export interface AscKeyMaterial {
  /** 10-character key id from ASC → Users and Access → Integrations. */
  keyId: string
  /** Issuer UUID from the same page. */
  issuerId: string
  privateKeyPem: string
}

/** Why there is no token — mirrors StoreSourceStatus's `not_configured` vs `error`. */
export type AscAuthResult =
  | { ok: true; header: string }
  | { ok: false; reason: 'not_configured' | 'error'; detail: string }

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Normalises whichever shape the secret was stored in into a usable PEM.
 *
 * Exported for the tests, which is the only way to pin the base64 branch — a
 * caller passing a single-line secret gets no error, just an unusable key.
 */
export function normalisePrivateKey(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('-----BEGIN')) return trimmed
  return Buffer.from(trimmed, 'base64').toString('utf8')
}

/** The signed JWT. Pure apart from the key material. */
export function mintAscJwt(key: AscKeyMaterial, ttlSeconds = TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', kid: key.keyId, typ: 'JWT' }
  const payload = {
    iss: key.issuerId,
    iat: now,
    exp: now + ttlSeconds,
    aud: 'appstoreconnect-v1',
  }

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(normalisePrivateKey(key.privateKeyPem)),
    dsaEncoding: 'ieee-p1363',
  })

  return `${signingInput}.${base64url(signature)}`
}

let cached: { header: string; expiresAt: number } | null = null

/**
 * The `Authorization` header value, cached for the token's lifetime.
 *
 * One signature per run rather than one per request — a sweep makes a dozen
 * calls and re-signing each is pure waste.
 *
 * Returns `not_configured` when any of the three secrets is simply unset, and
 * `error` when Secret Manager refused. Keeping those apart is the whole reason
 * `readSecret` exists: a missing IAM grant that rendered as "not configured"
 * would send an operator to paste a key that is already there.
 */
export async function ascAuthHeader(): Promise<AscAuthResult> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.expiresAt - REFRESH_MARGIN_SECONDS > now) {
    return { ok: true, header: cached.header }
  }

  const [keyId, issuerId, privateKey] = await Promise.all([
    readSecret('apple-asc-key-id'),
    readSecret('apple-asc-issuer-id'),
    readSecret('apple-asc-private-key'),
  ])

  for (const read of [keyId, issuerId, privateKey]) {
    if (read.ok) continue
    return read.reason === 'missing'
      ? { ok: false, reason: 'not_configured', detail: read.detail }
      : { ok: false, reason: 'error', detail: read.detail }
  }
  if (!keyId.ok || !issuerId.ok || !privateKey.ok) {
    // Unreachable — the loop above returns first. Present so the narrowing holds.
    return { ok: false, reason: 'error', detail: 'unreachable' }
  }

  try {
    const header = `Bearer ${mintAscJwt({
      keyId: keyId.value,
      issuerId: issuerId.value,
      privateKeyPem: privateKey.value,
    })}`
    cached = { header, expiresAt: now + TTL_SECONDS }
    return { ok: true, header }
  } catch (err) {
    // A malformed key lands here. The message names the failure, never the key.
    cached = null
    return {
      ok: false,
      reason: 'error',
      detail: `App Store Connect key could not be parsed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}

/** Test seam — drops the memoised token. */
export function resetAscAuthCache(): void {
  cached = null
}
