// ─── PKCE (RFC 7636), S256 only ──────────────────────────────────────────────

import * as crypto from 'crypto'

/** An S256 challenge is the base64url SHA-256 of the verifier: always 43 characters. */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(challenge)
}

/** 43–128 characters of the unreserved set (RFC 7636 §4.1). */
export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)
}

export function pkceS256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false
  const expected = Buffer.from(pkceS256(verifier))
  const given = Buffer.from(challenge)
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

/** Append parameters to a redirect URI, keeping whatever query it already has. */
export function withQuery(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

/** An opaque bearer secret: 32 random bytes, base64url. */
export function opaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}
