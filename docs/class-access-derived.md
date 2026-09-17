---
title: Who can book a class — derived from its prices, not asked
status: plan
area: product
---
# Who can book a class — derived from its prices, not asked

Agreed with Franco on 2026-09-17 from an interactive mockup: the class pricing tab
asks **no access question**. Who can book is worked out from what the studio
already answers — which plans include the class, whether there is a drop-in
price, whether there is a trial — plus one rarely-used switch under More
options. Context: `docs/ux-review-2026-09.md` (UX-115), open decisions 29–33 in
`docs/ux-review-open-decisions.md`.

## The rule

For a person with no plan that includes the class:

| Drop-in price | A plan includes it | They… |
|---|---|---|
| yes | — | pay the drop-in (anyone, no sign-up) |
| no | yes | cannot book — plan holders only |
| no | no | book free (the class is free) |

A plan holder books free ("Included"), at a member price (a discount on the
drop-in — offered only when there is one), or spends a class from a pack.

- **Trial class for newcomers** is available whenever the class is **not free**
  (it has a drop-in price or a plan includes it) — including a class anyone can
  pay for. That is the "first class free, then pay per class" shape.
- **Only people who signed up with you** (More options, off by default) puts the
  members wall in front of all of it: visitors cannot book even paying; the trial
  still admits a newcomer once. It is the club case (registered members train,
  the public cannot).

The pricing tab opens on one generated sentence — *"Unlimited monthly books free
· everyone else pays CHF 25 · newcomers: first class free"* — and the catalogue
chip says the same in two words (`Free for anyone`, `CHF 25 drop-in`,
`Plan holders only`, `Members · CHF 25`).

## What is stored

| Field | Now | After |
|---|---|---|
| `accessRule.audience` | `'anyone' \| 'members'` | kept — `'members'` is the sign-up switch; absent = `'anyone'` |
| `accessRule.subscriptionTypeIds` | plans that include it | kept, unchanged (the plan table writes it) |
| `accessRule.requirePlan` | stored answer | **removed** — derived: plans listed AND no resolved drop-in |
| `accessRule.type` | display projection + legacy tier | **removed** — derived for display only |
| `Activity.isFreeTrial`, `Session.isFreeTrial` | legacy spelling of "open" | **removed** |
| `dropIn.mode` | optional (absent → inferred) | **required** by the backfill; `dropIn.enabled` no longer stored |

`requirePlan` derived this way is exactly how the legacy `subscription` tier
already behaved (`resolveClassGate`: `requirePlan = !paidDoor`), so the resolver
change is a narrowing, not a new engine.

## Behaviour that changes

1. **A drop-in price now always opens the door.** "Members only + plan required +
   a drop-in price" (a price only discounted-plan holders could use) is no longer
   expressible. Backfill keeps the access and sets `dropIn.mode: 'off'`.
2. **Plans listed with no price means plan holders only.** "Plans listed, plan not
   required, no price" (free for everyone, so the plans did nothing) becomes plan
   holders only. Backfill keeps the free class and clears the plan list.
3. **The studio default moves access.** Setting or removing the usual drop-in
   price opens or closes every class that follows it and lists a plan. The drop-in
   modal (below) says how many classes that touches.
4. **A new class starts free and public** until it gets a price or a plan (today
   it starts members-only). Its chip says `Free for anyone`, and the setup
   checklist asks for the usual drop-in price early.

## Stages

Each stage leaves main green and deployable. Owners in brackets.

1. **Resolver** [shared] — `resolveClassGate` derives `requirePlan`; new
   `classIsFree(activity, studioDropIn)` and `classTrialAvailable(…)`; one
   `classAccessSummary(…)` producing the sentence parts and the chip kind, used by
   the form, the catalogue, the Pricing preview and the public cards. Legacy docs
   still read through `resolveActivityAccessRule` until stage 5 (the ONE place).
   Fixtures: the table above, the four behaviour changes, a guest paying the
   drop-in on a class that lists a plan (identity is only demanded of someone
   claiming coverage).
2. **Server** [functions] — `bookSession`'s trial door asks `classTrialAvailable`
   instead of `accessRule.type !== 'open'`; the activity and session mirrors stop
   writing `isFreeTrial` and `type` (they carry the summary kind instead); the AI
   offer drafter and the demo tenant write the new shape.
3. **Pricing tab** [web] — the mockup: summary sentence, plan table, drop-in
   (usual / own / none), trial, More options → sign-up switch. The access cards and
   the "members without a plan" switch go. Catalogue chips, the Pricing preview,
   the health checks (`gated_empty_allowlist` can no longer occur; it becomes a
   test that it cannot) and the public card lines move to `classAccessSummary`.
   Tab descriptions → tooltip (done, `4cbb3b2b`).
4. **Drop-in modal and the per-class leftovers** [web + scripts] — decision 29: one
   "Drop-in price" modal opened from the Offerings header and from a class's
   pricing tab (set, change, turn off, "follows it: N classes"); Pricing goes back
   to read-only. Decision 32: `per_class` removed from the type, the forms, the
   emulator and staging seeds, and the Swimli lead profile (local file).
5. **Backfill and delete** [scripts + shared] — `scripts/backfill-class-access.ts`,
   dry-run by default, through the Backfill workflow for staging and sandbox:
   every class gets `audience`, `subscriptionTypeIds` and `dropIn.mode` in the new
   shape with the mappings above, and loses `type`, `requirePlan`, `isFreeTrial`,
   `dropIn.enabled`; sessions lose `isFreeTrial`. Seeds, lead seeding and the HMD
   migration transform write the new shape directly. Then delete
   `legacyClassCoverage`, `hasModernGate`, `canonicalClassGate`, the
   `resolveActivityAccessRule` fallback and the stored `ActivityAccessTier`, with a
   census test that no class reader names them again.

The mobile app does not read a class's `accessRule` or `isFreeTrial` (checked
2026-09-17: its only mention is a comment in `utils/appointmentAccess.ts`), so no
app release is needed first. Course access tiers are a different enum and are not
touched.

## Not decided here

- Decision 34 — whether Pricing keeps "What you sell".
- Decision 31's promo half — whether a contact who used a trial still counts as
  "new" for a `new_contacts` promo code.
