---
title: Open defects
status: living
area: product
order: 4
---
# Open defects

Confirmed bugs that are **not** fixed, each reproduced against real data rather
than inferred. This file exists because the in-app follow-up chips are
session-scoped — they do not survive an app restart, and the evidence behind them
is expensive to re-derive.

Every entry states what was **verified**, so whoever picks it up starts from
evidence rather than from a symptom. Delete an entry when it ships; do not let it
rot into a claim nobody has re-checked.

**Refer to an entry by its TITLE, never by its number.** The numbers renumber
every time something ships: on 2026-08-16 two entries shipped and were deleted
(below), so every number after them moved in a single day. The one code comment
that points at this file names its entry by title
(`apps/web/src/lib/publicQueryError.ts`); keep it that way.

The Stripe entries were found while migrating the Stripe reads on
**2026-08-16**; the appointment-picker one during manual testing of the local
stack on **2026-08-15**, against commit `129a8c9` (Wave 3 Phase 3). All were
**pre-existing**, and all survived a full static pass (typecheck, tests, lint,
adversarial review). They are integration-boundary defects: the code is correct
about itself and wrong about the outside world, which is the category automated
verification is structurally blind to.

The Space "My courses" 403 shipped on **2026-08-16** and was deleted from this
file per the rule above. The fix lives in the `{path=**}/purchases` block in
`firestore.rules` and is held in place by
`packages/functions/src/connect/coursePurchaseAccess.test.ts`.

"The appointment picker ignores the signed-in contact session" shipped on
**2026-08-16** and was deleted too. The picker now derives ONE `Caller`
(`sessionCaller ?? verified ?? GUEST` — the same precedence
`resolveAppointmentCaller` uses), and every screen, price and payload comes off
it; see `docs/appointments.md` → "Who the picker is booking for". Its three
severity questions were answered against the running emulator before the fix and
**none was a money bug**: the contact session is a Firebase custom-token sign-in,
so its ID token rides on every callable the page makes regardless of what the
component knows, and the server was already resolving the member. The pricing
divergence was DISPLAY only (the member saw the guest figure and was charged the
member one); the `new_contacts` promo was refused at Apply time by
`previewPromoCode` and again inside the reserve; the per-contact cap keys on the
session contact's own normalised email and never reset. What the investigation
DID turn up, and what made the fix worth its size, was not in the entry: a
**covered** member was routed into `createAppointmentCheckout`, refused
`{ reason: 'covered' }` by design, and told *"This slot is no longer available."*
— a hard stop for the studio's own subscribers — and a signed-in contact filling
the guest form for someone else had the appointment booked under themselves.
Held in place by `packages/functions/src/appointments/callerIdentity.test.ts` and
the surface census in
`packages/functions/src/auth/publicSurfaceIdentity.test.ts`.

**What that census turned up and did NOT fix**, recorded here rather than left
inside a deleted entry:

- **`/public/{slug}/contact-update` still runs its own OTP.** It proves the
  visitor with `sendContactVerificationCode` + `verifyContactCode` against the
  `?contactId=` in the mailed link, and does not accept a contact session — so a
  contact who is already signed in is made to fetch a code to correct their own
  phone number. Closing it is a change to `verifyContactCode`'s caller
  resolution, not to the surface, which is why it was left alone.
- **`trial-booking/TrialBookingForm.tsx` is reachable from no route.**
  `trial-booking/page.tsx` is a redirect shim to `/booking`, and nothing else
  imports the component — 336 lines of dead surface, including the failed-read
  defect recorded at the bottom of this file, which therefore cannot be reached
  by a visitor today. Deleting it would settle that entry; nobody has.

"Stripe Connect reads a pre-Basil object model" shipped on **2026-08-16** and was
likewise deleted. Every migrated field now reads through
`packages/functions/src/utils/stripe/objectShape.ts` — modern location first,
narrow legacy fallback, and a report of which one answered. That module also
carries the guard that replaced the rejected `apiVersion` pin: compile-time
assertions, checked against the SDK's own declarations, stating where each field
is and is not, plus one comparing the bundled wire version to the version the
readers were verified against. A `pnpm update stripe` that moves any of them
fails `turbo run typecheck` before it can reach production. The fixtures holding
the modern shape are real captured Dahlia payloads
(`packages/functions/src/utils/stripe/dahlia-payloads.json`, exercised by
`objectShape.test.ts`); the reasoning for leaving `apiVersion` unpinned is
recorded in the header of `packages/functions/src/utils/connect/client.ts`.

What that migration left behind is NOT fixed, and is recorded below as its own
entries rather than left inside a deleted one. The one worry in the shipped
entry's own "verified live" list — that a null membership expiry might be treated
as "never expires" for access gating — was checked and is NOT a risk:
`writeContactMembership` discards the expiry outright (`void
opts.membershipExpiration`), gating runs off `Contact.active_subscriptions`, and
the rollup keys on `status` + `pause_collection` only. That symptom was a
data-quality defect, not an entitlement leak.

---

## 1. A BYO studio can double-count its own recurring revenue

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

- **Guidance is the primary defence, and it was WRONG in one place.** The setup
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

"Nothing tells a BYO studio which webhook events to subscribe to" shipped on
**2026-08-18** (UX-60) and was deleted per the rule above. The event set that
lived only in the header of
`packages/functions/src/billing/handleTeamStripeWebhook.ts` is now stated on the
BYO integration dialog itself (`TeamSettings.paymentsWebhookEventsHelp`, Stripe
only — Payrexx has no equivalent hazard), naming the three to subscribe to and
naming `invoice.payment_succeeded` as the one to leave off, with the reason.

---

## 2. Stripe endpoint drift on staging (ops, not code)

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

---

## 3. The subscription lifecycle backfill has not been run anywhere

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

---

## Smaller, unfiled

- **`stripe:listen` is unusable in a worktree.** The npm script hardcodes
  `localhost:5001`; a worktree's functions emulator is on its own port (15001
  here, per `firebase.worktree.json`). Same class of gap as `apps/admin/.env.local`,
  which pointed at the default emulator ports until it was corrected on
  2026-08-15 — server *and* client halves, since the client reads
  `NEXT_PUBLIC_AUTH_EMULATOR_PORT`. The worktree port scheme was designed
  properly and adopted inconsistently; one source of truth would end it.
- **Three Wave 3 Phase 3 minors** from the close-out round: a narrow
  self-correcting race on the appointment rail when a promo retry's
  session-close event beats the retry's own hold write; the members-only door
  card dropping its struck-through price once a promo beats the member benefit
  (display only); one under-qualified `only` comment in `staffBooking.ts`.

---

### Trial booking hides a failed read as "no trial sessions" — CLOSED 2026-08-28

`apps/web/src/app/[locale]/(public)/public/[slug]/trial-booking/TrialBookingForm.tsx`
logs its failed session read (2026-08-16), but still renders the failure as an
empty list — a visitor who came to book a trial is told the studio offers none.

Left open deliberately: closing it means threading an error state through the
whole trial flow, which is more than the surrounding sweep was scoped for. It is
the one acknowledged exception to rule 1 in `apps/web/src/lib/publicQueryError.ts`,
and that header points here rather than quietly weakening the rule.

**Update, 2026-08-16 (from the public-surface identity census):** no visitor can
reach this component. `trial-booking/page.tsx` redirects to `/booking` with the
query intact, and nothing imports `TrialBookingForm`. So the exception above is
currently an exception to nothing — which makes deleting the file the cheapest
close, not threading the error state. Verify the redirect before acting on that.

**Closed 2026-08-28 by deleting the file.** The redirect was verified first: the
route is an unconditional `redirect()` to `publicPath(slug, 'booking')` carrying
the query, with no branch that renders anything. The only remaining references
were two comments — the rule in `lib/publicQueryError.ts` that carried this as
its one admitted exception (it now has none) and a descriptive note in the
kiosk's `WalkIn.tsx` — and both were rewritten rather than left pointing at a
deleted path.

### A priced appointment at a studio without Stripe Connect says the slot is gone — FIXED 2026-08-28

`AppointmentPicker.tsx` — a paying visitor at a studio whose Connect account is
not onboarded is told **"This slot is no longer available."** The slot is fine;
the studio simply cannot take money yet. Same false-sentence dead end that was
fixed for covered members in the same file (2026-08-16), one refusal reason over.

Pre-existing, and deliberately out of scope for that change: the honest fix needs
a decision about what a visitor should be offered when a studio cannot charge —
book anyway and settle at the door, or say plainly that online payment is not set
up. That is Franco's call, not a mechanical repair.

**Franco chose: book anyway, settle at the door** (2026-08-28).

So appointments become the one deliberate exception to UX-33's hiding.
`listAvailability` no longer drops priced durations a studio cannot charge for —
it returns `settleAtStudio`, and the picker books through the FREE door and says
"Pay at the studio when you arrive" beside the figure. Hiding the length cost the
studio a booking it could have taken in cash; the false sentence cost it the
visitor as well.

The booking lands as `payment_status: 'required'` + `amount_due` +
`settle_at_studio`, which is the state the staff 'link' rail already produces
while a payment is outstanding — so `markAppointmentPaid` closes it with no new
branch and no second ledger. This is the only place a public caller can create an
unpaid-but-confirmed appointment, and it is gated on a fact the caller cannot
influence: whether the studio finished onboarding.

The rest of UX-33 is untouched. The shop, the drop-in price and the priced trial
still fail closed, because each of those IS a purchase with nothing to hand over
at a door; an appointment is a time, and the time is real either way.

`paymentsAreChargeable` in `connect/access.ts` is now the ONE predicate both the
listing and the booking ask, pinned by a test — computing it twice is how a
visitor ends up shown a price nothing can take.

## Feature requests, queued (not defects)

Recorded here for the same reason as the defects above — the follow-up chips are
session-scoped and do not survive a restart.

### Link one document from another in the editor — SHIPPED 2026-08-17

Deleted per the rule at the top of this file. It shipped as
`feat(documents): link one document from another, latest by default`.

**The design recorded here was superseded before it was built.** This entry said
"pin the link to the target's version as of publish", to stop a live link
changing what a signed waiver meant. Franco cut that: *"at this stage we do not
care, studio own responsibility, and we did not even go live yet."* What shipped
is simpler — **latest by default, pinned only when the author says so** — with no
publish-time freezing and no publish-time validation. See
`packages/shared/src/utils/documentLink.ts` for the model and
`packages/functions/src/documents/documentLink.test.ts` for its fixtures.

## Newly recorded, 2026-08-17

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

### The pinned document-version read path is only half-verified — VERIFIED 2026-08-28

`getPublicDocumentVersion` is wired: the public document page reads `?v=`, calls
it with the right arguments, reports a failure rather than swallowing it, and
falls back to the latest text — all observed in a browser.

**What was NOT exercised is the callable itself.** The running functions emulator
predates the callable and discovers its trigger list at startup, so every call
returned a CORS/registration failure; registering it needs an emulator restart,
which would have wiped the seeded stack. So the *serving* half — that it returns
v1's frozen text, refuses a waiver, and applies the published+isPublic gate — has
only been read, not run.

Verify by restarting the emulator with a fresh functions build (export the data
first if you want to keep it) and following a pinned link to an older version.

**Done, and it passes.** A worktree emulator running a fresh functions build has
`getPublicDocumentVersion` initialized, which is the condition that was missing.
The seed contains no documents, so four fixtures were written through the
emulator's REST API (owner token — the REST path enforces rules) and removed
afterwards. All six checks pass:

1. a published, public, non-waiver document returns the **frozen v1 text**, and
   the live `bodyHtml` on the parent — deliberately seeded with different
   content — does **not** appear in the response
2. a `kind: 'waiver'` document is refused
3. an unpublished document is refused, and so is a published-but-not-`isPublic`
   one
4. a version number that has no document is refused
5. `version: 0` is rejected as invalid argument

Every refusal returns the same `not-found` / "Document not available", so the
answer carries no signal about which documents exist — which is what the
callable's own comment promises.

### Stripe webhook handler params are typed `any` — FIXED 2026-08-28

Carried over rather than newly found — recorded here because it is the root cause
of a class, not one bug. Three shipped defects came from Stripe moving fields
between API versions; each read returned `undefined` silently. The SDK ships full
declarations, so **typecheck would have caught all three**. `utils/stripe/objectShape.ts`
now contains the reads that are known to have moved, with compile-time assertions,
but the handler signatures themselves are still `any`, so the next moved field
fails the same silent way. Retyping them is the durable fix; the blast radius is
why it has not been done.

**Done 2026-08-28, and the blast radius was two errors.** Every handler in
`connect/webhook.ts` (fifteen parameters) and every subscription/invoice reader
in `utils/gateway/stripe.ts` now takes a derived SDK type. Both errors it
surfaced were real:

- `handleAppointmentCheckout` passed `paymentIntentId: piId` into
  `refundDirectCharge` where `piId` is `string | undefined` —
  `session.payment_intent` is null whenever Stripe created no PaymentIntent. The
  duplicate-charge branch could have called the refund with `undefined` and an
  idempotency key of `apt-dup:undefined`. It now skips, and LOGS, because a
  duplicate detected and not refunded must not pass in silence.
- `scripts/connect-test-account.ts`'s Stripe client type (see the `scripts/`
  entry above) — found in the same pass.

Two shapes had to be modelled properly to get there. `StripeWebhookPayload<T>` is
`Omit<T, 'lastResponse'>`: every alias is derived from a `retrieve()`, so each
carries the HTTP envelope the SDK staples onto an API response, and
`event.data.object` has none — typing a handler with the bare alias demands a
field that is never there. And the LIST responses are not `{ data: T[] }`; a
listed item has no `lastResponse` and the envelope has `has_more`, so those are
derived from `list()` rather than hand-written.

**One `any` is left, deliberately**: the `event` in the dispatch. `event.data.object`
is a union of eighty-odd resources that TS cannot narrow from `event.type`,
because the verifier returns the general `Event`; typing it buys eighty `as`
casts at the router and a cast is an assertion exactly like the `any`, only
louder. The value lives in the handler BODIES, which is where all three
motivating defects were. It carries an eslint-disable and that reasoning.

### A new owner cannot upload an activity cover image, and the activity is created anyway — MECHANISM FALSIFIED 2026-08-28

Found by manual exploration on **2026-08-17**, on a freshly created account.
Creating an activity **with a cover image** fails the Storage upload with
`FirebaseError: Firebase Storage: User does not have permission to access …`,
while the activity document **is created regardless**. The dialog then stays open
with the data still in it and reports nothing — so the obvious next move is to
press Save again, which creates a duplicate activity.

Two separate faults, and they need separate fixes:

**1. The Storage rule (this entry).** Activity images fall through to the broad
`match /teams/{teamId}/{allPaths=**}` block in `storage.rules`, whose
`isTeamMemberStorage(teamId)` does a `firestore.exists` on
`teams/{teamId}/team_members/{uid}`. On a brand-new account that document is
written by the client during signup self-provisioning (see CLAUDE.md, "Team member
self-provision"), so the upload is denied whenever it runs before that write has
landed or if the write did not happen at all. **Not yet reproduced against a
second account, and the exact ordering has not been traced** — do that before
changing a rule, because the wrong fix here loosens tenant isolation on the
broadest storage match in the file. Note that the narrower `products/` and
`documents/` blocks use the same helper, so if this is a provisioning race it is
not confined to activities.

**2. The silent partial failure** is a UX finding, not a rule bug — it is UX-24 in
`docs/archive/ux-review-2026-08.md`, and this reproduction is what upgraded it from
`traced` to `observed`. It is being fixed there, including the branch that
distinguishes "activity saved, image failed" from "nothing saved", so a retry
cannot mint a duplicate. Fixing the rule does **not** close UX-24: any other
upload failure (offline, size, content-type) reaches the same silent path.

---

**Re-read 2026-08-28: the stated mechanism no longer exists, and the rule must
not be touched on the strength of it.**

This entry rests on "that document is written by the client during signup
self-provisioning … so the upload is denied whenever it runs before that write
has landed". That was true when it was observed on 2026-08-17. It stopped being
true nine days later: the **#106 team-takeover fix moved provisioning
server-side**, and `firestore.rules` now says in as many words that there is
"deliberately NO client self-provision branch anymore". `createStudioTeam` writes
the team, the owner membership and the user profile in ONE atomic batch, and
`provisionTeam` awaits that callable before the browser goes anywhere — so by the
time an owner can open the activities dialog, `teams/{id}/team_members/{uid}`
exists.

There is therefore no known race left to fix, and the warning in part 1 stands
with more force than before: **do not loosen
`match /teams/{teamId}/{allPaths=**}`** to chase a mechanism that has already
been removed. If the denial recurs, it has a different cause and needs a fresh
reproduction naming it.

**Part 2 is closed.** UX-24's fix was rebuilt after exactly this reproduction —
the create path's `addDoc`-then-upload ordering means a denied upload leaves a
real imageless activity, so the branches are now distinct and a generic toast
can no longer send a manager into a duplicate-creating retry (the edit path
uploads first and was always all-or-nothing).

---

## Newly recorded, 2026-08-25 — events + ranking

Found while reading the events and ranking code end to end before building the
rank-progression engine. All were read in the source at `b559addc`; none is
inferred from a symptom. The ranking-system org-awareness bugs, the duplicate
`RankLevel.value` bug and the mobile scalar-rank bug found in the same pass are
**not** here — they shipped in PR#105.

### `attendees` is an RSVP list wearing the word "attendance" — LABELS FIXED 2026-08-28

`events/{id}/attendees/{contactId}` is written by `handleEventInvitationResponse`
on `action: 'attend'` and deleted on `'decline'`. Nothing ever reconciles it
against who turned up, so a contact who accepts and never appears stays an
"attendee" permanently, and `attendees_count` counts acceptances.

Actual presence is the separate top-level `checkins` collection, counted by
`participants_count` / `completed_checkins_count`.

The two vocabularies have crossed: **`trackEventAttendees` is a trigger on
`checkins`** that maintains those two counters and never touches
`attendees_count` at all. Its own header says "Ported from
hmd-lineup/functions/src/trackEventAttendees", so the name arrived with the code
and the meaning drifted underneath it.

Renaming the subcollection is a data migration, so the fix is the UI label.

**Resolved for the labels.** The event detail page named one thing two ways on a
single screen: the stat tile already read "RSVPs" while the tab beside it read
"Attendees" (Franco, 2026-08-28 — "I still see attendees instead of RSVPs"). The
tab, its empty state and the duplicate-event copy now say RSVPs in all four
locales, and the message keys were renamed with them (`detail_tabRsvps`,
`detail_rsvpsEmpty`) so the old word cannot come back by autocomplete.

The empty state says "No one has accepted yet" rather than "No RSVPs yet",
because a DECLINE deletes its row — the list is the yeses, not every reply.

`EventPeekSheet` carried a second crossing, found while fixing the first: it read
`attendees_count ?? participants_count` and labelled whichever it got with the
same word, so an event with no acceptances and twelve people through the door
reported twelve RSVPs. It reads the RSVP count alone now.

**The FUNCTION name deliberately stays.** `trackEventAttendees` is the deployed
Cloud Function name, so renaming the export deletes one Firestore trigger and
creates another — and in the window between them every check-in write goes
uncounted, drifting the counters on a live event with nothing to announce it.
Its header carries the correction instead. What remains here is the
subcollection itself, which is a data migration.

### A manager can send event invitations but cannot see who accepted — FIXED 2026-08-27 (#120)

`events/[id]/page.tsx` gates the Attendees tab on
`isOrgAdmin || can('reports.view')`, while the Invitations tab beside it is
ungated. So a team manager invites people and then cannot see the responses —
`reports.view` is an odd capability to govern "who is coming to my event".

### One plugin's check-in payload lives in core — FIXED 2026-08-28

`isCheckinCompleted` (`packages/shared/src/utils/checkins.ts`) is a switch on
event type with no plugin hook, and its `default` branch reads
`Array.isArray(checkinData.categories)` — the fighting-cup shape. Core therefore
knows one tenant-specific plugin's payload, and a second plugin needing custom
completion logic has nowhere to put it but that same branch.

**Fixed with a keyed registry**, `PLUGIN_CHECKIN_COMPLETION` in
`packages/shared/src/types/plugin-checkins.ts`. It sits in `shared` rather than
the plugin folder for the reason `PLUGIN_BUNDLES` and `PLUGIN_ADDONS` do: the
predicate runs on the client AND in `addEventCheckin`, and the plugin registry
lives in `apps/web`. A rule is a PURE predicate over the payload — it is asked
on every roster row, on both sides of the wire.

Two things worth knowing:

- **The semantics are byte-identical**, including the odd one. A cup check-in
  with NO `categories` key auto-confirms, and only an EMPTY array means "nobody
  assigned"; `checkinCompletion.test.ts` pins that with a comment saying it is
  there "so the exam fix cannot be read as licence to change it". The first
  version of this change did read it as licence and broke that test — the
  registry now reproduces the old expression exactly.
- **One deliberate narrowing.** The old branch applied the cup's rule to ANY
  event type carrying a `categories` array; keyed lookup reaches only the types
  that registered. Nothing outside the cup's own form writes that key, so it is
  unreachable in practice — pinned by a new case so it is a decision rather than
  something that quietly stopped happening. A second new test reads
  `checkins.ts` and fails if `categories` ever reappears in it.

### `EventTypeConfig.contact_requirements` is declared and read by nothing — DELETED 2026-08-27

`packages/shared/src/types/event.ts` documents it as "contact fields that must be
set" (e.g. `['weight','birthdate']`). Repo-wide there are no readers outside the
type declaration and its build output. Either wire it into the check-in flow as a
prompt, or delete it — a declared-but-unenforced gate reads as a guarantee.

**Resolved by deleting it.** Nothing read it, nothing wrote it, and no seeder or
migration ever created an `event_types` document carrying it. The concept
already has an owner — `resolveBookingContactFields` — and this was a strictly
weaker second spelling of it: a bare `string[]` cannot name a `custom:` field and
cannot express optional-vs-required. The one use case the comment named,
`weight`, was solved better in the same commit that introduced it: a weigh-in is
a fact about that competition, so it lives on `checkin_data`, not on the person.

If per-person prerequisites are ever wanted, the shape is
`EventTypeConfig.contactFields?: BookingContactField[]` resolved through the
existing booking-contact-fields resolver and surfaced as a non-blocking banner —
which will also need the full contact read that `CheckinPanel` does not do today
(it holds only `{id, firstname, lastname}`).

### A team's custom check-in fields are authored and never rendered — FIXED 2026-08-27 (#120)

`EventTypeConfig.checkin_fields` has a full field builder in
`settings/event-types`, which saves and counts them. But `resolveFormType` in
`CheckinPanel` never consults `EventTypeConfig` — it dispatches on built-in slug
or plugin manifest only. A studio can build a custom check-in form and never see
it at check-in.

### Level `value: 0` cannot complete an exam — FIXED 2026-08-27 (#120)

`isCheckinCompleted`'s exam branch is
`Object.values(disciplines).some((v) => (v ?? 0) > 0)`, and `ExamCheckinForm`
repeats the `> 0` guard and renders a stored 0 as "Not examined". Every preset's
FIRST level uses `value: 0` — BJJ White, Swiss "Krebs", HMD "No belt" — so
awarding the entry grade is unrecordable. The sentinel for "not examined" should
be absence of the key, not the value zero.

### Deleting a ranking level or system silently orphans every contact holding it — FIXED 2026-08-27 (#120)

Neither ranking editor queries, counts or warns. `handleDelete` is a plain
`filter` + `updateDoc`, and the confirm copy is a static string with no contact
count. After a delete, `getPrimaryRank`'s `levels.find(l => l.value === value)`
misses and falls back to a floor-match, so a contact silently displays a
*different* belt.

### `getPrimaryRank` compares rank numbers across different systems — FIXED 2026-08-27 (#120)

When no system is `is_primary`, it picks one with
`Object.entries(ranks).sort(([, a], [, b]) => b - a)[0]` — a raw numeric compare
between unrelated scales, so a Korean Dragon 7 outranks a Hwal Moo Do 3 and
decides which belt the contact appears to hold.

### The org-managed ranking banner links to a page with no ranking UI — FIXED 2026-08-27 (#120)

`settings/team/page.tsx` renders "Ranking systems are managed by your
organization — Edit in organization settings" linking to `/org/{orgId}/settings`.
The editor is at `/org/{orgId}/ranking`; the settings page contains no ranking
UI. The banner text and link label are also hardcoded English while the rest of
the tab is translated.

### `ExamCheckinForm` is untranslated and points org tenants at the wrong place — FIXED 2026-08-27 (#120)

Seven hardcoded English strings, and its empty state says "Add ranking systems in
Team Settings" — wrong for an org-managed tenant, whose systems live on the
organisation and whose team tab is locked.

### The rank filter cannot express "this belt and above" — FIXED 2026-08-27

`contactFilter.ts` matches ranks by exact set membership
(`levels.includes(rank)`) with no comparison operator. "Blue and above" — the
normal way a coach thinks about a roster — requires ticking every level
individually, and silently goes wrong the moment a level is inserted.

**Shipped as a SECOND KEY, not a richer value — and the reason is a deployment
fact, not a taste one.** The web app and the Cloud Functions roll out through
independent pipelines (functions via `firebase deploy`, the web app via App
Hosting's own GitHub integration), so neither order is guaranteed and a skew
window always exists.

The obvious design — turning each `RankFilter` entry into
`{ mode, levels, min, max }` — fails OPEN in that window, not closed. The
dimension guard is `Object.values(f.rankFilter).some((l) => l.length > 0)`, and
on an object `l.length` is `undefined`, so the guard is false and the entire
rank block *including its `if (!matched) return false`* is skipped. The rank
restriction does not fail; it VANISHES, and the filter matches everyone it
otherwise would. `matchesFilter` backs dynamic contact groups, which back the
automation engine, which sends mail.

So `RankFilter` keeps its shape and meaning exactly, and
`ContactFilter.rankRanges` rides alongside it. **The band is the truth; the
level list is its mirror** — the writer expands the band through
`expandRankRange` and stores the result in `rankFilter[systemId]`, so a resolver
that predates bands still filters correctly (correct-as-of-write, which is
exactly what a hand-ticked list would have given it anyway). An old resolver
ignores a key it has never heard of. Neither reader is ever wrong in a way that
WIDENS the audience, which is the only direction that matters here.

That also dissolved the problem this entry used to warn about — readers that
test `rankFilter[systemId].length` still work, because the value is still a map
of number arrays. The one place that genuinely had to change is the "is this
dimension on" question, which now has a single owner, `rankFilterIsActive`, that
the contacts page and `activeFilterKeys` both call. Asking it any other way is
how the two got a second opinion in the first place.

**Still open, deliberately: `includeUnranked`.** A contact with no rank in the
system cannot be represented in the mirror at all, so it would behave
differently for old and new readers — a real divergence rather than mere
staleness. "and below" is the case that wants it, and it needs its own decision.

### HMD migration: exam history arrives in a shape nothing reads — FIXED 2026-08-27 (#120)

`passes/08-events.ts` copies the source `checkins` verbatim, so a legacy exam
check-in keeps hmd-lineup's payload (`exams.hmd_rank`, `is_hmd_exam`,
`is_graded`). Linyup's shape is `checkin_data.disciplines: { [systemId]: level }`.
The history is therefore present on disk and invisible to every reader — and it
is exactly the input the rank-progression engine's backfill needs. A remap pass
is a prerequisite for the belt work, not a tidy-up.

### HMD migration: fighting-cup categories are dropped — FIXED 2026-08-27 (#120)

hmd-lineup kept categories in a **global** `categories` collection; Linyup keeps
them per-event at `events/{id}/categories`. No migration pass references the
source collection, so migrated cup check-ins carry `categories: [id]` arrays
pointing at ids that exist nowhere in the target. Historic cup line-ups are not
reconstructable without a new pass.

### HMD migration: rank values are carried over unvalidated — FIXED 2026-08-27 (#120)

`transforms/contacts.ts` writes `ranks[systemId] = Number(hmdRank)` with no check
that the number exists in `HMD_BELT_LEVELS`. A bad source value becomes a rank
that renders as a floor-matched neighbour (see `getPrimaryRank` above).

### Unverified in PR#105, by admission

Two things shipped typechecked but unseen: the **member app's** rank rendering
was never run on a device (it is the code that decides whether a migrated HMD
member sees their belt or "NO BELT"), and the `image` arm of `RankBadge` was
never exercised with a real upload. The other three arms — split, emoji, solid —
were checked in a browser against computed styles.

---

## Newly recorded, 2026-08-27 — left open by the org-scope build

### `useAffiliationTerm` resolves the wrong organisation in org scope — FIXED 2026-08-28

`hooks/useAffiliationTerm.ts` calls `useOrg()`, and the studio sidebar is a
SIBLING of the org route's children — so `OrgProvider` does not wrap it and the
call returns the module default (`org: null`). The hook then falls back to the
CURRENT TEAM's `org_id`. On an `/org/{X}` route where X is not the current
team's org, the sidebar's affiliation word is a different organisation's, with
no error. Pre-existing; the scope build did not introduce it but does make org
scope a place people spend time, so it is worth fixing.

The fix is not to widen `OrgProvider` — the scope is already resolved from the
URL in `ScopeContext`, so the hook should read the ROUTE's org id from there
rather than the team's.

**Fixed 2026-08-28, as described.** The hook now reads `orgIdFromPath(pathname)`
and falls back to the team's `org_id` only when the URL names no organisation at
all — the route is the more specific fact, and the team's org is a default for
pages that are not about an organisation. `useOrg()` still wins where it has an
org, because there it has already resolved and cached the document.

### The sidebar quick-search does not index org destinations — FIXED 2026-08-27

Named as a risk in `docs/org-navigation.md` before the build and still true
after it. The search catalogue is built from `NAV_SECTIONS` + the settings
items; the four org rows and seven rail items are in neither, so in org scope
the switcher is the only way in and Ctrl+K finds nothing. The catalogue builder
takes resolved entries, so this is a matter of feeding it the org items when the
scope is org — not a new mechanism.

---

## Newly recorded, 2026-08-27 — the public booking page

Reported by Franco from STAGING: the calendar would not advance a month, and
bookable hours never appeared even with the setting on.

### The month arrows did nothing once a date was selected — FIXED 2026-08-27

`components/booking/MiniCalendar.tsx` — shared by the class booking form AND the
appointment picker. The effect that follows the SELECTION into its month had
`currentMonth` in its own dependency array, so it also ran on the visitor's own
paging and undid it: page to September, the effect re-runs, sees the selected
August date is not in the displayed month, snaps back. It only bit once a date
had been selected, which is why it read as a glitch rather than a dead button.
Now depends on `selectedDate` alone, with a functional update so dropping
`currentMonth` from the deps costs no correctness.

### An appointment-only studio never reached the picker — FIXED 2026-08-27

The real cause of "bookable hours are not displayed". Not the toggle, not the
sync: `applyEntry` in the public `BookingForm` asks `activityType ===
'appointment'` in both deep-link branches and **in neither default**. So a studio
whose only activity is an appointment — a coach selling 1:1s, which is the whole
shape of the coach plan — was auto-selected into the CLASS session list. An
appointment has no pre-scheduled sessions (nothing exists until it is booked),
so that list is empty forever. The setting was fine; the visitor never reached
the surface that renders those hours.

Date-first had the same hole with a wider blast radius: it pins no activity and
goes straight to the day picker, so appointment cards are never rendered at all.

### Still open: a MIXED studio on the date-first flow

Fixed above only where *every* activity is an appointment. A studio with both
classes and appointments, on date-first, still has no route from `/booking` to
its appointments — the day picker only knows class sessions. Rendering the
appointment cards above the day picker is the likely answer, but it is a design
call about what that page is, not a patch.

### The appointments toggle is read by nothing on the public web — FIXED 2026-08-28

`bookingSettings.appointmentsEnabled` and `appointmentPickerLive` have exactly
one web reader, `usePublicSurfaces`, and that hook is imported only by `(auth)`
routes. So the toggle governs what the STUDIO is shown about its own surfaces,
not what a visitor can reach. Switching it off does not hide anything public.
Worth deciding deliberately: either the public routes should honour it, or it
should be described as what it is.

**Franco chose: honour it publicly** (2026-08-28).

Enforced in `listAvailability`, not on the page. That callable is the one door
every client goes through, so the web picker, the mobile app and anything added
later are covered by construction — where a page-level gate would leave the
callable answering a direct call anyway. Off ⇒ no coaches, and the picker's
existing empty state does the rest. Absent still means ON, matching
`appointmentPickerLive`.

`appointmentPickerLive` stays exactly as it was: it answers the STUDIO-facing
question ("should I tell them this surface is live"), which is a different
question from whether a visitor may reach it.

### The website + kiosk appointment probe had no index — FIXED 2026-08-27

Found after the rest had merged, and it is the better explanation for "bookable
hours are not displayed **on staging**" than anything in the booking flow —
because it only ever failed on a REAL project.

`components/site/sections.tsx` and `kiosk/useKioskAvailability.ts` run the
byte-identical probe before calling `listAvailability`:

    collectionGroup('public_profile')
      .where('teamId','==',…).where('type','==','activity')
      .where('activityType','==','appointment')

Three equalities on a COLLECTION GROUP. At collection scope Firestore merges its
automatic single-field indexes for a pure equality query; at collection-group
scope it does not — which is exactly why `public_profile` already carries
explicit COLLECTION_GROUP overrides for `slug`, `type` and `teamId`.
`activityType` had none. (The two `activityType` entries in the index file are
on `sessions`, at COLLECTION scope.)

So the probe threw `FAILED_PRECONDITION`, and BOTH call sites swallow it —
`reportPublicLoadFailure` only `console.error`s — then set an empty list.
Classes rendered; bookable hours silently did not. **The emulator does not
enforce indexes**, so it looked perfect locally and failed only where a customer
would see it.

Fixed by declaring the `teamId + type + activityType` COLLECTION_GROUP index,
with a note at both call sites saying so, since JSON cannot carry one.

**Deploy note: the index must exist before the code that queries it.** Both
surfaces already fail closed, so deploying in the wrong order restores the
previous silence rather than breaking anything new.

### Still open (unverified): activity mirrors written before `activityType` existed

The field was added to the activity mirror when coaching was folded into
appointments, the mirror is rewritten only on an activity write, and there is no
backfill — so an activity untouched since then may carry no `activityType`, and
every branch above treats it as a class. Not reproduced; recorded because it
would present exactly like the fixed defect and would survive it.

### Renamed: "Show appointment booking" → "Show bookable hours"

For consistency with the term the availability UI already uses everywhere
("Add bookable hours", "Bookable hours", "Delete these bookable hours?").
Display-only — the stored field stays `appointmentsEnabled`. The Public pages
"on but empty" notice was brought onto the same vocabulary, and that same signal
now also appears in Settings → Booking beside the toggle, which is where the
studio is standing when it flips the switch. Previously it existed only on the
Public pages screen.

---

## Newly recorded, 2026-08-27 — the check-in tenant boundary

### `addEventCheckin` let any signed-up outsider write into any tenant — FIXED 2026-08-27

Not the LOW "trusts a client `checkinTeamId`" that was filed here earlier. The
gate in front of it was self-service, which turns a trusted-input smell into a
cross-tenant write by a stranger:

1. Sign up. 2. Call `createOrganization` — its own comment says "any
authenticated user can create an org", and it writes the creator an `org_admin`
row. 3. Create an org-scoped event in it (the rules allow exactly this).
4. Call `addEventCheckin` with `checkinTeamId` set to ANY team id in the system.

The callable's only org-event check was "are you an org admin of this event's
org" — true, of the attacker's own org — and it then stamped the requested
teamId verbatim. `checkins.teamId` IS the tenant boundary (`tenantData.ts`
matches the collection by it; every rule arm dereferences it), so the row landed
in the victim's tenant carrying attacker-chosen contact names and an arbitrary
payload. `trackEventAttendees` then wrote an activity-log entry into the
victim's own subtree quoting that text.

Fixed by `events/checkinAuthorization.ts` — a pure decision, fixtures beside it,
the split this codebase already uses for `decideWaiverGate`. The target team must
be an ACTIVE `org_teams` member of the event's org; authority is checked against
the RESOLVED team; the contact must belong to it; an update may not move a row
between tenants; and a null or empty stamp is refused rather than written (an
org event stores `teamId: null`, so the old fallback produced rows no rule could
match and no teardown could reach).

The same change WIDENS who may check in: a member studio's owner or manager can
now do it at an org event, for their own team. That closes a contradiction — the
rules already let that person UPDATE and DELETE such a row, and the roster UI
does exactly that, so only CREATE was blocked.

### The client could rewrite a check-in's tenant stamp directly — FIXED 2026-08-27

The client-side twin, and the rule's own comment already claimed it was closed:
"the manual confirm/unconfirm toggle (`is_completed`) is the only direct client
write allowed". The rule authorised the caller and then constrained no fields at
all, so a manager could `updateDoc` their own row's `teamId` and move it into
another studio, or rewrite `event.id` and drift `completed_checkins_count` on
two events at once. Now allow-listed to what the toggle actually writes.

### Migrated HMD cups resolved to no plugin at all — FIXED 2026-08-27

hmd-lineup stores `type: 'fighting_cup'`; the Linyup plugin declares
`hmd_fighting_cup`; the migration passed the source value through verbatim.
Plugin resolution is an exact match, so every migrated cup lost its Categories
tab, its check-in form and its export — and #120's category reconstruction wrote
data into a tab that never rendered. It degraded silently because the generic
form still renders and the completion predicate sniffs for a `categories` key
regardless of type.

It would also have broken the belt work this branch exists for:
`EventParticipationSpec.eventTypes` matches participation on these ids, so a cup
stamped `fighting_cup` never counts toward HMD's one-camp-one-tournament-one-exam
requirement. Remapped in the migration (`SOURCE_EVENT_TYPE_MAP`), including the
denormalised copy on each check-in. `traditional_cup` is deliberately left
unmapped — Linyup has no equivalent and collapsing it into `competition` would
merge two things HMD tells apart.

### A migrated cup check-in opened empty — FIXED 2026-08-27

The same top-level → `checkin_data` drift the exam pass fixed, for
`categories` / `weight`. New pass `09-cup-checkins`, run before the category
reconstruction so the ids are in their final home first.

### `scripts/` is typechecked in exactly one place — FIXED 2026-08-28

`turbo run typecheck` does not see `scripts/`; only
`tsconfig.seedcheck.json` does, and only what its `include` names. Anything
added there and not listed is checked by nobody. `scripts/migrate-hmd.ts` — the
entry point registering every migration pass — was in that blind spot until
2026-08-27. Worth a lint rule or a glob rather than a list.

**Fixed with the glob.** The list named seven paths against a directory of
twenty-seven files, so twenty were unchecked — every backfill, `purge-team`,
`reset-sandbox-db`, `reset-staging-db`, `promote-team`, `stripe-sync`.

It found a live one immediately: `scripts/connect-test-account.ts` declared
`type StripeClient = InstanceType<typeof import('stripe').default>`, which this
tsconfig cannot resolve because `stripe` uses `export =` — while the same
`.default` on the VALUE side is synthesised by esModuleInterop and runs fine.
The type is now DERIVED from the loader expression the runtime evaluates, so the
two cannot disagree again.

---

## Found and fixed in one pass, 2026-08-27 (#120) — two rules holes

Recorded because **how** they were found generalises, and because neither was
ever in this list: they were invisible until somebody read the events area as a
**migrated HMD studio** rather than as a seeded one. The emulator seed contains
no org-scoped event, so nothing had ever exercised these paths.

Both presented as an **empty result rather than an error**, which is the reason
no test and no manual click caught them. A permission denial that renders as
"no categories configured" is indistinguishable from a correct empty state.

### An org event's subcollections were unreadable by the studios attending it

An org-scoped event carries `teamId: null` (`transforms/events.ts`), and
`belongsToUserTeam` opens with `teamId != null`. The parent event's read rule
already admitted `currentTeamInOrg`; its `categories` and `attendees` did not. A
studio could open a federation camp and read neither — the check-in screen
reported "no categories configured" and the roster reported that nobody had
responded. The migration passes shipped in the same PR write exactly that data.

Fixed by `currentTeamInOrgOfEvent(eventId)` in `firestore.rules`, granting
**read only**; authoring an org event's divisions stays with the org admin.

### The organisation root document was `isOrgMember` only

Every subcollection below it — `org_places`, `affiliation_types`,
`org_program_templates`, `installed_plugins` — already carried
`|| currentTeamInOrg(orgId)`. But the settings a studio most needs live on the
**root**: `ranking_systems`, `affiliation_term`, `lock_affiliation`.
`useRankingSystems` resolves an org-managed studio's belts from precisely that
document, so the read was denied and the studio fell back to its own empty list:
no belts on the contact page, none in the exam form, none in the filter. Every
migrated HMD studio would have been in that state.

Fixed by admitting `currentTeamInOrg(orgId)` on `read`; `update` stays
`org_admin`.

Both are pinned by assertions in `programRules.rules-test.ts` that were verified
to FAIL against the pre-fix rules — 2 failing / 51 passing on `HEAD`, 53 passing
with the fix.

---

## Queued, not a defect — the two website builders have diverged

**Requested 2026-08-25 (Franco): align the org website builder with the team
one, reusing components as far as possible.** Recorded here rather than started,
because it is its own workflow.

What is actually there today — two parallel implementations, near-identical in
size and drifting apart:

| | team (`plugins/website/`) | org (`org/[orgId]/website/`) |
|---|---|---|
| Section editor | `SectionEditor.tsx`, 556 lines | `OrgSectionEditor.tsx`, 569 lines |
| Defaults | `defaults.ts`, 84 | `defaults.ts`, 80 |
| Hooks | `hooks.ts`, 125 | `hooks.ts`, 99 |
| Menu tree | `MenuPanel.tsx` | **absent** |
| Embed widgets | `EmbedWidgets.tsx` | **absent** |
| Preview overlay | `PreviewOverlay.tsx` | **absent** |

The types are separate too: `WebsiteSection` / `WebsiteSectionType` in
`types/website.ts`, `OrgSiteSection` / `OrgSiteSectionType` in
`types/orgWebsite.ts`.

**The cost is not duplication, it is drift.** The header-menu tree shipped for
teams (`MenuTarget` — `kind: 'section' | 'surface' | 'url' | 'none'` — in
`types/website.ts`) has no counterpart in `orgWebsite.ts` at all, so an
organisation cannot arrange its header the way a studio can. Every future
website feature is now two builds, and whichever tier is not in front of the
author quietly falls behind.

Worth deciding at the start, because it shapes the whole job: whether the two
converge on ONE section model with a tenant discriminator (the promising
direction — it is how `RankLevelFields` fixed the same shape of divergence
between the two ranking editors), or stay separate models sharing only leaf
components. The first removes the drift; the second only slows it.

### Partly done, 2026-08-28 — the drift that had already caused damage

Three consequences of the divergence were fixed without taking the structural
decision above, because each was a live defect rather than a design question:

- **The org editor had NO i18n at all.** Not a missing key — no `next-intl`
  import: every label, placeholder, toast and explanatory note was a hardcoded
  English literal, so a German or French org admin authored their site in
  English. It now reads the SAME `Website` namespace keys the team editor uses
  for the four shared section types; only the three org-only sections
  (clubs/locations/coaches) needed new copy.
- **The image box was the shape the team's `BOX` constant replaced** — a fixed
  `h-28` letterbox when filled and `h-20` when empty, so uploading an image
  shifted every field below it down by 32px.
- **The contact section's "show social links" switch had nothing to show.**
  `ContactBlock` renders socials from `ctx.socialLinks` and `Organization`
  carried no such field, so nothing could ever set any. Removed at first, then
  put back the same day with the field, an editor in Organisation settings and
  the draft preview reading it — `publishOrgWebsite` turned out to have been
  reading `org.socialLinks` defensively all along, waiting for exactly that.

### The capability gaps closed, same day

The menu tree and the preview overlay are done, and they cost far less than the
table above implies because the pieces were already tenant-agnostic:

- **The header menu.** `menu?: SiteMenuItem[]` on `OrgSiteDraft` and
  `OrgPublishedSite`, carried by `saveOrgSiteDraft` and sanitised by the SAME
  `sanitizeMenu` the team publish uses (it only needed an `export` — its rules
  bound depth and breadth and validate a target's shape, none of which differs
  between tenants). `MenuPanel` took a widened `sections` type and nothing else;
  `utils/siteMenu.ts` needed no change at all. ADDITIVE: an absent menu still
  derives, so no published org site changed.
  `surfaces={[]}` because an organisation has no cross-surface links — Shop, My
  space and Documents are studio surfaces.
- **The preview overlay**, in place of the sticky 420px column — and that column
  is what the menu tree now occupies, which is exactly the trade
  `PreviewOverlay`'s own header proposed. It gained `orgId`/`orgTeams`: without
  them the clubs, locations and coaches blocks render empty, and a preview that
  silently drops three of seven section types is worse than none.
- **Both appearance panels are translated.** They were equally untranslated, so
  they were "aligned" — at English. Twelve shared keys, one placeholder each.
- `SurfaceLinksEditor.tsx` deleted (exported, imported by nothing).

**CONVERGED 2026-08-28** — Franco chose one model with a tenant discriminator,
the same shape that fixed the divergence between the two ranking editors.

`components/website/SiteSectionFields.tsx` now owns the four section types both
builders share (hero, content, gallery, contact) plus `Field` and `ImageField`.
`SiteEditorTenant` carries `kind` and `id` — and, crucially, the tenant's own
`uploadImage`, because WHERE AN IMAGE GOES is the only thing that actually
differed. Carrying the behaviour rather than switching on the enum also keeps a
shared component from importing out of an app route.

What stays per-tenant is what the tenants genuinely CAN do differently: the
studio keeps Activities/Pricing/Schedule/Places and a CTA that can point at its
booking page or signup form; the org keeps Clubs/Locations/Coaches and a
URL-only CTA, because it has neither of those surfaces. The hero's CTA is a
SLOT for exactly that reason.

Three pieces of drift died with the copy, none of which was visible until the
two files were read side by side:

- `Center`, `Left`, `Right`, `Overlay (40%)` and "Call-to-action button" were
  hardcoded English in the org editor — a file whose every other label went
  through `useTranslations`. Verified live: the German org editor now reads
  Ausrichtung / Zentriert / Abdunklung (40 %) / Call-to-Action-Button.
- Its image-size limit was a bare `const MAX_IMAGE_SIZE_MB = 5` where the team's
  goes through `getWebsiteLimits()`, the seam that exists so an operator can
  raise it. Same number, one of them unreachable.
- `ContactFields` was identical in behaviour and different only in whitespace —
  the state a copy reaches just before somebody edits one of them.

Two more untranslated strings in the org-only sections ("Show address on each
card", "Extra venues") were found in the same pass and translated.

Both editors were exercised in a browser afterwards, in German, including that
the team's richer CTA (action selector, "Buchung öffnen") still renders and the
org's does not offer it.

Embed widgets for orgs stay descoped.
(Embed widgets for orgs need a new public collection and an `/embed/org/...`
route, which is a feature rather than a convergence.)

---

## Queued, not a defect — org lists have no search, and the org event list has no filters — FIXED 2026-08-27 (#120)

**Requested 2026-08-25 (Franco).** Recorded with the org-navigation rework
(`docs/org-navigation.md`), because it is the same surface and should land with
it rather than as a separate pass over the same pages.

`CLAUDE.md` already states the rule under UI/UX porting principles: *"every list
page with >1 filter has a search field + collapsible filter panel."* The org area
does not follow it.

Verified across the org list pages — zero occurrences of "search" in
`teams`, `events`, `members` and `places`; **ten in `affiliations`**, which has a
working search. So this is not a technical gap in the org area, it is an
inconsistency: the pattern is already there once, applied to one page out of five.

**The org event list is the sharpest case, and the asymmetry is the argument.**
`useOrgEvents(orgId, upcoming)` offers exactly one control — an upcoming/past
toggle. No search, no type filter. Meanwhile the team-side schedule already has
both: its list applies type and coach filtering to sessions *and* events before
the activity sub-filter narrows sessions further (and correctly exempts events
from that sub-filter via `item.kind !== 'session'`). The org, whose list is the
longer of the two by construction — HMD is migrating roughly two decades of
events — has less.

The quick filter that matters is **event type** (camp / competition / exam /
seminar / the plugin's cup), because that is how anyone actually looks for an
event, and it is exactly the question the rank-progression work makes people ask
constantly: *which camps did this contact attend in 2024?* Type filtering should
read the same resolved list `useEventTypes` already builds, so a plugin-contributed
type appears in the filter without anyone touching the org page.

Worth doing at the same time, on the same pages: `teams` and `members` are short
today and will not stay that way for a federation, and `places` is a lookup list
whose whole use is finding one entry.
