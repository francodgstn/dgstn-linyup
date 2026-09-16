---
title: Seed alignment — Phase 1 audit
status: closed
area: ops
---
> ## CLOSED — archived 2026-08-24
>
> **Both phases are complete** (PRs #80, #81, #82). Phase 1 produced
> `docs/seed-truth-2026-08.md`, which is still live and still the schema reference.
> Phase 2 closed the gaps it found; only a snapshot re-bootstrap remained at the
> time of closing.
>
> **Do not re-run the audit prompt below.** It is written in the imperative and
> reads like open work — it is the record of what was asked for, kept so the
> reasoning behind the truth doc survives. The three migration bugs it surfaced
> were invisible in the Firebase console, which is why the record is worth having.

# Seed alignment — the Phase 1 audit

Four seeders (`scripts/seed-{emulator,lead,sandbox,staging}.ts`, ~430 KB total)
plus the HMD migration passes all answer the same question — "what does current,
correct tenant data look like?" — and have drifted apart independently, because
they share almost nothing but `scripts/lib/roles.ts`.

**The expensive part is not writing seed code. It is establishing the schema
truth ONCE.** Do it inside four sessions and you get four interpretations, which
is the drift you set out to remove. So Phase 1 produces a document, not code.

What follows is the prompt for that audit, written to be pasted into a fresh
session. It leads with `ultracode` because the fan-out is the point.

Parked 2026-08-19 while the go-live readiness work ran
(`docs/launch/readiness-2026-08.md`).

**Phase 1 is DONE** — the deliverable is `docs/seed-truth-2026-08.md`. It was run
as a single session rather than the fan-out this prompt describes; the prompt is
kept below verbatim as the record of what was asked for. Phase 2, which consumes
it, is appended at the end of this file.

---

# Phase 1 — seed coverage audit (paste into a fresh session)

ultracode

Audit how far our five data-authoring surfaces have drifted from the current schema.
**Analysis only — write no seed code, fix nothing, run no seeder and start no emulator**
(another session may hold the emulator ports). The single deliverable is
`docs/seed-truth-2026-08.md`.

## The five surfaces

| Surface | Entry point |
|---|---|
| emulator | `scripts/seed-emulator.ts` |
| sandbox | `scripts/seed-sandbox.ts` |
| staging | `scripts/seed-staging.ts` |
| lead | `scripts/seed-lead.ts` + `scripts/leads/types.ts` (+ gitignored `scripts/leads/*/profile.ts` if present) |
| migration | `scripts/migration/passes/*` + `scripts/migration/transforms/*` |

They share almost nothing (`scripts/lib/roles.ts`, and `lib/storefront|connect|exportConsentLedger`
in the lead seeder only), so they have drifted independently against one schema. Finding
*where* is the entire job.

## The spine

`packages/shared/src/paths.ts` exports ~110 `*_COLLECTION` / `*_SUBCOLLECTION` constants.
That list — derived programmatically from the file, not from memory — is the row set.
`packages/shared/src/tenantData.ts` classifies only the top-level ones (tenant / platform /
retired); use it to mark rows as tenant-scoped vs platform, but do **not** use it as the row
set: it deliberately omits subcollections, which is where most recent work landed.

Partition those constants into coherent domains (roughly: contacts & affiliations; sessions,
bookings & waitlist; activities, availability & appointments; courses & purchases; documents,
versions & waivers; payments, promo codes & gift cards; finance & accounting; team config,
plugins, integrations & messaging; events; org & platform). One agent per domain. **The union
of the partitions must be all ~110 constants — assert that, and log any constant no agent
owned.**

## Per row, answer

1. **Present in each of the five surfaces?** `PRESENT` / `MISSING` / `PARTIAL` / `N-A`.
   Every non-missing verdict needs a `file:line`. Grep for both the imported constant *and*
   the raw string literal — do not read 100 KB seeders end to end.
2. **Field-level gaps** for `PARTIAL`: which fields the app reads but the surface never writes.
   Ground each against the type in `packages/shared/src/types/` and a real reader
   (component, callable, or rule), with `file:line`.
3. **The screen that proves it** — the one admin or public surface that visibly breaks, or
   silently renders empty, when this row is absent. This column becomes the Phase 2
   acceptance checklist, so name a route, not a feeling.

## Also produce

- **Semantic invariants** that aren't collection-shaped. Check seeded data against the
  documented rules in `CLAUDE.md` and `docs/`, at minimum: the waitlist single-deadline rule;
  `bookings_count` written absolute, never incremented; subscription docs carrying the whole
  cancellation record (`cancel_at` / `canceled_at` / `cancellation_details`); contact status on
  the three axes rather than the retired `Contact.type` / `membership_*`; published documents
  having a `v0001` version to copy from; dynamic contact groups holding a rule and never
  materialised membership; appointment activities carrying `durations` + at most one
  `memberBenefit`.
- **Duplication register** — fixtures that appear in three or more surfaces in copy-pasted
  form, with the line ranges. This scopes a later `scripts/lib/fixtures/` extraction; do not
  propose or start that extraction here.
- **Ranked worklist per surface** — ordered by "how visibly broken is the demo", since these
  seeds exist to be shown to people. This is what the Phase 2 sessions will consume.

## Verification

Fan out an adversarial pass over the findings, in both directions, because they fail
differently: a false `MISSING` invents Phase 2 work, a false `PRESENT` ships a broken demo.
For each `MISSING`, hunt for counter-evidence that something does write it. For each
`PRESENT`, confirm the write is reachable — not dead code, not behind an unset flag, not in a
branch the default seed run skips. Drop or downgrade anything that does not survive.

## Constraints

- The working tree has an in-flight waiver-request feature that is **untracked**
  (`packages/functions/src/waivers/request.ts`, `requestEmail.ts`, `trackAcceptances.ts`,
  `consentLedger.ts`, `apps/web/src/components/contacts/AskToSignDialog.tsx`). Mark anything
  depending on it `PENDING`, not `MISSING`.
- `scripts/leads/*/profile.ts` is gitignored. If absent, audit the lead surface against
  `scripts/leads/types.ts` and say so explicitly rather than guessing.
- Follow the repo's own rule on censuses: name members, never assert a count of code sites in
  prose. The matrix is the census — everything else points at it.
- Mark anything you could not verify `UNVERIFIED` rather than inferring it. An honest gap is
  useful; a confident wrong row costs a Phase 2 session.

---

# Phase 2 — close the gaps (the seed-writing sessions)

Phase 1 established the schema truth once, in `docs/seed-truth-2026-08.md`. Phase 2
spends it. **Read that document, not this one, for what is broken** — the matrix
there is the census, and restating any part of it here would create the second
copy that goes stale.

## The rule that shapes everything below

**Four seeders, four sessions, and they collide at FILE level.** `seed-emulator.ts`,
`seed-sandbox.ts`, `seed-staging.ts` and `seed-lead.ts` are 2.7-3.5 KLOC each; an
agent reads the whole file, edits, and writes it back, so two sessions touching
entirely different functions in one file still silently lose one another's work —
exactly the failure the i18n `_pending/` fragment protocol exists to prevent.

So the lanes below are **cut by file, never by feature**. A lane owns whole files
for its whole run. A feature that spans all four seeders is fixed by extracting it
into `scripts/lib/` FIRST (Lane 0), which turns a four-file edit into a one-file
edit that the other lanes merely call.

## Lane 0 — extract, then everything else is cheap (do this first, alone)

Sequential prerequisite. Nothing else starts until it lands.

`docs/seed-truth-2026-08.md` → "Duplication register" names seven fixtures copied
across three or more surfaces. Extract the two that are both duplicated **and**
already divergent, into `scripts/lib/fixtures/`:

1. **`documents.ts`** — the documents seed plus its `versions/v0001` snapshot plus
   the `public_profile` mirror. `seed-emulator.ts` holds the correct version; the
   other three reproduce the state `backfill-document-versions.ts` exists to clear
   and copy raw HTML into the mirror. Lift the emulator's implementation, do not
   re-derive it, and keep its comment explaining why the version exists.
2. **`appointments.ts` (extend)** — the appointment ACTIVITY document and the
   `availability` template. `scripts/lib/appointments.ts` already owns the booked
   sessions; the activity and the availability window are still written inline
   three times.

Leave the other five duplications alone. They are duplicated but not divergent,
and extracting them is churn without a defect behind it.

Acceptance: `pnpm verify:waiver-ledger` is clean after a fresh run of every
seeder, and each seeder reaches `status: 'published'` on a document only through
the shared writer.

## Lanes 1-5 — one owner per file, run in parallel after Lane 0

| Lane | Owns (exclusive) | Works from |
|---|---|---|
| 1 | `scripts/seed-emulator.ts` | the "emulator" worklist in the truth doc |
| 2 | `scripts/seed-sandbox.ts` | the "sandbox" worklist |
| 3 | `scripts/seed-staging.ts` | the "staging" worklist |
| 4 | `scripts/seed-lead.ts` + `scripts/leads/types.ts` | the "lead" worklist |
| 5 | `scripts/migration/**` | the "migration" worklist |

Each lane works its own ranked list top-down and stops when it runs out of time,
not when it runs out of list — the lists are ordered by demo visibility precisely
so that a partial lane still lands the things a prospect sees.

**Lane 4 has an extra constraint**: `scripts/leads/*/profile.ts` is gitignored, so
anything a lead tenant needs must be expressible in `scripts/leads/types.ts` and
must degrade to "absent" when a profile omits it. A lane-4 change that only works
with a local profile in place is not shippable.

**Lane 5 has an extra warning**: the pass-through subcollection list in
`passes/11-team-subcollections.ts:9-23` copies HMD's shape with no transform, and
whether those shapes still match today's schema is the largest `UNVERIFIED` area
in Phase 1. Verify against the HMD source before writing a transform, or leave it
and say so.

## Lane 6 — the cross-surface features (sequential, after Lanes 1-5)

These are single features absent from ALL five surfaces, so they cannot be split
by lane. Each is one session that adds one shared fixture in `scripts/lib/` and
one call per seeder. Ranked:

1. **Waivers.** The single largest hole: no `kind: 'waiver'` document, no
   `waiver_policy/current`, no `signers`, no `acceptances`, anywhere. Because the
   gate fails CLOSED on an absent policy, every seeded tenant silently behaves as
   "no waiver required", which means the feature is neither demoable nor
   rehearsed. Seed one waiver document with a policy and a mix of signature states
   (valid / expired / revoked / superseded) so `waiverAcceptanceState`'s fixed
   order is visible on a real roster. **Write through the same shapes
   `packages/functions/src/waivers/accept.ts` writes** — a seed that invents its
   own row shape is how the ledger verifier learns to be ignored.
2. **Event programmes.** `program_items` on one multi-day event, plus one
   `program_templates` entry, plus one `org_program_templates` entry so the
   org-applies-to-studio flow has something to apply. Times are WALL-CLOCK
   strings; do not write `Timestamp`s.
3. **Waitlist.** One full class with a queue, and one offered seat holding the
   single-deadline invariant (`resolveClaimWindow` computes it once; the seed
   must copy it, never recompute it).
4. **The money ledger** (decision 1 below). `member_subscriptions` and
   `member_payments`, seeded together with the bookings they pay for, in the
   shapes the Connect webhook writes. At least one subscription seeded as
   CANCELLING, with the whole record — that is the only way `cancel_at` /
   `canceled_at` / `cancellation_details` ever render.
5. **`course_purchases`.** One contact who has bought the `purchase`-tier course
   that already exists in the shop, so the Space unlock state renders.
6. **Promo codes** (decision 3 below). One active code in the shared storefront
   helper, so it reaches every tenant that already has a shop from one place.
7. **Finance** (decision 2 below), sandbox and lead only: the plugin, a journal
   and a chart of accounts. Never the cron-regenerated rollups.
8. **`contact_notes`** and a **dynamic contact group** (a group carrying a `rule`,
   with membership never materialised) — two small, high-visibility gaps.

## The five decisions — SETTLED 2026-08-19 by Franco

These were parked out of the lanes because settling them inside a session is how
four sessions end up with four answers. They are now answered. **A lane does not
reopen them**; if one turns out to be wrong, change it here first and say so.

### 1. Do the seeds get fake money? — **YES**

Seed `member_payments` and `member_subscriptions`, which also gives
`Contact.subscription_status` and `Contact.active_subscriptions` real values and
fills `/payments` and the contact Payments tab.

This **reverses** the rule stated in `scripts/lib/appointments.ts:15-20` ("seeded
bookings are always free-path-shaped, because a paid one would need a matching
webhook-written `member_payments` ledger row"). The reason for reversing it is
that the rule was written to avoid fabricating a half-record, and the answer to a
half-record is the whole record, not an empty screen — a blank payments dashboard
is the most damaging thing a prospect can see in a payments-first product.

So the obligation the old rule was protecting still binds, and gets stricter:

- **A paid booking and its ledger row are seeded together or not at all.** Never
  a `payment_status` on a session with no `member_payments` doc behind it.
- **Write the shapes the Connect webhook writes** (`packages/functions/src/connect/webhook.ts`),
  not invented ones — the same discipline the waiver seed needs.
- **Update the comment in `scripts/lib/appointments.ts`** in the same change that
  breaks its rule. A stale prohibition next to code that violates it is worse
  than no comment.
- A subscription seeded as **cancelling** is the point of the exercise, not a
  detail: it is the only way `cancel_at` / `canceled_at` / `cancellation_details`
  and the `payment_failed` vs `cancellation_requested` distinction ever render.
  Write the record whole, nulls included.

### 2. Finance plugin in demo scope? — **SANDBOX AND LEAD ONLY**

Install the plugin and seed the journal plus the chart of accounts on the two
surfaces prospects actually look at. Emulator and staging stay lean.

Do **not** seed `finance_monthly_reports` or `accounting_period_summaries`: both
are regenerated from the journal by cron and always overwritten.

### 3. Promo codes in demo scope? — **YES, ONE PER STOREFRONT TENANT**

Seeded in the shared storefront helper (`scripts/lib/storefront.ts`), so it
reaches every tenant that already gets a shop, on every surface, from one place.
Install the `promo-codes` plugin alongside it.

The code is a Stage A **modifier**, so nothing else needs seeding for it to
show — no redemption ledger, no reservation state. Seed the `promo_codes/{CODE}`
document and stop; `redemptions/{identityKey}` stays server-written.

### 4. Does staging stay Connect-unwired? — **YES, LEAVE IT OFF**

The reasoning in `seed-staging.ts`'s header still holds: staging is a real
deployed project sharing one Stripe TEST platform with sandbox, so attaching the
same test account moves `connect_accounts/{acct}.teamId` away from sandbox and
leaves both webhook endpoints receiving each other's events.

Staging therefore shows no priced doors, and that is correct rather than broken.
Sandbox and lead remain the surfaces where payments are demonstrated. This answer
changes only if staging is given its own dedicated onboarded test account, which
is a Stripe-side setup task and not a seeding one.

### 5. How far does the fixture extraction go? — **THE TWO DIVERGENT ONES**

Lane 0 as written: `documents` and the appointment activity/availability pair.
The other five duplications in the register are duplicated but not divergent, and
extracting them is a refactor of four large files with no defect behind it.


## Acceptance

Phase 2 is done when, for every row the truth doc marks `MISSING` and Phase 2
chose to close, the named screen in its "the screen that proves it" column renders
real content on a fresh run of the surface. That column was written to be a
checklist; use it as one, and record the rows Phase 2 deliberately left alone
rather than quietly dropping them.

## What Phase 2 landed — 2026-08-19

Branch `claude/seed-truth-audit`. Every fixture below was verified by seeding
into an ISOLATED Firestore-emulator project namespace (`seedcheck-tmp`), so no
running emulator's data was touched, and the results are quoted in each commit
message rather than assumed.

**Lane 0 — the extraction.** `scripts/lib/fixtures/documents.ts` is now the one
writer of a seeded published document (document + frozen `v0001` + public
mirror), lifted from the emulator rather than re-derived. All four seeders call
it. `scripts/verify-waiver-ledger.ts` reports clean on freshly seeded data — the
Lane 0 acceptance criterion.

**Lane 6 — the cross-surface features.**

| Feature | Where it lives now |
|---|---|
| Waivers — document, policy, and signatures in valid / guardian / expired / revoked states | `lib/fixtures/documents.ts` → `seedTeamWaiver` |
| The money ledger — `member_subscriptions` + `member_payments`, one subscription CANCELLING with the whole record, one in dunning | `lib/fixtures/money.ts` |
| Finance — plugin, chart of accounts, journal replayed from the ledger (sandbox + lead only) | `lib/fixtures/finance.ts` |
| Promo codes — one live code per storefront tenant | `lib/storefront.ts` → `seedStorePromoCode` |
| Contact notes, a DYNAMIC contact group, a waitlist queue, an event programme, a course purchase | `lib/fixtures/engagement.ts` |

**Three things that fell out of doing it**, each worth more than the row it came
from:

- `rollupMemberSubscriptions` moved into `@linyup/shared`, and
  `onMemberSubscriptionWrite` is now a thin wrapper over it. A seed writing
  through the Admin SDK fires no trigger, so it must leave the contact in the
  state the trigger would have produced — and computing that separately is the
  exact divergence this whole phase is about.
- `scripts/` was never typechecked (`turbo run typecheck` only sees workspaces,
  and `scripts/` is not one), which is a root cause of the drift the audit
  catalogues. `pnpm typecheck:seeds` now covers the four seeders and everything
  under `scripts/lib/`, and CI runs it.
- Only the lead seeder ever wrote `max_participants`, so on every other surface
  no class could be full — the precondition for the waitlist gap, sitting behind
  it unremarked. The waitlist fixture seeds a capacity when a session has none.

## The lanes — closed 2026-08-19

Phase 2's per-surface lanes ran in parallel, one owner per file, and closed most
of the list this section used to hold.

| Lane | File | What landed |
|---|---|---|
| 1 | `seed-emulator.ts` | `activity_log`, `monthly_scores`, `contact_alerts`, a year of `team_weekly_reports`, the automations set — plus the `gamification` plugin, without which the seeded scores would have produced a leaderboard nobody can open |
| 2+3 | `seed-sandbox.ts`, `seed-staging.ts` | places (with the public `mainAddress` mirror), a recurring session series, gift cards — via `lib/fixtures/studio.ts`, because both lanes needed the same helper |
| 4 | `seed-lead.ts` | `automation_logs` derived from facts the seeder already wrote, and `alert_presets` that are now the ONE definition of the alerts seeded further up |
| 5 | `scripts/migration/**` | two real defects — see below |

**Lane 5 found bugs, not gaps.** The migration hand-wrote
`active_public_surfaces.shop = true`, but that flag means "can this studio BE
PAID" (`shopActive = paymentsEnabled` in `syncTeamPublicProfile`), whose own
comment records that an earlier version lit it from plugins and put buy buttons
in front of visitors that the callable refused — UX-33. And a migrated
automation rule silently never fired: hmd-lineup writes
`portal_booking_no_show`, the canonical name is `bio_link_booking_no_show`, and
the engine's legacy alias checks for `portal_booking_pending`, a name hmd-lineup
itself already retired. Both fixed; the retired `contact_type` /
`membership_status` conditions are deliberately NOT guessed at, because the
engine already fails closed there for a recorded reason.

## What is still open

- **Persistent SNAPSHOTS are stored data and no code change reaches them.**
  `pnpm emulators:demo` / `:swimli` / `:hmd` import from `snapshots/`, which is
  gitignored. `snapshots/hmd-migration/` in particular was produced by the OLD
  migration, so it still carries the forced-live shop and the never-firing
  automation rule Lane 5 fixed. **Re-bootstrap each snapshot to pick any of this
  up** — nothing in this repo can do it for you.

## Closed since, with what closing it taught

- **The duplication these lanes created is gone.** `monthly_scores`,
  `contact_alerts` and `seedAutomations` now live once in
  `lib/fixtures/automations.ts`, with the VOCABULARY (`martial_arts` vs
  `generic`) as the only parameter — 784 lines out, 33 in. The copies had already
  diverged on something real: a `datetime` contact alert carried an actual
  instant in one seeder and `null` in another, which is a dated reminder with no
  date.
- **`superseded` is now reachable.** It could not be faked, because supersession
  is derived rather than stored — so the fixture publishes a real second version
  with `require_resign`. The precedence order (none → revoked → superseded →
  expired → valid) decides the fixture's shape: a v1 row that is also expired
  reads as superseded and the expiry never shows, so only ONE row stays at v1.
- **`seedFreeTeam` and `seedOrg` needed nothing.** Recorded here because it looks
  like a gap and is not: `PLAN_FEATURES.free` carries no `outreach_templates`,
  no automation flows and no gamification, so a sparse free tenant is the
  CORRECT demo of the free plan rather than a missing seed.

- **The pass-through subcollections are no longer UNVERIFIED.** All of them were
  checked field-by-field against the HMD source; five were broken and are fixed,
  and the findings are recorded in `scripts/MIGRATE-HMD.md`. The one worth
  knowing here: `public_profile` was REMOVED from the pass-through, because
  hmd-lineup stamps `doc_type: 'team'` while every `/public/{slug}/*` route
  resolves a studio through `where('type', '==', 'team')` — a raw copy 404s the
  studio's entire public surface. Nothing is lost by dropping it: HMD's own
  writer builds that document purely from the team doc, which the migration
  already copies, so `syncTeamPublicProfile` recomputes it. On a local emulator
  that means functions must run at least once.
