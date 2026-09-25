// PostHog browser client — singleton initialized once on the client side.
// Import this only from client components or the PostHogProvider.
// Server Components and API routes should not import this file.

import posthog from 'posthog-js'
import type { CaptureResult } from 'posthog-js'

// ─── query-string scrubbing ──────────────────────────────────────────────────
//
// NOTHING SENSITIVE MAY REACH ANALYTICS THROUGH A URL. Analytics is the one
// consumer that copies a URL verbatim off the page and ships it to a third party
// where it cannot be retracted, so the scrub lives here rather than at the
// places that might produce such a URL — a producer can be added tomorrow.
// Known producers: a pre-hydration submit on a credential form (closed at
// /login and /signup, but only for browsers running the new build), and the
// Stripe success URL, which deliberately carries `&email=` so the public signup
// form can prefill it.
//
// Applied on EVERY captured event via `before_send`, not just the manual
// pageview: autocapture attaches `$current_url` to click events too. It is
// mounted on `before_send` rather than the older `sanitize_properties` because
// that option is deprecated in posthog-js and its removal would be SILENT — the
// key would simply be ignored, with no exception and nothing here to notice.
const SENSITIVE_QUERY_KEYS = new Set([
  'password',
  'confirmpassword',
  'current-password',
  'new-password',
  'email',
  'token',
  'oobcode',
  'code',
  'secret',
  'apikey',
  'api_key',
  'access_token',
  'id_token',
])

/** Strip credential-ish parameters from a URL or path. Returns it unchanged when
 *  there is nothing to strip, so an ordinary URL is never rewritten. */
export function scrubUrl(value: string): string {
  const q = value.indexOf('?')
  if (q === -1) return value
  const [rawQuery, ...hashParts] = value.slice(q + 1).split('#')
  const params = new URLSearchParams(rawQuery)
  let changed = false
  for (const key of Array.from(params.keys())) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.delete(key)
      changed = true
    }
  }
  if (!changed) return value
  const rest = params.toString()
  const hash = hashParts.length > 0 ? `#${hashParts.join('#')}` : ''
  return `${value.slice(0, q)}${rest ? `?${rest}` : ''}${hash}`
}

/** Every string property that looks like a URL or path with a query — whatever
 *  PostHog decided to name it this version — goes through the scrub. */
function sanitizeProperties<T extends Record<string, unknown>>(properties: T): T {
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== 'string' || !value.includes('?')) continue
    if (!/^https?:\/\//i.test(value) && !value.startsWith('/')) continue
    ;(properties as Record<string, unknown>)[key] = scrubUrl(value)
  }
  return properties
}

/** `before_send` hands over the WHOLE event, so every bag that can carry a URL
 *  has to be named. `$set_once` is the one that is easy to miss: it holds
 *  `$initial_current_url`, and the old `sanitize_properties` hook reached it for
 *  free because PostHog called that hook from its set-once calculation too. */
function scrubEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event
  if (event.properties) event.properties = sanitizeProperties(event.properties)
  if (event.$set) event.$set = sanitizeProperties(event.$set)
  if (event.$set_once) event.$set_once = sanitizeProperties(event.$set_once)
  return event
}

export function initPostHog() {
  if (typeof window === 'undefined') return
  if (posthog.__loaded) return

  const key  = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com'

  if (!key) {
    // Telemetry disabled — key not set (expected in local dev without a PostHog project)
    return
  }

  posthog.init(key, {
    api_host: host,
    // We track pageviews manually via PostHogPageView so the locale route prefix
    // is included in every path before sending.
    capture_pageview: false,
    // Session replay is OFF in the product (privacy). Product analytics runs under
    // legitimate interest in operating and improving the service; customers can opt
    // out from the user menu. PostHog persists that choice (below) and respects it
    // automatically on subsequent loads.
    disable_session_recording: true,
    persistence: 'localStorage+cookie',
    opt_out_capturing_persistence_type: 'localStorage',
    autocapture: true,
    // Belt to the scrub's braces: PostHog's own URL masking, pointed at the same
    // key list, so a value is redacted on the way into a property even before
    // `before_send` sees it.
    mask_personal_data_properties: true,
    custom_personal_data_properties: Array.from(SENSITIVE_QUERY_KEYS),
    before_send: scrubEvent,
  })
}

export { posthog }
