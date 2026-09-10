/**
 * Google Play service-account auth.
 *
 * `google-auth-library` is already a dependency (it backs other Google calls in
 * this package), so this adds nothing to the install. The JWT client refreshes
 * its own access token, hence the module-level cache keyed on nothing but the
 * credential itself.
 *
 * ── THE PLAY CREDENTIAL IS NOT OUR PROJECT'S CREDENTIAL ────────────────────
 * This service account is minted in a GCP project and then LINKED IN THE PLAY
 * CONSOLE, which is where its access to the app and to the reports bucket is
 * granted. Nothing about that is expressible in our Terraform, `plan` will look
 * clean, and a missing grant surfaces as a 403 that reads exactly like a bad
 * key. See `config.ts` → PLAY_REPORTS_BUCKET.
 */
import { JWT } from 'google-auth-library'
import { readSecret } from '../utils/secrets'

/**
 * Everything the ingest needs, requested together.
 *
 * `androidpublisher` covers reviews; `playdeveloperreporting` covers vitals and
 * anomalies; `devstorage.read_only` covers the monthly report CSVs. A scope the
 * account has not been granted in the Play Console simply 403s at the call, so
 * asking for all three costs nothing.
 */
export const PLAY_SCOPES = [
  'https://www.googleapis.com/auth/androidpublisher',
  'https://www.googleapis.com/auth/playdeveloperreporting',
  'https://www.googleapis.com/auth/devstorage.read_only',
]

export type PlayAuthResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'not_configured' | 'error'; detail: string }

let client: JWT | null = null

/**
 * A bearer token for the Play APIs.
 *
 * Same `not_configured` / `error` split as `ascAuthHeader` and for the same
 * reason: "nobody set the key" and "the key is there but we cannot read it" are
 * different problems with different fixes.
 */
export async function playAccessToken(): Promise<PlayAuthResult> {
  if (!client) {
    const read = await readSecret('google-play-service-account')
    if (!read.ok) {
      return read.reason === 'missing'
        ? { ok: false, reason: 'not_configured', detail: read.detail }
        : { ok: false, reason: 'error', detail: read.detail }
    }

    let creds: { client_email?: string; private_key?: string }
    try {
      creds = JSON.parse(read.value) as { client_email?: string; private_key?: string }
    } catch {
      return {
        ok: false,
        reason: 'error',
        detail: 'google-play-service-account is not valid JSON',
      }
    }
    if (!creds.client_email || !creds.private_key) {
      return {
        ok: false,
        reason: 'error',
        detail: 'google-play-service-account is missing client_email or private_key',
      }
    }

    client = new JWT({
      email: creds.client_email,
      // A JSON string carries `\n` as two characters. Restoring them is not
      // optional — `createPrivateKey` rejects the one-line form outright.
      key: creds.private_key.replace(/\\n/g, '\n'),
      scopes: PLAY_SCOPES,
    })
  }

  try {
    const { token } = await client.getAccessToken()
    if (!token) return { ok: false, reason: 'error', detail: 'Play token request returned nothing' }
    return { ok: true, token }
  } catch (err) {
    // A revoked or malformed key lands here. Drop the client so a corrected
    // secret is picked up without waiting for the instance to recycle.
    client = null
    return {
      ok: false,
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Test seam — drops the memoised client. */
export function resetPlayAuthCache(): void {
  client = null
}
