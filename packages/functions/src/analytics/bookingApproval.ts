/**
 * Does a newly created booking need somebody to approve it?
 *
 * Its own module so it can be tested without loading `analytics/index.ts`,
 * which defines triggers at import time. The one caller is `trackBookings`,
 * which writes the `booking_pending` notification when this says yes.
 *
 * ── PENDING IS THE ABSENT VALUE, NOT THE STRING ──────────────────────────────
 *
 * `bookSession` writes `status: 'confirmed'` when the class auto-confirms and
 * writes NO status field otherwise. So a seat that really is waiting for a
 * human carries no `status` at all, `status === 'pending'` is false for almost
 * every one of them, and a Firestore `where('status','==','pending')` would
 * match nearly none while looking like a working query — the same shape as the
 * `teams where archived_at == null` trap in CLAUDE.md. Every reader in the web
 * app already spells this `(b.status ?? 'pending')`; this is that spelling,
 * server-side.
 *
 * ── WHAT IS DELIBERATELY NOT AN APPROVAL ─────────────────────────────────────
 *
 * A WAITLIST CLAIM is not a booking somebody made. A promoted entry holds its
 * seat as an ordinary booking (docs/waitlist.md → the hold IS a booking), so it
 * arrives looking like one; nobody approves it, the claim window decides it.
 *
 * A STAFF-ENTERED SEAT never notifies: the person who would read it is the
 * person who just typed it in.
 *
 * A PAID-APPOINTMENT HOLD never reaches here at all — `trackBookings` returns
 * before this on a `pending_payment` session, which is its own lifecycle.
 */
export function bookingCallsForApproval(booking: Record<string, unknown>): boolean {
  if (booking.waitlist_claim === true) return false
  if (booking.source === 'staff') return false
  return ((booking.status as string | undefined) ?? 'pending') === 'pending'
}
