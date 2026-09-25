// ─── The dashboard queue's SEEN record (teams/{teamId}/queue_seen/current) ───
//
// "Waiting on you" splits into three tabs, each carrying a count and a dot that
// says SOMETHING HERE IS NEW SINCE YOU LOOKED. This is what the dot is measured
// against.
//
// ─── WHY KEYS AND NOT A DATE ─────────────────────────────────────────────────
//
// The obvious design is a last-seen timestamp per tab, and it is wrong here,
// because half of what the card shows is not an event. `contactAttentionReasons`
// splits cleanly in two:
//
//   event-backed   alerts · pending_signup · trial_pending · new_lead ·
//                  canceling
//   time-derived   gone_quiet · checkin_lapsed  (and goal_overdue, partly)
//
// A member goes quiet because a clock ticked, not because anybody wrote
// anything — the same reason `docs/contact-state-model.md` gives for dynamic
// groups existing at all. There is no `created_at` to compare a stamp against,
// so a timestamp model can never light the dot for them, and the tab that most
// needs a nudge is the one that would never get one.
//
// So the record is the SET OF ITEMS the studio has already been shown. New =
// what is in the queue now, minus what is in here. That answers every reason
// identically, without asking any of them when they became true.
//
// ─── IT PRUNES ITSELF, WHICH IS WHY IT CANNOT GROW ───────────────────────────
//
// An acknowledgement REPLACES a tab's keys with exactly what is on screen — it
// never appends. So an item that has left the queue is forgotten, and if it
// comes back it is new again, which is the honest answer: a member who went
// quiet, was seen, came back and went quiet again is news the second time too.
// The set is therefore bounded by the queue itself, not by history.
//
// ─── TEAM-WIDE, DELIBERATELY ─────────────────────────────────────────────────
//
// One document, no per-user state — the model `types/teamNotification.ts`
// already encodes for the bell ("one manager clearing an item clears it for the
// studio"). The cost is real and is the point of writing it down: THE FIRST
// MANAGER TO ACKNOWLEDGE CLEARS THE DOT FOR EVERYONE. A studio that wants per
// person would need a second model, and the notification header is the argument
// against having two.

import type { Timestamp } from './common'

/** The card's tabs, in the order they render. */
export type DashboardQueueTab = 'bookings' | 'contacts' | 'other'

export const DASHBOARD_QUEUE_TABS: readonly DashboardQueueTab[] = ['bookings', 'contacts', 'other']

/**
 * A ceiling on one tab's stored keys, for the same reason
 * `UNREAD_NOTIFICATIONS_LIMIT` has one: a studio with more than this waiting on
 * it has a problem the dot cannot solve. Past the cap the newest keys are kept,
 * so the dot may re-light for an old item — visibly wrong in the safe
 * direction, rather than silently dropping the marker for a new one.
 */
export const QUEUE_SEEN_MAX_KEYS = 200

/** `teams/{teamId}/queue_seen/current`. Absent ⇒ nothing has been seen, which
 *  reads as "everything is new" — correct for a studio's first visit. */
export interface QueueSeenDoc {
  bookings?: string[]
  contacts?: string[]
  other?: string[]
  updated_at?: Timestamp | null
  updated_by?: string | null
}

// ─── The keys ────────────────────────────────────────────────────────────────
// Built HERE and nowhere else, so the writer and the reader cannot spell one
// differently — the whole mechanism is a set comparison, and a set comparison
// is only ever as good as its key.

/**
 * A booking.
 *
 * THE SESSION ID IS PART OF THE KEY AND MUST STAY. A booking document is
 * `sessions/{sessionId}/bookings/{contactId}` — the id is the CONTACT's, so one
 * member booking two classes produces two bookings with the SAME document id.
 * Keyed on the id alone, acknowledging one would silence the other.
 */
export function bookingQueueKey(sessionId: string, bookingId: string): string {
  return `booking:${sessionId}:${bookingId}`
}

/** A person, and WHY they are here — a new reason on a known member is a new
 *  item, because it is new work even though the person is not. */
export function contactQueueKey(contactId: string, reason: string): string {
  return `contact:${contactId}:${reason}`
}

/**
 * Housekeeping: `payments`, `setup`. One key per ROW, not per underlying item —
 * "3 payments to file" becoming 4 is not news, its first appearance is.
 *
 * THE ONE EDGE THIS LEAVES, stated rather than papered over: an acknowledgement
 * only ever rewrites the keys that are ON SCREEN, so a housekeeping row that
 * empties keeps its key in the record and does NOT light the dot again when it
 * returns. The count still moves. It is the Other tab, whose rows the panel
 * itself calls "exactly as urgent tomorrow", and the alternative — folding the
 * count into the key — would pulse at the studio every time a number changed,
 * which is the noise this design is avoiding.
 */
export function taskQueueKey(task: string): string {
  return `task:${task}`
}

/** The keys in `current` that are NOT in `seen`. Order follows `current`. */
export function unseenQueueKeys(current: readonly string[], seen: readonly string[] | undefined): string[] {
  if (!seen || seen.length === 0) return [...current]
  const known = new Set(seen)
  return current.filter((k) => !known.has(k))
}
