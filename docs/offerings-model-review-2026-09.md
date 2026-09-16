# Offerings model review — activities, plans, and who books what at what price

2026-09-17, on `origin/main` 23d7ea30. A read-only review of the concepts behind
Offerings; the UI findings it fed are in `docs/ux-review-2026-09.md`, and the
decisions it raised are parked in `docs/ux-review-open-decisions.md` (29–33).
Guiding rule (Franco): the default path should need the fewest concepts a
non-technical studio owner must understand; advanced concepts may exist but surface
only when used. Line references drift — they locate, they do not pin.

## 1. The model as it is

| Entity | Owns | Stored on | Main readers |
|---|---|---|---|
| **Activity** (`types/activity.ts`) | `type` class/appointment. Class: `accessRule` {`type`, `audience`, `requirePlan`, `subscriptionTypeIds`}, `isFreeTrial`, `dropIn` {`mode`, `enabled`, `priceAmount`}, `trialEnabled`, `trialPriceAmount`, `memberBenefit` (a member rate on the drop-in). Appointment: `durations[]`, `durationBenefits[]`, legacy `memberBenefit` | `activities/{id}` + public mirror (carries the RESOLVED drop-in) | bookSession, createDropInCheckout, bookAppointment, pricingSurface, activityTerms, the plan matcher |
| **Plan** = `SubscriptionType` (`types/contact.ts`) | `prices[]` (recurrence `per_class`/`one_time`/weekly…annual, `included_months`, `credits`, `maxPurchasesPerContact`), `limits[]`, `introOffers[]` (+ legacy `introOffer`), `source` internal/aggregator, `payoutPerVisit` | `teams/{t}/subscription_types/{id}` — **stores nothing about activities** | shop, checkouts, `loadContactPaymentSnapshot` |
| **Plan ↔ offering edge** | access facet (`accessRule.subscriptionTypeIds`) + rate facet (`memberBenefit` / `durationBenefits` / `Course.benefit`) | **only on the offering**; one writer `activityPlanEdgeUpdate` | `gatedPlanIds`, `ratedPlanIds`, catalogue |
| **Benefit** (`types/benefit.ts`) | ids + effect `included`/`spend_credits`/`percent_off`/`fixed_price` — one rule per offering (per length on appointments) | inside the offering | `resolvePaymentOptions` |
| **Booking settings** | studio default `dropIn` | `teams/{t}/public_profile/{t}.bookingSettings` | `resolveActivityDropIn`, `syncStudioDropIn` |
| **Course** | `accessRule` free/registered/subscription/purchase, `benefit` | `courses/{id}` | resolver course arm, rules |
| **Promo code** | a price modifier, `audience` all/new_contacts | `teams/{t}/promo_codes/{CODE}` | resolver context |
| **Contact holdings** | `held_plans[]`, `credit_grants`, `usage_windows`, `plan_purchases`, `acquisition_stage` (`joined` = member), `trial_used_at`, legacy `subscription_type_*` slot | contact + subcollections | snapshot loader |

```
                BookingSettings.dropIn (studio default)
                             │ followed when dropIn.mode = 'studio'
                             ▼
 ┌────────── Activity (class) ──────────┐      ┌── Activity (appointment) ──┐
 │ WHO:   audience · requirePlan        │      │ durations[] price | benefitOnly
 │        [type, isFreeTrial: projections]    │ durationBenefits[minutes]  │
 │ DOORS: dropIn(mode) · trial(price)   │      │ [memberBenefit: legacy]    │
 │ EDGE:  accessRule.subscriptionTypeIds ─┐  ┌─ benefit.subscriptionTypeIds │
 │        memberBenefit (drop-in rate) ───┤  │ └───────────────────────────┘
 └──────────────────────────────────────┘ │  │  Course.accessRule / benefit ─┐
                                          ▼  ▼                               │
                            SubscriptionType (Plan) ◄────────────────────────┘
                            prices: recurring | one_time + months | credits | per_class
                            limits · introOffers · source (partner)
                                          ▲
                   Contact.held_plans ────┘ (+ credit_grants, usage_windows,
                   acquisition_stage = joined → "member", trial_used_at)
                                          │
  snapshot ─► resolvePaymentOptions(snapshot, target, {promo}) ─► covered | spend_credits | pay
```

Four indirections answer "who books what at what price": the *price* decides
metered vs unmetered (`heldTypeIsUnmetered`), the *offering* decides which plans
count, the *contact's stage* decides who is a member, the *studio default* decides
the door price.

## 2. Redundancies and double sources of truth

| # | Same fact twice | Verdict |
|---|---|---|
| R1 | `accessRule.type` vs `audience` + `requirePlan` | **Legacy shim, still used to decide.** The trial door in bookSession (`accessRule.type !== 'open'`), `classDoors` and the health loop in `pricingSurface.ts`, the form's `openTier`, `activityTerms.ts`, `activityRequiresSubscription`. Two writers keep the projection in step (the pricing form and the edge writer). |
| R2 | `isFreeTrial` on Activity **and** Session | **Pure legacy, misnamed.** Now stores "anyone, no plan required" — nothing to do with the trial (`trialEnabled`). Still a fallback in `resolveActivityAccessRule` and `syncSessionPublicProfile`. A third spelling of the gate. |
| R3 | appointment `memberBenefit` vs `durationBenefits` | Shim absorbed on write, no backfill. `memberBenefit` also *means* different things by kind (every priced length vs the class drop-in rate), and nests a second legacy shape `{kind, discountPercent}`. |
| R4 | Course `benefit{included}` vs `accessRule.subscriptionTypeIds` | Shim absorbed on write; `firestore.rules` still honours the legacy spelling. |
| R5 | `introOffer` vs `introOffers[]` | Shim, normalised by `introOffersOf`. |
| R6 | `dropIn.enabled` vs `dropIn.mode` | Shim. **Raw readers slipped past the one-reader rule** — `rateHasAPriceToApplyTo` and the edge writer's `paidDoor`. Filed as UX-103, fixed in this pass. |
| R7 | Three ways to sell one class: drop-in, a 1-credit pack, a `per_class` price | Drop-in vs pack is a **real** distinction (a sale at the door vs a held right). `per_class` is **a trap**: charged once, unmetered, never ends. Filed as UX-104. |
| R8 | Four "new / once per person" rules: trial (`trial_used_at`), promo `new_contacts` (`!joined`), `maxPurchasesPerContact`, intro offer (no newcomer rule) | Partly legitimate (different rails), but no single "newcomer". Decision 31. |
| R9 | Metered vs unmetered decided per *price*, not per plan | Leaky: one plan may mix a monthly and a 10-credit price, and coverage depends on which price the holding carries. |
| R10 | `held_plans` vs legacy `subscription_type_*` slot | Planned exit, multi-plan phases 3b–5. UX-102 is the web's last display reader of the slot on the booking path. |

## 3. Legacy "absent field means X" readings still live

| Reading | Cost | Retired by |
|---|---|---|
| no `accessRule` → from `isFreeTrial` | a third gate spelling | backfill modern `accessRule` |
| no `audience`/`requirePlan` → `legacyClassCoverage` + `resolveClassGate` legacy legs; `subscription` tier meaning depends on the drop-in | two coverage engines in one resolver, `hasModernGate` branches | backfill with the *resolved* drop-in |
| legacy `open` = free for everyone, suppresses any drop-in | a stray price silently ignored | same backfill, `dropIn.mode: 'off'` |
| no `dropIn.mode` → custom if priced else studio | forces raw readers into existence (R6) | backfill `mode`, stop storing `enabled` |
| no `durationBenefits` → `memberBenefit` for every length | two shapes on the appointment rate | backfill, delete |
| legacy benefit `{kind, discountPercent}` | `AnyBenefit` union on every signature | backfill |
| course `benefit.included` = gate | a rules branch | backfill |
| no `introOffers` → `introOffer` | small | backfill |
| no `autoConfirm` → true; no `limits` → unlimited; no `included_months` → no end | legitimate defaults | keep |
| `subscription_type_*` slot | scheduled | multi-plan phase 5 |

"Absorb on first write, no backfill" was the right call to keep deploys inert.
Pre-launch with backfills acceptable, it is now the main source of complexity:
every legacy leg lives forever unless one runs.

## 4. Offers studios commonly sell

| Offer | Today |
|---|---|
| Unlimited except workshops | Tick the plan on every regular class. **Every new class starts uncovered.** The biggest friction for a non-technical owner — decision 30. |
| 10-class pack valid 3 months | Works: one-time, `credits: 10`, `included_months: 3` (a misleading field name). |
| Workshop costs 2 credits | Not possible; coverage always spends one. |
| Family / 2-person plan | Not possible; a holding is one contact's. |
| Off-peak membership | Not possible; limits are counts, nothing refers to time of day. |
| First class free (or CHF 15), then drop-in for anyone | Only on members-only classes — decision 31. |
| Trial set once for the studio | Per class only (unlike the drop-in). |
| A 6-week course block | Not a concept; workaround is a 6-credit capped plan, no "book all 6". |
| Intro pass "2 weeks unlimited CHF 29, once" | Works, except "2 weeks" (months only). |
| Partner visits (ClassPass-style) | Works. |

## 5. Vocabulary

- **One idea, many names.** Code: `SubscriptionType`, `subscription_type_id`,
  `held_plans`, `activityPlanLink`, `PlanPricingForm`. UI: "Plan", "Subscription
  type", "Membership type", "Plans & affiliations". Fixed on the manager screens of
  Offerings in this pass (UX-106); the contact side says *membership* (UX-107).
- **"Plan" is taken twice in code:** `types/plan.ts` is Linyup's own SaaS tier.
- **"Membership" is overloaded:** a plan, an affiliation, and group membership.
- **"Member" differs between code and copy:** code means `acquisition_stage ===
  'joined'`; the form said "people on your list", which includes leads.
- **Access has five names in code** (accessRule, gate, tier, audience, door) and
  "tier" means different enums for classes and courses.
- **"Trial" means three things:** `isFreeTrial` (actually "open"), `trialEnabled`, SaaS trial days.
- **`included_months`** is "access length" on a pass and "validity" on a pack.

## 6. Recommended target model

| Concept (UI name) | Stored as | Visible |
|---|---|---|
| Class / Appointment | `Activity` | always |
| Drop-in price | `BookingSettings.dropIn` + `Activity.dropIn.mode` | the studio price always; per-class custom/off on demand |
| Who can book: Anyone / Members only | `accessRule.audience` | always, two options |
| Plan — kind derived from its prices: Membership (recurring), Pass (one-time + length), Class pack (credits) | `SubscriptionType` | always; the kind picked by template, never by recurrence |
| Included classes: All classes (default) / Selected | **new** plan-side scope, unioned with class-side ids | "All" by default, "Selected" on demand |
| Plan required | `requirePlan` | on demand, under Members only |
| Member price (% / fixed) | `Benefit` | on demand |
| Trial class (free or priced, once per person) | studio default + per-class override, drop-in pattern | studio setting once, per-class on demand |
| Class limit, intro price, purchase cap, partner payout | as today | on demand, "More options" |
| Promo codes | as today | own page |

**Removed:** stored `accessRule.type` (derive for display), `isFreeTrial`, the
`per_class` recurrence, stored `dropIn.enabled`, appointment `memberBenefit`, the
legacy benefit shape, course `included` benefit, singular `introOffer`, the plan slot.
**Kept distinct:** drop-in vs class pack — the owner's decision stands.

### Stages, by value per effort

| Rank | Stage | Value | Effort | Status |
|---|---|---|---|---|
| 1 | **S0 — fix the leaks.** Raw drop-in readers (UX-103); stop offering `per_class` (UX-104); deciding paths stop branching on `accessRule.type` | high | S | first two shipped in this pass; the `type` branches ride with S1 |
| 2 | **S1 — backfill the class gate** (`audience`/`requirePlan`/`dropIn.mode`), then delete `legacyClassCoverage`, `hasModernGate`, `isFreeTrial`, stored `type`. Check mobile readers first | high | M | decision 33 |
| 3 | **S2 — plan scope "All classes"**, unioned by the snapshot loader so the resolver is untouched | highest for the owner | M | decision 30 |
| 4 | **S3 — finish multi-plan 3b–5** | high | M | planned |
| 5 | **S4 — studio-wide trial + trial on open classes with a paid door; one "newcomer"** | medium-high | M | decision 31 |
| 6 | **S5 — backfill rate shapes** (appointment memberBenefit, benefit shape, course included, introOffer) | medium | S–M | after S1 |
| 7 | **S6 — one kind per plan** (no mixing credit and non-credit prices); show "valid for" on packs | medium | S | open |
| 8 | **S7 — vocabulary** | medium | S | UI shipped for Offerings + booking; `types/plan.ts` → `saasPlan.ts` open |
| 9 | **S8 — gaps when a paying studio asks:** credit cost per class, off-peak windows, family holdings, course blocks | low now | M–L each | — |

S0–S1 remove the most code and every known leak with no product decision. S2 is the
single change that removes the most setup for a non-technical owner: a new
membership just covers new classes.
