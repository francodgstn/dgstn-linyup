/**
 * Thin App Store Connect client — read-only.
 *
 * Structured exactly like `domains/cloudflare.ts`: `defineString` for the public
 * identifiers, the credential through Secret Manager, a typed error, and the
 * envelope unwrapped in one place.
 *
 * ── 404 IS A NORMAL ANSWER HERE ────────────────────────────────────────────
 * The app is pre-launch. `perfPowerMetrics` has no data, there may be no
 * released version, there are certainly no customer reviews. Every method
 * therefore returns `[]` / `null` on a 404 rather than throwing, and the ingest
 * records `unavailable` — which the console renders as "Apple has no data yet",
 * not as a failure. A client that threw would paint the whole integration red
 * for months and teach everyone to ignore it.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * `POST /v1/analyticsReportRequests` is NOT here. It creates a durable resource
 * on Apple's side, and a cron that calls it is a cron that makes a second one
 * after any lost write. If the richer analytics reports are ever wanted, the
 * create belongs behind the operator callable, adopting an existing ONGOING
 * request before making one. Daily units are available from `salesReports` with
 * a plain GET and no resource creation.
 *
 * Nothing here writes to Apple. There is no `customerReviewResponses` call: we
 * read reviews, we never post a reply.
 */
import type { StoreSourceStatus } from '@linyup/shared'
import { ascAuthHeader } from './appleJwt'
import { ASC_APP_ID } from './config'

const ASC = 'https://api.appstoreconnect.apple.com/v1'

export class AscError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** How the ingest should record this — see StoreSourceStatus. */
    readonly sourceStatus: StoreSourceStatus = 'error',
  ) {
    super(message)
    this.name = 'AscError'
  }
}

/** Thrown when the key is absent, so the ingest can say `not_configured`. */
export class AscNotConfiguredError extends AscError {
  constructor(detail: string) {
    super(detail, undefined, 'not_configured')
    this.name = 'AscNotConfiguredError'
  }
}

interface AscResource<A> {
  id: string
  type: string
  attributes?: A
}

interface AscListResponse<A> {
  data?: AscResource<A>[]
  errors?: { status?: string; code?: string; title?: string; detail?: string }[]
}

export function ascAppId(): string {
  return ASC_APP_ID.value().trim()
}

/**
 * One GET against the ASC API.
 *
 * Returns null on 404 — see the header. Everything else that is not 2xx throws
 * an `AscError` carrying Apple's own `detail`, which is what ends up in
 * `sources.*.error` on screen.
 */
async function get<A>(path: string): Promise<AscListResponse<A> | null> {
  const auth = await ascAuthHeader()
  if (!auth.ok) {
    if (auth.reason === 'not_configured') throw new AscNotConfiguredError(auth.detail)
    throw new AscError(auth.detail)
  }

  const res = await fetch(`${ASC}${path}`, {
    headers: { Authorization: auth.header, Accept: 'application/json' },
  })

  if (res.status === 404) return null
  if (!res.ok) {
    let detail = `App Store Connect request failed (HTTP ${res.status})`
    try {
      const body = (await res.json()) as AscListResponse<never>
      const first = body.errors?.[0]
      if (first?.detail || first?.title) detail = `${first.title ?? ''} ${first.detail ?? ''}`.trim()
    } catch {
      // Non-JSON error body — the status line is all we get, and it is enough.
    }
    // 401/403 on a key that IS present means the wrong role was chosen at mint
    // time (it cannot be changed afterwards) — a real error, not a missing key.
    throw new AscError(detail, res.status)
  }

  return (await res.json()) as AscListResponse<A>
}

// ─── App Store versions ─────────────────────────────────────────────────────

export interface AscVersionAttributes {
  versionString?: string
  appStoreState?: string
  appVersionState?: string
  platform?: string
  createdDate?: string
}

export interface AscVersion {
  id: string
  versionString: string | null
  /**
   * Apple's own word, VERBATIM — WAITING_FOR_REVIEW, IN_REVIEW, REJECTED,
   * PENDING_DEVELOPER_RELEASE, READY_FOR_SALE, …
   *
   * `appStoreState` was superseded by `appVersionState`; both are read and the
   * newer wins, because a client pinned to one of them silently reports
   * `undefined` when Apple moves the field. (Same failure mode the Stripe
   * `objectShape` module exists for.)
   */
  state: string | null
  createdDate: string | null
}

export async function listAppStoreVersions(limit = 5): Promise<AscVersion[]> {
  const appId = ascAppId()
  if (!appId) throw new AscNotConfiguredError('ASC_APP_ID is not set for this environment')

  const body = await get<AscVersionAttributes>(
    `/apps/${appId}/appStoreVersions?limit=${limit}&sort=-createdDate`,
  )
  if (!body?.data) return []

  return body.data.map((v) => ({
    id: v.id,
    versionString: v.attributes?.versionString ?? null,
    state: v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? null,
    createdDate: v.attributes?.createdDate ?? null,
  }))
}

// ─── Review submissions ─────────────────────────────────────────────────────

export interface AscReviewSubmission {
  id: string
  state: string | null
  submittedDate: string | null
  platform: string | null
}

export async function listReviewSubmissions(limit = 5): Promise<AscReviewSubmission[]> {
  const appId = ascAppId()
  if (!appId) throw new AscNotConfiguredError('ASC_APP_ID is not set for this environment')

  const body = await get<{ state?: string; submittedDate?: string; platform?: string }>(
    `/reviewSubmissions?filter[app]=${appId}&limit=${limit}`,
  )
  if (!body?.data) return []

  return body.data.map((s) => ({
    id: s.id,
    state: s.attributes?.state ?? null,
    submittedDate: s.attributes?.submittedDate ?? null,
    platform: s.attributes?.platform ?? null,
  }))
}

// ─── TestFlight builds ──────────────────────────────────────────────────────

export interface AscBuild {
  id: string
  version: string
  build: string
  state: string
  uploadedDate: string | null
}

export async function listBuilds(limit = 5): Promise<AscBuild[]> {
  const appId = ascAppId()
  if (!appId) throw new AscNotConfiguredError('ASC_APP_ID is not set for this environment')

  const body = await get<{
    version?: string
    processingState?: string
    uploadedDate?: string
    expired?: boolean
  }>(`/builds?filter[app]=${appId}&limit=${limit}&sort=-uploadedDate`)
  if (!body?.data) return []

  return body.data.map((b) => ({
    id: b.id,
    // ASC calls the build NUMBER `version` on a build resource; the marketing
    // version lives on the related preReleaseVersion, which this does not
    // expand. Reported as the build, which is what it is.
    version: '',
    build: b.attributes?.version ?? '',
    state: b.attributes?.processingState ?? 'UNKNOWN',
    uploadedDate: b.attributes?.uploadedDate ?? null,
  }))
}

// ─── TestFlight feedback ────────────────────────────────────────────────────

export interface AscBetaFeedback {
  id: string
  comment: string | null
  createdDate: string | null
  deviceModel: string | null
  osVersion: string | null
  appVersion: string | null
  testerName: string | null
}

/**
 * Tester feedback submitted from TestFlight.
 *
 * Pre-launch this is the ONLY stream of real user words the product has, which
 * is why it lands in `store_reviews` beside App Store reviews rather than in a
 * collection of its own.
 */
export async function listBetaFeedback(limit = 20): Promise<AscBetaFeedback[]> {
  const appId = ascAppId()
  if (!appId) throw new AscNotConfiguredError('ASC_APP_ID is not set for this environment')

  const body = await get<{
    comment?: string
    createdDate?: string
    deviceModel?: string
    osVersion?: string
    appVersionString?: string
    buildNumber?: string
    testerFullName?: string
  }>(`/betaFeedbackScreenshotSubmissions?filter[app]=${appId}&limit=${limit}`)
  if (!body?.data) return []

  return body.data.map((f) => ({
    id: f.id,
    comment: f.attributes?.comment ?? null,
    createdDate: f.attributes?.createdDate ?? null,
    deviceModel: f.attributes?.deviceModel ?? null,
    osVersion: f.attributes?.osVersion ?? null,
    appVersion: f.attributes?.appVersionString ?? f.attributes?.buildNumber ?? null,
    testerName: f.attributes?.testerFullName ?? null,
  }))
}

// ─── Customer reviews ───────────────────────────────────────────────────────

export interface AscCustomerReview {
  id: string
  rating: number | null
  title: string | null
  body: string | null
  reviewerNickname: string | null
  territory: string | null
  createdDate: string | null
}

/**
 * App Store reviews, newest first.
 *
 * NOTE what this can and cannot answer. It returns only reviews that carry
 * TEXT — a star rating left without a comment is invisible here — so the
 * aggregate score and rating count must come from the public iTunes lookup
 * instead. Averaging these would report a number that disagrees with the one
 * in App Store Connect, confidently.
 */
export async function listCustomerReviews(limit = 20): Promise<AscCustomerReview[]> {
  const appId = ascAppId()
  if (!appId) throw new AscNotConfiguredError('ASC_APP_ID is not set for this environment')

  const body = await get<{
    rating?: number
    title?: string
    body?: string
    reviewerNickname?: string
    territory?: string
    createdDate?: string
  }>(`/apps/${appId}/customerReviews?limit=${limit}&sort=-createdDate`)
  if (!body?.data) return []

  return body.data.map((r) => ({
    id: r.id,
    rating: r.attributes?.rating ?? null,
    title: r.attributes?.title ?? null,
    body: r.attributes?.body ?? null,
    reviewerNickname: r.attributes?.reviewerNickname ?? null,
    territory: r.attributes?.territory ?? null,
    createdDate: r.attributes?.createdDate ?? null,
  }))
}
