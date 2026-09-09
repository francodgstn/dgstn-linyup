/* eslint-disable no-console */
/**
 * The app-store ingest — App Store Connect + Google Play → `store_presence/*`.
 *
 * Same shape as `dailyTasks/refreshCustomDomains.ts`, which is the house's
 * canonical external-API poll: per-source try/catch, a tally rather than a
 * throw, and status written beside the data so a half-configured integration is
 * legible rather than blank.
 *
 * ── IT RUNS ON ITS OWN SCHEDULE, NOT INSIDE `dailyTasks` ───────────────────
 * `dailyTasks` try/catches each task, so a throw could not take the sweep down.
 * A TIMEOUT could: that function has a 300s budget across seventeen tasks, and
 * a task that hangs on a vendor API kills the ones after it in the array —
 * `rollSessionSeries` (the rolling six-month booking horizon) among them. An
 * experimental read-only dashboard must not be able to stop recurring classes
 * being materialised.
 *
 * ── THE PARENT DOC IS WRITTEN WHOLE, NOT MERGED ────────────────────────────
 * `{merge:true}` does not delete an absent key, so a block omitted because its
 * source failed would leave YESTERDAY's value standing under a fresh
 * `updated_at` — the exact opposite of the "omit, never zero-fill" rule. The
 * doc is small and has one writer, so it is rebuilt from scratch each run and
 * replaced. `ingest_state` is the one thing not re-derived, so it is read first
 * and carried forward explicitly. The per-date `daily` subcollection docs stay
 * merge-safe: they are never partial.
 */
import * as admin from 'firebase-admin'
// Directly, not via `admin.firestore.Timestamp` — that static is only populated
// once something has loaded this submodule, so relying on a sibling import to
// have done so is a runtime crash waiting for whoever removes it.
import { Timestamp } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import {
  STORE_PRESENCE_COLLECTION,
  STORE_PRESENCE_ANDROID_DOC,
  STORE_PRESENCE_IOS_DOC,
  STORE_REVIEWS_COLLECTION,
  storeReviewDocId,
  type StorePlatform,
  type StorePresenceDoc,
  type StoreReviewDoc,
  type StoreReviewKind,
  type StoreSourceHealth,
  type StoreSourceId,
  type StoreSourceStatus,
} from '@linyup/shared'
import { to } from '../utils/async'
import { ASC_APP_ID, ITUNES_LOOKUP_COUNTRY, storeIngestEnabled } from './config'
import { describeError, serverNow, sourceHealth } from './health'
import { lookupItunesApp } from './itunesLookup'
import {
  AscError,
  ascAppId,
  listAppStoreVersions,
  listBetaFeedback,
  listBuilds,
  listCustomerReviews,
  listReviewSubmissions,
} from './appleClient'
import { PlayError, fetchVitals, listAnomalies, listRecentReviews, playPackageName } from './playClient'

export interface StoreIngestTally {
  sources: number
  ok: number
  not_configured: number
  unavailable: number
  failed: number
  reviews_written: number
  detail: Partial<Record<StoreSourceId, StoreSourceStatus>>
}

const emptyTally = (): StoreIngestTally => ({
  sources: 0,
  ok: 0,
  not_configured: 0,
  unavailable: 0,
  failed: 0,
  reviews_written: 0,
  detail: {},
})

function mergeTally(a: StoreIngestTally, b: StoreIngestTally): StoreIngestTally {
  return {
    sources: a.sources + b.sources,
    ok: a.ok + b.ok,
    not_configured: a.not_configured + b.not_configured,
    unavailable: a.unavailable + b.unavailable,
    failed: a.failed + b.failed,
    reviews_written: a.reviews_written + b.reviews_written,
    detail: { ...a.detail, ...b.detail },
  }
}

/**
 * Runs one source and records its health, never throwing.
 *
 * The status a failure maps to is the client's own judgement (`AscError` and
 * `PlayError` both carry a `sourceStatus`), because only the client knows
 * whether a 404 meant "no data yet" or something went wrong.
 */
async function runSource<T>(
  id: StoreSourceId,
  previous: StorePresenceDoc | null,
  fn: () => Promise<T>,
  tally: StoreIngestTally,
): Promise<{ value: T | null; health: StoreSourceHealth }> {
  const prev = previous?.sources?.[id]
  tally.sources += 1

  const [err, value] = await to(fn())
  if (!err) {
    tally.ok += 1
    tally.detail[id] = 'ok'
    return { value: value as T, health: sourceHealth('ok', prev) }
  }

  const status: StoreSourceStatus =
    err instanceof AscError || err instanceof PlayError ? err.sourceStatus : 'error'

  if (status === 'not_configured') tally.not_configured += 1
  else if (status === 'unavailable') tally.unavailable += 1
  else {
    tally.failed += 1
    // Logged at warn, not error: a missing credential on a pre-launch app is
    // the expected state and should not page anyone.
    console.warn(`[appstores] source ${id} failed:`, err.message)
  }

  tally.detail[id] = status
  return { value: null, health: sourceHealth(status, prev, describeError(err)) }
}

async function readPresence(
  db: admin.firestore.Firestore,
  platform: StorePlatform,
): Promise<StorePresenceDoc | null> {
  const [err, snap] = await to(
    db.collection(STORE_PRESENCE_COLLECTION).doc(platformDocId(platform)).get(),
  )
  if (err || !snap?.exists) return null
  return snap.data() as StorePresenceDoc
}

const platformDocId = (p: StorePlatform) =>
  p === 'ios' ? STORE_PRESENCE_IOS_DOC : STORE_PRESENCE_ANDROID_DOC

/**
 * Upserts one review/feedback row.
 *
 * The doc id is deterministic, so a re-poll rewrites the same row rather than
 * duplicating it — which is what makes the daily sweep safe to run against
 * Play's rolling seven-day window.
 */
async function writeReview(
  db: admin.firestore.Firestore,
  platform: StorePlatform,
  kind: StoreReviewKind,
  vendorId: string,
  fields: Omit<StoreReviewDoc, 'platform' | 'kind' | 'vendor_id' | 'ingested_at'>,
): Promise<boolean> {
  const [err] = await to(
    db
      .collection(STORE_REVIEWS_COLLECTION)
      .doc(storeReviewDocId(platform, kind, vendorId))
      .set(
        {
          platform,
          kind,
          vendor_id: vendorId,
          ...fields,
          ingested_at: serverNow(),
        },
        { merge: true },
      ),
  )
  if (err) console.warn(`[appstores] review write failed (${platform}/${vendorId}):`, err.message)
  return !err
}

const isoToTimestamp = (iso: string | null) =>
  iso ? Timestamp.fromDate(new Date(iso)) : Timestamp.now()

// ─── iOS ────────────────────────────────────────────────────────────────────

async function ingestIos(db: admin.firestore.Firestore): Promise<StoreIngestTally> {
  const tally = emptyTally()
  const previous = await readPresence(db, 'ios')
  const appId = ascAppId()

  const sources: StorePresenceDoc['sources'] = {}

  // The public lookup — no credential, and the only source of the aggregate
  // star rating (customerReviews returns text reviews only).
  const listing = await runSource(
    'itunes',
    previous,
    async () => {
      if (!appId) throw new AscError('ASC_APP_ID is not set', undefined, 'not_configured')
      return lookupItunesApp(appId, ITUNES_LOOKUP_COUNTRY.value())
    },
    tally,
  )
  sources.itunes = listing.health

  // ONE health row per QUESTION, not per HTTP call. Versions and submissions
  // both answer "where is the release", builds and feedback both answer "what is
  // in TestFlight" — so each pair is fetched inside a single `runSource`. Two
  // calls sharing a source id would double-count the tally and leave whichever
  // ran last as the recorded status.
  const release = await runSource(
    'asc_versions',
    previous,
    async () => {
      const [versions, submissions] = await Promise.all([
        listAppStoreVersions(),
        listReviewSubmissions(),
      ])
      return { versions, submissions }
    },
    tally,
  )
  const testflight = await runSource(
    'asc_testflight',
    previous,
    async () => {
      const [builds, feedback] = await Promise.all([listBuilds(), listBetaFeedback()])
      return { builds, feedback }
    },
    tally,
  )
  const reviews = await runSource('asc_reviews', previous, () => listCustomerReviews(), tally)

  sources.asc_versions = release.health
  sources.asc_testflight = testflight.health
  sources.asc_reviews = reviews.health

  for (const r of reviews.value ?? []) {
    const written = await writeReview(db, 'ios', 'review', r.id, {
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: r.reviewerNickname,
      locale: r.territory,
      app_version: null,
      device: null,
      submitted_at: isoToTimestamp(r.createdDate) as unknown as StoreReviewDoc['submitted_at'],
    })
    if (written) tally.reviews_written += 1
  }

  for (const f of testflight.value?.feedback ?? []) {
    const written = await writeReview(db, 'ios', 'beta_feedback', f.id, {
      rating: null,
      title: null,
      body: f.comment,
      author: f.testerName,
      locale: null,
      app_version: f.appVersion,
      device: [f.deviceModel, f.osVersion].filter(Boolean).join(' · ') || null,
      submitted_at: isoToTimestamp(f.createdDate) as unknown as StoreReviewDoc['submitted_at'],
    })
    if (written) tally.reviews_written += 1
  }

  const latestVersion = release.value?.versions?.[0]
  const latestSubmission = release.value?.submissions?.[0]
  const builds = testflight.value?.builds ?? []
  const doc: StorePresenceDoc = {
    platform: 'ios',
    app_id: appId || ASC_APP_ID.value(),
    ...(listing.value ? { listing: listing.value } : {}),
    ...(latestVersion?.state
      ? {
          release: {
            state: latestVersion.state,
            version: latestVersion.versionString,
            build: null,
            submission_state: latestSubmission?.state ?? null,
            changed_at: latestVersion.createdDate,
          },
        }
      : {}),
    ...(builds.length
      ? {
          testing: {
            track: 'testflight',
            testers: null,
            builds: builds.map((b) => ({
              version: b.version,
              build: b.build,
              state: b.state,
              uploaded_at: b.uploadedDate,
            })),
          },
        }
      : {}),
    ...(previous?.ingest_state ? { ingest_state: previous.ingest_state } : {}),
    sources,
    updated_at: serverNow() as unknown as StorePresenceDoc['updated_at'],
  }

  const [writeErr] = await to(
    db.collection(STORE_PRESENCE_COLLECTION).doc(STORE_PRESENCE_IOS_DOC).set(doc),
  )
  if (writeErr) console.error('[appstores] ios presence write failed:', writeErr)

  return tally
}

// ─── Android ────────────────────────────────────────────────────────────────

async function ingestAndroid(db: admin.firestore.Firestore): Promise<StoreIngestTally> {
  const tally = emptyTally()
  const previous = await readPresence(db, 'android')
  const pkg = playPackageName()

  const sources: StorePresenceDoc['sources'] = {}

  const reviews = await runSource('play_reviews', previous, () => listRecentReviews(), tally)
  // Vitals and anomalies are one question ("is anything wrong") and one API, so
  // one health row — see the note on the iOS side about sharing a source id.
  const reporting = await runSource(
    'play_reporting',
    previous,
    async () => {
      const [vitals, anomalies] = await Promise.all([fetchVitals(), listAnomalies()])
      return { vitals, anomalies }
    },
    tally,
  )

  sources.play_reviews = reviews.health
  sources.play_reporting = reporting.health

  for (const r of reviews.value ?? []) {
    const written = await writeReview(db, 'android', 'review', r.id, {
      rating: r.rating,
      title: null,
      body: r.text,
      author: r.authorName,
      locale: null,
      app_version: r.appVersion,
      device: r.device,
      submitted_at: isoToTimestamp(r.submittedAt) as unknown as StoreReviewDoc['submitted_at'],
      response_body: r.developerReply,
      response_at: r.developerReplyAt
        ? (isoToTimestamp(r.developerReplyAt) as unknown as StoreReviewDoc['response_at'])
        : null,
    })
    if (written) tally.reviews_written += 1
  }

  const vitalsBlock =
    reporting.value
      ? {
          crash_rate: reporting.value.vitals.crashRate,
          anr_rate: reporting.value.vitals.anrRate,
          anomalies: reporting.value.anomalies.map((a) => ({
            metric: a.metric,
            detected_at: a.detectedAt,
            note: a.note,
          })),
        }
      : null

  // NOTE there is deliberately no `listing` block for Android: Google publishes
  // no public lookup, and the alternative (scraping the store page) is not one.
  // The console shows the asymmetry rather than papering over it.
  const doc: StorePresenceDoc = {
    platform: 'android',
    app_id: pkg,
    ...(vitalsBlock ? { vitals: vitalsBlock } : {}),
    ...(previous?.ingest_state ? { ingest_state: previous.ingest_state } : {}),
    sources,
    updated_at: serverNow() as unknown as StorePresenceDoc['updated_at'],
  }

  const [writeErr] = await to(
    db.collection(STORE_PRESENCE_COLLECTION).doc(STORE_PRESENCE_ANDROID_DOC).set(doc),
  )
  if (writeErr) console.error('[appstores] android presence write failed:', writeErr)

  return tally
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Refreshes one or both stores. NEVER throws — the return value is the report.
 *
 * `force` is what the operator callable passes: a manual refresh has somebody
 * watching it, so it runs even when the environment's kill switch is off.
 */
export async function runStoreIngest(
  only?: StorePlatform,
  opts?: { force?: boolean },
): Promise<StoreIngestTally & { skipped?: boolean }> {
  if (!storeIngestEnabled() && !opts?.force) {
    console.log('[appstores] STORE_INGEST_ENABLED is not true — skipping')
    return { ...emptyTally(), skipped: true }
  }

  const db = admin.firestore()
  let tally = emptyTally()

  if (!only || only === 'ios') {
    const [err, t] = await to(ingestIos(db))
    if (err) console.error('[appstores] ios ingest threw:', err)
    else tally = mergeTally(tally, t)
  }
  if (!only || only === 'android') {
    const [err, t] = await to(ingestAndroid(db))
    if (err) console.error('[appstores] android ingest threw:', err)
    else tally = mergeTally(tally, t)
  }

  console.log(
    `[appstores] ingest done — ${tally.ok} ok, ${tally.not_configured} not configured, ` +
      `${tally.unavailable} unavailable, ${tally.failed} failed, ` +
      `${tally.reviews_written} review rows`,
  )
  return tally
}

/**
 * 05:30 Europe/Zurich — after Apple's previous-day reports are normally posted,
 * and well clear of `capturePlatformMetrics` (00:15, which owns the self-derived
 * adoption block) and `dailyTasks` (02:00 UTC).
 */
export const ingestAppStores = onSchedule(
  { schedule: 'every day 05:30', timeZone: 'Europe/Zurich', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    await runStoreIngest()
  },
)
