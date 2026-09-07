import type { Timestamp } from './common'
import type { BookingWaiverState } from './waiver'

/** Has a paid-booking hold lapsed? A 'pending_payment' session whose
 *  `hold_expires_at` has passed no longer blocks its slot — readers treat it as
 *  free (lazy expiry) until the daily sweep flips it to 'cancelled'. */
export function isExpiredAppointmentHold(
  s: { status?: string; hold_expires_at?: { toMillis(): number } | null },
  nowMs = Date.now()
): boolean {
  return s.status === 'pending_payment' && !!s.hold_expires_at && s.hold_expires_at.toMillis() <= nowMs
}

/** THE slot-blocking predicate for appointment scheduling — the single source of
 *  truth for "does this session make the provider busy?". Used by
 *  listAvailability's busy filter, both branches of the booking transaction
 *  (deterministic-id reuse + overlap range loop), and the admin calendar. */
export function appointmentSlotBlocked(
  s: { status?: string; hold_expires_at?: { toMillis(): number } | null },
  nowMs = Date.now()
): boolean {
  return s.status !== 'cancelled' && !isExpiredAppointmentHold(s, nowMs)
}

/** Has a waitlist CLAIM lapsed? An offered seat is held for the claimant only
 *  until `claim_expires_at`; past that the seat is logically free again (lazy
 *  expiry, same shape as isExpiredAppointmentHold) until the offer sweeper
 *  rolls it on to the next person.
 *
 *  Asks about the DEADLINE only. Never use it alone to decide whether a seat is
 *  free: a claim that was taken up keeps its seat past this instant, and pairing
 *  it with `isUnclaimedClaimHold` is what says so (see bookingHoldsSeat).
 *
 *  Inert until bookings carry `waitlist_claim` — it lands with its siblings so
 *  the waitlist adds a FIELD rather than a fourth predicate somewhere else. */
export function isExpiredWaitlistClaim(
  b: { waitlist_claim?: boolean; claim_expires_at?: { toMillis(): number } | null },
  nowMs = Date.now()
): boolean {
  return b.waitlist_claim === true && !!b.claim_expires_at && b.claim_expires_at.toMillis() <= nowMs
}

/** The booking fields the seat predicates read. Nothing else is needed to
 *  decide whether a document occupies a seat, so a caller can hand over a raw
 *  `DocumentData` without narrowing it first. */
export interface SeatHold {
  status?: string
  payment_status?: string
  expires_at?: { toMillis(): number } | null
  waitlist_claim?: boolean
  claim_expires_at?: { toMillis(): number } | null
}

/** THE capacity predicate for bookings — the single source of truth for "does
 *  this booking occupy a seat right now?". Used by trackBookings' recount and
 *  by every capacity gate that has to decide whether a session is really full.
 *
 *  A lapsed UNPAID hold (`payment_status: 'required'` past `expires_at`) is the
 *  reason this exists: an abandoned drop-in checkout used to keep its seat in
 *  `bookings_count` until the 02:00 sweep, so the next customer was refused on
 *  a session that had a free seat. Counting it as free here makes both the
 *  recount and the gate agree, without waiting for the sweep.
 *
 *  A lapsed waitlist CLAIM is the same story, with one hard qualification: the
 *  deadline only releases a seat while the offer is still an UNCLAIMED hold
 *  (isUnclaimedClaimHold). A claim that was taken up is an ordinary booking —
 *  confirmed, or paid with money or stored value — and it keeps its seat
 *  forever, even if the document still carries `waitlist_claim` because whoever
 *  confirmed it forgot to clear the flag. Testing `isExpiredWaitlistClaim`
 *  alone made a settled attendee stop holding their seat at `claim_expires_at`,
 *  so the recount freed it and the promoter offered it again: eleven people,
 *  ten seats.
 *
 *  An ABSENT status is pending and still holds a seat. */
export function bookingHoldsSeat(b: SeatHold, nowMs = Date.now()): boolean {
  if (b.status && NON_HOLDING_BOOKING_STATUSES.has(b.status)) return false
  if (b.payment_status === 'required' && !!b.expires_at && b.expires_at.toMillis() <= nowMs) {
    return false
  }
  if (isUnclaimedClaimHold(b) && isExpiredWaitlistClaim(b, nowMs)) return false
  return true
}

/** 'rebooked' means the seat moved to ANOTHER session — it is not held here. */
const NON_HOLDING_BOOKING_STATUSES = new Set(['cancelled', 'no_show', 'rebooked'])

/** Live seat count over a session's `bookings` subcollection — the ONE way a
 *  capacity gate turns documents into a number. Takes raw snapshot docs so a
 *  transaction read can be passed straight in.
 *
 *  `nowMs` is sampled ONCE by the caller and threaded through: re-reading the
 *  clock per document could count a hold as live at the top of a pass and
 *  expired at the bottom, and the number a gate refuses on is the same number
 *  it is about to persist.
 *
 *  `excludeId` drops the caller's own booking, whose document every gate is
 *  about to REPLACE — a returning buyer re-opening an abandoned checkout, a
 *  webhook confirming the hold it created. Counting it would refuse them the
 *  seat they are already holding. */
export function countHoldingSeats(
  docs: Array<{ id: string; data(): unknown }>,
  nowMs: number = Date.now(),
  excludeId?: string
): number {
  return docs.reduce(
    (n, d) =>
      d.id !== excludeId && bookingHoldsSeat(d.data() as SeatHold, nowMs) ? n + 1 : n,
    0
  )
}

/** Seats still open. `Infinity` when the session carries no cap — an unlimited
 *  class is never full, and `Infinity > 0` keeps the caller's arithmetic honest
 *  without a special case at every gate. A cap of 0 or less reads as ABSENT,
 *  matching how `max_participants` has always been interpreted. */
export function seatsFree(maxParticipants: number | null | undefined, holding: number): number {
  if (typeof maxParticipants !== 'number' || maxParticipants <= 0) return Infinity
  return maxParticipants - holding
}

/** The session fields the seat-freed edge reads — a `before`/`after` pair from
 *  an onDocumentWritten payload, narrowed to nothing but capacity and life. */
export interface SeatCounts {
  max_participants?: number | null
  bookings_count?: number
  status?: string
}

/** Did this write FREE A SEAT? — the edge the waitlist promoter hangs on, and
 *  the only thing its trigger inspects. True exactly when a session went from
 *  full (or oversold) to having room, which is where every seat-releasing event
 *  converges: a cancellation, a no-show flip, a rebooking out, a released hold,
 *  a raised cap. All of them land as a write to the session document — either
 *  the writer's own absolute count or `trackBookings`' recount — which is why
 *  the promoter watches the document instead of being wired into six call sites.
 *
 *  Being an EDGE is what makes the promoter loop-safe: the promotion transaction
 *  writes the session document and so re-fires the trigger, but on that second
 *  pass the seats are taken and `before` is no longer full, so it terminates.
 *  The corollary is binding — a handler on this edge must NOT write the session
 *  document on any path where it decides not to promote, or a "harmless" touch
 *  re-enters it forever.
 *
 *  An uncapped session never produces the edge (it was never full), and neither
 *  does a cancelled one (there is no seat to hand on). */
export function seatFreedEdge(
  before: SeatCounts | null | undefined,
  after: SeatCounts | null | undefined
): boolean {
  if (!before || !after) return false
  if (after.status === 'cancelled') return false
  return (
    seatsFree(before.max_participants, before.bookings_count ?? 0) <= 0 &&
    seatsFree(after.max_participants, after.bookings_count ?? 0) > 0
  )
}

/** Is this booking still the UNTAKEN hold a waitlist offer created? THE question
 *  every release path has to answer before deleting a booking: an offer that was
 *  taken up in the meantime is an ordinary booking — confirmed, or paid with
 *  money or stored value — and deleting it would destroy a seat somebody has
 *  already paid for, then hand that seat to the next person in the queue.
 *
 *  Anything already RESOLVED (cancelled, no_show, rebooked) is equally not a
 *  hold: its seat has been accounted for by whoever resolved it, and deleting it
 *  a second time would decrement the same person's pending-booking counter
 *  twice. Only a still-pending claim qualifies.
 *
 *  Deliberately clock-free. Whether the offer LAPSED is a separate question
 *  (isExpiredWaitlistClaim); this one asks only whether the seat is still
 *  unsettled, so a sweep that selected a lapsed offer and a `leaveWaitlist` that
 *  releases a live one apply the identical guard. */
export function isUnclaimedClaimHold(b: SeatHold | null | undefined): boolean {
  if (!b || b.waitlist_claim !== true) return false
  if (b.status && b.status !== 'pending') return false
  return !bookingWasPaidFor(b)
}

/** Did this seat cost its holder something? — money (`'paid'`, the Connect
 *  webhook's confirm) or stored value (`'gift_card'`, the full-cover rail).
 *
 *  The two markers are named together because the answer must never depend on
 *  WHICH tender settled a booking: a gift-card seat is as bought as a card one.
 *  Read by the release predicates above (a paid seat is never a hold to
 *  destroy) and by the session-cancellation notice, which is sent to a paying
 *  attendee even when the studio switched that notice off — nobody who paid
 *  should turn up to a class that is not happening. */
export function bookingWasPaidFor(b: SeatHold | null | undefined): boolean {
  return b?.payment_status === 'paid' || b?.payment_status === 'gift_card'
}

/**
 * Is an ONLINE payment arriving for an already-confirmed APPOINTMENT a SECOND
 * payment for it?
 *
 * An appointment is exclusive time: one booking per slot, by definition. So a
 * confirmed booking meeting a Stripe payment is either a redelivery of the
 * charge that confirmed it, or money taken twice for one thing.
 *
 * The id comparison answers that whenever the booking records WHICH payment
 * bought it. The second arm is the case that has no id to compare: a link-mode
 * hold settled AT THE DESK (`markAppointmentPaid`) is confirmed and paid for,
 * but by cash — there is no `payment_intent_id`, and without this arm a client
 * who later opens the emailed link is charged for an appointment they have
 * already paid for, and the studio's books count it twice. That settlement
 * expires the link first, so this is the net under a close that failed or a hold
 * written before the session id was stored; see appointments/staffBooking.ts.
 *
 * DELIBERATELY NOT `!bookingWasPaidFor(...)`-shaped: a confirmed booking with no
 * payment marker at all is an ordinary free or staff-confirmed appointment
 * (`createStaffAppointment`'s free and `pending_offline` rails both write one),
 * and refunding a payment against those would refund the FIRST payment they
 * ever received. Only an explicit offline settlement claims the slot is bought.
 */
export function appointmentChargeIsDuplicate(b: {
  /** The PaymentIntent the confirmed booking already carries, if any. */
  payment_intent_id?: string | null
  /** Settled at the desk — see `Booking.settled_offline`. */
  settled_offline?: boolean
  /** The PaymentIntent that has just arrived. */
  incomingPaymentIntentId?: string | null
}): boolean {
  if (!b.incomingPaymentIntentId) return false
  const existing = b.payment_intent_id ?? null
  if (existing) return existing !== b.incomingPaymentIntentId
  return b.settled_offline === true
}

/** Is this seat actually TAKEN UP — is the person in the class?
 *
 *  Holding a seat and being in the class are not the same question, and a
 *  release path has to ask the second one. `bookingHoldsSeat` is true for a live
 *  UNPAID hold (`payment_status: 'required'` before `expires_at`), because that
 *  hold really does occupy the seat while it lasts — but its owner has settled
 *  nothing, and treating it as "they got in another way" marks their queue entry
 *  `claimed` and swallows the "your offer lapsed" mail for someone who then
 *  abandons the checkout.
 *
 *  A CONFIRMED booking is in the class whatever its payment markers say: a coach
 *  confirming someone at the door is the studio deciding they are in, and a
 *  stranded `payment_status` must not demote that.
 *
 *  Everything else that holds a seat is settled by construction — a free
 *  booking, a paid one, a gift-card cover — so only the unsettled pending hold
 *  is carved out. */
export function bookingSeatTakenUp(b: SeatHold | null | undefined, nowMs = Date.now()): boolean {
  if (!b || !bookingHoldsSeat(b, nowMs)) return false
  return b.status === 'confirmed' || b.payment_status !== 'required'
}

/**
 * Every hold marker that must come OFF a booking when a claim settles.
 *
 * A settle is an `update`, not a full replace, so whatever the document was
 * carrying survives unless it is named here — and by then it may be carrying a
 * SECOND hold's markers. The path is ordinary: a claimant opens the pay screen
 * (`createDropInCheckout` rewrites the hold with `payment_status: 'required'` +
 * `expires_at`), abandons Stripe, then settles some other way — they acquire
 * coverage and re-open the claim link, or a coach simply confirms them at the
 * door.
 *
 * Clearing only the two claim fields there costs the seat twice over:
 * `bookingHoldsSeat` frees it at `expires_at` (recount → `seatFreedEdge` → the
 * promoter hands a confirmed person's seat to the next in the queue — eleven
 * bookings on ten seats), and `releaseExpiredBookingHolds` matches the same
 * `payment_status`/`expires_at` pair on its collection group and HARD-DELETES a
 * confirmed, covered booking.
 *
 * The list is exactly what the full-replace writers already produce implicitly —
 * the promoter's `.set()`, the gift-card full cover, the Connect webhook's
 * confirm (which sets `payment_status: 'paid'` instead, money having moved).
 *
 * It lives in `@linyup/shared` rather than in the waitlist module because the
 * settle paths are on BOTH sides of the wire: the free claim and the two
 * check-in callables are server-side, while the studio's bookings list and
 * session detail page confirm a booking with a client write. One list, or they
 * drift.
 */
export const CLAIM_HOLD_FIELDS = [
  'waitlist_claim',
  'claim_expires_at',
  'payment_status',
  'expires_at',
] as const

export type ClaimHoldField = (typeof CLAIM_HOLD_FIELDS)[number]

/** The settle patch, built from `CLAIM_HOLD_FIELDS`. Takes the delete sentinel
 *  rather than importing one, so this module stays free of both Firebase SDKs
 *  (`FieldValue.delete()` on the server, `deleteField()` in the browser) and a
 *  test can apply the same patch with a plain `undefined` — which behaves like
 *  an absent field for every predicate that reads these four. */
export function clearedClaimHoldFields<D>(deleteSentinel: D): Record<ClaimHoldField, D> {
  // `fromEntries` widens the key back to `string`; the entries come from the
  // literal tuple above, so the narrowing is a restatement, not an assumption.
  return Object.fromEntries(CLAIM_HOLD_FIELDS.map((field) => [field, deleteSentinel])) as Record<
    ClaimHoldField,
    D
  >
}

/** A claim hold whose payment never settled — the shape the waitlist introduced
 *  and the only one a staff confirm has to clear more than the claim fields
 *  from. `payment_status: 'required'` WITHOUT `waitlist_claim` is an ordinary
 *  abandoned drop-in hold, which has always survived a confirm untouched;
 *  whether confirming should waive somebody's payment is a product question and
 *  is deliberately not answered here. */
export function isUnsettledPaidClaimHold(b: SeatHold | null | undefined): boolean {
  return b?.waitlist_claim === true && b.payment_status === 'required'
}

/**
 * The hold markers a STAFF confirm must clear, for THIS booking.
 *
 * Confirming turns a booking into an ordinary seat, so the claim fields always
 * go: a leftover `waitlist_claim` hides the person from `sendBookingReminders`
 * forever, and deleting an absent field is a no-op on every non-waitlist
 * booking. A claim hold that was mid-payment additionally carries the drop-in
 * hold's own markers, and those are the ones that quietly kill the seat — see
 * `CLAIM_HOLD_FIELDS`.
 *
 * One function, called by all four confirm surfaces (the bookings list, session
 * detail, `checkInContact`, `selfCheckIn`), so they cannot settle a booking into
 * four different document shapes.
 */
export function confirmClearedHoldFields<D>(
  booking: SeatHold | null | undefined,
  deleteSentinel: D
): Partial<Record<ClaimHoldField, D>> {
  if (isUnsettledPaidClaimHold(booking)) return clearedClaimHoldFields(deleteSentinel)
  return { waitlist_claim: deleteSentinel, claim_expires_at: deleteSentinel }
}

// ─── the attendance row ───────────────────────────────────────────────────────

/**
 * WHO put this person in the room. Free-text was written at five call sites and
 * two of them wrote nothing at all, so a roster could not say how someone got
 * there.
 */
export type ParticipantSource =
  /** A staff confirm of an existing booking (bookings list or session detail). */
  | 'booking-confirm'
  /** A manager added a known contact to the class by hand. */
  | 'manual'
  /** Coach scanned the member's QR (`checkInContact`). */
  | 'qr-scan'
  /** Member scanned the room's kiosk QR (`selfCheckIn`). */
  | 'self-scan'
  /** Written by a seeding script, never by the product. */
  | 'seed'
  /**
   * Carried over from hmd-lineup, where attendance was a row's EXISTENCE and
   * carried no timestamp of its own. Those rows are stamped with the session's
   * start — the class is when the attendance happened — so a roster can say the
   * time is reconstructed rather than recorded.
   */
  | 'migration'

export interface ParticipantIdentity {
  firstname?: string | null
  lastname?: string | null
  avatar_url?: string | null
}

/**
 * THE ATTENDANCE ROW — one shape, one builder.
 *
 * **The document id IS the contact id.** Every reader already assumes it —
 * `scoreComputation` does `participants.doc(contactId)`, the waitlist join and
 * the booking dedupe both test `participants.doc(contactId).exists`, and
 * `trackSessionParticipants` recounts by it. Two writers used to disagree (the
 * bookings list keyed the row by the BOOKING id, which is the contact id only by
 * convention), so the invariant is enforced here instead of remembered.
 *
 * The `contact` field is the same value, denormalised for readers holding the
 * snapshot rather than the ref. `contactId` is written ALONGSIDE it because the
 * seed scripts have always written that spelling and one trigger read it — see
 * `trackSessionParticipants`, which now resolves the id from the document id
 * first and treats both fields as fallbacks.
 *
 * `fullname` is `lastname firstname`, matching the roster sort and the printed
 * manifest. The bookings list wrote it the other way round, which is why the
 * same person sorted into two different places depending on which page had
 * confirmed them.
 *
 * Callers pass their own server-timestamp sentinel (`serverTimestamp()` in the
 * browser, `FieldValue.serverTimestamp()` on the server) so this stays free of
 * any Firebase import.
 */
export function buildParticipantDoc<TS>(params: {
  contactId: string
  sessionId: string
  who: ParticipantIdentity
  checkedInBy: ParticipantSource
  checkedInAt: TS
  /** True when this row exists because a booking was confirmed, which is what
   *  the roster shows a "confirmed from booking" caption for. */
  fromBooking?: boolean
}): Record<string, unknown> {
  const firstname = params.who.firstname ?? ''
  const lastname = params.who.lastname ?? ''
  return {
    contact: params.contactId,
    contactId: params.contactId,
    session: params.sessionId,
    firstname,
    lastname,
    fullname: `${lastname} ${firstname}`.trim(),
    avatar_url: params.who.avatar_url ?? null,
    checkedInAt: params.checkedInAt,
    checkedInBy: params.checkedInBy,
    ...(params.fromBooking ? { confirmedFromBooking: true } : {}),
  }
}

/**
 * The id of the contact a booking belongs to.
 *
 * Server-created bookings are keyed BY the contact id (every `.doc(contactId)`
 * in `packages/functions/src/booking`), and they also carry it in `contact`. A
 * confirm surface must land the attendance row on that id and not on the
 * booking's own — they are the same value today, and the day they are not is the
 * day one person occupies two roster rows.
 */
export function bookingContactId(booking: { id: string; contact?: string | null }): string {
  return booking.contact || booking.id
}

/** Has the online booking cutoff passed for this session? `cutoffMinutes` is
 *  how long before start online booking closes (0/absent = no cutoff — bookable
 *  right up to start). Shared by the client (hide/disable slots) and the
 *  booking callables (authoritative refusal) so they never disagree. */
export function isPastBookingCutoff(
  sessionStart: { toMillis(): number },
  cutoffMinutes: number | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!cutoffMinutes || cutoffMinutes <= 0) return false
  return nowMs >= sessionStart.toMillis() - cutoffMinutes * 60_000
}

/**
 * Is this scheduled item OVER?
 *
 * ONE PREDICATE, because there were six divergent inline copies of this question
 * across the app and they did not agree with each other. The public site and the
 * public weekly calendar tested `(end ?? start)`; the schedule's own
 * upcoming/past tab tests `start` alone; three more surfaces each rolled their
 * own. That is fine while the answer only dims a card, and not fine the moment
 * it is used to warn somebody they are editing history.
 *
 * THE RULE IS `(end ?? start) < now` — an item is past when it has FINISHED, not
 * when it has begun. A class that started twenty minutes ago is in progress, and
 * telling a coach mid-session that they are editing something in the past is
 * both wrong and the kind of wrong that teaches people to ignore the warning.
 * `end` is optional across older documents, hence the fallback.
 *
 * NOT a booking gate — `isPastBookingCutoff` above answers whether booking has
 * closed, which happens on its own schedule and usually earlier.
 */
export function isPastSession(
  item: { start?: { toMillis(): number } | null; end?: { toMillis(): number } | null },
  nowMs: number = Date.now()
): boolean {
  const finish = item.end ?? item.start
  if (!finish) return false
  return finish.toMillis() < nowMs
}

export interface Session {
  id: string
  teamId: string
  activityId?: string
  activityName?: string
  /** Denormalised from the linked Activity.type — 'class' | 'appointment'. Default class. */
  activityType?: string
  start: Timestamp
  end: Timestamp
  duration_minutes?: number
  location?: string
  // Optional link to a Place + Room (team or org place). `location` is kept as a
  // free-text fallback (online/ad-hoc) and for display.
  placeId?: string
  roomId?: string
  onlineUrl?: string
  tags?: string[]
  participants_count?: number
  allowBooking?: boolean
  notes?: string
  created_at?: Timestamp
  createdBy?: string
  // ── Recurring session fields ──
  seriesId?: string
  isException?: boolean
  exceptionType?: 'modified' | 'cancelled' | null
  /** UID of the person who runs this session — class instructor or appointment
   *  provider (picked from the team's coach roster). Replaces the former
   *  instructorId/coachId split. */
  providerId?: string
  /** Denormalised display name of the provider. */
  providerName?: string
  /** When booking is allowed, mark it as required (no drop-ins) — surfaces a
   *  "Booking required" chip in the public booking flow. Class-only in UI. */
  bookingMandatory?: boolean
  /** A note pinned to this specific occurrence ("Marta subbing today", "outdoor
   *  — bring a jacket"). Internal by default; set `headlinePublic` to also show
   *  it on the public slot list, the confirmation email, and the reminder.
   *  Distinct from `notes`, which is always internal-only. */
  headline?: string
  /** When true, `headline` is mirrored onto the session's public_profile and
   *  surfaced to bookers. Absent/false ⇒ staff-only, same as `notes`. */
  headlinePublic?: boolean
  // ── Booking state — BOTH kinds. Not implied by activityType. ──
  /** Hard booking cap (seats for a class, 1 for a typical 1:1 appointment). */
  max_participants?: number
  /** Bookings currently HOLDING CAPACITY — i.e. every booking whose status is
   *  neither 'cancelled' nor 'no_show' (an absent status = pending = holds a
   *  seat). One counter for classes and appointments alike; `trackBookings` is
   *  the authoritative recount and self-heals races.
   *
   *  ONE WRITING STYLE, deliberately: an ABSOLUTE value, written either by
   *  `trackBookings`' recount or from inside a transaction that read the
   *  `bookings` subcollection in the same read set (countHoldingSeats). There
   *  is NO `FieldValue.increment` on this field anywhere — a blind increment
   *  and an absolute write cannot be ordered against each other, so the two
   *  styles used to interleave and leave a class one seat over or under. Add a
   *  new writer only in that shape.
   *  History: classes used to count into a separate `bio_link_bookings_count`
   *  while appointments used this one — merged 2026-07. */
  bookings_count?: number
  /** How many people are WAITING in this session's queue (`status: 'waiting'`
   *  entries — an offered/claimed/expired/left entry does not count). Written
   *  absolutely, only from inside a transaction that read the queue, for the
   *  same reason as `bookings_count`.
   *
   *  There is deliberately NO `waitlist_enabled` on the session, and nothing may
   *  add one: the flag lives on `Activity.waitlistEnabled` and its public
   *  mirror, exactly like `trialEnabled`. A session-level copy would need an
   *  activity→sessions fan-out (only `onActivityTypeChange` does that, and only
   *  for `type`) plus a backfill for every session that already exists, and it
   *  would drift the moment either failed. The promoter already reads the
   *  booking settings for `cutoffMinutes`, so one more activity read on a path
   *  that runs only when a seat frees costs nothing. */
  waitlist_count?: number
  /** Capacity state, derived from bookings_count vs max_participants (plus
   *  explicit cancellation). Treat an ABSENT value as 'open' — a session that
   *  nobody has booked yet may not carry one.
   *  'pending_payment' (appointments only) = a paid-booking HOLD: the slot is
   *  reserved while the client completes Stripe checkout. Blocks the slot while
   *  live, is logically free once `hold_expires_at` passes (lazy expiry — see
   *  appointmentSlotBlocked), is never published publicly, and is skipped by the
   *  trackBookings recount (the checkout/webhook/sweeper own its lifecycle). */
  status?: 'open' | 'full' | 'cancelled' | 'pending_payment'
  /** When a 'pending_payment' hold stops blocking the slot (created +30 min).
   *  Deleted when the webhook confirms payment. */
  hold_expires_at?: Timestamp | null
  /** Denormalised from Activity.autoConfirm. When true a booking is written
   *  `status: 'confirmed'` immediately (the client's slot is theirs); when false
   *  it stays unconfirmed until the studio confirms/checks them in. Defaults by
   *  kind (appointments true, classes false) but is a FIELD, not a type rule —
   *  a class may auto-confirm and an appointment may require approval. */
  autoConfirm?: boolean
  // ── Appointment-specific fields (only populated when activityType === 'appointment') ──
  /** Back-link to the availability doc this appointment was booked from. */
  templateId?: string
  /** Subset of bookings_count where is_new_contact === true. */
  trial_bookings_count?: number
  /** Legacy free-trial flag. Superseded by the activity's `accessRule`. */
  isFreeTrial?: boolean
  // ── Staff "phone booking" fields (appointments/staffBooking.ts) — a manager
  // creates the appointment directly, settled offline or via a Stripe Connect
  // payment link, distinct from the public checkout's own 'pending_payment'
  // hold (which carries `hold_expires_at` instead). ──
  /** True while a manager-created hold (offline or payment-link) awaits
   *  payment. Deleted once markAppointmentPaid / the Connect webhook confirms. */
  payment_pending?: boolean
  /** How a `payment_pending` hold will be settled: 'offline' (cash/bank
   *  transfer, confirmed via markAppointmentPaid) or 'link' (Stripe Connect
   *  checkout link emailed to the client, confirmed by the Connect webhook). */
  payment_intent_mode?: 'offline' | 'link'
  /** The amount owed for a `payment_pending` hold, in MINOR units (Rappen/cents). */
  payment_amount?: number
  payment_currency?: string
  /** The Stripe Checkout Session backing a `payment_intent_mode: 'link'` hold.
   *
   *  Stored so the link can be CLOSED, not merely watched. A link-mode hold is
   *  the one rail whose deadline lives entirely at Stripe (7 days, no
   *  `hold_expires_at`, no sweep), so settling it any other way — the client
   *  paid cash at the door — has to be able to prove the link can no longer take
   *  money. `markAppointmentPaid` expires it through `closeTeamCheckoutSession`
   *  before recording the cash; without this id there is nothing to expire and
   *  the only protection left is the late-payment refund in
   *  `handleAppointmentCheckout`. Deleted once the hold is settled. */
  payment_checkout_session_id?: string | null
  /** True for a manager's calendar block (no client) — see appointments/staffBooking.ts. */
  blocked_time?: boolean
  /** Denormalised booking contact so list views (e.g. the Payments page) can
   *  render a client name/link without an N+1 read into the bookings
   *  subcollection. Null for a `blocked_time` session. */
  contact_id?: string | null
  /** Denormalised "firstname lastname" (or the block's note) for display —
   *  same rationale as `contact_id`. */
  client_name?: string | null
}

export interface SessionPublicProfile {
  teamId: string
  activityId?: string
  activityName?: string
  activityType?: string
  start: Timestamp
  end: Timestamp
  allowBooking: boolean
  /** Booking is required for this session (no drop-ins) — drives the public chip. */
  bookingMandatory?: boolean
  /** Mirrored from `Session.headline` ONLY when `headlinePublic === true`. */
  headline?: string
  location?: string
  onlineUrl?: string
  /** UID + display name of the provider (class instructor or appointment provider). */
  providerId?: string
  providerName?: string
  locationAddress?: string
  locationMapsUrl?: string
  activitySlug?: string
  activityColor?: string
  activityImage?: string | null
  activityIsFreeTrial?: boolean
  // Appointment-specific public fields
  max_participants?: number
  bookings_count?: number
  isFreeTrial?: boolean
  templateId?: string
  status?: 'open' | 'full' | 'cancelled'
  /** CLASS branch only. How many people are waiting — an aggregate, never an
   *  identity; the queue itself is never public. The public form derives "full"
   *  arithmetically from `max_participants` vs `bookings_count` (the class
   *  mirror carries no `status`, and must not start carrying one), so this is
   *  the only field a "12 waiting" chip needs. */
  waitlist_count?: number
}

export interface Participant {
  contactId: string
  teamId: string
  checked_in_at: Timestamp
  checked_in_by?: string
}

/** Where a booking came from — the attribution axis.
 *  - 'online' → the visitor booked themselves on a public surface (booking
 *    page, appointment picker, Space). The default.
 *  - 'kiosk'  → taken at the door on the studio's own tablet (walk-in).
 *  - 'staff'  → entered by a team member on the client's behalf.
 *  Absent ⇒ treat as 'online' (bookings written before this field existed came
 *  from the public flow, which was the only writer). */
export type BookingSource = 'online' | 'kiosk' | 'staff'

export const BOOKING_SOURCES: readonly BookingSource[] = ['online', 'kiosk', 'staff']

/** Narrow an untrusted value to a BookingSource, else null. Used by the
 *  callables to validate client-supplied attribution. */
export function parseBookingSource(v: unknown): BookingSource | null {
  return typeof v === 'string' && (BOOKING_SOURCES as readonly string[]).includes(v)
    ? (v as BookingSource)
    : null
}

export interface Booking {
  id: string
  teamId: string
  contact: string
  session?: string
  email: string
  firstname: string
  lastname: string
  phone?: string
  is_new_contact: boolean
  joinedAt: Timestamp
  booking_token?: string
  /** Short human-readable code (e.g. "BK-7F3K9Q") for phone/desk lookups — never
   *  the auth mechanism (booking_token is). Not guaranteed collision-free. */
  booking_reference?: string
  /** Attribution — see `BookingSource`. Absent ⇒ 'online'. */
  source?: BookingSource
  /** Answers to the activity's `bookingQuestions`, keyed by FormField.id.
   *  Stored verbatim as given; the questions themselves live on the activity,
   *  so a label edit doesn't rewrite history — an answer whose field id no
   *  longer exists is simply not rendered. */
  question_answers?: Record<string, unknown>
  status?: 'pending' | 'confirmed' | 'cancelled' | 'no_show' | 'rebooked'
  rebooked_from?: string
  rebooked_to?: string
  // Drop-in payment (pay-per-class). A pending booking awaiting payment carries
  // payment_status 'required' + an expires_at hold; the Connect webhook flips it to
  // 'paid' + status 'confirmed'. Free bookings leave these unset.
  payment_status?: 'not_required' | 'required' | 'paid'
  payment_intent_id?: string
  /** The seat was settled AT THE DESK, not through Stripe — `markAppointmentPaid`
   *  recording cash against a hold that was awaiting an online payment.
   *
   *  It rides ALONGSIDE `payment_status: 'paid'` rather than replacing it,
   *  because the seat really was paid for and `bookingWasPaidFor` must keep
   *  saying so. What it adds is the one thing that value cannot: a confirmed
   *  booking carrying no `payment_intent_id` is normally a booking nobody
   *  charged, so the Connect webhook's duplicate guard (which compares the
   *  stored PaymentIntent against the incoming one) has nothing to compare and
   *  keeps a late online payment for a seat already paid for in cash. This flag
   *  is what turns that into a refund. See `handleAppointmentCheckout`. */
  settled_offline?: boolean
  expires_at?: Timestamp
  // Waitlist claim hold. A promoted waitlist entry reserves its seat as an
  // ORDINARY booking carrying these two fields rather than as a new kind of
  // object, so `bookingHoldsSeat`, the capacity gates, the duplicate guards and
  // the recount all understand it without a line of new code. Both are DELETED
  // when the claim is taken up — from that moment it is a normal booking.
  /** True while this booking is a seat held for a waitlist offer nobody has
   *  claimed yet. */
  waitlist_claim?: boolean
  /** THE single deadline of a claim: the booking hold expires, the offer
   *  expires, and (for a paid claim) the Stripe session expires all at this one
   *  instant. Mirrored onto the entry as `offer_expires_at` — two copies of one
   *  computed value, never two computations. */
  claim_expires_at?: Timestamp
  /** Provenance, kept after the two fields above are deleted: this seat came
   *  from the queue rather than from the booking page. Never read by a gate —
   *  it is for the manifest, the day sheet and anyone asking where a booking
   *  came from. */
  claimed_from_waitlist?: boolean
  /** Waiver state AT COMMIT, denormalised for the day sheet and the printed
   *  manifest so neither has to read a signer row per attendee. Never read for
   *  a decision, and ABSENT means "no required waiver applied" — see
   *  `BookingWaiverState` for why the roster must render nothing for that. */
  waiver_state?: BookingWaiverState
}

/** The lifecycle of one queue entry. 'offered' is the only status that owns a
 *  claim hold; 'claimed' | 'expired' | 'left' are terminal.
 *
 *  An entry is offered ONCE, ever. A lapsed offer is terminal ('expired') and
 *  the person re-joins if they still want the class — which writes a fresh
 *  `joined_at` and puts them at the tail for free. That is why there is no
 *  offer counter, no re-queue ordering key and no "max offers" setting. */
export const WAITLIST_STATUSES = ['waiting', 'offered', 'claimed', 'expired', 'left'] as const
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]

/** One person's place in a class queue — `sessions/{sessionId}/waitlist/{contactId}`.
 *
 *  The doc id IS the contactId, exactly mirroring `sessions/{id}/bookings/{contactId}`:
 *  dedupe is free, the rules mirror the bookings block, and the promotion
 *  transaction gets one session's whole queue in a single read.
 *
 *  CLASS-ONLY. An appointment session does not exist until it is booked, so
 *  "this session is full" has no meaning there — the analogous feature is a
 *  waitlist on an availability WINDOW, which is a different primitive.
 *
 *  Written only by Cloud Functions; every client write is denied by the rules. */
export interface WaitlistEntry {
  /** = contactId. */
  id: string
  teamId: string
  /** sessionId, denormalised — the collection-group sweeps need it inline. */
  session: string
  /** contactId, denormalised (same value as the doc id). */
  contact: string
  /** The session's start, denormalised: the ONLY way a collection-group sweep
   *  finds entries left on sessions that have already run, without a join. */
  session_start: Timestamp
  // Denormalised identity: the offer notification needs no contact read, and the
  // admin queue list and the day sheet render straight from the entry.
  firstname: string
  lastname: string
  email: string
  phone?: string | null
  /** THE ordering key — `joined_at ASC` is the queue, always. Immutable, and
   *  there is no stored position: a position is derived at read time, so a
   *  departure ahead of you never has to rewrite every entry behind it. */
  joined_at: Timestamp
  status: WaitlistStatus
  /** Long-lived: "check my place" / "leave the waitlist". Deliberately NOT the
   *  claim credential — a forwarded join-confirmation email must not let anyone
   *  take the seat. */
  entry_token: string
  /** Minted per offer, SINGLE USE, deleted the moment the offer resolves in any
   *  direction. This is the claim credential. */
  offer_token?: string
  offered_at?: Timestamp
  /** The SAME instant as the claim hold's `claim_expires_at`. */
  offer_expires_at?: Timestamp
  /** Attribution — where the join came from. See `BookingSource`. */
  source?: BookingSource
  /** Answers to the activity's `bookingQuestions`, captured at JOIN so the claim
   *  never re-asks them. Narrowed with `sanitizeBookingAnswers`, same as a
   *  booking's. */
  question_answers?: Record<string, unknown>
  left_at?: Timestamp
  expired_at?: Timestamp
  claimed_at?: Timestamp
}

export interface SessionSeries {
  id: string
  teamId: string
  activityId?: string
  recurrence: RecurrencePattern
  created_at: Timestamp
  createdBy: string
}

export interface RecurrencePattern {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[]
  dayOfMonth?: number
  monthOfYear?: number
  duration: number
  startDate: Timestamp
  endCondition: 'date' | 'count' | 'never'
  endDate?: Timestamp
  maxOccurrences?: number
}
