// The `expires_at` stamp for the append-only ledgers. The policy (which
// collections, how long) is `LEDGER_RETENTION_DAYS` in @linyup/shared; this is
// its Admin-SDK rendering. Every writer of a ledger row goes through one of
// these — a row written without the field never expires, silently, which is
// exactly the state the whole ledger was in before.

import { Timestamp } from 'firebase-admin/firestore'
import { ledgerExpiresAt, type LedgerCollection } from '@linyup/shared'

/** The expiry stamp for a row written now (or dated `from`). */
export function ledgerExpiry(collection: LedgerCollection, from: Date = new Date()): Timestamp {
  return Timestamp.fromDate(ledgerExpiresAt(collection, from))
}

/** `row`, with its expiry stamped — for a writer that builds the row inline. */
export function withLedgerExpiry<T extends object>(
  collection: LedgerCollection,
  row: T,
): T & { expires_at: Timestamp } {
  return { ...row, expires_at: ledgerExpiry(collection) }
}
