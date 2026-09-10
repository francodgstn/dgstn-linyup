/* eslint-disable no-console */
// Outbound-volume counts over the `mail_sends` send log.
//
// There is deliberately NO stored per-team counter behind these numbers. A
// counter exists to beat write contention, and a per-team mail counter would be
// touched once per email — a thousand studios at a hundred mails a day is one
// write per team per quarter of an hour. So the ledger is aggregated directly:
// an aggregation costs no extra write and cannot drift out of sync with the
// rows it aggregates. The platform DAILY snapshot below is stored anyway,
// because a day that has passed can no longer be re-derived if the raw ledger
// is ever given a retention policy.
//
// A ROW IS A PROVIDER CALL, NOT AN EMAIL. `msg.to` may be an array, so one call
// can carry several addresses; the addresses are the figure an operator reads as
// "emails". So the sent figures SUM `recipient_count` while the suppressed
// figure COUNTS rows — a suppressed send never reached the provider and carries
// `recipient_count: 0`, so there is nothing to sum there.
//
// Everything here aggregates email only (`channel == 'email'`). SMS shares the
// collection and is reported as its own figure — a studio's mail volume and its
// SMS spend are different questions with different costs.
import * as admin from 'firebase-admin'
import { AggregateField, Timestamp } from 'firebase-admin/firestore'
import { MAIL_SENDS_COLLECTION, type PlatformMailMetrics } from '@linyup/shared'
import { to } from '../utils/async'

const TIMEZONE = 'Europe/Zurich'

// Wall-clock midnight in Zurich, resolved to the UTC instant it actually is.
// Guess-then-correct, the same trick as utils/recurrence.ts: Zurich is UTC+1 or
// UTC+2 depending on the date, and a fixed offset puts the window an hour wrong
// twice a year — which silently moves a day's worth of sends into its neighbour.
function zurichMidnightUtc(year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(guess))
      .map(({ type, value }) => [type, parseInt(value, 10)]),
  ) as Record<string, number>
  const local = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  )
  return new Date(guess + (guess - local))
}

/**
 * The `[start, end)` UTC instants of the Zurich calendar day BEFORE `date`
 * ('YYYY-MM-DD' — the snapshot's own date key).
 *
 * The capture cron runs just after midnight, so the last day it can report in
 * full is the one that has just ended. `Date.UTC` normalises day 0 into the
 * previous month, so the first of a month needs no special case.
 */
export function previousZurichDay(date: string): { start: Date; end: Date } {
  const [year, month, day] = date.split('-').map(Number)
  return {
    start: zurichMidnightUtc(year!, month!, day! - 1),
    end: zurichMidnightUtc(year!, month!, day!),
  }
}

// null (not 0) when the read fails — a missing index must leave a GAP in the
// series, never a fabricated zero that reads as "no mail was sent that day".
async function countOrNull(query: FirebaseFirestore.Query): Promise<number | null> {
  const [err, snap] = await to(query.count().get())
  if (err || !snap) {
    console.warn('[mail-metrics] count failed:', err)
    return null
  }
  return snap.data().count
}

// Addresses, not rows. Same null-on-failure posture as countOrNull, and the same
// indexes — an aggregation is served by the index the equivalent query uses.
async function sumRecipientsOrNull(query: FirebaseFirestore.Query): Promise<number | null> {
  const [err, snap] = await to(
    query.aggregate({ recipients: AggregateField.sum('recipient_count') }).get(),
  )
  if (err || !snap) {
    console.warn('[mail-metrics] sum failed:', err)
    return null
  }
  return snap.data().recipients
}

/**
 * Called by `capturePlatformMetrics` (`../analytics/platformMetrics.ts`, the
 * 00:15 Europe/Zurich cron), between `platformMetricsToDoc` and the `set()`.
 * Snapshots written before that wiring landed carry no `mail` block at all, so
 * every reader must keep tolerating its absence — the platform's 30-day and
 * lifetime mail figures do NOT depend on it either way, being aggregated live
 * by `apps/admin/src/lib/queries/messaging.ts`. What this stores is the DAILY
 * series, which cannot be re-derived once a retention policy exists, which is
 * the whole reason for storing it.
 *
 * Platform-wide email volume for the snapshot doc dated `date`. Includes studio
 * mail AND Linyup's own system mail — the platform total is "how much mail did
 * this product send", which is a different question from the per-studio figures
 * (those are `team_id`-scoped and so studio-only).
 *
 * `sent_*` are ADDRESSES (summed `recipient_count`); `suppressed_yesterday` is
 * SENDS dropped before the provider, which have no addresses to sum.
 *
 * Returns null when any aggregation fails, so the caller omits the block rather
 * than writing zeros into a durable snapshot.
 */
export async function capturePlatformMailMetrics(
  db: admin.firestore.Firestore,
  date: string,
): Promise<PlatformMailMetrics | null> {
  const { start, end } = previousZurichDay(date)
  const email = db.collection(MAIL_SENDS_COLLECTION).where('channel', '==', 'email')
  const day = email
    .where('created_at', '>=', Timestamp.fromDate(start))
    .where('created_at', '<', Timestamp.fromDate(end))

  // Suppressed rows carry `recipient_count: 0`, so the sums need no
  // `status != 'suppressed'` filter — which is just as well: an inequality drops
  // documents where the field is absent, and it cannot be combined with the
  // `created_at` range anyway.
  const [daySent, daySuppressed, allSent] = await Promise.all([
    sumRecipientsOrNull(day),
    countOrNull(day.where('status', '==', 'suppressed')),
    sumRecipientsOrNull(email),
  ])
  if (daySent == null || daySuppressed == null || allSent == null) return null

  return {
    sent_yesterday: daySent,
    suppressed_yesterday: daySuppressed,
    sent_cumulative: allSent,
  }
}
