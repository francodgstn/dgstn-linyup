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

export const SITE_PAGE_LIMITS = {
  /** Pages besides the home page. */
  maxPages: 30,
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
