// ─── Where a visitor may be sent back to after paying ──────────────────────────
//
// Paying leaves the page for Stripe and returns to /pay/result, which then
// restores the page the visitor was booking on. That stored path feeds a
// navigation and sessionStorage is writable by any script on the origin, so it
// is validated on the way in AND out (apps/web/src/lib/bookingReturn.ts).
//
// Pure, so the rule is tested once (functions/src/domains) rather than trusted.

/** Paths that are never a place to return to — the payment return itself would
 *  loop, and the framework / API / embed paths are not pages a visitor was on. */
const NEVER_RETURN_TO = /^(?:\/[a-z]{2})?\/(?:pay|api|_next|embed|__)(?:\/|$)/

/** A public tenant path on the app's own hosts: `/de/public/{slug}/…`. */
const LONG_PUBLIC_PATH = /^(\/[a-z]{2})?\/public\/[A-Za-z0-9_-]+(\/[A-Za-z0-9._-]*)*(\?[^#]*)?$/

/** Any path on a studio's own domain: `/`, `/site/angebot`, `/de/booking?x=1`. */
const SHORT_PATH = /^(\/[A-Za-z0-9._-]+)*\/?(\?[^#]*)?$/

/**
 * Whether `value` may be restored after checkout.
 *
 * `customDomain` widens it: on the app's own hosts only `/public/{slug}/…` is a
 * tenant page, but on a studio's OWN domain every page is theirs and the short
 * form (`/site/angebot/crossfit`) is what the address bar shows.
 */
export function isRestorableReturnPath(value: string | null | undefined, opts: { customDomain: boolean }): boolean {
  if (!value || value.length > 512) return false
  // A root-relative path only: never `//evil.com`, `https://…` or `javascript:`.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  if (NEVER_RETURN_TO.test(value)) return false
  if (LONG_PUBLIC_PATH.test(value)) return true
  return opts.customDomain && SHORT_PATH.test(value)
}
