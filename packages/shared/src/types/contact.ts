import type { Timestamp } from './common'
import type { AffiliationSummary } from './affiliation'
import type { ContactFilter } from '../utils/contactFilter'

// ─── Acquisition axis (sticky, event-named funnel) ───────────────────────────
// Single ordered, OPEN vocab. The stage is a high-water milestone: it advances on
// transition and never flips backward. Reserved (design-for, don't build):
// upstream 'enquired'; downstream 'left' | 'won_back'.
//
// The funnel is OPTIONAL: it measures progress toward joining the training
// relationship (trial → join). A contact who entered off-funnel — bought in the shop
// or submitted a public form without ever booking/attending a trial — simply has NO
// acquisition_stage yet (see Contact.acquisition_stage). Absent = "not on the funnel",
// NOT a stage. Such a contact enters the funnel later, normally, if they book a trial.
export const ACQUISITION_STAGES = ['trial_booked', 'trial_attended', 'joined'] as const
export type AcquisitionStage = (typeof ACQUISITION_STAGES)[number]

// How the contact first ENTERED — immutable birth fact, set once by the entry event.
// Two kinds:
//  • FUNNEL doors — born on the trial funnel:
//      'booking'  → trial door, born 'trial_booked'
//      'walk_in'  → trial door, born already 'trial_attended'
//      'signup'   → direct join, born 'joined'
//      'import'   → migration, born 'joined'
//  • OFF-FUNNEL routes — enter the contact base with NO acquisition_stage (not on the
//    funnel; a purchase/lead-capture is not a funnel milestone):
//      'shop'     → self-created by a public shop purchase (product / course / membership)
//      'form'     → lead captured via a published Custom Form
//      'waitlist' → joined the queue for a full class. Off-funnel ON PURPOSE:
//                   joining a queue is not a trial booking, and stamping
//                   'trial_booked' on someone who may never get a seat would
//                   corrupt the funnel. The stage is stamped when they CLAIM.
//      'manual'   → created BY STAFF, not by the person (today: createStaffAppointment
//                   booking an appointment for a new client). Off-funnel because
//                   the trial funnel measures what a PROSPECT did, and a staff
//                   member typing a name is not an act of the prospect. Listed
//                   here because staffBooking has always written it: it was
//                   absent from this union, so the contact detail page rendered
//                   the raw key `Contacts.entry_manual` and the profile form's
//                   z.enum rejected its own stored value, blocking submit.
export const CONTACT_ENTRIES = ['booking', 'walk_in', 'signup', 'import', 'form', 'shop', 'waitlist', 'manual'] as const
export type ContactEntry = (typeof CONTACT_ENTRIES)[number]

// Source axis — marketing CHANNEL (attribution only), set once, never overwritten.
// NOTE: 'walk_in' is an ENTRY value, never a source, or the channel is lost.
export const CONTACT_SOURCES = ['website', 'referral', 'social', 'event', 'import', 'other'] as const
export type ContactSource = (typeof CONTACT_SOURCES)[number]

// Subscription axis — contact-level ROLLUP of the per-subscription Stripe status in
// teams/{teamId}/member_subscriptions. The ONLY axis that pauses: a summer-break or
// injury freeze suspends BILLING (→ 'paused'), not belonging. Webhook-maintained.
// Distinct from the acquisition 'trial_*' stages — 'trialing' here is a Stripe free
// period, never a trial class.
export const SUBSCRIPTION_ROLLUP_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'paused',
  'cancelled',
  'none',
] as const
export type SubscriptionRollupStatus = (typeof SUBSCRIPTION_ROLLUP_STATUSES)[number]

// One entry of Contact.active_subscriptions — a compact snapshot of a LIVE Stripe
// member subscription, deduped by type. Maintained by onMemberSubscriptionWrite.
export interface ActiveSubscriptionSummary {
  subscription_type_id: string
  subscription_type_name: string | null
  recurrence: string | null
  amount: number // major units (CHF), per period
  status: SubscriptionRollupStatus
  /**
   * Epoch MILLISECONDS at which this subscription stops, when it is winding down
   * (cancelled but still live) — otherwise absent. Computed by
   * onMemberSubscriptionWrite via `subscriptionEndsAtMs`, the epoch-ms form of
   * `subscriptionEndsAt`, so the member's Space and the studio's contact detail
   * answer "when does this end" the same way.
   *
   * A plain number rather than a Timestamp on purpose: this is a denormalised
   * display mirror living inside an array, and the trigger compares the whole
   * array by JSON equality to stay idempotent.
   */
  cancels_at_ms?: number | null
  /**
   * WHETHER this subscription is winding down, asked apart from WHEN — via the
   * shared `subscriptionIsCancelling`.
   *
   * `cancels_at_ms` alone could not carry the answer. A pre-migration
   * member_subscriptions doc holds the cancellation boolean and NO dates (the
   * period had moved onto the subscription item and the writer stored null), so
   * its summary gets `cancels_at_ms: null` and a member's Space showed them
   * nothing at all about a membership they had cancelled. Same population gap
   * the operator console and the studio's contact detail both had to close.
   */
  cancelling?: boolean
}

export type ContactGender = 'M' | 'F' | 'other'

export interface ContactAddress {
  route?: string
  street_number?: string
  postal_code?: string
  locality?: string
}

export interface EmergencyContact {
  name: string
  phone?: string
  email?: string
}

// Max passwordless-login allow-list emails per contact (on top of the primary
// `email`). Shared by the admin editor + the login callable.
export const MAX_CONTACT_LOGIN_EMAILS = 5

/**
 * Telemetry the mobile (Expo) app writes to ITS OWN contact document on
 * foreground — app + OTA runtime versions, so a studio/operator can tell what
 * a contact is actually running without a support round-trip. Written by
 * nobody else; read by nobody yet (a future support/diagnostics surface).
 *
 * Self-writable under `firestore.rules`' contact self-update arm, alongside
 * `weight`/`last_seen_at` — see that rule for the exact field list this must
 * stay in sync with.
 */
export interface MobileAppTelemetry {
  /** App version (e.g. from `expo-application`). */
  version?: string
  /** Expo Updates runtime version. */
  ota_runtime_version?: string | null
  /** Expo Updates release channel. */
  ota_channel?: string | null
  /** True when running the build's embedded update (no OTA has applied yet). */
  ota_is_embedded?: boolean | null
  /** The applied Expo Updates update id, when not embedded. */
  ota_update_id?: string | null
}

export interface Contact {
  id: string
  teamId: string
  createdBy?: string
  // Assigned coaches (team_member uids) — the staff who coach this contact. A contact
  // may have several. Backs the Coach role's own-data scope: a coach-role member may
  // see/manage only contacts they are assigned to (or created). Empty/absent =
  // unassigned. Owner/manager may also appear here (they can be coaches), but stay
  // all-scoped regardless — for them it's a relationship record, not a restriction.
  assigned_coach_ids?: string[]

  // Identity
  firstname: string
  lastname: string
  email?: string
  phone?: string
  // Passwordless-login allow-list: extra emails permitted to sign in AS this
  // contact via the OTP flow (on top of `email`), e.g. a parent logging in to
  // their child's profile. Normalized lowercase, deduped, capped at 5. Each entry
  // is a deliberate access grant — anyone who controls one of these inboxes can
  // authenticate as this contact. See loginContactWithCode / buildContactSession.
  login_emails?: string[]
  gender?: ContactGender
  birthdate?: Timestamp
  birthplace?: string
  weight?: number
  avatar_url?: string
  // Contact asked not to receive SMS (reminders etc.). Email is unaffected.
  // Checked by the SMS service before every send; a global per-number opt-out
  // additionally lives in sms_suppressions.
  sms_opt_out?: boolean

  // Address
  address?: ContactAddress

  // Emergency contacts (max 2)
  emergency_contacts?: EmergencyContact[]

  /**
   * @deprecated Superseded by the acceptance ledger
   * (`documents/{documentId}/acceptances/*` + `signers/{contactId}`). Read
   * NOTHING from this field.
   *
   * Declared here for the first time in order to mark it. It was written by
   * `completeSignup` and existed on no type, was read by no code and rendered on
   * no screen; the only client that filled it sent `version: ''` for every
   * document, so it recorded that a checkbox was ticked and not what was ticked.
   * `completeSignup` now writes real events against real immutable version
   * snapshots (`waivers/signup.ts`) and keeps writing this blob for one release
   * so nothing breaks mid-deploy.
   *
   * Two proofs of acceptance with different evidential weight and no marker
   * saying which is which is the state to avoid — hence the marker. Removal is a
   * follow-up once no reader remains.
   */
  consent?: {
    privacyAcceptedAt?: Timestamp
    documents?: Array<{ slug: string; kind: string | null; version: string | null }>
  }

  // ─── Acquisition axis ──────────────────────────────────────────────────────
  // Sticky high-water funnel position (trial_booked → trial_attended → joined).
  // Advances on transition, never regresses. Per-session attendance is a fact on
  // the booking, not here — the booking event PROMOTES the milestone.
  // OPTIONAL: absent = the contact is NOT on the trial funnel. An off-funnel entry
  // ('shop' / 'form' — a buyer or a captured lead) has no stage until it first books
  // a trial, at which point it enters the funnel normally. Never synthesise a stage
  // for these; "not applicable" is the honest value (don't assert a milestone that
  // didn't happen). The purchase itself is never a stage — a recurring purchase lives
  // on the subscription axis, a one-off on order/payment history.
  acquisition_stage?: AcquisitionStage
  acquisition_stage_updated_at?: Timestamp
  // Immutable birth fact: which door the contact came through; sets the birth stage.
  // Correctable for data-entry mistakes, but never silently moves the stage.
  entry?: ContactEntry
  // Milestone timestamps — set when the stage first reaches them; editable in the
  // contact profile (e.g. backdating an imported member who joined long ago).
  // trial_booked_at is an optional override; the UI falls back to created_at.
  trial_booked_at?: Timestamp
  trial_attended_at?: Timestamp
  converted_at?: Timestamp
  // Stamped when the contact COMPLETES a trial booking (free OR paid) — the
  // one-trial-per-person enforcement for the trial door (bookSession's free path
  // and createDropInCheckout's paid-trial checkout, see Activity.trialPriceAmount).
  // Absent ⇒ this email hasn't used a trial yet. Never cleared.
  trial_used_at?: Timestamp
  // "Paid at checkout but hasn't finished signup yet" — set true only on a contact
  // created by a 'full'-mode shop purchase (consent + the studio's required fields
  // still owed). Cleared, with signup_completed_at stamped, when the buyer finishes
  // the signup-finalize flow. Absent ⇒ not pending (a minimal/back-office contact is
  // considered complete). See CheckoutContactMode.
  pending_signup?: boolean
  signup_completed_at?: Timestamp | null
  // PROVISIONAL = a lead that does NOT count toward the plan's contact cap yet.
  // Carried by every entrant that hasn't materialized: shop registrations awaiting
  // their first payment, trial bookings never attended, and public-form leads. All
  // live under the contacts page's "Leads" tab. MATERIALIZATION clears both fields:
  // a successful payment (Connect webhook), first attendance (booked→attended
  // promotion), stage promotion to attended/joined, full signup completion, a
  // manual subscription assignment, or the studio's manual Confirm.
  // provisional_expires_at is set ONLY for shop registrations (anti-flooding): the
  // daily purge task hard-deletes those once it passes unpaid. Leads without an
  // expiry are never purged — stale trial bookings are archived by the opt-out
  // 'lib_trial_cleanup' automation instead. Absent ⇒ a normal, counted contact.
  provisional?: boolean
  provisional_expires_at?: Timestamp | null

  // ─── Source axis ───────────────────────────────────────────────────────────
  // Marketing channel + free-form detail. Set once at creation, never overwritten.
  source?: ContactSource
  source_detail?: string
  // Which PARTNER APP the person said they come through, when the book form
  // asked (BookingSettings.showFitnessAppField). The value is one of the
  // studio's own partner-app NAMES as the public form offered them
  // (TeamPublicProfile.partner_apps, derived from its active
  // `source: 'aggregator'` subscription types) — the server narrows the
  // anonymous payload to that same list before storing it, so an arbitrary
  // string can never land here.
  //
  // A CLAIM, NOT AN ENTITLEMENT. It is what somebody typed into a public form;
  // it proves nothing about a FitPass membership and must never be read as
  // coverage. Access and payout are answered by the contact's actual
  // subscription (Contact.subscription_type_id / active_subscriptions) and the
  // partner_visits ledger — never by this field.
  //
  // Absent ⇒ never asked, or answered "not using one". An empty answer never
  // clears a stored value (see booking/contactFields.ts).
  acquisition_partner_app?: string | null
  // "New contact seen" UX flag (replaces the old acquisition.acknowledged).
  lead_acknowledged?: boolean

  // ─── Affiliation axis (belonging) ──────────────────────────────────────────
  // Affiliations themselves live in the contacts/{id}/affiliations subcollection
  // (a contact may hold several). This denormalized rollup is what the contacts
  // list + Firestore rules read; maintained by the onAffiliationWrite trigger.
  affiliation_summary?: AffiliationSummary

  // Subscription — the single fields below are the "primary / most-recent" snapshot
  // (manual assignment, or the latest Stripe purchase). A contact may hold SEVERAL
  // different active subscription types at once (never two of the same) — the full set
  // lives in active_subscriptions, maintained by onMemberSubscriptionWrite from the
  // member_subscriptions docs. Read active_subscriptions for display; the single fields
  // remain for back-compat (filters, manual assignment).
  subscription_type_id?: string
  subscription_type_name?: string
  subscription_recurrence?: string // authoritative; derived from the chosen price when one exists
  subscription_price_id?: string // set only when the chosen type has prices
  subscription_amount?: number // amount snapshot at assignment time
  subscription_type_updated_at?: Timestamp
  // PROVENANCE: the payment doc id that wrote the fields above, or null when no
  // single payment owns them (a recurring Stripe renewal). Written on EVERY
  // subscription-field write by writeContactSubscriptionFields — null included,
  // never omitted — and read by exactly one thing: reversePaymentEffects, which
  // clears the fields only when this matches the payment being reversed.
  // Matching on subscription_type_id instead would strip a renewal of the same
  // plan when an older payment for it is refunded.
  subscription_source_ref?: string | null
  // When the fields above stop covering the member, or null/absent for "no end
  // of its own". Set ONLY by a one_time price carrying `included_months` — the
  // "CHF 100, 2 months included" shape, which has no renewal to end it.
  //
  // ENFORCED LAZILY, BY COMPARISON, NEVER BY A JOB: `planGrantIsCurrent`
  // (types/activity.ts) is the ONE predicate, and every reader that decides
  // coverage calls it. There is no sweep to clear this field and no event when
  // it passes — which is exactly why nothing may treat the field's PRESENCE as
  // the fact. The fact is the comparison.
  //
  // The consequence worth knowing: artifacts built from write EVENTS (the
  // subscription-history row, the analytics rollups) do not close themselves
  // when a grant lapses, because no write happens. The studio-facing answer is
  // the `subscription_expires_in` automation condition, which reads this field
  // on a scan rather than waiting for an event.
  subscription_expires_at?: Timestamp | null
  // Contact-level rollup of member_subscriptions Stripe status (webhook-maintained).
  // 'none' when the contact holds no live subscription. See SubscriptionRollupStatus.
  subscription_status?: SubscriptionRollupStatus
  // All LIVE Stripe subscriptions the contact holds, deduped by type (webhook-maintained
  // by onMemberSubscriptionWrite). Empty/absent when none. Drives the multi-subscription
  // chips on the contacts list + detail.
  active_subscriptions?: ActiveSubscriptionSummary[]
  // Lesson-credit balances by subscription type (denormalised from the
  // credit_grants subcollection by onCreditGrantWrite). Only non-exhausted,
  // non-expired grants contribute. Empty/absent when the contact holds none.
  credit_summary?: CreditSummaryEntry[]

  // ─── No-show policy (E5) ────────────────────────────────────────────────────
  // Rolling strike counter toward the team's noShowPolicy.threshold (see
  // resolveNoShowPolicy, types/policy.ts). Incremented on every 'booking_no_show'
  // transition (onBookingWrite → processNoShowStrike); reset to 0 (and refs
  // cleared) the moment a fee is created. Absent ⇒ 0.
  no_show_strikes?: number
  // The strike bookings ('sessionId/bookingId') accumulated since the last fee
  // (or ever, if none yet) — capped ~10, most-recent-last. Copied onto the fee's
  // strike_booking_refs when the threshold is reached, then cleared.
  no_show_strike_refs?: string[]

  // Notes (plain text; rich-text JSON stored as string in hmd-lineup)
  notes?: string

  // Gamification
  current_month_score?: number
  current_streak?: number
  streak_last_qualified_week?: string
  max_streak?: number
  total_sessions?: number
  last_session_at?: Timestamp
  distinct_activities?: string[]
  times_leader?: number
  times_top5?: number
  custom_badges?: string[]

  // Booking / bio-link counters (managed by Cloud Functions)
  pending_bookings_count?: number
  conversions_count?: number

  // Bio-link login tracking
  login_count?: number
  last_login_at?: Timestamp

  // Activity tracking
  last_seen_at?: Timestamp

  // Mobile app telemetry — see MobileAppTelemetry's doc comment. Self-writable,
  // same rules arm as last_seen_at above.
  mobile_app?: MobileAppTelemetry

  // Alerts (denormalized count)
  alerts_count?: number

  // Notes (denormalized count), written ONLY by the `trackContactNotes` trigger.
  //
  // Notes live in a SUBCOLLECTION, and `matchesFilter` is a pure predicate over
  // this document — so "has notes" is answerable only if the answer is already
  // here. Same shape and same reasoning as `alerts_count` one field up.
  notes_count?: number

  // Coaching (denormalized by the onGoalWrite / check-in triggers).
  //
  // These exist so `contactAttentionReasons` can name a coaching reason without
  // breaking its own rule: every reason reads a fact ALREADY on the contact
  // document, no extra read and no fan-out. Without them, "has an overdue goal"
  // would be one subcollection query per row of the contacts list.
  coaching_open_count?: number
  coaching_overdue_count?: number
  last_checkin_at?: Timestamp

  // Marketing opt-out. Honoured by the automation engine and by outreach sends;
  // DISTINCT from the ESP suppression list (mail_suppressions), which records
  // bounces/blocks/spam reports and is applied inside the mail service.
  // Transactional mail (bookings, codes, receipts) is unaffected.
  email_unsubscribed?: boolean

  // Tags — free-form labels attached by automations or manually
  tags?: string[]

  // Contact Groups plugin — IDs of teams/{teamId}/contact_groups docs
  group_ids?: string[]

  // Ranking — keyed by RankingSystem.id (e.g. { "hmd": 5, "internal": 2 })
  ranks?: Record<string, number>

  // Custom Fields plugin — keyed by CustomFieldDefinition.id. Dates are stored
  // as ISO 'YYYY-MM-DD' strings to keep the map JSON-flat.
  custom_fields?: Record<string, string | number | boolean>

  // Lifecycle
  created_at?: Timestamp
  archived_at?: Timestamp | null
  deleted_at?: Timestamp | null
  anonymized_at?: Timestamp | null

  /**
   * SELF-SERVICE DELETION, requested by the contact from the mobile app.
   *
   * Nothing is destroyed when these are set — the account keeps working for the
   * whole window and the contact can cancel by signing in. A `dailyTasks` sweep
   * anonymises once `deletion_scheduled_for` passes. See
   * `utils/contactDeletion.ts` for the state machine and for why this
   * anonymises rather than erases.
   */
  deletion_requested_at?: Timestamp | null
  deletion_scheduled_for?: Timestamp | null
}

// ─── contact group (teams/{teamId}/contact_groups) ───────────────────────────
// Contact Groups plugin — nested member groups à la association management
// tools. Nesting via parent_id; membership lives on Contact.group_ids.

export interface ContactGroup {
  id: string
  name: string
  parent_id: string | null
  color?: string
  description?: string
  // DYNAMIC group: membership is derived from this filter, evaluated lazily
  // wherever it's needed, and NEVER materialized into Contact.group_ids.
  // Absent ⇒ a manual group (membership is the stored group_ids array).
  // The two sources are disjoint by design: a group is manual OR dynamic, which
  // is what makes every mixed-mode question ("can I pin a manual member into a
  // dynamic group?") unaskable rather than merely undefined.
  rule?: ContactFilter
  created_at?: Timestamp
  created_by?: string
  updated_at?: Timestamp
}

// ─── subscription type (team configuration) ───────────────────────────────────

export type SubscriptionRecurrence =
  | 'per_class'
  | 'one_time' // a single charge (e.g. intro package); grants `included_months` of membership
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'

// Recurrences billed as a Stripe subscription (vs one-off charges: per_class, one_time).
export const RECURRING_RECURRENCES: SubscriptionRecurrence[] = [
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annual',
]

export function isRecurringRecurrence(r: SubscriptionRecurrence): boolean {
  return RECURRING_RECURRENCES.includes(r)
}

// Maps a recurring recurrence to a Stripe interval + count. Returns null for the
// one-off recurrences (per_class, one_time), which are charged as single payments.
export function recurrenceToStripeInterval(
  r: SubscriptionRecurrence
): { interval: 'week' | 'month' | 'year'; interval_count: number } | null {
  switch (r) {
    case 'weekly':
      return { interval: 'week', interval_count: 1 }
    case 'biweekly':
      return { interval: 'week', interval_count: 2 }
    case 'monthly':
      return { interval: 'month', interval_count: 1 }
    case 'quarterly':
      return { interval: 'month', interval_count: 3 }
    case 'annual':
      return { interval: 'year', interval_count: 1 }
    default:
      return null // per_class, one_time
  }
}

// A single price option on a subscription type (Stripe-like: product → prices).
// Amount is in the team's default currency (Team.default_currency).
export interface SubscriptionPrice {
  id: string // client-generated; stable across edits
  amount: number // in the team default currency, e.g. 49.9
  recurrence: SubscriptionRecurrence
  // For one_time prices: months of access granted by the ONE charge — "CHF 100,
  // 2 months included". Sets `Contact.subscription_expires_at` = now + N months,
  // which is what ENDS the access (there is no renewal to end it, and no cron:
  // every reader compares the stamp lazily — see `subscriptionGrantIsCurrent`).
  // On a credit price, this is instead the pack's VALIDITY window (grant expiry).
  included_months?: number
  // Credit pack (one_time only): the purchase grants this many lesson credits,
  // decremented by bookSession on credit-gated activities. Materialized as a
  // CreditGrant under contacts/{id}/credit_grants by the Connect webhook /
  // grantCredits callable. Absent ⇒ a plain time-based price.
  credits?: number
  // How many times ONE contact may buy this price — "the 2-month intro is a
  // once-per-person offer". Absent = unlimited, which stays the default for
  // every price that does not say otherwise.
  //
  // It is authored per PRICE, not per plan, because that is the grain the studio
  // means: a plan may sell a monthly recurring price (you subscribe to it, you
  // do not buy it repeatedly) beside a one-off intro price that must not be
  // bought twice. The editor therefore offers it on one_time prices only, and a
  // recurring price is never counted — a re-subscription is governed by the
  // already-holds-this-type refusal in `createMembershipCheckout` instead.
  //
  // Counted from the `plan_purchases` ledger (doc id = the payment ref, so a
  // retried webhook cannot inflate it) and ENFORCED on the self-service rail
  // only. Manager rails record a purchase but are never refused by it — a studio
  // selling the same offer again is exercising judgement, not making a mistake.
  maxPurchasesPerContact?: number
  label?: string // optional, e.g. "Intro offer"
  active?: boolean // default true; inactive prices are hidden from the table + assignment
}

// ─── plan purchases (contacts/{contactId}/plan_purchases/{paymentRef}) ────────
// One row per COMPLETED purchase of a subscription price by this contact. It
// exists to answer exactly one question — "how many times has she bought this
// price?" — for `SubscriptionPrice.maxPurchasesPerContact`.
//
// THE DOC ID IS THE PAYMENT REF, and that is the whole idempotency story: the
// Connect webhook can deliver the same purchase through more than one event, and
// a `create()` on a ref that already exists is a no-op rather than a second row.
// Never key this by contact+price (that cannot express two legitimate purchases)
// and never count it with an incrementing field (see the ONE-writer rule in
// CLAUDE.md — this collection has no counter to contend over).
export interface PlanPurchase {
  id: string // = the payment ref that produced it
  teamId: string
  subscription_type_id: string
  price_id: string
  /** Major units, as charged — descriptive; nothing decides on it. */
  amount?: number | null
  /** Which rail recorded it: 'stripe_connect' | 'manual' | 'payrexx' | … */
  source: string
  created_at?: Timestamp
}

// ─── lesson credits (contacts/{id}/credit_grants) ─────────────────────────────
// One doc per pack purchase (or manual grant). Balances live here — auditable,
// per-purchase expiry, FIFO consumption; the denormalised rollup a UI reads
// cheaply is Contact.credit_summary (maintained by the onCreditGrantWrite sync).
// Stripe-purchased grants use the paymentIntentId as doc id (duplicate-webhook
// safe); manual/seed grants use generated ids.

export type CreditGrantSource = 'stripe' | 'manual' | 'seed'

export interface CreditGrant {
  id: string
  teamId: string
  subscription_type_id: string
  subscription_type_name?: string | null
  price_id?: string | null
  // A reversal REDUCES credits_total to credits_used (absolute, never a
  // decrement, never a delete) — so "no credits left" is expressed in the two
  // numbers every reader already subtracts, and no reader needs a new filter.
  credits_total: number
  credits_used: number // 0..credits_total; only ever changed by Cloud Functions
  expires_at?: Timestamp | null // null = no expiry
  source: CreditGrantSource
  payment_intent_id?: string | null
  // The payment doc id that produced this grant. Same value as the DOC ID —
  // which is what a reversal keys off, because the field name differed by rail
  // until Step 0 of the reversal work made every writer stamp both.
  payment_ref?: string | null
  created_at?: Timestamp
  created_by?: string | null
  // ─── reversal audit (written by reversePaymentEffects) ────────────────────
  // Descriptive only. NOTHING reads these for a decision — remaining credits are
  // credits_total - credits_used and nothing else.
  reversed_at?: Timestamp | null
  reversed_by_payment_ref?: string | null
  /** Cumulative credits taken back by reversals of this grant. */
  credits_revoked?: number
}

// Denormalised per-type balance on the contact doc (what lists, the access gate
// and the Space read without querying the subcollection).
export interface CreditSummaryEntry {
  subscription_type_id: string
  subscription_type_name?: string | null
  remaining: number
  next_expires_at?: Timestamp | null
}

// How the public shop captures a contact when this subscription is bought:
//   'off'     — no contact created at checkout (the studio links the payment later)
//   'minimal' — collect first/last name + email and create a member contact (default)
//   'full'    — collect first/last name + email, then redirect the buyer to the signup
//               page to finish their profile + consent (contact is 'pending signup')
export type CheckoutContactMode = 'off' | 'minimal' | 'full'
export const CHECKOUT_CONTACT_MODES: CheckoutContactMode[] = ['off', 'minimal', 'full']

// ─── usage limits ("up to 3 classes per week") ────────────────────────────────
// A LIMITED subscription still grants unmetered (non-credit) access, but only
// `count` bookings per window; the window is a calendar day / ISO week / month
// in the TEAM's timezone (Europe/Zurich today — see usageWindowKey). Consumption
// is counted per contact in contacts/{id}/usage_windows/{typeId}_{windowKey}
// docs, incremented transactionally by bookSession and decremented on
// cancellation. Absent `limits` = unlimited (all pre-existing types).
// 'billing_cycle' resets are a known follow-up (needs the member_subscriptions
// current-period), deliberately not in v1.

export type UsageLimitPeriod = 'day' | 'week' | 'month'

export interface SubscriptionUsageLimit {
  count: number
  per: UsageLimitPeriod
}

// ─── intro offer ("first 3 months at CHF 1, then the full price") ─────────────
// ONE offer PER PRICE — a plan that sells a monthly and an annual price can put
// a different opener on each, which is the shape studios actually price in
// ("first 3 months at 29, or your first year at 490"). The plan-level singular
// (`introOffer`) came first and is still read: `introOffersOf` normalises the
// two, so no stored document needs rewriting and no reader needs to know which
// shape it is looking at.
//
// It is a property of the CHECKOUT, never of the price's own amount. It is NOT
// an arm of resolvePaymentOptions:
// that resolver returns ONE amount, and an intro offer is a SCHEDULE (an amount
// AND how many periods it survives). The single-amount contract is exactly why
// memberships were left out of the promo rails, and expressing this as a lower
// `unit_amount` would make the reduced figure the RECURRING price — the member
// would pay it forever. It is applied as a Stripe Coupon on the connected
// account so the price returns to full on its own.
//
// Expressibility is constrained by Stripe: `duration: 'repeating'` is measured
// in `duration_in_months` and nothing else, so "the first N periods" of a
// WEEKLY plan cannot be stated. See shared/utils/introOffer.ts — the ONE
// validator, shared by the editor, the public mirror, the pricing card and the
// checkout callables.

export interface SubscriptionIntroOffer {
  /** Which of this type's own RECURRING prices the offer applies to. */
  priceId: string
  /** How many billing PERIODS of that price are discounted. 1 … INTRO_OFFER_MAX_PERIODS. */
  periods: number
  /** What the member pays PER PERIOD while it runs, MAJOR units. 0 = free. */
  amount: number
}

export interface SubscriptionType {
  id: string
  name: string
  description?: string
  // 'aggregator' is displayed as "PARTNER", and the wider word is the accurate
  // one: the type means a third party owns the money relationship with the
  // member — a fitness app (ClassPass, Urban Sports Club), a gym the club
  // teaches inside, an employer, an insurer. The studio charges the member
  // nothing in every one of those cases, which is the whole behaviour.
  //
  // THERE IS NO THIRD SOURCE, deliberately. Ask what a reader would do
  // differently for a host gym than for a fitness app: nothing. Every consumer
  // does the same four things — keep it out of the shop, keep it out of own
  // revenue, write a `partner_visits` row on a covered booking, offer its name
  // in the public "which partner did you come through?" question. What varies
  // between partners is SETTLEMENT, and that is already a per-plan setting
  // (`payoutPerVisit`, optional) rather than a kind.
  //
  // The stored value stays 'aggregator' — a stable machine identifier, renamed
  // in display only, the same way `club`→`studio` and `members`→`registered`
  // were (see CLAUDE.md). The ledger has always called it partner.
  source?: 'internal' | 'aggregator'
  active?: boolean
  public?: boolean // show on the bio-link / website pricing table (default off)
  // Display order (lower = first), respected by the manager list, the website
  // pricing table, and any other place that lists subscription types. Absent
  // values sort last (by name) until the studio reorders.
  order?: number
  prices?: SubscriptionPrice[] // optional; absent = the simple "just a container" flow
  // Public-shop contact capture for this type (absent ⇒ 'minimal').
  checkout_contact_mode?: CheckoutContactMode
  // Usage limits — v1 supports a single entry (the editor enforces that); the
  // array leaves room for per-subset caps later. Absent = unlimited.
  limits?: SubscriptionUsageLimit[]
  // PARTNER types only (source: 'aggregator'): what the partner pays the studio
  // per attended visit (major units, team currency). Drives the partner_visits
  // payout ledger — see Phase E1 of the pricing initiative.
  //
  // ONE DIRECTION: what the partner pays US. Absent is a real answer and a
  // common one — a club teaching inside a gym may settle by rent or a flat fee,
  // and then the visit rows carry `amount: null` and stand as the attendance
  // record that settlement is reconciled against. An arrangement running the
  // OTHER way (the studio paying the partner a share) is a cost and belongs in
  // the finance plugin as an expense; never express it as a negative here, or
  // every reader of the payout ledger has to ask which way this one meant.
  payoutPerVisit?: number
  // Intro offers, at most one per recurring price of this plan. Never trusted as
  // written: every reader resolves through `resolveIntroOffer`
  // (shared/utils/introOffer.ts), which returns null for anything Stripe cannot
  // express — so an unsellable offer is invisible on the card AND unapplied at
  // checkout, rather than promised in one place and charged in another.
  introOffers?: SubscriptionIntroOffer[]
  // LEGACY: the single plan-level offer, written before an offer could be put on
  // each price. Still read (via `introOffersOf`) and still written by the editor
  // as a deletion when it migrates a document forward. Never read it directly —
  // a document may carry either shape.
  introOffer?: SubscriptionIntroOffer | null
}

// ─── partner (aggregator) visit payout ledger ─────────────────────────────────
// One row per booking covered via a source:'aggregator' subscription type
// (FitPass, SportPass…), written by bookSession / cancelBooking (Admin SDK)
// at teams/{teamId}/partner_visits/{sessionId_contactId}. Reporting only — the
// money settles between studio and partner off-platform.
export interface PartnerVisit {
  teamId: string
  contactId: string
  sessionId: string
  subscription_type_id: string
  subscription_type_name: string | null
  amount: number | null // major units, team currency; null = rate not configured
  session_start: { toDate(): Date } | null
  activity_name: string | null
  status: 'booked' | 'cancelled'
  created_at: { toDate(): Date }
  cancelled_at?: { toDate(): Date }
}

/** The v1 usage limit of a type (first entry), or null = unlimited. */
export function resolveUsageLimit(t: Pick<SubscriptionType, 'limits'>): SubscriptionUsageLimit | null {
  const l = t.limits?.[0]
  return l && typeof l.count === 'number' && l.count > 0 ? l : null
}

/** Stable sort for subscription types: explicit `order` first (asc), then name. */
export function compareSubscriptionTypes(a: SubscriptionType, b: SubscriptionType): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  return (a.name ?? '').localeCompare(b.name ?? '')
}

// ─── subscription history (contacts/{id}/subscription_history) ────────────────
//
// The ONLY store of a contact's plan PERIODS (`[start_date, end_date)`),
// maintained SOLELY by `onContactSubscriptionChange`
// (`packages/functions/src/sync/`) — Firestore rules deny client `create`/
// `update` (a team member may still `delete` a row; see `firestore.rules`).
//
// ABSENT `end_date` MEANS OPEN, same as `null` — the reconciler
// (`resolveHeldPlans` + `planSubscriptionHistory`,
// `@linyup/shared/utils/subscriptionHistory`) treats the two identically, and a
// row is only ever OPEN when it also carries a `start_date` (the mitigation for
// a malformed/legacy row being read as an open track forever).
export interface SubscriptionHistoryEntry {
  id: string
  subscription_type_id?: string
  subscription_type_name?: string
  recurrence?: string
  subscription_price_id?: string // price chosen at the time, when the type had prices
  amount?: number // amount snapshot at the time of subscription
  start_date?: Timestamp
  end_date?: Timestamp | null
  termination_reason?: string
  /** Never written by the reconciler on close — see its module header. Present
   *  only where something else (a future manual editor) sets it. */
  notes?: string | null
  created_at?: Timestamp
  created_by?: string
  updated_at?: Timestamp
}

// ─── contact alert (contacts/{id}/contact_alerts) ─────────────────────────────
//
// THREE SCHEDULE KINDS, and `always` is not a degenerate case of the other two.
//
//   sessions_countdown — fires once the contact has reached N total sessions.
//   datetime           — fires once an instant has passed.
//   always             — fires on creation and stays fired until archived.
//
// `always` exists because "active from the moment I wrote it" was previously
// only expressible by faking one of the other two, and both fakes are wrong:
// a `datetime` of today is an INSTANT, which the mobile reader only surfaces
// for a ±7 day window, so an alert meant to stand until dealt with quietly
// stops showing; and `sessions_countdown: 0` is unreachable from the forms
// (both enforce min 1) and would read as "0 sessions remaining" to the mobile
// predicate. The end of an `always` alert is `archived_at`, which already
// exists and which `trackContactAlerts` already respects.
//
// `schedule_value` is NOT narrowed by `schedule_type` — the pair predates the
// union and is persisted in thousands of documents. Never read it directly:
// `alertScheduleValue()` in `utils/contactAlerts.ts` narrows it in one place,
// and `alertIsFired()` is the ONLY predicate that decides a alert has fired.

export type AlertScheduleType = 'sessions_countdown' | 'datetime' | 'always'

export interface ContactAlert {
  id: string
  schedule_type: AlertScheduleType
  /** Sessions (number) for `sessions_countdown`, an instant for `datetime`,
   *  and unused for `always`. Narrow it with `alertScheduleValue()`. */
  schedule_value: number | Timestamp | null
  message: string
  show_in_app?: boolean
  /** Freeform origin tag, read by the mobile AlertsCard to pick an icon — NOT
   *  narrowed by a shared union: writers pick their own string ('automation',
   *  'booking' today — see automationEngine.ts and booking/index.ts) and a
   *  reader with no icon for an unrecognised value just shows the default.
   *  Absent on alerts written before this field existed. */
  alert_type?: string
  /** Set = dismissed. The only end an `always` alert has, and the reason
   *  `trackContactAlerts` counts non-archived rows only. */
  archived_at?: Timestamp | null
  created_at?: Timestamp
}

// ─── contact update request (teams/{teamId}/contact_requests) ─────────────────

export interface ContactRequest {
  id: string
  contact_id: string
  contact_name?: string
  contact_email?: string
  team_id?: string
  request_type?: 'data_update'
  /** The fields the contact submitted (firstname, lastname, phone, …). */
  submitted_data?: Record<string, unknown>
  note?: string
  status?: 'pending' | 'approved' | 'discarded'
  requested_at: Timestamp
  reviewed_at?: Timestamp
  reviewed_by?: string
}
