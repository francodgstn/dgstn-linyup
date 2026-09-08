/**
 * The path mapping between a tenant's own domain and the app's public route tree.
 *
 *     book.theirdojo.ch/shop      →  /public/{slug}/shop
 *     book.theirdojo.ch/de/shop   →  /de/public/{slug}/shop
 *
 * Pure functions, no request objects — so `proxy.ts` can apply them and
 * `customDomainPaths.test.ts` can exercise every case without a server.
 *
 * **This lives in the APP, not at the edge, and that is the whole design.** The
 * Cloudflare Worker was doing this rewrite until 2026-09; it now forwards the
 * request untouched and the app resolves the tenant. Three things fell out:
 *
 *  - the mapping has ONE implementation instead of two that must agree;
 *  - the rewrite is INTERNAL (`NextResponse.rewrite`), so the visitor's URL
 *    stays `/shop` and nothing has to translate `Location` headers back out of
 *    `/public/{slug}/…` on the way home — a whole class of bug deleted;
 *  - the app already needs the host→tenant mapping for emailed links, canonical
 *    tags and the Stripe return-origin check, so an edge copy could only drift
 *    from it.
 *
 * See `docs/custom-domains.md`.
 */

import { PUBLIC_LOCALES, DEFAULT_PUBLIC_LOCALE } from '../publicRoutes'

/**
 * Locale prefixes that actually appear in a path. `en` is excluded because
 * `localePrefix: 'as-needed'` leaves the default locale unprefixed — treating
 * `/en/shop` as a locale would rewrite it into a route that does not exist.
 */
const PREFIXED_LOCALES: readonly string[] = PUBLIC_LOCALES.filter(
  (l) => l !== DEFAULT_PUBLIC_LOCALE
)

/**
 * Paths that are NOT tenant-scoped and must reach the app untouched.
 *
 * `/pay/` is the Stripe return and lives at the app root, not under a surface —
 * rewriting it would strand every payment mid-checkout. `/embed/` already
 * carries its own slug. `/api/`, `/_next/` and `/__/` are framework- and
 * Firebase-owned.
 */
export const CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES = [
  '/_next/',
  '/api/',
  '/pay/',
  '/embed/',
  '/__/',
]

/** Root files the app serves directly. */
export const CUSTOM_DOMAIN_PASSTHROUGH_EXACT = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/icon.svg',
  '/apple-icon.png',
  '/embed.js',
])

/** Splits a leading locale segment off a path. `/de/shop` → `['de', '/shop']`. */
export function splitPathLocale(pathname: string): [locale: string, rest: string] {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length && PREFIXED_LOCALES.includes(segments[0])) {
    return [segments[0], '/' + segments.slice(1).join('/')]
  }
  return ['', pathname]
}

/** True when the path must be served as-is rather than mapped onto a tenant. */
export function isCustomDomainPassthrough(pathname: string): boolean {
  const [, rest] = splitPathLocale(pathname)
  for (const candidate of [pathname, rest]) {
    if (CUSTOM_DOMAIN_PASSTHROUGH_EXACT.has(candidate)) return true
    if (CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES.some((p) => candidate.startsWith(p))) return true
  }
  // Anything with a file extension in the last segment — mirrors the app's own
  // middleware matcher, which excludes `.*\..*` for the same reason.
  return /\/[^/]*\.[^/]*$/.test(pathname)
}

/**
 * `/de/shop` → `/de/public/{slug}/shop`; `/` → `/public/{slug}`.
 *
 * `scope` picks the tree: a team's surfaces live at `/public/{slug}`, an
 * organisation's at `/public/org/{slug}`.
 */
export function toTenantInternalPath(
  pathname: string,
  slug: string,
  scope: 'team' | 'org' = 'team'
): string {
  const [locale, rest] = splitPathLocale(pathname)
  const prefix = locale ? `/${locale}` : ''
  const root = scope === 'org' ? `/public/org/${slug}` : `/public/${slug}`
  const tail = rest === '/' ? '' : rest.replace(/\/$/, '')
  return `${prefix}${root}${tail}`
}
