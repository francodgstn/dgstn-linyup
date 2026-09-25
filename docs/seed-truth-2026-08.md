---
title: Seed coverage 2026-08
description: Seed truth — the 2026-08 coverage audit
status: record
area: ops
---
# Seed coverage 2026-08

Phase 1 of `docs/archive/seed-alignment-plan.md` (that plan is now closed; this
document is the live deliverable and remains the schema reference). **Analysis only**: no seeder was run, no
emulator was started, and no seed code was changed to produce this. The Phase 2
worklist that consumes it is appended to that plan.

Five surfaces author tenant data, they share almost nothing, and they have
drifted against one schema independently. This document says *where*, with
evidence, so the repair sessions do not each re-derive the schema truth and
arrive at four different answers.

---

## How this was produced, and what that does not cover

The row set is **every `export const … = '…'` in `packages/shared/src/paths.ts`**,
extracted programmatically rather than from memory — 121 constants. Each was
searched in all five surfaces for both the imported constant *and* the raw string
literal, and every hit was then filtered to lines that actually reach Firestore
(`.collection(` / `.doc(`), which is what separates a write from a comment, an
import or a name in a doc block.

`packages/shared/src/tenantData.ts` is used only to mark rows tenant vs platform
vs retired. It is deliberately not the row set: it classifies top-level
collections only, and most of the last year's work landed in subcollections.

**Limits of this pass, stated so nobody trusts it further than it goes:**

- Verdicts are about **static reachability of a write**, not about the *values*
  written. A row can be `PRESENT` and still hold a shape the app mis-renders;
  the field-level section covers only the cases checked by hand.
- Nothing was executed. A write behind a condition that never fires at runtime
  would still read as `PRESENT` here unless the condition was inspected — the
  ones that were are marked `CONDITIONAL`.
- `scripts/leads/*/profile.ts` is gitignored. Two profiles (`swimli`, `nicole`)
  were present locally and were read; **a fresh clone and CI have neither**, so
  every lead-surface verdict below is "the engine can write this, given a profile
  that asks for it", not "this data exists for anybody who clones the repo".
- The plan's constraint about an untracked in-flight waiver feature is **stale**:
  `packages/functions/src/waivers/request.ts`, `requestEmail.ts`,
  `trackAcceptances.ts`, `consentLedger.ts` and
  `apps/web/src/components/contacts/AskToSignDialog.tsx` are all tracked on
  `main` as of this audit. Nothing here is marked `PENDING`.

## Verdict vocabulary

| Verdict | Meaning |
|---|---|
| `PRESENT` | A reachable write exists in the default run of that surface. |
| `PARTIAL` | Written, but missing fields a real reader needs — see the field-gap section. |
| `PASS-THRU` | Migration only: copied verbatim from the HMD source with no transform, so it carries whatever shape the source had. |
| `CONDITIONAL` | Written only when an env var / profile key is set, and unset is the default. |
| `MISSING` | No write anywhere in that surface, and something visible depends on it. |
| `N-A` | Nothing should write it here — runtime-only (webhook/trigger/cron), operator-owned, retired, or nothing in the product reads it. |

`N-A` is doing real work in this document. A large part of `paths.ts` is
Admin-SDK-only ledger and idempotency state whose *absence is the correct seeded
state*; counting those as gaps would have invented a Phase 2 that should not
exist.

---

## The matrix

Union check: every one of the 121 constants appears in exactly one domain
section below. The domains partition the file's declaration order; nothing is
unowned. **This matrix is the census** — the ranked worklist and the invariants
point at it rather than restating it.

### 1 — Contacts and affiliations

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `CONTACTS_COLLECTION` | PARTIAL `seed-emulator.ts:1351` | PARTIAL `seed-sandbox.ts:2128` | PARTIAL `seed-staging.ts:1420` | PARTIAL `seed-lead.ts:1610` | PARTIAL `passes/05-contacts.ts:36` | `/contacts` |
| `CONTACT_AFFILIATIONS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1392` | PRESENT `seed-sandbox.ts:2184` | PRESENT `seed-staging.ts:1481` | PRESENT `seed-lead.ts:1706` | PRESENT `passes/05-contacts.ts:80` | `/affiliations` |
| `AFFILIATION_TYPES_SUBCOLLECTION` | PRESENT `seed-emulator.ts:648` | PRESENT `seed-sandbox.ts:1727` | PRESENT `seed-staging.ts:949` | PRESENT `seed-lead.ts:1067` | PRESENT `passes/00-setup.ts:71` | `/affiliations` |
| `CONTACT_ALERTS_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2300` | PRESENT `seed-staging.ts:1597` | PRESENT `seed-lead.ts:1870` | PASS-THRU `passes/05-contacts.ts:19` | `/contacts/[id]` alerts |
| `CONTACT_WEEKLY_REPORTS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1530` | PRESENT `seed-sandbox.ts:2262` | PRESENT `seed-staging.ts:1559` | PRESENT `seed-lead.ts:1831` | PASS-THRU `passes/05-contacts.ts:20` | `/contacts/[id]` trend chart |
| `CONTACT_GOALS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1590` | PRESENT `seed-sandbox.ts:2326` | PRESENT `seed-staging.ts:1657` | PRESENT `seed-lead.ts:1897` | PASS-THRU `passes/05-contacts.ts:101` | `/contacts/[id]` goals |
| `CONTACT_NOTES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/contacts/[id]` NotesTab — empty everywhere |
| `CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION` | MISSING | PRESENT `lib/fixtures/coaching.ts:227` via `seed-sandbox.ts:2321` | MISSING | MISSING | PASS-THRU `passes/05-contacts.ts:21` (renamed from `training_checkins`) | `/contacts/[id]` performance radar |
| `CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1411` | PRESENT `seed-sandbox.ts:2197` | PRESENT `seed-staging.ts:1494` | PRESENT `seed-lead.ts:1718` | PASS-THRU `passes/05-contacts.ts:16` | `/contacts/[id]` subscriptions |
| `CONTACT_CREDIT_GRANTS_SUBCOLLECTION` | MISSING | MISSING | MISSING | PRESENT `seed-lead.ts:1761` | MISSING | `/contacts/[id]` credits; credit-pack booking |
| `SUBSCRIPTION_TRANSITIONS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | PASS-THRU `passes/11-team-subcollections.ts:13` | `/subscriptions` transition history |
| `MONTHLY_SCORES_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2235` | PRESENT `seed-staging.ts:1532` | PRESENT `seed-lead.ts:1804` | PASS-THRU `passes/05-contacts.ts:18` | `/gamification` |
| `CONTACT_GROUPS_SUBCOLLECTION` | MISSING | MISSING | MISSING | PARTIAL `seed-lead.ts:837` | MISSING | `/plugins/contact-groups` |
| `CONTACT_FILTERS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/contacts` saved filter presets |

### 2 — Sessions, bookings and the waitlist

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `SESSIONS_COLLECTION` | PRESENT `seed-emulator.ts:943` | PRESENT `seed-sandbox.ts:1921` | PRESENT `seed-staging.ts:1201` | PRESENT `seed-lead.ts:1346` | PRESENT `passes/06-sessions.ts:16` | `/schedule` |
| `COACH_SLOT_BOOKINGS_SUBCOLLECTION` (value `bookings`; live as `sessions/{id}/bookings`) | PRESENT `seed-emulator.ts:948` | PRESENT `seed-sandbox.ts:1926` | PRESENT `seed-staging.ts:1206` | PRESENT `seed-lead.ts:1351` | PRESENT `passes/06-sessions.ts:57` | `/bookings` |
| `PARTICIPANTS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1460` | PRESENT `seed-sandbox.ts:2400` | PRESENT `seed-staging.ts:1731` | PRESENT `seed-lead.ts:1369` | PRESENT `passes/06-sessions.ts:46` | `/sessions/[id]` roster |
| `SESSION_SERIES_COLLECTION` | MISSING | MISSING | MISSING | PRESENT `seed-lead.ts:572` | PRESENT `passes/04-session-series.ts:17` | `/schedule` recurring-series edit |
| `WAITLIST_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/public/{slug}/waitlist`; seat-offer banner on `/sessions/[id]` |
| `TEAM_SESSIONS_TAGS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | session tag picker (`setSessionTags`) |
| `CHECKINS_COLLECTION` | MISSING | MISSING | MISSING | MISSING | PRESENT `passes/08-events.ts:62` | event `CheckinPanel` |

### 3 — Activities, availability and appointments

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `ACTIVITIES_COLLECTION` | PRESENT `seed-emulator.ts:770` | PRESENT `seed-sandbox.ts:1745` | PRESENT `seed-staging.ts:1034` | PRESENT `seed-lead.ts:1103` | PRESENT `passes/03-activities.ts:18` | `/offer/activities` |
| `AVAILABILITY_COLLECTION` | PRESENT `seed-emulator.ts:881` | PRESENT `seed-sandbox.ts:1865` | PRESENT `seed-staging.ts:1145` | PRESENT `seed-lead.ts:1276` | MISSING (no HMD analogue — correct) | `/schedule/availability`; `/public/{slug}/appointments` |
| `AVAILABILITY_EXCEPTIONS_COLLECTION` | MISSING | MISSING | MISSING | PRESENT `seed-lead.ts:1400` | N-A | `/schedule/availability` time-off |
| `COACH_SLOTS_COLLECTION` | N-A | N-A | N-A | N-A | N-A | retired (`tenantData.ts:165`) |

### 4 — Courses and purchases

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `COURSES_COLLECTION` | PRESENT `seed-emulator.ts:2226` | PRESENT `seed-sandbox.ts:3082` | PRESENT `lib/storefront.ts:466` | PRESENT `seed-lead.ts:2490` | N-A | `/plugins/online-courses`; shop Courses tab |
| `COURSE_MODULES_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2280` | PRESENT `seed-sandbox.ts:3087` | PRESENT `lib/storefront.ts:471` | PRESENT `seed-lead.ts:2500` | N-A | `/plugins/online-courses/[courseId]` |
| `COURSE_LESSONS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2298` | PRESENT `seed-sandbox.ts:3101` | PRESENT `lib/storefront.ts:485` | PRESENT `seed-lead.ts:2514` | N-A | `/public/{slug}/space/courses/[courseSlug]` |
| `COURSE_PURCHASES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | `/public/{slug}/space` unlock state on a `purchase`-tier course |

### 5 — Documents, versions and waivers

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `DOCUMENTS_COLLECTION` | PRESENT `seed-emulator.ts:2464` | PARTIAL `seed-sandbox.ts:2891` | PARTIAL `seed-staging.ts:2089` | PARTIAL `seed-lead.ts:2438` | MISSING | `/plugins/documents`; `/public/{slug}/documents` |
| `DOCUMENT_VERSIONS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2576` | MISSING | MISSING | MISSING | MISSING | `/plugins/documents/[documentId]` history; `pnpm verify:waiver-ledger` |
| `DOCUMENT_ACCEPTANCES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/contacts/[id]` consent state; the booking waiver gate |
| `DOCUMENT_SIGNERS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | roster waiver chip; printed manifest |
| `DOCUMENT_NOTICES_SUBCOLLECTION` | N-A | N-A | N-A | N-A | N-A | writer-less by design (`notify` deferred to v2) |
| `WAIVER_POLICY_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | the booking gate — fails **closed**, so absence means "no waiver required" |
| `WAIVER_POLICY_DOC_ID` | MISSING | MISSING | MISSING | MISSING | MISSING | as above (`waiver_policy/current`) |
| `TEAM_SETTINGS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2463` | PRESENT `seed-sandbox.ts:2890` | PRESENT `seed-staging.ts:2088` | PRESENT `seed-lead.ts:2437` | MISSING | `/public/{slug}/signup` consent checkboxes |
| `DOCUMENTS_SETTINGS_DOC_ID` | PRESENT `seed-emulator.ts:2464` | PRESENT `seed-sandbox.ts:2891` | PRESENT `seed-staging.ts:2089` | PRESENT `seed-lead.ts:2438` | MISSING | as above |

The hits a raw scan reports for the waiver constants in the non-emulator surfaces
all resolve to `scripts/lib/exportConsentLedger.ts:70-84`, which **reads** the
ledger on the teardown path. It is not a writer, and counting it as one would
have been the most expensive false `PRESENT` in this audit.

### 6 — Payments, gift cards and promo codes

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `CONNECT_ACCOUNTS_COLLECTION` | CONDITIONAL `lib/connect.ts:61` | CONDITIONAL `lib/connect.ts:61` | N-A (deliberate — `seed-staging.ts` header) | CONDITIONAL `lib/connect.ts:61` | N-A | `/payments`; every priced door on `/public/{slug}` |
| `MEMBER_PAYMENTS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | `/payments`; `/contacts/[id]` PaymentsTab |
| `MEMBER_SUBSCRIPTIONS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | `/contacts/[id]` PaymentsTab; the `subscription_status` rollup |
| `GIFT_CARDS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1873` | MISSING | MISSING | CONDITIONAL `seed-lead.ts:1001` | N-A | `/public/{slug}/shop` gift-card redemption |
| `GIFT_CARD_ISSUES_SUBCOLLECTION` | N-A | N-A | N-A | N-A | N-A | serialisation marker; callable-written only |
| `PROMO_CODES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | `/manage/promo-codes` — empty in every demo |
| `PROMO_REDEMPTIONS_SUBCOLLECTION` | N-A | N-A | N-A | N-A | N-A | ledger; written only by `commitPromoRedemption` |
| `PAYMENT_EVENTS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | `/payments` BYO-gateway rows |
| `PARTNER_VISITS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | aggregator payout reporting |
| `POLICY_FEES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | no-show fee list |
| `CONNECT_WEBHOOK_EVENTS_COLLECTION` | N-A | N-A | N-A | N-A | N-A | Stripe idempotency markers |
| `SAAS_SUBSCRIPTIONS_COLLECTION` | PARTIAL `seed-emulator.ts:1804` | PARTIAL `seed-sandbox.ts:2603` | PARTIAL `seed-staging.ts:1966` | PARTIAL `seed-lead.ts:2182` | N-A | `/settings/billing`; operator console tenant row |

### 7 — Finance and accounting

Every row here is `MISSING` on all five surfaces, and the finance plugin is never
installed by any seeder, so `/plugins/finance` is an empty shell in every demo and
every migrated tenant.

| Constant | The screen that proves it |
|---|---|
| `FINANCE_TRANSACTIONS_SUBCOLLECTION` | `/plugins/finance` journal |
| `FINANCE_MONTHLY_REPORTS_SUBCOLLECTION` | `/plugins/finance/reports` |
| `ACCOUNTING_ACCOUNTS_SUBCOLLECTION` | `/plugins/finance/accounts` |
| `ACCOUNTING_SETTINGS_SUBCOLLECTION` | `/plugins/finance` settings |
| `ACCOUNTING_SETTINGS_DOC` | as above (`accounting_settings/config`) |
| `ACCOUNTING_ENTRIES_SUBCOLLECTION` | `/plugins/finance/entries` |
| `ACCOUNTING_PERIOD_SUMMARIES_SUBCOLLECTION` | `/plugins/finance/reports` |
| `ACCOUNTING_ENTRY_TEMPLATES_SUBCOLLECTION` | `/plugins/finance/entries` template picker |

Two of these are honestly `N-A` rather than gaps: `finance_monthly_reports` and
`accounting_period_summaries` are regenerated from the journal by cron and always
overwritten. Seed the journal and the accounts; leave the rollups alone.

### 8 — Team configuration, plugins, integrations and messaging

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `TEAMS_COLLECTION` | PRESENT `seed-emulator.ts:564` | PRESENT `seed-sandbox.ts:1563` | PRESENT `seed-staging.ts:831` | PRESENT `seed-lead.ts:497` | PRESENT `passes/02-teams.ts:23` | everything |
| `TEAM_MEMBERS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:630` | PRESENT `seed-sandbox.ts:1641` | PRESENT `seed-staging.ts:884` | PRESENT `seed-lead.ts:1020` | PRESENT `passes/11-team-subcollections.ts:92` | `/settings/members` |
| `USER_PUBLIC_PROFILE_SUBCOLLECTION` | PRESENT `seed-emulator.ts:599` | PRESENT `seed-sandbox.ts:1614` | PRESENT `seed-staging.ts:859` | PRESENT `seed-lead.ts:945` | PRESENT `passes/11-team-subcollections.ts:159` | every `/public/{slug}` route |
| `ROLE_CONFIG_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2842` | PRESENT `seed-sandbox.ts:1710` | PRESENT `seed-staging.ts:2051` | PRESENT `seed-lead.ts:1050` | MISSING | `/settings/roles` |
| `SUBSCRIPTION_TYPES_SUBCOLLECTION` | PRESENT `seed-emulator.ts:969` | PRESENT `seed-sandbox.ts:1952` | PRESENT `seed-staging.ts:1227` | PRESENT `seed-lead.ts:1421` | PRESENT `passes/11-team-subcollections.ts:132` | `/offer/subscriptions` |
| `PRODUCTS_SUBCOLLECTION` | PRESENT `lib/storefront.ts:222` | PRESENT `lib/storefront.ts:222` | PRESENT `lib/storefront.ts:222` | PRESENT `seed-lead.ts:2603` | MISSING (the plugin is installed at `passes/11-team-subcollections.ts:148`, but no product documents are written — a migrated tenant's public shop is live and empty) | `/manage/products`; shop Products tab |
| `INSTALLED_PLUGINS_SUBCOLLECTION` | PARTIAL `seed-emulator.ts:1858` | PARTIAL `seed-sandbox.ts:2873` | PARTIAL `lib/storefront.ts:138` | PARTIAL `seed-lead.ts:2420` | PARTIAL `passes/00-setup.ts:102` | `/settings/plugins` |
| `ORG_INSTALLED_PLUGINS_SUBCOLLECTION` | PARTIAL `seed-emulator.ts:1858` | MISSING | MISSING | MISSING | PRESENT `passes/00-setup.ts:102` | `/org/[orgId]/plugins` |
| `TEAM_INTEGRATIONS_SUBCOLLECTION` | MISSING | MISSING | MISSING | PRESENT `seed-lead.ts:854` | MISSING | `/settings/emails` |
| `EMAIL_SENDER_INTEGRATION_DOC` | MISSING | MISSING | MISSING | MISSING | MISSING | `/settings/emails` sender card |
| `SMS_SENDER_INTEGRATION_DOC` | MISSING | MISSING | MISSING | PRESENT `seed-lead.ts:855` | MISSING | SMS reminder sends |
| `MESSAGING_POLICIES_COLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2623` | MISSING | PRESENT `seed-lead.ts:897` | MISSING | operator console delivery policy |
| `TEAM_ACTIVITY_LOG_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2490` | PRESENT `seed-staging.ts:1826` | PRESENT `seed-lead.ts:2074` | PASS-THRU `passes/11-team-subcollections.ts:21` | `/dashboard` activity feed |
| `TEAM_WEEKLY_REPORTS_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:3345` | MISSING | PRESENT `seed-lead.ts:2780` | PASS-THRU `passes/11-team-subcollections.ts:22` | `/dashboard` trend charts |
| `ALERT_PRESETS_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2723` | PRESENT `seed-staging.ts:2274` | MISSING | PASS-THRU `passes/11-team-subcollections.ts:19` | `/automations` presets |
| `OUTREACH_TEMPLATES_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2687` | PRESENT `seed-staging.ts:2237` | PRESENT `seed-lead.ts:2241` | PASS-THRU `passes/11-team-subcollections.ts:14` | `/automations` templates |
| `AUTOMATION_RULES_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2793` | PRESENT `seed-staging.ts:2345` | PRESENT `seed-lead.ts:2263` | PASS-THRU `passes/11-team-subcollections.ts:15` | `/automations` |
| `AUTOMATION_LOGS_SUBCOLLECTION` | MISSING | PRESENT `seed-sandbox.ts:2833` | PRESENT `seed-staging.ts:2386` | MISSING | MISSING | `/automations` run log |
| `TEAM_INVITATIONS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | PASS-THRU `passes/11-team-subcollections.ts:16` | `/settings/members` pending invites |
| `CONTACT_REQUESTS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | PASS-THRU `passes/11-team-subcollections.ts:17` | `/contacts` inbound requests |
| `TEAM_ALERTS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | PASS-THRU `passes/11-team-subcollections.ts:18` | `/dashboard` alert banner |
| `TEAM_PLACES_SUBCOLLECTION` | MISSING | MISSING | MISSING | PRESENT `seed-lead.ts:809` | PRESENT `passes/12-places.ts:17` | `/schedule/places` |
| `NOTIFICATIONS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | `TeamNotificationsBanner` on `/dashboard` |
| `TEAM_REBUILD_JOBS_SUBCOLLECTION` | N-A | N-A | N-A | N-A | N-A | no reader in `apps/` — see the last section |
| `SITE_DRAFTS_COLLECTION` | PRESENT `lib/storefront.ts:336` | PRESENT `seed-sandbox.ts:2949` | PRESENT `lib/storefront.ts:336` | PRESENT `seed-lead.ts:2460` | PRESENT `passes/13-org-website.ts:124` | `/plugins/website` |
| `SITE_PUBLISHED_COLLECTION` | PRESENT `lib/storefront.ts:349` | PRESENT `seed-sandbox.ts:2962` | PRESENT `lib/storefront.ts:349` | PRESENT `seed-lead.ts:2473` | PRESENT `passes/13-org-website.ts:143` | `/public/{slug}/site` |
| `EMBED_WIDGETS_COLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/embed/[slug]/[sectionId]` |
| `FEEDBACK_COLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | operator console feedback inbox |
| `FEEDBACK_PROMPTS_COLLECTION` | N-A | N-A | N-A | N-A | N-A | ops-authored, platform-global |

### 9 — Events and programs

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `EVENTS_COLLECTION` | PARTIAL `seed-emulator.ts:1688` | PARTIAL `seed-sandbox.ts:2517` | PARTIAL `seed-staging.ts:1885` | PARTIAL `seed-lead.ts:2097` | PARTIAL `passes/08-events.ts:12` | `/events/[id]` |
| `EVENT_INVITATIONS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1750` | PRESENT `seed-sandbox.ts:2549` | PRESENT `seed-staging.ts:1917` | PRESENT `seed-lead.ts:2129` | PASS-THRU `passes/08-events.ts:33` | `/public/event-invitation` |
| `EVENT_ATTENDEES_SUBCOLLECTION` | PRESENT `seed-emulator.ts:1774` | PRESENT `seed-sandbox.ts:2572` | PRESENT `seed-staging.ts:1940` | PRESENT `seed-lead.ts:2152` | PASS-THRU `passes/08-events.ts:33` | `/events/[id]` attendees |
| `EVENT_PROGRAM_ITEMS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/events/[id]` ProgramTab; `/public/{slug}/events/[eventId]/print` |
| `PROGRAM_TEMPLATES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/settings/program-templates` |
| `ORG_PROGRAM_TEMPLATES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/org/[orgId]/program-templates` |
| `EVENT_TYPES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | `/settings/event-types` — degrades gracefully (`BUILTIN_EVENT_TYPES` still render) |
| `EVENT_CATEGORIES_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | MISSING | HMD Fighting Cup `CategoryManager` (plugin-only) |

### 10 — Organisations

| Constant | emu | sbx | stg | lead | mig | The screen that proves it |
|---|---|---|---|---|---|---|
| `ORGANIZATIONS_COLLECTION` | PRESENT `seed-emulator.ts:646` | N-A (all six tenants are `studio`) | PRESENT `seed-staging.ts:947` | N-A | PRESENT `passes/00-setup.ts:48` | `/org/[orgId]` |
| `ORG_MEMBERS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2374` | N-A | PRESENT `seed-staging.ts:2452` | N-A | PRESENT `passes/00-setup.ts:78` | `/org/[orgId]/members` |
| `ORG_TEAMS_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2392` | N-A | PRESENT `seed-staging.ts:2465` | N-A | PRESENT `passes/02-teams.ts:43` | `/org/[orgId]/teams` |
| `ORG_AFFILIATION_STATUSES_SUBCOLLECTION` | PRESENT `seed-emulator.ts:2368` | N-A | PRESENT `seed-staging.ts:2447` | N-A | PRESENT `passes/00-setup.ts:68` | `/org/[orgId]/affiliations` |
| `ORG_INVITATIONS_SUBCOLLECTION` | MISSING | N-A | MISSING | N-A | MISSING | `/org-invite/[orgId]/[invId]` |
| `ORG_MEMBER_INVITATIONS_SUBCOLLECTION` | MISSING | N-A | MISSING | N-A | MISSING | `/org-member-invite/[orgId]/[token]` |
| `ORG_ACCESS_REQUESTS_SUBCOLLECTION` | MISSING | N-A | MISSING | N-A | MISSING | `/org/[orgId]` access-request queue |
| `ORG_PLACES_SUBCOLLECTION` | MISSING | N-A | MISSING | N-A | MISSING | `/org/[orgId]/places` |
| `ORG_SITE_DRAFTS_COLLECTION` | MISSING | N-A | MISSING | N-A | PRESENT `passes/13-org-website.ts:124` | `/org/[orgId]/website` |
| `ORG_SITE_PUBLISHED_COLLECTION` | MISSING | N-A | MISSING | N-A | PRESENT `passes/13-org-website.ts:143` | `/public/org/[slug]` |

### 11 — Platform, forms, referrals and the rest

| Constant | emu | sbx | stg | lead | mig | Note |
|---|---|---|---|---|---|---|
| `USERS_COLLECTION` | PRESENT `seed-emulator.ts:654` | PRESENT `seed-sandbox.ts:1653` | PRESENT `seed-staging.ts:896` | PRESENT `seed-lead.ts:534` | PRESENT `passes/00-setup.ts:30` | login |
| `APP_SETTINGS_COLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | operator-owned; gates public signup |
| `GLOBAL_SETTINGS_DOC` | MISSING | MISSING | MISSING | MISSING | N-A | as above |
| `PUBLIC_SETTINGS_DOC` | MISSING | MISSING | MISSING | MISSING | N-A | the world-readable signup flag |
| `SIGNUP_ALLOWLIST_COLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | limited-launch signup gate |
| `SIGNUP_INVITES_COLLECTION` | N-A | N-A | N-A | N-A | N-A | write-to-send queue |
| `PLATFORM_METRICS_COLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | operator console charts (cron-written) |
| `MAIL_SUPPRESSIONS_COLLECTION` | N-A | N-A | N-A | N-A | N-A | Brevo webhook ledger |
| `MAIL_SENDS_COLLECTION` | N-A | N-A | N-A | N-A | N-A | idempotency ledger |
| `SMS_SUPPRESSIONS_COLLECTION` | N-A | N-A | N-A | N-A | N-A | opt-out ledger |
| `FORMS_COLLECTION` | MISSING | MISSING | MISSING | CONDITIONAL `seed-lead.ts:2680` | N-A | `/plugins/custom-forms` |
| `FORM_SUBMISSIONS_SUBCOLLECTION` | MISSING | MISSING | MISSING | MISSING | N-A | `/plugins/custom-forms/[formId]` submissions |
| `REFERRALS_COLLECTION` | MISSING | MISSING | MISSING | MISSING | PRESENT `passes/10-referrals.ts:11` | `/plugins/referrals` |
| `REFERRAL_CODES_COLLECTION` | N-A | N-A | N-A | N-A | N-A | no reader in `apps/` |
| `CATEGORIES_COLLECTION` | N-A | N-A | N-A | N-A | N-A | no reader in `apps/` |
| `PROJECTS_COLLECTION` | N-A | N-A | N-A | N-A | N-A | legacy top-level; no seeder write and no exercised reader |

---

## Field-level gaps on the `PARTIAL` rows

Each gap names the type it is measured against and one real reader.

### `contacts` — `subscription_status` is written by nobody

`Contact.subscription_status` (`packages/shared/src/types/contact.ts:259`) is the
contact-level rollup of the per-subscription Stripe status. Readers:
`apps/web/src/app/[locale]/(auth)/contacts/[id]/PaymentsTab.tsx:320` and the
automation condition at `packages/functions/src/utils/automationEngine.ts:488`.
**No surface writes it**, because no surface writes `member_subscriptions`
either — the rollup is maintained by `onMemberSubscriptionWrite`
(`packages/functions/src/sync/onMemberSubscriptionWrite.ts:115`), which never
fires on seeded data. The two gaps are one gap: seed `member_subscriptions` and
the rollup follows wherever triggers run.

`Contact.active_subscriptions` has the same shape of problem and the same cause.
`scripts/migration/transforms/contacts.ts` is the only place that writes it.

### `contacts` — filter dimensions with no data behind them

`ContactFilter` (`packages/shared/src/utils/contactFilter.ts:99`) has `coaches`,
`customFields`, `groups` and `consent` dimensions. Only `seed-lead.ts` writes
`group_ids` and `custom_fields`, and only when the profile supplies them;
`assigned_coach_ids` is not written onto contact documents by emulator, sandbox
or staging. Consent has no data anywhere (see the waiver rows). A studio opening
`/contacts` on any demo tenant therefore meets four filter dimensions that return
everything or nothing.

### `documents` — a published document with no version

`Document.current_version` (`types/document.ts:64`) and the immutable
`versions/v0001` snapshot are what `publishDocumentVersion` copies from and what
an acceptance pins. `seed-emulator.ts:2547-2593` gets this right and says why in
a comment. `seed-sandbox.ts:3266`, `seed-staging.ts:2183` and `seed-lead.ts:2652`
all write `status: 'published'` with **no `current_version`, no
`min_valid_version` and no `versions` subcollection** — reproducing on every run
exactly the state `scripts/backfill-document-versions.ts` exists to clear, and
the state `scripts/verify-waiver-ledger.ts` is meant to alarm on.

All three also copy the **raw** `body` into the public mirror's `bodyHtml`
(`seed-sandbox.ts:3282`, `seed-staging.ts:2201`, `seed-lead.ts:2669`) rather than
the sanitized frozen snapshot the type's doc comment requires. The emulator
sanitizes once and copies (`seed-emulator.ts:2554`).

### `saas_subscriptions` — the cancellation record is a boolean

`SaasSubscription` carries `cancel_at`, `canceled_at` and `cancellation_details`
alongside `cancel_at_period_end` (`packages/shared/src/types/saas.ts:22-39`).
Every surface writes only `cancel_at_period_end: false`
(`seed-emulator.ts:1813`, `seed-sandbox.ts:2612`, `seed-staging.ts:1975`,
`seed-lead.ts:2191`) and none seeds a **cancelling** subscription at all.
`SubscriptionCancellationNote` (`apps/web/src/components/payments/`) and the
operator console's churn-reason column therefore have no state that renders them
on any surface — and the distinction the record exists for (`payment_failed` vs
`cancellation_requested`) is undemoable.

### `installed_plugins` — most of the catalogue is never installed

`PLUGIN_REGISTRY` (`apps/web/src/plugins/registry.ts:28`) is the catalogue. What
the surfaces install:

- **emulator**: `kiosk`, `online-courses`, `gift-cards`, plus `products` and `website` via the storefront helper
- **sandbox**: `gamification`, `website`, `online-courses`
- **staging**: `products`, `website`, `online-courses` (all via `lib/storefront.ts:138`)
- **lead**: `gamification`, `website`, `online-courses`, `products`, plus `custom-fields` / `contact-groups` / `custom-forms` / `gift-cards` **only when the profile supplies matching data**
- **migration**: `products` on every migrated team (`passes/11-team-subcollections.ts:148`) and the `hmd` container at `organizations/hmd` (`passes/00-setup.ts:102`), which reconciles to `hmd-fighting-cup`

Installed by nothing: `finance`, `promo-codes`, `referrals`. Installed by lead
alone: `custom-fields`, `contact-groups`, `custom-forms`. `ai-assistant`,
`ai-insights` and `whatsapp` are correctly excluded — they are locked/key-gated,
and both `lib/storefront.ts:126` and `seed-sandbox.ts:2857` say so in a comment.

### `events` — no program

`Event.program` embeds days and tracks; the rows live in
`events/{id}/program_items` (`docs/event-program.md`). No surface writes either,
so `ProgramTab` on `/events/[id]` and the printed manifest at
`/public/{slug}/events/[eventId]/print` are empty on every demo tenant, and
`/org/[orgId]/program-templates` has nothing to apply.

---

## Semantic invariants

Checked against the rules in `CLAUDE.md` and `docs/`.

| Invariant | Verdict |
|---|---|
| Waitlist single-deadline (`claim_expires_at` / `offer_expires_at` / hold `expires_at` are one instant) | **N-A — not exercised.** No surface writes `waitlist`, so the rule cannot be violated and is also never demonstrated. |
| `bookings_count` written absolute, never incremented | **HELD, all five.** There is no `FieldValue.increment` anywhere under `scripts/`. Each seeder accumulates in a local `Map` and writes the total once (`seed-emulator.ts:1510`, `seed-sandbox.ts:2457`, `seed-staging.ts:1788`, `seed-lead.ts:2045`); migration writes an absolute recount (`passes/06-sessions.ts:86`). |
| Subscription docs carry the whole cancellation record | **NOT MET on all four seeders** — see the field-gap section. Not a wrong write; an absent one. |
| Contact status on the three axes, not the retired `Contact.type` / `membership_*` | **HELD in the written documents.** The `type: 'student'` occurrences in the seeders are *local fixture* fields used to derive the axes (e.g. `seed-staging.ts:1749`), never written to Firestore. `acquisition_stage`, `entry`, `source` and `affiliation_summary` are written by all four seeders and by `transforms/contacts.ts`. The one hole is `subscription_status`, above. |
| Published documents have a `v0001` to copy from | **NOT MET on sandbox, staging and lead. HELD on emulator.** See the field-gap section. |
| Dynamic contact groups hold a rule and never materialise membership | **HELD, and never exercised.** The only surface writing `contact_groups` is lead (`seed-lead.ts:837`), and every group it writes is manual — no `rule` key, membership via `Contact.group_ids`. The dynamic half of the feature has zero coverage anywhere. |
| Appointment activities carry `durations` + at most one `memberBenefit` | **HELD on all four seeders.** One appointment activity each, with `durations` and a single `memberBenefit` (`seed-emulator.ts:840`, `seed-sandbox.ts:1824`, `seed-staging.ts:1103`, and the lead engine at `seed-lead.ts:1094`). Both the legacy `{kind, discountPercent}` and the generalized `{effect, percent}` shapes appear; both are valid — `normalizeBenefit` (`types/benefit.ts:49`) is the single normalization point. Availability is availability-only in all four: `scripts/lib/appointments.ts` materialises already-booked sessions and never fabricates open slots. |

Two further invariants, found while checking the above and worth recording
because a Phase 2 session will otherwise "fix" them:

- **Priced doors fail closed, and the seeds respect it.** `linkSeedConnectAccount`
  (`scripts/lib/connect.ts:231`) writes `connect_accounts` and
  `payments_enabled: true` **only** when `STRIPE_CONNECT_TEST_ACCOUNT` names an
  account. Unset is the default, so a fresh clone gets no shop, no drop-in price,
  no priced trial. That is correct behaviour — but it means every `PRESENT` on a
  priced surface is really `CONDITIONAL`, and seeding "a paid booking" without an
  account seeds a door nobody can open.
- **Paid bookings are deliberately unseeded.** `scripts/lib/appointments.ts:15-20`
  states the rule: seeded appointments are always free-path-shaped, because a paid
  one needs a matching webhook-written `member_payments` ledger row. This is why
  the whole payments domain reads `MISSING`, and it is a considered decision
  rather than drift. Phase 2 should either seed the ledger row alongside, or leave
  the domain alone — not seed half of it.

---

## Duplication register

Fixtures that appear in three or more surfaces in copy-pasted form. This scopes a
later `scripts/lib/fixtures/` extraction; that extraction is **not** proposed
here.

| Fixture | Where | Shape of the duplication |
|---|---|---|
| Booking write + `bookings_count` roll-up | `seed-emulator.ts:1476-1512`, `seed-sandbox.ts:2420-2459`, `seed-staging.ts:1751-1789`, `seed-lead.ts:2009-2047` | Same `Map` accumulator, same booking field set (`teamId`, `contact`, `session`, `email`, `firstname`, `lastname`, `phone`, `is_new_contact`, `joinedAt`, `status: 'pending'`, `booking_token`), same write-back loop. Four copies, near-identical apart from how the contact is named. |
| Appointment activity + `durations` + `memberBenefit` + availability template | `seed-emulator.ts:808-905`, `seed-sandbox.ts:1797-1870`, `seed-staging.ts:1077-1150` | Half-extracted already: `scripts/lib/appointments.ts` owns the session/booking materialisation, but the activity and availability documents are still written inline three times. |
| Documents seed + `public_profile` mirror | `seed-emulator.ts:2546-2608`, `seed-sandbox.ts:3255-3285`, `seed-staging.ts:2176-2205`, `seed-lead.ts:2640-2672` | Four copies — and the one that is correct (emulator) is not the one the other three were copied from. The clearest case in the repo for extraction: the divergence is invisible at a glance and produces a broken waiver ledger. |
| `installed_plugins` writer | `seed-emulator.ts:1858`, `seed-sandbox.ts:2861-2884`, `lib/storefront.ts:128-148`, `seed-lead.ts:2400-2434` | Identical document shape (`pluginId`, `teamId`, `installedAt`, `installedBy`, `status`, `config`, `updated_at`) written four ways; `lib/storefront.ts` already holds the extracted version. |
| Subscription-history pair (previous closed + current open) | `seed-emulator.ts:1400-1440`, `seed-sandbox.ts:2190-2225`, `seed-staging.ts:1487-1522`, `seed-lead.ts:1712-1750` | Same two-row pattern, same field set. |
| Contact weekly reports / monthly scores generators | `seed-emulator.ts:1516-1560`, `seed-sandbox.ts:2228-2290`, `seed-staging.ts:1525-1590`, `seed-lead.ts:1797-1860` | Same random-walk generator, same doc-id convention (ISO week label). |
| Path constants re-declared instead of imported | `lib/storefront.ts:24-28`, `lib/appointments.ts` header, `migration/config.ts:36-47` | Each mirrors `@linyup/shared` because `tsconfig.scripts.json` does not resolve the workspace import. All three say so in a comment; the mirroring is why a `paths.ts` rename does not reach the seeders. |

---

## Ranked worklist per surface

Ranked by "how visibly broken is the demo", because these seeds exist to be shown
to people.

### emulator (`pnpm emulators:seed`)

1. **`contact_notes` is empty** — the Notes tab is on the contact detail page every
   demo opens first, and it renders a permanent empty state.
2. **`contact_alerts` missing** (present in the other three seeders) — the
   attention/alerts surface on `/contacts` and `/dashboard` has nothing.
3. **`monthly_scores` missing** while gamification exists elsewhere — `/gamification`
   is empty on the tier seeds.
4. **No `team_activity_log` / `team_weekly_reports`** — `/dashboard` shows an empty
   feed and flat trend charts, which is the first screen after login.
5. **No automations data** (`outreach_templates`, `automation_rules`,
   `automation_logs`, `alert_presets`) — `/automations` is empty here but populated
   on sandbox and staging.
6. Then the cross-surface items below.

### sandbox (`pnpm sandbox:seed`, the `/try` playground)

1. **Published documents with no version** — the one that produces a real alarm:
   `verify-waiver-ledger` fails on freshly seeded data, and the mirror carries
   unsanitized HTML.
2. **No gift cards** — the emulator has a demo card and the shop shows redemption;
   the six `/try` tenants do not.
3. **No `contact_groups` / `custom_fields` / `forms`** — three plugin surfaces a
   prospect can click into and find empty.
4. **No `team_places`** — `/schedule/places` is empty and sessions reference no room.
5. **No `session_series`** — every session looks like a one-off, and the recurring-class
   story is the most common thing a studio asks about.
6. Then the cross-surface items.

### staging (`pnpm seed:staging`)

1. **Published documents with no version** — same as sandbox.
2. **No `team_weekly_reports`** — the dashboard trend charts are flat on the
   environment used to rehearse releases.
3. **No gift cards, forms, groups, places, series** — same list as sandbox.
4. **Connect is deliberately unwired** — keep it that way (`seed-staging.ts` header
   explains why); do not "fix" this in Phase 2.
5. Then the cross-surface items.

### lead (`pnpm lead:seed --lead <id>`)

The most complete surface, and the one shown to actual prospects.

1. **Published documents with no version** — same defect, highest stakes: a lead
   demo is where a studio asks about liability waivers.
2. **No waiver at all** — a lead profile can express documents, but not a waiver,
   its policy, or a signature. See the cross-surface item.
3. **`automation_logs` missing** while rules exist — `/automations` shows rules that
   have apparently never run.
4. **`alert_presets` missing** — the presets picker is empty.
5. Then the cross-surface items.

### migration (`pnpm migrate:hmd`)

1. **Migrated tenants have no documents at all**, so no `versions` and no
   `waiver_policy`. `scripts/backfill-document-versions.ts` is the stated deploy
   precondition; the migration should either run it or write versions itself.
2. **Pass-through subcollections carry HMD's shape** — `team_invitations`,
   `contact_requests`, `team_alerts`, `alert_presets`, `subscription_transitions`,
   `outreach_templates`, `automation_rules` and `products` are copied verbatim by
   `passes/11-team-subcollections.ts:9-23` with no transform. Any field Linyup
   added since is absent, silently. **This is the largest `UNVERIFIED` area in this
   audit**: confirming it needs the HMD source schema in hand, which was out of
   scope here.
3. **The shop is switched on and empty.** `passes/11-team-subcollections.ts:146-160`
   installs the `products` plugin and flips `active_public_surfaces.shop` to true,
   but nothing writes any `products` document — so `/public/{slug}/shop` goes live
   on the first migrated tenant with an empty catalogue. Either seed a product or
   leave the surface off until the studio adds one.
4. **No `availability`** — correct today (HMD had no appointments), but a migrated
   tenant lands with the appointments feature unusable until someone configures it.
5. **`goals/{id}/evaluations`** is copied (`passes/05-contacts.ts:101-112`) but has
   no `paths.ts` constant — see the last section.

### Cross-surface, ranked

1. **Waivers — zero coverage on all five surfaces.** No `kind: 'waiver'` document,
   no `waiver_policy/current`, no `signers`, no `acceptances`. The gate
   (`packages/functions/src/waivers/gate.ts`) fails closed on an absent policy, so
   every seeded tenant behaves as "no waiver required" and the whole feature — the
   roster chip, the minors prompt, Ask-to-Sign, the printed manifest column — is
   invisible in every demo and unexercised by every rehearsal.
2. **Event programs — zero coverage.** `program_items`, `program_templates`,
   `org_program_templates`.
3. **Finance and accounting — zero coverage**, and the plugin is never installed.
4. **Promo codes — zero coverage**, and the plugin is never installed;
   `/manage/promo-codes` is empty everywhere.
5. **`member_payments` / `member_subscriptions` — zero coverage**, which also leaves
   `Contact.subscription_status` and `active_subscriptions` unwritten. Decide
   deliberately (see "paid bookings are unseeded") before touching this.
6. **Waitlist — zero coverage.** `/public/{slug}/waitlist` and the seat-offer flow
   cannot be shown.
7. **`course_purchases` — zero coverage.** A `purchase`-tier course exists in the
   shop on three surfaces, but nobody has ever bought one, so the Space unlock
   state is never demonstrated.

---

## Constants nobody reads, and strings nobody owns

Recorded so a Phase 2 session does not spend effort seeding something inert.

**Constants with no reader in `apps/web`, `apps/admin` or `packages/functions`:**
`REFERRAL_CODES_COLLECTION`, `CATEGORIES_COLLECTION`,
`TEAM_REBUILD_JOBS_SUBCOLLECTION`. `COACH_SLOTS_COLLECTION` is explicitly retired
in `tenantData.ts:165`. `PROJECTS_COLLECTION` is classified platform but has no
exercised reader path.

**Constants whose value collides with another's**, so a raw-string grep cannot
tell them apart — each was disambiguated by reading the call site:
`CATEGORIES_COLLECTION` / `EVENT_CATEGORIES_SUBCOLLECTION` (both `categories`),
`INSTALLED_PLUGINS_SUBCOLLECTION` / `ORG_INSTALLED_PLUGINS_SUBCOLLECTION` (both
`installed_plugins`), `DOCUMENTS_COLLECTION` / `DOCUMENTS_SETTINGS_DOC_ID` (both
`documents`), and `COACH_SLOT_BOOKINGS_SUBCOLLECTION` (`bookings`) — whose
constant is retired while the string it names is very much alive as
`sessions/{id}/bookings`.

**Collection names a surface writes with no `paths.ts` constant:** `leaderboard`
(`passes/11-team-subcollections.ts:20`), `goals/{goalId}/evaluations`
(`passes/05-contacts.ts:101`), and `saas_checkout_attempts` (registered in
`tenantData.ts:113` with a note that it has no constant). The first two are
migration-only pass-throughs; whether they still exist in the current schema is
`UNVERIFIED`.
