---
title: Open decisions — parked for Franco
status: living
area: product
---
# Open decisions — parked for Franco

Questions raised while working the UX review that need a product call rather than a
code judgement. Recorded here as they arise so the autonomous run does not stall
and does not guess. Each entry states what was done in the meantime, so nothing is
blocked waiting for an answer.

Status legend: **PARKED** (needs a decision) · **ASSUMED** (proceeded on a stated
assumption, reversible) · **ANSWERED** (decided; kept for the record).

---

## 1. Promo codes on memberships — deferred, not refused
**ANSWERED 2026-08-17.** UX-25 shipped an intro offer owned by the PLAN (first N
periods). Promo codes on memberships stay deferred: a promo is a Stage A modifier
inside `resolvePaymentOptions`, which returns ONE amount, while a recurring discount
is a schedule. Revisit only if studios ask for a *code* rather than a standing offer.

## 2. Weekly-report distortion if a stage backfill is ever run
**PARKED.** UX-83 makes `trial_* → joined` write a conversion row. A backfill of
already-stranded contacts would dump months of historical conversions into ONE
week's `trial_conversions_count` (`trackContacts` stamps the current week).
*Meanwhile:* nothing was backfilled — pre-launch, no production tenants, and no
seeder writes `signup_completed_at`. **Decide before the first real migration**, not
before launch.

## 3. `hmd-fighting-cup` and other tenant-specific plugins
**ANSWERED 2026-08-18 — Franco: hide it behind an allow-list.** Built as a
mechanism, not a one-off. `PluginManifest.audience` (`packages/shared/src/types/plugin.ts`)
names `teamIds` and/or `orgIds`; absent means public, so every generic plugin is
unaffected by construction. **A member studio of an allowed org is ALLOWED** —
an org-level customization bundle exists so the org's studios can run it, and
`org_id` is already the grant everywhere else (`useInstalledPlugins`). Its one
reader is `pluginVisibleToTenant`, whose doc comment owns **the census** of
discovery surfaces (marketplace + its `?plugin=` deep link, event-types "From
plugins", DiscoverPanel, org catalogue) and names the one deliberate
non-caller — the sidebar suggestion in `(auth)/layout.tsx`, unreachable for a
restricted plugin because it takes only `recommended` manifests with nav rows.

**The gate is on DISCOVERY, never on running.** Nothing that resolves an
installed plugin consults it, and each catalogue ORs the predicate with its own
install check, so a tenant dropped from a list keeps its card, its Configure and
its Remove — a list edit must not be a data change with an outage in it.

**The list lives in the manifest, not in operator-editable data.** A
tenant-specific plugin is code that exists only because one customer was built
for, so its audience costs one line in a file already being written; a
data-backed list needs a collection, rules, an operator screen and a
per-render read before the first one works, and a globally-readable
"which plugin belongs to whom" document leaks the customer names the field
exists to hide. `locked` + `unlockPlugin` remains the no-deploy escape hatch
and composes with this.

**Not renamed — and now never needs to be. RESOLVED 2026-08-19.** The widening
happened by ADDITION: a new `hmd` container plugin was added beside
`hmd-fighting-cup`, which became its first member (`PLUGIN_BUNDLES` in
`@linyup/shared`). A member is an ordinary plugin with an ordinary install
document, so it keeps its id, its `hmd_fighting_cup` event-type value and its
folder — nothing migrated, and the double migration this decision was deferring
never had to happen. The container is what a tenant now discovers and installs;
`pluginIsInstallable` is the only predicate that treats a member differently.
See `docs/plugins.md`.

## 4. Automation delays (UX-85)
**ANSWERED 2026-08-18 — Franco: build them for real.** Pre-launch, no productive
data, so the migration concern below is moot. Original note kept for the record: Ten triggers store a
`delayMinutes` that nothing reads; only `session_ended` is really deferred. Two
non-equivalent fixes: route event rules through the Cloud Tasks path (a real
feature — needs a queue handler and a decision about what a delayed rule does if
the contact changed meanwhile), or set `supportsDelay: false` and hide the field
(honest and immediate).
**The blocker is data, not code:** existing rules already carry a delay a studio
believes in. Hiding the field silently converts "3 days later" into "immediately";
building the feature makes those rules start behaving as written, possibly years
after they were composed. *Meanwhile:* nothing changed, and the new
`acquisition_stage_changed` trigger declines the delay so it adds no new instances.

## 5. Should the starter bundle install "Welcome a new member"? (UX-84)
**ANSWERED 2026-08-18 — Franco: yes, bundle it.** `lib_member_welcome` is now in
`STARTER_BUNDLE_KEYS`, so a day-one studio's first automated mail is the one
that greets a new member rather than only the ones that chase a lapsed one.

Three things checked rather than assumed:
- **It installs `active: false`,** like every other bundle item and with no
  exception for this one — `installStarterBundle` goes through the same
  `installItems` writer as the library dialog, which writes `active: false`
  unconditionally. It is the item whose failure mode is loudest: installed live,
  it would greet the whole existing roster the first time anyone's stage moved.
- **The count follows.** The button reads
  `starterBundleItemsForPlan(plan).length`; nothing is hardcoded. Since the item
  is `requires_plan: 'studio'`, `libraryItemUnlocked` still filters it out below
  Studio and the label shows the smaller number there.
- **The trigger is right.** It fires on `acquisition_stage_changed`, which
  `onContactWrite` emits on FORWARD stage moves only and evaluates against the
  **after** document — so the `acquisition_stage = joined` condition reads the
  new stage, including the `trial_* → joined` move `auth/signupJoin.ts` makes
  when a trial lead completes signup.

## 6. Cloud Tasks region fix wants eyes on the first deploy (UX-85)
**ASSUMED, needs confirmation once — not blocking.** `getFunctions().taskQueue()`
with a bare name resolves to `us-central1` (firebase-admin `DEFAULT_LOCATION`)
while our functions live in `europe-west6`, so every delayed-rule enqueue has
been posting to a queue that does not exist. The error is swallowed by `to()`,
which is why nobody noticed. Now fully qualified.
**This was verified statically and against a local probe, NOT against a deployed
404.** The Tasks emulator is a plain FIFO that ignores `scheduleTime`, so the
one thing local testing cannot prove is that the wait actually happens.
*Action on first sandbox deploy:* create a rule with a short delay, fire it, and
confirm the task is scheduled rather than dispatched immediately.

## 7. Three affiliation triggers still use a random occurrence id (UX-85)
**DONE 2026-08-18** — patched once the file was free; all 11 event triggers now
derive the key from the CloudEvent id. Original note: `onAffiliationWrite.ts` was in a reserved lane, so
`affiliation_added/removed/changed` fall back to `randomUUID()` for the dedup
occurrence instead of the CloudEvent id. It still collapses a Cloud Tasks
redelivery, and a duplicate Firestore delivery falls to the per-rule/per-contact
window — the same protection the inline path has today, so there is no
regression. *Follow-up:* add `{ eventId: event.id }` at
`packages/functions/src/sync/onAffiliationWrite.ts:124/129/135`.

## 8. ⚠ Seeded tenants now show NO priced doors (UX-33) — affects the next demo
**PARKED, and the most time-sensitive item here.** `payments_enabled` fails closed,
and **no seed writes `teams/{id}.payments`** — so every emulator, sandbox and lead
tenant now reads `payments_enabled: false`: no shop surface, no drop-in price, no
priced trial, no priced appointment duration.

The lane deliberately did **not** fake `connectStatus: 'enabled'` in the seeds,
which is right — that reproduces the exact lie UX-33 exists to remove. The honest
fix is linking a real **test-mode** Connect account; the tooling already exists
(`scripts/lib/connect.ts`, `scripts/connect-test-account.ts`).

*Action:* do this before the next live demo **if priced surfaces are part of it.**
Until then the demo tenants show a free-only product, which is coherent but not
what you would want to present.

## 9. Org trials never expire — RESOLVED, and this entry was stale
**BUILT (UX-9), recorded here 2026-08-28.** The text below described the code as
it was when the question was asked, and stayed on the board after the answer
shipped — which is how a decision register misleads: a reader checking "do org
trials expire?" found PARKED and believed it.

`handleTrialLifecycle` has a **phase 2** that queries `ORGANIZATIONS_COLLECTION`
for `plan_status == 'trial'` past `trial_ends_at` and calls `lapseOrganization`,
which deactivates the org's installs, unpublishes its site, moves every active
member studio to Free through `downgradeTeamToFree` and severs `org_id`. The
decision the entry was waiting for — what a lapse does to member teams — was
answered as **Free**, the same as a team trial.

Both phases skip `tenantExemptFromTrialSweep` (internal / pilot / comped), and
`lapseOrganization` refuses an exempt org outright.

*Original text, for the record:* `handleTrialLifecycle` sweeps `TEAMS_COLLECTION`
only, while `createOrganization` grants a 14-day trial that nothing ends. An
unpaid org — and every studio it bills — sits on the top tier indefinitely.
UX-35 removed the *accidental* sweep that used to catch member teams, so this is
now the only thing between an unpaid org and unlimited access. The decision: what
should a lapsed org trial do to its member teams? Free (like a team trial), a
fresh Studio trial (like `removeTeamFromOrg` does), or read-only? Not guessed.

## 10. An org lapse mounts features it no longer pays for
**PARKED.** On `past_due`/`cancelled` the webhook propagates `plan_status` to member
teams but leaves `plan: 'organization'` and deactivates no installs — where the team
rail calls `downgradeTeamToFree`, which does. Client `pluginAccessForPlan` reads the
plan only, so navigation stays mounted while every gated callable 403s.
**The decision:** should a lapsed org deactivate its org-level installs?

## 11. Should a studio that takes payment offline get a read-only price list?
**PARKED, product call.** Hiding the shop (UX-33) removes the only surface where a
visitor can see membership prices. A cash-only studio may still want prices
published with no buy button.

## 12. Org-admin invitations by email
**DECIDED AND BUILT.** Franco asked for it; the three reasons it was previously
declined became the specification.

- **Where a pending invitation lives.** `organizations/{orgId}/`
  **`org_member_invitations`**`/{id}`, with the doc id DERIVED FROM THE
  NORMALISED ADDRESS (`orgMemberInvitationId`, a hashed key — `/` is legal in an
  RFC 5322 local part). So inviting the same address twice rewrites ONE row: a
  new token, a new deadline, the older mail's link dead on the spot. Never two
  live tokens, never two "pending" rows disagreeing about which one accepting
  consumed.
- **Kept apart from `org_invitations` by a rule, not by care.** AN INVITATION IS
  NAMED AFTER THE COLLECTION IT GRANTS INTO — `org_invitations` → `org_teams`
  (a whole studio, accepted by its owner, billing moves),
  `org_member_invitations` → `org_members` (one person, accepted by themselves,
  nothing else moves). The rule is written once, beside
  `ORG_INVITATIONS_SUBCOLLECTION` in `packages/shared/src/paths.ts`;
  `org_invitations` is misnamed by it and keeps its name because it is shipped
  data behind a live route. Separate route (`/org-member-invite/{orgId}/{token}`
  vs `/org-invite/{orgId}/{invId}`), and the mail + the page say in words that no
  studio and no billing is involved. `memberInvitations.test.ts` fails the build
  if this module so much as mentions `org_teams`, `saas_subscriptions` or the
  teams collection.
- **The accept surface owns the whole trip.** The invitee may have no account:
  the page signs them up itself, with the address FIXED to the invited one —
  not via `/signup` (its second step creates a STUDIO) and not via `/login`
  (which ignores `?redirect=` today).
- **The address mismatch.** The token proves control of a mailbox, not of an
  identity, so `acceptOrgMemberInvitation` refuses unless the signed-in
  account's own address equals the invited one — `email_mismatch`, naming both
  addresses, with a sign-out button. It never re-points the invitation at
  whoever turned up: that would make a forwarded link a transferable grant.
- **Expiry** is `expireOrgMemberInvitations` in `dailyTasks`, and it earns its
  place precisely because AUTHORIZATION DOES NOT DEPEND ON IT — the deadline is
  compared at accept, so a sweep that never ran opens nothing. It selects
  `status == 'pending'` and writes `status = 'expired'`, so a swept row stops
  matching, and it notifies nobody, so there is nothing that could double-fire.
- **The last-admin guard is untouched**, checked rather than assumed: it counts
  `org_members` rows only. A pending invitation must not satisfy it (an unopened
  mailbox is not an administrator) and cannot be blocked by it (sending one takes
  no admin away).
- **Follow-up, not done:** the invitee's signup allowlist entry
  (`source: 'org_member_invitation'`) is never removed — it permits creating an
  account, which is not a grant of anything in the organisation, but it does mean
  an org admin can widen the closed-signup allowlist one address at a time.

## 13. `public_profile` is client-writable by any team member
**NOTED, not acted on.** `payments_enabled` — like `showBranding` and
`public_pages_indexable` before it — can be flipped client-side. Display only:
every checkout still refuses server-side, so this changes what a page *shows*, not
what it can *take*. Tightening the rule would break the bio-link settings editor.

## 14. Should automation run history name recipients? (UX-48)
**DECIDED AND BUILT — a capped list of contact IDS.** `AutomationLogData` now
carries `recipient_ids` (≤ `RECIPIENT_ID_CAP` = 50) plus an exact
`recipients_total`, written on the same row as the counts by `runRule` — the one
function all four log writers go through, so there is no second write to keep in
step. The three questions, answered:

- **How many** — 50. A sample, never presented as the whole: when the total
  exceeds the stored list the dialog leads with "Showing the first 50 of 400".
- **Retention** — the log row's; nothing new expires or is swept.
- **PII** — ids only. Names are resolved at READ time from the roster the app
  already caches (plus a per-row lookup for anyone archived since the run), so
  the log holds no frozen copy of contact data outside the contact. A recipient
  deleted since resolves to nothing and is counted as such.

**Which contacts:** the ones an action actually RAN FOR (`executed > 0`), not
everyone who matched — the studio's question is "who got the mail". Recorded at
the same seam that stamps `outreach_rules_sent`, so "reached" means one thing.

Rows written before this carry no `recipient_ids` at all, and the dialog
distinguishes that from an empty array: "not recorded" and "reached nobody" are
different sentences. No index was needed (a new field on an existing document;
the `idempotency_key` guard query is untouched). The `history.recipientsNote`
message key is now orphaned — the copy it held was the "we do not record
recipients" sentence, which is no longer true.

## 15. Two indexes must deploy BEFORE the code that queries them
**ACTION, not a decision — carried into the sandbox tag annotation.**
- `automation_logs (rule_id ASC, triggered_at DESC)` — new today (UX-48); the
  per-rule "Run history" item is its only caller.
- `bookings` collection-group `(teamId, contact, joinedAt DESC)` — from UX-10.
The emulator hides a missing index; a real project returns 400. Order:
rules+indexes, then functions, then web.

## 16. Cancelling a link-mode appointment does not close its Stripe link (UX-59)
**ANSWERED 2026-08-18 — Franco: close it. Shipped.** The manager's cancel moved
behind a callable, `cancelAppointmentSlot`
(`packages/functions/src/appointments/cancelSlot.ts`), which closes the Checkout
Session and then cancels. Census site 8 in `appointments/holdRelease.ts`, the
twin of site 7's deliberate manager exemption.

**THE ORDERING IS THE REVERSE OF `markAppointmentPaid`'s, deliberately.** Closing
a session makes Stripe deliver `checkout.session.expired` — census site 3, which
carries this hold's own booking token, so its ownership proof SUCCEEDS. For a
SETTLEMENT that event is an UNDO, which is why `markAppointmentPaid` settles
first. For a CANCELLATION it writes the same end state, so the two writers
COMMUTE: event first and our transaction re-reads an already-cancelled session;
transaction first and `releaseAppointmentHold` answers `not_a_live_hold`. What
does NOT commute is a PAYMENT landing between a cancel write and a successful
close — that is the defect itself, merely narrowed to milliseconds. So the
irreversible half goes first: close, then cancel. Pinned by source assertions in
`appointments/cancelSlot.test.ts`.

The three outcomes, all surfaced: `closed` → the cancellation proceeds silently;
`paid` → **refused**, nothing is cancelled and the manager is told the client
paid and the appointment is confirmed (the refusal clears itself once the webhook
confirms the session, so it is not a deadlock); `failed` → the cancellation
proceeds (Stripe being unreachable must not block a manager clearing a slot) and
the manager is told the link may still be payable.

**Not widened:** a public-checkout hold stores no session id (30-minute deadline,
own rollback) and a DELETED session sends a late payment into
`handleAppointmentCheckout`'s case 4, which refunds rather than re-acquires — so
the delete path is only routed through the callable when a link id exists, which
is about not throwing that id away.

## 17. A gift-card-covered trial carries no "Paid trial" chip (UX-66)
**NOTED, no action.** Full-cover gift-card redemption writes a finance reclass and
no payment row at all, so there is nowhere to put the stamp. A property of
full-cover redemption generally, not of trials. Recorded in
`docs/payment-contact-studio.md`.

## 18. UX-60 remains STRUCTURALLY open — the chip is a warning, not a fix
**DECIDED 2026-08-18 — guidance + detection; the structural fix is deliberately
NOT built.** Franco rejected dedupe-by-heuristic (a wrong match silently deletes
a real second payment) and rejected giving the rail credentials (avoiding them is
what BYO is for). Shipped: the setup guidance corrected — `docs/payment-contact-studio.md`
was itself telling studios to subscribe to `invoice.payment_succeeded`, so the
documented setup produced the defect — and the dialog note promoted from a
footnote to a callout; plus **detection, which turned out to be exact rather than
heuristic**: `raw_status` stores the literal event type that wrote each row, so
"this endpoint delivered both families" is a stored fact. `detectByoStripeDoubleRecording`
(shared, unit-tested) counts families over a 90-day window — self-clearing, and
it never pairs two rows — and Settings → Payments warns the owner with the fix.
Nothing mutates a row. `docs/open-defects.md` entry 1 records this; the entry
stays open because the duplication itself is unchanged.

**Original note.** BYO double-recording is caused by the Stripe API no longer letting an
`invoice.*` payload name its PaymentIntent (or vice versa), with no credentials on
that rail to bridge them. Today's work makes the suspect rows *visible* and tells
the studio which events to subscribe to; it does not stop the duplication. The
three real closes each have a cost and none was mine to pick: swap to
`invoice_payment.paid`, give the rail read-only credentials, or dedupe across
keys. `docs/open-defects.md` entry 1 says explicitly that this is still not a fix.

## 19. Should search find archived and deleted contacts? (UX-21)
**PARKED — scope, not mechanism.** `useActiveContacts` filters them out, so looking
up a former member returns nothing. Fixing it costs a second query per panel
session. *Meanwhile:* active contacts only, matching every list page's default tab.

## 20. "Recent contacts" in the empty search panel — deliberately not built
**ASSUMED: no.** It was on the brief as a candidate, and it would be a FOURTH
remembered-destination store on the day UX-23 reduced three overlapping ones to
clearly-named distinct concepts. Say if you want it; it should reuse the Open-tabs
store rather than adding another.

## 21. The public-pages hub is missing the appointment picker (UX-28)
**ANSWERED 2026-08-18 — computed, then added. Shipped.**

**The liveness rule, in one line:** the picker is live when the studio's
`bookingSettings.appointmentsEnabled` toggle is on **AND** at least one
`status: 'active'` availability window links to at least one `type: 'appointment'`
activity of the team with a bookable duration menu — where "bookable" drops
priced durations for a studio with no chargeable Connect account, exactly as
`listAvailability` does. It is a mirror of that callable's own refusals (it
returns `{ coaches: [] }` on each of them), because that callable is what a
visitor actually sees.

**It is stored as HALF an answer, on purpose.** `active_public_surfaces.appointments`
holds only the CONTENT half (`syncTeamPublicProfile` → `appointmentContentExists`).
The toggle is written straight to the public_profile document by Settings →
Booking, which never touches the team document — so a stored copy would be
silently stale from the moment a studio flipped the switch, which is the exact
failure this flag was added to avoid. The toggle is read LIVE from the same
document, in the same read, at no cost. `appointmentPickerLive`
(`shared/publicRoutes.ts`) is the ONE place the two are combined, and it fails
closed.

Freshness of the content half: `onAvailabilityWrite` (new) and an appointment-only
nudge in `syncActivityPublicProfile`, both through the existing
`touchTeamForSurfaceRecompute`.

What it does NOT claim: that a given day has a free time. Expanding recurrence
against booked sessions is a request-time computation. The flag says a visitor
arrives at a configured picker rather than an empty state.

**A studio with the toggle on and nothing bookable sees a DIM row with "Set up"**
pointing at `/schedule/availability` — the hours are what is missing. With the
toggle off it points at `/settings/booking` instead. It is the only row on the
hub whose action switches, because it is the only one with two management homes.

**Not made a `PublicSurface`:** that would also put it in the default-landing
choices, the website header link derivation and the bio-link page-link picker.
The picker is a deep-link destination (activity/provider/date presets), not a
front door. Say if you want a bio-link "Book an appointment" target — that is the
change this deliberately did not make.

## 22. "Scheduling" in the settings rail is now two rows (UX-67)
**NOTED.** Event types and Booking page remain there. Only Places was used
mid-task while scheduling, so only Places moved — but a two-row group is worth a
second look.

## 23. One sticky bar still needs the mobile-header offset (UX-36)
**FOLLOW-UP, one line.** `components/howto/HowToToc.tsx:96` is `sticky top-0 z-20
… xl:hidden` — the section-tab strip on /how-to. It needs `top-14 md:top-0` or it
pins behind the now-sticky app header on phones. Reserved by another lane at the
time. `components/site/WebsiteRenderer.tsx:121` was deliberately left alone: it is
shared with public routes that have no app header.

## 24. /offer/activities has no quick link yet (UX-71)
**FOLLOW-UP.** It is the obvious fourth candidate — links now point AT it from
plans and availability, but it got none of its own because the file was reserved
by a concurrent lane. Its natural destination is `/schedule` ("See these classes
on the calendar").

## 25. `multiple_managers` is flagged at studio but ships at coach (UX-42)
**DECIDED 2026-08-18 — the flag is right; the invite moved to Studio.** Both
surfaces now READ `multiple_managers` instead of naming a tier, so they cannot
drift apart again. The removal speaks in the UX-42 `PlanUpgradeNotice` shape
(names the tier, carries the upgrade control) rather than hiding the button, and
the coaches page's dead-end refusal was converted to the same shape. **The gate
is on ADDING, never on being**: `requireExtraUserPlan` guards every
server seam that can create a seat (`sendTeamInvitation`, `acceptTeamInvitation`
— an invitation lives 7 days and the plan can change under it — and
`manageTeamMember` action `'add'`, which has no UI at all), while `remove`,
`updateRole` and `setCoach` stay open, nothing deletes a member on downgrade, and
a team that already has somebody in the Coach role keeps the roles editor
whatever its plan. **`firestore.rules` was TIGHTENED too** (not loosened): the
`team_members` write rule let an owner create somebody else's membership doc
straight from a client on any plan above Free — a seam no callable can defend —
and now names the same tiers, pinned to `PLAN_FEATURES` by
`packages/functions/src/teams/seatGate.test.ts`. **Deploy rules with the code.**

**Original note.** `PLAN_FEATURES` puts
`multiple_managers` at **studio**, while `/settings/members` unlocks invites at
**coach**. The roles page was gated at `coach` to match the behaviour the product
actually ships, rather than the flag. Decide which is true and make the other
agree.

## 26. Two dashboard cards draw a chart on zero rows (UX-46)
**FOLLOW-UP, small.** `ContactsSummaryCard` and `BookingsTrendCard` have no empty
state — they render axes and a flat line, which reads as a broken chart rather
than a new studio. Day one no longer shows them (the dashboard collapses to three
cards until the team has a contact or a session), so the case is now rare rather
than universal — but a studio that deletes its data still meets it.

## 27. Two holders of the contact-session storage contract (UX-88)
**FOLLOW-UP.** `apps/web/src/lib/contactSession.ts` (new) and
`PublicContactAuthProvider.tsx` both own load/save/clear against the
`linyup:space:session` key — and without a localStorage record a valid Firebase
session is ignored by every public surface. The provider was being edited by a
sibling lane at the time, so it was not pointed at the module. Its header names
the provider as the other holder. Import from it the next time either is touched.

## 28. `SectionEditor.tsx` is now mixed English/translated (UX-94)
**FOLLOW-UP.** That panel is otherwise hardcoded English; the new pricing-display
controls use `useTranslations('Website')`. Finish the file when someone owns it.

---

# Run complete — 2026-08-18

**98 of 101 findings fixed. 0 open. 3 partial**, each with its interim shipped and
its remainder stated:

- **UX-2** — the checklist measures existence, not outcome (a studio can complete
  it and have a class nobody can book). Interim: the misleading step landed
  somewhere that works. **Remainder:** make each step measure the outcome, not the
  document's presence. Note UX-27 found a second instance (`bioLink` reads "done"
  because `syncTeamPublicProfile` writes that mirror on every team write).
- **UX-4** — the recurring-series cliff is closed by a daily roller. **Remainder:**
  the series surface itself — list, edit-on-existing, make-this-repeat.
- **UX-7** — the trial is now stated. **Remainder:** the T-7 / T-1 reminders.

Everything else in this file is a decision or a follow-up, not a defect.

---

# Offerings review — 2026-09-17 (`docs/ux-review-2026-09.md`)

Parked during the autonomous run on the activities/plans review. Numbering
continues from the 2026-08 run.

## 29. Where the studio default drop-in is edited (UX-112)
**PARKED.** Two places edit `BookingSettings.dropIn`: Pricing → Drop-in (set, change,
turn off) and a class's pricing tab (set or change, never off). The reviewer
proposes Pricing becomes display-only and the class tab gains "turn off"; the
alternative is the reverse (Pricing owns it, the class tab only links). Either
satisfies "one place". *Meanwhile:* both stay, unchanged.

## 30. A plan that covers "all classes" by default (UX-114)
**PARKED — the highest-value model change in the review.** Today a plan stores no
scope; each class lists the plans that include it, so an unlimited membership
covers no class added after it was set up. Proposal (model review S2): a plan-side
scope, `all classes` (default for new memberships and passes) or `selected`, unioned
into the class's allowed plans by the snapshot loader so `resolvePaymentOptions`
is untouched. Questions for Franco: default `all` for new plans only, or also
migrate existing ones? Do workshops/events need an "excluded from all-classes"
flag on the class? *Meanwhile:* nothing built.

## 31. Trial on classes open to anyone, and one meaning of "newcomer" (UX-115)
**PARKED.** "First class free (or CHF 15), then CHF 25 drop-in for anyone" cannot
be expressed: the trial door opens only on members-only classes. Also three
definitions of "new": trial (`trial_used_at`), promo `new_contacts` (`!joined`),
purchase caps. Questions: should a class open to anyone with a paid drop-in offer a
trial? Should a contact who used a trial still count as "new" for a promo code?
Should the trial get a studio-wide default like the drop-in? *Meanwhile:* nothing
built.

## 32. Stored `per_class` plan prices (UX-104)
**ASSUMED.** `per_class` sells unlimited, never-ending access on linked classes.
Shipped: removed from the picker for new prices and from the AI drafter.
**Not done:** refusing checkout on an already-stored `per_class` price, or
converting them. The emulator and staging seeds ship a "10-Class Pack" priced
`per_class` (converting it to one-time + 10 credits changes which seeded contacts
are covered, since credits need grants); HMD migration
(`scripts/migration/transforms/subscriptions.ts`) can emit it, and some may be
tracking-only plans nobody buys online. Decide: refuse at checkout, convert
(seeds + a backfill), or leave.

## 33. The legacy class-gate backfill (model review S1)
**PARKED — needs a deploy window, not a design call.** Retires `accessRule.type` as
stored data, `isFreeTrial`, the legacy coverage engine and `dropIn` without
`mode`, by backfilling every class to `audience`/`requirePlan`/`dropIn.mode`.
Pre-launch, so acceptable; but it touches every environment's data and the mobile
app's readers were not reviewed. Decide when, and whether mobile needs a release
first.
