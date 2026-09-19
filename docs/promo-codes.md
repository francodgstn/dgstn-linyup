---
title: Promo codes
description: Promo codes — architecture
status: living
area: payments
order: 5
---
# Promo codes

A promo code is **a price modifier a visitor types at checkout**. It changes what
a purchase costs; it does not pay for one. That single sentence decides almost
everything below, because the codebase already has a coded instrument that does
the opposite — a gift card, which *pays* a price without changing it — and the
two must never be built the same way.

> **THE GOVERNING RULE.** A price **modifier** belongs in Stage A (inside
> `resolvePaymentOptions`). A **tender** belongs in Stage B (at the checkout
> callable). **Nothing may be both.**

```
STAGE A — PRICE (pure, resolvePaymentOptions)
  list price → best-one-wins(member benefit, promo) → clamp ≥ MIN_CHARGE_MAJOR
             → pay.amount

STAGE B — TENDER (impure, at the checkout callable)
  pay.amount → gift-card drawdown (planGiftCardRedemption) → residual → Stripe
```

Promo is Stage A. Gift card is Stage B. `spend_credits` is Stage A but is a
*coverage* answer, not a tender. The dividend is concrete and is the reason the
rule is worth stating twice: because the promo lives inside the resolver, every
gift-card reservation already receives a **post-promo** total and not one
gift-card call site needed editing.

The pure half lives in `packages/shared/src/types/promoCode.ts` (types + the
predicates) and `packages/shared/src/utils/paymentOptions.ts` (the comparator).
The impure half — exists / active / window / scope / caller / currency, plus the
whole reserve→commit→release lifecycle — lives in
`packages/functions/src/connect/promoCodes.ts`.

## The data model

```
teams/{teamId}/promo_codes/{CODE}                           ← the doc id IS the code
teams/{teamId}/promo_codes/{CODE}/redemptions/{identityKey} ← durable per-PERSON ledger
```

`PROMO_CODES_SUBCOLLECTION` / `PROMO_REDEMPTIONS_SUBCOLLECTION` in
`packages/shared/src/paths.ts`. Both nest under `teams/`, so **no
`tenantData.ts` registration is needed** — the completeness test classifies
top-level `*_COLLECTION` constants only and per-team teardown uses
`db.recursiveDelete`. The type file says so, so nobody adds one.

### The code is the doc id — for the dedupe, not for the secrecy

The gift card does this too, and the reasons diverge in a way that matters:

| | Gift card | Promo code |
|---|---|---|
| Doc id is the code | yes | **yes** — free case-insensitive dedupe, no lookup query, no index, no query-then-write race |
| Is it a secret? | **yes** — it is stored value | **no** — it is printed on a flyer. But the *document* still is not public: it carries `max_uses`, `usage_count`, internal labels, and listing the collection would hand a scraper every code a studio runs |
| Public read path | `checkGiftCard` | `previewPromoCode` |
| Who may write | nobody (Admin SDK, callables) | nobody (Admin SDK, callables) |
| Collision | **retry with a new random code** | **refuse** — `already-exists`, `reason: 'code_taken'` |

**The collision rule is where copying the gift card would have been a bug.** A
card's code is *generated*, so minting a different one on collision is correct. A
promo code is *chosen by a manager* — silently minting `SUMMER26-X7` when they
typed `SUMMER26` puts a code on the flyer that nobody can redeem. So
`createPromoCode` uses `.create()` and reports `ALREADY_EXISTS` as a user-facing
refusal, with no retry loop.

**Codes normalise the same way gift cards do**, and that is enforced rather than
matched: `normalizeRedemptionCode` (`packages/shared/src/utils/codes.ts`) is the
one trim-and-uppercase, and `giftCards.ts` delegates to it. It deliberately does
**not** fold hyphens — that would collide `SUMMER-26` and `SUMMER26` onto one
document. Format after normalisation is `PROMO_CODE_FORMAT_RE`
(3–24 chars, uppercase alphanumerics and hyphens, no leading hyphen), and a code
matching `looksLikeGiftCardCode` (`/^GC-/`) is refused at creation and reported
distinctly by the preview — a visitor pasting a gift card into the promo field is
a real event, and "invalid code" is the wrong answer to it.

### The definition — `PromoCode`

| Field | Notes |
|---|---|
| `code`, `teamId`, `status` | `status: 'active' \| 'disabled'`. A code is never deleted — see "Disabling" |
| `effect`, `percent`, `amount` | `percent_off` (integer 1–99) or `fixed_price` (major units ≥ `MIN_CHARGE_MAJOR`). No `amount_off` |
| `currency` | stamped at creation from `giftCardCurrency(team.default_currency)`; guarded at reserve time for `fixed_price` **only** |
| `valid_from`, `valid_until` | both optional, both ends **inclusive** (`promoWindowOpen`) |
| `max_uses` | **required at creation.** `null` means unlimited and must be chosen explicitly |
| `max_uses_per_contact` | absent ⇒ `PROMO_DEFAULT_MAX_USES_PER_CONTACT` (1); explicit `null` ⇒ unlimited |
| `restrict_to_contact_id` | bind the code to ONE person — the service-recovery shape |
| `audience` | `'all' \| 'new_contacts'`, absent ⇒ `'all'` (stamped explicitly at creation so a stored doc is self-describing) |
| `usage_count` | **committed** redemptions. One writer, absolute writes — see "One writer" |
| `applies_to`, `activity_ids`, `course_ids`, `product_ids` | which rails, then optionally which entities |
| `reservations` | **live reservations only**, keyed deterministically, each carrying the `instanceId` of the attempt that owns it and the `sessionId` of the ONE Checkout Session that may be paid against it. There is no `committed` map |
| `label`, `created_*`, `disabled_at` | audit |

**There is deliberately no `committed` map on the document, and that is a size
decision.** Firestore's 1 MiB limit is a hard wall with a nasty property: once
crossed, reserve, commit **and** release all fail with `INVALID_ARGUMENT`, so the
code becomes unredeemable *and* unrepairable — disabling it is also a write to
that document. The gift card is safe from this by accident of its own semantics
(a card's finite balance bounds how many `committed_holds` it can accumulate);
`max_uses: null` is a supported configuration here, so a permanent `WELCOME10` on
a busy shop would have wedged itself. Committed history lives in the
`redemptions` subcollection — one document per person — and live reservations are
capped at `PROMO_MAX_LIVE_RESERVATIONS` (25). Worst case is about 5 KB, for any
campaign, forever.

### The ledger is keyed by IDENTITY, not by `contactId`

```ts
promoIdentityKey({ email, contactId }, sha256Hex)
// email present → 'e_' + sha256(lowercase(trim(email))).slice(0, 32)
// else           → 'c_' + contactId
```

On the two rails a guest can reach, the contact document is minted **by the
visitor, for free, at purchase time**: `createDropInCheckout` reuses an existing
contact only on an exact `teamId + email + lowercased firstname + lowercased
lastname` match and otherwise creates one, and
`resolveOrCreateAppointmentContact` matches on email alone. Keying the cap on
`contactId` would therefore have made "once per person" mean "once per
(email, exact name) tuple" — "Ann Smith" and "A. Smith" are two people — while
App Check is monitor-only by default, so the probe is scriptable.

It is hashed so the ledger's **doc ids** are not a harvestable list of a studio's
customer emails, and hex so the id is always safe as a Firestore doc id, a map
key and a `FieldPath` segment.

**What this does and does not buy, stated so nobody over-claims it again:**

- **It does** bind across the name-spelling evasion, across a contact document
  deleted and recreated (`purgeProvisionalContacts` runs nightly), and across the
  same person arriving signed-in on one purchase and as a guest on the next.
- **It does not** make the cap unforgeable. A second mailbox, or a `+1` alias, is
  a different identity.

That residual is in the admin copy rather than hidden: `PromoCodes.perContactHint`
reads *"Counted per email address. Pair a public code with a total limit."* The
cap is a **nudge with teeth, not a promise**, and the total cap is the thing that
actually bounds liability — which is why `max_uses` is a required field.

`clearPromoRedemption` accepts `{ code, contactId }` **or** `{ code, email }` and
resolves the same key from either.

### Plan caps

`PROMO_CODE_LIMITS`: `free` 0 · `coach` 0 · `studio` 20 · `organization` 100,
in the shape of `PRODUCT_LIMITS`. Zero on free/coach is the same statement as the
`requirePlan(teamId, 'studio')` gate, expressed as data so the admin page renders
"4 of 20" without a second rule. Free inherits Coach, which is why Coach is zero:
a hobbyist at the free contact cap running discount campaigns is not a real persona.

**Gates control creation only.** `requirePlan` is called by `createPromoCode` and
by nothing else. A team downgraded to `free` keeps its live codes previewable,
reservable, committable and releasable.

## Which rails take a code

| Rail | Callable | Promo? |
|---|---|---|
| Class drop-in | `createDropInCheckout` | **yes** |
| Appointment | `createAppointmentCheckout` | **yes** |
| Course (purchase tier) | `createCourseCheckout` | **yes** |
| Product | `createProductCheckout` | **yes** — required the new `product` resolver arm |
| **Waitlist claim** | `createDropInCheckout({ waitlistToken })` | **no** — see "The waitlist claim" |
| Paid trial | `createDropInCheckout({ trial: true })` | **no** — a trial is already an acquisition price |
| Membership, one-off | `createMembershipPayment` | **no** |
| Membership, recurring | `createMembershipCheckout` | **no** — a modifier on a Stripe subscription is a Stripe *coupon*, not an amount we compute |
| Gift-card purchase | `createGiftCardCheckout` | **no** — a discount on stored value mints value the studio was not paid for |
| Free `bookSession` | — | **no** — nothing to discount |

`PROMO_TARGETS` in `paymentOptions.ts` is the enumeration, and `class_booking`'s
absence from it is load-bearing beyond tidiness: it guarantees a promo can never
reach the arm whose denial is cast unchecked to `BookingAccessDenialReason`.

**The `product` arm was a debt this feature had to repay.** `createProductCheckout`
priced merchandise outside `resolvePaymentOptions` entirely, and a promo on
merchandise cannot exist without fixing that. The arm never covers and never
denies — its effect set excludes `included` and `spend_credits`, there is no free
product tier and no product denial — so it returns exactly one `pay` option,
always, which is a falsifiable invariant rather than a behaviour to remember. It
resolves with `GUEST_SNAPSHOT`: the arm is snapshot-*invariant* by construction,
so loading the buyer's subscription facts would be reads that cannot change the
answer. Two fixtures pin the invariance, so if `Product` ever gains a benefit the
test fails before anyone ships a benefit that silently never applies.

## Best-one-wins, and the deliberate asymmetry

The settled decision is **never stacked**: `appliedBenefit` and `appliedPromo`
stay mutually exclusive on the wire. "Best" means **the lowest amount the visitor
pays today** — not the largest percentage, not the newest rule.

One clamp-and-round site, `priceAfterModifier`, serves both modifiers:

```
percent_off : pct >= 100 ? MIN_CHARGE_MAJOR
            : max(MIN_CHARGE_MAJOR, round2Major(base * (100 - pct) / 100))
fixed_price : max(MIN_CHARGE_MAJOR, amount)
malformed   : null  →  NOT APPLIED, never "applied as zero"
```

`applyModifiers` is the comparator. Its incumbent **starts at `base` and is only
ever lowered**, which is what makes "a modifier never raises a price" true by
construction rather than by a check somebody can forget. And the comparison is
**deliberately asymmetric**:

- a **benefit** applies, and stamps `appliedBenefit`, whenever it does not RAISE
  the price — `benefitPrice <= base`;
- a **promo** applies, and stamps `appliedPromo`, only when **strictly lower**
  than the incumbent.

The asymmetry has a reason, not a preference. `appliedBenefit` answers *which
membership priced this booking* — provenance, read downstream by `/manage/pricing`
for the member badge and by `createAppointmentCheckout` for the booking's
`subscription_type_id`. `appliedPromo` answers *did a code change the price* — an
event. A benefit set exactly at base **did** price the booking; a promo at exactly
base changed nothing. A symmetric "strictly lower everywhere" rule would have
silently blanked the member badge and the booking's `subscription_type_id` for
every studio using a base-priced placeholder benefit.

Consequences worth naming, each of which would otherwise be a separate rule:

1. A `fixed_price` benefit **above** base no longer charges the member more than
   the list price. That was a live bug, authorable through the benefit editor
   today, and it is fixed by the same comparator the promo needed.
2. A `fixed_price` benefit **exactly at** base still stamps `appliedBenefit`.
3. A `fixed_price` promo above or exactly at base never applies — `superseded`,
   and no struck-through price identical to the charged one.
4. A promo exactly equal to the member price loses; the member is never told
   their membership stopped mattering.
5. **A promo that beats a benefit still records which benefit it beat**, on
   `appliedPromo.supersededBenefit`, so a campaign never blanks a studio's
   subscription attribution. `subscription_type_id` is stamped from
   `appliedBenefit?.subscriptionTypeId ?? appliedPromo?.supersededBenefit?.subscriptionTypeId ?? null`.

**Coverage beats every promo.** `covered` and `spend_credits` are coverage
answers, not prices, and they short-circuit before any comparison exists — so a
promo on that path reports `not_needed`, never `superseded`. That distinction is
not cosmetic: it is the difference between "your member price is already lower"
and "you can book this without paying at all".

### What the visitor is told when their code loses

This is the whole reason `PaymentOptionsResult.promo` exists. Every outcome has
one message and one visible price.

| `promo.status` | When | Copy key |
|---|---|---|
| `applied` | strictly lower than base and benefit | `Promo.applied` + the discount row |
| `superseded`, `by: 'benefit'` | a member benefit was as good or better | `Promo.supersededByBenefit` |
| `superseded`, `by: 'base'` | the list price was as good or better | `Promo.supersededByBase` |
| `not_needed` | the caller is `covered` / `spend_credits` | `Promo.notNeeded` — **preview only** |
| `not_applicable` | the arm takes no promo, the code is out of scope, the modifier is malformed, **or the arm DENIED** | `Promo.notApplicable` |

`by` is a **discriminator carried out of the resolver**, not something the client
re-derives from `appliedBenefit`: one question must have one answer, and
re-deriving it on the client is that rule broken in miniature.

The fourth cause of `not_applicable` — a denial — matters more than it looks. The
arm can return zero options (`guest`, `no_subscription`, `sign_in_required`,
`trial_used`, `limit_reached`), leaving no price for a code to modify. The
obvious implementation reports `not_needed` there, which tells a visitor who was
just **refused** that they can have the thing for free.

`not_needed` is a **preview** outcome and unreachable at checkout: every one-off
callable refuses a covered caller before the pay option is read, so the visitor
who becomes covered between preview and pay sees the coverage refusal each
surface already maps.

> **A code that does not apply is REPORTED, never silently charged, and never
> blocks the purchase.** A checkout refuses only when the client asserted a price
> Stage A did not produce.

**A losing promo consumes nothing.** No reservation is taken unless the code
actually won, so a member typing a code out of curiosity does not burn a use of a
50-use campaign.

## The 0.50 floor

The rule, from `packages/shared/src/utils/money.ts`: **authored prices below the
floor are a configuration error and THROW; arithmetic-derived prices CLAMP UP and
are never free.** `requireChargeableAmountFromMajor` is the throwing half;
`Math.max(MIN_CHARGE_MAJOR, …)` inside the resolver is the clamping half.

| Case | Behaviour |
|---|---|
| 25% off 40.00 | `30.00` |
| 95% off a CHF 8 drop-in (→ 0.40) | **clamps** to 0.50; the breakdown shows it |
| `percent: 100` | **not expressible** — `createPromoCode` refuses outside 1–99 |
| `percent` ≤ 0, missing **or non-finite** | not applied; falls back to base |
| `fixed_price` below 0.50 | **throws at creation** |
| `fixed_price` above list | not applied — `superseded` |
| Rounding | `round2Major`, half-up on the IEEE-754 float — so 15% off 33.30 is `28.304999999999996` and rounds **down** to `28.30`. Pinned by a fixture rather than by prose |
| Currency | `percent_off` has none, so no guard. `fixed_price` is an authored money amount compared case-insensitively at reserve time; mismatch is `promo_currency_mismatch` |

**A promo can never produce a zero total.** `percent` caps at 99 and every derived
price clamps, so there is no promo-only no-Stripe-session branch; the only
payment-less confirm path remains the gift card's full cover.

**The two 0.50 floors never meet, and that is the point.** The PRICE floor clamps
a derived price *up* inside Stage A. The CHARGE floor protects a residual by
*shrinking a drawdown* in Stage B (`planGiftCardRedemption`). Borrowing the second
for the promo would create money from nothing.

## A promo code AND a gift card on the same purchase

The case a user hits on day one. A drop-in listed at CHF 40, a 25% code, a card
holding CHF 20:

```
Drop-in                        40.00
Code AUTUMN25 (−25%)          −10.00      ← Stage A
Subtotal                       30.00
Gift card GC-XXXX-XXXX        −20.00      ← Stage B
Total                          10.00
```

Two edge interactions, both resolved by the ordering and neither needing new code:

- **The card covers the post-promo total** → `residual === 0` → the existing
  full-cover branch records the sale with no Stripe session, and **commits the
  promo in that same branch**. That is the only place the redemption can be
  recorded, because no webhook will ever fire for it.
- **The card would leave a residual below 0.50** → `planGiftCardRedemption`
  shrinks the *drawdown* and leaves a 0.50 residual. The promo is untouched: it
  already did its work in Stage A.

## Redemption integrity

### The ownership rules — all consequences of the deterministic key

> **THIS NUMBERED LIST IS THE DEFINITION.** `CLAUDE.md`, the header of
> `connect/promoCodes.ts` and every other summary point HERE and restate none of
> it. That is not tidiness: the heading once said *four* while five were numbered
> under it, `CLAUDE.md` said *three*, and `promoCodes.ts` said *three* while four
> were lettered — three summaries of one list, disagreeing with the list and with
> each other. A list that is copied is a list that rots, so it is now written
> once and referred to.

The reservation key is derived from `(code, identity, target)` and nothing else,
which is what makes a retry a refresh rather than a second use. That property is
load-bearing and has to survive; its cost is that a key is *not* a handle on a
particular attempt. The rules below pay that cost, and each one was a live bug in
this phase before it was written down.

1. **A reservation is TAKEN only when the resolver said `applied`.** A code that
   loaded fine but lost best-one-wins — a member whose own benefit beats the
   public code, who typed it anyway — reserves nothing.
2. **Checkout metadata is stamped IF AND ONLY IF a reservation was taken.** This
   is structural: `reservePromoRedemption` returns a `PromoReservationTicket`,
   there is no other way to mint one, and `promoCheckoutMetadata` takes the
   ticket rather than the loaded attempt. So the webhook can never commit a
   reservation that does not exist — which would consume a global use *and*
   permanently burn that buyer's per-person cap for a discount they never got.
   (It did exactly that: the stamp used to gate on "a modifier was built".)
3. **An entry is REMOVED only by the instance that wrote it** — or by lazy
   expiry, or by the manager lever. Every attempt at one purchase addresses the
   same map entry, so without this a stale sibling's expiry, or a later failed
   retry, deletes the reservation guarding a *still-payable* session and the cap
   can be exceeded. `PromoReservation.instanceId` is a fresh random marker minted
   by every reserve — including a refresh, which is how ownership MOVES to the
   newest attempt — and release and commit compare it **inside** their
   transaction against the entry they are about to delete.

4. **A SLOT IS SPENT ONCE.** Ownership decides more than deletion. Every retry
   mints a *new* Checkout Session while refreshing the *same* entry, and Stripe
   will take money for any session that has not expired — so one reservation can
   sit behind several payable sessions at once. On the drop-in and appointment
   rails a second payment is a duplicate the webhook refunds, but on the product
   and course rails it is a second genuine order, and each one used to commit a
   use: `usage_count` and `PromoRedemption.count` both past their caps, nothing
   failing, nothing logged. Q9 is *refuse, never over-issue*, so that is the
   invariant broken rather than a residual to accept. The commit therefore spends
   the slot only when it still holds it — and treats an entry that has *vanished
   inside its own claim window* as taken, not lapsed, because otherwise the
   opposite payment ordering walks through the same hole.

5. **A SLOT BACKS AT MOST ONE PAYABLE SESSION.** Rule 4 bounds how many *counted*
   uses a slot yields; it runs after the money has moved, so on its own it cannot
   bound how many *discounted orders* a slot yields — and on the product and
   course rails those are real sales, not duplicates. So the bound sits on the
   thing that takes money. `PromoReservation.sessionId` names the session the slot
   is currently backing, and three things keep that to one:

   - a **refresh CLOSES** that session at Stripe (`checkout.sessions.expire`)
     *before writing anything*. `paid` ⇒ refuse `promo_purchase_paid` — the money
     moved on that session, so it owns the slot and its commit must still count.
     `failed` ⇒ refuse `promo_busy` — Stripe could not tell us whether a payable
     session is still out there, and assuming it is dead is the assumption that
     costs a use. Both refusals write nothing, so the previous owner keeps the
     slot;
   - the reserve transaction **compare-and-sets** on that session id, because the
     close is a network call and therefore outside the transaction. A sibling that
     bound a session in between makes this attempt `promo_busy` rather than a
     second live session;
   - `bindPromoCheckoutSession` **attaches the new session under the instance
     check**, and closes the session it just created if the slot has moved on. The
     URL is the last thing a callable returns, so a session closed there was never
     reachable by a buyer.

   **The customer-facing trade is named rather than discovered:** a buyer with an
   older Stripe page still open in another tab loses it the moment they retry —
   the newest attempt wins and the older page reports an expired session. That is
   the same trade Stripe's own "expire the abandoned cart" pattern makes, and the
   alternative is two live discounted carts for one slot, which is the breach.

Rule 3 deliberately is not "make the key unique": that would destroy the refresh
property. The key says *which slot*; the instance says *whose attempt is holding
it right now*; the session id says *which session may take money for it*. The one
exemption is `releasePromoReservations` (the manager lever), which is precisely
the operation no instance owns.

Fixtures for all of it: `connect/promoLifecycle.test.ts`.

#### The census — every site that removes a reservation

**THIS TABLE OWNS THE PROMO-RESERVATION CENSUS.** Nothing in the source repeats
it; comments at the sites point here. (Its twin, the appointment-hold census, is
owned by the module header of
`packages/functions/src/appointments/holdRelease.ts` — and nothing here repeats
that one either.)

Rule 3 is only true if *every* remover expresses it. Written down because the
sibling census on the appointment rail was fixed at two sites and missed at the
third; re-derive this one with
`grep -rn "releasePromoReservation\|releaseAllPromoReservations\|decidePromoCommit" packages/functions/src`.

| # | Site | How the entry leaves the map |
|---|---|---|
| 1 | `createDropInCheckout`'s guard (`booking/dropIn.ts`) | `releasePromoReservation` with **our ticket's `instanceId`** |
| 2 | `createAppointmentCheckout`'s guard (`appointments/checkout.ts`) | ditto |
| 3 | `createProductCheckout`'s guard (`connect/payments.ts`) | ditto |
| 4 | `createCourseCheckout`'s guard (`connect/payments.ts`) | ditto |
| 5 | `handleCheckoutExpired` → `releasePromoFromMetadata` (`connect/webhook.ts`) | ditto, from `md.promoInstance` — **the primary release path**, on positive evidence the session can never take money again |
| 6 | `commitPromoRedemption` (`connect/promoCodes.ts`) | **spends** the slot: the same instance check, plus its own claim window, then deletes |
| 7 | `reservePromoRedemption`'s refresh | ownership **moves** to the newest attempt rather than being freed — the refresh property, and why the key must stay deterministic |
| 8 | lazy expiry inside `promoLiveReservations` | the **deadline** — every transaction that already holds the document drops stale entries; there is no sweep job |
| 9 | `releasePromoReservations` (manager lever) | **deliberate exemption** — "drop every claim on this campaign" is the one operation no instance owns. It never writes `usage_count`, and its consequences are priced in "What is bounded, and the residuals" |

Sites 1–6 all pass through `decidePromoRelease` / `decidePromoCommit`, so the rule
has ONE expression rather than one per row. That is the same shape the appointment hold now
uses (`decideAppointmentHoldRelease` + `releaseAppointmentHold`,
`packages/functions/src/appointments/holdRelease.ts`) — one ownership rule, one
executor, one census — and the two are cross-referenced deliberately: they are the
same design decision applied to two finite things that share one deterministic
address.

### The pipeline at a checkout callable

```
1  load the promo (impure)     exists · active · window · scope · caller · currency
                               FAILS → NO modifier + a reason. NEVER a throw.
2  resolve Stage A             pure, free, no side effects
3  quotedAmount guard          the client's asserted price vs payOption.amount
4  capacity / eligibility      all NON-MONEY gates (drop-in)
5  IF the promo won → RESERVE  close the superseded session, then the cap
                               transaction (compare-and-set on that session id)
6  reserve the gift card       against pay.amount
7  full cover ? record : Stripe(residual)
8  BIND the session to the slot before the URL is returned; a bind that cannot
   happen closes the session it just created and refuses
   — steps 5..8 run inside ONE guard; any throw releases what was reserved,
     in reverse order: gift card, then promo
```

**Why the reserve sits at step 5 and not step 3.** None of the non-money gates has
a release path — nothing is reserved above them. A visitor with a 10-use flyer
code clicking Pay on a *full* class would have burned a use and, because the
reservation is keyed to her own identity, barred herself from the code on any
other class for the whole window. Ten such clicks would exhaust a campaign without
a sale.

**Why the promo is still reserved before the gift card.** The gift-card
reservation is computed against `pay.amount`; if the promo reservation could fail
*after* it, the drawdown would have been reserved against a price that no longer
applies.

**Why steps 5–7 are one guard rather than a list of catches.** The set of throw
sites between the reserve and the return is larger than it looks and grows with
the code — three inside `reserveGiftCardDrawdown` alone, plus two booking
transactions, the Stripe create, and `runAppointmentSlotTransaction`, which used
to sit *outside* the appointment rail's try/catch so two visitors racing one slot
with the same code stranded the loser's reservation. It is now inside the guard.
Enumeration is the wrong shape; **every path from the reserve to the successful
return goes through one guard** is the right one.

**But "inside the guard" is not the same as "everything above it is mine to
undo", and getting that wrong is worse than the bug it fixed.** The appointment
session's doc id is deterministic and SHARED (`apt_{providerId}_{startMs}`) —
that is exactly why `runAppointmentSlotTransaction` can refuse a second visitor.
So when it throws "this time was just taken", the document sitting at that id is
the **winner's** live hold, and a rollback that cancels `sessionRef`
unconditionally takes a slot away from somebody who successfully booked it, at
the request of a concurrent loser. The guard therefore answers two different
questions:

- **the slot hold** is released only when we ACQUIRED it (the transaction
  returned) — "we never got it" and "we got it and then failed" are different
  states, and only the second is ours;
- **the promo reservation** is released whenever we took one, including when the
  slot transaction is what threw: it is ours by construction (its key is derived
  from this caller's identity and this target) and stranding it is what makes a
  lost race cost the campaign a use for no sale.

`decideAppointmentCheckoutRollback` is that distinction as a pure function, so
the losing-racer path is pinned by a fixture rather than by this paragraph.

**Neither answer is an instruction to delete, and that is the second half.**
"We acquired it" and "it is still ours" are different facts, because
`allowRewriteByHolder: contactId` deliberately lets one contact's *second* attempt
rewrite its own still-live hold — the retry path. So attempt A can hold the slot,
attempt B rewrite it, and A then fail and cancel the session B's live, payable
Stripe session is guarding. **Two rollbacks, one ownership rule:** each proves the
thing at the shared address is still the one *it* wrote, inside the transaction
that deletes it — the promo by `instanceId` (`decidePromoRelease`), the hold by
`booking_token` (`decideAppointmentHoldRelease`), both treating a missing document
as not-ours and over-holding until its own deadline. The race pre-dates promos;
what Phase 3 changed is that a sibling attempt failing while a newer one holds the
slot went from an accident to a **designed** outcome, since the promo lifecycle
refuses losing attempts on purpose (`promo_busy` from the compare-and-set, and
from a bind whose slot moved on).

### `quotedAmount` — scoped to a code, one-sided, and recoverable

Every one-off checkout callable accepts an optional `quotedAmount` (major units,
the figure the surface actually rendered) and compares it to `payOption.amount`.
**Higher than shown** → refuse `failed-precondition` with
`{ reason: 'price_changed', amount, promoRefusal? }`. Absent → proceed. The
optional `promoRefusal` names the typed code's own verdict when there is one, and
is what stops the visitor being told the price moved when it did not — see the
refusals section below.

**It is scoped to promo-carrying checkouts.** `assertQuotedAmount` takes a
required third argument,
`scope: { promoAttempted: boolean; promoRefusal?: string | null }` — the first
required so no call site can be silently in or out of scope — and returns early
when no code was typed. `promoAttempted` means *a code was supplied*, never *a code won*: gating on
"won" would switch the guard off in precisely the case it exists for, where the
client thought the code applied and the server says it did not.

The reason is that off the promo path **the client's number is not a quote**. The
public surfaces price from an optimistic snapshot documented as partial — the
contact session carries only the *primary* `subscription_type_id`, every held id
is reported unmetered, `joined` is assumed, and the shop fetches its catalogue
once with no listener — while the server loads the real thing. The two are two
implementations of one resolver and are **allowed to disagree**. Enforcing the
quote everywhere turned those divergences into refused sales, and not transiently:

- a member whose primary type is a **credit pack with 0 remaining** that is listed
  in the activity's `memberBenefit` — the client counts it as held so the benefit
  applies (32.00), the server sees `remaining: 0` so it does not (40.00). Refused,
  and refused identically on every retry;
- a studio that **raises a product or course price** while a shop tab is open —
  that tab re-quotes the old figure for as long as it stays open.

Neither buyer typed a code, and neither was promised the lower figure by anything
but an optimistic render. A code is what makes the figure a promise — "Code X
applied", a struck-through base, a discount row — and a server that then charges
list price breaks it. That is the case the guard was built for, and the only one
where its refusal tells the visitor something true and actionable.

**It is one-sided**, and that asymmetry is a separate decision. A member whose
benefit comes from a **secondary** held type is quoted base by the client and the
discounted price by the server — routinely, with nothing wrong anywhere. Under a
strict `!==` she would be told "the price changed" and the studio would lose the
sale for being cheaper than advertised. Being charged **more** than the screen
said is the harm; being charged less needs no consent.

**The refusal is recoverable, and that is part of the contract.** A promo-carrying
checkout meets the same divergences, so the guard can still fire on a purchase
where nothing is wrong — and a client that simply re-renders re-derives the same
optimistic figure and is refused again: refuse, re-render, refuse, with no path to
the real price. So the throw carries the server's own `amount`,
`priceChangedAmount(err)` (`components/booking/PromoCodeField.tsx`) is the single
reader of it, and every mount stores it as `acceptedPrice`, which becomes **both**

- what the surface renders from then on — the discount rows and the struck-through
  base drop, because the server has just declined to honour them, and leaving them
  over a higher total is the same broken promise the guard refuses; **and**
- what the next submit sends back as `quotedAmount`.

The two then agree and the sale completes. `Promo.priceChangedTo` names the
figure; `Promo.continueAtPrice` labels the button on the surfaces that own one
(the shop modal, the appointment member-pay screen), so pressing it *is* the
consent. A refusal a buyer cannot act on is a lost sale, not a safety feature.

### The reserve — one owner of the cap decision

`reservePromoRedemption` runs `decidePromoReservation`, a pure function of one
read set so the ordering that makes it correct is testable without an emulator.

**Read set — two document `get`s by id, no query, no index:**

```
tx.get(promoRef)                                          teams/{t}/promo_codes/{CODE}
tx.get(promoRef.collection('redemptions').doc(identityKey))
```

Because both reads are single documents fetched by id, the transaction is
serializable under *both* readings of the phantom-read question Phase 2 had to
leave procedurally open — there is no query in it to be phantom about. That is a
design choice, not a coincidence: counting a `redemptions` subcollection with a
query would have dragged that question back in.

**And ONE Stripe call before the transaction**, which is not decoration: if the
slot is already backing a session, that session is CLOSED first, and a close that
cannot be trusted refuses the reserve outright. It is outside the transaction
because it is a network call, and it is BEFORE any write so that every refusal
leaves the previous owner's entry exactly as it stands.

```
PRE-FLIGHT (no writes yet)
  prev = live[reservationKey] from a plain get
  if (prev?.sessionId) close it at Stripe:
      'closed' → carry expectedSessionId = prev.sessionId into the tx
      'paid'   → failed-precondition promo_purchase_paid   ← the money already moved there
      'failed' → resource-exhausted  promo_busy            ← we do NOT know it is dead

TRANSACTION
promo missing / teamId mismatch      → not-found           promo_not_found
status !== 'active'                  → not-found           promo_inactive     (same copy — never leaks)
!promoWindowOpen                     → failed-precondition promo_expired
!promoAllowsCaller  (bound)          → not-found           promo_not_found    ← identity BEFORE scope
!promoAllowsCaller  (audience)       → failed-precondition promo_audience_mismatch
!promoAppliesTo(scope)               → failed-precondition promo_not_applicable
fixed_price && currency mismatch     → failed-precondition promo_currency_mismatch

live  = promoLiveReservations(promo, now)   ← expired entries dropped here, in this tx
mine  = live[reservationKey]

REFRESH  — checked FIRST, so no cap can refuse a purchase already in flight
   if (mine):
       COMPARE-AND-SET  mine.sessionId !== expectedSessionId
                                        → resource-exhausted  promo_busy
       else → rewrite expires_at / amountMajor / baseAmount, sessionId = null,
              fresh instanceId, and RETURN. Consumes nothing.

GLOBAL CAP           left.global <= 0            → resource-exhausted  promo_exhausted
LIVE-RESERVATION     left.liveTotal >= 25        → resource-exhausted  promo_busy
PER-PERSON CAP       left.perIdentity <= 0       → failed-precondition promo_already_used

AFTER THE STRIPE SESSION EXISTS
  attachPromoCheckoutSession — instance-guarded; on failure the just-created
  session is closed and the checkout is refused promo_busy, so no payable URL is
  ever returned for a slot nothing is holding.
```

**The identity gates run BEFORE the scope check, and the order is load-bearing**
— in `loadPromoForTarget` and in `decidePromoReservation` alike. A code bound to
somebody else must report the secretive refusal rather than a `not_applicable`
that would confirm to a guesser that the code is real *and* tell them which
items it is for. Inside `promoAllowsCaller` the same logic repeats one level
down: the binding is checked first, then the audience.

**`promoUsesLeft` is the single expression of BOTH caps**, and the reserve
transaction, the preview callable and the admin list all call it against the same
fields. So "the last use is reserved but not yet paid" is answered once rather
than three times. Splitting it into a global helper plus an inlined per-person
test is the defect wearing the fix's clothes.

**The reservation key is DETERMINISTIC**, and that is what makes a retry a
refresh. Each reserve also mints a fresh `instanceId` onto the entry — see
"The ownership rules" above; it is what a later release or commit must match
before deleting anything, and it is returned to the caller as the
`PromoReservationTicket` that everything downstream requires.

```
promoReservationKey({ code, identityKey, targetKey }, sha256Hex)
  = sha256([code, identityKey, targetKey].map(p => `${p.length}:${p}`).join('|')).slice(0, 32)

targetKey per rail (promoTargetKey):
  drop_in      drop_in:{sessionId}
  appointment  apt:{providerId}:{startMs}:{durationMinutes}
  course       course:{courseId}
  product      product:{productId}:{variantId ?? ''}
```

The preimage is **length-prefixed, not merely joined**, and that is not
pedantry: a bare `a|b|c` hashes `('AB','x|y','t')` and `('AB','x','y|t')`
identically, merging two *different* purchases onto one reservation — and it is
reachable, because `targetKey` embeds a product's client-generated `variantId`.

So **one person holds at most ONE reservation per (code, target)**. A retry
refreshes their own and consumes nothing; it can never take a second slot from
either cap, and the map cannot grow per retry. Without this, an ordinary Back
button on a `max_uses_per_contact: 1` code refused the buyer with "You have
already used this code" for a purchase she had never completed. The codebase had
already solved this shape forty lines away — `countHoldingSeats(docs, now,
contactId)` excludes the caller's own seat hold for exactly the same reason.

**`tx.update`, never `set(…, { merge: true })`.** A merge deep-merges the map and
resurrects every expired key the transaction just dropped, so cleanup would never
persist. The gift card documents this trap in three places.

**The promo document is a hot document while a campaign runs**, and that is
correct behaviour rather than a bottleneck — a promo code is not a flash sale. If
a tenant ever runs a code across a burst larger than a few writes per second, the
remedy is more codes, not a sharded counter. Recorded so nobody optimises it
speculatively.

### The commit — one writer, at the confirm point

> **ONE WRITER OF `usage_count`, EVER.** `commitPromoRedemption`'s transaction is
> the only code that writes `PromoCode.usage_count` or `PromoRedemption.count`
> after creation, and it writes an **absolute** value computed from its own read
> set. **No `FieldValue.increment` touches either field anywhere.**

> **A USE IS CONSUMED BY A COMPLETED SALE, NEVER BY AN ATTEMPT — AND BY EACH
> RESERVATION SLOT AT MOST ONCE.**

The commit is called from the per-kind **confirm points** and the **gift-card
full-cover branches**, and nowhere else. The full-cover branches are
`createDropInCheckout`, `createProductCheckout` and `createCourseCheckout` — one
per rail that takes a gift card at all. The appointment rail has none, because
appointments take no gift card by design, which is also why nothing there can
ever be fully covered. **That tally is asserted against the source** in
`connect/commitSites.test.ts` rather than restated in prose: this sentence
claimed *two* for a whole phase, and was "fixed" twice on the wrong copy.

| Path | Where |
|---|---|
| Product, paid | `handleProductCheckout` — never refunds; its early returns leave the payment standing |
| Course, paid | `handleCourseCheckout` — same |
| Drop-in, paid | `handleDropInCheckout`, **after** the confirm transaction and past both refund branches |
| Appointment, paid | `handleAppointmentCheckout`, after `confirmed = true` and past both refund branches |
| Gift-card FULL COVER | inside the branch that records the sale (`createDropInCheckout`, `createProductCheckout`, `createCourseCheckout`) — no Stripe session exists, so no webhook will ever run |
| **Never** | `handleCheckoutCompleted`, before the per-kind dispatch |
| **Never** | `commitGiftCardDrawdown` |

**Why not before the dispatch, which is the obvious spot.** Four branches inside
the dispatch are **system-initiated full refunds** — a duplicate drop-in charge, a
class that filled after checkout, a duplicate appointment charge, an appointment
whose slot was retaken. A commit placed above them has already run when they fire:
the buyer ends with no seat, no charge, and a code they can never use again, and
the studio's campaign is down a use. The gift card's answer to exactly this is a
compensating reversal twenty lines away — but a promo reversal would be a **second
writer of `usage_count`**. Committing at the confirm point needs no reversal at
all, because the reservation simply lapses.

**Why not on `commitGiftCardDrawdown`**, where a `promoRedemptionId` rider was
declared for a whole phase before being deleted: that function returns early for a
card with nothing left to commit, returns early again for an `admin_comp` card,
and — decisively — only runs at all when a gift-card code was supplied. A promo
used *without* a card, the overwhelmingly common case, would never commit its
reservation: the discount given, the count never moved, no error and no alarm.

**A completed checkout spends the slot only while it still holds it.** This is
ownership rule 4, and it is the difference between "a use is consumed by a
completed sale" and "a use is consumed by every completed sale that ever quoted
this code". The three states are read off the promo document plus two metadata
keys the session carries (`promoInstance`, `promoExpires` — both minted from the
reservation ticket, so neither can exist without a reservation behind it):

| At commit time | Outcome |
|---|---|
| A live entry at our key, carrying **our** instance | **Spend it** — count, and delete the entry |
| A live entry at our key, carrying **another** instance | Count nothing, touch nothing. A newer attempt at this same purchase holds the slot and its session is the one entitled to it |
| **No** entry, and our own claim was already due to lapse | **Count** — Stripe cannot take money for an expired session, so this payment was made while the session was open, and with one payable session per slot that session was the slot's |
| **No** entry, inside our own claim window | Count nothing. Something took the slot: the sibling that already spent it, a sibling's failure path, or the manager's release lever |
| Counting would push either counter past its cap | **THE CAP GATE.** Count nothing, write nothing, log at ERROR — see below |

The third row is why `promoExpires` exists at all. Without it the two payment
orderings differ: if the *newer* session pays first it deletes the entry, and the
older sibling then finds an empty map — which reads exactly like a late delivery.
An ownership check alone therefore closes one ordering and leaves the other open,
which is not a cap.

The cost is stated rather than hidden: **a sale whose slot we do not hold is not
counted**, so a code can under-report. That is the safe direction under Q9, and it
is loud — `commitPromoRedemption` logs it at ERROR with the code, the reservation
key, our instance and which of the two losses it was. "The system does not even
notice" was half of the original defect.

### The cap gate — the last bound, and the one that needs no timing argument

Every mechanism above bounds how many slots exist and who may spend one. None of
them runs before the money moves, so none of them can be the last word: a commit
arrives with a payment already taken. So the commit is also a **gate**.

> **No commit ever pushes `usage_count` past `max_uses`, or
> `PromoRedemption.count` past `max_uses_per_contact` — in every ordering,
> unconditionally.** A commit that would breach either writes NOTHING: not the
> counter, not the ledger row, not the reservations map. It logs at ERROR naming
> the code, the reservation and which cap it refused. (It is a bound on what the
> system *writes*, not a data invariant: a manager may lower `max_uses` below a
> count already reached, which simply leaves the code refusing everyone.)

This replaces a tripwire that counted anyway and complained afterwards. A counter
that reports a breach is not a cap, and Q9 asked for a cap.

**The product consequence is a decision, not an implementation detail, so it is
stated here rather than discovered in a support ticket:** the buyer has already
paid the discounted price when this fires. The gate does **not** refund them and
does not undo the sale — they keep the booking, the course, the goods, and the
studio keeps the money. What is refused is the *bookkeeping*. Honour-and-don't-
count is chosen over refunding because a system-initiated refund of a completed,
wanted purchase is a worse surprise for both sides than a discount given one extra
time; and the ERROR log is what lets a studio reconcile it if it ever cares.

### What is bounded, and the residuals

**Bounded, hard, in every ordering:**

- **the counters.** No commit ever pushes `usage_count` past `max_uses`, or
  `PromoRedemption.count` past `max_uses_per_contact`, by the gate above — no
  timing argument required, so no future change to windows or delivery behaviour
  can erode it. (The *authoring* side is not part of that claim and does not need
  to be: `updatePromoCode` will happily set `max_uses` below a count already
  reached, which leaves a code reading past its own cap and refusing every
  customer — data a manager typed, not a breach the system committed.)
- **payable sessions per slot — EXCEPT after the manager release lever.** At most
  one Checkout Session can take money against a reservation at any instant, by the
  three-part mechanism above (close before refresh, compare-and-set in the
  transaction, close-on-failed-bind). `releasePromoReservations` is the one route
  out of that, and it is deliberate: it frees the slots **without closing the
  sessions they were backing**, because those buyers are mid-checkout for a
  purchase they still want. Every slot it frees can be re-reserved and given a
  second, simultaneously payable session — see "Refuse, never over-issue" item 5.
- **counted uses per slot.** At most one, by the ownership rules — never two, in
  any ordering. Not *exactly* one: a slot yields zero when its commit is lost, the
  lever cleared it (`lostTo: 'removed_early'`) or the commit throws, and
  under-counting is the direction Q9 asks for.

**The residuals, stated plainly because an honest documented residual is fine and
a false "hard in every ordering" is not.** In both, the money is never wrong — the
buyer paid exactly what the screen said — and only the campaign's ledger
under-reports. There are **two** routes by which more *discounted prices* are
charged than `max_uses` allows:

1. **The late webhook.** One extra per occurrence of a narrow ordering: a payment
   completed on a session, whose `checkout.session.completed` is delivered more
   than `PROMO_RESERVATION_BACKSTOP_MINUTES` (60) after that session's own expiry,
   against a slot that lazily lapsed and was re-handed and spent in the meantime.
   It requires all three, and it cannot be closed without either a tombstone per
   redemption — which is what made the document unbounded the first time — or a
   slot that is never freed without positive evidence, which turns a lost webhook
   into a permanently wedged campaign.
2. **The manager release lever.** Not narrow, not one, and not accidental: one
   pull of `releasePromoReservations` frees every live slot on the code while
   leaving every one of their sessions payable, so a code with N contested slots
   can yield up to N extra discounted prices — each of them a sale the lever's own
   docblock says it will not cancel. N is bounded per pull by
   `PROMO_MAX_LIVE_RESERVATIONS` (25) and by nothing else; the lever may be pulled
   again. This is a lever a manager reaches for *because* the code is contested,
   i.e. exactly when N is largest. It is
   nonetheless the right trade (the alternative is cancelling live carts to tidy a
   counter) and it is a deliberate human action rather than a system behaviour,
   which is why it is documented and not closed.

**Three things about residual 1 — the late webhook — that are easy to overstate,
so they are written down rather than assumed** (residual 2 shares none of them:
the lever's occurrences are neither rare nor correlated with a delivery outage,
and they are logged as `lostTo: 'removed_early'` rather than by the cap gate):

- **It is one extra discount per OCCURRENCE, not one per campaign.** Nothing
  bounds it to a single occurrence. A lapsed straggler leaves no mark on
  `usage_count`, so its slot is genuinely re-handed and the same shape can repeat.
- **The occurrences are positively CORRELATED, not independent.** "Delivered more
  than an hour late" is normally a webhook outage, not a coin flip, and one outage
  can strand many paid sessions at once. What bounds the blast radius is not the
  promo code at all: the *same* late event carries the sale's own confirmation, so
  a delivery regime bad enough to multiply this residual is one where drop-in
  bookings are not confirming, course entitlements are not granting and product
  sales are not recording. It can never be a quiet promo-only leak.
- **Its only log is the CAP GATE** — one ERROR line per occurrence, so counting
  those lines is how a studio learns how many. It is *not* also logged as
  `lostTo`: on this ordering `lostTo` is null by construction (the entry is absent
  **and** our own deadline has passed, which is precisely the case that counts).
  `lostTo` fires on different orderings — an entry at our key held by a newer
  attempt (`not_ours`), or an entry gone *before* our deadline (`removed_early`).

Both refusal logs name the code, the team, the **contact**, the **identity key**
(the redemption row's own doc id, so it addresses `redemptions/{identity}`
directly), the **Stripe Checkout Session**, the reservation key and the instance —
enough to join a refused count to the payment that caused it. The gift-card
full-cover branches create no Stripe session, and log `session=full_cover`.

**Identity comes from the RESERVATION, not from the webhook.** The callable that
minted the reservation *knew who was buying*; the webhook only knows what
survived. A guest who books with a code, stalls on the Stripe page and whose
provisional contact is purged overnight would otherwise produce a write to
`redemptions/undefined`. When neither the reservation nor the metadata fallback
yields an identity, the commit still moves `usage_count`, **skips** the ledger
write, and logs at error level — the global count must not under-report because
one person became unidentifiable.

**There is no `committed` map, and replay is still guaranteed.** The Stripe path
claims `connect_webhook_events/{eventId}` with `.create()` *before* dispatching, so
a redelivery short-circuits with a 200 and the handler never runs; a Checkout
Session completes exactly once. The full-cover path runs synchronously inside a
callable whose booking write already refuses a second attempt.

**Every commit is best-effort and wrapped in `try/catch`**, like its gift-card
neighbour. A commit that throws must not stop the booking confirming: the customer
paid and owning the seat matters more than the count. The cost is a reservation
that lapses instead of committing — the count under-reports by one, which is the
safe direction.

### Expiry, and the two-sided timer rule

> **A reservation is bounded on BOTH sides against the checkout it guards.**
> `session.expires_at < hold.expires_at  ≤ session.expires_at + PROMO_RESERVATION_MARGIN_MINUTES` (4, gift card)
> `session.expires_at < promo.expires_at ≤ session.expires_at + PROMO_RESERVATION_BACKSTOP_MINUTES` (60, promo)
> — both derived from the **one** instant passed to Stripe.
>
> Each upper bound carries two small trailing terms in the stored document, named
> rather than glossed: **+1 minute** of `Math.ceil` on a minute-granular hold
> parameter, and **+ the work budget**, because `holdMinutes` / `promoHoldMinutes`
> are *durations* applied at each reserve's own clock, necessarily later than the
> instant the session got. The drift is always in the safe direction (a
> longer-lived reservation) and is bounded at
> `CHECKOUT_WINDOW_WORK_BUDGET_SECONDS` on any checkout that completes — one that
> spends more is refused and its reservations released. See "The instant is fixed
> before the reserves" below.

A one-sided rule ("never expire before the session") is unbounded above: on a rail
whose session lives 24 hours it forces a 24-hour reservation, and one abandoned
cart locks a slot of a scarce campaign for a day.

**The two upper bounds differ, and that difference is a correctness fix rather
than tuning.** A gift-card hold is released by a committed-hold marker on the
card, so four minutes of slack costs nothing. A promo slot is released by a
webhook — and at +4 its lazy expiry fired essentially the instant the session
died, which put it in a race with Stripe's delivery of the *other* webhook that
decides the same slot. Stripe's delivery horizon is hours, because it retries. So
a session paid one second before expiry whose `checkout.session.completed` arrived
five minutes late found its slot already lapsed, re-handed and spent. A lease
measured in minutes cannot arbitrate an event measured in hours; the backstop is
now an hour so that ordinary webhook lateness is swallowed rather than raced.

The honest cost: a slot whose `checkout.session.expired` never arrives at all is
held for about 91 minutes instead of 35 before it self-heals. That is the
Q9-required direction — over-hold, never over-issue — and
`releasePromoReservations` is the manager's immediate answer.

`resolveCheckoutHoldWindow` (`connect/checkout.ts`) owns the derivation and both
constants. Every rail calls it once and reads `expiresAtEpochSeconds`,
`holdMinutes` and `promoHoldMinutes`, so all three are **copies of one instant**,
never separate computations. Gift-card behaviour is preserved exactly where it was
already right: `31 + 4 === 35 === DEFAULT_HOLD_MINUTES`.

| Rail | Before | With a promo and/or a gift card |
|---|---|---|
| Drop-in, plain | 31 min | unchanged |
| Drop-in, waitlist claim | the claim window, clamped at 24 h | **unchanged** — and no promo may ride it |
| Appointment | 31 min | unchanged (its own `CHECKOUT_EXPIRY_MINUTES` constant is gone) |
| Product / course, gift card | 31 min | unchanged |
| **Product / course, plain** | **24 h — Stripe's default, no `expires_at` at all** | **31 min when a promo rides it**; still 24 h when nothing does |

The last row was a live hole, not a hypothetical: `SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES`
reached those callables only inside their gift-card sub-branches. So attaching a
code shortens a buyer's payment window from 24 hours to about 31 minutes on those
two rails. That is a customer-facing trade, taken deliberately — the alternative
is one abandoned cart holding a scarce code hostage for a day, and the gift-card
branches already made exactly this trade for exactly this reason.

**The instant is fixed before the reserves, and that costs a budget.** Every rail
resolves the window *first* and reserves *afterwards* — it has to, because each
reservation's own window is derived from that instant, and deriving them
separately is exactly the bug the function exists to close. But Stripe measures
its 30-minute `expires_at` floor against the moment the **create call lands**, not
the moment we chose the instant. So everything in between — the promo reserve (a
transaction plus up to two Stripe calls, because superseding a slot closes the
session it was already backing), the gift-card reserve, the booking-hold
transaction — spends the gap between the 31 minutes we choose and the 30 Stripe
requires:

> **`CHECKOUT_WINDOW_WORK_BUDGET_SECONDS` = (31 − 30) × 60 = 60 seconds.**
> Derived from the two ends so it cannot drift out of step with either.

Before promos that gap was clock-skew slack with nothing happening inside it;
it is now a budget, so it is named, enforced and pinned. It cannot be widened
(31 is pinned on one side to the 30-minute booking hold it must close just after,
and on the other to `31 + 4 === 35`), and the instant cannot be computed later
(that *is* the two-computations bug). So:

- `assertCheckoutWindowPayable` runs at `startOneOffCheckout` — the ONE choke
  point every rail that derives an expiry funnels through, including any rail
  added later. It **refuses** when the budget is overspent, and deliberately does
  not extend the instant: by then that instant has been reconciled with the seat
  freed at +30, the appointment slot hold, a claim's single deadline and the upper
  bound of every reservation riding it, and moving it would break all four
  silently, in data. Refusing costs one transient attempt and nothing else — the
  rail's guard hands every reservation back, no Stripe session is created and no
  idempotency key is consumed.
- A **WARN** fires at half the budget spent, so erosion (one more `await` inside
  the window) shows up in logs on a sale that still completed, rather than as the
  first refused checkout after a deploy.
- Rails with no `expires_at` at all (plain product/course, 24 h) have no budget
  and the guard is a no-op. A waitlist claim's budget is minutes, not seconds:
  `resolveClaimCheckoutWindow` already refuses below 31 minutes remaining, so one
  threshold serves every rail.
- The one caller that bypasses `startOneOffCheckout` is `createStaffAppointment`,
  which computes a 7-day link expiry one statement before its own Stripe call and
  has no window to overspend.

Fixtures: `packages/functions/src/connect/checkoutWindow.test.ts` →
"the checkout window work budget".

**Release is by positive evidence; lazy expiry is the backstop.** The distinction
is the cap, so it is worth naming which is which:

- **PRIMARY — `checkout.session.expired`.** The webhook's `handleCheckoutExpired`
  releases beside the gift-card release, for any kind, passing the session's own
  `promoInstance`. This event is Stripe telling us the session can never take
  money again, which is the only evidence that makes re-handing its slot safe. It
  is emitted at the session's expiry and retried, so it is prompt and reliable —
  and it is also what our OWN close of a superseded session produces, which the
  instance check turns into a harmless no-op.
- **The callables' failure guards.** Every path from the reserve to a successful
  return releases what it took.
- **The manager lever.** `releasePromoReservations` — see below.
- **BACKSTOP — lazy expiry.** `promoLiveReservations` drops expired entries inside
  any transaction that already holds the document. **There is no sweep job and no
  cron entry**, exactly as gift-card holds have none. It sits an hour past the
  session precisely so it does not decide slots that a webhook is about to decide.

`releasePromoReservation` itself is `tx.get` + `tx.update`, deleting the key
**only when the caller's `instanceId` matches the entry** (rule 3 above), so a
missing document, a missing key and a key a newer attempt now owns are all no-ops
and it stays idempotent. Stripe expires abandoned sessions on its own schedule, so
an expiry for a superseded sibling routinely arrives *after* the buyer's live
retry refreshed the same deterministic key — that is the caller the check exists
for.

An **undateable** reservation is treated as expired — the opposite of the gift
card's committed-hold marker, and reasoned that way on purpose: a permanently
stranded use does not self-heal, and the counters are hard-bounded by the cap gate
whatever the timers do.

### Idempotency on retry

| Retry shape | Guard |
|---|---|
| Double click, Back button, dropped redirect, changed card | the reservation key is deterministic → the second call **refreshes** the first and consumes nothing, and takes ownership of the entry so the abandoned session's own expiry cannot free it. The superseded session is **closed at Stripe first** (ownership rule 5), so the retry does not leave a payable one behind |
| The buyer retries **after already paying** | the close reports `paid` → `promo_purchase_paid`, nothing is written, and the paid session's commit still owns the slot |
| Stripe cannot be reached to close the superseded session | `promo_busy` — refuse rather than risk two payable sessions. The old session's own short expiry resolves it within the window, and the message says "try again in a few minutes" |
| **Several of those sessions actually get paid** | can no longer happen for sessions this system handed out (rule 5); if it somehow does, only the attempt that still holds the slot spends it (rule 4) → **exactly one** use, in any payment ordering |
| Changing the code or the card inside the same minute | the Stripe idempotency key carries the applied instruments — see below |
| Redelivered `checkout.session.completed` | `connect_webhook_events/{eventId}` claimed with `.create()` before dispatch |
| Late webhook delivery (Stripe retries over hours) | the reservation outlives the session by an hour, so the slot is normally still standing; `fallbackAmountMajor` and `promoIdentity` come from checkout metadata; and if it is later than that AND the slot was re-handed, the **cap gate** refuses the second count |
| Two concurrent claims of the last use | serialised on `promoRef`; one wins, the other gets `promo_exhausted` |
| Manager double-submitting the create form | `.create()` → `already-exists`, `reason: 'code_taken'`, no retry loop |

**The Stripe idempotency key had to learn about instruments — and about
ATTEMPTS.** `defaultIdempotencyKey` buckets by minute and its parts carried only
the rail's entity ids and the contact. Stripe **rejects a reused idempotency key
whose request parameters differ**, and a promo changes both the amount and the
metadata — so "submit at 40.00, get bounced by a validation message, type a code,
resubmit twelve seconds later" would have been the same key with a different
amount, surfacing as a bare `internal` "Failed to start checkout".
`instrumentKeyParts` **appends** the applied instruments, last, never reordered: a
call with no instruments produces a byte-identical key and `moneyCore.test.ts`'s
snapshots stay green.

The code alone was not enough, and the gap broke a purchase. **The code is
constant across every attempt at one purchase while the request is not**: each
attempt stamps a fresh `promoInstance` and a freshly derived `promoExpires` (and,
on the rails that take one, a fresh `giftCardHold`). Two attempts inside one
minute bucket therefore reached Stripe as the same key with different parameters —
a mismatch — and by then the reserve's pre-flight had already **closed the buyer's
still-live Checkout Session**, so the failure left them with no payable session at
all. So `instrumentKeyParts` takes the **reservation ticket**, not the code, and
appends the attempt's `instanceId` beside it. The instance is minted by
`reservePromoRedemption` and by nothing else, so the key now varies exactly when a
new slot generation exists — i.e. exactly when a new Checkout Session must be
created.

The alternative — freeze the instance inside a bucket and keep it out of the key —
was rejected twice over: the instance is not the only per-attempt parameter (the
window instant is derived afresh at every attempt, and freezing *that* is the
two-computations bug `resolveCheckoutHoldWindow` exists to close), and even a
byte-identical replay would return the cached response — the URL of the session
the pre-flight has just expired, which is the same sessionless buyer by a quieter
route. Nothing is lost on the dedupe side: re-submission is deduped by the reserve
(close, then compare-and-set) and by the bind, never by Stripe's key. Fixtures:
"the idempotency key names the ATTEMPT, not just the code" in
`connect/promoLifecycle.test.ts`.

### The concurrency argument, stated so it can be checked

With `max_uses = 1` and N concurrent checkouts for the same code, exactly one
reservation is created:

1. every call's read set and write set both include `promoRef`;
2. Firestore read-write transactions are serializable, so two that both read and
   write the same document cannot both commit against one snapshot — one retries
   and re-reads;
3. on re-read the winner's reservation is in `live`, so the cap test refuses;
4. the predicate that decides it is `promoUsesLeft` — one expression, both halves,
   shared by the transaction, the preview and the admin list;
5. a retry by the same person is not a fifth claimant: the deterministic key makes
   it a refresh of an entry already counted;
6. …and a refresh cannot smuggle a second payable session past the first: the
   compare-and-set on `sessionId` is in the same read set and the same
   transaction, so a sibling that bound one in between is `promo_busy`.

The argument depends on **no query**, and on the document holding no committed
history — step 3 reads a scalar and a bounded map.

**And the counters do not depend on this argument at all.** Even if every step
above were wrong, the cap gate at commit refuses to write past `max_uses` or
`max_uses_per_contact`. That separation is deliberate: a serializability argument
is a proof about code that can be invalidated by a later edit, and a cap should not
be one edit away from not being a cap.

## Refuse, never over-issue — and the support story it creates

**A live, uncompleted reservation consumes a use of `max_uses`.** That is the
decision, and the honest consequence is worth stating plainly rather than
discovering:

> A studio will eventually open `/manage/promo-codes` and see a campaign reporting
> **fully redeemed with uses left unsold**. That is **contested, not exhausted**:
> reservations are held by people currently in checkout (or who abandoned one),
> and they release themselves when their checkout can no longer be paid.

Five things bound that, and the fifth is the lever:

1. **The deterministic key** — one reservation per *person* per target, so N
   abandonments of one purchase are **one** slot rather than N. Taking N slots
   needs N distinct **(identity, target) pairs** — which at the default
   `max_uses_per_contact` of 1 does mean N distinct email identities, because a
   second live reservation by the same identity drives `perIdentity` to 0 and is
   refused whatever the target. A manager who ticks **"unlimited per person"**
   (`max_uses_per_contact: null`) trades that half away: one email can then hold
   up to the ceiling in (2) by starting checkouts on that many different
   sessions/products. What still binds it is that a reservation is only ever
   taken inside a checkout callable (the preview reserves nothing), each costs a
   Stripe Checkout Session, and the public rate limit is 30/hour/IP — so the
   residual is a transient denial that self-heals on expiry, never an
   over-issue.
2. **`PROMO_MAX_LIVE_RESERVATIONS` (25)** — a hard ceiling on concurrent
   reservations for one code, independent of `max_uses`, refused as `promo_busy`.
   That is a **different sentence** from `promo_exhausted` on purpose: "try again
   in a few minutes" and "the campaign is over" are not the same news.
3. **Short windows, and a PROMPT release.** The Checkout Session is about 31
   minutes on every rail that can carry a code, and the slot is freed by
   `checkout.session.expired` within seconds of that — not by its own lease, which
   sits an hour out as the backstop for a lost webhook (see "Expiry"). So the
   ordinary abandoned cart holds a slot for ~31 minutes, not ~91; the longer
   number is only reached when Stripe's expiry event never arrives at all.
4. **The admin list shows `reserved` separately from `used`**, both read through
   `promoUsesLeft`, so the page and the gate cannot disagree. A single number
   would let a manager read "3 of 20" while the code refuses every customer at 20
   reserved.
5. **`releasePromoReservations({ code })`** — a manager row action that clears all
   live reservations on one code. It writes only the `reservations` map, never
   `usage_count`, so it is not a second counter writer. Its honest consequence
   under ownership rule 4: a checkout that was holding one of those slots and
   then pays inside its own window records the money and the sale but consumes
   **no** use (logged as `lostTo: 'removed_early'`). That is the direction Q9
   requires — the manager has just handed those slots to other customers, so
   counting them again is exactly how the cap gets exceeded. It is also the one
   lever that can make the cap gate fire, which is why the gate names the code and
   the reservation in its ERROR line.

The opposite direction — count committed only — would over-issue by a bounded few.
The asymmetry that argues for it is real: a promo slot is not stored value, so
giving one extra 25%-off booking costs the studio one discount while refusing a
paying customer costs a sale. **Flipping it is one line**: drop `liveTotal` from
`global` in `promoUsesLeft`.

## The waitlist claim takes no code, and why

A waitlist claim **is** a drop-in — same callable, same pricing path, no separate
scope kind. It is nonetheless the one rail with no promo field, and the reason is
the interaction between two decisions rather than either alone.

The claim rail has the longest and only studio-configurable checkout window, and
its deadline **cannot be shortened**: the booking hold's `claim_expires_at`, the
queue entry's `offer_expires_at` and the Stripe session's `expires_at` are ONE
instant, and giving one seat two timers is how a seat gets sold twice. So a code
applied on a claim would lock a use for the whole claim window — about 124 minutes
at the default, up to 24 hours if a studio configures it that way. **Strict cap
plus longest hold is the worst pairing in the design.**

This is enforced on the server, not merely absent from the UI:
`createDropInCheckout` builds a `NO_PROMO_ATTEMPT` on the claim path and reports a
hand-made request carrying a code as `not_applicable` — reported, not blocked,
like every other inapplicable code.

Reversing this later needs more than a mount: the claim page's displayed price
comes from `claimWaitlistSeat`'s server response, so a client-applied promo would
disagree with it unless the preview supplies its own quote (it does), and the new
refusal reasons must join `claimErrorKey`, the single mapping shared by
`claimWaitlistSeat`, `createDropInCheckout` and the promoter. `claimErrorKey`
already maps `price_changed` → `Waitlist.priceChanged`, even though that page
cannot fire it today: a refusal with no mapped copy is this feature's most likely
failure mode, and mapping it cost four message keys.

## Audience — "new customers only"

`audience?: 'all' | 'new_contacts'`, absent ⇒ `'all'`.

The axis exists because best-one-wins has a sharp consequence without it: a studio
with 120 members prints "20% off, code AUTUMN20, 50 uses", its members already
hold a 10% `memberBenefit`, every member who sees the flyer takes 20% instead, the
50 uses are gone in a week, **zero new contacts are acquired**, and the admin page
reports a fully-used campaign. The one report a studio actually wants cannot say
the campaign failed. It was decided before any code went live precisely because
retrofitting it changes the meaning of codes already in customers' hands.

**"New" is implemented as `!joined` — NOT `acquisition_stage === 'joined'` — and
that needed reading rather than transcribing.** The literal phrasing ("a
pre-member stage") means `acquisition_stage ∈ {trial_booked, trial_attended}`,
which **excludes every anonymous guest and every off-funnel contact**: the field
is optional, and a `shop` / `form` / `waitlist` entry carries no stage at all.
That is precisely the population a "new customers only" code exists to admit, so
the literal reading breaks the feature on the acquisition surface. `!joined` is
byte-identical to `ContactPaymentSnapshot.joined` and to what the `members` access
rule already means, so the audience axis cannot fork from the booking gate.

The residual, documented in the type file: a long-standing member whose stage was
never advanced past `trial_attended` reads as new. The funnel field is the agreed
proxy, chosen over a prior-bookings query for cost.

### The invariant, and the three times it was broken

> **"Joined" is a property of the EMAIL ADDRESS, never of one contact document.**
> A `new_contacts` code is refused whenever **any active** contact of the team
> under the caller's email has joined — whichever document the rail happens to be
> buying as.

The predicate is the easy half. The hard half is **what it is asked about**, and
that has now been got wrong three times, each a layer deeper:

1. the predicate itself (a stage allow-list rather than `!joined`);
2. what each rail *fed* the predicate — the drop-in rail passed a `contactDoc`
   that is null whenever the (email + exact firstname + exact lastname) match
   misses, so a joined "Ann Smith" booking as "A. Smith" walked straight through.
   The appointment rail had closed the same hole with an inline email lookup,
   which is how one rail's fix became a second definition of "new customer";
3. what the *resolver* did with what it was fed — it returned early on
   `params.contact`, discarding the email evidence whenever the rail happened to
   hold a document. That is precisely the household case: the exact-name match
   hits the not-yet-joined member of a shared mailbox, the rail holds a document,
   and the member's own household takes the code.

All three are one mistake — treating **one contact document as the answer to a
question about a person**, when on these rails a person owns as many contact
documents as they care to create. So the seam is now the **evidence**, not the
rail:

- `promoCallerFrom` is the only constructor of a gate-bearing `PromoCaller`, and
  it takes **both** halves — the held document and the email's contacts — as
  **required** properties. A call site missing the email half does not compile.
- `resolvePromoCaller` is the only producer of that evidence, and it consults the
  email **whether or not the rail holds a document**. The one skip left cannot
  change the answer: `joined` is a union, so it only moves false → true, and a
  held document that has already joined settles it.
- the lookup runs **only when a code was typed** — the gate is the only thing
  that needs it, and a plain checkout pays nothing for it. (Nor does a waitlist
  claim, which refuses codes outright.)
- `joined` is true when the held document has joined **or** any active contact
  under the email has. `resolveSingleContact`'s "never guess when ambiguous" is
  right for *attributing a payment* and exactly wrong for a gate.
- `contactId` still follows never-guess: the held document when there is one,
  else an unambiguous single active match and otherwise nothing — because it
  feeds `restrict_to_contact_id`, where naming the wrong person hands somebody
  else's code away.
- `promoCallerNotAsked` is the one place a `joined: false` may be built with no
  evidence at all, and its name says why that is safe: no code was typed, so
  every reader of it is unreachable.

**The drop-in rail passes its OWN query results in**, and that is not an
optimisation. `createDropInCheckout` mints a provisional contact for an unmatched
guest *before* the promo loads, so a query issued at the promo site would see that
brand-new document too, come back with two matches, and — under a
single-match-only rule — the gate would fall open precisely where it matters. The
matches captured *before* the mint are the correct read set, and that ordering is
load-bearing.

`promoAllowsCaller` decides both identity gates in one expression, and **the order
is load-bearing**: the `restrict_to_contact_id` binding is checked **first**, so a
code that is both bound to somebody else and new-contacts-only reports the
secretive refusal. A binding maps all the way out to a bare `invalid` — "this code
is not yours" confirms the code is real to whoever guessed it. An audience
mismatch names itself, because a flyer code is public and "this one is for new
customers" is useful, honest and gives nothing away.

## Finance

> **A promo code writes nothing to `finance_transactions`. Ever.**

A discount is not a money event. The journal is cash-basis — entries mirror money
events — and the money event here is the (smaller) charge:

```
Stripe PaymentIntent amount      3000 Rappen   ← already net of the promo
finance row: gross               3000
             stripe_fee          −XXX
             platform_fee        −YY
             net                 3000 − XXX − YY
assertFinanceInvariant: gross + stripe_fee + platform_fee === net   ✓ trivially
```

The promo changed **one input** to the row — the gross — and did not touch the
identity. So: **no `FinanceCategory` member** (a drop-in bought with a code is
still `drop_in`), **no reclass pair**, **no CSV column**, no chart-template break,
no monthly-report change.

The reclass pair (`buildGiftCardReclassTxns`) exists for exactly one reason: a
gift card's revenue was **already recognised** at sale time in a different bucket,
so redeeming it is an *attribution change* and the only permitted write is a
signed pair summing to zero. A promo has no prior recognition to move. A "discount
given" row would be inventing a negative money event, and it would either break
the `gross + fees === net` identity or double-count against the charge row.

**The comp gift card is the exact precedent and was resolved the same way**: a
comped card writes nothing to the journal, and the card document is the audit
record. Here the promo document and its redemptions subcollection are the audit
record.

**The cost, stated plainly: "discount given" is unrecoverable from the journal.**
A studio can see revenue but not forgone revenue. That is the right trade on a
cash basis, and it is why the payment-row stamp below is not decoration.

### Reporting — where a discount IS visible

1. **The promo admin list** — `used / max` **and** `reserved`, window, per code.
   This is the report a studio actually wants ("did the flyer work"), and both
   figures come from `promoUsesLeft`, the same expression the gate uses.
2. **The payment row.** `PaymentLineItem.promoCode` is stamped by the Connect
   webhook from checkout metadata (`lineItemFromMetadata`) and rendered as a chip
   in `/payments`, the contact detail Payments tab and the contact's own Space
   payments list. `PaymentLineItemKind` gains **no** member — a drop-in bought
   with a code is still `drop_in`.
   - It is a **system stamp**: `normalizePaymentLineItem` deliberately does not
     read it off a client payload, and `updatePaymentRecord` carries the *stored*
     value forward across an edit. Neither forgeable by a client nor loseable when
     a manager corrects "what was paid" — which matters more than usual precisely
     because there is no journal row behind it.
   - **A gift-card full-cover purchase has no payment row at all** (no Stripe
     session, no `member_payments` document), so a promo used on one is recorded
     only in `usage_count` and the redemptions ledger.
3. **`/manage/pricing`** — `PriceCell.pay.promoCode`, and `fromResult` falls back
   through `appliedPromo.baseAmount` and `appliedPromo.supersededBenefit` so the
   member badge is not lost the moment a code beats the benefit.
4. **No campaign analytics module** — no attribution dashboard, no cohort lift, no
   per-channel ROI.

## Surfaces

### Admin — `/manage/promo-codes`

In `sectionOffer` of the nav, after Pricing, with **`minPlan: 'studio'`** — so it
is **visible but locked**, driving the upsell modal. `requiresPlan` would hide the
lever entirely and teach nobody the feature exists. Not a plugin: plugin gating is
for substantial à-la-carte modules, and a promo code is a thin pricing lever.

- **Header**: the active count against `getPromoCodeLimits(plan).maxActiveCodes`
  ("4 of 20 active"), and a Create button disabled at the cap with a reason
  resolved through `usePlanName()` — never a hardcoded plan display name.
- **Create dialog**: code (uppercased as typed), effect, value, an optional
  window, the **required** total cap, the per-person cap (default 1), the
  one-person binding, the audience toggle, scope checkboxes plus optional entity
  pickers, and an internal label.
  - **The total cap is required, not optional.** Optional plus a per-person
    default of 1 makes the fastest path through the form produce an *uncapped*
    code each person may use once — the shape a leaked WhatsApp message turns into
    unbounded liability, with no notification behind it. Unlimited stays
    expressible, but only by ticking a box that carries its warning.
  - **The one-person binding is a first-class shape, not a workaround.** Service
    recovery ("sorry you got bumped from Tuesday, here's 20% off") is the most
    common manual discount a studio issues, and the alternative was "set the total
    cap to 1 and hope the right person redeems first".
  - **The entity allow-lists are authored here, and they are the second half of
    the scope.** `applies_to` says which RAILS; `activity_ids` / `course_ids` /
    `product_ids` say which entities on them, and the resolver has always
    honoured both — so "20% off, that one course only" is expressible. Each
    picker appears only while its rail is ticked, and **nothing ticked means
    everything of that kind**: the same meaning a null allow-list has on disk, so
    there is deliberately no "all" option to choose (two ways to say one thing
    drift). One picker serves both activity rails, because `promoAppliesTo` reads
    `activity_ids` for `drop_in` and `appointment` alike. Ids whose rail is
    currently unticked are kept and re-sent rather than pruned — they are inert
    (the kind is checked first) and un-ticking "Courses" to look at something else
    must not silently destroy a narrowing. `PROMO_MAX_SCOPE_IDS` is shared with
    `resolveScope`, whose truncation is silent.
  - **The validators are promo-specific.** `benefitPercentInvalid` and
    `benefitAmountInvalid` both short-circuit to VALID when
    `subscriptionTypeIds.length === 0`, and a promo form has no subscription
    types — so borrowing them validates *nothing*, and `150` in the percent field
    would reach the callable and come back as a raw `invalid-argument` with no key
    to render.
- **List**: code, discount, window, `used / max` **and** `reserved`, per-person
  cap, scope chips, status. Row actions **Edit**, **Release reservations** and
  **Disable**, the last two behind an `AlertDialog`.
- **The code field is disabled on edit.** The code IS the document id; changing it
  would orphan every reservation and every `redemptions/*` row under it.
  `updatePromoCode` may never write `usage_count` or `reservations`.
- **Disabling, not deleting.** `status: 'disabled'` stops new reservations; live
  ones complete. Deleting the document would orphan in-flight checkouts and
  destroy the redemption ledger — and there is no delete action.
- The tier gate **carries the stored value through** rather than reading it off a
  locked control, so a downgraded team keeps its live codes redeemable.

### The public widget — `PromoCodeField`

Mirrors `GiftCardRedeemField` — an optional input + Apply, a preview callable, an
applied chip with an X, an exported `promoCheckoutErrorMessage(err, t)` so every
surface shares the copy, and a `colors` override for branded surfaces. Two
deliberate divergences:

1. **It takes the target.** `previewPromoCode({ teamId, code, target })` returns a
   **quoted price for this item**, not a balance. `checkGiftCard`'s
   `{ valid, balance, currency }` is target-independent because a balance is a
   balance whatever you buy; a promo's validity is a function of *(code, target,
   contact, time)*. Copying that signature is how you ship a preview that says
   "valid" and a checkout that says "not for this class".
2. **Its copy lives in a new `Promo` namespace**, not in `Shop` —
   `GiftCardRedeemField` binds to `Shop` because gift cards are *sold* there. The
   rule that matters is preserved: **one namespace for the widget, never a fork
   per surface.**

**The widget never decides whether the code won.** Each surface passes its own
single `resolvePaymentOptions(..., { promo })` result's `promo` field down as
`outcome`, and the widget renders the sentence. A widget that decided the verdict
itself would be a second price computation.

### The mounts — more renders than surfaces

**This table is the census.** The comments at the mounts themselves say "every
mount" and point here; none of them carries its own tally, because a comment that
said "mounted on the guest screen only" sat directly above the appointment
picker's second mount for two rounds, and the two surface comments that did carry
a number both said *three* when there were four renders.

The renders-vs-surfaces distinction is not pedantry: the shared helpers
(`useAcceptedPrice`, `priceChangedMessage`) are per **render**, while the copy
namespace and the recovery branches are counted per **surface**. Both tallies are
asserted against the source in `connect/commitSites.test.ts`, so this table
cannot silently fall behind a new mount.

| Surface | Mount(s) | Notes |
|---|---|---|
| Booking form, drop-in step | above `GiftCardRedeemField`, gated **`willCharge && !isPricedTrial`** | modifier above tender, in the UI as in the maths |
| Shop buy modal | above `GiftCardRedeemField` | products **and** courses; the `checkoutKey` reset effect clears the code when the item changes |
| Appointment picker | the **guest** screen and the **member** screen, input + chip on both | the second mount exists so a pay-time reserve refusal on the member screen can be *removed*: without it the visitor pressed a button that could not succeed, and the sale was lost to a discount that no longer existed. **An applied code does NOT survive an identity change** — `previewPromoCode` resolves ITS caller from a contact session and nothing else, so a code quoted anonymously on the guest screen and carried onto a member screen is re-priced by the client for an audience the server judges differently, and an audience-restricted code shows as applied on a screen whose checkout is obliged to refuse it. The picker's one identity rule retires the code with the identity that applied it and says so (`AppointmentBooking.identityChangedPromo`). Because nothing can be carried, the member screen shows the input to every recognised caller rather than a chip-only variant: whatever is there was applied by that caller, under the same advisory-preview contract the guest screen has always had, recovered at pay time by `promoCheckoutErrorMessage` / `priceChangedMessage` |
| **Not**: waitlist claim | — | see "The waitlist claim takes no code" |
| **Not**: priced trial door | — | `willCharge` is literally `(dropInAvailable && guestPath !== 'trial') \|\| isPricedTrial`, so it is TRUE on the trial door — the one door a promo is guaranteed to fail on. Rendering the field there would show a newcomer a code box that must fail, on the acquisition surface, while the same person taking the *dearer* drop-in door gets the discount |
| **Not**: trial booking, kiosk walk-in, Space | — | `bookSession` (no charge path) and entitlement display |

**ONE computation per surface.** Every public price breakdown renders
`appliedBenefit` **XOR** `appliedPromo` from a single resolver result. Three
surfaces held a second, independent benefit computation before this phase, and two
independent computations do not become exclusive by assertion:

> A member holding a 20% benefit applies a 25% code to a CHF 40 drop-in. The
> member-price call returns {32, base 40} → a −8 row. The preview returns 30 → a
> −10 row. The breakdown renders 40 / −8 / −10 / **22**, and Stripe charges **30**.

`BookingForm`'s `dropInMemberPrice` became a derivation of one `dropInQuote`,
`ShopHome` grew one `checkoutQuote`, and `AppointmentPicker` grew one `quote(caller)`
that every screen calls. That argument used to be `(held, authenticated)`, supplied
per screen — which is how the picker managed to compute one price correctly and
still show a signed-in member the guest's: it passed `([], false)` on the screen a
member was looking at, because nothing in the file knew the member was there. It now
takes the DERIVED caller, so "which price" and "whose price" are the same question.

### The preview callable

`previewPromoCode`, on its **own** `'promo-check'` rate-limit bucket — the
*charging* variant, not the peeking one: a promo preview is an enumeration surface
and every attempt must cost quota. (The bucket parameter exists because one shared
counter means a burst from a gym's NAT locks the same IP out of an unrelated
public surface.) It reads main collections through the Admin SDK, like
`checkGiftCard`; the "public routes read only `public_profile`" rule binds the
**client**, not a callable.

**It is advisory about AVAILABILITY, authoritative about PRICE.** The reserve
transaction may still refuse (`promo_exhausted`, `promo_already_used`,
`promo_busy`), so every mount handles a refusal at pay time and not only at apply
time. But its `quotedAmount` is the figure the client sends back as
`quotedAmount`, which turns "the preview and the checkout disagreed" from a silent
overcharge into an explicit `price_changed` refusal.

**It builds its target and its snapshot through the SAME helpers the corresponding
callable uses.** This is a hard requirement, not a preference, and it is why
`buildDropInTarget` / `resolveDropInForContact` were extracted into
`booking/dropInPricing.ts`. The concrete divergence it prevents:
`createDropInCheckout` meters usage limits against the **class's own week**
(`usageAt = session.start`), so a member on "3 per week" who has spent this week's
allowance but books a class in nine days is **covered**. A preview metering against
`now` would resolve them uncovered, price the drop-in at 40, apply 25% and show
"you pay 30.00" — and then the checkout would throw "You can already book this
class for free". Quoted a price for a class they can have for nothing, then
refused.

It uses the contact session when one is present, so the per-person cap can be
previewed; anonymously it previews the **discount** without the per-person check.
That asymmetry is deliberate: an anonymous probe is the cheapest way to test a
code, and it is also the only way a genuine guest can see a price before typing
their name.

Its caller comes from `resolvePromoCaller`, the same helper the four checkout
rails use, so a preview cannot answer the audience question differently from the
pay button. **One residual follows from having no email input:** an anonymous
preview of a `new_contacts` code reads as new and reports a discount, and the
member who then signs in and pays is refused with `promo_audience_mismatch` —
which every mount renders, because the preview is advisory about availability and
this is the same class of refusal.

### Refusals — every reason has a code and translated copy

| Reason | Where | Copy |
|---|---|---|
| `invalid` | preview: unknown / disabled / outside window / **bound to someone else** | "We could not find that code." A bound code is deliberately indistinguishable from a nonexistent one |
| `promo_not_found` / `promo_inactive` | reserve, discovered between preview and pay | the same sentence, two entry points |
| `not_applicable` / `promo_not_applicable` | `promoAppliesTo` | "This code does not apply to this booking." **Never blocks a checkout** |
| `audience_mismatch` / `promo_audience_mismatch` | `promoAllowsCaller` | "This code is for new customers only." |
| `looks_like_gift_card` | preview, `/^GC-/` | "That looks like a gift card — use the gift card field below." |
| `promo_exhausted` | reserve, global cap | "This code has just been fully used." |
| `promo_busy` | reserve, the live-reservation ceiling | "This code is busy right now — please try again in a few minutes." |
| `promo_already_used` | reserve, per-person cap | "You have already used this code." Cannot fire for the caller's own retry |
| `promo_expired` | reserve, window closed mid-checkout | "This code has expired." |
| `promo_currency_mismatch` | reserve, `fixed_price` only | "This code cannot be used for this purchase." |
| `promo_purchase_paid` | reserve, when the session this slot was backing turns out **paid** | "This purchase has already been paid — there is nothing left to pay for here." The true thing, and the one that stops a second discounted session existing for a purchase that has gone through |
| `price_changed` | the `quotedAmount` guard — **promo-carrying checkouts only** | carries `details.amount`, and the mount shows that figure and offers the purchase at it (`Promo.continueAtPrice`). The one refusal that is not about the code's own validity — **and usually not about the price either**: see below |

**`price_changed` is usually a refused code wearing the wrong sentence, and the
refusal now says which.** The loader REPORTS rather than throws, so a code that
does not apply reaches Stage A as "no modifier", the server prices at list, the
client's discounted quote is lower, and this guard fires *before* anything ever
raises the code's own refusal. That path is reachable with nothing wrong
anywhere: `previewPromoCode` is never sent the guest form's email — it resolves
the caller from a contact session or the Firebase auth token alone — so for a
signed-out visitor it answers as an anonymous caller and accepts a
`new_contacts` code. The checkout then resolves that same code against the email
actually typed, which may belong to a member, and refuses it.
The visitor used to be told "the price changed while you were checking out" — a
sentence about the studio's pricing, when the studio's pricing never moved.

So the refusal carries `details.promoRefusal` (the loader's own `PromoLoadRefusal`)
alongside `details.amount`, and the mounts compose one sentence from both through
`priceChangedMessage` (`components/booking/PromoCodeField.tsx`):

| `details` | What the visitor reads |
|---|---|
| `{ amount }` only | `Promo.priceChangedTo` — "The price changed while you were checking out — it is now X." |
| `{ amount, promoRefusal }` | the SAME sentence the Apply button shows for that refusal (e.g. `Promo.audienceMismatch`), then `Promo.priceWithoutCode` — "Without the code, this costs X." |

Three properties are deliberate. `reason` **stays** `price_changed`: it is still
true, and it is the token every mount's recovery branch keys on, so the cause is
additive — a mount that ignores it recovers exactly as before. The copy is the
**same key** the preview refusal uses, so one refusal never has two sentences
depending on when the visitor hears it. And a named cause can never *create* a
refusal: it only ever describes one the amount comparison already made.

Every preview throw (`invalid-argument`, `not-found`, rate limit, Firestore) is
caught and rendered as the translated `Promo.checkError`, so no server English can
reach a French visitor by any path. In `AppointmentPicker` the promo check runs
**before** the `failed-precondition` branch, which would otherwise render
`promo_exhausted` as "this slot is unavailable".

`plan_required` / `plan_inactive` are unreachable publicly — the gate is on
creation only — and are recorded here only because `requirePlan`'s docblock
requires every public caller to map both.

## Rules and indexes

```
match /promo_codes/{code} {
  allow read:  if hasTeamRole(teamId, 'manager') || hasTeamRole(teamId, 'owner');
  allow write: if false;                    // callables only
  match /redemptions/{identityKey} {
    allow read:  if hasTeamRole(teamId, 'manager') || hasTeamRole(teamId, 'owner');
    allow write: if false;
  }
}
```

Client authoring was rejected in favour of manager callables, and the reason is
not uniformity: a promo carries `usage_count`, a `max_uses` cap and a plan-tiered
creation gate, and a client write bypasses all three. "These fields yes, that
field no" rules are exactly the fragile surface this codebase has avoided on every
coded instrument — `gift_cards` and `referral_codes` both deny client writes
outright.

**No index was added, and that is recorded deliberately.** Every access is a
document `get` by id (`promoRef`, `redemptionRef`), a single-field ordered list
for the admin page (`orderBy('created_at','desc')`), or a single-field equality
(`where('status','==','active')`, which the plan cap needs to count active codes).
Firestore indexes single fields automatically. Gift cards have zero entries in
`firestore.index.json` for the same reason. If anyone later adds a
**collection-group** query here, it needs an override — the emulator hides missing
indexes and a real project does not (memory: `firestore-index-query-gotcha`).

## Cancellations and refunds

**The half that is not a question.** When the *platform itself* refunds the whole
charge — a duplicate drop-in charge, a class that filled after checkout, a
duplicate appointment charge, an appointment slot retaken — nothing was ever
committed, because the commit sits at each handler's confirm point and those
branches return before it. The reservation lapses on its own timer and the slot
comes back. No restore path, no second writer, no manager action.

**The half that is a decision: a HUMAN-initiated refund or cancellation does NOT
restore a use.** A committed redemption stays committed through a studio
cancellation, a manual refund or a dispute. The reasoning is the one-writer
invariant, not indifference: a restore path is a second writer of `usage_count`
and of `PromoRedemption.count`, with an ordering question against a late webhook
commit and a reversal marker of its own. Against that, the cost is bounded and
visible — a 50-use campaign that suffers three refunds effectively becomes 47, and
the studio raises `max_uses`, which is one auditable edit.

Two consequences, stated rather than discovered:

- **A studio-side cancellation can permanently bar a customer** whose
  `max_uses_per_contact` was 1. The remedy is `clearPromoRedemption`, which
  deletes that one `redemptions/{identityKey}` document and **does not** touch
  `usage_count` — it forgives the per-person bar, it is not a second writer of the
  global counter.
- **The finance journal already tells the truth** — the refund row is built from
  the actual (discounted) charge, so the books never disagree with the customer's
  statement.

Both manager corrections are **deletes of lifecycle state**, never adjustments of
a counter. That is how one-writer survives having a support story at all.

## Known gaps and deliberate omissions

Honest list. Every item below was **decided rather than defaulted**, and the
provenance differs in a way a later reader should be able to see.

**Four questions Franco answered directly (2026-08-14).** Each governs the shape
of the feature, each has its own section above, and each has a consequence a
studio will eventually feel:

| | Decision | The consequence, stated rather than discovered |
|---|---|---|
| **Q9** refuse vs over-issue | **Refuse — never exceed the cap.** A live reservation consumes a use, one slot backs at most one payable session, and the commit is a hard gate on both counters | A campaign can read **"fully redeemed" while uses remain unsold**. That is *contested*, not exhausted. Five things bound it and the fifth is the lever — see "Refuse, never over-issue". What is never bounded away is a *discounted price* charged beyond the cap — never a counted use — by either of two routes: an hour-late webhook against a re-handed slot, or the manager pulling the release lever on a contested code. See "What is bounded, and the residuals" |
| **Q12** audience | **Build the audience axis** — `'all' \| 'new_contacts'` | "New" is `!joined`, so a long-standing member whose `acquisition_stage` was never advanced past `trial_attended` **reads as new**. Decided before any code went live, because retrofitting it changes the meaning of codes already on customers' flyers |
| **Q11** waitlist claim | **No promo field on the claim page in v1** | Follows from Q9: strict cap plus the one rail whose deadline cannot be shortened is the worst pairing in the design. Enforced server-side, not merely unmounted |
| **Q8** memberships | **Excluded entirely** — not even the one-off half | The single most likely thing a studio will ask for ("first month 50% off") |

**Eleven more proceeded on this design pass's recommendation** rather than a
direct answer — Q1–Q7, Q10, Q13, Q14, Q15. They are the rest of this section, and
each is flagged with its number so the difference stays visible. (The spec's §10
table bolds **Q4** as answered too, while its own entry still reads as an open
question; it is listed below with the recommendations, which is the conservative
reading and changes nothing about what shipped.)

**Deliberately not built (decided 2026-08-14):**

- **(Q4) `amount_off` as a third effect.** `percent_off` + `fixed_price` only. So a
  code can say "this costs CHF 10 with this code" but not "CHF 10 off", which is
  what studios usually ask for. Adding it is a `BenefitEffect` widening whose blast
  radius is `normalizeBenefit`, the exhaustive `switch` in
  `resolveBenefitCandidate`, `priceAfterModifier`, the five effect allow-sets
  (`APPOINTMENT_` / `DROP_IN_` / `COURSE_` / `PRODUCT_` / `PROMO_EFFECTS`),
  `BenefitEditor` and every fixture — real but bounded.
- **(Q14) A 100%-off code.** Structurally inexpressible: `percent` caps at 99 and every
  derived price clamps. The cost of allowing it is a payment-less confirm path for
  promos in every rail. So "first class free, 100 seats, January only" cannot be
  run — the workaround is the free-trial door, which is a different feature with
  its own once-per-person gate, no code, no window and no campaign report.
- **(Q8, answered directly) Promo on memberships, one-off or recurring.** Not even the one-off half: a
  Subscriptions tab that takes a code on some rows and not others is worse than a
  clean "not on memberships". This is the single most likely thing a studio will
  ask for ("first month 50% off").
- **(Q5) Promo on a priced trial.** A paid trial is already an acquisition price,
  enforced once per person; stacking a code on it double-discounts the cheapest
  thing in the product. Reversing it is a one-line predicate change plus fixtures,
  precisely because the predicate lives in one place.
- **(Q11, answered directly) A promo field on the waitlist claim page.** See
  "The waitlist claim takes no code, and why".
- **(Q7) Auto-apply and pre-filled campaign links.** Every code is typed. No `?promo=`,
  no auto-apply. A pre-fill is a small addition (one query-param read per surface);
  a code that applies with no visitor action is really "a scheduled sale price" and
  belongs on the entity, not on a code.
- **(Q2) Restoring a redemption on a human-initiated refund.** See
  "Cancellations and refunds".
- **(Q6) A `promo_code` column in the finance CSV export.** The schema is a documented
  append-only public contract, so a trailing column is safe to add later — but it
  would mean putting the code on `FinanceTransaction`, a schema change to an
  otherwise immutable log. The payments-row stamp is the record instead.
- **(Q15) Any notification about a promo.** No email, no SMS, no push — not on apply,
  not on commit, not on exhaustion, not on expiry. `booking/templates.ts` gains
  nothing. **The honest cost:** a studio's only signal is a page they must remember
  to open. The minimal alternative is one email on the first `promo_exhausted` per
  code — a single send, no template family, no preference surface. This is the
  absence most likely to read as a bug from the studio's side.
- **(Q1) Collapsing `invalid` and `not_applicable` into one opaque refusal.** The
  distinction is kept: "this code is for courses" is a much better experience than
  "we could not find that code", and the harm from a harvested flyer code is
  bounded — it is a discount the studio advertised. If an unadvertised
  (newsletter-only, influencer) code is ever judged genuinely confidential, that is
  a one-line change in the preview plus two fewer message keys.
- **Campaign analytics** — attribution, cohort lift, per-channel ROI. The admin
  list's `used / reserved / max` is the report.
- **Stacking two promo codes.** The field is single-valued and best-one-wins is
  settled.
- **A `Product.benefit` field.** The `product` arm accepts `benefit` so a later
  phase adds *data*, not a signature. No product carries one today.
- **A promo reservation sweep job.** Expiry is lazy, exactly as gift-card holds
  are.
- **Reusing `commitGiftCardDrawdown` as the commit seam**, and **reusing
  `planGiftCardRedemption` for the promo floor** — the first cannot run for the
  common case, the second is the wrong floor.

**Built, but the shape was a decision with a visible cost:**

- **(Q3) Studio and above only — `free` 0, `coach` 0, `studio` 20,
  `organization` 100.** The `PRODUCT_LIMITS` precedent grades across all four
  plans rather than zeroing the bottom two, and a solo coach's "first 10 clients
  get 20% off" launch is a real and sympathetic use. It is refused anyway,
  because Free inherits Coach and a non-zero Coach allowance puts discount
  campaigns on the free tier. The nav row is **visible but locked** rather than
  hidden, so the lever teaches the feature exists instead of concealing it.
- **(Q10) Typing a code shortens the buyer's payment window on the product and
  course rails, from 24 hours to about 31 minutes.** Those two rails passed no
  `expires_at` at all before this phase, so Stripe applied its 24-hour default; a
  promo-carrying session now takes the short window, exactly as the gift-card
  sub-branches already did. A buyer who wanted to think about a CHF 180 course
  overnight loses that option the moment they apply a code. The alternative is
  one abandoned cart holding a slot of a strictly-capped campaign hostage for a
  day — which, under Q9, means refusing real customers for a day. A purchase
  carrying **no** instrument keeps its 24 hours untouched.

**Known imprecision, accepted:**

- **(Q13) The per-person cap is per EMAIL ADDRESS, not per human.** A second
  mailbox, or a `+1` alias, defeats it. Shipped as-is with honest copy rather
  than restricted to signed-in surfaces, because gating it on a contact session
  costs conversions on the acquisition surface — which is the one place a
  campaign is trying to work. `PromoCodes.perContactHint` says "Counted per
  email address" in all four locales, and the total cap is what actually bounds
  liability.
- **(Q9) A capped code can read "fully redeemed" while uses remain unsold.**
  Contested, not exhausted — see "Refuse, never over-issue" and the release
  lever.
- **A code can UNDER-report, and that is the deliberate direction.** Ownership
  rule 4 refuses to count a completed sale whose reservation slot is held by a
  newer attempt at the same purchase, or was cleared by the manager lever while
  the session was still payable. The money and the sale are recorded normally;
  only the campaign's counters stay put, and the refusal is logged at ERROR. The
  opposite direction is a cap that can be exceeded, which Q9 forbids outright.
- **One reservation can still back more than one PAID session — the counters are
  bounded, the discounts are not.** A Checkout Session's amount is fixed at
  creation, so a superseded sibling session remains payable at the discounted
  price until it expires (about 31 minutes). On the drop-in and appointment rails
  the second payment is a duplicate the webhook refunds; on the product and
  course rails it is a second genuine order, and the buyer keeps the discount on
  it while consuming exactly one use. Closing that would mean expiring the
  superseded session at Stripe from inside the retry path — an outbound network
  call that can fail, on the most common interaction in the feature, that still
  cannot help once a session is already paid. It would be defence in depth over a
  rule that is already deterministic, so it was not built.
  - **The residual this replaces** was written up here as "ownership narrows the
    release hole; it does not close it completely… at most one sale can come of
    it". That last clause was the same defect wearing a different hat: A and B
    being the same person buying the same thing does **not** bound it to one
    sale, because a product or course rail will happily sell them both. Rule 4
    closes the release-hole ordering too — A's payment lands inside A's own claim
    window, finds the entry gone, and counts nothing.
- **(Q12) A long-standing member whose `acquisition_stage` was never advanced
  past `trial_attended` counts as a new contact** for the audience axis. The
  funnel field is the agreed proxy, chosen over a prior-bookings query for cost;
  a studio whose data is that stale has a contact-data problem, not a promo
  problem.
- **A second mailbox defeats the audience gate as well as the per-person cap.**
  The email fan-out closes the name-spelling evasion and the household case; it
  cannot close "sign up with another address", which is the same residual the
  per-person cap carries and for the same reason.
- **An anonymous preview of a `new_contacts` code reports a discount**, because
  the preview takes no email. The checkout refuses with
  `promo_audience_mismatch`, which every mount renders.
- **A gift-card full-cover purchase leaves no payment row**, so a promo used on one
  is visible only in `usage_count` and the redemptions ledger, never in `/payments`.
- **`mapCategory` has no `'appointment'` case**, so appointment revenue lands in
  `'other'`. Named here so nobody assumes this phase blessed it; no promo path
  depends on it and it was left alone.
- **Nothing in this phase was exercised against a real Firebase project**, and none
  of the emulator + Stripe CLI end-to-end cases in the phase spec's checklist have
  been run. The unit and fixture layers are green; the wire is not proven.

## History and gotchas

- **A `promoRedemptionId` rider on `commitGiftCardDrawdown` was declared a whole
  phase early and then deleted rather than implemented.** Its own comment argued
  against itself ("a rider only fits here when it must happen AFTER the money
  moves"), and it was the second such rider deleted from that function — Phase 2
  removed `waitlistEntryId` for the same reason. The removal is recorded on the
  line where it stood so nobody adds a third.
- **The gift-card hold-key comments asserted a precondition the code did not
  establish** — "keyed by Stripe Checkout Session id", while all three call sites
  mint the key with `generateSecureToken(16)` *before* any Stripe session exists.
  The functions-side header was already correct and only the shared type file was
  stale, which is exactly how the two drifted unnoticed. Fixed here because the
  promo reservation faces the identical ordering constraint: its key must also be
  caller-minted.
- **The code-normalisation rule was re-typed in six places** outside
  `normalizeCode` — two `paymentRef` builders, two `metadata.giftCardCode` stamps,
  the drop-in's metadata stamp, and `buildGiftCardReclassTxns`'s `sourceRef`. The
  reclass `sourceRef` and the callables' `paymentRef` must agree character for
  character, so all six now delegate to the shared helper.
- **On a waitlist claim, the gift-card hold used to expire long before the Stripe
  session it was guarding** — 35 minutes against a 120-minute claim window — so the
  held value became available again and another purchase could spend it. Phase 2
  introduced it by making the Stripe expiry variable while the hold stayed a
  constant. `resolveCheckoutHoldWindow` is the generalisation that closes it.
- **`createDropInCheckout` had FOUR resolver call sites**, not one: the brand-new
  guest branch, plus the waitlist claim, the signed-in contact and the matched
  existing contact, all going through a wrapper. Threading the promo context into
  only the visible one would have failed **silently** — no `promo` outcome, no
  reservation, and the *undiscounted* price charged to every signed-in member who
  was quoted a discount. They are now a **single** resolution point, and
  `N10b` is the backstop: a supplied code that produces no resolver outcome throws
  `internal` rather than charging full price.
- **The three public surfaces price from a documented-as-partial client snapshot**
  (primary `subscription_type_id` only), which is why the `quotedAmount` guard is
  one-sided. Read the note on `assertQuotedAmount` before tightening it.
- **Three defects, one root cause, found in review before any of it shipped.**
  All three were the deterministic reservation key being used as if it were a
  handle on one attempt, and they are pinned by ownership rules 1, 2 and 3 above:
  (a) `promoCheckoutMetadata` gated on "a modifier was loaded" instead of the
  resolver's `applied` verdict, so a **superseded** code — the flagship
  best-one-wins case, a member whose benefit beats the public code typing it
  anyway — reached Stripe carrying a reservation key nothing had reserved, and
  the webhook committed it: a use consumed and that member's one allowed use
  burned, for a discount never given. (b) Release deleted by key with no
  ownership check, so a stale sibling's expiry or a later failed retry freed a
  slot guarding a still-payable session, which is how a "refuse, never
  over-issue" cap gets exceeded. (c) Bringing `runAppointmentSlotTransaction`
  inside the guard — correct in itself — made the hold-release path reachable
  when the hold had never been acquired, so a losing racer's catch cancelled the
  **winner's** live appointment. The lesson worth keeping: a deterministic,
  shared identifier makes "undo what is above me" ambiguous, and the fix is
  always an ownership marker compared inside the transaction, never a unique key
  (which would have destroyed the retry-is-a-refresh property that key exists
  for).
- **…and (c) needed the lesson applied THREE times, at three separate sites, and
  the third was missed twice.** Gating the hold release on `holdAcquired` fixed the
  *stranger* racing the slot but not the **sibling**: `allowRewriteByHolder:
  contactId` lets one contact's second attempt rewrite its own live hold, so
  attempt A could still cancel the session attempt B was about to be paid for. "We
  acquired it" is not "it is still ours". That was site 1. Site 2
  (`createStaffAppointment`'s payment-link catch) cancelled on **presence** under a
  comment claiming it followed site 1's pattern — a false cross-reference standing
  in for the fix. Site 3 (`handleCheckoutExpired`) did the same, and was the
  dangerous one: the promo pre-flight **expires the superseded Checkout Session at
  Stripe**, so that event now arrives seconds after a retry instead of ~31 minutes
  later. Phase 3 converted a rare race into a likely one and then fixed two thirds
  of it.
  The rule now has ONE expression — `decideAppointmentHoldRelease` +
  `releaseAppointmentHold` (`packages/functions/src/appointments/holdRelease.ts`),
  whose header carries **the census** of every release site, the proof each one
  rests on, and the grep recipe for re-deriving it. That header is the ONLY place
  that list is written down, and this paragraph deliberately does not repeat it:
  the sibling census on the promo side is owned by "The census — every site that
  removes a reservation" above, and each of these two documents points at the
  other rather than restating it. The primary proof is `booking_token`, compared
  inside the transaction that deletes — the exact shape `decidePromoRelease` uses
  for `instanceId` — with two named secondary proofs for callers that have no
  token to compare. Fixtures: one block per site, in
  `appointments/holdRelease.test.ts`.
  The race pre-dates promos; what this phase changed is that a sibling attempt
  failing while a newer one holds the slot went from an accident to a **designed**
  outcome, because the promo lifecycle refuses losing attempts on purpose.
- **The idempotency key knew the code but not the ATTEMPT, and it broke a
  purchase.** `defaultIdempotencyKey` buckets by minute and `instrumentKeyParts`
  appended only the promo code — constant across every attempt at one purchase,
  while the request is not (a fresh `promoInstance`, a freshly derived
  `promoExpires`, and on some rails a fresh `giftCardHold`). A checkout
  resubmitted inside the same minute therefore reached Stripe as the same key with
  different parameters and failed with a bare `internal` — and because the
  reserve's pre-flight had *already* closed the buyer's still-live Checkout
  Session, they were left with none at all. `instrumentKeyParts` now takes the
  **ticket**, not the code, so the key varies exactly when a new slot generation
  exists. Freezing the instance instead would have been worse, not better: an
  idempotent replay returns the cached session — the one the pre-flight just
  expired — which is the same sessionless buyer, silently.
- **…and the gift card had the identical defect, one instrument over.** The first
  fix added the attempt marker for the promo only, so a **gift-card checkout with
  no promo** still sent Stripe the same `gift=<CODE>` key with a freshly minted
  `giftCardHold` in the metadata — a parameter mismatch, surfaced as a bare
  `internal`, on every resubmit inside the minute bucket. It was flagged as
  pre-existing and out of scope for a close-out round, which was reasonable and
  still left a known-broken resubmit path in a payments file. `instrumentKeyParts`
  now takes `{ code, holdKey }`, and `createProductCheckout` /
  `createCourseCheckout` hoist the hold key above the key that carries it (the
  drop-in rail already minted it there). The trade is named rather than discovered:
  a resubmit inside the bucket now creates a second session and a second hold
  instead of failing outright — which is exactly what the same request already did
  one second later across the minute boundary, and is bounded by the card's own
  balance.
- **Three of the six findings in the final review round were COMMENTS, and that
  is the theme of the phase rather than an accident.** Six rounds of edits moved
  code out from under prose written for an earlier shape: a rider note that
  miscounted the full-cover branches (and was "fixed" twice, on the sibling copy
  each time), a plain-branch comment claiming Stripe's 24-hour default on the very
  path the flagship promo case takes, a cross-reference to a pattern the referring
  site did not follow, and a "mounted on the guest screen only" note sitting
  directly above the second mount. A false comment is worse than no comment,
  because the next author designs against it — revision 1 of the spec cited a stale
  comment as evidence for where the promo release should go.
  The rule this leaves behind: **a claim about a COUNT, a CALL-SITE LIST, a
  PRECONDITION or an INVARIANT must be checkable without counting.** Name the
  members instead of counting them, state the range's endpoints, or assert it in a
  test — `connect/commitSites.test.ts` is that gate.
- **…and correcting the numbers did not work. Seven rounds, a false count in
  every one.** "Two full-cover branches" (three), "three ownership rules" (five),
  "three mounts" (four renders), "three transactional writers" (five), "six
  copies" (seven), "the only public path" (there are several), "the three rules
  below" (four). Each round found the wrong numbers and shipped new ones,
  because **a comment asserting a count is a claim that silently rots every time
  someone adds a case** — and the reviewer who checks it is not the author who
  broke it. Fixing the arithmetic is not a fix; it is another turn of the same
  wheel.

  So the final round removed the CLASS rather than the instances. Every
  count-of-code-sites claim this phase added was resolved one of three ways, in
  order of preference:

  1. **Point at the owner.** A census is written down ONCE and referred to
     everywhere else. `appointments/holdRelease.ts`'s module header owns the
     appointment-hold census (and `docs/appointments.md`'s duplicate table of it
     is gone); the table above owns the promo-reservation census;
     "The ownership rules" above owns that list, and `CLAUDE.md` and
     `connect/promoCodes.ts` now point at it instead of carrying rival counts of
     it.
  2. **Name the members, drop the number.** A claim you can check by reading the
     names beside it cannot go stale silently — it goes stale *visibly*.
  3. **Assert it in a test.** `connect/commitSites.test.ts` is where a bare
     number is allowed to be a bare number, because there it is executable. It
     now pins the full-cover branches and their promo commits, the appointment-
     hold executor's callers (and that none exists without a census entry, and
     that the census's grep recipe finds them), the promo mount tally across the
     web surfaces, and the gift-card hold-key mint sites.

  The residual is honest: a count in prose that names its members is still prose.
  What changed is that no claim is now BOTH bare and load-bearing.
- **The phase landed in passes, and one pass's gap was silent.** The drop-in and
  product rails were wired before the course rail, the appointment rail and the
  whole webhook half — and the tree did not say so: `promoCheckoutMetadata` was
  imported and never called, so a promo product session reached Stripe with no
  promo metadata and the webhook could neither commit nor release it. Discount
  given, use never counted, reservation stranded. The general lesson is the one
  this feature is built around: **a missing commit is invisible from the outside**,
  which is why `usage_count` has exactly one writer and why the admin page shows
  reserved separately from used.
- **The `new_contacts` audience was broken three times, each fix one layer
  deeper than the last.** First the predicate; then what each rail *fed* it (the
  drop-in rail had no email lookup at all, so a joined member took the code by
  spelling their name differently); then what `resolvePromoCaller` *did* with
  what it was fed — it discarded the email evidence whenever the rail held a
  contact document, which is the household case, so a member's own shared mailbox
  reopened the identical evasion. Each time the campaign burns out on the people
  it was never for, which is the entire failure Q12 was answered to prevent.
  The lesson is not "add the lookup to the other rail", and it is not "fix the
  resolver" either: **a predicate shared across rails is worthless while any
  caller can choose what evidence it sees.** `promoCallerFrom` now takes both
  halves of the evidence as required properties, `resolvePromoCaller` is the only
  producer of that evidence and never short-circuits on a held document, and the
  drop-in rail hands it the contacts it queried **before** minting a provisional
  one — a fresh query there reads as ambiguous and fails open.
- **One reservation slot could back several payable Checkout Sessions, and every
  one of them committed a use.** This took three passes and the first two were
  both fixes to the wrong layer, which is the part worth remembering. The
  deterministic key made a retry a refresh — correct, and load-bearing — but each
  retry still minted a *new* Stripe session, and on the product and course rails a
  second payment is a second genuine order rather than a duplicate to refund.

  Pass 1 added **ownership on delete** (`instanceId`), so a stale sibling could no
  longer free a live slot. Pass 2 added **ownership on spend** plus a claim
  deadline (`promoExpires`), so only one of the sessions sharing a slot could
  count and the two payment orderings stopped differing. Both were right and
  neither closed it, because both bound the *counter* with a *time-limited lease*
  — and a Stripe session can be paid after that lease expires, so the lease and
  the money were on different clocks.

  Pass 3 moved the bound onto the thing that takes money. **`sessionId` on the
  reservation**, closed-before-refresh, compare-and-set in the transaction, and
  close-on-failed-bind: at most one payable session per slot, at every instant
  (ownership rule 5). Release became **prompt and evidence-based**
  (`checkout.session.expired`) with lazy expiry pushed out to an hour as a
  backstop rather than the mechanism. And the commit became a **hard gate**, so
  the counters are bounded without relying on any timing argument at all.

  A `committed` marker would have been the obvious alternative at pass 2; it is
  what made the document unbounded the first time and it collides with the
  deterministic key on a legitimate second purchase, so the claim deadline does
  the same work with no storage and no cleanup.

  What survives as a documented residual — a *discounted price* charged beyond
  `max_uses`, never a counted use, under a webhook delivered more than an hour
  late against a re-handed slot, or under the manager release lever — is stated in
  "What is bounded, and the residuals" rather than claimed away.
- **The course rail assembled its pricing inputs twice.** `loadCoursePricing`
  exists so `previewPromoCode` quotes what `createCourseCheckout` charges (N22),
  and the checkout was still doing it by hand — its own course refusals, its own
  contact + purchase reads, its own `relevantTypeIds` union — while a comment
  claimed they shared the helper. Two assemblies that must agree, with a note
  asserting they already do, is strictly worse than one obvious duplication. The
  checkout now calls the helper, which returns the buyer's contact document (the
  audience gate's input) and the validated `listMajor` so nothing has to
  re-narrow `accessRule.priceAmount`.
- **The entity allow-lists were in the model, honoured by the resolver, and
  unauthorable.** Three fields the reserve path checked on every purchase, that no
  studio could ever set. A narrowing axis with no control is not a smaller
  feature — it is a dead branch that reads as working code.
- **Gates control creation only**, here as everywhere in Wave 3. A team downgraded
  below Studio keeps its live codes fully operational.
