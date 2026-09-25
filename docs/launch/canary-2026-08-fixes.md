---
title: Prod canary 2026-08
description: "Prod canary, 2026-08-23 — triage and fix plan"
status: record
area: ops
---
# Prod canary 2026-08

Franco ran a manual canary against **production** and came back with 24 findings.
This file is the triage: what each one actually is against the code, what groups
with what, and the order to do them in. It is a WORK LIST, not a status board —
delete an entry when it ships, and if a fix turns out to be wrong, correct the
entry rather than adding a second one beside it.

Every entry states what was **verified in the source** (file:line) versus what
still needs a reproduction. Two entries are unverified on purpose and say so.

## STATUS — all 24 shipped in one pass, 2026-08-23

Everything below is implemented. `pnpm build`, `pnpm typecheck`, `pnpm lint`
(0 errors) and `pnpm test` (1918 passing) are green, and `pnpm i18n:check`
reports four locales in parity.

The entries are KEPT rather than deleted, against this file's own rule, for one
reason: several of them record a decision that is now load-bearing in the code
and reversible by accident. "Blocks on an explicit `false`, never on absence"
(the mail gate), "the billing stops at REQUEST time, not at purge time", "the
key says which slot, the marker says whose attempt" — those are the kind of
thing a later reader undoes because it looks redundant. Where the reasoning is
short it also lives beside the code; this file is where it is stated once, whole.

**Not done, and deliberately:**

- **C7's actual repro.** The "INTERNAL" error was NOT reproduced, and the audit
  shows it cannot have come from the activity dialog. Everything that makes a
  repeat diagnosable shipped — the swallowed errors are logged, the unhandled
  throw in `generateRecurringSessions` is now an `HttpsError` — but the entry
  stays open until Franco says which screen raised it.
- **Refund-issued as an automation trigger.** The two billing triggers that
  shipped (`subscription_cancel_requested`, `subscription_payment_failed`) are
  contact-document deltas, so they cost no webhook edit and work on every write
  path. A refund has no contact-level fact to fire from and would have meant
  wiring the money handler; it is worth doing separately, on purpose, not as a
  rider on a UI fix.
- **Deploy.** Nothing here is deployed. `firestore.index.json` gained one index
  (`users`: `email_verified` + `created_at`) that the unverified-signup sweep
  needs — **rules and indexes deploy BEFORE functions**, per the standing order
  in the finance-plugin notes.

## The four decisions taken up front (Franco, 2026-08-23)

1. **Studio account deletion** — force-stop then a 30-day reversible window.
   Request → cancel every live member subscription and stop new charges → 30
   days → `purgeTeam`. Same shape as the contact self-deletion already in the
   tree.
2. **Subscription divergence** — do BOTH halves: the destructive path defaults
   to canceling Stripe billing, AND every disagreement is surfaced.
3. **Email verification** — soft gate (banner + outbound/public surfaces held)
   and a 7-day sweep that deletes the Auth user + team **only if the team is
   untouched** (no contacts, sessions or payments).
4. **Plan ↔ activity links** — the picker goes back INSIDE the subscription
   form, but reads and writes through the shared `activityPlanEdgeUpdate`
   writer. No second source of truth (that was UX-69).

Three more, taken the same day after the first triage round:

5. **Place is the primary field, Location is the quick alternative or the
   addition** — because Place is what gets tracked. See B1.
6. **The purpose callouts go entirely** — all four, not just the schedule one.
   See B4.
7. **A generating series shows a "filling in…" marker** rather than an empty
   calendar. See B3.

---

## Sequencing

The five workstreams are independent of each other and can run in parallel, but
**C before D** where they touch the same files, and **E last** — the form-style
sweep (E3) rewrites the same dialogs C and E2 edit, so doing it first means doing
it twice.

| # | Workstream | Items | Why it is one piece of work |
|---|---|---|---|
| A | Onboarding & account lifecycle | 1, 2, 8, 19 | All four are the same seam: what a studio is asked at signup, what it may do before it proves an email, and how it leaves. |
| B | Scheduling ergonomics | 3, 5, 6, 7 | One dialog (`SessionFormDialog`) plus one page (`/schedule`). Items 3 and 6 are literally the same defect twice. |
| C | Money / Stripe correctness | 4, 11, 13, 16, 18, 20, 21 | The heavy one. Shared blast radius: the Connect account, `member_subscriptions`, `member_payments` and the webhook. |
| D | Booking flow identity | 12 | One defect, already-solved shape — copy `resolveAppointmentCaller`'s precedence onto the class form. |
| E | Forms & IA polish | 9, 10, 14, 15, 17, 22, 23 | Small, visual, low-risk. Bundle into one PR; E3 (form style) is the only one with real size. |

---

## A — Onboarding & account lifecycle

### A1 · Signup asks for currency and preferred language *(item 1)* — M

**Verified.** `teamSchema` collects a name and an optional sport type only
(`apps/web/src/app/[locale]/signup/page.tsx`), and `provisionTeam` writes the
team doc with neither `default_currency` nor `language`
(`apps/web/src/lib/provisioning.ts`).

Worse than a missing signup field: **`Team.language` has no editor anywhere in
the app.** It is declared (`packages/shared/src/types/team.ts:556`) and read by
~15 call sites to pick the language of every member-facing email
(`booking/index.ts:137`, `appointments/booking.ts:177`, the waitlist claim, the
accounting seed …), but nothing in `apps/web` ever writes it. Every studio
created through signup therefore mails its members in English forever, with no
way to change it. Currency is better off — `BillingCurrencyCard` in Settings →
Team → Payments edits it — but it is never asked at signup, so the first prices
a studio types are entered under a currency it did not choose.

**Fix:** add both to the team step (currency defaulted from the locale, language
defaulted from the UI locale), write them in `provisionTeam`, AND add a language
control to Settings → Team beside the currency card. Note
`startConnectOnboarding` hard-codes `default_currency: 'chf'` on the
`connect_accounts` doc (`packages/functions/src/connect/index.ts`) — seed it
from the team instead.

### A2 · Email verification + 7-day sweep *(item 2)* — L

**Verified.** `signUp` is a bare `createUserWithEmailAndPassword`
(`apps/web/src/lib/auth.ts:21`); `sendEmailVerification` appears nowhere in the
repo, and nothing reads `emailVerified`.

**Fix, per the decision above:**
- Send the verification mail at signup and after a magic-link/social signup that
  yields an unverified address; a resend control on the banner.
- **Soft gate:** a persistent banner while unverified, and hold the surfaces
  that reach the outside world — outbound mail via `sendEmail`, and the public
  surfaces (`syncTeamPublicProfile` / booking). Enforce in the callables and
  rules, not only in the UI.
- **The sweep** is a new `dailyTasks` handler beside `purgeProvisionalContacts`
  and `anonymizeScheduledContacts`. It deletes the Auth user and its team after
  7 days **only when the team is untouched** — no contacts, no sessions, no
  payments. An unverified studio that has started working is kept and nagged.
  Reuse `purgeTeam` for the erase so the collection list stays driven by
  `TENANT_DATA_COLLECTIONS`.
- Social sign-ins arrive verified; do not mail them.

### A3 · "Finish set up" drops you into one step with no overview *(item 8)* — M · SHIPPED

**Verified.** `QueuePanel.tsx:171-178` built the setup task with
`href: openSetup[0].href` — the FIRST open step, so a studio with two steps left
landed on `/offer/plans?tab=subscriptions` with nothing on screen saying why it
was there or what else was outstanding. The first-run modal is long gone by then.

**The fix Franco asked for (2026-08-23), and it is bigger than the defect:** a
**Stripe-style persistent, minimizable setup overlay**.

> "I really like the Stripe approach, with the overlay with the steps that stays
> onscreen (minimizable). This would be quite useful to guide the studio along
> the initial steps as they span across different topics and they are all
> interconnected, and for a good experience it is important that the studio sets
> them correctly and as complete as possible."

That is the right read of why the original defect happened at all. The five
required steps live in five different areas, and **every one of them navigates
away from wherever the list is shown** — so a checklist that lives on a page can
only ever be read once. A pointer to a better page would have had the same
problem one hop later.

**Shipped as `components/onboarding/SetupGuide.tsx`**, mounted by the app shell
(`(auth)/layout.tsx`) in the FloatingDock's `shell` lane, so it declares a lane
rather than a corner and cannot collide with a page's FAB:

- **Three states.** EXPANDED (every step, ticked ones struck through, each with
  what it is for and a link), MINIMIZED (a pill carrying the progress), HIDDEN.
- **Minimize is per-BROWSER** (`localStorage`) because it means "not now";
  **dismiss is per-TEAM** (`teams/{id}.setup_dismissed`, the flag that already
  existed) because it is a decision about the studio. Two controls, because one
  that did both would make the reversible answer look final.
- **It defaults to minimized after a reload** — a panel that reopens itself on
  every navigation is what this pattern is usually criticized for — and the pill
  still carries the progress, so nothing is hidden, only folded.
- **It removes itself on the last tick.** No congratulation state to close.
- **One list, raised from three places.** The dashboard queue row and How-to's
  checklist card now dispatch `OPEN_SETUP_GUIDE_EVENT` instead of navigating or
  reproducing the steps (same mechanism as `START_TOUR_EVENT`). How-to remains
  the place a team-wide dismissal can be undone.

### A4 · No way for a studio to delete its account *(item 19)* — L

**Verified.** `purgeTeam` is the one implementation and is **deliberately a
script, not a callable** (`packages/functions/src/saas-billing/purgeTeam.ts`
header) — invoked by `scripts/purge-team.ts` and the ops demo reset only. Its
own header records the gap this item is about: it removes Firestore + Storage
only, and provider-side state flagged `externalTeardown` (the Connect account
and its member subscriptions) "must be cancelled/disconnected separately". The
contact-side equivalent already exists (`contacts/selfDeletion.ts`,
`deletion_requested_at` / `deletion_scheduled_for`, swept by
`anonymizeScheduledContacts`) — the studio side has nothing.

**Fix (force-stop + 30-day window):**
1. `requestTeamDeletion` callable, owner-only, typed confirmation. It cancels
   every live/paused member subscription on the connected account, stops new
   charges, and stamps `deletion_requested_at` / `deletion_scheduled_for` on the
   team.
2. A banner + a `cancelTeamDeletion` callable for the whole window.
3. A `purgeScheduledTeams` handler in `dailyTasks` that calls `purgeTeam` once
   the window passes, then disconnects the Connect account and deletes the
   owner's Auth user if it holds no other team.
4. Settings → Team → Danger zone, stating plainly what is erased, what is
   canceled immediately, and what is kept (Stripe's own records of past
   charges, which we cannot and must not delete).

Do this AFTER C1 (Connect disconnect) — the teardown reuses it.

---

## B — Scheduling ergonomics

### B1 · Place is hidden when empty, and is indistinguishable from Location *(item 3)* — M

**Verified, and it is two problems stacked.**

1. `SessionFormDialog.tsx:921` renders the Place row inside
   `{places.length > 0 && …}` — a team with no place sees no field at all, so
   the concept never introduces itself.
2. Directly beneath it sits a free-text **Location** field (`:977-981`) whose
   placeholder is *"Gym, dojo…"* (`messages/en.json:1017`) — which is a
   description of a **Place**. Two adjacent fields, near-synonymous labels
   ("Place" / "Location"), and nothing anywhere says which is which. A new
   studio therefore types "Gym" into the free-text box forever and never
   discovers the tracked venue it should have created.

**The rule to encode (Franco, 2026-08-23): PLACE IS THE PRIMARY FIELD — it is
the one that gets TRACKED (rooms, and everything downstream that groups by
venue). LOCATION is a quick alternative when no place exists yet, or an addition
on top of one.** Today the layout states the opposite: the tracked field is the
one that disappears.

**Fix — one "Where" block, in that order:**
- **Always render Place**, empty or not. With no places, show the dashed empty
  state (the shape the activity picker at `:816` already uses) whose button
  opens `PlacesSheet` **over** the form. That is free: the sheet already shares
  the `['places', teamId, orgId]` query key with this picker, so a place created
  in it appears in the open form with no wiring, no event and no reload.
- **Demote Location visually** under Place — subordinate, not a sibling — and
  make its copy carry the distinction rather than repeat it. Its placeholder
  must stop describing a venue ("Gym, dojo…" → a one-off address, or a detail
  like "back entrance"), and its label should read as an ADDITION when a place
  is picked and as a QUICK ALTERNATIVE when none is.
- One line of help on the block, stated once: a Place is a venue you keep and
  schedule into; a Location is free text for a one-off.

### B2 · New class/appointment should let you create the activity *(item 6)* — S

**Verified.** `SessionFormDialog.tsx:816-827` already shows a dashed empty state
— but it is a `<Link>` to `/offer/activities`, which navigates away and loses
everything typed into the session form. The comment there records the reasoning
("a class activity carries a name, a level and an access rule that nobody can
invent on the studio's behalf"), and the availability dialog next door does
create one inline.

**Fix:** an inline quick-create (name + type, everything else defaulted, editable
later on `/offer/activities`), consistent with the availability dialog. Same
component serves B1's sheet-over-form pattern.

### B3 · Session creation should run in the background *(item 5)* — M

**Verified, and the latency is explained.** The create path awaits
`generateRecurringSessions` behind a 30-second timeout
(`SessionFormDialog.tsx:577-579`), and the server does **one dedupe query per
occurrence, sequentially** (`packages/functions/src/sessions/series.ts:110-147`).
A 6-month weekly series is ~26 sequential round-trips; a daily one is ~180. The
timeout exists precisely because this is slow.

**Fix, two halves — do both:**
- **Make it not block.** The `session_series` doc is already written first, so
  the dialog can close on that write and let generation run behind it. Either
  trigger generation from an `onDocumentCreated` on `session_series` (no
  callable at all) or keep the callable and stop awaiting it.
- **Show a "filling in…" marker** (Franco, 2026-08-23) rather than an empty
  calendar: the first occurrence is drawn as soon as it exists, and the series
  carries a visible in-progress state until it settles. The series doc already
  holds what that needs — `totalOccurrences` and `lastGeneratedUntil` — so the
  marker is a read of existing state, not new bookkeeping. A toast when it
  finishes; a visible failed state if it does not, because a silent background
  job that dies leaves a series nobody knows is short.
- **Make it fast anyway.** Replace the per-occurrence dedupe with ONE query for
  the series' existing `instanceDate`s into a `Set`. Same idempotency, one
  round-trip. Keep the "a failing dedupe THROWS" rule.

### B4 · Delete the purpose callouts — all four *(item 7)* — S

**Decided (Franco, 2026-08-23): remove the whole pattern, not just the schedule
one.** "I thought they were helpful, but it is more visual noise." The
component's own header (`components/layout/PageHeader.tsx:83-98`) argues the four
phrases only work read together as a set — which is the argument against keeping
any of them: a line that needs three other pages to make sense is not doing work
on the page it is on.

**Verified scope — it is genuinely four call sites and one component.** The
`purpose` prop is used by `<PagePurpose purpose="schedule" />`
(`schedule/page.tsx:1198`) and through `PageHeader`'s own `purpose` pass-through
(`:72`), keyed by `PagePurposeKey = 'activities' | 'schedule' | 'subscriptions' |
'pricing'` (`:83`).

**Fix:** delete `PagePurpose`, `PagePurposeKey` and the `purpose` prop on
`PageHeader`, drop the four call sites, and remove the `PagePurpose` message
namespace from all four locale files (via a `_pending` fragment — never edit the
locale files directly in a parallel lane). `pnpm i18n:check` is the guard that
the removal is symmetric.

---

## C — Money / Stripe correctness

### C1 · No way to disconnect an initiated Stripe link *(item 11)* — M

**Verified.** `startConnectOnboarding` creates the account, stores
`payments.connectAccountId` on the team and reuses it forever — "Reuse an
existing connected account if one is already linked; the model is fixed at
creation" (`packages/functions/src/connect/index.ts`). There is no
disconnect/reset callable, and `ConnectPaymentsCard.tsx` offers no such control.
A studio that starts onboarding under the wrong Stripe login is stuck with it.

**Fix:** a `disconnectConnectAccount` callable, owner-only, that refuses while
the account has live member subscriptions or unsettled balance (name them in the
refusal), clears `payments.*` on the team, marks the `connect_accounts` doc
detached, and lets onboarding start clean. Note `connect_accounts/{acct}.teamId`
is the only account→team map the webhook has — detaching must keep the old doc
readable for historical payments, not delete it.

### C2 · Freeze exists, cancel does not; the two systems drift *(item 18)* — L

**The heaviest item on the list, and the one with real money consequences.**

**Verified.**
- `pauseMemberSubscription` / `resumeMemberSubscription` are wired to the contact
  Payments tab (`contacts/[id]/PaymentsTab.tsx:108,125`), but
  `cancelMemberSubscription` is reachable **only** from inside the "change
  subscription" dialog, behind a `stopCurrent` radio that defaults to KEEP
  (`contacts/[id]/page.tsx:2943,3132-3142`).
- `handleClear` (`contacts/[id]/page.tsx:3006`) — the "remove the subscription"
  path — writes null over the contact's subscription fields and **never touches
  Stripe**. That is exactly Franco's repro: plan removed, Stripe subscription
  still billing (or still frozen), no warning anywhere.
- `canFreeze` (`PaymentsTab.tsx:173`) excludes `paused`, so a frozen subscription
  offers only "resume" — which is why restarting billing looked like the only
  way back.

**Fix (both halves, per the decision):**
1. **Destructive path defaults to canceling.** `handleClear` and the reassign
   dialog both cancel live Stripe subscriptions by default; the radio flips to
   "cancel billing" checked, and clearing shows what will be canceled before it
   happens.
2. **A per-subscription "Cancel billing" action** on every row of
   `MemberSubscriptionsSection`, available in every state including `paused`,
   behind a confirm that names the member and the amount.
3. **Divergence is surfaced, not inferred.** A live/paused Stripe subscription
   whose contact holds no matching Linyup subscription (and the reverse) gets a
   warning on the contact page, a row in Payments → Subscriptions, and a task in
   "Waiting on you". This is a derived check over `member_subscriptions` +
   `Contact.subscription_type_id` — no new collection, no sync job.
4. Copy: "freeze" and "cancel" must never read as the same button.

### C3 · Payments → Subscriptions says nothing; and the tab labels lie *(item 13)* — M

**Verified, and the answer to Franco's question is: the label is wrong, not the
routing.** Subscription renewals DO write `member_payments` rows —
`connect/webhook.ts:1195` stamps `kind: 'subscription'` on the `invoice.paid`
path — and the tab those rows land in is labeled **"One-off payments"**
(`messages/en.json:3723`). The money is in the right ledger; the tab name claims
it is something it is not.

The Subscriptions tab itself is a stub: `payments/page.tsx:386-403` renders
`{t('membership')}` — the literal word "Subscription" — plus amount and status.
No contact, no plan name, no period, no actions.

**Fix:**
- Rename the payments tab to "All payments" (or "Payments") and add a kind
  filter so "one-off only" stays reachable as a FILTER rather than a false label.
- Rebuild the Subscriptions tab as a real memberships list: contact name (link),
  plan name, amount + interval, status, next renewal or cancellation date via
  `subscriptionEndsAt`, the freeze/cancel actions from C2, and the divergence
  warnings.

### C4 · Refund needs a manual page refresh *(item 16)* — S

**Verified, root-caused.** `refunds.ts` initiates the refund and returns; its own
comment says "The charge.refunded webhook reconciles amount_refunded / status /
refunds[]". `useRefundMemberPayment` (`hooks/useConnect.ts:174`) invalidates
`['member-payments', teamId]` immediately — which re-reads a document Stripe has
not updated yet. The refetch is correct and always too early.

**Fix:** write the expected `amount_refunded` / `status` optimistically in the
callable right after `refunds.create` succeeds. The webhook already writes
ABSOLUTE values, so it reconciles rather than double-counts. Keep the
invalidation. (Alternative — polling or an `onSnapshot` on the row — costs reads
on every payments page view for a rare event; not worth it.)

### C5 · Contact Space shows "failed" for a refunded payment *(item 20)* — XS

**Verified, one line.** `space/payments/PaymentsHome.tsx:111`:
`const failed = p.status !== 'succeeded'`. A refunded payment carries status
`refunded` / `partially_refunded`, so it takes the failed branch — struck
through, labeled failed — and the `refunded` branch two lines below is
unreachable for a full refund. The member is told a payment they were refunded
had failed.

**Fix:** test the status explicitly against the failure states, and let the
refunded branch own refunded rows.

### C6 · Stripe cancellation requests should raise an alert *(item 21)* — M

**Verified as a gap.** The cancellation RECORD is already stored properly —
`cancel_at`, `canceled_at`, `cancellation_details` with the load-bearing
`reason` (see CLAUDE.md → "A cancellation is a RECORD"). Nothing reads it to
raise anything: `QueuePanel` builds tasks from unassigned payments and setup
steps only, and `ContactAttentionReason`
(`packages/shared/src/utils/contactFilter.ts:525-548`) has no member for it.

**Fix:**
- Add a `cancelling` reason to `ContactAttentionReason` and place it in
  `ATTENTION_WEIGHT` (the union's comment requires this). It needs a
  contact-level fact to test: `Contact.active_subscriptions` mirrors only LIVE
  subscriptions and deliberately never carries the reason, so add a narrow
  denormalised stamp written by `onMemberSubscriptionWrite` — the same rollup
  writer, no new trigger.
- The reason then reaches "Waiting on you" and the contacts Needs-attention view
  for free, through the shared comparator.
- **Automation triggers:** extend `AutomationTriggerType`
  (`packages/functions/src/utils/automationEngine.ts:31`) with the Stripe-side
  events worth acting on — cancellation requested, payment failed
  (`invoice.payment_failed` is already handled), refund issued — fired from the
  Connect webhook. Each needs a label in the automations UI and an entry in the
  library.

### C7 · "INTERNAL" saving an activity with a drop-in price *(item 4)* — ? **not reproduced; the message did not come from where it looked like it did**

Franco reported the error text as *"INTERNAL"*, nothing more. That single word is
the most informative thing in this entry, because **uppercase `INTERNAL` is the
Firebase callable SDK's signature for an unhandled exception inside a Cloud
Function** — a gen2 function that throws something other than an `HttpsError`
returns `{"error":{"status":"INTERNAL","message":"INTERNAL"}}`, and the client
surfaces that verbatim. A Firestore rules refusal reads `permission-denied`; a
bad value reads `invalid-argument`.

**Audited, and the activity save cannot produce it:**
- There is **no callable anywhere under `apps/web/src/app/[locale]/(auth)/offer`**
  — verified by grep across the whole subtree. The activity write is a direct
  client `addDoc` / `updateDoc`.
- `firestore.rules:1309-1319` validates only the `activities.manage` capability;
  there is no shape validation of `dropIn` to fail.
- `syncActivityPublicProfile` is an onWrite trigger — it cannot reject the write,
  and its failure surfaces nowhere on the client. Its drop-in branches
  (`:58-59, :105-111`) are correctly guarded on
  `dropIn?.enabled && typeof priceAmount === 'number'`.
- The activity dialog's three catch blocks print a **translated generic**
  (`t('saveErrorToast')`, lines 621/647/662) — they are structurally incapable of
  printing the word "INTERNAL".

**So the toast came from somewhere that prints the raw message, and in this area
there is exactly one: the SESSION dialog** — `toast.error(t('saveError', {
message: errorMessage(err) }))` (`SessionFormDialog.tsx:585`). The only callable
in that path is `generateRecurringSessions`, and it has a genuine unhandled-throw
surface: `materializeOccurrences` deliberately re-throws a failing dedupe query
(`sessions/series.ts:127`) and nothing above it converts that into an
`HttpsError`, so any Firestore-side failure there reaches the client as exactly
`INTERNAL`. That also lines up with item 5 being on the same page of the canary.

**Next steps, in this order:**
1. **Stop discarding the error.** The activity dialog's three bare `catch {}`
   need a `console.error` — a two-line change, and no diagnosis of this class of
   report is possible without it. Do the same audit for every other bare catch on
   a write path.
2. **Wrap the throw.** `generateRecurringSessions` should convert an unexpected
   failure into an `HttpsError` with a code and a message that names the series,
   so a repeat is diagnosable from the toast alone. (This is worth doing whether
   or not it turns out to be the culprit.)
3. **Then re-run the repro** and confirm which dialog raised it. Ask Franco
   whether the error appeared while saving the ACTIVITY or while creating the
   CLASS/session that used it — the two are one screen apart in the flow.

**Independently wrong, found during the audit and worth fixing regardless:**
- `superRefine` (`offer/activities/page.tsx:239`) demands
  `Number(dropInPrice) >= 0.5`, and `Number('10,00')` is `NaN`. A comma decimal
  separator — the default on a Swiss/German/French keyboard — silently fails the
  check. Normalize the separator before parsing (`RefundPaymentDialog` already
  does exactly this: `Number(text.replace(',', '.'))`).
- The refusal it prints, *"Enter a drop-in price of at least 0.50"*, and
  *"Pick at least one session length"* (`:243`) are **hardcoded English string
  literals**, not message keys — so they render untranslated in de/fr/it. The
  two neighboring refusals in the same block correctly use `t(…)`.

**Also worth checking in the prod console while here** (unverified, prod-only by
nature — see the emulator/index gotcha): the dedupe query filters `seriesId ==`
AND `instanceDate ==` and there is no `(seriesId, instanceDate)` composite index
in `firestore.index.json`. Two equality filters should be served by the automatic
single-field indexes, so this is probably fine — but a missing-index failure is
invisible in the emulator and would surface in prod as precisely this `INTERNAL`.

---

## D — Booking flow identity

### D1 · A signed-in contact is asked to sign in again *(item 12)* — M

**Verified, and this is the class-side twin of a defect already fixed for
appointments** (see `docs/open-defects.md` — the appointment picker's
`resolveAppointmentCaller` precedence, shipped 2026-08-16).

`BookingForm.tsx:369` reads `usePublicContactAuth()`, and the contact IS used for
pricing (`:883-884`) and for the summary card (`:2604`). But the `who` step
(`:2156`) and the `returning` step (`:2257`) never test `isAuthenticated` — so a
signed-in member with a valid subscription is offered "Returning? sign in with a
code" and made to fetch an email code they do not need.

**Fix:** derive ONE caller with the same precedence the picker uses
(`sessionCaller ?? verified ?? GUEST`), skip `who`/`returning` entirely when a
contact session exists, and go straight to the confirm step with the member's
coverage already resolved. Pin it with a test in the surface census
(`packages/functions/src/auth/publicSurfaceIdentity.test.ts`).

**While here** (recorded in `docs/open-defects.md`, still open):
`/public/{slug}/contact-update` runs its own OTP and does not accept a contact
session either — same class of bug, one file over.

---

## E — Forms & IA polish

Bundle E1, E2, E4–E7 into one PR. E3 is its own.

### E1 · Subscription dialog has a horizontal scrollbar *(item 9)* — S · needs repro
`DialogBody` is `overflow-y-auto` (`components/ui/dialog.tsx:175`), and CSS
promotes `overflow-x` to `auto` alongside it — so ANY child wider than the body
produces the bar. Prime suspects in `SubscriptionTypesManager.tsx`: the limit row
(`SelectTrigger className="w-[150px]"` beside an input) and the price rows. Fix
the offending child (`min-w-0` / wrap), never by clipping the body.

### E2 · Subscription form: activities inline, one writer *(item 10)* — M
Replace the dashed "open the catalog" block
(`SubscriptionTypesManager.tsx:790-808`) with the picker itself, reading and
writing through `activityPlanEdgeUpdate` — the same writer the catalog uses, so
there is still exactly one author of that edge. While in the file: delete the
stale comment at `:388-391` that describes activity-linking code no longer there.

### E3 · One form style: stacked, not boxes *(item 17)* — L
The two idioms are both in the tree today. **The target is the session dialog's**
— `<section>` + `SectionLabel` + `border-t` rules, one vertical rhythm. The
subscription dialog stacks `rounded-lg border border-dashed p-3` boxes per
setting group (`:514, :648, :751, :794`), and the activity dialog mixes both.
Extract ONE `FormSection` primitive, convert the subscription and activity
dialogs, then sweep the rest. Do this AFTER C and E2 so the same dialogs are not
rewritten twice.

### E4 · "Subscriptions" → "Subscription plans" *(item 14)* — XS
The nav labels `/offer/plans` with the `subscriptions` key
(`(auth)/layout.tsx:264`), while `/subscriptions` — the roster of what contacts
actually hold — is in NO nav at all, reachable only from a dashboard figure.
Rename the plans entry to "Subscription plans", and give the roster a home
(under Contacts, or as a second tab) rather than leaving it orphaned.

### E5 · A visible shortcut beside the revenue figure *(item 15)* — XS
The whole revenue cell IS a link to `/payments`
(`dashboard-preview/FiguresBlock.tsx:182`) — it just does not look like one; the
only affordance is a hover color change. Add a persistent arrow next to the
caption (all figures, for consistency).

### E6 · Dividers between automation conditions *(item 22)* — XS
`automations/page.tsx:787` — the condition list is `space-y-2` with no
separation. Add a hairline between rows.

### E7 · Move "⋯" up beside the QR so search takes the row *(item 23)* — XS
`(auth)/layout.tsx:2520` puts `<TeamQrButton />` on the studio-name row and
`:2562` puts `<UtilityFlyout>` beside the search input. Expanded, move the
flyout up to the studio row and let search span the full width; collapsed, leave
it exactly as it is (there is no studio row at `w-14`, which is why
`includeQr={collapsed}` exists).

---

## Still open — need Franco

Four questions were asked on 2026-08-23 and answered; the answers are folded into
B1, B3, B4 and C7 above. One thing remains outstanding:

1. **Item 4** — was the "INTERNAL" toast raised while saving the ACTIVITY, or
   while creating the CLASS/session that used it? The audit in C7 shows the
   activity dialog cannot print that word, so the answer picks between two
   different fixes. If the repro is gone by the time this is picked up, do C7
   steps 1 and 2 anyway — they are the reason a repeat will be diagnosable.
