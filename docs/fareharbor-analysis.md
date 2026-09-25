---
title: FareHarbor analysis
description: FareHarbor → Linyup — competitive feature analysis
status: record
area: product
---
# FareHarbor analysis

> **Status: analysis, not a commitment.** Nothing here is scheduled. Effort
> estimates are order-of-magnitude. The **Reject** verdicts are as much the point
> as the Port ones — this document exists so a considered "no" doesn't get
> re-litigated every quarter.

**Date:** 2026-08-11 · **Subject:** [FareHarbor](https://fareharbor.com), an
online booking platform for tours, activities, rentals and attractions (owned by
Booking Holdings).

---

## 1. Method and scope

Three inputs:

1. **FareHarbor's product glossary** (~150 domain concepts, from their public help
   center) — the most complete map of what the product actually models.
2. **A live booking walked end to end** on a real operator's page (a NYC harbour
   cruise): item page → date → time slot → ticket types → add-ons → cart →
   checkout. Every UI observation below comes from that walkthrough, not from
   marketing copy.
3. **An audit of this repo** — the public surfaces (`apps/web/src/app/[locale]/(public)/`),
   the admin surfaces (`.../(auth)/`), and the payments model
   (`packages/functions/src/connect/`, `packages/shared/src/utils/paymentOptions.ts`).

### The positioning caveat that drives every verdict

FareHarbor optimises for **one-off transactional bookings by tourists**, with OTA
distribution (Viator, GetYourGuide, Booking.com) as its moat. Linyup optimises for
**recurring member relationships** — subscriptions, retention, coaching — per
`docs/product-strategy.md` §1.

So the question is never "does FareHarbor have it?" but "does it serve a coaching
business?". A feature that only makes sense for a party of four buying a one-time
excursion is rejected here explicitly, with the reason. Conversely, several
FareHarbor concepts turn out to be *more* relevant to a martial-arts school than to
a boat operator — waivers being the obvious one.

---

## 2. Why FareHarbor's booking UI feels solid

This is the design takeaway, independent of any single feature. Three mechanics do
most of the work.

### 2.1 The item page answers every pre-purchase question before you commit

The activity page carried, in this order: a price preview in the header
(*"Starting at $52 | 1.5 hrs"*), a Google rating inline (*4.9 ★, 3,798 reviews*), a
month calendar, then a structured **Overview** grid — Duration / Meeting point /
Cancellations / Accessibility — followed by Details, **What's included**, **What's
not included**, Highlights, and accordions for FAQs and Cancellations.

Nothing about that is technically hard. The effect is that you never have to leave
the page, email the operator, or guess. Linyup's `ActivityPublicProfile` today
carries name, description, image, and `prerequisites`
(`packages/shared/src/types/activity.ts:210-242`) — the booker cannot find out where
to meet, what to bring, or what happens if they cancel.

### 2.2 One book form with a live running total

Ticket types, add-ons, promo code, gratuity and free-text questions all sit on **one
page**, with `Subtotal / Fees / Total` recalculating as you touch anything. Linyup
uses a 3–5 step wizard instead (`booking/BookingForm.tsx`, steps
`activities → sessions → who → returning|details → confirmed`).

**Recommendation: keep the wizard.** It is genuinely better than a single page when
there are member / guest / drop-in doors to choose between — a distinction
FareHarbor doesn't have, because everyone is a stranger paying list price. But
**port the live price breakdown** onto its final step, which today shows one opaque
number. `resolvePaymentOptions` already returns `appliedBenefit` alongside the
amount, so the data to show "CHF 30 − 20% member discount = CHF 24" is already in
hand.

### 2.3 Availability is visible before commitment

Unavailable dates are *rendered and visibly disabled* rather than hidden, each with
an accessible label ("Saturday, 1 August 2026 is not available"). The calendar
communicates scarcity instead of just absence. Linyup's `MiniCalendar`
(`apps/web/src/components/booking/MiniCalendar.tsx`) already does this — noted as
parity, not a gap.

---

## 3. Concept map with verdicts

**Verdicts:** **Port** (take it roughly as-is) · **Adapt** (take the idea, not the
shape) · **Already have** · **Finish** (built but not shipped) · **Reject** (with
reason).

**Effort:** **S** ≤1 day · **M** 2–5 days · **L** 1–3 weeks · **XL** larger.

### Theme A — Conversion polish (public booking surfaces)

| FareHarbor concept | Linyup today | Verdict | Effort |
|---|---|---|---|
| **Item page detail**: meeting point, what's included / not included, highlights, FAQ, accessibility | `ActivityPublicProfile` = name + description + image + `prerequisites` (`shared/src/types/activity.ts:210-242`) | **Port.** The single biggest perceived-quality delta, and it's purely additive optional fields on `Activity` mirrored to the public profile by `syncActivityPublicProfile`. Render as an accordion block on the activities step. Zero backend logic | M |
| **Cancellation notes** — per-item policy shown at booking *and* in every email | Nothing. `confirmationInstructions` (`activity.ts:184`) is email-only, and the team-wide `BookingInstructionsCard` likewise | **Port.** Exact same pattern as `confirmationInstructions`, extended to the public page. Kills support tickets | S |
| **Google rating** on the book form (via Google Place ID) | No reviews / rating / testimonial concept anywhere in `shared/src/types` | **Port.** Pure conversion play, and prominent in the live flow. A manually-entered rating + link to the Google profile is a legitimate v1 — the Places API can come later | S–M |
| **Price previews** on cards | `resolveActivityPricingDisplay` already renders "Included with Premium", drop-in price, appointment ranges | **Already have** | — |
| **Live Subtotal / Fees / Total** during checkout | Final wizard step shows a single number | **Port.** See §2.2 — reuse `resolvePaymentOptions`'s `appliedBenefit` | S |
| **Locations** — map link, directions, parking, where to check in | `Place` + `placeId` on sessions (`session.ts:37`); no per-activity meeting-point copy | **Adapt.** Fold into the rich activity detail above rather than building separately | S |
| **Search by date** — pick a day, see everything available across all activities | `BookingSettings.flowType: 'activity-first' \| 'date-first'` exists in the type (`team.ts:365`) **and** the settings UI with a visual mock (`settings/booking/page.tsx:92-104,163-174`), but `BookingForm` only implements activity-first | **Port.** This is finishing something already declared and configurable — a studio can currently select a flow that does nothing | M |
| **Booking flows / flow pages** — categorised booking navigation | Flat activity list | **Adapt.** Only matters once catalogues grow past ~10 activities. Deferred | M |
| **Dark mode** for the booking frame | `bioLinkTheme: light\|dark\|auto` with `matchMedia` resolution | **Already have** | — |
| **Visitor-currency display** ("Total in your selected currency CHF 121.30") | Single `Team.default_currency`; the accounting ledger is single-currency by design | **Reject.** A tourist feature. Linyup is single-market CH | — |

### Theme B — Daily operations (what a coach touches every day)

| FareHarbor concept | Linyup today | Verdict | Effort |
|---|---|---|---|
| **Manifest** — the printable, filterable day sheet: every session, its roster, check-in status, and custom-field answers | Nothing. **There is zero print CSS in the entire repo** — no `@media print`, no `window.print`, no PDF path. Closest surfaces are the dashboard `AgendaCard` (`dashboard/page.tsx:336-437`) and an events-only CSV export (`components/events/CheckinPanel.tsx:52-72`) | **Port.** FareHarbor's most-used staff screen, and coaches still work off paper at the door. Not "reporting" — an operational sheet | M |
| **Headline** — a public or private note pinned to one availability, shown on the calendar | `Session.notes` is internal-only | **Port.** "Marta subbing today", "outdoor — bring a jacket", "moved to studio B". Tiny feature, constantly wanted. Surface on the public slot list, the calendar, the kiosk board, and the reminder email | S |
| **Auto close** — cutoff after which a session is no longer bookable online | Only `windowMonths` (how far *ahead* you can book). No cutoff, no minimum notice for classes | **Port.** Operational must-have — a coach needs a frozen roster before they leave for the studio | S |
| **Booking ID** — short human-readable reference | Bookings are keyed `sessions/{sessionId}/bookings/{contactId}`; there is no short code to read out on a phone call | **Port** | S |
| **QR check-in scanning** | `useQrScanner` + the `checkInContact` wiring are **complete but shipped disabled** behind a "coming soon" badge (`sessions/[id]/page.tsx:665-677`; the scanner block is commented out at `:696-697`). Kiosk QR and member `selfCheckIn` do work | **Finish.** Not a port — it's built. Decide whether to ship it or delete the dead path | S |
| **Crew** — assign multiple staff to a session with roles, notify them with headcount and meeting point | Single `Session.providerId` | **Adapt.** Matters for studios running assistants or two-coach classes | M |
| **Availability updater** — bulk-edit many sessions across items and dates | Recurrence edit/delete scopes `single \| future` exist (`sessions/index.ts:364,432`); no cross-series bulk edit | **Port.** Real admin time-saver (holiday closures, seasonal time shifts) | M |
| **Custom calendars / custom manifests** — saved filtered views, assignable as a user's default | Contacts already has exactly this pattern — saved queries persisted to a `contact_filters` subcollection (`contacts/page.tsx:556-565,645`) | **Adapt.** Extend the existing pattern to the schedule and bookings pages rather than inventing a second one | M |
| **Recent activity** — dashboard-wide audit trail (who changed what, when) | Finance journal only | **Adapt.** Useful once teams have multiple managers | M |
| **Duplicate** any entity (item, custom field, resource) | Partial | **Port.** Quality-of-life | S |
| **Sonar** — realtime dashboard without refresh | Firestore listeners give this for free | **Already have** | — |
| **Push notification to staff** on a new booking | Automations exist; no staff-facing push | **Adapt** | M |
| **Transportation / pickup routes / lodging**; **Boca tickets**; **queuing** | — | **Reject.** Tourist-operator only: hotel pickups, thermal ticket printers, and high-demand drop queues have no coaching analogue | — |

### Theme C — Revenue and growth

| FareHarbor concept | Linyup today | Verdict | Effort |
|---|---|---|---|
| **Waitlist** | **Done — Wave 3 Phase 2.** Was: a full class threw `resource-exhausted` and the flow ended, with zero code hits for `waitlist` repo-wide. Now: a queue at `sessions/{id}/waitlist/{contactId}`, offered on the `seatFreedEdge` session trigger, held as an ordinary booking, claimed inside one deadline shared by the hold, the entry and the Stripe session. The capacity refusal it replaced now lives in `bookSession` (`booking/index.ts`) twice: the stale-count pre-flight that calls `healSessionSeatCount`, and the authoritative `countHoldingSeats` / `seatsFree` check inside the booking transaction — `docs/waitlist.md` | **Ported.** The highest-value *missing* booking feature: an empty seat in a paid class is leaked revenue, and a "sorry, full" dead end is the worst moment in the funnel. Shipped with the queue, the notifications, and the **race-safe claim window** | L |
| **Campaigns → promo codes** | **Done — Wave 3 Phase 3.** Was: zero occurrences of `coupon`, `promo`, `discount_code`, `voucher` anywhere. Now: `teams/{teamId}/promo_codes/{CODE}` (the code IS the doc id), applied as a **Stage A modifier inside `resolvePaymentOptions`** on the four one-off rails (drop-in, appointment, course, product), best-one-wins against the member benefit, with a deterministic reserve → commit → release lifecycle whose `usage_count` has exactly one writer — `docs/promo-codes.md` | **Ported**, and the prediction held: the redemption UX was cloned from `GiftCardRedeemField` into `PromoCodeField`, the lifecycle shape from `connect/giftCards.ts`, and the discount math is the `Benefit` vocabulary's price-modifying half (`percent_off` / `fixed_price`) sharing one clamp-and-round site with the benefit path. Two things the prediction missed: a promo is **not** simply "a `Benefit` keyed by a code" — it also owns a finite counter, which is what forced the reserve transaction and the one-writer rule; and it required the `product` resolver arm (§7.4) | M–L |
| **Customer types** — Adult / Child / Infant, each with its own price, description, and per-booking min/max (the live flow offered *Private Section 2-8*, *Cocktail Table max 2*, *Communal*, *Children*, *Infants*) | A booking is hard-keyed `bookings/{contactId}`; `bookings_count` increments by 1; Stripe line items are `quantity: 1` (`utils/connect/client.ts:256,303`). No party size, guest count, or quantity anywhere | **Adapt — do not port the full model.** The per-type price matrix is the tourist shape and would fight the member/subscription model (Linyup's answer to "who pays what" is *the contact's subscription*, resolved server-side — strictly better for a studio). Propose instead the **light version**: `Booking.guestCount` + an activity guest price, capacity decrementing by `1 + guests`, one payment. That unlocks bring-a-friend, parent-books-child, and couples classes without touching the pricing model | L |
| **Suggested items** — cross-sell shown during checkout *and* in the confirmation email | Shop has a "Pay per visit" cross-sell strip (`ShopHome.tsx:806-856`); nothing post-booking | **Port.** Cheap revenue on top of the existing automation engine, templates, products and courses | S–M |
| **Add-ons / upgrades** attached to a booking (the live flow offered +9% cancellation protection and a gratuity picker) | Products exist as standalone shop items; nothing attaches to a booking | **Adapt.** Real for a studio (rent a gi, hire a mat, add video analysis) but depends on guest count or a cart landing first | M |
| **Online cart** — multiple items, one transaction | No cart, basket or line-item collection anywhere; every purchase is single-item, single-charge | **Adapt.** Only needed once add-ons exist. Record as a *dependency*, not a goal in itself | L |
| **Dynamic pricing rules** — price by how full, how far ahead, or time of day | — | **Adapt.** Early-bird and off-peak pricing fit the `Benefit` model conceptually. Defer | L |
| **Deposits / partial payment** | Zero occurrences. The only "pay later" construct is the emailed no-show policy fee link | **Adapt.** Narrow but real — camps, retreats, multi-week course blocks | M |
| **Gift cards / gift certificates** | Fully built: mint, hold/commit lifecycle, partial cover, full-cover bypassing Stripe entirely | **Already have** | — |
| **Membership code** on the book form ("Are you a member?") | Better already — contact sign-in resolves the real price server-side | **Already have** | — |
| **Booking source** (`online \| affiliate \| direct`) + report-by-source | `Contact.source` exists as a marketing channel; nothing per booking | **Port.** Small field, and it feeds the existing dashboard | S |
| **Tips / gratuity** | Zero occurrences | **Reject.** Culturally out of place for CH coaching, and it muddies the subscription relationship | — |
| **Affiliates, ASN tracking, commission, OTA distribution, FHDN** | "Affiliation" in this repo means club/federation membership — unrelated. The Referrals plugin is member-get-member | **Reject the network — but flag one adjacent idea.** There is no OTA market for yoga classes, so the distribution moat doesn't transfer. However, the guest booking form *already* collects a fitness-app field (Fitpass / ClassPass / Urban Sports Club / Gymlib / Wellhub), and `SubscriptionType.source = 'aggregator'` with `payoutPerVisit` already writes a `partner_visits` ledger. Formalising that into tracked partner links with commission reporting is a genuine strategic option. **Named, not scoped** — see §6 | XL |
| **BNPL / iDEAL / Bancontact / Vipps** | Stripe Connect with TWINT + Apple Pay / Google Pay via dynamic payment methods (`utils/connect/client.ts:229-230`) | **Already have** the CH equivalent | — |
| **Seat maps / zones** | — | **Reject** for now. One real adjacent case exists (a spin studio letting members pick a bike); note it as a distant maybe, not a roadmap item | — |

### Theme D — Compliance and intake

| FareHarbor concept | Linyup today | Verdict | Effort |
|---|---|---|---|
| **Custom fields on the book form** — per-item, conditional, whole-booking vs per-person, and optionally private (staff-only) | **Absent.** The public booking form's only extra fields are two team-wide booleans, `showPhone` and `showFitnessAppField` (`team.ts:364-373`) | **Port.** Every piece already exists: the Forms plugin's field schema (`shared/src/types/form.ts:18-29` — text, choice, date, checkbox…), the per-type field precedent on events (`event.ts:41-63`), and contact custom fields. What's missing is **attaching a question set to an activity**, storing answers **on the booking**, and surfacing them on the roster and manifest. "Any injuries?", "shoe size", "how did you hear about us?" | M–L |
| **Waivers** — liability release signed at booking, status visible at a glance on the manifest | **No first-class concept.** The Documents plugin covers `terms \| privacy \| regulation \| other`, wired to the *signup* consent checkbox via `signup_documents` (`team.ts:420-425`). There is **no per-booking signature, no acceptance record, and no versioned acceptance ledger** | **Port.** More relevant here than at FareHarbor — martial arts, contact sport, and kids' classes make this a genuine liability question, and it's the compliance story that closes studio leads. Shape: a `Document` of kind `waiver` + a required-on-booking flag + an acceptance record keyed by contact **and document version** + a status column on the roster. Must handle **minor / guardian consent** (`Contact` already carries guardian fields) — **BUILT, Wave 3 Phase 4 (`docs/waivers.md`).** Three corrections from the implementation: the acceptance is keyed on the EVENT, not on `(contact, version)`, or re-signing after a revocation is unrepresentable; the contact's "guardian fields" are `emergency_contacts`, which identify nobody and were never a consent mechanism; and minor consent is a **self-declaration on the consent step plus a chip on the roster**, not a verification — an emailed one-time link was built and then removed (2026-08-16) because it proved control of a mailbox rather than parenthood, at the price of a public mail-sending surface | L |
| **Health & safety policies** shown throughout booking | — | **Adapt.** Generalise into the same policy block as cancellation notes (Theme A) rather than a separate field | S |
| **Receipts** — printable branded transaction record | Stripe emails its own receipt; no branded document | **Adapt.** Ties into the manifest's print infrastructure | M |
| **Permission groups** | Roles + capabilities (`shared/src/types/capabilities.ts`) | **Already have** | — |

### Theme E — Structural (name it, don't schedule it)

| FareHarbor concept | Linyup today | Verdict |
|---|---|---|
| **Resources & shared resources** — capacity governed by a shared physical thing (a boat, a room, an equipment pool), so concurrent activities can't overbook it | **No entity.** `PlaceRoom` is `{ id, name }` (`place.ts:12-15`); a session can carry `roomId` and the form sets it, but **nothing validates it** — no conflict check, no capacity. The only overlap check in the whole system is per-provider, for appointments (`session.ts:17-22`) | **Port in two phases.** **Phase 1:** make `roomId` an actual constraint — one session per room per time window. Cheap, and it catches the mistake studios actually make (two classes scheduled into one room). **Phase 2:** a countable `Resource` with a shared pool — 8 reformer beds drawn on by three different class types. Phase 1 alone earns its keep and is a fraction of the cost |
| **Translations** stored per tenant | Linyup's *UI* is four-language (en/de/fr/it, all four national languages). A studio's *content* — activity names, descriptions, policies — is single-language | **Port, eventually — but decide now.** For a Swiss product this is a differentiator, not a nicety: a Basel studio serving German and French members currently has to pick one. It turns every public content field into a localised map, so it is genuinely XL. **The decision is time-sensitive**: Theme A adds several new content fields, and retrofitting them later costs more than designing them localisable now. See §6 |
| **Zapier / external API** | Org tier already plans API access (`docs/product-strategy.md` §2, Tier 3) | **Already planned** |

---

## 4. Recommended sequencing

Ordered so launch-critical polish lands first and structural work lands after v1 is
out.

### Wave 1 — before or at launch

All **S**, all additive, no data-model changes, no new collections.

- Rich activity detail (meeting point, what to bring, what's included, FAQ)
- Cancellation / health-and-safety policy block, shown at booking **and** in emails
- Session headline (public / private)
- Booking cutoff time
- Human-readable booking reference
- Live price breakdown on the final wizard step
- Ship (or delete) the built-but-disabled QR check-in scanner

*Rationale: this is the entire "feels solid" delta from §2, and none of it risks the
launch. The activity detail alone closes the gap that made FareHarbor's item page
feel more finished than ours.*

### Wave 2 — first post-launch

Mostly **M**.

- Printable manifest / day sheet
- Per-activity booking questions
- Finish the `date-first` booking flow (already selectable in settings)
- Google rating / social proof
- Per-booking source attribution
- Post-booking cross-sell in the confirmation email
- Bulk session editing

### Wave 3 — revenue and compliance

**L** each. Designed in detail in §7 below — including the phase order, which is
*not* the order listed here. Gift-card flow review was added to this wave in
2026-08 (guest purchase, admin minting, and a category-attribution fix).

- ~~Gift-card flow review — guest purchase, admin mint, category attribution~~
  **done** (Phase 0 + Phase 1, `62fc546`)
- ~~Waitlist~~ **done** (Phase 2) — `docs/waitlist.md`
- ~~Promo codes / campaigns~~ **done** (Phase 3) — `docs/promo-codes.md`
- Waivers with a real acceptance ledger

### Wave 3.5 — surface discipline (queued 2026-08-15)

**S–M.** Not a FareHarbor finding — a consequence of shipping Wave 3. Three
capabilities landed that a *new* studio does not need on day one, and a crowded
first impression is its own product defect. Franco's call, with the reasoning in
§7.8.

- Gift Cards → **plugin** (`commerce`)
- Promo Codes → **plugin** (`commerce`); the Studio *plan gate* becomes a plan
  *limit* — one gate, not two
- Waitlist → **NOT a plugin**; a team default in `Settings → Booking` beside
  `cutoffMinutes`, with the existing per-activity toggle kept as an override

Sequencing is open: this can land before or after the waivers phase. It touches
no waiver surface either way, so the choice is about what Franco wants demoable
first, not about a dependency.

### Wave 4 — dissolved (2026-08-15)

**There is no Wave 4.** Franco cut it: room conflicts / resources, guest count and
crew assignment are advanced features that a small or medium studio does not
actually need. They are recorded in §5 with their reasons rather than left on a
roadmap nobody intends to run.

**Tenant content translation is the exception** — it left Wave 4 alive rather than
declined. Not as a per-locale authoring UI (that is rejected outright), but as
machine translation written into the `public_profile` mirrors so the German-language
pages are *indexable*. The driver is findability, not comprehension: see §6.1.
Unscheduled, and shaped there in enough detail to be picked up directly.

One carve-out survives, and it is not a Wave 4 item: `PlaceRoom` is settable on a
session and **never validated**, so a studio can already assign two classes to one
room and get no warning. That is a half-built field that lies, not a missing
feature — either validate it or stop offering it. Small, unscheduled, worth doing
the next time someone is in `sessions/`.

<!-- ─────────────────────────────────────────────────────────────────────────
     EXECUTION QUICK-REF (Claude Code settings per wave) — not product content.

     | Wave | Model    | Effort | Orchestration                    |
     |------|----------|--------|----------------------------------|
     | 1    | Sonnet 5 | high   | solo                             |
     | 2    | Opus 5   | high   | solo (optional 3-way fan-out)    |
     | 3    | Opus 5   | xhigh  | ultracode — say "ultracode"      |
     | 4    | Opus 5   | xhigh  | solo                             |

     Model/effort must be set by hand in the app's model picker — Claude can't
     change its own mid-session (it can only pick models for subagents it
     spawns). Effort and orchestration are orthogonal: Wave 3 is xhigh AND
     ultracode, not one instead of the other.

     Start each wave in a NEW session: keeps scope contained (Opus 5 tends to
     widen it), and a mid-session model switch invalidates the prompt cache
     anyway. Prompt is just: "Do Wave N from docs/fareharbor-analysis.md".

     Wave 1 on Sonnet only saves money if the WHOLE session runs on Sonnet —
     delegating to Sonnet subagents from an Opus session still bills the main
     loop (file reads, review, decisions) at Opus rates.

     Wave 3 is the only one worth the fan-out: promo codes / waitlist / waivers
     are independent projects, and each has real correctness risk (resolver
     math, the race on a freed seat, versioned consent) that earns an
     adversarial verify panel. Wave 2's three items are independent too, but
     carry no correctness risk — parallelise if you like, skip the verify panel.

     Don't want to manage it? Run everything on Opus 5 high, bump to xhigh for
     Wave 3 only. One switch total; Wave 1 costs a bit more, which is a fine
     trade if the switching is friction.

     Fable 5: not worth 2× for any of this — it's tuned for work above what
     Opus 5 can do, and every wave here is well-specified porting into a
     codebase with strong conventions. The one item to reconsider it for is
     Wave 4's tenant content translation; try Opus 5 xhigh there first. (Also
     needs 30-day data retention — unavailable under zero-retention.)
     ───────────────────────────────────────────────────────────────────────── -->

### Plan-tier placement

Against `docs/product-strategy.md` §2 tiering:

| Item | Tier | Why |
|---|---|---|
| Manifest, headline, booking cutoff, booking reference | **Coach** | Core daily operations — a solo coach needs these as much as a studio |
| Booking questions | **Coach** | Custom Fields is already standard in Coach as of 2026-06 |
| Waitlist | **Coach** | Already listed under Coach in the strategy doc |
| Promo codes | **Studio** | A growth lever, and it sits alongside Referrals |
| Waivers | **Studio** | Compliance is a studio/club concern; plausibly its own plugin add-on |
| ~~Crew assignment~~ | — | Declined 2026-08-15, §5 |
| ~~Resources~~ | — | Declined 2026-08-15, §5 |

Superseded for two rows by Wave 3.5 (§7.8): **Gift Cards** and **Promo Codes**
become `commerce` plugins, so install state is their gate and the plan decides
limits, not access. The waitlist stays a Coach-plan feature with a team-level
booking setting.

---

## 5. Rejected, with reasons

Recorded so these don't come back around:

| Rejected | Reason |
|---|---|
| OTA / reseller distribution (FHDN, external API for resellers) | No equivalent marketplace exists for recurring class bookings. FareHarbor's moat doesn't transfer |
| Affiliate network with ASN tracking and commission | Same. The narrower fitness-aggregator idea is kept alive separately in §6 |
| Transportation, pickup routes, lodging | Tourist logistics |
| Seat maps and zones | Theatre/vessel seating. The spin-bike case is noted but doesn't justify the machinery |
| Boca tickets | Thermal ticket printers |
| Queuing (virtual line for high-demand drops) | Solves a scale problem no coaching business has |
| Refund reserve | A payment-facilitator concern; Stripe Connect handles this |
| Visitor-currency display | Single-market CH |
| BNPL / regional EU rails (Afterpay, iDEAL, Bancontact, Vipps) | Stripe dynamic payment methods already cover the CH equivalent (TWINT, Apple/Google Pay) |
| Tips / gratuity | Culturally out of place for CH coaching; muddies the subscription relationship |
| **Full customer-type pricing matrix** | Adapted, not rejected outright — see Theme C. The full matrix fights the subscription model; the guest-count subset is kept |

**Added 2026-08-15**, when Franco dissolved Wave 4. These were *scheduled* and are
now declined — a stronger statement than never having considered them:

| Rejected | Reason |
|---|---|
| **Resources with shared pools** (8 reformer beds across three class types) | Advanced. A small or medium studio does not have a contended equipment pool; the ones that do are not the first market. The cheap half — validating `roomId` so one room cannot host two concurrent sessions — is kept as an unscheduled integrity fix, because the field already exists and currently promises something it does not deliver |
| **Guest count on a booking** | Supersedes §6.2, which asked whether the demand was real: the answer is that it is not, for the studios being sold to now. Bookings are keyed by `contactId`, so this is an **L** that touches capacity, pricing and the webhook. A parent booking for two children is already expressible as contact selection at sign-in |
| **Crew assignment + staff notifications** | Needs multiple managers, which is Studio-gated anyway. A single `providerId` covers the small-studio reality, and the studios large enough to want a second assigned coach can name them in the session headline |
| **Tenant content translation** (as *per-locale authoring*) | Only the authoring UI is rejected — owners will not maintain four versions and a half-filled page reads as broken. **Machine translation into the public mirrors is NOT rejected**: see §6.1, revised 2026-08-15 once it became clear the driver is findability, not comprehension, and that browser translation does nothing for SEO |

---

## 6. Open questions

Three decisions this analysis surfaced but could not make. **Two are now resolved**
(2026-08-15) and are kept with their answers rather than deleted, so the reasoning
survives the decision.

### 6.1 Tenant content translation

**1. Tenant content translation — RESOLVED 2026-08-15: no per-locale authoring,
ever. Machine translation into the PUBLIC MIRRORS, for findability. Shaped below;
not yet scheduled.**

> **Status 2026-08-28: the shaped machine-translation path SHIPPED for the
> website + embed surfaces** — author-once in the tenant's language, translate
> at publish into hash-guarded per-locale stores, `hreflang`, and the binding
> text rule below obeyed. Full architecture: `docs/site-translations.md`. The
> `public_profile` **booking/shop mirrors remain unscheduled** — the
> `sync*PublicProfile` translation step shaped below is still open.

> **Revised later the same day, and the revision is the important part.** The
> first answer below was "don't build it", resting on two claims. One of them was
> wrong.
>
> **The driver is discoverability, not comprehension.** Franco's own club (HMD
> Basel) targets an English-speaking audience, and its website analytics show
> visitors from Basel and the surrounding region switching to German anyway —
> people who are perfectly happy speaking English in the room. Wanting the page in
> your own language is about trust and search, not about understanding.
>
> **And browser translation does not solve SEO.** Chrome translates *after* the
> page is served, in the visitor's browser; Googlebot indexes the served HTML. An
> English-only page is therefore invisible to someone searching "Kampfsport
> Basel". The "browsers translate anyway" argument answers comprehension and is
> simply irrelevant to acquisition — which is the half that has revenue attached.
>
> What survives unchanged: **no per-locale authoring UI**, for the half-filled-page
> reason below. The studio authors once, in its own language.

The timing question below is now moot and is kept as a record: Wave 1 shipped
those fields as plain strings, so the cheap moment passed. Retro-fitting locale
maps is now strictly more expensive than it would have been — which is an argument
against doing it, not for hurrying.

*The decision, and the reasoning.* A per-locale authoring UI fails on the studio's
side before it fails on ours: owners will not write and maintain four versions of
every activity description, and a **half-filled** translation is worse than none —
a page that is half German and half English reads as broken. Meanwhile browsers
translate whole pages competently now, so the honest marginal value of building it
is *quality and control*, not capability. Not worth an XL schema change across
every public content field.

*What to do instead, at no cost:* make sure the public pages declare `lang`
correctly and do nothing that fights browser translation. That is the 90% answer
for free, and it should be verified rather than assumed.

### The shape, if and when it is scheduled

**Translate into the `public_profile` mirrors at sync time.** This is smaller and
better-formed than the read-time cache the first draft proposed, and the revision
above is what made it visible.

- The public surfaces already read only from `public_profile` mirrors — denormalised
  projections written by the `sync*PublicProfile` functions. Those functions gain a
  translation step. **Growing a projection is a projection's job**, so there is no
  schema churn on the source of truth and no locale maps on `Activity`, `Course` or
  `Team`.
- The routing already exists: `next-intl` with `localePrefix: 'as-needed'`, so
  English keeps clean URLs and German is `/de/...`. What is missing is content at
  those URLs, plus `hreflang`.
- Because the pages are server-rendered from the mirror, the result is **genuinely
  indexable** — which is the entire point, and the thing a read-time client cache
  would not have delivered.
- The studio authors **once**, in its own language. No per-locale UI, ever.

**Never machine-translate binding text.** Marketing copy — activity description,
what's included, FAQ, meeting point — is safe, and a small muted disclaimer on the
page is sufficient for it (Franco's call, and correct). A **cancellation policy, a
waiver, or terms** are not: a mistranslated refund rule is a dispute you lose on
time even where you would win on law. Those render in the original with a note.

The reason this costs nothing to obey: **nobody searches for a cancellation
policy.** All of the findability value sits in the marketing surface, so keeping
binding text untranslated forfeits none of the benefit. The split is free.

**Cost is not the blocker**, and it is worth recording so it stops being raised as
one. The translatable surface is tens of thousands of characters per studio,
one-time plus edits — cents to low single-digit francs per tenant at commodity
machine-translation rates, and an LLM pass is cheaper still and better at short
marketing copy it can be given domain context for. The real costs are re-translation
on every content edit, mirror growth, and accountability for a wrong translation —
all three bounded by the marketing/binding split above.

### 6.2 Guest count

**2. Guest count — RESOLVED 2026-08-15: declined.** See §5. The demand is not real
for the studios being sold to now, and contact selection at sign-in already covers
the parent-books-children case that motivated it.

### 6.3 The fitness-aggregator partner rail

**3. The fitness-aggregator partner rail — bet or distraction?**
The pieces are half-built already (the fitness-app field on the guest form,
`SubscriptionType.source = 'aggregator'`, the `partner_visits` payout ledger). The
question is whether Linyup wants to be the system of record for a studio's
ClassPass/Fitpass relationship, or just record that a visit came from one. The first
is a strategic bet; the second is what exists today and may be enough.

---

## 7. Wave 3 — resolved design

Added 2026-08 after a design pass: four specs written against the code, each
adversarially reviewed, plus a cross-cutting analysis of how they collide. The
full specs and critiques live in the workflow journal at
`.claude/projects/…/subagents/workflows/wf_fc749ebe-409/journal.jsonl`. This
section records only what was *decided*.

### 7.1 Decisions (settled — do not re-litigate)

| Question | Decision |
|---|---|
| Waivers: where | Extend Documents (`kind: 'waiver'`) with **immutable published version snapshots**; acceptance keyed by `(contact, documentId, version)` |
| Promo vs member benefit | **Best-one-wins** — never stacked. `appliedBenefit` and `appliedPromo` stay mutually exclusive on the wire. **Refined in Phase 3:** exclusive as the field that *prices* the option, which is what "never stacked" means; a benefit a promo beat still rides out on `appliedPromo.supersededBenefit`, or every campaign would blank the studio's own `subscription_type_id` attribution for exactly the members who used the code. The comparator is also deliberately asymmetric — a benefit applies when it does not *raise* the price, a promo only when *strictly lower* — because the two fields answer different questions |
| Waitlist promotion | **Notify + claim window**, uniform for free and paid, respecting the booking cutoff |
| Admin gift-card mint | Asks **paid or comp**. Paid → `recordManualPayment`. Comp → no journal entry (correct on cash basis), stamped for audit |
| Gift-card category | **Fix it.** Redemptions must attribute to their real category, not sit in `'other'` |
| Plan/plugin gates | Gates control **creation only**. Every in-flight object completes its lifecycle regardless — an outstanding waitlist offer, a reserved promo slot, and a required waiver all survive a downgrade |

### 7.2 The pricing rule (write this down once, obey it everywhere)

The single most important output of the design pass. A single drop-in booking
can involve a member benefit, a promo code *and* a gift card, and "best-one-wins"
only settles the first two.

> **A price modifier belongs in Stage A (inside `resolvePaymentOptions`).
> A tender belongs in Stage B (at the checkout callable). Nothing may be both.**

```
STAGE A — PRICE (pure, resolver):
  list price → best-one-wins(member benefit, promo) → clamp ≥ MIN_CHARGE_MAJOR → pay.amount

STAGE B — TENDER (impure, callable):
  pay.amount → gift-card drawdown (planGiftCardRedemption) → residual → Stripe
```

Promo is Stage A. Gift card is Stage B. `spend_credits` is Stage A but is a
*coverage* answer, not a tender.

**Two different 0.50 floors, and the difference is load-bearing.** The PRICE
floor clamps inside the resolver (authored values throw, derived values clamp).
The CHARGE floor protects the residual by **shrinking the drawdown**, never by
clamping the residual — clamping there would create money from nothing.

A useful consequence: putting promo *inside* the resolver means the gift-card
call sites already receive a post-promo total and need no edit at all. The promo
spec's largest self-flagged money-loss risk dissolves entirely — it was only
real if promo were applied outside the resolver.

**Confirmed in implementation, with one narrowing.** No gift-card call site
needed a *promo* edit: `reserveGiftCardDrawdown` still receives `totalMajor:
priceMajor` unchanged, and that figure is now post-promo. They did each gain one
unrelated argument — `holdMinutes`, from `resolveCheckoutHoldWindow` — but that
is bug B3 below, not the promo.

### 7.3 Pre-existing bugs the design pass uncovered

**None of these are Wave 3 features. All were live when this was written.** Each
was confirmed against the code, not inferred. **1, 3 and 4 were fixed in Phase 0 +
Phase 1 (`62fc546`); 2 was fixed in Phase 2.**

1. **Refunds silently destroy gift-card value.** `connect/refunds.ts` has zero
   gift-card handling — no hits for `gift`, `drawdown`, or
   `restoreGiftCardDrawdown`. `refundMemberPayment` refunds the Stripe residual
   only, so a refunded gift-card booking loses the customer's stored value
   outright. Fix in Phase 1.
2. **`rebookSession` can oversell.** No `max_participants` check anywhere in
   `booking/index.ts:1530-1645`. Rebooking into a full session succeeds. Fix in
   Phase 2. **Fixed:** the `db.batch()` became a transaction that reads the new
   session and its bookings and refuses with `reason: 'session_full'`, and it
   gained the `isPastBookingCutoff` check it had never had — bound to the public,
   self-service door only, since the same callable also serves the studio's
   Bookings page, where a coach on the phone at 18:30 moves someone into the
   19:00 class.
3. **An abandoned checkout can make a class un-bookable for up to 24 hours.**
   `trackBookings`' `NON_HOLDING` set counts any booking not in
   `{cancelled, no_show, rebooked}`, so a lapsed drop-in payment hold keeps
   holding its seat until the 02:00 sweep. Fixed by `bookingHoldsSeat` in Phase 0.
4. **The gift-card price breakdown lies to the customer.**
   `BookingForm.tsx:1725-1728` uses `Math.min(balance, afterBenefit)` instead of
   `planGiftCardRedemption`, so it doesn't model the floor-shrink: price 20 with
   a 19.80 balance shows "−19.80, total 0.20" while the server draws 19.50 and
   charges 0.50. Fix in Phase 0 — *before* a promo line makes that branch common.
5. **Full-cover redemption writes no `finance_transactions` row at all** — a real
   money-equivalent event missing from the journal. This is the hole the
   category fix nominally exists to close.

**Phase 3's own pass found eight more, all live at `4b3177f`** — numbered B1–B7
as in the Phase 3 design pass (since retired — see `docs/promo-codes.md`), plus B3b,
the second half of B3. **Seven were fixed in Phase 3** because each sat on a line
promo was rewriting anyway; B6 was named and deliberately left alone.

| | Defect | Resolution |
|---|---|---|
| **B1** | A `fixed_price` member benefit **above** the base price charged the member MORE than the guest, and stamped `appliedBenefit` so the UI struck through the *lower* figure. Authorable through the benefit editor, which validates only `amount >= 0.50` and never cross-checks the target's price | The one comparator now starts its incumbent at the list price and only ever lowers it, so "a modifier never raises a price" is true by construction. B1's fix and the promo's comparator are literally the same function |
| **B2** | `createProductCheckout` bypassed `resolvePaymentOptions` entirely, and `pricingSurface`'s `source` union already carried a dead `'product'` member proving it | The `product` arm, and the callable routed through it. The dead union member is live |
| **B3** | On a waitlist claim the gift-card hold expired at +35 min while the Stripe session it guarded stayed payable to +120 — so the held value came back and another purchase could spend it | `resolveCheckoutHoldWindow` derives both from **one** instant; the hold now outlives its session by a bounded margin |
| **B3b** | The plain product and course checkouts took Stripe's **24-hour** default expiry — only their gift-card sub-branches passed a short one | Any one-off checkout carrying a reservation of a finite thing gets the short window. A no-instrument purchase keeps its 24 hours |
| **B4** | The gift-card hold-key comments claimed holds are "keyed by Stripe Checkout Session id" while all three call sites mint the key *before* any session exists | Comments corrected. The promo reservation key has the identical ordering constraint, so the stale claim would have misled the next reader directly |
| **B5** | `MemberPayment.kind` declared four members; the webhook — its only writer — writes seven | Union widened to what the writer writes, with the writer named on the line |
| **B6** | `mapCategory` has no `'appointment'` case, so appointment revenue lands in `'other'` | **Named, not fixed.** No promo path depends on it; recorded so nobody assumes Phase 3 blessed it |
| **B7** | `releaseReservedGiftCard`'s comment named a caller that does not exist — the capacity refusal it cited had moved above the reservation in Phase 2 | Comment fixed alongside the promo release it sits beside. It had already caused harm: an earlier revision of the promo spec cited that stale comment as evidence for where the promo release should go |

### 7.4 Phase order

Deliberately **not** the order the items were listed in. Each phase's placement
is justified by what it unblocks.

**Phase 0 — shared foundations.** No user-visible feature; each item is otherwise
re-invented three times.

1. `checkoutRateLimit(ipRaw, prefix?)` — one signature covers the promo preview,
   gift-card check, and guest purchase.
2. `bookingHoldsSeat` + `isExpiredWaitlistClaim` in `shared/src/types/session.ts`,
   beside `isExpiredAppointmentHold` and `appointmentSlotBlocked` — they are the
   third member of an existing family. `trackBookings` switches to it.
   **Correction (2026-08, from implementation):** this does *not* fix bug #3 on
   its own, as originally claimed here. `trackBookings` only fires on booking
   writes, and `bookSession` refuses at the capacity gate *before* writing — so a
   stale-full class stayed stuck. The fix needs the capacity gate itself to
   re-count live holds before refusing, and to persist the correction
   (`bookings_count` **and** `status`, or the public mirror still advertises
   'full').
   **Second correction:** freeing the seat at +30 min while the Stripe session
   stayed payable for 24 h turned "buyer abandoned checkout" into "class
   oversold and buyer charged for a seat that no longer exists". Every drop-in
   checkout now expires at `SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES`, not just the
   gift-card ones.
3. `commitGiftCardHold` returns the committed amount; null-guard the dedupe query.
4. The client price breakdown calls `planGiftCardRedemption`. Fixes bug #4.

**Phase 1 — Gift cards.** First, because it is the only project *fixing existing
production behaviour on real money* rather than adding surface. Widening
`FinanceCategory` is a compile-time break across all three chart templates —
far cheaper to land now, at pre-launch data volume. Its
`commitGiftCardDrawdown(...)` wrapper becomes the single hook that promo's commit
and the waitlist claim-confirm both ride on: four scattered call sites collapse
to one function, and later phases add one field each instead of rediscovering
them. Also fixes bug #1.

**Phase 2 — Waitlist.** Second, because it carries the only hard prerequisite
that **rewrites a hot path**: `bookSession`'s capacity check must become
transactional. Every later feature merges into the rewritten version — doing
waivers first means relocating the waiver gate twice. Touches no money surface
in this order (join is free; claim routes into the existing
`createDropInCheckout`). Also fixes bug #2.
**Correction (2026-08, from implementation):** "touches no money surface" held for
*pricing* — the claim adds no arm to `resolvePaymentOptions` and no price of its
own — but not for the money **plumbing**. `createDropInCheckout` gained a
`waitlistToken` input (the claim's deadline replaces the 30-minute hold on both
the booking and the Stripe session), its gift-card full-cover branch had to flip
the queue entry in the same transaction as the booking (that branch creates no
Stripe session, so no webhook can do it later), and the Connect webhook gained a
capacity re-check that **refunds** rather than confirming into a full class. The
`commitGiftCardDrawdown({ waitlistEntryId })` rider Phase 1 declared for this was
removed rather than implemented — the booking is already confirmed before it runs,
and both of that function's early returns skip anything placed after them.

**Phase 3 — Promo codes.** Third, because it is the only project changing the
**signature of `resolvePaymentOptions`**; landing it last means it lands once,
against settled call sites. It must also add a `product` target arm —
`createProductCheckout` currently bypasses the resolver entirely
(`resolveProductPrice` → `requireChargeableAmountFromMajor`), which is a genuine
one-resolver repair, but one only promo requires.
**Correction (2026-08, from implementation):** the signature change itself cost
nothing — an **optional third `context` parameter** meant every pre-existing
call site compiled and behaved unchanged, and `paymentOptions.test.ts` took 671
added lines and **zero deletions**, so every pre-existing fixture is still
byte-identical under `assert.deepEqual`. The expensive half was elsewhere,
and this section did not predict it: a promo owns a **finite counter**, so it
needed a reserve → commit → release lifecycle with exactly one writer of
`usage_count`, a deterministic reservation key (so a buyer's own retry refreshes
rather than refuses her), and an ownership marker on top of that key. Three
further decisions changed the shipped shape against what was designed here:

- an **audience axis** (`audience: 'all' | 'new_contacts'`) was added, because
  best-one-wins otherwise hands a public "20% off" campaign to the 120 members
  who already hold a 10% benefit and acquires nobody;
- the **waitlist claim page takes no code** — reversing what Phase 2 had assumed
  and what a comment in `claim.ts` had asserted. The claim rail's deadline
  cannot be shortened without giving one seat two timers, so a code there would
  lock a use of a strictly-capped campaign for the whole claim window;
- the `commitGiftCardDrawdown({ promoRedemptionId })` rider Phase 1 declared for
  this was **deleted rather than implemented**, exactly as Phase 2 deleted
  `waitlistEntryId` — that function only runs when a gift-card code was supplied
  at all, so a promo used *without* a card would never have committed.

**Phase 4 — Waivers.** Last, because it has the largest independent surface
(versioning, immutable snapshots, acceptance ledger, minors model, rules
tightening, a new public mirror) and the smallest interaction footprint — no
waiver arm in `resolvePaymentOptions`, so it never contends for the price
pipeline. Its one prerequisite is Phase 2's transactional `bookSession`: the
gate must refuse *before* contact creation and write *after* the booking commits.
**Shipped 2026-08-15 — `docs/waivers.md` is the shipped-behaviour document.**
**Correction (2026-08, from implementation):** the footprint claim held — `git
diff` on `paymentOptions.ts` is empty for the whole phase — and the *placement*
rule reversed on the second half. The acceptance is written **inside** the commit
transaction, not after it: post-commit on `bookSession` is the zone where the
partner ledger and the contact alert swallow their own failures, and an
acceptance that can fail while the seat commits is an evidence hole in a
compliance feature. That satisfies the rule's intent (nothing recorded for a
booking that never happened) more strictly, and costs one extra single-document
read. Three further shipped shapes differ from what was designed here: the
deterministic acceptance id had to gain the **event's own nonce** or re-signing,
renewal and re-signing-after-revocation are all unrepresentable (§7.7's blocker);
the **`notify` publish outcome was deferred to v2**, leaving two outcomes and a
declared-but-writer-less `notices` subcollection so adding it later is an
addition rather than a migration; and **every rail refuses** — the two deferring
rails this section originally described (the waitlist claim and the kiosk
walk-in) existed only because a guardian's emailed signature could not be
completed in the window, and both went with that mechanism on 2026-08-16.

### 7.5 Commits that must not be split

Each of these is atomic — splitting produces a broken intermediate:

- `FinanceCategory` + all three chart templates + `chartTemplates.test.ts`
- Transactional `bookSession` + `bookingHoldsSeat` in `trackBookings` + retiring
  the blind `FieldValue.increment()` call sites (leaving both styles in place
  lets the transaction's read set and the increments interleave, with the
  recount papering over it non-deterministically) — **landed in Phase 2**;
  `bookings_count` now has exactly one writing style, and the rule is recorded on
  the field itself and in `docs/waitlist.md`
- Promo's resolver signature + `product` arm + the fixture regression gate in
  `paymentOptions.test.ts` — **landed together in Phase 3**, and the pairing
  earned itself: the base-as-candidate comparator that gives the promo its
  "never raises a price" property is the same edit that fixes B1, so splitting
  it would have shipped a signature nothing exercised, or a new arm with no
  regression net. A second atomic group emerged during implementation and is
  worth recording beside it: **reserve + commit + release + all four call
  sites**, because a reserve without a commit gives the discount and never
  counts it, and a commit without a reserve has nothing to commit

### 7.6 Resolved: guardians and Documents de-gating

Both settled 2026-08 by a second design pass (`wf_9aab7697-8e6`).

> **SHIPPED 2026-08-15, AND THE GUARDIAN HALF WAS THEN WITHDRAWN IN FULL
> (Franco, 2026-08-16). `docs/waivers.md` is the current document; everything
> below about `Guardian[]`, minor detection, `guardianRequired` and the emailed
> link is kept as the reasoning it was decided on and describes NO CODE.**
>
> - **The emailed guardian link is gone**, with the ~2,500 lines, the
>   `guardian_requests` store, the three public callables, the signing page, the
>   mail template, the four rate-limit counters and the date-of-birth question.
>   An emailed link proves control of a MAILBOX, not parenthood — a teenager with
>   a parent's phone defeats it — so it bought evidence barely stronger than a
>   checkbox at the price of a public, studio-branded mail-sending surface on the
>   booking path. What replaces it: one optional flag on the waiver
>   (`mayIncludeMinors`), a second required choice on the consent step (*I am the
>   participant* / *I am signing as a parent or guardian*, with an optional
>   name), stored as a **self-declaration** nothing verifies, and a chip on the
>   roster and the printed manifest so the studio — the party with the exposure,
>   and the only party who can actually check — verifies at the door.
>
> - **No `Guardian[]` type was built.** With the ledger snapshotting the signer —
>   which this section already specifies two paragraphs down — a freely-editable
>   array on the contact would be a second source of truth for a question the
>   ledger already answers, and would invite exactly the read the emailed-link
>   decision forbids. A repeat guardian's pre-fill comes from their most recent
>   guardian acceptance instead.
> - **`guardianRequired` defaults to `never`, not `if_minor`** (Franco, D3): the
>   common case is an adults-only studio, and a date-of-birth field on the
>   acquisition path is a real conversion cost for a guard most tenants never
>   need. Its failure mode is silent, so the compensating requirement is
>   **visibility** — the control renders inline in the waiver editor, never
>   collapsed, with one line stating what `never` means.
> - **De-gating went further than this section proposes** (Franco, D2): the
>   public document pages are de-gated too, with **indexability** gated on a paid,
>   *active* plan instead — `noindex` below it, so the page always works and
>   nothing has to be withdrawn later. The `installed_plugins/documents` teardown
>   arm was **deleted** rather than worked around, so a downgrade no longer
>   destroys a team's document mirrors at all.
>
> One clause below is also wrong on its own terms and is corrected rather than
> deleted: **Coach has no "one-plugin explore slot" to free** — no per-plan
> install count exists anywhere in the repo, and a Coach team could never install
> Documents in the first place (the client-side install route the plan is sent
> down is denied by the rules). The de-gating case stands without it.

**NOT BUILT — Guardians as a distinct `Guardian` type.**
They look structurally similar but differ where it counts: a guardian's `email`
is **required** (it is the identity consent is recorded against, and
`EmergencyContact.email` is optional), a guardian is legally load-bearing where
an emergency contact is freely-edited operational data, and every consent path
must answer *"may this person sign?"* from the type rather than a runtime filter
on a mixed array. Array capped at 2 (separated parents are the ordinary case
under Swiss joint parental authority); guardians remain **embedded on the
contact**, never counted rows, preserving the contact-cap invariant.

The acceptance ledger **snapshots the signer** rather than referencing the
guardian array, so removing a guardian never rewrites history.

**NOT BUILT — minor detection, three states, and an age question.**
`minor | adult | unknown`, with a declared `requires_guardian_consent` flag
beating any computed value. Since the guest booking form collects no birthdate,
*every* guest-booked contact starts `unknown` — so neither default is acceptable:
treating unknown as adult is a silent compliance hole on the highest-volume
intake path; treating it as minor taxes every adult booking. Instead the waiver
itself carries `guardianRequired: 'never' | 'if_minor' | 'always'` (default
`if_minor`), and on `if_minor` + `unknown` it asks for a date of birth **once,
inside the waiver step, with the reason stated** — and nowhere else in the
product. An adults-only studio (`never`) pays zero age questions; a kids' club
(`always`) skips the age question entirely.

> ⚠️ ~~Amend `docs/product-strategy.md:313-314`~~ — **DONE, and not as written
> here (2026-08-16).** That line was amended twice. The first correction stands:
> the counting invariant holds, and it conflated guardians with
> `Contact.emergency_contacts`, which is freely-edited operational data that
> identifies nobody. But the fix this callout asked for — *"a guardian needs a
> required email"* — is now the wrong correction, because the required guardian
> email went with the emailed link. A guardian declaration is not stored on the
> contact at all: it is `signer_role` / `signer_name` on an acceptance event in
> the waiver ledger, self-declared and unverified.

**Documents becomes a default feature, not a plugin.** It was never monetised —
`minPlan: 'free'`, no `addon` field, gated purely by install state — so this
gives away no revenue and, on Coach, may free the one-plugin explore slot. It
also removes a real defect structurally: uninstalling the plugin batch-deletes
every document public-profile mirror, which under Wave 3 would make a booking
gate point at content that no longer resolves.

Deliberately **not** replaced by an "extended documents" plugin — that would
create confusion for no gain.

> ⚠️ **De-gating is not a no-op on existing data.** The critique found the
> design's "existing-data effect: none" claim to be false and load-bearing:
> teams holding documents that are `published + isPublic` while the plugin is
> uninstalled would have those surfaces **flip live** the moment the gate is
> removed. Pre-launch this is seed data only, but the migration must audit and
> resolve that set *before* the gate comes out, not after.

`signupDocumentIds` currently lives in `installed_plugins/documents.config` —
plugin-shaped storage that needs a new home plus a dual-read migration. The
critique flagged a silent no-op-save window in the proposed ordering; the
config move must land with the read/write switch, not before it.

### 7.7 Remaining risk before implementation

Every spec came back with blocker-class defects. These must be folded in, not
discovered during implementation:

- **Gift cards** — 4 blockers, including a major/minor units disagreement that
  would record **100× the cash**, and a non-atomic reclassification pair.
- **Waitlist** — 3 blockers, including a gift-card full-cover claim that loses
  both the money and the seat, and no capacity check at all on the paid path.
  **Resolved** in the Phase 2 design pass (retired; see `docs/waitlist.md`) and closed in the
  implementation; that pass also found ten further findings neither the design nor
  its critique had caught (§0.4), four of them live miscounts or record
  corruption — including `markNoShowBookings` stamping abandoned drop-in checkouts
  `no_show` on real people's records.
- **Promo** — the reserve transaction has no serialization point.
  **Resolved** in the Phase 3 design pass (retired; see `docs/promo-codes.md`) and closed in the
  implementation: the transaction's read set is the promo document plus one
  redemption row, both single-document `get`s by id, so it both reads and writes
  `promoRef` and there is no query in it to be phantom about. That pass also
  found three defects neither the design nor its critique had caught, all one
  root cause — the deterministic reservation key being treated as a handle on a
  single attempt. One let a *superseded* code reach Stripe carrying a
  reservation key nothing had reserved, which the webhook then committed:
  a use consumed and a buyer's per-person cap burned for a discount never given.
- **Waivers** — re-signing is structurally impossible as specified (deterministic
  doc id + `.create()` deadlocks both expiry and revocation).
  **Resolved** in the Phase 4 design pass (retired; see `docs/waivers.md`) and closed in the
  implementation: the ledger splits into append-only EVENT rows plus one mutable
  CURRENT-STATE row, and the event id derives from the event (its `intentId`
  nonce) rather than from the relationship — which makes a second, genuine
  signing a second row instead of a collision. That pass also found fifteen
  pre-existing defects neither the design nor its critique had caught (§0.3 of
  that spec), including a live Delete button that destroys the text of a document
  somebody has already accepted, `signup_documents` failing **open** to empty
  while being proposed as an authorization source, and
  `teams/{teamId}/settings/*` having no security rule at all.
- **Guardians** — the authenticated-guardian path is unimplementable as designed:
  the contact session token records `contactId` but not *which* email opened the
  session, so it cannot prove a guardian is signing rather than the minor.
  **Resolved 2026-08-15** by an emailed link bound to the guardian's own address,
  and then **withdrawn 2026-08-16**: that link proved mailbox control, which is
  not parenthood either. The product stopped trying to prove the relationship and
  started prompting the studio to check it (`docs/waivers.md` → "Minors").

### 7.8 Wave 3.5 — what to gate, and what not to

Three Wave 3 capabilities are useful and none of them belong in a new studio's
first ten minutes. The split is not uniform, and the reasoning is the point:

| Capability | Gated today | Becomes | Why |
|---|---|---|---|
| **Gift Cards** | **nothing** | plugin (`commerce`) | The biggest first-impression offender precisely because it is ungated. A studio consciously decides to sell gift cards, often seasonally — a clean on/off |
| **Promo Codes** | plan: Studio (creation only) | plugin (`commerce`); the plan gate demotes to a plan **limit** | Do **not** stack a plugin on the plan gate — a Studio-tier user asking "why can't I see this?" must have one answer. `plan.ts` already states the rule: plugin-delivered features are gated by install state, *not* feature flags (see Courses, Referrals). `PROMO_CODE_LIMITS` (0/0/20/100) stays as the ceiling |
| **Waitlist** | plan: Coach + per-activity toggle | **team default in `Settings → Booking`** + the per-activity toggle as override | Not a plugin. It has **no nav item**, so it adds no clutter — the argument that justifies the other two does not apply. And it is not a capability a studio adopts; it is a fix for a broken state. A full class silently loses bookings, and a studio does not know it needs a queue until after the revenue is gone — behind an install step, the studios who need it most never find it. The real defect in today's shape is that per-activity is the *only* control, so 40 activities means 40 toggles |

**Plugins are also a monetisation surface**, not only a simplicity lever —
`plugin-addons.ts` carries `PluginAddonPrice`. Gift Cards and Promo Codes are
plausible paid add-ons; the waitlist is not, because nobody will pay to un-break
a dead end. That asymmetry is a second, independent reason the split falls here.

**Two implementation cautions.** Gating a shipped feature touches every entry
point — the incomplete-enumeration shape that cost Phase 3 three rounds — so it
wants the census treatment: enumerate the entry points first, one gate helper,
machine-checked. And **the seeders**: lead sandboxes and demo tenants have gift
cards seeded, so the moment Gift Cards is install-gated those tenants need the
plugin marked installed or their data vanishes mid prospect demo.

---

## 8. Related documents

- `docs/product-strategy.md` — tiering, pricing, and the module list this maps onto.
  Note §6 "Coaching & 1:1 scheduling" already lists **slot waiting list** and
  **session notes** as intended scope, so Wave 3's waitlist is a confirmation of an
  existing plan, not a new idea
- `docs/waitlist.md` — Wave 3 Phase 2 as built: the queue's data model, the
  single-deadline rule, the claim lifecycle (free and paid), the seat predicates
  and the one-writer rule for `bookings_count`
- `docs/promo-codes.md` — Wave 3 Phase 3 as built: the Stage A / Stage B split,
  best-one-wins and its deliberate asymmetry, the reserve → commit → release
  lifecycle and its ownership rules, the identity the per-person cap binds
  to and what it does not promise, and the four decisions (§10 Q8/Q9/Q11/Q12)
  with their user-visible consequences
- `docs/waivers.md` — Wave 3 Phase 4 as built: the ledger's two halves and the
  event-nonce id that makes re-signing expressible, the two publish outcomes and
  why the third is deferred, why the emailed guardian link was removed rather
  than fixed, the honest paragraph on what a click-wrap signature is worth, and —
  the section a studio will otherwise get wrong by inference — **"What the gate
  does NOT cover"**
- `docs/appointments.md` — the appointment model (activity owns the *what*,
  availability owns the *when*), which is what makes appointment slots
  un-pre-generatable and therefore constrains any waitlist design on that side
- `docs/payment-contact-studio.md` — the member→studio payment rail that promo
  codes, deposits, and guest counts would all extend
