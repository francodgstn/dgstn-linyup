# Offerings copy pass — 2026-09 (working notes for UX-105/106/107/113)

Companion to `docs/ux-review-2026-09.md`. Audience: a studio owner who is not a
tech person. Rule: the owner's words, never the data model's. Every change applies
to en, de, fr and it.

## Vocabulary — one term per concept

| Concept | Manager side (Offerings) | Contact side (booking, shop) |
|---|---|---|
| The thing a member buys | **Plan** (kinds: *membership*, *class pack*) — never "subscription type", "type", "subscription" | **Membership** — never "subscription" |
| Paying for one class | **Drop-in price** ("pay per class" explained once, on Pricing) | "Pay for a single class" (unchanged) |
| First visit | **Trial class** (it can be priced) | "First time here" (unchanged) |
| A plan's discounted opening periods | **Intro price** | — |
| Who may book | **Who can book: Anyone / Members only** — never door, gate, tier | — |
| People on a plan | **Members on this plan** — never "holders" | — |
| What a plan does for a class | **Included** / **Member price** (covers % off and fixed) | — |
| Credits | **classes** ("10 classes") — never "lesson credits" | — |
| Usage cap | **Class limit** — never "usage limit", "allowance" | — |

## Key rewrites (en; translate the same meaning)

| Key | Now | New |
|---|---|---|
| `Activities.accessHint` | "This is the door. What people pay…" | remove the rendered hint (or "Prices are set below.") |
| `Activities.access_open_desc` | "No account needed. A newcomer becomes a trial contact when they book." | "Anyone can book, no sign-up needed." |
| `Activities.access_members_desc` | "Only people on your list can book — including at the drop-in price…" | "Only people who have joined as members." |
| `Activities.accessAllowWithoutPlan` | "Allow booking for members without a subscription" | "Members without a plan can book too" |
| `Activities.accessAllowWithoutPlanHint` | "On, they book at the drop-in price — or free if there is none. Off, only holders…" | "They pay the drop-in price, or nothing if there isn't one." |
| `Activities.fieldTrialEnabled` | "Free trial for newcomers" | "Trial class for newcomers" |
| `OfferPricing.doorTrialFree` | "Free trial for newcomers" | "Free trial class" |
| `Activities.dropInHelp` | "Uncovered contacts can pay this…" | "What someone without a plan pays for one class." |
| `Activities.dropInModeStudio` / `dropInModeStudioNone` | "Studio default · {amount}" / "Studio default (none set yet)" | "Your usual price · {amount}" / "Your usual price (not set yet)" |
| `OfferCatalogue.summaryAppointment` | "The price is the gate · …" | "Anyone can book · …" |
| `OfferCatalogue.summaryClass` | "… on the member rate" | "… with a member price" |
| `OfferCatalogue.openNoPlanEdge` | names removed options | delete key + dead branch (UX-113) |
| `OfferCatalogue.plansHint` | "For each plan, say whether this is included, cheaper, or neither." | "What does each plan give here?" |
| `OfferCatalogue.includesHint` | "For each activity, say whether this plan includes it…" | "What does this plan give for each class?" |
| `OfferCatalogue.sharedRule` | "This rate is shared with {names} — changing it changes theirs too." | "Also used by {names}. Changing it changes theirs." |
| `Benefit.effect_*_desc` | "Holders…" | "Members on this plan…" |
| `OfferCatalogue.hintPlans` | "How you charge — recurring or one-off, and what each plan opens. Partner apps live here too." | "Memberships and class packs, and what each one includes." |
| `OfferPricing.sectionSellSubtitle` | "Every subscription type, its prices, and what it unlocks." | "Every plan, its prices, and what it includes." |
| `OfferPricing.noSubscriptionTypes` | "No subscription types yet." | "No plans yet." |
| `OfferPricing.personaMember` | "Member (no subscription)" | "Member without a plan" |
| `OfferPricing.personaPickerLabel` | "Who's asking" | "See prices as" |
| `OfferPricing.sectionHealthTitle` | "Health" | "Things to fix" |
| `OfferPricing.health*` (UX-105) | "…is gated but allows no subscription types…", "…member benefit points to a subscription type that no longer exists", "…sold only with a subscription or pack…", "…sells credit packs, but no activity accepts them" | name the class and the fix in plain words, e.g. "Nobody can book {name}: it's members-only with a plan required, but no plan includes it." / "{name}'s member price uses a plan that was deleted." / "{name} is sold only with a plan, but no plan includes it." / "{name} is a class pack, but no class accepts it." |
| `TeamSettings.addSubscriptionType` / `editSubscriptionType` | "Add type" / "Edit type" | "New plan" / "Edit plan" |
| `TeamSettings.fieldSubTypeSource` + options | "Source" · "Internal" / "Partner" | "Who charges the member" · "You" / "A partner app" |
| `TeamSettings.subTypeCheckoutContact` + modes | "Contact capture at checkout" · Off / Minimal / Full | "Add buyers to your members" · "No" / "Name and email" / "Full sign-up" |
| `TeamSettings.subTypeActiveDesc` | "Inactive types are hidden from booking forms and reports" | "Turn off to stop selling it." |
| `TeamSettings.subTypeCreditsPlaceholder` / `subTypeCreditsSuffix` / `subTypeCreditsHelp` | "Credits (lessons)" / "lessons" / "…lesson credits, consumed per booking…" | "Classes" / "classes" / "Number of classes in the pack. They expire after the months above." |
| `TeamSettings.subTypeIncludedMonthsSuffix` / `subTypeIncludedMonths` | "mth incl." / "Months incl." | "months valid" / "Valid for (months)" |
| `TeamSettings.subTypeMaxPurchasesSuffix` | "× / person" | "per person" |
| `TeamSettings.subTypeUsageLimit` / `subTypeUsageLimitDesc` | "Usage limit" / "Only limits CLASS bookings…allowance…" | "Class limit" / "After the limit, members pay the drop-in price." |
| `TeamSettings.subTypeIntroErr_interval_not_monthly` | mentions Stripe | "Weekly plans can only get an intro price for the first week." |
| `Contacts.recurrence_biweekly` | "Biweekly" | "Every 2 weeks" |
| `Onboarding.setup.steps.activities.desc` | "Define the classes or coaching you offer." | "The classes and appointments you offer." |
| `Onboarding.setup.steps.pricing.desc` | "A subscription plan, or a price per class." | "A plan, or a drop-in price." |
| `Onboarding.setup.steps.payments.desc` | "Connect Stripe to accept payments directly in Linyup." | "Get paid by card online." |

Contact side (UX-107): in `Booking` and `AppointmentBooking`, every
"subscription(s)" a contact reads becomes "membership(s)" — e.g.
`accessSubtitle`, `accessSignUpBody`, `accessSeeSubscriptions` ("See memberships"),
the `AppointmentBooking` "Included with your subscription" / "Have a subscription?
Sign in" / "Your subscription no longer covers this booking".

## Helper text that only restates its label — remove where rendered

`Activities.accessHint`, `TeamSettings.subTypeSourceInternalDesc`,
`OfferPricing.healthAllGood` (show nothing). The `Benefit.effect_*_desc` and
`OfferCatalogue.choiceNoneDesc` strings are NOT removed: they are the plan table's
column explanations, and UX-109 moves them from hover tooltips into a visible legend.
