import createMiddleware from 'next-intl/middleware'
import { NextRequest, NextResponse } from 'next/server'
import {
  isCustomDomainPassthrough,
  isLinyupOwnHost,
  splitPathLocale,
  toTenantInternalPath,
} from '@linyup/shared'
import { routing } from './i18n/routing'
import { resolveCustomDomainTenant } from './lib/customDomainTenant'
import { resolveSiteLanguage } from './lib/siteLanguage'

const handleI18n = createMiddleware(routing)

// Framing policy is owned here (not in next.config headers) so it can branch on
// the path: the public /embed/* widget routes must be framable by any studio's
// own website, while every other route stays frame-denied. next.config headers
// merge rather than override and apply after middleware, so a single path-aware
// place is the only reliable spot to make this distinction.
//
// Demo builds (sandbox) are themselves embedded as a live preview on the landing
// page, so the whole app allows framing from our own origins there.
const isDemoBuild = process.env.NEXT_PUBLIC_DEMO_MODE === 'true'
const APP_FRAME_CSP =
  "frame-ancestors 'self' https://linyup.com https://*.linyup.com https://*.web.app http://localhost:* http://127.0.0.1:*"

// Matches /embed/… with or without an as-needed locale prefix (/de/embed/…).
const EMBED_PATH = /^\/(?:(?:de|fr|it)\/)?embed\//

// Which hosts are ours is `isLinyupOwnHost` (@linyup/shared) — one list, shared
// with the booking return and pinned by functions/src/domains/siteAtRoot.test.ts.
const isOwnHost = isLinyupOwnHost

/** An internal rewrite, and the locale the rewritten path is in. */
interface Rewrite {
  url: URL
  locale: string
}

/**
 * Rewrite internally, CARRYING THE LOCALE.
 *
 * next-intl resolves the request locale from a header ITS OWN middleware sets
 * (`X-NEXT-INTL-LOCALE`), not from the `[locale]` path segment — so a rewrite
 * that goes around it lands on the German page with the ENGLISH catalog: the
 * studio's own copy in German, every app string around it (the language
 * switcher, "read more", the booking funnel) in English, and `<html lang>`
 * wrong for a screen reader. Setting the header is what the locale-prefixed
 * path is FOR, so the two can never disagree.
 */
function rewriteWithLocale(request: NextRequest, rewrite: Rewrite): NextResponse {
  const headers = new Headers(request.headers)
  headers.set('X-NEXT-INTL-LOCALE', rewrite.locale)
  return NextResponse.rewrite(rewrite.url, { request: { headers } })
}

/**
 * Maps a request on a studio's own domain onto the public route tree, or null
 * when it is not one (or needs no mapping).
 *
 *     book.theirdojo.ch/shop     →  /de/public/{slug}/shop
 *     book.theirdojo.ch/         →  /de/public/{slug}
 *
 * The rewrite is INTERNAL, so the visitor's address bar keeps `/shop` — which is
 * the entire point of a custom domain, and is also why nothing here has to
 * translate `Location` headers back afterwards.
 *
 * `/public/…` is deliberately NOT mapped. The pages emit their own links through
 * `publicHref`, which still produces `/public/{slug}/…`; passing those through
 * means an in-page click serves the same content instead of being mapped a
 * SECOND time into `/public/{slug}/public/{slug}/…`. Both URL forms therefore
 * work on the domain today; making the links themselves emit the short form is
 * the remaining half (see docs/custom-domains.md).
 */
async function tenantRewrite(request: NextRequest): Promise<Rewrite | null> {
  // The Worker preserves the visitor's host here, because forwarding to App
  // Hosting necessarily overwrites `Host` with the backend's own name.
  const host = (request.headers.get('x-linyup-host') || request.nextUrl.hostname).toLowerCase()
  if (isOwnHost(host)) return null

  const pathname = request.nextUrl.pathname
  if (isCustomDomainPassthrough(pathname)) return null

  const [locale, rest] = splitPathLocale(pathname)
  if (rest.startsWith('/public/')) return null // already an internal path

  const tenant = await resolveCustomDomainTenant(host)
  if (!tenant) return null

  // The locale segment is always explicit on the internal path: the routes live
  // under `app/[locale]/`, so a rewrite has to name one. An unprefixed request
  // gets the TENANT's language, not the browser's.
  const language = locale || tenant.language || 'en'
  const url = request.nextUrl.clone()
  // A studio whose website is its front door gets the site at `/` and its pages
  // at the root; every other studio keeps `/` as its default surface.
  url.pathname = `/${language}${toTenantInternalPath(rest, tenant.slug, tenant.scope, { siteAtRoot: tenant.siteAtRoot })}`
  return { url, locale: language }
}

/** `/public/{slug}/site…` — the website, on the app's own hosts. */
const PUBLIC_SITE_PATH = /^\/public\/([A-Za-z0-9_-]+)\/site(?:\/|$)/
/** `/public/org/{slug}…` — an organization's website, which IS its root; only
 *  the static `events` segment beside the site's catch-all is not a site page. */
const PUBLIC_ORG_SITE_PATH = /^\/public\/org\/([A-Za-z0-9_-]+)(?:\/(?!events(?:\/|$))|$)/

/** Whose website a path is, if it is one. */
function publicSiteOf(path: string): { slug: string; scope: 'team' | 'org' } | null {
  const org = PUBLIC_ORG_SITE_PATH.exec(path)?.[1]
  if (org) return { slug: org, scope: 'org' }
  const team = PUBLIC_SITE_PATH.exec(path)?.[1]
  return team ? { slug: team, scope: 'team' } : null
}

/**
 * A website answers in ITS OWN language when the URL names none.
 *
 * `localePrefix: 'as-needed'` leaves the default locale unprefixed, so an
 * unprefixed request resolved to English — and a German site then rendered its
 * German copy with an English switcher and English booking chrome. The studio's
 * `SiteMeta.language` decides instead. A REWRITE, not a redirect: the short URL
 * stays what a studio shares. (On a studio's own domain the same answer comes
 * from the tenant lookup, which already prefers the site's language.)
 */
async function siteLanguageRewrite(request: NextRequest): Promise<Rewrite | null> {
  const pathname = request.nextUrl.pathname
  // `/en/…` — ENGLISH, ASKED FOR EXPLICITLY. `as-needed` has no prefix for the
  // default locale, so next-intl would redirect this to the unprefixed path,
  // which now answers in the SITE's language: on a German site that would make
  // English unreachable, and its hreflang a lie. Serving it here keeps English
  // addressable (the app routes live under `[locale]`, so the path already is
  // the internal one).
  if (pathname.startsWith('/en/') && publicSiteOf(pathname.slice(3))) {
    return { url: request.nextUrl.clone(), locale: 'en' }
  }
  const [locale, rest] = splitPathLocale(pathname)
  if (locale) return null // the visitor named a language — theirs wins
  const site = publicSiteOf(rest)
  if (!site) return null
  const language = await resolveSiteLanguage(site.slug, site.scope)
  // English IS the unprefixed locale; anything else needs the prefix.
  if (!language || language === 'en') return null
  const url = request.nextUrl.clone()
  url.pathname = `/${language}${rest}`
  return { url, locale: language }
}

export default async function proxy(request: NextRequest) {
  // A studio's own domain is resolved BEFORE anything else, because the rules
  // below are about the app's own hosts: a bare `/` must reach the studio's
  // landing surface, not be redirected to the operator login.
  const tenantRewriteResult = await tenantRewrite(request)
  if (tenantRewriteResult) return withFramingPolicy(rewriteWithLocale(request, tenantRewriteResult), request)

  // On our own hosts, a website with its own language gets it — the same
  // internal rewrite the custom-domain branch above does, so the short URL the
  // studio shares stays what the visitor sees.
  const siteLangRewrite = await siteLanguageRewrite(request)
  if (siteLangRewrite) return withFramingPolicy(rewriteWithLocale(request, siteLangRewrite), request)

  // Embed snippet language pinning (WidgetTheme.locale): 'de'/'fr'/'it' bake
  // straight into the path prefix, but English is the UNPREFIXED locale under
  // localePrefix 'as-needed', so it has no prefix to bake into. A cross-origin
  // iframe embed can't carry the NEXT_LOCALE cookie either, so an unprefixed
  // request is auto-detected from Accept-Language — there is no way to pin
  // English on an unprefixed URL without an explicit marker. `?hl=en` is that
  // marker: bypass next-intl's own middleware and rewrite straight to the
  // English page, mirroring what it does internally for the default locale,
  // BEFORE it would otherwise Accept-Language-redirect this request elsewhere.
  // Scoped strictly to unprefixed /embed/* paths carrying `hl=en`.
  const isPinnedEnglishEmbed =
    EMBED_PATH.test(request.nextUrl.pathname) &&
    !/^\/(de|fr|it)\//.test(request.nextUrl.pathname) &&
    request.nextUrl.searchParams.get('hl') === 'en'

  // The app has no marketing root (the landing site is separate) — send a bare
  // root to the login entry. This is done HERE, not in next.config `redirects`,
  // because config redirects run outside middleware, so their Location keeps the
  // leaked Cloud Run :8080 port (see below) and can't be corrected — that's why a
  // bare `demo.linyup.com/` broke while deep links worked. Doing it in middleware
  // routes the Location through the port-fix.
  const response = isPinnedEnglishEmbed
    ? NextResponse.rewrite(
        new URL('/en' + request.nextUrl.pathname + request.nextUrl.search, request.url)
      )
    : request.nextUrl.pathname === '/'
      ? NextResponse.redirect(new URL('/login', request.url))
      : handleI18n(request)

  // Fix redirects behind Firebase App Hosting / Cloud Run.
  //
  // Cloud Run serves the container on :8080. Both the root redirect above and
  // next-intl's locale redirects (e.g. /login → /de/login for a non-default
  // locale) build their Location from the internal request URL, so that port
  // leaks and the browser is sent to `demo.linyup.com:8080`, which is not publicly
  // reachable — the request hangs. English (the default, `as-needed`) needs no
  // locale redirect, which is why only the other languages surfaced it.
  //
  // Trigger on the Cloud-Run-specific :8080 rather than on forwarded-header
  // presence: App Hosting doesn't reliably surface x-forwarded-host/-proto to the
  // middleware, and :8080 never appears in local dev (which serves on :3000), so
  // this is safe there. Restore the public authority (port stripped) from the
  // forwarded/Host header, defaulting to https (Cloud Run is always fronted by it).
  const location = response.headers.get('location')
  if (location) {
    try {
      const url = new URL(location)
      if (url.port === '8080') {
        const publicHost = (
          request.headers.get('x-forwarded-host') ||
          request.headers.get('host') ||
          url.hostname
        )
          .split(',')[0]
          .trim()
          .replace(/:\d+$/, '')
        url.protocol = `${request.headers.get('x-forwarded-proto') || 'https'}:`
        url.hostname = publicHost
        url.port = ''
        response.headers.set('location', url.toString())
      }
    } catch {
      // Relative Location — no authority/port to correct.
    }
  }

  return withFramingPolicy(response, request)
}

/** The framing policy, applied to every exit from `proxy` including the tenant one. */
function withFramingPolicy(response: NextResponse, request: NextRequest): NextResponse {
  if (EMBED_PATH.test(request.nextUrl.pathname)) {
    response.headers.set('Content-Security-Policy', 'frame-ancestors *')
  } else if (isDemoBuild) {
    response.headers.set('Content-Security-Policy', APP_FRAME_CSP)
  } else {
    response.headers.set('X-Frame-Options', 'DENY')
  }
  return response
}

export const config = {
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
}
