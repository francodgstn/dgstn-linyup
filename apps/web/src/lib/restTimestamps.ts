// Client-safe (no `server-only`) — the counterpart to `firestoreRest.ts`'s
// `{ __ts }` marker. A server component decodes a Firestore REST document into
// plain JSON and hands it to a Client Component as an `initial` prop; JSON
// cannot carry a real `Timestamp` instance, so every `timestampValue` crosses
// that boundary as `{ __ts: '<ISO string>' }` instead. `reviveTimestamps` walks
// the JSON back on the client and swaps every marker for a real `Timestamp`
// (`firebase/firestore`), so any consumer that calls `.toDate()` / `.toMillis()`
// on the data keeps working exactly as it does on a client-fetched document —
// see `packages/shared/src/types/common.ts`'s `Timestamp` interface, which
// either shape satisfies.
import { Timestamp } from 'firebase/firestore'
import type { RestTimestampMarker } from './firestoreRest'

function isTimestampMarker(value: unknown): value is RestTimestampMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__ts' in value &&
    typeof (value as { __ts?: unknown }).__ts === 'string'
  )
}

/** Deep-revive every `{ __ts }` marker in `value` into a real `Timestamp`.
 *  Returns a NEW structure — never mutates its input. Safe to call on data
 *  that carries no markers at all (a plain pass-through). */
export function reviveTimestamps<T>(value: T): T {
  if (isTimestampMarker(value)) {
    return Timestamp.fromDate(new Date(value.__ts)) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => reviveTimestamps(v)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = reviveTimestamps(v)
    }
    return out as T
  }
  return value
}
