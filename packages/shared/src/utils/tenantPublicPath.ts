// ─── The short form of a public path, on a studio's own domain ─────────────────
//
// `toTenantInternalPath` maps what a visitor asked for onto the app's route
// tree; this is its INVERSE, for the links a page emits. The app builds
// `/de/public/{slug}/site/angebot`, which the domain serves — but the address
// bar should say `/angebot`, which is the whole point of the domain.
//
// Pure, and it never invents a path: anything it cannot express short (another
// tenant's link, or English on a non-English tenant, where the unprefixed path
// already means the tenant's language) comes back unchanged and still works.

import { PUBLIC_LOCALES, DEFAULT_PUBLIC_LOCALE } from '../publicRoutes'

const PREFIXED_LOCALES: readonly string[] = PUBLIC_LOCALES.filter((l) => l !== DEFAULT_PUBLIC_LOCALE)

export interface TenantHostContext {
  slug: string
  scope?: 'team' | 'org'
  /** The language the domain answers in without a prefix. */
  tenantLanguage: string
  /** The website owns `/` — see `toTenantInternalPath`. */
  siteAtRoot: boolean
}

/**
 *     /de/public/cfz/site/angebot?x=1  →  /angebot?x=1   (de tenant, site at root)
 *     /de/public/cfz/site             →  /
 *     /fr/public/cfz/shop             →  /fr/shop
 *     /public/cfz/site                →  unchanged for a de tenant (English)
 */
export function toTenantPublicPath(path: string, ctx: TenantHostContext): string {
  if (typeof path !== 'string' || !path.startsWith('/')) return path
  const [pathname, suffix = ''] = splitSuffix(path)

  const segments = pathname.split('/').filter(Boolean)
  const locale = segments.length && PREFIXED_LOCALES.includes(segments[0]) ? segments.shift()! : ''

  const root = ctx.scope === 'org' ? ['public', 'org', ctx.slug] : ['public', ctx.slug]
  if (root.some((segment, index) => segments[index] !== segment)) return path
  let tail = segments.slice(root.length)

  // The website at the root: `/site` IS `/`, and `/site/x` is `/x`.
  if (ctx.scope !== 'org' && ctx.siteAtRoot && tail[0] === 'site') tail = tail.slice(1)

  // An unprefixed path on the domain means the TENANT's language, so English on
  // a non-English tenant has no short form — the long one stays, and works.
  const prefix =
    locale === ctx.tenantLanguage
      ? ''
      : locale
        ? `/${locale}`
        : ctx.tenantLanguage === DEFAULT_PUBLIC_LOCALE
          ? ''
          : null
  if (prefix === null) return path

  return `${prefix}${tail.length ? `/${tail.join('/')}` : '/'}${suffix}`
}

/** Splits a query / fragment off a path: '/a?b=1#c' → ['/a', '?b=1#c']. */
function splitSuffix(path: string): [string, string] {
  const cut = path.search(/[?#]/)
  return cut === -1 ? [path, ''] : [path.slice(0, cut), path.slice(cut)]
}
