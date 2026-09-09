/**
 * The public iTunes lookup — `https://itunes.apple.com/lookup?id=…`.
 *
 * NO CREDENTIAL OF ANY KIND. This is the whole credential-free slice of the
 * app-store work, and it earns its place for one reason: the App Store Connect
 * API has NO aggregate-ratings endpoint. `/v1/apps/{id}/customerReviews`
 * returns only reviews that carry TEXT, so the star average and rating count an
 * operator actually wants cannot be computed from it — they are here or nowhere.
 *
 * ── `resultCount: 0` IS AN ANSWER, NOT AN ERROR ────────────────────────────
 * The app is not on the store yet, so zero is what this returns today. That is
 * the machine-checkable answer to "are we live", and the day it flips to one is
 * launch day. Treating it as a failure would throw away the only signal this
 * call currently has.
 *
 * ── THERE IS NO ANDROID EQUIVALENT, DELIBERATELY ───────────────────────────
 * Google publishes no public lookup API. The only credential-free route is
 * scraping the Play listing HTML, which is ToS-grey, breaks on markup changes
 * and would put an HTML parser on a cron. The console shows the asymmetry
 * instead — `store_presence/android` simply has no `listing` block.
 */
import type { StoreListingBlock } from '@linyup/shared'

const LOOKUP = 'https://itunes.apple.com/lookup'

/** Only the fields we read. The response carries dozens more. */
interface ItunesResult {
  trackName?: string
  version?: string
  averageUserRating?: number
  userRatingCount?: number
  currentVersionReleaseDate?: string
  trackViewUrl?: string
}

interface ItunesResponse {
  resultCount: number
  results: ItunesResult[]
}

export class ItunesLookupError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ItunesLookupError'
  }
}

/**
 * Public listing facts for one ASC app id, from one storefront.
 *
 * Ratings are per storefront, so `country` is part of the answer rather than a
 * detail — 'ch' and 'us' return different numbers for the same app, and a block
 * that did not say which one it came from would be uncomparable to itself.
 *
 * Throws only on a transport/HTTP failure; a well-formed "no such app" comes
 * back as `live: false`.
 */
export async function lookupItunesApp(
  ascAppId: string,
  country: string,
): Promise<StoreListingBlock> {
  const cc = country.trim().toLowerCase() || 'ch'
  const url = `${LOOKUP}?id=${encodeURIComponent(ascAppId)}&country=${encodeURIComponent(cc)}`

  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    throw new ItunesLookupError(`iTunes lookup failed (HTTP ${res.status})`, res.status)
  }

  // The endpoint answers 200 with a JS content-type and, for some malformed
  // queries, an empty body — so parse defensively rather than trusting res.json().
  const text = await res.text()
  let body: ItunesResponse
  try {
    body = JSON.parse(text) as ItunesResponse
  } catch {
    throw new ItunesLookupError('iTunes lookup returned a non-JSON body')
  }

  const hit = body.resultCount > 0 ? body.results[0] : undefined
  if (!hit) {
    // Not live yet. Everything but `live` and `country` is deliberately absent
    // rather than zeroed: a `rating_count: 0` would claim nobody has rated the
    // app, which is a different statement from "the app is not on the store".
    return { live: false, country: cc }
  }

  return {
    live: true,
    country: cc,
    title: hit.trackName ?? null,
    version: hit.version ?? null,
    released_at: hit.currentVersionReleaseDate ?? null,
    average_rating: hit.averageUserRating ?? null,
    rating_count: hit.userRatingCount ?? null,
    url: hit.trackViewUrl ?? null,
  }
}
