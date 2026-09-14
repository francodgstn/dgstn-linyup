import type { Contact } from '../types/contact'
import type { Session } from '../types/session'

// ─── The public API field catalog ────────────────────────────────────────────
//
// docs/public-api.md → "The read layer". Every key of every internal type the
// API reads is classified here, ONCE:
//
//   exposed   its value may leave Linyup through a projection
//   pii       its value may leave only with `contacts:read:pii`
//   excluded  its value never leaves, whatever the scope
//
// The catalogs are typed as a mapped type over the internal interface, so a
// field added to `Contact` or `Session` fails `turbo run typecheck` until
// somebody decides — here, in review — whether it may leave. That is the whole
// point: an allow-list nobody is forced to extend is an allow-list that goes
// stale in the permissive direction the day a projection starts spreading.
//
// A DERIVED answer may READ an excluded field. `lifecycle` reads `deleted_at`,
// the attention reasons read `alerts_count` and `lead_acknowledged`; what leaves
// is the answer (an enum), never the value. The catalog governs values.
//
// The consent screen renders these same lists, and `API_FIELD_CATALOG_VERSION`
// (types/api.ts) is bumped whenever a field moves towards `exposed`.

export type ApiFieldClass = 'exposed' | 'pii' | 'excluded'

export type FieldCatalog<T> = { readonly [K in keyof Required<T>]: ApiFieldClass }

export const CONTACT_FIELD_CATALOG: FieldCatalog<Contact> = {
  id: 'exposed',
  teamId: 'excluded', // implicit: the principal's team
  createdBy: 'excluded', // read for the coach's own-scope, never returned
  assigned_coach_ids: 'exposed',

  firstname: 'exposed',
  lastname: 'exposed',
  email: 'pii',
  phone: 'pii',
  login_emails: 'excluded', // each one is an access grant to the member's account
  gender: 'pii',
  birthdate: 'pii',
  birthplace: 'excluded',
  weight: 'excluded', // health data
  avatar_url: 'excluded',
  sms_opt_out: 'excluded',
  address: 'pii',
  emergency_contacts: 'excluded', // third parties' details
  consent: 'excluded', // deprecated, superseded by the waiver ledger

  acquisition_stage: 'exposed',
  acquisition_stage_updated_at: 'excluded',
  entry: 'exposed',
  trial_booked_at: 'exposed',
  trial_attended_at: 'exposed',
  converted_at: 'exposed',
  trial_used_at: 'excluded',
  pending_signup: 'exposed',
  signup_completed_at: 'excluded',
  provisional: 'exposed', // leaves as `lifecycle`
  provisional_expires_at: 'excluded',
  external: 'exposed', // leaves as `lifecycle`
  external_since: 'excluded',

  source: 'exposed',
  source_detail: 'excluded', // free text
  acquisition_partner_app: 'excluded', // a claim typed into a public form, not an entitlement
  lead_acknowledged: 'excluded',

  affiliation_summary: 'exposed', // `has_active` only

  // The legacy single plan slot. The API is a multi-plan-holdings reader and
  // reads `held_plans` alone (docs/multi-plan-holdings.md).
  subscription_type_id: 'excluded',
  subscription_type_name: 'excluded',
  subscription_recurrence: 'excluded',
  subscription_price_id: 'excluded',
  subscription_amount: 'excluded',
  subscription_type_updated_at: 'excluded',
  subscription_source_ref: 'excluded',
  subscription_expires_at: 'excluded',
  subscription_status: 'excluded',
  active_subscriptions: 'excluded',
  credit_summary: 'exposed',

  no_show_strikes: 'excluded',
  no_show_strike_refs: 'excluded',

  notes: 'excluded', // prose about the person

  current_month_score: 'excluded',
  current_streak: 'excluded',
  streak_last_qualified_week: 'excluded',
  max_streak: 'excluded',
  total_sessions: 'exposed',
  last_session_at: 'exposed',
  distinct_activities: 'excluded',
  times_leader: 'excluded',
  times_top5: 'excluded',
  custom_badges: 'excluded',

  pending_bookings_count: 'excluded',
  conversions_count: 'excluded',
  login_count: 'excluded',
  last_login_at: 'excluded',
  last_seen_at: 'excluded',
  mobile_app: 'excluded',

  alerts_count: 'excluded',
  notes_count: 'excluded',
  ai_summary: 'excluded', // prose about the person

  held_plans: 'exposed',
  held_plan_type_ids: 'excluded', // a query index over held_plans
  held_plans_next_change_at_ms: 'excluded',

  coaching_open_count: 'excluded',
  coaching_overdue_count: 'excluded',
  last_checkin_at: 'excluded',

  email_unsubscribed: 'excluded',
  tags: 'exposed',
  group_ids: 'exposed',
  ranks: 'excluded', // deferred: needs the ranking ladder to mean anything
  custom_fields: 'excluded', // plugin data regularly carries health information

  created_at: 'exposed',
  archived_at: 'exposed', // leaves as `lifecycle`
  deleted_at: 'excluded', // a deleted contact never leaves at all
  anonymized_at: 'excluded',
  deletion_requested_at: 'excluded',
  deletion_scheduled_for: 'excluded',
}

export const SESSION_FIELD_CATALOG: FieldCatalog<Session> = {
  id: 'exposed',
  teamId: 'excluded',
  activityId: 'exposed',
  activityName: 'exposed',
  activityType: 'exposed',
  start: 'exposed',
  end: 'exposed',
  duration_minutes: 'exposed',
  location: 'exposed',
  placeId: 'exposed',
  roomId: 'exposed',
  onlineUrl: 'excluded', // a meeting link works like a credential once it reaches an AI provider
  tags: 'exposed',
  participants_count: 'exposed',
  allowBooking: 'exposed',
  notes: 'excluded', // internal
  created_at: 'excluded',
  createdBy: 'excluded', // read for the coach's own-scope, never returned
  seriesId: 'exposed',
  isException: 'excluded',
  exceptionType: 'exposed', // leaves as `status`
  providerId: 'exposed',
  providerName: 'exposed',
  bookingMandatory: 'exposed',
  headline: 'exposed',
  headlinePublic: 'exposed',
  max_participants: 'exposed',
  bookings_count: 'exposed',
  waitlist_count: 'exposed',
  status: 'exposed',
  hold_expires_at: 'excluded',
  autoConfirm: 'excluded',
  templateId: 'excluded',
  trial_bookings_count: 'exposed',
  isFreeTrial: 'excluded', // legacy
  payment_pending: 'excluded',
  payment_intent_mode: 'excluded',
  payment_amount: 'excluded',
  payment_currency: 'excluded',
  payment_checkout_session_id: 'excluded',
  blocked_time: 'excluded', // blocked time is filtered out, never returned
  contact_id: 'excluded', // an appointment's client — through the bookings endpoint, under contacts scope
  client_name: 'excluded', // a denormalised copy that can outlive anonymisation
}

/** The fields of a catalog in one class, sorted — what the consent screen lists. */
export function catalogFieldsIn<T>(catalog: FieldCatalog<T>, fieldClass: ApiFieldClass): string[] {
  return Object.entries(catalog)
    .filter(([, c]) => c === fieldClass)
    .map(([k]) => k)
    .sort()
}
