> **⚠️ STATUS: DRAFT / WORK IN PROGRESS — not definitive. Pricing figures and tier boundaries are indicative and subject to change.**

---

# HMD SaaS Strategy — Product & Pricing Blueprint

## 1. Product Philosophy

The platform is **not a generic CRM**.

It is:

> **An operating system for coaching businesses — group classes or 1:1 training**

Core value drivers:

* **Revenue generation** (subscriptions, referrals)
* **Retention** (engagement, gamification, communication)
* **Operational efficiency** (sessions, appointments, automation)

All features must map to at least one of these.

---

## 2. Tiering Strategy (Value-Based, Not Feature Dump)

The system is structured around **business maturity**, not arbitrary feature grouping.

### Tier 0 — Free (Getting Started)

**Persona:**

* Someone *starting* a coaching business — first handful of clients, no urgency to pay
* Evaluators who outlast a time-boxed trial

**Model:**

* Full Coach feature set, differentiated by **limits**, not feature flags:
  * **15 active contacts — hard cap** (manual adds blocked at the limit; public
    bio link signups still land, so the cap breach itself becomes the upgrade prompt)
  * **Single user** (no team member invitations)
  * **No plugin add-ons** (catalogue browsable, everything upgrade-locked)
  * **"Powered by Linyup" badge** on the public bio link (every free bio link is a
    referral surface; removing the badge is a paid perk)
* CHF 0, no payment method, no Stripe subscription
* Lifecycle: every signup still starts on the **30-day** full-access Studio trial
  (no opt-in extension — the old 14-day + extension model was retired 2026-06); on
  expiry the team **downgrades to Free** (data kept, no wall, no purge). Cancelled
  paid subscriptions also land here.

**Why it exists:** the contact cap scales with customer success — Free is
genuinely useful at ≤15 clients and any economically real coaching business
outgrows it quickly, converting exactly when the product has proven its value.

> **Plan code:** `free`

### Tier 1 — Coach (Solo Operator)

**Persona:**

* Solo coach, personal trainer, or small independent instructor
* 10–50 active clients
* May run group sessions, 1:1 appointments, or both
* Sells memberships, session packages, or monthly retainers — often all three

**Goal:**

* Run sessions and 1:1 appointments
* Let clients book online without back-and-forth
* Manage contacts and billing in one place

**Core Features:**

* Contacts & client profiles
* Session management (single sessions + simple series)
* Public booking page (group sessions)

* **Coaching — 1:1 appointment booking**
  * Availability templates: define recurring windows (days × time × duration)
  * Auto-generated appointment slots from templates (daily task)
  * Bio link-based client self-booking (same public URL as group session booking — no app required)
  * Confirmation emails with **.ics calendar invite** sent to both client and coach
  * Booking reminder email before the appointment
  * Named service types (e.g. "Personal Training", "Assessment", "Online Consultation")
  * Online session support: optional meeting URL per slot (Zoom, Meet, etc.) included in confirmation email
  * Buffer time between consecutive slots (coach-configurable)
  * Minimum advance booking notice (e.g. must book ≥ 24h ahead)
  * Coach dashboard: upcoming appointments list with client contact details, one-click cancel

* **Monetization**
  * Subscriptions — recurring billing (monthly retainers, class memberships)
  * Session packages — one-off credit bundles, single data model with type discriminator:
    * `group_sessions` — class packs (e.g. 10-class pass)
    * `coaching` — 1:1 bundles (e.g. 5 PT sessions)
    * UI shows packages and subscriptions together in the contact's "Subscription & membership" section
  * Payment tracking — manual or via payment gateway (Stripe, Payrexx)

* **Coaching productivity**
  * Session notes — coach writes a post-session note after each 1:1; surfaces in contact activity timeline
  * Progress check-ins — client submits weight, mood (1–5), and a short note between sessions; coach reviews timeline in training profile
  * Client intake / assessment form — pre-session onboarding: goals, experience level, injuries, notes; populates contact profile
  * Slot waiting list — when a coaching slot is full, clients can join a waiting list and are notified if a spot opens

* **Goals & progress framework** (extends existing goals system)
  * Long-term goals — numeric targets with a deadline (e.g. lose 5 kg by June); coach and client both comment and evaluate progress
  * Short-term tasks / homework — boolean-completion goals assigned by coach after a session (e.g. "3× stretch routine this week"); client marks done; coach sees completion rate
  * Progress photos — photo attachments on goal progress updates; photos are evidence toward a specific goal, not a standalone gallery
  * Bidirectional comment thread on each goal — coach and client annotate progress entries; visible in contact profile and member app
  * Unified "Goals & Progress" section in contact profile covering all three types

* **Resource sharing**
  * Coach attaches files (PDFs, links, videos) to a contact or to a specific coaching slot
  * Displayed as a simple list in the contact profile — not a structured library
  * Client can access shared resources via bio link or mobile app

* QR-based self check-in
* Public profile / link-in-bio page
* Sign-up forms
* Basic dashboard (attendance, simple stats)
* Alerts (manual or simple triggers)
* Booking flow communications (confirmation, reminder, reschedule, no-show follow-up)

**Constraints (important):**

* Max 1 team manager
* **Automation is "half active"** — available, but limited to the triggers and
  actions of the coach's active modules and installed add-ons. The full automation
  suite (all add-on triggers/actions) is Studio.
* **Member app included** — a basic booking/check-in portal on Coach, enriched by
  add-ons (Gamification, Online Courses, …). Standard from Coach up; never on Free.
* **Contact Groups & Custom Fields are standard in Coach** (no longer paid add-ons,
  2026-06). À-la-carte is limited to the substantial add-ons (see *Plugin add-ons*).

**Product Intent:**

* Extremely fast onboarding (≤10 min setup)
* Immediate utility for both group-class coaches and personal trainers
* Low cognitive load

**Note for personal trainers:** The Coach plan replaces three tools in one — Calendly/Acuity for 1:1 scheduling, a subscription/package billing tool, and a client CRM. Clients self-book via the public bio link, receive calendar invites automatically, and the coach manages sessions, billing, and client progress in one place.

> **Plan code:** `coach`

---

### Tier 2 — Studio (Core Revenue Tier)

> **Naming (2026-06):** this tier was renamed **Club → Studio** to appeal to the
> broader sport & wellness segment (yoga/pilates/PT studios) without excluding
> sports clubs. Because the product was pre-launch (seed data only), the rename
> was applied **in full**: plan ID `studio`, Stripe lookup key
> `linyup_studio_monthly`, seeds and migration scripts aligned. Display names
> still live solely in the `Plans` i18n namespace (`apps/web/messages/*.json`)
> via `usePlanName()` — once real customers exist, any future rename must be
> display-only (plan IDs become immutable).

**Persona:**

* Gym / club (e.g. boxing, martial arts, fitness studio)
* 50–250+ members (buy contact blocks beyond 250)
* Wants growth + retention

**Goal:**

* Monetize members
* Automate operations
* Increase engagement

**Core Features (in addition to Coach):**

#### Monetization

* Advanced billing features built on top of Coach plan:
  * Automated payment failure handling and retry logic
  * Automated payment reminders (overdue notices)
  * Subscription revenue analytics (MRR, churn, LTV)

#### Engagement

* Member app (iOS + Android) — the full, content-rich app (the same app ships on
  Coach as a basic booking/check-in portal; Studio's add-ons light it up)

* **Coaching — mobile app integration** (extends Coach plan's 1:1 system)
  * In-app slot browsing and booking (upcoming slots carousel + featured next-slot card)
  * Booking and cancellation from within the app (token-based, no login required for simple flows)
  * Push notification reminder 1 hour before a 1:1 appointment
  * Per-client coaching session history visible in member profile
  * Progress notes shared between coach and client (ties into Training Profile)

* Gamification:
  * Points
  * Streaks
  * Leaderboards
  * Badges

#### Automation

* Outreach system:
  * Templates (email/SMS)
  * Automated flows (e.g. inactivity, onboarding)
* Alerts:
  * Trigger-based notifications

#### Insights

* Advanced dashboard
* AI-driven insights (e.g. churn risk, attendance patterns)

#### Team Management

* Multiple team managers
* Role-based access (basic)

#### Growth

* Referral program:
  * Track invites
  * Reward system

**Product Intent:**

* Replace multiple tools (CRM + booking + communication + engagement)
* Drive measurable ROI:
  * Retention ↑
  * Revenue ↑
  * Admin time ↓

**Important:**
👉 This is the **primary monetization tier** — most users should land here eventually.

> **Plan code:** `studio`

---

### Tier 3 — Organization (Multi-Entity Control)

**Persona:**

* Multi-location gyms
* Franchises
* Federations

**Goal:**

* Centralized control
* Cross-team coordination
* Scalability

**Core Features (in addition to Team):**

#### Multi-Team Management

* Multiple teams under one organization
* Central admin access

#### Data & Operations

* Unified data view across teams
* Move contacts between teams

#### Coordination

* Cross-team events
* Invitations across teams

#### Communication

* Cross-team messaging

#### Platform Extensibility

* API access

#### Governance

* Advanced roles & permissions (org-level)

**Product Intent:**

* Enable scaling without operational chaos
* Provide visibility and control at the org level

> **Plan code:** `organization`

---

## 3. Pricing Strategy

### Model: Flat tiers + contact caps (no per-head metering)

**Components:**

1. Base subscription fee per tier
2. A contact cap per tier (counts **active, non-archived** contacts only)
3. Studio-only **contact blocks** — buy more room in flat +250 increments
4. Optional per-plugin add-ons (Coach plan — see *Plugin add-ons* below)

There is **no per-active-contact metering**. The earlier "variable fee per
active student" model was dropped: per-head billing is unpredictable for the
customer and operationally fiddly. Instead each tier has a generous cap, and
growth is monetised by moving up a tier (or, for Studio, buying flat blocks).

### What counts as a contact

* A **contact** is any non-archived person record. Two contact types: **trial**
  and **student** (`student` is the stable code/enum value, kept post-launch; it
  is **displayed as "Member"** in the UI). Trials **do** count toward the cap but
  keep a distinct `trial` status flag for the trial→member funnel and automations.
* **Terminology (2026-06):** use **"members"** for people in customer-facing copy
  and **"contacts"** in data/CRM contexts. A studio's sellable recurring plans are
  **"subscriptions"** (not "memberships"). Reserve **"membership"** for the
  Organisation level only (a studio's membership in an org / member teams).
* **Guardians are not contact records**, and the counting invariant is the whole
  of what that sentence means: a guardian never becomes a separate counted row.
  **Corrected 2026-08 (Wave 3 Phase 4):** it used to add "guardian / emergency
  info is stored as fields on the contact (name + phone)", which conflated two
  different things. `Contact.emergency_contacts` is freely-edited operational
  data that identifies nobody. A **guardian declaration** is a consent record and
  is not stored on the contact at all: it is `signer_role` / `signer_name` on an
  acceptance event in the waiver ledger. No `Guardian[]` field was built,
  deliberately — it would be a second source of truth for a question the ledger
  already answers.
  **Amended 2026-08-16:** the declaration is exactly that — a self-declaration on
  the consent step, made only when the studio flags a waiver
  `mayIncludeMinors`. Nothing verifies it. The emailed one-time link that used to
  bind it to a guardian's own mailbox was removed: it proved control of a
  mailbox, not parenthood. The studio verifies at the door, prompted by a chip on
  the roster. See `docs/waivers.md` → "Minors".

### Archived contacts & retention

* Archived contacts **do not count** toward the cap — studios can archive freely.
* Archived contacts are **auto-anonymised after 2 years** by default (retention
  policy). Frame this as a **privacy feature**, not a limit: nDSG / GDPR data
  minimisation — *"old archived contacts are automatically anonymised, so you
  don't hoard ex-members' data."* A differentiator vs international tools.

### Pricing Structure

| Tier         | Base Price | Included Contacts | Over the cap |
|--------------|------------|-------------------|--------------|
| Free         | CHF 0      | 15 (hard cap)     | Blocked — prompt to upgrade to Coach / Studio |
| Coach        | CHF 9      | 50                | Prompt to upgrade to Studio (no overage charge) |
| Studio       | CHF 35     | 250               | Add +250-contact blocks at CHF 10/mo each, or upgrade to Organisation |
| Organization | From CHF 103 · *Talk to us* | Unlimited | — |

> **Organisation pricing (not flat-published).** Org is **base CHF 79/mo + CHF 12
> per studio**, 2-studio minimum, so the entry point is ~CHF 103 (two studios) and
> scales with locations. It is **sales-led** — published only as "From CHF 103 ·
> Talk to us", never as the base/per-studio split. The base fee is deliberate: it
> makes the org wrapper cost something so unrelated studios can't group up purely
> to undercut individual Studio plans. Modelled in code as the org base price plus
> `ORG_PER_STUDIO` (`linyup_organization_studio_monthly`, quantity = studios).
> Eligibility: studios under common ownership or a single federating body.

* **Free (15)** — hard cap. Manual adds are blocked at the limit; public bio-link
  signups still land, so the breach itself becomes the upsell.
* **Coach (50)** — when exceeded, prompt to upgrade to Studio (the coach has
  grown past a solo operation into a studio). No per-contact charge.
* **Studio (250)** — **never hard-block** an active Studio for being slightly
  over. Prompt to add a flat **+250 block (~CHF 10/mo)** for predictable extra
  room, or to move to Organisation when going multi-location.
* **Organisation** — unlimited contacts.

> **Implementation status (2026-06):** the new caps (15 / 50 / 250 / unlimited)
> are live in `PLAN_PRICING` and enforced — Free hard-blocks, while Coach and
> Studio show tier-specific over-cap prompts (upgrade / add a block) on the
> contacts page. The **legacy per-student soft overage** (`syncContactOverage`,
> `linyup_extra_student_monthly`) has been **removed** — there is no per-contact
> metering. The Studio **contact block** price is provisioned
> (`STUDIO_CONTACT_BLOCK` → `linyup_studio_contact_block_monthly`); the remaining
> piece is the in-app "add a block" purchase flow (the over-cap banner already
> surfaces the option).

> **Launch offer (PUBLIC):** 50% off **Coach and Studio** for the first **6 months**
> for new signups during launch (Coach ~CHF 4.50, Studio ~CHF 17.50), framed as
> scarce ("limited availability"). This is the single public promo and doubles as
> the early-adopter offer. Organisation is "Talk to us", not a published discount.

> **Founder pricing (PRIVATE):** Studio **CHF 15/mo locked for life**, founding
> clubs only — handled by direct outreach, kept **off** the public pricing page.
> Note the collision risk: the 50% Studio launch price is CHF 17.50, so the
> founder CHF 15 must never appear publicly. The only founder element allowed on
> the page later is a partner-logo strip once they've signed.

### Plugin add-ons (Coach plan)

**Studio and Org include all internal plugins** at no extra cost; **Coach** can
activate a curated subset (the substantial engagement/content plugins) as **paid
monthly add-ons**, each billed as a Stripe subscription item on top of the Coach
base.

**Standard in Coach (2026-06 de-pettifying):** **Contact Groups** and **Custom
Fields** are now included in the Coach base — they are no longer sold à la carte
("no more CHF 2 for custom fields"). À-la-carte is limited to the substantial
add-ons below.

Add-on prices are **anchored** so that a coach wanting **three or more** add-ons
reaches or exceeds the Coach→Studio delta — making Studio the rational choice
("Need 3+ add-ons? Studio includes everything for CHF 35").

| Add-on | Coach price / mo |
|--------|------------------|
| Website | CHF 8 |
| Online Courses | CHF 8 |
| Products Shop | CHF 8 |
| Gamification | CHF 5 |
| Referrals | CHF 5 |

*Indicative placeholders, synced from `PLUGIN_ADDONS`. Marquee Studio features —
the full member app, full automation suite, multiple managers, advanced analytics
— are **never** sold à la carte. The member app itself ships from Coach as a basic
portal; add-ons (Gamification, Online Courses, …) are the content that fills it.*

**Mechanics:** plugin **installation is the gate**. Studio/Org owners install
freely; Coach activations go through a Cloud Function that adds the Stripe item
(so paid value can't be self-granted). During the **trial**, coaches activate
add-ons **free** to explore; on conversion the active add-ons carry into the paid
subscription. The catalogue (plans + add-ons) is declared in the repo and synced
to Stripe — see `docs/stripe-catalog.md`.

### Optional Revenue Layer

If payments are integrated (e.g. via Payrexx):

* Add **0.5%–1.5% transaction fee**

Only if you provide real billing + subscription value — otherwise skip to avoid friction.

### Trial Strategy

* **Freemium + trial combined** (decision 2026-06): every signup starts on a
  14-day full-access Studio trial; on expiry the team downgrades to the **Free
  plan** (15-contact hard cap) instead of being walled and purged.
* The trial sells the full product; Free keeps non-converters in the funnel at
  near-zero marginal cost and converts them when they outgrow the cap.

---

## 4. Upgrade Path Design

The system must naturally push users upward:

* **Free → Coach triggers:**
  * Hits the 15-contact hard cap (the primary, success-aligned trigger)
  * Wants a second team member on the account
  * Wants plugin add-ons (gamification, referrals, …)
  * Wants the "Powered by Linyup" badge off their bio link

* **Coach → Studio — hard pulls (Studio-only, never à la carte):**
  * Outgrows the 50-contact cap — no per-contact overage on Coach, so growth past
    a solo operation means moving up to Studio
  * Wants a branded client mobile app (in-app booking, push reminders, coaching history)
  * Wants automated outreach (inactivity follow-ups, onboarding sequences)
  * Needs multiple coaches or managers on the team
  * Wants advanced + AI-driven analytics

* **Coach → Studio — anchored upsells (available as Coach add-ons):**
  * Gamification and the referral program are purchasable as paid add-ons on
    Coach, priced so that wanting both approaches the Studio price — they pull
    toward Studio rather than blocking it.

* **Studio → Organization trigger:**
  * Manages multiple locations
  * Needs centralized control
  * Consistently exceeds 250 contacts and prefers one multi-location account
    over stacking +250 contact blocks

Features must be distributed to **create pull**, not force upgrades artificially.

---

## 5. Key Differentiation

Avoid competing as "Gym CRM". Position as:

> **Retention and growth platform for coaching businesses**

Core differentiators:

* Built for any coaching business — group classes, personal training, or hybrid
* 1:1 appointment booking with calendar integration (replaces Calendly for coaches)
* Strong attendance + engagement loop
* Gamification layer
* Mobile-first student/client experience

---

## 6. Core System Modules

The platform should be modular, with these domains:

| Module | Description |
|--------|-------------|
| Contacts & CRM | Client profiles, lifecycle, alerts |
| Sessions & Scheduling | Single + recurring sessions, calendar |
| Bookings | Bio link booking, QR check-in, self check-in |
| Coaching & 1:1 scheduling | Availability templates, slot generation, client self-booking, calendar invites, session notes, waiting list |
| Goals & progress | Long-term goals, short-term tasks/homework, progress photos, bidirectional coach–client comment thread |
| Resource sharing | File and link attachments per contact or coaching slot, accessible via bio link and mobile app |
| Payments & Subscriptions | Recurring billing, session packages (class packs + coaching bundles), payment tracking |
| Finance & accounting | Money journal + cash-basis double-entry ledger (finance plugin); studio-shaped accrual layer + asset register planned — see docs/finance-accrual.md |
| Communication | Email / SMS / push notifications |
| Automation engine | Triggers + workflows |
| Gamification engine | Points, streaks, leaderboards, badges |
| Analytics & insights | Dashboard, AI-driven signals |
| Multi-team / org layer | Organization hierarchy, cross-team ops |
| Public pages | Booking page, public profile / link-in-bio |

Each module should be independently extensible and tier-gated. Plugin-delivered
modules (gamification, referrals, courses, …) are gated by **plugin installation**
(the packaging/billing gate); non-plugin tier features use feature flags.

---

## 7. Non-Goals

To avoid scope creep:

* ❌ Horizontal/statutory accounting suite — AR/AP & invoicing, VAT filing,
  payroll, bank reconciliation, statutory exports stay external. (Tarif 595
  reimbursement receipts, `docs/tarif-595.md`, are a plugin that attests a paid
  purchase and posts nothing — not invoicing.) ✅ In scope
  instead: the studio-shaped finance layer — money journal, cash double-entry
  ledger, and the planned accrual layer + asset register (docs/finance-accrual.md),
  which feeds the fiduciary's tool rather than replacing it. (This line
  originally read "Full accounting system"; the shipped finance plugin crossed
  that wording, so the boundary is now drawn where it actually runs.)
* ❌ Generic CRM features not tied to gym workflows
* ❌ Over-complex reporting in early versions

Focus on: simplicity, speed, real gym use cases.

---

## 8. Success Metrics

| Metric | Why it matters |
|--------|----------------|
| Activation time (setup → first booking) | Measures onboarding friction |
| Monthly active members per customer | Proxy for customer health |
| Gym retention rate | Core SaaS health metric |
| Subscription adoption rate (Team tier) | Revenue quality |
| Feature usage: automations, app, referrals | Stickiness drivers |

---

## 9. Strategic Priorities (Execution Order)

1. Core operations (Coach tier fully usable)
2. Payments + subscriptions
3. Student app
4. Automations
5. Gamification
6. Org-level features
7. Finance v2 — accrual layer + asset register (post-launch adoptable by
   design; see docs/finance-accrual.md for phasing)
8. APIs

---

## 10. Key Insight

> Users don't pay for software.
> They pay for **more members, better retention, and less admin work**.

Every feature should clearly support one of these outcomes.
