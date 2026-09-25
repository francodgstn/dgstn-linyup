---
title: Appointments
description: "Appointments (1:1) — architecture"
status: living
area: booking
order: 3
---
# Appointments

An appointment is **a booking of a provider's exclusive time**, as opposed to a
class, which is **a seat in a scheduled event**. That's the whole distinction —
they are not different entities. Both are `sessions/{id}` docs; `activityType`
(`'class' | 'appointment'`) says which, and `Activity.type` says which scheduling
mechanism an offering uses:

| | **Class** | **Appointment** |
|---|---|---|
| The unit | a scheduled event with N seats | a provider's exclusive time |
| Exists before booking? | **yes** — the studio schedules it onto the calendar | **no** — availability is published; the session is created *at booking* |
| Constraint | seats remaining | provider not double-booked (overlap check) |
| Time chosen by | the studio | the client, from published availability |
| Created via | Schedule → "New session" | client books from availability (`bookAppointment`) |

Everything else — provider, capacity, price — is an ordinary field both kinds
carry, **not** something implied by the type. One deliberate asymmetry: classes
have an **access rule** (`open`/`members`/`subscription`, plus the independent
`trialEnabled` and `dropIn` toggles), while appointments have **none** — for an
appointment, **the price is the gate** (see "Paid appointments").

## The two halves: the *what* and the *when*

This split is the core of the model. Get it wrong and nothing else makes sense.

- **`Activity` (type `'appointment'`) owns the *what***: name, `durations`
  (the lengths a client may book — a "Technique Assessment" is 60 minutes wherever
  it's offered — each carrying an optional **base price**), the ONE
  **`memberBenefit`** rule (see "Paid appointments" below), and
  `confirmationInstructions`. There is deliberately NO capacity field: an
  appointment is a provider's *exclusive* time, so one booking per slot is the
  definition, not a setting (the materialised session carries
  `max_participants: 1` for the recount trigger). And there is NO `accessRule`:
  appointments dropped the access gate in 2026-07 — the field still exists on
  `Activity` because classes use it, but appointment forms don't show it and
  appointment booking paths don't read it. Because appointments are activities,
  they are listed on the website and countable in analytics **exactly like
  classes** — no special-casing.
- **`availability/{id}` (`Availability`) owns only the *when***: `providerId`,
  `title` (the SCHEDULE's admin-facing name — "Saturday mornings" — *not* the
  offering's name), `recurrence.daysOfWeek` + `startDate`/`endDate`,
  `bufferMinutes`, and **`activityIds: string[]`** — which appointment activities
  are bookable in this window. Durations are **never** configured here; they derive
  from the linked activities.

Two entry styles, both **lazy**:

| `mode` | Fields | Meaning |
|---|---|---|
| `'range'` | `window: {start,end}` + `granularityMinutes` | "I'm free 9–12; pick a start on the grid" |
| `'times'` | `times: string[]` | "I offer exactly 19:30 and 20:15" |

> **Why nothing can be pre-generated.** If a window offers a 30-min *and* a 90-min
> activity, the 9:00 slot is **indeterminate** — it isn't one session until the
> client picks the activity. Multi-activity availability is therefore incompatible
> with pre-materialisation. This is *why* the model is lazy; it isn't a preference.

## Booking flow

`packages/functions/src/appointments/window.ts` — two public callables:

- **`listAvailability`** `{ teamId, providerId?, activityId?, days? }` — pure
  compute, no writes. Reads active `availability` docs, resolves their linked
  `type: 'appointment'` activities, and enumerates free starts **per activity**
  (its `durations` drive the grid), minus the provider's booked sessions
  expanded by `bufferMinutes` (busy = `appointmentSlotBlocked`, so an expired
  payment hold doesn't block). Returns coach-first:
  `coaches[] → { providerId, providerName, activities: [{ activityId, activityName, durations, memberBenefit, location, onlineUrl, days: [{ dayMs, slotsByDuration }] }] }`
  where `durations` is the priced menu `[{ minutes, priceAmount }]` and
  `memberBenefit` is the activity's rule, verbatim — the picker runs the SAME
  shared resolver the server uses (`resolvePaymentOptions`, `kind:
  'appointment'`, optimistic client snapshot) to show a verified member their
  price (public-safe: the type ids are already public in the shop; the server
  re-resolves at booking). Days are merged across a provider's several
  schedules; when schedules disagree on location, the first contributor's is
  shown (booking resolves the real one).
- **`bookAppointment`** `{ teamId, providerId, activityId, startMs, durationMinutes, …contact }` —
  the **free-path** booking callable. The client sends **no** `templateId`: the
  server resolves which active availability covers that start (day-of-week, date
  range, window/grid or explicit time), which is both simpler and unspoofable.
  It validates `durationMinutes` against the activity's `durations` and applies
  **the price gate — the only gate** (there is no access check): when the
  caller's effective price is an amount it refuses with `failed-precondition
  { reason: 'payment_required', priceAmount }` (the client routes to
  `createAppointmentCheckout`); when it's free it creates the session and its
  `confirmed` booking in one transaction (an `included` benefit via a
  credit-pack type spends a credit).
- **`createAppointmentCheckout`** — the **paid path**
  (`appointments/checkout.ts`); see "Paid appointments" below.

The materialised session **inherits from the activity**: `activityId`,
`activityName`, `autoConfirm` (plus a fixed `max_participants: 1`) — but **no
`accessRule`**, which appointment session docs and mirrors stopped carrying;
`location`/`onlineUrl` come from the matched availability; `templateId` points
back at it; `origin: 'window'`.

**Overlap safety (first-come-first-served)** — two layers in one transaction:
1. a **deterministic id** `apt_{providerId}_{startMs}` so two bookings for the same
   provider+start collide on one doc (a `cancelled` doc at that id is reusable);
2. an **in-transaction range query** over the provider's sessions to catch
   *overlapping different* starts, buffer-expanded.

**No access gate.** Appointments have no access rule — THE PRICE IS THE GATE
(see "Paid appointments"). The class access gate (`booking/access.ts`) is
untouched for `bookSession`; what the two paths share is the **held-types
computation**: the appointment paths build the same contact snapshot
(`loadContactPaymentContext`) the class coverage gate uses, but resolve it
against `memberBenefit.subscriptionTypeIds` — so credit packs keep spending a
credit on an `included` booking. (History: the 2026-07 activity-bound refactor initially
gave appointments the class access gate; a persona test showed it produced the
"who pays base price if only Premium can book?" paradox, and it was dropped the
same month — while the old generator model before the refactor couldn't gate at
all, since its slots carried no `activityId`.)

**`bookSession` is class-only.** It rejects `activityType === 'appointment'` — no
open appointment sessions exist to book. Class-side, `accessRule` still means
"who books FREE", with two independent toggles alongside it: `trialEnabled` (a
gated class still accepts a newcomer's guest trial via the open-tier path) and
`dropIn` (uncovered contacts pay per class). **`cancelBooking` still handles
both kinds**: an appointment cancel flips the session to `status: 'cancelled'`
(unpublishing it via the sync gate) and frees the provider's time, which
reappears in `listAvailability`.

### Who the picker is booking for — one derived caller, the server's precedence

`resolveAppointmentCaller` (`appointments/booking.ts`) accepts **three** proofs and
checks them in trust order — **contact session → `authenticatedContactId` +
`verificationCodeId` → typed `contactDetails`** — returning from the first that
answers. A contact session therefore wins over everything in the request body, and
this is not a subtlety the client may skip: `PublicContactAuthProvider` is mounted
at the team root, so the session's ID token is attached by `httpsCallable` to every
callable the picker makes, whether or not the picker knows it exists.

`AppointmentPicker.tsx` mirrors that order in a `Caller` derived on every render
(`sessionCaller ?? verified ?? GUEST`), and every screen, price and payload comes
off it:

| Caller | Screen | Body identity | Price snapshot |
|---|---|---|---|
| `session` (signed in anywhere under `/public/{slug}`) | member screen — name, price or "included", one CTA | **none** — the token is the proof | the contact's held type |
| `code` (took the sign-in offer on the guest form) | member screen, or the `autobooking` spinner when covered | `authenticatedContactId` + `verificationCodeId` | `held_subscription_type_ids` from `verifyBookingCode` |
| `guest` | guest details form + the sign-in offer | `contactDetails` | `GUEST_SNAPSHOT` |

**A signed-in contact is never shown the guest form or the sign-in offer**, because
the server would discard what they typed and would ignore a second sign-in. Until
2026-08-16 this file read the session zero times, and all three of the consequences
were live: a member was quoted the guest price (display only — the server charged
the member price), a member typing a partner's details had the appointment booked
under themselves, and — the real one — a **covered** member was routed into
`createAppointmentCheckout`, which refuses `{ reason: 'covered' }` by design, and
the picker rendered that as *"This slot is no longer available."* Both paid submits
now answer a `covered` refusal by booking through the free door.

Free-vs-paid routing comes from the resolved quote (`owesPayment`), never from
"does this duration have a price" — that substitution is what sent a covered member
to the paid door in the first place. The three terminal submits are unchanged in
number and are the census `waivers/surfaces.test.ts` counts: `onSubmitGuest`,
`runMemberFreeBooking` (entered from `onVerifiedAppointment`'s autobooking path and
from the member screen's Confirm) and `onMemberPay`.

#### The caller can move while the step is open

Deriving the caller is half of it; the other half is that the derivation can
CHANGE mid-flow, because the corner sign-in pill belongs to the provider that
wraps this page. Everything the screen has already said or captured was quoted
for whoever was there before, so one rule retires all of it:

| What | How it retires | What it did before |
|---|---|---|
| the accepted `price_changed` figure | `useAcceptedPrice` scope (shared) | a guest's 40.00 re-sent on a member screen quoting 24.00 |
| the server's `payment_required` figure | read through `identityKey` | — |
| **the error sentence** | read through `identityKey` (it NAMES a figure) | "…the price without the code is CHF 40.00" rendered verbatim above a member's 24.00 button; only the OTP arm cleared it, the contact-session arm had nobody |
| **the captured submit** (`pendingBook`) | stamped with its identity; a foreign one is dropped and the consent screen dismissed | a resume replayed `pending.caller` / `pending.values.email` from before against a price, body identity and acceptances re-derived after |
| **the applied promo** | dropped, and said out loud | a code previewed anonymously on the guest screen was carried onto the member screen and re-priced there for an audience the server judges differently |

The sentences are `AppointmentBooking.identityChanged` /
`identityChangedPromo`. Because a carried code is now impossible, the member
screen's `PromoCodeField` renders its INPUT for every recognised caller (it used
to be `session`-only): whatever is on that screen was applied by that caller,
under the same advisory-preview contract the guest screen has always had.

#### The member's price is re-resolved, not read off the session

The persisted contact session is a **seven-day snapshot** — it carries the one
`subscription_type_id` the contact had at sign-in and is never refreshed. On
other surfaces that is a label; here it is the price, and its divergence points
the **unsafe** way: a lapsed or changed subscription still reads as held, the
screen quotes the benefit, and `loadContactPaymentSnapshot` charges the real
figure. `assertQuotedAmount` does not catch it either — it returns on its first
line unless the checkout carried a promo code.

So the picker re-resolves the held set on load from the contact's own document
(`usePublicContactRecord`, the `isSelfContact` get Space already makes) through
the shared `heldSubscriptionTypeIds` union — the same one the OTP path gets from
`verifyBookingCode`. The frozen value survives only as the fallback for a read
that FAILED, and the member CTA + code field wait for the answer rather than
offering a figure derived from the stale one. On the `payment_required` race
(client resolved free, server did not) the CTA turns from Confirm into Pay, and
`AppointmentBooking.coverageEnded` says why.

**The census of which public surfaces read the session at all** —
and, for the ones that do not, what they use instead — is
`packages/functions/src/auth/publicSurfaceIdentity.test.ts`. It enumerates the
route tree rather than a hand-kept list, so a new surface that forgets the session
fails the build.

## Paid appointments

A duration can carry a price; a client whose effective price is an amount books it
by paying up front through Stripe Connect — the same rail as the class drop-in
(`docs/payment-contact-studio.md`), but **not** the class `dropIn` config, which
stays class-only. Appointments price the duration itself.

### The pricing model — a price AND a member rule, both per session length

The coach sells TIME, so the base price is per duration — and so is the rule
about that price (`packages/shared/src/types/activity.ts`):

```ts
durations: [
  { minutes: 30, priceAmount: 45 },   // base price, major units
  { minutes: 60, priceAmount: 85 },   // null/absent = unpriced → free for anyone
]
durationBenefits: [                   // one optional rule PER LENGTH
  { minutes: 30, benefit: { subscriptionTypeIds: ['sub-elite'], effect: 'included' } },
  { minutes: 60, benefit: { subscriptionTypeIds: ['sub-elite'], effect: 'fixed_price', amount: 60 } },
]
memberBenefit: { … }                  // LEGACY — the activity-wide rule
```

- **THE ONE READER IS `resolveDurationBenefit(activity, minutes)`.** Never touch
  either field directly. `durationBenefits` present ⇒ it is the whole answer and
  a missing entry means "no rule for this length"; absent ⇒ the legacy
  activity-wide `memberBenefit` applies to every length, exactly as before. So
  an appointment nobody has re-edited behaves identically, and **no backfill is
  owed**: the first per-length save absorbs the old rule onto every length the
  activity has and clears `memberBenefit`
  (`activityPlanEdgeUpdate`), the same absorption-on-first-write the course gate
  does with its own legacy spelling.
- **The benefit is data, never implied.** Holders of any listed type:
  `included` → that length is free (a credit-pack type spends a credit);
  `percent_off` → that percentage off it; `fixed_price` → that amount for it.
  **No rule = no benefit** — everyone, subscribers included, pays base.
- **Why it went back to being per length (2026-09-02).** One rule for the whole
  activity could not express `fixed_price` at all: "members pay CHF 40" charged
  the same for thirty minutes and for ninety, an amount that cannot be right for
  both — offered by the editor and honoured by the resolver, with no way to say
  the true thing. **This is not the matrix that was cut in 2026-07.** That one
  was per duration × per subscription type — a grid of PRICES, which is what
  produced "who pays base price if only Premium can book?". This is the same ONE
  rule the studio already writes, asked once per length; the second axis is
  still the rule's own `subscriptionTypeIds`, not a cell.
- **A public one-line summary is unanimous or absent.** The shop card, the
  website's activity chip and the site's pricing table each have ONE cell for an
  appointment, so they state a benefit only when every length agrees and
  otherwise fall back to the price range (`resolveActivityTerms`,
  `pricingCell`). "Included with Premium" when only the 30-minute length is
  included is a lie told to a stranger.
- **Effective price for a caller** — the appointment arm of the ONE shared
  coverage/quote resolver (`resolvePaymentOptions(snapshot, { kind:
  'appointment', duration, benefit }, context?)` in
  `packages/shared/src/utils/paymentOptions.ts`, pure + fixture-tested — the arms
  are class bookings, drop-ins, appointments, courses **and products**, and the
  optional third `context` carries a typed promo code: `docs/promo-codes.md`), in
  order: unpriced → `covered` for anyone; priced + no held benefit type →
  `pay(base)` (guests always land here); priced + held + `included` →
  `covered` (or `spend_credits` when held via a pack); priced + held +
  `discount` → `pay(max(0.50, round(base × (100 − pct) / 100)))` — clamped to
  Stripe's **0.50 minimum-charge floor**, never "free via discount" (a
  `discountPercent` ≥ 100 clamps to 0.50; missing/≤ 0 falls back to base).
  A promo code competes with the benefit inside this same call, best-one-wins,
  and can only ever lower the result. Server-side resolution (snapshot via
  `loadContactPaymentSnapshot`) is authoritative — the picker runs the same
  resolver on an optimistic client snapshot for display only.

### The price is the gate — there is no access gate

An appointment has **no** access rule. Unpriced duration → **anyone books
free**, guests included. Priced → **anyone books by paying their effective
price**; holding a benefit type just lowers (or zeroes) that price. Sign-in is
never a requirement — the picker offers it purely as "have a subscription? sign
in to get your member price."

Bypass-proof in both directions: `bookAppointment` refuses a payable caller with
`{ reason: 'payment_required', priceAmount }`; `createAppointmentCheckout`
charges the CALLER's effective amount (base or discounted) and refuses with
`{ reason: 'covered' }` when the caller's effective price is free (the client
falls back to the free path) and `{ reason: 'not_priced' }` when the duration
has no price at all. The refusal shapes are unchanged from the matrix era.

### Priced per person: a party books one length together

"I come with another person, CHF 75 each" is a length whose price is PER PERSON
(`ActivityDuration.party: { min, max }`, the booker included). It is its own
length on its own offer, never a multiplier on the solo price: the studio that
sells "I come alone" at CHF 110 sells the pair at a different price. A party is
ONE booking of the provider's time, whatever its size. Decisions (Franco,
2026-09-25): companions are NAMES on the booking, never contacts; the booker's
own place takes their member price and any promo, and every companion place
pays list with the promo only.

- **One reader, one check.** `resolveDurationParty` reads the bounds (null for
  one person, and always null on a `benefit_only` length, where nothing would
  cover the people brought along). `normalizePartyRequest` checks what a caller
  asked for, and the picker and every booking callable run it, so they cannot
  accept different parties. A refusal names its reason: `party_required` is an
  older client booking a length that cannot be booked alone.
- **Priced in the resolver, place by place.** The appointment arm of
  `resolvePaymentOptions` takes `people` and prices each place through
  `applyModifiers`, then sums, so the comparator, floor and rounding are the
  solo path's own. The result is always a `pay` (companions owe), and a booker
  whose plan covers their own place is recorded on `party.bookerCoveredBy`. A
  credit pack does not pay for a party: that would be a mixed tender.
- **The party a payment bought travels with the payment.** The paid rail puts
  it in the Checkout Session's metadata (`appointments/party.ts`), and the
  webhook writes the booking's party from there, erasing it on a solo payment.
  A retry that changes the party rewrites the hold, but the older session can
  still be the one paid, and the booking must say what that money bought. The
  party is also part of the Checkout idempotency key (zero parts for one
  person), or a re-priced retry inside the key's minute is refused by Stripe.
- **The picker asks first.** "Who's coming" is its own screen before any
  identity screen, because a member whose code verifies is booked at once, and
  a party refused after that would have spent the one-time code.
- **The studio's own booking** (`createStaffAppointment`) takes the same bounds
  but optional names: a studio books a pair before it knows who is coming.

### The hold state machine — the hold IS the session

An appointment session doesn't exist until booked, so a payment must first reserve
the slot: `createAppointmentCheckout` creates the session *as* the hold, through
the same overlap-safe slot transaction the free path uses (a retry by the same
contact rewrites its own still-live hold and gets a fresh Checkout URL).

```
(none)          --createAppointmentCheckout tx--> status:'pending_payment', hold_expires_at:+30min, bookings_count:1
pending_payment --webhook confirm---------------> status:'full', hold_expires_at deleted
pending_payment --hold_expires_at <= now--------> logically FREE (lazy); swept to 'cancelled'
pending_payment --admin cancel------------------> 'cancelled' (a late payment re-acquires or refunds)
```

Booking subdoc: `{ status:'pending', payment_status:'required', expires_at }` — no
`fullname` (that's stamped only on confirm) → webhook → `{ status:'confirmed',
payment_status:'paid', payment_intent_id, fullname }`.

The slot-blocking predicate is centralised in `packages/shared/src/types/session.ts`
— `appointmentSlotBlocked(s, nowMs)` / `isExpiredAppointmentHold` — and consumed by
`listAvailability`'s busy filter, both branches of the slot transaction, and the
admin calendar. A hold whose `hold_expires_at` has passed stops blocking the slot
immediately (**lazy expiry** — release never waits for a cleaner). The cleaners
converge on the same end state:

1. **Lazy** — readers treat expired holds as free; when the slot transaction
   reclaims an expired/foreign hold it deletes stale `payment_status: 'required'`
   booking subdocs in the same transaction (else the next recount counts 2).
2. **`checkout.session.expired`** — Stripe expires the Checkout at ~31 minutes
   (7 days for a staff payment link); the webhook cancels a still-pending hold
   **that this session still owns** (session first, then the booking delete). See
   the census below: it may not cancel on presence.
3. **Daily sweep** — `expirePendingBookings` cancels expired held sessions before
   its existing bookings sweep, session first THEN booking delete, so the
   delete-triggered recount preserves `cancelled` instead of recomputing `open`.
   Composite index: `sessions (status ASC, hold_expires_at ASC)`.

Hold consumers to know about: `trackBookings` **early-returns** on
`pending_payment` sessions (else the hold's own booking write would recompute the
status and clobber the hold), and `syncSessionPublicProfile` excludes them —
**holds are never published publicly**.

### Who may release a hold — the census, and the ONE ownership rule

The session's doc id is deterministic (`apt_{providerId}_{startMs}`) and therefore
**shared by every attempt at that slot** — which is exactly what lets the slot
transaction refuse a second visitor. The cost is that "cancel the session at this
id and delete the booking under it" is an operation any attempt can perform on
**any other attempt's live, payable hold**. *Presence is not ownership.*

This was fixed once per site, from different files, and the last site was missed
twice — so the census now lives in code, beside the rule, in
**`packages/functions/src/appointments/holdRelease.ts`**.

> **THAT HEADER OWNS THE CENSUS. This document does not repeat it**, and the
> omission is the point: this page carried a copy of the table for two rounds,
> and a copy of a list is a second thing to keep true. It lists every site that
> can release, cancel or delete a hold, the proof each one rests on, and the grep
> recipe for re-deriving it. `connect/commitSites.test.ts` asserts that no caller
> of the shared executor exists without an entry there. **Read that header before
> adding a release path**, and add the entry in the same commit.

What you need from it to read the rest of this page: the sites that address a
hold by its shared id while another attempt may own it go through **one call
each** to `releaseAppointmentHold`, which proves ownership with `booking_token`
inside the transaction that deletes. Two secondary proofs carry the callers that
have no token to compare — a **lapsed deadline**, and a document that **still
presents no deadline at all** (the staff payment-link rail, which writes none so
the daily sweep leaves its 7-day link alone). A token never leaves a caller worse
off than no token: where there is nothing to compare it against, a token-holder
falls to exactly those two proofs, which is what stops a deadline-less staff hold
being stranded forever. Fixtures, one block per site:
`packages/functions/src/appointments/holdRelease.test.ts`.

**Why `handleCheckoutExpired` was the urgent one.** Wave 3 Phase 3's promo
lifecycle expires a superseded Checkout Session *at Stripe* before writing
anything, so `checkout.session.expired` for an attempt the buyer has just retried
now arrives **seconds** after the retry instead of ~31 minutes later. A rare race
became a likely one — and it was the release site still cancelling on presence.

### Webhook confirmation (`kind: 'appointment'`)

`handleAppointmentCheckout` (`connect/webhook.ts`), cases in order:

1. Booking already `confirmed` and the incoming charge is a **second** payment
   for it → `refundDirectCharge` (idempotency key `apt-dup:{pi}`) +
   `member_payments/{pi}` marked refunded. (Also the idempotent short-circuit for
   redeliveries of the same charge.) "Second payment" is
   `appointmentChargeIsDuplicate` (`shared/types/session.ts`): a **different**
   `payment_intent_id`, *or* — the case with no id to compare — a booking stamped
   `settled_offline`, i.e. one that `markAppointmentPaid` settled in cash. A
   confirmed booking with neither marker is an ordinary free or `pending_offline`
   staff booking, and the charge arriving on it is its first.
2. Live hold → **confirm in place**: session `{ status:'full', hold_expires_at:
   delete }`, booking `{ confirmed, paid, payment_intent_id, fullname }`.
3. Hold expired or session cancelled (swept, admin-cancelled, Stripe-expired) →
   **re-acquire** through the same slot transaction, rebuilding from the swept
   doc's own fields (never from metadata); conflict — slot retaken — → refund.
4. Session missing entirely → refund.

Post-confirm: the contact's `provisional` flag clears, `member_payments/{pi}`
(`kind: 'appointment'`, `sessionId`) is written with the platform fee, the finance
contact is stamped, an `appointment_booked` activity_log entry lands, and the same
booking emails as a free booking go out — from the webhook, since payment is when
the booking becomes real.

### Settling an awaiting-payment appointment at the desk

`markAppointmentPaid` (`appointments/staffBooking.ts`) is how a manager closes a
`payment_pending` appointment with money taken in person. It covers **both**
awaiting-payment modes, and the second one is the one that used to have no exit
at all:

| Mode | Written by | What settles it |
|---|---|---|
| `offline` | `createStaffAppointment({ paymentMode: 'pending_offline' })` | `markAppointmentPaid` — always did |
| `link` | `createStaffAppointment({ paymentMode: 'payment_link' })` | the Connect webhook **if the client uses the link**; otherwise `markAppointmentPaid` |

**Why the link rail needed this (UX-59).** It deliberately writes no
`hold_expires_at`, so the daily sweep never sees it and the Stripe Checkout
Session's own 7-day expiry is its only other ending — and that ending *cancels
the session and deletes the booking*. A client who paid cash at the door instead
therefore left a booking that nothing could settle and that vanished a week
later, with the money recorded nowhere. `markAppointmentPaid` refused the mode by
name and the payments dashboard did not even offer the button.

**Settling a link-mode hold takes on one extra obligation: kill the link.** The
callable expires the Checkout Session (`closeTeamCheckoutSession`, whose result
is three-valued on purpose) and reports what happened — `closed` (the ordinary
case), `paid` (the client paid online in the seconds before the call, so **no
cash row is written**: the webhook owns that money), `failed` (Stripe could not
tell us; the cash *is* recorded and the caller is told the link may still be
live, so the studio can cancel it in its own dashboard). The Checkout Session id
is stored on the session as `payment_checkout_session_id` for exactly this — a
link that cannot be named cannot be closed.

**The orderings below are load-bearing**, and both are asserted in
`appointments/deskSettlement.test.ts`:

- **Settle, then close.** Expiring a session makes Stripe deliver
  `checkout.session.expired` — census site 3, holding *this* hold's booking token,
  so its ownership proof succeeds. Closing first opens a window in which the
  studio's own settlement cancels the appointment it was settling. Past the
  settle write the session is no longer `pending_payment` and the event is inert.
- **Refuse the cash row before writing it.** The `paid` branch returns above
  `writeManualPaymentEvent`; a cash row on top of Stripe's own doubles the
  studio's revenue for one appointment.

The booking is stamped `settled_offline: true` alongside `payment_status: 'paid'`
— the seat really was paid for, so `bookingWasPaidFor` must keep saying so, and
the extra flag is what lets case 1 of the webhook refund a payment that arrives
late on a link this call could not close. It is written in the settle
transaction, as early as possible, because the case it guards is the one where a
payment may already be on its way; the `paid` outcome is the one branch that
**retracts** it, since there the incoming charge is the client's real and only
payment and refunding it would be the defect rather than the guard.

### Cancelling an awaiting-payment appointment

The other ending of the same rail, and the same obligation
(`cancelAppointmentSlot`, `appointments/cancelSlot.ts`). The manager's cancel
used to be a client-side `updateDoc(status: 'cancelled')`, which left the link
payable: the client paid days later and the webhook's **case 3 re-acquired and
confirmed the cancelled slot**. It is now a callable that closes the link.

**THE ORDER IS THE REVERSE OF THE SETTLEMENT'S, and that is the point.** A
settlement and a cancellation face the same racing `checkout.session.expired`,
and it hurts them differently:

|  | What the expiry event would do | So the order is |
|---|---|---|
| `markAppointmentPaid` | **undo** the settlement (cancel the appointment it just settled) | settle, then close |
| `cancelAppointmentSlot` | write **the same end state** (the two writers commute) | close, then cancel |

What does *not* commute for a cancellation is a **payment**: cancel first and the
window before the close is the original defect, merely shortened. So the close
goes first, and the same three outcomes are reported — `closed` (cancel
proceeds), `paid` (**refused**: the client paid, the appointment is theirs, and
the manager is told rather than left with their money and no appointment),
`failed` (cancel proceeds — Stripe being unreachable must not block a manager
clearing a slot — and the manager is told the link may still be payable).
Pinned in `appointments/cancelSlot.test.ts`; the release census entry is site 8
in `appointments/holdRelease.ts`.

Gated on `schedule.manage` with the rules' own coach own-scope, **not** on the
manager role its siblings use: this replaces a client write the rules already
allowed, and a role gate would have silently taken the cancel button away from
every coach.

### Gotchas

- **Payment auto-confirms even when `autoConfirm: false`.** A paid booking is
  written `confirmed` regardless of the activity's `autoConfirm` — the drop-in
  precedent: payment *is* the confirmation. Documented, deliberate.
- **The OTP verification code burns at checkout creation**, not at payment
  (`resolveAppointmentCaller` marks it used, single-use). An abandoned checkout
  therefore needs a fresh code for the member's next attempt.
- **30 vs 31 minutes.** The Firestore hold lives 30 minutes; the Stripe Checkout
  `expires_at` is set to **31** because Stripe's minimum is 30 minutes from the
  moment the create call *lands*. That extra minute used to be clock-skew slack
  with nothing happening inside it; since Wave 3 Phase 3 it is a **work budget**
  — the reserves and the hold transaction all run inside it — and
  `assertCheckoutWindowPayable` refuses a checkout that overspends it. The
  instant itself comes from `resolveCheckoutHoldWindow`
  (`connect/checkout.ts`), never from a local constant.
- **Stripe-create failure after the hold** is caught, and the release is
  **ownership-checked, not best-effort-on-presence**: it goes through
  `releaseAppointmentHold`, which cancels the session and deletes the booking
  only when this attempt still owns the hold. A hold that has been rewritten by
  a newer attempt is left alone; a leaked one self-heals via lazy expiry.
- **Mobile stays free-path.** The app books via `bookAppointment` only; a caller
  whose effective price is an amount gets the `payment_required` refusal (no
  mobile checkout surface yet).

## Mirrors

| Doc | Discriminator | Publish gate |
|---|---|---|
| `sessions/{id}/public_profile/{id}` | `type: 'appointment_session'` (classes: `'session'`) | appointment: `status !== 'cancelled' && status !== 'pending_payment'` (payment holds are never published) · class: `allowBooking === true` |
| `activities/{id}/public_profile/{id}` | `activityType: 'appointment'` | `isActive !== false` |

Since only **booked** appointments have a session, the only `appointment_session`
mirrors that exist are already full — which is why the public site's schedule
section lists **classes only**. Appointments reach the public as *activity* cards
that route to the picker. Appointment `appointment_session` mirrors carry **no
`accessRule`** (dropped with the access gate, `syncSessionPublicProfile`).

The activity mirror (`syncActivityPublicProfile`) carries the duration menu
`durations: [{ minutes, priceAmount }]` **and `memberBenefit`, both verbatim** —
there is no per-contact data to strip any more (the old `subscriptionPricing`
matrix is gone), and the benefit is public-safe since the referenced
subscription-type ids are already public in the shop. Public cards can show
"from CHF 45"; the picker itself never reads the mirror — it gets the same
shape from `listAvailability`.

## Where appointments appear

| Surface | Behaviour |
|---|---|
| Admin **Schedule** | Booked appointments render like any session; the **Classes / Appointments / Events** filter shows/hides them. Clicking one opens `AppointmentDetail` (bookings roster + cancel), not the session edit form. A `pending_payment` hold renders **ghosted** (dimmed, dashed border) with an amber **"Awaiting payment"** badge; an expired-but-unswept hold renders as cancelled. Cancelling a hold is safe — a late payment re-acquires the slot or refunds. |
| Admin **availability** | **`/schedule/availability`** ("Bookable hours"), reached by a named button in the Schedule header (`AppointmentAvailabilityManager`): per coach, list/add/edit/pause/delete schedules, pick their activities, and add/remove **time off**. Schedule → "+ New" → *Add bookable hours* opens the create form alone. Published hours also render as bands in the left gutter of the Schedule week grid, always — there is no availability "mode" and no availability filter chip (deleted 2026-08-17, UX-3: the manager used to hang off an unlabelled caret on that chip, and a coach testing the product never found it). |
| Public picker | `/public/{slug}/appointments` — coach → activity → duration (if >1) → day → time. 100% `listAvailability`; reads no Firestore directly. Priced durations show on the chips ("45 min · CHF 65") and route to `createAppointmentCheckout`. No gate: guests always book (pay if priced); when the activity has a `memberBenefit`, sign-in is offered — "have a subscription? sign in to check your price" — and after OTP the member sees their effective price (display-only, the server re-resolves). |
| Public site / booking flow | Appointment **activity** cards route to the picker. The schedule section is classes-only. |
| Kiosk schedule / Now-Next | Booked appointments shown — the front desk sees the day's 1:1s. |
| Kiosk walk-in | **Not offered.** Walk-in needs a discrete open slot, which no longer exists. Removed 2026-07; re-addable on `listAvailability` if wanted. |
| Drop-in | Rejected for appointments (`booking/dropIn.ts`) — `dropIn` is class-only config. Paid appointments have their own path: per-duration prices + `createAppointmentCheckout` (see "Paid appointments"). |

## Seeds

All four seeds (`seed-emulator`, `seed-sandbox`, `seed-staging`, `seed-lead`) create
an appointment activity (with a priced `durations` menu), one or more
`availability` docs, and a few **booked** appointments — never open slots, since
nothing is pre-generated. Shared builders live in `scripts/lib/appointments.ts` so
every seed emits the shape `bookAppointment` would (no `accessRule`/`isFreeTrial`
on appointment session docs or mirrors). Every seed writes the
per-length shape (`durationBenefits`) and **never** the legacy activity-wide
field, and each demos a DIFFERENT pair so a click-through meets all three
effects: **emulator** gives the top tier the 30-minute free and the 60-minute at
a flat 60 (`included` + `fixed_price`), **staging** gives it free + 25% off
(`included` + `percent_off`), **sandbox** gives monthly holders their 30-minute
check-in free and 20% off the 60-minute. A lead profile still states ONE rule and
the seeder applies it to every length — see `LeadAppointmentMemberBenefitDef` for
why that shape did not change. The legacy fallback is covered by a unit test, not
by seed data. Each generic seed also
gates ONE class with the full ordinary offer — subscription access +
`trialEnabled` + `dropIn` (MMA in emulator/staging, Advanced BJJ in the sandbox
grappling team) — and none seeds a "Drop-in" subscription PLAN any more (the
per-activity `dropIn` price is the one drop-in concept). Seeded **booked**
appointments are always free-path-shaped (`confirmed`, no payment fields): paid
bookings are not seeded, as that would require fabricating `member_payments`
ledger rows. Swimli (`scripts/leads/swimli/profile.ts`) is the richest: 3
providers, both `times` and `range` schedules, and a credit-pack `included`
benefit on the private lesson; nicole's paid 1:1 deliberately has NO benefit
(everyone pays base) while her free intro call stays unpriced.

## History / gotchas

- **2026-07 — the big one.** Appointments were "coaching": a parallel model with its
  own `coachId`, its own counters, and a daily cron that pre-generated 28 days of
  fixed slots. That generator had **no teardown** (pausing a template orphaned its
  slots) and set **no `activityId`**, so appointments were invisible to the website
  and impossible to subscription-gate. All of it was deleted in favour of the lazy,
  activity-bound model above. If you're tempted to re-add pre-generation, re-read
  "Why nothing can be pre-generated".
- **2026-07, later the same month — "the price is the gate".** The initial paid
  model gave appointments the class access gate plus a per-duration ×
  per-subscription-type `subscriptionPricing` matrix. A coach persona test
  showed both confused real users, so appointments dropped `accessRule` entirely
  and the matrix collapsed into the ONE `memberBenefit` rule (see "Paid
  appointments"). Session docs and appointment mirrors stopped carrying
  `accessRule` in the same pass; classes gained the independent `trialEnabled`
  toggle, and the seeded "Drop-in" subscription plan was removed in favour of
  the per-activity `dropIn` price.
- `instructorId`/`coachId` were unified into **`providerId`** across sessions,
  activities and availability. `Event.coachId` is a different entity and unchanged.
- The kiosk `walkInActivityIds` allowlist matches on `activityId`. Appointments now
  carry one, but walk-in still excludes them by kind — it's about the absence of open
  slots, not the allowlist.
