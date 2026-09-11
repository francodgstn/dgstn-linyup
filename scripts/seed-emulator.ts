/**
 * Seed script for the Firebase emulator.
 *
 * Usage (emulators must be running first):
 *   pnpm seed
 *
 * What it creates:
 *   Three plan-tier accounts, each with full data:
 *
 *   coach@linyup.com  / linyup123  →  plan: coach  (trial)
 *   studio@linyup.com   / linyup123  →  plan: studio (active)
 *   org@linyup.com    / linyup123  →  plan: organization (active)
 *
 *   Per team:
 *   - 4 group-class activities + 1 appointment activity (type='appointment')
 *   - 36 group-class sessions (past + upcoming) + 3 BOOKED appointment sessions
 *     (availability is availability-only — nothing exists until a client books)
 *   - 1 availability doc per team ('range' mode: Mon+Wed 08:00–11:00)
 *   - 18 contacts, 3 events, 4 group bookings + 3 appointment bookings
 *   - Past-session participants, weekly reports, goals, contact alerts
 *   - A team activity feed and a year of team weekly reports, so /dashboard
 *     opens on a populated feed and real trend lines rather than flat ones
 *
 *   Studio + Org tiers (gamification is off on coach, and automations are a
 *   Studio feature):
 *   - Gamification plugin + 4 months of monthly scores per attending contact
 *   - Automations: outreach templates, alert presets, rules and run logs
 *
 *   Studio tier only:
 *   - Online Courses plugin installed + 4 courses with modules and
 *     text/audio/video lessons, spanning every access tier:
 *       • "BJJ Fundamentals"  → published, free (anonymous Space access)
 *       • "Competition Game Plan" → published, registered (sign-in required)
 *       • "Inside the Black Belt Curriculum" → published, subscription
 *         (Premium/Elite only — e.g. contact 2, Premium annual)
 *       • "Strength & Conditioning for Fighters" → draft
 *     Published courses also get a courses/{id}/public_profile/{id} summary.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * PRICED SURFACES need a Stripe TEST connected account.
 *
 *   `TeamPublicProfile.payments_enabled` fails CLOSED (UX-33), so a seed with no
 *   connected account behind it shows NO shop, NO drop-in price, NO priced trial
 *   and NO priced appointment duration. That is the honest state, not a bug, and
 *   it is what you get out of the box.
 *
 *   To get priced doors (and a checkout that actually completes), export an
 *   already-onboarded Stripe TEST account id before seeding:
 *
 *     export STRIPE_CONNECT_TEST_ACCOUNT=acct_123        # → seed-team-studio
 *     export STRIPE_CONNECT_TEST_ACCOUNT=acct_123,acct_456   # → studio, then org
 *
 *   ONE account backs exactly ONE team (see scripts/lib/connect.ts for why, and
 *   for the one-time onboarding walk-through). Unset ⇒ silent skip: no error, one
 *   warning line at the end of the run.
 */

// emulator env vars must be set BEFORE admin.initializeApp().
// Pre-set values win so the script can seed an alternate-port suite
// (parallel worktree dev).
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= 'localhost:9099'
process.env.FIRESTORE_EMULATOR_HOST ??= 'localhost:8080'

import admin from 'firebase-admin'
import {
  APP_SETTINGS_COLLECTION,
  PUBLIC_SETTINGS_DOC,
  DEFAULT_PAYMENT_MODES,
  DEFAULT_KIOSK_CONFIG,
  PLAN_PRICING,
  toKioskPublicConfig,
  normalizeActivityTags,
  // Taken from the shared constant rather than hand-copied, so the seeded rule
  // stays the same rule onTeamCreated provisions.
  TRIAL_CLEANUP_RULE,
  withRankLevelIds,
} from '@linyup/shared'
// The document/version/mirror writer moved to lib/fixtures/documents.ts, and the
// sanitizer + hasher moved with it — a stored fingerprint must not depend on
// which of four seeders wrote it.
import {
  CONTACT_AFFILIATIONS_SUBCOLLECTION,
  AFFILIATION_TYPES_SUBCOLLECTION,
  ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
  DEFAULT_ORG_AFFILIATION_STATUSES,
  orgAffiliationTypes,
  teamAffiliationTypes,
  buildAffiliationDoc,
  buildAffiliationSummary,
  type AffiliationSummaryInput,
  statusCountsAsActive,
  type SeedAffiliationType,
} from './lib/affiliations'
import {
  buildStorefrontPageLinks,
  buildBasicPageLinks,
  seedStoreProducts,
  seedStorePromoCode,
  seedStoreWebsite,
  seedStoreCourses,
} from './lib/storefront'
import { memberCapsFor, COACH_DEFAULT_CAPABILITIES } from './lib/roles'
import {
  planSeedConnectAccounts,
  linkSeedConnectAccount,
  reportSeedConnectAccounts,
} from './lib/connect'
import {
  appointmentOccurrences,
  buildAppointmentSessionDocs,
  buildAppointmentBookingDoc,
} from './lib/appointments'
import {
  seedDocumentsSettings,
  seedTeamWaiver,
} from './lib/fixtures/documents'
import {
  seedAutomations,
  seedContactAlerts,
  seedMonthlyScores,
} from './lib/fixtures/automations'
import {
  seedContactNotes,
  seedCoursePurchase,
  seedDynamicContactGroup,
  seedEventProgram,
  seedSessionWaitlist,
} from './lib/fixtures/engagement'
import { seedTeamMoney, seedTeamSales } from './lib/fixtures/money'
import { seedTeamSubscriptionHistory } from './lib/fixtures/subscriptionHistory'
import { seedTeamFinance } from './lib/fixtures/finance'
import { seedTeamAssetRegister } from './lib/fixtures/assetRegister'
import { partnerAppNames } from './lib/partnerApps'
import { printMemberAppLogin, seedMobileSettings, seedReviewTenant } from './lib/mobile'

admin.initializeApp({ projectId: 'demo-linyup' })

const auth = admin.auth()
const db = admin.firestore()

// ── helpers ───────────────────────────────────────────────────────────────────

const ts = (date: Date) => admin.firestore.Timestamp.fromDate(date)

function daysFromNow(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

// Deterministic pseudo-random in [0,1) from a string seed — keeps reruns stable.
function seededRand(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

// Marketing-channel sources (excludes 'walk_in' — that's an entry, not a channel,
// and 'import', which is reserved for migrated contacts).
const SEED_SOURCES = ['website', 'referral', 'social', 'event', 'other'] as const

// Pick a deterministic marketing source for a seeded contact.
function pickSource(seed: string): (typeof SEED_SOURCES)[number] {
  return SEED_SOURCES[Math.floor(seededRand(seed + 'src') * SEED_SOURCES.length)]
}

// Derive the acquisition-axis fields written to a contact doc from the seed's
// authoring `type` + whether the contact has attended a session. The old `type`
// field is intentionally NOT returned — it must not be written to the doc.
//   student  → joined  / entry 'signup' / converted_at
//   external → joined  / entry 'import' + 'external' tag
//   trial    → trial_attended (if attended) | trial_booked (no-show), entry 'booking'
function acquisitionFieldsFor(opts: {
  type: 'student' | 'trial' | 'external'
  hasAttended: boolean
  milestoneTs: admin.firestore.Timestamp
  seed: string
}): Record<string, unknown> {
  const { type, hasAttended, milestoneTs, seed } = opts
  const out: Record<string, unknown> = {
    acquisition_stage_updated_at: milestoneTs,
    source: pickSource(seed),
  }
  if (type === 'student') {
    out.acquisition_stage = 'joined'
    out.entry = 'signup'
    out.converted_at = milestoneTs
  } else if (type === 'external') {
    out.acquisition_stage = 'joined'
    out.entry = 'import'
    out.converted_at = milestoneTs
  } else {
    out.entry = 'booking'
    if (hasAttended) {
      out.acquisition_stage = 'trial_attended'
      out.trial_attended_at = milestoneTs
    } else {
      out.acquisition_stage = 'trial_booked'
      out.lead_acknowledged = false // freshly-booked no-show lead
    }
  }
  return out
}

function hoursOffset(base: Date, hours: number) {
  return new Date(base.getTime() + hours * 3_600_000)
}

function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`
}

function mondayOfWeeksAgo(n: number): Date {
  const d = new Date()
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1) - n * 7)
  d.setHours(0, 0, 0, 0)
  return d
}

// Project a current-snapshot count map back onto an earlier week. The team's
// weekly reports are a HISTORY the dashboard trends read; there is nothing to
// recompute them from, so the seed walks today's aggregates backwards.
function scaleMap(map: Record<string, number>, factor: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(map)) out[k] = Math.max(0, Math.round(v * factor))
  return out
}

// Wipe via the same hosts the admin SDK was pointed at (above) — hardcoding the
// default ports here would clear the DEFAULT-port suite while seeding an
// alternate-port one, i.e. silently destroy a parallel worktree's data.
async function clearEmulator() {
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-linyup/databases/(default)/documents`,
    { method: 'DELETE' }
  ).catch(() => {})
  await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/demo-linyup/accounts`,
    { method: 'DELETE' }
  ).catch(() => {})
}

// Which seed teams belong to which org. seedOrg() links these later, but seedTeam
// runs first and needs to know the org up front to seed affiliations + flags.
// Keep in sync with seedOrg() (CLUB_A / CLUB_B).
const TEAM_ORG: Record<string, string> = {
  'seed-team-studio': 'seed-org',
  'seed-team-org': 'seed-org',
}

// ── per-team seed ─────────────────────────────────────────────────────────────

async function seedTeam(opts: {
  uid: string
  email: string
  displayName: string
  teamId: string
  teamName: string
  teamSlug: string
  plan: 'coach' | 'studio' | 'organization'
  planStatus: 'trial' | 'active'
  accentColor: string
}) {
  const { uid, email, displayName, teamId, teamName, teamSlug, plan, planStatus, accentColor } =
    opts

  // ── affiliation config ───────────────────────────────────────────────────────
  // Studio/Org demo teams enable the affiliation axis. Org-linked teams issue
  // affiliations at the ORG level (federation licence + club); standalone studios
  // issue a team-local club membership. Coach plan stays single-surface (no axis).
  const teamOrgId = TEAM_ORG[teamId]
  const affiliationsEnabled = plan === 'studio' || plan === 'organization'
  const affiliationTypeDefs: SeedAffiliationType[] = affiliationsEnabled
    ? teamOrgId
      ? orgAffiliationTypes(teamOrgId)
      : teamAffiliationTypes()
    : []
  // Pick the 'club' type as the contact-affiliation type (org has it at order 1).
  const clubAffiliationType = affiliationTypeDefs.find((t) => t.key === 'club') ?? null

  // ── plan-tier config ─────────────────────────────────────────────────────────

  // Subscription types — vary by plan. Studio/Org use named tiers (Starter /
  // Premium / Elite) where each tier carries multiple prices (monthly + annual).
  // Coach keeps a simpler single-price structure.
  type SeedRecurrence = 'per_class' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual'
  type SeedPrice = { id: string; amount: number; recurrence: SeedRecurrence }
  type SeedSubType = {
    id: string
    name: string
    description: string
    source: string
    prices: SeedPrice[]
    active: boolean
    /** Usage limit (Phase D), e.g. Starter's real "3 classes per week". */
    limits?: { count: number; per: 'day' | 'week' | 'month' }[]
    /** Aggregator payout per attended visit (E1), source:'aggregator' only. */
    payoutPerVisit?: number
  }
  const subscriptionTypeDefs: SeedSubType[] =
    plan === 'coach'
      ? [
          {
            id: `${teamId}-sub-monthly`,
            name: 'Monthly Membership',
            description: 'Unlimited classes, billed monthly.',
            source: 'internal',
            prices: [{ id: `${teamId}-sub-monthly-price`, amount: 95, recurrence: 'monthly' }],
            active: true,
          },
          {
            id: `${teamId}-sub-10class`,
            name: '10-Class Pack',
            description: 'Pre-paid block of 10 sessions.',
            source: 'internal',
            prices: [{ id: `${teamId}-sub-10class-price`, amount: 180, recurrence: 'per_class' }],
            active: true,
          },
        ]
      : plan === 'studio'
        ? [
            {
              id: `${teamId}-sub-starter`,
              name: 'Starter',
              description: 'Essential access — up to 3 group classes per week.',
              source: 'internal',
              prices: [
                { id: `${teamId}-sub-starter-monthly`, amount: 89, recurrence: 'monthly' },
                { id: `${teamId}-sub-starter-annual`, amount: 890, recurrence: 'annual' },
              ],
              // Enforced by the Phase D usage-limit window counters.
              limits: [{ count: 3, per: 'week' }],
              active: true,
            },
            {
              id: `${teamId}-sub-premium`,
              name: 'Premium',
              description: 'Unlimited group classes and open-mat access.',
              source: 'internal',
              prices: [
                { id: `${teamId}-sub-premium-monthly`, amount: 139, recurrence: 'monthly' },
                { id: `${teamId}-sub-premium-annual`, amount: 1390, recurrence: 'annual' },
              ],
              active: true,
            },
            {
              id: `${teamId}-sub-elite`,
              name: 'Elite',
              description: 'All-inclusive — unlimited classes, coaching sessions, and priority booking.',
              source: 'internal',
              prices: [
                { id: `${teamId}-sub-elite-monthly`, amount: 189, recurrence: 'monthly' },
                { id: `${teamId}-sub-elite-annual`, amount: 1890, recurrence: 'annual' },
              ],
              active: true,
            },
            {
              id: `${teamId}-sub-fitpass`,
              name: 'FitPass Partner',
              description: 'Access via FitPass aggregator network.',
              source: 'aggregator',
              prices: [],
              // What FitPass pays the studio per attended visit (E1 — drives
              // the partner_visits payout ledger).
              payoutPerVisit: 18,
              active: true,
            },
            {
              id: `${teamId}-sub-sportpass`,
              name: 'SportPass',
              description: 'Access via SportPass membership card.',
              source: 'aggregator',
              prices: [],
              payoutPerVisit: 15,
              active: true,
            },
          ]
        : [
            {
              id: `${teamId}-sub-starter`,
              name: 'Starter',
              description: 'Essential access — up to 3 group classes per week.',
              source: 'internal',
              prices: [
                { id: `${teamId}-sub-starter-monthly`, amount: 99, recurrence: 'monthly' },
                { id: `${teamId}-sub-starter-annual`, amount: 990, recurrence: 'annual' },
              ],
              // The description is now REAL: enforced by the usage-limit window
              // counters (Phase D) — 4th booking in a week falls to the drop-in
              // pay path (at the member rate, where one is configured).
              limits: [{ count: 3, per: 'week' }],
              active: true,
            },
            {
              id: `${teamId}-sub-premium`,
              name: 'Premium',
              description: 'Unlimited group classes and open-mat access.',
              source: 'internal',
              prices: [
                { id: `${teamId}-sub-premium-monthly`, amount: 149, recurrence: 'monthly' },
                { id: `${teamId}-sub-premium-annual`, amount: 1490, recurrence: 'annual' },
              ],
              active: true,
            },
            {
              id: `${teamId}-sub-elite`,
              name: 'Elite',
              description: 'All-inclusive — unlimited classes, coaching sessions, and priority booking.',
              source: 'internal',
              prices: [
                { id: `${teamId}-sub-elite-monthly`, amount: 199, recurrence: 'monthly' },
                { id: `${teamId}-sub-elite-annual`, amount: 1990, recurrence: 'annual' },
              ],
              active: true,
            },
          ]

  // Mirror written to public_profile (what syncSubscriptionTypesToPublicProfile
  // would produce) so the bio-link / website pricing table works deterministically.

  const publicSubTypes = subscriptionTypeDefs
    .filter((st) => st.active !== false)
    .map((st) => {
      const hasRecurring = st.prices.some((p) => p.recurrence !== 'per_class')
      const entry: {
        id: string
        name: string
        description?: string
        checkout_contact_mode?: string
        prices?: { id: string; amount: number; recurrence: string }[]
      } = {
        id: st.id,
        name: st.name,
        checkout_contact_mode: hasRecurring ? 'full' : 'minimal',
      }
      if (st.description) entry.description = st.description
      if (st.prices.length > 0)
        entry.prices = st.prices.map((p) => ({ id: p.id, amount: p.amount, recurrence: p.recurrence }))
      return entry
    })

  // Ranking systems — Training Level for coach, BJJ Belt for studio/org
  const rankingSystemDefs =
    plan === 'coach'
      ? [
          {
            id: 'training-level',
            name: 'Training Level',
            is_primary: true,
            levels: [
              { value: 0, label: 'Beginner', color: '#6b7280' },
              { value: 1, label: 'Intermediate', color: '#2563eb' },
              { value: 2, label: 'Advanced', color: '#7c3aed' },
              { value: 3, label: 'Expert', color: '#dc2626' },
            ],
          },
        ]
      : [
          {
            id: 'bjj-belt',
            name: 'BJJ Belt',
            is_primary: true,
            levels: [
              { value: 0, label: 'White Belt', color: '#e5e7eb' },
              { value: 1, label: 'Blue Belt', color: '#1d4ed8' },
              { value: 2, label: 'Purple Belt', color: '#7e22ce' },
              { value: 3, label: 'Brown Belt', color: '#78350f' },
              { value: 4, label: 'Black Belt', color: '#111827' },
            ],
          },
        ]

  // Rank system ID used as key in contact.ranks map
  const rankSystemId = plan === 'coach' ? 'training-level' : 'bjj-belt'

  // Gamification — enabled for studio/org, disabled for coach
  const gamificationSettings =
    plan === 'coach'
      ? {
          enabled: false,
          default_base_score: 10,
          streak_min_sessions: 2,
          monthly_cap: 200,
          time_multipliers: [],
        }
      : plan === 'studio'
        ? {
            enabled: true,
            default_base_score: 10,
            streak_min_sessions: 2,
            monthly_cap: 200,
            time_multipliers: [
              { day: 1, start_hour: 6, end_hour: 9, multiplier: 1.5 },
              { day: 3, start_hour: 6, end_hour: 9, multiplier: 1.5 },
              { day: 6, start_hour: 7, end_hour: 10, multiplier: 1.3 },
            ],
          }
        : {
            enabled: true,
            default_base_score: 10,
            streak_min_sessions: 2,
            monthly_cap: 300,
            time_multipliers: [
              { day: 1, start_hour: 6, end_hour: 9, multiplier: 1.5 },
              { day: 3, start_hour: 6, end_hour: 9, multiplier: 1.5 },
              { day: 5, start_hour: 6, end_hour: 9, multiplier: 1.5 },
              { day: 6, start_hour: 7, end_hour: 10, multiplier: 1.3 },
            ],
          }

  // Per-contact subscription assignment (index → config).
  // Studio/Org use tier-based IDs (starter/premium/elite); coach keeps flat IDs.
  type SubAssign = {
    subId: string
    subName: string
    priceId: string | null
    amount: number | null
    recurrence: string | null
  }
  const subStarter = plan === 'coach' ? `${teamId}-sub-monthly` : `${teamId}-sub-starter`
  const subPremium = plan === 'coach' ? `${teamId}-sub-monthly` : `${teamId}-sub-premium`
  const subElite = plan === 'coach' ? `${teamId}-sub-monthly` : `${teamId}-sub-elite`
  const subFitpass = `${teamId}-sub-fitpass`
  const subSportpass = `${teamId}-sub-sportpass`
  // Helpers to build SubAssign entries for a tier + chosen recurrence.
  const starterMonthly: SubAssign = plan === 'coach'
    ? { subId: subStarter, subName: 'Monthly Membership', priceId: `${subStarter}-price`, amount: 95, recurrence: 'monthly' }
    : { subId: subStarter, subName: 'Starter', priceId: `${subStarter}-monthly`, amount: plan === 'studio' ? 89 : 99, recurrence: 'monthly' }
  const starterAnnual: SubAssign = plan === 'coach'
    ? starterMonthly
    : { subId: subStarter, subName: 'Starter', priceId: `${subStarter}-annual`, amount: plan === 'studio' ? 890 : 990, recurrence: 'annual' }
  const premiumMonthly: SubAssign = plan === 'coach'
    ? starterMonthly
    : { subId: subPremium, subName: 'Premium', priceId: `${subPremium}-monthly`, amount: plan === 'studio' ? 139 : 149, recurrence: 'monthly' }
  const premiumAnnual: SubAssign = plan === 'coach'
    ? starterMonthly
    : { subId: subPremium, subName: 'Premium', priceId: `${subPremium}-annual`, amount: plan === 'studio' ? 1390 : 1490, recurrence: 'annual' }
  const eliteMonthly: SubAssign = plan === 'coach'
    ? starterMonthly
    : { subId: subElite, subName: 'Elite', priceId: `${subElite}-monthly`, amount: plan === 'studio' ? 189 : 199, recurrence: 'monthly' }
  // NOTE: no "Drop-in" per-class subscription PLAN any more (removed 2026-07):
  // drop-in is the per-activity `Activity.dropIn` price, paid per booking — not a
  // membership. Contact 5 (Emma) deliberately holds NO subscription: she is the
  // pay-per-class regular who exercises the MMA drop-in path.
  const contactSubRank: Record<number, SubAssign> = {
    0: starterMonthly,
    1: starterMonthly,
    2: premiumAnnual,
    3: starterMonthly,
    4: premiumMonthly,
    6: plan !== 'coach'
      ? { subId: subFitpass, subName: 'FitPass Partner', priceId: null, amount: null, recurrence: null }
      : starterMonthly,
    10: eliteMonthly,
    11: premiumAnnual,
    16: starterAnnual,
    17: plan !== 'coach'
      ? { subId: subSportpass, subName: 'SportPass', priceId: null, amount: null, recurrence: null }
      : starterMonthly,
  }

  // Per-contact rank assignment — keyed by contact index.
  // Covers all students (active, almost_ready, expired); trials & external have no rank.
  // coach → Training Level (0 Beginner … 3 Expert, inferred from session count)
  // studio/org → BJJ Belt (0 White … 4 Black)
  const contactRankMap: Record<number, number> =
    plan === 'coach'
      ? { 0: 2, 1: 2, 2: 3, 3: 1, 4: 2, 5: 0, 6: 2, 7: 0, 8: 0, 9: 1, 10: 1, 11: 2, 16: 3, 17: 1 }
      : { 0: 1, 1: 1, 2: 2, 3: 0, 4: 1, 5: 0, 6: 1, 7: 0, 8: 0, 9: 1, 10: 0, 11: 1, 16: 2, 17: 1 }

  // Auth user
  await auth.createUser({ uid, email, password: 'linyup123', displayName, emailVerified: true })

  // Booking settings — ONE store, the team's public_profile: the public booking
  // flow, the mobile app, the booking callables and the admin Settings → Booking
  // form all read it there. (There used to be a team-doc mirror at
  // settings.booking; it is gone — see packages/functions/src/booking/bookingSettings.ts.)
  const bookingSettings = {
    flowType: 'activity-first',
    windowMonths: 2,
    showPhone: true,
    ctaUrl: null,
    ctaLabel: null,
    // Every plan-tier demo team seeds an appointment activity + availability.
    appointmentsEnabled: true,
  }

  // Gift cards (E3) + no-show policy (E5) — studio-tier demo data only, so the
  // Payments dashboard + public shop have something to show without every plan
  // tier carrying it. giftCards is ALSO mirrored onto public_profile (below),
  // same reasoning as bookingSettings — syncTeamPublicProfile would recompute
  // it anyway, but a direct write keeps the seed correct even without the
  // functions emulator running.
  const giftCardSettings = { enabled: plan === 'studio', amounts: [50, 100] }
  const noShowPolicySettings = { enabled: plan === 'studio', feeAmount: 15, threshold: 3 }

  // Team doc
  const trialEndsAt = plan === 'coach' ? ts(daysFromNow(14)) : undefined
  await db
    .collection('teams')
    .doc(teamId)
    .set({
      name: teamName,
      description: `${teamName} — managed with Linyup.`,
      slug: teamSlug,
      sport_type: 'Martial arts',
      createdBy: uid,
      created: ts(daysFromNow(-120)),
      plan,
      plan_status: planStatus,
      default_currency: 'CHF',
      payment_modes: [...DEFAULT_PAYMENT_MODES],
      ...(trialEndsAt ? { trial_ends_at: trialEndsAt } : {}),
      ...(affiliationsEnabled ? { affiliations_enabled: true } : {}),
      ...(teamOrgId ? { organization_ids: [teamOrgId] } : {}),
      // Levels carry deterministic ids so a re-seed ranks contacts against the
      // same identities as the last one (see withRankLevelIds in shared).
      ranking_systems: rankingSystemDefs.map((s) => ({ ...s, levels: withRankLevelIds(s.levels) })),
      settings: {
        gamification: gamificationSettings,
        giftCards: giftCardSettings,
        noShowPolicy: noShowPolicySettings,
      },
      bioLinkTheme: 'light',
      bioLinkAccentColor: accentColor,
      bioLinkBackground: { type: 'solid', color: '#ffffff' },
      // Coach plan can't install the storefront plugins (studio+ only), so it gets
      // the lighter link set (booking + signup + memberships shop).
      links: plan === 'coach' ? buildBasicPageLinks() : buildStorefrontPageLinks(),
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
    })

  // Public profile
  await db
    .collection('teams')
    .doc(teamId)
    .collection('public_profile')
    .doc(teamId)
    .set({
      type: 'team',
      name: teamName,
      description: `${teamName} — managed with Linyup.`,
      slug: teamSlug,
      sport_type: 'Martial arts',
      profileImage: null,
      heroImage: null,
      bioLinkTheme: 'light',
      bioLinkAccentColor: accentColor,
      bioLinkBackground: { type: 'solid', color: '#ffffff' },
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
      links: plan === 'coach' ? buildBasicPageLinks() : buildStorefrontPageLinks(),
      bookingSettings,
      showBranding: false, // paid plans carry no "Powered by Linyup" badge
      default_currency: 'CHF',
      aggregator_subscription_types: publicSubTypes,
      partner_apps: partnerAppNames(subscriptionTypeDefs),
      giftCards: giftCardSettings,
      // products mirror is written by seedStoreProducts (studio+ only) at the end
      // of seedTeam, via a merge into this same public_profile doc.
      membershipRequiredFields: null,
      membershipOptionalFields: null,
      updated_at: ts(new Date()),
    })

  // Team member
  await db
    .collection('teams')
    .doc(teamId)
    .collection('team_members')
    .doc(uid)
    .set({
      teamId,
      userId: uid,
      role: 'owner',
      email,
      ...memberCapsFor('owner'),
      joined: ts(daysFromNow(-120)),
    })

  // ── affiliation type catalog ─────────────────────────────────────────────────
  // Org-linked teams get their types from the ORG catalog (seeded once per team
  // here; idempotent set). Standalone studios get a team-local 'club' type.
  for (const at of affiliationTypeDefs) {
    const parent = teamOrgId
      ? db.collection('organizations').doc(teamOrgId)
      : db.collection('teams').doc(teamId)
    await parent.collection(AFFILIATION_TYPES_SUBCOLLECTION).doc(at.id).set(at)
  }

  // User profile
  const [firstname, lastname] = displayName.split(' ')
  await db
    .collection('users')
    .doc(uid)
    .set({
      email,
      displayName,
      firstname,
      lastname,
      currentTeam: teamId,
      created_at: ts(daysFromNow(-120)),
    })

  // ── activities ──────────────────────────────────────────────────────────────
  // MMA showcases the activity↔subscription link: gated on the plan tier's
  // "unlimited" subscription types, so seeded contacts split into covered and
  // uncovered (exercises the session badges, the warn+confirm, and the
  // subscription-side activities editor). isFreeTrial stays in sync (open ⇔ true).
  // Starter is INCLUDED but usage-limited (3/week — see its `limits`): bookings
  // 1–3 in a week are covered, the 4th falls to the drop-in pay path at
  // Starter's 50% member rate. Premium/Elite are unlimited. On the studio team
  // the aggregator passes (FitPass/SportPass) also cover MMA — their covered
  // bookings earn the per-visit payout in the partner_visits ledger (E1).
  const mmaSubIds =
    plan === 'coach'
      ? [`${teamId}-sub-monthly`, `${teamId}-sub-10class`]
      : plan === 'studio'
        ? [
            `${teamId}-sub-starter`,
            `${teamId}-sub-premium`,
            `${teamId}-sub-elite`,
            `${teamId}-sub-fitpass`,
            `${teamId}-sub-sportpass`,
          ]
        : [`${teamId}-sub-starter`, `${teamId}-sub-premium`, `${teamId}-sub-elite`]
  type ClassActivitySeed = {
    id: string
    name: string
    slug: string
    color: string
    tags: string[]
    isFreeTrial: boolean
    type: 'class'
    accessRule: {
      type: string
      subscriptionTypeIds?: string[]
      /** Who may book AT ALL — the door, free path and paid path alike. */
      audience?: 'anyone' | 'members'
      /** Must the booker hold a linked plan? */
      requirePlan?: boolean
    }
    /** Independent of the tier: a gated class still accepts a newcomer's trial. */
    trialEnabled?: boolean
    /** Pay-per-class price for uncovered contacts (the ONE drop-in concept). */
    dropIn?: { enabled: boolean; priceAmount?: number }
    /** Member rate on the drop-in price (Activity.memberBenefit on a CLASS):
     *  holders of a listed type who are NOT covered by the accessRule pay a
     *  reduced drop-in. Price-modifying effects only. */
    memberBenefit?: { subscriptionTypeIds: string[]; effect: 'percent_off'; percent: number }
  }
  const activities: ClassActivitySeed[] = [
    {
      id: `${teamId}-act-bjj`,
      name: 'Brazilian Jiu-Jitsu',
      slug: 'bjj',
      color: accentColor,
      tags: [],
      isFreeTrial: true,
      type: 'class',
      accessRule: { type: 'open' },
    },
    {
      // MMA demos the FULL ordinary offer (members included + trial + drop-in):
      // gated to plans, but `trialEnabled` lets a newcomer book a free trial,
      // and an uncovered MEMBER can pay the per-class drop-in price instead —
      // the three toggles are independent and coexist.
      //
      // It is also the cell the old single tier could not express: MEMBERS ONLY
      // WITH A PAID DOOR. Under `members` the price never fired (every member
      // was free); under `subscription` a stranger could buy in. Here the studio
      // says both things — you must be on our list, and if your plan does not
      // cover this you pay the drop-in.
      id: `${teamId}-act-mma`,
      name: 'MMA',
      slug: 'mma',
      color: '#dc2626',
      tags: ['intermediate'],
      isFreeTrial: false,
      type: 'class',
      accessRule: {
        // `type` is the DISPLAY projection of the pair below and must agree with
        // it: members-only without a required plan reads as "Members only".
        type: 'members',
        subscriptionTypeIds: mmaSubIds,
        audience: 'members',
        requirePlan: false,
      },
      trialEnabled: true,
      dropIn: {
        enabled: true,
        priceAmount: plan === 'coach' ? 25 : plan === 'studio' ? 30 : 35,
      },
      // Starter subscribers aren't covered for MMA, but pay HALF the drop-in
      // (the class member rate the old model couldn't express). Coach teams
      // have no uncovered tier, so no rate there.
      ...(plan !== 'coach'
        ? {
            memberBenefit: {
              subscriptionTypeIds: [`${teamId}-sub-starter`],
              effect: 'percent_off' as const,
              percent: 50,
            },
          }
        : {}),
    },
    {
      id: `${teamId}-act-kickbox`,
      name: 'Kickboxing',
      slug: 'kickboxing',
      color: '#ea580c',
      tags: [],
      isFreeTrial: true,
      type: 'class',
      accessRule: { type: 'open' },
    },
    {
      id: `${teamId}-act-yoga`,
      name: 'Yoga & Mobility',
      slug: 'yoga-mobility',
      color: '#059669',
      tags: [],
      isFreeTrial: true,
      type: 'class',
      accessRule: { type: 'open' },
    },
  ]
  for (const a of activities) {
    await db
      .collection('activities')
      .doc(a.id)
      .set({
        ...a,
        teamId,
        // Classes don't auto-confirm: a booking holds a seat but stays
        // unconfirmed until the studio checks the contact in. Written
        // explicitly (it's what resolveAutoConfirm defaults to for 'class')
        // so the seed data exercises the field.
        autoConfirm: false,
        isActive: true,
        created_at: ts(daysFromNow(-100)),
      })
    await db.collection('activities').doc(a.id).collection('public_profile').doc(a.id).set({
      type: 'activity',
      activityType: 'class',
      teamId,
      name: a.name,
      slug: a.slug,
      color: a.color,
      image_url: null,
      isFreeTrial: a.isFreeTrial,
      accessRule: a.accessRule,
      // Drop-in config, mirrored only when enabled + priced — exactly as
      // syncActivityPublicProfile does. trialEnabled IS mirrored (when true):
      // the public flow needs it to OFFER the newcomer trial door on a gated
      // class; bookSession stays the enforcement.
      ...(a.dropIn?.enabled && typeof a.dropIn.priceAmount === 'number'
        ? { dropIn: { enabled: true, priceAmount: a.dropIn.priceAmount } }
        : {}),
      ...(a.trialEnabled ? { trialEnabled: true } : {}),
      // Class member rate mirrored verbatim (as syncActivityPublicProfile does)
      // so the public booking page can show the struck-through drop-in price.
      ...(a.memberBenefit ? { memberBenefit: a.memberBenefit } : {}),
      // Tags mirrored only when non-empty, exactly as syncActivityPublicProfile does.
      ...(a.tags?.length ? { tags: normalizeActivityTags(a.tags) } : {}),
    })
  }

  // ── appointment activity ────────────────────────────────────────────────────────
  // The WHAT of an appointment: its name, the lengths it can be booked at (with
  // their prices) and one member rule PER LENGTH. No access rule — the price is
  // the gate. The availability below only publishes the WHEN.
  const appointmentActId = `${teamId}-act-appointment`
  const appointmentActName = plan === 'coach' ? 'Personal Training' : '1-on-1 Coaching'
  // Per-duration BASE pricing (major units, CHF), and ONE MEMBER RULE PER
  // LENGTH (`Activity.durationBenefits`). The rule is per length because the
  // price is: a single activity-wide rule could not say "the short one is
  // included, the long one is cheaper", and could not express a fixed member
  // price at all (one amount cannot be right for 30 and 60 minutes alike).
  //
  // THE SEEDS DEMO DIFFERENT EFFECTS ON PURPOSE, so a click-through meets each
  // of them: this one gives the top tier the 30-minute session free and the
  // 60-minute one at a flat member price of 60 (base 85). The legacy
  // `memberBenefit` is deliberately NOT written anywhere here — its fallback is
  // covered by a unit test, not by seed data a studio might mistake for the
  // shape the product writes today.
  const appointmentDurations = [
    { minutes: 30, priceAmount: 45 },
    { minutes: 60, priceAmount: 85 },
  ]
  const appointmentTopTier =
    plan === 'coach' ? `${teamId}-sub-monthly` : `${teamId}-sub-elite`
  const appointmentDurationBenefits = [
    { minutes: 30, benefit: { subscriptionTypeIds: [appointmentTopTier], effect: 'included' } },
    {
      minutes: 60,
      benefit: {
        subscriptionTypeIds: [appointmentTopTier],
        effect: 'fixed_price',
        amount: 60,
      },
    },
  ]
  await db
    .collection('activities')
    .doc(appointmentActId)
    .set({
      teamId,
      name: appointmentActName,
      slug: '1on1-coaching',
      color: accentColor,
      type: 'appointment',
      providerId: uid,
      providerName: displayName,
      durations: appointmentDurations,
      durationBenefits: appointmentDurationBenefits,
      // A 1:1 slot has no roster-review step — the time is taken the moment it's
      // booked, so the booking is written 'confirmed' on the spot.
      autoConfirm: true,
      isActive: true,
      created_at: ts(daysFromNow(-90)),
    })
  await db
    .collection('activities')
    .doc(appointmentActId)
    .collection('public_profile')
    .doc(appointmentActId)
    .set({
      type: 'activity',
      // Routes the public booking/site cards to the appointment flow.
      activityType: 'appointment',
      teamId,
      name: appointmentActName,
      slug: '1on1-coaching',
      color: accentColor,
      image_url: null,
      // The doc carries no isFreeTrial; the live sync mirrors `|| false`.
      isFreeTrial: false,
      // Duration menu ("from CHF 45" on public cards) + the per-length member
      // rules, both mirrored verbatim, exactly as syncActivityPublicProfile
      // does (public-safe: the subscription-type ids are already public in the
      // shop).
      durations: appointmentDurations.map((d) => ({
        minutes: d.minutes,
        priceAmount: d.priceAmount ?? null,
      })),
      durationBenefits: appointmentDurationBenefits,
    })

  // ── availability (the WHEN — publishes free time, generates nothing) ──────────
  // 'range' mode: the coach advertises a daily window and clients self-book a
  // start on the `granularityMinutes` grid, at one of the activity's durations.
  const appointmentTemplateId = `${teamId}-tpl-appointment`
  const appointmentDays = [1, 3] // Mon + Wed
  await db
    .collection('availability')
    .doc(appointmentTemplateId)
    .set({
      teamId,
      providerId: uid,
      providerName: displayName,
      // The SCHEDULE's name — the offering's name lives on the activity.
      title: 'Weekday mornings',
      description: 'One-on-one coaching session.',
      activityIds: [appointmentActId],
      location: 'Dojo A',
      onlineUrl: null,
      status: 'active',
      mode: 'range',
      window: { start: '08:00', end: '11:00' },
      granularityMinutes: 30,
      bufferMinutes: 0,
      recurrence: {
        daysOfWeek: appointmentDays,
        startDate: ts(daysFromNow(-30)),
        endDate: null,
      },
      created_at: ts(daysFromNow(-30)),
      createdBy: uid,
    })

  // ── booked appointments ──────────────────────────────────────────────────────
  // Availability pre-generates NOTHING — a session exists only once someone books.
  // These are what that looks like afterwards, shaped as `bookAppointment` writes
  // them (the first active contact, Luca Ferrari, is the client).
  const bookedContact = {
    id: `${teamId}-contact-000`,
    firstname: 'Luca',
    lastname: 'Ferrari',
    email: `luca.ferrari.${teamId}@email.com`,
  }
  const bookedAppointments = [
    ...appointmentOccurrences({ daysOfWeek: appointmentDays, time: '08:00', count: 1 }).map(
      (start) => ({ start, durationMinutes: 60, past: false })
    ),
    ...appointmentOccurrences({ daysOfWeek: appointmentDays, time: '09:30', count: 1, fromDayOffset: 7 }).map(
      (start) => ({ start, durationMinutes: 30, past: false })
    ),
    ...appointmentOccurrences({ daysOfWeek: appointmentDays, time: '08:00', count: 1, direction: -1 }).map(
      (start) => ({ start, durationMinutes: 60, past: true })
    ),
  ]

  for (const apt of bookedAppointments) {
    const { id: sid, session, publicProfile } = buildAppointmentSessionDocs({
      teamId,
      templateId: appointmentTemplateId,
      activityId: appointmentActId,
      activityName: appointmentActName,
      providerId: uid,
      providerName: displayName,
      start: apt.start,
      durationMinutes: apt.durationMinutes,
      location: 'Dojo A',
      past: apt.past,
      createdAt: daysFromNow(-7),
    })
    await db.collection('sessions').doc(sid).set(session)
    await db.collection('sessions').doc(sid).collection('public_profile').doc(sid).set(publicProfile)
    await db
      .collection('sessions')
      .doc(sid)
      .collection('bookings')
      .doc(bookedContact.id)
      .set(
        buildAppointmentBookingDoc({
          teamId,
          sessionId: sid,
          contactId: bookedContact.id,
          firstname: bookedContact.firstname,
          lastname: bookedContact.lastname,
          email: bookedContact.email,
          bookedAt: daysFromNow(-2),
        })
      )
  }

  // ── subscription types ──────────────────────────────────────────────────────
  for (const st of subscriptionTypeDefs) {
    const hasRecurring = st.prices.some((p) => p.recurrence !== 'per_class')
    await db
      .collection('teams')
      .doc(teamId)
      .collection('subscription_types')
      .doc(st.id)
      .set({
        name: st.name,
        description: st.description,
        source: st.source,
        active: st.active,
        public: st.active !== false,
        checkout_contact_mode: hasRecurring ? 'full' : 'minimal',
        prices: st.prices.map((p) => ({ ...p, active: true })),
        ...(st.limits ? { limits: st.limits } : {}),
        ...(typeof st.payoutPerVisit === 'number' ? { payoutPerVisit: st.payoutPerVisit } : {}),
        teamId,
        created_at: ts(daysFromNow(-60)),
      })
  }

  // ── sessions ────────────────────────────────────────────────────────────────
  type SessionDef = {
    dayOffset: number
    actId: string
    actName: string
    hour: number
    duration: number
    location: string
    allowBooking: boolean
    instructor?: string
    locationAddress?: string
  }
  const sessionDefs: SessionDef[] = []

  for (let week = -4; week <= -1; week++) {
    for (const [dayOff, actId, actName, hour, dur, loc, instr] of [
      [1, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 18, 1.5, 'Dojo A', 'Marco Silva'],
      [3, `${teamId}-act-kickbox`, 'Kickboxing', 19, 1, 'Dojo B', 'Elena Rossi'],
      [5, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 7, 1, 'Dojo A', 'Marco Silva'],
      [6, `${teamId}-act-mma`, 'MMA', 10, 2, 'Main Hall', null],
    ] as const) {
      sessionDefs.push({
        dayOffset: week * 7 + Number(dayOff),
        actId,
        actName,
        hour: Number(hour),
        duration: Number(dur),
        location: String(loc),
        allowBooking: false,
        instructor: instr ?? undefined,
        locationAddress: '123 Fighter St',
      })
    }
  }
  for (let week = 0; week <= 3; week++) {
    for (const [dayOff, actId, actName, hour, dur, loc, ab, instr] of [
      [1, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 18, 1.5, 'Dojo A', true, 'Marco Silva'],
      [2, `${teamId}-act-yoga`, 'Yoga & Mobility', 9, 1, 'Studio', true, 'Aiko Tanaka'],
      [3, `${teamId}-act-kickbox`, 'Kickboxing', 19, 1, 'Dojo B', true, 'Elena Rossi'],
      [5, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 7, 1, 'Dojo A', true, 'Marco Silva'],
      [6, `${teamId}-act-mma`, 'MMA', 10, 2, 'Main Hall', true, null],
      [0, `${teamId}-act-yoga`, 'Yoga & Mobility', 10, 1.5, 'Studio', false, 'Aiko Tanaka'],
    ] as const) {
      sessionDefs.push({
        dayOffset: week * 7 + Number(dayOff),
        actId,
        actName,
        hour: Number(hour),
        duration: Number(dur),
        location: String(loc),
        allowBooking: Boolean(ab),
        instructor: (instr as string | null) ?? undefined,
        locationAddress: '123 Fighter St',
      })
    }
  }

  const pastCount = 4 * 4
  const sessionIds: string[] = []
  for (let i = 0; i < sessionDefs.length; i++) {
    const s = sessionDefs[i]
    const base = daysFromNow(s.dayOffset)
    base.setHours(s.hour, 0, 0, 0)
    const end = hoursOffset(base, s.duration)
    const id = `${teamId}-session-${i.toString().padStart(3, '0')}`
    sessionIds.push(id)

    // Resolve activity metadata for public_profile
    const act = activities.find((a) => a.id === s.actId)

    await db
      .collection('sessions')
      .doc(id)
      .set({
        teamId,
        activityId: s.actId,
        activityName: s.actName,
        start: ts(base),
        end: ts(end),
        location: s.location,
        providerName: s.instructor ?? null,
        locationAddress: s.locationAddress ?? null,
        allowBooking: s.allowBooking,
        // Denormalised from the activity — classes confirm at check-in.
        autoConfirm: false,
        participants_count: 0,
        created_at: ts(daysFromNow(-100)),
        createdBy: uid,
      })
    if (s.allowBooking) {
      await db
        .collection('sessions')
        .doc(id)
        .collection('public_profile')
        .doc(id)
        .set({
          type: 'session',
          teamId,
          activityId: s.actId,
          activityName: s.actName,
          activityColor: act?.color ?? null,
          activitySlug: act?.slug ?? null,
          activityIsFreeTrial: act?.isFreeTrial ?? false,
          activityImage: null,
          start: ts(base),
          end: ts(end),
          location: s.location,
          providerName: s.instructor ?? null,
          locationAddress: s.locationAddress ?? null,
          locationMapsUrl: null,
          capacity: null,
          participants_count: 0,
          allowBooking: true,
          slug: null,
        })
    }
  }

  // ── contacts ─────────────────────────────────────────────────────────────────
  const contactSeeds = [
    {
      firstname: 'Luca',
      lastname: 'Ferrari',
      email: `luca.ferrari.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'M',
      totalSessions: 48,
      birthdate: new Date('1992-03-14'),
      birthplace: 'Milan',
    },
    {
      firstname: 'Sofia',
      lastname: 'Bianchi',
      email: `sofia.bianchi.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'F',
      totalSessions: 32,
      birthdate: new Date('1995-07-22'),
      birthplace: 'Rome',
    },
    {
      firstname: 'Alex',
      lastname: 'Müller',
      email: `alex.mueller.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'M',
      totalSessions: 67,
      birthdate: new Date('1988-11-05'),
      birthplace: 'Zurich',
    },
    {
      firstname: 'Chiara',
      lastname: 'Romano',
      email: `chiara.romano.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'F',
      totalSessions: 21,
      birthdate: new Date('1999-01-30'),
      birthplace: 'Naples',
    },
    {
      firstname: 'Matteo',
      lastname: 'Esposito',
      email: `matteo.espo.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'M',
      totalSessions: 55,
      birthdate: new Date('1990-09-18'),
      birthplace: 'Turin',
    },
    {
      firstname: 'Emma',
      lastname: 'Schneider',
      email: `emma.schneid.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'F',
      totalSessions: 14,
      birthdate: new Date('2001-04-11'),
      birthplace: 'Bern',
    },
    {
      firstname: 'David',
      lastname: 'Costa',
      email: `david.costa.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'M',
      totalSessions: 39,
      birthdate: new Date('1993-06-27'),
      birthplace: 'Lisbon',
    },
    {
      firstname: 'Julia',
      lastname: 'Weber',
      email: `julia.weber.${teamId}@email.com`,
      type: 'student',
      status: 'almost_ready',
      gender: 'F',
      totalSessions: 8,
      birthdate: new Date('2000-12-03'),
      birthplace: 'Basel',
    },
    {
      firstname: 'Marco',
      lastname: 'Conti',
      email: `marco.conti.${teamId}@email.com`,
      type: 'student',
      status: 'almost_ready',
      gender: 'M',
      totalSessions: 6,
      birthdate: new Date('1997-08-15'),
      birthplace: 'Florence',
    },
    {
      firstname: 'Sara',
      lastname: 'Ricci',
      email: `sara.ricci.${teamId}@email.com`,
      type: 'student',
      status: 'expired',
      gender: 'F',
      totalSessions: 28,
      birthdate: new Date('1994-02-09'),
      birthplace: 'Bologna',
    },
    {
      firstname: 'Tobias',
      lastname: 'Huber',
      email: `tobias.huber.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'M',
      totalSessions: 19,
      birthdate: new Date('1996-05-21'),
      birthplace: 'Geneva',
    },
    {
      firstname: 'Nina',
      lastname: 'Moreau',
      email: `nina.moreau.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'F',
      totalSessions: 44,
      birthdate: new Date('1991-10-08'),
      birthplace: 'Paris',
    },
    {
      firstname: 'Lorenzo',
      lastname: 'De Luca',
      email: `lorenzo.dl.${teamId}@email.com`,
      type: 'trial',
      status: 'requested',
      gender: 'M',
      totalSessions: 0, // booked a trial but hasn't attended yet → trial_booked no-show cohort
      birthdate: new Date('2003-07-19'),
      birthplace: 'Palermo',
    },
    {
      firstname: 'Amélie',
      lastname: 'Dupont',
      email: `amelie.dupont.${teamId}@email.com`,
      type: 'trial',
      status: 'requested',
      gender: 'F',
      totalSessions: 0,
      birthdate: null,
      birthplace: null,
    },
    {
      firstname: 'Kevin',
      lastname: 'Nguyen',
      email: `kevin.nguyen.${teamId}@email.com`,
      type: 'trial',
      status: 'under_review',
      gender: 'M',
      totalSessions: 2,
      birthdate: new Date('1998-03-25'),
      birthplace: 'Lyon',
    },
    {
      firstname: 'Hannah',
      lastname: 'Fischer',
      email: `hannah.fisch.${teamId}@email.com`,
      type: 'external',
      status: 'guest',
      gender: 'F',
      totalSessions: 0,
      birthdate: null,
      birthplace: null,
    },
    {
      firstname: 'Radu',
      lastname: 'Ionescu',
      email: `radu.ionescu.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'M',
      totalSessions: 77,
      birthdate: new Date('1987-12-31'),
      birthplace: 'Bucharest',
    },
    {
      firstname: 'Valentina',
      lastname: 'Greco',
      email: `val.greco.${teamId}@email.com`,
      type: 'student',
      status: 'active',
      gender: 'F',
      totalSessions: 29,
      birthdate: new Date('1993-09-14'),
      birthplace: 'Catania',
    },
  ]

  for (let i = 0; i < contactSeeds.length; i++) {
    const c = contactSeeds[i]
    const id = `${teamId}-contact-${i.toString().padStart(3, '0')}`
    const subAssign = contactSubRank[i] ?? null
    const rankValue = contactRankMap[i] ?? null
    // Drop the authoring `type` — it is input convenience only and is never
    // written to the doc; it maps to the acquisition axis fields below instead.
    const { type: authoringType, ...contactFields } = c
    const createdTs = ts(daysFromNow(-Math.floor(Math.random() * 90) - 10))
    const acquisition = acquisitionFieldsFor({
      type: authoringType as 'student' | 'trial' | 'external',
      hasAttended: c.totalSessions > 0,
      milestoneTs: createdTs,
      seed: id,
    })
    // ── affiliation (replaces the old membership_* fields) ───────────────────
    // A non-guest, non-external contact holds ONE affiliation: the seeded club
    // type, issuer 'org' for org-linked teams else 'team'. Status carries over
    // (active/expired/requested/…); `active` is denormalized from the status def.
    const writeAffiliation =
      affiliationsEnabled &&
      clubAffiliationType !== null &&
      authoringType !== 'external' &&
      c.status !== 'guest'
    const affiliationDoc = writeAffiliation
      ? buildAffiliationDoc({
          teamId,
          type: clubAffiliationType!,
          statusId: c.status,
          orgId: teamOrgId,
          // No source expiration in seed data — derive a plausible window so the
          // UI shows a validity: expired = past, active-counting = future.
          validUntil: statusCountsAsActive(c.status)
            ? ts(daysFromNow(300))
            : c.status === 'expired'
              ? ts(daysFromNow(-20))
              : undefined,
          validFrom: ts(daysFromNow(-200)),
          createdAt: createdTs,
          createdBy: 'seed',
        })
      : null

    await db
      .collection('contacts')
      .doc(id)
      .set({
        teamId,
        ...contactFields,
        birthdate: c.birthdate ? ts(c.birthdate) : null,
        total_sessions: c.totalSessions,
        last_session_at:
          c.totalSessions > 0 ? ts(daysFromNow(-Math.floor(Math.random() * 14))) : null,
        current_month_score: Math.floor(Math.random() * 120),
        current_streak: Math.floor(Math.random() * 8),
        created_at: createdTs,
        deleted_at: null,
        archived_at: null,
        ...acquisition,
        // 'external' is a tag now, not a status.
        ...(authoringType === 'external' ? { tags: ['external'] } : {}),
        // Best-effort affiliation summary (the trigger recomputes this live).
        ...(affiliationDoc
          ? { affiliation_summary: buildAffiliationSummary([affiliationDoc as AffiliationSummaryInput]) }
          : {}),
        ...(subAssign
          ? {
              subscription_type_id: subAssign.subId,
              subscription_type_name: subAssign.subName,
              subscription_recurrence: subAssign.recurrence,
              ...(subAssign.priceId
                ? {
                    subscription_price_id: subAssign.priceId,
                    subscription_amount: subAssign.amount,
                  }
                : {}),
            }
          : {}),
        ...(rankValue != null ? { ranks: { [rankSystemId]: rankValue } } : {}),
      })

    if (affiliationDoc) {
      await db
        .collection('contacts')
        .doc(id)
        .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
        .doc(`${id}-aff-club`)
        .set(affiliationDoc)
    }
  }

  // `subscription_history` is seeded later, by `seedTeamSubscriptionHistory`
  // (AFTER `seedTeamMoney`, which is what `active_subscriptions` — its
  // multi-plan source — is read back from). See that call for why.

  // Past-session participants
  const studentContactIds = Array.from(
    { length: 12 },
    (_, i) => `${teamId}-contact-${i.toString().padStart(3, '0')}`
  )
  for (let i = 0; i < pastCount; i++) {
    const sid = sessionIds[i]
    if (!sid) continue
    const count = 3 + ((i * 7 + 3) % 7)
    const attending = studentContactIds.filter((_, ci) => (ci + i * 3) % 12 < count)
    for (const contactId of attending) {
      const cIdx = studentContactIds.indexOf(contactId)
      const cs = contactSeeds[cIdx]
      await db
        .collection('sessions')
        .doc(sid)
        .collection('participants')
        .doc(contactId)
        .set({
          contactId,
          session: sid,
          firstname: cs.firstname,
          lastname: cs.lastname,
          fullname: `${cs.lastname} ${cs.firstname}`,
          joinedAt: ts(daysFromNow(sessionDefs[i].dayOffset)),
          checkedInAt: ts(daysFromNow(sessionDefs[i].dayOffset)),
          checkedInBy: 'seed',
        })
    }
    await db.collection('sessions').doc(sid).update({ participants_count: attending.length })
  }

  // Bookings
  const bookingContacts = contactSeeds.slice(12, 16)
  const sessionBookingCounts = new Map<
    string,
    { bookings_count: number; trial_bookings_count: number }
  >()
  for (let i = 0; i < bookingContacts.length; i++) {
    const b = bookingContacts[i]
    const sessionId = sessionIds[pastCount + (i < 2 ? 1 : 3)]
    if (!sessionId) continue
    await db
      .collection('sessions')
      .doc(sessionId)
      .collection('bookings')
      .doc(`${teamId}-booking-${i}`)
      .set({
        teamId,
        contact: `${teamId}-contact-${(12 + i).toString().padStart(3, '0')}`,
        session: sessionId,
        email: b.email,
        firstname: b.firstname,
        lastname: b.lastname,
        phone: '',
        is_new_contact: true,
        joinedAt: ts(daysFromNow(-2)),
        status: 'pending',
        booking_token: `tok-${teamId}-${i}`,
      })
    const cur = sessionBookingCounts.get(sessionId) ?? {
      bookings_count: 0,
      trial_bookings_count: 0,
    }
    cur.bookings_count++
    cur.trial_bookings_count++ // all seeded bookings are is_new_contact: true
    sessionBookingCounts.set(sessionId, cur)
  }
  for (const [sessionId, counts] of sessionBookingCounts) {
    await db.collection('sessions').doc(sessionId).update(counts)
  }

  // ── team activity log ───────────────────────────────────────────────────────
  // A RECORD of what the app did, written live by triggers and never recomputed —
  // so a seeded tenant starts with a permanently empty feed on /dashboard (the
  // first screen after login) and an empty Activity tab on every contact.
  // `refs.contact` is the equality field the contact page filters on, and
  // `refs.user` carries the teamId (see @linyup/shared ActivityLogEntry).
  const logEntries: { event: string; contactIndex: number; desc: string }[] = [
    {
      // Contact 12 is the freshly-booked trial lead — the one a studio opening
      // the dashboard is meant to notice first.
      event: 'contact_add',
      contactIndex: 12,
      desc: `New trial contact ${contactSeeds[12].firstname} ${contactSeeds[12].lastname} added from the booking page.`,
    },
    {
      event: 'session_participant_add',
      contactIndex: 0,
      desc: `${contactSeeds[0].firstname} ${contactSeeds[0].lastname} checked into ${sessionDefs[0].actName}.`,
    },
    {
      event: 'subscription_change',
      contactIndex: 2,
      desc: `${contactSeeds[2].firstname} ${contactSeeds[2].lastname} switched to ${contactSubRank[2].subName}.`,
    },
    {
      event: 'booking_confirmed',
      contactIndex: 13,
      desc: `Trial booking confirmed for ${contactSeeds[13].firstname} ${contactSeeds[13].lastname}.`,
    },
  ]
  for (let i = 0; i < logEntries.length; i++) {
    const e = logEntries[i]
    await db
      .collection('teams')
      .doc(teamId)
      .collection('activity_log')
      .doc(`${teamId}-log-${i}`)
      .set({
        event: e.event,
        created_at: ts(daysFromNow(-i - 1)),
        parameters: { description: e.desc },
        refs: {
          contact: `${teamId}-contact-${e.contactIndex.toString().padStart(3, '0')}`,
          user: teamId,
        },
      })
  }

  // ── weekly reports (feeds the trend chart in the contact header) ────────────
  for (let i = 0; i < contactSeeds.length; i++) {
    const c = contactSeeds[i]
    if (c.totalSessions === 0) continue
    const contactId = `${teamId}-contact-${i.toString().padStart(3, '0')}`
    const maxPerWeek = Math.min(3, Math.ceil(c.totalSessions / 16))
    for (let w = 7; w >= 0; w--) {
      const monday = mondayOfWeeksAgo(w)
      const label = isoWeekLabel(monday)
      // Most active contacts attend most weeks; less active ones skip more
      const attendChance = Math.min(0.9, c.totalSessions / 30)
      const count = Math.random() < attendChance ? 1 + Math.floor(Math.random() * maxPerWeek) : 0
      await db
        .collection('contacts')
        .doc(contactId)
        .collection('contact_weekly_reports')
        .doc(label)
        .set({
          iso_week: label,
          sessions_count: count,
          generated_at: ts(monday),
        })
    }
  }

  // ── monthly scores (gamification) — last 4 months per attending contact ──────
  // Follows the team's gamification switch rather than the plan: the coach tier
  // ships the feature off, and scores under a disabled scoreboard would be data
  // no screen ever explains.
  if (gamificationSettings.enabled) {
    await seedMonthlyScores({ teamId, monthlyCap: gamificationSettings.monthly_cap })
  }

  // ── contact alerts — the coach's own reminders on a person ───────────────────
  // Written flat (`schedule_type` / `schedule_value`), which is the canonical
  // `ContactAlert` shape the admin contact page writes; the server writers use a
  // nested `schedule` map and the page normalises both on read. Seeding the flat
  // one keeps the demo on the shape the admin UI round-trips.
  await seedContactAlerts({ teamId, vocabulary: 'martial_arts' })

  // ── goals & tasks (appointment data) ────────────────────────────────────────────
  // `categories` are GOAL CATEGORIES (technique / attitude / attendance /
  // physical / mental — see DEFAULT_GOAL_CATEGORIES), never check-in axis keys:
  // what a goal is about and how someone is doing are two vocabularies. A goal
  // created FROM a weak axis carries `from_dimension` instead; nothing seeded
  // here comes from one, because no check-ins are seeded.
  const goalDefs = [
    {
      title: 'Improve guard passing',
      description: 'Work on pressure passing and leg weave.',
      categories: ['technique', 'physical'],
    },
    {
      title: 'Compete at next tournament',
      description: 'Enter the regional open and go for gold.',
      categories: ['attitude', 'mental'],
    },
    {
      title: 'Build consistent training habit',
      description: 'Train at least 3 × per week for 8 weeks.',
      categories: ['attendance', 'attitude'],
    },
    {
      title: 'Develop rear-naked choke finish',
      description: 'Clean finish from back control.',
      categories: ['technique'],
    },
    {
      title: 'Improve cardio base',
      description: 'Finish hard rounds without gassing in minute 3.',
      categories: ['physical', 'mental'],
    },
  ]
  const taskDefs = [
    'Watch 3 guard-passing breakdown videos',
    'Practice solo drills 10 min/day this week',
    'Stretch routine every morning (5 days)',
    'Review competition weight-cut plan',
    'Write post-training notes for each session',
  ]

  for (let i = 0; i < contactSeeds.length; i++) {
    const c = contactSeeds[i]
    if (c.type !== 'student' || c.totalSessions < 5) continue
    const contactId = `${teamId}-contact-${i.toString().padStart(3, '0')}`

    // 1–2 long-term goals
    const numGoals = i < 4 ? 2 : 1
    for (let g = 0; g < numGoals; g++) {
      const def = goalDefs[(i + g) % goalDefs.length]
      const goalId = `${contactId}-goal-${g}`
      const status = i < 3 && g === 0 ? 'in_progress' : 'open'
      await db
        .collection('contacts')
        .doc(contactId)
        .collection('goals')
        .doc(goalId)
        .set({
          type: 'goal',
          title: def.title,
          description: def.description,
          status,
          categories: def.categories,
          created_by: 'coach',
          created_at: ts(daysFromNow(-28)),
          target_date: ts(daysFromNow(60)),
          completed_at: null,
        })

      if (status === 'in_progress') {
        for (let e = 0; e < 2; e++) {
          await db
            .collection('contacts')
            .doc(contactId)
            .collection('goals')
            .doc(goalId)
            .collection('evaluations')
            .doc(`${goalId}-eval-${e}`)
            .set({
              evaluated_at: ts(daysFromNow(-14 + e * 7)),
              evaluated_by: 'coach',
              score: 3 + e,
              notes:
                e === 0
                  ? 'Good start — needs more drilling time.'
                  : 'Visible improvement over last session.',
              status_after: 'in_progress',
              edited: false,
            })
        }
      }
    }

    // 1 task (some already completed)
    const taskId = `${contactId}-task-0`
    const taskDone = i % 3 === 0
    await db
      .collection('contacts')
      .doc(contactId)
      .collection('goals')
      .doc(taskId)
      .set({
        type: 'task',
        title: taskDefs[i % taskDefs.length],
        description: null,
        status: taskDone ? 'achieved' : 'open',
        categories: [],
        created_by: 'coach',
        created_at: ts(daysFromNow(-7)),
        target_date: ts(daysFromNow(7)),
        completed_at: taskDone ? ts(daysFromNow(-2)) : null,
      })
  }

  // Events
  const eventDefs = [
    {
      title: 'Regional BJJ Tournament',
      type: 'competition',
      startOffset: 45,
      durationH: 8,
      fee: 25,
      location: 'Sports Arena Geneva',
      description:
        'Annual regional championship — open to white and blue belts. Gi and No-Gi divisions available.',
    },
    {
      title: 'Summer MMA Camp',
      type: 'camp',
      startOffset: 60,
      durationH: 72,
      fee: 180,
      location: 'High Performance Training Center',
      description:
        '3-day intensive camp with guest instructors. All skill levels welcome. Accommodation included.',
    },
    {
      title: 'Nutrition Workshop',
      type: 'seminar',
      startOffset: 14,
      durationH: 3,
      fee: 0,
      location: 'Team HQ — Conference Room',
      description:
        'Practical guide to sports nutrition and recovery for martial artists. Free for all members.',
    },
  ]
  const eventIds: string[] = []
  for (let i = 0; i < eventDefs.length; i++) {
    const e = eventDefs[i]
    const eventId = `${teamId}-event-${i}`
    eventIds.push(eventId)
    await db
      .collection('events')
      .doc(eventId)
      .set({
        teamId,
        title: e.title,
        type: e.type,
        fee: e.fee,
        description: e.description,
        location: e.location,
        start: ts(daysFromNow(e.startOffset)),
        end: ts(hoursOffset(daysFromNow(e.startOffset), e.durationH)),
        status: 'open',
        participants_count: 0,
        attendees_count: 0,
        invitations_sent_count: 0,
        deleted_at: null,
        createdBy: uid,
        created_at: ts(daysFromNow(-10)),
      })
  }

  // Event invitations & attendees
  // Realistic: a subset of contacts are invited per event, with varied RSVP status.
  // Token format is deterministic so dev/test links work predictably.
  const inviteSlices = [12, 8, 10] // how many contacts to invite per event
  // Status distribution per position j: 0-2 responded, 3-4 declined, 5-7 opened, rest sent
  function inviteStatusForIdx(j: number): 'responded' | 'declined' | 'opened' | 'sent' {
    if (j < 3) return 'responded'
    if (j < 5) return 'declined'
    if (j < 8) return 'opened'
    return 'sent'
  }

  for (let ei = 0; ei < eventIds.length; ei++) {
    const eventId = eventIds[ei]
    const maxInvite = inviteSlices[ei]
    let sentCount = 0
    let attendeeCount = 0

    // Pick contacts that have an email (all 18 do) — vary starting index per event
    const startIdx = ei * 3
    const inviteIndices = Array.from(
      { length: maxInvite },
      (_, k) => (startIdx + k) % contactSeeds.length
    )

    for (let j = 0; j < inviteIndices.length; j++) {
      const cidx = inviteIndices[j]
      const c = contactSeeds[cidx]
      if (!c.email) continue

      const contactId = `${teamId}-contact-${cidx.toString().padStart(3, '0')}`
      const status = inviteStatusForIdx(j)
      // Deterministic token — 64-char hex-like string for test links
      const token = `seed${teamId}ev${ei}c${cidx}`.padEnd(32, '0').repeat(2).slice(0, 64)
      const link = `http://localhost:3000/public/event-invitation?token=${token}`
      const hasOpened = ['opened', 'responded', 'declined'].includes(status)
      const hasRsvp = ['responded', 'declined'].includes(status)

      await db
        .collection('events')
        .doc(eventId)
        .collection('invitations')
        .doc(contactId)
        .set({
          contactId,
          firstname: c.firstname,
          lastname: c.lastname,
          email: c.email,
          status,
          token,
          link,
          eventId,
          sentBy: uid,
          sentAt: ts(daysFromNow(-7)),
          firstOpenedAt: hasOpened ? ts(daysFromNow(-5)) : null,
          lastOpenedAt: hasOpened ? ts(daysFromNow(-3)) : null,
          respondedAt: hasRsvp ? ts(daysFromNow(-2)) : null,
        })
      sentCount++

      if (status === 'responded') {
        attendeeCount++
        await db
          .collection('events')
          .doc(eventId)
          .collection('attendees')
          .doc(contactId)
          .set({
            contactId,
            firstname: c.firstname,
            lastname: c.lastname,
            email: c.email,
            notes: j === 0 ? 'Really looking forward to this!' : null,
            respondedAt: ts(daysFromNow(-2)),
          })
      }
    }

    // Update event-level counters
    await db
      .collection('events')
      .doc(eventId)
      .update({
        invitations_sent_count: sentCount,
        attendees_count: attendeeCount,
        last_invitation_sent_at: ts(daysFromNow(-7)),
      })
  }

  // ── saas_subscriptions ────────────────────────────────────────────────────
  // Mirrors the state the Stripe webhook would write after a real payment.
  // gateway_type: null = manually managed (no real Stripe customer yet in dev).
  const now = ts(new Date())
  if (plan === 'coach') {
    await db
      .collection('saas_subscriptions')
      .doc(teamId)
      .set({
        teamId,
        plan: 'coach',
        status: 'trial',
        trial_ends_at: ts(daysFromNow(14)),
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        gateway_type: null,
        gateway_data: null,
        created_at: now,
        updated_at: now,
      })
  } else {
    const periodStart = ts(daysFromNow(-30))
    const periodEnd = ts(daysFromNow(1)) // renews tomorrow
    await db
      .collection('saas_subscriptions')
      .doc(teamId)
      .set({
        teamId,
        plan,
        status: 'active',
        trial_ends_at: null,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: false,
        gateway_type: null, // null = manually managed / pre-configured
        gateway_data: null,
        created_at: ts(daysFromNow(-120)),
        updated_at: now,
      })
  }

  // ── online courses (Online Courses LMS plugin) ──────────────────────────────
  // Only the studio-tier account showcases the full course library (studio+ feature).
  if (plan === 'studio') {
    await seedCourses(teamId, uid)
  }

  // ── gift cards (E3) — one pre-minted active card, studio tier only ─────────
  // Mirrors what mintGiftCard writes on a real purchase, minus payment_intent_id
  // (there was no real Stripe checkout behind this one).
  //
  // The PLUGIN must be installed alongside the data (Wave 3.5): gift cards are
  // install-gated now, and syncTeamPublicProfile refuses to mirror
  // `giftCards.enabled` without it — so seeding the card without the plugin
  // gives a demo tenant an invisible gift-card offer and an empty Payments tab.
  if (plan === 'studio') {
    await db
      .collection('teams')
      .doc(teamId)
      .collection('installed_plugins')
      .doc('gift-cards')
      .set({
        pluginId: 'gift-cards',
        teamId,
        installedAt: ts(daysFromNow(-30)),
        installedBy: uid,
        status: 'active',
        config: {},
      })
  }
  if (plan === 'studio') {
    await db
      .collection('teams')
      .doc(teamId)
      .collection('gift_cards')
      .doc('GC-DEMO-CARD')
      .set({
        code: 'GC-DEMO-CARD',
        teamId,
        amount: 100,
        balance: 100,
        currency: 'CHF',
        status: 'active',
        purchaserContactId: null,
        purchaserEmail: null,
        payment_intent_id: null,
        created_at: ts(daysFromNow(-10)),
        updated_at: ts(daysFromNow(-10)),
      })
  }

  // ── storefront (studio+ only — products/website/online-courses are minPlan studio) ──
  // Gives studio/organization demo teams a complete public storefront: a Products
  // shop tab, a published website, a sellable course, and the full bio-link set.
  if (plan === 'studio' || plan === 'organization') {
    const storefront = {
      teamId,
      uid,
      teamName,
      teamSlug,
      accentColor,
      description: `${teamName} — managed with Linyup.`,
      primaryActivity: activities[0]?.name ?? 'Training',
      email,
      currency: 'CHF',
      installedDaysAgo: 60,
    }
    await seedStoreProducts(storefront)
    await seedStorePromoCode(storefront)
    await seedStoreWebsite(storefront)
    // Studio already seeds a full course set above (incl. a purchase course); the
    // organization tier has none of its own, so give it a free + sellable course here.
    if (plan === 'organization') {
      await seedStoreCourses(storefront, { includeFree: true })
    }
  }

  // ── kiosk plugin (studio+ only — minPlan studio) ───────────────────────────────
  if (plan === 'studio' || plan === 'organization') {
    await seedKiosk(teamId, uid)
  }

  // ── gamification plugin ─────────────────────────────────────────────────────
  // Same pairing as gift cards: the scores above are the DATA, the install is the
  // GATE. /gamification renders an install prompt without it, so seeding a team's
  // scoreboard and leaving the plugin off gives a demo tenant a leaderboard it
  // cannot open. Tracks the team's own gamification switch, which is off on coach.
  if (gamificationSettings.enabled) {
    await db
      .collection('teams')
      .doc(teamId)
      .collection('installed_plugins')
      .doc('gamification')
      .set({
        pluginId: 'gamification',
        teamId,
        installedAt: ts(daysFromNow(-90)),
        installedBy: uid,
        status: 'active',
        config: {},
      })
  }

  // ── automations (studio+ — 'outreach_templates' / 'automation_flows' are
  // Studio features, so the coach tier's empty /automations is the honest tier
  // difference, not a gap) ────────────────────────────────────────────────────
  if (plan !== 'coach') {
    await seedAutomations({ teamId, vocabulary: 'martial_arts' })
  }

  // ── team weekly reports — a year of history behind the dashboard trends ──────
  // generateWeeklyReports writes ONE row per ISO week and never backfills, so a
  // fresh tenant's Weekly trends / Trial funnel / Engagement charts are flat
  // lines on the first screen after login. Doc id = the ISO week label the
  // dashboard queries on (useDashboardData filters `iso_week >=`).
  //
  // Today's contact aggregates are the anchor; earlier weeks are that snapshot
  // scaled down an acquisition ramp, so the curve ends exactly where /contacts
  // actually stands rather than contradicting it.
  const byStage: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byAffiliationType: Record<string, number> = {}
  const bySubscriptionType: Record<string, number> = {}
  let withAffiliation = 0
  let withSubscription = 0
  for (let i = 0; i < contactSeeds.length; i++) {
    const c = contactSeeds[i]
    // Re-derive the stage through the SAME function that wrote it onto the
    // contact doc — a second copy of that mapping here would drift silently and
    // the charts would disagree with the list they summarise. Only `type` and
    // `hasAttended` reach the stage, so the other arguments are inert.
    const stage = acquisitionFieldsFor({
      type: c.type as 'student' | 'trial' | 'external',
      hasAttended: c.totalSessions > 0,
      milestoneTs: ts(new Date()),
      seed: `${teamId}-contact-${i}`,
    }).acquisition_stage as string
    byStage[stage] = (byStage[stage] ?? 0) + 1
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
    // Mirrors the affiliation condition used when the contacts were written.
    if (clubAffiliationType && c.type !== 'external' && c.status !== 'guest') {
      byAffiliationType[clubAffiliationType.key] =
        (byAffiliationType[clubAffiliationType.key] ?? 0) + 1
      if (statusCountsAsActive(c.status)) withAffiliation++
    }
    const sub = contactSubRank[i]
    if (sub) {
      bySubscriptionType[sub.subId] = (bySubscriptionType[sub.subId] ?? 0) + 1
      withSubscription++
    }
  }

  const REPORT_WEEKS = 52 // fills the dashboard's 4/8/13/26/52-week ranges
  for (let w = REPORT_WEEKS - 1; w >= 0; w--) {
    const monday = mondayOfWeeksAgo(w)
    const label = isoWeekLabel(monday)
    const seed = `${teamId}-wr-${w}`
    const progress = (REPORT_WEEKS - 1 - w) / (REPORT_WEEKS - 1) // 0 = oldest week
    const ramp = 0.62 + 0.38 * progress
    const factor = Math.min(1.05, Math.max(0.5, ramp + (seededRand(seed + 'n') - 0.5) * 0.08))

    // Roughly the seeded weekly timetable: group classes plus the odd appointment.
    const appointments = Math.floor(seededRand(seed + 'ap') * 3) // 0–2
    const group = 4 + Math.floor(seededRand(seed + 'gp') * 3) // 4–6
    const bookings = 1 + Math.round(progress * 4) + Math.floor(seededRand(seed + 'bk') * 2)
    const bkAppointments = Math.min(bookings, Math.floor(seededRand(seed + 'ba') * 2))

    await db
      .collection('teams')
      .doc(teamId)
      .collection('team_weekly_reports')
      .doc(label)
      .set({
        iso_week: label,
        generated_at: ts(new Date(monday.getTime() + 6 * 86_400_000)),
        active_contacts_count: Math.max(0, Math.round(contactSeeds.length * factor)),
        contacts_count_by_stage: scaleMap(byStage, factor),
        contacts_count_by_membership_status: scaleMap(byStatus, factor),
        contacts_with_active_affiliation: Math.round(withAffiliation * factor),
        contacts_count_by_affiliation_type: scaleMap(byAffiliationType, factor),
        contacts_with_active_subscription: Math.round(withSubscription * factor),
        contacts_count_by_subscription_type: scaleMap(bySubscriptionType, factor),
        sessions_count: group + appointments,
        sessions_count_by_type: { class: group, appointment: appointments },
        bookings_count: bookings,
        bookings_count_by_type: { class: bookings - bkAppointments, appointment: bkAppointments },
        trial_conversions_count:
          seededRand(seed + 'cv') < 0.25 + progress * 0.4
            ? 1 + Math.floor(seededRand(seed + 'cv2') * 2)
            : 0,
        trial_dropouts_count: seededRand(seed + 'dp') < 0.3 ? 1 : 0,
      })
  }

  // ── the money ledger (member_subscriptions + member_payments) ────────────────
  // Seeded AFTER contacts, because it reads their subscription assignment back:
  // inventing a membership for someone the studio never sold one to would put a
  // row on /payments that contradicts the contact's own profile.
  await seedTeamMoney({ teamId })
  // `subscription_history` — the ONLY store of a contact's plan PERIODS — is
  // seeded AFTER the money ledger, because it reads `active_subscriptions` back
  // (the concurrent-plans membership seeded above lands there via
  // `applySubscriptionRollups`). See scripts/lib/fixtures/subscriptionHistory.ts.
  await seedTeamSubscriptionHistory({ teamId })

  // ── the smaller cross-surface gaps (Phase 2 Lane 6) ────────────────────────
  // Each of these was a shipped feature with zero data behind it on every
  // surface. See scripts/lib/fixtures/engagement.ts.
  await seedContactNotes(teamId, uid)
  // The Juniors group below is DATA; contact-groups is the GATE — the group
  // picker, contact detail and the automation `in_group` condition all sit behind
  // /plugins/contact-groups, so without the install the seeded group is a
  // leaderboard nobody can open (the same trap gift cards and gamification
  // document above).
  await db
    .collection('teams')
    .doc(teamId)
    .collection('installed_plugins')
    .doc('contact-groups')
    .set({
      pluginId: 'contact-groups',
      teamId,
      installedAt: ts(daysFromNow(-90)),
      installedBy: uid,
      status: 'active',
      config: {},
    })
  await seedDynamicContactGroup(teamId, uid)
  await seedEventProgram(teamId, uid)
  await seedSessionWaitlist({ teamId })
  await seedCoursePurchase(teamId)

  // ── one-off sales, then the journal (studio+ only) ─────────────────────────
  // Finance is a studio-tier plugin; seedTeamFinance installs it AND replays
  // every member_payments row into the journal, so it must run LAST (after
  // seedTeamMoney above and the sales below). Without this the Finance plugin
  // (beta) is only exercisable against the cloud sandbox — the slowest place to
  // find a bug in it. Mirrors seed-sandbox.
  if (plan === 'studio' || plan === 'organization') {
    await seedTeamSales({ teamId })
    await seedTeamFinance({ teamId, uid })
  }

  // ── the asset register (Coach+, its OWN plugin) ─────────────────────────────
  // Deliberately outside the studio-only branch above and UNCONDITIONAL: the
  // register is included from Coach and stands alone, so a coach tenant must
  // show one too — that tenant is the whole reason it stopped being a finance
  // feature. Every team this function seeds is Coach or above by its own `plan`
  // type, so there is no tier left to guard against.
  await seedTeamAssetRegister({ teamId, uid })

  // ── documents (a default feature on every plan, not a plugin) ────────────────
  await seedDocuments(teamId, teamSlug, teamName, uid)

  // ── Stripe Connect (TEST) ───────────────────────────────────────────────────
  // Links a REAL onboarded test account when STRIPE_CONNECT_TEST_ACCOUNT names
  // one for this team; silently leaves the team payment-less otherwise. Last,
  // so it merges onto the public_profile written above rather than being
  // overwritten by it. See scripts/lib/connect.ts for the one-time setup.
  await linkSeedConnectAccount({ db, teamId })
}

// ── kiosk seed ──────────────────────────────────────────────────────────────────

async function seedKiosk(teamId: string, uid: string) {
  // Install the Kiosk plugin (studio+) with a configured default so it shows in the
  // sidebar + admin config. We ALSO denormalize the public subset straight into
  // public_profile (via toKioskPublicConfig) and flag the surface active, so the
  // public /kiosk page works from a fresh emulator seed regardless of whether the
  // syncTeamPublicProfile trigger has re-run. Merge keeps the other surfaces' flags.
  await db
    .collection('teams')
    .doc(teamId)
    .collection('installed_plugins')
    .doc('kiosk')
    .set({
      pluginId: 'kiosk',
      teamId,
      installedAt: ts(daysFromNow(-15)),
      installedBy: uid,
      status: 'active',
      config: DEFAULT_KIOSK_CONFIG,
    })

  await db
    .collection('teams')
    .doc(teamId)
    .collection('public_profile')
    .doc(teamId)
    .set(
      {
        active_public_surfaces: { kiosk: true },
        kiosk: toKioskPublicConfig(DEFAULT_KIOSK_CONFIG),
      },
      { merge: true }
    )
}

// ── automations seed (templates + presets + rules + logs) ─────────────────────
//
// /automations reads `outreach_templates`, `alert_presets`, `automation_rules`
// and `automation_logs`, and nothing generates any of them, so an unseeded tenant
// shows every tab empty. They are seeded together because they REFERENCE each
// other: a rule's `send_email` action names a template id and its `create_alert`
// action names a preset id, and a rule pointing at nothing is worse demo data
// than no rule at all.
//
// Language: the emulator's teams carry no language field, so the app resolves
// them as English — hence the `:en` template variants the library dialog looks
// for when matching an installed template to a library item.


// ── online courses seed ─────────────────────────────────────────────────────────

async function seedCourses(teamId: string, uid: string) {
  // Install the Online Courses plugin for this team so it appears in the sidebar.
  await db
    .collection('teams')
    .doc(teamId)
    .collection('installed_plugins')
    .doc('online-courses')
    .set({
      pluginId: 'online-courses',
      teamId,
      installedAt: ts(daysFromNow(-20)),
      installedBy: uid,
      status: 'active',
      config: {},
    })

  type LessonSeed = {
    title: string
    type: 'text' | 'audio' | 'video'
    body?: string
    mediaSource?: 'youtube' | 'vimeo' | 'url' | 'upload'
    mediaUrl?: string
    durationSeconds?: number
    attachments?: { name: string; url: string; size?: number; contentType?: string }[]
  }
  type ModuleSeed = { title: string; summary?: string; lessons: LessonSeed[] }
  type CourseSeed = {
    title: string
    summary: string
    status: 'draft' | 'published'
    accessType: 'free' | 'registered' | 'subscription' | 'purchase'
    subscriptionTypeIds?: string[]
    priceAmount?: number // major units (CHF); required for the 'purchase' tier
    /** Subscriber benefit on the purchase price (Course.benefit) — demos the
     *  percent_off middle ground the free-or-full inclusion can't express. */
    benefit?: { subscriptionTypeIds: string[]; effect: 'percent_off'; percent: number }
    modules: ModuleSeed[]
  }

  const courseSeeds: CourseSeed[] = [
    {
      title: 'BJJ Fundamentals',
      summary:
        'A beginner-friendly path through the core positions, escapes and submissions of Brazilian Jiu-Jitsu.',
      status: 'published',
      accessType: 'free',
      modules: [
        {
          title: 'Getting Started',
          summary: 'Orientation and your first day on the mats.',
          lessons: [
            {
              title: 'Welcome & how this course works',
              type: 'text',
              body: '<h2>Welcome</h2><p>This course takes you from your very first class to a confident understanding of the fundamentals.</p><p><strong>What you will need</strong></p><ul><li>A gi (or rashguard for no-gi classes)</li><li>A water bottle</li><li>An open mind</li></ul><p>Work through the modules in order — each one builds on the last.</p>',
            },
            {
              title: 'Mat etiquette & safety',
              type: 'video',
              mediaSource: 'youtube',
              mediaUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              durationSeconds: 420,
            },
          ],
        },
        {
          title: 'Core Positions',
          summary: 'Guard, mount, side control and the positional hierarchy.',
          lessons: [
            {
              title: 'Understanding the guard',
              type: 'video',
              mediaSource: 'youtube',
              mediaUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              durationSeconds: 600,
            },
            {
              title: 'Escaping side control',
              type: 'video',
              mediaSource: 'vimeo',
              mediaUrl: 'https://vimeo.com/76979871',
              durationSeconds: 540,
            },
            {
              title: 'Positional hierarchy cheat sheet',
              type: 'text',
              body: '<h3>Positional hierarchy</h3><p>From worst to best for you:</p><ol><li>Mounted / back taken (escape!)</li><li>Side control bottom</li><li>Guard (neutral)</li><li>Side control top</li><li>Mount</li><li>Back control (best)</li></ol><p>Always fight to improve your position before hunting for a submission.</p>',
              attachments: [
                {
                  name: 'positional-hierarchy.pdf',
                  url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
                  size: 13264,
                  contentType: 'application/pdf',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: 'Strength & Conditioning for Fighters',
      summary:
        'Build the engine: mobility, strength and recovery routines tailored for grapplers and strikers.',
      status: 'draft',
      accessType: 'registered',
      modules: [
        {
          title: 'Mobility Foundations',
          lessons: [
            {
              title: 'Daily mobility flow (guided audio)',
              type: 'audio',
              mediaSource: 'url',
              mediaUrl: 'https://download.samplelib.com/mp3/sample-12s.mp3',
              durationSeconds: 720,
            },
            {
              title: 'Warm-up principles',
              type: 'text',
              body: '<h3>Warm-up principles</h3><p>A good warm-up raises your core temperature, primes your nervous system and reduces injury risk.</p><ul><li>3–5 min easy movement</li><li>Joint circles (ankles, hips, shoulders, neck)</li><li>Sport-specific drills at increasing intensity</li></ul><p>Never roll or spar cold.</p>',
            },
          ],
        },
      ],
    },
    {
      // Published, "Sign-in required": any signed-in contact of the team can view.
      title: 'Competition Game Plan',
      summary:
        'Prepare for your first tournament: rule sets, weight cuts, bracket strategy and managing nerves on the day.',
      status: 'published',
      accessType: 'registered',
      modules: [
        {
          title: 'Before the Mats',
          summary: 'Everything to sort out in the weeks before you compete.',
          lessons: [
            {
              title: 'Choosing the right tournament',
              type: 'text',
              body: '<h3>Choosing your first tournament</h3><p>Pick a beginner-friendly, single-elimination event close to home. Read the rule set in full before you register, and double-check the weigh-in format.</p>',
            },
            {
              title: 'Managing the weight cut',
              type: 'video',
              mediaSource: 'youtube',
              mediaUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              durationSeconds: 480,
            },
          ],
        },
        {
          title: 'On the Day',
          lessons: [
            {
              title: 'Warm-up & nerves checklist',
              type: 'text',
              body: '<h3>On the day</h3><ol><li>Arrive early, find the bullpen.</li><li>Warm up ~2 matches before yours.</li><li>Breathe — box breathing 4-4-4-4.</li><li>Trust your A-game; keep it simple.</li></ol>',
              attachments: [
                {
                  name: 'competition-day-checklist.pdf',
                  url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
                  size: 13264,
                  contentType: 'application/pdf',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      // Published, subscription-gated: only contacts holding a Premium or Elite
      // subscription may view. Contact 2 (Premium annual) and contact 10 (Elite) can.
      title: 'Inside the Black Belt Curriculum',
      summary:
        'A members-only deep dive into the advanced systems we drill in our competition classes.',
      status: 'published',
      accessType: 'subscription',
      subscriptionTypeIds: [`${teamId}-sub-premium`, `${teamId}-sub-elite`],
      modules: [
        {
          title: 'Advanced Guard Systems',
          summary: 'The connected guard retention and attacking framework.',
          lessons: [
            {
              title: 'The retention framework',
              type: 'video',
              mediaSource: 'vimeo',
              mediaUrl: 'https://vimeo.com/76979871',
              durationSeconds: 900,
            },
            {
              title: 'Drilling plan (12 weeks)',
              type: 'text',
              body: '<h3>12-week drilling plan</h3><p>Two focused drilling blocks per week, 20 minutes each. Rotate through retention, recomposition and attacking sequences. Log your reps and review every fourth week.</p>',
            },
          ],
        },
      ],
    },
    {
      title: 'Competition Masterclass',
      summary:
        'A premium, self-paced masterclass on building a competition game — strategy, conditioning and mindset.',
      status: 'published',
      accessType: 'purchase',
      priceAmount: 49,
      // Elite subscribers buy it at half price (Course.benefit — resolved by
      // resolvePaymentOptions; the shop shows the struck-through member price).
      benefit: {
        subscriptionTypeIds: [`${teamId}-sub-elite`],
        effect: 'percent_off',
        percent: 50,
      },
      modules: [
        {
          title: 'Build your A-game',
          summary: 'The strategy and structure behind a winning competition plan.',
          lessons: [
            {
              title: 'Designing your competition game plan',
              type: 'video',
              mediaSource: 'vimeo',
              mediaUrl: 'https://vimeo.com/76979871',
              durationSeconds: 1080,
            },
            {
              title: 'Peaking: the 8-week conditioning block',
              type: 'text',
              body: '<h3>Peaking for competition</h3><p>An 8-week block that ramps intensity while protecting recovery, so you arrive on the day sharp and fresh.</p>',
            },
          ],
        },
      ],
    },
  ]

  for (let ci = 0; ci < courseSeeds.length; ci++) {
    const cs = courseSeeds[ci]
    const courseId = `${teamId}-course-${ci}`
    const slug = cs.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
    const lessonCount = cs.modules.reduce((n, m) => n + m.lessons.length, 0)
    const courseSlug = `${slug}-${ci}`
    const accessRule = {
      type: cs.accessType,
      ...(cs.subscriptionTypeIds ? { subscriptionTypeIds: cs.subscriptionTypeIds } : {}),
      ...(cs.accessType === 'purchase' && cs.priceAmount != null
        ? { priceAmount: cs.priceAmount }
        : {}),
    }

    await db
      .collection('courses')
      .doc(courseId)
      .set({
        scope: 'team',
        teamId,
        title: cs.title,
        slug: courseSlug,
        summary: cs.summary,
        status: cs.status,
        accessRule,
        ...(cs.benefit ? { benefit: cs.benefit } : {}),
        moduleCount: cs.modules.length,
        lessonCount,
        order: ci,
        created_at: ts(daysFromNow(-18 + ci)),
        updated_at: ts(daysFromNow(-2)),
        createdBy: uid,
        archived_at: null,
      })

    // Mirror what syncCoursePublicProfile writes, so the public "Space" web area can
    // list published courses without the Functions emulator running during seeding.
    if (cs.status === 'published') {
      await db
        .collection('courses')
        .doc(courseId)
        .collection('public_profile')
        .doc(courseId)
        .set({
          type: 'course',
          teamId,
          slug: courseSlug,
          title: cs.title,
          summary: cs.summary,
          coverImageUrl: null,
          accessType: cs.accessType,
          ...(cs.accessType === 'purchase' && cs.priceAmount != null
            ? { priceAmount: cs.priceAmount }
            : {}),
          // Mirrored exactly as syncCoursePublicProfile does.
          benefit: cs.benefit ?? null,
          subscriptionTypeIds: cs.subscriptionTypeIds ?? [],
          moduleCount: cs.modules.length,
          lessonCount,
          order: ci,
        })
    }

    for (let mi = 0; mi < cs.modules.length; mi++) {
      const m = cs.modules[mi]
      const moduleId = `${courseId}-module-${mi}`
      await db
        .collection('courses')
        .doc(courseId)
        .collection('modules')
        .doc(moduleId)
        .set({
          courseId,
          teamId,
          title: m.title,
          ...(m.summary ? { summary: m.summary } : {}),
          order: mi,
          created_at: ts(daysFromNow(-18 + ci)),
          updated_at: ts(daysFromNow(-2)),
        })

      for (let li = 0; li < m.lessons.length; li++) {
        const l = m.lessons[li]
        const lessonId = `${moduleId}-lesson-${li}`
        await db
          .collection('courses')
          .doc(courseId)
          .collection('lessons')
          .doc(lessonId)
          .set({
            courseId,
            moduleId,
            teamId,
            title: l.title,
            type: l.type,
            order: li,
            ...(l.body !== undefined ? { body: l.body } : {}),
            ...(l.mediaSource !== undefined ? { mediaSource: l.mediaSource } : {}),
            ...(l.mediaUrl !== undefined ? { mediaUrl: l.mediaUrl } : {}),
            ...(l.durationSeconds !== undefined ? { durationSeconds: l.durationSeconds } : {}),
            ...(l.attachments !== undefined ? { attachments: l.attachments } : {}),
            created_at: ts(daysFromNow(-18 + ci)),
            updated_at: ts(daysFromNow(-2)),
          })
      }
    }
  }
}

// ── org seed ──────────────────────────────────────────────────────────────────

async function seedOrg() {
  const ORG_ID = 'seed-org'
  const ORG_ADMIN = 'seed-org-uid' // Rafael Torres (also owns seed-team-org)
  const CLUB_A = 'seed-team-studio' // Iron Circle Gym (Anna Schmidt)
  const CLUB_B = 'seed-team-org' // Titan Combat Sports (Rafael Torres)

  const now = ts(new Date())
  const periodStart = ts(daysFromNow(-30))
  const periodEnd = ts(daysFromNow(1))

  // BJJ Belt ranking system — shared across all teams in this org
  const bjjBelt = [
    {
      id: 'bjj-belt',
      name: 'BJJ Belt',
      is_primary: true,
      levels: [
        { value: 0, label: 'White Belt', color: '#e5e7eb' },
        { value: 1, label: 'Blue Belt', color: '#1d4ed8' },
        { value: 2, label: 'Purple Belt', color: '#7e22ce' },
        { value: 3, label: 'Brown Belt', color: '#78350f' },
        { value: 4, label: 'Black Belt', color: '#111827' },
      ],
    },
  ]

  // ── Organization document ─────────────────────────────────────────────────
  await db
    .collection('organizations')
    .doc(ORG_ID)
    .set({
      name: 'Titan Martial Arts Association',
      slug: 'titan-martial-arts',
      description: 'The Titan organization — managing Iron Circle Gym and Titan Combat Sports.',
      plan: 'organization',
      plan_status: 'active',
      ranking_systems: bjjBelt.map((s) => ({ ...s, levels: withRankLevelIds(s.levels) })),
      created: ts(daysFromNow(-180)),
      createdBy: ORG_ADMIN,
    })

  // ── Org membership statuses (reused as affiliation statuses) ───────────────
  for (const st of DEFAULT_ORG_AFFILIATION_STATUSES) {
    await db
      .collection('organizations')
      .doc(ORG_ID)
      .collection(ORG_AFFILIATION_STATUSES_SUBCOLLECTION)
      .doc(st.id)
      .set(st)
  }

  // ── Org admin member ──────────────────────────────────────────────────────
  await db.collection('organizations').doc(ORG_ID).collection('org_members').doc(ORG_ADMIN).set({
    userId: ORG_ADMIN,
    orgId: ORG_ID,
    role: 'org_admin',
    joined: now,
    addedBy: ORG_ADMIN,
  })

  // Record orgId on the admin's user profile so the sidebar finds it without collectionGroup
  await db
    .collection('users')
    .doc(ORG_ADMIN)
    .update({
      orgIds: [ORG_ID],
    })

  // ── Org teams ─────────────────────────────────────────────────────────────
  for (const teamId of [CLUB_A, CLUB_B]) {
    await db.collection('organizations').doc(ORG_ID).collection('org_teams').doc(teamId).set({
      teamId,
      orgId: ORG_ID,
      status: 'active',
      joined: now,
      addedBy: ORG_ADMIN,
    })

    // Link team to org; clear team-level ranking_systems (org provides them)
    await db.collection('teams').doc(teamId).update({
      org_id: ORG_ID,
      organization_ids: [ORG_ID],
      affiliations_enabled: true,
      ranking_systems: [], // delegated to org
    })
  }

  // ── THE ORG ADMIN RUNS TWO OF ITS STUDIOS ─────────────────────────────────
  //
  // Without this NOBODY in the seed belongs to more than one studio, and the
  // scope switcher can only be half tested: `TeamSwitcher` renders its studios
  // list only for a login that is in more than one (its own rule — "it hides
  // itself, but only when it knows"), so the control showed an Organisations
  // group and nothing to switch BETWEEN. Franco hit exactly that trying to
  // verify it (2026-08-27).
  //
  // Rafael already owns Titan Combat Sports and administers the organisation;
  // making him a MANAGER of Iron Circle Gym as well is the persona the whole
  // scope model was designed around — the org admin who also runs a studio and
  // moves between the two all day (docs/org-navigation.md). It also exercises
  // the case that matters: switching to a studio where he is NOT the owner, so
  // the capability differences are real rather than theoretical.
  //
  // Manager, not owner: Anna owns Iron Circle Gym, and two owners would make the
  // seed say something about ownership it does not mean to say.
  await db
    .collection('teams')
    .doc(CLUB_A)
    .collection('team_members')
    .doc(ORG_ADMIN)
    .set({
      teamId: CLUB_A,
      userId: ORG_ADMIN,
      role: 'manager',
      email: 'org@linyup.com',
      ...memberCapsFor('manager'),
      joined: ts(daysFromNow(-60)),
      addedBy: 'seed-studio-uid',
    })

  // ── SaaS subscription for the org ────────────────────────────────────────
  await db
    .collection('saas_subscriptions')
    .doc(ORG_ID)
    .set({
      entity_type: 'org',
      entity_id: ORG_ID,
      teamId: ORG_ID, // backwards-compat field
      plan: 'organization',
      status: 'active',
      trial_ends_at: null,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      gateway_type: null,
      gateway_data: null,
      created_at: ts(daysFromNow(-180)),
      updated_at: now,
    })

  // ── Org-wide event ────────────────────────────────────────────────────────
  await db.collection('events').add({
    orgId: ORG_ID,
    teamId: null,
    scope: 'org',
    title: 'Titan Open Championship 2026',
    type: 'competition',
    start: ts(daysFromNow(45)),
    end: ts(daysFromNow(46)),
    location: 'Geneva Sports Arena',
    description: 'Annual open championship — all Titan clubs are invited to participate.',
    status: 'open',
    deleted_at: null,
    createdBy: ORG_ADMIN,
    created_at: now,
  })
}

// ── documents seed ──────────────────────────────────────────────────────────────

async function seedDocuments(
  teamId: string,
  teamSlug: string,
  teamName: string,
  uid: string,
) {
  // NO PLUGIN INSTALL. Documents is a default feature on every plan; its
  // signup-consent selection lives in teams/{teamId}/settings/documents, which is
  // where the panel writes it and where syncTeamPublicProfile reads it (falling
  // back to the retired plugin config only for teams the backfill has not
  // reached — a fresh seed is never one of those).
  await seedDocumentsSettings(teamId, [`${teamId}-doc-terms`, `${teamId}-doc-privacy`])

  const docSeeds = [
    {
      id: `${teamId}-doc-terms`,
      title: 'General Terms & Conditions',
      slug: `terms-${teamSlug.slice(0, 4)}`,
      kind: 'terms' as const,
      summary: `The general terms and conditions governing use of ${teamName}'s services.`,
      body: `<h2>General Terms &amp; Conditions</h2>
<p>These terms govern the relationship between ${teamName} ("the Studio") and its members. By registering, you agree to the following:</p>
<h3>1. Membership</h3>
<p>Your membership is personal and non-transferable. Access to classes requires a valid subscription or a valid drop-in pass.</p>
<h3>2. Cancellation</h3>
<p>Monthly subscriptions can be cancelled at any time with 30 days' notice. Annual plans are non-refundable once the commitment period begins.</p>
<h3>3. Conduct</h3>
<p>All members are expected to maintain respectful conduct during classes and open-mat sessions. The Studio reserves the right to revoke access for repeated violations.</p>
<h3>4. Liability</h3>
<p>Training is undertaken at your own risk. The Studio is not liable for injuries sustained during classes unless caused by gross negligence.</p>
<h3>5. Changes</h3>
<p>The Studio reserves the right to update these terms. Members will be notified of material changes via email.</p>`,
      order: 0,
    },
    {
      id: `${teamId}-doc-privacy`,
      title: 'Privacy Policy',
      slug: `privacy-${teamSlug.slice(0, 4)}`,
      kind: 'privacy' as const,
      summary: `How ${teamName} collects, uses, and protects your personal data.`,
      body: `<h2>Privacy Policy</h2>
<p>${teamName} ("we", "us") is committed to protecting your personal data. This policy explains what we collect and how we use it.</p>
<h3>Data we collect</h3>
<ul>
<li><strong>Account data:</strong> name, email, phone number, date of birth</li>
<li><strong>Attendance data:</strong> session check-ins and booking history</li>
<li><strong>Payment data:</strong> processed by our payment provider (we do not store card details)</li>
</ul>
<h3>How we use your data</h3>
<p>We use your data to manage your membership, communicate about classes and events, and improve our services. We never sell your data to third parties.</p>
<h3>Your rights</h3>
<p>You may request access, correction, or deletion of your data at any time by contacting us.</p>
<h3>Data retention</h3>
<p>We retain your data for the duration of your membership plus 2 years for legal compliance.</p>`,
      order: 1,
    },
    {
      id: `${teamId}-doc-rules`,
      title: 'House Rules & Regulations',
      slug: `house-rules-${teamSlug.slice(0, 4)}`,
      kind: 'regulation' as const,
      summary: 'Facility rules, hygiene standards, and training etiquette.',
      body: `<h2>House Rules &amp; Regulations</h2>
<p>To keep our training environment safe and respectful for everyone, please observe the following rules at all times.</p>
<h3>Hygiene</h3>
<ul>
<li>Trim your nails before every session</li>
<li>Wear a clean gi or rash guard — no street clothes on the mats</li>
<li>Use flip-flops off the mats to keep the training area clean</li>
</ul>
<h3>Training etiquette</h3>
<ul>
<li>Bow when stepping on and off the mats</li>
<li>Tap early and often — protect yourself and your partner</li>
<li>Respect the coach's instructions and the class structure</li>
</ul>
<h3>Facility</h3>
<ul>
<li>No shoes on the mats</li>
<li>No food or drink (except water) in the training area</li>
<li>Personal belongings must be stored in the lockers provided</li>
</ul>`,
      order: 2,
    },
  ]

  // The documents + the studio's liability WAIVER, each with its frozen v1
  // snapshot and public mirror, through the ONE shared writer
  // (scripts/lib/fixtures/documents.ts). This block used to live here and was
  // copied — divergently — into the other three seeders.
  //
  // The waiver is what makes teams/{teamId}/waiver_policy/current exist. Without
  // it the booking gate fails CLOSED onto "nothing to sign", so every seeded
  // tenant silently behaved as if the whole feature were switched off.
  await seedTeamWaiver({
    teamId,
    uid,
    teamName,
    teamSlug,
    otherDocuments: docSeeds,
    createdDaysAgo: 25,
  })
}

// ── free-plan team ────────────────────────────────────────────────────────────
// Minimal tenant pinned EXACTLY at the Free plan's contact hard cap
// (PLAN_PRICING.free.includedContacts, derived below), to exercise: blocked
// manual adds, portal "Powered by Linyup" badge, locked member invites, and
// fully upgrade-locked plugins.

async function seedFreeTeam() {
  const uid = 'seed-free-uid'
  const teamId = 'seed-team-free'
  const teamSlug = 'sunrise-yoga-studio'
  const teamName = 'Sunrise Yoga Studio'

  await auth.createUser({
    uid,
    email: 'free@linyup.com',
    password: 'linyup123',
    displayName: 'Luca Bianchi',
    emailVerified: true,
  })

  await db
    .collection('teams')
    .doc(teamId)
    .set({
      name: teamName,
      description: `${teamName} — managed with Linyup.`,
      slug: teamSlug,
      sport_type: 'Yoga',
      createdBy: uid,
      created: ts(daysFromNow(-60)),
      plan: 'free',
      plan_status: 'active',
      // Mimics a lapsed trial → drives the FreeDowngradeBanner in the web app.
      downgraded_from_trial_at: ts(daysFromNow(-5)),
      bioLinkTheme: 'light',
      bioLinkAccentColor: '#0d9488',
      bioLinkBackground: { type: 'solid', color: '#ffffff' },
      links: [
        {
          label: 'Book Now',
          target: 'booking',
          showInBioLink: true,
          iconName: 'CalendarPlus',
          url: null,
        },
      ],
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
    })

  await db
    .collection('teams')
    .doc(teamId)
    .collection('public_profile')
    .doc(teamId)
    .set({
      type: 'team',
      name: teamName,
      description: `${teamName} — managed with Linyup.`,
      slug: teamSlug,
      sport_type: 'Yoga',
      profileImage: null,
      heroImage: null,
      bioLinkTheme: 'light',
      bioLinkAccentColor: '#0d9488',
      bioLinkBackground: { type: 'solid', color: '#ffffff' },
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
      links: [
        {
          label: 'Book Now',
          target: 'booking',
          showInBioLink: true,
          iconName: 'CalendarPlus',
          url: null,
        },
      ],
      bookingSettings: {
        flowType: 'activity-first',
        windowMonths: 2,
        showPhone: true,
        ctaUrl: null,
        ctaLabel: null,
      },
      showBranding: true, // Free plan → "Powered by Linyup" badge on the portal
      updated_at: ts(new Date()),
    })

  await db
    .collection('teams')
    .doc(teamId)
    .collection('team_members')
    .doc(uid)
    .set({
      teamId,
      userId: uid,
      role: 'owner',
      email: 'free@linyup.com',
      ...memberCapsFor('owner'),
      joined: ts(daysFromNow(-60)),
    })

  await db
    .collection('users')
    .doc(uid)
    .set({
      email: 'free@linyup.com',
      displayName: 'Luca Bianchi',
      firstname: 'Luca',
      lastname: 'Bianchi',
      currentTeam: teamId,
      created_at: ts(daysFromNow(-60)),
    })

  // One bookable activity so the public portal flow works
  const actId = `${teamId}-act-yoga`
  await db
    .collection('activities')
    .doc(actId)
    .set({
      id: actId,
      teamId,
      name: 'Vinyasa Flow',
      slug: 'vinyasa-flow',
      color: '#0d9488',
      isFreeTrial: true,
      isActive: true,
      created_at: ts(daysFromNow(-60)),
    })
  await db.collection('activities').doc(actId).collection('public_profile').doc(actId).set({
    type: 'activity',
    activityType: 'class',
    teamId,
    name: 'Vinyasa Flow',
    slug: 'vinyasa-flow',
    color: '#0d9488',
    image_url: null,
    isFreeTrial: true,
  })

  // EXACTLY the Free plan's contact cap, DERIVED so it self-corrects if the cap
  // moves — the hard cap was raised 10 → 15 (2026-06-18) and this seed was left
  // at 10, which made the block, the over-cap upgrade prompt and the meter-at-
  // limit all unreachable, and printed a tenant that *claims* to be at cap yet
  // takes more contacts fine (so "is the cap wired?" reads as broken).
  const freeCap = PLAN_PRICING.free.includedContacts ?? 15
  const freeNamePool = [
    { firstname: 'Mia', lastname: 'Keller', gender: 'F' },
    { firstname: 'Jonas', lastname: 'Frei', gender: 'M' },
    { firstname: 'Lea', lastname: 'Steiner', gender: 'F' },
    { firstname: 'Noah', lastname: 'Brunner', gender: 'M' },
    { firstname: 'Elena', lastname: 'Marti', gender: 'F' },
    { firstname: 'Tim', lastname: 'Graf', gender: 'M' },
    { firstname: 'Sofia', lastname: 'Arnold', gender: 'F' },
    { firstname: 'Luca', lastname: 'Wyss', gender: 'M' },
    { firstname: 'Anna', lastname: 'Roth', gender: 'F' },
    { firstname: 'Felix', lastname: 'Baumann', gender: 'M' },
    { firstname: 'Nina', lastname: 'Weber', gender: 'F' },
    { firstname: 'Leon', lastname: 'Meier', gender: 'M' },
    { firstname: 'Sara', lastname: 'Huber', gender: 'F' },
    { firstname: 'David', lastname: 'Schmid', gender: 'M' },
    { firstname: 'Clara', lastname: 'Zbinden', gender: 'F' },
  ]
  const freeContacts = Array.from({ length: freeCap }, (_, i) =>
    freeNamePool[i] ?? { firstname: `Member${i + 1}`, lastname: 'Free', gender: i % 2 ? 'M' : 'F' }
  )
  for (let i = 0; i < freeContacts.length; i++) {
    const c = freeContacts[i]
    const id = `${teamId}-contact-${i.toString().padStart(3, '0')}`
    const createdTs = ts(daysFromNow(-50 + i))
    // All free-team contacts are joined members (entry 'signup').
    const acquisition = acquisitionFieldsFor({
      type: 'student',
      hasAttended: true,
      milestoneTs: createdTs,
      seed: id,
    })
    await db
      .collection('contacts')
      .doc(id)
      .set({
        teamId,
        ...c,
        email: `${c.firstname.toLowerCase()}.${c.lastname.toLowerCase()}.${teamId}@email.com`,
        // Free plan does not enable the affiliation axis — no affiliation docs.
        total_sessions: 5 + i,
        last_session_at: ts(daysFromNow(-(i + 1))),
        created_at: createdTs,
        deleted_at: null,
        archived_at: null,
        ...acquisition,
      })
  }

  // Documents plugin — available on free plan too
  await seedDocuments(teamId, teamSlug, teamName, uid)
}

// ── studio coach (granular roles demo) ──────────────────────────────────────────
// Adds a second team member to the Studio team with the own-scoped 'coach' role, a
// handful of assigned contacts and a couple of their own sessions, so the Coach role
// can be exercised end-to-end (sign in as coach2@linyup.com / linyup123).
async function seedStudioCoach() {
  const teamId = 'seed-team-studio'
  const uid = 'seed-studio-coach'
  const email = 'coach2@linyup.com'
  const displayName = 'Marco Silva'

  await auth
    .createUser({ uid, email, password: 'linyup123', displayName, emailVerified: true })
    .catch(() => {})

  const coachCapabilities = COACH_DEFAULT_CAPABILITIES

  await db
    .collection('teams')
    .doc(teamId)
    .collection('team_members')
    .doc(uid)
    .set({
      teamId,
      userId: uid,
      role: 'coach',
      email,
      capabilities: coachCapabilities,
      scope: 'own',
      joined: ts(daysFromNow(-60)),
      addedBy: uid,
    })

  await db.collection('users').doc(uid).set({
    email,
    displayName,
    firstname: 'Marco',
    lastname: 'Silva',
    currentTeam: teamId,
    created_at: ts(daysFromNow(-60)),
  })

  // A stored Coach override so Settings → Roles shows a saved config.
  // coachRoles includes owner + manager so they appear in the coach picker.
  await db
    .collection('teams')
    .doc(teamId)
    .collection('role_config')
    .doc('coach')
    .set({
      role: 'coach',
      capabilities: coachCapabilities,
      coachRoles: ['owner', 'manager', 'coach'],
      updatedBy: uid,
      updated_at: ts(daysFromNow(-60)),
    })

  // Assign the first few active studio contacts to the coach (their own book).
  const contactsSnap = await db
    .collection('contacts')
    .where('teamId', '==', teamId)
    .where('deleted_at', '==', null)
    .where('archived_at', '==', null)
    .limit(6)
    .get()
  for (const c of contactsSnap.docs) {
    await c.ref.update({ assigned_coach_ids: admin.firestore.FieldValue.arrayUnion(uid) })
  }

  // Give the coach a couple of their own sessions to manage.
  const sessionsSnap = await db.collection('sessions').where('teamId', '==', teamId).limit(3).get()
  for (const s of sessionsSnap.docs) {
    await s.ref.update({ providerId: uid, providerName: displayName })
  }

  console.log(
    `   Coach: ${displayName} (${email}) — studio team, ${contactsSnap.size} contacts + ${sessionsSnap.size} sessions assigned`
  )
}

// ── studio manager (multi-role demo) ──────────────────────────────────────────
// Adds a manager to the Studio team so the coach picker shows all three eligible
// roles (owner, manager, coach). Sign in as manager@linyup.com / linyup123.
async function seedStudioManager() {
  const teamId = 'seed-team-studio'
  const uid = 'seed-studio-manager'
  const email = 'manager@linyup.com'
  const displayName = 'Elena Rossi'

  await auth
    .createUser({ uid, email, password: 'linyup123', displayName, emailVerified: true })
    .catch(() => {})

  await db
    .collection('teams')
    .doc(teamId)
    .collection('team_members')
    .doc(uid)
    .set({
      teamId,
      userId: uid,
      role: 'manager',
      email,
      ...memberCapsFor('manager'),
      joined: ts(daysFromNow(-90)),
      addedBy: 'seed-studio-uid',
    })

  await db.collection('users').doc(uid).set({
    email,
    displayName,
    firstname: 'Elena',
    lastname: 'Rossi',
    currentTeam: teamId,
    created_at: ts(daysFromNow(-90)),
  })

  console.log(`   Manager: ${displayName} (${email}) — studio team`)
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🗑  Clearing emulator data…')
  await clearEmulator()

  const accounts = [
    {
      uid: 'seed-coach-uid',
      email: 'coach@linyup.com',
      displayName: 'Marco Rossi',
      teamId: 'seed-team-coach',
      teamName: 'Samurai Fight Academy',
      teamSlug: 'samurai-fight-academy',
      plan: 'coach' as const,
      planStatus: 'trial' as const,
      accentColor: '#7c3aed',
    },
    {
      uid: 'seed-studio-uid',
      email: 'studio@linyup.com',
      displayName: 'Anna Schmidt',
      teamId: 'seed-team-studio',
      teamName: 'Iron Circle Gym',
      teamSlug: 'iron-circle-gym',
      plan: 'studio' as const,
      planStatus: 'active' as const,
      accentColor: '#dc2626',
    },
    {
      uid: 'seed-org-uid',
      email: 'org@linyup.com',
      displayName: 'Rafael Torres',
      teamId: 'seed-team-org',
      teamName: 'Titan Combat Sports',
      teamSlug: 'titan-combat-sports',
      plan: 'organization' as const,
      planStatus: 'active' as const,
      accentColor: '#0284c7',
    },
  ]

  // -- SIGNUP HAS TO BE REACHABLE LOCALLY -------------------------------------
  // `app_settings/public` is the world-readable flag BOTH halves of the signup
  // gate read: the login page's "Create an account" link
  // (`usePublicSignupEnabled`) and the `beforeSignup` blocking function that
  // actually admits the account. Both fail CLOSED on a missing doc, by design —
  // and nothing seeded it, so on a fresh emulator the link was invisible and
  // signing up was refused outright. The whole flow was untestable on the one
  // machine where it most needs to be testable.
  //
  // Written OPEN here and nowhere else. Staging and production carry their own
  // value, toggled from the operator console; this is the emulator saying "yes,
  // of course you can sign up on your own machine".
  await db.collection(APP_SETTINGS_COLLECTION).doc(PUBLIC_SETTINGS_DOC).set({
    public_signup_enabled: true,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_by: 'seed-emulator',
  })
  console.log('\n[open]  Public signup enabled (app_settings/public)')

  for (const account of accounts) {
    console.log(`\n🏟  Seeding ${account.plan} account (${account.email})…`)
    await seedTeam(account)
  }

  console.log('\n🧘  Seeding free account (free@linyup.com)…')
  await seedFreeTeam()

  console.log('\n🏢  Seeding organization (Titan Martial Arts Association)…')
  await seedOrg()

  console.log('\n🧑‍🏫  Seeding studio staff (granular roles demo)…')
  await seedStudioManager()
  await seedStudioCoach()

  // The member app's test login: the SAME review studio production provisions
  // from the console, plus its fixed sign-in code and the app's min-version
  // policy. See scripts/lib/mobile.ts.
  console.log('\n📱  Seeding the member-app review studio (linyup-demo)…')
  const memberApp = await seedReviewTenant({ db, seededBy: 'seed-emulator' })
  await seedMobileSettings({ db, seededBy: 'seed-emulator' })

  console.log('\n✅ Emulator seeded successfully!\n')
  console.log('   ┌─────────────────────┬──────────────────────┬──────────────┬────────────┐')
  console.log('   │ Plan                │ Email                │ Password     │ Status     │')
  console.log('   ├─────────────────────┼──────────────────────┼──────────────┼────────────┤')
  console.log(
    `   │ free (at cap ${PLAN_PRICING.free.includedContacts}/${PLAN_PRICING.free.includedContacts}) │ free@linyup.com      │ linyup123    │ active     │`
  )
  console.log('   │ coach               │ coach@linyup.com     │ linyup123    │ trial      │')
  console.log('   │ studio (mgr+coach)  │ studio@linyup.com      │ linyup123    │ active     │')
  console.log('   │ org admin           │ org@linyup.com       │ linyup123    │ active     │')
  console.log('   └─────────────────────┴──────────────────────┴──────────────┴────────────┘\n')
  console.log('   Organization: Titan Martial Arts Association (org@linyup.com is org admin)')
  printMemberAppLogin(memberApp)
  console.log('   org@linyup.com is ALSO a manager of Iron Circle Gym — the two-studio')
  console.log('   login the scope switcher needs to be testable at all.')
  console.log('   Teams in org: Iron Circle Gym + Titan Combat Sports')
  console.log('   Studio staff: manager@linyup.com (manager) + coach2@linyup.com (coach)\n')
  console.log(
    '   Online Courses: 2 courses seeded for studio@linyup.com → /plugins/online-courses'
  )
  console.log(
    '   Documents: 3 documents seeded per team (terms, privacy, house rules) → /plugins/documents\n'
  )
  console.log('   Portals:')
  for (const a of accounts) {
    console.log(`   ${a.plan.padEnd(16)} →  http://localhost:3000/public/${a.teamSlug}`)
  }
  console.log(
    `   ${'free'.padEnd(16)} →  http://localhost:3000/public/sunrise-yoga-studio  (shows "Powered by Linyup")`
  )
  reportSeedConnectAccounts()
  console.log('')
}

main().catch((err) => {
  console.error('❌ Seed failed:', err)
  process.exit(1)
})
