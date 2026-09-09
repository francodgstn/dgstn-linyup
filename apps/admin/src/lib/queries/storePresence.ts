import 'server-only'
import {
  PLATFORM_METRICS_COLLECTION,
  STORE_PRESENCE_ANDROID_DOC,
  STORE_PRESENCE_COLLECTION,
  STORE_PRESENCE_IOS_DOC,
  STORE_REVIEWS_COLLECTION,
  type PlatformMetricsDoc,
  type PlatformMobileMetrics,
  type StorePlatform,
  type StorePresenceDoc,
  type StoreReviewDoc,
  type StoreSourceId,
  type StoreSourceStatus,
} from '@linyup/shared'
import { adminDb } from '@/lib/firebase-admin'

// Reads for the Member app page. Firestore Timestamps are converted to numbers
// at this boundary — they cannot cross the server→client component line.

export interface SourceRow {
  id: StoreSourceId
  status: StoreSourceStatus
  error: string | null
  lastOkMs: number | null
  lastAttemptMs: number | null
}

export interface StorePresenceView {
  platform: StorePlatform
  /** null when the ingest has never run for this platform. */
  present: boolean
  appId: string | null
  listing: StorePresenceDoc['listing'] | null
  release: StorePresenceDoc['release'] | null
  testing: StorePresenceDoc['testing'] | null
  vitals: StorePresenceDoc['vitals'] | null
  installs: StorePresenceDoc['installs'] | null
  sources: SourceRow[]
  updatedMs: number | null
}

export interface StoreReviewView {
  id: string
  platform: StorePlatform
  kind: StoreReviewDoc['kind']
  rating: number | null
  title: string | null
  body: string | null
  author: string | null
  appVersion: string | null
  device: string | null
  locale: string | null
  submittedMs: number | null
  responseBody: string | null
}

// A Firestore Timestamp as it arrives from the Admin SDK.
type Stamp = { toMillis?: () => number } | null | undefined
const ms = (t: Stamp): number | null => t?.toMillis?.() ?? null

function toView(platform: StorePlatform, doc: StorePresenceDoc | null): StorePresenceView {
  if (!doc) {
    return {
      platform,
      present: false,
      appId: null,
      listing: null,
      release: null,
      testing: null,
      vitals: null,
      installs: null,
      sources: [],
      updatedMs: null,
    }
  }

  const sources: SourceRow[] = Object.entries(doc.sources ?? {}).map(([id, health]) => ({
    id: id as StoreSourceId,
    status: health.status,
    error: health.error ?? null,
    lastOkMs: ms(health.last_ok_at as Stamp),
    lastAttemptMs: ms(health.last_attempt_at as Stamp),
  }))

  return {
    platform,
    present: true,
    appId: doc.app_id || null,
    listing: doc.listing ?? null,
    release: doc.release ?? null,
    testing: doc.testing ?? null,
    vitals: doc.vitals ?? null,
    installs: doc.installs ?? null,
    sources,
    updatedMs: ms(doc.updated_at as Stamp),
  }
}

export async function getStorePresence(): Promise<{
  ios: StorePresenceView
  android: StorePresenceView
}> {
  const col = adminDb.collection(STORE_PRESENCE_COLLECTION)
  const [iosSnap, androidSnap] = await Promise.all([
    col.doc(STORE_PRESENCE_IOS_DOC).get(),
    col.doc(STORE_PRESENCE_ANDROID_DOC).get(),
  ])

  return {
    ios: toView('ios', iosSnap.exists ? (iosSnap.data() as StorePresenceDoc) : null),
    android: toView('android', androidSnap.exists ? (androidSnap.data() as StorePresenceDoc) : null),
  }
}

/**
 * Recent reviews and TestFlight feedback, newest first, across both stores.
 *
 * One list on purpose: pre-launch the beta feedback IS the stream, and an
 * operator wants "what did people say about the app", not two tabs that are
 * both empty.
 */
export async function getStoreReviews(limit = 20): Promise<StoreReviewView[]> {
  try {
    const snap = await adminDb
      .collection(STORE_REVIEWS_COLLECTION)
      .orderBy('submitted_at', 'desc')
      .limit(limit)
      .get()

    return snap.docs.map((d) => {
      const r = d.data() as StoreReviewDoc
      return {
        id: d.id,
        platform: r.platform,
        kind: r.kind,
        rating: r.rating ?? null,
        title: r.title ?? null,
        body: r.body ?? null,
        author: r.author ?? null,
        appVersion: r.app_version ?? null,
        device: r.device ?? null,
        locale: r.locale ?? null,
        submittedMs: ms(r.submitted_at as Stamp),
        responseBody: r.response_body ?? null,
      } satisfies StoreReviewView
    })
  } catch (err) {
    // An empty collection has no index to be missing, but a FAILED_PRECONDITION
    // here carries the index-creation URL — so log the cause and render an empty
    // list rather than 500ing the whole page. Same posture as queries/messaging.
    console.warn('[store-presence] review read failed:', err)
    return []
  }
}

/**
 * The most recent daily snapshot that actually carries a `mobile` block.
 *
 * Not simply "yesterday's doc": the block is OMITTED on any day whose
 * aggregation failed, and on every snapshot from before the block existed. A
 * reader that took the newest doc and found no block would report "no installs"
 * on the strength of one failed read.
 */
export async function getMobileAdoption(): Promise<{
  metrics: PlatformMobileMetrics
  date: string
} | null> {
  const snap = await adminDb
    .collection(PLATFORM_METRICS_COLLECTION)
    .orderBy('date', 'desc')
    .limit(14)
    .get()

  for (const doc of snap.docs) {
    const m = doc.data() as PlatformMetricsDoc
    if (m.mobile) return { metrics: m.mobile, date: m.date }
  }
  return null
}
