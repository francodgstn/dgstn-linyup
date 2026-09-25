---
title: Waitlist
description: Waitlist — architecture
status: living
area: booking
order: 5
---
# Waitlist

A waitlist is **a queue for a seat in a full class**. When a seat frees, the
oldest waiter is offered it and the seat is *held for them* until a deadline;
they claim it (free or by paying), or it rolls on to the next person.

**Class-only, and that is a modeling fact rather than a scoping choice.** An
appointment session does not exist until it is booked (`docs/appointments.md`),
so "this session is full" has no meaning there — one booking per slot is the
definition of exclusive time. The analogous feature would be a queue on an
availability *window*, which is a different primitive and is not built
(`docs/product-strategy.md`, "Slot waiting list"). `joinWaitlist` and
`offerWaitlistSeats` both refuse `activityType === 'appointment'`, and the
promotion trigger returns early on one — canceling an appointment produces the
seat-freed edge on every single one.

Everything lives in `packages/functions/src/booking/waitlist/`; the seat
predicates it hangs on live in `packages/shared/src/types/session.ts` beside
their appointment siblings.

## The data model

### The entry — `sessions/{sessionId}/waitlist/{contactId}`

The doc id **is** the contactId, exactly mirroring
`sessions/{id}/bookings/{contactId}`. Dedupe is then free (a double-click writes
the same document), the rules mirror the bookings block, and the promotion
transaction gets one session's whole queue in a single read.
`WaitlistEntry` is defined in `packages/shared/src/types/session.ts`;
`WAITLIST_SUBCOLLECTION` in `packages/shared/src/paths.ts`.

| Field | Why it exists |
|---|---|
| `teamId` | collection-group rules and `listMyWaitlist` |
| `session`, `session_start` | denormalised so a collection-group sweep finds entries on sessions that have already run, with no join back |
| `firstname` / `lastname` / `email` / `phone` | the offer mail, the admin queue list and the day sheet all render straight off the entry — no contact read |
| `joined_at` | **THE ordering key.** `joined_at ASC` is the queue, always. Immutable |
| `status` | see the lifecycle below |
| `entry_token`, `offer_token` | see "Two tokens" |
| `source` | attribution, `BookingSource` |
| `question_answers` | the activity's `bookingQuestions`, captured at JOIN so the claim never re-asks |
| `offered_at`, `offer_expires_at`, `claimed_at`, `expired_at`, `left_at` | timestamps of each transition |

**There is no stored position.** A position is derived at read time from
`joined_at ASC`, so somebody ahead of you leaving never has to rewrite every
entry behind them.

**An entry is offered ONCE, ever.** A lapsed offer is terminal (`expired`) and
the person re-joins if they still want the class — which writes a fresh
`joined_at` and puts them at the tail for free. That single decision deletes an
offer counter, a re-queue ordering key, a "max offers" setting and the whole
re-queue ordering problem.

### The status lifecycle

```
                     joinWaitlist
                          │
                          ▼
                      'waiting' ──────── leaveWaitlist / removeWaitlistEntry ──▶ 'left'
                          │                                                       (terminal)
     offerWaitlistSeats   │  (a seat frees, or "Offer now", or the backstop)
                          ▼
                      'offered'  ── claim settles (free, paid, or gift-card) ──▶ 'claimed'
                     (owns a claim                                               (terminal)
                      hold — a real
                      booking doc)
                          │
                          └─ window lapsed / left / class cancelled / class ran ─▶ 'expired'
                                                                                   (terminal)
```

`offered` is the only status that owns a claim hold. `claimed`, `expired` and
`left` are terminal — nothing transitions out of them, which is what makes every
release path idempotent: a redelivered sweep or a double-clicked "leave" link
finds a terminal entry and writes nothing.

### Two tokens, deliberately

Both come from `generateSecureToken()` (`packages/functions/src/utils/crypto.ts`),
the generator `booking_token` already uses.

| Token | Life | What it opens |
|---|---|---|
| `entry_token` | long-lived, minted at join, never rotated | the **status view** and "leave the waitlist" |
| `offer_token` | minted per offer, **SINGLE USE**, deleted the moment the offer resolves in any direction | **the claim credential** |

**`offer_token` is the credential; `entry_token` is not.** A join-confirmation
mail gets forwarded, and a forwarded mail must never hand someone else the seat.
Both are looked up by collection-group query, so both carry a `fieldOverrides`
entry in `firestore.index.json` (see "Rules and indexes").

A consequence worth knowing: because `offer_token` is deleted when the offer
resolves, "this offer expired" and "this offer was already claimed" are
**indistinguishable** from a bare claim link — and must be, or the credential
would outlive its own offer. `getWaitlistEntry` and `claimWaitlistSeat` both say
so; the long-lived entry link is where a person finds out which it was.
`getWaitlistEntry` also returns `wasOffered` (derived from `offered_at`, which no
closing path deletes) so the page can tell "your offer ran out" from "the queue
closed without ever reaching you" — both are stored as `expired`.

### The claim hold is a booking, not a new object

An offer reserves its seat as an ordinary `sessions/{id}/bookings/{contactId}`
document with `status: 'pending'` plus two fields (`Booking` in
`packages/shared/src/types/session.ts`):

- `waitlist_claim: true` — this seat is held for an unclaimed offer;
- `claim_expires_at` — **the** deadline (below).

Both are **deleted** when the claim settles; a third field,
`claimed_from_waitlist`, survives as provenance for the manifest and the day
sheet and is never read by a gate.

This is the design's cheapest decision. `bookingHoldsSeat` already counts the
hold, so every capacity gate, every duplicate guard and `trackBookings`' recount
stop selling that seat without a line of new code, and no other subsystem has to
learn what a waitlist is.

### The flags and settings

| Where | Field | Notes |
|---|---|---|
| `Activity` | `waitlistEnabled?: boolean` | class-only; mirrored to `activities/{id}/public_profile/{id}` by `syncActivityPublicProfile` under the same conditional spread as `trialEnabled` |
| `Session` | `waitlist_count?: number` | how many are **waiting**; written absolutely, only from a transaction that read the queue |
| `SessionPublicProfile` | `waitlist_count` | **class branch only** (`syncSessionPublicProfile`). An aggregate, never an identity — the queue is never public |
| `bookingSettings` (on `teams/{id}/public_profile/{id}`) | `waitlistClaimMinutes` | default 120, read next to `cutoffMinutes`; THE booking-settings store — see `packages/functions/src/booking/bookingSettings.ts` |

**There is deliberately NO `waitlist_enabled` on the session, and nothing may add
one.** A session-level copy would need an activity→sessions fan-out (only
`sync/onActivityTypeChange.ts` does that, and only for `type`) plus a backfill
for every session that already exists, and it would drift the moment either
failed. The promoter already reads the booking settings for `cutoffMinutes`, so
one more activity read on a path that runs only when a seat frees costs nothing. The
doc comment on `Session.waitlist_count` says this too, so nobody re-adds it.

### A guest with no account

Same shape as `bookSession`'s guest path — exact match on
`teamId + email + lowercased firstname/lastname`, else create. A waitlist-born
contact differs in three ways from a trial-booking one:

- `entry: 'waitlist'`;
- `provisional: true` **with** `provisional_expires_at = session.start + 30 days`,
  so an abandoned queue entry is reaped by `purgeProvisionalContacts` (which
  re-checks the flag at delete time, so a claim that confirms them makes them
  permanent);
- **no `acquisition_stage`.** Joining a queue is not a trial booking; stamping
  `'trial_booked'` on someone who may never get a seat would report a funnel
  entry that never happened. The stamp lands at claim.

An email address is **required**, even for a signed-in contact: a place in a
queue is only ever redeemed by mail. A contact with no `email` on their record
falls back to the address in their verified session token (the per-contact
login-email allow-list case — a parent on a child's profile) before being
refused with `reason: 'email_required'`.

## The single-deadline rule

> **A claim has exactly ONE deadline.** The hold's `claim_expires_at`, the
> entry's `offer_expires_at` and — for a paid claim — the booking hold's
> `expires_at` and the Stripe Checkout Session's `expires_at` are all the same
> instant.

`expires_at` is qualified for the same reason the Stripe timer is: the free-path
hold `offerWaitlistSeats` writes carries `claim_expires_at` and **no
`expires_at` at all**. The drop-in hold's markers (`payment_status: 'required'`
+ `expires_at`) appear only when the claimant goes to checkout through
`createDropInCheckout`, which sets `expires_at` to that same instant.

It is computed once, by `resolveClaimWindow`
(`booking/waitlist/constants.ts`, pure and unit-tested in `waitlistMath.test.ts`),
and copied — never recomputed:

```
cutoffAt         = session.start − cutoffMinutes         (absent cutoff ⇒ session.start)
claimStart       = nextSmsWindowOpen(now)                (utils/sms.ts)
claim_expires_at = min(claimStart + waitlistClaimMinutes, cutoffAt, session.start)

OFFER only if    claim_expires_at − now >= WAITLIST_MIN_WINDOW_MINUTES        (35)
CHECKOUT only if claim_expires_at − now >= SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES (31)
```

`HOLD_MINUTES` — the ordinary 30-minute drop-in hold — **does not apply to a
claim at all** (`booking/dropIn.ts` takes `claim?.expiresAt ?? now + HOLD_MINUTES`).

**Why 35 and 31.** Stripe's Checkout Session minimum is 30 minutes from creation
and 31 is this codebase's already-chosen safe floor for clock skew
(`SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES`, `connect/checkout.ts`). 35 leaves margin
so a claimant who opens the mail promptly can still reach checkout for a *paid*
class — one window for free and paid alike, because a queue that behaves
differently depending on price is a queue nobody can explain. Below 35 the seat
is simply **not offered**: it shows as free on the day sheet and the walk-in door
can take it, which is the right owner for a seat that frees ten minutes before
class. `resolveClaimCheckoutWindow` additionally clamps *down* at Stripe's
24-hour ceiling — the safe direction, since a checkout that dies before the hold
costs a click while one that outlives it sells a seat that has already gone.

**Why the window's START is anchored to the SMS window and the mail is not.**
`sendBookingReminders` handles quiet hours by *deferring*. Deferring a claim
offer is not deferral, it is expiry. So the offer is minted and the **email sent
immediately at any hour**, and only the window's start is anchored to the next
SMS-sending instant: a seat freed at 23:10 for a class the next evening gets its
mail now and a window that opens at 08:00. For a 07:00 class the next morning,
`cutoffAt` clamps the window under the floor and no offer is made.

### What breaks if the deadlines diverge

Each of these was a real hazard in the design, and each is closed by the one
instant rather than by a guard:

- **Stripe outliving the hold.** The hold frees its seat, someone else takes it,
  and the original buyer pays hours later. `handleDropInCheckout` *must* confirm
  a real charge, so the class ends up oversold and the payer holds a seat that no
  longer exists. (The webhook's capacity re-check + refund is the backstop for
  the residual race, not the design.)
- **The entry outliving the hold.** The entry still says `offered` while the
  booking has stopped holding a seat — the promoter re-offers it while the first
  person's claim link still works. Two people, one seat.
- **The hold outliving the entry.** The seat is held but unclaimable: a dead seat
  on the day sheet until a sweep tidies it.
- **Two jobs disagreeing about "when".** `expirePendingBookings` (02:00) and
  `sweepWaitlistOffers` (hourly) both act on lapsed claims — but
  `expirePendingBookings` reaches only the **paid** one. Its query is
  `payment_status == 'required' && expires_at <= now`, and a free-path claim hold
  carries neither field, so the sweep is that hold's only reaper. Where the two
  do meet, `expires_at === claim_expires_at`, so the delete is idempotent and the
  entry transition is re-derived from the booking's state: the outcome is the
  same whichever ran first. **No exclusion was added to `expirePendingBookings`,
  and none should be** — that would make it a second owner of the same decision.

## The seat predicates

`bookingHoldsSeat` is **THE** capacity predicate. Every gate, the recount, the
promoter and every release path call it; **nothing may re-derive it.** It lives
in `packages/shared/src/types/session.ts` with a family of companions, and the
distinctions between them are the part that four rounds of review kept getting
wrong. They are different questions, not variations on one:

| Predicate | The question it answers | Clock? | Read by |
|---|---|---|---|
| `bookingHoldsSeat(b, nowMs)` | Does this document **occupy a seat right now**? | yes | every capacity gate, `countHoldingSeats`, `trackBookings`' recount, `healSessionSeatCount` |
| `isExpiredWaitlistClaim(b, nowMs)` | Has the claim **deadline** passed? | yes | only inside `bookingHoldsSeat` |
| `isUnclaimedClaimHold(b)` | Is this still the **untaken hold** an offer created? | **no** | every release path, `claimWaitlistSeat`'s in-transaction guard, and the day sheet (`useDaySheet`: `activeBookings`' roster filter and `heldOfferSeats`' count) |
| `bookingSeatTakenUp(b, nowMs)` | Is this person **in the class**? | yes | `releaseWaitlistOffer`'s self-heal branch |
| `seatsFree(max, holding)` | Seats still open (`Infinity` when uncapped) | — | every gate |
| `countHoldingSeats(docs, nowMs, excludeId?)` | Turn a bookings snapshot into a number | — | every gate |
| `seatFreedEdge(before, after)` | Did this session write **free a seat**? | — | the promotion trigger, and nothing else |

Four distinctions are load-bearing:

1. **`bookingHoldsSeat` tests the deadline only while the hold is unclaimed.**
   `isExpiredWaitlistClaim && isUnclaimedClaimHold`, not the deadline alone. A
   claim that was taken up is an ordinary booking and keeps its seat forever,
   even if the document still carries `waitlist_claim` because some writer forgot
   to clear it. Testing the deadline alone made a settled attendee stop holding
   their seat at `claim_expires_at`, so the recount freed it and the promoter
   offered it again: eleven people, ten seats.
2. **`isUnclaimedClaimHold` is deliberately clock-free.** Whether the offer
   *lapsed* is a separate question, so a sweep that selected a lapsed offer and a
   `leaveWaitlist` that releases a live one apply the identical guard. It also
   rejects anything already resolved (`cancelled` / `no_show` / `rebooked`) —
   deleting one of those a second time would decrement the same person's pending
   counter twice.
3. **`bookingSeatTakenUp` is narrower than `bookingHoldsSeat`, on purpose.** A
   live *unpaid* drop-in hold occupies the seat while it lasts but puts nobody in
   the class; calling it "claimed" swallows the "your offer lapsed" mail for
   somebody who then never pays. Conversely a `confirmed` booking is in the class
   whatever its payment markers say — a coach confirming someone at the door is
   the studio deciding they are in.
4. **`seatFreedEdge` is an EDGE, and that is what makes the promoter loop-safe.**
   The promotion transaction writes the session document and re-fires its own
   trigger; on the second pass the seats are taken, `before` is no longer full,
   and it terminates. The corollary is binding: **a handler on this edge must not
   write the session document on any path where it decides not to promote.** The
   promoter's clean-up of dead entries writes ENTRIES only for exactly this
   reason, and `healSessionSeatCount` writes nothing when nothing moved.

### Clearing the hold markers — one list, both sides of the wire

A settle is an `update`, not a full replace, so whatever the booking is carrying
survives unless it is named — and by then it may be carrying a *second* hold's
markers (a claimant opened the pay screen, which rewrites the hold with
`payment_status: 'required'` + `expires_at`, then settled some other way).
Clearing only the two claim fields costs the seat twice over: `bookingHoldsSeat`
frees it at `expires_at`, and `releaseExpiredBookingHolds`
(`dailyTasks/expirePendingBookings.ts`) hard-deletes a confirmed, covered
booking.

- `CLAIM_HOLD_FIELDS` = `waitlist_claim`, `claim_expires_at`, `payment_status`,
  `expires_at` — what the full-replace writers (the promoter's `.set()`, the
  gift-card full cover, the Connect webhook's confirm) already produce implicitly.
- `clearedClaimHoldFields(deleteSentinel)` builds the patch. It takes the sentinel
  rather than importing one, so the module stays free of both Firebase SDKs.
- `confirmClearedHoldFields(booking, sentinel)` is what a **staff confirm** uses:
  the two claim fields always, plus the drop-in hold's markers when the booking is
  an unsettled paid claim (`isUnsettledPaidClaimHold`). All four confirm surfaces
  call it — the bookings list, session detail, `checkInContact`, `selfCheckIn` —
  so they cannot settle a booking into four different shapes.

They live in `@linyup/shared` and not in the waitlist module because half the
settle paths are **client** writes.

## One writer for `bookings_count`

> On a **class** session, `bookings_count` is written as an **ABSOLUTE value**,
> either by `trackBookings`' recount or from inside a transaction that read the
> session's `bookings` subcollection in the same read set. **There is no
> `FieldValue.increment` on this field anywhere.**

A blind increment and an absolute write cannot be ordered against each other. The
two styles used to interleave: `createDropInCheckout` wrote the hold (firing the
recount) and the webhook then added `increment(1)` on top, so a filling class read
one seat over and refused a real customer. The waitlist is what made this
load-bearing — a claim hold that a direct booker can take is not a hold — so
every remaining increment was retired in the same commit.

**Scoped to classes on purpose.** An **appointment** session is a third shape and
needs neither mechanism: it is created together with its single booking, so
`bookings_count: 1` is absolute and uncontended by construction — one booking per
slot is the definition of exclusive time, and `runAppointmentSlotTransaction` is
what serializes two people reaching for the same one. `bookAppointment`
(`appointments/window.ts`), `createAppointmentCheckout`
(`appointments/checkout.ts`), the staff booking (`appointments/staffBooking.ts`)
and the Connect webhook's appointment confirm / re-acquire all write the literal
`1`. This doc is class-only throughout; they are named here only so the rule
above is not read as covering them.

The **transactional** writers, all absolute, all inside a transaction that read
both the session document **and** its bookings:

`bookSession` · `createDropInCheckout` (hold and gift-card full cover) ·
`handleDropInCheckout` · `cancelBooking` · `rebookSession` ·
`offerWaitlistSeats` · `releaseWaitlistOffer` · `healSessionSeatCount`.

`trackBookings`' recount is the one **non-transactional** writer, and it is
listed apart because the lock argument below does not cover it: it reads the
session and the whole bookings subcollection outside any transaction and writes
the count back with a plain `update`. That is what makes it self-healing — it
fires on every booking write and re-derives the number from the documents rather
than reasoning about a delta — and the price is that it can transiently lose to a
concurrent absolute write. The next booking write recounts and it converges.
`healSessionSeatCount` is the same recount done *inside* a transaction, for the
paths that need the correction to be authoritative.

**The session document is the lock; the bookings query is the count.** For every
one of the transactional writers the session doc is in the read set *and* the
write set, which is what makes two bookers, a canceller and a promoter serialize
against each other.
`cancelBooking`'s comment used to assert this while the transaction only ever read
the bookings subcollection — a document written but never read carries no version
precondition, so the claim was simply false. It reads the session now.

Two changes came along with it, both fixing pre-existing drift: `no_show` was
added to `trackBookings`' `STATUS_EVENT` (so a no-show flip reaches the recount at
all — `markNoShowBookings` had been hand-writing a counter because of the gap, in
a **batch**, which has no conflict detection), and the kiosk self-scan's stale
`bookings_count: increment(-1)` was deleted.

### `pending_bookings_count` — the shape table

This counter is per **contact**, not per session, and it is not recounted by
anything — so it has to move exactly once per counted document. Two seams decide,
and they read different fields on purpose (`booking/index.ts`, fixtures in
`booking/pendingBookingsCount.test.ts`):

| Hold shape | Counted while it lives? | Who counts it | Who gives it back |
|---|---|---|---|
| **waitlist claim hold** (`waitlist_claim: true`) | **yes** | `offerWaitlistSeats`, when it mints the offer | `releaseWaitlistOffer` (lapse, leave, remove, cancel), or `cancelSingleSession` when the whole session goes |
| **plain drop-in hold** (`payment_status: 'required'`, no claim flag) | **no**, for its whole life | nobody | nobody — `expirePendingBookings` deletes it without a decrement, the webhook confirms it without one |

**`cancelSingleSession` is a release site too** (`sessions/index.ts:188-238`), and
until 2026-08-17 it was a broken one in both directions. The decrement lived
*inside the cancellation-notice loop*, so a studio with `session_cancellation`
switched off canceled sessions and nobody's counter moved — while with the
notice on, the loop decremented the two shapes this table says own no count
(disposed documents, whose disposer already gave it back, and plain drop-in
holds), driving real contacts negative. It now runs with the bookings read,
before any mail is built, and composes the facts above rather than restating
them: `replacedBookingWasCounted` for the live shapes and the exported
`DISPOSED_BOOKING_STATUSES` for the dead ones. A `confirmed` booking still
decrements, preserving the ambiguity `holdWriteCountDelta` documents and declines
to decide — skipping it would strand a count on every auto-confirming class.

- `replacedBookingWasCounted(replaced)` — **`bookSession`'s seam.** "Was the
  document I am replacing already counted?" Its duplicate guard admits only
  `status === 'pending'`, so every shape reaching it is live and the status
  carries no information; the one uncounted shape is the plain drop-in hold.
- `holdWriteCountDelta(replaced, writesClaimHold)` — **`createDropInCheckout`'s
  seam**, which also decides *what kind of hold the document becomes*. The delta
  is `(the document left behind owns a count) − (the document replaced owned one)`.
  An offer holder who abandons the claim link and buys through the ordinary form
  turns a counted hold into an uncounted one: **−1**. Someone who opened a plain
  checkout and then went back to their claim link: **+1**.
  It reads `status` and `replacedBookingWasCounted` does not, because
  `createDropInCheckout`'s guard is looser — a **disposed** document (canceled /
  no_show / rebooked away) reaches this seam and owns no count, so decrementing
  there would drive a real person negative.

One asymmetry is deliberate and documented rather than fixed: when the booking has
**already gone** (`expirePendingBookings` can reach a lapsed *paid* claim before
the hourly sweep sees the entry), `releaseWaitlistOffer` pairs the decrement only
with a delete it made itself, so the counter may be left one **high**. Guessing
the other way drives it negative, which is the failure someone notices.

## The lifecycle, end to end

### Join — `joinWaitlist` (public callable)

Charged against its own rate-limit bucket (`'waitlist-join'`), because sharing the
checkout counter would let a burst of people queueing for a popular class from one
gym's NAT lock that address out of paying for anything.

Refuses unless the session is a class, not canceled (**both** shapes — see
`isSessionCancelled`), `allowBooking`, in the future, capped
(`max_participants > 0`), inside the booking cutoff, and its activity has
`waitlistEnabled === true`. Then `requirePlan(teamId, 'coach')` — the only public
caller of `requirePlan`, which is why both of its refusals carry
`details.reason` (`plan_required` / `plan_inactive`): its messages are the
studio's billing prose in English and the caller may be reading a French page.

One transaction reads the session (re-read *inside*, because a merge-set on a
deleted document would CREATE a ghost session), the entry, the waiting queue, the
bookings and the caller's participants doc, then:

- already in the class (participant, or a booking of their own that holds a seat)
  → `already_booked`;
- already `waiting`/`offered` → `already_waiting`;
- **a seat is actually free** → `seat_available`, and afterwards
  `healSessionSeatCount` corrects the stale count best-effort. This guard is the
  one that stops twenty joins on an empty ten-seat class becoming ten claim holds
  that lock every real booker out for a whole claim window. It matches the client,
  which only offers the queue when `sessionBlockReason` says `'full'`;
- queue at `waitlistQueueCap` = `max(2 × seats, 20)` **waiting** entries →
  `waitlist_full`;
- else write the entry (a full `.set()` — re-joining starts a genuinely fresh
  place at the tail) and the absolute `waitlist_count`. `bookings_count` is
  untouched, so a join can never look like a freed seat to the promotion trigger.

Returns `{ position, entryToken }` and sends the join-confirmation mail — which
is the only other copy of `entryToken` that will ever exist.

**No access gate at join, and no money.** A prospective member's subscription may
start before the class; the public form shows the access badge as a *warning* and
the claim enforces. Gift cards are entered on the claim page, never at join.
**Promo codes are entered on neither** — see "No promo code on this rail".

### Offer — `offerWaitlistSeats` + `promoteWaitlistOnSeatFreed`

The promoter hangs on **one** trigger: `onDocumentWritten('sessions/{sessionId}')`,
gated on `seatFreedEdge`. Every event that frees a seat converges there — a
cancellation, a no-show flip, a rebooking out, a released hold, a raised cap, an
admin deleting a booking by hand — either through the writer's own absolute count
or through `trackBookings`' recount. Wiring six call sites would have missed the
seventh, and one of them (the hand delete) has no callable to hook.

The transaction reads, in cheapest-first order: the session, the queue
(`status == 'waiting'`, `joined_at ASC`, limit `WAITLIST_QUEUE_SCAN_LIMIT`), the
activity (for `waitlistEnabled`), the team's `public_profile` (for
`cutoffMinutes` / `waitlistClaimMinutes` — the booking-settings store), the
bookings, and the candidates' contact documents. It
re-verifies **everything from storage** — the event payload is used for nothing
but "wake up".

```
holding    = countHoldingSeats(bookings, nowMs)
free       = seatsFree(session.max_participants, holding)
room       = min(free, WAITLIST_MAX_OFFERS_PER_RUN)          // 10
candidates = waiting entries whose own booking does not hold a seat
heads      = selectOfferHeads(candidates, room, pinned?, hasContact)
```

Two things about that arithmetic:

- **Outstanding offers need no separate subtraction.** A live claim hold *is* a
  booking that holds a seat, so `holding` already covers it. Subtracting the
  `offered` entries on top would double-count them and stall the queue one seat
  short. The mirror case is why the count and not the entry is the authority: an
  offer whose window has passed stops holding its seat the instant anyone reads
  it, so the seat rolls on without waiting for a sweep.
- **One pass offers every free seat it finds**, not one. Freeing two seats at once
  (a capacity raise, a batch cancellation) fires the edge exactly once.

`selectOfferHeads` (pure, in `constants.ts`) filters entries whose **contact
document is gone** *before* the head is taken. The order is the point: filtering
afterwards meant a single dead entry at the front wedged the whole queue forever
— the pass selected the corpse, found nothing to offer, and returned without a
write, so every trigger and every backstop re-picked it. Dropped entries are
closed out (`expired`) in the same transaction, on the ENTRY only, never on the
session.

Writes per head: the booking hold (a full `.set()`, carrying the join-time
`question_answers`, an explicit `status: 'pending'`, `waitlist_claim`,
`claim_expires_at`, a `booking_token` and a `booking_reference`), the entry flip
to `offered` with its `offer_token`, `pending_bookings_count: +1` on the contact,
and the session's absolute `bookings_count` + `waitlist_count`. `claim_expires_at`
and `offer_expires_at` are written from **one** computed `Timestamp`.

Every "nothing to offer" exit is a **silent no-op** — that silence *is* the
idempotency that lets the trigger fire twice for one cancellation. A **pinned**
run (the admin's "Offer now") throws instead, with `details.reason`, because a
human pressed a button and "nothing happened" is not an answer.

`offerWaitlistSeatsAndNotify` is the entry point every caller uses: it offers,
notifies, and **gives back any offer the mail could not deliver**, then rolls the
seat on once. An offer nobody was told about is worse than no offer — the seat is
held, hidden from the day sheet and from every booking callable, and then lost,
and since an entry is offered once ever that person leaves the queue having never
been reachable. The roll is bounded twice over: it re-offers exactly once, and
every pass moves at least one candidate to a terminal status, so the candidate set
strictly shrinks.

### Claim — free

`claimWaitlistSeat` resolves the entry by `offer_token` (collection-group), checks
that a signed-in caller *is* the offer's contact, re-checks the session (both
cancellation shapes, the cutoff — because "booking closed" and "your offer
expired" are different stories and the claim page's whole job is to tell them
apart), then prices the seat with the **same** `DropInTarget` and the **same**
`resolvePaymentOptions` call `createDropInCheckout` makes. The claim adds no arm,
no rule and no price of its own — `trial: null`, because a waitlist claim is never
a trial.

`covered` / `spend_credits` settle in **one transaction**, and the entry's own
status is the guard **inside** it: two concurrent calls with the same token both
read `offered`, but only one commits; the loser retries, reads `claimed`, and is
refused before it can spend a second credit or usage unit for one seat. The
transaction also re-asserts `isUnclaimedClaimHold` on the booking — not a bare
`waitlist_claim === true`, because that is the same decision `release.ts` makes
about the same document and the two must never disagree.

It writes: the credit grant or usage window, the booking (status,
`clearedClaimHoldFields`, `claimed_from_waitlist`, the coverage provenance), and
the entry (`claimed`, `offer_token` deleted). **No `bookings_count` and no
`pending_bookings_count` write** — the seat was counted when the offer was minted
and never stopped being counted; settling a hold moves no number, and touching the
session would re-enter the promotion trigger for nothing.

After the commit, best-effort: the partner-visit ledger, the `acquisition_stage`
stamp (here, not at join), clearing `provisional`, and the **ordinary booking
confirmation email** — a claimed seat *is* an ordinary booking from that point,
and a second "you're in" template would drift from it.

A caller with no coverage and no pay path is refused with the resolver's own
denial (`denialMessage` in `booking/access.ts`, widened to the full
`PaymentDenial` union so the claim reuses those strings instead of growing a
second set). `not_joined` is the *ordinary* shape of that refusal, not an edge:
an activity with no explicit `accessRule` and `isFreeTrial: false` resolves to
`{ type: 'members' }`.

### Claim — paid

**A payable claim leaves `claimWaitlistSeat` and returns through
`createDropInCheckout`.** The free half returns
`{ requiresPayment: true, amount, appliedBenefit, claimExpiresAt }` and **writes
nothing** — an abandoned pay screen must leave the offer exactly as it was. The
client then calls `createDropInCheckout({ waitlistToken })`. There is no second
pricing path to keep in step with the first.

`createDropInCheckout` with a `waitlistToken`:

- resolves the offer from **this session's** queue and takes the payer's identity
  from it — a claimant never re-types their details and can never claim as
  somebody else;
- refuses `claim_window_too_short` when under 31 minutes remain
  (`resolveClaimCheckoutWindow`);
- refuses a claim asked for as a `trial`;
- refuses when the caller is already covered (`claimWaitlistSeat` settles those
  for free);
- rewrites the hold explicitly. Both booking writes in that file are bare
  `.set()`s that replace the document wholesale, so `waitlist_claim`,
  `claim_expires_at` and the join-time `question_answers` have to be re-sent —
  otherwise the entry would still say `offered` while the booking had silently
  become a plain drop-in hold, and on abandonment `expirePendingBookings` would
  delete it and leave the entry stuck at `offered` forever: a permanently blocked
  queue;
- sets `expires_at = claim_expires_at` and the Stripe session's expiry to the same
  instant;
- puts `metadata.waitlistEntry = contactId` so the webhook knows which queue it is
  closing.

`handleDropInCheckout` then confirms the booking **and flips the entry to
`claimed`** in the *same* transaction, so "the booking is paid but the queue still
thinks the offer is outstanding" never exists for a sweep to act on. That
transaction also re-checks capacity: the hold this charge paid for may no longer
hold a seat (swept, or lapsed while someone else took the last place), and
confirming blindly would oversell. If the class is full **without** the payer, the
charge is refunded, any gift-card drawdown reversed, and the offer released back
to the queue through the ordinary guarded release. A claimant whose hold survived
is confirmed unconditionally — the seat was held for them and there is no capacity
question.

### No promo code on this rail

**A waitlist claim is the one paid drop-in that takes no promo code** (Wave 3
Phase 3, decision Q11). It is not an oversight and not a deferral: it is the
interaction of two decisions that are each right on their own.

- Promo's cap **refuses rather than over-issues**, so a live, uncompleted
  reservation consumes a use of `max_uses`.
- This rail's deadline **cannot be shortened**. `claim_expires_at`,
  `offer_expires_at` and the Stripe session's `expires_at` are one instant, and
  giving one seat two timers is exactly what "The single-deadline rule" above
  exists to forbid. Every other promo-carrying checkout gets ~31 minutes; this
  one would get the whole claim window — ~124 minutes by default, up to 24 hours
  if a studio configures it.

Strict cap plus longest hold is the worst pairing in that design: one claimant
who opens the pay screen and walks away would hold a slot of a scarce campaign
closed for hours.

**Enforced on the server, not merely absent from the UI.** The claim page mounts
no promo field, and `createDropInCheckout` builds a `NO_PROMO_ATTEMPT` on the
claim path, so a hand-made request carrying `promoCode` is reported
`not_applicable` — reported, not blocked, like every other inapplicable code. The
claim still completes at its ordinary price.

Reversing this later needs more than a mount: the claim page's displayed price
comes from `claimWaitlistSeat`'s own response, and the new refusal reasons would
have to join `claimErrorKey` — the single mapping shared by `claimWaitlistSeat`,
`createDropInCheckout` and the promoter. `claimErrorKey` already maps
`price_changed` → `Waitlist.priceChanged` even though this page cannot fire it
today, precisely so that groundwork is not the thing that blocks it.

### Claim — full-cover gift card

A gift card that covers the whole price creates **no Stripe session**, so no
webhook ever fires and there is no later hook to hang the entry flip on — and the
seat becomes permanent right there. So the confirmed booking write, the entry flip
to `claimed` and the absolute `bookings_count` are **one transaction**, committed
**before** `commitGiftCardDrawdown`.

This is the blocker the design pass named: an entry left at `offered` behind a
confirmed, gift-card-paid booking would be matched by the sweep, and a release
that did not inspect the booking would delete a paid seat and hand it to the next
person — costing the buyer both the balance *and* the class. It is guarded twice:
by this atomicity, and by the release's own guard below.

A rider on `commitGiftCardDrawdown({ waitlistEntryId })`, declared in the Phase 1
spec as the hook for this, was **removed rather than implemented**: the booking is
already confirmed before it runs, and both of that function's early returns
(nothing to commit; an `admin_comp` card) skip anything placed after them.
**Update (Wave 3 Phase 3): `promoRedemptionId` went the same way**, and the
sentence that used to stand here — "Phase 3 commits *after* the money moves,
which is the seam that rider actually fits" — was wrong. `commitGiftCardDrawdown`
only runs when a gift-card code was supplied at all, so a promo used *without* a
card would never have committed. See `docs/promo-codes.md` → "The commit".

### Release — and why the ordering is load-bearing

`releaseWaitlistOffer` (`waitlist/release.ts`) is the ONE way an offer stops being
an offer. Six callers reach it from different directions — the hourly sweep
(passes 1 and 2), `leaveWaitlist`, the admin's "Remove", the session-cancel /
session-delete teardown, the Connect webhook's oversell refund, and the promoter
itself when an offer mail could not be delivered — and they all apply the
identical guard, because the guard is what stands between the queue and a
destroyed paid booking.

**The entry is treated as a DERIVED VIEW of the booking, never as a second source
of truth.** Whatever the booking says happened is what the entry is set to, so a
flip missed anywhere else self-heals here rather than turning into a deletion:

| Outcome | When | What happens |
|---|---|---|
| `noop` | the entry is gone, or already terminal | nothing written |
| `queue_only` | the entry was only `waiting` | entry closed, `waitlist_count` corrected, no seat involved |
| `released` | the booking is still an unclaimed claim hold | booking deleted, `pending_bookings_count` −1, absolute `bookings_count` — **a seat is free right now** |
| `self_healed` | `bookingSeatTakenUp` — they are IN the class (a settled claim whose flip was missed, or they booked directly while holding the offer) | booking untouched, entry corrected to `claimed`, no "your offer lapsed" mail |
| `stale` | the hold is gone, or what replaced it holds no seat, or what replaced it is itself unsettled | entry closed out, person told the offer lapsed |

> **RELEASE FIRST, RE-OFFER AFTER.** The booking is deleted and the session's
> count corrected *inside* the release transaction; a caller that re-offers does
> it *outside* that transaction, immediately. The other order means the promoter
> looks for free seats while this one is still held — it finds none, returns, and
> the seat leaks until the next hourly sweep.

Who re-offers, and who deliberately does not:

- **Sweep pass 1** collects the sessions of its `released` outcomes and re-offers
  after the loop.
- **`leaveWaitlist`** and **`removeWaitlistEntry`** each re-offer on a `released`
  outcome. Explicitly, and not by leaning on the trigger: the release's session
  write only produces a `seatFreedEdge` when the class was exactly full before it
  — a class already under its cap produces no edge, and the queue would sit.
- **The promoter's own undeliverable release** rolls the seat on inside
  `offerWaitlistSeatsAndNotify`, once (see "Offer").
- **The Connect webhook's oversell branch does NOT**, and that is correct. It
  releases only after `seatsFree` found the class full *without* the payer, so
  deleting the payer's own dead hold frees nothing to roll on — which is also why
  the release's session write produces no edge there either.
- **The session-cancel / session-delete teardown does NOT**, because that class
  will never run. Re-offering there is exactly what closing the queue *before*
  releasing the holds exists to prevent. **Sweep pass 2** is the same case: its
  classes have already started.

The release also reads the session before writing it: a subcollection outlives its
parent document, so the sweep reaches entries on deleted sessions, and
`tx.set(…, { merge: true })` on a deleted document would **create** a ghost session
carrying nothing but a seat count.

### The sweep — `sweepWaitlistOffers`

Rides the existing **hourly** `bookingRemindersHourly` job, not the 02:00 batch:
an offer minted at 09:00 with a two-hour window has to roll on at 11:00, and the
nightly job would leave that seat dead for fifteen hours. Hourly granularity is
acceptable *only* because expiry is lazy — a lapsed hold stops occupying its seat
the instant any transaction reads it, and `claimWaitlistSeat` refuses a lapsed
offer whether or not the sweep has run. **The sweep is bookkeeping and
re-offering, never correctness.**

Three passes, in this order:

1. **Lapsed offers** — `status == 'offered' && offer_expires_at <= now`, oldest
   deadline first. Each through the guarded release; `released` and `stale` both
   send the "your place was not claimed in time" mail (they are the same event to
   the person), `self_healed` never does. Then re-offer, outside the transaction.
2. **Dead queues** — `status in ['waiting','offered'] && session_start <= now`.
   Without this the queue leaks an entry on every past session forever; this is
   why `session_start` is denormalised onto the entry. `waitlist_count` is
   deliberately left alone here — the class has run and nothing reads it again.
3. **Backstop promotion** — `status == 'waiting' && session_start > now`, deduped
   by session, skipping sessions pass 1 already re-offered. Catches a dropped
   trigger event. It is driven from the **queue**, not from "sessions with free
   seats and a queue": Firestore cannot compare two fields, so that query does not
   exist.

Pass 2 is wrapped so a failed commit costs that pass and not pass 3 — the backstop
is the one that puts people in classes.

### Leaving, removing, canceling, deleting

- **`leaveWaitlist({ entryToken })`** — the same guarded release, terminal status
  `left`, then re-offer. Someone who claimed and paid and *then* clicked the older
  "leave the waitlist" link in their mailbox keeps the seat they bought.
- **`removeWaitlistEntry`** / **`promoteWaitlistEntry`** (`waitlist/admin.ts`) —
  the studio's two row actions, manager-gated against the **session's own**
  `teamId`. Callables and not client writes: the rules deny *all* client writes to
  `sessions/{id}/waitlist/**`, including from a `schedule.manage` holder, because
  a coach flipping an entry to `offered` from the browser would mint a claim
  nobody held a seat for. Every refusal carries `details.reason` — the session
  page maps it to a translated string, since the English messages must not reach
  a coach in Lausanne.
- **`cancelSession`** (`sessions/index.ts`) marks the session called-off
  **first**, then calls `closeSessionWaitlist` **before** reading the bookings.
  Both orderings are independent and both matter: the marker stops the promoter
  mailing "A place has opened up" for a class being called off (releasing a hold
  writes `bookings_count`, which is the seat-freed edge), and closing the queue
  before the bookings read stops the same person's `pending_bookings_count` being
  decremented twice for one hold. Offer holders come back from the teardown and
  are mailed the cancellation alongside the real bookings — they are the group
  that genuinely believed they had a seat, and the bookings loop cannot reach them.
- **`teardownWaitlistOnSessionDeleted`** — an `onDocumentDeleted` trigger, not a
  call-site hook, because a standalone session is deleted **client-side**. It
  closes the entries (releasing holds, giving the counters back) and then
  **deletes** them, since a Firestore subcollection survives its parent and the
  entries would otherwise surface in the collection-group sweeps forever. Both
  loops are paged: only *live* entries are capped, while terminal ones accumulate
  for the life of the session, and a batch commits at most 500 writes.

## Notifications

`packages/functions/src/booking/waitlist/notify.ts`; copy in
`booking/templates.ts` as `Record<Lang, string>` maps (functions cannot read
`messages/*.json`).

| Mail | When | Carries | Gated by `systemEmailEnabledFor`? |
|---|---|---|---|
| **You're on the list** | after a join commits | the long-lived `entry_token` status link, and the position | **No** |
| **A place has opened up** | after a promotion commits | the single-use claim link (`offer_token`) and the deadline | **No** |
| **Your place was not claimed in time** | sweep pass 1, outcomes `released` and `stale` | a re-join link back to the booking page | **Yes** (`booking_confirmation`) |
| **Booking confirmed** | a **free** claim settling in `claimWaitlistSeat` | the ordinary confirmation, reused verbatim | **Yes** (`booking_confirmation`) |
| **nothing** | a claim settled **through `createDropInCheckout`** — paid by card, or fully covered by a gift card | — | — |
| **SMS nudge** | with an offer, only inside `isWithinSmsSendingHours` and only if the contact has a phone | "check your email" — **no token** | — |

**Two sends are deliberately ungated, and that is the unusual call.** The other
system mails are courtesies a studio may reasonably run itself from the
automations engine. These two are not:

- the **offer** carries the single-use claim token and has no automation
  equivalent. A studio that switched it off would mint offers nobody is told
  about — a held seat, removed from the day sheet and from every booking callable,
  expiring in silence.
- the **join confirmation** carries the only other copy of `entry_token`, and
  `listMyWaitlist` needs a contact session a guest does not have. Switching it off
  would trap people in a queue they can see once and never leave.

Same posture as the verification codes in `utils/systemEmails.ts`: always on,
because switching it off does not quieten the feature, it breaks it. The expiry
notice *stays* behind the toggle — it carries nothing but news, and switching it
off leaves nobody stuck.

Delivery is **reported, not assumed**. `sendEmail` does not throw when a recipient
is suppressed (an earlier hard bounce), when the tenant messaging policy is
`silent`/`allowlist`, or when `MAIL_ENABLED=false` — it returns `{ skipped: true }`.
`offerWasDelivered` treats a `skipped` outcome as a delivery only when it carries a
`providerMessageId` (the idempotency ledger reporting a send that already went
out); everything else hands the seat back.

Idempotency keys are per **event**, not per person-and-class:
`waitlist-{kind}-{sessionId}-{contactId}-{token…}`. Leaving and re-joining writes a
genuinely fresh entry for the same pair, so a token-free key would silently dedupe
the second round's mail and hand that person a held seat nobody told them about.
The SMS variant carries the reminder steps' `sms-` prefix, since mail and SMS share
one ledger collection.

Two exclusions elsewhere: `sendBookingReminders` skips `waitlist_claim === true`
bookings (a held-but-unclaimed seat must not get a reminder for a class the person
has not got), and `markNoShowBookings` skips unsettled holds
(`payment_status === 'required' || waitlist_claim === true`) and their counter
decrement — it was stamping abandoned drop-in checkouts `no_show` on real people's
records.

## Rules and indexes

```
// nested — sessions/{session}/waitlist/{entryId}
allow read:  belongsToUserTeam(get(.../sessions/$(session))) || hasRole('admin')
allow read:  isSelfContact(entryId)
allow write: if false      // callables only — deliberately unlike the bookings block

// collection group
match /{path=**}/waitlist/{entryId}
allow read:  request.auth != null && resource.data.teamId != null && isTeamMember(...)
allow write: if false
```

The collection-group **read** grant has no client consumer today, and the block
says so: every collection-group query on `waitlist` in this repo runs in a
callable over the Admin SDK, which bypasses rules entirely. It is a defensive
team-scoping grant for a future client-side read — the shape `listMyWaitlist`
exists to work around, since `isSelfContact` authorizes a `get` and not a `list` —
and it widens nothing, because a team member can already read every one of those
documents individually through the nested block. It grants a query shape, not data.

Indexes (`firestore.index.json`) — **deploy indexes before functions**:

| Scope | Fields | For |
|---|---|---|
| COLLECTION | `status ASC, joined_at ASC` | the FIFO head inside the promotion transaction |
| COLLECTION_GROUP | `status ASC, offer_expires_at ASC` | sweep pass 1 |
| COLLECTION_GROUP | `status ASC, session_start ASC` | sweep passes 2 and 3 |
| COLLECTION_GROUP | `teamId ASC, contact ASC` | `listMyWaitlist` |

Plus **`fieldOverrides`** for `waitlist.entry_token` and `waitlist.offer_token`,
each with a `COLLECTION_GROUP` ascending index, copying the `bookings.booking_token`
shape. Without them the token lookups work in the emulator and fail in a real
project (memory: `firestore-index-query-gotcha`).

`offer_expires_at` / `offer_token` / `offered_at` are **flat fields**, not a nested
`offer` map — a nested subfield index is legal, but the flat shape keeps the
queries and the overrides identical to every existing precedent.

## Where the waitlist appears

| Surface | Behavior |
|---|---|
| Public booking form (`BookingForm.tsx`) | A full-but-bookable class keeps its slot rendered with a "join the waitlist" chip, gated on `waitlistEnabled` from the **activity** public profile. The click and the `?session=` deep link route to a `waitlist` step (reusing `GuestDetailsForm` and the activity's `bookingQuestions`); a signed-in contact skips the form. `sessionBlockReason` reports `'closed'` before `'full'`, so a class past the cutoff disappears instead of advertising a queue nothing can be offered from. The access badge is shown as a **warning**, not a gate |
| Claim page (`/public/{slug}/waitlist?token=…`) | One page, two modes, decided **server-side** by which token matched. `entry_token` → status view (position, "leave the waitlist"). `offer_token` → claim view (countdown, "claim my spot"): free finishes inline; payable shows the price with `appliedBenefit`, offers `GiftCardRedeemField`, and routes to `createDropInCheckout({ waitlistToken })` → Stripe → back into the booking flow's confirmed step |
| Admin session detail | A queue section with position, name, "waiting since" and a status chip, plus a count in the stat row. Two row actions, both callables: **Offer now** and **Remove** (behind a confirmation dialog) |
| Day sheet (`useDaySheet`) | Loads each session's queue alongside its bookings and participants — the coach at the door with a no-show and three names to call is the point of the feature |
| Printable manifest | "Waitlist (3): A. Müller · B. Rossi · C. Dupont" under each roster |
| Activity form | `waitlistEnabled` beside `trialEnabled` / `dropIn`, plan-gated in the UI to mirror the server's `requirePlan(teamId, 'coach')` |
| Settings → Booking | `waitlistClaimMinutes`, under the cutoff |
| Mobile app | **Nothing.** No waitlist surface exists in `apps/mobile` |
| Public Space | **Nothing.** `listMyWaitlist` is implemented and exported but has no client consumer yet |

## Known gaps and deliberate omissions

Honest list. Several of these are decisions rather than debt.

**Deliberately not built:**

- **Waitlists on appointment availability windows** — a different primitive; see
  the opening.
- **A per-session `waitlist_enabled` override.** It is exactly what would create
  the fan-out/backfill problem. Addable later as an *optional* override that wins
  when present.
- **Re-queueing a lapsed offer to the tail** (offer counters, `maxOffers`,
  ordering keys). One offer per entry; the person re-joins.
- **An admin "book them in directly" action.** That would be a second
  capacity-writing path for a job the add-participant dialog and the walk-in door
  already do through gates that recount.
- **Deferred SMS after quiet hours.** A fourth sweep pass with its own idempotency
  marker; the window anchoring plus the always-sent email covers it.
- **Push notification of an offer.** Push is not shipped for reminders — never
  build a claim window on a channel that does not exist.
- **A promo field at join** — and, as of Phase 3, **not on the claim page
  either**: see "No promo code on this rail". This bullet used to say Phase 3
  would add one to the claim page; that was reversed by the Q11 decision, not
  merely deferred. **A waiver gate at join** is still Phase 4.
- **Any waitlist arm in `resolvePaymentOptions`.** A claim is an ordinary drop-in
  resolution.
- **`canCreateContact` on the join path.** `bookSession` and
  `createDropInCheckout` do not apply it either, and provisional contacts do not
  count toward the cap by design. The join's own rate-limit bucket, the queue cap
  and `provisional_expires_at` bound the new vector; applying the cap here alone
  would be inconsistent. Tracked as a Wave-3-wide follow-up.

**Known imprecision, accepted:**

- **`waitlist_count` is a display value and can run high.** A promotion pass that
  expires dead entries and offers nothing leaves it stale until the next absolute
  write, because touching the session on a no-offer path is the one thing the
  promoter may not do. Sweep pass 2 leaves it alone entirely on classes that have
  already run.
- **`pending_bookings_count` can be left one high** when `expirePendingBookings`
  deletes a lapsed *paid* claim before the sweep sees the entry — see the shape
  table. Never negative, which is the direction that matters.
- **The scan limits are ceilings, not paging.** `WAITLIST_QUEUE_SCAN_LIMIT` (200)
  and `WAITLIST_SWEEP_SCAN_LIMIT` (500): a run that hits one drains the most
  urgent work first (ordered by deadline / session start) and the remainder waits
  an hour. Raise them before reaching for paging — a partial pass is correct, a
  half-paged one is not.
- **The sweep is hourly**, so an entry can sit terminal-but-unswept for up to an
  hour. Correctness never depends on it (lazy expiry).
- **`rebookSession` writes the old booking's `rebooked` status without reading it
  in-transaction.** Not a lost-update hole — its counterparties read the whole
  bookings collection — but the precondition is missing and it is worth a
  follow-up.
- **A claim settled through `createDropInCheckout` sends NO confirmation mail.**
  Only the free claim gets one (`claimWaitlistSeat`); the card-paid claim
  confirms in `handleDropInCheckout` and the full-cover gift-card claim confirms
  inside `createDropInCheckout` itself, and neither of those paths sends mail.
  That is **pre-existing** and not something this phase introduced — no paid
  drop-in has ever had a confirmation email — so it was left alone rather than
  fixed on the waitlist's coat-tails. Closing it means changing the drop-in
  paths, which is where the omission actually lives.
- **On a tenant whose messaging policy drops mail, the queue is inoperative and
  self-draining.** `offerWaitlistSeatsAndNotify` hands back any offer the mail
  could not deliver — and a policy of `silent` or `allowlist`, or an RFC-2606
  seed address (`@example.com`, always dropped by the synthetic-recipient guard),
  is reported as exactly that. So every offer releases, rolls on, releases again,
  and the whole queue drains to `expired`. **`linyup-sandbox` is in that state by
  configuration, not by chance**: its `MESSAGING_DEFAULT_MODE` is `silent`
  (`packages/functions/.env.sandbox`), so a tenant with no `messaging_policies`
  doc drops every offer. Demoing or exercising the waitlist there needs an
  explicit `live` (or `allowlist`, with the demo address on it) policy for that
  tenant first — `pnpm messaging:policy`, or the operator console's
  messaging-policy card.
- **Nothing in this phase was exercised against a real Firebase project.** The
  emulator hides missing indexes; the `entry_token` / `offer_token`
  collection-group lookups should be run against `linyup-sandbox` before this
  ships anywhere real.

## History and gotchas

- **The waitlist is where the capacity model got fixed.** Roughly half of Phase 2
  was not waitlist work at all but seat-accounting repair the queue made
  load-bearing, and three of those were live bugs: `createDropInCheckout` had **no
  capacity check whatsoever** (a full class sold drop-ins deterministically, no
  race required), `rebookSession` had neither a capacity check nor a cutoff check,
  and the blind-increment / absolute-write pair was already fighting in
  production. A claim hold that a direct booker can take is not a hold, which is
  why all of it had to land in one commit.
- **The claim hold is a booking, not a `waitlist_holds` collection.** Every
  alternative required teaching the capacity gates, the duplicate guards and the
  recount about a second kind of seat.
- **`bookSession`'s stale-full pre-read is separate from the transaction.** The
  fast path reads the stored `bookings_count`, and only when that says "full" does
  it call `healSessionSeatCount` — which re-derives from the bookings **inside a
  transaction** and persists both `bookings_count` and `status`. Re-deriving
  outside a transaction and writing the result is the lost-update shape this phase
  retired. The authoritative gate is still the one inside the booking transaction.
- **`joinWaitlist` refuses when a seat is genuinely free.** It is the join, not
  the promoter, that is wrong in that case — which is what leaves the sweep's
  backstop pass free to do its real job (re-offering after a missed trigger)
  instead of second-guessing the queue.
- **Both cancellation shapes, everywhere.** A canceled *occurrence of a series*
  writes `isException` + `exceptionType: 'cancelled'` and leaves `status` and
  `allowBooking` exactly as they were. `isSessionCancelled` tests the pair; a
  status-only test reads a called-off class as bookable, and the queue would take
  joins for it and offer seats on it.
- **Rate limiting is split into two buckets and charged differently.** Joining is
  charged per attempt on `'waitlist-join'`. The token surfaces (claim, status
  view, leave) **peek** at `'waitlist-claim'` and charge only attempts whose token
  resolves to nothing — the people queueing for a class and the one person holding
  an offer for it are behind the same gym NAT by construction, and an offer is a
  one-shot entitlement nobody gets twice.
- **Gates control creation only.** A team downgraded below `coach` can still have
  its outstanding offers claimed and its queue swept; only a new join is refused.
