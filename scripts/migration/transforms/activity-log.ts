/**
 * Renames the one field every hmd-lineup `activity_log` writer uses that
 * Linyup's reader does not.
 *
 * ── THE BUG THIS RENAMES ────────────────────────────────────────────────────
 * Every hmd-lineup `logActivity(...)` call site — trackContacts/index.js,
 * trackBookings/index.js, trackSessionParticipants/index.js,
 * trackEventAttendees/index.js, verifyMembershipCode/index.js,
 * dailyTasks/tasks/anonymizeDeletedContacts.js, and both
 * dailyTasks/tasks/send*AutomationEmails.js — stamps the entry's timestamp
 * field as `date` (`admin.firestore.FieldValue.serverTimestamp()`), never
 * `created_at`. Linyup's `ActivityLogEntry` (packages/shared/src/types/
 * activityLog.ts) requires `created_at`, and its one reader —
 * useContactActivityLog in apps/web/src/app/[locale]/(auth)/contacts/[id]/
 * page.tsx:585-608 — both orders (`orderBy('created_at', 'desc')`) and, for
 * the day-limited view, filters (`where('created_at', '>=', …)`) on it.
 * Firestore's orderBy/where silently EXCLUDE any doc missing the field being
 * ordered/filtered on, so a raw copy makes a migrated contact's entire
 * historical activity feed invisible — not an error, just an empty tab.
 *
 * `event` and `refs.{contact,session,user}` are written under the same
 * names and shapes on both sides (confirmed against trackContacts.js,
 * trackBookings.js, trackEventAttendees.js) — not touched here. An `event`
 * value with no entry in the reader's EVENT_META map (e.g. hmd-lineup's
 * `event_checkin_add`/`event_checkin_delete`) already renders with a
 * graceful fallback icon (page.tsx:3377), so it is not a break worth a
 * mapping decision.
 */

import { ledgerExpiry } from '../../lib/ledgerExpiry'

export function transformActivityLogEntry(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src }

  if ('date' in out && !('created_at' in out)) {
    out.created_at = out.date
    delete out.date
  }

  // ── AND STAMP THE TTL ──────────────────────────────────────────────────────
  // hmd-lineup has no retention at all, so no source row carries `expires_at`,
  // and a row without it is never touched by a TTL policy — a migrated studio's
  // whole history would sit in the ledger forever while a new studio's aged out
  // at eighteen months. Stamped here rather than in a pass afterwards because a
  // migration is re-runnable: repairing the rows later is work the next run
  // throws away. See scripts/lib/ledgerExpiry.ts.
  //
  // Counted from the row's OWN date (after the rename above), so a 2019 entry
  // expires as if the policy had always existed. A row with no usable date is
  // counted from now — the same fallback scripts/backfill-ledger-ttl.ts uses,
  // because the alternative is leaving it immortal.
  if (!('expires_at' in out)) {
    out.expires_at = ledgerExpiry('activity_log', asDate(out.created_at) ?? new Date())
  }

  return out
}

/** A Firestore Timestamp, a Date, or an ISO string — whatever the source held. */
function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    const d = (v as { toDate: () => Date }).toDate()
    return Number.isFinite(d.getTime()) ? d : null
  }
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isFinite(d.getTime()) ? d : null
  }
  return null
}
