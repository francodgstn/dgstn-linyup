---
title: Multi-plan holdings
description: Multi-plan holdings — a contact holds a LIST of plans
status: plan
area: payments
order: 7
---
# Multi-plan holdings

Status: **built, phases 0–5** — the guard, the store and mirror, the writers,
every reader (coverage and pricing, the security rules, the public session,
automations, analytics, the history reconciler, the AI dossier and the UI) on
the plan list, and the single plan slot removed. Option B, chosen by Franco on 2026-09-13 over the
minimal option (stop Stripe events writing the single plan slot). All four
decisions settled the same day — see §7.

**Why this is worth the work.** Pricing and offer flexibility is where Linyup
should be strongest: a member can hold a studio membership, a partner-app pass,
an intro offer and a credit pack at the same time, each with its own end, its own
limits and its own benefits, and the studio can see and change each one on its
own. Other systems struggle here. Today Linyup half-supports it — and the half
that is missing is the part a studio touches.

---

## 1. Today

A contact's plans come from three stores, and only two of them are lists:

| Holding | Authoritative store | Mirror on the contact | Shape |
|---|---|---|---|
| Stripe membership | `teams/{t}/member_subscriptions` | `active_subscriptions[]` (onMemberSubscriptionWrite) | list, one per type |
| Credit pack | `contacts/{c}/credit_grants` | `credit_summary[]` (onCreditGrantWrite) | list, one per type |
| Everything else — staff-assigned, one-off purchase, own-gateway payment, import | **none** | `subscription_type_id` + name, price, recurrence, amount, expiry, source ref | **one slot** |

The slot is documented as the "primary / most-recent snapshot"
(`types/contact.ts`). In practice it is last-writer-wins, and its writers
overwrite each other:

- **`writeContactSubscriptionFields`** (`functions/src/payments/effects.ts`),
  reached from `applyPaymentEffects` (manual payment, payment edit, Connect
  one-off) and from the Connect webhook's `applyMembership` — which runs on
  **every active or trialing Stripe subscription event**. A staff-assigned plan
  held alongside a Stripe plan is overwritten the next time Stripe writes.
- **Own-gateway webhooks** (`billing/handleTeamStripeWebhook.ts`,
  `billing/handlePayrexxWebhook.ts`) overwrite `subscription_type_id` alone, so
  the stored NAME stays the previous plan's.
- **`reversePaymentEffects`** (`payments/reversal.ts`) clears the slot when its
  source ref matches the refunded payment.
- **Staff**: the plan dialog on the contact page writes the slot from the
  browser and replaces whatever was there; by default it also cancels **every**
  live Stripe subscription. Bulk assign on the contacts list replaces too.
- **Scripts**: the HMD migration transform, `repair-hmd-subscriptions`, every
  seeder, and `ops/demoTenant`.

The authoritative list is `packages/functions/src/contacts/legacyPlanSlot.test.ts`
(phase 0). The bullets above are its narrative; where they disagree, the test
is right.

What already works on the full set: booking coverage, drop-in and appointment
pricing, the contact filter, automations, the session roster check, and
`subscription_history` (one row per held type since 2026-08-29). They union the
three sources, through `heldSubscriptionTypeIds` or hand-written copies of it.

What reads only one plan, and so misstates a member with several:

- **Access**: the course read rule and course media rule (`firestore.rules`,
  `storage.rules`); the held price id in `booking/access.ts`; the course
  checkout's primary-type workaround.
- **Public**: shop and booking-form snapshots, `claimCheckoutSession`.
- **Pricing order**: `resolvePaymentOptions` takes the FIRST allowed plan in the
  rule's list, so a limited allowance can be spent while an unlimited plan would
  have covered the booking.
- **Display**: header chips, facts line, contacts-list badge, member Space card
  (the slot vanishes once any Stripe plan exists); the Subscription card on
  Current (slot only); Payments → Subscriptions (one row per contact);
  dashboard "subscribed" (slot only) vs. the donut and trend (Stripe only); CSV
  export; the mobile profile; the AI summary dossier.
- **Warnings**: `contactBillingIsUnlinked` flags a staff plan held beside a
  different Stripe plan as orphaned billing.

Snapshot of the slot's reach on 2026-09-13, for scale only — the census test in
phase 0 is the owner, not this table:

| Area | Files | Lines |
|---|---|---|
| shared | 11 | 116 |
| functions | 31 | 145 |
| web | 22 | 120 |
| mobile | 2 | 6 |
| scripts | 11 | 96 |
| rules | 2 | 8 |

---

## 2. Target model

### 2.1 One new store: `contacts/{c}/plan_grants/{grantId}`

Every holding that is not a Stripe subscription or a credit pack becomes a grant
row. Stripe subscriptions and credit packs keep their stores.

```ts
interface PlanGrant {
  teamId: string
  subscription_type_id: string
  subscription_type_name: string | null
  price_id: string | null
  recurrence: string | null
  amount: number | null            // major units, as today's slot
  source: 'staff' | 'purchase' | 'gateway' | 'import'
  source_ref: string | null        // payment doc id that created it, or null
  starts_at: Timestamp
  expires_at: Timestamp | null     // null = no end of its own
  ended_at: Timestamp | null       // set by staff "end", a refund, or a change
  ended_reason: 'staff' | 'refund' | 'changed' | null
  created_by: string | null        // uid, or null for a payment rail
  created_at: Timestamp
}
```

- **Doc id** is the payment ref when a payment made it (idempotent against
  redelivered webhooks, the same idiom as `credit_grants` and `plan_purchases`),
  otherwise an auto id.
- **Rows are events, never edited into a different plan.** Changing a plan ends
  one row and creates another, so history and refunds stay exact.
- **Client writes are denied** by the rules; staff act through callables.
  Read access: team staff with contact access. The member reads the mirror, not
  this subcollection.
- `plan_purchases` stays what it is — the "buy once" allowance ledger — and is
  not repurposed.

### 2.2 One mirror, one writer: `held_plans` on the contact

```ts
interface HeldPlan {
  subscription_type_id: string
  subscription_type_name: string | null
  source: 'grant' | 'stripe' | 'credits'
  grant_source?: PlanGrant['source']
  status: 'active' | 'trialing' | 'past_due' | 'paused' | 'cancelling'
  starts_at_ms: number | null
  ends_at_ms: number | null          // grant expiry, Stripe end date, next credit expiry
  next_charge_at_ms?: number | null  // Stripe only: the period end it renews at
  price_id: string | null
  amount: number | null
  recurrence: string | null
  credits_remaining?: number
  ref: string                        // grant id, Stripe subscription id, or type id for credits
}

Contact.held_plans?: HeldPlan[]
Contact.held_plan_type_ids?: string[]          // flat, for rules hasAny + array-contains queries
Contact.held_plans_next_change_at_ms?: number | null
```

Times are **epoch milliseconds**, not Timestamps, for the reason
`ActiveSubscriptionSummary.cancels_at_ms` gives: this is a display mirror
inside an array, compared whole by value, and a pure builder in
`@linyup/shared` cannot mint an SDK Timestamp.

- **`recomputeHeldPlans(contactId)`** is the ONE writer. It reads the three
  sources and writes the three fields whole. The existing credit-grant and
  member-subscription triggers call it, and a new `plan_grants` trigger does
  too. `active_subscriptions` and `credit_summary` stay as they are until every
  reader has moved.
- An entry is **current at recompute time**: ended grants, lapsed grant expiries
  and exhausted or expired credits are left out.
- `held_plans_next_change_at_ms` is the earliest future instant the list changes
  on its own — a grant starting or ending, a credit pack expiring — so a sweep
  can find the contacts whose mirror is about to go stale. Stripe changes arrive
  as webhook events and trigger a recompute, so they are not counted.

### 2.3 Expiry stays lazy where it can, and refreshes where it cannot

The rule was "enforced by comparison, never by a job": every coverage reader
called `planGrantIsCurrent` on the slot. That stays for every server and client
reader — they compare `ends_at` live, generalised as `holdingIsCurrent(entry, now)`.

Security rules cannot compare per list element. So `held_plan_type_ids` is only
as fresh as the last recompute, and a **daily per-tenant job** (the
`dispatchTenantJob` pattern) recomputes every contact whose
`held_plans_next_change_at_ms` has passed. The recompute also closes the lapsed
plan's history row, which fixes the "a lapsed grant still shows Active" defect
for free. See decision D1.

### 2.4 The legacy slot is removed, not derived

Linyup is pre-launch: the only data is seeds, lead sandboxes and the HMD
migration, and no member app is installed anywhere that matters (decision D2).
So there is no transition to carry. Readers move to `held_plans`, the
`subscription_type_*` fields stop being written and read, and the backfill
converts what the existing datasets hold. No derived "primary" is kept.

### 2.5 Best plan, not first plan

`resolvePaymentOptions` chooses among held plans by value, not by the order of
the rule's list (decision D3):

1. unmetered and unlimited;
2. unmetered and limited, with allowance left — most remaining first;
3. credits — the pack expiring soonest first, so credits are not left to lapse;
4. benefits — the lowest resulting price.

Fixtures in `functions/src/booking/paymentOptions.test.ts` pin each ordering.

---

## 3. Writers after the change

| Writer | Today | After |
|---|---|---|
| Staff plan dialog | client write replaces the slot; cancels all Stripe billing | `assignPlan`, `endPlan`, `changePlan` callables (scope checked); stopping billing names the one subscription |
| Bulk assign | client write replaces the slot | `assignPlan` per contact, adding by default |
| `applyPaymentEffects` | writes the slot | creates a grant, id = payment ref |
| Connect one-off `applyMembership` | writes the slot | creates a grant, id = payment ref |
| Connect recurring `handleSubscription` | writes the slot on every active event | writes nothing on the contact once the rules read the plan list (phase 3); the member-subscription mirror covers it |
| Own-gateway webhooks | overwrite the plan id only | create a grant, id = payment event id |
| `reversePaymentEffects` | clears the slot on a matching ref | ends the grant whose `source_ref` matches |
| Connect `handleInvoice` (renewal charges) | stamps plan type and name on the payment | also stamps the Stripe subscription id, so a charge links to its plan card exactly (§5) |
| HMD migration, seeds, demo tenant | write the slot | write grants |

**The bridge.** Until phase 3 moves the readers, every server writer keeps
writing the slot beside its grant, as it did before. Nothing derives the slot
from the grants, and phase 5 removes it. Recurring Stripe events keep their slot
write until phase 3b, because the course rules read only the slot until then.

---

## 4. Readers after the change

- **Coverage and pricing**: `loadContactPaymentSnapshot`, the web payment
  snapshot and `heldSubscriptionTypeIds` read `held_plans`; the held price id
  comes from the entry, which removes the primary-only price lookup.
- **Rules**: course read and course media use
  `held_plan_type_ids.hasAny(...)`; the course checkout workaround goes.
- **Public**: shop, booking form and checkout claim read the held list.
- **One shared reader** for the contact filter, automations, analytics,
  dashboard figures and CSV export, so "subscribed" means one thing everywhere.
- **History reconciler**: its held set is the mirror, grants' own ends included.
- **Mobile**: the profile lists every held plan. JS only, so an OTA update if the
  fingerprint is unchanged.
- **AI summary dossier**: lists every held plan with its source and end.

---

## 5. UI

- **A plan and the billing that pays for it are ONE card.** A Stripe
  subscription is how a plan is paid for, not a separate thing, so it is never
  listed apart from its plan. The card leads with the plan — its name and what
  it gives — and then its billing: amount and interval, status, next charge or
  end date, and the actions that act on that subscription alone (freeze,
  resume, cancel). A one-off purchase reads "Bought {date} for {amount}" and
  links to that payment; a staff grant says who assigned it and when. Every
  card lists its own payments, and every payment row on the Payments tab links
  back to the plan card it paid for.
  - *Exact for grants* — the grant's `source_ref` is the payment.
  - *Exact for Stripe charges* once renewal payments record their subscription:
    today `handleInvoice` stamps the plan type and name on the payment but not
    the subscription id, so phase 2 adds it. Rows written before that fall back
    to matching by plan type.
- **Current segment — one Plans list.** A card per holding, labelled by source
  (assigned, bought, Stripe billing, credit pack), with its own status, next
  charge or end date, lessons left where relevant, and its own actions: end or
  change a grant; freeze, resume or cancel that one Stripe subscription; grant
  credits. Replaces the separate Subscription card, credits card and billing
  section. "Add plan" is the primary action.
- **Everywhere a contact is summarised** — header chips, contacts-list badge,
  member Space — every held plan, with a +N overflow.
- **Payments → Subscriptions**: one row per subscription, not per contact, so a
  second subscription's failed payment reaches "needs attention".
- **Dashboard**: one "subscribed" definition across figure, donut and trend.
- **Billing warning**: flags only Stripe billing for a type the contact holds in
  no other way.
- **CSV**: a plans column listing every held plan.

---

## 6. Phases

Each phase is its own PR and leaves `main` shippable.

0. **Guard.** Decisions are settled (§7). `contacts/legacyPlanSlot.test.ts`
   pins every writer of the legacy slot, so a new one fails the build (PR #348).
1. **Store and mirror.** `PlanGrant` and `HeldPlan` types; rules for
   `plan_grants`; `recomputeHeldPlans` with its triggers; a backfill that
   creates one grant per contact from today's slot
   (`source: 'import'`, source ref preserved). Deploy rules, then functions, then
   the backfill through the Backfill workflow. Nothing reads the new fields yet.
2. **Writers.** `assignPlan`, `changePlan` and `endPlan` replace the browser's
   slot writes; payment effects, Connect one-off and own-gateway webhooks create
   grants keyed by the payment; reversal ends the payment's grant; first and
   renewal charges record their Stripe subscription id; client writes to the
   slot are denied by rules. Every server writer keeps its slot write as the
   bridge. The seeders, the demo tenant and the HMD migration (pass 17) import
   the slot as a grant through `scripts/lib/planGrantImport.ts`, so a re-import
   after the production cutover produces the new shape.
3. **Readers**, in four PRs. None falls back to the slot for a contact with no
   `held_plans`: such a contact holds nothing, so the phase 1 backfill
   (`pnpm backfill:plan-grants`) must have run on a dataset before 3a reaches it.
   - **3a. Coverage and pricing.** The best-plan resolver (D3).
     `holdingIsCurrent` is the one "held now" comparison. `heldSubscriptionTypeIds`,
     the contact filter's subscriptions dimension and `loadContactPaymentSnapshot`
     read the list; the snapshot classifies every held plan by the price its own
     entry carries, and gives each credit pack its expiry.
   - **3b. Rules.** Course read and course media use
     `held_plan_type_ids.hasAny(...)`; the daily expiry refresh job; the course
     checkout workaround goes; recurring Stripe events stop writing the slot.
     **Built (2026-09-25):** `callerHeldPlanTypeIds()` in `firestore.rules` and
     `storage.rules`; the daily `refreshHeldPlans` job
     (`dailyTasks/refreshHeldPlans.ts`, one `heldPlansForTeam` task per tenant,
     indexed on `teamId` + `held_plans_next_change_at_ms`); the course checkout
     refuses an entitled buyer when the covering type is on the mirror, not
     only the slot. Recurring Stripe events stop writing the slot with the rest
     of the writers, in phase 5.
   - **3c. Public.** The contact session carries the held list; shop, booking
     form, checkout claim and the Space membership card read it.
   - **3d. The rest.** Automations and contact-write events, analytics and
     dashboard figures, CSV, the contacts-list badge, the billing warning, the
     history reconciler, the AI summary dossier, mobile.
     **Built (2026-09-25):** the automation conditions (`subscription`, its
     aliases and `subscription_expires_in`, which now matches when the member's
     memberships all end and the last ends inside the window) read the plan
     list; the plan events (`subscription_added` / `_removed` / `_changed`)
     diff the stored `held_plan_type_ids`, so the daily refresh fires them for a
     lapsed grant (`automation/contactEvents.ts`); the contact activity log's
     plan change and the weekly report's "subscribed" read the list; the AI
     summary dossier lists every membership with how it is held and its end.
     The history reconciler moves in phase 5, with the seeders it shares a
     fixture with.
4. **UI.** The Current Plans list and dialogs; header, list, Space, Payments tab
   and dashboard; mobile profile.
   - **Built (2026-09-25): the Current Plans list.** One card per `held_plans`
     entry (`contacts/[id]/PlansList.tsx`), labelled by source, its status only
     when not the normal one, and its own menu: freeze / resume / cancel THAT
     Stripe subscription, change / end THAT grant, grant credits. "Add plan"
     adds (`assignPlan`, `replace: false`) and never touches billing; the old
     dialog's replace-everything save and its cancel-all-billing default are
     gone. Ended Stripe billing keeps its cancellation record under the list.
   - **Built (2026-09-25): payment ↔ plan-card links** (`planCardForPayment`,
     `apps/web/src/lib/payments.ts`) — each card lists its payments, each
     payment row opens its card.
   - **Built (2026-09-25): the display surfaces read the list** through
     `heldMemberships` (shared, planHoldings.ts — every current held plan but
     credit packs, the one "subscribed" definition for display): the contact
     header chips and facts line, the contacts-list badge, the member Space
     card and its "change subscription" link, Payments → Subscriptions (one row
     per held plan; "unlinked" = live Stripe billing no plan list knows about),
     and the dashboard's figures, donut and overview card.
     **The billing warning is dropped** (Franco, 2026-09-25):
     `contactBillingIsUnlinked` and the `billing_unlinked` attention reason
     compared Stripe billing to the legacy slot, and with a plan list a Stripe
     subscription IS a held plan, so there is nothing for it to diverge from.
     Payments → Subscriptions still flags live billing no plan list knows about.
   - **Built (2026-09-25): the contacts CSV** (`toContactsCsv`,
     `packages/shared/src/utils/contactsCsv.ts`). One `plans` column lists every
     plan held at export time — name, how it is held, a non-normal status, the
     credits left, the end date — and replaces the slot's `subscription_type`,
     `subscription_status` and `subscription_amount` columns.
   - **Built (2026-09-25): the mobile profile** (`resolveHeldPlanSummary`,
     `apps/mobile/src/utils/profileUtils.ts`). The plan row on the member's
     profile reads `heldMemberships`: the one plan's name and recurrence, or the
     first name with `+N` when there are more. The legacy slot and
     `active_subscriptions` are no longer read there. Phase 4 is done.
5. **Remove the slot.** Delete the `subscription_type_*` fields from the
   Contact type, the rules and every remaining reader; the census test's
   allow-list ends empty. No adoption wait — nothing is live.
   **Built (2026-09-25):**
   - No server writer touches the slot: payment effects, the Connect webhook,
     the own-gateway webhooks and the staff callables write only grants (and
     `last_payment_at`); a refund ends the payment's grant and never writes the
     contact; `writeContactSubscriptionFields` and `planGrantIsCurrent` are gone.
   - The history reconciler reads the stored plan list (memberships only), so
     the daily refresh closes a lapsed grant's row.
   - Seeders give a contact a staff grant (`seedPlanGrant`,
     `scripts/lib/planGrantImport.ts`) and finish with `rebuildPlanLists`; the
     money fixture replaces a seeded grant with the Stripe subscription it
     seeds for the same plan. The HMD migration writes the plan as a grant in
     pass 05 (no made-up `active_subscriptions` row, which had also made the
     old import skip the grant) and pass 17 builds the lists.
     `repair-hmd-subscriptions` is deleted.
   - The Contact type, field catalogue and filter subject no longer declare the
     fields. The rules keep refusing client writes of them. Old documents may
     still carry them; nothing reads them, and `backfill:plan-grants` still
     imports one found on data written before this phase.
   - `contacts/legacyPlanSlot.test.ts` now pins that nothing writes the slot.

---

## 7. Decisions (settled by Franco, 2026-09-13)

- **D1 — rules freshness: the daily per-tenant refresh.** A rules-gated course
  read can outlive a lapsed grant by up to a day; bookings and pricing compare
  live. Rejected: course content behind a callable (a round trip per lesson).
- **D2 — no derived primary.** Pre-launch, so there is no installed base to
  carry: the slot is removed rather than kept in sync (§2.4, phase 5).
- **D3 — best-plan order** as in §2.5: unlimited, then limited with the most
  allowance left, then the credit pack expiring soonest, then the lowest
  benefit price.
- **D4 — two grants of the same type may coexist** as rows, merged in the
  mirror into one entry per type with the latest end.

## 8. Risks

- **Double counting during the transition** if a reader unions the mirror with
  the slot it is replacing. Each reader moves to the mirror alone.
- **Backfill against the existing datasets** — seed snapshots, the sandbox lead
  tenants (preserved across resets, so they need the backfill or a lead
  reseed) and the HMD migration data. Idempotent by grant id derived from the
  contact, dry run first.
- **Pricing behaviour changes for members holding several plans** once the
  resolver picks the best plan. Intended, but visible: it belongs in the release
  note.
