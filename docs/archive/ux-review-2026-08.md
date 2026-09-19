---
title: UX review 2026-08
description: "UX review, August 2026"
status: closed
area: product
---
> ## CLOSED — archived 2026-08-24
>
> A point-in-time review of `apps/web` run against commit `8b1dea3` on 2026-08-17.
> Much of what it found has since shipped — including via the 24-item prod canary
> pass of 2026-08-23 (`docs/launch/canary-2026-08-fixes.md`).
>
> **Findings here are NOT a work list.** Verify any individual finding against the
> code before acting on it; several are already fixed. Decisions that came out of
> the review live in `docs/ux-review-open-decisions.md`, and reproduced defects
> that are genuinely still open live in `docs/open-defects.md`.

# UX review — Linyup web app — 2026-08

The first full UI/UX review of `apps/web`, run against `8b1dea3` on 2026-08-17: one
cross-app consistency sweep plus fifteen area reviews (M1–M11, C1–C4), for the
**studio-manager** and **contact** personas, backed by one runtime persona test against
the live local stack. `apps/mobile` (area C5) was out of scope by request. The org tier
(M10) was reviewed under the standing caveat that it is unfinished, so "incomplete" was
never counted as a finding there.

**Headline: the product's individual surfaces are good, and several are excellent — the
pricing resolver, the waiver step, the booking flows' URL state, the Space error states
are all better than most shipping SaaS. What is failing is the seams between them.** Of
the twelve worst findings, nine are one surface confidently asserting something a second
surface contradicts: a checklist that reports a bookable class that nobody can book, a
consent setting that gates a flow the manager never uses, a cutoff written to a store the
server does not read, a refund that returns money and leaves the goods, a portal that
reports no bookings while holding a paid one. None is a hard crash and none would fail a
test, which is why they are still here.

**The single most urgent item is UX-1.** A studio that has done its compliance homework —
authored house rules, published them, ticked them as required — is told nothing, anywhere,
that its newcomers are still training having accepted nothing. That is the one place in
the product where the default outcome is worse than not shipping the feature, because the
feature *appears* configured.

Severity: **blocks** > **costs-money** > **slows** > **confuses** (aligned with
`persona-ux-test`). Frequency: `every-session` / `weekly` / `at-setup` / `once`.
Rank is cost to the user = frequency × severity. **Ease of fix never affects rank.**

---

## Method and evidence — read this before trusting a row

| Input | Available | Effect on this report |
|---|---|---|
| Prior `docs/ux-review-*.md` | **No** — this is the first | Every finding is marked `new`; nothing is a repeat or a regression |
| `docs/ux-principles.md` | **No** | Nothing outranked reviewer judgement; no `charter` findings |
| `/persona-ux-test` runtime run | **Yes** — 2026-08-17, one run | The only `observed` evidence. 17 friction items, 2 of 5 goals blocked |
| In-app feedback submissions | **No** | `docs/in-app-feedback.md` is the system doc, not submissions; the reviewer cannot read Firestore |
| `docs/open-defects.md` | Yes | Two UX-shaped entries were cited, not re-filed |

**Three honest caveats.**

1. **One persona run, one persona.** "Dana", a new fitness-studio owner, on desktop at
   1280×860. Nothing in this review observed a *contact* using the product, so every C1–C4
   finding is `traced` from source, not watched. A contact-persona runtime run is the
   highest-value next input.
2. **The persona's automation could not open base-ui dropdown menus**, and screenshots were
   unavailable, so it worked from the accessibility tree alone. That is what actually
   blocked its goals 1–3 — not the product. Where a friction item depended on it, the area
   reviewer re-derived the claim from source and said so.
3. **One reported `blocks` was adjudicated away.** The persona reported that create dialogs
   stayed open after a successful save with Escape and X dead (F2). M5 traced both dialogs
   she hit and found they close correctly (`offer/activities/page.tsx:532-563`,
   `offer/promo-codes/page.tsx:347-354`); M3 traced the session dialog and found the same.
   **F2 is an automation artifact and is not filed.** What *is* filed is the real gap it
   resembles: the activities dialog has no `try`/`catch` and no success toast, so a genuine
   write failure produces exactly that appearance (UX-24).

Coverage caps: each area run was capped at 8 findings and returned `--brief`, so the tail
below is deliberately compressed rather than complete. Accessibility (contrast, screen
readers, `aria` state) was **out of scope throughout** and is deferred to
`design:accessibility-review`; four findings flag "needs an a11y pass" where they touched it.

**Pre-launch — ignore every migration caveat in this report.** The product has no real
customer data; every tenant is seed data. So wherever a finding says a fix "needs a migration",
"a one-off backfill", or "repairing existing docs" — UX-M7-3's ranks plugin, UX-M4-4's saved
filters, UX-69's stray access rules, and others — **that half is moot. Reseed instead.** Take
the clean shape now and skip the compatibility layer; it is the cheapest this work will ever
be, and every one of those caveats becomes real the day the first paying studio signs up. The
same licence does **not** extend to stored enum values that are already documented as stable
machine identifiers (plan ids, `Course.accessRule.type`), which CLAUDE.md governs separately.

---

## Findings

| # | Sev | Freq | Finding | Area | Owner | Status |
|---|-----|------|---------|------|-------|--------|
| 1 | blocks | every-session | Consent is configured in the one place that does not gate attendance | C2×C3×M4 | web + functions | ✅ Fixed ✓verified |
| 2 | blocks | at-setup | A studio can complete the setup checklist and have a class nobody can book | M2×M3×M5 | web | ◐ Interim shipped |
| 3 | blocks | weekly | Availability management is an unlabelled caret welded to a filter chip | M3 | web | ✅ Fixed ✓verified |
| 4 | blocks | at-setup | Recurring timetables are create-only and silently expire after six months | M3 | web + functions | ◐ Cliff closed; series surface deferred |
| 5 | blocks | weekly | 13 of 16 money actions fail invisibly | M6 | web | ✅ Fixed |
| 6 | blocks | at-setup | A non-owner manager's settings saves fail silently — and the booking cutoff never applies | M7×M3 | web + functions | ✅ Fixed |
| 7 | costs-money | at-setup | Nobody is told they are on a 30-day trial, and Billing says "No subscription" | M2×M6 | web + functions | ◐ Interim shipped ✓verified |
| 8 | costs-money | weekly | Refunding returns the money and leaves the member holding the goods | M6 | functions + web | ✅ Fixed |
| 9 | blocks | every-session | The assistant launcher sits on top of the page's primary button and eats the tap | M1 | web | ✅ Fixed ✓verified |
| 10 | blocks | every-session | The member portal reports "no bookings" while holding a paid appointment | C4 | functions + web | ✅ Fixed |
| 11 | costs-money | every-session | The default access tier can never name a plan, and the health check is blind to it | M5×C1×C2 | web | ✅ Fixed |
| 12 | costs-money | weekly | Payment corrections make the data worse than the mistake did | M6 | functions + web | ✅ Fixed |
| 13 | costs-money | weekly | Automations can email the whole list with no preview, and "Run Now" re-sends | M9 | web | ✅ Fixed |
| 14 | costs-money | every-session | A visitor commits without seeing cancellation terms or the no-show fee | C2 | web + functions | ✅ Fixed |
| 15 | costs-money | weekly | Bulk plan changes keep the old plan's price | M4 | web | ✅ Fixed |
| 16 | costs-money | once | Plugin removal is one unconfirmed click, including paid add-ons | M8 | web | ✅ Fixed |
| 17 | costs-money | at-setup | Two things called Stripe on one screen; the record-only one says "Enabled" | M6 | web | ✅ Fixed |
| 18 | slows | every-session | Confirming a booking writes different data depending on which page you used | M3×M4×M1 | web/functions | ✅ Fixed |
| 19 | slows | every-session | Booking a known person into a class has exactly one door — the one that corrupts the counts | M3×M4 | web | ✅ Fixed |
| 20 | confuses | every-session | The schedule contradicts itself: "0 upcoming" over a full grid | M3 | web | ✅ Fixed |
| 21 | slows | every-session | No way to open one person's record without going to Contacts first | M1×M4 | web | ✅ Fixed |
| 22 | confuses | every-session | Refresh, share or reopen a detail page and lose the tab you were on | M4×M3×M5×M8 | web | ✅ Fixed |
| 23 | confuses | every-session | Three parallel "remembered destination" mechanisms; "pin" means two things | M1 | web | ✅ Fixed |
| 24 | slows | weekly | Saving an offer change tells you nothing — the real cause of reported F2 | M5 | web | ✅ Fixed |
| 25 | blocks | at-setup | A discount cannot be applied to a membership — the highest-value thing in the shop | M5 | functions + web | ✅ Fixed |
| 26 | confuses | every-session | Public copy leaks back-office vocabulary: 8 `activity` + 4 `drop-in` hits | C1–C4 | web | ✅ Fixed |
| 27 | blocks | at-setup | The checklist's "subscriptions" step lands on a page that cannot create one | M2×M5 | web | ✅ Fixed |
| 28 | slows | weekly | Nine public surfaces managed from six route prefixes across three partial maps | M11×M7×M5×M8 | web | ✅ Fixed |
| 29 | slows | every-session | Find "Schedule" only after scanning past five less-used items — a regression from `6d94638` | M1 | web | ✅ Fixed |
| 30 | confuses | every-session | Every published tenant website mixes the owner's language with English chrome | C1 | web | ✅ Fixed |
| 31 | confuses | every-session | The bio-link — the one artifact meant to be shared — previews as "Linyup" | C1 | web | ✅ Fixed |
| 32 | costs-money | weekly | Cancelling from the emailed link answers in English and says nothing about money | C2 | web | ✅ Fixed |
| 33 | blocks | at-setup | A studio that cannot take money still advertises priced doors | C2×M6 | web + functions | ✅ Fixed |
| 34 | blocks | at-setup | The org Members tab is a fully-styled form whose callables do not exist | M10 | functions + web | ✅ Fixed |
| 35 | costs-money | weekly | Org plugin installs hand affiliated studios plan-gated features for free | M10 | web | ✅ Fixed |
| 36 | slows | every-session | The mobile hamburger scrolls away with the page | M1 | web | ✅ Fixed |
| 37 | confuses | every-session | The member portal greets a signed-in member by telling her she is a stranger | C4 | web | ✅ Fixed |
| 38 | slows | every-session | Space Home never answers "what's next", and duplicates four blocks that live elsewhere | C4 | web | ✅ Fixed |
| 39 | confuses | at-setup | Ranks taxes every studio that does not award them | M7×M4×M2 | web | ✅ Fixed |
| 40 | slows | at-setup | Adding one class means meeting 23 fields, one of them required | M2×M5 | web | ✅ Fixed |
| 41 | slows | at-setup | Turning on public booking asks 11 questions, at least 3 with a right answer | M7×C2 | web | ✅ Fixed |
| 42 | confuses | at-setup | Above-tier settings behave three inconsistent ways; only one reads as "upgrade" | M7 | web | ✅ Fixed |
| 43 | slows | at-setup | Discount campaigns are findable only by browsing the plugin catalogue | M8×M5 | web | ✅ Fixed |
| 44 | slows | every-session | Contacts sorts by surname and cannot answer "who needs me today" | M4 | functions + web | ✅ Fixed |
| 45 | confuses | at-setup | Setup is presented three times, three ways, with three dismissals and no finish line | M2 | web | ✅ Fixed |
| 46 | confuses | at-setup | Day one shows 18 dashboard cards, 17 of them empty | M2 | web | ✅ Fixed |
| 47 | confuses | once | The product tour never mentions activities, sessions, bookings, contacts or money | M2 | web | ✅ Fixed |
| 48 | slows | weekly | `automation_logs` is written by every trigger path and read by nothing | M9 | web | ✅ Fixed |
| 49 | confuses | weekly | Unpublishing a surface leaves the bio-link pointing at a dead page | M11 | web + functions | ✅ Fixed |
| 50 | slows | weekly | "Take it off the internet" is one unconfirmed click, next to Publish | M11 | web | ✅ Fixed |
| 51 | confuses | at-setup | "Create alert" is selectable and silently stripped at save | M9 | web | ✅ Fixed |
| 52 | confuses | every-session | A purchase-tier course opened by shared link shows a signed-in member a sign-in wall | C4×C3 | web | ✅ Fixed |
| 53 | slows | weekly | Class bookings send no calendar invite; the manage link exists only in the email | C2 | functions + web | ✅ Fixed |
| 54 | confuses | every-session | Filtering contacts in German reads English — 15 hardcoded strings | M4 | web | ✅ Fixed |
| 55 | slows | every-session | The member portal links to the shop four ways and to booking not at all | C4 | web | ✅ Fixed |
| 56 | confuses | weekly | Cancelling a class says nothing about the credit, and offers "try again" for a permanent refusal | C4 | web | ✅ Fixed |
| 57 | confuses | every-session | A prospect on the Shop has no path to the studio's terms | C3 | web | ✅ Fixed |
| 58 | confuses | weekly | Two competing sign-in UIs fire off the same state on gated forms | C3 | web | ✅ Fixed |
| 59 | slows | weekly | A settled-in-cash appointment whose payment link went unpaid has no action at all | M6 | web + functions | ✅ Fixed |
| 60 | confuses | weekly | A BYO studio's doubled revenue rows are indistinguishable from two real payments | M6 | web | ✅ Fixed |
| 61 | slows | weekly | Public pages is the only settings section that isn't a settings panel | M7×M11 | web | ✅ Fixed |
| 62 | slows | weekly | Contacts cannot be filtered by coach, or by "in no group" | M4 | functions + web | ✅ Fixed |
| 63 | slows | every-session | A booking row hides its own contact and session behind an action menu | M3×M4 | web | ✅ Fixed |
| 64 | slows | weekly | The schedule cannot show a season, only a three-month window | M3 | web | ✅ Fixed |
| 65 | slows | every-session | Plugin suggestions clutter the sidebar, and "recommended" isn't a filter where plugins are chosen | M1×M8 | web | ✅ Fixed |
| 66 | confuses | weekly | A paid trial is recorded as a trial, with no trace that money changed hands | M4×M5 | functions + web | ✅ Fixed |
| 67 | confuses | at-setup | Places is a scheduling concept filed under Settings | M7×M3 | web | ✅ Fixed |
| 68 | slows | at-setup | Nothing can be duplicated, so the second of anything costs as much as the first | M5×M2 | web | ✅ Fixed |
| 69 | costs-money | weekly | Linking a subscription to an *appointment* writes a field appointments never read | M5 | web | ✅ Fixed |
| 70 | costs-money | at-setup | An appointment can be free or priced, but not "only with a pack" | M5×C2 | shared + web | ✅ Fixed |
| 71 | slows | weekly | A page never points at the one other page that would confirm it worked | M5×M7×M1 | web | ✅ Fixed |
| 72 | confuses | at-setup | Delete the per-page help popovers — the How-to page replaced them | M2×M1 | web | ✅ Fixed |
| 73 | slows | weekly | The org billing page repeats every problem UX-5 just fixed, one floor up | M10×M6 | web | ✅ Fixed |
| 74 | slows | every-session | In 13 dialogs the Save button scrolls away with the form | M5×M7×M9 | web | ✅ Fixed ✓verified |
| 75 | blocks | weekly | An org admin cannot cancel, reactivate or pay for her own organisation | M10×M6 | functions | ✅ Fixed |
| 76 | costs-money | every-session | A paid drop-in confirms nothing — no email, and no route to what you bought | C2×C4 | functions + web | ✅ Fixed |
| 77 | costs-money | weekly | Three more paid rails confirm nothing, and a fourth confirms behind a switch | C2×C3×M6 | functions | ✅ Fixed |
| 79 | slows | weekly | A studio sells a product and the product knows nothing about handing it over | C3×M5 | shared + web | ✅ Fixed |
| 80 | costs-money | weekly | Everything sold at the desk still confirms nothing | M6×C4 | functions | ✅ Fixed |
| 81 | confuses | every-session | Every email's plain-text half runs its headings into the following sentence | C2×M9 | functions | ✅ Fixed |
| 78 | confuses | every-session | A contact's pending-booking counter moves only if a mail is switched on | M4×M3 | functions | ✅ Fixed |
| 82 | blocks | weekly | A member can buy a plan and still be locked out, with no self-serve way back | M5×M8 | functions | ✅ Fixed |
| 83 | blocks | every-session | A trial lead who signs up is still refused, and the card promises otherwise | M5×M8 | functions | ✅ Fixed |
| 84 | blocks | weekly | "When someone joins" cannot be built: the trigger exists but is unreachable | M9 | web | ✅ Fixed |
| 85 | costs-money | weekly | Ten automation triggers offer a delay that is silently ignored | M9 | web + functions | ✅ Fixed |
| 86 | costs-money | once | A library automation gated to a paid plan installs on any plan | M9×M8 | web | ✅ Fixed |
| 87 | confuses | at-setup | Declared triggers that can never fire, and mounted ones that never do | M9 | functions + web | ✅ Fixed |
| 88 | blocks | every-session | After paying, the buyer lands on a page that asks them to sign in again | C2 | web + functions | ✅ Fixed |
| 89 | confuses | every-session | A confirmed newcomer booking is not tracked - contact still shows 0 attended | M4xM3 | functions | ✅ Fixed |
| 90 | slows | every-session | Sidebar search finds pages, not contacts, subscriptions or activities | M1 | web | ✅ Fixed |
| 91 | slows | every-session | Session detail: secondary-looking primary action, unlinked names, heavy share control | M3 | web | ✅ Fixed |
| 92 | slows | every-session | Schedule: oversized bookable-hours control, and no way to reach "new activity" | M3xM5 | web | ✅ Fixed |
| 93 | slows | weekly | Documents are listed twice, and the publish controls scroll away from a long body | M11 | web | ✅ Fixed |
| 94 | slows | weekly | The website's activity cards cannot control how pricing is shown | M7 | web | ✅ Fixed |
| 95 | slows | weekly | The website has no pricing TABLE - activities as rows, plans as columns | M7 | web | ✅ Fixed |
| 96 | slows | weekly | Contact notes cannot be colour-tagged | M2 | web | ✅ Fixed |
| 97 | confuses | weekly | Nine emailed links still drop the locale, so the page answers in English | C2xM9 | functions | ✅ Fixed |
| 98 | slows | every-session | A person's name is a dead end on four more lists | M2xM3 | web | ✅ Fixed |
| 99 | slows | at-setup | Three more "create one first" dead ends, all naming a destination they don't link | M5 | web | ✅ Fixed |
| 100 | slows | weekly | Four more unpublish buttons take a public page down with no confirmation | M7xM11 | web | ✅ Fixed |
| 101 | costs-money | every-session | A gated class whose plans are not public shows no gate at all | M5xM7 | web | ✅ Fixed |
Findings 69+ (per-area tails, each capped at 8 and returned `--brief`) are summarised under
**Remaining, by area** rather than enumerated individually.

**Status legend.** `▶ Open` · `◐ Interim shipped` — the cheap mitigation is in, the real fix is
not; the row stays open · `◐ Partial` — some call sites done, see the finding's correction note
· `✅ Fixed` · `✓verified` — exercised in a browser against the running stack, not merely
typechecked.

### Batch A, 2026-08-17

Seven cheap "close the lie" items, applied in one pass. Typecheck and lint clean; all four
locale files key-identical. **Nothing here is committed.** Two things worth carrying forward:

- **UX-5 is only partly closed and must not be ticked.** The `onError` fix landed on six
  mutation definitions in `hooks/useConnect.ts` and `hooks/usePolicyFees.ts`, but the billing
  callables — upgrade, **cancel**, reactivate, update-payment-method — are raw inline
  `httpsCallable` in `settings/billing/page.tsx` and were out of reach. See the correction note
  on UX-5.
- **UX-24's fix had to be rebuilt** once a manual reproduction showed the create path fails
  *partially* — `addDoc` runs before the image upload, so a denied upload leaves a real,
  imageless activity behind. A generic error toast would have sent the manager into a
  duplicate-creating retry. The two branches are now distinct; the edit path uploads *before*
  writing, so it is all-or-nothing and was already correct. The underlying Storage permission
  denial is filed separately in `docs/open-defects.md`.

Only UX-7 was exercised in a browser (billing now reads "Coach plan · Trial · Trial ends on
31/08/2026" with the Coach tile marked Current, where it previously said "No subscription").
The rest are applied and typechecked but **not** runtime-verified — which, per this review's own
findings, is not the same thing.

---

## Work orders — the top twelve

### UX-1 — A studio that made its house rules mandatory still lets newcomers train having accepted nothing
`blocks` · every-session · **observed** (persona F11, F8) + traced · merges C2-1, C3-1, M4-1

**Now.** There are two structurally different consent mechanisms that look like peers:

| | "Signup consent" — what a manager finds | The booking gate — what she needs |
|---|---|---|
| Control | `documents/page.tsx:168-171` → `plugins/documents/ConfigPanel.tsx:44` | `documents/[documentId]/page.tsx:552` → `plugins/documents/WaiverSettings.tsx:196-215` |
| Where | A button at the top of the Documents **list** | A block on **one document's detail page**, rendered only when `kind === 'waiver'` |
| Writes | `teams/{id}/settings/documents.signupDocumentIds` | `teams/{id}/waiver_policy/current` via `setWaiverRequirement` |
| Mirror | `TeamPublicProfile.signup_documents` (`team.ts:522`) | `TeamPublicProfile.required_waivers` (`team.ts:549`) |
| Read by | `signup/SignupForm.tsx:86` **only** | `useWaiverGate` in `BookingForm.tsx:476-480`, `AppointmentPicker.tsx:512`, `WalkIn.tsx:97`, `waitlist/page.tsx:213` |

`BookingForm.tsx` never reads `signup_documents` — grep returns zero hits. So a House Rules
document attached to Signup consent is invisible on every booking surface, and `WaiverStep`
renders nothing because `required_waivers` is empty. The guest sees one line,
`PublicBooking.consentText`. The server side says so explicitly: *"THIS RAIL RECORDS; IT
NEVER REFUSES … Signup is not attendance"* (`packages/functions/src/waivers/signup.ts:12-18`).
The document-creation dialog lists `Terms / Privacy / Regulation / Other / Waiver` as one flat
set (`documents/page.tsx:45`) with **no copy anywhere** saying only `Waiver` gates anyone who
never visits `/signup` — and a manager authoring "House Rules" reaches for `Regulation`, not
the legally-loaded word.

The person-shaped half is missing too. The contact record has nine tabs
(`contacts/[id]/page.tsx:4831-4841`) and none is about consent; `ConsentHistoryPanel` exists
but renders at the bottom of the **Profile** tab under a ~557-line edit form (`:5276`) and
returns `null` outright unless a required-waiver policy exists
(`components/contacts/ConsentHistoryPanel.tsx:54`). A signup-consent acceptance is recorded
and **displayed on no screen in the product**, from either direction. And there is no remedy:
`ContactFilter` has 15 dimensions and none is consent
(`packages/shared/src/utils/contactFilter.ts:75-93`), so bulk outreach, dynamic groups and
automations cannot target the unsigned — and `packages/functions/src/waivers/` ships create,
update, publish, setRequirement, archive, resolve, revoke, signInSpace and export, but **no
callable that asks anyone to accept anything**.

> **Correction, 2026-08-17, from building part A.** "Displayed on no screen" is true of the
> *list* and overstated about the data. `exportContactConsentHistory` was already union-shaped —
> it queries acceptances by `contactId` with no kind filter — so signup acceptances were always
> in the downloaded artefact; and `revokeWaiverAcceptance` has no `not_a_waiver` check, so
> revoking a signup-terms signature already worked. Both were simply unreachable, behind the
> same `return null` as the list. The data layer needed nothing here; only the reader was
> narrow — which makes part B cheaper than this finding implies.

**Cost.** She did the compliance work; the product will not tell her it didn't take. She finds
out at a dispute, or never. This is the one finding where the product looks *complete* — the
waiver system landed with roster chips, a door check, a legal-grade export and a
revoke-with-reason flow — while the question a human actually asks stayed unanswerable.

**Fix.** Make enforcement a **scope**, not a document kind.
1. One "Where documents are asked for" panel on `/documents`, listing every published document
   against *Shown at signup* / *Required before booking* — the two flags that already exist,
   in one place, with the Studio-plan lock shown inline. Retire the separate Signup-consent
   dialog. Keep `WaiverSettings`' validity/scope/minors controls on the document detail page;
   those are genuinely per-document.
2. A **Documents** tab on the contact record listing the union of both sets with this person's
   state, version, role and date — promote `ConsentHistoryPanel` out of the Profile form and
   widen it past `useWaiverPolicy`.
3. A `requestWaiverAcceptance` callable plus an "Ask to accept" action per row and in the bulk
   bar, sending the existing Space sign link.
4. A `consent` dimension on `ContactFilter` — that one addition buys a filter chip, a saved
   set, a dynamic group *and* an automation condition, because they all share `matchesFilter`.
5. `waiver_accepted` / `waiver_revoked` in `ActivityEventType`.

**Cheap interim, this week:** one sentence under `Documents.configSignupBody` — *"Bookings are
not covered by this. To ask for a signature before someone books, publish a Waiver and turn on
Required before booking."* — plus render `signup_documents` as links beside `consentText` in
the booking flow, and move `ConsentHistoryPanel` into its own tab with an honest empty state.

**Surface:** −1 parallel consent mechanism, −1 dialog, +1 panel, +1 contact tab, +1 callable,
+1 filter dimension. **Build:** L. **Owner:** web-agent + functions-agent.
**Verify:** As a Studio-plan manager, make "House Rules" mandatory using only the controls on
`/documents`. Walk `/public/{slug}/booking` as a guest — the text appears before Confirm. Then
filter Contacts to everyone who has not accepted, and email them, without leaving Contacts.

---

### UX-2 — A studio can complete every setup step and have a class nobody on earth can book
`blocks` · at-setup · counted · M2-1

**Now.** Two defaults make the guided path a dead end. A new activity defaults to
`accessTier: 'members'` with `subscriptionTypeIds: []`, `dropInEnabled: false`,
`trialEnabled: false` (`offer/activities/page.tsx:355`) — `'members'` means any **joined**
contact, and a day-zero studio has none, so a bio-link prospect is refused. A new session
defaults to `allowBooking: false` (`components/sessions/SessionFormDialog.tsx:390`), an
unchecked, un-hinted checkbox at `:842`; with it off, `syncSessionPublicProfile.ts:31` never
writes the public mirror, the public query `where('allowBooking','==',true)`
(`booking/BookingForm.tsx:546`) never returns it, and `bookSession` refuses it
(`packages/functions/src/booking/index.ts:723`).

The checklist's completion test is **existence-only** —
`teamCollectionHasAny(ACTIVITIES_COLLECTION)` / `(SESSIONS_COLLECTION)`
(`hooks/useSetupChecklist.ts:56-63`) — so it cannot tell a bookable class from an invisible
one, and ticks both. It reports 5/5.

**Cost.** The single outcome the entire first run exists to produce is not produced, and
nothing says so. Empty public page, no error to search for. This is the churn moment.

**Fix.** Measure the outcome, not the artefact: the sessions step completes only when ≥1 future
session has `allowBooking: true` **and** its activity admits a non-member (`open`, or
`trialEnabled`, or `dropInEnabled`). Rename it "Put a bookable class on your calendar". Flip
both defaults for a team's **first** activity and session — the studio that wants a gate goes
looking for one; the studio that wants a booking should not have to find two unrelated
switches in two dialogs. **Interim:** keep the defaults, add a red line to the step — *"This
class isn't bookable yet: turn on Allow online booking"* — deep-linked to the session, plus
the same warning on any activity gated to an empty subscription list.

**Surface:** −2 first-run decisions, +1 shared `isPubliclyBookable(session, activity)`
predicate (reuse it for a "not bookable" badge on the schedule). **Build:** M. **Owner:** web-agent.
**Verify:** Sign up fresh, do only what the checklist says, then open `/public/{slug}/booking`
in a private window as a stranger and book. If the page is empty, this is not fixed.

---

### UX-3 — A coach who wants to set her bookable hours must find a caret with no label welded to a filter chip
`blocks` · weekly · **observed** (persona F7) · M3-2

**Now.** The availability manager — published schedules, pause/resume, edit, delete and **time
off** — is `AppointmentAvailabilityDialog` (`components/appointments/AppointmentAvailability.tsx:994`).
It has exactly one importer and one trigger: a `DropdownMenuTrigger` whose entire visible
content is `<ChevronDown className="h-3.5 w-3.5" />`, attached to the right edge of the
"Availability" **filter** chip (`schedule/page.tsx:1102-1124`). Its only name is a
`title`/`aria-label`. Time off is one level deeper inside that dialog (`:1201-1230`). The code
comment at `schedule/page.tsx:981-983` records the move: it used to be a header button,
relocated "to keep the top area to just + New".

*Creating* availability is also in "+ New", as "Appointment availability" after an unexplained
separator (`:1006-1009`), and again, duplicated, inside the caret menu (`:1118-1121`). So the
job has three doors, two of them the same action, none named as a task — and the door for
everything except creation is the invisible one. The chip also does what a filter must never
do: pressing it force-switches the view (`setView('calendar')`, `:1092`). It is a mode wearing
a filter's clothes.

The persona spent two of five goals failing to find this, checked `/coaches` and Settings →
Booking, and gave up.

**Fix.** *(This is the area's removal.)* Delete the split-button and the `availability` filter
chip; collapse `availabilityMode` (`schedule/page.tsx:880-908`,
`SessionsCalendar.tsx:676-688, 991-1023`) into the overlay rendering that already exists
(`:1024-1031`) so published hours are simply always visible behind the week grid. Give
availability one named destination — a **"Bookable hours"** panel from the Schedule header, or
`/schedule/availability` so it is linkable and pinnable: schedules per coach, pause/resume,
time off, "Add hours". Rename the "+ New" item to a verb — "Add bookable hours" — and drop the
duplicate. Surface **time off** as a first-class action.
**Interim:** a text label beside the caret ("Manage") and a header button on `/schedule`. One
line each; it unblocks the coach while the rest is built.

**Surface:** −1 split-button, −1 filter chip, −1 calendar mode, −1 duplicated menu item, +1
named destination. **Build:** M — the dialogs exist and are self-contained; this is re-hosting
them. **Owner:** web-agent.
**Verify:** As someone who has never seen the app: publish Anna's Tuesday 09:00–12:00 hours,
then block next Thursday off, without opening the "+ New" menu.

---

### UX-4 — A weekly timetable must be right on the first save, and it silently stops six months later
`blocks` · at-setup, then permanent · **observed** (persona F4) + traced · M3-1

**Now.** Recurrence is offered only on create — the panel is wrapped in `{!editing && (` at
`SessionFormDialog.tsx:710`. Open any existing class and there is no recurrence field and no
way to add one. **There is no series object in the product**: `session_series` is written from
exactly one place in the web app (`SessionFormDialog.tsx:475`) and **read from none** — no
list, no detail page, no nav item, no way to see a pattern, its end date, or how many sessions
remain.

And it ends. `generateRecurringSessions` materialises `addMonths(now, 6)`
(`packages/functions/src/sessions/index.ts:60`), is called only at creation
(`SessionFormDialog.tsx:509`), and **no scheduled job extends it** —
`packages/functions/src/dailyTasks/index.ts:51-64` contains no series work. Worse,
`updateRecurringSession` bumps `lastGeneratedUntil` to `now + 6 months` **while generating
nothing** (`sessions/index.ts:589-593`), so the stored horizon claims sessions that do not
exist. A studio that sets "every Tuesday, ends never" has an empty calendar in month seven,
taking every public booking link with it, with nothing that could have warned it.

Two smaller cuts: the recurring path writes a **different session shape** — generated docs
carry no `duration_minutes`, `autoConfirm`, `placeId` or `roomId` (`sessions/index.ts:82-107`
vs `SessionFormDialog.tsx:440-463`) — and the object is named four ways in one flow (menu "New
class", dialog "New session", toggle "Repeat this session", badge "Class").

**Fix.** Make the series a thing you can see and edit: a "Repeating" list or tab on `/schedule`
showing activity, pattern, next occurrence and **end date**, with edit/pause/end/extend; show
recurrence on edit, routed through the this/future scope chooser that already exists
(`SessionFormDialog.tsx:617-649`); allow "make this repeat" on an existing standalone session;
add a daily task rolling every active series forward to a 6-month horizon, idempotent against
the existing `instanceDate` dedupe query (`sessions/index.ts:73-80`); settle the noun.
**Interim:** default `endCondition` to `'date'` six months out so the form states the horizon
it actually has, put the end date in the "Part of a recurring series" banner, and add
"Weekly · until 14 Feb" to the peek sheet.

**Surface:** +1 route or tab, +1 scheduled function, −1 silent data cliff, −1 duplicated write
shape. **Build:** L. **Owner:** web-agent + functions-agent.
**Verify:** Create a class for next Tuesday without ticking Repeat. Now make it weekly ending
in December, without deleting it. Find the series tomorrow and change its end date to March.

---

### UX-5 — Thirteen of sixteen money actions fail invisibly
`blocks` · weekly · counted · M6-3

**Now.** Across the M6 surfaces there are 16 payment-callable invocations. **Three** tell the
manager when they fail: refund (`payments/page.tsx:209-221`, with a genuinely good
refusal-reason branch), mark-appointment-paid (`:748-750`) and gift-card issue
(`GiftCardsSection.tsx:264-265`). The rest do not:

- `settings/billing/page.tsx:251-253, 265-267, 281-283, 299-301` — upgrade, cancel, reactivate
  and update-payment-method each `console.error` and return. **A cancel that failed and a
  cancel that succeeded look identical until the next reload.**
- `RecordPaymentDialog.tsx:118-128`, `AssignPaymentDialog.tsx:83-84` — bare `await
  mutateAsync`; a rejection is an unhandled promise, the dialog stays open with the data in
  it, nothing appears.
- `payments/page.tsx:586-596` (payment link), `ConnectPaymentsCard.tsx:37-40` (onboarding),
  `settings/team/page.tsx:1234-1282, 1292-1297` (gateway CRUD), `OutstandingFeesCard.tsx:46-48, 80`
  (waive/resend), `GiftCardsSection.tsx:380-383` (void a card).

Not theoretical: `requireChargeableAccount` (`packages/functions/src/connect/access.ts:66-79`)
throws `failed-precondition` on exactly the population most likely to be clicking these — a
studio mid-onboarding. Its message never reaches a screen.

**Cost.** She cancels her subscription, sees nothing, clicks again. She records the day's cash,
the dialog sits there, she re-enters it. The product's own error strings are already written
and already thrown; only the last three metres are missing.

**Fix.** Put `onError: (e) => toast.error(...)` on the **mutation definitions** in
`hooks/useConnect.ts` and `usePolicyFees.ts` rather than on 16 call sites — one place, and new
callers inherit it. Map the known `failed-precondition` reasons to a sentence naming the next
step and linking to Settings → Payments, the way the refund handler already maps its gift-card
reasons.

> **Correction, 2026-08-17.** That fix does **not** reach four of the thirteen. The billing
> callables — upgrade, cancel, reactivate and update-payment-method — are raw inline
> `httpsCallable` calls inside `settings/billing/page.tsx` (`:257`, `:280`, `:294`, `:310`),
> not TanStack mutations defined in either hook file, so there is no `onError` to attach.
> They need either lifting into hooks or handling in place. Do not treat UX-5 as closed until
> they are done: "cancel my subscription" failing silently is the single worst case in the
> list, and it is one of the four. Also leave `useRefundMemberPayment` without a generic
> handler — its call site already maps refusal reasons well, and a blanket `onError` would
> double-toast every refund failure.

**Surface:** −13 silent failures; error handling moves into ~6 hook definitions. **Build:** S —
`sonner` is already imported. **Owner:** web-agent.
**Verify:** With `payments.connectStatus = 'pending'`, click "Create payment link" and "Select
plan". Each must say what is wrong and where to fix it.

---

### UX-6 — A non-owner manager's settings saves fail silently, and the booking cutoff never applies
`blocks` · at-setup / weekly · traced · merges M7-1 + M7-2

**Now, part one.** `firestore.rules:368` makes the team doc owner-only for writes; `:477` and
`:485` do the same for `alert_presets` and `integrations`. Seven of fourteen settings rail
items are therefore read-only for a `manager` role — and settings handles that fact three
different ways. Correctly disabled with a note:
`settings/booking/CancellationPolicyCard.tsx:29,65-67`, `NoShowPolicyCard.tsx`,
`settings/emails/SystemEmailsCard.tsx:167,230-232`, `components/connect/BillingCurrencyCard.tsx`.
Hidden entirely: `settings/emails/SmsSenderCard.tsx:101`. **Nothing at all** — the control
looks live and the save fails silently: `settings/team/page.tsx:346` (studio name, description,
sport, public slug — `await updateDoc` with **no `catch`**, then `setSaved(true)`), `:235`
(engagement thresholds), `:984` (ranking systems), `:476`/`:610` (alert presets), `:1234`/`:1292`
(payment gateway). On the Payments tab the *read* is denied too (`:199-214`), so `integrations`
resolves to `[]` and she is shown "No gateway configured" — indistinguishable from a studio
that genuinely has none.

**Now, part two — the same root cause with teeth.** `settings/booking/page.tsx:441-455` writes
booking settings twice, and its comment says which is which: *"① `public_profile` is the source
of truth (team-member writable). Must succeed. ② Mirror onto the team doc (owner-only;
re-hydrates this form). Non-fatal."* **The server disagrees.**
`packages/functions/src/booking/index.ts:860-869` reads the cutoff from
`team.settings.booking.cutoffMinutes` and calls it "authoritative"; `booking/dropIn.ts:188-195`
reads the same field. The form re-hydrates from that same mirror (`:77`). So for a
`manager`-role user, ② fails with a permission error swallowed into `console.warn` (`:452-454`),
a green "Saved" toast fires (`:456`), and three things are true at once: the public page hides
late slots, the booking callables still accept them, and reloading shows the old value — so she
believes she never saved it. The same split affects `waitlistEnabled`, `appointmentsEnabled`
and the window.

**Cost.** The one setting whose entire purpose is to say *no* silently says yes. She sets a
cutoff to stop 19:58 sign-ups for a 20:00 class, watches the public page behave, and a deep
link or the drop-in checkout books someone anyway.

**Fix.** Part one: do what `CancellationPolicyCard` already does, everywhere — derive `canEdit`
from `useCapabilities().can('team.settings')` once, thread it into the five forms, disable the
inputs and Save, render the existing owner-only note; then hide `teamPayments`, `teamAlerts`,
`teamRanking` and `billing` from the rail for non-owners via the `SettingsGate` mechanism that
already exists (`lib/settings-nav.ts:29`, currently carrying one dead value). Part two: one
source — make `public_profile.bookingSettings` the single store, have the callables read it
(they already load the team), delete the team-doc mirror. **Interim for both:** wrap those five
`updateDoc`s in a `catch` raising an error toast, and make ② fatal so the lie stops.

**Surface:** −4 rail items for non-owners, −1 duplicated store, −1 silent failure path.
**Build:** M. **Owner:** web-agent + functions-agent (read path + rules).
**Verify:** As a `manager`-role member, set the cutoff to 60 minutes, reload (the value
persists), then attempt a booking 30 minutes before a session via a direct link — refused.

---

### UX-7 — Nobody is told they are on a 30-day trial, and Billing says "No subscription"
`costs-money` · at-setup · counted · M2-2

**Now.** Signup silently provisions `plan: 'studio'`, `plan_status: 'trial'`,
`trial_ends_at: now + 30d` (`lib/provisioning.ts:74-77`; `TRIAL_DAYS = 30`,
`packages/shared/src/types/plan.ts:11`). The wizard never mentions a plan, a trial, a length or
a price. `usePlan()` exposes `isTrialing` (`hooks/usePlan.ts:46`) and has exactly **one**
consumer, which is not visual — `settings/plugins/page.tsx:783` branches an add-on activation.
No banner, badge or countdown anywhere.

Billing is worse than silent: it reads `saas_subscriptions/{teamId}`, which self-service signup
never creates, so `sub` is null → the Current Plan card renders `t('noSubscription')`
(`settings/billing/page.tsx:464`) while the app behaves as Studio, and `currentPlanRank = -1`
(`:225-233`) so **no plan is marked current** in the four-plan grid. Meanwhile day-zero Discover
nudges plugin installs (`components/dashboard/DiscoverPanel.tsx:146-186`), several of which she
will lose. At day 31 the first and only signal is `FreeDowngradeBanner`, which fires **after**
the drop to Free: a 15-contact hard cap (`plan.ts:60-62`), no finance dashboard, no trends, no
waitlist.

**Cost.** Thirty days building a studio inside a tier she never chose and was never told about,
then feature loss and a hard cap with no warning — and no reason to ever enter a card, because
no deadline is ever stated. The most expensive silence in the product, for the studio and for
Linyup.

**Fix.** State it three times: one line on signup step 2 above the button ("You're starting a
30-day {Studio} trial. No card needed."); a persistent shell chip "{Studio} trial · N days
left" linking to billing; and make Billing read the **team** doc when `sub` is null so it says
"{Studio} plan · Trial · ends {date}" and marks Studio current. Add T−7 and T−1 email.
**Interim:** the signup line and the billing null-branch alone — both are copy plus a branch.

**Surface:** −1 false state, +1 shell chip. **Build:** S for the web half (`isTrialing` and
`trial_ends_at` already exist and are computed); M with the reminder emails.
**Owner:** web-agent + functions-agent.
**Verify:** Sign up fresh and, without leaving the dashboard, answer: what plan am I on, does it
cost money, and when does it change? Then open Settings → Billing and check it agrees.

---

### UX-8 — Refunding a member returns the money and leaves them holding the goods
`costs-money` · weekly · traced · M6-1

**Now.** The refund confirm says only *"This refunds {amount} to the member and reverses the
platform fee proportionally"* (`payments/page.tsx:520-539`). What happens:
`handleChargeRefunded` (`packages/functions/src/connect/webhook.ts:671-751`) updates
`amount_refunded` and `status` and writes finance-journal rows — **and nothing else**.
`packages/functions/src/payments/effects.ts` exports `writeContactSubscriptionFields`,
`grantPaymentCredits`, `grantCourseEntitlement` and **no reversal of any of them**. A refunded
course purchase leaves the lifetime doc at `courses/{id}/purchases/{contactId}`
(`effects.ts:167-198`) — and **no manager surface in `apps/web` reads or writes `purchases` at
all**; the only readers are the public Shop and Space. Refunded credits stay in
`contact_credit_grants`; a refunded membership leaves `subscription_type_id` set. Gift cards
are the one handled case, and it is handled in the callable rather than the webhook
(`connect/refunds.ts:80-101`) — proof the gap was seen once and closed for exactly one product
kind.

**Cost.** She refunds a CHF 180 course, the member watches it forever, and there is no screen
anywhere — not the contact, not the course editor, not the payment row — where she can take it
back. This is "contact support to undo", except support has no UI either.

**Fix.** Make the dialog state the consequence and offer the choice — *"Refund CHF 180 and
remove {Course} from {Member}?"* with the revoke as the default. Behind it, one
`reversePaymentEffects(paymentRef)` beside `applyPaymentEffects`, called from the refund
**callable** (the manager's intent belongs where she expressed it), deleting
`purchases/{contactId}` and `contact_credit_grants/{paymentRef}` and clearing the subscription
fields when they still point at this payment. **Interim:** name what the member keeps in
`refundConfirmBody`, and add a "Remove access" action on the course entitlement — an honest dead
end beats a silent one.

**Surface:** +1 shared function, +1 manager action. **Build:** M — the grants are already keyed
by `paymentRef`, so the reversal is symmetric with code that exists; the judgement call is
subscriptions another payment may own. **Owner:** functions-agent, then web-agent.
**Verify:** Sell a course through the shop, refund it from `/payments`, then sign in as that
contact at `/public/{slug}/space` — the course must be gone, and the manager must have been
told it would be.

---

### UX-9 — The assistant launcher sits on top of the page's primary button and eats the tap
`blocks` · every-session · traced · M1-9

**Now.** `AssistantLauncher` mounts globally, unconditionally on mobile, **after `<main>` in
the DOM**, at `bottom-5 right-5 z-40` (`plugins/ai-assistant/AssistantPanel.tsx:72`, mounted at
`(auth)/layout.tsx:1895`). Two of the app's own FAB-convention buttons occupy the same corner
and z-layer: the Contacts "New contact" FAB at `bottom-6 right-6 z-40`
(`contacts/page.tsx:2651`) and the contact-detail floating **Save** for a dirty profile form at
`bottom-6 right-6 z-40` (`contacts/[id]/page.tsx:2192-2196`).

**Cost.** Once a studio installs the ai-assistant plugin, at 375px two ~50px round buttons sit
almost concentrically on every page using the FAB convention. Later DOM order plus the same
z-layer means the launcher paints on top and intercepts the tap. A manager tapping Save on an
edited contact opens the AI chat instead — and if she backs out without noticing, **her edits
are lost**.

**Fix.** Give shell-level floating controls a reserved lane distinct from the page-FAB corner —
a shared `FloatingSlot` registry so a page's primary action and the shell's overlays never
claim the same pixel (it replaces ~5 hardcoded call sites; ~14 files hardcode `fixed
bottom-*`). **Interim, shippable today:** move the assistant launcher off the FAB footprint
(`bottom-24 right-5`) — a one-line class change.

> **Correction, 2026-08-17.** An earlier draft of this finding said the feedback launcher had
> the same problem. It does not: `components/feedback/FeedbackLauncher.tsx:36` is a vertical
> edge tab at `fixed right-0 top-1/2`, and its header comment states the placement was chosen
> because *"the bottom-right corner belongs to the AI assistant launcher + page FABs"*. It is
> the precedent this finding is asking the assistant launcher to follow, not a second offender
> — which is also the argument for the `FloatingSlot` registry: one component reasoned about
> the corner and wrote it down, and the other never saw that note.

**Surface:** +1 shared component replacing ~5 hardcoded positions. **Build:** M. **Owner:** web-agent.
**Verify:** At 375px with ai-assistant installed, Contacts' "New contact" is fully tappable and
a dirty contact form's Save is not covered.

---

### UX-10 — The member portal reports "no upcoming bookings" while she is holding a paid appointment
`blocks` · every-session · traced · C4-1

**Now.** `space/bookings/BookingsHome.tsx:66-71` lists the team's upcoming public mirrors with
`where('type','==','session')`. Appointments are mirrored as `type: 'appointment_session'`
(`packages/functions/src/sync/syncSessionPublicProfile.ts:41`), so **no appointment can ever
match**. The probe loop (`:74-77`) then reads `sessions/{id}/bookings/{contactId}` — and
`bookAppointment` writes exactly that doc, keyed by contactId
(`packages/functions/src/appointments/booking.ts:526`). The booking is there; it is never
looked for. She is shown "You have no upcoming bookings."

Two further silent omissions on the same line: `limit(80)` truncates by **team** volume, not
hers, so at ten classes a day the list stops about eight days out and a booking four weeks
ahead is invisible; and a session the manager booked her into with `allowBooking !== true` is
never mirrored at all (`syncSessionPublicProfile.ts:29`), so studio-entered bookings never
appear either. The kiosk already gets this right —
`kiosk/useKioskSessions.ts:67` queries `where('type','in',['session','appointment_session'])`.

**Cost.** She paid for an appointment and her account says she has none. To cancel it she must
find the confirmation email and its token link, or she no-shows. Every other claim on this
surface is guarded against exactly this failure (see What's good #2); this one shipped as a fact.

**Fix.** The `getMyBookings` callable the file's own comment already names as future work
(`:39-43`): one server read of **her** bookings, unbounded by team volume, mirror liveness or
online-bookability, returning kind, provider name and cancel eligibility. **Interim:** widen the
query to `where('type','in',[…])`, paginate the limit, and label appointment rows with
`providerName` — it still misses studio-entered bookings, so it is an interim, not the answer.

**Surface:** −1 client fan-out (up to 80 `getDoc` per visit), +1 callable. **Build:** M.
**Owner:** functions-agent + web-agent.
**Verify:** Book a 1:1 and a class four weeks out as a member; open
`/public/{slug}/space/bookings` on a phone; both appear and both cancel.

---

### UX-11 — The default access tier can never name a plan, and the health check is blind to it
`costs-money` · every-session · **observed** (persona F9) + traced · merges M5-1, C1-2
**✅ Fixed** 2026-08-17 — **but not as written above: this finding's central premise was wrong.**
`members` does not mean "holds a subscription". It gates on `acquisition_stage === 'joined'`
(`paymentOptions.ts:269-271`; `access.ts:263` derives it strictly), and `completeSignup.ts:263`
— the only server-side writer of `joined` — is reached by a free public form whose own comment
reads *"signup without a purchase"*. A joined contact who has bought **nothing** books a
members class. So the "Included with…" framing this finding asked for, and its interim
*"Included with any membership"*, would have quoted a price **nobody has to pay** — worse than
the silence it replaced, because silence makes a prospect ask and a wrong price makes them
leave. The card now states the gate that is actually enforced: **"Members only — signing up is
free"**, pointing at `/public/{slug}/signup`, with no plan and no price. `cheapestSub()` and the
plan-catalogue parameter were removed rather than left unused. The flag is `signedUpOnly` —
named for what is enforced, not for what is sold. The copy deliberately never says *"and you can
book right away"*: the gate admits them instantly, but `completeSignup.ts:435` sends every
self-signup a welcome mail saying their request *"is under review"*, so that claim is true of
the code and contradicted by the studio's own email.
The `subscription` tier is untouched — there the named plans genuinely ARE the key.
**Two health checks stayed subscription-only, against this finding's instruction, and correctly:**
`gated_empty_allowlist` (a `members` rule has no allow-list to be empty — running it would fire
an *error* on every default class in a tenant that sells no plans) and `acceptedTypeIds` /
`credits_unusable` (a members class burns no credit, so counting it would have silently
suppressed a real alarm). Only `gated_no_newcomer_path` now runs on both tiers.
`activityTermLabel`'s gate branch was confirmed genuinely unreachable and deleted.

**Now.** A new class defaults to `accessTier: 'members'` — deliberately, with the reasoning in
the comment (`offer/activities/page.tsx:349-355`). But `members` is the one gate that carries
**no subscription ids**: `kindSpecificPayload` writes `subscriptionTypeIds` only for the
`subscription` tier (`:501-506`). Downstream, `resolveActivityPricingDisplay` builds its
`includedWith` list from `term.kind === 'gate' && term.tier === 'subscription'` only
(`lib/activityTerms.ts:202-203`), so a `members` class resolves to an empty list and **every
public surface renders no "Included with…" line at all** — while a `subscription`-tier class
lists all five plans. The persona hit exactly this and asked what she was supposed to buy.

It reproduces independently on the studio's own website through a different render path:
`ActivitiesBlock` (`components/site/sections.tsx:595-679`) renders those same lines and nothing
else about access, so a Members-only class on `/site` shows a name, a "Class" chip and a
**Book** link with no hint membership is required — on the surface a prospect reaches *earlier*.

And the safety net misses it: `computePricingHealth` opens with `if (rule.type !==
'subscription') continue` (`lib/pricingSurface.ts:386`), so both `gated_empty_allowlist` and
`gated_no_newcomer_path` — the check written for "no way in for a newcomer" — **never run on the
default tier**. The best diagnostic in the app is blind to the state most classes are in.

**Fix.** Make `members` name its plans: treat tier `members` as "every **public** active
subscription type" and emit the same `includedWith` rows the `subscription` tier does — the
surfaces already carry the lookup (`SubLookup`, `activityTerms.ts:167`). That preserves the
tier's real semantics (future plan types auto-included, which is why it must not simply merge
into `subscription`) while making it legible. Drop the `continue` at `pricingSurface.ts:386` so
`members` classes get the newcomer-path and empty-catalogue checks. **Interim:** one generic
line — "Included with any membership" plus a link to the shop's plans tab.

Note the payoff already sitting one step later: `BookingForm.tsx:2142-2194` already gives a
newcomer who hits a members-only class the plans that include it, with prices and a shop link.
The fix is to say it on the *card*, not only after the click.

**Surface:** 0 routes, 0 settings — one resolver branch, one health condition, one dead
`activityTermLabel` gate branch deleted (`sections.tsx:413-419`, unreachable). **Build:** M —
filter on `public` to avoid enumerating hidden plan types. **Owner:** web-agent.
**Verify:** Create a class on the default tier, publish it, open the public booking card signed
out: it names at least one plan and a price. Then check Offer → Pricing flags it if there is no
drop-in and no trial.

---

### UX-12 — Correcting a payment makes the data worse than the mistake did
`costs-money` · weekly · traced · M6-2

**Now.** Three compounding facts.

1. **A recorded payment is immutable.** `firestore.rules:607-609` — `payment_events` is `allow
   write: if false`; same for `member_payments` (`:615-617`). The only mutating callable,
   `updatePaymentRecord`, accepts contact, comment and line-item **only**
   (`connect/updatePayment.ts:62-99`). Amount, date and method cannot be changed by anyone, and
   there is no delete or void callable. A compensating entry is refused too:
   `recordManualPayment` rejects anything below 1 minor unit (`payments/recordManualPayment.ts:61-63`).
   CHF 1'800 typed instead of CHF 180 is permanent in the ledger, in `useMonthlyRevenue` and in
   the CSV export.
2. **The books can be corrected but the payments page cannot**, so the two disagree —
   `/plugins/finance/entries` has an owner-only reverse (`plugins/finance/entries/page.tsx:151-156`),
   behind a plugin install, reversing the accounting entry rather than the payment row.
3. **Re-assigning is additive, never subtractive.** `updatePayment.ts:168-183` calls
   `applyPaymentEffects` for the new contact and never reverses the old one's. Move a membership
   payment from the wrong Anna to the right Anna and **both** now hold the subscription and a
   credit grant — the `create()` idempotency in `effects.ts:126-164` is keyed per contact, so
   the second simply gets a fresh doc. The dialog that does this is titled "Edit payment"
   (`components/payments/AssignPaymentDialog.tsx:91`) and warns nothing.

**Cost.** Every correction makes it worse. Her month's revenue is wrong and unfixable, her
rosters show a member who never paid, and the one path that *looks* like a correction quietly
hands out a second membership.

**Fix.** A **Void** action on any `manual`-gateway row — a `voidManualPayment` callable flipping
it to `status: 'voided'` (visible, struck through, excluded from revenue) and reversing the
finance entry and the effects. Voiding is the correction; re-recording is the redo. And make
re-assign symmetric: reverse the previous contact's effects before applying the new one's, and
say *"This moves the membership from X to Y."* **Interim:** disable the contact field on a row
whose line item already granted something and point at void-and-re-record.

**Surface:** +1 callable, +1 row action, +1 row status. **Build:** L — the void is small, but
symmetric re-assign needs the same reversal primitive as UX-8, which is why they should ship
together. **Owner:** functions-agent + web-agent.
**Verify:** Record a CHF 1'800 cash payment linked to a 10-credit pack against contact A, then
correct it. A ends with no credits, revenue shows CHF 180, and the CSV agrees with
`/plugins/finance/entries`.

---

## Added after the review

### UX-61 — Public pages is the only settings section that isn't a settings panel
`slows` · weekly · traced · M7×M11 · *added 2026-08-17, after the review, on Franco's observation*

**Now.** `publicPages` is one of **15** entries in `SETTINGS_ITEMS`, and the only one whose
`href` points outside `/settings/*` — it goes to `/public-page` (`lib/settings-nav.ts:67`).
Its own comment concedes the consequence: *"Lives outside the /settings/\* shell at
/public-page, so the layout injects a 'back to settings' link."*

Three costs follow.

1. **It drops out of the master-detail shell.** `settings/layout.tsx` renders the rail once
   and keeps it mounted while the detail pane swaps, so moving between settings sections
   never re-flashes the rail — the review lists that shell in What's good #8. Opening Public
   pages from that same rail loses it entirely: the rail disappears, and returning re-mounts
   it. One row in a list of fifteen behaves unlike the other fourteen.
2. **The compensating back-link doesn't reach the children.** `(auth)/layout.tsx:1816-1817`
   computes `onSettingsPage` as `!pathname.startsWith('/settings') && SETTINGS_ITEMS.some((i)
   => i.href === pathname)` — an **exact** match. So `/public-page` gets the injected link at
   `:1881-1889`, while `/public-page/shop` and `/public-page/space` get nothing: no rail, no
   back-link, no route back to settings except the browser button. (M1 recorded this symptom
   under Confirms sweep without filing it.)
3. **The special case exists for this one item.** Nothing else in `SETTINGS_ITEMS` needs it.

**Fix.** Move the hub and its children under the settings shell —
`/settings/public-pages`, `/settings/public-pages/{shop,space}` — so it inherits the rail,
the mobile list ⇆ detail split and the back-link the other fourteen already get. Leave
redirect stubs at the old paths (retire them with the other 17). Then delete the
`onSettingsPage` branch and its injected `ChevronLeft` link from `(auth)/layout.tsx`.

**Interaction with UX-28.** That finding proposes making the public-pages hub the *single*
manager surface for all nine public surfaces, pulling each surface's editor under it. The two
agree, and this one is the cheap structural half — but both move the same routes, so **if
UX-28 is scheduled soon, do them in one pass** rather than relocating the same files twice.

**Surface:** −1 route prefix, −1 layout special case, +3 redirect stubs. **Build:** M — route
moves plus stubs; the pages themselves don't change. **Owner:** web-agent.
**Verify:** From Settings → Emails, click Public pages — the rail stays put. Open its Shop
sub-page — there is still a rail on desktop and a back-link on mobile.

### UX-62 — Contacts cannot be filtered by coach, or by "in no group"
`slows` · weekly · traced · M4 · *added 2026-08-17, from manual exploration*

**Now.** `matchesFilter` (`packages/shared/src/utils/contactFilter.ts`) carries dimensions for
stages, sources, statuses, subscriptions, groups, tags, age, engagement, inactivity, search and
custom fields — and **no coach/assignee dimension at all**. A manager whose role lets her see
every contact cannot narrow the list to one coach's people. Separately, the `groups` dimension
can only express *in* a group; there is no "in no group", which is the query a studio runs when
it wants to find who has fallen through its own segmentation.

**Fix.** Extend the resolver — and only the resolver. CLAUDE.md is explicit that
`matchesFilter` is the ONE contact-matching implementation and that a parallel check must never
be added. Add a `coach` dimension and a negative/empty case to `groups`. The dividend is the
reason to do it there: both then work in the contacts list, in saved filter presets, in dynamic
groups **and** in the automation engine's `in_group` condition, for free, because all four read
the same predicate. Fixtures belong beside the existing ones in
`packages/functions/src/contacts/contactFilter.test.ts`.
**Surface:** +2 filter dimensions, 0 routes, 0 parallel logic. **Build:** S–M.
**Owner:** functions-agent (resolver + fixtures), then web-agent (chips).
**Verify:** Filter contacts to one coach's people, then to everyone in no group, and save the
second as a dynamic group.

### UX-63 — A booking row hides its own contact and session behind an action menu
`slows` · every-session · traced · M3×M4 · *added 2026-08-17, from manual exploration*

**Now.** On `/bookings`, the two entities a row is *about* — the contact and the session — are
reachable only through the row's action menu. The names are rendered as text, not links.

**Cost.** The most common thing to do with a booking row is look at the person or the class it
belongs to, and both cost a menu open. This is also a cheap partial answer to UX-21 (no way to
reach a person's record from where you already are): it does not replace the search provider,
but it removes one of the most-walked detours to it.
**Fix.** Make the contact name link to `/contacts/{id}` and the session label to
`/sessions/{id}`. Keep the action menu for actions. **Build:** S. **Owner:** web-agent.

### UX-64 — The schedule cannot show a season, only a three-month window
`slows` · weekly · traced · M3 · *added 2026-08-17, from manual exploration*

**Now.** The List view offers Upcoming/Past tabs (`schedule/page.tsx:1178-1192`) over the same
truncated fetch the calendar uses — `useAllSessions` reads only `[viewMonth − 1, viewMonth + 2)`
(`:201-202`). There is no way to see the shape of a term or a season, which is precisely the
view a studio owner needs to plan events.

**Fix.** A month-grouped "zoom out" on the List view, plus a season start/end the studio can
set (a season rarely matches the calendar year).
**Two dependencies, both worth respecting:**
1. **Do UX-20 first.** The list inherits the three-month window, so a season view is not a
   presentation change — it needs the fetch fixed before it can be honest. Building it on
   today's query would produce a season view that silently omits most of the season.
2. **Default the season, don't ask for it.** The report's standing complaint about M7 is
   configuration debt: every setting that could be a sensible default is a finding. Default the
   season to the calendar year and let a studio override it, rather than adding a required
   decision at setup.
**Build:** M (after UX-20). **Owner:** web-agent.

### UX-65 — Plugin suggestions clutter the sidebar, and "recommended" isn't a filter where plugins are chosen
`slows` · every-session · traced · M1×M8 · *added 2026-08-17, from manual exploration*

**Now.** The sidebar renders muted plugin-suggestion entries with a per-browser dismissal
(`linyup_hidden_plugin_suggestions`, `(auth)/layout.tsx:534`) — one of the nine device-local
preferences UX-23 counts, so a manager who dismisses them on her laptop meets them again on her
tablet. Alongside them sits the icon-only "Explore plugins" entry point that UX-14 already
flags as unlabelled and hover-only on touch.

**Fix.** Drop the muted suggestion entries from the sidebar and keep **one** labelled entry
point. Move the recommendation to where plugins are actually chosen: a "Recommended" filter on
the plugins list page. That puts the suggestion in front of someone who has already decided to
look at plugins, instead of in front of everyone, permanently.
**Do this with UX-23 and UX-43** — all three shrink the same sidebar, and UX-43 wants
uninstalled plugins findable from where the need arises rather than from a permanent nag.
**Surface:** −N sidebar entries, −1 device-local preference, +1 list filter. **Build:** S–M.
**Owner:** web-agent.

### UX-66 — A paid trial is recorded as a trial, with no trace that money changed hands
`confuses` · weekly · traced · M4×M5 · *added 2026-08-17, from manual exploration*

**Now.** `Activity.trialPriceAmount` lets a gated class charge a newcomer for their first class
over the drop-in checkout, enforced once per person via `Contact.trial_used_at`. But the
acquisition axis records only that a trial was booked or attended — **nothing distinguishes a
paid trial from a free one**. A manager reading the contact sees a stage that implies no money
moved. The payment exists, on a different surface, and the two are never joined.

**Cost.** Conversion reporting treats a paying newcomer and a free-trial newcomer as the same
person, so the question a studio most wants to answer about paid trials — do they convert
better? — cannot be answered from the product that introduced them.
**Fix.** Stamp the trial's paid-ness where the stage is written (the same point that sets
`trial_used_at`), surface it as a chip beside the acquisition stage, and expose it as a
`ContactFilter` dimension rather than a one-off badge — same reasoning as UX-62, and it then
becomes a segment and an automation condition for free.
**Build:** S–M. **Owner:** functions-agent, then web-agent.

### UX-67 — Places is a scheduling concept filed under Settings
`confuses` · at-setup · traced · M7×M3 · *added 2026-08-17, from manual exploration*

**Now.** `{ id: 'places', href: '/settings/places', group: 'scheduling' }`
(`lib/settings-nav.ts:48`) — the entry's **own group name says `scheduling`**, yet it sits in
the settings rail while every other thing a studio schedules against (activities, plans,
pricing) lives under Offer. A place is not a preference; it is part of the offer.
**Fix.** Move it to the Offer section. Same class as UX-61 and UX-28 — an item filed by
implementation history rather than by the job it belongs to — so do them in one IA pass.
**Build:** S. **Owner:** web-agent.

### UX-73 — The org billing page repeats every problem UX-5 just fixed, one floor up
`slows` · weekly · traced · M10×M6 · *added 2026-08-17, found while fixing UX-5*

**Now.** `org/[orgId]/billing/page.tsx:170-209` calls the same four SaaS-billing callables
that `settings/billing` did. It is not silent — which is why the review's count missed it — but
it reports through a hand-rolled `setTimeout` banner (`:140-145`) that prints the **raw English
server message** to French, German and Italian owners; and after a successful cancel or
reactivate it invalidates nothing, so the badge does not move until a reload.

**Cost.** Lower than UX-5's, because something does appear — but an org owner cancelling a
subscription gets an English sentence and a page that still says "active".

**Fix.** Adopt `hooks/useSaasBilling.ts`, which now owns these four with code-matched reasons,
translated copy, invalidation and a success toast. This is the obvious next adopter and the
reason that file exists rather than four local handlers.
**Surface:** −1 hand-rolled banner, −4 inline callables. **Build:** S. **Owner:** web-agent.
**Verify:** In German, cancel an org subscription whose Stripe id is missing — the message is
German and the badge is correct without a reload.

### UX-75 — An org admin cannot cancel, reactivate or pay for her own organisation
`blocks` · weekly · traced · M10×M6 · *found 2026-08-17 while fixing UX-73* · **functions, not web**
**✅ Fixed** 2026-08-17 — the org got its own four callables (`cancelOrgSubscription`,
`reactivateOrgSubscription`, `getOrgBillingPortalUrl`, `getOrgInvoices`, in `orgs/billing.ts`),
guarded by the existing `assertOrgAdmin` against `organizations/{orgId}/org_members/{uid}`. The
Stripe work moved to `saas-billing/actions.ts` with **no authorization in it**, so both rails
share one implementation and "cancel" cannot come to mean two things. `firestore.rules` needed
no change — it had already named the parameter `entityId` and enumerated both authorization
models for `saas_subscriptions/{entityId}`, which is what settled the design question. A fourth
callable was in scope that the finding missed: `getSaasInvoices` refused the same way, and
because the refusal landed in a `useQuery` with no error surface the org page rendered
**"No invoices yet"** — a wrong answer with no tell. **Deploy order:** these are four NEW
function names; they must ship before the web change reaches an environment.

**Now.** `cancelSaasSubscription`, `reactivateSaasSubscription` and `getBillingPortalUrl` all
guard with `assertOwner(uid, teamId)` (`packages/functions/src/saas-billing/index.ts:427`,
`:466`, `:510`), which is `hasTeamRole(uid, teamId, 'owner')` — a read of
`teams/{teamId}/team_members/{uid}` (`:44-47`).

**An org id is not a team id, and an org's members are not team members.** They live at
`organizations/{orgId}/org_members/{uid}` (`ORG_MEMBERS_SUBCOLLECTION`,
`packages/shared/src/paths.ts:49`). So an org admin calling any of the three is refused
`permission-denied` — she cannot cancel her organisation's subscription, reactivate it, or open
its billing portal to change a card.

**Why nobody noticed.** Before UX-73 the org billing page rendered every outcome through one
hand-rolled banner styled green, so a refusal reading *"Owner access required"* appeared as a
**success**. UX-73 made it an honest red, translated refusal — which is what surfaced the real
gap underneath. The copy was never the bug; it was hiding one.

**Cost.** An organisation on a paid plan cannot stop paying, cannot restart after cancelling,
and cannot fix an expiring card, from inside the product. That is `blocks`, and the money
direction is the wrong one: the studio keeps being charged.

**Fix.** A decision, not a patch — say which and write it down:
1. **Widen the guard** — an `assertOrgAdminOrTeamOwner` that accepts an org admin when the id
   is an organisation. Cheapest, but it makes one callable serve two authorization models, and
   the three call sites take `data.teamId` while meaning "the thing being billed".
2. **Give orgs their own three callables**, beside the `createOrgCheckoutSession` that already
   exists — which is itself the evidence that org billing was always going to need its own
   surface. More code, one model each.

Recommend (2), because `createOrgCheckoutSession` already exists for exactly this reason and
the asymmetry is the smell. Whichever ships, the parameter should stop being called `teamId`
where it may hold an org id.
**Surface:** +3 callables, or +1 shared guard. **Build:** M. **Owner:** functions-agent.
**Verify:** As an org admin who owns no team, cancel the organisation's subscription. It
cancels, and the badge says so.

### UX-76 — A paid drop-in confirms nothing, and its buyer is never told the Space exists
`costs-money` · every-session · **counted + traced** · C2×C4 · *added 2026-08-17, Franco's observation*

**Now — two halves of one silence.**

**The email.** `packages/functions/src/booking/index.ts` makes **six** `sendEmail` calls: the free
booking path confirms itself. The Connect webhook contains **exactly one**, at `:1685`, and it
belongs to the **gift-card** handler. `handleDropInCheckout` (`:1723`) flips the pending hold to
confirmed, counts the seat, stamps the payment and logs it — and **sends nothing.** So the one
booking a visitor *paid for* is the one that never confirms itself, while the free one does.
Whatever Stripe's own receipt says, it names a charge, not a class: no what, no when, no where,
no cancellation terms, no way to change it.

**The route.** Franco's report was that a lead who books cannot get into the Space to see what
they bought. Checked, and the auth is **not** the problem: `sendContactVerificationCode` gates
only on email, team existence and a rate limit; `loginContactWithCode` matches primary `email`
or `login_emails` and filters only archived/deleted — **no joined, affiliation or subscription
gate anywhere**; both sides `toLowerCase().trim()`, so case cannot desync; and the Space
surfaces carry no membership gate either (Space is a base surface, always live). A lead *can*
sign in.

What a lead cannot do is **find out that they can.** The drop-in returns to the generic result
page (`buildResultUrls`, `booking/dropIn.ts:1073-1074`, `seg=booking`), and per UX-C2-5 the
manage-booking link exists **solely in the email** — which for this path does not exist. So the
buyer leaves with no email, no Space invitation and no manage link. "Cannot log in" is the
symptom of never being invited.

**Cost.** Someone paid, and the product's entire post-purchase communication is a Stripe
receipt. They cannot see the class they bought, cannot cancel it, and cannot find the portal
built for exactly this. It also lands hardest on the acquisition path a studio most wants to
work: a newcomer's first paid contact with the business.

**Fix.**
1. **`handleDropInCheckout` sends the booking confirmation** — the same one `bookSession`
   already builds (`booking/templates.ts`), not a second template. Both paths end in a
   confirmed booking on a session; only the tender differs, so the confirmation should not.
   Note UX-C2-5 while you are there: class bookings attach no `.ics` at all (the only
   `text/calendar` in the whole functions package is `appointments/templates.ts:178`), so
   adding it here fixes the paid path and the free one together.

   **But it must NOT inherit the `booking_confirmation` toggle** — see below. Reusing the
   template is right; reusing the gate is the bug.
2. **That email carries the Space link**, so the buyer learns the portal exists at the one
   moment they have a reason to use it. This is the cheapest possible fix for the review's
   standing complaint that Space has no discoverable entrance.
3. **The result page stops being generic** for this case: name the class and the time, and offer
   "see my bookings" rather than only a way back to the shop.
4. **Send it idempotently.** The webhook is redelivered, and `handleDropInCheckout` is already
   written to be idempotent — the mail must join that, via the `mail_sends` ledger, or a
   redelivery mails the buyer twice.

**A receipt for money is not a preference — make it always-on.** *(Franco's call, 2026-08-17,
and the codebase already argues it.)*

`booking_confirmation` is a **switch**: `settings.system_emails.booking_confirmation`, enforced
by `systemEmailEnabledFor` at six call sites (`utils/systemEmails.ts`). So simply routing the
paid drop-in through the existing send would let a studio turn off the receipt for something a
visitor **paid for** — which is worse than today's silence, because it would look deliberate.

The codebase already has the category this belongs in, and the test to qualify for it.
`booking/waitlist/notify.ts:118-130` puts two sends outside the toggle on purpose:

> *"always on, because switching it off does not quieten the feature, it breaks it"* … *"a
> studio that switched the toggle off would be trapping people rather than quietening a mail."*

A paid drop-in receipt passes that test exactly. Without it there is no email, therefore no
manage-booking link and no Space invitation — the buyer is not spared a courtesy, they are
stranded. So:

- **Add a new always-on system email for a paid booking's confirmation/receipt.** Not behind
  `SystemEmailKey`, with the reasoning in the header, in the same voice as the waitlist ones.
- **List it in Settings → Emails with the `alwaysOn` badge**, beside the sign-in codes and form
  receipts (`SystemEmailsCard.tsx:262-280`). That panel's virtue, per this review's What's good,
  is that it shows the mail a studio *cannot* switch off rather than hiding it — a receipt they
  cannot disable should be visible for the same reason.
- **Keep the free-path `booking_confirmation` toggle as it is.** A studio may legitimately run
  its own confirmation from the automations engine for free bookings; that is a courtesy. The
  asymmetry — free is switchable, paid is not — **is the design**, and it should say so in the
  code so nobody later "tidies" the two into one flag.

**One more candidate, worth deciding not assuming:** `session_cancellation` is also switchable.
For a *paid* booking it arguably fails the same test — switching it off leaves someone who paid
turning up to a class that is not happening. Apply the waitlist test to it and say which way it
falls, rather than leaving it inconsistent with whatever you decide here.

**Check the sibling rails while you are in there.** If the drop-in branch never sent mail, the
other paid branches deserve the same question — course purchase, product, priced appointment,
waitlist claim. Report which of them confirm themselves and which do not, rather than fixing
one and leaving a set. Any of them that take money and confirm nothing belong in the always-on
category by the same argument.

**Surface:** +1 send in the webhook (reusing an existing template), +1 link, ±0 routes.
**Build:** M. **Owner:** functions-agent, then web-agent for the result page.
**Verify:** Buy a drop-in as a brand-new visitor. An email arrives naming the class, its time
and how to cancel, with a working way into the Space; signing in there shows the booking.

### UX-77 — Three more paid rails confirm nothing, and a fourth confirms behind a switch
`costs-money` · weekly · **counted** · C2×C3×M6 · *from the sibling-rail audit UX-76 asked for*

**Now.** UX-76 asked whoever fixed the drop-in to audit the other paid rails rather than fix one
branch and leave a set. The audit:

| Rail | Confirms itself? | Gate |
|---|---|---|
| Drop-in, Stripe · gift-card cover · paid waitlist claim | yes, as of UX-76 | none — always on |
| Gift card purchase | yes | none — always on |
| Free booking · free waitlist claim · free appointment | yes | `booking_confirmation`, correctly |
| **Priced appointment** | yes — but behind `booking_confirmation` | **wrong gate** |
| **Course purchase** | **no** | — |
| **Product purchase** | **no** | — |
| **Membership / credit pack** | **no** | — |
| Policy fee | no, defensibly | — the fee was itself requested by email, and paying it grants nothing |

**Cost, in order of how much money is involved.** The **credit pack** is the worst: someone buys
ten classes and is never told they hold ten, or how to spend them — the balance exists only
inside a portal they were not told about. A **course** buyer is not told where to watch it. A
**product** buyer gets no fulfilment or pickup information, because none exists anywhere. And the
**priced appointment** does send, but a studio can switch that receipt off — the exact defect
UX-76 refused to introduce, already present one rail over.

**Fix.** The same rule: a receipt for money is not a preference. But **each needs its own
template**, which is why this is a separate build and not a rider on UX-76 — a course has no
time or location, a product may need pickup terms, a credit pack needs the resulting balance.
Reuse `booking/paidConfirmation.ts`'s posture and its `mail_sends` keying, not its body.

**The priced appointment is the cheapest and should go first**: it already sends, so it only
needs its gate split by tender. Note the cost that stopped it shipping with UX-76 —
`sendAppointmentBookingEmails` has to learn whether the booking was paid, a signature change
across three call sites. `bookingWasPaidFor` (`packages/shared/src/types/session.ts:188`) is
the predicate to use; do not add a second one.
**Build:** M for the appointment gate, M per template after. **Owner:** functions-agent.
**Verify:** Buy a 10-credit pack as a new visitor — the mail says how many credits you hold and
where to use them. Then switch every system-email toggle off and buy a priced appointment: it
still confirms.

### UX-79 — A studio sells a product and the product knows nothing about handing it over
`slows` · weekly · traced · C3×M5 · *found while writing UX-77's product receipt*

**Now.** `Product` (`packages/shared/src/types/product.ts`) carries **no delivery, pickup or
collection field** — "the studio fulfils manually" is a comment in the type, not a value anyone
can read — and `startOneOffCheckout` collects no shipping address. So no receipt can say when or
where, and the one UX-77 shipped says only what is true: the studio arranges handover directly,
here is their address to ask.

**Cost.** Someone pays for a thing and the product cannot tell them how to get it. The studio
then fields the same question by email every time, which is the work they bought software to
stop doing.

**Fix.** A free-text **collection terms** block — per product, falling back to a team default —
rendered into the receipt and onto the shop card before purchase, so it sets the expectation
rather than answering it afterwards. Free text rather than structured fulfilment: a studio
handing over a gi at the front desk and one posting a water bottle need the same field to say
different things, and a shipping model nobody asked for is the heavier mistake.
**Surface:** +1 optional field, +1 team default, ±0 routes. **Build:** S–M. **Owner:** web-agent.
**Verify:** Buy a product; the confirmation says how to collect it, and the shop card said so
before you paid.

### UX-80 — Everything sold at the desk still confirms nothing
`costs-money` · weekly · **counted** · M6×C4 · *from UX-77's closing audit*

**Now.** UX-76 and UX-77 made every **online** paid rail confirm itself. Every **manual and
offline** rail still sends nothing: `recordManualPayment` (a cash membership, credit pack or
course recorded at the desk), `updatePayment`'s assign and relink, the BYO gateway webhooks,
and the `grantCredits` callable. Each runs `applyPaymentEffects`; none contains a `sendEmail`.

So a desk-sold 10-pack tells the buyer nothing — the same silence UX-77 just closed for the web
purchase of the identical thing.

**Why it was left out of UX-77, and why it needs its own decision.** Two reasons, both real.
The money changed hands **in front of a person**, so the studio has already said something —
that is a different silence from a web checkout, and it may warrant different copy rather than
the same receipt. And `applyPaymentEffects` is deliberately re-run on **every manager edit**, so
a send placed inside it would mail the member again on each re-save. The send therefore belongs
at the **callables**, one decision per rail, not in the shared effects function.

**Fix.** Decide per rail whether the studio wants the platform to confirm what it just sold by
hand — a "send the buyer a receipt" checkbox on `RecordPaymentDialog`, defaulting on for a rail
that grants something (a pack, a course) and off for a bare payment record, is the shape I would
start from. Then reuse `connect/purchaseReceipts.ts` rather than writing a fifth template.
**Build:** M. **Owner:** functions-agent + web-agent.
**Verify:** Record a cash 10-pack against a contact; they learn they hold ten credits.

### UX-81 — Every email's plain-text half runs its headings into the following sentence
`confuses` · every-session · traced · C2×M9 · *found while writing UX-77's templates*
**✅ Fixed** 2026-08-17 — `htmlToPlainText` in `packages/shared/src/emailLayout.ts`, beside the
chrome that built the HTML; both call sites (`utils/email.ts`, `utils/outreachEmail.ts` — the
same two-line regex, twice) delegate. The finding named one defect and there were **three**: the
weld, the whole mail arriving as a single paragraph, and entities never decoded — so
`&amp;middot;` and everything `escapeHtml` produced went out raw, and a CTA arrived as a label
with no link. Source whitespace is flattened *first*, so every newline in the output is one the
function chose; boundaries are paragraph-level (blank line) or line-level (single newline), which
is why a `<br>` inside a box breaks one line while the box's title takes two. Entities are
decoded **last**, after every tag is gone, so a decoded `&amp;lt;b&amp;gt;` cannot become markup.
No existing test pinned the old output, so nothing encoded the bug.

**Now.** `buildEmailTemplate`'s plain-text arm strips tags without inserting separators, so a
titled block renders as `Cosa succede oraStudio organizza…` — the heading welded to the sentence
after it. Every existing template with a titled box has it: the "Important" blocks, the
cancellation-policy box, and now the purchase receipts.

**Cost.** Small per message and universal: it is every email the platform sends, as seen by any
client that shows the text part — which includes most notification previews. It reads as
sloppiness in the one artefact a studio's members judge them by, and the studio cannot fix it.

**Fix.** Insert a newline at block boundaries when flattening to text. One change in shared
layout code, which is why UX-77 deliberately did not make it mid-feature — it touches every
mail the platform sends and wants its own verification, not a rider on a receipt.
**Build:** S. **Owner:** functions-agent.
**Verify:** Send any mail with a titled box and read the `text/plain` part.

### UX-82 — A member can buy a plan and still be locked out, with no self-serve way back
`blocks` · weekly · traced · M5×M8 · *found 2026-08-17 while fixing UX-11* · **functions**

**Now.** Booking gates on `acquisition_stage === 'joined'` (`access.ts:263`, strictly). Two
things never set it:

1. **Buying in the public shop.** The Connect webhook creates the buyer's contact *off-funnel*,
   with **no `acquisition_stage` at all** (`connect/webhook.ts:385`) — deliberate, so a shop
   purchase does not fake a signup.
2. **Signing up afterwards.** `completeSignup` has three branches, and only the **create**
   branch (`:263`, no existing contact) writes `joined`. The finalize-existing branch (`:280`)
   and the session branch (`:241`) write profile fields only, on purpose: *"never overwrite the
   birth facts (acquisition_stage/entry/converted_at) it holds."*

So under `checkout_contact_mode: 'minimal'`, a person buys a subscription, is matched by
team+email when they later use the public signup form, receives the welcome mail — and comes out
**still not joined**. Every members-tier class refuses them with `not_joined`. Their only exits
are a staff member setting the stage by hand or an automation `update_field` action; there is no
self-serve route at all.

**Cost.** They have paid. It is the single worst moment to be refused, and the refusal names a
condition the payer cannot act on. UX-11 removed the copy that pointed these people at the shop
— which was a false promise, since buying grants no `joined` — so the dead end is now honest but
still dead.

**Fix.** In the finalize branch, promote when the contact carries **no** stage at all. That
preserves the rule the comment is protecting (never overwrite a birth fact the contact *holds*)
while fixing the case where there is nothing to overwrite. Check the session branch for the same
shape. **Build:** S. **Owner:** functions-agent.
**Verify:** Buy a subscription in the shop under `minimal` mode, then complete the public signup
form with that email, then book a members-only class.

---

### UX-101 — A gated class whose plans are not public shows no gate at all
`costs-money` · every-session · traced · M5×M7 · *found 2026-08-18 while fixing UX-94*

**Now.** `resolveActivityPricingDisplay` builds its `includedWith` rows by resolving each id in
`accessRule.subscriptionTypeIds` against the **public** plan list
(`aggregator_subscription_types`). Ids it cannot resolve are dropped. So a `subscription`-gated
class whose plans are not public renders **no gate line whatever** — not "Members only", not
"Included with…", nothing. The card looks open.

This predates UX-94 and is unaffected by its display modes: it is broken under `list` too.
`members` and `open` tiers are unaffected — they need no lookup.

**Cost.** It is the same failure UX-11 fixed from the other side, and the same one UX-94 was
careful to avoid: **hiding a price must never hide a gate.** A visitor clicks Book on what
appears to be an open class and meets a refusal. Filtering plans out of the public list is a
normal thing for a studio to do — a legacy plan it no longer sells still gates its classes.

**Fix.** When every id resolves to nothing, fall back to the generic gate sentence rather than
silence — the class still requires a membership, and that is true without naming which. The
`members`-tier wording shipped by UX-11 ("Members only — signing up is free") is close but not
identical: this tier does require a plan, so it needs its own line. **Build:** S.
**Owner:** web-agent.
**Verify:** gate a class on a plan, set that plan `public: false`, open the public card.

---

### UX-100 — Four more unpublish buttons, still unconfirmed
`slows` · weekly · traced · M7×M11 · *found 2026-08-18 while fixing UX-50*

**Now.** UX-50 put a confirmation on `/plugins/website`'s unpublish. The same act — take a
public page off the internet in one click — is still unconfirmed on:

- `documents/[documentId]` — has an explanatory hint but no confirm, **and** it flips
  `active_public_surfaces.documents`, so this is the one that can also strip bio-link entries
  (UX-49's mechanism, from the writing side).
- `offer/online-courses/[courseId]`
- `plugins/custom-forms/[formId]`
- `org/[orgId]/website/page.tsx` — identical to the one UX-50 fixed, in the org tier.

**Cost.** Small per instance, and the pattern is the point: a studio learns from the confirmed
one that this app asks before taking something public down, then meets three that do not.

**Fix.** The same `AlertDialog` treatment, with the honest framing UX-50 established — these are
reversible and lossless, so the copy must say so rather than implying destruction; an overstated
warning trains people to click through. The org website page needs its own copy keys
(`OrgWebsite` namespace) or to reuse the `Website` ones — it does not currently import them.
**Build:** S. **Owner:** web-agent.
**Verify:** unpublish a document; confirm the bio-link entry for Documents stops being offered.

---

### UX-98 — A person's name is a dead end on four more lists
`slows` · every-session · traced · M2×M3 · *found 2026-08-18 while fixing UX-91*

**Now.** UX-63 linked contact names on `/bookings`; UX-91 did the session rosters and the
calendar peek. The same rows elsewhere still render a name as plain text while holding the
contact id. **Trivially the same fix, ids already in hand:**

- `affiliations/page.tsx` — both tables (the status-editing roster and the summary). The row
  cannot be wrapped in a link because it contains an inline status `Select`, so linking the
  **name** is precisely the right shape here.
- `events/[id]/page.tsx` — Attendees and Invitations.
- `plugins/referrals/page.tsx` — referrer and referred, both ids present.
- `gamification/page.tsx` — the leaderboard. Caveat: trial contacts are deliberately rendered as
  initials, so only named rows may link.

**Has a reason NOT to link, recorded so nobody "fixes" it:**

- `org/[orgId]/events/[id]/page.tsx` and `org/[orgId]/affiliations/page.tsx` — the person belongs
  to a MEMBER TEAM, not the org tenant, and `/contacts/{id}` resolves in the current team
  context. Linking would send an org admin to a record they cannot read. Needs a team-scoped
  route first.
- `components/events/CheckinPanel.tsx` — same cross-tenant hazard; the code already branches on
  `checkin.teamId !== currentTeamId`, and the row is a button that opens the check-in editor.
- `components/payments/OutstandingFeesCard.tsx` — **cannot** link: the fee row carries
  `contactName` and no id. A data gap, not a judgement call.
- Selection controls (the contact-groups add dialog, CheckinPanel's picker) where clicking
  selects, and the public Space/booking surfaces, which render the member's own name.

**Half-linked, worth finishing:** `plugins/contact-groups/page.tsx` reaches `/contacts/{id}` via
`router.push` on a `<button>` — no href, so no middle-click, no open-in-new-tab, no hover preview.

**Fix.** Link the four; leave the rest with the reasons above. **Build:** S. **Owner:** web-agent.

---

### UX-99 — Three more "create one first" dead ends
`slows` · at-setup · traced · M5 · *found 2026-08-18 while fixing UX-92*

**Now.** UX-92 fixed the session and appointment pickers. The same shape survives in three more
places — prose names the destination and nothing goes there:

- `offer/activities/page.tsx` — access tier "Subscription" with no subscription types:
  *"No subscription types yet — create them under Plans & Affiliations."*
- `components/pricing/BenefitEditor.tsx` — the same sentence (`Benefit.noSubs`), and this one is
  reached **from** the appointment activity form, so a studio can hit it two steps inside the
  flow UX-92 just repaired.
- `components/subscriptions/SubscriptionTypesManager.tsx` — *"No activities yet — create them
  under Offer → Activities."* The exact mirror, pointing the other way.

**No gap:** "New event" — event types always include built-ins, so its picker is never empty.

**Adjacent, same file family:** `team/bio-link/page.tsx` uses a raw `<a href="../settings">` for
its "Go to Settings" escape — a relative href that bypasses `@/i18n/navigation` and resolves
wrongly under a locale prefix.

**Fix.** Link each destination. **Build:** S. **Owner:** web-agent.
**Verify:** as a studio with no subscription types, set an activity to the Subscription tier.

---

### UX-97 — Nine emailed links still drop the locale
`confuses` · weekly · traced · C2×M9 · *found 2026-08-18 while fixing UX-32*

**Now.** UX-32 fixed the booking→cancel chain and added localized URL builders to
`packages/shared/src/publicRoutes.ts`. Nine call sites still use the unprefixed
`publicUrl(getHostingUrl(), ...)`, so the mail is localised into `Team.language` and the page
it opens answers in English — `localePrefix: 'as-needed'` falls through to cookie →
Accept-Language → `en`, and public surfaces never write that cookie.

The remaining sites, by file: **`booking/waitlist/notify.ts`** (three), **`sessions/index.ts`**
(two), **`waivers/request.ts`**, **`referrals/index.ts`**, **`connect/webhook.ts`**,
**`connect/purchaseReceipts.ts`**. The last two were reserved by a parallel lane at the time and
are the sharper pair: `webhook.ts` builds an `appointments/cancel` link — the same defect UX-32
just fixed one file over.

`grep -rn "publicUrl(getHostingUrl()" packages/functions/src` finds them all, which is the
census to work from rather than this list.

**Cost.** Small each, universal in aggregate, and it lands on the two mails a member is most
likely to act on — a waitlist offer with a deadline, and a purchase receipt.

**Fix.** Swap each for `localizedPublicUrl` / `localizedPublicSubUrl` with the recipient's
language, exactly as the booking chain now does. The default locale stays unprefixed, so an
English link is byte-identical and no existing URL breaks — pinned by a test.
**Build:** S. **Owner:** functions-agent.
**Verify:** set a team to German, trigger a waitlist offer, open the link.

---

### UX-88 — After paying, the buyer lands on a page that asks them to sign in again
`blocks` · every-session · **reported by Franco 2026-08-18**

**Now.** A newcomer completes a booking and a payment, and the success/redirect page asks them to
sign in before showing what they just bought. But the payment already identified them — checkout
collected their email and the webhook has just linked or created their contact.

**Cost.** It is the worst moment in the product to demand a credential: the person has paid, is
holding a receipt, and is being treated as a stranger. It also lands immediately after
`checkout_contact_mode` deliberately kept the flow short — the friction saved at the door is
handed straight back.

**Fix.** Mint the contact session on the success path from the completed checkout, so the redirect
arrives signed in. One constraint that rules out the quick version: the session claims
(`contactId`, `teamId`, `sessionExpires`) are what Firestore and Storage rules check, so this must
go through the same `buildContactSession` the passwordless login uses — never a client-side
shortcut. Check the interaction with UX-82/83: a shop buyer's contact may exist with no
`acquisition_stage`, so signing them in is not the same as their being joined.
**Build:** M. **Owner:** functions + web.
**Verify:** book and pay a drop-in as a brand-new person; the success page shows the booking.

---

### UX-89 — A confirmed newcomer booking is not tracked
`confuses` · every-session · **reported by Franco 2026-08-18** · relates to UX-18, UX-78

**Now.** A newcomer books, the booking is confirmed, and the contact detail still shows **0
sessions attended**. Establish *which* counter is meant before changing anything: attendance is
normally a check-in fact, not a booking fact, so "0 attended" may be literally correct and the
missing number may be "1 booked". Both readings are defects — either the counter is not written,
or the page shows a number that cannot answer the question the studio is asking it.

**Cost.** The contact record is where a studio decides who to chase. A zero that should be one is
indistinguishable from a person who has genuinely never come.

**Fix.** Trace `bookSession` → the contact counters → the detail page. UX-18 already found that
confirming a booking writes different data depending on which page is used, and UX-78 found a
counter living inside a notification loop; this is likely the same family, and the fix should not
add a third writer. **Build:** M. **Owner:** functions-agent.
**Verify:** book a newcomer into a class, confirm it, open their record.

---

### UX-90 — Sidebar search finds pages, not the things a studio looks up
`slows` · every-session · **reported by Franco 2026-08-18**

**Now.** The sidebar search returns navigation destinations only. It cannot find a **contact**, a
**subscription type** or an **activity** — the three things a studio looks up by name all day.
Settings destinations are also listed as ordinary pages rather than grouped as settings.

**Fix.** Extend the index to contacts, subscription types and activities, grouped by kind, and
label settings destinations as settings. Contacts are the volume case: reuse the existing list
query and its `(lastname, firstname)` ordering rather than introducing a second contact query
(see the index/query note in CLAUDE.md — a contacts query without that ordering works in the
emulator and fails on a real project). **Build:** M. **Owner:** web-agent.

---

### UX-91 — Session detail: the primary action does not look primary
`slows` · every-session · **reported by Franco 2026-08-18** · relates to UX-63

**Now.** Three things on the session detail page. **"Add contact"** is not styled as the primary
action although it is the page's main job. The **link-sharing** control takes more room than it
earns and belongs as an icon button at the bottom-right of the heading. And **contact names in
the roster do not link** to their records — the same defect UX-63 fixed on the bookings list,
surviving one page over.

**Fix.** Promote "Add contact" to primary, demote sharing to an icon button, link the names.
**Build:** S. **Owner:** web-agent.

---

### UX-92 — Schedule: an oversized control, and no route to "new activity"
`slows` · every-session · **reported by Franco 2026-08-18** · relates to UX-27

**Now.** The bookable-hours control is larger than the components beside it, breaking the row's
rhythm. And **New class / New appointment** offers no path to *create an activity* — but a session
cannot exist without one, so a studio with no activities is stopped with no next step from the
place it is standing.

**Fix.** Normal-size the control; add a link to create an activity from the new-session surface.
This is UX-27's family — a step that cannot be completed from where it lands — so check whether
the same gap exists on any other "new X" surface while you are there. **Build:** S.
**Owner:** web-agent.

---

### UX-93 — Documents are listed twice, and publishing scrolls away
`slows` · weekly · **reported by Franco 2026-08-18** · relates to UX-74

**Now.** Documents appear as **two lists** — one for signup-consent selection, one general — for
what is one set of objects. And on a single document page the body can grow long, pushing **save
and publish** off-screen; they are not sticky.

**Fix.** Merge into one list, with signup-consent membership as a property of the row rather than
a second list. For the editor, apply UX-74's shipped pattern: `DialogBody` established the scroll
rule for dialogs, and this is its full-page equivalent — a sticky footer or side rail so the
publish controls never leave the viewport. Care: publishing a document mints an immutable version
(`publishDocumentVersion`), so the control must stay unambiguous when it becomes always-visible —
easier to reach must not mean easier to hit by accident. **Build:** M. **Owner:** web-agent.

---

### UX-94 — The website's activity cards cannot control how pricing is shown
`slows` · weekly · **reported by Franco 2026-08-18** · relates to UX-11

**Now.** `ActivitiesBlock` renders pricing lines with no per-site control. A studio may want them
hidden, listed, or reduced to an icon with a tooltip.

**Fix.** A display option on the block: hide / list / icon + tooltip. Note UX-11 has just made
these lines meaningful for the default access tier, so this now controls something that says
something. **Keep the honest-copy rule:** hiding a *price* must not hide a *gate* — "Members only"
is not pricing, and a card that silently drops it invites a click that ends in a refusal.
**Build:** M. **Owner:** web-agent.

---

### UX-95 — The website has no pricing table
`slows` · weekly · **reported by Franco 2026-08-18**

**Now.** The pricing block lists plans as cards only. The comparison a prospect actually makes —
**which activities does each plan include** — has no layout: activities as rows, plans as columns.

**Fix.** A table style for the pricing block. The data already exists: each activity's `accessRule`
plus the public subscription types, which is exactly what `resolveActivityPricingDisplay` resolves
— so this is a rendering variant, not new data. Mind the `members` tier: it means *any* membership,
so its row is ticked under every plan, and rendering it blank (or inventing a plan list for it)
would be wrong. Wide tables must scroll inside their own container, not the page.
**Build:** M. **Owner:** web-agent.

---

### UX-96 — Contact notes cannot be colour-tagged
`slows` · weekly · **reported by Franco 2026-08-18**

**Now.** Notes on a contact are visually uniform. A studio triaging a record wants the grouping a
few predefined colours give — post-it style.

**Fix.** A small fixed palette, not a colour picker. **Store the NAME of the colour, never a hex
value:** a pastel chosen against a white card is unreadable on a dark one, and a stored hex cannot
be re-themed. The token then resolves per theme, which is the same rule the artifact/theming
guidance elsewhere in this app already follows. **Build:** S. **Owner:** web-agent.

---

### UX-85 — Ten automation triggers offer a delay that is silently ignored
`costs-money` · weekly · traced · M9 · *found 2026-08-18 while fixing UX-84*

**Now.** `TRIGGER_OPTIONS` marks eleven triggers `supportsDelay: true`, so the editor renders a
delay field and stores `trigger.delayMinutes`. **Exactly one of them honours it.**
`enqueueDelayedRule` (`utils/automationEngine.ts:1542`) has ONE caller — `onSessionWrite.ts:78`,
the `session_ended` path — and `fireEventRules` never reads `delayMinutes` at all; it runs the
rule inline. The ten that store a delay nothing reads:

`contact_created`, `booking_confirmed`, `booking_no_show`, `booking_cancelled`,
`subscription_added`, `subscription_removed`, `subscription_changed`, `affiliation_added`,
`affiliation_removed`, `affiliation_changed`.

**Cost.** A studio composes "three days after the booking, ask how it went" and the mail leaves
**immediately** — while the member is still in the room, or before the class has happened. The
rule looks correct in the editor forever, because the number it typed is stored faithfully. This
is the exact shape of UX-13 and UX-84 (built, never wired) but worse: those were capabilities
nobody could reach, this one is reachable, configured, and wrong.

**Fix — two options, and they are not equivalent.** Either route event rules through the Cloud
Tasks path `session_ended` already uses (real feature, needs a queue handler per trigger and a
decision about what a delayed rule does if the contact changes meanwhile), or set
`supportsDelay: false` on the ten and hide the field (honest, immediate, and needs a data
question answered first: **existing rules already carry a `delayMinutes` a studio believes in**).
Note `acquisition_stage_changed` was mounted with `supportsDelay: false` for exactly this
reason, so the honest option has a precedent in the file. **Build:** S (honest) / L (real).
**Owner:** web + functions. **PARKED — needs a product decision.**
**Verify:** create a rule on `booking_confirmed` with a 3-day delay, book, watch the mail arrive.

---

### UX-86 — A library automation gated to a paid plan installs on any plan
`costs-money` · once · traced · M9×M8 · *found 2026-08-18 while fixing UX-84*

**Now.** `LibraryItem.requires_plan` is declared on every library item and **read by nothing** —
`LibraryDialog` filters on category and free-text search only. So a Free or Coach team can open
the library and install an item marked `requires_plan: 'studio'`.

**Cost.** Plan gating that is declared and unenforced is worse than no gating: the field reads as
a guarantee to everyone maintaining the catalogue, so items get marked and nobody checks. Same
class as UX-13/UX-84/UX-85 — built, never wired — and this one gives away paid features.

**Fix.** Read the field: filter or lock library items above the team's plan, with the upgrade
path the app already uses elsewhere. **Build:** S. **Owner:** web-agent.
**Verify:** as a Free team, open the automation library and try to install a studio-tier item.

---

### UX-87 — Declared triggers that can never fire, and mounted ones that never do
`confuses` · at-setup · traced · M9 · *found 2026-08-18 while fixing UX-84*

**Now.** Two directions of the same rot, both verified against the `fireEventRules` call-site
census (`inboundWebhook.ts:139`, `onBookingWrite.ts:82`, `onContactWrite.ts:136`,
`onSessionWrite.ts:113`, `onAffiliationWrite.ts:124/129/135`, plus `runScheduledRules` and
`triggerAutomationRule`):

- **`contact_updated`** is declared in the trigger union (`automationEngine.ts:35`) and **fired by
  nothing**. It is correctly *not* mounted — mounting it would ship a trigger that never runs —
  so the dead union member is the thing to delete.
- **`plugin:referrals:referral_created` and `plugin:referrals:referral_rewarded`** are mounted
  dynamically from the installed manifest and **never fired**: `utils/referrals.ts` creates
  referrals without firing anything, and the plugin is `status: 'available'`, so a studio can
  install it, build a rule on it, and wait forever.
- **`plugin:whatsapp:message_received`** — same, but that plugin is `coming_soon`, so it is a
  smaller trap.

**Cost.** A rule that never fires is indistinguishable from a rule that has not matched yet.
There is no error, no log, nothing to notice. The referrals pair is the live one.

**Fix.** Fire the referral events from `utils/referrals.ts`, or unmount them until the plugin
fires them. Delete `contact_updated` from the union. **Build:** S. **Owner:** functions + web.
**Verify:** install referrals, build a rule on `referral_created`, create a referral.

---

### UX-84 — "When someone joins" cannot be built: the trigger exists but is unreachable
`blocks` · weekly · traced · M9 · *found 2026-08-17 while fixing UX-83*

**Now.** `acquisition_stage_changed` is a real trigger — `automationEngine.ts:39` declares it,
`onContactWrite.ts:72` fires it — but it is **absent from `TRIGGER_OPTIONS`**
(`apps/web/src/app/[locale]/(auth)/automations/page.tsx:184`), has no message key, and no system
or library rule ships with it. A studio cannot select it. This is the same class as UX-13's
`previewAutomationRule`: **built, never wired.**

So "welcome someone the moment they join" is expressible only two ways, and one of them is
broken:

- **`contact_created` + condition `acquisition_stage = joined`** — does **not** fire for a trial
  lead and cannot: `contact_created` fired at trial-booking time, when the stage was
  `trial_booked`, and it never re-evaluates. UX-83 did not change this and could not.
- **`schedule_daily` + condition `acquisition_stage = joined`** — the shape all seven system
  rules use. Works, one day late.

**Cost.** The welcome mail is the highest-intent message a studio ever sends, and the only
trigger that fires at the right instant is the one nobody can pick. Studios reach for
`contact_created`, which silently skips exactly the people who converted from a trial — the
population the welcome is most for.

**Fix.** Mount the trigger: add it to `TRIGGER_OPTIONS` with copy in four locales. Consider a
library rule ("welcome a new member") so the common case needs no assembly. **Build:** S.
**Owner:** web-agent. **Verify:** book a trial as a new person, complete signup, confirm a rule
on the mounted trigger fires once.

---

### UX-25 — A discount cannot be applied to a membership
`blocks` · at-setup · traced · M5 · **decided 2026-08-17: intro offer on the plan, first N periods**

**The exclusion was not an oversight.** CLAUDE.md states the promo rails deliberately omit
memberships, and the reason holds up: a promo is *"a Stage A MODIFIER inside
`resolvePaymentOptions`"*, and that resolver **returns one number**. A recurring discount is not
a number — it is a **schedule** (an amount *and* how many periods it survives). The single-amount
contract cannot express "CHF 1 now, CHF 79 from March". So there was never a missing branch.

**The trap.** `createMembershipCheckout` → `createSubscriptionCheckoutSession` builds the price
inline (`price_data.unit_amount` + `recurring`), with no `discounts` and no coupon — there is
**zero Stripe coupon usage anywhere in the codebase**. So lowering `unit_amount` "works" first
try and is wrong: that becomes the **recurring** price, the member pays the discount forever, and
nothing records why they are on a different price from the plan.

**Decided shape: an intro offer owned by the PLAN, not by a code.** A field on
`SubscriptionType` — first *N* periods at a reduced (or zero) price, then full price. Reasons:

1. It is the standard acquisition lever for this market, and most of its value is being on the
   **public pricing card**. A promo code is invisible until checkout.
2. It stays clear of the promo redemption machinery, whose central rule is *"a use is consumed by
   a completed **sale**"*. On a recurring rail, which renewal is the sale? Reservations,
   per-person caps and the ownership rules all become ambiguous where they are currently precise.
3. **It must NOT be added to `resolvePaymentOptions`** — that would break the single-amount
   contract, which is the whole reason this is a separate feature rather than a fifth promo rail.

**Deferred, deliberately:** promo codes on memberships. Revisit only once the intro-offer
schedule concept exists and can be reused.

**Known Stripe constraint to design around:** a coupon's `duration: 'once'` applies to the first
invoice at any interval, but `duration: 'repeating'` is expressed in **`duration_in_months`** —
which cannot express "first N periods" for a weekly plan. Establish what Stripe actually supports
and constrain the editor accordingly; do not write a value Stripe will reject or silently
misapply. **Build:** M. **Owner:** functions-agent + web.
**Verify:** set a 3-month intro on a monthly plan, buy it in the shop, confirm the first invoice
is discounted, the fourth is full price, and the pricing card says so before purchase.

---

### UX-83 — A trial lead who signs up is still refused, and the card we just wrote promises otherwise
`blocks` · every-session · traced · M5×M8 · *found 2026-08-17 while fixing UX-82* · **needs a product decision**

**Now.** Booking a trial or a drop-in creates the contact at
`acquisition_stage: 'trial_booked'` — four writers: `appointments/booking.ts:343`,
`booking/dropIn.ts:474` and `:588`, `booking/index.ts:1109`. UX-82 promotes a contact who holds
**no** stage; one who holds `trial_booked` is deliberately left alone, because advancing it is a
change to funnel semantics rather than a gap-fill.

The consequence is that **the most ordinary path in the product is broken**: try a class, decide
to join, complete the signup form — and stay `trial_booked`, refused by every members-tier class
forever, until a staff member edits the stage by hand. This is far more common than UX-82's
shop-buyer case.

And it now **contradicts copy we shipped**. UX-11 put *"Members only — signing up is free"* on
the public card, pointing at the signup form. For a trial lead that sentence is false: they sign
up, free, and are still refused. We replaced a wrong price with a wrong promise.

**Fix — three options, and this is a product decision, not a code one:**

1. **Signup always promotes to `joined`.** The signup form IS the declaration of joining; the
   trial stages exist to track leads who have *not* signed up. This also makes the funnel more
   accurate rather than less: `trial_booked → joined` is precisely a trial conversion, and
   `analytics/index.ts:307` counts a stage change with both sides present — so these would start
   being **counted as conversions**, which is what they are. Recommended.
2. **Change the gate**: `members` asks "is this a contact of this studio who completed signup"
   rather than "did they reach the joined milestone". Weakens a paid gate — needs care.
3. **Change the copy** to stop promising what signup delivers. Cheapest, and the worst of the
   three: it makes the product honest about a dead end instead of removing the dead end.

**Verify:** book a free trial as a new person, then complete the signup form with the same
email, then open a members-only class.

---

### UX-78 — A contact's pending-booking counter moves only if a mail is switched on
`confuses` · every-session · traced · M4×M3 · *found while fixing UX-76*

**Now.** In `cancelSingleSession`, `Contact.pending_bookings_count` is decremented **inside the
notification loop** — so a studio with `session_cancellation` switched off cancelled sessions
without anybody's counter moving. UX-76 made paid bookings notify regardless, so paid ones now
decrement and free ones still do not, which is an improvement and also an inconsistency.

**Cost.** `pending_bookings_count` is the number the contacts list uses to say "this person
needs chasing" (see UX-18, which found the same counter corrupted from the other direction). A
studio that turned off a courtesy email silently acquired a permanently wrong roster.

**Fix.** Decouple them: the counter is a fact about the booking, the mail is a message about it,
and a data write has no business living inside a delivery loop. Move the decrement out, next to
the cancellation write. **This touches contact counters, so it wants its own change** rather than
riding on a mail fix — which is exactly why it was left.
**Build:** S–M. **Owner:** functions-agent.
**Verify:** With `session_cancellation` off, cancel a session holding one free and one paid
pending booking. Both contacts' pending counts drop.

### UX-74 — In 13 dialogs the Save button scrolls away with the form
`slows` · every-session · counted · M5×M7×M9 · *added 2026-08-17, Franco's observation* · **one fix, in the primitive**

**Now.** `DialogContent` (`components/ui/dialog.tsx:42-60`) is a bare `grid` with no scroll
region of its own — no `max-h`, no `overflow`. So every dialog with a long form bolts the
constraint onto `DialogContent` itself via `className`, which makes the **whole popup** the
scroll container, footer included. Counted:

```
grep -rn "DialogContent" --include=*.tsx apps/web/src | grep -E "overflow-y-auto|overflow-auto"
→ 13
```

`offer/activities/page.tsx:615` · `components/subscriptions/SubscriptionTypesManager.tsx:319` ·
`offer/promo-codes/page.tsx:460` · `offer/products/page.tsx:357` · `automations/page.tsx:1466` ·
`automations/WebhookEndpointsDialog.tsx:143` · `settings/event-types/page.tsx:157` ·
`settings/team/page.tsx:893` · `components/appointments/AppointmentAvailability.tsx:453` ·
`components/appointments/AppointmentFormDialog.tsx:279` ·
`plugins/custom-fields/CustomFieldsTab.tsx:90` · `plugins/documents/VersionHistory.tsx:75` ·
`org/[orgId]/ranking/page.tsx:104`.

The two worst are the two this review already complains about for other reasons: the activity
dialog, which UX-40 counts at **23 fields**, and the promo dialog, where UX-24 found the
validation message parked 135 lines from the field it names — and noted that *"the dialog
scrolls, so on a short viewport the error and the field it names cannot be on screen together."*
That is this finding, seen from the side. A pinned footer is where a form-level error belongs,
so fixing this makes UX-24's remaining half nearly free.

**Cost.** The manager finishes a long form and has to scroll back down to commit it — and on a
short viewport she cannot see the primary action while touching the last field, which is
exactly when she wants to know it is there. `DialogFooter` is used by **52** files, so the
pattern is established; it simply is not pinned.

> **Corrections, 2026-08-17, from building it.** The 13 is exact and the member list is right,
> but two of its line numbers had drifted (`SubscriptionTypesManager.tsx` is `:457`,
> `automations/page.tsx` is `:1467`), and the `DialogFooter` figure above was 67 — the real
> count is 52. Separately, **four more dialogs had already hand-rolled the pinned layout**
> (`automations/LibraryDialog.tsx:321`, `settings/emails/TemplateEditor.tsx:291`,
> `components/sessions/SessionFormDialog.tsx:341`, `components/booking/BookingOverlay.tsx:140`).
> They are left alone deliberately — they already pin, and they are the evidence the primitive
> was missing rather than another instance of the defect.

**Fix — in the primitive, once.** Give `DialogContent` an internal scroll region: header and
footer as fixed rows, the body scrolling between them (a grid with `grid-rows-[auto_minmax(0,1fr)_auto]`
and `overflow-y-auto` on the middle row, with a sensible default `max-h`). Then **delete the
`max-h`/`overflow` classes from all 13 call sites** — they become not just redundant but
harmful, since a scroll container on the popup re-breaks the pin. Every dialog written
afterwards inherits the behaviour instead of re-deciding it.

Two things to get right, because they are why this is not purely mechanical:
1. **Not every dialog wants a pinned footer.** A short confirm should not grow a bordered bar.
   Pin only when the body actually overflows, or make it opt-in on `DialogContent` and set it
   on the 13 — and say which, so the next author knows the rule rather than guessing from
   examples.
2. **`AlertDialog` is a separate component** (`components/ui/alert-dialog.tsx`) with 29 users
   and its own footer. Decide whether it shares the fix or is deliberately left alone — a
   confirm dialog rarely scrolls, so "left alone" is defensible, but it should be a decision.

**Surface:** +1 scroll region in one primitive, **−13 hand-rolled `max-h`/`overflow` pairs**,
±0 routes, ±0 settings. **Build:** M — the primitive is small; the care is in the 13 call sites
and in not regressing the dialogs that do not scroll. **Owner:** web-agent.
**Verify:** Open the activity dialog at 900px height, scroll to the last field, and confirm
Save is visible without scrolling back. Then open a two-line confirm dialog and confirm it has
not grown a footer bar it does not need.

### UX-68 — Nothing can be duplicated, so the second of anything costs as much as the first
`slows` · at-setup · traced · M5×M2 · *added 2026-08-17, from manual exploration*

**Now.** There is no duplicate/clone action on any entity in the product. A studio setting up
its timetable builds each class from an empty form — and that form is the one UX-40 counts at
**23 fields, exactly one of them required**. The second class a studio creates is usually the
first one with a different name, level and time; today it costs the same 23 decisions.

**Cost.** This lands squarely on the first hour, which is where the review already finds the
most damage (UX-2, UX-40, UX-45). It is also the cheapest possible mitigation for UX-40: rather
than restructuring a long form, let the manager pay its cost once. And the studios it hurts
most are the ones with the richest offer — exactly the customers worth keeping.

**Fix.** A "Duplicate" action on the entity's row/detail menu, opening the create form
pre-filled, with the copy saved only when she confirms. Three rules matter more than the
mechanism:

1. **Copy the definition, never the identity or the live state.** For an activity: copy the
   offer — name (suffixed), description, durations, prices, access rule, member benefit, the
   prose fields. Do **not** copy its sessions, bookings, waitlist entries, public slug or
   published status. A duplicate is a new thing that resembles an old one, not a second handle
   on the same one.
2. **Duplicating must not duplicate a misconfiguration silently.** An activity carries
   `accessTier: 'members'` with an empty allow-list by default, which UX-11 shows renders **no**
   "Included with…" line on any public surface. Copy that and the studio propagates an invisible
   class six times in a minute. Run the existing `computePricingHealth` on the copy before it
   saves and surface what it says — the check already exists and is already the app's best
   diagnostic; this is the moment it earns most.
3. **Name it so two things are never indistinguishable.** Suffix the copy and put the cursor in
   the name field, since renaming is the first thing she will do.

**Where it genuinely applies.** Activities (classes *and* appointments) is the clear first case
— longest form, highest setup burden, and the entity a studio has most of. Beyond that, apply
one test rather than a list: *does a studio routinely own several of these that differ in a few
fields?* Subscription types and promo codes pass (a September campaign becomes an October one).
Documents do not — versions already cover that. Sessions do not — recurrence covers the
repeating case, and UX-4 is the finding for the non-repeating one.

**Surface:** +1 row action per supported entity, +0 routes, +0 settings — the create form is
reused as-is. **Build:** M for the first entity (the form must accept initial values and the
copy rules must be explicit per entity), S for each one after.
**Owner:** web-agent.
**Verify:** Build one class with a subscription, a trial and a drop-in price. Duplicate it,
change only the name and the level, save. The copy carries the pricing and none of the
original's sessions or bookings — and if its access rule leaves no way in, you are told before
it saves.

### UX-69 — Linking a subscription to an appointment writes a field appointments never read
`costs-money` · weekly · traced · M5 · *added 2026-08-17, from manual exploration*

**Now.** The subscription editor has an "Activities this subscription unlocks" picker
(`components/subscriptions/SubscriptionTypesManager.tsx:600-627`) — the inverse editor over the
activities' access rule, added so a studio can link from the subscription side. It renders
`activities.map((a: Activity) => …)` with **no filter on `a.type`**, so appointment activities
appear in the list alongside classes. Ticking one runs `persistLinkedActivities` (`:206-244`),
which writes:

```ts
accessRule: { type: 'subscription', subscriptionTypeIds: [...] }, isFreeTrial: false
```

**`Activity.accessRule` is CLASS-ONLY.** CLAUDE.md states it outright — appointment forms don't
show it, appointment paths don't read it, appointment session docs and mirrors don't carry it —
because an appointment has no access gate at all: *the price is the gate*. Coverage for an
appointment is expressed by `Activity.memberBenefit` (`{subscriptionTypeIds, kind:
'included' | 'discount'}`), which this control never touches.

So the tick does two wrong things at once:

1. **It is a silent no-op where it matters.** Nothing reads `accessRule` on an appointment, so
   `resolveActivityPricingDisplay` never emits an "Included with…" row and the public
   appointment card says nothing about the pack — the symptom that surfaced this.
2. **It writes class-only data onto an appointment.** An `accessRule` on an appointment doc is
   state that by design should not exist, and `isFreeTrial: false` rides along with it.

**Cost.** A studio sells a 10-pack believing it unlocks its appointments. The public surface
never says so, so the pack under-sells — and because appointment coverage comes from
`memberBenefit`, a holder who books anyway is quoted and **charged the full base price**. The
studio's own admin UI told them the link was saved. This is the same shape as the report's
Theme 1 (two stores for one fact), except here the second store is not merely divergent: the
write lands somewhere nothing reads.

**Fix.** The picker must stop offering a control that cannot work. Two honest options, and I'd
take the second:
- **Exclude appointments from the picker** and say why in one line. Correct immediately, and
  leaves the studio to set the benefit on the activity — but it makes the subscription side a
  half-answer.
- **Support appointments properly**: when the ticked activity is an appointment, write
  `memberBenefit` instead of `accessRule`. This cannot be a bare checkbox, because
  `memberBenefit` carries a `kind` — for a credit pack `'included'` is right (a booking spends
  a credit), for a discount plan it is `'discount'` with a percentage. So the row needs that
  one extra choice for appointments.

**One constraint not to paper over.** `memberBenefit` is **one rule per activity**, so linking
a second subscription appends to that rule's `subscriptionTypeIds` — and if two subscriptions
want *different* kinds for the same appointment (one includes it, one discounts it), the model
cannot express it. Say so in the UI rather than silently overwriting. (Repairing appointments
already carrying a stray `accessRule` is **not** required — see "Pre-launch" below.)

**Surface:** ±0 routes; +1 branch in one editor, −1 class-only write on appointment docs, +1
cleanup pass. **Build:** M. **Owner:** web-agent (editor + repair), with a shared-types check
that nothing else writes `accessRule` on an appointment.
**Verify:** Create a 10-credit pack, tick an appointment activity, save. The public appointment
card names the pack, and a holder booking it spends a credit instead of being charged. Then
open that activity's own editor — it shows the benefit, and no access rule.

### UX-70 — An appointment can be free or priced, but not "only with a pack"
`costs-money` · at-setup · traced · M5×C2 · *added 2026-08-17, from manual exploration*

**Now.** An appointment's price lives per duration (`Activity.durations: [{minutes,
priceAmount?}]`), and the resolver treats an absent price as free **to everyone**:

```ts
// packages/shared/src/utils/paymentOptions.ts:685-687
const base = target.duration.priceAmount
if (base === undefined) return { options: [{ type: 'covered', via: { reason: 'unpriced' } }], denial: null }
```

`activity.ts:90-92` states the design outright: appointments dropped `ActivityAccessRule`
entirely, and *"the price is the only gate now — unpriced = anyone books free, priced = anyone
pays, benefit holders less."*

That leaves a coach who sells **only packs** with no expressible option:
- Leave the duration unpriced → a stranger off the bio-link books a **free one-to-one**.
- Give it a price → pack holders spend a credit, but **anyone can also just buy a single
  session** — which is exactly the thing this coach does not sell.

**The root cause is a conflation, not a missing gate.** `priceAmount: undefined` currently
means two different things at once: *"this is free for everyone"* and *"this is not sold by the
session"*. That is the same mistake the codebase already identified and fixed elsewhere — see
`offer/activities/page.tsx:169-175` on why `Activity.level` was made optional: *"forcing a
choice made them pick 'All levels' to mean 'not applicable' — two different statements
collapsed into one."* This is that, one field over.

**Fix — keep "the price is the gate" true by making the price able to close the door.** Make a
duration's price a **tri-state** rather than an optional number: *free* · *priced* · **not sold
individually** (bookable only through a covering subscription). Do **not** re-introduce
`accessRule` on appointments: that would restore the second gate axis the model deliberately
removed, and every appointment path would have to learn it.

Three things follow, and none is optional:
1. **A denial, not silence.** `resolvePaymentOptions` already has a `denial` channel — a
   non-holder on a pack-only duration must be refused there, with a reason the picker can turn
   into "This is available with the {pack name}" plus a link to buy it, rather than a dead end.
2. **The public card must name the way in.** This is UX-11's machinery (`includedWith`) and
   UX-69's `memberBenefit` link. All three converge on one sentence a visitor needs: *what do I
   buy to book this?*
3. **A pack-only duration with no `memberBenefit` is unbookable by anyone.** That is precisely
   the "no way in" state `computePricingHealth` already detects for classes
   (`gated_no_newcomer_path`) and, per UX-11, currently skips. Extend it to appointments —
   otherwise this fix ships a brand-new way to build an invisible offering.

**Surface:** ±0 routes, ±0 settings — one field becomes expressive instead of a new gate.
**Build:** M — shared resolver + fixtures, the activity editor, the appointment picker's refusal
copy, and the health check. **Owner:** functions-agent (resolver + health), then web-agent.
**Verify:** Create an appointment offered only via a 10-pack. As a guest, the picker says what
to buy and links to it — it does not offer a free booking and does not offer a per-session
price. As a pack holder, booking spends a credit.

### UX-71 — A page never points at the one other page that would confirm it worked
`slows` · weekly · traced · M5×M7×M1 · *added 2026-08-17, from manual exploration*

**Now.** A manager finishes configuring a subscription and has no way to know whether the
result is what she meant. The product *has* the answer — Offer → Pricing recomputes every
class, appointment, course and product through the same resolver a real checkout uses, and the
persona called it *"the single best thing in the app"* and used it to verify two goals in
seconds. Nothing anywhere points at it from the place the doubt arises. The same is true of
several pairs this review already found independently: the documents panel and where consent is
actually asked (UX-1), an automation rule and the template it will send (UX-M9-4), an activity
and the pricing-health check that would tell her nobody can get in (UX-11).

**Cost.** She configures, then either takes it on trust or navigates on a hunch. Nielsen 1 —
the system knows how to show her the outcome and doesn't offer to.

**Fix.** A short line of **lateral task prompts** under the page heading — two or three, comma
or dot separated, each a sentence about *what she is about to check*, not a noun ("See how this
prices for a member" rather than "Pricing"). Four constraints, and the first two are what stop
this becoming the thing it is trying to fix:

1. **Declared data, not per-page markup.** One curated map of `page → prompts`, consumed by the
   shared header — the same mechanism as `lib/settings-nav.ts`'s `SETTINGS_ITEMS`, which this
   review praises (What's good #8) precisely because one catalogue feeding two surfaces is what
   stops nav drift. Twenty-five pages each hand-writing their own link row is the accretion this
   report exists to name.
2. **It must answer `PageHeader`'s standing objection.** That component's header says
   navigation is *deliberately* excluded — *"the sidebar is the single, consistent way back… so
   detail pages don't sprout their own inconsistent up-links."* That decision is about
   **up-links**, and these are **lateral prompts to verify a result**; if that distinction
   cannot be stated in one line in the UI, the objection wins and this should not ship. Update
   the component comment either way, so the next reader sees one decision rather than a
   contradiction.
3. **A prompt may never be the only path to anything.** Then hiding them on a phone — which is
   reasonable, since verification is a desktop-shaped, low-frequency task — costs a shortcut and
   not a capability. Hide the prose before the link if a compromise is needed.
4. **Curate by known dependency, not by page.** Only where the product can name a real
   cross-page relationship. The review already supplies the first four: subscriptions →
   pricing, documents → where consent is asked, automation rule → template preview, activity →
   pricing health.

**Blocked on UX-22.** There is no consistent page heading to put this under: `PageHeader` is
used by **6** files while **67** hand-roll their own `<h1>` across four treatments. Shipping
this first would mean hand-rolling it 67 times. Adopt the header, then add one slot to it.

**Do not add a third thing under the heading.** `components/onboarding/SectionIntro.tsx`
already occupies that space on 3 pages, with the dual-source state M2 flagged (a `localStorage`
glow key beside a `profile.onboarding.seenIntros` seen-flag). Fold it into the same slot or
leave it alone deliberately — do not stack a new row above it.

**Surface:** +1 prompt map, +1 `PageHeader` slot, ±0 routes. **Build:** M for the mechanism,
S per prompt after. **Owner:** web-agent.
**Verify:** Finish creating a subscription. Without using the sidebar, reach the screen that
shows what a member will actually pay — and on a phone, confirm nothing has become unreachable.

### UX-72 — Delete the per-page help popovers; the How-to page replaced them
`confuses` · at-setup · traced · M2×M1 · *added 2026-08-17, Franco's call* · **removal**

**Now.** `components/onboarding/SectionIntro.tsx` renders a `HelpCircle` popover beside the
heading on exactly three pages — dashboard, contacts, schedule — with a glow until first
opened. It never reached the other ~22, and the studio-facing help it offers is now done better,
and in one place, by the How-to page (concept map, "I want to…" recipes, a live price
simulator, a checklist read from real data — this review's What's good #12).

It also carries the dual-source state M2 flagged: a per-browser `linyup_intro_opened_{section}`
key drives the glow while `profile.onboarding.seenIntros` records the seen-flag on the user doc
— two answers to one question, and the localStorage half is three of the nine device-local
preferences UX-23 counts.

**Fix — delete it.** The surface is cleanly bounded:
- `components/onboarding/SectionIntro.tsx` (the whole file) and its three mounts in
  `(auth)/{dashboard,contacts,schedule}/page.tsx`.
- `markIntroSeen` (`lib/onboarding.ts:33-36`) — **`SectionIntro` is its only caller**, so the
  helper goes with it, along with the stale "Phase 4 (section intro panels)" note at `:11`.
- The `Onboarding.intro.{open,termsLabel,dashboard,contacts,calendar}` keys × 4 locales.
- `profile.onboarding.seenIntros` simply stops being written. Pre-launch, so no cleanup.

**Surface:** −1 component, −3 mounts, −1 helper, −1 user-doc field, −3 device-local preferences,
−20 message strings. **Build:** S. **Owner:** web-agent.

**Two things this changes elsewhere.**
1. **It frees the slot UX-71 needs.** That finding's "do not add a third thing under the
   heading" constraint is satisfied by removing the second one.
2. **The same argument applies to the product tour, and should be faced.** UX-47 records that
   the tour never runs below 768px and that not one of its six steps touches activities,
   sessions, bookings, contacts or money — step 4 introduces an empty Shortcuts box, and step 5
   pitches a search that only resolves nav destinations. If per-page help goes because the
   How-to page does it better, the tour is the same claim with a weaker case. Decide both
   together rather than deleting one and leaving the other.

**Noted for later, not filed:** Franco's view is that the How-to page itself wants a review. It
is currently the survivor of this consolidation, so it inherits the job both deleted surfaces
were doing — and this review already found its one real hole (UX-M3-8: no scheduling or
recurrence topic, the most basic weekly job).

---

## Themes — what the twelve have in common

**1. Two stores for one fact.** UX-1 (two consent mechanisms), UX-6 (cutoff written to a mirror
the server does not read), UX-12 (payments page vs finance ledger), UX-15 (bulk vs per-contact
subscription writes), UX-18 (two confirm paths writing different fields). In every case both
writers are individually correct. The fix is never "fix the bug" — it is to delete one store.

**2. A check that cannot see the default.** UX-2 (existence-only checklist probes), UX-11
(`computePricingHealth` skips the default tier), UX-10 (`type == 'session'` misses the
appointment mirror). Each was written against the shape the author had in mind, and the
product's *default* shape is the one it does not cover.

**3. The last three metres.** UX-5 (13 silent money failures), UX-24 (no toast on the activities
dialog), UX-6 (a `console.warn` under a green tick). The error strings exist and are thrown;
they just never reach a screen. This is the cheapest cluster in the report and should ship first.

**4. The control is there, unlabelled.** UX-3 (availability behind a caret), UX-9 (a launcher on
top of the primary button), UX-43 (a plugin findable only by browsing). And its mirror image:
capability built and never wired — `previewAutomationRule` has zero importers (UX-13),
`automation_logs` is written by four trigger paths and read by none (UX-48), `manifest.screenshot`
is populated by zero of sixteen manifests, and a ⌘K synonym entry for "discount" can only ever
match a plugin already installed.

---

## Remaining findings, by area

Each area was capped at 8 findings and returned `--brief`, so these are one-liners, not
work orders. Numbers cross-reference the table above.

**M1 Shell & nav** — #29 alphabetical sort pushed Schedule last, a regression from `6d94638`
(`layout.tsx:1663-1672` re-sorts the frequency-curated `NAV_SECTIONS` at `:160-181`); #36 the
mobile hamburger is not `sticky` (`MobileHeader.tsx:12`); collapsed-sidebar state is read in a
`useEffect` after first render so it visibly snaps (`layout.tsx:1810, 1819-1822`); the mobile
drawer has no swipe handling, diverging from CLAUDE.md's explicit porting requirement; the
plugin marketplace's only entry point is an icon with a hover-only tooltip.

**M2 First run** — #45 the checklist renders three times with three dismissals (two device-local)
and no finish line; #46 day one shows 18 cards, 17 empty; #40 the activity dialog has 23 fields,
one required; #47 the tour never runs below 768px and never mentions activities, sessions,
bookings, contacts or money, while step 4 highlights an empty box; the bio-link is seeded with
hardcoded English links (`lib/provisioning.ts:52-67`) so a German studio's public page is
English on day one, and its checklist step arrives pre-ticked; a "Set up ranks" step ships to
every studio.

**M3 Schedule** — #20 four surfaces describe the same week from three different sets, and the
header count is really "a 3-month window around whichever month the mini-calendar is on, plus
all events, ever"; the event dialog is the real instance of the F2 shape; `/events/[id]` has no
booking, waitlist or check-in while `/sessions/[id]` has all three; no List view below `sm`.

**M4 Contacts** — #44 sorted by surname with the only "attention" signal being a manually typed
reminder, while pending requests live in a separate tab; #15 bulk plan change writes 2 fields
where the per-contact dialog writes 5; #54 fifteen hardcoded English strings including a count
interpolated into a translated destructive sentence ("1 contacts"); an active contact cannot be
archived from their own record; nine tabs with a drag-reorder *mode* as the coping mechanism;
two soft-delete states for one job, plus a permanently disabled "Move to team" item.

**M5 Offer** — #25 `PromoScopeKind` has no `subscription` member and `createMembershipCheckout`
accepts no `promoCode` at all; #24 promo validation is one string 135 lines from the unmarked
field it names, and the activities dialog has no `try`/`catch`; `/offer/plans` reads `?tab=`
server-side but never writes it back; M5 alone carries 5 of the app's 17 redirect stubs.

**M6 Money** — #17 the BYO gateway type defaults to Stripe and asks for a publishable key read
by nothing, while badging itself "Enabled"; #33 `connectReady` is true the moment onboarding
*starts* while every server path demands `enabled`; the contact Payments tab omits `onRefund`
and half-refunds are impossible in-app though the callable accepts an amount; #59 link-mode rows
have no action and the server refuses them; #60 the `gateway_ref_kind: 'fallback'` marker is read
by no screen.

**M7 Settings** — #39 ranks; #41 booking asks 11 questions including a `waitlistClaimMinutes`
control that renders even when the waitlist is off and whose only possible effect is to make a
waitlist worse; #42 three inconsistent above-tier behaviours, including a fully working
`/settings/roles` on a single-user plan; sender identity and email templates are two rail items
though the placeholders live in one and the editor in the other; the engagement thresholds
behind "at risk" live at the bottom of General, and none of the four surfaces that read the band
links back.

**M8 Plugins** — #16 unconfirmed removal with a recorded precedent of data loss
(`layout.tsx:227-231`); #43 discovery; `hmd-fighting-cup` ships unconditionally to every tenant;
the whole card and a separate "Details" link do the same thing next to Remove;
`manifest.screenshot` is populated by none of the 16.

**M9 Automations** — #13 no preview before a rule goes live and "Run Now" fires from a `…` menu
with no confirm, on a callable documented as bypassing the dedup guard with `force=true`; #48
`automation_logs`; #51 `create_alert` is selectable and stripped at save; no email preview while
wiring a rule though `TemplateEditor` already builds a production-fidelity one; a rule points at
one template so language is whatever the manager picked. Persona F14/F15 corroborate: both
library rules installed **Paused** with no warning and only a nameless kebab to activate, one
with an empty template.

**M10 Org** — #34 `addOrgMember`/`removeOrgMember` do not exist; #35 the org marketplace renders
the unfiltered 16-plugin registry with **no `minPlan` check**, and org installs merge into every
affiliated team; an invitee who owns no team gets a permanently disabled Accept with no
explanation. M10 alone has 8 hand-rolled `z-50` toasts.

**M11 Public authoring** — #49 unpublishing leaves the bio-link pointing at "Site not found";
#50 Unpublish is unconfirmed while deleting a *section* three lines away confirms; the same
"what are my other pages called" list is configured twice with different granularity; documents
have no visitor-fidelity preview though the bio-link and website builder both have sticky live
ones; draft→live behaves three different ways across the hub.

**C1 Discovery** — #31 no `generateMetadata` on the bio-link, though the identical
slug-resolution problem was already solved for `/site` (`site/page.tsx:18-110`); #30
`components/site/sections.tsx` is not i18n-aware **by its own comments** (`:409-411`, `:720`) and
is the only renderer for every published tenant site, in a product where 3 of 4 locales are not
English.

**C2 Book & pay** — #14 cancellation policy sits in a collapsed `<details>` two steps before
Confirm, and the no-show fee has no public mirror at all; #32 `manage-booking` maps one refusal
and prints the rest as hardcoded English; #53 no `.ics` on class bookings (the only
`text/calendar` in the whole functions package is `appointments/templates.ts:178`); #33 appointment
cards can never show the honest "no open sessions" chip; the appointment confirmation shows no
date, time, coach, location, price or cancel link.

**C3 Shop & forms** — #57 no path from the Shop to the studio's terms unless the studio built a
custom `/site`; #58 `ContactsGate` hand-rolls a sign-in UI driven by the same `auth.step` as the
globally mounted dialog, so both open at once.

**C4 Space** — #37 no `initializing` flag, so four copies of a signed-out wall paint before auth
resolves; #38 Home duplicates four blocks and never shows the next booking, and Membership
appears twice with the cancelling state omitted on Home; #55 four shop links, zero booking links;
#56 cancel with no confirm, no policy, no credit statement, and a hover-only reason a phone
cannot show; #52 `CoursePlayer`'s summary type never got `'purchase'`; a course resumes at lesson 1
every time; 20 dead catalogue-era strings across four locales.

---

## What's good — do not redesign these away

1. **`Offer → Pricing` is the best surface in the product, and it is best because it cannot
   lie.** Persona preview, "what you sell" and health are all computed from the *same resolver a
   real checkout uses* — stated as a contract at `offer/pricing/page.tsx:3-13`. The persona
   called it "the single best thing in the app" and used it to verify two goals in seconds.
   **Reuse the health-with-a-fix-link pattern (`:560-591`) in Automations** — F14/F15 is exactly
   the class of problem it catches.
2. **Failure is never rendered as emptiness anywhere in Space, and the reasoning is written down
   at each site** — two independent error slots (`SpaceHome.tsx:142-149`), a credits section that
   survives a failed read (`:446`), a profile card that refuses to print "—" into fields it could
   not read (`AccountHome.tsx:273-291`), a cancel that does not refetch after failure
   (`BookingsHome.tsx:114-121`). The best error-state work in the app. `AppointmentPicker.tsx:1641-1644`
   states the principle: *"a coach would read that as a misconfiguration; a client would just leave."*
3. **`WaiverStep` is a step, not a block, and the header says why** — two surfaces book
   automatically on verification and render no details form, so a consent block inside a form
   would be silently skipped on exactly those paths (`components/booking/WaiverStep.tsx:14-24`). A
   brand-new subsystem landed across five surfaces with one implementation and a written reason
   for its one deviation.
4. **The booking flows put step state in the URL and re-validate it** — `useStepUrl`
   (`BookingForm.tsx:1322-1460`, `AppointmentPicker.tsx:1693-1795`) syncs step, provider,
   activity, duration, date and slot, restores from `popstate`, and re-checks a crafted `?start=`
   against real free slots rather than trusting it. **This, and `contacts/[id]:4895-4902`, are the
   fix UX-22 is asking for — already written, twice.**
5. **Progressive disclosure and inline quick-create in the activity form** — the trial-price
   field appears only where a trial door grants something (`offer/activities/page.tsx:759`, with
   the reasoning at `:755-758`); the plan allow-list only on the `subscription` tier; and a
   subscription can be created without leaving the form (`:1022-1046`). The persona: *"I never saw
   a field I didn't need."*
6. **Microcopy that teaches the data model instead of describing the UI** — *"Class — you put it
   on the calendar; people book a seat"* vs *"Appointment — people pick a time from your
   availability"* (`:586-590`). The reason the persona never asked what an appointment was.
7. **One terms resolver, three surfaces** — `resolveActivityTerms` (`lib/activityTerms.ts:91`)
   feeds the admin card, the public shop and the marketing site. This is why UX-11 is one branch
   in one file rather than three divergent bugs.
8. **`SETTINGS_ITEMS` is one catalogue consumed by both the sidebar and the settings rail**
   (`lib/settings-nav.ts:44`, reason at `:1`), and the settings master-detail shell keeps the rail
   mounted across navigations (`settings/layout.tsx:3-8`). **Reuse that shell at `/offer` and
   `/plugins`**, both hub-plus-children today with no shared shell.
9. **Nav plan/plugin gating is declarative and self-documenting** — `minPlan` (visible, locked,
   opens upgrade) vs `requiresPlan` (hidden) vs `requiresPlugin` vs `requiresShop`, each item
   commented with which and why (`layout.tsx:100-114`). A Free manager sees what she is missing
   without dead links.
10. **The org billing page reuses the same predicates and component as team billing, with the
    reason recorded** — *"two org owners must not read two different sentences about the same
    Stripe field"* (`org/[orgId]/billing/page.tsx:213-221`). And every org tab is a **real route**
    (`org/[orgId]/layout.tsx:16-27`) — the pattern UX-22 needs.
11. **The 19-rule automation library**, categorised by business outcome, installing `active:
    false` so nothing goes live silently (`LibraryDialog.tsx:194`).
12. **The How-to page** — concept map, an "I want to…" recipe list matched to business goals, a
    live price simulator, a checklist read from real data. The persona: *"genuinely the best in-app
    help I've seen"* — with a scheduling-shaped hole.

---

## Dropped

Recorded so they are not re-derived: `/coaches` and the roles IA (the coach/staff persona is
deliberately not modelled — it needs its own pass); the 17 redirect stubs as a cleanup sweep
rather than a finding; `plugins/hmd-fighting-cup/` as a product-scope call; contacts loading the
whole roster client-side and `contacts/[id]/page.tsx` at ~5,300 lines (both `code-reviewer`'s);
empty/loading/error consistency (`ui/query-error` adopted by 10 files, 9 more render a raw
string) pending a contact-persona runtime pass; a scattering of single hardcoded English strings
outside the counted clusters; and **all accessibility findings** — contrast across the four
heading treatments, `aria-pressed` on hand-rolled toggle chips, `role="status"` on skeletons,
and the studio-theme token leaks in `SpaceWaiverCard` — deferred in full to
`design:accessibility-review`, which four findings flag explicitly.

---

## Suggested order of work

**This week, all cheap, all closing a lie:** UX-5 (error toasts on the mutation definitions),
UX-6's interim (`catch` + fatal mirror write), UX-9's interim (move the launchers off the FAB
corner), UX-24 (`try`/`catch` + toasts on the activities dialog), UX-2's interim (a red line on
the checklist step), UX-7's interim (one signup line + the billing null-branch), and the two
untranslated `window.confirm` strings.

**Next, the seams:** UX-1 (consent scope), UX-4 (the series cliff — the horizon roller is small
and stops silent data loss), UX-3 (a named home for availability), UX-8 + UX-12 together (they
share one reversal primitive).

**Then harvest `docs/ux-principles.md`.** Three judgement calls recurred often enough to be
worth writing down before the next review: *one store per fact*, *a capability that is built but
unwired is not shipped*, and *a check must cover the product's default shape, not the shape the
author had in mind*.
