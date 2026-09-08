import createMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'
import { isCustomDomainPassthrough, splitPathLocale, toTenantInternalPath } from '@linyup/shared'
import { routing } from './i18n/routing'
import { resolveCustomDomainTenant } from './lib/customDomainTenant'

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

/**
 * Hosts that are OURS — the app, the marketing site, the previews, localhost.
 * Anything else reaching this app is a studio's own domain, forwarded here by
 * the Cloudflare tenant-router.
 */
function isOwnHost(hostname: string): boolean {
  return (
    hostname === 'linyup.com' ||
    hostname.endsWith('.linyup.com') ||
    hostname.endsWith('.hosted.app') ||
    hostname.endsWith('.web.app') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1'
  )
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
async function tenantRewrite(request: NextRequest): Promise<URL | null> {
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
  url.pathname = `/${language}${toTenantInternalPath(rest, tenant.slug, tenant.scope)}`
  return url
}

export default async function proxy(request: NextRequest) {
  // A studio's own domain is resolved BEFORE anything else, because the rules
  // below are about the app's own hosts: a bare `/` must reach the studio's
  // landing surface, not be redirected to the operator login.
  const tenantUrl = await tenantRewrite(request)
  if (tenantUrl) return withFramingPolicy(NextResponse.rewrite(tenantUrl), request)

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
