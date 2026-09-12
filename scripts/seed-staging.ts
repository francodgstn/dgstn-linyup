/**
 * Seed script for the **linyup-staging** Firebase project.
 *
 * Auth: uses gcloud Application Default Credentials (ADC). No service-account
 * JSON is required — run `gcloud auth application-default login` once if ADC is
 * not already active. The active ADC identity needs Editor (or Firebase Admin +
 * Datastore + Identity Toolkit Admin) on the project.
 *
 * Usage:
 *   pnpm seed:staging
 *
 * The script is idempotent: every document uses a deterministic ID and is
 * written with set(), so re-running overwrites rather than duplicating. To start
 * from a clean slate, run `pnpm reset:staging` first.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * NOT WIRED FOR STRIPE CONNECT — deliberately, and it is a separate decision.
 *
 * seed-emulator / seed-sandbox / seed-lead link a real Stripe TEST connected
 * account when STRIPE_CONNECT_TEST_ACCOUNT names one, so their priced doors show
 * (payments_enabled fails closed — UX-33). This script does NOT, because staging
 * is a REAL deployed project with its own live Connect webhook endpoint on the
 * same Stripe TEST platform: attaching a developer's shared test acct here moves
 * `connect_accounts/{acct}.teamId` for staging AND leaves both endpoints
 * receiving each other's `checkout.session.completed` events. Whether staging
 * gets its own dedicated onboarded test account is a call to make with the
 * staging Stripe configuration in front of you, not a seeding default.
 *
 * To wire a staging team by hand, on purpose:
 *   pnpm connect:test-account --team <teamId> --account acct_… --target staging
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * What it creates — three SaaS plan tiers, all major features covered:
 *
 *   coach@linyup.com   / linyup123  →  plan: coach        (trial)
 *   studio@linyup.com    / linyup123  →  plan: studio       (active, 2 coaches)
 *   org@linyup.com     / linyup123  →  plan: organization (active, org admin)
 *
 *   Coach team:  Samurai Fight Academy        — 15 contacts
 *   Studio team: Iron Circle Gym              — 30 contacts, gamification, automations
 *   Org:         Titan Martial Arts Assoc.    — 2 member teams:
 *                  · Titan Combat Sports       — 20 contacts (owned by org admin)
 *                  · Titan Striking Lab        — 18 contacts (owned by 2nd coach)
 *
 *   Per team (where the plan allows the feature):
 *   - activities (group classes + 1 appointment) + public_profile
 *   - 1 availability doc ('range' mode) + a few BOOKED appointment sessions
 *     (availability-only: nothing exists until a client books)
 *   - subscription types (2-6 per team, internal + aggregator)
 *   - sessions: 4 past weeks + 4 upcoming weeks, with attendance + bookings
 *   - contacts with: identity, membership status, subscription, rank, notes,
 *     gamification (score, streak, badges, monthly_scores), alerts, goals/tasks
 *   - subscription_history, contact_weekly_reports, contact_alerts (show_in_app)
 *   - team activity_log
 *   - alert_presets + outreach_templates + automation_rules + automation_logs (studio+)
 *   - events + invitations + attendees
 *   - saas_subscriptions (mirrors what the Stripe webhook would write)
 *
 *   Auth users:
 *   - one coach (owner) per team + a second coach for studio / org-team-b
 *   Contacts have NO auth users: a contact signs in through the passwordless
 *   code flow, which mints its session on demand. The member app's test login
 *   is the review studio (scripts/lib/mobile.ts, docs/test-accounts.md).
 */

import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
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
import { partnerAppNames } from './lib/partnerApps'
import { normalizeActivityTags, withRankLevelIds } from '@linyup/shared'
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
import { seedSessionSeries, seedTeamGiftCards, seedTeamPlaces } from './lib/fixtures/studio'
import {
  seedContactNotes,
  seedCoursePurchase,
  seedDynamicContactGroup,
  seedEventProgram,
  seedSessionWaitlist,
} from './lib/fixtures/engagement'
import { seedTeamMoney } from './lib/fixtures/money'
import { seedTeamSubscriptionHistory } from './lib/fixtures/subscriptionHistory'
import { printMemberAppLogin, seedMobileSettings, seedReviewTenant } from './lib/mobile'

const PROJECT_ID = 'linyup-staging'

admin.initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })

const auth = admin.auth()
const db = admin.firestore()
db.settings({ ignoreUndefinedProperties: true })

// ── helpers ───────────────────────────────────────────────────────────────────

const ts = (date: Date) => admin.firestore.Timestamp.fromDate(date)
const now = () => new Date()

function daysFromNow(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
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
// and 'import', reserved for migrated contacts).
const SEED_SOURCES = ['website', 'referral', 'social', 'event', 'other'] as const

// Pick a deterministic marketing source for a seeded contact.
function pickSource(seed: string): (typeof SEED_SOURCES)[number] {
  return SEED_SOURCES[Math.floor(seededRand(seed + 'src') * SEED_SOURCES.length)]
}

// Derive the acquisition-axis fields written to a contact doc from the authoring
// `type` + whether the contact has attended. The old `type` field is NOT returned —
// it must not be written to the doc.
//   student  → joined / entry 'signup'  / converted_at
//   external → joined / entry 'import'  + 'external' tag (added at the call site)
//   trial    → trial_attended (attended) | trial_booked (no-show), entry 'booking'
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
      out.lead_acknowledged = false
    }
  }
  return out
}

// ── contact pool ────────────────────────────────────────────────────────────
// 32 entries, ordered so any prefix (15 / 18 / 20 / 30) yields a realistic mix
// of active students, trials, almost-ready leads, expired and external contacts.

// NOTE: no 'dropin' kind any more — the "Drop-in" per-class subscription PLAN was
// removed (2026-07): drop-in is the per-activity `Activity.dropIn` price, paid per
// booking, not a membership. Pay-per-class contacts simply hold no subscription.
type SubKind = 'starter_monthly' | 'starter_annual' | 'premium_monthly' | 'premium_annual' | 'elite_monthly' | 'aggregator' | null

interface PoolEntry {
  firstname: string
  lastname: string
  gender: 'M' | 'F'
  birthYear: number | null
  birthplace: string | null
  type: 'student' | 'trial' | 'external'
  status: 'active' | 'almost_ready' | 'under_review' | 'expired' | 'requested' | 'guest'
  totalSessions: number
  sub: SubKind
}

const CONTACT_POOL: PoolEntry[] = [
  {
    firstname: 'Luca',
    lastname: 'Ferrari',
    gender: 'M',
    birthYear: 1992,
    birthplace: 'Milan',
    type: 'student',
    status: 'active',
    totalSessions: 142,
    sub: 'premium_monthly',
  },
  {
    firstname: 'Sofia',
    lastname: 'Bianchi',
    gender: 'F',
    birthYear: 1995,
    birthplace: 'Rome',
    type: 'student',
    status: 'active',
    totalSessions: 88,
    sub: 'premium_annual',
  },
  {
    firstname: 'Alex',
    lastname: 'Müller',
    gender: 'M',
    birthYear: 1988,
    birthplace: 'Zurich',
    type: 'student',
    status: 'active',
    totalSessions: 210,
    sub: 'elite_monthly',
  },
  {
    firstname: 'Chiara',
    lastname: 'Romano',
    gender: 'F',
    birthYear: 1999,
    birthplace: 'Naples',
    type: 'student',
    status: 'active',
    totalSessions: 34,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Matteo',
    lastname: 'Esposito',
    gender: 'M',
    birthYear: 1990,
    birthplace: 'Turin',
    type: 'student',
    status: 'active',
    totalSessions: 121,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Julia',
    lastname: 'Weber',
    gender: 'F',
    birthYear: 2000,
    birthplace: 'Basel',
    type: 'student',
    status: 'almost_ready',
    totalSessions: 7,
    // Pay-per-class regular: no subscription — she books via the per-activity
    // drop-in price (the Drop-in PLAN is gone; see the SubKind note).
    sub: null,
  },
  {
    firstname: 'David',
    lastname: 'Costa',
    gender: 'M',
    birthYear: 1993,
    birthplace: 'Lisbon',
    type: 'student',
    status: 'active',
    totalSessions: 56,
    sub: 'aggregator',
  },
  {
    firstname: 'Lorenzo',
    lastname: 'De Luca',
    gender: 'M',
    birthYear: 2003,
    birthplace: 'Palermo',
    type: 'trial',
    status: 'requested',
    totalSessions: 1,
    sub: null,
  },
  {
    firstname: 'Sara',
    lastname: 'Ricci',
    gender: 'F',
    birthYear: 1994,
    birthplace: 'Bologna',
    type: 'student',
    status: 'expired',
    totalSessions: 41,
    sub: null,
  },
  {
    firstname: 'Hannah',
    lastname: 'Fischer',
    gender: 'F',
    birthYear: 1997,
    birthplace: 'Bern',
    type: 'external',
    status: 'guest',
    totalSessions: 0,
    sub: null,
  },
  {
    firstname: 'Emma',
    lastname: 'Schneider',
    gender: 'F',
    birthYear: 2001,
    birthplace: 'Geneva',
    type: 'student',
    status: 'active',
    totalSessions: 29,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Radu',
    lastname: 'Ionescu',
    gender: 'M',
    birthYear: 1987,
    birthplace: 'Bucharest',
    type: 'student',
    status: 'active',
    totalSessions: 175,
    sub: 'starter_annual',
  },
  {
    firstname: 'Nina',
    lastname: 'Moreau',
    gender: 'F',
    birthYear: 1991,
    birthplace: 'Paris',
    type: 'student',
    status: 'active',
    totalSessions: 96,
    sub: 'premium_monthly',
  },
  {
    firstname: 'Kevin',
    lastname: 'Nguyen',
    gender: 'M',
    birthYear: 1998,
    birthplace: 'Lyon',
    type: 'trial',
    status: 'under_review',
    totalSessions: 2,
    sub: null,
  },
  {
    firstname: 'Tobias',
    lastname: 'Huber',
    gender: 'M',
    birthYear: 1996,
    birthplace: 'Lucerne',
    type: 'student',
    status: 'active',
    totalSessions: 48,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Valentina',
    lastname: 'Greco',
    gender: 'F',
    birthYear: 1993,
    birthplace: 'Catania',
    type: 'student',
    status: 'active',
    totalSessions: 63,
    sub: 'premium_monthly',
  },
  {
    firstname: 'Marco',
    lastname: 'Conti',
    gender: 'M',
    birthYear: 1997,
    birthplace: 'Florence',
    type: 'student',
    status: 'almost_ready',
    totalSessions: 5,
    sub: null,
  },
  {
    firstname: 'Amélie',
    lastname: 'Dupont',
    gender: 'F',
    birthYear: 2002,
    birthplace: 'Geneva',
    type: 'trial',
    status: 'requested',
    totalSessions: 0,
    sub: null,
  },
  {
    firstname: 'Jonas',
    lastname: 'Keller',
    gender: 'M',
    birthYear: 1989,
    birthplace: 'Zurich',
    type: 'student',
    status: 'active',
    totalSessions: 134,
    sub: 'elite_monthly',
  },
  {
    firstname: 'Léa',
    lastname: 'Martin',
    gender: 'F',
    birthYear: 1996,
    birthplace: 'Geneva',
    type: 'student',
    status: 'active',
    totalSessions: 72,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Andrei',
    lastname: 'Popescu',
    gender: 'M',
    birthYear: 1992,
    birthplace: 'Cluj',
    type: 'student',
    status: 'expired',
    totalSessions: 38,
    sub: null,
  },
  {
    firstname: 'Giulia',
    lastname: 'Marino',
    gender: 'F',
    birthYear: 2000,
    birthplace: 'Genoa',
    type: 'student',
    status: 'active',
    totalSessions: 24,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Felix',
    lastname: 'Wagner',
    gender: 'M',
    birthYear: 1985,
    birthplace: 'Basel',
    type: 'student',
    status: 'active',
    totalSessions: 188,
    sub: 'aggregator',
  },
  {
    firstname: 'Camille',
    lastname: 'Girard',
    gender: 'F',
    birthYear: 1999,
    birthplace: 'Lausanne',
    type: 'trial',
    status: 'requested',
    totalSessions: 1,
    sub: null,
  },
  {
    firstname: 'Stefan',
    lastname: 'Brunner',
    gender: 'M',
    birthYear: 1994,
    birthplace: 'St. Gallen',
    type: 'student',
    status: 'active',
    totalSessions: 81,
    sub: 'premium_monthly',
  },
  {
    firstname: 'Aisha',
    lastname: 'Diallo',
    gender: 'F',
    birthYear: 1998,
    birthplace: 'Geneva',
    type: 'student',
    status: 'active',
    totalSessions: 52,
    sub: 'premium_monthly',
  },
  {
    firstname: 'Paolo',
    lastname: 'Russo',
    gender: 'M',
    birthYear: 1991,
    birthplace: 'Bari',
    type: 'student',
    status: 'almost_ready',
    totalSessions: 8,
    sub: null,
  },
  {
    firstname: 'Marie',
    lastname: 'Lefebvre',
    gender: 'F',
    birthYear: 1995,
    birthplace: 'Neuchâtel',
    type: 'student',
    status: 'active',
    totalSessions: 110,
    sub: 'premium_annual',
  },
  {
    firstname: 'Dragan',
    lastname: 'Petrović',
    gender: 'M',
    birthYear: 1990,
    birthplace: 'Belgrade',
    type: 'student',
    status: 'active',
    totalSessions: 67,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Yuki',
    lastname: 'Tanaka',
    gender: 'F',
    birthYear: 1997,
    birthplace: 'Zurich',
    type: 'student',
    status: 'active',
    totalSessions: 45,
    sub: 'starter_monthly',
  },
  {
    firstname: 'Thomas',
    lastname: 'Meier',
    gender: 'M',
    birthYear: 1986,
    birthplace: 'Winterthur',
    type: 'external',
    status: 'guest',
    totalSessions: 0,
    sub: null,
  },
  {
    firstname: 'Elena',
    lastname: 'Novak',
    gender: 'F',
    birthYear: 2001,
    birthplace: 'Ljubljana',
    type: 'student',
    status: 'active',
    totalSessions: 19,
    sub: 'starter_monthly',
  },
]

// Badge catalogue — assigned by attendance milestones / behaviour.
function badgesFor(totalSessions: number, streak: number, seed: string): string[] {
  const out: string[] = []
  if (totalSessions >= 50) out.push('50_sessions')
  if (totalSessions >= 100) out.push('100_sessions')
  if (totalSessions >= 200) out.push('200_sessions')
  if (streak >= 4) out.push('streak_master')
  if (seededRand(seed + 'eb') > 0.6) out.push('early_bird')
  if (seededRand(seed + 'wr') > 0.75) out.push('weekend_warrior')
  return out
}

// ── per-team seed ─────────────────────────────────────────────────────────────

interface TeamSeed {
  uid: string
  email: string
  displayName: string
  teamId: string
  teamName: string
  teamSlug: string
  plan: 'coach' | 'studio' | 'organization'
  planStatus: 'trial' | 'active'
  accentColor: string
  tagline: string // portal home description (public_profile.description)
  portalGradient: string // BIO_LINK_GRADIENTS key (apps/web/src/lib/bioLink.ts)
  contactCount: number
  orgId?: string // set when the team is an org member team
  extraStaff?: { uid: string; displayName: string; email: string; role: 'manager' | 'coach' }[]
}

async function seedTeam(opts: TeamSeed) {
  const {
    uid,
    email,
    displayName,
    teamId,
    teamName,
    teamSlug,
    plan,
    planStatus,
    accentColor,
    tagline,
    portalGradient,
    contactCount,
    orgId,
    extraStaff = [],
  } = opts

  const automationsEnabled = plan !== 'coach'
  const gamificationEnabled = plan !== 'coach'

  // ── affiliation config ───────────────────────────────────────────────────────
  // Studio/Org teams enable the affiliation axis. Org-member teams issue at the
  // ORG level (federation licence + club); standalone studios issue a team-local
  // club membership. Coach plan stays single-surface (no axis).
  const affiliationsEnabled = plan === 'studio' || plan === 'organization'
  const affiliationTypeDefs = affiliationsEnabled
    ? orgId
      ? orgAffiliationTypes(orgId)
      : teamAffiliationTypes()
    : []
  const clubAffiliationType = affiliationTypeDefs.find((t) => t.key === 'club') ?? null

  // ── subscription types ──────────────────────────────────────────────────────
  const subscriptionTypeDefs =
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
      : [
          {
            id: `${teamId}-sub-starter`,
            name: 'Starter',
            description: 'Essential access — up to 3 group classes per week.',
            source: 'internal',
            prices: [
              { id: `${teamId}-sub-starter-monthly`, amount: 89, recurrence: 'monthly' },
              { id: `${teamId}-sub-starter-annual`, amount: 890, recurrence: 'annual' },
            ],
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
            active: true,
          },
        ]
  // Map a pool SubKind → concrete subscription type + price for this team.
  type SubResolve = { id: string; name: string; priceId: string | null; amount: number | null; recurrence: string | null }

  function resolveSub(kind: SubKind): SubResolve | null {
    if (!kind) return null
    switch (kind) {
      case 'starter_monthly':
        return plan === 'coach'
          ? { id: `${teamId}-sub-monthly`, name: 'Monthly Membership', priceId: `${teamId}-sub-monthly-price`, amount: 95, recurrence: 'monthly' }
          : { id: `${teamId}-sub-starter`, name: 'Starter', priceId: `${teamId}-sub-starter-monthly`, amount: 89, recurrence: 'monthly' }
      case 'starter_annual':
        return plan === 'coach'
          ? { id: `${teamId}-sub-monthly`, name: 'Monthly Membership', priceId: `${teamId}-sub-monthly-price`, amount: 95, recurrence: 'monthly' }
          : { id: `${teamId}-sub-starter`, name: 'Starter', priceId: `${teamId}-sub-starter-annual`, amount: 890, recurrence: 'annual' }
      case 'premium_monthly':
        return plan === 'coach'
          ? { id: `${teamId}-sub-monthly`, name: 'Monthly Membership', priceId: `${teamId}-sub-monthly-price`, amount: 95, recurrence: 'monthly' }
          : { id: `${teamId}-sub-premium`, name: 'Premium', priceId: `${teamId}-sub-premium-monthly`, amount: 139, recurrence: 'monthly' }
      case 'premium_annual':
        return plan === 'coach'
          ? { id: `${teamId}-sub-monthly`, name: 'Monthly Membership', priceId: `${teamId}-sub-monthly-price`, amount: 95, recurrence: 'monthly' }
          : { id: `${teamId}-sub-premium`, name: 'Premium', priceId: `${teamId}-sub-premium-annual`, amount: 1390, recurrence: 'annual' }
      case 'elite_monthly':
        return plan === 'coach'
          ? { id: `${teamId}-sub-monthly`, name: 'Monthly Membership', priceId: `${teamId}-sub-monthly-price`, amount: 95, recurrence: 'monthly' }
          : { id: `${teamId}-sub-elite`, name: 'Elite', priceId: `${teamId}-sub-elite-monthly`, amount: 189, recurrence: 'monthly' }
      case 'aggregator':
        return { id: `${teamId}-sub-fitpass`, name: 'FitPass Partner', priceId: null, amount: null, recurrence: null }
    }
  }

  // ── ranking system ───────────────────────────────────────────────────────────
  const rankingSystemDefs =
    plan === 'coach'
      ? [
          {
            id: 'training-level',
            name: 'Training Level',
            is_primary: true,
            levels: [
              { label: 'Beginner', color: '#6b7280' },
              { label: 'Intermediate', color: '#2563eb' },
              { label: 'Advanced', color: '#7c3aed' },
              { label: 'Expert', color: '#dc2626' },
            ],
          },
        ]
      : [
          {
            id: 'bjj-belt',
            name: 'BJJ Belt',
            is_primary: true,
            levels: [
              { label: 'White Belt', color: '#e5e7eb' },
              { label: 'Blue Belt', color: '#1d4ed8' },
              { label: 'Purple Belt', color: '#7e22ce' },
              { label: 'Brown Belt', color: '#78350f' },
              { label: 'Black Belt', color: '#111827' },
            ],
          },
        ]
  const rankSystemId = plan === 'coach' ? 'training-level' : 'bjj-belt'

  function rankFor(entry: PoolEntry): number | null {
    if (entry.type !== 'student') return null
    const s = entry.totalSessions
    if (plan === 'coach') return s < 10 ? 0 : s < 40 ? 1 : s < 90 ? 2 : 3
    return s < 15 ? 0 : s < 40 ? 1 : s < 80 ? 2 : s < 140 ? 3 : 4
  }

  // ── gamification settings ─────────────────────────────────────────────────────
  const gamificationSettings = gamificationEnabled
    ? {
        enabled: true,
        default_base_score: 10,
        streak_min_sessions: 2,
        monthly_cap: plan === 'organization' ? 300 : 200,
        time_multipliers: [
          { day: 1, start_hour: 6, end_hour: 9, multiplier: 1.5 },
          { day: 3, start_hour: 6, end_hour: 9, multiplier: 1.5 },
          { day: 6, start_hour: 7, end_hour: 10, multiplier: 1.3 },
        ],
      }
    : {
        enabled: false,
        default_base_score: 10,
        streak_min_sessions: 2,
        monthly_cap: 200,
        time_multipliers: [],
      }

  // ── auth users (owner + extra staff) ──────────────────────────────────────────
  await upsertAuthUser({ uid, email, displayName, password: 'linyup123' })
  for (const c of extraStaff) {
    await upsertAuthUser({
      uid: c.uid,
      email: c.email,
      displayName: c.displayName,
      password: 'linyup123',
    })
  }

  // ── team doc ──────────────────────────────────────────────────────────────────
  const trialEndsAt = plan === 'coach' ? ts(daysFromNow(14)) : undefined
  const teamLanguage = 'en'
  // Coach plan can't install the storefront plugins (studio+ only), so it gets the
  // lighter link set; studio/org teams surface the full storefront.
  const portalLinks = plan === 'coach' ? buildBasicPageLinks() : buildStorefrontPageLinks()
  const bioLinkBackground = { type: 'gradient', color: portalGradient }
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
    showActivityDescription: true,
    // Every staging team seeds an appointment activity + availability.
    appointmentsEnabled: true,
  }
  await db
    .collection('teams')
    .doc(teamId)
    .set({
      name: teamName,
      description: tagline,
      slug: teamSlug,
      sport_type: 'Martial arts',
      language: teamLanguage,
      createdBy: uid,
      created: ts(daysFromNow(-220)),
      plan,
      plan_status: planStatus,
      ...(trialEndsAt ? { trial_ends_at: trialEndsAt } : {}),
      ...(affiliationsEnabled ? { affiliations_enabled: true } : {}),
      ...(orgId
        ? { org_id: orgId, organization_ids: [orgId], ranking_systems: [] }
        : { ranking_systems: rankingSystemDefs.map((s) => ({ ...s, levels: withRankLevelIds(s.levels) })) }),
      settings: { gamification: gamificationSettings, teamEmail: email },
      bioLinkTheme: 'light',
      bioLinkAccentColor: accentColor,
      bioLinkBackground,
      links: portalLinks,
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
      description: tagline,
      slug: teamSlug,
      sport_type: 'Martial arts',
      profileImage: null,
      heroImage: null,
      bioLinkTheme: 'light',
      bioLinkAccentColor: accentColor,
      bioLinkBackground,
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
      links: portalLinks,
      bookingSettings,
      membershipRequiredFields: null,
      membershipOptionalFields: null,
      // What syncTeamPublicProfile would compute (see scripts/lib/partnerApps.ts).
      // Without it the bio-link booking form hides the fitness-app question, and
      // re-seeding staging (which auto-deploys from main) reproduces exactly the
      // stale shape the backfill:partner-apps precondition exists to repair.
      partner_apps: partnerAppNames(subscriptionTypeDefs),
      updated_at: ts(now()),
    })

  // ── team members (owner + extra staff) ────────────────────────────────────────
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
      joined: ts(daysFromNow(-220)),
    })
  const [ownerFirst, ownerLast] = displayName.split(' ')
  await db
    .collection('users')
    .doc(uid)
    .set(
      {
        email,
        displayName,
        firstname: ownerFirst,
        lastname: ownerLast ?? '',
        currentTeam: teamId,
        created_at: ts(daysFromNow(-220)),
      },
      { merge: true }
    )

  for (const c of extraStaff) {
    await db
      .collection('teams')
      .doc(teamId)
      .collection('team_members')
      .doc(c.uid)
      .set({
        teamId,
        userId: c.uid,
        role: c.role,
        email: c.email,
        ...memberCapsFor(c.role),
        joined: ts(daysFromNow(-150)),
        addedBy: uid,
      })
    const [cf, cl] = c.displayName.split(' ')
    await db
      .collection('users')
      .doc(c.uid)
      .set(
        {
          email: c.email,
          displayName: c.displayName,
          firstname: cf,
          lastname: cl ?? '',
          currentTeam: teamId,
          created_at: ts(daysFromNow(-150)),
        },
        { merge: true }
      )
  }

  // ── affiliation type catalog ──────────────────────────────────────────────────
  // Org-member teams write the ORG catalog (idempotent set); standalone studios
  // write a team-local 'club' type.
  for (const at of affiliationTypeDefs) {
    const parent = orgId
      ? db.collection('organizations').doc(orgId)
      : db.collection('teams').doc(teamId)
    await parent.collection(AFFILIATION_TYPES_SUBCOLLECTION).doc(at.id).set(at)
  }

  // ── activities (group classes + appointments) ─────────────────────────────────────
  type ClassActivitySeed = {
    id: string
    name: string
    slug: string
    color: string
    tags: string[]
    isFreeTrial: boolean
    type: 'class'
    base_score: number
    description: string
    accessRule: { type: string; subscriptionTypeIds?: string[] }
    /** Independent of the tier: a gated class still accepts a newcomer's trial. */
    trialEnabled?: boolean
    /** Pay-per-class price for uncovered contacts (the ONE drop-in concept). */
    dropIn?: { enabled: boolean; priceAmount?: number }
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
      base_score: 12,
      description:
        'Gi grappling from fundamentals to advanced — positions, escapes and submissions.',
      accessRule: { type: 'open' },
    },
    {
      // MMA demos the FULL ordinary offer (members included + trial + drop-in):
      // subscription-gated, but `trialEnabled` lets a newcomer book a free trial,
      // and an uncovered contact can pay the per-class drop-in price instead.
      id: `${teamId}-act-mma`,
      name: 'MMA',
      slug: 'mma',
      color: '#dc2626',
      tags: ['intermediate'],
      isFreeTrial: false,
      type: 'class',
      base_score: 15,
      description: 'Striking-to-grappling transitions and cage craft for experienced athletes.',
      // Showcases the activity↔subscription link (see seed-emulator.ts).
      accessRule: {
        type: 'subscription',
        subscriptionTypeIds:
          plan === 'coach'
            ? [`${teamId}-sub-monthly`, `${teamId}-sub-10class`]
            : [`${teamId}-sub-premium`, `${teamId}-sub-elite`],
      },
      trialEnabled: true,
      dropIn: { enabled: true, priceAmount: plan === 'coach' ? 25 : 30 },
    },
    {
      id: `${teamId}-act-kickbox`,
      name: 'Kickboxing',
      slug: 'kickboxing',
      color: '#ea580c',
      tags: [],
      isFreeTrial: true,
      type: 'class',
      base_score: 10,
      description: 'Pad work, combinations and conditioning — a serious workout for every level.',
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
      base_score: 8,
      description: 'Recovery-focused mobility and breath work to keep you on the mats.',
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
        // Bookings confirm themselves — the default `resolveAutoConfirm` gives
        // a class too (2026-09-11). Written explicitly so the seed exercises
        // the field; a class that needs the studio's approval is the exception
        // a studio sets on purpose, and none of these do.
        autoConfirm: true,
        isActive: true,
        created_at: ts(daysFromNow(-200)),
      })
    await db.collection('activities').doc(a.id).collection('public_profile').doc(a.id).set({
      type: 'activity',
      activityType: 'class',
      teamId,
      name: a.name,
      slug: a.slug,
      color: a.color,
      description: a.description,
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
      // Tags mirrored only when non-empty, exactly as syncActivityPublicProfile does.
      ...(a.tags?.length ? { tags: normalizeActivityTags(a.tags) } : {}),
    })
  }

  // The WHAT of an appointment: name, bookable lengths (with their prices) and
  // the ONE member-benefit rule. No access rule — the price is the gate. The
  // availability below only publishes the WHEN.
  const appointmentActId = `${teamId}-act-appointment`
  const appointmentActName = plan === 'coach' ? 'Personal Training' : '1-on-1 Coaching'
  const appointmentActDescription =
    'One-on-one session tailored to your goals — technique, strategy and conditioning.'
  // Per-duration BASE pricing (major units, CHF), and ONE MEMBER RULE PER
  // LENGTH (`Activity.durationBenefits`). The rule is per length because the
  // price is: a single activity-wide rule could not say "the short one is
  // included, the long one is cheaper", and could not express a fixed member
  // price at all (one amount cannot be right for 30 and 60 minutes alike).
  //
  // THE SEEDS DEMO DIFFERENT EFFECTS ON PURPOSE, so a click-through meets each
  // of them: this one gives the top tier the 30-minute session free and 25% off
  // the 60-minute one (85 → 63.75). The legacy activity-wide
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
        effect: 'percent_off',
        percent: 25,
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
      description: appointmentActDescription,
      type: 'appointment',
      providerId: uid,
      providerName: displayName,
      durations: appointmentDurations,
      durationBenefits: appointmentDurationBenefits,
      // A 1:1 slot has no roster-review step — the time is taken the moment it's
      // booked, so the booking is written 'confirmed' on the spot.
      autoConfirm: true,
      isActive: true,
      created_at: ts(daysFromNow(-180)),
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
      description: appointmentActDescription,
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

  // ── availability (the WHEN — publishes free time, generates nothing) ─────────────
  // 'range' mode: a daily window clients self-book a start within, on the
  // `granularityMinutes` grid, at one of the activity's durations.
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
      recurrence: { daysOfWeek: appointmentDays, startDate: ts(daysFromNow(-40)), endDate: null },
      created_at: ts(daysFromNow(-40)),
      createdBy: uid,
    })

  // ── booked appointments ─────────────────────────────────────────────────────────
  // Availability pre-generates NOTHING — a session exists only once someone books.
  // These mirror what `bookAppointment` writes.
  const bookedContact = {
    id: `${teamId}-contact-000`,
    firstname: CONTACT_POOL[0].firstname,
    lastname: CONTACT_POOL[0].lastname,
    email: `${slugEmail(CONTACT_POOL[0])}.${teamId}@example.com`,
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

  // ── subscription types ────────────────────────────────────────────────────────
  for (const st of subscriptionTypeDefs) {
    const hasRecurring = st.prices.some((p: { recurrence: string }) => p.recurrence !== 'per_class')
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
        prices: st.prices.map((p: { id: string; amount: number; recurrence: string }) => ({ ...p, active: true })),
        teamId,
        created_at: ts(daysFromNow(-120)),
      })
  }

  // ── group sessions (4 past weeks + 4 upcoming weeks) ──────────────────────────
  type SessionDef = {
    dayOffset: number
    actId: string
    actName: string
    hour: number
    duration: number
    location: string
    allowBooking: boolean
    instructor?: string
  }
  const sessionDefs: SessionDef[] = []
  const instructors = extraStaff.length
    ? [displayName, extraStaff[0].displayName]
    : [displayName, 'Elena Rossi']

  for (let week = -4; week <= -1; week++) {
    for (const [dayOff, actId, actName, hour, dur, loc, instr] of [
      [1, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 18, 1.5, 'Dojo A', instructors[0]],
      [3, `${teamId}-act-kickbox`, 'Kickboxing', 19, 1, 'Dojo B', instructors[1]],
      [5, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 7, 1, 'Dojo A', instructors[0]],
      [6, `${teamId}-act-mma`, 'MMA', 10, 2, 'Main Hall', instructors[1]],
    ] as const) {
      sessionDefs.push({
        dayOffset: week * 7 + Number(dayOff),
        actId: String(actId),
        actName: String(actName),
        hour: Number(hour),
        duration: Number(dur),
        location: String(loc),
        allowBooking: false,
        instructor: String(instr),
      })
    }
  }
  for (let week = 0; week <= 3; week++) {
    for (const [dayOff, actId, actName, hour, dur, loc, ab, instr] of [
      [1, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 18, 1.5, 'Dojo A', true, instructors[0]],
      [2, `${teamId}-act-yoga`, 'Yoga & Mobility', 9, 1, 'Studio', true, 'Aiko Tanaka'],
      [3, `${teamId}-act-kickbox`, 'Kickboxing', 19, 1, 'Dojo B', true, instructors[1]],
      [5, `${teamId}-act-bjj`, 'Brazilian Jiu-Jitsu', 7, 1, 'Dojo A', true, instructors[0]],
      [6, `${teamId}-act-mma`, 'MMA', 10, 2, 'Main Hall', true, instructors[1]],
      // The Sunday yoga stays OFF the booking calendar on purpose — the one
      // showcase of a session a studio keeps outside it, which is the
      // exception, never the state a class lands in by default.
      [0, `${teamId}-act-yoga`, 'Yoga & Mobility', 10, 1.5, 'Studio', false, 'Aiko Tanaka'],
    ] as const) {
      sessionDefs.push({
        dayOffset: week * 7 + Number(dayOff),
        actId: String(actId),
        actName: String(actName),
        hour: Number(hour),
        duration: Number(dur),
        location: String(loc),
        allowBooking: Boolean(ab),
        instructor: String(instr),
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
        locationAddress: '123 Fighter St',
        allowBooking: s.allowBooking,
        // Denormalised from the activity — bookings confirm themselves.
        autoConfirm: true,
        participants_count: 0,
        created_at: ts(daysFromNow(-200)),
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
          locationAddress: '123 Fighter St',
          locationMapsUrl: null,
          capacity: null,
          participants_count: 0,
          allowBooking: true,
          slug: null,
        })
    }
  }

  // ── contacts ───────────────────────────────────────────────────────────────────
  const pool = CONTACT_POOL.slice(0, contactCount)
  const contactIds: string[] = []
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i]
    const id = `${teamId}-contact-${i.toString().padStart(3, '0')}`
    contactIds.push(id)
    const seed = `${teamId}-${i}`
    const sub = resolveSub(c.sub)
    const rank = rankFor(c)
    const streak = c.totalSessions > 0 ? Math.floor(seededRand(seed + 'st') * 6) : 0
    const maxStreak = Math.max(streak, Math.floor(seededRand(seed + 'ms') * 10))
    const monthScore =
      gamificationEnabled && c.totalSessions > 0 ? Math.floor(seededRand(seed + 'sc') * 140) : 0
    const birthdate = c.birthYear
      ? new Date(
          c.birthYear,
          Math.floor(seededRand(seed + 'mo') * 12),
          1 + Math.floor(seededRand(seed + 'dy') * 27)
        )
      : null

    const createdTs = ts(daysFromNow(-Math.floor(seededRand(seed + 'cr') * 200) - 10))
    const acquisition = acquisitionFieldsFor({
      type: c.type,
      hasAttended: c.totalSessions > 0,
      milestoneTs: createdTs,
      seed,
    })
    // Tags: 'external' replaces the old external status; keep the existing
    // win-back / lead labels alongside it.
    const baseTags = c.status === 'expired' ? ['win-back'] : c.type === 'trial' ? ['lead'] : []
    const tags = c.type === 'external' ? [...baseTags, 'external'] : baseTags

    // ── affiliation (replaces the old membership_* / org_membership_* fields) ──
    // Issuer 'org' for org-member teams (carries org_id), else 'team'. External
    // and guest contacts hold no affiliation. `active` is denormalized from status.
    const writeAffiliation =
      affiliationsEnabled &&
      clubAffiliationType !== null &&
      c.type !== 'external' &&
      c.status !== 'guest'
    const affiliationDoc = writeAffiliation
      ? buildAffiliationDoc({
          teamId,
          type: clubAffiliationType!,
          statusId: c.status,
          orgId,
          // No expiration in seed data — derive a plausible validity window.
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
        firstname: c.firstname,
        lastname: c.lastname,
        email: `${slugEmail(c)}.${teamId}@example.com`,
        phone: `+417${(60000000 + Math.floor(seededRand(seed + 'ph') * 9999999)).toString().slice(0, 8)}`,
        gender: c.gender,
        birthplace: c.birthplace,
        birthdate: birthdate ? ts(birthdate) : null,
        total_sessions: c.totalSessions,
        last_session_at:
          c.totalSessions > 0 ? ts(daysFromNow(-Math.floor(seededRand(seed + 'ls') * 14))) : null,
        notes:
          c.type === 'student' && c.totalSessions > 20
            ? `Consistent attendance. Focus areas noted after recent gradings.`
            : c.type === 'trial'
              ? `Came in via the website trial form — follow up after first session.`
              : '',
        created_at: createdTs,
        deleted_at: null,
        archived_at: null,
        ...acquisition,
        // Best-effort affiliation summary (the trigger recomputes this live).
        ...(affiliationDoc
          ? { affiliation_summary: buildAffiliationSummary([affiliationDoc as AffiliationSummaryInput]) }
          : {}),
        ...(gamificationEnabled
          ? {
              current_month_score: monthScore,
              current_streak: streak,
              max_streak: maxStreak,
              times_leader: Math.floor(seededRand(seed + 'tl') * 3),
              times_top5: Math.floor(seededRand(seed + 't5') * 6),
              distinct_activities: ['bjj', 'kickboxing'].slice(
                0,
                1 + Math.floor(seededRand(seed + 'da') * 2)
              ),
              custom_badges: badgesFor(c.totalSessions, maxStreak, seed),
            }
          : {}),
        ...(sub
          ? {
              subscription_type_id: sub.id,
              subscription_type_name: sub.name,
              subscription_recurrence: sub.recurrence,
              ...(sub.priceId
                ? { subscription_price_id: sub.priceId, subscription_amount: sub.amount }
                : {}),
              subscription_type_updated_at: ts(daysFromNow(-30)),
            }
          : {}),
        // The LEVEL'S ID (docs/rank-scale-decoupling.md): `rank` is an index
        // into the ladder, and the ladder was written with these same ids.
        ...(rank != null
          ? {
              ranks: {
                [rankSystemId]:
                  withRankLevelIds(rankingSystemDefs.find((s) => s.id === rankSystemId)?.levels ?? [])[rank]?.id ?? rank,
              },
            }
          : {}),
        tags,
      })

    if (affiliationDoc) {
      await db
        .collection('contacts')
        .doc(id)
        .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
        .doc(`${id}-aff-club`)
        .set(affiliationDoc)
    }

    // `subscription_history` is seeded later, by `seedTeamSubscriptionHistory`
    // (AFTER `seedTeamMoney`, which is what its multi-plan source —
    // `active_subscriptions` — is read back from). See that call for why.

    // weekly reports
    if (c.totalSessions > 0) {
      const maxPerWeek = Math.min(3, Math.ceil(c.totalSessions / 40) + 1)
      for (let w = 7; w >= 0; w--) {
        const monday = mondayOfWeeksAgo(w)
        const label = isoWeekLabel(monday)
        const attendChance = Math.min(0.9, c.totalSessions / 60)
        const count =
          seededRand(seed + 'wk' + w) < attendChance
            ? 1 + Math.floor(seededRand(seed + 'wc' + w) * maxPerWeek)
            : 0
        await db
          .collection('contacts')
          .doc(id)
          .collection('contact_weekly_reports')
          .doc(label)
          .set({
            iso_week: label,
            sessions_count: count,
            generated_at: ts(monday),
          })
      }
    }
  }

  // ── contact alerts (show_in_app) — a few per team ─────────────────────────────
  // Gamification scores follow the team's own switch — scores under a disabled
  // scoreboard are data no screen explains.
  if (gamificationSettings?.enabled) {
    await seedMonthlyScores({ teamId, monthlyCap: gamificationSettings.monthly_cap })
  }

  await seedContactAlerts({ teamId, vocabulary: 'martial_arts' })

  // ── goals & tasks ──────────────────────────────────────────────────────────────
  // `categories` are GOAL CATEGORIES (technique / attitude / attendance /
  // physical / mental — see DEFAULT_GOAL_CATEGORIES), never check-in axis keys.
  // A goal created FROM a weak axis carries `from_dimension` instead; none is
  // seeded, because no check-ins are seeded.
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
      description: 'Train at least 3× per week for 8 weeks.',
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
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i]
    if (c.type !== 'student' || c.totalSessions < 5) continue
    const id = contactIds[i]
    const numGoals = i < 4 ? 2 : 1
    for (let g = 0; g < numGoals; g++) {
      const def = goalDefs[(i + g) % goalDefs.length]
      const goalId = `${id}-goal-${g}`
      const status = i < 3 && g === 0 ? 'in_progress' : 'open'
      await db
        .collection('contacts')
        .doc(id)
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
            .doc(id)
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
    const taskId = `${id}-task-0`
    const taskDone = i % 3 === 0
    await db
      .collection('contacts')
      .doc(id)
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

  // ── past-session participants + bookings ──────────────────────────────────────
  const studentIdxs = pool
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.type === 'student')
    .map((x) => x.i)
  for (let i = 0; i < pastCount; i++) {
    const sid = sessionIds[i]
    if (!sid) continue
    const target = 4 + ((i * 3) % 6)
    const attending = studentIdxs
      .filter((idx, k) => (k + i) % studentIdxs.length < target)
      .slice(0, target)
    for (const idx of attending) {
      const cs = pool[idx]
      const contactId = contactIds[idx]
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

  // upcoming-session bookings from trial/external contacts
  const bookingIdxs = pool
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.type !== 'student')
    .map((x) => x.i)
    .slice(0, 4)
  const sessionBookingCounts = new Map<
    string,
    { bookings_count: number; trial_bookings_count: number }
  >()
  for (let i = 0; i < bookingIdxs.length; i++) {
    const idx = bookingIdxs[i]
    const b = pool[idx]
    const sessionId = sessionIds[pastCount + (i < 2 ? 1 : 3)]
    if (!sessionId) continue
    await db
      .collection('sessions')
      .doc(sessionId)
      .collection('bookings')
      .doc(`${teamId}-booking-${i}`)
      .set({
        teamId,
        contact: contactIds[idx],
        session: sessionId,
        email: `${slugEmail(b)}.${teamId}@example.com`,
        firstname: b.firstname,
        lastname: b.lastname,
        phone: '',
        is_new_contact: true,
        fromBioLink: true,
        joinedAt: ts(daysFromNow(-2)),
        status: 'pending',
        booking_token: `tok-${teamId}-${i}`,
      })
    const cur = sessionBookingCounts.get(sessionId) ?? {
      bookings_count: 0,
      trial_bookings_count: 0,
    }
    cur.bookings_count++
    cur.trial_bookings_count++
    sessionBookingCounts.set(sessionId, cur)
  }
  for (const [sessionId, counts] of sessionBookingCounts) {
    await db.collection('sessions').doc(sessionId).update(counts)
  }

  // ── team activity log ─────────────────────────────────────────────────────────
  const logEntries = [
    {
      event: 'contact_add',
      desc: `New trial contact ${pool[bookingIdxs[0]]?.firstname ?? 'lead'} added from portal.`,
      contact: contactIds[bookingIdxs[0]],
    },
    {
      event: 'session_participant_add',
      desc: `${pool[0].firstname} ${pool[0].lastname} checked into BJJ.`,
      contact: contactIds[0],
    },
    {
      event: 'rank_change',
      desc: `${pool[2].firstname} ${pool[2].lastname} promoted.`,
      contact: contactIds[2],
    },
    {
      event: 'subscription_change',
      desc: `${pool[1].firstname} ${pool[1].lastname} switched to Annual Membership.`,
      contact: contactIds[1],
    },
    {
      event: 'booking_confirmed',
      desc: `Trial booking confirmed for an upcoming session.`,
      contact: contactIds[bookingIdxs[0]],
    },
  ]
  for (let i = 0; i < logEntries.length; i++) {
    const e = logEntries[i]
    if (!e.contact) continue
    await db
      .collection('teams')
      .doc(teamId)
      .collection('activity_log')
      .doc(`${teamId}-log-${i}`)
      .set({
        event: e.event,
        created_at: ts(daysFromNow(-i - 1)),
        parameters: { description: e.desc },
        refs: { contact: e.contact, user: teamId },
      })
  }

  // ── automations (studio+ only): templates, alert presets, rules, logs ──────────
  if (automationsEnabled) {
    await seedAutomations({ teamId, language: teamLanguage, vocabulary: 'martial_arts' })
  }

  // ── events ───────────────────────────────────────────────────────────────────
  const eventDefs = [
    {
      title: 'Regional BJJ Tournament',
      type: 'competition',
      startOffset: 45,
      durationH: 8,
      fee: 25,
      location: 'Sports Arena Geneva',
      description:
        'Annual regional championship — open to white and blue belts. Gi and No-Gi divisions.',
    },
    {
      title: 'Summer MMA Camp',
      type: 'camp',
      startOffset: 60,
      durationH: 72,
      fee: 180,
      location: 'High Performance Training Center',
      description: '3-day intensive camp with guest instructors. All levels welcome.',
    },
    {
      title: 'Nutrition Workshop',
      type: 'seminar',
      startOffset: 14,
      durationH: 3,
      fee: 0,
      location: 'Team HQ — Conference Room',
      description: 'Practical guide to sports nutrition and recovery. Free for all members.',
    },
  ]
  for (let ei = 0; ei < eventDefs.length; ei++) {
    const e = eventDefs[ei]
    const eventId = `${teamId}-event-${ei}`
    const maxInvite = [
      Math.min(12, contactCount),
      Math.min(8, contactCount),
      Math.min(10, contactCount),
    ][ei]
    let sentCount = 0,
      attendeeCount = 0
    const startIdx = ei * 3

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

    for (let j = 0; j < maxInvite; j++) {
      const cidx = (startIdx + j) % pool.length
      const c = pool[cidx]
      const contactId = contactIds[cidx]
      const status = j < 3 ? 'responded' : j < 5 ? 'declined' : j < 8 ? 'opened' : 'sent'
      const token = `seed${teamId}ev${ei}c${cidx}`.padEnd(32, '0').repeat(2).slice(0, 64)
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
          email: `${slugEmail(c)}.${teamId}@example.com`,
          status,
          token,
          link: `https://linyup.com/public/event-invitation?token=${token}`,
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
            email: `${slugEmail(c)}.${teamId}@example.com`,
            notes: j === 0 ? 'Really looking forward to this!' : null,
            respondedAt: ts(daysFromNow(-2)),
          })
      }
    }
    await db
      .collection('events')
      .doc(eventId)
      .update({
        invitations_sent_count: sentCount,
        attendees_count: attendeeCount,
        last_invitation_sent_at: ts(daysFromNow(-7)),
      })
  }

  // ── saas_subscriptions ────────────────────────────────────────────────────────
  const nowTs = ts(now())
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
        created_at: nowTs,
        updated_at: nowTs,
      })
  } else if (!orgId) {
    await db
      .collection('saas_subscriptions')
      .doc(teamId)
      .set({
        teamId,
        plan,
        status: 'active',
        trial_ends_at: null,
        current_period_start: ts(daysFromNow(-30)),
        current_period_end: ts(daysFromNow(1)),
        cancel_at_period_end: false,
        gateway_type: null,
        gateway_data: null,
        created_at: ts(daysFromNow(-220)),
        updated_at: nowTs,
      })
  }
  // org member teams are billed through the org subscription (handled in seedOrg)

  // ── documents (all plans — minPlan 'free') ──────────────────────────────────
  // The money ledger — seeded after contacts, whose subscription assignment it
  // reads back. See scripts/lib/fixtures/money.ts for why seeded ledger rows
  // exist at all.
  // ── studio configuration the audit found missing here (Phase 2 Lanes 2/3) ───
  // Places + a recurring series + gift cards. See scripts/lib/fixtures/studio.ts
  // for why gift cards need all four writes rather than just a card.
  await seedTeamPlaces({ teamId, uid, teamName })
  await seedSessionSeries({ teamId, uid })
  await seedTeamGiftCards({ teamId, uid })

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
  await seedDynamicContactGroup(teamId, uid)
  await seedEventProgram(teamId, uid)
  await seedSessionWaitlist({ teamId })
  await seedCoursePurchase(teamId)

  await seedDocuments(teamId, teamSlug, teamName, uid)

  // ── storefront (studio+ only — products/website/online-courses are minPlan studio) ──
  // Gives studio/organization teams a complete public storefront: a Products shop
  // tab, a published website, free + sellable courses, and the full bio-link set.
  if (plan === 'studio' || plan === 'organization') {
    const storefront = {
      teamId,
      uid,
      teamName,
      teamSlug,
      accentColor,
      description: tagline,
      primaryActivity: activities[0]?.name ?? 'Training',
      email,
      currency: 'CHF',
      installedDaysAgo: 120,
    }
    await seedStoreProducts(storefront)
    await seedStorePromoCode(storefront)
    await seedStoreWebsite(storefront)
    await seedStoreCourses(storefront, { includeFree: true })
  }

  // ── coach role demo: give the first coach-role staff an own book (assigned
  // contacts + sessions) + a default role_config, so staging exercises the Coach
  // role. Owner + manager are also coach-eligible (coachRoles). ──
  const coaches = extraStaff.filter((s) => s.role === 'coach')
  if (extraStaff.length) {
    await db
      .collection('teams')
      .doc(teamId)
      .collection('role_config')
      .doc('coach')
      .set({
        role: 'coach',
        capabilities: COACH_DEFAULT_CAPABILITIES,
        coachRoles: ['owner', 'manager', 'coach'],
        updatedBy: uid,
        updated_at: ts(daysFromNow(-150)),
      })
    if (coaches.length) {
      const coachUid = coaches[0].uid
      const coachContacts = await db.collection('contacts').where('teamId', '==', teamId).limit(6).get()
      for (const c of coachContacts.docs) await c.ref.update({ assigned_coach_ids: [coachUid] })
      const coachSessions = await db.collection('sessions').where('teamId', '==', teamId).limit(3).get()
      for (const s of coachSessions.docs)
        await s.ref.update({ providerId: coachUid, providerName: coaches[0].displayName })
    }
  }

  console.log(
    `   ✓ ${teamName} (${plan}) — ${contactCount} contacts, ${sessionDefs.length} sessions`
  )
}

// ── documents seed ───────────────────────────────────────────────────────────

async function seedDocuments(
  teamId: string,
  teamSlug: string,
  teamName: string,
  uid: string,
) {
  // NO PLUGIN INSTALL — Documents is a default feature on every plan. The
  // signup-consent selection lives in teams/{teamId}/settings/documents.
  await seedDocumentsSettings(teamId, [`${teamId}-doc-terms`, `${teamId}-doc-privacy`], 30)

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

  // Documents + the studio's liability WAIVER, each with its frozen v1 snapshot
  // and public mirror, through the ONE shared writer
  // (scripts/lib/fixtures/documents.ts).
  await seedTeamWaiver({
    teamId,
    uid,
    teamName,
    teamSlug,
    otherDocuments: docSeeds,
    createdDaysAgo: 25,
  })
}

// ── automations seed (templates + presets + rules + logs) ─────────────────────


// ── org seed ──────────────────────────────────────────────────────────────────

async function seedOrg(opts: {
  orgId: string
  orgName: string
  orgSlug: string
  adminUid: string
  teamIds: string[]
}) {
  const { orgId, orgName, orgSlug, adminUid, teamIds } = opts
  const nowTs = ts(now())

  const bjjBelt = [
    {
      id: 'bjj-belt',
      name: 'BJJ Belt',
      is_primary: true,
      levels: [
        { label: 'White Belt', color: '#e5e7eb' },
        { label: 'Blue Belt', color: '#1d4ed8' },
        { label: 'Purple Belt', color: '#7e22ce' },
        { label: 'Brown Belt', color: '#78350f' },
        { label: 'Black Belt', color: '#111827' },
      ],
    },
  ]

  await db
    .collection('organizations')
    .doc(orgId)
    .set({
      name: orgName,
      slug: orgSlug,
      description: `${orgName} — multi-team organization managed with Linyup.`,
      plan: 'organization',
      plan_status: 'active',
      ranking_systems: bjjBelt.map((s) => ({ ...s, levels: withRankLevelIds(s.levels) })),
      created: ts(daysFromNow(-260)),
      createdBy: adminUid,
    })

  // Org membership statuses (reused as affiliation statuses for org-issued affiliations).
  for (const st of DEFAULT_ORG_AFFILIATION_STATUSES) {
    await db
      .collection('organizations')
      .doc(orgId)
      .collection(ORG_AFFILIATION_STATUSES_SUBCOLLECTION)
      .doc(st.id)
      .set(st)
  }

  await db.collection('organizations').doc(orgId).collection('org_members').doc(adminUid).set({
    userId: adminUid,
    orgId,
    role: 'org_admin',
    joined: nowTs,
    addedBy: adminUid,
  })
  await db
    .collection('users')
    .doc(adminUid)
    .set({ orgIds: [orgId] }, { merge: true })

  for (const teamId of teamIds) {
    await db.collection('organizations').doc(orgId).collection('org_teams').doc(teamId).set({
      teamId,
      orgId,
      status: 'active',
      joined: nowTs,
      addedBy: adminUid,
    })
    // ensure the org admin is a manager of every member team they don't already own
    const memberRef = db.collection('teams').doc(teamId).collection('team_members').doc(adminUid)
    const existing = await memberRef.get()
    if (!existing.exists) {
      await memberRef.set({
        userId: adminUid,
        teamId,
        role: 'manager',
        ...memberCapsFor('manager'),
        joined: nowTs,
        addedBy: 'seed',
      })
    }
  }

  await db
    .collection('saas_subscriptions')
    .doc(orgId)
    .set({
      entity_type: 'org',
      entity_id: orgId,
      teamId: orgId,
      plan: 'organization',
      status: 'active',
      trial_ends_at: null,
      current_period_start: ts(daysFromNow(-30)),
      current_period_end: ts(daysFromNow(1)),
      cancel_at_period_end: false,
      gateway_type: null,
      gateway_data: null,
      created_at: ts(daysFromNow(-260)),
      updated_at: nowTs,
    })

  // org-wide event
  await db
    .collection('events')
    .doc(`${orgId}-event-open`)
    .set({
      orgId,
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
      createdBy: adminUid,
      created_at: nowTs,
    })

  console.log(`   ✓ ${orgName} — ${teamIds.length} member teams`)
}

// ── auth helper (idempotent create-or-update) ─────────────────────────────────

async function upsertAuthUser(opts: {
  uid: string
  email: string
  displayName: string
  password: string
}) {
  const { uid, email, displayName, password } = opts
  try {
    await auth.createUser({ uid, email, password, displayName, emailVerified: true })
  } catch (e: unknown) {
    const code = (e as { code?: string }).code
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth
        .updateUser(uid, { email, password, displayName, emailVerified: true })
        .catch(() => {})
    } else {
      throw e
    }
  }
}

function slugEmail(c: PoolEntry): string {
  return `${c.firstname}.${c.lastname}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
}

// ── enable email/password sign-in provider ─────────────────────────────────────
// A freshly-initialized Firebase project has the email/password provider disabled.
// The Admin SDK can create users but the client SDK cannot sign them in until the
// provider is enabled. We patch it via the Identity Platform v2 REST API using the
// same ADC credential the Admin SDK is already using.

async function enableEmailPasswordSignIn() {
  const credential = admin.app().options.credential!
  const token = await (
    credential as { getAccessToken(): Promise<{ access_token: string }> }
  ).getAccessToken()
  const url =
    `https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/config` +
    `?updateMask=signIn.email.enabled,signIn.email.passwordRequired`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': PROJECT_ID,
    },
    body: JSON.stringify({ signIn: { email: { enabled: true, passwordRequired: true } } }),
  })
  if (!res.ok) {
    throw new Error(`Failed to enable email/password sign-in: ${res.status} ${await res.text()}`)
  }
  console.log('   ✓ Email/password sign-in enabled')
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🌱 Seeding Firebase project: ${PROJECT_ID}\n`)

  await enableEmailPasswordSignIn()

  // 1. Coach plan — solo coach
  await seedTeam({
    uid: 'seed-coach-uid',
    email: 'coach@linyup.com',
    displayName: 'Marco Rossi',
    teamId: 'seed-team-coach',
    teamName: 'Samurai Fight Academy',
    teamSlug: 'samurai-fight-academy',
    plan: 'coach',
    planStatus: 'trial',
    accentColor: '#7c3aed',
    contactCount: 15,
    tagline:
      'Traditional martial arts with a modern edge — disciplined training for body and mind.',
    portalGradient: 'night',
  })

  // 2. Studio plan — owner + manager + coach
  await seedTeam({
    uid: 'seed-studio-uid',
    email: 'studio@linyup.com',
    displayName: 'Anna Schmidt',
    teamId: 'seed-team-studio',
    teamName: 'Iron Circle Gym',
    teamSlug: 'iron-circle-gym',
    plan: 'studio',
    planStatus: 'active',
    accentColor: '#dc2626',
    contactCount: 30,
    tagline: 'Forge your fight game — BJJ, MMA and kickboxing under one roof, all levels welcome.',
    portalGradient: 'warm',
    extraStaff: [
      {
        uid: 'seed-studio-manager-uid',
        displayName: 'Elena Rossi',
        email: 'elena.rossi@ironcircle.example.com',
        role: 'manager',
      },
      {
        uid: 'seed-studio-coach2-uid',
        displayName: 'Marco Silva',
        email: 'marco.silva@ironcircle.example.com',
        role: 'coach',
      },
    ],
  })

  // 3. Organisation — org admin + 2 member teams (each with manager + coach)
  await seedTeam({
    uid: 'seed-org-uid',
    email: 'org@linyup.com',
    displayName: 'Rafael Torres',
    teamId: 'seed-org-team-a',
    teamName: 'Titan Combat Sports',
    teamSlug: 'titan-combat-sports',
    plan: 'organization',
    planStatus: 'active',
    accentColor: '#0284c7',
    contactCount: 20,
    tagline: 'The Titan flagship — competition-grade grappling and MMA coaching for every level.',
    portalGradient: 'royal',
    orgId: 'seed-org',
    extraStaff: [
      {
        uid: 'seed-org-a-manager-uid',
        displayName: 'Sofia Müller',
        email: 'sofia.mueller@titan.example.com',
        role: 'manager',
      },
      {
        uid: 'seed-org-a-coach-uid',
        displayName: 'Liam Chen',
        email: 'liam.chen@titan.example.com',
        role: 'coach',
      },
    ],
  })
  await seedTeam({
    uid: 'seed-org-coachb-uid',
    email: 'coach.b@titan.example.com',
    displayName: 'Diego Fernández',
    teamId: 'seed-org-team-b',
    teamName: 'Titan Striking Lab',
    teamSlug: 'titan-striking-lab',
    plan: 'organization',
    planStatus: 'active',
    accentColor: '#0d9488',
    contactCount: 18,
    tagline: 'Precision striking — kickboxing technique, pad work and fight-camp conditioning.',
    portalGradient: 'ocean',
    orgId: 'seed-org',
    extraStaff: [
      {
        uid: 'seed-org-b-coach-uid',
        displayName: 'Mia Tanaka',
        email: 'mia.tanaka@titan.example.com',
        role: 'coach',
      },
    ],
  })
  await seedOrg({
    orgId: 'seed-org',
    orgName: 'Titan Martial Arts Association',
    orgSlug: 'titan-martial-arts',
    adminUid: 'seed-org-uid',
    teamIds: ['seed-org-team-a', 'seed-org-team-b'],
  })

  // The member app's test login — the same review studio the production
  // console provisions, with its fixed code (scripts/lib/mobile.ts).
  const memberApp = await seedReviewTenant({ db, seededBy: 'seed-staging' })
  await seedMobileSettings({ db, seededBy: 'seed-staging' })

  console.log('\n✅ Staging seeded successfully!\n')
  console.log('   ┌──────────────────────┬──────────────────────┬────────────┬──────────┐')
  console.log('   │ Plan                 │ Email                │ Password   │ Status   │')
  console.log('   ├──────────────────────┼──────────────────────┼────────────┼──────────┤')
  console.log('   │ coach                │ coach@linyup.com     │ linyup123  │ trial    │')
  console.log('   │ studio (mgr+coach)   │ studio@linyup.com    │ linyup123  │ active   │')
  console.log('   │ org admin            │ org@linyup.com       │ linyup123  │ active   │')
  console.log('   └──────────────────────┴──────────────────────┴────────────┴──────────┘\n')
  console.log('   Organization: Titan Martial Arts Association (org@linyup.com)')
  console.log('   Member teams: Titan Combat Sports + Titan Striking Lab')
  printMemberAppLogin(memberApp)
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seed failed:', err)
    process.exit(1)
  })
