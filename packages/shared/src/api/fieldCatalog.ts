import type { Activity } from '../types/activity'
import type { MemberSubscription } from '../types/connect'
import type { Contact, SubscriptionType } from '../types/contact'
import type { Event } from '../types/event'
import type { Booking, Session } from '../types/session'

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
  whatsapp_consent: 'excluded',
  whatsapp_marketing_consent: 'excluded',
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
  contact_id: 'excluded', // an appointment's client — through the roster, under contacts scope
  client_name: 'excluded', // a denormalised copy that can outlive anonymisation
}

export const ACTIVITY_FIELD_CATALOG: FieldCatalog<Activity> = {
  id: 'exposed',
  teamId: 'excluded',
  name: 'exposed',
  alternativeName: 'exposed',
  description: 'exposed',
  slug: 'exposed',
  color: 'exposed',
  tags: 'exposed',
  // The booking page's section heading — already world-readable on the public
  // mirror, and a caller listing offerings wants the same grouping the visitor
  // sees rather than inventing one.
  bookingGroup: 'exposed',
  type: 'exposed',
  providerId: 'exposed',
  providerName: 'exposed',
  durations: 'exposed', // through resolveAppointmentDurations / resolveDurationSale
  memberBenefit: 'excluded', // deferred: benefits leave through resolveDurationBenefit, not yet projected
  durationBenefits: 'excluded',
  autoConfirm: 'excluded',
  base_score: 'excluded',
  isFreeTrial: 'excluded', // legacy, read by resolveActivityAccessRule
  accessRule: 'exposed', // through resolveActivityAccessRule
  dropIn: 'exposed', // through resolveActivityDropIn, never raw
  trialEnabled: 'exposed',
  trialPriceAmount: 'exposed',
  waitlistEnabled: 'exposed',
  prerequisites: 'exposed',
  confirmationInstructions: 'excluded', // sent after booking; can hold door codes
  meetingPoint: 'exposed',
  whatsIncluded: 'exposed',
  whatsNotIncluded: 'exposed',
  faq: 'exposed',
  cancellationPolicy: 'exposed',
  bookingQuestions: 'excluded',
  contactFields: 'excluded',
  isActive: 'exposed',
  image_url: 'exposed',
  order: 'exposed', // leaves as list order
  created_at: 'excluded',
  createdBy: 'excluded',
  archived_at: 'exposed', // an archived activity is not returned
}

export const PLAN_FIELD_CATALOG: FieldCatalog<SubscriptionType> = {
  id: 'exposed',
  name: 'exposed',
  description: 'exposed',
  source: 'exposed', // leaves as own | partner
  active: 'exposed',
  public: 'exposed',
  order: 'exposed', // leaves as list order
  prices: 'exposed', // field by field; maxPurchasesPerContact stays in
  checkout_contact_mode: 'excluded',
  limits: 'exposed', // through resolveUsageLimit
  payoutPerVisit: 'excluded', // commercial terms with a partner app
  introOffers: 'exposed', // through introOffersOf
  introOffer: 'exposed', // legacy single offer, read by introOffersOf
}

export const BOOKING_FIELD_CATALOG: FieldCatalog<Booking> = {
  id: 'exposed',
  teamId: 'excluded',
  contact: 'exposed',
  session: 'exposed',
  // The denormalised identity copies survive anonymisation, which only wipes the
  // contact document — so a booking's person always comes from the CONTACT.
  email: 'excluded',
  firstname: 'excluded',
  lastname: 'excluded',
  phone: 'excluded',
  is_new_contact: 'exposed',
  joinedAt: 'exposed',
  booking_token: 'excluded', // a credential: it manages the booking
  booking_reference: 'excluded', // a desk lookup code
  source: 'exposed',
  question_answers: 'excluded', // "any injuries today?"
  status: 'exposed',
  rebooked_from: 'exposed',
  rebooked_to: 'exposed',
  payment_status: 'exposed', // leaves as `paid`, through bookingWasPaidFor
  payment_intent_id: 'excluded',
  settled_offline: 'excluded',
  expires_at: 'excluded',
  waitlist_claim: 'excluded',
  claim_expires_at: 'excluded',
  claimed_from_waitlist: 'exposed',
  waiver_state: 'exposed',
}

export const MEMBER_SUBSCRIPTION_FIELD_CATALOG: FieldCatalog<MemberSubscription> = {
  teamId: 'excluded',
  subscriptionId: 'exposed',
  customerId: 'excluded',
  contactId: 'exposed',
  priceId: 'excluded',
  subscriptionTypeId: 'exposed',
  subscriptionTypeName: 'exposed',
  recurrence: 'exposed',
  amount: 'exposed', // only with reports.view
  currency: 'exposed',
  application_fee_percent: 'excluded',
  status: 'exposed',
  current_period_start: 'exposed',
  current_period_end: 'exposed',
  cancel_at_period_end: 'exposed', // through subscriptionIsCancelling
  cancel_at: 'exposed', // through subscriptionEndsAt
  canceled_at: 'exposed',
  cancellation_details: 'exposed', // reason + feedback; the member's own words only under pii
  payment_method_kind: 'excluded',
  last_invoice_id: 'excluded',
  last_payment_status: 'exposed',
  last_event_id: 'excluded',
  duplicate: 'excluded', // a duplicate is not returned
  pause_collection: 'exposed', // leaves as `paused`
  created_at: 'exposed',
  updated_at: 'excluded',
}

export const EVENT_FIELD_CATALOG: FieldCatalog<Event> = {
  id: 'exposed',
  teamId: 'excluded',
  orgId: 'excluded',
  scope: 'excluded', // organisation events are out of v1
  title: 'exposed',
  type: 'exposed',
  start: 'exposed',
  end: 'exposed',
  location: 'exposed',
  placeId: 'exposed',
  roomId: 'exposed',
  description: 'exposed',
  fee: 'exposed',
  status: 'exposed',
  participants_count: 'exposed',
  completed_checkins_count: 'exposed',
  attendees_count: 'exposed',
  invitations_sent_count: 'excluded',
  last_invitation_sent_at: 'excluded',
  coachId: 'exposed',
  coachName: 'exposed',
  program: 'excluded', // deferred
  publicVisibility: 'exposed',
  created_at: 'excluded',
  createdBy: 'excluded',
  deleted_at: 'excluded', // a deleted event is not returned
}

/** The fields of a catalog in one class, sorted — what the consent screen lists. */
export function catalogFieldsIn<T>(catalog: FieldCatalog<T>, fieldClass: ApiFieldClass): string[] {
  return Object.entries(catalog)
    .filter(([, c]) => c === fieldClass)
    .map(([k]) => k)
    .sort()
}
