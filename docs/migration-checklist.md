---
title: HMD port checklist
description: Migration Checklist — hmd-lineup → dgstn-lineup
status: living
area: ops
order: 10
---
# HMD port checklist

Reference project: `C:\git\hmd\hmd-lineup`

Legend: ✅ done · ⏳ in progress · ❌ not started · ~~skipped~~ (out of scope)

---

## Infrastructure & Config

- ✅ pnpm workspaces + Turborepo root setup
- ✅ `packages/shared` — TypeScript types + Firestore path constants
- ✅ `firestore.rules` — ported verbatim, adapted for teamId model
- ✅ `firestore.index.json` — ported verbatim
- ✅ `storage.rules`
- ✅ `database.rules.json`
- ✅ `firebase.json` + `.firebaserc`
- ✅ Firebase emulator config (demo-linyup project)
- ✅ CI/CD — `.github/workflows/verify.yml` + `deploy.yml`

---

## packages/functions — Utils

- ✅ `async.ts` — `to()` helper
- ✅ `email.ts` — `sendEmail()`
- ✅ `secrets.ts` — secret access wrapper
- ✅ `recurrence.ts` — DST-safe Europe/Zurich recurrence logic
- ✅ `teams.ts` — `isTeamMember()`, `hasTeamRole()`
- ✅ `contacts.ts` — count helpers (`getActiveContacts`, `countByField`) — extracted from `analytics/index.ts`
- ✅ `users.ts` — `findTeamWeeklyReport()`, `getOrCreateTeamWeeklyReport()` — plus named count helpers in `contacts.ts`

---

## packages/functions — Cloud Functions

### Teams & Auth
- ✅ `createTeam`
- ✅ `validateTeamSlug`
- ✅ `sendTeamInvitation`
- ✅ `getTeamInvitationDetails`
- ✅ `acceptTeamInvitation`
- ✅ `manageTeamInvitation` (studio+)
- ✅ `manageTeamMember` (studio+)
- ~~`generateAuthToken`~~ — deleted 2026-07-16. Gated on `isTeamMember`, so a contact could never call it; wrote a token shape no reader understood. Signed-in contacts now identify themselves with their contact session (`utils/contactSession.ts`).
- ✅ `sendContactVerificationCode`
- ✅ `verifyContactCode`
- ✅ `completeSignup`
- ~~`validateAuthToken`~~ — deleted 2026-07-17. Read a snake_case `auth_tokens` shape (`type`/`team_id`/`contact_id`) that no writer in the repo ever produced, so every call could only return `not-found` or "type mismatch". The whole `auth_tokens` mechanism went with it (incl. `requestContactUpdate`'s `authToken` mode and the rules block); contacts authenticate with their contact session.
- ✅ `generateApiKey`

### Sync Triggers
- ✅ `syncTeamPublicProfile`
- ✅ `syncSessionPublicProfile`
- ✅ `syncActivityPublicProfile`
- ✅ `indexUser`
- ✅ `syncSubscriptionTypesToPublicProfile`
- ✅ `onContactSubscriptionChange`
- ✅ `onSessionUpdate`

### Sessions
- ✅ `generateRecurringSessions`
- ✅ `cancelSession`
- ✅ `updateRecurringSession`
- ✅ `selfCheckIn`
- ✅ `generateCoachSlots` (callable) + `generateCoachSlotsScheduled` (daily cron)
- ~~`generateCoachSlotsNow`~~ — merged into `generateCoachSlots` callable
- ✅ `setSessionLocation`
- ✅ `setSessionTags`

### Bookings
- ✅ `bookSession`
- ✅ `sendBookingVerificationCode`
- ✅ `verifyBookingCode`
- ✅ `cancelBooking`
- ✅ `rebookSession`
- ✅ `getBookingDetails`
- ~~`bookTrialSession`~~ — superseded by `bookSession` (handles trial + authenticated bio-link bookings, referral tracking, IP rate limiting, contact sessions)
- ✅ `bookCoachSlot`
- ✅ `cancelCoachBooking`
- ✅ `trackCoachBookings`

### Contacts
- ✅ `deleteContact`
- ✅ `restoreContact`
- ✅ `checkInContact`
- ✅ `moveContacts`
- ✅ `generateContactQR`
- ~~`sendContactQrCodes`~~ — deprecated; QR code lives in the student mobile app instead
- ✅ `getContactQR`
- ✅ `manageContactUpdateRequest`
- ✅ `requestContactUpdate`
- ✅ `switchActiveContact`

### Events (studio+)
- ✅ `sendEventInvitations`
- ✅ `getEventInvitationDetails`
- ✅ `handleEventInvitationResponse`
- ✅ `trackEventAttendees`


### Analytics & Tracking
- ✅ `trackBookings`
- ✅ `trackSessions`
- ✅ `weeklyReports` (scheduled, expanded with full breakdown fields + idempotency guard)
- ✅ `trackContacts`
- ✅ `trackSessionParticipants`
- ❌ `generateDashboardInsight` (AI/Gemini)
- ✅ `dailyTasks` (scheduled cleanup + generic `runScheduledRules` scanner)
- ✅ `triggerAutomationRule`
- ✅ `previewAutomationRule`

### Gamification (studio+)
- ✅ `recalculateScores`
- ✅ `resetScores`
- ✅ `processScoresRebuildJob`
- ✅ `triggerScoresRebuild`
- ✅ `recalculateScoresFromDate`

### Outreach & Referrals
- ~~`sendAutomationRuleEmails`~~ — superseded by the generalized automation engine (`runScheduledRules` + event triggers); the daily-only approach has been replaced
- ✅ `sendOutreachEmail` — manual one-off email callable (retained)
- ✅ `generateReferralCodes`
- ✅ `confirmReferral`
- ✅ `getMyReferralCode`
- ✅ `getMyReferralStats`

### Bio-link
- ✅ `bioLinkPreview`
- ✅ `getInTouchForm`

### SaaS Billing
- ✅ `SaasSubscription` shared type (`packages/shared/src/types/saas.ts`)
- ✅ Gateway adapter interface + Stripe adapter + Payrexx stub (`packages/functions/src/utils/gateway/`)
- ✅ `createCheckoutSession` (onCall — Stripe Checkout redirect)
- ✅ `handleStripeWebhook` (onRequest — signature validation, idempotency, saas_subscriptions sync)
- ✅ `cancelSaasSubscription` (onCall — cancel at period end)
- ✅ `getSaasInvoices` (onCall — live from Stripe, not stored)

### Other
- ~~`generateQrBill`~~ (Swiss QR Bill — out of scope)
- ~~`hmdApi`~~ (HMD-specific integration)
- ~~`migrateContactTimestamps`~~ (one-time migration utility)
- ~~`migrateNoShowBookings`~~ (one-time migration utility)
- ~~`setUserPlaceLabel`~~ (HMD place system — evaluate if needed)
- ~~`setUserSessionsTag`~~ (HMD tag system — evaluate if needed)
- ~~`updateUserPlaceRefs`~~ (HMD place system)
- ~~`updateUserSessionsTagRefs`~~ (HMD tag system)

---

## apps/web — Foundation

- ✅ Next.js 15 App Router scaffold
- ✅ shadcn/ui component library
- ✅ Tailwind CSS
- ✅ TanStack Query v5 provider
- ✅ AuthContext + `useAuth()`
- ✅ next-intl i18n (en, de, fr, it)
- ✅ Firebase emulator connection
- ✅ Auth layout: sidebar, topbar, mobile drawer, collapse mode
- ✅ Plan gating: `PlanGate`, `usePlan()`, locked nav items → upgrade page
- ✅ Upgrade page (`/upgrade`)

---

## apps/web — Auth routes

### Dashboard
- ✅ Overview cards (contacts snapshot, recent sessions, alerts)
- ✅ RosterCard (donut chart — type / membership / subscription / billing views)
- ✅ TrendsSection (gated studio+): BookingsTrendCard, SessionsHeatmapCard, ContactsSummaryCard, TopActivitiesCard, TrialFunnelCard
- ❌ AI Insights card (requires `generateDashboardInsight`)

### Contacts
- ✅ Contacts list page
- ✅ Contact detail page (`/contacts/[id]`) — profile, notes, activity, alerts, bookings, subscriptions, goals, gamification tabs
- ✅ Contact create flow (new contact dialog in contacts list page)

### Sessions
- ✅ Sessions list page
- ✅ Sessions calendar view (custom mini-grid + day detail panel — react-big-calendar removed)
- ✅ Session detail page (`/sessions/[id]`)
- ✅ New session / recurring session wizard

### Activities
- ✅ Activities list + create/edit/archive

### Events (studio+)
- ✅ Events list page
- ✅ Event detail page (`/events/[id]`) — overview stats, attendees tab, invitations tab, send/resend invitations, edit, delete
- ✅ Event invitation flow (bio-link RSVP page — `/public/event-invitation?token=…`) — greets contact by name, shows event details, attend/decline buttons, notes field, handles already-responded state, closed/past event notices

### Bookings
- ✅ Bookings list page (basic)
- ✅ Booking management — confirm (creates participant), revert to pending, mark no-show, cancel, rebook

### Coaching
> Restructured: there is no separate `/coaching` admin page. Coaching is modeled as an activity type
> (`type: 'group_class' | 'coaching'` on `Activity`). Sessions inherit `activityType` from their linked
> activity. Coach slot generation remains a backend concern. The bio-link-side booking flow is intact.
- ✅ Activity `type` field (group_class | coaching) — selectable in Activities form; sessions inherit `activityType`
- ✅ Coach slot generation functions (`generateCoachSlots`, `generateCoachSlotsScheduled`)
- ✅ Coach booking flow (bio-link: `/public/[slug]/coaching` + cancel page)
- ~~Admin `/coaching` page~~ — intentionally removed; coaching sessions live in the Sessions page

### Gamification (studio+)
- ✅ Leaderboard, badge award, score breakdown UI — full implementation

### Team
- ✅ Team settings page
- ✅ Team bio-link settings
- ✅ Team members page — full invite/manage UI (send invitations, change role, remove member, cancel invite)
- ✅ Subscription types management (CRUD in team settings — name, description, source, active toggle)
- ✅ Payment gateway config (Payments tab in team settings — add/edit/delete Stripe/Payrexx gateways)

### Billing
- ✅ Billing page (`/billing`) — subscription status, plan selection, invoice history, cancel flow
- ✅ Sidebar nav entry

### Bio-link (public, unauthenticated)
- ✅ Public profile page
- ✅ Session booking flow
- ✅ Trial sign-up form
- ✅ Contact update request form (`/public/[slug]/contact-update?contactId=…`) — email verify → 3-step form → `requestContactUpdate`; "Copy update link" button on contact detail page
- ✅ Event RSVP page — `/public/event-invitation?token=…` (studio+)

---

## apps/mobile (Member app)

- ✅ Full port of hmd-lineup student-app with Linyup branding
- ✅ Auth — passwordless contact session: `sendContactVerificationCode` → `loginContactWithCode` → `signInWithCustomToken` (the HMD `student_auth_tokens` mechanism was never ported; see `docs/mobile-roadmap-2026-09.md`)
- ✅ Home screen / welcome messages
- ✅ Session check-in (QR scan + self check-in)
- ✅ Profile screen
- ✅ OTA update handling

---

## Automation Engine (new in Linyup — supersedes hmd-lineup's daily-only outreach approach)

> Replaces the simple `sendAutomationRuleEmails` daily job with a three-tier generalized engine.
> Outreach emails are one possible action; the engine supports diverse triggers and multiple action types.

- ✅ `utils/automationEngine.ts` — core engine: normalizeRule, evaluateContactConditions, runRule, fireEventRules, enqueueDelayedRule
  - ✅ Backward-compat: normalizeRule() converts legacy hmd-lineup rule format at runtime (no data migration)
  - ✅ 30-day dedup window for scheduled rules; 7-day for event-triggered rules
  - ✅ Plan gate in fireEventRules (studio+ only)
  - ✅ Phase-2+ action types (assign_tag, update_field, webhook) are no-ops until implemented, not errors
- ✅ `dailyTasks/runScheduledRules.ts` — Tier 3 generic scanner (`schedule_daily` rules, inactivity etc.)
  - ✅ Plan gate per team (studio+ only)
- ✅ `automation/triggerAutomationRule` — onCall, manual trigger, bypasses dedup (studio+)
- ✅ `automation/previewAutomationRule` — onCall, dry-run preview, returns matched contacts (studio+)
- ✅ `automation/onContactWrite` — Tier 1 event trigger: contact_created, membership_status_changed, subscription_changed
- ✅ `automation/onBookingWrite` — Tier 1 event trigger: booking_confirmed, booking_no_show
- ✅ `automation/onSessionWrite` — Tier 1+2: session_ended detection + Cloud Tasks enqueue
- ✅ `automation/executeDelayedRule` — Tier 2 Cloud Tasks handler; loads participants at execution time (not at enqueue); idempotency guard via automation_logs
- ✅ `automation_logs` Firestore rules (manager/owner read; write only via Admin SDK)
- ✅ Web UI — Automations page (`/automations`): RuleCard, RuleDialog (trigger + conditions + actions), TemplateDialog
- ✅ Starter kit — `systemDefaults.ts` (4 templates + 8 rules); `StarterKitBanner` with idempotent seeder; banner auto-hides once all system_key templates are loaded
- ✅ Automation Library — `automationLibrary.ts` (18 pre-built rules, 5 categories, 4-language templates); `LibraryDialog` (search, filter, multi-select, installed state); empty state quick-start replaces banner

---

## Security & Data Model

- ✅ Firestore security rules — full port + teamId model
- ✅ `public_profile` pattern enforced for all bio-link-facing data
- ✅ Sync triggers for team, session, activity public profiles
- ✅ `syncSubscriptionTypesToPublicProfile` trigger
- ✅ Firestore indexes reviewed for all new queries added during migration
  - automation_logs: `idempotency_key` equality query (single-field auto-indexed by Firestore ✅)
  - automation_rules: `teamId`+`active`+`trigger` composite index added ✅
  - sessions: `teamId`+`end` composite index already present ✅
