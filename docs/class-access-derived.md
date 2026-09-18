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

**Only an "Included" plan decides access.** A plan that merely earns a MEMBER
PRICE changes what its holders pay and never who may book, so a class with a
drop-in price and a discounting plan stays open to everyone — and a member price
has nothing to bite on once the drop-in is off. The two lists are already
separate in the data (`accessRule.subscriptionTypeIds` vs the benefit's
`subscriptionTypeIds`); this is the rule that keeps them apart.

- **Trial class for newcomers** is available whenever the class is **not free**
  (it has a drop-in price or a plan includes it) — including a class anyone can
  pay for. That is the "first class free, then pay per class" shape.
- **Only people who signed up with you** (More options, off by default) puts the
  members wall in front of all of it: visitors cannot book even paying; the trial
  still admits a newcomer once. It is the club case (registered members train,
  the public cannot).

**Screen order** (Franco, 2026-09-17): the summary sentence, then the drop-in
price, then the plan table, then the trial, then More options. The base price
comes before what plans change about it — and a member price is greyed out until
there is a drop-in to reduce, which is a puzzle if the plans come first.

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

A document written before the drop-in default names no `dropIn.mode` and so
FOLLOWS the studio (shipped with the default itself, #289). A studio that sets a
usual price therefore already turned every legacy `members` and `subscription`
class into a paid door; the backfill writes `mode` explicitly so that is stated
rather than inherited.

## Stages

Each stage leaves main green and deployable. Owners in brackets.

1. **Resolver** [shared] — DONE (`packages/shared/src/utils/classAccess.ts`,
   fixtures `packages/functions/src/offer/classAccess.test.ts`).
   `classAccessFacts(activity, studioDropIn)` answers the table in one call
   (resolved door, included plans, sign-up wall, plan-holders-only, free, trial
   available); `classAccessChip` names the two-word list chip;
   `classAccessRuleFor` is what every writer stores, so the derived answer and
   the stored `requirePlan` / `type` cannot disagree while both exist. Legacy
   documents still read through `resolveActivityAccessRule` until stage 5.
2. **Server** [functions] — DONE. `bookSession`'s trial door asks
   `classAccessFacts(...).trialAvailable` instead of `accessRule.type !== 'open'`,
   so a class anyone may book AND PAY FOR now takes a newcomer's trial; the AI
   offer drafter and the demo tenant write through `classAccessRuleFor`. The
   MIRRORS need no change: a mirror carries the RESOLVED drop-in and its access
   rule, so `classAccessFacts(mirror, null)` answers for a public reader exactly
   as it does for the admin one. The stored `isFreeTrial` / `type` fields go with
   stage 5's backfill, not here.
3. **Pricing tab** [web] — DONE. The tab reads: the derived sentence, the
   drop-in (usual / own / none), the plan table, the trial, then More options →
   the sign-up switch. The access cards and the "members without a plan" switch
   are gone; the draft holds `signupRequired` and nothing else about access, and
   both writers (`save` and the matcher's `onBeforeSave`) store through
   `classAccessRuleFor`. The catalogue chip and the Pricing page's doors and
   health loop ask `classAccessFacts`; `gated_empty_allowlist` is now unreachable
   and a fixture pins that. Tab descriptions → tooltip (`4cbb3b2b`).
   PUBLIC surfaces still read the stored `accessRule.type`, which every writer
   keeps in step — they move in stage 5, when the field goes.
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
