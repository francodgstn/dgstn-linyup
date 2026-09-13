# Multi-plan holdings — a contact holds a LIST of plans

Status: **design, not built.** Option B, chosen by Franco on 2026-09-13 over the
minimal option (stop Stripe events writing the single plan slot).

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
  starts_at: Timestamp | null
  ends_at: Timestamp | null        // grant expiry, Stripe end date, next credit expiry
  price_id?: string | null
  amount?: number | null
  recurrence?: string | null
  credits_remaining?: number
  ref: string                      // grant id, Stripe subscription id, or type id for credits
}

Contact.held_plans?: HeldPlan[]
Contact.held_plan_type_ids?: string[]        // flat, for rules hasAny + array-contains queries
Contact.held_plans_next_expiry_at?: Timestamp | null
```

- **`recomputeHeldPlans(contactId)`** is the ONE writer. It reads the three
  sources and writes the three fields whole. The existing credit-grant and
  member-subscription triggers call it, and a new `plan_grants` trigger does
  too. `active_subscriptions` and `credit_summary` stay as they are until every
  reader has moved.
- An entry is **current at recompute time**: ended grants, lapsed grant expiries
  and exhausted or expired credits are left out.
- `held_plans_next_expiry_at` is the earliest future `ends_at` among grants and
  credits, so a sweep can find the contacts whose mirror is about to go stale.

### 2.3 Expiry stays lazy where it can, and refreshes where it cannot

The rule today is "enforced by comparison, never by a job": every coverage
reader calls `planGrantIsCurrent`. That stays for every server and client
reader — they compare `ends_at` live, generalised as `holdingIsCurrent(entry, now)`.

Security rules cannot compare per list element. So `held_plan_type_ids` is only
as fresh as the last recompute, and a **daily per-tenant job** (the
`dispatchTenantJob` pattern) recomputes every contact whose
`held_plans_next_expiry_at` has passed. The recompute also closes the lapsed
plan's history row, which fixes the "a lapsed grant still shows Active" defect
for free. See decision D1.

### 2.4 The legacy slot is derived, then retired

During the transition `recomputeHeldPlans` keeps writing the single
`subscription_type_*` fields as a derived **primary** (decision D2). Nothing new
reads them. They exist for installed mobile app versions and for any reader not
yet moved, and stop being written once the mobile release that reads
`held_plans` has adoption.

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
| Connect recurring `handleSubscription` | writes the slot on every active event | writes nothing on the contact; the member-subscription mirror covers it |
| Own-gateway webhooks | overwrite the plan id only | create a grant, id = payment event id |
| `reversePaymentEffects` | clears the slot on a matching ref | ends the grant whose `source_ref` matches |
| HMD migration, seeds, demo tenant | write the slot | write grants |

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

0. **Sign-off and guard.** Decisions D1–D4 below. A census test (in the style of
   `connect/commitSites.test.ts`) that pins every writer of the legacy slot, so a
   new one fails the build.
1. **Store and mirror.** `PlanGrant` and `HeldPlan` types; rules for
   `plan_grants`; `recomputeHeldPlans` with its triggers; the derived legacy
   slot; a backfill that creates one grant per contact from today's slot
   (`source: 'import'`, source ref preserved). Deploy rules, then functions, then
   the backfill through the Backfill workflow. Nothing reads the new fields yet.
2. **Writers.** The staff callables; payment effects, Connect one-off and
   own-gateway webhooks create grants; reversal ends grants; recurring Stripe
   events stop touching the contact; client writes to the slot denied by rules.
   The HMD migration transform and seeders write grants, so a re-import after the
   production cutover produces the new shape.
3. **Readers.** Snapshots and the best-plan resolver; rules and storage rules;
   public shop and booking; the shared reader for filter, automations,
   analytics, dashboards and CSV; the history reconciler; the daily expiry
   refresh job.
4. **UI.** The Current Plans list and dialogs; header, list, Space, Payments tab
   and dashboard; mobile profile.
5. **Retire.** Stop deriving the legacy slot once the mobile release that reads
   `held_plans` has adoption; remove the last slot readers; leave the fields on
   old documents.

---

## 7. Decisions needed

- **D1 — rules freshness.** Recommended: the daily per-tenant refresh, accepting
  that a rules-gated course read can outlive a lapsed grant by up to a day while
  bookings and pricing compare live. Alternative: move course content reads
  behind a callable, which removes the lag and adds a round trip to every lesson.
- **D2 — the derived primary** for the legacy slot during the transition.
  Recommended: the most recently started current holding, preferring a grant
  over a Stripe plan of the same start, so the mobile profile shows what the
  studio last assigned.
- **D3 — best-plan order**, as in 2.5.
- **D4 — two grants of the same type at once** (for example two overlapping
  intro offers). Recommended: allowed as rows, merged in the mirror into one
  entry per type with the latest end.

## 8. Risks

- **Double counting during the transition** if a reader unions the mirror with
  the slot it is replacing. Each reader moves to the mirror alone.
- **Backfill against production HMD data.** Idempotent by grant id derived from
  the contact, dry run first, and run after the cutover import.
- **Installed mobile versions** read the slot until they update; the derived
  primary covers them.
- **Pricing behaviour changes for members holding several plans** once the
  resolver picks the best plan. Intended, but visible: it belongs in the release
  note.
