/* eslint-disable no-console */
// PROVIDER USAGE we have to go and ASK for — Brevo and DeepL.
//
// Google Cloud is not here: its spend is PUSHED to us by the billing budget
// (see budgetNotification.ts), so it needs no poll. These two have to be
// fetched, which is why they hang off the daily capture job instead.
//
// ── THE CONTRACT, SHARED WITH mailMetrics.ts / mobileAdoptionMetrics.ts ──────
// Each function returns the block, or NULL. Null means "no block on today's
// snapshot", and the caller omits the key rather than writing a zero: a vendor
// call that failed, a key that is not configured, and a genuine zero are three
// different facts and only the last is a number. The operator console renders
// an absent block as "not measured" and says why it might be.
//
// Consequently NOTHING in here throws. A failure logs and returns null, and the
// daily snapshot is still worth writing without the block.
//
// ── WHAT THESE NUMBERS ARE (AND ARE NOT) ────────────────────────────────────
// Neither is money, and neither is converted into money. Brevo returns CREDITS
// REMAINING per plan line; DeepL returns CHARACTERS against a cap. Converting
// either to francs would need a price this code does not have, and a guessed
// price rendered on a cost page is worse than an honest unit. See
// `PlatformProviderCosts` in @linyup/shared for the whole rule.
import type { BrevoCreditSnapshot, DeeplUsageSnapshot } from '@linyup/shared'
import { getBrevoClient } from '../mail/brevoClient'
import { getSecret } from '../utils/secrets'
import { to } from '../utils/async'

/**
 * Brevo credits, from `GET /v3/account` via the shared client (same key, same
 * Secret Manager entry, no new credential).
 *
 * One line per plan the account holds, kept separate rather than summed: a
 * `sendLimit` line and an `sms` line are not interchangeable units, and CH SMS
 * runs 30–50× email per message.
 */
export async function captureBrevoCredits(
  nowMs = Date.now(),
): Promise<BrevoCreditSnapshot | null> {
  const [clientErr, client] = await to(getBrevoClient())
  if (clientErr || !client) {
    // The commonest cause is simply no key configured in this environment,
    // which is a configuration fact rather than an incident — hence warn.
    console.warn('[provider-usage] brevo: no client (key not configured?)', clientErr?.message)
    return null
  }

  const [err, res] = await to(client.account.getAccount())
  if (err || !res) {
    console.error('[provider-usage] brevo: getAccount failed', err?.message)
    return null
  }

  const lines = Array.isArray(res.plan) ? res.plan : []
  // An account with no plan array is a shape we do not recognise. Returning an
  // empty `plans` would render as "0 credits on no plans", so treat it as a gap.
  if (lines.length === 0) {
    console.warn('[provider-usage] brevo: account carried no plan lines')
    return null
  }

  return {
    plans: lines.map((p) => ({
      type: String(p.type ?? 'unknown'),
      credits: typeof p.credits === 'number' ? p.credits : 0,
      credits_type: String(p.creditsType ?? 'unknown'),
    })),
    fetched_at_ms: nowMs,
  }
}

/** Free-tier DeepL keys are suffixed ':fx' and live on a different host — the
 *  same split `translate/deeplProvider.ts` makes for the translate endpoint. */
function usageEndpointFor(apiKey: string): string {
  return apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/usage'
    : 'https://api.deepl.com/v2/usage'
}

interface DeeplUsageResponse {
  character_count?: unknown
  character_limit?: unknown
}

/**
 * DeepL character usage, from `GET /v2/usage`.
 *
 * Absent whenever DeepL is not the configured provider or no key is set — both
 * are configuration facts. `character_limit` can legitimately be missing on a
 * plan with no cap, which is why it is nullable rather than defaulted: a zero
 * limit would render as "0 characters allowed", the opposite of unlimited.
 */
export async function captureDeeplUsage(
  nowMs = Date.now(),
): Promise<DeeplUsageSnapshot | null> {
  const provider = (process.env.TRANSLATION_PROVIDER ?? '').trim().toLowerCase()
  // Unset means auto (DeepL when keyed) — see translate/provider.ts — so only
  // an explicit other provider rules DeepL out.
  if (provider && provider !== 'deepl') return null

  const [keyErr, apiKey] = await to(getSecret('deepl-api-key'))
  if (keyErr || !apiKey) return null

  const [fetchErr, res] = await to(
    fetch(usageEndpointFor(apiKey), {
      method: 'GET',
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
    }),
  )
  if (fetchErr || !res) {
    console.error('[provider-usage] deepl: usage request failed', fetchErr?.message)
    return null
  }
  if (!res.ok) {
    console.error(`[provider-usage] deepl: usage returned ${res.status}`)
    return null
  }

  const [jsonErr, body] = await to(res.json() as Promise<DeeplUsageResponse>)
  if (jsonErr || !body) {
    console.error('[provider-usage] deepl: usage body was not JSON', jsonErr?.message)
    return null
  }

  const used = typeof body.character_count === 'number' ? body.character_count : null
  if (used === null) {
    console.warn('[provider-usage] deepl: usage carried no character_count')
    return null
  }

  return {
    characters_used: used,
    character_limit: typeof body.character_limit === 'number' ? body.character_limit : null,
    fetched_at_ms: nowMs,
  }
}
