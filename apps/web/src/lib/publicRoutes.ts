import type { Route } from 'next'
import {
  type ActivePublicSurfaces,
  type PublicFrom,
  type PublicRoutable,
  type PublicRouteParams,
  type PublicSurface,
  publicOrgPath,
  publicPath,
  publicSubPath,
  routableSurfaces,
} from '@linyup/shared'
import { getPathname } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'

// ─── Public tenant routes: the apps/web wrappers ──────────────────────────────
//
// Two href builders that must NEVER be swapped:
//
//   publicHref(…)            → UNPREFIXED path, for next-intl <Link> / useRouter
//                              (imported from '@/i18n/navigation'). Those add the
//                              locale themselves — handing them a prefixed path
//                              yields '/de/de/public/…'.
//
//   publicHrefLocalized(…)   → PREFIXED path, for raw <a href> ONLY.
//                              `components/site/sections.tsx` cannot use <Link>:
//                              the same components render inside a cross-origin
//                              iframe (app/[locale]/embed/…) where every anchor
//                              click is delegated to window.open, and in the
//                              website builder with no router context.
//
// Path strings themselves come from @linyup/shared/publicRoutes, which
// packages/functions shares for emailed links.

/** Unprefixed path, cast for `typedRoutes`. For next-intl `Link` / `useRouter`. */
export function publicHref<R extends PublicRoutable>(
  slug: string,
  route?: R,
  params?: PublicRouteParams[R]
): Route {
  return publicPath(slug, route, params) as Route
}

/** Unprefixed path with extra segments (`booking/{activitySlug}`, `space/courses/{slug}`, …). */
export function publicSubHref<R extends PublicRoutable>(
  slug: string,
  route: R,
  sub: string | string[],
  params?: PublicRouteParams[R]
): Route {
  return publicSubPath(slug, route, sub, params) as Route
}

/**
 * Locale-PREFIXED path, for raw `<a href>`.
 *
 * `getPathname` is the only thing that gets `localePrefix: 'as-needed'` right —
 * it emits `/public/…` for the default locale and `/de/public/…` otherwise.
 * Hand-concatenating `/${locale}` produces `/en/public/…`, which then costs a
 * 302 on every click.
 *
 * A public surface now persists an EXPLICIT choice: `LocaleSwitcher` writes
 * the `NEXT_LOCALE` cookie via `persistLocale` before navigating, so once a
 * visitor picks a language on a public page it sticks across the site the same
 * way it does in the app. First-visit auto-detection (cookie/Accept-Language)
 * is unchanged for everyone who hasn't chosen yet. That still doesn't help a
 * raw `<a href>`, though — an unprefixed one falls back to whatever
 * cookie/Accept-Language resolves to at THAT click, so the prefixed-href
 * regime below is still required for iframes (the embed) and the website
 * builder (no router context): the rationale stands independent of the
 * cookie.
 */
export function publicHrefLocalized<R extends PublicRoutable>(
  locale: string,
  slug: string,
  route?: R,
  params?: PublicRouteParams[R]
): string {
  return localizePublicPath(locale, publicPath(slug, route, params))
}

/** Locale-prefixed variant with extra segments. */
export function publicSubHrefLocalized<R extends PublicRoutable>(
  locale: string,
  slug: string,
  route: R,
  sub: string | string[],
  params?: PublicRouteParams[R]
): string {
  return localizePublicPath(locale, publicSubPath(slug, route, sub, params))
}

/** An organisation site's page as a PREFIXED path, for raw <a href> — the org
 *  twin of `publicHrefLocalized(locale, slug, 'site')`. `segments` [] ⇒ home. */
export function publicOrgHrefLocalized(locale: string, slug: string, segments: readonly string[] = []): string {
  return localizePublicPath(locale, publicOrgPath(slug, segments))
}

/**
 * `getPathname` types `href` against the known route tree, which these
 * query-carrying public paths are not members of — hence the cast. It also only
 * accepts locales in the configured set, so an unexpected value degrades to the
 * unprefixed path rather than producing `/xx/public/…`.
 */
function localizePublicPath(locale: string, path: string): string {
  const locales = routing.locales as readonly string[]
  if (!locales.includes(locale)) return path
  return getPathname({
    href: path as Parameters<typeof getPathname>[0]['href'],
    locale: locale as (typeof routing.locales)[number],
  })
}

/**
 * Where a public flow's "back" should go.
 *
 * Resolving the default surface HERE is the point: linking to `/public/{slug}`
 * and letting the root page redirect means a spinner plus a second hop, and a
 * visitor who came from `/site` ends up on whatever the studio picked as its
 * default — which is the reported bug.
 *
 * Falls back to the team's default surface (then the bio-link) whenever `from`
 * is absent, unknown, or names a surface that isn't live.
 */
export function returnHref(
  team: {
    default_public_surface?: PublicSurface
    active_public_surfaces?: ActivePublicSurfaces
  },
  slug: string,
  from?: PublicFrom
): { href: Route; surface: PublicSurface } {
  const surface = resolveReturnSurface(team, from)
  return { href: publicHref(slug, surface), surface }
}

function resolveReturnSurface(
  team: {
    default_public_surface?: PublicSurface
    active_public_surfaces?: ActivePublicSurfaces
  },
  from?: PublicFrom
): PublicSurface {
  // A valid `from` WINS, and is deliberately NOT gated on
  // `active_public_surfaces`.
  //
  // That flag exists so the team ROOT doesn't redirect into a dead surface —
  // a different question from "where did this visitor come from". The visitor
  // was demonstrably just on that page, which is stronger evidence than a
  // denormalized flag that can be stale or simply not synced yet. Gating on it
  // threw away a correct return target and sent people to the bio-link instead.
  //
  // `from` is a closed enum of this team's own surfaces (parsePublicFrom), so
  // the worst a crafted value can do is link to another page of the same team.
  if (from && from !== 'checkout') return from

  // No usable `from` (cold entry, or a Stripe return): the studio's chosen
  // default. `active_public_surfaces` still guards THAT, because nobody
  // asserted the visitor came from it — read through `routableSurfaces`, so a
  // studio that landed visitors on its shop keeps doing so when it loses the
  // till (the page becomes a price list rather than a dead end).
  const fallback = team.default_public_surface
  if (fallback && fallback !== 'bio-link' && !routableSurfaces(team.active_public_surfaces)[fallback])
    return 'bio-link'
  return fallback ?? 'bio-link'
}

/**
 * Serialize a Next.js `searchParams` bag back into a query string, preserving
 * repeated keys. Used by the redirect shims so an old URL's query survives.
 */
export function toQuery(sp: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x))
    else p.append(k, v)
  }
  const qs = p.toString()
  return qs ? `?${qs}` : ''
}
