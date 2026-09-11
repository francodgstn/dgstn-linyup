# Payments: contact → studio

> **Scope:** how a studio/coach collects money **from their contacts** (members) —
> memberships, drop-ins, shop, courses. Two rails exist; both feed **one** unified
> payments view inside Linyup.
>
> | Rail | Money settles on | Platform fee | Linyup does |
> |---|---|---|---|
> | **Pay via Linyup** (Stripe Connect) | the **studio's** Stripe balance | yes (per-tier) | runs checkout, refunds, reconciliation |
> | **BYO gateway** (Payrexx / Stripe-BYO) | the studio's **own** account | no | **records** the payment + links a contact (minimal) |
> | **Manual** (cash / bank transfer) | outside Linyup entirely | no | **records** the payment a manager types in + applies what was bought |
>
> CHF-first (with TWINT on Connect). All money is **integer minor units** (Rappen) — never floats.

## The three payment concerns (don't conflate them)

| Concern | Money settles on | Where | Doc |
|---|---|---|---|
| Linyup SaaS billing (Linyup charges studios) | **Linyup** | `saas-billing/`, `getPlatformStripeAdapter()` | [payment-studio-linyup.md](payment-studio-linyup.md) |
| contact → studio **+ platform fee** (Connect) | **Studio** | `connect/`, `utils/connect/` | this doc |
| contact → studio, **no fee** (BYO) | **Studio** | `billing/handlePayrexxWebhook`, `billing/handleTeamStripeWebhook` | this doc |

---

## Unified payments view (both rails)

The web **Payments** page (`/payments`) and the per-contact **Payments** tab merge
both rails in the read layer — Connect (`member_payments` / `member_subscriptions`)
+ BYO (`payment_events`) — into one list. Nav shows the page when Connect is enabled
**or** any BYO gateway is configured.

**Contact matching (both rails).** Email is **not** a unique key in Linyup — a
parent's address routinely controls several child contacts — so a payment links to a
contact only when **exactly one** active contact matches the payer email
(`resolveSingleContact`, `packages/functions/src/utils/contacts.ts`). Zero or
multiple matches → the payment is still **recorded as Unassigned**, and a manager
assigns it. (The public Connect **shop** keeps its approved behaviour: 1 match →
link, 0 → auto-create the contact cap-aware, >1 → Unassigned, never guess.)

**Assign, link, comment.** `updatePaymentRecord({ teamId, source:'connect'|'byo',
paymentId, contactId?, comment?, lineItem? })` (manager-only) (re)assigns the contact,
sets a structured **line-item** ("what was bought"), and/or edits a free-text `comment`
("what was paid" note). The comment is prefilled with a default and offers preset
quick-picks (`PAYMENT_COMMENT_PRESETS`, i18n'd via `PaymentComment.preset_*`).

**Applying a line-item runs the real effects** — the same a Connect purchase would —
through one shared helper, `applyPaymentEffects` (`packages/functions/src/payments/effects.ts`),
reused by the BYO webhooks, the manual entry, and `updatePaymentRecord` on assign:

| `line_item.kind` | Effect on the contact |
|---|---|
| `subscription` | Set subscription fields (`subscription_type_id`/name/price/recurrence) + a credit grant when the price carries `credits`. **No** affiliation/expiry write — the subscription axis is separate from the affiliation axis. |
| `course` | Grant the **lifetime entitlement** (`courses/{id}/purchases/{contactId}`) — unlocks the course in the Space. |
| `product` | Record-only: an `activity_log` entry (merch, no entitlement). |
| `drop_in` / `appointment` / `other` | `last_payment_at` + an activity entry. |

Every effect appends an `activity_log` entry carrying the `payment_id` so the contact
timeline links back to the exact payment. Effects are idempotent (course keyed by
`contactId`; credits keyed by the payment ref), so a redelivery or a re-save never
double-grants.

---

# Rail A — Pay via Linyup (Stripe Connect)

Studio collects from members **+ Linyup takes a configurable platform fee**. Money
settles on the **studio's** Stripe balance via **direct charges** — it never passes
through Linyup's balance. This is the first-class, fully-integrated rail.

## Architecture (locked)

- **Accounts v2 API** (`stripe.v2.core.accounts` / `accountLinks`) with controller-style
  `defaults.responsibilities` — **not** the legacy Standard/Express/Custom account types.
- **Direct charges** on the connected account via Checkout Sessions, with
  `application_fee_amount` (one-off) / `application_fee_percent` (subscriptions).
- **One account configuration** (Standard-equivalent: `dashboard: 'full'`). The studio
  picks a framing on the Linyup side — **"Use my Stripe account"** (connect existing) or
  **"Create a new account"** (guided) — but both produce the same Standard account, and
  the Stripe-hosted Account Link supports both signing into an existing account and
  creating a new one. (Originally specced as two account types — BYO `full` + Managed
  `express` — but test mode confirmed Stripe forbids "studio pays fees + Stripe bears
  losses" on a non-full dashboard, so the express/embedded Managed account was dropped.)
- **CHF only** in Phase 1.
- Feature-flagged per team (`teams/{teamId}.payments.connectEnabled`) so it ships dark.

### The three §6 decisions (final values)

1. **Fee-payer →** the **studio pays Stripe fees** (`fees_collector: 'stripe'`);
   Linyup's application fee is clean margin and **losses are assigned to Stripe**
   (`losses_collector: 'stripe'`) — Linyup is never liable. To satisfy both, the account
   must use the full dashboard (Standard), so there is **one** account config (see above);
   the separate "Managed/express" account from the brief was dropped after test-mode
   confirmed the combination is unsupported.
2. **Per-tier take-rate (revised 2026-08-29 by commercial review, pre-launch;
   supersedes the 2026-06-20 set of 1.7 / 1.2 / 0.7 / 0.4 %):**

   | Tier | Application fee |
   |---|---|
   | Free | 2.5% |
   | Coach | 1.5% |
   | Studio *(brief's "Club")* | 0.8% |
   | Organization | 0.5% |

   Config lives in `packages/shared/src/types/connect.ts` → `CONNECT_TAKE_RATE`
   (basis points + optional minimum fee). The **only** fee entry points are
   `computePlatformFee()` (one-off, returns Rappen) and `takeRatePercent()`
   (subscriptions, returns a percent). No fee is hardcoded anywhere else.

   **Changing a rate is a DEPLOY for everything except recurring memberships.**
   One-off charges (drop-in, appointment, course, product, gift card, priced
   trial) recompute `application_fee_amount` per request, so the new rate is live
   the moment the functions are deployed, and historical charges keep the fee they
   were actually taken at — which is what a proportional refund reversal needs.
   `createSubscriptionCheckoutSession` is the exception: it writes
   `application_fee_percent` ONCE onto the Stripe Subscription on the studio's
   connected account, and Stripe bills every later invoice at that stored number.
   A deploy does not touch it. There is no error and no warning — the membership
   simply keeps billing at the retired rate.

   So every rate change owes ONE Stripe-side check, per environment: walk the
   platform's connected accounts, list each account's billable subscriptions
   (`active`, `trialing`, `past_due`, `unpaid`, `paused`) and compare the stored
   `application_fee_percent` against `takeRatePercent(team.plan, waived)` — resolved
   through those functions and through `resolveFeeWaiver`'s read-to-the-organisation,
   never re-derived, because a second implementation of a money decision is the one
   copy never worth making. The map from account to team is
   `connect_accounts/{acct}.teamId`; an account with no such document has no
   derivable rate and must be decided by hand rather than guessed at. Repair is
   `stripe.subscriptions.update(id, { application_fee_percent }, { stripeAccount })`.
   The Firestore mirror (`member_subscriptions.*.application_fee_percent`) needs no
   separate backfill — the update emits `customer.subscription.updated`, which the
   Connect webhook already re-mirrors.

   **There is deliberately no script for this.** The 2026-08-29 change ran the check
   against `linyup-sandbox` and `linyup-prod` and found zero stale subscriptions in
   both — pre-launch, no recurring membership had been sold yet — so the deploy WAS
   the whole migration. A tool kept alive for months without ever running would go
   stale against the very comp logic it copies, and be trusted post-launch precisely
   when being wrong costs money. Write it fresh, against whatever the code says then.

   The Stripe **catalogue** (`pnpm stripe:sync`) is NOT involved: it holds Linyup's
   own plan Products and Prices, and the take-rate is not a catalogue object.
3. **TWINT + direct-charge + Connect — validate in test mode.** Documented constraint:
   only **one active TWINT mandate per studio↔member pair**. See "Validate in test mode".

### Liability (single Standard config — both framings)

| | Standard account (`dashboard: 'full'`) |
|---|---|
| Stripe processing fees | Studio (`fees_collector: 'stripe'`) |
| Negative balance / chargeback loss | Stripe (`losses_collector: 'stripe'`) |
| Requirements / KYC | Stripe-collected |
| Linyup liability | none |

## Required secrets / env vars

| Secret (Secret Manager id) | Env var (emulator) | Purpose |
|---|---|---|
| `stripe-secret-key` | `STRIPE_SECRET_KEY` | Platform key — **reused** from SaaS billing. The Connect platform *is* Linyup's Stripe account. Prefer a **restricted key** with Connect write scope in prod. |
| `stripe-connect-webhook-secret` | `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret for the **Connect** webhook endpoint (separate from `stripe-webhook-secret`, the SaaS-billing endpoint). |

Terraform provisions the container in all environments (`infra/environments/*/variables.tf`
→ `secret_ids`). Add the value out-of-band:

```bash
echo -n "<whsec_...>" | gcloud secrets versions add stripe-connect-webhook-secret --project=linyup-staging --data-file=-
```

For local dev add to `packages/functions/.env.local`:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...   # from `stripe listen` (Connect), see below
```

## Enabling the feature

**Self-serve.** Any team owner can set it up from **Settings → Payments** ("Set up
payments") and onboard their Stripe account — no operator action needed. The card is
visible by default. An operator can **disable** a team (kill-switch) by setting
`teams/{teamId}.payments.connectEnabled = false` (admin-only; the team `payments` map
is admin/function-only in `firestore.rules`). Absent/`true` = allowed; only an
explicit `false` blocks. The **Payments** nav entry appears once a team has started
onboarding (a connected account exists) or has a BYO gateway configured.

### Operator console (apps/admin)

The accounts **list** shows a per-team Connect status badge (Enabled / Restricted /
Pending / Not set up / Disabled). The account **detail** page has a "Payments · contact
→ studio" card: onboarding model, charges/payouts enabled, connected-account id,
outstanding requirements, and aggregated totals (gross collected, Linyup fees earned,
refunded, payment count, active subscriptions). The admin app reads via the Admin SDK
(server-side), so no Firestore rule changes are needed.

## Selling subscription types (membership linkage)

Connect is the payment rail for the team's **subscription types** (the membership
catalog, `teams/{teamId}/subscription_types`). `createMembershipPayment` resolves a
chosen `subscription_type` + price and routes by recurrence:

- **Recurring** (`weekly`/`biweekly`/`monthly`/`quarterly`/`annual`) → a Stripe
  subscription on the connected account (interval + `interval_count`).
- **One-off** (`one_time`, `per_class`) → a single direct charge. A `one_time` price
  carries `included_months`; on payment the member's `membership_expiration` is set to
  `now + included_months` (e.g. "intro offer: CHF 100, 2 months incl.").

On a successful payment the webhook **updates the buyer's contact**:
`subscription_type_id`, `subscription_price_id`, `subscription_amount`,
`subscription_recurrence`, `membership_expiration`, `last_payment_at`, plus an
`activity_log` entry. The contact is resolved by `metadata.contactId` (preferred) or a
unique email match. Managers create a payment link from the **Payments dashboard →
"Create payment link"** (pick type + price + member email).

## Drop-in (pay-per-class booking)

A contact **not covered** by an activity's access rule can pay a **per-class** drop-in fee
to book a single **group-class** session, over the same Connect one-off checkout. No
membership is created — a drop-in is a single paid booking, not a subscription.

- **Config — one default, per-class exceptions (2026-09-11).** The price has a
  studio-wide default, `BookingSettings.dropIn = { enabled, priceAmount }` (major units,
  the team's currency), stored with the other booking settings on the team's public
  profile — the one document the callables, the public pages and the mobile app already
  read — and edited on **Offerings → Pricing** ("Drop-in" card), because it is a price
  rather than a booking rule. Each class then says how it relates to it,
  `Activity.dropIn.mode` (`DropInMode`, `packages/shared/src/types/activity.ts`):
  `'studio'` follows the default (what a new class starts as), `'custom'` names its own
  `priceAmount`, `'off'` sells no drop-in even when the studio has a default. A document
  from before the default (no `mode`) reads as `'custom'` when it named a price and as
  `'studio'` otherwise — so a class that never named a price follows the studio the day the
  studio sets one, with no click per class. **THE ONE READER is
  `resolveActivityDropIn(activity, studioDropIn)`** (`packages/shared/src/utils/dropIn.ts`,
  with `studioDropInOf(bookingSettings)` for the second argument); nothing that decides may
  read `activity.dropIn.enabled` / `.priceAmount` directly, because a class that follows the
  studio stores no price of its own. The activity `public_profile` carries the **RESOLVED**
  price, so no public reader knows a default exists; `syncStudioDropIn`
  (`packages/functions/src/sync/`) rewrites the mirrors of every `'studio'` class when the
  default changes, through the same pure `buildActivityPublicProfile` the per-activity sync
  uses. Independent of the `trialEnabled` toggle (a gated class can offer members-free +
  trial + drop-in at once).
- **Flow (hold-pending → webhook-confirm).** The public **`createDropInCheckout`** callable
  (`booking/dropIn.ts`) resolves/creates the contact (payment is the proof — **no email
  verification**), writes a **PENDING** booking hold
  (`sessions/{id}/bookings/{contactId}` with `status: 'pending'`, `payment_status: 'required'`,
  `expires_at` ≈ now + 30 min), then starts a one-off Connect Checkout with metadata
  `{ kind: 'drop_in', sessionId, contactId }`. The amount is computed **server-side** from
  `dropIn.priceAmount`; the call is rate-limited like the other public checkouts.
- **Confirmation.** The `checkout.session.completed` webhook (`handleDropInCheckout` in
  `connect/webhook.ts`) flips the hold to `status: 'confirmed'`, `payment_status: 'paid'`,
  writes `member_payments/{pi}` (`purpose: 'drop_in'`, `sessionId`), counts it toward the
  session, and logs a `drop_in_booked` activity entry. It is idempotent on redelivery,
  **refunds a duplicate second charge** for an already-confirmed booking, and **recreates**
  the booking from metadata if the hold was swept before payment landed (a paid charge is
  never lost).
- **Holds.** Unpaid holds are released by the daily **`expirePendingBookings`** task
  (`payment_status == 'required' && expires_at <= now`; composite index on the `bookings`
  collection group). A pending hold does **not** block a later free `bookSession` (only a
  confirmed booking / attendance does).
- **Booking UI.** `/public/{slug}/booking` offers a **"Drop-in — pay to book"** path for a
  gated class with drop-in enabled; members who are covered still book free via sign-in.
  Stripe redirects to `/{locale}/pay/result?seg=booking`.
- **Scope.** Group-class only (coaching is rejected — 1:1 capacity model). The mobile app
  books coaching only, so it has no drop-in surface.

## Paid trial (a newcomer's discounted first class)

A studio may price the **trial** itself rather than giving it away — the common real-world
shape "first class CHF 15, drop-in CHF 25, 10-class pack CHF 230". It is a **trial**, not a
subscription: one per person, newcomer-only, no membership created.

- **Config.** `Activity.trialPriceAmount` (major units, class-only) sits next to the
  `trialEnabled` toggle in `offer/activities`. **Absent/null ⇒ the trial stays FREE** —
  today's behaviour, untouched. Only offered (and only mirrored to the activity
  `public_profile`) on a **gated** class with `trialEnabled === true`: on an `open` class
  the trial door grants nothing extra — everyone books free — so a price there would be
  inert, and both the form and `bookSession` treat it as absent.
- **Flow.** Reuses the drop-in plumbing wholesale: **`createDropInCheckout`** takes a
  `trial: true` input that charges `trialPriceAmount` instead of `dropIn.priceAmount` and
  waives the drop-in-configured requirement (a class may sell a paid trial with no drop-in
  at all). Metadata stays `kind: 'drop_in'` plus `trial: 'true'`, so the existing
  `handleDropInCheckout` confirms it unchanged.
- **One trial per person.** `Contact.trial_used_at` is stamped when a trial booking
  *completes* — by `bookSession` on the free path, by the webhook on the paid one (never on
  a duplicate redelivery, so it can't double-stamp). Both doors refuse a second attempt with
  `failed-precondition { reason: 'trial_used' }`, resolved **by email** so fudging a name
  doesn't buy another one. This tightens the previously unlimited free-trial door too.
- **Bypass-proofing.** `bookSession` refuses a free booking of a priced trial with
  `failed-precondition { reason: 'payment_required', priceAmount }`; the booking UI routes
  to checkout up front and also recovers from that error by redirecting rather than dead-ending.
- **Booking UI.** The activity card shows a **"Trial {price}"** chip next to the type chip
  (a free trial keeps the existing "Free trial" chip), and the newcomer door reads
  "Try your first class for {price}".
- **The money says it was a trial (UX-66).** The charge was always recorded — a
  `member_payments/{pi}` row, a finance-journal charge row, `payment_status: 'paid'` on the
  booking — but every one of them said `drop_in`, and `Contact.trial_used_at` is stamped
  identically by the free door and the paid one. So after the fact nothing connected the
  studio's income to the trial that earned it, and nothing said whether a given contact's
  trial had been paid for. `PaymentLineItem.trial` closes both with one field: a **system
  stamp**, written by the Connect webhook from `md.trial`, never read off a client payload
  by `normalizePaymentLineItem`, carried across a manager's edit by `updatePaymentRecord` —
  the same three rules as `promoCode` and `introOffer`. It surfaces as a "Paid trial" chip
  in `PaymentsTable`, which is also the contact's Payments tab, so one chip answers both
  questions.
  **It is not a category and not a subscription.** No `FinanceCategory` member, no journal
  row of its own, no CSV column, no arm in `resolvePaymentOptions`: a paid trial is a
  drop-in sale that happened to be somebody's first, and the money event is the charge that
  is already booked.
  *Known gap:* a trial covered in full by a **gift card** creates no payment row at all
  (that rail books a finance reclass instead), so it carries no chip. That is a property of
  full-cover gift-card redemption generally, not of trials.

## Appointments (pay-per-1:1 booking)

The 1:1 counterpart to drop-in, over the same Connect one-off checkout — but with its
own model: the base price is **per duration** on the appointment activity
(`Activity.durations[].priceAmount`), the member benefit is **one rule per activity**
(`Activity.memberBenefit`: `included` books free, `discount` takes a % off), and there
is **no access gate** — the price is the gate; the checkout charges the caller's
**effective** amount. Since an appointment session doesn't exist until booked,
**the hold IS the session** — `createAppointmentCheckout` (`appointments/checkout.ts`)
reserves the slot as a `pending_payment` session (+ a `pending`/`required` booking,
`hold_expires_at` ≈ now + 30 min, Stripe `expires_at` at 31) before starting the
Checkout, with metadata
`{ kind: 'appointment', sessionId, contactId, activityId, providerId, startMs,
durationMinutes }`. The `checkout.session.completed` webhook (`handleAppointmentCheckout`)
confirms the hold (or re-acquires a swept slot, or refunds a lost/duplicate one) and
writes `member_payments/{pi}` with `kind: 'appointment'` + `sessionId`;
`checkout.session.expired` (`handleCheckoutExpired`) releases a still-pending
hold promptly. Full architecture — pricing model, the price-is-the-gate rule, the hold
state machine, race cases: **`docs/appointments.md` → "Paid appointments"**.

## Refunds take back what the payment bought — and a used pack is a commitment

**A full refund takes back what that payment granted. A class pack that has been used
is not refundable in the app.**

Refunding a member payment also reverses its *effects* (`payments/reversal.ts`, called
from `refundMemberPayment`): the membership snapshot is cleared, the course entitlement
deleted, an untouched credit pack revoked — each only if **that payment** is the one
that granted it (`subscription_source_ref` / `purchases.payment_ref`), so a later
purchase or a manual grant is never stripped by a refund of an older charge. Partial
refunds are refused on anything that granted something (membership, course, pack) and
allowed where nothing was granted (products, drop-ins, appointments, gift cards).

The pack rule is the one that surprises people, so: a pack's per-class price is a
**discount against the drop-in price**, and that discount is exactly what the member
committed to in exchange. Once a class has been taken the commitment has been partly
performed on both sides, and any split of it the app could compute would be a policy
decision wearing arithmetic. So the app declines to guess — it refuses, and the dialog
says *"{Member} has used 3 of the 10 classes on this pack"* plus the rule. Deliberately
**no pro-rata figure exists anywhere in the codebase**; reintroducing one reopens this
decision rather than filling a gap.

**The escape hatch:** a studio that wants to be generous refunds the charge **in Stripe
directly**. Linyup records the refund but revokes nothing (there was no manager intent
here to act on), and the external-refund flag then lets a manager revoke the access
deliberately, as a separate decision.

## Functions

| Function | Type | Who | What |
|---|---|---|---|
| `startConnectOnboarding` | callable | owner | Create the connected account (once) + return a hosted Account Link URL. |
| `getConnectStatus` | callable | owner | Refresh status from Stripe, persist, return charges/payouts enabled + outstanding requirements. |
| `createMembershipPayment` | callable | manager+ | Sell a subscription type + price → routes recurring/one-off, links the contact on payment. |
| `createMemberPayment` | callable | manager+ | Ad-hoc one-off direct-charge Checkout Session (+ `application_fee_amount`). |
| `createMemberSubscription` | callable | manager+ | Ad-hoc subscription Checkout Session (+ `application_fee_percent`). |
| `createMembershipCheckout` / `createProductCheckout` / `createCourseCheckout` | callable (public) | anyone | Member self-checkout from the public shop (email only). |
| `createDropInCheckout` | callable (public) | anyone | Pay-per-class booking — writes a pending booking hold + a one-off Checkout; the webhook confirms the booking on payment. See [Drop-in](#drop-in-pay-per-class-booking). |
| `createAppointmentCheckout` | callable (public) | anyone | Pay-per-appointment booking — reserves the slot as a `pending_payment` session (the hold IS the session) + a one-off Checkout at the caller's **effective** per-duration price; the webhook confirms on payment. See [Appointments](#appointments-pay-per-11-booking). |
| `refundMemberPayment` | callable | manager+ | Refund a charge, reversing the platform fee proportionally. |
| `updatePaymentRecord` | callable | manager+ | (Re)assign the contact + edit the comment (shared with BYO). |
| `handleConnectWebhook` | onRequest (public) | Stripe | Verify + reconcile account / payment / subscription / refund / dispute state + contact membership. |

> **Every one-off checkout callable now accepts an optional `quotedAmount`**
> (major units — the figure the surface actually rendered) and an optional
> `promoCode`. `assertQuotedAmount` (`connect/checkout.ts`) compares the quote to
> the resolved price and refuses `failed-precondition` with
> `{ reason: 'price_changed', amount, promoRefusal? }` — carrying the *current*
> figure, and the typed code's own verdict when the code is why the figure moved
> (`docs/promo-codes.md` → "Refusals"). The commonest cause of this refusal is a
> refused code, not a moved price, and the surface says which.
>
> **The guard is scoped to promo-carrying checkouts** (a required
> `scope: { promoAttempted }` argument, so no call site can be silently in or out
> of it). Without a code the rendered price is an optimistic render, not a quote:
> the public surfaces price from a documented-as-partial client snapshot (a
> contact session carries only the *primary* `subscription_type_id`, every held id
> is reported unmetered, the shop fetches its catalogue once), and that snapshot
> and the server's are allowed to disagree. Enforcing a quote there refuses
> ordinary sales — an exhausted credit pack listed in a benefit, a price raised
> under an open tab — deterministically and with no way out.
>
> **It is one-sided:** it fires only when the server resolves a price *higher*
> than the caller was shown. Being charged more than the screen said is the harm;
> being charged less needs no consent — a member whose benefit comes from a
> secondary held type is routinely quoted base by the client and the discounted
> price by the server, and a strict `!==` would refuse that sale for being cheaper
> than advertised.
>
> **The refusal is recoverable:** `details.amount` is the server's figure; each
> mount renders it, offers the purchase at it, and re-sends it as `quotedAmount`
> on the next attempt. Sending no `quotedAmount` proceeds. See
> `docs/promo-codes.md`.

> Same-session redirect targets (Checkout success/cancel, Account Link return/refresh)
> are built from the **caller's origin** when it's a trusted Linyup/localhost origin
> (`resolveBaseUrl`, `utils/env.ts`), so local dev returns to localhost; otherwise they
> fall back to the env-configured `HOSTING_URL`.

### Data model

- `connect_accounts/{stripeAccountId}` — top-level, keyed by `acct_...` so the webhook
  resolves `event.account → teamId` with one `.get()`. Mirror on `teams/{teamId}.payments`.
- `teams/{teamId}/member_payments/{paymentIntentId}` — one-off charges + refunds (+ `comment`).
- `teams/{teamId}/member_subscriptions/{subscriptionId}` — recurring memberships.
- `connect_webhook_events/{eventId}` — idempotency markers (functions only).

All are **function-written only**; managers/owners get read access for the dashboard.

## Public shop (member self-checkout) — LOGIN-FIRST

A public, member-facing page at **`/public/{slug}/shop`** lists the team's public
subscription types, products, and online courses. Checkout is **login-first — no
anonymous buying**: the buyer completes the passwordless OTP sign-in before paying
(picking a contact when the email matches several, e.g. a parent choosing the right
child). An **unknown email registers a minimal contact** right in the sign-in dialog
(first + last name only — `loginContactWithCode` with `newContact`); the full signup
page stays as a secondary link.

The `createMembershipCheckout` / `createProductCheckout` / `createCourseCheckout`
callables **require a contact session** (`requireContactSessionForTeam`) and always
carry `metadata.contactId`, so the webhook links the sale — and grants course
entitlements — to the **exact** contact, never an email guess. Email-based
`resolveOrCreateContact` remains only as the webhook's safety net for in-flight
legacy sessions. Stripe redirects to `/{locale}/pay/result`.

**Provisional contacts (leads don't count toward the cap).** `provisional: true`
marks every entrant that hasn't MATERIALIZED yet — shop registrations awaiting their
first payment, trial bookings never attended, and public-form leads. They are
excluded from the contact-cap count and live under the contacts page's **Leads**
tab. Materialization clears the flag: a successful payment (webhook, any kind incl.
drop-in), first attendance, stage promotion to attended/joined, full signup
completion, a manual subscription assignment, or the studio's manual Confirm.
Only shop registrations carry `provisional_expires_at` (purge countdown): the daily
`purgeProvisionalContacts` task hard-deletes those after 7 unpaid days. Trial/form
leads are never purged — stale never-attended trial bookings are ARCHIVED by the
default `lib_trial_cleanup` automation rule (installed active for every new team by
`onTeamCreated`; editable/pausable in the Automations UI).
Guards on shop registration: the plan's hard cap (Free 15, measured against
*counted* actives → `failed-precondition` with `reason: 'contact_cap'`), a per-team
daily registration budget (20/day), a per-IP hourly OTP-send limit, and App Check on
both auth callables.

**Contact-capture modes.** `checkout_contact_mode` `'off'`/`'minimal'` are obsolete
under login-first (the buyer is always a real contact); **`'full'`** survives as the
post-payment "finish your profile" nudge (success page lands on `seg=signup`).

Entry points: a **bio-link** "Shop" system link (auto-shown once Connect is enabled,
owner-toggleable) and the **website pricing** component (each plan card deep-links
`/public/{slug}/shop?type={id}`, plus a "view all" link). The `shop` segment is a
reserved slug.

## Webhook setup

The Connect endpoint must receive **connected-account** events. With the Stripe CLI,
forward Connect events to the local emulator (note `--forward-connect-to`):

```bash
stripe listen \
  --forward-connect-to "http://localhost:5001/demo-linyup/europe-west6/handleConnectWebhook"
```

Copy the printed `whsec_...` into `STRIPE_CONNECT_WEBHOOK_SECRET` and restart the
Functions emulator.

### Deployed environments — provision both endpoints with `stripe:sync`

Don't hand-register them: the event lists live in the repo (`scripts/stripe-sync.ts`,
`WEBHOOKS`) alongside the handlers they must match, and the script is idempotent —
keyed by URL, dry-run by default.

```bash
# dry-run — shows what it would create / which events are missing
pnpm stripe:sync --project linyup-sandbox

# create the endpoints and print the signing secrets
pnpm stripe:sync --project linyup-sandbox --apply

# ...or write the secrets straight into Secret Manager (needs secretVersionAdder)
pnpm stripe:sync --project linyup-sandbox --apply --store-secrets
```

**No key on the command line.** With `--project`, the script reads
`stripe-secret-key` from that project's Secret Manager — the same value the
deployed functions use, so the two can't drift, and the key never reaches shell
history. `STRIPE_SECRET_KEY` still overrides when you need it (local, CI).

The key is what selects the account and the mode, so the script refuses a
mismatch: `linyup-prod` requires `sk_live_…`, every other project requires
`sk_test_…`. Override with `--force` only if you mean it. This matters most for
webhooks, where the damage is quiet — a live-mode endpoint pointing at sandbox
looks perfectly healthy and simply never fires.

Re-running is safe: an existing endpoint is left alone, and any events missing from
it are reported (added with `--apply`). The signing secret of an existing endpoint
**cannot be re-read** — only rotated in Stripe — which is why the script stores it at
creation time. Values can also be set by hand in the ops console under
**Settings → Payments**.

Two endpoints are provisioned:

| Endpoint | `connect` | Carries |
|---|---|---|
| `handleStripeWebhook` | `false` | SaaS billing — studios paying Linyup |
| `handleConnectWebhook` | **`true`** | member → studio payments |

`connect: true` is the one that fails silently if you get it wrong: the endpoint
looks healthy and receives nothing, so payments take the money and bookings never
confirm. The Connect endpoint subscribes to:

```
account.updated, capability.updated                     (account state; v2.core.account* too)
checkout.session.completed                              (links/creates the buyer's contact)
checkout.session.expired                                (releases appointment payment holds)
payment_intent.succeeded, payment_intent.payment_failed
charge.refunded, charge.updated
charge.dispute.created, charge.dispute.closed
customer.subscription.created/updated/deleted
invoice.paid, invoice.payment_failed
payout.paid, payout.failed
```

(`v2.core.account*` is a wildcard the API won't accept as an `enabled_events`
literal, so the script omits it — add it in the dashboard if you want v2 thin
account events; `isAccountEvent` in `connect/webhook.ts` already handles them.)

## Test instructions

1. Enable the flag on a test team (`payments.connectEnabled = true`).
2. Call `startConnectOnboarding({ teamId, model: 'managed' })` → open the returned URL,
   complete Stripe's **test** onboarding (use the "skip / use test data" affordances).
3. Call `getConnectStatus({ teamId })` → expect `charges_enabled: true` once card_payments
   is `active`.
4. **One-off:** `createMemberPayment({ teamId, amount: 2500, purpose: 'drop_in' })` → pay with
   test card `4242 4242 4242 4242`. The `payment_intent.succeeded` event writes
   `member_payments/{pi}` with the `application_fee_amount`.
5. **Subscription:** `createMemberSubscription({ teamId, amount: 5000, interval: 'month' })` →
   pay → `customer.subscription.created` + `invoice.paid` write `member_subscriptions/{sub}`.
   Use **test clocks** to advance renewals.
6. **Refund:** `refundMemberPayment({ teamId, paymentIntentId })` → `charge.refunded` reconciles
   `amount_refunded` + `status`; the application fee is reversed proportionally.
7. **Dispute:** trigger `charge.dispute.created` (e.g. card `4000 0000 0000 0259`) → status
   surfaces on the payment doc.

### Faster local setup — reuse a test account (`connect:test-account`)

Steps 1–3 (hosted onboarding) only need doing **once** per Stripe test platform — the
connected account persists in Stripe, but the Firestore wiring (`teams/{id}.payments` +
`connect_accounts/{acct}`) is wiped on every emulator reseed / fresh team. Re-wire it in
one command instead of re-onboarding:

```bash
pnpm connect:test-account --list                                    # list the acct_… ids
pnpm connect:test-account --team <teamId> --account acct_xxx --target emulator
```

It writes both docs with `connectStatus: enabled` (what `requireChargeableAccount` gates
on), trusting the account is already onboarded — the real charge still runs against Stripe,
so the acct must genuinely be onboarded. Flags: `--refresh` pulls the real live status from
Stripe (needs `STRIPE_SECRET_KEY`, else `packages/functions/.env.local`); `--disable` clears
the wiring; `--target staging` targets linyup-staging via ADC (prod refused). One account
maps to exactly one team (`connect_accounts/{acct}.teamId` is the webhook's route), so use
one test account per team.

Lead-demo seeds wire it inline: `pnpm lead:seed --lead <id> --connect acct_xxx` (or set
`STRIPE_CONNECT_TEST_ACCOUNT` / `profile.stripeConnectTestAccount`), so a reseeded lead
tenant can take payments immediately — shared helper `scripts/lib/connect.ts`. See
`scripts/leads/README.md`.

### Enable TWINT on a test connected account

Checkout shows whatever the **connected account's** payment-method configuration has on
(direct charges + dynamic payment methods — `createOneOffCheckoutSession` never passes
`payment_method_types`). The platform's own Settings → Payment methods page does NOT
affect this. Two independent switches, both API-doable in test mode (the CLI is logged
into the sandbox — no key handling):

```bash
# 1. Capability — usually already 'active' on CH accounts; if missing, request it
#    (instant in test mode, no real KYC):
stripe post /v1/accounts/acct_xxx/capabilities/twint_payments -d requested=true

# 2. The actual gate — flip TWINT on in the ACCOUNT's payment-method config(s):
stripe payment_method_configurations list --stripe-account acct_xxx
stripe payment_method_configurations update pmc_xxx --stripe-account acct_xxx \
  -d "twint[display_preference][preference]=on"     # repeat per pmc_… returned
```

Expect `twint: available: true, preference: on` in the response — the next CHF checkout
session offers TWINT immediately (no code change / restart). Dashboard equivalent:
Connect → Connected accounts → *account* → Payment methods → Edit → TWINT *On by
default*. Constraints: **CHF-only** sessions; reliable on **one-off** (`mode: payment`)
checkouts (recurring TWINT depends on the API version — see "Validate in test mode");
test mode shows a simulator page with Authorize/Fail instead of the app handoff. Note
TWINT charges are `py_…` objects whose balance transaction arrives AFTER
`payment_intent.succeeded` — the `charge.updated` healer upgrades the finance journal's
fee split (see `docs/finance-reports.md`).

### Drop-in (pay-per-class)

End-to-end for the [drop-in flow](#drop-in-pay-per-class-booking). Needs a test team with
Connect enabled + a chargeable connected account (steps 1–3 above) and the Connect webhook
forwarded (see [Webhook setup](#webhook-setup)).

1. **Configure a drop-in class.** In `offer/activities`, create a **group-class** activity
   with a **gated** access rule (*Members only* or *Specific subscriptions*) and **drop-in
   enabled** with a price (e.g. `25`). Add a **future session** for it.
2. **Book as a non-member.** Open `/public/{slug}/booking`, pick the class → **"Drop-in —
   pay to book"** → fill name + email → pay with test card `4242 4242 4242 4242`.
3. **Expect the confirmation.** The `checkout.session.completed` webhook (`kind: drop_in`)
   flips `sessions/{sessionId}/bookings/{contactId}` from `status: pending` /
   `payment_status: required` to `status: confirmed` / `payment_status: paid`, and writes
   `teams/{teamId}/member_payments/{pi}` with `purpose: drop_in` + `sessionId`. Verify both
   in the Firestore emulator UI ([localhost:4000](http://localhost:4000)); the buyer lands
   on `/{locale}/pay/result?seg=booking`.
4. **Coverage refusal.** As a contact who *does* hold the required subscription, the
   callable throws `failed-precondition` ("you can already book this class for free") — the
   booking UI routes covered members to the free sign-in path instead.
5. **Abandoned hold.** Start a checkout but don't pay → the booking stays `pending`; confirm
   it does **not** block a later free `bookSession`, and that the daily
   `expirePendingBookings` task deletes it once `expires_at` passes.
6. **Double-charge guard.** Pay two Checkout sessions for the same class+contact → the
   second `checkout.session.completed` finds the booking already `confirmed` and issues an
   automatic refund (a duplicate `member_payments` row lands as `status: refunded`).

### Appointment (pay-per-1:1)

End-to-end for the [appointment checkout](#appointments-pay-per-11-booking). Same
prerequisites as the drop-in test (chargeable connected account + Connect webhook
forwarded — the CLI forwards `checkout.session.expired` too).

1. **Price a duration.** In `offer/activities`, give an **appointment** activity a
   priced duration (e.g. 60 min → `85`) and publish availability covering it.
2. **Book as a guest.** Open `/public/{slug}/appointments`, pick coach → activity →
   the priced duration (the chip shows the price) → a time → fill name + email → pay
   with `4242 4242 4242 4242`.
3. **Expect the confirmation.** During checkout the slot is HELD: `sessions/apt_…`
   exists with `status: pending_payment` + `hold_expires_at` (ghosted "Awaiting
   payment" in the admin calendar). On payment, `checkout.session.completed`
   (`kind: appointment`) flips the session to `full` (hold field deleted), the booking
   to `confirmed`/`paid` (+ `payment_intent_id`, `fullname`), and writes
   `member_payments/{pi}` with `kind: appointment` + `sessionId`. The buyer lands on
   `/{locale}/pay/result?seg=appointments`.
4. **Covered refusal.** As a contact holding a type listed in the activity's
   `memberBenefit` with `kind: 'included'`, `createAppointmentCheckout` throws
   `failed-precondition` (`reason: 'covered'`) — the picker books them free instead
   (a credit-pack type spends a credit). A `discount` benefit doesn't refuse: the
   Checkout amount is simply the discounted price (≥ CHF 0.50). Conversely, a payable
   caller on `bookAppointment` gets `reason: 'payment_required'` with their effective
   amount.
5. **Abandoned hold.** Start a checkout, don't pay → the slot stays blocked for other
   browsers; after ~31 min `checkout.session.expired` cancels the hold (or hand-expire
   `hold_expires_at` and watch the picker re-offer the time lazily; the daily
   `expirePendingBookings` sweeps it to `cancelled`).
6. **Double-charge guard.** Pay two Checkouts for the same slot+contact → the second
   delivery refunds the duplicate PI (`member_payments` row `status: refunded`).

Unit tests for the fee calculation: `pnpm --filter @linyup/functions test`
(`computePlatformFee` / `applyTakeRate`). Build `@linyup/shared` first.

### Validate in test mode (status)

Confirmed against Stripe test mode (2026-06-19, run via the guarded integration suite):

- ✅ **Account configuration accepted** — Standard account creation (full dashboard,
  `fees_collector: 'stripe'`, `losses_collector: 'stripe'`, `card_payments` + `twint_payments`
  capabilities) is accepted once Connect + Accounts v2 are enabled on the platform. The
  express/embedded Managed variant was **rejected** ("account configuration is not supported")
  — hence the single Standard config above.
- ⚠️ **"Use my existing account" — MISREAD HERE, corrected 2026-08-23.** This bullet used to
  read ✅ "the `dashboard: 'full'` Account Link lets a studio sign into an existing Stripe
  account or create a new one (both framings)". Signing in is real, but it only **prefills**
  the studio's already-verified details onto the **newly created** account — the account they
  already had is never attached. Confirmed against production 2026-08-22: an owner who picked
  "use your existing account" ended up with a second, empty business. Attaching a pre-existing
  account needs the Standard OAuth flow (`connect.stripe.com/oauth/authorize`), which is not
  implemented. The studio-facing copy no longer offers it, and the two-option picker this
  bullet justified was removed — both options built the same account. Authoritative note:
  `packages/functions/src/utils/connect/client.ts`, on `MODEL_DASHBOARD`.
- ✅ **Direct charge + refund** — one-off direct charge with `application_fee_amount`, then a
  partial refund with proportional fee reversal, both succeed on the connected account.
- ✅ **Enablement derivation** — on a fully-onboarded account, `normalizeAccount()` correctly
  produced `status: enabled`, `charges_enabled: true`, `payouts_enabled: true`; on a restricted
  account it surfaces the exact `requirements_currently_due` list for the finish-setup UI.
  (Test mode permits charges on a still-`restricted` account; production blocks them, which
  `requireChargeableAccount` enforces by gating on `enabled`.)
- ✅ **TWINT capability** — after full KYC onboarding, `twint_payments` flips to `active`
  alongside `card_payments`, confirming TWINT works under direct charges + Connect.
- ⏳ **TWINT recurring** — the only remaining manual check: the **one-active-mandate-per-
  studio↔member** behavior on subscriptions needs a real TWINT Checkout payment (redirect-based,
  so not server-automatable).

## Out of scope (Phase 1)

Multi-currency / EUR payouts, custom payout scheduling, instant payouts, split-cart
marketplace checkouts, becoming a Payment Facilitator or Merchant of Record.

---

# Rail B — BYO gateway (record-only)

A studio that runs its **own** payment gateway (Payrexx, or its own Stripe account)
keeps all the money (no platform fee). Linyup's role is deliberately **minimal**: it
**records** each confirmed payment and links it to a contact. Linyup does not run the
checkout, manage refunds, or hold any gateway credentials — only the per-team **webhook
signing secret**, used to verify signatures.

> Want Linyup to run the checkout, handle refunds, and take a platform fee? Use
> **Rail A (Connect)** above — a different rail.

Each team configures exactly one gateway at
`teams/{teamId}/integrations/{integrationId}` (type `payment_gateway`).

| Gateway | Webhook handler | Status |
|---------|----------------|--------|
| Payrexx | `handlePayrexxWebhook` | ✅ Implemented |
| Stripe (BYO) | `handleTeamStripeWebhook` | ✅ Implemented (record-only) |

Matching, Unassigned handling, the `comment` field, and the unified payments page are
shared with Connect — see **Unified payments view** above.

## The BYO ledger — `teams/{teamId}/payment_events/{gateway}:{gatewayRef}`

The unified `ExternalPayment` record. Written atomically by the webhook handlers on
first delivery, and patched by `updatePaymentRecord` when a manager (re)assigns the
contact or edits the comment. Write-once on the webhook side — a redelivery (and any
later manager edit) is never clobbered.

```jsonc
{
  "gateway": "payrexx",            // "payrexx" | "stripe"
  "gatewayRef": "12345",           // Payrexx tx id / Stripe payment ref
  "contact_id": "…",               // null when unassigned
  "assignment_status": "assigned", // "assigned" | "unassigned"
  "amount": 5000,                  // smallest currency unit (Rappen / Cent)
  "currency": "CHF",
  "email": "student@example.com",  // payer email, may be null
  "subscription_type_id": "…",     // may be null
  "membership_expiration": Timestamp, // may be null
  "comment": "Monthly membership", // "what was paid" — default suggestion, editable
  "raw_status": "confirmed",
  "processed_at": Timestamp,
  "assigned_by": "uid",            // set when a manager assigns
  "assigned_at": Timestamp
}
```

**Firestore rules:** managers and owners can read; no client writes (the
`updatePaymentRecord` callable writes via the Admin SDK).

The payment is **always recorded** (even when no contact matches) so nothing is
silently dropped. The contact record is updated only when uniquely **assigned**:
`membership_expiration` ← gateway date, `subscription_type_id` ← referenceId/metadata
or the gateway default, `last_payment_at` ← now.

## Payrexx

### Setup

1. **Settings → Payments → Add gateway → Payrexx.** Enter the instance name (your
   Payrexx subdomain) + currency.
2. In your Payrexx dashboard → **Settings → Webhooks → Add webhook**:

   | Field | Value |
   |-------|-------|
   | URL | `https://europe-west6-linyup-prod.cloudfunctions.net/handlePayrexxWebhook?teamId=YOUR_TEAM_ID` |
   | Events | `Transaction` |
   | Secret | A random string — paste it into Linyup's **Webhook signing secret** field |

   *(Staging: replace `linyup-prod` with `linyup-staging`. Local: see Testing below.)*
3. Optionally set a **Default subscription type** — applied when a payment link has no
   `referenceId`. Set `referenceId` to the subscription-type ID on each Payrexx link for
   per-plan control. Resolution order: `transaction.referenceId` → gateway default → none.

### Behaviour

- **Signature**: `HMAC-SHA256(rawBody, signingSecret)` compared to `X-Webhook-Signature`
  with a constant-time comparison. Blank secret → logs a warning and allows through
  (setup phase only; **not** for production).
- Only `status: confirmed` is processed; `mode: TEST` is ignored unless
  `ALLOW_TEST_PAYREXX=true`.
- **Membership expiration** comes from `transaction.subscription.valid_until` (parsed as
  end-of-day UTC). One-off payments have none.
- Idempotent on `payment_events/payrexx:{transactionId}` — duplicate deliveries are
  acknowledged with `200`.

## Stripe (BYO)

A studio charging on its **own** Stripe account. Handler:
`handleTeamStripeWebhook?teamId={teamId}`.

### Setup

1. **Settings → Payments → Add gateway → Stripe.** Enter the publishable key + currency.
   (Stored for reference; BYO makes no Stripe API calls.)
2. In the **Stripe dashboard → Developers → Webhooks**, add an endpoint:

   | Field | Value |
   |-------|-------|
   | URL | `https://europe-west6-linyup-prod.cloudfunctions.net/handleTeamStripeWebhook?teamId=YOUR_TEAM_ID` |
   | Events | `payment_intent.succeeded`, `charge.succeeded`, `checkout.session.completed` |

   ⚠ **Do NOT add `invoice.payment_succeeded`.** This table asked for it until
   2026-08-18, and that is the misconfiguration behind "A BYO studio can
   double-count its own recurring revenue" (`docs/open-defects.md`): Stripe no
   longer lets an invoice payload name its PaymentIntent, and this rail holds no
   credentials to bridge them, so an endpoint subscribed to both families records
   every recurring payment TWICE and nothing can merge the two rows.
   `payment_intent.succeeded` already covers subscription renewals;
   `charge.succeeded` is enrich-only (it never opens a row) and is what recovers
   the payer's email on an invoice-generated payment.

3. Copy the endpoint's **Signing secret** (`whsec_…`) into the Linyup gateway dialog's
   **Webhook signing secret** field. Without it, no payments are recorded.
4. Optionally set a **Default subscription type** — applied when a payment carries no
   `metadata.subscriptionTypeId`.

### Behaviour

- **Signature** is verified against the team's own signing secret
  (`stripe.webhooks.constructEventAsync`). No Stripe API key is needed.
- Keyed by the underlying **payment reference** (PaymentIntent / invoice / session id),
  so `checkout.session.completed` and the matching `payment_intent.succeeded` converge to
  **one** `payment_events` doc (write-once).
- **The endpoint is watched, not repaired.** A row records the event type that
  wrote it (`raw_status`), so Settings → Payments can say plainly when an endpoint
  has delivered both event families in the last 90 days — a reading of what
  arrived, never a guess at which two rows are the same money. Nothing merges or
  deletes a row; the studio fixes the endpoint in Stripe.
- Scope is **record + assign** only — no in-app checkout, no refunds (those happen in the
  studio's own Stripe dashboard, or use Connect).

## BYO — webhook behaviour (shared)

- **Always 200** after signature verification, so the gateway stops retrying for
  expected conditions (misconfigured team, no contact match, …). Only genuine server
  errors return 5xx.
- **Idempotency** via the `payment_events/{gateway}:{ref}` doc id (atomic create-or-skip).

## BYO — testing locally

### Payrexx — curl against the local emulator

```bash
BODY='{"transaction":{"id":99999,"status":"confirmed","mode":"LIVE","referenceId":"YOUR_SUB_TYPE_ID","contact":{"email":"student@example.com"},"subscription":{"valid_until":"2027-01-31"}}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "YOUR_SECRET" | awk '{print $2}')
curl -X POST \
  "http://localhost:5001/demo-linyup/europe-west6/handlePayrexxWebhook?teamId=YOUR_TEAM_ID" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIG" \
  -d "$BODY"
```

Expected: `{"ok":true,"contact_id":"…","assignment_status":"assigned"}` (or
`unassigned` when no single contact matches). Then check the Firestore emulator UI at
[localhost:4000](http://localhost:4000) for the `payment_events` doc + contact updates.

### Stripe (BYO) — Stripe CLI

```bash
stripe listen \
  --forward-to "http://localhost:5001/demo-linyup/europe-west6/handleTeamStripeWebhook?teamId=YOUR_TEAM_ID"
```

Paste the printed `whsec_…` into the team's gateway config, then `stripe trigger
checkout.session.completed` (or pay a test Checkout on the studio's own test account).

## BYO — troubleshooting

| Log message | Fix |
|-------------|-----|
| `No Payrexx integration for team=…` / `no_integration` | Gateway not configured, or wrong `teamId` in the webhook URL |
| `Missing X-Webhook-Signature` / `missing_signature` | The gateway isn't sending the header — check its webhook config |
| `Signature mismatch` / `invalid_signature` | The signing secret in Linyup doesn't match the gateway's. Re-copy it. |
| `… unassigned email=…` | No single active contact matched (none, or a shared family email) — recorded as **Unassigned**; assign it from the Payments page. |
| `skipped_status:…` (Payrexx) | Payment not confirmed yet — normal; the gateway sends events at each status change. |
| `test_mode` (Payrexx) | `mode: TEST` — set `ALLOW_TEST_PAYREXX=true` on staging, or use a live payment. |
| `already_processed` / `duplicate` | A retried/previously-processed event — safe to ignore. |

---

# Rail C — Manual (cash / bank transfer)

A studio that takes **cash** or a **bank transfer** — money that never touches any
gateway — records it by hand into the same unified ledger. It's a `payment_events` row
with `gateway: 'manual'`, so it appears on the Payments page and the contact Payments
tab, and reuses the assign/link/edit path like every other external payment.

- **Where:** the **Payments** page → *Record payment*, or a contact's **Payments** tab
  (contact prefilled). The page is a core manager surface — always available, even for a
  studio with **no** gateway configured at all.
- **What a manager enters:** amount, date, a **payment mode** (studio-configurable —
  Cash / Bank transfer / TWINT / …; see below), an optional contact, a structured
  **line-item** (subscription / course / product / drop-in), and an optional note.
- **Payment modes are configurable.** The owner manages the list in
  **Settings → Payments → Manual payment modes** (`teams/{teamId}.payment_modes`,
  owner-only). Until customized, a default set (Cash / Bank transfer / TWINT) is offered.
  The chosen mode is stored on the row as `payment_mode` and shown in the payments list —
  so a Swiss studio taking TWINT to a personal number just adds that mode once.
- **Callable:** `recordManualPayment` (manager-only, `packages/functions/src/payments/`)
  writes the row and — when a contact + line-item are given — runs `applyPaymentEffects`
  (see **Unified payments view**), so a cash course sale actually unlocks the course, a
  cash membership sets the subscription (+ credits), etc.
- **Idempotency:** the doc id is `manual:{id}`; pass an `idempotencyKey` to make a retry
  a no-op.
- **Not a gateway:** no webhook, no signing secret, no Stripe/Payrexx config. It is
  purely bookkeeping + entitlements. Refunds are out of scope (adjust in your own books) —
  what the app *does* offer is a **void**, which is a different thing entirely.

### Void — "this record is wrong", not "the money came back"

`voidManualPayment` (manager, `packages/functions/src/payments/voidManualPayment.ts`)
un-records a manual payment. It **moves no money**: a manager who typed CHF 1'800 for
CHF 180 has no money to give back, she has a wrong row. So the row survives, stamped
`voided_at` / `voided_by` / `void_reason`, struck through in the payments list, counted
in no total, and inert — `updatePaymentRecord` refuses to edit a voided row, because
re-assigning one would re-apply the effects the void just took back. **The redo is a
fresh `recordManualPayment`**, which mints its own row (the Record dialog sends no
idempotency key, so the corrected re-record is never mistaken for a duplicate).

- **Manual rows only, enforced server-side.** `payment_events` also holds `payrexx` and
  BYO-`stripe` rows; voiding one of those would make our books contradict a gateway we
  neither run nor can correct.
- **It reverses the effects**, through the same `reversePaymentEffects` the refund path
  uses, with the same ownership checks — so a membership a *later* payment set up is
  never stripped.
- **A used pack IS voidable**, and this is the one place the void and the refund
  deliberately differ on rules rather than money. A refund of a used pack is refused
  because refunding money for delivered classes is a policy question (see *"Refunds take
  back what the payment bought"*). A void asks no such question — no money is moving —
  so it proceeds and reduces `credits_total` to `credits_used`: **the classes she
  actually took stand; the remainder she never paid for is withdrawn.** Same principle
  as the refund path (*delivered value is owed*), opposite outcome, because the question
  is different.
- **The books:** the row's journal entry is set to `status: 'corrected'` — one field, no
  compensating `adjustment` row (a void has no "right amount" needing a home). The
  monthly report already drops corrected rows and the accounting trigger already posts
  the reversing double entry.
- **Order:** reverse first, stamp second. A failed reversal voids nothing and is safe to
  retry; the other order would show a voided row beside a member who still holds what it
  gave.

### Re-assigning a payment is a MOVE, not a copy

`updatePaymentRecord` reverses the effects off the **previous** contact before applying
them to the new one, and writes the contact field **last**, once the apply has succeeded
— so a mis-typed assignment can never leave two people holding one purchase, and a
failure leaves the row pointing at the previous holder rather than at someone who was
given nothing. Unassigning (`contactId: ''`) reverses too. A **partly consumed pack
cannot be moved** — the classes were taken by *that* person, so handing the remainder to
somebody else would rewrite who attended; the answer is a void plus a fresh record. A
comment-only edit neither applies nor reverses, and the promo stamp on the row survives
every one of these paths (a reversal never releases or decrements a redemption — see
`docs/promo-codes.md`).

> The credit-pack counterpart for cash sales, `grantCredits`
> (`packages/functions/src/contacts/`), still exists for granting lesson credits
> directly; a manual payment with a subscription line-item whose price carries credits
> grants them the same way.
