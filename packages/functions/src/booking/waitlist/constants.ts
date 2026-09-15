// The waitlist's numbers and the pure arithmetic around them. No Firestore, so
// the two decisions that actually matter — how long a claim stays claimable, and
// how long a queue may get — are unit-tested (see waitlistMath.test.ts) instead
// of being re-derived at each call site. The rate-limit bucket names live here
// too, so the surfaces that must NOT share a quota can be seen side by side.
//
// The one import is a TYPE, erased at compile time: this file stays loadable
// with nothing but the standard library behind it, which is what lets the tests
// be plain unit tests.

import type { SendOutcome } from '../../mail/mailService'

/** Joining is the one waitlist action an anonymous visitor can repeat, and every
 *  join can create a contact — so it is charged per IP up front, like a
 *  checkout. Its OWN bucket, because sharing the checkout counter would mean a
 *  burst of people queueing for a popular class from one gym's NAT locks that
 *  address out of paying for anything. */
export const WAITLIST_RATE_LIMIT_BUCKET = 'waitlist-join'

/**
 * The token-authenticated surfaces (claim, status view, leave) get a bucket of
 * their own, and it is charged very differently — see
 * `assertUnderCheckoutRateLimit`.
 *
 * They must NOT share the join bucket: the people queueing for a class and the
 * one person holding an offer for it are behind the same gym NAT by
 * construction, so a busy queue would make an offered seat un-claimable — and
 * an offer is a one-shot, time-boxed entitlement that nobody gets twice.
 */
export const WAITLIST_CLAIM_RATE_LIMIT_BUCKET = 'waitlist-claim'

/** A claim needs a usable window or it is not worth offering: an offer with ten
 *  minutes on it is a seat taken off the day sheet that nobody can reach in
 *  time. 35 leaves margin over the 31-minute Stripe floor below, so a claimant
 *  who opens the mail promptly can still reach checkout for a PAID class — one
 *  window for free and paid alike, because a queue that behaves differently
 *  depending on price is a queue nobody can explain. Below this the seat is
 *  simply not offered: it shows as free on the day sheet and the walk-in door
 *  can take it, which is the right outcome for a seat that frees ten minutes
 *  before class. */
export const WAITLIST_MIN_WINDOW_MINUTES = 35

/** Ceiling on how many seats one promotion pass may offer. A capacity raise from
 *  10 to 40 with a long queue would otherwise write 30 booking holds, 30 entry
 *  flips and 30 contact updates in a single transaction. The backstop pass picks
 *  up the remainder. */
export const WAITLIST_MAX_OFFERS_PER_RUN = 10

/** Default `bookingSettings.waitlistClaimMinutes` (public_profile) — two hours is long
 *  enough for someone to see the mail over a lunch break and short enough that a
 *  seat freed the evening before a class still rolls on to the next person. */
export const WAITLIST_DEFAULT_CLAIM_MINUTES = 120

// A queue is bounded, because joining is the one waitlist action an anonymous
// visitor can repeat and every join can create a contact. Twice the seats is
// past the point where anyone at the back realistically gets in; the floor keeps
// a tiny class from having a queue of two.
export const WAITLIST_MAX_QUEUE_MULTIPLIER = 2
export const WAITLIST_MIN_QUEUE_CAP = 20

/** How many queue documents one promotion transaction reads. Comfortably above
 *  any real queue — the cap below bounds the WAITING entries, and live offers
 *  can never exceed the session's seats — so this is a runaway guard, not a
 *  paging limit. It is deliberately generous: truncating would understate
 *  `waitlist_count`, and that number is on the public mirror. */
export const WAITLIST_QUEUE_SCAN_LIMIT = 200

/** How many entries ONE hourly sweep pass reads. A ceiling, not a page: the
 *  passes are ordered by deadline / session start, so a run that hits it drains
 *  the most urgent work first and the remainder waits an hour. Raise it before
 *  reaching for paging — a partial pass is correct, a half-paged one is not. */
export const WAITLIST_SWEEP_SCAN_LIMIT = 500

/**
 * Did an offer mail actually reach anybody?
 *
 * Here rather than in `notify.ts` for the same reason the claim window is: it is
 * a decision, not a line of plumbing, and getting it backwards is expensive in
 * both directions — release the seat of somebody who WAS mailed and they lose a
 * place they could have claimed; keep the seat of somebody who was not and it
 * expires in silence. Pure, so it is unit-tested.
 *
 * `sendEmail` reports a non-delivery by RETURNING, not by throwing: a suppressed
 * address (an earlier hard bounce), a tenant messaging policy of `silent` or
 * `allowlist`, a synthetic seed address, `MAIL_ENABLED=false` — all
 * `{ skipped: true }`. The one `skipped` that IS a delivery carries a
 * `providerMessageId`, because that is the idempotency ledger reporting a send
 * that already went out (see mail/mailService.ts).
 */
export function offerWasDelivered(outcome: SendOutcome): boolean {
  return !outcome.skipped || !!outcome.providerMessageId
}

// The settled claim-hold shape — `CLAIM_HOLD_FIELDS`, `clearedClaimHoldFields`
// and `confirmClearedHoldFields` — lives in `@linyup/shared` (types/session.ts)
// beside the seat predicates that read those fields. It is NOT here because
// half the settle paths are client writes: the studio's bookings list and
// session detail page confirm a booking from the browser, and they cannot
// import from `packages/functions`. One list, or the shapes drift.

/**
 * A class is called off in one of TWO shapes, and every waitlist path has to
 * know both.
 *
 * `status: 'cancelled'` is the appointment/standalone form. A cancelled
 * occurrence of a recurring series is different — `cancelSession` writes
 * `isException` + `exceptionType: 'cancelled'` and leaves `allowBooking` and
 * `status` exactly as they were (see sessions/index.ts, `markAsException`), so a
 * status-only test reads a called-off class as bookable. `rebookSession` already
 * tests the pair; the queue would otherwise take joins for, and offer seats on,
 * a class that will never run.
 *
 * The predicate now lives in `@linyup/shared` (utils/sessionStatus.ts), so the
 * public API's session projection asks the same question; re-exported here so
 * every waitlist import keeps working.
 */
export { isSessionCancelled } from '@linyup/shared'

/** How many people may WAIT for one session. Offered/claimed/expired/left
 *  entries do not count — only the live queue is capped, so a class whose queue
 *  keeps rolling never wedges.
 *
 *  CLAMPED TO THE SCAN LIMIT, because the cap is enforced by counting the
 *  `waiting` entries the join transaction reads, and that read is itself capped
 *  at WAITLIST_QUEUE_SCAN_LIMIT. Unclamped, any class with more than
 *  `SCAN_LIMIT / MULTIPLIER` seats got a cap the observed count could never
 *  reach: the check silently stopped binding, and `waitlist_count` — derived
 *  from the same read — froze at the scan limit on the session and its public
 *  mirror. Raising the scan limit raises the real ceiling; changing this
 *  multiplier alone cannot. */
export function waitlistQueueCap(maxParticipants: number | null | undefined): number {
  const seats = typeof maxParticipants === 'number' && maxParticipants > 0 ? maxParticipants : 0
  const wanted = Math.max(seats * WAITLIST_MAX_QUEUE_MULTIPLIER, WAITLIST_MIN_QUEUE_CAP)
  return Math.min(wanted, WAITLIST_QUEUE_SCAN_LIMIT)
}

export interface OfferHeadSelection<T> {
  /** Who to offer to, in queue order. */
  heads: T[]
  /** Candidates skipped because their CONTACT document is gone. Terminal, and
   *  reported rather than silently dropped: the caller closes them out in the
   *  same transaction, which is what stops them being re-picked forever. */
  dropped: T[]
}

/**
 * Who one promotion pass offers to, in queue order.
 *
 * `candidates` are the entries that are still waiting AND do not already hold a
 * seat. That second half carries more weight than it looks: an offer REPLACES
 * the contact's booking document, so offering to somebody who got into the class
 * another way since joining would overwrite their confirmed — possibly paid —
 * booking with an unclaimed hold, and the next sweep would then delete it.
 *
 * `hasContact` reports whether the entry's contact document still exists, and
 * THE ORDER IT IS APPLIED IN IS THE POINT: it filters the queue BEFORE the head
 * is taken, never after. Filtering afterwards meant a single dead entry at the
 * front wedged the whole queue — with one seat freeing (the ordinary case) the
 * pass selected the corpse, found nothing to offer, and returned without a
 * write, so every trigger and every hourly backstop re-picked the same entry and
 * everybody behind it waited for the life of the class. A contact really does
 * disappear: `purgeProvisionalContacts` HARD-deletes provisional contacts, and a
 * shop registrant who joins a queue is exactly that.
 *
 * A PINNED run (the admin's "Offer now") returns exactly one head, and only if
 * that person survived the same filters as everyone else — including this one,
 * so "Offer now" on a deleted contact still reports a failure rather than
 * writing a hold nobody owns. Pinning skips the queue ORDER; it must never skip
 * a safety check.
 */
export function selectOfferHeads<T extends { id: string }>(
  candidates: readonly T[],
  room: number,
  pinnedContactId?: string | null,
  hasContact: (candidate: T) => boolean = () => true
): OfferHeadSelection<T> {
  if (room <= 0) return { heads: [], dropped: [] }
  const live: T[] = []
  const dropped: T[] = []
  for (const candidate of candidates) {
    if (hasContact(candidate)) live.push(candidate)
    else dropped.push(candidate)
  }
  if (pinnedContactId) {
    const head = live.find((c) => c.id === pinnedContactId)
    return { heads: head ? [head] : [], dropped }
  }
  return { heads: live.slice(0, room), dropped }
}

export interface ClaimWindow {
  /** THE deadline. The booking hold's `expires_at`, the entry's
   *  `offer_expires_at` and (for a paid claim) the Stripe session's `expires_at`
   *  are all this one instant — three timers collapsed into one, so no two jobs
   *  can ever disagree about when a claim died. */
  expiresAtMs: number
  /** Minutes of window left from `nowMs`, which is what every floor is tested
   *  against — the offer floor here, and the Stripe floor at checkout. */
  minutesLeft: number
  /** Worth offering at all. */
  offerable: boolean
}

/**
 * The claim window for one offer, clamped by everything that can close it.
 *
 * `claimStartMs` is the next instant the studio may text (see
 * `nextSmsWindowOpen`) — anchoring the START to it, rather than deferring the
 * whole offer, is what stops a seat freed at 23:10 sitting dark until morning:
 * the offer is minted and mailed immediately at any hour, and only the window
 * runs 08:00–10:00. For a 07:00 class the next morning, the cutoff clamp below
 * shortens it past the floor and no offer is made at all.
 *
 * The booking cutoff is a hard clamp, not advice: an offer that outlived it
 * would hand someone a claim their own booking callables then refuse.
 */
export function resolveClaimWindow(input: {
  nowMs: number
  claimStartMs: number
  sessionStartMs: number
  cutoffMinutes?: number | null
  claimMinutes?: number | null
}): ClaimWindow {
  const claimMinutes =
    typeof input.claimMinutes === 'number' && input.claimMinutes > 0
      ? input.claimMinutes
      : WAITLIST_DEFAULT_CLAIM_MINUTES
  const cutoffAtMs =
    typeof input.cutoffMinutes === 'number' && input.cutoffMinutes > 0
      ? input.sessionStartMs - input.cutoffMinutes * 60_000
      : input.sessionStartMs

  const expiresAtMs = Math.min(
    input.claimStartMs + claimMinutes * 60_000,
    cutoffAtMs,
    input.sessionStartMs
  )
  const minutesLeft = (expiresAtMs - input.nowMs) / 60_000
  return { expiresAtMs, minutesLeft, offerable: minutesLeft >= WAITLIST_MIN_WINDOW_MINUTES }
}

export interface ClaimCheckoutWindow {
  /** False ⇒ refuse with `claim_window_too_short`. Below Stripe's own floor a
   *  Checkout Session cannot be created at all, and creating a LONGER one would
   *  be worse: it would still be payable after the seat had rolled on. */
  payable: boolean
  /** Stripe's `expires_at`, in epoch SECONDS. */
  expiresAtEpochSeconds: number
}

/**
 * The paid claim's third timer, reconciled with the other two.
 *
 * A claim has ONE deadline: the booking hold, the queue entry's
 * `offer_expires_at` and the Stripe session all die at `claimExpiresAtMs`. Two
 * bounds shape what Stripe will accept for that instant — `minMinutes` (its
 * 30-minute floor, 31 here for clock skew) and `maxMinutes` (its 24-hour
 * ceiling). Both are passed in rather than imported so this file stays pure.
 *
 * Clamping DOWN at the ceiling is the safe direction and the only one available:
 * a checkout that dies before the hold costs the payer a fresh click, while one
 * that outlives it sells a seat that has already gone to the next person.
 */
export function resolveClaimCheckoutWindow(input: {
  nowMs: number
  claimExpiresAtMs: number
  minMinutes: number
  maxMinutes: number
}): ClaimCheckoutWindow {
  const minutesLeft = (input.claimExpiresAtMs - input.nowMs) / 60_000
  const expiresAtMs = Math.min(input.claimExpiresAtMs, input.nowMs + input.maxMinutes * 60_000)
  return {
    payable: minutesLeft >= input.minMinutes,
    expiresAtEpochSeconds: Math.floor(expiresAtMs / 1000),
  }
}
