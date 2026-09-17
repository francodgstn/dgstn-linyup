---
title: UX review — 2026-09 · Offerings (activities & plans)
status: living
area: product
---
# UX review — 2026-09 · Offerings (activities & plans)

Reviewed on `origin/main` 23d7ea30 (2026-09-17), after the studio default drop-in
(#289) and the two-question class gate (#279). Scope: the manager's Offerings area
(M5: `manage/offer`, `manage/pricing`, the class pricing tab, the plan editor, the
plan ↔ class table) and how the same classes and plans reach a contact (C2 booking,
C3 shop). Four read-only passes fed it: `ux-reviewer` on M5, `ux-reviewer` on
C2×C3 narrowed to offer presentation, a copy/vocabulary pass over every string
the Offerings area renders, and a conceptual model review
(`docs/offerings-model-review-2026-09.md`).

**Driving principle (Franco, 2026-09-17):** lean UI, not cluttered; wherever
possible hide what is not directly needed. A studio owner is generally not a tech
person — the data model's words must not reach the screen.

**Top line.** The access form's two plain questions ("Who can book" → *Open to
anyone* / *Members only*) and the booking flow's plain doors ("First time here",
"Pay for a single class") are the right shape and should be copied, not changed.
What degrades the area is everything *around* them: three real bugs that show a
member or a manager the wrong answer, a vocabulary that names one concept four
ways ("plan", "subscription", "subscription type", "membership"), health warnings
written in model words, and plan-editor controls for rare cases (partner apps,
checkout capture, purchase caps) sitting on the default path.

## Evidence inputs

| Input | Available | Effect |
|---|---|---|
| Prior report `docs/archive/ux-review-2026-08.md` | Yes | Every M5 row there re-walked; all still hold. Everything below is `new` |
| `docs/ux-principles.md` | No | The principle above stood in for it |
| `/persona-ux-test` runtime run | **No** (none since 2026-08-17; every local slot was in use) | Nothing is `observed`; all findings are `traced` or `counted` |
| In-app feedback | No | — |

The three bugs (UX-102…104) were re-verified against the source by hand before
being filed, not taken from the agents' word.

## Findings

| # | Sev | Finding | Area | Owner | Status |
|---|---|---|---|---|---|
| 102 | blocks | A member whose *second* plan covers a class is told she holds none, then refused when she tries to pay | C2×C3 | web | ✅ Fixed (dea573f8) |
| 103 | costs-money | The plan ↔ class table reads a class's drop-in raw, so a class on the studio default looks priceless and a plan tick can lock it to plan-holders | M5 | shared + web | ✅ Fixed (545912cd) |
| 104 | costs-money | A plan price with the "per class" recurrence sells unlimited, never-ending access | M5×C3 | web + seeds | ✅ Fixed (f5ddd2cd) |
| 105 | costs-money | The "nobody can book this" warnings are written in model words and name no fix | M5 | web | ✅ Fixed (1dcaed66) |
| 106 | confuses | One concept, four names on the manager side (plan / subscription / subscription type / membership), plus "gate", "door", "holders" | M5 | web | ✅ Fixed (1dcaed66) |
| 107 | confuses | The contact reads "subscription" and "membership" for the same fact, one screen apart | C2 | web | ✅ Fixed (1dcaed66) |
| 108 | slows | Creating any plan shows partner-app, checkout-capture and purchase-cap controls first-time studios never need | M5 | web | ✅ Fixed (a4cd5879) |
| 109 | slows | The plan ↔ class table needs sideways scroll at 375px and explains its columns only in hover tooltips | M5 | web | ◐ Interim shipped (a4cd5879 (interim legend)) |
| 110 | confuses | A member browsing classes sees the list price; her member price appears two steps later | C2 | web | ✅ Fixed (0679f90e) |
| 111 | slows | A plan with monthly + annual prices shows two identical Buy rows, no steer to the better deal | C3 | web | ✅ Fixed (a4cd5879) |
| 112 | confuses | The studio default drop-in is editable in two places with different powers | M5 | web | ▶ Parked — decision 29 |
| 113 | confuses | A hint still names "Any member" / "Specific subscriptions", options the form removed | M5 | web | ✅ Fixed (1dcaed66) |
| 114 | slows | Every new class starts uncovered by every membership until someone ticks it | M5 (model) | shared + functions + web | ▶ Parked — decision 30 |
| 115 | costs-money | "First class free, then drop-in for anyone" cannot be set up | M5 (model) | functions + web | ▶ Parked — decision 31 |
| 116 | slows | Creating a class meets nine optional fields (meeting point, booking questions, prose) before Save | M5 | web | ✅ Fixed (d52ee50a) |
| 117 | slows | Pricing's "What you sell" repeats the plan facts the Offerings plan pane already shows | M5 | web | ▶ Parked — decision 34 |

---

### UX-102 — A member whose second plan covers a class is told she holds none
C2×C3 · contact (member) · blocks · weekly · traced (verified) · new

**Now:** the booking confirm step and the drop-in quote build the client snapshot
from the legacy slot alone — `heldSubscriptionTypeIds = contact?.subscription_type_id ? [..] : []`
(`public/[slug]/booking/BookingForm.tsx` `dropInQuote` and `memberAccess`), and
the shop's discount preview does the same (`shop/ShopHome.tsx`). The server reads
`held_plans` (`functions/src/booking/access.ts`). A member covered by a non-primary
plan sees "You don't currently hold a subscription that includes this class", is
routed to pay the drop-in, and `createDropInCheckout` then refuses with "You can
already book this class for free", rendered raw.
**Fix:** read the live contact record through `heldSubscriptionTypeIds()` exactly
as `AppointmentPicker.tsx` already does (live read, frozen slot only as the
fallback for a failed read). Display-only; the callables stay authoritative.
**Build:** M · **Owner:** web-agent
**Verify:** a contact holding two plans, the class covered only by the second —
booking shows "Included in your membership".

### UX-103 — The plan ↔ class table reads a class's drop-in raw
M5 · manager · costs-money · weekly · traced (verified) · new — a leak of #289

**Now:** `rateHasAPriceToApplyTo` (`shared/utils/activityPlanLink.ts`) tests
`dropIn.enabled && priceAmount`, and the edge writer computes `paidDoor` the same
way before `canonicalClassGate`. A class following the studio default stores no
price, so (a) from a plan's page every member-price control on it is dimmed with
"no drop-in price" — on the state every new class starts in; (b) ticking a plan on a
legacy `subscription`-tier class that follows the default stores
`requirePlan: true`, while `bookSession` (which resolves the drop-in) sold it to
anyone at the door — everyone without that plan loses the drop-in.
**Fix:** the activity arm of `PlanLinkTarget` carries the studio default; both
readers go through `resolveActivityDropIn`. The pricing form's draft states its
mode explicitly so a draft "off" is not re-read as "follow the studio".
**Build:** S · **Owner:** shared + web
**Verify:** studio default CHF 25, a class on it; from a plan's page the member
price columns are live; tick the plan on a legacy class and the stored gate keeps
"no plan required".

### UX-104 — A "per class" plan price sells unlimited, never-ending access
M5×C3 · manager · costs-money · at-setup · traced (verified) · new

**Now:** `PlanPricingForm` offers `per_class` as a recurrence and
`createMembershipPayment` charges it once. A held price that is not a credit price
is unmetered (`heldTypeIsUnmetered`), and only `one_time` prices ever get an end
(`planGrantExpiryMs`). So a "10-class card, CHF 180, per class" — the emulator
seed ships exactly this — lets the buyer book every linked class forever.
`planTemplates.ts` itself calls it "a display recurrence with no door semantics".
**Fix:** stop offering it: remove it from the price picker for new prices (an
existing price keeps its label) and from the AI drafter's enum and validator. A
class pack is *one-time + number of classes*. Already-stored `per_class` prices —
including the emulator and staging seeds' "10-Class Pack" — are decision 32.
**Build:** S · **Owner:** web + functions + scripts
**Verify:** New plan → price → no "Per class"; an existing per-class price still
shows its label.

### UX-105 — "Nobody can book this" warnings are written in model words
M5 · manager · costs-money · weekly · traced · new

**Now:** Pricing → Health, the one screen whose job is telling an owner a class is
unbookable: "{name} is gated but allows no subscription types — nobody can book
it." (`OfferPricing.healthGatedEmptyAllowlist`), "…member benefit points to a
subscription type that no longer exists", "…sold only with a subscription or
pack…". The catalogue says "The price is the gate" on every appointment row.
**Fix:** rewrite in the form's own words and name the fix: "Nobody can book
{name}: it's members-only with a plan required, but no plan includes it." Section
title "Health" → "Things to fix".
**Build:** S · **Owner:** web-agent

### UX-106 — One concept, four names (manager side)
M5 · manager · confuses · every-session · counted · new

**Now:** the plan is "Plan" (`OfferCatalogue.railPlans`, `newPlan`), "Subscriptions"
(`Nav.subscriptions` on the pricing quick link, `backToSubscriptions`),
"Subscription type(s)" (`OfferPricing.sectionSellSubtitle`, `noSubscriptionTypes`,
`TeamSettings.addSubscriptionType` "Add type"), and "Membership" in hints. Model
words reach the screen: `Activities.accessHint` "This is the door…",
`summaryAppointment` "The price is the gate", `Benefit.effect_*_desc` "Holders…",
credits as "lesson credits", the usage cap as "allowance".
**Fix:** one vocabulary — **Plan** for the thing sold (with *membership* and *class
pack* as its kinds), **Drop-in price**, **Trial class**, **Who can book: Anyone /
Members only**, **Included** / **Member price**, **classes** for credits, **Class
limit** for the usage cap. Remove helper text that only restates its label.
Full key list: the copy pass in this review's working notes, §2–§3 (applied in the
same PR).
**Build:** S–M (copy only, four locales) · **Owner:** web-agent

### UX-107 — "Subscription" and "membership" for the same fact, one screen apart
C2 · contact · confuses · every-session · counted · new

**Now:** inside the `Booking` namespace: "{activity} is included with a
subscription", "See subscriptions", then "Included in your membership" / "Your
membership doesn't include this class". `AppointmentBooking` uses "subscription"
throughout.
**Fix:** contact-facing word is **membership** everywhere in `Booking` and
`AppointmentBooking` (the manager side keeps *plan*).
**Shipped as:** English only. German, French and Italian already used one word
throughout (Abo / abonnement / abbonamento), which is the customer's own word
there, so they were left as they were.
**Build:** S · **Owner:** web-agent

### UX-108 — The plan editor puts rare controls on the default path
M5 · manager · slows · at-setup · traced · new

**Now:** `SubscriptionTypeDialog` opens with a "Source: Internal / Partner" picker
above everything, for every plan; `PlanPricingForm` shows "Contact capture at
checkout: Off / Minimal / Full", "× / person" purchase cap and "mth incl." inline on
every price row.
**Fix:** collapse partner source, checkout capture and purchase cap behind one
"More options" disclosure that opens by itself when any of them is already set.
Nothing is removed; a partner plan is one click further.
**Build:** S · **Owner:** web-agent

### UX-109 — The plan ↔ class table at 375px
M5 · manager · slows · at-setup · traced · new

**Now:** `ActivityPlanLinks` is a `min-w-[36rem]` grid in `overflow-x-auto`; the
only explanation of None / Included / % off / Fixed is a `title` on each header.
**Fix (interim, shipped here):** a visible legend above the table, on narrow
screens only (a pointer still gets the header tooltips, without four extra lines).
**Real fix:** a stacked one-card-per-row layout below `sm` — L, not in this pass.
**Build:** S interim / L real · **Owner:** web-agent

### UX-110 — The member's own price appears two steps late
C2 · contact (member) · confuses · every-session · traced · new

**Now:** class cards resolve their price from the activity alone
(`resolveActivityPricingDisplay`), the who's-booking step then shows the member
rate struck through. **Fix:** feed the signed-in contact's held plans into the card
price; interim — leave it. **Build:** S–M · **Owner:** web-agent

### UX-111 — Two Buy rows, no steer
C3 · contact (prospect) · slows · weekly · traced · new

**Now:** the membership template ships monthly + annual; `ShopHome` stacks both as
equal rows. **Fix:** when a plan has a monthly and an annual price and the annual is
cheaper per month, badge it "Save N%". Derived, nothing for the studio to set.
**Build:** S · **Owner:** web-agent

### UX-112 — The studio default drop-in, editable in two places
M5 · manager · confuses · at-setup · traced · new — **parked, decision 29**

Pricing → Drop-in card edits it fully; a class's pricing tab edits it in place but
can only turn it *on*. The Pricing page's own header comment says "no editing here".

### UX-113 — A hint names removed options
M5 · manager · confuses · once · traced · new

`OfferCatalogue.openNoPlanEdge` ("Pick 'Any member' or 'Specific subscriptions'
above") behind `noPlanEdge`, hard-coded `false` in `ActivityPricingForm`. Delete the
branch and the key.
**Build:** S · **Owner:** web-agent

### UX-114 — Every new class starts uncovered by every membership
M5 (model) · manager · slows · weekly · traced · new — **parked, decision 30**

A plan stores no scope; coverage lives only on each class's
`accessRule.subscriptionTypeIds`. "Unlimited" means ticking every class, and every
class added later is silently outside it. The highest-leverage simplification in
the model review (stage S2). Needs a product call.

### UX-115 — "First class free, then drop-in for anyone" cannot be set up
M5 (model) · manager · costs-money · at-setup · traced · new — **parked, decision 31**

The trial door opens only on members-only classes (`bookSession` branches on
`accessRule.type !== 'open'`); a class open to anyone that sells a drop-in projects
to `open`, so the form hides the trial there. Needs a product call on what
"newcomer" means across trial and promo codes.

### UX-116 — Creating a class meets nine optional fields before Save
M5 · manager · slows · at-setup · counted · new (declutter audit)

**Now:** the create/duplicate dialog rendered the meeting point, booking
questions, contact fields, prerequisites, confirmation instructions, what's
included / not included, FAQ and cancellation policy unconditionally after the
five fields a class needs (`ActivityDialog.tsx`).
**Fix (shipped):** in the dialog they fold under one `MoreOptions`, open by itself
when the copied class already carries any of them. Auto-confirm and the waitlist
stay visible — hiding either fails silently (unconfirmed bookings; a full class
with no queue). The pane's Booking tab is unchanged.
**Build:** S · **Owner:** web-agent

### UX-117 — Pricing's "What you sell" repeats the plan pane
M5 · manager · slows · weekly · traced · new — **parked, decision 34**

The section lists each plan's prices, class limit and what it covers — the same
facts the Offerings plan pane shows and edits one click away. The declutter audit
proposes replacing it with one link. Not done: it is a whole section of a page
Franco shaped recently, and the all-plans-at-a-glance view may be the point.

## What's good

- **The access form asks two plain questions** — "Who can book" → *Open to anyone* /
  *Members only*, then only when relevant the trial and the drop-in
  (`ActivityPricingForm.tsx`). Reuse for courses.
- **A new class opens straight onto Access & pricing**, not a tab to find.
- **The catalogue's dead-end banner** counts only true nobody-can-book states, with
  one resolver at two severities (`computePricingHealth`) so Pricing and Offerings
  cannot disagree.
- **Catalogue rows state who, what it costs and the trial without opening them**,
  from the *resolved* price.
- **Booking prices hide behind a quiet tooltip** instead of stacking under every card.
- **A covered member's confirm screen is one sentence and a button.**
- **The booking doors are customer words** — "First time here", "Pay for a single
  class", "I've been here before".
- **A gated class's refusal opens the shop in a new tab, deep-linked**, so the picked
  class is not lost.

## Dropped

- Drop-in vs a one-class plan as two ways to sell a class: no template or copy nudges a
  studio toward the plan route, so the overlap stays in the model and not the path.
  `per_class` (UX-104) was the real third way, and it is a bug.
- The seven-value recurrence select — real billing models; `per_class` handled in UX-104.
- Products and promo codes — first pass only, nothing stood out.
- `payoutPerVisit` — already disclosed only for partner plans.
- The shop's price-index-0 selection rule — fragile but consistent, not visible today.
