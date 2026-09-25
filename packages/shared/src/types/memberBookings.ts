// The contract of `getMyBookings` — the signed-in contact's own upcoming
// bookings, as the member portal renders them.
//
// It lives in `@linyup/shared` because BOTH ends of the wire are in this repo
// and the failure this callable exists to fix was a silent mismatch between
// them: the Space listed the team's public session mirrors with
// `type == 'session'`, appointments are mirrored as `type == 'appointment_session'`,
// so a member holding a paid appointment was told "You have no upcoming
// bookings." A shape both sides compile against is the cheapest guard there is
// against the next version of that.
//
// Everything here is already the caller's own data — her booking, on a session
// she is in. `cancelToken` is the `booking_token` from HER booking document,
// which she was also mailed; it is the credential `cancelBooking` takes, and it
// is returned ONLY when canceling is actually still allowed (see `cancellable`).

/** Which scheduling primitive this booking sits on — `Session.activityType`.
 *  A class is a seat in a scheduled event; an appointment is a provider's
 *  exclusive time, and is the kind the member surface must name a provider for. */
export type MyBookingKind = 'class' | 'appointment'

/** One upcoming booking of the signed-in contact. Times are ISO-8601 strings
 *  (a callable response is JSON — a Firestore Timestamp does not survive it). */
export interface MyBooking {
  /** The session the booking is on. Unique per contact: a booking document's id
   *  IS the contactId, so one contact holds at most one booking per session —
   *  which is what makes this a safe React key and a safe merge key for paging. */
  sessionId: string
  kind: MyBookingKind
  activityName: string | null
  start: string | null
  end: string | null
  location: string | null
  /** Set for online sessions (appointments carry it today). */
  onlineUrl: string | null
  /** The coach/provider. Always shown for an appointment — it is the one thing
   *  that distinguishes two otherwise identical slots. */
  providerName: string | null
  /** The booking document's own status (`pending` / `confirmed` / …), or null
   *  when it carries none — an absent status reads as pending everywhere. */
  status: string | null
  /**
   * Is `cancelBooking` still going to accept this? Resolved server-side against
   * the SAME rules that callable applies (a live token, a session that has not
   * started, a status the session's auto-confirm setting still treats as
   * cancelable) so the button is never offered for a call that will refuse.
   */
  cancellable: boolean
  /** The `booking_token` for `cancelBooking`, or null when `cancellable` is false. */
  cancelToken: string | null
  /** The studio called this session off (either cancellation shape — a status
   *  flip, or a canceled occurrence of a recurring series). The row stays
   *  visible, because a class silently disappearing from her list is exactly
   *  the sort of thing she would read as "my booking was lost". */
  sessionCancelled: boolean
  /** What canceling this one would give back — see `BookingCancelEffect`. It
   *  travels with the row so the member reads it BEFORE she presses, which is
   *  the only moment the answer can change her mind. */
  cancelEffect: BookingCancelEffect
}

export interface MyBookingsResult {
  /** Upcoming only, soonest first. */
  bookings: MyBooking[]
  /**
   * Continue the walk back through her reservation history, or null when the
   * server reached the end of it.
   *
   * The scan is bounded by HER OWN most recently made reservations, never by
   * the team's volume — a busy studio cannot push her bookings out of view.
   * The value is the `joinedAt` of the last document scanned, in epoch ms, and
   * the next page is INCLUSIVE of it: re-reading one boundary document is much
   * cheaper than skipping one when two reservations share a millisecond.
   * Callers must therefore de-duplicate by `sessionId` when merging pages, and
   * must stop when a page returns the cursor they sent.
   */
  cursor: number | null
  /** How many of her booking documents this call actually read. The client does
   *  not render it; it exists so the cost of this surface is observable. */
  scanned: number
}

// ─── Canceling: what actually comes back, and why a refusal is final ────────
//
// `cancelBooking` is the authority for both, and the copy on every surface has
// to say what IT does rather than what a cancellation usually does elsewhere:
//
//  • A spent LESSON CREDIT is put back on the pack. Unconditionally — there is
//    no cancellation window, and it is returned even if the pack has expired in
//    the meantime ("the swimmer paid for a lesson they now didn't take").
//  • A USAGE-LIMITED plan's window unit is put back the same way, against the
//    ORIGINAL window, so a cancellation after the window rolled over is
//    harmless rather than a free extra booking.
//  • MONEY IS NEVER RETURNED. `cancelBooking` issues no refund and creates no
//    refund request: a paid drop-in, a paid appointment and a gift-card-paid
//    seat all release the seat and leave the payment standing, for the studio to
//    settle. Copy that implies otherwise would be the same defect as promising a
//    price nobody has to pay.
//
// The studio's own `cancellationPolicy` prose is a separate thing and NOTHING
// ENFORCES IT (see components/booking/BookingTerms.tsx) — never restate it as
// if the product applied it.

/** What canceling this booking gives back. Every field is a statement about
 *  what the server WILL do (on `getBookingDetails`) or DID do (on the
 *  `cancelBooking` response) — never a guess made on the client. */
export interface BookingCancelEffect {
  /** A lesson credit returns to the contact's pack. */
  credit: boolean
  /** A usage-limited plan's window unit is freed ("up to 3 classes per week"). */
  usageUnit: boolean
  /** The booking was PAID for (card or gift card). Canceling does not refund
   *  it — the money stays with the studio until the studio acts. */
  paid: boolean
}

export const NO_CANCEL_EFFECT: BookingCancelEffect = {
  credit: false,
  usageUnit: false,
  paid: false,
}

/**
 * Why `cancelBooking` refused — carried as `HttpsError.details.reason`, so the
 * client can state what happened instead of showing a raw English server
 * sentence under a "try again" it should not offer.
 *
 * EVERY member of this union is PERMANENT: pressing the button again cannot
 * change any of them. That is the whole point of the type — the failure it
 * replaces was a generic retry prompt on a refusal that was already final,
 * which teaches a member that the button is broken rather than that the answer
 * is no. Anything NOT carrying a reason (a network drop, an internal error) is
 * the transient case, and is the only case a retry belongs on.
 */
export type BookingCancelRefusal =
  /** No booking matches this token — canceled already, or the link is dead. */
  | 'not_found'
  /** The booking is there; its session is gone. */
  | 'session_gone'
  /** Already canceled, or the studio has checked this person in. */
  | 'already_settled'
  /** The session has already started. */
  | 'past'

export interface BookingCancelRefusalDetails {
  reason: BookingCancelRefusal
}

/** Narrow an `HttpsError.details` bag off the wire. Returns null for the
 *  transient case (no reason ⇒ retrying is legitimate). */
export function parseBookingCancelRefusal(details: unknown): BookingCancelRefusal | null {
  if (typeof details !== 'object' || details === null) return null
  const reason = (details as { reason?: unknown }).reason
  const known: BookingCancelRefusal[] = ['not_found', 'session_gone', 'already_settled', 'past']
  return typeof reason === 'string' && (known as string[]).includes(reason)
    ? (reason as BookingCancelRefusal)
    : null
}

/** The `cancelBooking` response. */
export interface CancelBookingResult {
  success: true
  /** English, for logs — never rendered. The surfaces translate. */
  message: string
  rebookUrl: string | null
  /** What this cancellation actually gave back. */
  returned: BookingCancelEffect
}
