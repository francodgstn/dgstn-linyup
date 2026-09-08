import type { Timestamp } from './common'
import type { BookingContactField } from './team'
import type { Benefit } from './benefit'
// Type-only — form.ts imports nothing from here, so no runtime cycle. Booking
// questions deliberately REUSE the Custom Forms field schema rather than
// inventing a parallel one: same types, same renderer, same answer shape.
import type { FormField } from './form'

/** Top-level category that determines the session model and booking flow.
 *  'class' = a scheduled event with seats; 'appointment' = a provider's exclusive
 *  time booked from published availability (was 'coaching'). */
export type ActivityType = 'class' | 'appointment'

// ─── WHO MAY BOOK A CLASS ────────────────────────────────────────────────────
//
// TWO INDEPENDENT QUESTIONS, and conflating them is what made this area hard to
// explain for as long as it was one enum:
//
//   AUDIENCE     — may this person book AT ALL?      'anyone' | 'members'
//   requirePlan  — must they hold one of the plans?  boolean
//
// What they PAY is not asked here at all: a covering plan makes it free, and
// everyone else pays the drop-in price if one is set. So "free" is the ABSENCE
// of a price, not a tier — which is why there is no 'free' state to choose.
//
//   audience   requirePlan   drop-in price   outcome
//   ────────   ───────────   ─────────────   ────────────────────────────────
//   anyone     false         —               free for everyone
//   anyone     false         CHF 25          anyone books; pays 25 unless covered
//   members    false         —               free for every member
//   members    false         CHF 25          members pay 25 unless covered; guests refused
//   members    true          (either)        only holders of a linked plan may book
//
// The fourth row is the one the old enum could not say: 'members' made EVERY
// member free (so the price never fired) and 'subscription' let a stranger pay.
//
// ── THE LEGACY TIER ──────────────────────────────────────────────────────────
// `type` came first and is still read: `resolveActivityAccessRule` derives the
// pair above from it when the new fields are absent, so no document needs
// rewriting. It survives as the DISPLAY projection — surfaces that only want to
// say "open / members only / plan required" keep reading it — but nothing that
// DECIDES may branch on it any more, because it cannot express the fourth row.
//
// CLASSES ONLY — appointments dropped this gate entirely in 2026-07 (see
// `ActivityMemberBenefit`'s history note); `Activity.accessRule` still exists
// because classes use it, but appointment booking paths ignore it everywhere.
export type ActivityAccessTier = 'open' | 'members' | 'subscription'

/** Who is allowed through the door — free path and paid path alike. */
export type ActivityAudience = 'anyone' | 'members'

export interface ActivityAccessRule {
  /** LEGACY + display projection. Never branch on it to decide access. */
  type: ActivityAccessTier
  /** The plans that grant free (or credit-spent) access. */
  subscriptionTypeIds?: string[]
  /** Absent ⇒ derived from `type` by `resolveActivityAccessRule`. */
  audience?: ActivityAudience
  /** Must the booker hold a linked plan? Absent ⇒ false (derived). */
  requirePlan?: boolean
}

/**
 * THE ONE READER of an activity's stored access rule — unchanged in behaviour:
 * it fills in the legacy `isFreeTrial` default and hands back what is stored.
 *
 * IT DELIBERATELY DOES NOT DERIVE `audience` / `requirePlan`. The legacy
 * `subscription` tier maps to one or the other depending on whether a DROP-IN
 * PRICE exists (with one, a non-holder could always buy in; without one she was
 * refused), and this function is called from surfaces that have no drop-in in
 * hand — the public mirror, the terms line, the plan-link editor. Deriving here
 * would make those surfaces guess. The gate does it instead, where the price is
 * known: `resolveClassGate` in utils/paymentOptions.ts.
 */
export function resolveActivityAccessRule(a: {
  accessRule?: ActivityAccessRule | null
  isFreeTrial?: boolean
}): ActivityAccessRule {
  if (a.accessRule) return a.accessRule
  return { type: a.isFreeTrial === false ? 'members' : 'open' }
}

/** Does a booking for this offering confirm itself? Falls back to the kind's
 *  default when the field is unset: appointments auto-confirm (a 1:1 slot has no
 *  roster-review step — the time is taken the moment it's booked), classes don't
 *  (the studio confirms via check-in). Keep this the single source of truth so
 *  the booking callables, the seeds, and the UI agree. */
export function resolveAutoConfirm(a: {
  autoConfirm?: boolean
  type?: ActivityType
}): boolean {
  if (typeof a.autoConfirm === 'boolean') return a.autoConfirm
  return a.type === 'appointment'
}

/** One bookable session length of an appointment offering, with its pricing.
 *
 *  The coach sells TIME, so price is per duration — a 30-minute session cannot
 *  cost the same as a 90-minute one. `priceAmount` (major units, team currency)
 *  is the base price; null/absent = unpriced, which means free for anyone,
 *  guests included — there is no separate access gate for appointments any
 *  more (see `ActivityMemberBenefit`).
 *
 *  `benefitOnly` is the third state, and it exists because the two above were
 *  ONE FIELD SAYING TWO THINGS: an absent price meant both "free for everyone"
 *  and "not sold by the session", so a coach who sells only packs could express
 *  neither (leave it unpriced → a stranger books a free one-to-one; price it →
 *  anyone buys the single session the coach does not sell) — the conflation one
 *  optional field always produces when it is asked two questions at once.
 *
 *  IT IS NOT A SECOND GATE. Appointments have no `accessRule` and gain none
 *  here: this flag introduces no list of subscription ids and no new predicate.
 *  It says only that there is NO INDIVIDUAL PRICE to quote — so the price is
 *  still the gate, and the way in is the activity's ONE `memberBenefit` rule,
 *  which already names who books free or on credits. Read it through
 *  `resolveDurationSale`, never as a raw field.
 *
 *  Stored as a flag rather than a `'free' | 'priced' | 'benefit_only'` enum on
 *  purpose: an enum member would be able to disagree with `priceAmount`
 *  ('free' beside a number), and there is no answer to which one wins. The
 *  TRI-STATE IS THE READING, not the storage.
 *
 *  History: until 2026-07 this also carried `subscriptionPricing`, a per-
 *  duration × per-subscription-type price matrix. Cut after a persona test
 *  showed it produced real coach confusion ("who pays base price if only
 *  Premium can book?"); member benefit is now ONE rule per ACTIVITY
 *  (`Activity.memberBenefit`), never per duration. */
export interface ActivityDuration {
  minutes: number
  priceAmount?: number | null
  /** APPOINTMENT-ONLY. This length is not sold individually — it is bookable
   *  only through the activity's `memberBenefit`. Any `priceAmount` beside it
   *  is IGNORED (`resolveDurationSale` returns no price), so a stale number
   *  left by a studio switching modes can never be charged. */
  benefitOnly?: boolean
}

/** How a duration is sold. `'benefit_only'` = not sold individually; the
 *  activity's `memberBenefit` is the only way in. */
export type DurationSaleMode = 'free' | 'priced' | 'benefit_only'

/** THE ONE READER of a duration's sale state — every surface that asks "is this
 *  free / what does it cost / is it sold at all" goes through here rather than
 *  testing `typeof priceAmount === 'number'` inline, which is what made
 *  `benefitOnly` expressible as an addition instead of a migration.
 *
 *  Legacy docs (no `benefitOnly`) resolve to exactly today's meaning: a number
 *  is 'priced', anything else is 'free'. */
export function resolveDurationSale(d: ActivityDuration): {
  mode: DurationSaleMode
  /** The individual price, or null when there is none to quote. */
  priceAmount: number | null
} {
  if (d.benefitOnly === true) return { mode: 'benefit_only', priceAmount: null }
  return typeof d.priceAmount === 'number'
    ? { mode: 'priced', priceAmount: d.priceAmount }
    : { mode: 'free', priceAmount: null }
}

/** An appointment activity's duration menu, defaulting to a single unpriced
 *  60-minute entry when unset — the one fallback rule, shared by the
 *  availability grid, the booking gate, and the UIs. */
export function resolveAppointmentDurations(a: {
  durations?: ActivityDuration[] | null
}): ActivityDuration[] {
  const ds = (a.durations ?? []).filter((d) => d.minutes > 0)
  return ds.length ? ds : [{ minutes: 60 }]
}

/** The LEGACY appointment benefit shape — one rule for a whole activity.
 *  Holders of any listed subscription type: `kind: 'included'` books free (a
 *  credit-pack type spends a credit), `kind: 'discount'` pays
 *  `discountPercent` off every priced duration. Absent/empty
 *  `subscriptionTypeIds` = no benefit — everyone pays base.
 *
 *  On an appointment this is now the FALLBACK, not the answer: the rule is per
 *  DURATION (`Activity.durationBenefits`), and this is read only while that
 *  field is absent. See `resolveDurationBenefit`, which is the one reader.
 *
 *  Appointments also DROPPED `ActivityAccessRule` entirely in the same pass —
 *  the price is the only gate now (unpriced = anyone books free, priced =
 *  anyone pays, benefit holders less). `Activity.accessRule` still exists
 *  because classes use it; appointments ignore it everywhere — forms don't
 *  show it, booking paths don't read it. */
export interface ActivityMemberBenefit {
  subscriptionTypeIds: string[]
  kind: 'included' | 'discount'
  /** 1–100. Required/meaningful when `kind === 'discount'`; ignored for
   *  'included'. Malformed values (missing, <=0, or >=100) are handled by
   *  the appointment arm of `resolvePaymentOptions` (utils/paymentOptions.ts)
   *  — see its doc comment. */
  discountPercent?: number
}

/**
 * APPOINTMENT-ONLY. One member rule, for ONE session length.
 *
 * ── WHY IT IS PER LENGTH AGAIN ──────────────────────────────────────────────
 * An appointment's price is attached to its LENGTH, and a rule about that price
 * has to be too. With one rule for the whole activity, "members pay CHF 40"
 * charged the same for thirty minutes and for ninety — an amount that cannot be
 * right for both, offered by the editor and honoured by the resolver, with no
 * way to say the true thing (Franco, staging, 2026-09-02).
 *
 * This is NOT the matrix that was cut in 2026-07. That one was per duration ×
 * per subscription type — a grid of PRICES, which is what produced "who pays
 * base price if only Premium can book?". This is the same ONE rule the studio
 * already writes, asked once per length: the second axis is still the rule's
 * own `subscriptionTypeIds`, not a cell.
 *
 * A length with no entry has NO rule — see `resolveDurationBenefit` for how
 * that differs from having no `durationBenefits` at all.
 */
export interface ActivityDurationBenefit {
  /** Joins to `ActivityDuration.minutes`. An entry whose length no longer
   *  exists is inert: every reader looks up BY minutes, so an orphan is never
   *  consulted — and re-adding that length restores the rule it had, which is
   *  the behaviour a studio expects from un-ticking a chip by accident. */
  minutes: number
  /** `null` means this length has NO member rule. Distinct from a missing
   *  entry, which is what `resolveDurationBenefit` reads the legacy field for. */
  benefit: Benefit | null
}

/**
 * THE ONE READER of an appointment's member rule. Every surface that asks
 * "what does this plan do for this length" goes through here rather than
 * touching `memberBenefit` or `durationBenefits` directly — which is what keeps
 * the migration below invisible to all of them.
 *
 * ── AUTHORITATIVE ONCE PRESENT ──────────────────────────────────────────────
 * `durationBenefits` present ⇒ it is the whole answer, and a missing entry
 * means "no rule for this length". Absent ⇒ the legacy activity-wide
 * `memberBenefit` still applies to every length, exactly as it did before.
 *
 * So an appointment nobody has re-edited behaves identically to yesterday, and
 * the FIRST per-duration save absorbs the old rule onto every length it had
 * (`activityPlanEdgeUpdate`) and clears `memberBenefit`. One canonical home
 * going forward, no backfill to deploy — the same absorption the course gate
 * does with its own legacy spelling.
 *
 * The trap this shape avoids: reading the two as a MERGE (per-duration entry,
 * else activity-wide) would make "no rule at 90 min" unsayable — clearing the
 * 90-minute row would silently fall back to the rule the studio had just
 * removed.
 */
export function resolveDurationBenefit(
  // NULLS TOLERATED on both fields, because the wire shapes carry them: the
  // public mirror and `listAvailability` both send `null` where a document
  // simply has no key, and a signature that only accepted `undefined` would
  // push a cast onto every public caller.
  a: {
    memberBenefit?: ActivityMemberBenefit | Benefit | null
    durationBenefits?: ActivityDurationBenefit[] | null
  },
  minutes: number
): ActivityMemberBenefit | Benefit | null {
  if (a.durationBenefits) {
    return a.durationBenefits.find((d) => d.minutes === minutes)?.benefit ?? null
  }
  return a.memberBenefit ?? null
}

// A duration's effective price for one particular contact — THE PRICE IS THE
// GATE for appointments — is resolved by `resolvePaymentOptions` (the shared
// coverage/quote resolver in utils/paymentOptions.ts, `kind: 'appointment'`).
// History: a dedicated `resolveEffectiveAppointmentPrice` lived here until the
// 2026-07 pricing consolidation folded it into the one resolver; its exact
// rules (0.50 floor, malformed-pct fallbacks, first-held-in-config-order
// tie-break) are pinned by the appointment parity rows in
// functions/src/booking/paymentOptions.test.ts.

export interface Activity {
  id: string
  teamId: string
  name: string
  alternativeName?: string
  description?: string
  slug: string
  color?: string
  /** Free-text labels shown on the public booking cards ("Beginner friendly",
   *  "Gi", "Kids"). Display-only and enforced NOWHERE — no gate, no filter, no
   *  resolver reads them; the same class of field as `prerequisites`.
   *
   *  They replaced `level`, a four-value enum ('all' | 'beginners' | …) that no
   *  public surface ever rendered: it produced one chip in the admin list and
   *  nothing else, while a studio grades its classes in its own words or not at
   *  all. Stored values were dropped rather than migrated (pre-launch).
   *
   *  Mirrored into the WORLD-READABLE public profile, so the editor says so.
   *  Normalise through `normalizeActivityTags` on every write. */
  tags?: string[]
  /** Session category — default 'class'. 'appointment' uses the availability model. */
  type?: ActivityType
  /** Assigned provider uid — populated when type === 'appointment'. */
  providerId?: string
  /** Denormalised provider display name. */
  providerName?: string
  /** APPOINTMENT-ONLY. The session lengths a client may book this offering at,
   *  each with an optional price. Duration belongs to the *what* (the activity),
   *  not to the *when* (the availability schedule): a "Technique Assessment" is
   *  60 minutes wherever it is offered. An availability window's selectable start
   *  times are derived from these — never configured on the availability doc.
   *  Classes don't use this (their length is per-session, from start/end).
   *  History: was `durationsMinutes: number[]` until 2026-07 (pre-launch), when
   *  per-duration pricing arrived with paid appointments. */
  durations?: ActivityDuration[]
  /** The one member-benefit rule for this activity. Appointments: applies to
   *  every priced duration. Classes: applies to the DROP-IN price (a member
   *  rate for holders who aren't covered by the accessRule) — price-modifying
   *  effects only there. Accepts the legacy appointment shape or the
   *  generalized `Benefit`; ALL reads go through `normalizeBenefit`.
   *  Absent/empty = no benefit, everyone pays base. */
  memberBenefit?: ActivityMemberBenefit | Benefit
  /** APPOINTMENT-ONLY. The member rule PER SESSION LENGTH — read only through
   *  `resolveDurationBenefit`, never as a raw field. See that function for why
   *  it is authoritative-once-present and how a legacy `memberBenefit` is
   *  absorbed into it. */
  durationBenefits?: ActivityDurationBenefit[]
  /** Does a booking confirm itself, or does the studio decide?
   *  - `true`  → the booking is written `status: 'confirmed'` on the spot.
   *  - `false` → it stays unconfirmed until the studio confirms/checks them in.
   *  Defaults by kind when unset (appointment → true, class → false) via
   *  `resolveAutoConfirm`, but it is a FIELD, not a type rule: a class may
   *  auto-confirm, and an appointment may require approval. Denormalised onto
   *  each Session at booking time. */
  autoConfirm?: boolean
  base_score?: number | null
  /** Legacy trial toggle. Superseded by `accessRule` but kept in sync
   *  (`isFreeTrial = accessRule.type === 'open'`) for existing queries. */
  isFreeTrial?: boolean
  /** Paid-access gate. When unset, derived from `isFreeTrial` (see resolveActivityAccessRule).
   *  CLASSES ONLY — appointments ignore this field entirely; see `ActivityMemberBenefit`. */
  accessRule?: ActivityAccessRule
  /** Drop-in / pay-per-class: a contact not covered by the access rule may pay this
   *  one-off price to book a single session. Charged via Stripe Connect; no membership
   *  is created. Group-class only for now. Price is major units (team default_currency). */
  dropIn?: { enabled: boolean; priceAmount?: number }
  /** CLASS-ONLY. Independent of `accessRule`: when true, a gated class
   *  ('members' | 'subscription') still accepts a newcomer's trial booking —
   *  the guest path is IDENTICAL to the 'open' tier's (provisional trial
   *  contact, same booking shape, no repeat-limiting machinery). Lets a studio
   *  combine "members-only" access with a free trial for newcomers, without
   *  loosening the tier itself. No-op for 'open' activities (already open to
   *  everyone) and ignored for appointments (money is the only gate there —
   *  see `ActivityMemberBenefit`). */
  trialEnabled?: boolean
  /** CLASS-ONLY. Major units, team `default_currency`. Absent/null ⇒ the trial is
   *  FREE (today's behaviour — untouched). A number ⇒ the trial costs that instead
   *  of nothing; the trial's ELIGIBILITY semantics (newcomer/guest-only, once —
   *  enforced via `Contact.trial_used_at`) are unchanged, only the money changes.
   *  No-op unless `trialEnabled === true`. Charged via the same Stripe Connect
   *  drop-in checkout as `dropIn`, at this amount instead of `dropIn.priceAmount`
   *  (see `createDropInCheckout`'s `trial` input) — a class may offer a paid
   *  trial with no drop-in configured at all. */
  trialPriceAmount?: number | null
  /** CLASS-ONLY. When true, a full session of this activity offers a queue
   *  instead of a dead end: a visitor joins, and the first waiter is offered the
   *  seat automatically the moment one frees. Meaningless without
   *  `max_participants` on the sessions — a class with no cap is never full.
   *
   *  This is the ONLY place the toggle lives. There is no per-session copy and
   *  no per-session override (see `Session.waitlist_count` for why), and
   *  appointments ignore it: nothing exists to be full until a booking creates
   *  it. */
  waitlistEnabled?: boolean
  /** Display-only entry requirements shown on the public booking pages (e.g.
   *  "25m front crawl with side breathing"). Not enforced anywhere. */
  prerequisites?: string
  /** Extra instructions appended to this activity's booking confirmation email,
   *  overriding the team-wide `settings.bookingConfirmationInstructions`.
   *  Email-only — never mirrored to the public profile. */
  confirmationInstructions?: string
  /** Display-only: where to show up (address, floor, landmark). Shown on the
   *  public booking pages, never enforced. */
  meetingPoint?: string
  /** Display-only, free text (rendered as a bulleted list, one line per item). */
  whatsIncluded?: string
  /** Display-only, free text — the counterpart to `whatsIncluded`. */
  whatsNotIncluded?: string
  /** Display-only free-text FAQ block, rendered as prose on the public page. */
  faq?: string
  /** Per-activity cancellation/refund policy, shown on the public booking pages
   *  and appended to the booking confirmation email. Overrides the team-wide
   *  default (`settings.bookingCancellationPolicy`) the same way
   *  `confirmationInstructions` overrides its team-wide counterpart — but unlike
   *  that field, THIS one is also public (shown before the visitor books, not
   *  just emailed after). */
  cancellationPolicy?: string
  /** Questions asked on the public book form for THIS activity ("Any injuries?",
   *  "Shoe size", "How did you hear about us?"). Answers land on the booking
   *  (`Booking.question_answers`, keyed by field id) and surface on the day
   *  sheet, which is where the coach actually needs them.
   *
   *  Reuses `FormField` from the Custom Forms plugin — same types, same public
   *  renderer — but is NOT gated on that plugin: asking a question at booking
   *  time is part of booking, not a separate product. Capped by
   *  MAX_BOOKING_QUESTIONS (a book form is not a survey). */
  bookingQuestions?: FormField[]
  /** Contact fields this activity's book form collects, ON TOP of the team-wide
   *  list. Answers are written to the CONTACT — that is the whole distinction
   *  from `bookingQuestions`, whose answers stay on the booking. Combine the two
   *  lists ONLY through `resolveBookingContactFields` (types/team.ts). */
  contactFields?: BookingContactField[]
  isActive?: boolean
  image_url?: string
  // Display order (lower = first), respected by the manager list, the public
  // booking flow, the website, and any other place that lists activities. Absent
  // values sort last (by name) until the studio reorders.
  order?: number
  created_at?: Timestamp
  createdBy?: string
  archived_at?: Timestamp | null
}

/** Stable sort for activities: explicit `order` first (asc), then name. Absent
 *  order sorts last. Single source of truth so the manager, the public booking
 *  flow, the website, and everywhere else that lists activities agree. Typed
 *  loosely so denormalised public-profile shapes can reuse it. */
export function compareActivities(
  a: { order?: number | null; name?: string },
  b: { order?: number | null; name?: string },
): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  return (a.name ?? '').localeCompare(b.name ?? '')
}

export interface ActivityPublicProfile {
  teamId: string
  name: string
  description?: string
  slug: string
  color?: string
  image_url?: string
  /** Denormalised display order so public consumers sort identically to admin. */
  order?: number
  /** Denormalised access gate so booking UIs can render lock state and rules can gate. */
  accessRule?: ActivityAccessRule
  /** Denormalised drop-in config so the booking UI can offer pay-per-class. */
  dropIn?: { enabled: boolean; priceAmount?: number }
  /** CLASS-ONLY. Mirrored so the public flow can OFFER the newcomer trial door
   *  on a gated class ("even when members-only") — present only when true. */
  trialEnabled?: boolean
  /** CLASS-ONLY. Major units, team `default_currency`. Absent/null ⇒ the trial is
   *  FREE (today's behaviour — untouched). A number ⇒ the trial costs that instead
   *  of nothing. Mirrored only when `trialEnabled === true` and the value is a
   *  number — see `Activity.trialPriceAmount`. */
  trialPriceAmount?: number | null
  /** CLASS-ONLY. Mirrored so the public booking flow can offer "join the
   *  waitlist" on a full slot — present only when true. The queue itself is
   *  never public; only this flag and the session's `waitlist_count` are. */
  waitlistEnabled?: boolean
  /** APPOINTMENT-ONLY. The duration menu with base prices so public cards can
   *  show "from CHF 45". Mirrored verbatim from `Activity.durations` — there's
   *  no per-contact data to strip any more (the old `subscriptionPricing`
   *  matrix is gone; see `ActivityDuration`'s history note). */
  durations?: Array<{ minutes: number; priceAmount: number | null; benefitOnly?: boolean }>
  /** Mirrored verbatim from `Activity.memberBenefit` (appointments AND class
   *  drop-in member rates) — public-safe, since the referenced
   *  subscription-type ids are already public in the shop. */
  memberBenefit?: ActivityMemberBenefit | Benefit
  /** APPOINTMENT-ONLY. Mirrored verbatim from `Activity.durationBenefits`, and
   *  public-safe for the same reason `memberBenefit` is. The public picker
   *  reads the pair through `resolveDurationBenefit`, so a tenant mirrored
   *  before this field existed keeps quoting from `memberBenefit` — this is
   *  additive, and no republish is owed before it is correct. */
  durationBenefits?: ActivityDurationBenefit[]
  /** Mirrored from `Activity.tags` — free-text display labels for the public
   *  booking cards. Present only when the activity has any. */
  tags?: string[]
  /** Denormalised display-only prerequisites for the public booking pages. */
  prerequisites?: string
  /** Denormalised verbatim from the matching `Activity` fields — see there for
   *  what each one means. All display-only. */
  meetingPoint?: string
  whatsIncluded?: string
  whatsNotIncluded?: string
  faq?: string
  /** Denormalised verbatim from `Activity.cancellationPolicy`. Public UIs fall
   *  back to the team-wide default when this is absent — see
   *  `TeamPublicProfile.bookingCancellationPolicy`. */
  cancellationPolicy?: string
  /** Mirrored verbatim from `Activity.bookingQuestions` so the public book form
   *  can render them. Public-safe: these are the questions, never the answers. */
  bookingQuestions?: FormField[]
  /** Mirrored verbatim from `Activity.contactFields`. Public-safe: it names
   *  fields, never values, and a custom field only renders when its definition
   *  also opted in (TeamPublicProfile.publicCustomFields). */
  contactFields?: BookingContactField[]
}

/** A book form is not a survey — keep it short enough that it doesn't cost the
 *  booking. Enforced in the activity editor. */
export const MAX_BOOKING_QUESTIONS = 6

/**
 * The book-form questions as they are STORED, from whatever the editor holds.
 *
 * Every key is written out rather than spread, because a patch that clears a
 * key by setting it to `undefined` — which is exactly what the editor's type
 * picker does when a question stops being a choice type — leaves the key
 * standing as an own property, and Firestore refuses an undefined value
 * outright (`addDoc() called with invalid data`). That killed the whole save,
 * not just the question. Enumerating the keys means only defined values can
 * reach the write, whoever built the array; a new `FormField` key belongs here
 * too, or it will silently stop being persisted.
 *
 * Half-written rows are dropped here as well: no label means nothing to ask,
 * and the public form must never render an unlabelled input.
 */
export function normalizeBookingQuestions(
  questions: FormField[] | null | undefined
): FormField[] {
  return (questions ?? [])
    .filter((q) => q?.label?.trim())
    .map((q, i) => ({
      id: q.id,
      type: q.type,
      label: q.label.trim(),
      required: q.required ?? false,
      order: i,
      ...(q.placeholder ? { placeholder: q.placeholder } : {}),
      ...(q.options?.length ? { options: q.options } : {}),
    }))
}

/** How many free-text labels one activity may carry. A row of chips is a
 *  glance, not a taxonomy. */
export const MAX_ACTIVITY_TAGS = 6

/** Longest single tag — a label, never a sentence. */
export const MAX_ACTIVITY_TAG_LENGTH = 24

/** THE ONE normaliser for `Activity.tags`, run by the editor and the public
 *  mirror alike: trim, drop empties, cap the length, dedupe
 *  case-insensitively (keeping the first spelling the studio typed) and cap the
 *  count. Free text collected on two surfaces diverges unless both narrow it
 *  the same way. */
export function normalizeActivityTags(input: readonly unknown[] | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input ?? []) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().slice(0, MAX_ACTIVITY_TAG_LENGTH).trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_ACTIVITY_TAGS) break
  }
  return out
}

/** Longest answer we'll persist per question. Generous for a free-text note,
 *  bounded so a book form can't be used to write arbitrary payloads. */
const MAX_ANSWER_LENGTH = 1000

/**
 * Narrow untrusted book-form answers to the activity's OWN questions.
 *
 * Answers arrive from a public, unauthenticated caller, so nothing here trusts
 * the shape: unknown field ids are dropped (the questions are the allow-list),
 * values are coerced to the type their question declares, and strings are
 * length-capped. Returns null when nothing survives, so callers can omit the
 * field entirely rather than writing an empty map.
 *
 * Shared by `bookSession` and `createDropInCheckout` so the free and paid paths
 * can never disagree about what got stored.
 */
export function sanitizeBookingAnswers(
  questions: FormField[] | null | undefined,
  answers: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!questions?.length || !answers || typeof answers !== 'object') return null

  const out: Record<string, unknown> = {}
  for (const q of questions) {
    const raw = answers[q.id]
    if (raw === undefined || raw === null || raw === '') continue

    if (q.type === 'checkbox') {
      out[q.id] = raw === true || raw === 'true'
      continue
    }
    if (q.type === 'multiple_choice') {
      const allowed = q.options ?? []
      const picked = (Array.isArray(raw) ? raw : [raw])
        .filter((v): v is string => typeof v === 'string')
        .filter((v) => allowed.includes(v))
      if (picked.length) out[q.id] = picked
      continue
    }
    if (q.type === 'single_choice' || q.type === 'dropdown') {
      // A choice answer that isn't one of the offered options is a spoofed
      // payload, not a typo — drop it rather than storing free text.
      if (typeof raw === 'string' && (q.options ?? []).includes(raw)) out[q.id] = raw
      continue
    }
    if (q.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (Number.isFinite(n)) out[q.id] = n
      continue
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim().slice(0, MAX_ANSWER_LENGTH)
      if (trimmed) out[q.id] = trimmed
    }
  }

  return Object.keys(out).length ? out : null
}

/** The subscription-type ids an access rule demands, or null when the rule doesn't
 *  gate on subscriptions at all (open/members). An empty array is a real (mis)config
 *  — a subscription-gated activity nobody can book — and is returned as-is. */
export function activityRequiresSubscription(
  accessRule: ActivityAccessRule | null | undefined,
): string[] | null {
  if (!accessRule || accessRule.type !== 'subscription') return null
  return accessRule.subscriptionTypeIds ?? []
}

// Structural subset of Contact the coverage check reads — typed loosely so it
// accepts full Contact docs, denormalised snapshots, and test fixtures alike.
export interface SubscriptionCoverageSnapshot {
  subscription_type_id?: string | null
  subscription_expires_at?: { toMillis(): number } | null
  active_subscriptions?: Array<{ subscription_type_id?: string | null }> | null
  credit_summary?: Array<{
    subscription_type_id?: string | null
    remaining?: number
    next_expires_at?: { toMillis(): number } | null
  }> | null
}

/**
 * THE ONE PREDICATE for "does the contact's flat plan grant still cover her".
 *
 * A one-time price with `included_months` ("CHF 100, 2 months included") is the
 * only thing that sets an end date, because it is the only plan grant with no
 * renewal to end it. Absent stamp = no end, which keeps every pre-existing
 * document, every manual assignment and every recurring subscription behaving
 * exactly as before.
 *
 * Deliberately shaped like the credit-pack expiry two lines below it, because it
 * is the same idea: the ledger states a date, and every reader compares. Nothing
 * writes when the date passes — so never ask whether the field is PRESENT, ask
 * this function. It applies ONLY to the flat `subscription_type_id`;
 * `active_subscriptions` is a mirror of live Stripe subscriptions and removes
 * its own entries when they lapse.
 */
export function planGrantIsCurrent(
  contact: Pick<SubscriptionCoverageSnapshot, 'subscription_expires_at'> | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const at = contact?.subscription_expires_at
  return !at || at.toMillis() > nowMs
}

/**
 * When a purchase of this price stops covering the member, as epoch ms — or null
 * for "no end of its own". THE ONE rule, in epoch ms rather than any SDK's
 * Timestamp so the server, the client and the seeds all compute the same instant
 * and each wraps it in its own type.
 *
 * ONE-TIME PRICES ONLY. `included_months` on a recurring price would be a
 * contradiction: a subscription's end is Stripe's to say, and a second end date
 * stamped beside it would cut off a member who is still paying. A one-time price
 * with no `included_months` means exactly what it says — bought once, no end (a
 * lifetime membership, or a credit pack whose real limit is the credits, which
 * carry their own expiry).
 */
export function planGrantExpiryMs(
  price:
    | { recurrence?: string | null; included_months?: number | null }
    | null
    | undefined,
  nowMs: number = Date.now()
): number | null {
  if (!price || price.recurrence !== 'one_time') return null
  const months = price.included_months
  if (typeof months !== 'number' || months <= 0) return null
  const d = new Date(nowMs)
  d.setMonth(d.getMonth() + months)
  return d.getTime()
}

/** The subscription-type ids a contact currently "holds" for coverage purposes:
 *  live subscriptions in `active_subscriptions`, the primary `subscription_type_id`
 *  snapshot while its grant is still current, and non-exhausted, non-expired
 *  lesson-credit balances. Mirrors the coverage union in the bookSession callable
 *  (which stays authoritative — it additionally SPENDS credits). */
export function heldSubscriptionTypeIds(
  contact: SubscriptionCoverageSnapshot | null | undefined,
  nowMs: number = Date.now(),
): string[] {
  if (!contact) return []
  const held = new Set<string>()
  for (const s of contact.active_subscriptions ?? []) {
    if (s.subscription_type_id) held.add(s.subscription_type_id)
  }
  if (contact.subscription_type_id && planGrantIsCurrent(contact, nowMs)) {
    held.add(contact.subscription_type_id)
  }
  for (const e of contact.credit_summary ?? []) {
    if (!e.subscription_type_id) continue
    if ((e.remaining ?? 0) <= 0) continue
    if (e.next_expires_at && e.next_expires_at.toMillis() <= nowMs) continue
    held.add(e.subscription_type_id)
  }
  return Array.from(held)
}

/** Read-only "is this contact covered for these subscription types" check, shared by
 *  the admin session UI, the roster badges, and the member-facing booking warning. */
export function contactHoldsCoveringSubscription(
  contact: SubscriptionCoverageSnapshot | null | undefined,
  subscriptionTypeIds: string[] | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!contact || !subscriptionTypeIds?.length) return false
  const held = new Set(heldSubscriptionTypeIds(contact, nowMs))
  return subscriptionTypeIds.some((id) => held.has(id))
}
