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

/**
 * The first path segments of a tenant's own routes (`/public/{slug}/{segment}`).
 * With the website at the domain root, these still reach their surface and
 * every OTHER path is a page of the site — which is why a site page path may
 * never start with one (`isValidSitePagePath`).
 */
export const TENANT_ROUTE_SEGMENTS: readonly string[] = [
  'site',
  'space',
  'booking',
  'shop',
  'signup',
  'documents',
  'kiosk',
  'events',
  'appointments',
  'manage-booking',
  'waitlist',
  'contact-update',
  'trial-booking',
  'forms',
  'public',
  'pay',
  'embed',
  'api',
]

/**
 * Hosts that are OURS — the app, the marketing site, the previews, localhost.
 * Anything else reaching the app is a studio's own domain, forwarded by the
 * Cloudflare tenant-router.
 */
export function isLinyupOwnHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'linyup.com' ||
    host.endsWith('.linyup.com') ||
    host.endsWith('.hosted.app') ||
    host.endsWith('.web.app') ||
    host === 'localhost' ||
    host === '127.0.0.1'
  )
}

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
 *
 * `siteAtRoot` (a team whose website is its front door): `/` is the site's
 * home, `/angebot/crossfit` its page, and only the tenant's own route segments
 * (`/shop`, `/booking`, … — `TENANT_ROUTE_SEGMENTS`) still reach their surface.
 */
export function toTenantInternalPath(
  pathname: string,
  slug: string,
  scope: 'team' | 'org' = 'team',
  opts: { siteAtRoot?: boolean } = {}
): string {
  const [locale, rest] = splitPathLocale(pathname)
  const prefix = locale ? `/${locale}` : ''
  const root = scope === 'org' ? `/public/org/${slug}` : `/public/${slug}`
  let tail = rest === '/' ? '' : rest.replace(/\/$/, '')
  if (scope === 'team' && opts.siteAtRoot) {
    const first = tail.split('/')[1] ?? ''
    if (!TENANT_ROUTE_SEGMENTS.includes(first)) tail = `/site${tail}`
  }
  return `${prefix}${root}${tail}`
}

/**
 * The address of a page of a team's website ON ITS OWN DOMAIN — for canonical
 * tags, hreflang and the sitemap, which must name the URL a visitor sees.
 *
 *     siteAtRoot, de tenant, de   →  https://crossfitzug.ch/angebot/crossfit
 *     siteAtRoot, de tenant, fr   →  https://crossfitzug.ch/fr/angebot/crossfit
 *     no siteAtRoot               →  https://crossfitzug.ch/site/angebot/crossfit
 *
 * The tenant's own language is unprefixed (the domain answers in it). English
 * on a non-English tenant has NO ADDRESS on the domain at all — `/en` is not a
 * locale prefix under `as-needed`, and the unprefixed path is taken by the
 * tenant's own language — so this returns null and the caller omits it rather
 * than advertising a URL that answers in another language.
 */
export function customDomainSiteUrl(opts: {
  host: string
  slug: string
  locale: string
  tenantLanguage: string
  siteAtRoot: boolean
  segments: readonly string[]
}): string | null {
  const origin = `https://${opts.host}`
  const sub = opts.segments.filter(Boolean).join('/')
  if (opts.locale === opts.tenantLanguage || PREFIXED_LOCALES.includes(opts.locale)) {
    const prefix = opts.locale === opts.tenantLanguage ? '' : `/${opts.locale}`
    const path = opts.siteAtRoot ? (sub ? `/${sub}` : '') : `/site${sub ? `/${sub}` : ''}`
    return `${origin}${prefix}${path}` || origin
  }
  return null
}

/** Escapes a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrites the app's own public links in outbound content onto the studio's
 * custom domain.
 *
 *     https://app.linyup.com/de/public/hmd-basel/manage-booking?t=x
 *  →  https://book.hmdbasel.ch/de/manage-booking?t=x
 *
 * **Applied once, at the send, rather than at each link's call site.** The
 * emailed links are built from a single global `getHostingUrl()` read at ~39
 * places; threading a per-tenant base through all of them means 39 chances to
 * miss one, and a missed one is invisible — the link still works, it just says
 * linyup.com on a studio that is paying to be on their own domain. Rewriting at
 * the seam every studio mail already passes through cannot be missed, and covers
 * call sites that do not exist yet.
 *
 * Anchored on the EXACT origin + locale + `/public/{slug}` prefix, and refuses
 * to match a slug that is merely a prefix of another (`/public/hmd` inside
 * `/public/hmd-basel`), so it cannot touch a link to a different studio.
 */
export function rewriteTenantPublicLinks(
  content: string,
  opts: { origin: string; slug: string; host: string; scope?: 'team' | 'org' }
): string {
  const { origin, slug, host, scope = 'team' } = opts
  if (!content || !origin || !slug || !host) return content

  const localeGroup = `((?:/(?:${PREFIXED_LOCALES.join('|')}))?)`
  const root = scope === 'org' ? 'public/org/' : 'public/'
  const pattern = new RegExp(
    `${escapeRegExp(origin.replace(/\/+$/, ''))}${localeGroup}/${root}${escapeRegExp(slug)}(?![A-Za-z0-9_-])`,
    'g'
  )
  return content.replace(pattern, (_match, locale: string) => `https://${host}${locale}`)
}
