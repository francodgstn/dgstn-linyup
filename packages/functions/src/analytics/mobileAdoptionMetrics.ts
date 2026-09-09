/* eslint-disable no-console */
// Member-app adoption, derived from OUR OWN data — `Contact.mobile_app`, which
// the app writes on every foreground.
//
// This exists because the two store dashboards report NOTHING until the app is
// published, and because they answer a different question even afterwards: a
// store knows about downloads, this knows about what is actually RUNNING. "How
// many people are still on an old build" is only answerable here.
//
// No credential, no vendor, no network. It is the one part of the app-store
// insight work that produces real numbers today.

import * as admin from 'firebase-admin'
import { CONTACTS_COLLECTION, type PlatformMobileMetrics } from '@linyup/shared'
import { to } from '../utils/async'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Ceiling on contacts scanned in one capture. Bounded rather than paged
 * deliberately: this is a daily gauge over the contacts that have OPENED THE
 * APP, which is a small subset of a collection that is itself in the thousands.
 * If the log line below ever fires, the fix is a paged cursor — not a bigger
 * number.
 */
const MAX_CONTACTS_SCANNED = 20_000

/** The label used for a telemetry row that carries no version / channel. */
const UNKNOWN = '(unknown)'

/** Just the fields the tally reads — keeps the pure function free of Firestore. */
export interface MobileAdoptionRow {
  version?: string | null
  otaChannel?: string | null
  otaIsEmbedded?: boolean | null
  lastSeenMs?: number | null
}

/**
 * The tally itself. Pure, so it is unit-tested without a database.
 *
 * `installs_seen` only ever grows — there is no uninstall signal in the
 * telemetry, and inventing one from `last_seen_at` would quietly re-define the
 * word. `active_30d` is the figure to read as "people still using it".
 */
export function tallyMobileAdoption(
  rows: MobileAdoptionRow[],
  nowMs: number,
): PlatformMobileMetrics {
  const byVersion: Record<string, number> = {}
  const byOtaChannel: Record<string, number> = {}
  let active30d = 0
  let embedded = 0

  for (const row of rows) {
    const version = row.version || UNKNOWN
    byVersion[version] = (byVersion[version] ?? 0) + 1

    const channel = row.otaChannel || UNKNOWN
    byOtaChannel[channel] = (byOtaChannel[channel] ?? 0) + 1

    if (row.otaIsEmbedded === true) embedded += 1
    if (row.lastSeenMs != null && nowMs - row.lastSeenMs <= THIRTY_DAYS_MS) active30d += 1
  }

  return {
    installs_seen: rows.length,
    active_30d: active30d,
    by_version: byVersion,
    by_ota_channel: byOtaChannel,
    embedded,
  }
}

/**
 * Platform-wide member-app adoption for the snapshot doc.
 *
 * Mirrors `capturePlatformMailMetrics`' contract exactly: returns null when the
 * read fails so the caller OMITS the block rather than writing zeros into a
 * durable snapshot. A zero here would claim nobody is running the app, which is
 * a much more alarming statement than "we could not count".
 *
 * ── WHY THE QUERY ORDERS BY `ota_is_embedded` ──────────────────────────────
 * An `orderBy` on a nested field restricts the result to documents that HAVE
 * it, which is how "contacts that have opened the app" is asked without a
 * second field or an index. The obvious choice, `mobile_app.version`, is the
 * wrong one: `buildMobileAppTelemetry` OMITS `version` when the app cannot read
 * it, while `ota_is_embedded` is written on every single foreground. Ordering
 * on `version` would silently drop exactly the installs whose version we most
 * want to know about.
 *
 * `.select()` keeps this a projection rather than a full-document read of the
 * largest collection in the database.
 */
export async function capturePlatformMobileMetrics(
  db: admin.firestore.Firestore,
  nowMs: number,
): Promise<PlatformMobileMetrics | null> {
  const [err, snap] = await to(
    db
      .collection(CONTACTS_COLLECTION)
      .orderBy('mobile_app.ota_is_embedded')
      .select('mobile_app', 'last_seen_at')
      .limit(MAX_CONTACTS_SCANNED)
      .get(),
  )
  if (err || !snap) {
    console.warn('[mobile-adoption] contact scan failed:', err)
    return null
  }
  if (snap.size >= MAX_CONTACTS_SCANNED) {
    console.warn(
      `[mobile-adoption] hit the ${MAX_CONTACTS_SCANNED} scan ceiling — the figures below ` +
        'are a floor, not a total. Page the query.',
    )
  }

  const rows: MobileAdoptionRow[] = snap.docs.map((doc) => {
    const data = doc.data() as {
      mobile_app?: {
        version?: string | null
        ota_channel?: string | null
        ota_is_embedded?: boolean | null
      }
      last_seen_at?: { toMillis?: () => number }
    }
    return {
      version: data.mobile_app?.version ?? null,
      otaChannel: data.mobile_app?.ota_channel ?? null,
      otaIsEmbedded: data.mobile_app?.ota_is_embedded ?? null,
      lastSeenMs: data.last_seen_at?.toMillis?.() ?? null,
    }
  })

  return tallyMobileAdoption(rows, nowMs)
}
