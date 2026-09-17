import type { SaasPlan } from './team'

// Ordered from lowest to highest — used for >= comparisons
export const PLAN_ORDER: SaasPlan[] = ['free', 'coach', 'studio', 'organization']

// Trial: new self-service teams start on a full-access Studio trial
// of this length. NOTE: plan IDs are stable machine identifiers — display names
// live in the `Plans` i18n namespace, see usePlanName().
// The trial is a flat 30 days with no opt-in extension (the old 14-day +
// one-time extension model was retired in the 2026-06 pricing overhaul).
export const TRIAL_DAYS = 30
// When the trial lapses the team is downgraded to the Free plan (see
// handleTrialLifecycle); there is no wall or data purge.

// An ORGANISATION's trial (createOrganization). Separate constant, same length
// today: the org tier is sales-led and its setup is operator-assisted, so the
// number is expected to move independently of a self-service team's. It was 14
// while nothing ended it at all — the sweep that ends it (handleTrialLifecycle,
// phase 2) arrived with this constant.
//
// THE LENGTH IS A DEFAULT, NOT A COUNTDOWN. Both sweeps read the stored
// `trial_ends_at` and never recompute it from `created`, so an operator
// onboarding a customer by hand extends a trial by editing that one field.
// `flags.internal` / `flags.pilot` on the entity exempt it from the sweep
// entirely.
export const ORG_TRIAL_DAYS = 30

// Base subscription pricing per plan. Declarative source for scripts/stripe-sync.ts
// (the whole Stripe catalogue — plans + add-ons — lives in the repo).
// Amounts are INDICATIVE base prices in CHF/month; the authoritative amount is the
// Stripe Price for the lookup key. `stripe:sync` only *creates* missing prices —
// it never repriced an existing one unless run with --reprice.
// Lookup-key convention matches the gateway: `linyup_<plan>_monthly`.
export interface PlanPrice {
  baseMonthly: number
  /** null = the plan is never billed (free) and stripe:sync skips it. */
  stripeLookupKey: string | null
  /**
   * Included contacts. The cap counts ACTIVE (non-archived) contacts only —
   * archived contacts never count and are auto-anonymised after 2 years (see
   * the retention policy). The cap is acquisition-stage-neutral: a contact at any
   * stage (trial_booked / trial_attended / joined) counts the same — `archived_at`
   * is the sole input. null = unlimited (organisation). Over-cap behaviour is
   * per-tier and carries NO per-contact charge — see `contactOverageForPlan`.
   */
  includedContacts: number | null
}

export const PLAN_PRICING: Record<SaasPlan, PlanPrice> = {
  free: { baseMonthly: 0, stripeLookupKey: null, includedContacts: 50 },
  coach: {
    baseMonthly: 9,
    stripeLookupKey: 'linyup_coach_monthly',
    includedContacts: 150,
  },
  studio: {
    baseMonthly: 35,
    stripeLookupKey: 'linyup_studio_monthly',
    includedContacts: 300,
  },
  // Organisation has NO fixed price and NO base fee — it is priced PER STUDIO
  // (ORG_PER_STUDIO). `baseMonthly: 0` is the honest value rather than a
  // placeholder, and `stripeLookupKey: null` follows from it: a base fee of zero
  // has no price to bill, so the catalogue creates none and the org's whole
  // subscription is the per-studio line at quantity = studios.
  //
  // Anything reading `baseMonthly` to render "the price of this tier" is WRONG
  // for this one. Use `orgMonthlyForStudios`.
  organization: {
    baseMonthly: 0,
    stripeLookupKey: null,
    includedContacts: null,
  },
}

// Free has no payment method to bill against, so its contact cap is HARD:
// manual contact creation is blocked at the limit (public bio-link submissions
// still land — the breach is the upgrade prompt). Paid tiers are never
// hard-blocked; they get a tier-specific over-cap prompt (contactOverageForPlan).
export function planHasHardContactCap(plan: SaasPlan | null): boolean {
  return plan === 'free'
}

// ─── Search-engine indexability of a team's PUBLIC pages ──────────────────────
// Documents is a default feature on every tier, public pages included, so every
// self-service signup now gets a publishing surface on a Linyup domain. That is
// an SEO-spam and reputation vector: sign up, publish keyword pages, borrow the
// domain's standing.
//
// The mitigation gates INDEXABILITY, not existence. The page works for everyone —
// a Free studio's terms are readable and shareable by link and QR exactly as
// before — it simply carries `noindex` until somebody is paying. Nothing has to
// be withdrawn later, which is the property that made de-gating completely safe
// to choose.
//
// A TRIAL IS NOT A PAID TIER, and this is the half that is easy to get wrong:
// self-service signups are provisioned `plan: 'studio', plan_status: 'trial'`
// (TRIAL_DAYS above), so keying on the plan alone would leave the vector wide
// open for 30 days per throwaway account — and a spammer only needs the page
// crawled once. Paying is the signal, so `plan_status` must be settled too.
//
// A lapsed trial reports its stored plan until the nightly cron writes
// `plan: 'free'`; `status === 'expired'` is therefore refused explicitly rather
// than left to the plan field.
export function publicPagesIndexable(team: {
  plan?: SaasPlan | null
  plan_status?: string | null
}): boolean {
  const plan = team.plan ?? 'free'
  const status = team.plan_status ?? 'trial'
  if (plan === 'free') return false
  return status === 'active'
}

// ─── Over-cap behaviour (NO per-contact metering) ───────────────────────────────
// When a team exceeds includedContacts the response depends on the tier — there
// is no per-head overage charge:
//   free   → hard cap, prompt to upgrade (planHasHardContactCap).
//   coach  → prompt to upgrade to Studio (grown past a solo coach).
//   studio → buy optional +N-contact blocks (STUDIO_CONTACT_BLOCK) for more
//            room, or upgrade to Organisation. Never hard-blocked mid-month.
//   org    → unlimited.
export interface ContactBlock {
  /** Contacts added per block. */
  size: number
  /** Flat CHF/month per block. */
  monthly: number
  /** Stripe Price lookup key (provisioned by scripts/stripe-sync.ts). */
  stripeLookupKey: string
}

/** Studio add-on: buy room in predictable flat blocks, not per-head. */
export const STUDIO_CONTACT_BLOCK: ContactBlock = {
  size: 300,
  monthly: 10,
  stripeLookupKey: 'linyup_studio_contact_block_monthly',
}

// ─── Organisation pricing: A FLAT RATE PER STUDIO ───────────────────────────────
//
// CHF 25 per studio per month, from 2 studios to 10. Above ten the number is
// quoted rather than listed, and that is a FOURTH STATE OF THE SAME TIER, not a
// hidden premium plan: the rate is still per studio and the answer is still a
// quick quote (Franco, 2026-08-28).
//
// ── "FROM CHF 25" IS WRONG AND IS THE MISTAKE THIS REPLACED ─────────────────
// The rate is FLAT — not tiered, not volume-discounted, no base fee — so "from"
// would describe a price that climbs with size, which is the opposite of what
// this is. The tier used to carry a CHF 79 base plus CHF 12 per studio and was
// published as "From CHF 103"; both the base fee and that framing are gone.
// `orgPriceFrom()` was deleted rather than renamed, so nothing can keep the old
// reading by accident.
//
// The base fee existed to stop unrelated studios grouping up to undercut the
// Studio tier. Nothing in code replaces it: eligibility (common ownership, or a
// single federating body) was always a sales judgement and still is.
//
// Stripe bills ONE recurring item — ORG_PER_STUDIO at quantity = studios. There
// is no base price any more, which is why PLAN_PRICING.organization carries a
// null lookup key.
export const ORG_MIN_STUDIOS = 2

/** Above this, the price is quoted rather than listed — see `orgNeedsQuote`. */
export const ORG_MAX_LISTED_STUDIOS = 10

export const ORG_PER_STUDIO: { monthly: number; stripeLookupKey: string } = {
  monthly: 25,
  stripeLookupKey: 'linyup_organization_studio_monthly',
}

/**
 * Monthly total for an organisation with `studios` studios.
 *
 * The minimum is enforced because the tier does not exist below it; the MAXIMUM
 * deliberately is not, so a caller that asks about 14 studios gets the honest
 * arithmetic rather than the 10-studio price. Whether to SHOW a number is
 * `orgNeedsQuote`'s decision, and keeping the two apart is what lets the quote
 * state still say "still CHF 25 per studio" truthfully.
 */
export function orgMonthlyForStudios(studios: number): number {
  const n = Math.max(ORG_MIN_STUDIOS, Math.floor(studios) || 0)
  return n * ORG_PER_STUDIO.monthly
}

/** Is this size past the listed range — i.e. quoted rather than published? */
export function orgNeedsQuote(studios: number): boolean {
  return studios > ORG_MAX_LISTED_STUDIOS
}

export type ContactOverage =
  | { kind: 'hard' } // free: blocked, upgrade
  | { kind: 'upgrade'; to: SaasPlan } // coach: prompt next tier
  | { kind: 'block'; block: ContactBlock } // studio: buy blocks (or upgrade)
  | { kind: 'unlimited' } // organisation

export function contactOverageForPlan(plan: SaasPlan | null): ContactOverage {
  switch (plan) {
    case 'coach':
      return { kind: 'upgrade', to: 'studio' }
    case 'studio':
      return { kind: 'block', block: STUDIO_CONTACT_BLOCK }
    case 'organization':
      return { kind: 'unlimited' }
    default:
      return { kind: 'hard' } // free / unknown
  }
}

// ─── Contact usage (cap meter) ──────────────────────────────────────────────────
// Usage is tracked and surfaced in the UI. Counting basis is ACTIVE
// (non-archived, non-deleted) contacts; archived contacts never count. What the
// app does at/over the cap is tier-specific (contactOverageForPlan) — only Free
// hard-blocks.

export interface ContactUsage {
  used: number
  included: number | null // null = unlimited
  isUnlimited: boolean
  remaining: number | null
  overBy: number
  atOrOverLimit: boolean
  percent: number // 0..100 for the meter (clamped)
}

export function contactUsageForPlan(plan: SaasPlan | null, used: number): ContactUsage {
  const included = plan ? PLAN_PRICING[plan].includedContacts : null
  if (included == null) {
    return {
      used,
      included: null,
      isUnlimited: true,
      remaining: null,
      overBy: 0,
      atOrOverLimit: false,
      percent: 0,
    }
  }
  return {
    used,
    included,
    isUnlimited: false,
    remaining: Math.max(0, included - used),
    overBy: Math.max(0, used - included),
    atOrOverLimit: used >= included,
    percent: included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 100,
  }
}

export type PlanFeature =
  // Coach
  | 'contacts'
  | 'sessions'
  | 'public_booking'
  | 'qr_checkin'
  | 'public_profile'
  | 'signup_forms'
  | 'basic_dashboard'
  | 'basic_alerts'
  | 'subscriptions'
  | 'payment_tracking'
  | 'goals'
  | 'appointments'
  | 'custom_domain'
  // Studio
  | 'member_app'
  | 'gamification'
  | 'outreach_templates'
  | 'automation_flows'
  | 'advanced_alerts'
  | 'advanced_dashboard'
  | 'multiple_managers'
  | 'referral_program'
  | 'courses'
  // Organization
  | 'multi_team'
  | 'central_admin'
  | 'unified_data'
  | 'cross_team_events'
  | 'cross_team_messaging'
  | 'api_access'
  | 'advanced_permissions'

/**
 * The refusal a member-adding callable throws when the team's plan has no
 * `multiple_managers`. A STABLE CODE, shared so the client can map it to
 * localized copy instead of showing the server's English — and shared in BOTH
 * directions, so renaming it here breaks the reader rather than silencing it.
 *
 * Thrown by every server seam that can put a SECOND user on a team
 * (`sendTeamInvitation`, `acceptTeamInvitation`, `manageTeamMember` action
 * 'add'); never by anything that manages the people already there — the gate is
 * on adding, not on being.
 */
export const MULTIPLE_USERS_PLAN_REFUSAL = 'multiple-users-plan-required'

// NOTE: features delivered by plugins (gamification, referral_program, courses)
// are now gated by plugin INSTALL state, not these flags — see
// pluginAccessForPlan + useInstalledPlugins. The flags remain for reference /
// non-UI logic; do not re-introduce feature-flag gates for plugin features.
export const PLAN_FEATURES: Record<SaasPlan, PlanFeature[]> = {
  // Free = the full Coach feature set. The tier is differentiated by limits
  // (a hard contact cap — see PLAN_PRICING.free.includedContacts — single user,
  // no plugin add-ons, bio-link branding), not by feature flags.
  free: [
    'contacts',
    'sessions',
    'public_booking',
    'qr_checkin',
    'public_profile',
    'signup_forms',
    'basic_dashboard',
    'basic_alerts',
    'subscriptions',
    'payment_tracking',
    'goals',
    'appointments',
  ],
  coach: [
    'contacts',
    'sessions',
    'public_booking',
    'qr_checkin',
    'public_profile',
    'signup_forms',
    'basic_dashboard',
    'basic_alerts',
    'subscriptions',
    'payment_tracking',
    'goals',
    'appointments',
    'custom_domain',
    // The member app is available from Coach up (a basic booking/check-in portal
    // on Coach, enriched by add-ons). Never offered on Free. (2026-06 overhaul.)
    // NOTE: this feature flag is what `loginContactWithCode` checks (mobile
    // client only) to decide whether a contact's team even offers the app —
    // see memberAppAccessForPlan in auth/loginContactWithCode.ts.
    'member_app',
  ],
  studio: [
    'contacts',
    'sessions',
    'public_booking',
    'qr_checkin',
    'public_profile',
    'signup_forms',
    'basic_dashboard',
    'basic_alerts',
    'subscriptions',
    'payment_tracking',
    'goals',
    'appointments',
    'custom_domain',
    'member_app',
    'gamification',
    'outreach_templates',
    'automation_flows',
    'advanced_alerts',
    'advanced_dashboard',
    'multiple_managers',
    'referral_program',
    'courses',
    // API access is available from Studio up (2026-06). NOTE: this is currently a
    // declarative flag only — the API itself is not built yet, so there is no
    // runtime gate to relax; minimumPlanForFeature('api_access') now returns 'studio'.
    'api_access',
  ],
  organization: [
    'contacts',
    'sessions',
    'public_booking',
    'qr_checkin',
    'public_profile',
    'signup_forms',
    'basic_dashboard',
    'basic_alerts',
    'subscriptions',
    'payment_tracking',
    'goals',
    'appointments',
    'custom_domain',
    'member_app',
    'gamification',
    'outreach_templates',
    'automation_flows',
    'advanced_alerts',
    'advanced_dashboard',
    'multiple_managers',
    'referral_program',
    'courses',
    'multi_team',
    'central_admin',
    'unified_data',
    'cross_team_events',
    'cross_team_messaging',
    'api_access',
    'advanced_permissions',
  ],
}

// ─── Plugin packaging ─────────────────────────────────────────────────────────
// Studio/Org include all internal plugins. Coach can activate a curated subset
// (plugins with an `addon`) as paid monthly add-ons; non-curated plugins are
// upgrade-locked for coaches. See docs/product-strategy.md → "Plugin add-ons (Coach plan)".

export type PluginAccess =
  | { kind: 'included' }
  | { kind: 'addon'; priceMonthly: number }
  | { kind: 'upgrade'; minPlan: SaasPlan }

// Minimal shape needed to decide access — satisfied by PluginManifest.
interface PluginAccessInput {
  minPlan: SaasPlan
  addon?: { coachPriceMonthly: number; stripeLookupKey: string }
}

export function pluginAccessForPlan(
  manifest: PluginAccessInput,
  plan: SaasPlan | null
): PluginAccess {
  if (plan === 'studio' || plan === 'organization') return { kind: 'included' }
  if (plan === 'free') {
    // Plugins explicitly available from Free (minPlan 'free', no paid add-on)
    // install client-side at no charge — e.g. Documents (core operational docs
    // like terms/privacy that every studio needs). Everything else is upgrade-
    // locked: Free has no billing relationship to charge add-ons against.
    if (!manifest.addon && manifest.minPlan === 'free') return { kind: 'included' }
    return { kind: 'upgrade', minPlan: 'coach' }
  }
  // Coach (or unknown/trialing coach):
  //  • plugins standard from Coach (minPlan ≤ coach, no paid add-on) → included
  //    (e.g. Contact Groups, Custom Fields — de-pettified in the 2026-06 pricing
  //    overhaul; they install client-side with no charge).
  //  • curated paid add-ons → addon (Website, Online Courses, Products,
  //    Gamification, Referral).
  //  • Studio-only plugins → upgrade.
  if (!manifest.addon && planIsAtLeast('coach', manifest.minPlan)) return { kind: 'included' }
  if (manifest.addon) return { kind: 'addon', priceMonthly: manifest.addon.coachPriceMonthly }
  return { kind: 'upgrade', minPlan: manifest.minPlan }
}

export function planIsAtLeast(current: SaasPlan, minimum: SaasPlan): boolean {
  return PLAN_ORDER.indexOf(current) >= PLAN_ORDER.indexOf(minimum)
}

export function planHasFeature(plan: SaasPlan, feature: PlanFeature): boolean {
  return PLAN_FEATURES[plan].includes(feature)
}

// The minimum plan required for a given feature
export function minimumPlanForFeature(feature: PlanFeature): SaasPlan {
  for (const plan of PLAN_ORDER) {
    if (PLAN_FEATURES[plan].includes(feature)) return plan
  }
  return 'organization'
}

// Affiliations (the belonging axis: club / federation licence / grading) are an
// opt-in surface for Verein-structured and licence-bound clubs. Available from the
// Studio tier up, off by default per team (see Team.affiliations_enabled). Phase 2.
export function planSupportsAffiliations(plan: SaasPlan | null): boolean {
  return plan === 'studio' || plan === 'organization'
}
