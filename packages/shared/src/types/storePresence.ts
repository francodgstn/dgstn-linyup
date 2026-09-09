// App-store presence — what the two stores say about the member app.
//
// Written by the `appstores` ingest (packages/functions/src/appstores/) via the
// Admin SDK, read by the operator console via the Admin SDK. Never client-
// readable: `store_reviews` carries reviewers' display names and free text, so a
// readable collection is a readable list of members' own words.
//
// ── THE APP IS PRE-LAUNCH, AND THAT IS THE DESIGN CONSTRAINT ────────────────
// Nothing is on the public App Store yet and Play is in a closed test, so
// installs, reviews, ratings and vitals are EMPTY — and an empty panel looks
// exactly like a broken integration. `StoreSourceStatus` exists to keep the
// reasons a panel can be empty apart, because the console's copy is the only
// thing that can tell an operator which one they are looking at.

import type { Timestamp } from './common'

export type StorePlatform = 'ios' | 'android'

/**
 * Why a source has no data.
 *
 * `not_configured` is a FIRST-CLASS state, not an error: no credential is the
 * expected steady state today, and rendering it red trains an operator to
 * ignore the one badge that will eventually matter.
 *
 * `unavailable` means the vendor answered, correctly, that there is nothing
 * yet — a 404 from `perfPowerMetrics` before the app has users, an analytics
 * request still warming up. Also not an error.
 */
export type StoreSourceStatus = 'ok' | 'not_configured' | 'error' | 'unavailable'

/** Every source that can report into a `StorePresenceDoc.sources` map. */
export type StoreSourceId =
  | 'itunes'
  | 'asc_versions'
  | 'asc_reviews'
  | 'asc_testflight'
  | 'asc_sales'
  | 'asc_vitals'
  | 'play_reviews'
  | 'play_reporting'
  | 'play_gcs'

export interface StoreSourceHealth {
  status: StoreSourceStatus
  /** Vendor/HTTP detail when `status` is 'error'. NEVER a credential. */
  error?: string | null
  last_ok_at?: Timestamp | null
  last_attempt_at: Timestamp
}

/**
 * Public listing facts. iOS only, from `itunes.apple.com/lookup` — no
 * credential of any kind.
 *
 * `live: false` is the answer to "are we on the store yet", and the day it
 * flips to true is launch day. That is the entire value of this block today.
 */
export interface StoreListingBlock {
  live: boolean
  /** Storefront the lookup was made against (ISO-3166-1 alpha-2, lowercase). */
  country: string
  title?: string | null
  version?: string | null
  released_at?: string | null
  average_rating?: number | null
  rating_count?: number | null
  url?: string | null
}

/** The signal that actually has content pre-launch. */
export interface StoreReleaseBlock {
  /**
   * Apple's `appStoreState` / Play's rollout state, VERBATIM.
   *
   * Not normalised into our own enum: collapsing WAITING_FOR_REVIEW,
   * IN_REVIEW and PENDING_DEVELOPER_RELEASE loses exactly the distinction
   * somebody opened the console to see.
   */
  state: string
  version?: string | null
  build?: string | null
  /** Apple's `reviewSubmissions` state, when a submission is in flight. */
  submission_state?: string | null
  changed_at?: string | null
}

export interface StoreTestingBuild {
  version: string
  build: string
  state: string
  uploaded_at?: string | null
}

export interface StoreTestingBlock {
  /** 'testflight' | 'internal' | 'closed' | … — the vendor's own word. */
  track?: string | null
  testers?: number | null
  builds?: StoreTestingBuild[]
}

export interface StoreAnomaly {
  metric: string
  detected_at: string
  note?: string | null
}

export interface StoreVitalsBlock {
  crash_rate?: number | null
  anr_rate?: number | null
  anomalies?: StoreAnomaly[]
}

export interface StoreInstallsBlock {
  window_days: number
  installs?: number | null
  uninstalls?: number | null
  active_devices?: number | null
  /**
   * The last date the VENDOR has data for.
   *
   * Deliberately distinct from `sources[x].last_ok_at`: "when we last reached
   * Apple" and "what Apple has numbers through" are two clocks, and conflating
   * them puts a green dot over three-day-old installs.
   */
  through_date?: string | null
}

/**
 * Where the ingest LEFT OFF — separate from `sources`, which is how it is
 * DOING. Two questions, two shapes.
 *
 * This is the one block the ingest does not re-derive, so it must be read and
 * carried forward across the (deliberately non-merging) write of the parent
 * doc. See the writer in packages/functions/src/appstores/ingest.ts.
 */
export interface StoreIngestState {
  /** ASC ONGOING `analyticsReportRequest` id. Created ONCE, by an operator. */
  asc_analytics_request_id?: string | null
  asc_analytics_requested_at?: Timestamp | null
  /** ISO instant of the newest customer review already ingested. */
  asc_reviews_high_water?: string | null
  /**
   * Play reports-bucket objects already ingested.
   *
   * An ARRAY, not a map keyed by name: object names contain dots
   * (`installs_com.dgstn.linyup_202609_overview.csv`) and a Firestore map key
   * with a dot in it cannot be addressed by field path.
   */
  play_gcs_seen?: { name: string; updated: string }[]
  play_reviews_high_water?: string | null
}

/** store_presence/{platform} */
export interface StorePresenceDoc {
  platform: StorePlatform
  /** ASC app id (iOS) or package name (Android). */
  app_id: string
  listing?: StoreListingBlock
  release?: StoreReleaseBlock
  testing?: StoreTestingBlock
  vitals?: StoreVitalsBlock
  installs?: StoreInstallsBlock
  ingest_state?: StoreIngestState
  /**
   * The ONLY always-present block, and the reason a half-configured
   * integration is legible: "Apple is fine, Play's bucket grant is missing"
   * rather than one grey card.
   */
  sources: Partial<Record<StoreSourceId, StoreSourceHealth>>
  updated_at: Timestamp
}

/**
 * A review, or a piece of TestFlight feedback.
 *
 * Both live in ONE collection on purpose. Pre-launch the beta feedback IS the
 * entire stream, and an operator wants one chronological list of "what people
 * said about the app"; splitting it to honour a schema distinction produces two
 * empty lists instead of one useful one.
 */
export type StoreReviewKind = 'review' | 'beta_feedback'

/**
 * store_reviews/{platform}_{kind}_{vendorId}
 *
 * The deterministic id makes a re-poll idempotent with no dedupe pass — the
 * same trick `mail_sends` uses with its idempotency key. It matters more here
 * than it looks: Play only exposes the last SEVEN DAYS of reviews, so a poll is
 * the only chance to capture one, and a lost write is permanent.
 */
export interface StoreReviewDoc {
  platform: StorePlatform
  kind: StoreReviewKind
  vendor_id: string
  /** null for `beta_feedback` — TestFlight feedback carries no star rating. */
  rating?: number | null
  title?: string | null
  body?: string | null
  author?: string | null
  locale?: string | null
  app_version?: string | null
  device?: string | null
  submitted_at: Timestamp
  /** The studio's reply, if one was posted IN THE PORTAL. We never post one. */
  response_body?: string | null
  response_at?: Timestamp | null
  ingested_at: Timestamp
}

/**
 * store_presence/{platform}/daily/{date}
 *
 * Vendor-reported series, kept OUT of `platform_metrics/{date}` deliberately.
 * A platform_metrics doc is a gauge snapshot that is never restated; these
 * numbers are late and restated constantly (Apple's daily report lands D+1/D+2,
 * Play rewrites the whole current-month CSV every day). Writing a restatement
 * into a doc whose value is that it does not move is the bug this split avoids.
 */
export interface StoreDailyMetricDoc {
  /**
   * The VENDOR's date, verbatim, 'YYYY-MM-DD'.
   *
   * Apple reports in its own reporting day and Play's CSVs are Pacific, while
   * `platform_metrics` keys Europe/Zurich. Re-keying a vendor date into our
   * timezone is a silent, permanent class of error — don't.
   */
  date: string
  platform: StorePlatform
  source: 'asc_sales_report' | 'asc_analytics' | 'play_gcs_installs' | 'play_reporting'
  installs?: number | null
  uninstalls?: number | null
  updates?: number | null
  active_devices?: number | null
  crash_rate?: number | null
  /** When WE fetched it. A restatement moves this; `date` never moves. */
  fetched_at: Timestamp
}

// ─── Webhook events ─────────────────────────────────────────────────────────
// App Store Connect pushes state changes (WWDC25 webhooks). Google Play has no
// equivalent and must be polled, so every row here is iOS today.

export type StoreEventKind = 'version_state' | 'build_state' | 'beta_feedback' | 'other'

/**
 * store_events/{platform}_{vendorEventId}
 *
 * Append-only log of what the store told us, as it told us. Deliberately NOT
 * merged into `store_presence`: that doc is a gauge with exactly ONE writer
 * (the ingest, which replaces it wholesale), and a second writer would either
 * be clobbered or would diverge from the API's own answer. The webhook instead
 * records the event here and re-runs the ingest, so the gauge still has one
 * writer and the card cannot say READY_FOR_REVIEW while the log says REJECTED.
 *
 * The doc id derives from Apple's own `data.id`, so a redelivery rewrites the
 * same row rather than duplicating it. `occurred_at` comes from the payload and
 * therefore never moves on redelivery; `received_at` may.
 */
export interface StoreEventDoc {
  platform: StorePlatform
  /** Apple's `data.type`, VERBATIM — e.g. 'appStoreVersionAppVersionStateUpdated'. */
  vendor_type: string
  /** Apple's `data.id`. */
  vendor_id: string
  kind: StoreEventKind
  /** One line, computed once at receipt, for the console list. */
  summary: string
  old_value?: string | null
  new_value?: string | null
  /** The ASC resource the event is about, e.g. 'appStoreVersions' / its id. */
  instance_type?: string | null
  instance_id?: string | null
  /**
   * A state worth a human's attention right now.
   *
   * A HIGHLIGHT, NOT A FILTER. Every event is stored and shown whatever this
   * says, and `new_value` is always rendered verbatim beside it — so a state
   * Apple adds that this does not recognise costs a badge, never visibility.
   * That is what makes it safe to match on a known set of names.
   */
  needs_attention: boolean
  occurred_at: Timestamp
  received_at: Timestamp
}

/**
 * App Store version states that mean somebody has to do something.
 *
 * Two groups, and they are not the same feeling: the rejections need a fix,
 * `PENDING_DEVELOPER_RELEASE` needs a button pressed. Both are "you are the
 * blocker", which is the question this answers.
 */
export const ATTENTION_VERSION_STATES: readonly string[] = [
  'REJECTED',
  'METADATA_REJECTED',
  'DEVELOPER_REJECTED',
  'INVALID_BINARY',
  'PENDING_DEVELOPER_RELEASE',
]

/** Doc id for an event row. */
export function storeEventDocId(platform: StorePlatform, vendorEventId: string): string {
  return `${platform}_${vendorEventId}`
}

/** Doc id for a review/feedback row. */
export function storeReviewDocId(
  platform: StorePlatform,
  kind: StoreReviewKind,
  vendorId: string,
): string {
  return `${platform}_${kind}_${vendorId}`
}
