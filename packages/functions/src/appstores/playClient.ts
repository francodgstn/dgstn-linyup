/**
 * Thin Google Play client — read-only.
 *
 * Two APIs, and the split matters:
 *   androidpublisher            reviews, but only the LAST SEVEN DAYS of them
 *   playdeveloperreporting      vitals (crash/ANR) and ANOMALIES
 *
 * ── `androidpublisher.edits` IS DELIBERATELY ABSENT ────────────────────────
 * Reading Play's release TRACKS requires `edits.insert` → `edits.tracks.list` →
 * `edits.delete`: a write-shaped transaction against a live listing, from a
 * cron, on an integration whose entire premise is read-only. It is not worth a
 * track name. If the closed-test state is genuinely wanted in the console it is
 * an operator-typed field, not an API call. Do not "fix" this by adding it.
 *
 * ── AND NEITHER IS `reviews.reply` ─────────────────────────────────────────
 * The API supports replying to a review. This client does not. One-way today,
 * by decision.
 *
 * ── THE 7-DAY WINDOW IS A DATA-LOSS CLOCK ──────────────────────────────────
 * `reviews.list` cannot page past a week. A poll that is broken for eight days
 * loses those reviews from the API permanently — recoverable only from the
 * monthly CSV in the reports bucket. So `sources.play_reviews.last_ok_at` is
 * not cosmetic: it is the only warning that data is being lost.
 */
import type { StoreSourceStatus } from '@linyup/shared'
import { playAccessToken } from './playAuth'
import { PLAY_PACKAGE_NAME } from './config'

const ANDROID_PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3'
const REPORTING = 'https://playdeveloperreporting.googleapis.com/v1beta1'

export class PlayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly sourceStatus: StoreSourceStatus = 'error',
  ) {
    super(message)
    this.name = 'PlayError'
  }
}

export class PlayNotConfiguredError extends PlayError {
  constructor(detail: string) {
    super(detail, undefined, 'not_configured')
    this.name = 'PlayNotConfiguredError'
  }
}

export function playPackageName(): string {
  return PLAY_PACKAGE_NAME.value().trim()
}

async function call<T>(url: string, init?: RequestInit): Promise<T | null> {
  const auth = await playAccessToken()
  if (!auth.ok) {
    if (auth.reason === 'not_configured') throw new PlayNotConfiguredError(auth.detail)
    throw new PlayError(auth.detail)
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  // 404 is a normal pre-launch answer here too — an app with no released track
  // has no vitals resource at all.
  if (res.status === 404) return null
  if (!res.ok) {
    let detail = `Google Play request failed (HTTP ${res.status})`
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body.error?.message) detail = body.error.message
    } catch {
      // Non-JSON body; the status is enough.
    }
    throw new PlayError(detail, res.status)
  }

  return (await res.json()) as T
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export interface PlayReview {
  id: string
  authorName: string | null
  rating: number | null
  text: string | null
  submittedAt: string | null
  appVersion: string | null
  device: string | null
  developerReply: string | null
  developerReplyAt: string | null
}

interface PlayReviewsResponse {
  reviews?: {
    reviewId: string
    authorName?: string
    comments?: {
      userComment?: {
        text?: string
        lastModified?: { seconds?: string }
        starRating?: number
        appVersionName?: string
        device?: string
      }
      developerComment?: { text?: string; lastModified?: { seconds?: string } }
    }[]
  }[]
}

const secondsToIso = (s?: string): string | null =>
  s ? new Date(Number(s) * 1000).toISOString() : null

export async function listRecentReviews(limit = 50): Promise<PlayReview[]> {
  const pkg = playPackageName()
  if (!pkg) throw new PlayNotConfiguredError('PLAY_PACKAGE_NAME is not set for this environment')

  const body = await call<PlayReviewsResponse>(
    `${ANDROID_PUBLISHER}/applications/${encodeURIComponent(pkg)}/reviews?maxResults=${limit}`,
  )
  if (!body?.reviews) return []

  return body.reviews.map((r) => {
    // A review is a thread. The user's own comment is the one with `userComment`;
    // the developer's reply, if any, arrives as a sibling entry.
    const user = r.comments?.find((c) => c.userComment)?.userComment
    const dev = r.comments?.find((c) => c.developerComment)?.developerComment
    return {
      id: r.reviewId,
      authorName: r.authorName ?? null,
      rating: user?.starRating ?? null,
      text: user?.text ?? null,
      submittedAt: secondsToIso(user?.lastModified?.seconds),
      appVersion: user?.appVersionName ?? null,
      device: user?.device ?? null,
      developerReply: dev?.text ?? null,
      developerReplyAt: secondsToIso(dev?.lastModified?.seconds),
    }
  })
}

// ─── Vitals + anomalies ─────────────────────────────────────────────────────

export interface PlayAnomaly {
  metric: string
  detectedAt: string
  note: string | null
}

interface PlayAnomaliesResponse {
  anomalies?: {
    name?: string
    metricSet?: string
    timelineSpec?: { startTime?: Record<string, number> }
    dimensions?: { dimension?: string; stringValue?: string }[]
    metric?: { metric?: string }
  }[]
}

/**
 * Play's own "this changed sharply" feed — the closest thing either store has
 * to an action item, and the reason the Reporting API is worth wiring at all.
 *
 * The response shape is deliberately read loosely: this is a v1beta1 API and a
 * strict mapping would start returning `undefined` the moment Google moves a
 * field, silently. What matters is the metric name and when it fired.
 */
export async function listAnomalies(limit = 20): Promise<PlayAnomaly[]> {
  const pkg = playPackageName()
  if (!pkg) throw new PlayNotConfiguredError('PLAY_PACKAGE_NAME is not set for this environment')

  const body = await call<PlayAnomaliesResponse>(
    `${REPORTING}/apps/${encodeURIComponent(pkg)}/anomalies?pageSize=${limit}`,
  )
  if (!body?.anomalies) return []

  return body.anomalies.map((a) => {
    const start = a.timelineSpec?.startTime
    const detectedAt =
      start && start.year
        ? new Date(
            Date.UTC(start.year, (start.month ?? 1) - 1, start.day ?? 1, start.hours ?? 0),
          ).toISOString()
        : new Date().toISOString()
    return {
      metric: a.metric?.metric ?? a.metricSet ?? a.name ?? 'unknown',
      detectedAt,
      note: a.name ?? null,
    }
  })
}

export interface PlayVitals {
  crashRate: number | null
  anrRate: number | null
}

interface PlayMetricSetResponse {
  rows?: { metrics?: { metric?: string; decimalValue?: { value?: string } }[] }[]
}

/**
 * The most recent daily crash rate and ANR rate.
 *
 * Returns nulls rather than zeros when a metric set has no rows. A crash rate
 * of 0 and an unknown crash rate are not the same claim, and an app with no
 * users produces the latter.
 */
export async function fetchVitals(): Promise<PlayVitals> {
  const pkg = playPackageName()
  if (!pkg) throw new PlayNotConfiguredError('PLAY_PACKAGE_NAME is not set for this environment')

  const query = async (set: 'crashRateMetricSet' | 'anrRateMetricSet'): Promise<number | null> => {
    const body = await call<PlayMetricSetResponse>(
      `${REPORTING}/apps/${encodeURIComponent(pkg)}/${set}:query`,
      {
        method: 'POST',
        body: JSON.stringify({
          metrics: [set === 'crashRateMetricSet' ? 'crashRate' : 'anrRate'],
          timelineSpec: { aggregationPeriod: 'DAILY' },
          pageSize: 1,
        }),
      },
    )
    const raw = body?.rows?.[0]?.metrics?.[0]?.decimalValue?.value
    return raw == null ? null : Number(raw)
  }

  const [crashRate, anrRate] = await Promise.all([
    query('crashRateMetricSet'),
    query('anrRateMetricSet'),
  ])
  return { crashRate, anrRate }
}
