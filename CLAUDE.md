# CLAUDE.md — dgstn-lineup (Linyup SaaS)

## What this project is

Linyup is a generalised SaaS version of **hmd-lineup** — a martial-arts school
management platform. The goal is to strip out sport-specific logic and offer the
same feature set (sessions, contacts, bookings, trial forms, team management,
student mobile app) to any type of coach, club, or multi-club organisation.

**Reference implementation**: the original project lives at
`C:\git\hmd\hmd-lineup` (or `~/git/hmd/hmd-lineup` on Mac/Linux). When porting
or extending any feature, always read the source there first.

---

## Monorepo layout

```
apps/web/           Next.js 15 App Router — admin dashboard (replaces CRA/Redux)
apps/mobile/        Expo 54 + React Native — student app (ported from hmd-lineup/student-app/)
packages/functions/ Firebase Cloud Functions v2 — TypeScript (replaces Babel JS)
packages/shared/    TypeScript types + Firestore path constants
```

Root tooling: **pnpm workspaces** + **Turborepo**. Node 22 required.

---

## Reference project structure (hmd-lineup)

| Concern | hmd-lineup path | Notes |
|---|---|---|
| Cloud Functions | `functions/src/{name}/index.js` | Babel ES6, `regionalFunctions` from `utils/functions.js` |
| Firestore rules | `firestore.rules` | 650 lines — ported verbatim into root `firestore.rules` here |
| Firestore indexes | `firestore.index.json` | Ported verbatim |
| Web app | `src/` | React 19, MUI 7, Redux — do NOT copy this; rewrite in Next.js |
| Student app | `student-app/` | Copied into `apps/mobile/` with branding updates |
| Data constants | `src/constants/firebasePaths.js` | Ported to `packages/shared/src/paths.ts` |
| Mail utils | `functions/src/utils/email.js` | Reworked: SMTP removed, now a thin façade over the Brevo mail service in `packages/functions/src/mail/` (see "Email sending" pattern) |
| Secrets | `functions/src/utils/secrets.js` | Ported to `packages/functions/src/utils/secrets.ts` |
| Teams utils | `functions/src/utils/teams.js` | Ported to `packages/functions/src/utils/teams.ts` |
| Recurrence | `functions/src/utils/recurrence.js` | Ported — DST-safe Europe/Zurich logic, keep as-is |
| Users utils | `functions/src/utils/users.js` | Ported to `packages/functions/src/utils/users.ts` (stub) |

---

## What's done (Phase 1 + Phase 2 start)

- Root workspace: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- `packages/shared`: all types + Firestore path constants
- `packages/functions`: utils ported, ~12 functions fully implemented, rest stubbed
- Firebase config: `firestore.rules`, `firestore.index.json`, `storage.rules`, `database.rules.json`, `firebase.json`, `.firebaserc`
- `apps/web`: Next.js 15 scaffold with `(auth)` route group, `(public)` route group, login page, AuthContext, TanStack Query
- `apps/mobile`: full port of `hmd-lineup/student-app/` with Linyup branding
- CI/CD: `.github/workflows/verify.yml` + `deploy.yml`
- shadcn/ui component library installed in `apps/web/src/components/ui/`
- Build + typecheck clean across all packages; dev server runs at port 3000
- `firebase-auth.ts` split from `firebase.ts` to prevent SSG crash (auth/invalid-api-key)
- Bio-link routes tagged `force-dynamic`; `apps/web/.env.local` created with placeholders
- Self-service signup wizard (`app/signup/page.tsx`) — 2-step: account → team → dashboard
- Firebase emulator wired up for local dev (`demo-linyup` project, no real Firebase project needed)
- Public **Space** area (`/public/{slug}/space`) — the contacts' personal member portal
  (membership, bookings, profile, and the courses they can open), interim web surface until the
  mobile app ships. Sign-in via the passwordless contact-session login; course discovery + buying
  lives in the Shop, not here. See "Public Space" under Key patterns.

---

## What's NOT done yet (Phase 2+)

### UI / UX gaps (priority)
- **Auth layout + nav** — no icons, no mobile drawer, no collapse mode (see UI/UX porting principles above)
- **Contact detail page** — `/contacts/[id]` route with tabbed view (profile, notes, activity, subscriptions)
- **Session calendar view** — calendar tab alongside list (react-big-calendar)
- **Mobile-first list layouts** — current list pages use desktop tables; need card/list patterns that work on mobile
- **Gamification** — stubbed page, no implementation

### Features not yet started
- **Stripe billing** — `SaasSubscription` type is stubbed, `saas_subscriptions` rules deny all
- **Organisation tier** — multi-team hierarchy, `organizations/` collection stub only
- **SaaS operator console** — no admin panel for managing tenants
- **Full function port** — only ~15 of ~81 functions are implemented; the rest are stubbed with a `TODO: port from hmd-lineup/functions/src/{name}/index.js` comment
- **Outreach/automation engine** — not started
- **Accrual finance** — planned, not started: `docs/finance-accrual.md` is the recorded design (recognition policies, basis setting, assets-in-finance, the inventory-extension re-scope). Shipped from it so far: `MemberSubscription.current_period_start` persistence, the opening-balances wizard (`/plugins/finance/opening`), and the **asset register / statement of assets** register-only slice (`/plugins/finance/assets` — indicative values, no postings until accrual mode).
- **Appointments (1:1)** — DONE: activity-bound, availability-only booking (`listAvailability` + `bookAppointment`, overlap-safe lazy session creation, priced durations + one `memberBenefit` rule (no access gate — the price is the gate), .ics emails, public picker at `/public/{slug}/appointments` — see `docs/appointments.md`). Still open: mobile paid appointments (browse/book on `listAvailability` exists; a priced duration is refused with `payment_required` — no mobile checkout surface, see `docs/mobile-roadmap-2026-09.md`), push reminders, session notes, waiting list (`docs/product-strategy.md`).

---

## Architecture decisions (locked)

| Decision | Choice | Reason |
|---|---|---|
| UI library | shadcn/ui + Tailwind CSS | White-label flexibility; no vendor lock-in |
| State: server | TanStack Query v5 | Replaces react-redux-firebase |
| State: auth | AuthContext (React context) | Simpler than Redux for auth-only state |
| Firebase SDK | Modular v12 (no compat) | Tree-shakeable, future-proof |
| Functions | TypeScript, CommonJS target, **firebase-functions v6 (gen2)** | No Babel, type-safe, already on latest |
| Branding | "Linyup" (coined word, linyup.com) | Energetic, invented, domain available |
| Multi-tenancy | `teamId` as tenant boundary | Matches existing Firestore rules pattern |
| Functions region | `europe-west6` | Same as hmd-lineup; change only if customer base shifts |

---

## Key patterns

### Cloud Functions — use v2 imports (NOT `regionalFunctions`)

The old project used `regionalFunctions` (firebase-functions v1 gen1). This project is on **v6 gen2**. When porting any function, update the import at the same time:

```typescript
// v2 gen2 — use this
import { onCall, onRequest } from 'firebase-functions/v2/https'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'

setGlobalOptions({ region: 'europe-west6' })

export const myFn = onCall(async (request) => { … })

// OLD v1 pattern from hmd-lineup — do NOT copy as-is
import { regionalFunctions } from '../utils/functions'
export const myFn = regionalFunctions.firestore.document('…').onCreate(…)
```

### Public tenant routes — ONLY read `public_profile` subcollections

Public tenant routes (`/public/{slug}/*`) must never query main collections. Always use:

```typescript
// resolve team by slug
const q = query(
  collectionGroup(db, 'public_profile'),
  where('slug', '==', slug),
  where('type', '==', 'team'),
  limit(1)
)
```

See `hmd-lineup/docs/portal-security.md` for full rules and patterns.

### Public tenant route structure

Routes are **tenant-first**: `/public/{slug}` is the team root and renders the team's chosen
default surface (`Team.default_public_surface`, defaults to `'bio-link'`). The root reads
`TeamPublicProfile.active_public_surfaces` (computed by `syncTeamPublicProfile` on team write)
to avoid redirecting to a dead surface. Sub-routes are siblings: `/public/{slug}/site`,
`/public/{slug}/space`, `/public/{slug}/booking`, `/public/{slug}/signup`,
`/public/{slug}/manage-booking`, `/public/{slug}/contact-update`, `/public/{slug}/coaching`,
`/public/{slug}/events`. Token-only routes stay standalone: `/public/event-invitation` and
`/public/team-invitation/{token}`.

### Event programmes — what makes an event more than a session

An event **has a programme**: a multi-day, multi-track agenda. `Event.program`
embeds the days + tracks (few, like `Place.rooms`); the rows live in
`events/{id}/program_items` (can run to hundreds). Full docs: `docs/event-program.md`.

Three invariants worth knowing before touching it:

- **Times are WALL-CLOCK at the venue** (`'HH:MM'` + the day's `'YYYY-MM-DD'`),
  never `Timestamp`s. A programme is a printed schedule — "09:00 breakfast" is
  09:00 wherever the camp is. Same convention as `availability.ts`;
  `timezoneLabel` is display-only. Do not "fix" this into UTC.
- **Every program item carries a denormalised tenant stamp** (`teamId`/`orgId`/
  `scope`). Create validates it against the parent event once; read/update/delete
  then trust it, so the hot paths need no `get()` — and org-scoped events (whose
  `teamId` is null) work by construction. The stamp is immutable on update.
- **Events are private by default.** `Event.publicVisibility` gates
  `syncEventPublicProfile`, which embeds the whole programme into one mirror doc
  and NEVER mirrors `internalNote`.

`ProgramTab` is tenant-agnostic (reads the tenant off the Event doc), so the team
and org event pages mount the same component. Templates
(`teams|organizations/{id}/[org_]program_templates`) key items by a relative
`dayIndex`, so an org authors a standard camp programme once and every member
studio applies it. Rules tests: `pnpm --filter @linyup/functions test:rules`.

### Contact filtering + dynamic groups — ONE predicate

`matchesFilter(contact, filter, ctx)` in `packages/shared/src/utils/contactFilter.ts`
is the **only** contact-matching implementation, shared by the contacts list,
saved filter presets, dynamic contact groups and the automation engine's
`in_group` condition. **Never add a parallel contact-matching check — extend the
resolver** (fixtures: `functions/src/contacts/contactFilter.test.ts`). Tree
helpers live beside it in `utils/contactGroups.ts` so web and functions expand
descendants identically.

**Groups have two disjoint membership sources**, and a group is one or the other:

| Kind | Membership | Written? | Edited by |
|---|---|---|---|
| Manual | `Contact.group_ids[]` | yes | anyone who can write the contact |
| Dynamic | `ContactGroup.rule` (a `ContactFilter`) | **never** | manager/owner (the rule is on the group doc) |

A dynamic group is **derived lazily, never materialized** — there is no sync job,
no cache, nothing to invalidate, and it cannot go stale. This works because every
membership question is asked from a position that already holds the data: a page
with the contact list filters it, a page with one contact tests that contact
(`groupsForContact` — the reverse lookup, asked the cheap way, no index), and the
automation scan tests the contact already in hand. Consequently a dynamic group
is **excluded from every UI that writes membership** (group picker, bulk dialog,
`add_to_group`/`remove_from_group`) but **included** wherever membership is read.
The `groups` dimension is stripped when evaluating a rule, so rules can't recurse.

**Age is the reason dynamic groups exist.** Every other dimension changes only
when data changes (an event fires, a snapshot can be corrected); age changes with
no write at all, so a snapshot group silently goes wrong and no event trigger can
notice. `AgeFilter` therefore carries two modes — `'age'` (today's age) and
`'birth_year'` (the calendar year, which is what rosters and competition
categories actually use) — plus `includeUnknown`, because a missing birthdate is
common and dropping those contacts silently is exactly the failure nobody spots.

### Contact lifecycle — ONE predicate, and two questions

`contactLifecycle(c)` in `packages/shared/src/utils/contactLifecycle.ts` is the
only reader of the lifecycle markers, in a fixed order: `deleted` (also
anonymised) → `archived` → `provisional` → `external` → `active`. Two
predicates sit on it, and they answer **different questions**:

| | asks | includes |
|---|---|---|
| `isLiveContact` | may they book, attend, sign in, be matched by email? | active, leads, **externals** |
| `isRosterContact` | does the studio look after them? | active, leads |

**External** (`Contact.external` + `external_since`) is a person who trains
here without being on the roster — a partner-app drop-in, a former member who
still comes now and then, the old HMD `type: external`. They are live and
counted in every class's attendance and toward the contact cap, but excluded
from the headcount, event invitations, every automation (sweep AND per-contact
triggers), Needs attention, and the lost-trial count. It is a **lifecycle**
value: marking someone external moves nothing on the journey, plan or
affiliation axes. Cleared by the studio or by completing the public signup
form; **a purchase never clears it** (a partner-app plan is a purchase).

Two mechanics that the seams depend on: `archived_at`/`deleted_at` are ALWAYS
present (`null` when clear — what makes the Firestore `== null` query safe,
see `apps/web/src/lib/liveContacts.ts`), while `provisional`/`external` are
present ONLY when true — so "is external" can be queried and "is not external"
is decided in memory after the live query. Never test the field inline; the
census of server seams is `contacts/contactLifecycle.test.ts`.

### Public Space — the contacts' personal portal

`/public/{slug}/space` is a minimal, team-branded public area (sibling to `/public/{slug}`
bio-link root and `/public/{slug}/site`) — the signed-in **contact's** personal portal:
membership (subscriptions + affiliation), bookings, editable profile, and **My courses** (the
courses they can open). It's a **base surface** (always live, not gated on the online-courses
plugin) and sign-in-gated — anonymous visitors get a sign-in wall. The course **catalogue**
(browse + buy, incl. locked/priced cards) lives in the **Shop**, NOT here; Space only ever shows
a contact's own entitlements, filtered from the world-readable
`courses/{courseId}/public_profile/{courseId}` summaries (written by `syncCoursePublicProfile`,
`packages/functions/src/sync/`). It resolves the team by slug with the same `public_profile`
collection-group query as the other public routes. Never list the root `courses` collection publicly.

**Course access tiers** (`Course.accessRule.type` in `packages/shared/src/types/course.ts`):

| Tier | Stored value | Display | Who can read |
|---|---|---|---|
| Free | `free` | "Free" | Anyone, no login — incl. media |
| Sign-in required | `registered` | "Sign-in required" | Any signed-in contact of the team |
| Subscription | `subscription` | "Subscription" | Contact whose `subscription_type_id` ∈ `accessRule.subscriptionTypeIds` |
| Sold (one-off) | `purchase` | "Sold · {price}" | Contact who bought it (lifetime), OR whose `subscription_type_id` ∈ `accessRule.subscriptionTypeIds` (optional "included free") |

History: the middle tier was `members` until 2026-06; renamed (value + display) to
`registered` while pre-launch with seed data only. The stored enum value is the stable
machine identifier — post-launch, renames must be display-only.

**Video is embed-only** (`MediaSource` `youtube` / `vimeo` / `url`): `storage.rules`
refuses `video/*` uploads under a team — the kiosk's standby media is the one
exception — and the course editor offers no upload for a video lesson. A hosted
video is billed per byte delivered to every member who watches it, the largest line
on a studio's bill (`docs/scalability-2026-09.md` §12); hosted video, if it ever
comes, is a paid add-on on zero-egress infrastructure, never this bucket. Audio
uploads stay and are the known residual.

**Selling courses (the `purchase` tier).** A purchase-tier course carries
`accessRule.priceAmount` (major units) and is sold one-off in `/public/{slug}/shop`
**next to products and subscriptions** (a "Courses" tab), while still consumed in
`/public/{slug}/space`. It reuses the products Stripe-Connect plumbing: the public
`createCourseCheckout` callable (`packages/functions/src/connect/payments.ts`) →
`createOneOffCheckoutSession` → the Connect webhook's `handleCourseCheckout`
(`webhook.ts`, `kind: 'course'`) links/creates the buyer's contact and writes a
**lifetime entitlement** at `courses/{courseId}/purchases/{contactId}`
(`COURSE_PURCHASES_SUBCOLLECTION`). Firestore rules unlock the course via
`hasPurchasedCourse(courseId)` inside `canReadPublishedCourse(courseId, c)`. The shop
+ Space read the per-course `public_profile` summary (now carries `priceAmount`) via
the same collection-group query; the Space also queries `purchases` (collection-group,
indexed on `contactId, teamId`) to show unlock state. The success page lands the buyer
in their Space (`seg=space`) to watch.

**Contact auth on the web** reuses the mobile contact-session mechanism: passwordless email
code (`sendContactVerificationCode`) → `loginContactWithCode` (matches the existing
contact, handles same-email selection, mints a session via `buildContactSession`) →
`signInWithCustomToken`. The custom-token claims `{ contactId, teamId, sessionExpires }`
are what Firestore + Storage rules check (`isContactOfTeam` / `canReadPublishedCourse` in
`firestore.rules`; `isContactSessionForTeam` / `isPublishedFreeCourse` in `storage.rules`).
Enforcement lives in the rules; the UI lock states are UX only.

### Embeds — the booking modal on the studio's OWN website

A studio can put the booking funnel on its own site (Wix, Squarespace, a
hand-rolled page) as a pop-up over the page the visitor is reading — the same
panel `BookingOverlay` gives a Linyup-hosted website. Two lines of HTML: a link
carrying `data-linyup-book`, and `public/embed.js`.

**The modal is drawn by the HOST page, not inside the iframe.** A dialog
rendered in a content-sized iframe can only ever cover that iframe. So
`embed.js` owns the backdrop, the dialog/sheet sizing, Escape, the scroll lock
and the Back-closes-it history entry; `/embed/{slug}/book` is the panel's
CONTENTS — the funnel with `FlowShell`'s overlay chrome. `/embed/*` is the only
path served `frame-ancestors *` (proxy.ts); everything else is
`X-Frame-Options: DENY`, which is why nothing in an embed may ever navigate its
own frame.

`BookingChrome` gains its third host (page → website overlay → embed panel) and
nothing about the step machine is duplicated; `useExitFlow` is how a terminal
step leaves — CLOSE in a panel, navigate on a page. **embed.js owns the
canonical-link → panel-URL mapping**; the app side (`src/lib/embedBridge.ts`)
owns the message vocabulary and asks rather than deciding. An already-pasted
snippet with no script, or an old cached one, still opens a new tab exactly as
before — the panel is opt-in by handshake. Paying leaves the page (Stripe
refuses to be framed) and returns to `/pay/result`, not to the studio's page:
bringing the buyer back there needs a verified origin, like the custom-domain
rail. Full docs: `docs/embed-booking.md`.

### Firebase client SDK — server/client split

Next.js SSG/SSR crashes if `getAuth()` is called at module level on the server.

| File | Exports | Import from |
|---|---|---|
| `src/lib/firebase.ts` | `app`, `db`, `storage` | Anywhere (server + client safe) |
| `src/lib/firebase-auth.ts` | `auth` | Client components and `src/lib/auth.ts` only |

Never add `getAuth()` back to `firebase.ts`.

### Email sending — Brevo ESP (no SMTP)

All outbound mail goes through **Brevo's transactional HTTP API** via a
provider-agnostic service in `packages/functions/src/mail/`. There is **no SMTP /
nodemailer** and **no stored mail credentials** for anyone. Full docs:
`packages/functions/src/mail/README.md`.

- Call sites send via `sendEmail(...)` from `utils/email.ts` (a thin façade).
  **Pass `teamId` to send AS the studio**; omit it for Linyup **system mail**
  (from `hello@linyup.com`).
- **Sender resolution** (`mail/senderResolution.ts`, pure + unit-tested): a studio
  sends **Managed** (studio name over a `linyup.com` address, Reply-To = the
  studio's contact email) by default, or from a **BYO domain** once verified in
  Brevo (paid plans only — `coach`/`studio`/`organization`). BYO falls back to
  Managed automatically until verified.
- Per-studio config lives at `teams|organizations/{id}/integrations/email_sender`
  (`EmailSenderConfig`, no credentials). BYO domain-auth callables:
  `registerSenderDomain` / `checkSenderDomain` / `useManagedSender`.
- Brevo event webhook `handleBrevoWebhook` writes `mail_suppressions/*` on
  bounce/block/spam so dead addresses are skipped; `mail_sends/*` is the
  idempotency + delivery ledger. Secrets: `brevo-api-key`, `brevo-webhook-secret`
  (Secret Manager; emulator env `BREVO_API_KEY` / `BREVO_WEBHOOK_SECRET`).

### Appointments (1:1) vs classes

Two primitives, not two entities — both are `sessions/{id}` docs:

- **Class** = a seat in a scheduled event. The studio schedules it; it exists on
  the calendar before anyone books.
- **Appointment** = a provider's exclusive time. **Nothing exists until booked** —
  the provider publishes *availability*, and the session is created lazily,
  overlap-safe, at booking.

`Activity.type` (`'class' | 'appointment'`) picks the scheduling mechanism;
`Session.activityType` carries it. Mirrors: `type: 'session'` vs
`'appointment_session'`; activity mirrors carry `activityType` so public UIs route
appointment cards to the picker.

**The what vs the when.** The `Activity` owns the *what* — `durations` (each
length with an optional base price) and the ONE `memberBenefit` rule (no
capacity: an appointment is exclusive time, one booking per slot by definition).
The `availability/{id}` doc owns only the *when* — provider, recurrence,
`mode: 'range'|'times'`, buffer, and **`activityIds`** (which appointment
activities are bookable in that window). Durations are never stored on
availability; they derive from the linked activities. Because a window may offer
activities of different lengths, a start time is indeterminate until the client
picks one — **which is why availability can never be pre-generated** (the old
slot-generation cron was deleted for exactly this reason).

Booking: **`bookAppointment`** is the free-path appointment callable
(`bookSession` is class-only and rejects them); the client sends no templateId —
the server resolves the covering availability. `listAvailability` computes free
times, coach-first (returning `durations` + `memberBenefit` per activity).
Appointments have **NO access gate** — THE PRICE IS THE GATE: unpriced → anyone
books free (guests included), priced → anyone pays their effective price.
`Activity.accessRule` is CLASS-ONLY (appointment forms don't show it, appointment
paths don't read it, appointment session docs/mirrors don't carry it).
`cancelBooking` handles both kinds.

**A class's drop-in price is read through ONE resolver.** The price has a
studio-wide default (`BookingSettings.dropIn`, on the team's public profile
beside the other booking settings, edited on Offerings → Pricing) and each
class says how it relates to it — `Activity.dropIn.mode`: `'studio'` (follow
the default; what a new class starts as), `'custom'` (its own price), `'off'`
(none, even under a default); a document without `mode` reads as `'custom'`
when it named a price and `'studio'` otherwise. **`resolveActivityDropIn(activity,
studioDropInOf(bookingSettings))`** (`packages/shared/src/utils/dropIn.ts`) is
the only reader — never branch on `activity.dropIn.enabled` / `.priceAmount`,
since a class that follows the studio stores no price. The activity mirror
carries the RESOLVED price (public readers and mobile need no default), and
`syncStudioDropIn` rewrites the mirrors of every following class when the
default changes. Docs: `docs/payment-contact-studio.md` → "Drop-in".

**Paid appointments** put a base price per duration (`Activity.durations:
[{minutes, priceAmount?}]`) **and one member rule per duration**
(`Activity.durationBenefits: [{minutes, benefit}]`) — holders of a listed type
book that length free (`included`; credit packs spend a credit), at
`percent_off`, or at a `fixed_price` (all clamped to Stripe's 0.50 floor, never
free-via-discount). **THE ONE READER is `resolveDurationBenefit(activity,
minutes)`** — never touch the fields directly: `durationBenefits` present ⇒ it
is the whole answer and a missing entry means no rule; absent ⇒ the LEGACY
activity-wide `Activity.memberBenefit` still applies to every length, so an
un-re-edited appointment behaves as before and **no backfill is owed** (the
first per-length save absorbs the old rule onto every length and clears it).
This is NOT the per-duration × per-type `subscriptionPricing` matrix cut in
2026-07 — that was a grid of prices; this is the same one rule, asked once per
length, because `fixed_price` on an activity charged the same for 30 and 90
minutes. A public ONE-LINE summary (shop card, site chip, pricing table) states
a benefit only when every length agrees, else the price range alone.
Resolver: **`resolvePaymentOptions(snapshot, target, context?)`** — the ONE
shared coverage/quote resolver (`packages/shared/src/utils/paymentOptions.ts`,
pure, client-safe) that answers `covered | spend_credits | pay(amount,
appliedBenefit)` for class bookings, drop-ins, appointments, courses AND
products; the optional third `context` carries a typed promo code (see "Promo
codes" below) and nothing else, so every pre-existing call site compiles and
behaves unchanged. The server builds its authoritative snapshot via `loadContactPaymentSnapshot`
(`packages/functions/src/booking/access.ts`), the web an optimistic one via
`apps/web/src/lib/paymentSnapshot.ts`. Never add a parallel coverage/price
check — extend the resolver (fixtures:
`functions/src/booking/paymentOptions.test.ts`). Money mechanics (0.50 floor,
Rappen conversion, fees, idempotency) live once in
`packages/functions/src/connect/checkout.ts` + `shared/src/utils/money.ts`. A
payable caller is refused by `bookAppointment`
(`payment_required`) and instead reserves→pays→confirms via
**`createAppointmentCheckout`** at the caller's effective amount: the hold IS
the session (`status: 'pending_payment'` + `hold_expires_at`, +30 min, lazily
expiring) and the Connect webhook (`kind: 'appointment'`) confirms it to `full`
on payment. `dropIn` stays class-only — appointments never use it; class-side,
the independent `trialEnabled` toggle lets a gated class accept a newcomer's
guest trial, so members-included + trial + drop-in coexist. That trial may
itself be **priced** — `Activity.trialPriceAmount` (class-only, gated-only;
absent ⇒ free, today's behaviour) charges a newcomer's first class over the
drop-in checkout (`createDropInCheckout({ trial: true })`), enforced once per
person via `Contact.trial_used_at`. A trial is never a subscription. Kiosk
walk-in is class-only too. Full docs: `docs/appointments.md` → "Paid
appointments"; `docs/payment-contact-studio.md` → "Paid trial".

### Book-form fields — a QUESTION is about the booking, a FIELD is about the person

Two lists sit side by side on an activity and they are not interchangeable:

| | Booking question | Contact field |
|---|---|---|
| Asks about | this booking ("any injuries today?") | the person ("date of birth") |
| Stored on | `Booking.question_answers` | the CONTACT (`phone`, `birthdate`, `address`, `custom_fields.*`) |
| Authored in | `Activity.bookingQuestions` | `BookingSettings.contactFields` + `Activity.contactFields` |
| Asked | every booking | once — a stored answer is never re-asked |

**ONE resolver**: `resolveBookingContactFields(bookingSettings, activityFields)`
(`packages/shared/src/types/team.ts`), run identically by the public form and by
every callable. The activity list **EXTENDS** the team default (it never
replaces it) and dedupes by key with the ACTIVITY winning, so a kids class can
promote a team-optional field to required without restating the rest. The legacy
`BookingSettings.showPhone` boolean is read **there and nowhere else**, as a
fallback while `contactFields` is absent; the settings form derives it on save so
the two can never disagree.

**The payload is NARROWED, never merged** — `buildContactFieldPatch`
(`packages/functions/src/booking/contactFields.ts`). The public form is
anonymous and is writing to a contact document, so the server decides which keys
exist: only keys the resolved list names survive, and a `custom:` key survives
only when its definition sets `publicOnBookingForm` (off by default — asking it
publicly means mirroring its label and options into the world-readable team
profile). Three rules learned the hard way, all pinned by tests:

- **An empty answer never blanks a stored value.** A member with a phone on file
  books, leaves the box untouched, the client posts `''` — treating that as an
  edit deletes a number the studio collected months ago.
- **`birthdate` is a Timestamp and `address` is a four-part map.** Writing the
  raw string in either case stores something no reader looks at — no error, no
  failing test. Both are special-cased; an address MERGES over the stored one.
- **`set()` vs `update()` are not interchangeable.** `update()` reads
  `custom_fields.x` as a path, `set()` as a literal key with a dot in it. The
  create branches go through `expandContactFieldPatch`.

Mounted on the rails that own a contact write: `bookSession`,
`createDropInCheckout`, `bookAppointment` and `createAppointmentCheckout` (the
appointment pair share one seam, `resolveOrCreateAppointmentContact`).
**`joinWaitlist` deliberately asks for none** — it stores none, and a form that
asks and discards is worse than one that never asked; the fields are collected
on the claim, which goes through the paid or free rail like any other booking.

### Waitlist — class-only, one deadline, one seat writer

A queue for a seat in a full **class**; entries live at
`sessions/{sessionId}/waitlist/{contactId}` (doc id = contactId, mirroring
`bookings`), written only by callables — every client write is denied by the
rules. **Class-only**: an appointment session doesn't exist until it's booked, so
"full" has no meaning there. The flag is `Activity.waitlistEnabled` + its public
mirror only — there is deliberately **no** `session.waitlist_enabled` (it would
need an activity→sessions fan-out plus a backfill). When a seat frees, the
`seatFreedEdge` trigger on the session doc offers it to the oldest waiter and
holds it as an **ordinary booking** carrying `waitlist_claim` +
`claim_expires_at`, so `bookingHoldsSeat` and every capacity gate already stop
selling it. **THE SINGLE-DEADLINE RULE:** the hold's `claim_expires_at`, the
entry's `offer_expires_at` and (for a paid claim) the booking hold's `expires_at`
and the Stripe session's `expires_at` are ONE instant, computed once by
`resolveClaimWindow` and copied — diverge and a seat gets sold twice. (A
free-path hold carries no `expires_at`; only the checkout adds it, which is why
`expirePendingBookings` reaches the paid claim hold alone.) A free claim settles
in `claimWaitlistSeat`; a **payable one leaves it and returns through
`createDropInCheckout({ waitlistToken })`** (no second pricing path). **ONE SEAT
WRITER:** on a **class** session `bookings_count` is only ever an ABSOLUTE value,
from `trackBookings`' recount or a transaction that read the `bookings`
subcollection — **no `FieldValue.increment` on it anywhere** (an appointment
session is created together with its one booking, so its `bookings_count: 1` is
absolute and uncontended by construction). Releases go through
`releaseWaitlistOffer` and always **release before re-offering** — where there is
anything to re-offer: the Connect webhook's oversell branch and the session
teardown deliberately do not. Full docs: `docs/waitlist.md`.

### Promo codes — a Stage A MODIFIER, never a tender

**A promo code changes what a purchase costs; a gift card pays for one.** That is
the whole design, and getting it backwards is the single biggest way this area
goes wrong:

> A price **MODIFIER** belongs in Stage A (inside `resolvePaymentOptions`). A
> **TENDER** belongs in Stage B (at the checkout callable). **Nothing is both.**

So the promo is applied inside the resolver and **no callable ever computes a
discounted amount itself** — every one reads `payOption.amount`. The dividend:
every gift-card reservation already receives a post-promo total, so no gift-card
call site needed a promo edit. `teams/{teamId}/promo_codes/{CODE}` (the doc
id IS the code, `PromoCode` in `packages/shared/src/types/promoCode.ts`), written
only by manager callables in `packages/functions/src/connect/promoCodes.ts`;
`firestore.rules` denies every client write. Rails: drop-in, appointment, course,
product — **not** memberships, not gift-card purchases, not the priced-trial door,
and **not the waitlist claim** (its deadline cannot be shortened without giving
one seat two timers, so a code there would lock a use for the whole claim window;
the claim path is refused server-side, not merely unmounted). A code may also be
narrowed by **audience** (`audience: 'all' | 'new_contacts'`, where "new" is
`!joined` — the same fact the `members` access rule runs on, never a second
definition), by entity allow-lists, or bound to one contact.

**Best-one-wins, and the comparator is deliberately ASYMMETRIC.** A *benefit*
applies whenever it does not RAISE the price (`<= base`), because `appliedBenefit`
answers *which membership priced this booking* — provenance read downstream. A
*promo* applies only when **strictly lower**, because `appliedPromo` answers *did
a code change the price* — an event. When a promo beats a benefit, the beaten one
rides on `appliedPromo.supersededBenefit` so a campaign never blanks a studio's
subscription attribution. `appliedBenefit` and `appliedPromo` are never both
present on one option.

**ONE writer of `usage_count`** — `commitPromoRedemption`'s transaction, writing
an **absolute** value from its own read set. No `FieldValue.increment` on
`usage_count` or `PromoRedemption.count` anywhere, and **no restore-on-refund
path**, which is the second writer that would otherwise appear. The manager levers
(`clearPromoRedemption`, `releasePromoReservations`) *delete lifecycle state* and
never adjust a counter.

**A use is consumed by a completed SALE, never by an attempt.** The commit sits at
each handler's per-kind confirm point — never before the dispatch — so every
branch that refunds the whole charge commits nothing and the reservation simply
lapses. A **live reservation consumes a use** (never
over-issue), which is bounded by a deterministic reservation key (a retry is a
refresh, not a second use), `PROMO_MAX_LIVE_RESERVATIONS` + a distinct
`promo_busy` refusal, short checkout windows, reserved-shown-separately-from-used
in the admin list, and the manager release lever. The per-person cap binds to a
**hashed normalised email**, not a contact document — so it is a nudge with teeth,
not a promise, and the admin copy says "counted per email address".

**The deterministic key is paid for by a set of ownership rules**, each of which
was a live bug before it was written down. They are enumerated ONCE, in
`docs/promo-codes.md` → "Redemption integrity" — read them there rather than from
a summary, because the summaries of that list have now disagreed with it (and
with each other) in every review round of this phase. The shape they all share:
the key says *which slot*, `instanceId` says *whose attempt holds it right now*,
and `sessionId` says *which Checkout Session may take money for it*; every
removal or spend compares its marker **inside** the transaction that writes.
Never make the key unique to fix a release bug — that destroys
retry-is-a-refresh.

**A promo writes NO finance journal row, ever** — a discount is not a money event
on a cash basis; the money event is the smaller charge. No `FinanceCategory`
member, no reclass pair, no CSV column. The record is
`PaymentLineItem.promoCode` on the payment row (a system stamp: never read off a
client payload, carried forward across a manager's edit) plus the
`redemptions/{identityKey}` ledger. Full docs: `docs/promo-codes.md`.

### Waivers — a FACT about a person, never a scarce resource

**A signature is a fact about a person, not a claim on a scarce resource.**
Nothing about a waiver is reserved, held, released or restored — the promo
phase's reserve→commit→release apparatus has no analogue here, and reaching
for it is the single biggest way this area goes wrong. There is no price (no
arm in `resolvePaymentOptions`, checkable by `git diff`), no journal row, no
counter but `rounds`, and **no job, cron or sweep anywhere**.

A waiver is a Document (`kind: 'waiver'`) whose published versions are
**immutable snapshots** — `documents/{d}/versions/v0001…`, `allow write: if
false`, minted only by `publishDocumentVersion`, which replaced the old client
status flip **for every kind** (the rules now deny a client *transition* into
`published`). The sanitizer runs THERE, once, and the public mirror **copies**
the frozen `bodyHtml`: two sanitize calls with a library upgrade between them
would break every acceptance hash. `scripts/backfill-document-versions.ts` is a
**deploy precondition** — every already-published document needs a v1 to copy
from.

**The ledger has two halves** (`packages/functions/src/waivers/accept.ts` is
its ONE writer): append-only EVENT rows hold the immutable facts, and one
mutable CURRENT-STATE row per `(document, contact)` holds the answer the gate
asks. The event id derives from the EVENT (`…:intentId`), not the relationship
— which is what makes re-signing, renewal after expiry and re-signing after
revocation expressible at all. The event is ALWAYS created; the signer row is
updated **only when the event strictly improves it**
(`waiverEventImprovesSigner`), against a row re-read **inside the same
transaction**, with `rounds = read + 1` and no `FieldValue.increment`. Two
traps, both learned the hard way: **never** copy `recordFinanceTransaction`'s
`.create()`+catch-gRPC-6 idiom into a transaction (a collision fails the whole
commit and takes the seat) — `tx.get` the acceptance ref in the read phase and
skip; and `accepted_at` is captured **before** the transaction, because a retry
that re-stamps it silently beats a revocation.

**ONE predicate** — `waiverAcceptanceState` (`packages/shared/src/types/waiver.ts`),
fixed order `none → revoked → superseded → expired → valid`. Supersession and
expiry are **never stored**: a `require_resign` publish moves ONE number
(`min_valid_version`) and writes **zero** signer rows. The validity rule is
frozen onto each signature, so editing `validityMonths` governs future
signatures only.

**Authorization reads `teams/{t}/waiver_policy/current`** — server-written,
patched (never rebuilt) inside the same transaction as the document write, and
it fails **CLOSED**. `TeamPublicProfile.required_waivers` is a display mirror
that fails open and is **never** read for a decision; the client calls
`resolveWaiverRequirement` iff that mirror is non-empty, so a tenant with no
waiver pays zero extra round-trips.

**The gate** is `enforceWaiverGate` → `decideWaiverGate`, called once per rail.
**The census owner is the module header of
`packages/functions/src/waivers/gate.ts`** — never restate it, and never state a
count of it; `gate.test.ts` re-derives the caller set from the source so a new
rail that is never added fails the build. Two ordering rules: **refuse before
any contact write**, and **record with the commit** (free rails: inside the seat
transaction; paid rails: before Stripe, in their own transaction, not
conditional on payment). **Every rail refuses** — there is no `defer` arm and no
posture parameter, so no booking anywhere commits with a required waiver
unsigned. **Not gated, deliberately:** staff add-participant (no server seam),
`checkInContact` (a coach chose to admit them), event attendance (a different
primitive), `rebookSession`, `joinWaitlist`, shop purchases.

**Minors are a PROMPT, not an enforcement.** `WaiverConfig.mayIncludeMinors`
(off by default) adds one required choice to the consent step — *I am the
participant* vs *I am signing as a parent or guardian*, plus an optional name —
and puts a chip on the roster and the printed manifest so the studio checks at
the door. It is a **self-declaration**: nothing verifies it, and no copy may
imply otherwise. The control renders **inline** in the waiver editor because its
failure mode is silent; moving it behind "advanced" removes the only guard there
is. The emailed-guardian link this replaced (2026-08-16) proved control of a
mailbox, not parenthood — see `docs/waivers.md` → "Minors" for why ~2,500 lines
of it were deleted rather than fixed.

The **`notify` publish outcome is deferred to v2**: `PublishOutcome` has two
members and the callable refuses `'notify'` by name. The `notices/{id}`
subcollection stays declared and **writer-less** on purpose — removing it would
make notify a migration rather than an addition.

Full docs: `docs/waivers.md`, including **"What the gate does NOT cover"** and
the sixteen recorded decisions.

### Site translations — author once, machine-translate at publish

The studio authors its public site in ONE language (`Team.language` /
`Organization.language`, fallback `'en'` via `resolveSiteSourceLocale`);
`publishWebsite` / `publishOrgWebsite` machine-translate the site text into the
other locales of en/de/fr/it synchronously at publish (DeepL or Google Cloud
Translation behind `packages/functions/src/translate/` — vendor chosen ONLY in
its `provider.ts`, `TRANSLATION_PROVIDER` env; no provider ⇒ warn once, publish
succeeds untranslated — **translation can never fail a publish**). **ONE extractor + ONE
resolver**: `extractSiteUnits` / `applySiteTranslations` /
`applySectionTranslations` in `packages/shared/src/utils/siteTranslation.ts`
own the key grammar (its module header is the authoritative table) — never add
a parallel implementation. Storage: per-locale **sidecar docs in the SAME
collections**, id `{id}__i18n_{locale}` (`siteI18nDocId`, paths.ts) — never
carrying a `slug` field (invisible to the public slug queries),
function-write-only via the existing wildcard rules, with a manifest
`i18n: {srcLang, locales}` on the base doc; embed widgets carry translations
inline (`EmbedWidgetSet.i18n`), written whole by the `onEmbedWidgetsWritten`
trigger (loop guard = fixed-point check). **The hash guard**: every unit is
`{text, srcHash, pinned?}`; the resolver substitutes only when `srcHash`
(`translationSourceHash`, FNV-1a, non-cryptographic) matches the CURRENT base
text — staleness degrades to the authoring language, never to wrong text, and
unchanged text re-publishes with zero provider calls. `pinned` is a
**reservation** for a future manual-override callable: MT writers preserve it
while the hash matches, clear it when the source changes, and the resolver
never reads it. **Never translated**: brand names (`meta.title`, team/org
name), data fields (address/phone/email/mapQuery, place names), live-mirror
content (activity/plan/session names — authoring-language this phase), and
binding text (waivers, cancellation policies — never machine-translated, by
recorded decision). Full docs: `docs/site-translations.md` (incl. the embed
`?hl=en` pinning, the switcher/cookie change, and
`pnpm backfill:site-translations`).

### Scheduled jobs fan out — one Cloud Task per tenant, never a loop

A cron that loops tenants with `await` inside the loop is one instance, one
timeout and one point of failure for every studio at once. Past a few hundred
tenants it does not slow down, it **dies partway** — some tenants done, some
not, with nothing on any screen to say which (`docs/scalability-2026-09.md` §9).

So a scheduled job is a **dispatcher**: `dispatchTenantJob`
(`packages/functions/src/utils/tenantFanOut.ts`, whose header owns the
reasoning) lists the tenants and enqueues one Cloud Task each, and a
`…ForTeam(teamId)` function does one tenant's work. That same function is what
the dispatcher runs inline on a machine with no Cloud Tasks emulator, so there
is never a second implementation to drift. Converted: `sendBookingReminders`,
`markNoShowBookings`, `runScheduledRules`, `weeklyReports` — each with its own
handler in `dailyTasks/tenantWorkers.ts`, hence its own queue and its own retry
and concurrency settings.

Two rules when adding one:

- **Idempotence is the JOB's, not the queue's.** Cloud Tasks is at-least-once.
  The deterministic task id (`{teamId}-{runId}`, tenant first because a run id
  is a sequential prefix and Cloud Tasks degrades on those) is a first line of
  defence; the guarantee has to be the job's own marker — a `reminders_sent`
  key, a report that refuses to overwrite its week, a status that is only ever
  flipped from `pending`.
- **`teams where archived_at == null` matches almost nothing.** A Firestore
  `== null` filter matches an explicit null and NOT a missing field, and no
  team writer sets that field. Project it and filter in memory. The identical
  clause against `contacts` IS correct — see `apps/web/src/lib/liveContacts.ts`
  for why the two collections differ.

### Comments must not assert a COUNT of code sites

A comment saying "the two X", "all three Y", "six copies" or "the only Z" is a
claim that rots the moment somebody adds a case — silently, and against the
reader who trusts it. Wave 3 Phase 3 shipped a false one in **every** review
round and corrected the arithmetic every time; the numbers kept coming back.
So, in order of preference:

1. **Point at the owner.** A list of call sites (a "census") is written down
   ONCE and referred to everywhere else. Existing owners:
   `packages/functions/src/appointments/holdRelease.ts`'s module header (every
   site that can release an appointment hold), `docs/promo-codes.md`
   ("The census — every site that removes a reservation", "The ownership rules",
   "The mounts"), and `packages/functions/src/waivers/gate.ts`'s module header
   (every site that puts a person in a room, with its re-derivation recipe and
   the exemptions stated as explicitly as the inclusions). Add to the owner;
   never copy it.
2. **Name the members and drop the number** — a claim checkable by reading the
   names beside it fails visibly rather than silently.
3. **Assert it in a test.** `packages/functions/src/connect/commitSites.test.ts`
   reads the SOURCE and pins call-site tallies (it spans the functions/web
   boundary on purpose — that boundary is where corrections stop travelling).
   That file is where a bare number is allowed, because there it is executable.

### Stripe fields move — never read one inline

`apiVersion` is deliberately **unpinned**, so the wire version follows whatever
`stripe-node` bundles (today `2026-04-22.dahlia`). Stripe moves fields between
versions, and an `obj.field` read on an `any` that stops matching returns
`undefined` **silently** — no exception, no failing test, just wrong data written
confidently. Three shipped defects came from exactly that.

So every read of a field Stripe has moved goes through
**`packages/functions/src/utils/stripe/objectShape.ts`**, which is the ONE place
that knows where each one lives: modern location first, narrow legacy fallback
(so an older pinned deployment still works), and a report of which one answered
so the caller can log `[stripe-shape] MISSING …` when it is neither. Add a reader
there; never re-inline one at a call site.

That module also holds what a pin was being asked to provide: compile-time
assertions — checked against the SDK's own declarations, reachable via
`Awaited<ReturnType<StripeInstance['x']['retrieve']>>` even though the
`Stripe.X` namespace is not — stating where each field is and is not, plus one
comparing the bundled wire version to the version the readers were verified
against. **A `pnpm update stripe` that moves any of them fails
`turbo run typecheck`**, and the upgrade then also needs `pnpm stripe:sync`
re-run (endpoints are pinned to the SDK's version at creation). The full
reasoning is in the header of `utils/connect/client.ts`; the fixtures are real
captured payloads in `utils/stripe/dahlia-payloads.json`.

### A cancellation is a RECORD, not a boolean

"Cancels at period end" is a **third state** — still live, will not renew — and
the billing portal expresses it as a `cancel_at` **timestamp** while leaving
`cancel_at_period_end` false. So both subscription kinds
(`MemberSubscription`, `SaasSubscription`) store the whole record: `cancel_at`
(when it stops), `canceled_at` (when it was asked for — the two bracket the
win-back window) and `cancellation_details` (`reason`, `feedback`, `comment`).

**`reason` is the load-bearing one.** `payment_failed` and
`cancellation_requested` are the same stored state and completely different
studio actions, and a boolean could not tell them apart — which is most of why
this was worth more than a date.

`shared/utils/subscriptionLifecycle.ts` owns the predicates every surface reads
it through. **WHETHER and WHEN are two questions**, and fusing them was its own
bug: **`subscriptionIsCancelling()`** answers whether (gate UI on this),
**`subscriptionEndsAt()`** answers when *if the date is known* — it returns null
for a pre-migration doc that is plainly cancelling — and
**`subscriptionCancellation()`** returns the whole record or null. All three gate
on the current LIFECYCLE STATE, never on the presence of a cancellation field, so
a stale record left by a reactivation is stale data, not a wrong screen.

Two writer rules, each of which was a bug first:

- **On a LIVE event (`created` / `updated`), write the record whole — every
  field, nulls included.** A reactivation is the event that must ERASE a stored
  end date and reason, and an omitted key on a `merge` leaves them standing.
  **On the ENDING event the two rails differ, deliberately:** the SaaS
  `subscription.cancelled` branch writes `canceled_at` /
  `cancellation_details` only when the payload carries them, so a `deleted`
  event stating no reason cannot erase the one an earlier `updated` recorded.
  Connect routes `deleted` into the same `handleSubscription` and so writes them
  unconditionally — that is the HAZARD, not the standard: a `deleted` payload
  without `cancellation_details` blanks a member's churn reason at the moment it
  is most worth having. The SaaS rule is the safe direction if it ever bites.
  Both behaviours are pinned in `connect/dahliaReads.test.ts`; anything
  repairing these docs reproduces ITS RAIL's rule rather than picking one.
- **`cancellation_details` is set whole or set to null — never key-by-key.**
  Firestore DEEP-merges a nested map, so a partial write keeps the previous
  cancellation's `feedback` behind the new `reason`.

Surfaces: the studio sees the date + the full record (contact detail, operator
console); a studio reading its OWN subscription sees the date + the reason but
not the survey it wrote itself (`audience` on
`components/payments/SubscriptionCancellationNote.tsx`, whose copy lives in the
ONE `SubscriptionCancellation` message namespace); the member's Space sees the
date only — `Contact.active_subscriptions` mirrors only LIVE subscriptions, so a
reason never reaches it.

Docs written before the readers existed carry a null period end, and — where the
cancellation came from the billing portal — a false `cancel_at_period_end` with
no `cancel_at` at all. `pnpm backfill:subscription-lifecycle` repairs them from
Stripe through the same readers — see its header for why the webhook's
self-healing is not enough (the `updated` event that carried the cancellation has
already been consumed, and the next one fires when the member is already gone).

### SaaS plan tiers (Phase 2)

```typescript
type SaasPlan = 'free' | 'coach' | 'studio' | 'organization'
// stored in teams/{teamId}.plan + saas_subscriptions/{teamId}
```

**Plan IDs vs display names:** plan IDs are stable machine identifiers
(Firestore data, security rules, Stripe lookup keys) and must not change once
real customer data exists. Marketing names live in the `Plans` namespace of
`apps/web/messages/*.json`, resolved via `usePlanName()`
(`apps/web/src/hooks/usePlanName.ts`) — never hardcode plan display names in
components or copy. History: the tier was `club` until 2026-06; it was fully
renamed (ID + display) to `studio` while the product was pre-launch with seed
data only. Post-launch, renames must be display-only.

---

## Firebase projects

| Alias | Project ID |
|---|---|
| default (local) | `demo-linyup` (emulator only — `demo-` prefix bypasses project validation) |
| staging | `linyup-staging` |
| production | `linyup-prod` |

Staging and production need to be created in Firebase Console (not done yet).
For local development use the Firebase emulators — no real project needed.

---

## Firebase emulators

Auth: `localhost:9099` | Firestore: `localhost:8080` | Storage: `localhost:9199` | UI: `localhost:4000`

`.env.local` sets `NEXT_PUBLIC_USE_EMULATORS=true`. Emulator connections are guarded by this flag + a `globalThis` flag to prevent HMR double-connect. Storage is wired up in `firebase.ts` (`connectStorageEmulator`, port 9199) — needed for file/image uploads (e.g. Online Courses media + attachments).

Start from repo root (Java required — use external terminal if VS Code's integrated terminal can't find Java). Include `storage` whenever you need uploads:

```
firebase emulators:start --only auth,firestore,storage
```

### Emulator data modes

| Command | Dataset | Notes |
|---|---|---|
| `pnpm emulators:seed` | Fresh seed (wipes + re-seeds) | Three plan-tier demo accounts |
| `pnpm emulators:demo` | `snapshots/demo/` | Persistent demo data for live demo; auto-saved on exit |
| `pnpm emulators:swimli` | `snapshots/swimli/` | Swimli lead-demo rehearsal snapshot (see "Lead demo tenants") |
| `pnpm emulators:hmd` | `snapshots/hmd-migration/` | Real HMD data after migration (+ the four seed tier teams) |
| `pnpm emulators:all` | `snapshots/all/` | **Everything at once** — 28 teams: 16 HMD + 4 seed tiers + 6 sandbox sectors + 2 leads |

A firebase emulator export is ALL-OR-NOTHING per project namespace — there is no
per-collection or per-team export — so `snapshots/hmd-migration/` now also
contains the four seed tier teams that were in the namespace when it was taken.
They are rounding error beside HMD's 16 teams and 1632 contacts, and a genuinely
HMD-only snapshot is still reconstructible at any time by wiping the namespace
and re-running the migration alone.

`snapshots/` is gitignored. Bootstrap each snapshot once — see `scripts/MIGRATE-HMD.md` for the HMD snapshot and the inline docs in `scripts/emulators-demo.mjs` for the demo snapshot.

**These datasets MAY be loaded together** (Franco, 2026-08-19). The old rule here
said "isolated datasets, never mixed"; it was caution rather than a constraint,
and a single emulator holding the seed tiers + the six sandbox sectors + the lead
tenants + real migrated HMD data is a far better test of how the app behaves with
many teams than any of them alone. Everything that matters is `teamId`-scoped, so
mixing exercises the tenant boundary rather than crossing it.

What was actually checked before allowing it, because a silent collision is worse
than no test at all:

- **Contact emails are namespaced by team** (`{name}.{teamId}@example.com`), so no
  two datasets can produce the same one.
- **Login emails are disjoint** — the emulator seed owns `coach@` / `studio@` /
  `org@` / `free@ / manager@ / coach2@linyup.com`, the sandbox owns
  `{teamSlug}@linyup.com`, leads own theirs, and HMD brings its own real users.
- **Team slugs are disjoint**, which matters because `/public/{slug}` resolves a
  studio through a `collectionGroup('public_profile')` query with `limit(1)` — two
  teams sharing a slug would resolve arbitrarily.
- **Org ids are distinct**: `seed-org` vs `hmd`.

**THE ONE PAIR THAT MUST NOT BE COMBINED is the emulator seed and the STAGING
seed.** `seed-staging.ts` deliberately reuses the emulator's team slugs
(`samurai-fight-academy`, `iron-circle-gym`, `titan-combat-sports`) AND its login
emails, so loading both into one namespace collides on both axes. In practice
they never meet — staging targets a real project — but do not "helpfully" point
`seed:staging` at the emulator.

### Seeded tenants show priced doors ONLY with a Stripe test account

`TeamPublicProfile.payments_enabled` **fails closed** (UX-33): a studio with no
chargeable Connect account shows **no shop, no drop-in price, no priced trial and
no priced appointment duration**. A seed must never fake `connectStatus:
'enabled'` — that puts a Pay button in front of a prospect that dies with
`failed-precondition` at the callable, which is the exact defect UX-33 removed.

So the seeders (`seed-emulator.ts`, `seed-sandbox.ts`, `seed-lead.ts`) link a
**real Stripe TEST connected account** when `STRIPE_CONNECT_TEST_ACCOUNT` names
one, and write nothing at all when it is unset — CI and a fresh clone keep the
honest closed state, with one warning line and no error.

**ONE account backs exactly ONE team.** `connect_accounts/{acct}.teamId` is the
only account → team map the Connect webhook has, so pointing one acct at a second
team steals the routing from the first. The env var therefore takes a *list*, and
teams past the end of it stay closed:

```
export STRIPE_CONNECT_TEST_ACCOUNT=acct_123                    # highest-priority team
export STRIPE_CONNECT_TEST_ACCOUNT="acct_123,acct_456"         # two teams
export STRIPE_CONNECT_TEST_ACCOUNT="seed-team-org=acct_123"    # pin one team
```

One-time setup (onboard once, re-attach forever) and the per-seeder priority
order are documented in `scripts/lib/connect.ts`; `pnpm connect:test-account
--list` prints the acct ids on your Stripe test platform, and
`pnpm connect:test-account --team <id> --account acct_…` re-attaches one to an
already-seeded team. **Staging is deliberately NOT wired** — see
`scripts/seed-staging.ts`.

### Lead demo tenants

Prospective-customer sandboxes (real public business data + synthetic contacts),
seeded by the generic `pnpm lead:seed --lead <id>` (`scripts/seed-lead.ts`) from
per-lead profiles in `scripts/leads/{id}/profile.ts` — dual-target: local emulator
or the cloud `linyup-sandbox` project. Seeding is **local-only**: lead profiles are
gitignored, so CI has no profiles to read (the old Seed Lead Sandbox Action was
removed for that reason). Lead tenants are NOT on the public `/try` picker.
Full docs: `scripts/leads/README.md`.

### Sandbox safety model

The sandbox hosts **live prospect demos**, so nothing lands in it unattended:

- **Code deploys are deliberate, never automatic on merge.** `deploy-sandbox.yml`
  runs on a **`sandbox-*` tag push** or `workflow_dispatch` — there is no
  push-to-`main` trigger, so sandbox drifts behind `main` until somebody tags it,
  and the run then waits on the `sandbox` environment's reviewer approval before
  it does anything. Deploy before a demo if backend code changed:
  `git tag -a sandbox-YYYY-MM-DD <sha> -m "why" && git push origin sandbox-YYYY-MM-DD`.
  A second deploy the same day takes a letter suffix (`sandbox-2026-09-03b`, then
  `…c`). **The tag list IS the deployment record** — `git tag -l 'sandbox-*'`, and
  `git log <last-tag>..origin/main` is how far behind sandbox has drifted.
- **What that deploy covers:** functions + Firestore rules/indexes + Storage
  rules, and then the **web app**, rolled out on App Hosting (`linyup-web-eu`,
  the one backend sandbox has) at the tagged commit rather than a branch tip. No
  `hosting:landing` — sandbox has no landing site. **App Hosting auto-rollout
  must stay OFF on that backend**: the workflow does the rollout itself, and the
  Console's own trigger would race it.
- **The `/try` demos reset on a schedule; nothing else does.**
  `.github/workflows/reseed-sandbox.yml` wipes + reseeds the `/try` playground
  **daily** (~04:00 Zurich / 03:00 UTC) so it stays clean and current (the seed
  builds dates relative to the run day) — **lead tenants are always preserved**.
  It is data-only (never deploys code) and runs unattended, so it uses repo-level
  secrets rather than the reviewer-gated `sandbox` environment. Beyond that reseed,
  no push-triggered or scheduled job wipes data, except `purgeProvisionalContacts`
  (in `dailyTasks`), which hard-deletes *expired provisional* contacts across all
  tenants nightly.
- **`pnpm sandbox:reset` PRESERVES lead tenants.** It wipes only the `/try`
  playground; `lead-*` teams, their data and their logins survive. It asks for a
  typed confirmation (`--yes` to skip in CI, `--dry-run` to preview counts first,
  `--include-leads` to override the preservation).
- **To tear down ONE lead**, use `pnpm lead:seed --lead <id> --reset` — scoped to
  that tenant, and it now also asks for typed confirmation against the cloud.
- Both teardown paths derive their collection list from the **shared**
  `TENANT_DATA_COLLECTIONS` (`packages/shared/src/tenantData.ts`), which has a
  completeness test. Never hand-copy that list into a script — the copies went
  stale and started missing `availability_exceptions` and `feedback`.

---

## Firestore security rules

- **Team creation:** any authenticated user can create a team where `createdBy == request.auth.uid` — enables self-service signup.
- **Team member self-provision:** a user can write their own `team_members` doc as `owner` on signup (before membership exists).
- Everything else requires strict team-membership checks (`isTeamMember`, `hasTeamRole`).

---

## Internationalisation (i18n)

**Library:** `next-intl` — installed in `@linyup/web`.

**Locales:** `en` (default), `de`, `fr`, `it` — all four national languages of Switzerland.

**Locale in URL:** `localePrefix: 'as-needed'` — English keeps clean URLs (`/dashboard`); other locales get a prefix (`/de/dashboard`, `/fr/contacts`). Middleware rewrites English paths internally.

**File structure:**
```
apps/web/
├── messages/               ← one JSON per locale
│   ├── en.json             ← source of truth (always complete)
│   ├── de.json
│   ├── fr.json
│   └── it.json
└── src/
    ├── i18n/
    │   ├── routing.ts      ← defineRouting (locales, defaultLocale, localePrefix)
    │   ├── request.ts      ← getRequestConfig (loads messages per locale)
    │   └── navigation.ts   ← createNavigation (locale-aware Link, useRouter, usePathname)
    ├── middleware.ts        ← createMiddleware(routing)
    └── app/
        ├── layout.tsx      ← minimal root: just `return children`
        └── [locale]/
            ├── layout.tsx  ← html+body, NextIntlClientProvider, QueryProvider, AuthProvider
            └── (auth)/     ← all authenticated routes live here
```

**Rules:**
- All routes live under `app/[locale]/`. Never add routes directly to `app/` (except `layout.tsx`).
- Import `Link`, `useRouter`, `usePathname` from `@/i18n/navigation` — NOT from `next/link` or `next/navigation`. The i18n wrappers add locale context automatically.
- Use `useTranslations('Namespace')` for all visible strings. Never hardcode UI text.
- Message keys live in `en.json` first. Add the same key to `de.json`, `fr.json`, `it.json` immediately.
- **Working in parallel? Do NOT open the locale files — write a fragment.** The four
  message files are the busiest contention point in the repo, and the race is at **file**
  level, not key level: an agent reads the whole file, edits, writes back, so two agents
  adding keys to entirely different namespaces still silently lose one another's work.
  Each lane writes `apps/web/messages/_pending/<lane>.json` holding all four translations
  of each key together, then `pnpm i18n:merge` applies them — refusing, rather than
  guessing, on a missing locale, a dropped `{placeholder}`, two lanes claiming one key, or
  a clobber of shipped copy. Contract: `apps/web/messages/_pending/README.md`.
- `pnpm i18n:check` enforces parity across all keys (including the 18 **arrays** that hold
  real copy) and runs in CI's Lint job. It is the ONLY enforcement there is: `apps/web` has
  no test runner, and there is no `IntlMessages` augmentation, so **message keys are untyped
  strings**.
- Since 2026-08-28 it ALSO checks the code against the files: every `t('key')` must exist in
  the namespace its accessor was bound to (`scripts/lib/usedKeys.mjs`). Parity cannot see
  this class — a key that exists in NO locale is perfectly consistent across all four — and
  it is the common one, because the string usually does exist and somebody reached it
  through whichever accessor was in scope. It found eight live ones the day it was added.
  Computed keys (a template literal rather than a string) are counted and reported, never
  failed — which is why section labels are written out as literals instead of built from a
  prefix.
- Sport type names in the signup form are kept in English for now (they're international proper nouns); translate when the need arises.
- Date formatting uses the browser locale via `toLocaleDateString()`. "Today"/"Tomorrow" labels come from `Common.today` / `Common.tomorrow` in messages.
- `typedRoutes: true` is still enabled. With `[locale]` in the path, many route literals need `as Route` cast. This is expected — use casts rather than disabling typedRoutes.

## Next.js specifics

- `typedRoutes: true` at root level in `next.config.ts`. Use `Route` from `next` for typed hrefs.
- Bio-link routes must export `export const dynamic = 'force-dynamic'` to prevent SSG Firebase calls.
- `Input` component in `src/components/ui/input.tsx` uses a plain `<input>` (not `@base-ui/react`) — do not revert this; the base-ui wrapper causes SSR hydration mismatches.

---

## Development commands

**Before starting or stopping ANY local process, run `node scripts/local-env.mjs
status`.** Several worktrees develop this repo at once and they all want the same
ports; both ways that goes wrong are silent (the seeder wipes another checkout's
data behind a clean success banner, and the functions emulator keeps serving the
`dist` of whichever checkout started it). `.claude/skills/local-env/SKILL.md`
owns the port slots, the fresh-worktree bootstrap, and the traps.

**Local dev = one process per terminal.**

In VS Code (the usual way): **Ctrl+Shift+P → "Tasks: Run Task"** → pick a service or a
`Stack:` preset (`.vscode/tasks.json`). Each runs in its own dedicated integrated
terminal; the `Stack:` presets launch several at once (e.g. "Stack: Web" = emulators +
web). Add/extend presets there.

Or run the scripts directly (start the backend in one terminal, then each app in its own):

```bash
pnpm install            # root — installs all workspaces (once)
pnpm bootstrap          # env files from their *.example templates (emulator-first), shared +
                        # functions built when their dist is missing/stale, a port slot claimed.
                        # Idempotent; also runs as the SessionStart hook (.claude/settings.json).

# ── Terminal 1: backend (datasets may be combined — see "Emulator data modes") ──
pnpm emulators:seed     # fresh seed: emulators (auth+firestore+functions+storage) + 3 demo accounts
pnpm emulators:demo     # persistent demo snapshot
pnpm emulators:hmd      # HMD migration snapshot (auth+firestore+storage)

# ── Terminal 2+: apps (one per terminal, as needed) ──
pnpm dev:web            # Next.js admin dashboard (port 3000)
pnpm dev:admin          # operator console (port 3002)
pnpm dev:landing        # Astro marketing site (port 4321)
pnpm dev:mobile         # Expo member app against STAGING (default target)
pnpm dev:mobile:emulators  # … against the local stack (ports from this checkout's slot)

# ── Optional extra terminals ──
pnpm stripe:listen      # forward Stripe test webhooks (platform + Connect) to the local
                        # Functions emulator. Forwards to BOTH handleStripeWebhook (SaaS
                        # billing) and --forward-connect-to handleConnectWebhook (member→
                        # studio payments). Copy the printed whsec_… into
                        # packages/functions/.env.local as STRIPE_CONNECT_WEBHOOK_SECRET
                        # (and STRIPE_WEBHOOK_SECRET), then restart the emulator.
pnpm functions:watch    # rebuild Cloud Functions on save (when editing functions)
```

Test logins for every environment, web AND member app — including the review
studio `linyup-demo` + fixed code that every seeder provisions — are in
`docs/test-accounts.md`. Never re-derive one from a seeder's source.

Quality / CI checks (run anytime): `pnpm build` · `pnpm lint` · `pnpm typecheck` ·
`pnpm test` · `pnpm format` · `pnpm i18n:check` · `pnpm census:reads` (the LOG-list
tripwire — a direct read of a collection that grows with time must carry a bound;
`docs/scalability-2026-09.md` §17 is the census it guards). Cloud/data ops live under `seed:*` / `reset:*` /
`migrate:hmd` / `stripe:sync` / `emulators:export:*` — not part of day-to-day startup.

**Deploy preconditions owed by the scalability work** (`docs/scalability-2026-09.md`
Part 2 §14, Part 3 §19): `pnpm backfill:ledger-ttl` before the TTL index overrides,
and `pnpm backfill:contact-counts` after the functions deploy — the operator console
reads a per-team contact counter that only exists once its trigger or the nightly
reconciliation has written it.

---

## UI/UX porting principles

**Goal: functional parity, not pixel-perfect copy.**

hmd-lineup's UI patterns were designed carefully — especially for mobile. When building or refactoring any page, read the reference first and replicate the *functionality and layout intent*, even though the visual style will differ (shadcn/Tailwind vs MUI).

### What must be ported faithfully

- **Navigation**: icons on every nav item, collapsible sidebar on desktop (full ↔ icon-only), mobile hamburger + swipeable sheet drawer, user/team info at bottom
- **List pages**: mobile-first card/list layouts (avatar + name + status chips), NOT desktop-only tables. Tables are only acceptable for data-heavy views where mobile is less important.
- **Detail pages**: contacts, sessions, events, and bookings all have full detail pages (own route), not just edit modals. A modal is only acceptable for quick create/edit of simple entities.
- **Multi-tab detail views**: contact detail has tabs (profile, notes, activity, subscriptions, gamification). Port the tab structure even if some tabs start empty.
- **Calendar view for sessions**: sessions page has a list tab AND a calendar tab (month/week/day). Use `react-big-calendar` or equivalent.
- **Search + filters**: every list page with >1 filter has a search field + collapsible filter panel.
- **Confirmation dialogs**: all destructive actions (delete, archive) require a confirmation dialog.
- **FAB / primary action**: "New …" button is fixed bottom-right on mobile (FAB pattern), inline toolbar button on desktop.

### What to intentionally diverge from

- Visual style: MUI components → shadcn/ui + Tailwind equivalents
- Redux state → TanStack Query + React context
- Sport-specific fields: belt ranks, Swiss QR Bill, federation logic → remove or generalise
- HMD-specific copy and branding

### Rule

Before writing a new page or refactoring an existing one, check:
```
C:\git\hmd\hmd-lineup\src\routes\{Feature}\   ← reference UX and data flow
```
If a pattern exists in hmd-lineup and is not sport-specific, port it.

---

## Using the reference project in this session

When asked to implement a feature, check the reference first:

```
@C:\git\hmd\hmd-lineup\functions\src\{feature}\index.js   # source function to port
@C:\git\hmd\hmd-lineup\src\routes\{Feature}\              # web UI to re-implement
@C:\git\hmd\hmd-lineup\docs\{topic}.md                    # architecture docs
```

The hmd-lineup codebase is the source of truth for business logic. Port logic faithfully;
only diverge where the old code is HMD-specific (belt ranks, Swiss QR Bill, etc.).
