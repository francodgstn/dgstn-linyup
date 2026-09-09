// Canonical registry of where a single TENANT's (team's) data lives in Firestore
// and Cloud Storage. This is the single source of truth consumed by per-team
// teardown (purgeTeam) and future per-tenant export/GDPR tooling, so a new
// tenant-scoped collection only ever has to be registered in ONE place.
//
// A completeness test (packages/functions/src/saas-billing/tenantData.test.ts)
// asserts that every top-level `*_COLLECTION` constant is consciously classified
// here as tenant, platform, or retired — so adding a new top-level collection
// without classifying it fails CI rather than silently leaking out of teardown.

import {
  TEAMS_COLLECTION,
  CONTACTS_COLLECTION,
  CONTACT_UPDATE_LINKS_COLLECTION,
  SESSIONS_COLLECTION,
  ACTIVITIES_COLLECTION,
  EVENTS_COLLECTION,
  CHECKINS_COLLECTION,
  SESSION_SERIES_COLLECTION,
  SESSION_SERIES_JOBS_COLLECTION,
  COURSES_COLLECTION,
  FORMS_COLLECTION,
  DOCUMENTS_COLLECTION,
  AVAILABILITY_COLLECTION,
  AVAILABILITY_EXCEPTIONS_COLLECTION,
  REFERRAL_CODES_COLLECTION,
  REFERRALS_COLLECTION,
  CONNECT_ACCOUNTS_COLLECTION,
  SAAS_SUBSCRIPTIONS_COLLECTION,
  SITE_DRAFTS_COLLECTION,
  SITE_PUBLISHED_COLLECTION,
  EMBED_WIDGETS_COLLECTION,
  MESSAGING_POLICIES_COLLECTION,
  FEEDBACK_COLLECTION,
  PUBLIC_DOMAINS_COLLECTION,
  // platform-wide / cross-tenant
  FEEDBACK_PROMPTS_COLLECTION,
  USERS_COLLECTION,
  APP_SETTINGS_COLLECTION,
  SIGNUP_ALLOWLIST_COLLECTION,
  SIGNUP_INVITES_COLLECTION,
  PLATFORM_METRICS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  MAIL_SUPPRESSIONS_COLLECTION,
  MAIL_SENDS_COLLECTION,
  PLATFORM_NOTICES_COLLECTION,
  SMS_SUPPRESSIONS_COLLECTION,
  PROJECTS_COLLECTION,
  CATEGORIES_COLLECTION,
  CONNECT_WEBHOOK_EVENTS_COLLECTION,
  COACH_SLOTS_COLLECTION,
  ORG_SITE_DRAFTS_COLLECTION,
  ORG_SITE_PUBLISHED_COLLECTION,
  STORE_PRESENCE_COLLECTION,
  STORE_REVIEWS_COLLECTION,
} from './paths'

/** How a top-level collection's documents are matched to a team. */
export type TenantMatch =
  | { by: 'field'; field: string } // top-level docs where <field> == teamId
  | { by: 'docId' } // a single doc whose id IS the teamId

export interface TenantCollection {
  collection: string
  match: TenantMatch
  /**
   * Provider-side state that deleting the Firestore doc does NOT remove and which
   * must be torn down separately (e.g. cancel/disconnect the Stripe Connect
   * account and its member subscriptions). Surfaced so teardown can warn/handle it.
   */
  externalTeardown?: 'stripe_connect' | 'cloudflare_hostname'
}

/**
 * The team document subtree: `teams/{teamId}` plus ALL of its subcollections
 * (team_members, installed_plugins, integrations, subscription_types, products,
 * member_payments, member_subscriptions, …). Removed wholesale by a recursive
 * delete, so its subcollections are intentionally NOT enumerated here.
 */
export const TENANT_TEAM_DOC_COLLECTION = TEAMS_COLLECTION

/** Cloud Storage path prefix holding all of a team's files. */
export function tenantStoragePrefix(teamId: string): string {
  return `${TEAMS_COLLECTION}/${teamId}/`
}

/**
 * Every TENANT-SCOPED top-level Firestore collection. Documents that match a
 * team are removed by per-team teardown; for `field` matches each matched doc is
 * recursively deleted so its own subcollections go too (e.g. contact goals,
 * session bookings, event attendees, course modules/lessons/purchases).
 *
 * NOTE: the `teams/{teamId}` subtree (TENANT_TEAM_DOC_COLLECTION) and the Storage
 * prefix (tenantStoragePrefix) are handled separately by the caller.
 */
export const TENANT_DATA_COLLECTIONS: TenantCollection[] = [
  { collection: CONTACTS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  // Live grants to edit a contact's details. Tenant data, and the one entry here
  // whose omission would be a SECURITY leftover rather than an orphaned row: a
  // purged team's outstanding QR would still resolve.
  { collection: CONTACT_UPDATE_LINKS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: SESSIONS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: ACTIVITIES_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: EVENTS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: CHECKINS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: SESSION_SERIES_COLLECTION, match: { by: 'field', field: 'teamId' } },
  // Progress records for background series teardown. Short-lived, but they carry
  // the teamId and outlive the run, so they go with the tenant.
  { collection: SESSION_SERIES_JOBS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: COURSES_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: FORMS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: DOCUMENTS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: AVAILABILITY_COLLECTION, match: { by: 'field', field: 'teamId' } },
  { collection: AVAILABILITY_EXCEPTIONS_COLLECTION, match: { by: 'field', field: 'teamId' } },
  // referrals key the team via `team_id`; referral_codes via `teamId`.
  { collection: REFERRALS_COLLECTION, match: { by: 'field', field: 'team_id' } },
  { collection: REFERRAL_CODES_COLLECTION, match: { by: 'field', field: 'teamId' } },
  // connect_accounts is keyed by the Stripe account id but carries a teamId field.
  // Deleting the doc does not cancel the Stripe account/subscriptions — see externalTeardown.
  {
    collection: CONNECT_ACCOUNTS_COLLECTION,
    match: { by: 'field', field: 'teamId' },
    externalTeardown: 'stripe_connect',
  },
  // SaaS rate-limit ledger (no paths.ts constant); keyed by a teamId field.
  { collection: 'saas_checkout_attempts', match: { by: 'field', field: 'teamId' } },
  // doc id IS the teamId
  { collection: SAAS_SUBSCRIPTIONS_COLLECTION, match: { by: 'docId' } },
  { collection: SITE_DRAFTS_COLLECTION, match: { by: 'docId' } },
  { collection: SITE_PUBLISHED_COLLECTION, match: { by: 'docId' } },
  { collection: EMBED_WIDGETS_COLLECTION, match: { by: 'docId' } },
  // Operator-set outbound-delivery policy; doc id = teamId (or orgId/'system',
  // which per-team teardown never touches).
  { collection: MESSAGING_POLICIES_COLLECTION, match: { by: 'docId' } },
  // In-app feedback submissions reference the submitting tenant (and carry the
  // submitter's email), so they go with the team. Screenshots live under the
  // PLATFORM `feedback/{uid}/` Storage prefix (keyed by user, not team) and are
  // not part of the team's storage teardown.
  { collection: FEEDBACK_COLLECTION, match: { by: 'field', field: 'team_id' } },
  // Custom public domains. Keyed by HOSTNAME, so matched on the tenant field it
  // carries rather than the doc id. It is tenant data and not platform data for
  // one reason: a claim that outlives its tenant locks that hostname forever —
  // nobody can re-add it, including the same studio signing up again.
  // Deleting the claim does NOT delete the Cloudflare custom hostname, which
  // keeps serving (and billing) until it is removed there too.
  {
    collection: PUBLIC_DOMAINS_COLLECTION,
    match: { by: 'field', field: 'entityId' },
    externalTeardown: 'cloudflare_hostname',
  },
]

/**
 * Top-level collections that are PLATFORM-WIDE / cross-tenant and must NEVER be
 * touched by a per-team teardown. Enumerated so the completeness test can assert
 * every top-level collection is consciously classified (tenant vs platform).
 *
 * `organizations` spans multiple teams, so deleting one is not a single-tenant op.
 * `connect_webhook_events` are global Stripe idempotency markers.
 */
export const PLATFORM_COLLECTIONS: string[] = [
  USERS_COLLECTION,
  // Ops-authored feedback prompt questions are global (pushed to all tenants).
  FEEDBACK_PROMPTS_COLLECTION,
  APP_SETTINGS_COLLECTION,
  SIGNUP_ALLOWLIST_COLLECTION,
  SIGNUP_INVITES_COLLECTION,
  PLATFORM_METRICS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  MAIL_SUPPRESSIONS_COLLECTION,
  MAIL_SENDS_COLLECTION,
  // Operator → Customer notices. PLATFORM, not tenant data, and the distinction
  // is the point: it is Linyup's record of ITS OWN communications, and purging a
  // studio must not erase the proof that the studio was notified. The recipients
  // subcollection holds addresses, but it is keyed by notice rather than by team,
  // so a per-team teardown has nothing to walk.
  PLATFORM_NOTICES_COLLECTION,
  // Phone-number opt-outs span tenants (a number opts out globally, like a
  // bounced email address) — never part of a per-team teardown.
  SMS_SUPPRESSIONS_COLLECTION,
  PROJECTS_COLLECTION,
  CATEGORIES_COLLECTION,
  CONNECT_WEBHOOK_EVENTS_COLLECTION,
  // Org-level website docs are keyed by orgId (not teamId), so per-TEAM teardown
  // never touches them — they belong with the org itself.
  ORG_SITE_DRAFTS_COLLECTION,
  ORG_SITE_PUBLISHED_COLLECTION,
  // What the App Store and Play say about LINYUP'S OWN member app. There is one
  // app for the whole platform, so these are as far from tenant data as a
  // collection gets — a per-team teardown has nothing to walk here, and the
  // reviews are written by the app's users about the product, not by or about
  // any one studio.
  STORE_PRESENCE_COLLECTION,
  STORE_REVIEWS_COLLECTION,
]

/**
 * Defined-but-retired top-level collections. `coach_slots` was removed —
 * appointment sessions now live in `sessions` (activityType === 'appointment'). Listed so the
 * completeness test stays green without misclassifying dead data as live.
 */
export const RETIRED_TOP_LEVEL_COLLECTIONS: string[] = [COACH_SLOTS_COLLECTION]
