/**
 * Per-source health for `StorePresenceDoc.sources`.
 *
 * ── THE POINT OF THIS FILE ─────────────────────────────────────────────────
 * The app is pre-launch, so almost every panel in the console is empty — and an
 * empty panel looks exactly like a broken integration. These four states are
 * the only thing that can tell an operator which kind of empty they are looking
 * at:
 *
 *   ok            we asked and got an answer
 *   not_configured  no credential. THE EXPECTED STEADY STATE TODAY, not a fault
 *   unavailable   the vendor answered "there is nothing yet" — also not a fault
 *   error         we asked and it went wrong; `error` says how
 *
 * Collapse any two of them and the console gains a badge nobody can act on.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import type { StoreSourceHealth, StoreSourceStatus } from '@linyup/shared'

/**
 * The health row for one source, preserving `last_ok_at` across a failure.
 *
 * `previous` is the source's row from the doc as it stands. Carrying its
 * `last_ok_at` forward is what makes "Apple has been failing for three days"
 * expressible at all — the parent doc is written whole (see ingest.ts), so a
 * value not carried here is a value erased.
 */
export function sourceHealth(
  status: StoreSourceStatus,
  previous?: StoreSourceHealth,
  error?: string | null,
): StoreSourceHealth {
  const now = Timestamp.now()
  const lastOk = status === 'ok' ? now : (previous?.last_ok_at ?? null)
  return {
    status,
    // Written explicitly as null rather than omitted: the parent doc is a whole
    // replace, so an omitted key here is a key that vanishes, and a vanished
    // `error` on a still-failing source reads as a source that recovered.
    error: status === 'error' ? (error ?? 'unknown error') : null,
    last_ok_at: lastOk as StoreSourceHealth['last_ok_at'],
    last_attempt_at: now as unknown as StoreSourceHealth['last_attempt_at'],
  }
}

/**
 * A vendor/HTTP message, safe to store.
 *
 * NEVER pass a request object or headers through here — `sources.*.error` is
 * read back by the console and shown on screen, and a bearer token in an error
 * string is a bearer token in Firestore.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500)
  return String(err).slice(0, 500)
}

/** Server timestamp for `updated_at` / `ingested_at` / `fetched_at`. */
export const serverNow = () => FieldValue.serverTimestamp()
