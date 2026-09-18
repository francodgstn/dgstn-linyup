/**
 * The `expires_at` stamp for a ledger row written by a SCRIPT — the seeders and
 * the HMD migration.
 *
 * ── WHY THE SCRIPTS NEED THEIR OWN ──────────────────────────────────────────
 * The app's ledger writers stamp every row as they write it
 * (`packages/functions/src/utils/ledgerRetention.ts`). The scripts write ledger
 * rows STRAIGHT TO FIRESTORE with the Admin SDK, bypassing those writers
 * entirely — so every seeded or migrated row used to land without the field,
 * and a row without `expires_at` is never touched by a TTL policy. Silently:
 * no error, and a ledger that simply grows.
 *
 * `scripts/backfill-ledger-ttl.ts` can repair such rows, but repairing SEEDED
 * data is work the next reseed throws away — the `/try` sandbox reseeds nightly
 * and `pnpm emulators:seed` wipes and rewrites — so the stamp belongs at the
 * write, not in a pass afterwards. The backfill stays for rows the APP wrote
 * before its writers shipped, which is the case it was actually built for.
 *
 * ── STAMP FROM THE ROW'S OWN DATE ───────────────────────────────────────────
 * Seed rows are backdated on purpose (`created_at: ts(daysFromNow(-3))`), and a
 * demo tenant's history reads as months long. Stamping those from NOW would
 * give a row dated last spring a retention window starting today — it would
 * outlive a real row of the same age, which is the one thing a seeded ledger
 * should not do. Passing the row's own date is what makes a seeded ledger age
 * exactly like a real one, and it is what the backfill computes too.
 */
import type { Timestamp } from 'firebase-admin/firestore'
import admin from 'firebase-admin'
import { ledgerExpiresAt, type LedgerCollection } from '@linyup/shared'

/** The expiry stamp for a ledger row dated `from`. */
export function ledgerExpiry(collection: LedgerCollection, from: Date): Timestamp {
  return admin.firestore.Timestamp.fromDate(ledgerExpiresAt(collection, from))
}

/** `row`, with its expiry stamped — for a writer that builds the row inline. */
export function withLedgerExpiry<T extends object>(
  collection: LedgerCollection,
  from: Date,
  row: T,
): T & { expires_at: Timestamp } {
  return { ...row, expires_at: ledgerExpiry(collection, from) }
}
