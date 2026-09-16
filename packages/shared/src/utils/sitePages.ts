// ─── Site pages — the ONE path grammar ─────────────────────────────────────────
//
// A page of a studio website lives at `/site/{path}`. The path is also what a
// custom domain maps (`/site/…` passes through as-is) and what a crawler
// indexes, so it is deliberately plain: lowercase words of letters and digits,
// joined by single dashes, up to three segments. No dots (the proxy treats any
// segment with a dot as a static file and never rewrites it), no umlauts or
// spaces (they would be percent-encoded into every link), no leading slash.
//
// Pure and dependency-free: the editor normalises what a studio types, the
// publish sanitizer refuses anything else, and the renderer resolves a URL.

import { TENANT_ROUTE_SEGMENTS } from './customDomainPaths'

export const SITE_PAGE_LIMITS = {
  /** Pages besides the home page (posts not counted). */
  maxPages: 30,
  /** Blog posts — capped apart from pages: a blog grows, a page tree does not. */
  maxPosts: 100,
  /** Segments in a path ('ueber-uns/team' is 2). */
  maxDepth: 3,
  /** Characters per segment. */
  maxSegmentLength: 60,
} as const

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const TRANSLITERATE: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', à: 'a', á: 'a', â: 'a', è: 'e', é: 'e', ê: 'e', ë: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ò: 'o', ó: 'o', ô: 'o', ù: 'u', ú: 'u', û: 'u', ç: 'c', ñ: 'n',
}

/** Whether `path` is a valid page path as stored. */
export function isValidSitePagePath(path: string): boolean {
  if (typeof path !== 'string' || !path) return false
  const segments = path.split('/')
  return (
    segments.length <= SITE_PAGE_LIMITS.maxDepth &&
    // On a domain where the site is the front door, `/shop` must still be the
    // shop — so a page can never claim a tenant route's name.
    !TENANT_ROUTE_SEGMENTS.includes(segments[0]) &&
    segments.every((segment) => segment.length <= SITE_PAGE_LIMITS.maxSegmentLength && SEGMENT.test(segment))
  )
}

/**
 * What a studio typed → a valid path, or '' when nothing usable is left.
 * "Über uns / Team" → 'ueber-uns/team'.
 */
export function normalizeSitePagePath(input: string): string {
  const segments = input
    .toLowerCase()
    .split('/')
    .map((segment) =>
      [...segment]
        .map((ch) => TRANSLITERATE[ch] ?? ch)
        .join('')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SITE_PAGE_LIMITS.maxSegmentLength)
        .replace(/-+$/g, '')
    )
    .filter(Boolean)
    .slice(0, SITE_PAGE_LIMITS.maxDepth)
  return segments.join('/')
}

/** A stored path → its URL segments ('ueber-uns/team' → ['ueber-uns', 'team']). */
export function sitePageSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

// ─── Redirects from a previous website ────────────────────────────────────────

/** How many old paths a site may redirect. */
export const SITE_REDIRECT_LIMIT = 200

/**
 * An old site's path as stored and as looked up: lowercase, one leading slash,
 * no trailing slash, no query or fragment, percent-decoded. '' when nothing
 * usable is left — the root is never a redirect (the home page owns it).
 */
export function normalizeSiteRedirectPath(input: string): string {
  if (typeof input !== 'string') return ''
  let path = input.trim().split(/[?#]/)[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    return ''
  }
  path = ('/' + path.toLowerCase()).replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (path.length > 300 || /[\s<>"\\]/.test(path)) return ''
  return path === '/' ? '' : path
}

/** The redirect for a requested path, or null. */
export function findSiteRedirect<R extends { from: string }>(
  redirects: readonly R[] | undefined,
  requestedPath: string
): R | null {
  const path = normalizeSiteRedirectPath(requestedPath)
  if (!path) return null
  return (redirects ?? []).find((redirect) => redirect.from === path) ?? null
}

const SITE_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** A post date as stored: 'YYYY-MM-DD'. */
export function isValidSiteDate(value: unknown): value is string {
  return typeof value === 'string' && SITE_DATE.test(value)
}

/**
 * The visible posts of a page index, newest first — the ONE ordering every
 * posts section and post navigation uses. A post with no date sorts last;
 * equal dates fall back to the title, so the order never flickers.
 */
export function sitePosts<P extends { kind?: string; hidden?: boolean; publishedOn?: string; title: string }>(
  pages: readonly P[] | undefined
): P[] {
  return (pages ?? [])
    .filter((page) => page.kind === 'post' && !page.hidden)
    .sort((a, b) => {
      const byDate = (b.publishedOn ?? '').localeCompare(a.publishedOn ?? '')
      return byDate !== 0 ? byDate : a.title.localeCompare(b.title)
    })
}

/** The page a URL's segments name, or null — the home page is `[]`. Hidden
 *  pages never resolve. */
export function findSitePageByPath<P extends { path: string; hidden?: boolean }>(
  pages: readonly P[] | undefined,
  segments: readonly string[]
): P | null {
  if (!segments.length) return null
  const wanted = segments.map((segment) => segment.toLowerCase()).join('/')
  return (pages ?? []).find((page) => !page.hidden && page.path === wanted) ?? null
}
