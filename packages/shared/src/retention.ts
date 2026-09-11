// Retention of the append-only ledgers — ONE policy, read by the writers that
// stamp `expires_at`, by the backfill that stamps the rows written before the
// field existed (`scripts/backfill-ledger-ttl.ts`), and by the operator console
// when it labels a figure with the window it covers.
//
// Firestore's TTL policy does the deleting: a `ttl: true` field override on
// `expires_at` (firestore.index.json) per collection group. No job, no sweep,
// nothing to time out over a thousand tenants; a TTL delete is billed like any
// delete and lands within about 72 hours of the stamp. Until this existed the
// ledgers had NO retention at all — every booking, every email and every rule
// run, forever (docs/scalability-2026-09.md, "Housekeeping").
//
// A TTL policy is per COLLECTION GROUP, so it reaches every subcollection of
// that name: `activity_log` is both the studio's feed (`teams/{id}/activity_log`)
// and the contact's own timeline (`contacts/{id}/activity_log`), and they age
// out together.

export const LEDGER_RETENTION_DAYS = {
  /** `teams/{id}/activity_log` (the studio's feed) and
   *  `contacts/{id}/activity_log` (a contact's timeline). Eighteen months: a
   *  full season with margin. */
  activity_log: 548,
  /** `mail_sends` — the send log and idempotency ledger, email and SMS. The
   *  daily platform series and the running total are captured into
   *  `platform_metrics` before rows age out (mail/mailMetrics.ts);
   *  suppressions live in their own collections and never expire. */
  mail_sends: 90,
  /** `teams/{id}/automation_logs` — one row per rule per run. */
  automation_logs: 90,
  /** `teams/{id}/notifications` — the studio's inbox. A notification is a
   *  NUDGE, not a record: what it points at (the request, the submission, the
   *  organisation) keeps its own document. The only reader shows the UNREAD
   *  page (`useTeamNotifications`), so an item nobody opened in ninety days is
   *  not one the studio was going to open. */
  notifications: 90,
} as const

export type LedgerCollection = keyof typeof LEDGER_RETENTION_DAYS

/** The field the TTL policies key on — the same name in every ledger. */
export const LEDGER_EXPIRES_AT_FIELD = 'expires_at'

const DAY_MS = 86_400_000

/** When a row written (or dated) at `from` should be deleted. */
export function ledgerExpiresAt(collection: LedgerCollection, from: Date = new Date()): Date {
  return new Date(from.getTime() + LEDGER_RETENTION_DAYS[collection] * DAY_MS)
}
