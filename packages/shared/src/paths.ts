// Firestore collection and subcollection path constants

export const USERS_COLLECTION = 'users'
export const USER_PUBLIC_PROFILE_SUBCOLLECTION = 'public_profile'
// THE public mirror subcollection — `teams|organizations|sessions|events|courses|
// documents/{id}/public_profile/{id}`, the world-readable summary every public
// surface queries (`collectionGroup(PUBLIC_PROFILE_SUBCOLLECTION)` filtered on
// `type`). Same string as the user mirror above, named for its own use: it was
// hand-typed at every public read site, and a lint rule now refuses a literal
// where a constant here exists (docs/scalability-2026-09.md §7, item 25).
export const PUBLIC_PROFILE_SUBCOLLECTION = 'public_profile'

export const TEAMS_COLLECTION = 'teams'
export const TEAM_MEMBERS_SUBCOLLECTION = 'team_members'
export const TEAM_PLACES_SUBCOLLECTION = 'team_places'
export const TEAM_SESSIONS_TAGS_SUBCOLLECTION = 'sessions_tags'
export const TEAM_ACTIVITY_LOG_SUBCOLLECTION = 'activity_log'
export const TEAM_WEEKLY_REPORTS_SUBCOLLECTION = 'team_weekly_reports'
export const TEAM_INVITATIONS_SUBCOLLECTION = 'team_invitations'
export const CONTACT_REQUESTS_SUBCOLLECTION = 'contact_requests'
/**
 * @deprecated Superseded by `NOTIFICATIONS_SUBCOLLECTION`
 * (`teams/{teamId}/notifications`) — see `types/teamNotification.ts`.
 *
 * A second, parallel team inbox: two writers, ZERO readers, no `link`, no
 * `status`, and rules that let a coach read an alert they had no permission to
 * dismiss. Both writers now create a `TeamNotification` instead. The
 * collection, its rules and its indexes stay so existing documents are not
 * stranded — but NOTHING should write it again.
 */
export const TEAM_ALERTS_SUBCOLLECTION = 'team_alerts'
export const ALERT_PRESETS_SUBCOLLECTION = 'alert_presets'
// Per-team overrides for customizable roles (currently only the Coach role).
// Doc id = the role id, e.g. teams/{teamId}/role_config/coach.
export const ROLE_CONFIG_SUBCOLLECTION = 'role_config'
export const SUBSCRIPTION_TYPES_SUBCOLLECTION = 'subscription_types'
export const PRODUCTS_SUBCOLLECTION = 'products'
export const CONTACT_FILTERS_SUBCOLLECTION = 'contact_filters'
/** The one doc in `contact_filters` that is not a filter: which presets are pinned. */
export const CONTACT_FILTER_PRESET_PINS_DOC = '_preset_pins'
export const CONTACT_GROUPS_SUBCOLLECTION = 'contact_groups'
export const OUTREACH_TEMPLATES_SUBCOLLECTION = 'outreach_templates'
export const AUTOMATION_RULES_SUBCOLLECTION = 'automation_rules'
export const AUTOMATION_LOGS_SUBCOLLECTION = 'automation_logs'
export const WEBHOOK_ENDPOINTS_SUBCOLLECTION = 'webhook_endpoints'
export const TEAM_REBUILD_JOBS_SUBCOLLECTION = 'rebuild_jobs'
// The monthly leaderboard: one denormalised document per team (see
// types/leaderboard.ts), plus a per-month history written at month end.
export const TEAM_LEADERBOARD_SUBCOLLECTION = 'leaderboard'
export const TEAM_LEADERBOARD_CURRENT_DOC = 'current'
export const TEAM_LEADERBOARD_HISTORY_SUBCOLLECTION = 'leaderboard_history'

// Platform-wide operator configuration (SMTP, etc.). Single well-known doc.
// Read by Cloud Functions (getAppSettings) and written by the operator console.
export const APP_SETTINGS_COLLECTION = 'app_settings'
export const GLOBAL_SETTINGS_DOC = 'global_settings'
// Public, world-readable subset of app settings (e.g. the signup flag). Kept in
// a SEPARATE doc from global_settings so the public read rule never exposes the
// private operator/SMTP config.
export const PUBLIC_SETTINGS_DOC = 'public'
/** app_settings/mobile — the member app's world-readable policy (MobileAppSettings). */
export const MOBILE_SETTINGS_DOC = 'mobile'

// Signup gating (limited-launch). Both are Admin-SDK only (PII / security).
// signup_allowlist: emails permitted to create a Linyup account while public
// signup is closed. signup_invites: write-to-send-an-invite-email queue.
export const SIGNUP_ALLOWLIST_COLLECTION = 'signup_allowlist'
export const SIGNUP_INVITES_COLLECTION = 'signup_invites'

// SaaS-specific (new in Linyup)
export const SAAS_SUBSCRIPTIONS_COLLECTION = 'saas_subscriptions'
// Daily platform-wide operator metric snapshots (doc id = YYYY-MM-DD).
// Written by the capturePlatformMetrics function; read by the operator console.
// Operator → Customer notices, and the resolved recipient list each one was
// actually sent to. See types/platformNotice.ts for why the list is stored
// rather than re-derived.
export const PLATFORM_NOTICES_COLLECTION = 'platform_notices'
export const PLATFORM_NOTICE_RECIPIENTS_SUBCOLLECTION = 'recipients'

export const PLATFORM_METRICS_COLLECTION = 'platform_metrics'

// App-store presence — what App Store Connect and Google Play say about the
// member app. Written by the `appstores` ingest, read by the operator console,
// both Admin SDK; no client access at all (see types/storePresence.ts for why
// store_reviews in particular must never be readable).
export const STORE_PRESENCE_COLLECTION = 'store_presence'
/** store_presence/{platform} — doc id is the StorePlatform ('ios' | 'android'). */
export const STORE_PRESENCE_IOS_DOC = 'ios'
export const STORE_PRESENCE_ANDROID_DOC = 'android'
/** store_presence/{platform}/daily/{YYYY-MM-DD} — the vendor-reported series. */
export const STORE_PRESENCE_DAILY_SUBCOLLECTION = 'daily'
/** Doc id = `${platform}_${kind}_${vendorId}` — see storeReviewDocId(). */
export const STORE_REVIEWS_COLLECTION = 'store_reviews'
/**
 * Append-only log of App Store Connect webhook deliveries.
 * Doc id = `${platform}_${vendorEventId}` — see storeEventDocId().
 */
export const STORE_EVENTS_COLLECTION = 'store_events'
export const ORGANIZATIONS_COLLECTION = 'organizations'
export const ORG_MEMBERS_SUBCOLLECTION = 'org_members'
export const ORG_TEAMS_SUBCOLLECTION = 'org_teams'
// THE TWO ORG INVITATIONS ARE DIFFERENT RELATIONSHIPS. The naming rule that
// tells them apart: AN INVITATION IS NAMED AFTER THE COLLECTION IT GRANTS INTO.
//
//   org_invitations         → org_teams    a whole STUDIO joins the org. Accepted
//                                          by that studio's OWNER; it moves the
//                                          studio's billing onto the org plan.
//   org_member_invitations  → org_members  a PERSON joins the org's staff as
//                                          org_admin / org_viewer. Accepted by
//                                          that person; it grants no studio
//                                          anything and touches no billing.
//
// `org_invitations` predates the rule and is misnamed by it (`org_team_invitations`
// is what it would be called today); it is shipped data behind a live route
// (/org-invite/{orgId}/{invId}), so it keeps its name and the rule is enforced
// on everything after it. Never conflate the two — an org admin who receives
// "you've been invited" must not land on a screen that enrols their studio.
export const ORG_INVITATIONS_SUBCOLLECTION = 'org_invitations'
export const ORG_MEMBER_INVITATIONS_SUBCOLLECTION = 'org_member_invitations'
export const ORG_ACCESS_REQUESTS_SUBCOLLECTION = 'org_access_requests'
/** A studio asking to join the organisation — `organizations/{id}/team_access_requests`. */
export const ORG_TEAM_ACCESS_REQUESTS_SUBCOLLECTION = 'team_access_requests'
export const ORG_AFFILIATION_STATUSES_SUBCOLLECTION = 'affiliation_statuses'
export const ORG_PLACES_SUBCOLLECTION = 'org_places'
// Affiliation type catalog — same subcollection name under organizations/{orgId}
// (org-wide types) AND teams/{teamId} (team-local types). See AffiliationType.
export const AFFILIATION_TYPES_SUBCOLLECTION = 'affiliation_types'
export const TEAM_INTEGRATIONS_SUBCOLLECTION = 'integrations'
export const INSTALLED_PLUGINS_SUBCOLLECTION = 'installed_plugins'
// Same subcollection name, under organizations/{orgId} instead of teams/{teamId}.
// Exported as a separate constant for clarity at call sites.
export const ORG_INSTALLED_PLUGINS_SUBCOLLECTION = 'installed_plugins'
// Well-known integration doc id for a studio's email sender configuration
// (teams|organizations/{id}/integrations/email_sender). See EmailSenderConfig.
export const EMAIL_SENDER_INTEGRATION_DOC = 'email_sender'
// Well-known integration doc id for a studio's custom PUBLIC domain
// (teams|organizations/{id}/integrations/public_domain). See PublicDomainConfig.
// The sibling of email_sender, and deliberately a separate doc: the domain a
// studio SENDS from and the domain their pages are SERVED from are different
// facts with different lifecycles, and a studio may well have one and not the
// other. Contains no credentials.
export const PUBLIC_DOMAIN_INTEGRATION_DOC = 'public_domain'

// public_domains/{hostname} — the GLOBAL uniqueness registry for custom public
// domains. The doc id IS the hostname (like promo_codes), which is what makes
// "one hostname, one tenant" a property of the database rather than of a check
// somebody has to remember to run. Admin-SDK only; every client access is
// denied by the rules — a tenant reads its own config doc instead, and the
// registry would otherwise let anyone enumerate every studio's domain.
export const PUBLIC_DOMAINS_COLLECTION = 'public_domains'

// Mail pipeline (Brevo). Both are Admin-SDK only — written by Cloud Functions
// (the webhook handler + mail service), never by clients.
// mail_suppressions: dead/complained recipients (doc id = sha256(email)).
// mail_sends: idempotency + delivery ledger (doc id = idempotency key).
export const MAIL_SUPPRESSIONS_COLLECTION = 'mail_suppressions'
export const MAIL_SENDS_COLLECTION = 'mail_sends'
// sms_suppressions: opted-out/undeliverable phone numbers (doc id = sha256(E.164)).
// Same Admin-SDK-only posture as the mail collections.
export const SMS_SUPPRESSIONS_COLLECTION = 'sms_suppressions'
// messaging_policies: OPERATOR-controlled per-tenant outbound-delivery policy
// (doc id = teamId | orgId | 'system'). Admin-SDK-only; see MessagingPolicy.
export const MESSAGING_POLICIES_COLLECTION = 'messaging_policies'
// Well-known integration doc id for a studio's SMS sender configuration
// (teams/{id}/integrations/sms_sender): { type, senderName, enabled }.
export const SMS_SENDER_INTEGRATION_DOC = 'sms_sender'

// In-app feedback (see types/feedback.ts).
// feedback: client CREATE with strict rules validation; read/update via the
// operator console only (Admin SDK). feedback_prompts: ops-authored prompt
// questions — any signed-in user reads, Admin-SDK-only writes.
export const FEEDBACK_COLLECTION = 'feedback'
export const FEEDBACK_PROMPTS_COLLECTION = 'feedback_prompts'

export const PROJECTS_COLLECTION = 'projects'
export const CONTACTS_COLLECTION = 'contacts'
/** Scoped grants to edit one contact's own details — see types/contactLink.ts.
 *  Server-written only; `firestore.rules` denies every client read and write,
 *  which is what lets the document hold an OTP hash at all. */
export const CONTACT_UPDATE_LINKS_COLLECTION = 'contact_update_links'
export const CONTACT_ALERTS_SUBCOLLECTION = 'contact_alerts'
export const CONTACT_WEEKLY_REPORTS_SUBCOLLECTION = 'contact_weekly_reports'
export const CONTACT_NOTES_SUBCOLLECTION = 'contact_notes'
export const CONTACT_GOALS_SUBCOLLECTION = 'goals'
/** Evaluations of one goal: contacts/{c}/goals/{g}/evaluations/{e}. Was a bare
 *  string literal in the web tab, the Space, the mobile app and the trigger —
 *  four places to keep in step by hand. */
export const CONTACT_GOAL_EVALUATIONS_SUBCOLLECTION = 'evaluations'
export const CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION = 'performance_checkins'
export const CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION = 'subscription_history'
// Lesson-credit grants (pack purchases) — functions-only writes; see CreditGrant.
export const CONTACT_CREDIT_GRANTS_SUBCOLLECTION = 'credit_grants'
// Completed purchases of a subscription PRICE — one row per payment, doc id =
// the payment ref. Functions-only writes; read to enforce
// `SubscriptionPrice.maxPurchasesPerContact`. See PlanPurchase.
export const CONTACT_PLAN_PURCHASES_SUBCOLLECTION = 'plan_purchases'
export const SUBSCRIPTION_TRANSITIONS_SUBCOLLECTION = 'subscription_transitions'
// Affiliation set — a contact may hold several (club + federation licence + grading).
export const CONTACT_AFFILIATIONS_SUBCOLLECTION = 'affiliations'
// Push-notification device registrations, doc id = the token itself. See
// `PushToken` (types/push.ts) for why. Client writes are self-only
// (contacts/{id}/push_tokens/{token}, isSelfContact — no staff/admin arm at
// all); sendPush (packages/functions/src/push/) is the only Admin-SDK writer,
// and it only ever DELETES a token the vendor reports dead. See the
// firestore.rules match for the full reasoning.
export const CONTACT_PUSH_TOKENS_SUBCOLLECTION = 'push_tokens'

export const EVENTS_COLLECTION = 'events'
export const EVENT_TYPES_SUBCOLLECTION = 'event_types'
export const EVENT_CATEGORIES_SUBCOLLECTION = 'categories'
export const EVENT_INVITATIONS_SUBCOLLECTION = 'invitations'
export const EVENT_ATTENDEES_SUBCOLLECTION = 'attendees'
// The event's agenda — events/{eventId}/program_items/{itemId}
export const EVENT_PROGRAM_ITEMS_SUBCOLLECTION = 'program_items'
// Reusable programs. Team-owned, plus org-owned templates every member studio
// can apply read-only (same scope model as team_places / org_places).
export const PROGRAM_TEMPLATES_SUBCOLLECTION = 'program_templates'
export const ORG_PROGRAM_TEMPLATES_SUBCOLLECTION = 'org_program_templates'
export const CHECKINS_COLLECTION = 'checkins'
export const SESSIONS_COLLECTION = 'sessions'
export const PARTICIPANTS_SUBCOLLECTION = 'participants'
// Class waitlist — sessions/{sessionId}/waitlist/{contactId}. The doc id is the
// contactId, exactly like `bookings`, so a second join is an idempotent write
// rather than a duplicate row. Written only by Cloud Functions (Admin SDK);
// every client write is denied. Deliberately NOT registered in tenantData.ts:
// tenant teardown uses recursiveDelete on the parent session.
export const WAITLIST_SUBCOLLECTION = 'waitlist'
export const MONTHLY_SCORES_SUBCOLLECTION = 'monthly_scores'
export const ACTIVITIES_COLLECTION = 'activities'
export const SESSION_SERIES_COLLECTION = 'session_series'
// Background teardown of a series' future sessions — one doc per run, written
// only by Cloud Functions. The client polls it for progress; see
// types/sessionSeriesJob.ts.
export const SESSION_SERIES_JOBS_COLLECTION = 'session_series_jobs'

export const REFERRALS_COLLECTION = 'referrals'
export const REFERRAL_CODES_COLLECTION = 'referral_codes'

export const AVAILABILITY_COLLECTION = 'availability'
// Provider time-off that OVERRIDES the availability templates — a coach is
// unavailable in [start, end) even if a template would otherwise offer it.
export const AVAILABILITY_EXCEPTIONS_COLLECTION = 'availability_exceptions'
export const COACH_SLOTS_COLLECTION = 'coach_slots'
export const COACH_SLOT_BOOKINGS_SUBCOLLECTION = 'bookings'
// `sessions/{id}/bookings` — the seat ledger every booking rail writes and
// `trackBookings` recounts. Same string as the coach-slot one above, named for
// its own use (see PUBLIC_PROFILE_SUBCOLLECTION for why a twin is deliberate).
export const SESSION_BOOKINGS_SUBCOLLECTION = 'bookings'

export const CATEGORIES_COLLECTION = 'categories'

// Online Courses plugin (lightweight LMS)
export const COURSES_COLLECTION = 'courses'
export const COURSE_MODULES_SUBCOLLECTION = 'modules'
export const COURSE_LESSONS_SUBCOLLECTION = 'lessons'
// Lifetime entitlement granted when a contact buys a 'purchase'-tier course one-off.
// Doc id is the buyer's contactId; written only by the Connect webhook (admin SDK).
export const COURSE_PURCHASES_SUBCOLLECTION = 'purchases'

// Custom Forms plugin (form builder + submissions backend)
// forms/{formId}: team-scoped form (fields embedded on the doc).
// submissions: written ONLY by the submitForm Cloud Function (Admin SDK).
export const FORMS_COLLECTION = 'forms'
export const FORM_SUBMISSIONS_SUBCOLLECTION = 'submissions'

// Documents (core operational documents: terms, privacy, regulations, waivers)
// documents/{documentId}: team-scoped, authored rich text OR an external link.
// The world-readable summary lives in the generic `public_profile` subcollection
// (written by syncDocumentPublicProfile) — no dedicated subcollection constant.
export const DOCUMENTS_COLLECTION = 'documents'

// ── Waivers (Wave 3 Phase 4) ────────────────────────────────────────────────
// Everything hangs off the DOCUMENT, not off the contact, and that is
// deliberate: the evidence must survive the contact. purgeProvisionalContacts
// hard-deletes expired provisional contacts nightly and a per-team teardown uses
// recursiveDelete, so a contact-scoped acceptance subcollection would be
// destroyed by both. Document-scoped rows are not.
//
// NO tenantData.ts REGISTRATION for any of these: the completeness test
// classifies top-level *_COLLECTION constants only, and `documents` is already
// registered there with a teamId field match. Same finding as the gift-card and
// promo phases — do not add a constant.

/** IMMUTABLE published snapshots. Doc id = documentVersionId(n) → 'v0001'…,
 *  zero-padded so a plain orderBy(documentId()) is chronological with no index.
 *  `allow write: if false`; written once by publishDocumentVersion. */
export const DOCUMENT_VERSIONS_SUBCOLLECTION = 'versions'
/** APPEND-ONLY acceptance/revocation EVENT rows. Doc id = waiverAcceptanceId(),
 *  which contains the event's own nonce — never the relationship alone, which is
 *  what made re-signing, expiry and revocation inexpressible in the first
 *  design. Server-written only. */
export const DOCUMENT_ACCEPTANCES_SUBCOLLECTION = 'acceptances'
/** APPEND-ONLY notice rows, one per send attempt.
 *
 *  ⚠ NO WRITER IN THIS PHASE. The `notify` publish outcome is deferred to v2;
 *  the MODEL stays so adding it later is an addition rather than a migration.
 *  See WaiverNoticeRow in types/waiver.ts for the full reasoning — do not delete
 *  this constant on the grounds that nothing writes it. */
export const DOCUMENT_NOTICES_SUBCOLLECTION = 'notices'
/** THE one mutable current-state row per (document, contact). Doc id =
 *  contactId — NOT an identity key, because a shared household mailbox would
 *  give two people the same identity key and merge one person's signature with
 *  another's. Exactly one writer: functions/src/waivers/accept.ts. */
export const DOCUMENT_SIGNERS_SUBCOLLECTION = 'signers'
/** teams/{teamId}/waiver_policy/current — THE authorization source for the
 *  booking gate. Server-written, client-read; it fails CLOSED, unlike the
 *  display mirror on the team's public profile, which fails open by design. */
export const WAIVER_POLICY_SUBCOLLECTION = 'waiver_policy'
export const WAIVER_POLICY_DOC_ID = 'current'

// ─── Per-team feature settings ────────────────────────────────────────────────
// teams/{teamId}/settings/{settingId} — owner-writable, member-readable config
// for features that are NOT plugins. It exists because Documents stopped being a
// plugin: its signup-consent selection used to live inside
// `installed_plugins/documents.config`, which is the very document the de-gating
// retires.
//
// The `match /teams/{teamId}` rules block enumerates its subcollections one by
// one and has no catch-all, so this path was denied to every client until the
// rule for it landed. It arrived in the SAME commit as the first writer — split,
// a studio's first save fails outright with a permission error.
export const TEAM_SETTINGS_SUBCOLLECTION = 'settings'

// Server-maintained counters for a team — `teams/{teamId}/counters/{name}`.
// A SUBCOLLECTION and not fields on the team document, because a team write
// rebuilds the whole public mirror (see utils/contactCounter.ts).
export const TEAM_COUNTERS_SUBCOLLECTION = 'counters'
export const TEAM_CONTACT_COUNTER_DOC = 'contacts'
/** teams/{teamId}/settings/documents — `TeamDocumentsSettings`. Readers must
 *  fall back to the retired `installed_plugins/documents.config` until every
 *  team is migrated; `resolveSignupDocumentIds` in types/team.ts is that read,
 *  written once so the client and the sync cannot disagree about it. */
export const DOCUMENTS_SETTINGS_DOC_ID = 'documents'

// Website plugin (studio site builder)
// site_drafts: PRIVATE working copy (manager+). site_published: PUBLIC snapshot
// (public read, written only by the publishWebsite Cloud Function). Both keyed by teamId.
export const SITE_DRAFTS_COLLECTION = 'site_drafts'
export const SITE_PUBLISHED_COLLECTION = 'site_published'
// Standalone embed widgets (decoupled from the published site). PUBLIC snapshot
// keyed by teamId; managers author it directly (no draft/publish split).
export const EMBED_WIDGETS_COLLECTION = 'embed_widgets'

// Per-locale machine-translation sidecars for the published sites, stored in
// the SAME collections as the site they translate:
//   site_published/{teamId}__i18n_{locale}
//   org_site_published/{orgId}__i18n_{locale}
// (SiteTranslationDoc in types/website.ts). Function-write only, like every
// other doc there. INVARIANT: no real team/org id contains this separator, so
// a sidecar id can never collide with a site doc — and sidecars carry NO `slug`
// field, so the public slug queries can never return one.
export const SITE_I18N_SEPARATOR = '__i18n_'
export const siteI18nDocId = (id: string, locale: string): string =>
  `${id}${SITE_I18N_SEPARATOR}${locale}`

// Organization website (org-level site builder). Mirrors the team site but keyed
// by orgId. org_site_drafts: PRIVATE working copy (org_admin). org_site_published:
// PUBLIC snapshot, written only by the publishOrgWebsite Cloud Function.
export const ORG_SITE_DRAFTS_COLLECTION = 'org_site_drafts'
export const ORG_SITE_PUBLISHED_COLLECTION = 'org_site_published'

// Stripe Connect (member → studio payments — studio's own Stripe balance).
// connect_accounts is TOP-LEVEL, keyed by the Stripe connected account id
// (acct_...), so the Connect webhook resolves event.account → teamId with a
// single direct doc get (no reverse query, no composite index). The per-payment
// and per-subscription records live under the owning team.
export const CONNECT_ACCOUNTS_COLLECTION = 'connect_accounts'
export const MEMBER_PAYMENTS_SUBCOLLECTION = 'member_payments'
export const MEMBER_SUBSCRIPTIONS_SUBCOLLECTION = 'member_subscriptions'

// In-app notifications for team managers/owners (e.g. org access requests).
// Written only by Cloud Functions (Admin SDK); clients read and mark-read.
export const NOTIFICATIONS_SUBCOLLECTION = 'notifications'

// BYO gateway ledger (Payrexx / Stripe-BYO). teams/{teamId}/payment_events/{id},
// doc id = `${gateway}:${gatewayRef}` for idempotency. Written only by the team
// webhook handlers + the updatePaymentRecord callable (Admin SDK); managers/owners
// read it for the payments dashboard and per-contact Payments tab. Unlike Connect,
// BYO records the payment even when no contact matches (assignment_status).
export const PAYMENT_EVENTS_SUBCOLLECTION = 'payment_events'

// Partner (aggregator) visit payout ledger — teams/{teamId}/partner_visits/{id},
// doc id = `${sessionId}_${contactId}`. One row per booking covered via a
// source:'aggregator' subscription type (FitPass, SportPass…); written by
// bookSession / cancelBooking (Admin SDK). Reporting only — see types/contact.ts.
export const PARTNER_VISITS_SUBCOLLECTION = 'partner_visits'
// Gift cards (E3): teams/{teamId}/gift_cards/{code} — the code is the doc id.
export const GIFT_CARDS_SUBCOLLECTION = 'gift_cards'
// Manager-mint claims: teams/{teamId}/gift_card_issues/{issueRef}. A create()
// on this doc is the serialisation point for issueGiftCard — whoever wins mints,
// everyone else reads the code back. Server-only: no firestore.rules block, and
// there is no `match /{document=**}` wildcard, so clients are denied by default.
export const GIFT_CARD_ISSUES_SUBCOLLECTION = 'gift_card_issues'
// Promo codes (Wave 3 P3): teams/{teamId}/promo_codes/{CODE} — the canonical
// uppercase code is the doc id, which is what makes "is this code taken?" a
// create() rather than a query-then-write race. Server-only: firestore.rules
// give managers/owners read and deny every client write (the doc carries
// usage_count, max_uses and internal labels), so every mutation is a callable.
export const PROMO_CODES_SUBCOLLECTION = 'promo_codes'
// Durable per-PERSON redemption ledger:
// teams/{teamId}/promo_codes/{CODE}/redemptions/{identityKey}. The doc id is
// promoIdentityKey(...) — a hash of the normalised email, NOT a contactId — so
// the per-person cap survives a contact document being purged and recreated,
// and the ids are not a harvestable list of a studio's customer emails.
export const PROMO_REDEMPTIONS_SUBCOLLECTION = 'redemptions'
// No-show policy fees (E5): teams/{teamId}/policy_fees/{feeId}.
export const POLICY_FEES_SUBCOLLECTION = 'policy_fees'

// Idempotency markers for the Connect webhook (doc id = Stripe event id).
// Admin-SDK only; clients never read or write it.
export const CONNECT_WEBHOOK_EVENTS_COLLECTION = 'connect_webhook_events'

// Finance journal — the normalized, immutable money-event log all financial
// reporting derives from (see types/finance.ts). Written ONLY by Cloud Functions
// (webhooks + recordManualPayment + the backfill script); managers/owners read.
// Doc id is deterministic (financeTxnId) for idempotency across retries/backfill.
export const FINANCE_TRANSACTIONS_SUBCOLLECTION = 'finance_transactions'
// Derived monthly rollups (doc id = 'YYYY-MM'), regenerated from the journal by
// the monthlyFinanceReports cron — always overwritten (journal is source of truth).
export const FINANCE_MONTHLY_REPORTS_SUBCOLLECTION = 'finance_monthly_reports'

// Double-entry accounting (finance plugin — see types/accounting.ts).
// accounts: doc id = account code, owner-editable (name/active), system rows
// locked. settings: singleton doc. entries + period summaries: function-written
// only (corrections are reversal entries, never edits).
export const ACCOUNTING_ACCOUNTS_SUBCOLLECTION = 'accounting_accounts'
export const ACCOUNTING_SETTINGS_SUBCOLLECTION = 'accounting_settings'
export const ACCOUNTING_SETTINGS_DOC = 'config'
export const ACCOUNTING_ENTRIES_SUBCOLLECTION = 'accounting_entries'
export const ACCOUNTING_PERIOD_SUMMARIES_SUBCOLLECTION = 'accounting_period_summaries'
// Entry templates: owner-managed presets for manual entries (+ optional
// recurring auto-post — see accounting/templates.ts).
export const ACCOUNTING_ENTRY_TEMPLATES_SUBCOLLECTION = 'accounting_entry_templates'
// Asset register (finance plugin — see types/asset.ts): the equipment list
// behind the statement of assets. Owner-written from the client; REGISTER-ONLY
// in cash mode — no ledger writer reads it until accrual mode lands.
export const ASSET_REGISTER_SUBCOLLECTION = 'asset_register'
