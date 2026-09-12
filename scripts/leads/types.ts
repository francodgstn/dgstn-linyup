/**
 * LeadProfile — the data contract between `scripts/seed-lead.ts` (the generic
 * lead-sandbox seeder) and the per-lead profile modules under
 * `scripts/leads/{lead}/profile.ts`.
 *
 * A "lead" is a prospective customer we demo to: the profile mirrors their REAL
 * public data (schedule, offerings, pricing, site copy — with their permission)
 * plus fully SYNTHETIC contacts (never real client names).
 *
 * Type vocabulary mirrors @linyup/shared (re-declared here because the seed
 * scripts compile under tsconfig.scripts.json, which does not resolve the
 * workspace import — same convention as scripts/lib/affiliations.ts).
 */

export type LeadRecurrence =
  | 'per_class'
  | 'one_time'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'

export interface LeadStaffDef {
  /** id suffix → auth uid `lead-{leadId}-{key}` ('owner' key gets `lead-{leadId}-uid`). */
  key: string
  role: 'owner' | 'manager' | 'coach'
  firstname: string
  lastname: string
  email: string
}

export interface LeadPlaceDef {
  /** id suffix → `{teamId}-place-{key}`; referenced by LeadGridSlot.placeKey etc. */
  key: string
  name: string
  address: string
  mapsUrl?: string
  /** The team's Main Address (denormalised to the bio-link). Exactly one. */
  isPrimary?: boolean
}

export interface LeadCustomFieldDef {
  /** Stable id — the key used in Contact.custom_fields. */
  id: string
  label: string
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox'
  options?: string[] // for type 'select'
  required?: boolean
  /** Opt in to being ASKED on the public book form. Off by default, because
   *  asking it publicly mirrors this field's label and options into the
   *  world-readable team profile. A field listed in `bookingContactFields`
   *  without this is refused at the write — see booking/contactFields.ts. */
  publicOnBookingForm?: boolean
}

/**
 * A field the public book form collects ABOUT THE PERSON (stored on the
 * contact), as opposed to a booking QUESTION (stored on the booking).
 *
 * Keys are the shared vocabulary: 'phone' | 'birthdate' | 'address', or
 * `custom:{id}` naming a `LeadCustomFieldDef`.
 */
export interface LeadBookingContactField {
  key: string
  required?: boolean
}

export interface LeadReminderStep {
  channel: 'email' | 'sms'
  /** Hours before session start (e.g. 168 = 1 week, 48 = 2 days, 24 = day before). */
  offsetHours: number
}

export interface LeadAutomationTemplateDef {
  /** id suffix → `{teamId}-tmpl-{key}`; referenced by rule actions' templateKey. */
  key: string
  name: string
  subject: string
  /** Markdown body; {{teamName}} / {{firstname}} placeholders supported. */
  body: string
  /** Library key (`lib_…:{lang}`) when the template mirrors a stock one. */
  systemKey?: string
}

export interface LeadAutomationRuleDef {
  /** id suffix → `{teamId}-rule-{key}`. */
  key: string
  name: string
  active?: boolean
  systemKey?: string
  /** Engine trigger, e.g. { type: 'session_ended', delayMinutes: 120 }. */
  trigger: Record<string, unknown>
  conditions?: Record<string, unknown>[]
  /** Engine actions; `templateKey` entries are resolved to seeded template ids. */
  actions: (Record<string, unknown> & { templateKey?: string })[]
}

export interface LeadActivityDef {
  name: string
  slug: string
  color: string
  level: 'all' | 'beginner' | 'intermediate' | 'advanced'
  isFreeTrial: boolean
  base_score: number
  description: string
  /** Group-class capacity shown/enforced on the public booking surface. */
  capacity: number | null
  /** Assets-folder base name for the cover image (e.g. 'activity-squad-technique'). */
  imageAsset?: string
  /** Display-only entry requirements shown on the public booking page. */
  prerequisites?: string
  /** Contact fields this activity asks for IN ADDITION to the team-wide list
   *  (LeadTeamProfile.bookingContactFields) — it extends, never replaces. */
  contactFields?: LeadBookingContactField[]
  /** Per-activity confirmation-email note (overrides the team-wide one). */
  confirmationInstructions?: string
  /** Paid-access gate; defaults derived from isFreeTrial when unset. */
  accessTier?: 'open' | 'members' | 'subscription'
  /** For accessTier 'subscription': LeadSubscriptionDef.keys that grant access. */
  accessSubKeys?: string[]
  /** Drop-in / pay-per-class price (major units) for uncovered contacts. */
  dropInPrice?: number
  /** Member rate on the drop-in price (Activity.memberBenefit on a CLASS):
   *  holders of a listed subscription type who are NOT covered by the access
   *  rule pay a reduced drop-in — 'percent_off' takes `percent` (1–99) off,
   *  'fixed_price' charges `amount` (major units) instead. subKeys reference
   *  LeadSubscriptionDef.keys (resolved to type ids at seed time, like
   *  accessSubKeys). Price-modifying effects only; only meaningful (and only
   *  mirrored publicly) alongside a priced dropInPrice. */
  memberBenefit?: {
    subKeys: string[]
    effect: 'percent_off' | 'fixed_price'
    percent?: number
    amount?: number
  }
  /** Independent of accessTier: a gated class still accepts a newcomer's trial
   *  booking (guest path identical to 'open'). Lets a class combine
   *  members-only access + free trial + drop-in (Activity.trialEnabled). */
  trialEnabled?: boolean
  /** PAID trial price (major units) — a reduced-price first class instead of a
   *  free one (Activity.trialPriceAmount). Only meaningful with a trial door
   *  (trialEnabled, or an 'open' class). Unset ⇒ the trial is FREE. */
  trialPrice?: number
}

export interface LeadSubscriptionPriceDef {
  /** id suffix → `{teamId}-sub-{subKey}-price-{key}`. */
  key: string
  /** Shown in the price picker + shop, e.g. "x3 Starter Pack". */
  label?: string
  amount: number
  recurrence: LeadRecurrence
  /** For one_time prices: how long the purchase covers (months). */
  includedMonths?: number
  /** Lesson credits granted by the purchase (credit packs; Wave 3 feature). */
  credits?: number
  /** True when the price is a plausible assumption, not confirmed public data. */
  assumed?: boolean
}

export interface LeadSubscriptionDef {
  /** id suffix → `{teamId}-sub-{key}`. */
  key: string
  name: string
  description: string
  source: 'internal' | 'aggregator'
  recurrence: LeadRecurrence | null
  /** Major units in the team currency; null = price-less (e.g. aggregator passes). */
  price: number | null
  /** For one_time prices: how long the purchase covers (months). */
  includedMonths?: number
  /** True when the price is a plausible assumption, not confirmed public data. */
  priceAssumed?: boolean
  /** Multi-price types (e.g. single / 3-pack / 5-pack). When set, overrides the
   *  single price/recurrence/includedMonths fields above. */
  prices?: LeadSubscriptionPriceDef[]
  /** Usage limit on covered CLASS bookings (SubscriptionType.limits), e.g.
   *  [{ count: 3, per: 'week' }] = "3 classes per week". Windows are CALENDAR
   *  periods in the team timezone; once the allowance is spent the type stops
   *  covering until the window resets (drop-in / member rates still apply).
   *  Not for credit-metered packs — credits are the meter there. */
  limits?: { count: number; per: 'day' | 'week' | 'month' }[]
  /** Aggregator types only (source: 'aggregator'): what the partner pays the
   *  studio per ATTENDED visit (major units, team currency) — drives the
   *  partner_visits payout ledger once a class gates on the type. */
  payoutPerVisit?: number
}

export interface LeadGridSlot {
  /** Weekday, JS getDay() convention: 0=Sun … 6=Sat. Ignored when `dayOffsets`
   *  is set (a one-off slot carries its own dates). */
  day: number
  hh: number
  mm: number
  durMin: number
  /** Index into LeadProfile.activities. */
  activityIdx: number
  /** Which staff member teaches it (LeadStaffDef.key). */
  staffKey: string
  /** Where it happens (LeadPlaceDef.key); falls back to LeadProfile.location. */
  placeKey?: string
  /** Only materialize in upcoming weeks (new offerings with no history).
   *  Ignored on a one-off slot — its dates are already explicit. */
  upcomingOnly?: boolean
  /**
   * ONE-OFF dates instead of a weekly repeat: day offsets from seed time
   * (0 = today, negative = the past), each materialized once at `hh:mm`. Set
   * this for an offering that is scheduled a session at a time — a monthly
   * workshop, a one-day intensive — rather than on a fixed weekly rhythm.
   *
   * When set, `day` and `upcomingOnly` are ignored and the slot is NOT repeated
   * across the `scheduleWeeksBack…Ahead` window.
   *
   * Keep future offsets inside the seeded booking window, which is derived from
   * `scheduleWeeksAhead` (≈ `max(2, ceil(scheduleWeeksAhead / 4))` months): a
   * session further out than that exists as a doc but won't surface on the
   * public booking page.
   */
  dayOffsets?: number[]
}

/** One bookable length of an appointment offering, with its base price — an
 *  `Activity.durations` entry. Prices are major units of the team currency.
 *
 *  Appointments have NO access gate — THE PRICE IS THE GATE. `priceAmount` is
 *  the base price anyone (guests included) pays through Stripe checkout; omit
 *  it (or null) for an unpriced duration, which anyone books free. The stored
 *  member rule IS per duration (`Activity.durationBenefits`) — a profile still
 *  states ONE rule (`LeadAppointmentDef.memberBenefit`) and the seeder applies
 *  it to every length; see there for why the profile shape did not change. */
export interface LeadAppointmentDurationDef {
  minutes: number
  priceAmount?: number | null
}

/** The member rule of an appointment offering, referencing subscriptions by
 *  `LeadSubscriptionDef.key` (resolved to subscription-type ids at seed time).
 *  Holders of any listed type: `kind: 'included'` book every priced duration
 *  free (a credit-pack type spends a credit); `kind: 'discount'` pay
 *  `discountPercent` off every priced duration. Absent = no benefit — everyone
 *  pays base. The benefit is data, never implied.
 *
 *  ONE RULE HERE, PER-LENGTH RULES IN THE DOCUMENT. The product stores one rule
 *  per session length; the seeder writes this one onto every length. The
 *  profile shape stayed as it was on purpose — lead profiles are gitignored, so
 *  a required edit there is one this repo can neither make nor review, and
 *  every existing profile would break on a field nobody could find. A profile
 *  that wants different rules per length can be given a per-length key when one
 *  actually does. */
export interface LeadAppointmentMemberBenefitDef {
  subKeys: string[]
  kind: 'included' | 'discount'
  /** 1–100; required when kind === 'discount'. */
  discountPercent?: number
}

/**
 * One appointment OFFERING — the WHAT. Seeded as an `Activity` with
 * `type: 'appointment'`; the availability docs that link to it publish only the WHEN.
 *
 * A lead may have SEVERAL: a free 30-min intro call and a paid 60-min 1:1 are
 * two offerings because they are different PRODUCTS with different pricing —
 * appointments carry no access rule (the price is the only gate), so what
 * separates offerings is name, durations, price and member benefit.
 */
export interface LeadAppointmentDef {
  /** id suffix → `{teamId}-act-appointment-{key}`; referenced by
   *  LeadAvailabilityDef.activityKeys and LeadBookedAppointmentDef.activityKey. */
  key: string
  activityName: string
  slug: string
  description: string
  /** Assets-folder base name for the cover image (as LeadActivityDef.imageAsset). */
  imageAsset?: string
  /** The lengths this offering can be booked at, each with an optional base
   *  price (Activity.durations). Duration belongs to the offering, never to the
   *  availability schedule. */
  durations: LeadAppointmentDurationDef[]
  /** The member rule, applied to EVERY length at seed time. Absent = no benefit
   *  — everyone pays the base price (or books free when unpriced). */
  memberBenefit?: LeadAppointmentMemberBenefitDef
}

/**
 * A provider's published free time — the WHEN, and only the when. The WHAT (name,
 * durations, pricing, member benefit) lives on the linked appointment activities,
 * i.e. `LeadProfile.appointments.activities`.
 *
 * NOTHING is pre-generated in either mode: an appointment session exists only once
 * a client books one. `booked` below is demo dressing, not generated availability.
 */
export interface LeadAvailabilityDef {
  /** Whose time this publishes (LeadStaffDef.key). */
  staffKey: string
  /** The SCHEDULE's admin-facing name — e.g. 'Monday evenings'. NOT the offering
   *  name (that's `appointments.activities[].activityName`). */
  title: string
  /** Which offerings are bookable in this window (LeadAppointmentDef.keys) →
   *  the availability doc's `activityIds`. Defaults to ALL of them. One window may
   *  list several — that is what the multi-activity model is for. */
  activityKeys?: string[]
  /** Recurrence days (JS getDay convention: 0=Sun … 6=Sat), in the team timezone. */
  daysOfWeek: number[]
  /** Where it happens (LeadPlaceDef.key); falls back to LeadProfile.location. */
  placeKey?: string
  /** 'range' = a daily window clients self-book a start within, stepped by
   *  `granularityMinutes` (Calendly-style); 'times' = an explicit list of starts. */
  mode: 'range' | 'times'
  /** 'range' mode: the daily bookable range ('HH:MM', team timezone). */
  window?: { start: string; end: string }
  /** 'range' mode: step between selectable start times (minutes). Default 30. */
  granularityMinutes?: number
  /** 'times' mode: explicit 'HH:MM' start times. */
  times?: string[]
  /** Gap enforced before/after each appointment (minutes). Default 0. */
  bufferMinutes?: number
  /** Demo realism only: already-booked appointments to materialise against this
   *  availability, shaped exactly as the `bookAppointment` callable writes them. */
  booked?: LeadBookedAppointmentDef[]
}

/** A coach's time off — a window that OVERRIDES the availability templates.
 *  Written to `availability_exceptions/{id}`; listAvailability subtracts it, so
 *  the coach loses those slots (and the public picker refuses a start inside it).
 *  Dates are RELATIVE (day offsets from seed time, anchored to 00:00 team-local)
 *  so the demo always lands in the future regardless of when the tenant is seeded. */
export interface LeadTimeOffDef {
  /** Whose time off (LeadStaffDef.key). */
  staffKey: string
  /** Inclusive window start — this many days from seed time, at 00:00 team-local. */
  startDayOffset: number
  /** Exclusive window end — this many days from seed time, at 00:00 team-local. */
  endDayOffset: number
  /** Optional reason, shown only in the admin manager (never public). */
  note?: string
}

/** One already-booked appointment (see LeadAvailabilityDef.booked). */
export interface LeadBookedAppointmentDef {
  /** 'HH:MM' start — must sit on the availability's grid / times list. */
  time: string
  /** Which offering was booked (LeadAppointmentDef.key). Defaults to the first
   *  activity the availability links to. */
  activityKey?: string
  /** Session length; must be one of the booked activity's `durations` minutes. */
  durationMinutes: number
  /** Which occurrence of the availability's weekdays to land on (1 = the next one).
   *  Negative walks backwards into the PAST — history for the calendar + reports. */
  occurrence: number
  /** Index into LeadProfile.contacts of the client who booked. Defaults to the
   *  first adult student. */
  contactIdx?: number
}

export interface LeadContactGroupDef {
  /** id suffix → `{teamId}-group-{key}`; referenced by LeadContactDef.groupKeys. */
  key: string
  name: string
  /** Nest under another group (LeadContactGroupDef.key). Top-level when unset. */
  parentKey?: string
  color?: string
  description?: string
}

export interface LeadContactDef {
  firstname: string
  lastname: string
  gender: 'M' | 'F'
  birthYear: number | null
  birthplace: string | null
  type: 'student' | 'trial' | 'external'
  /** Authoring status — mapped to acquisition/affiliation fields, never written raw. */
  status: 'active' | 'almost_ready' | 'under_review' | 'expired' | 'requested' | 'guest'
  totalSessions: number
  /** LeadSubscriptionDef.key or null. */
  subKey: string | null
  /** Assign to a coach's own-scope view (LeadStaffDef.key). */
  assignedToStaffKey?: string
  /** Contact Groups plugin membership (LeadContactGroupDef.keys) → group_ids. */
  groupKeys?: string[]
  /** Acquisition source override (default: seeded-random). */
  source?: 'website' | 'referral' | 'social' | 'event' | 'other'
  /** Free-text detail shown with the source (e.g. 'QR poster', 'Meta ads'). */
  sourceDetail?: string
  /** Values for the team's custom field definitions (keyed by definition id). */
  customFields?: Record<string, string | number | boolean>
  /** Mark this synthetic contact as the DEMO-LOGIN target: its `login_emails`
   *  gets the operator (+ profile `demoLoginEmails`), so you/the lead can sign in
   *  AS this member (shop, Space, courses) via the passwordless code flow. Pick a
   *  data-rich contact (subscription + credit pack + bookings) for a full POV. */
  demoLogin?: boolean
  /** Present for child contacts (baby/toddler classes): parent + guardian fields.
   *  Kids get no gamification, no goals, no leaderboard presence, no auth login. */
  kid?: {
    /** ISO date, e.g. '2024-11-03'. */
    birthdate: string
    parentName: string
    parentEmail: string
    parentPhone: string
    note: string
  }
}

export interface LeadEventDef {
  title: string
  type: string
  startOffset: number
  durationH: number
  fee: number
  location: string
  description: string
}

export interface LeadGoalDef {
  title: string
  description: string
  /** GOAL CATEGORY keys — what the goal is about (technique / attitude /
   *  attendance / physical / mental, or the tenant's own list). NEVER
   *  check-in axis keys: see the header of packages/shared/src/types/goal.ts. */
  categories: string[]
}

export interface LeadCourseLessonDef {
  title: string
  type: 'text' | 'video'
  body: string
  media?: string
  dur?: number
}

export interface LeadCourseDef {
  /** id suffix → `{teamId}-course-{key}`. */
  key: string
  title: string
  summary: string
  /** Course access tier (mirrors Course.accessRule.type):
   *  free = anyone · registered = any signed-in contact · subscription = only
   *  holders of `accessSubKeys` · purchase = sold one-off in the shop for
   *  `priceAmount` (and ALSO included free for `accessSubKeys` holders). */
  access: 'free' | 'registered' | 'subscription' | 'purchase'
  /** LeadSubscriptionDef.keys that unlock ('subscription') or include ('purchase') it. */
  accessSubKeys?: string[]
  /** One-off shop price, major units — required for 'purchase'. */
  priceAmount?: number
  /** Subscriber benefit on the 'purchase' price (Course.benefit): holders of a
   *  listed subscription type get the course 'included' free, `percent` (1–99)
   *  off, or at a fixed `amount` (major units). subKeys reference
   *  LeadSubscriptionDef.keys (resolved to type ids at seed time). Absent =
   *  no benefit — everyone pays the base price. */
  benefit?: {
    subKeys: string[]
    effect: 'included' | 'percent_off' | 'fixed_price'
    percent?: number
    amount?: number
  }
  /** Assets-folder base name for the cover image. */
  coverAsset?: string
  modules: { title: string; lessons: LeadCourseLessonDef[] }[]
}

export interface LeadProductDef {
  /** id suffix → `{teamId}-prod-{key}`. */
  key: string
  name: string
  description: string
  priceAmount: number
  variantLabel?: string
  variants?: { id: string; label: string }[]
}

/** One question on a lead's public form (a `Form.fields[]` entry). */
export interface LeadFormFieldDef {
  /** Stable id — used VERBATIM as the answer key in FormSubmission.answers. */
  id: string
  type:
    | 'short_text'
    | 'long_text'
    | 'email'
    | 'phone'
    | 'number'
    | 'single_choice'
    | 'multiple_choice'
    | 'dropdown'
    | 'checkbox'
    | 'date'
  label: string
  /** Shown inside the control. For `checkbox` this is the VISIBLE text — the
   *  public renderer hides the label and prints `placeholder || label` inline —
   *  so consent wording belongs here, not in `label`. */
  placeholder?: string
  required?: boolean
  /** Choices for 'single_choice' | 'multiple_choice' | 'dropdown'. */
  options?: string[]
}

/**
 * A public form (`forms/{id}` + its `public_profile` mirror), reached at
 * `/public/{slug}/forms/{formSlug}`. Installs the `custom-forms` plugin and
 * flips the team's `active_public_surfaces.forms`.
 *
 * Note this is NOT the signup/booking path: with `createContact: false` a
 * submission is just a message — no contact is created or matched, nothing
 * enters the acquisition funnel. That's what makes it a plain "get in touch".
 */
export interface LeadFormDef {
  /** id suffix → `{teamId}-form-{key}`. */
  key: string
  title: string
  /** URL segment → `/public/{teamSlug}/forms/{slug}`. */
  slug: string
  description?: string
  /** 'public' = anyone with the link; 'contacts' = needs a contact session. */
  access?: 'public' | 'contacts'
  /** Whether a submission creates/links a Contact. Default true (lead capture);
   *  set FALSE for a plain enquiry form. */
  createContact?: boolean
  /** Which field carries the submitter's email (LeadFormFieldDef.id) — used for
   *  the confirmation mail and (when enabled) contact matching. */
  emailFieldId?: string
  /** Email the studio on each submission. Default true. */
  notifyStaff?: boolean
  /** Email the submitter a copy/confirmation. Default false. */
  confirmSubmitter?: boolean
  /** Shown on the page after a successful submit. */
  confirmationMessage?: string
  fields: LeadFormFieldDef[]
  /** Add a bio-link entry pointing at the form (there is no `form` system link
   *  target, so it is seeded as a custom-URL link). */
  inBioLink?: boolean
}

export interface LeadDocumentDef {
  /** id suffix → `{teamId}-doc-{key}`. */
  key: string
  title: string
  slug: string
  kind: 'terms' | 'privacy' | 'regulation' | 'other'
  summary: string
  /** Rich-text body; ignored when externalUrl is set. */
  body: string
  /** Externally-hosted document (e.g. a SignWell agreement) → source 'external_link'. */
  externalUrl?: string
  /** Attach to the public signup flow (documents plugin config). */
  inSignup?: boolean
}

/**
 * Website sections, passed through to site_drafts/site_published verbatim after
 * asset resolution: `imageAsset` → `imageUrl`, `bgImageAsset` → `bgImageUrl`,
 * `imagesAssets` → `images` (each an assets-folder base name; missing files
 * resolve to null / are dropped).
 */
export type LeadSiteSection = Record<string, unknown> & {
  id: string
  type: string
  imageAsset?: string
  bgImageAsset?: string
  imagesAssets?: string[]
}

export interface LeadProfile {
  /** Lead id — folder name, workflow choice value, teamId `lead-{id}`. */
  id: string
  teamName: string
  slug: string
  description: string
  sportType: string
  language: 'en' | 'de' | 'fr' | 'it'
  currency: string
  /** IANA timezone the weekly grid times are expressed in (e.g. 'Europe/Zurich'). */
  timezone: string
  accentColor: string
  /** BIO_LINK_GRADIENTS key (apps/web/src/lib/bioLink.ts). */
  portalGradient: string
  /** Optional custom background for the branded public surfaces that read
   *  `bioLinkBackground` — the bio-link home, the shop, and the Space. A hex
   *  color (e.g. '#fde0dd') or a full CSS value (e.g. 'linear-gradient(…)').
   *  When set it overrides `portalGradient`. (Booking follows the app theme.) */
  publicBackground?: string
  /** How many FUTURE weeks of the weekly grid to materialize as bookable
   *  sessions (default 3). Raise it so a lead trying the system for a while has
   *  a schedule that lasts; the public booking window is derived from it. Keep
   *  weeks × grid-slots-per-week under ~200 (the booking query fetches the
   *  first 200 upcoming sessions). */
  scheduleWeeksAhead?: number
  /** How many weeks of PAST sessions to materialize (default 4) — history for
   *  reports/attendance. */
  scheduleWeeksBack?: number
  socialLinks: { platform: string; url: string }[]
  /** Main venue, used on sessions + the site contact section. */
  location: { label: string; address: string; mapsUrl?: string }
  contactPhone: string
  contactEmail: string

  /** Physical locations (pools, gyms, studios). Slots reference them by key. */
  places?: LeadPlaceDef[]
  /** Account-wide extra contact fields (installs the custom-fields plugin). */
  customFieldDefinitions?: LeadCustomFieldDef[]
  /**
   * What EVERY book form asks about the person, on top of name + email.
   * Unset keeps the historical default (phone only). An empty array asks for
   * nothing beyond name + email.
   */
  bookingContactFields?: LeadBookingContactField[]
  /** Contact Groups plugin — nested member groups (e.g. by discipline/area).
   *  Installs the contact-groups plugin; membership is set via
   *  LeadContactDef.groupKeys. */
  contactGroups?: LeadContactGroupDef[]
  /** Team-wide note appended to booking confirmation emails ("Important" box). */
  bookingConfirmationInstructions?: string
  /** Booking reminder schedule (settings.bookingReminderSteps; Wave 2 sends SMS). */
  reminders?: { steps: LeadReminderStep[] }
  /** SMS sender name (≤11 alphanumeric chars) → integrations/sms_sender. */
  smsSenderName?: string
  /** Profile-authored automations; replaces the stock welcome/win-back pair.
   *  The lib_trial_cleanup hygiene rule is always installed regardless. */
  automations?: { templates: LeadAutomationTemplateDef[]; rules: LeadAutomationRuleDef[] }
  /** Outbound-delivery policy (messaging_policies/{teamId}, operator-only).
   *  Default: allowlist of the owner's + the profile's contact email — the lead
   *  gets real OTP/confirmations while synthetic contacts stay silent. Extra
   *  entries extend the allowlist ('@domain.tld' entries allowed); phones are
   *  E.164 for SMS delivery. mode override for special cases (e.g. 'silent'). */
  messagingPolicy?: {
    mode?: 'live' | 'allowlist' | 'redirect' | 'silent'
    allowEmails?: string[]
    allowPhones?: string[]
    redirectEmail?: string
    note?: string
  }
  /** Extra REAL emails added to the demo-login contact's `login_emails` (the one
   *  flagged `demoLogin`), on top of the operator email the seeder always adds —
   *  e.g. the lead's own address so they can try the member POV. Delivery of the
   *  login code still obeys the messaging policy (allowlist/redirect the tester). */
  demoLoginEmails?: string[]

  staff: LeadStaffDef[]
  rankingSystem: {
    id: string
    name: string
    /** `value` is IGNORED since Phase 4 of docs/rank-scale-decoupling.md and
     *  kept optional only so an older profile still typechecks; a level is
     *  identified by the id minted from its label and ordered by position. */
    levels: { value?: number; label: string; color: string }[]
  } | null
  /** settings.gamification payload (enabled, base score, multipliers, …). */
  gamification: Record<string, unknown>

  activities: LeadActivityDef[]
  /** The 1:1 offerings (each a `type: 'appointment'` activity — the WHAT) + the
   *  availability schedules that publish when they can be booked (the WHEN). A
   *  schedule links to one or more offerings via `activityKeys`. */
  appointments: {
    activities: LeadAppointmentDef[]
    availability: LeadAvailabilityDef[]
    /** Coach time-off windows → `availability_exceptions/{id}` (the Time-off
     *  feature). listAvailability subtracts these. Optional; absent ⇒ none. */
    timeOff?: LeadTimeOffDef[]
  }
  subscriptions: LeadSubscriptionDef[]
  weeklyGrid: LeadGridSlot[]
  contacts: LeadContactDef[]
  goals: LeadGoalDef[]
  tasks: string[]
  events: LeadEventDef[]

  siteSections: LeadSiteSection[]
  /**
   * Optional stored header MENU (a `SiteMenuItem[]` tree). Absent ⇒ the header
   * is DERIVED from the sections — every nav-visible section becomes a top-level
   * item, which grows long once a site has many sections. A profile provides
   * this to demo a realistic GROUPED menu: a few top items, some with children,
   * and secondary sections folded away (set their `showInNav: false`).
   * Authored by hand as `{ id, label?, target, children? }`; see SiteMenuItem.
   */
  siteMenu?: Record<string, unknown>[]
  courses: LeadCourseDef[]
  products: LeadProductDef[]
  /** Gift cards (settings.giftCards + the team public_profile mirror): lets the
   *  public shop sell stored-value cards at these face values (major units).
   *  `demoCard` pre-mints ONE active card at teams/{id}/gift_cards/{code} so
   *  redemption can be demoed in checkout without buying a card first — pick a
   *  readable demo code (e.g. 'GC-SWIM-DEMO'), never a real minted one.
   *  Absent ⇒ gift cards stay off for the tenant. */
  giftCards?: {
    enabled: boolean
    amounts: number[]
    demoCard?: { code: string; amount: number }
  }
  /** No-show policy (settings.noShowPolicy): every `threshold` accumulated
   *  no-show strikes create ONE `feeAmount` policy fee (major units) on the
   *  contact (TeamUp-style — never per incident; managers can waive). Absent ⇒
   *  the policy stays off.
   *
   *  LEAVE IT ABSENT unless the lead has SAID they charge for no-shows. Whether
   *  to bill somebody for missing a class is their commercial decision, not a
   *  demo default: a sandbox that arrives with it on has made that decision for
   *  them, and it is the kind of setting a prospect notices and objects to. No
   *  shipped lead profile sets it. */
  noShowPolicy?: { feeAmount: number; threshold: number }
  documents: LeadDocumentDef[]
  /** Public forms (installs the `custom-forms` plugin + flips the team's
   *  `active_public_surfaces.forms`). Absent ⇒ none, plugin not installed. */
  forms?: LeadFormDef[]
  /**
   * Default pinned sidebar items for the tenant, in PIN ORDER
   * (`teams/{teamId}.settings.defaultNavPins`). Applied only when the viewer has
   * no pins of their own yet — a user's own choice always wins afterwards.
   *
   * Ids come from the admin nav: core ones like `calendar`, `bookings`,
   * `contacts`, `activities`, `plans`, `payments`, `publicPages`; plugin ones
   * are scoped as `plugin:{pluginId}:{href}` (e.g.
   * `plugin:contact-groups:/plugins/contact-groups`) and are skipped silently if
   * that plugin isn't installed for the team.
   */
  navPins?: string[]

  /** Assets-folder base names for team branding (default 'profile' / 'hero'). */
  profileImageAsset?: string
  heroImageAsset?: string

  /**
   * Optional Stripe TEST connected account (acct_…) to wire for the "pay with
   * Linyup" flow, so the seeded team can take payments without re-onboarding.
   * Overridden by the --connect flag / STRIPE_CONNECT_TEST_ACCOUNT env. The acct
   * must already be onboarded in Stripe test mode (see scripts/connect-test-account.ts).
   */
  stripeConnectTestAccount?: string
  /**
   * Pins the staff-login password for this lead instead of generating a random
   * one per run — the same value `--password` would pass.
   *
   * THE FIELD IS DECLARED HERE; THE VALUE BELONGS IN THE PROFILE, which is
   * gitignored. A lead's owner login is a real person's address on a cloud
   * sandbox, so the password is a working credential and must not reach a
   * tracked file. That is also why this is not a constant in seed-lead.ts,
   * which is committed.
   *
   * Precedence: `--password` > this > a fresh random one.
   */
  demoPassword?: string

  /** Caveats printed after seeding (e.g. which prices are assumptions). */
  notes?: string[]
}
