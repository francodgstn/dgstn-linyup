---
title: Open defects
status: living
area: product
order: 4
---
# Open defects

Confirmed bugs that are **not** fixed, each reproduced against real data rather
than inferred, plus ops steps that are owed but cannot be confirmed from the
repo. This file exists because the in-app follow-up chips are session-scoped —
they do not survive an app restart, and the evidence behind them is expensive to
re-derive.

Every entry states what was **verified**, so whoever picks it up starts from
evidence rather than from a symptom. **Delete an entry when it ships** — git
history keeps the record; do not let it rot into a claim nobody has re-checked.
Every entry was last re-checked against the code on **2026-09-26**, when the
shipped ones were deleted.

**Refer to an entry by its TITLE, never by a number.** Code comments that point
here name their entry by title; keep it that way.

---

## A BYO studio can double-count its own recurring revenue

**Severity: medium.** Structural, and only partly ours to fix.

`handleTeamStripeWebhook` keys every payment row on the underlying PaymentIntent
so that all events about one payment converge on one `payment_events` doc. Under
the current Stripe API version an `invoice.*` payload can no longer name its
PaymentIntent (`invoice.payment_intent` was removed; the replacement `payments`
list is **expand-only** and confirmed absent from the delivered payload), and a
`payment_intent.*` / `charge.*` payload can no longer name its invoice
(`payment_intent.invoice` was removed in the same change). The BYO rail holds NO
Stripe credentials by design, so it cannot expand or retrieve to bridge them.

Consequence: a studio subscribed to BOTH `invoice.payment_succeeded` and
`payment_intent.succeeded` gets two rows — and two finance-journal rows — for one
recurring payment.

**What shipped instead of a fix:** the divergence is now visible rather than
silent. A row keyed on anything other than the payment carries
`gateway_ref_kind: 'fallback'`, and the reader logs `[stripe-shape] MISSING …`.
The module header states which events a studio should subscribe to.

**Update 2026-08-18 (UX-60).** The marker was previously read by no screen, so a
doubled row was indistinguishable from a real one to the only person who could
act on it. `byoToUnified` now carries it as `UnifiedPaymentRow.refKindFallback`
and `PaymentsTable` renders a "may be a duplicate" chip with the reason on hover.
ABSENT still means `'payment'` — only an explicit `'fallback'` warns, so rows
written before the field existed are not accused of a duplication they are not
exposed to. **This is still not a fix**: the two rows remain, and everything under
"What would actually close it" is unchanged.

**Update 2026-08-18 (decision 18, Franco).** The close is **guidance + detection,
and the structural fix is deliberately NOT being built.** Both alternatives were
rejected by name: dedupe-by-heuristic, because a wrong match silently deletes a
real second payment; and giving the rail credentials, because avoiding them is
what BYO is FOR. So the rail now does two things and neither of them touches a
row:

- **Guidance is the primary defense, and it was WRONG in one place.** The setup
  table in `docs/payment-contact-studio.md` told studios to subscribe to
  `invoice.payment_succeeded` — i.e. the documented setup produced the defect.
  Corrected, with the reason. The dialog note (UX-17) is accurate and is now a
  callout rather than an 11px footnote.
- **Detection turned out to be exact, not heuristic.** A recorded row stores
  `raw_status` = the literal Stripe event type that wrote it, so "this endpoint
  delivered both families" is a STORED FACT about deliveries, not an inference
  from amounts or timing. `detectByoStripeDoubleRecording`
  (`packages/shared/src/utils/byoStripeEvents.ts`, pure + unit-tested in
  `packages/functions/src/billing/byoDoubleRecording.test.ts`) counts families
  over a 90-day window and Settings → Payments renders a warning naming the fix.
  It is bounded so it SELF-CLEARS once the endpoint is corrected, and it
  deliberately never pairs two rows — the one thing it cannot say without
  guessing is *which* two rows are the same money, which is exactly what the
  "may be a duplicate" chip leaves to the studio's own eyes.

The entry stays open because the duplication itself is unchanged.

**What would actually close it** (each has a real cost — pick deliberately):
subscribe BYO studios to `invoice_payment.paid` instead of
`invoice.payment_succeeded` (it carries both ids, so it converges — but adding it
*alongside* the invoice event makes the double-count worse, so it is a swap, not
an addition); or give the rail read-only credentials, which contradicts its
stated design; or dedupe across keys, which needs a second doc per payment.

---

## A MIXED studio on the date-first flow cannot reach its appointments

Fixed only where *every* activity is an appointment (those studios land on the
offer cards). A studio with both classes and appointments, on date-first, lands
on the class day picker (`ClassWhen`), which knows class sessions only; the
`activities` step is left out of date-first entirely, so there is no route from
`/booking` to its appointments. Rendering the appointment cards above the day
picker is the likely answer, but it is a design call about what that page is,
not a patch. Re-checked 2026-09-26 in `BookingForm.tsx` (`visibleSteps` and the
default-step branch).

## `/public/{slug}/contact-update` asks a signed-in contact for a code

It proves the visitor with `sendContactVerificationCode` + `verifyContactCode`
against the `?contactId=` in the mailed link and never looks for a contact
session, so a contact who is already signed in is made to fetch a code to
correct their own phone number. The server side is no longer the obstacle:
`completeSignup` already accepts a signed-in contact session in place of a code.
What is left is the surface (`ContactUpdateForm.tsx`).

## Smaller, unfiled

- **`stripe:listen` is unusable in a worktree.** The npm script hardcodes
  `localhost:5001`; a worktree's functions emulator is on its own port (per
  `.claude/skills/local-env/SKILL.md`). The worktree port scheme was designed
  properly and adopted inconsistently; one source of truth would end it.
- **Three Wave 3 Phase 3 minors** from the close-out round: a narrow
  self-correcting race on the appointment rail when a promo retry's
  session-close event beats the retry's own hold write; the members-only door
  card dropping its struck-through price once a promo beats the member benefit
  (display only — `dropInMemberPrice` in `BookingForm.tsx` still returns null
  then); one under-qualified `only` comment in `staffBooking.ts`.
- **The rank filter has no `includeUnranked`.** A contact with no rank in the
  system cannot be represented in the mirror at all, so it would behave
  differently for old and new readers — a real divergence rather than mere
  staleness. "and below" is the case that wants it, and it needs its own
  decision (`packages/shared/src/utils/contactFilter.ts`).
- **Unverified since PR#105:** the member app's rank rendering was never run on
  a device (it decides whether a migrated HMD member sees their belt or
  "NO BELT"), and the `image` arm of `RankBadge` was never exercised with a real
  upload.

---

## Owed ops steps (cannot be confirmed from the repo)

None of these shows in the Backfill workflow's run history as of 2026-09-26; a
run from a laptop leaves no trace, so each stays here until someone who ran it
deletes it.

### Stripe endpoint drift on staging

Found while auditing the delivery side on 2026-08-16, against live Stripe:

- `linyup-staging/handleConnectWebhook` is **missing `payment_intent.succeeded`,
  `payment_intent.payment_failed` and `payout.paid`**, and carries an extra
  `payout.created`. On staging, **no member payment is recorded at all.**
- The three registered endpoints disagreed on `api_version`: staging's Connect
  endpoint pinned to `2026-04-22.dahlia`, the other two following the account
  default.

`pnpm stripe:sync --project <p>` now reports both (it pins `api_version` at
creation from the installed SDK, and reports drift on existing endpoints —
Stripe does not allow the version to be changed after creation, so a wrong one
must be recreated). Running it, and recreating the staging Connect endpoint, is
ops work that has not been done.

### The subscription lifecycle backfill has not been run anywhere

Ops, not code — the companion to "Stripe endpoint drift on staging", and the same
shape: the tool exists and nobody has run it.

Every `member_subscriptions` and `saas_subscriptions` doc written before the
Dahlia readers shipped carries `current_period_end: null`, and none carries
`cancel_at` / `canceled_at` / `cancellation_details` at all — those fields were
not being read. `cancel_at_period_end` is the one that is only half wrong: the
old code read Stripe's boolean directly, so an API-initiated cancellation stored
`true`, while a BILLING-PORTAL one (which leaves that boolean false and states a
`cancel_at` instead) stored `false` and nothing else. **The webhook self-heals**
— on both rails the `created`/`updated` branches rewrite every lifecycle field
unconditionally, nulls included (the `cancelled` branches deliberately do not;
see CLAUDE.md, "A cancellation is a RECORD, not a boolean") — but the timing is
the problem, and it differs per symptom:

- a null period end heals at the next RENEWAL: up to a month, or a YEAR on an
  annual plan;
- a portal cancellation does **not** heal in any useful window. The `updated`
  event carrying `cancel_at` was already delivered, answered 200 and recorded in
  `last_event_id`; Stripe will not redeliver. The next event is the `deleted`
  one, which fires when the member is already gone — so the entire period a
  studio needs the warning for is the period nothing gives it.

The two interact: a STORED doc from that window that carries the boolean and no
`cancel_at` (nothing was reading one) leaves `subscriptionEndsAt()` falling back
to `current_period_end` for the date — which is null on the same doc. So its
third state stays dateless even after the code fix, until this runs.

`pnpm backfill:subscription-lifecycle --project <p>` re-fetches each subscription
from Stripe and repairs it through the same readers the webhook uses (dry-run by
default, `--apply` to write, re-runnable, exits non-zero on anything it cannot
repair). It was exercised end-to-end against live Stripe test data on 2026-08-16
— but its `payload()` has since been made PER-RAIL (it was writing a
`current_period_start` the Connect rail does not have, and a billing period on
the SaaS ended path that the `subscription.cancelled` branch never writes), and
that change has NOT been re-exercised end-to-end. What holds it today is
`connect/dahliaReads.test.ts`, which pins each branch against the handler it
mirrors. Re-run the dry run before trusting an `--apply`. **Not yet run against
sandbox, staging or production.**

### `pnpm backfill:gateway-data` has not been run anywhere

Ops, not code — the same shape as "The subscription lifecycle backfill has not
been run anywhere", and it needs the same treatment.

`saas_subscriptions` docs written before the dotted-key fix keep `subscription_id`,
`customer_id`, `last_event_id` and friends as **literal top-level fields named**
`"gateway_data.subscription_id"`, because `set()` takes a dotted key literally
where `update()` reads it as a path. Every reader now goes through
`readGatewayData`, which understands both shapes, so **nothing is broken while
this is outstanding** — this is cleanup, not a live defect. The webhook also
heals a doc on its next event.

The gap is the same as the lifecycle backfill's: a `cancelled` or `past_due`
subscription may never receive another event, so those docs stay in the old
shape indefinitely.

Run: `pnpm backfill:gateway-data --project <id>` (dry-run), then `--apply`.
Verified end-to-end against the emulator; never run against staging or prod.

### `pnpm backfill:activity-type-mirrors` has not been run anywhere

The field was added to the activity mirror when coaching was folded into
appointments, and the mirror is rewritten only on an activity write — so an
activity untouched since then may carry no `activityType`, and every public
booking branch treats it as a class. Not reproduced; recorded because it would
present exactly like a fixed defect ("an appointment-only studio never reached
the picker") and would survive it. `scripts/backfill-activity-type-mirrors.ts`
is how you look, and `--apply` is how you fix it.
