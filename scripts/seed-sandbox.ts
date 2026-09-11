/**
 * Seed script for the **demo playground** (the `linyup-sandbox` Firebase project).
 *
 * Unlike seed-staging.ts (coach/studio/org tiers, all "Martial arts"), this seed
 * creates SIX fully-populated **Studio**-plan accounts spanning different sectors —
 * three sport, three wellness — so the public /try playground shows real variety.
 *
 *   grappling@linyup.com  / linyup123  →  Ronin Grappling Academy   (sport · martial arts)
 *   crossfit@linyup.com   / linyup123  →  Forge CrossFit           (sport · fitness)
 *   tennis@linyup.com     / linyup123  →  Baseline Tennis Academy  (sport · tennis)
 *   yoga@linyup.com       / linyup123  →  Lotus Yoga Studio        (wellness · yoga)
 *   pilates@linyup.com    / linyup123  →  Core Pilates Studio      (wellness · pilates)
 *   dance@linyup.com      / linyup123  →  Rhythm Dance Studio      (wellness · dance)
 *
 * Every account is plan: 'studio', status: 'active' (full feature set, never hits
 * the trial wall). Keep DEMO_ACCOUNTS in apps/web/src/lib/demo.ts in sync.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Targets:
 *   • Real project (default):  ADC via `applicationDefault()` → linyup-sandbox.
 *     Run `gcloud auth application-default login` once; the identity needs Editor
 *     (or Firebase Admin + Datastore + Identity Toolkit Admin).
 *       pnpm sandbox:seed
 *   • Local emulator (no cloud project needed): set the emulator host vars and the
 *     seed writes into the emulator's `demo-linyup` namespace (what the web app
 *     reads). Useful for exercising /try before the project exists:
 *       FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *       FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
 *       pnpm sandbox:seed
 *
 * Idempotent: deterministic IDs + set(), so re-running overwrites. For a clean
 * slate against the real project, run `pnpm sandbox:reset` first.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * PRICED SURFACES need a Stripe TEST connected account. `payments_enabled` fails
 * CLOSED (UX-33), so without one the /try tenants show no shop, no drop-in price,
 * no priced trial and no priced appointment duration. Export an already-onboarded
 * TEST account id before seeding to light them up (and get a checkout that really
 * completes):
 *
 *   export STRIPE_CONNECT_TEST_ACCOUNT=acct_123               # → sandbox-grappling
 *   export STRIPE_CONNECT_TEST_ACCOUNT=sandbox-yoga=acct_123  # → pin a tenant
 *
 * ONE account backs exactly ONE team — the six tenants are served in profile order
 * until the configured accounts run out. Unset ⇒ silent skip (one warning line).
 * Full setup notes: scripts/lib/connect.ts.
 */

import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { DEFAULT_PAYMENT_MODES, normalizeActivityTags, withRankLevelIds } from '@linyup/shared'
import {
  CONTACT_AFFILIATIONS_SUBCOLLECTION,
  AFFILIATION_TYPES_SUBCOLLECTION,
  teamAffiliationTypes,
  buildAffiliationDoc,
  buildAffiliationSummary,
  type AffiliationSummaryInput,
  statusCountsAsActive,
} from './lib/affiliations'
import {
  buildStorefrontPageLinks,
  seedStoreProducts,
  seedStorePromoCode,
  seedStoreCourses,
} from './lib/storefront'
import { memberCapsFor, COACH_DEFAULT_CAPABILITIES } from './lib/roles'
import { partnerAppNames } from './lib/partnerApps'
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
import { seedSessionSeries, seedTeamGiftCards, seedTeamPlaces } from './lib/fixtures/studio'
import {
  seedContactNotes,
  seedCoursePurchase,
  seedDynamicContactGroup,
  seedEventProgram,
  seedSessionWaitlist,
} from './lib/fixtures/engagement'
import { seedPerformanceCheckins } from './lib/fixtures/coaching'
import { seedTeamFinance } from './lib/fixtures/finance'
import { seedTeamAssetRegister } from './lib/fixtures/assetRegister'
import { seedTeamMoney, seedTeamSales } from './lib/fixtures/money'
import { seedTeamSubscriptionHistory } from './lib/fixtures/subscriptionHistory'
import { printMemberAppLogin, seedMobileSettings, seedReviewTenant } from './lib/mobile'

const USE_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST
// Emulator convenience: the Auth host is required alongside Firestore — default
// it so a forgotten env var doesn't silently create auth users (with the shared
// demo password) on the REAL sandbox project while Firestore writes go local.
// Same guard as seed-lead.ts.
if (USE_EMULATOR && !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099'
}
// On the emulator, write into the namespace the web app + emulator use
// (demo-linyup); against the cloud, target the dedicated sandbox project.
const PROJECT_ID = USE_EMULATOR ? process.env.GCLOUD_PROJECT || 'demo-linyup' : 'linyup-sandbox'

// Guard: this script only ever targets the sandbox project (or the emulator) —
// it must never write demo teams into staging/production.
const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
if (!USE_EMULATOR && envProject && envProject !== PROJECT_ID) {
  console.error(`❌ Refusing to run: ambient project '${envProject}' != '${PROJECT_ID}'.`)
  process.exit(1)
}

admin.initializeApp(
  USE_EMULATOR
    ? { projectId: PROJECT_ID }
    : { credential: applicationDefault(), projectId: PROJECT_ID }
)

const auth = admin.auth()
const db = admin.firestore()
db.settings({ ignoreUndefinedProperties: true })

const DEMO_PASSWORD = 'linyup123'

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

// Map an authoring `type` (+ attendance) to its acquisition_stage — used by the
// weekly-report aggregate so its keys are stage values, not the old type values.
function stageForPoolEntry(type: 'student' | 'trial' | 'external', totalSessions: number): string {
  if (type === 'student' || type === 'external') return 'joined'
  return totalSessions > 0 ? 'trial_attended' : 'trial_booked'
}

// ── contact pool ────────────────────────────────────────────────────────────
// 32 sector-neutral people, ordered so any prefix yields a realistic mix of
// active students, trials, almost-ready leads, expired and external contacts.

// NOTE: no 'dropin' kind any more — the "Drop-in" per-class subscription PLAN was
// removed (2026-07): drop-in is the per-activity `Activity.dropIn` price, paid per
// booking, not a membership. Pay-per-class contacts simply hold no subscription.
type SubKind = 'monthly' | 'quarterly' | 'annual' | 'aggregator' | null

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
    sub: 'monthly',
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
    sub: 'annual',
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
    sub: 'monthly',
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
    sub: 'monthly',
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
    sub: 'annual',
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
    sub: 'monthly',
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
    sub: 'annual',
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
    sub: 'monthly',
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
    sub: 'monthly',
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
    sub: 'quarterly',
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
    sub: 'annual',
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
    sub: 'monthly',
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
    sub: 'monthly',
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

// ── sector profiles ─────────────────────────────────────────────────────────

interface ActivityDef {
  name: string
  slug: string
  color: string
  tags: string[]
  isFreeTrial: boolean
  base_score: number
  description: string // shown on the portal booking page activity cards
  /** Subscription-gate the class on these plan kinds (Activity.accessRule
   *  'subscription'). Unset → the tier derives from isFreeTrial (open/members). */
  accessSubKinds?: Array<Exclude<SubKind, null>>
  /** Independent of the tier: a gated class still accepts a newcomer's trial. */
  trialEnabled?: boolean
  /** Pay-per-class price for uncovered contacts (the ONE drop-in concept —
   *  the "Drop-in" subscription PLAN is gone). */
  dropInPrice?: number
}
interface SubDef {
  kind: Exclude<SubKind, null>
  name: string
  description: string
  source: 'internal' | 'aggregator'
  price: number | null
}
interface RankLevel {
  value: number
  label: string
  color: string
}
interface SectorProfile {
  key: string // login local-part + id prefix
  sector: 'sport' | 'wellness'
  ownerName: string
  teamName: string
  teamSlug: string
  sportType: string // matches a signup SPORT_TYPES label
  accentColor: string
  description: string // portal home tagline (public_profile.description)
  portalGradient: string // BIO_LINK_GRADIENTS key (apps/web/src/lib/bioLink.ts)
  instructors: string[] // [owner, assistant]
  activities: ActivityDef[] // 4–5 group classes
  appointmentName: string
  rankingSystem: { id: string; name: string; levels: RankLevel[] } | null
  subscriptions: SubDef[]
  locations: string[]
  events: {
    title: string
    type: string
    startOffset: number
    durationH: number
    fee: number
    location: string
    description: string
  }[]
  /** `categories` = GOAL CATEGORY keys (what the goal is about), never
   *  check-in axis keys — see packages/shared/src/types/goal.ts. */
  goals: { title: string; description: string; categories: string[] }[]
  tasks: string[]
}

const BELT_LEVELS: RankLevel[] = [
  { value: 0, label: 'White Belt', color: '#e5e7eb' },
  { value: 1, label: 'Blue Belt', color: '#1d4ed8' },
  { value: 2, label: 'Purple Belt', color: '#7e22ce' },
  { value: 3, label: 'Brown Belt', color: '#78350f' },
  { value: 4, label: 'Black Belt', color: '#111827' },
]

const SECTOR_PROFILES: SectorProfile[] = [
  // ── SPORT ──────────────────────────────────────────────────────────────────
  {
    key: 'grappling',
    sector: 'sport',
    ownerName: 'Marco Silva',
    teamName: 'Ronin Grappling Academy',
    teamSlug: 'ronin-grappling-academy',
    sportType: 'Martial arts',
    accentColor: '#dc2626',
    instructors: ['Marco Silva', 'Elena Rossi'],
    description:
      'BJJ and no-gi grappling for all levels — from your first class to the competition team.',
    portalGradient: 'night',
    appointmentName: 'Private Lesson',
    activities: [
      {
        name: 'BJJ Fundamentals',
        slug: 'bjj-fundamentals',
        color: '#dc2626',
        tags: ['beginner'],
        isFreeTrial: true,
        base_score: 12,
        description: 'Core positions, escapes and submissions for your first year on the mats.',
      },
      {
        // The sandbox's FULL-ordinary-offer demo (members included + trial +
        // drop-in): subscription-gated on the internal plans, `trialEnabled`
        // lets a newcomer book a free trial, and an uncovered contact can pay
        // the per-class drop-in price instead — three independent toggles.
        name: 'Advanced BJJ',
        slug: 'advanced-bjj',
        color: '#7c3aed',
        tags: ['advanced'],
        isFreeTrial: false,
        base_score: 15,
        description: 'Competition-paced rounds and advanced systems for experienced grapplers.',
        accessSubKinds: ['monthly', 'quarterly', 'annual'],
        trialEnabled: true,
        dropInPrice: 30,
      },
      {
        name: 'No-Gi Grappling',
        slug: 'no-gi',
        color: '#ea580c',
        tags: ['intermediate'],
        isFreeTrial: true,
        base_score: 14,
        description: 'Wrestling, scrambles and modern leg-lock systems — no gi required.',
      },
      {
        name: 'Open Mat',
        slug: 'open-mat',
        color: '#0891b2',
        tags: [],
        isFreeTrial: true,
        base_score: 8,
        description: 'Free rolling for all levels. Bring a partner or find one here.',
      },
    ],
    rankingSystem: { id: 'bjj-belt', name: 'BJJ Belt', levels: BELT_LEVELS },
    subscriptions: [
      {
        kind: 'monthly',
        name: 'Unlimited Monthly',
        description: 'Unlimited mat time, billed monthly.',
        source: 'internal',
        price: 140,
      },
      {
        kind: 'quarterly',
        name: 'Quarterly Plan',
        description: '3-month commitment, 10% off.',
        source: 'internal',
        price: 380,
      },
      {
        kind: 'annual',
        name: 'Annual Membership',
        description: 'Best value — 2 months free.',
        source: 'internal',
        price: 1290,
      },
      {
        kind: 'aggregator',
        name: 'FitPass Partner',
        description: 'Access via the FitPass network.',
        source: 'aggregator',
        price: null,
      },
    ],
    locations: ['Mat Room A', 'Mat Room B', 'Main Hall'],
    events: [
      {
        title: 'Regional Gi Open',
        type: 'competition',
        startOffset: 45,
        durationH: 8,
        fee: 35,
        location: 'Sports Arena Geneva',
        description: 'Regional IBJJF-style tournament — gi divisions for all belts.',
      },
      {
        title: 'No-Gi Throwdown',
        type: 'competition',
        startOffset: 70,
        durationH: 6,
        fee: 25,
        location: 'Ronin Main Hall',
        description: 'In-house no-gi rounds with prizes. All levels welcome.',
      },
      {
        title: 'Guard Retention Seminar',
        type: 'seminar',
        startOffset: 14,
        durationH: 3,
        fee: 40,
        location: 'Mat Room A',
        description: 'Guest black-belt seminar on modern guard retention.',
      },
    ],
    goals: [
      {
        title: 'Improve guard passing',
        description: 'Work on pressure passing and the leg weave.',
        categories: ['technique', 'physical'],
      },
      {
        title: 'Compete at next tournament',
        description: 'Enter the regional open and go for gold.',
        categories: ['attitude', 'mental'],
      },
      {
        title: 'Develop rear-naked choke finish',
        description: 'Clean finish from back control.',
        categories: ['technique'],
      },
      {
        title: 'Build a consistent habit',
        description: 'Train at least 3× per week for 8 weeks.',
        categories: ['attendance', 'attitude'],
      },
    ],
    tasks: [
      'Watch 3 guard-passing breakdowns',
      'Drill solo escapes 10 min/day',
      'Review tournament rules',
      'Write post-roll notes each session',
    ],
  },
  {
    key: 'crossfit',
    sector: 'sport',
    ownerName: 'Anna Schmidt',
    teamName: 'Forge CrossFit',
    teamSlug: 'forge-crossfit',
    sportType: 'CrossFit / Fitness',
    accentColor: '#0f172a',
    instructors: ['Anna Schmidt', 'Tom Becker'],
    description:
      'Coached functional fitness — daily WODs, Olympic lifting and engine work for every level.',
    portalGradient: 'royal',
    appointmentName: 'Personal Training',
    activities: [
      {
        name: 'WOD',
        slug: 'wod',
        color: '#0f172a',
        tags: [],
        isFreeTrial: true,
        base_score: 12,
        description: 'The classic daily workout — scaled to every level by our coaches.',
      },
      {
        name: 'Olympic Lifting',
        slug: 'olympic-lifting',
        color: '#b45309',
        tags: ['intermediate'],
        isFreeTrial: false,
        base_score: 15,
        description: 'Snatch and clean & jerk technique in small coached groups.',
      },
      {
        name: 'Endurance',
        slug: 'endurance',
        color: '#0d9488',
        tags: [],
        isFreeTrial: true,
        base_score: 10,
        description: 'Engine-building intervals on rower, bike and track.',
      },
      {
        name: 'Foundations',
        slug: 'foundations',
        color: '#2563eb',
        tags: ['beginner'],
        isFreeTrial: true,
        base_score: 8,
        description: 'Your first four weeks — movement basics and how the gym works.',
      },
    ],
    rankingSystem: {
      id: 'performance-level',
      name: 'Performance Level',
      levels: [
        { value: 0, label: 'Foundations', color: '#94a3b8' },
        { value: 1, label: 'Scaled', color: '#2563eb' },
        { value: 2, label: 'Rx', color: '#b45309' },
        { value: 3, label: 'Elite', color: '#dc2626' },
      ],
    },
    subscriptions: [
      {
        kind: 'monthly',
        name: 'Unlimited Monthly',
        description: 'Unlimited classes, billed monthly.',
        source: 'internal',
        price: 155,
      },
      {
        kind: 'quarterly',
        name: '3× / Week Plan',
        description: 'Three sessions a week, billed monthly.',
        source: 'internal',
        price: 120,
      },
      {
        kind: 'annual',
        name: 'Annual Membership',
        description: 'Best value — pay once, train all year.',
        source: 'internal',
        price: 1490,
      },
      {
        kind: 'aggregator',
        name: 'ClassPass',
        description: 'Access via the ClassPass network.',
        source: 'aggregator',
        price: null,
      },
    ],
    locations: ['The Box', 'Lifting Platform', 'Outdoor Rig'],
    events: [
      {
        title: 'Forge Throwdown',
        type: 'competition',
        startOffset: 40,
        durationH: 6,
        fee: 30,
        location: 'The Box',
        description: 'In-house partner competition across three WODs.',
      },
      {
        title: 'Hyrox Prep Camp',
        type: 'camp',
        startOffset: 60,
        durationH: 4,
        fee: 45,
        location: 'Outdoor Rig',
        description: 'Weekend prep camp for the next Hyrox race.',
      },
      {
        title: 'Nutrition Workshop',
        type: 'seminar',
        startOffset: 14,
        durationH: 2,
        fee: 0,
        location: 'The Box',
        description: 'Practical fuelling and recovery for athletes. Free for members.',
      },
    ],
    goals: [
      {
        title: 'First strict pull-up',
        description: 'Build to one unassisted strict pull-up.',
        categories: ['physical'],
      },
      {
        title: 'Bodyweight clean',
        description: 'Clean your bodyweight with clean technique.',
        categories: ['technique', 'physical'],
      },
      {
        title: 'Sub-8 Fran',
        description: 'Complete Fran under 8 minutes Rx.',
        categories: ['mental', 'physical'],
      },
      {
        title: 'Consistent attendance',
        description: 'Hit 4 classes a week for a month.',
        categories: ['attendance'],
      },
    ],
    tasks: [
      'Mobility 10 min after each WOD',
      'Log lifts in the app',
      'Practice double-unders',
      'Track protein for a week',
    ],
  },
  {
    key: 'tennis',
    sector: 'sport',
    ownerName: 'Pierre Dubois',
    teamName: 'Baseline Tennis Academy',
    teamSlug: 'baseline-tennis-academy',
    sportType: 'Tennis',
    accentColor: '#16a34a',
    instructors: ['Pierre Dubois', 'Sara Lindqvist'],
    description:
      'Group clinics, junior pathways and competitive match play across our three courts.',
    portalGradient: 'forest',
    appointmentName: 'Private Coaching',
    activities: [
      {
        name: 'Group Clinic',
        slug: 'group-clinic',
        color: '#16a34a',
        tags: [],
        isFreeTrial: true,
        base_score: 10,
        description: 'Drill-based group clinic, organised by rating band.',
      },
      {
        name: 'Cardio Tennis',
        slug: 'cardio-tennis',
        color: '#ea580c',
        tags: [],
        isFreeTrial: true,
        base_score: 12,
        description: 'High-energy footwork and rally games — fitness first, score second.',
      },
      {
        name: 'Junior Development',
        slug: 'junior-dev',
        color: '#2563eb',
        tags: ['beginner'],
        isFreeTrial: true,
        base_score: 8,
        description: 'Ages 6–14 — the red-to-green ball development pathway.',
      },
      {
        name: 'Match Play',
        slug: 'match-play',
        color: '#7c3aed',
        tags: ['intermediate'],
        isFreeTrial: false,
        base_score: 14,
        description: 'Supervised competitive sets with coaching between games.',
      },
    ],
    rankingSystem: {
      id: 'rating-band',
      name: 'Rating Band',
      levels: [
        { value: 0, label: '1.0–2.0 Beginner', color: '#94a3b8' },
        { value: 1, label: '2.5–3.0 Improver', color: '#2563eb' },
        { value: 2, label: '3.5–4.0 Intermediate', color: '#16a34a' },
        { value: 3, label: '4.5–5.0 Advanced', color: '#dc2626' },
      ],
    },
    subscriptions: [
      {
        kind: 'monthly',
        name: 'Court Membership',
        description: 'Unlimited clinics + court booking, monthly.',
        source: 'internal',
        price: 130,
      },
      {
        kind: 'quarterly',
        name: 'Seasonal Plan',
        description: 'One season of group clinics.',
        source: 'internal',
        price: 340,
      },
      {
        kind: 'annual',
        name: 'Annual Membership',
        description: 'Full year, includes 2 private lessons.',
        source: 'internal',
        price: 1190,
      },
    ],
    locations: ['Court 1', 'Court 2', 'Indoor Court'],
    events: [
      {
        title: 'Club Championships',
        type: 'competition',
        startOffset: 50,
        durationH: 10,
        fee: 20,
        location: 'Court 1',
        description: 'Annual singles + doubles club championship across all bands.',
      },
      {
        title: 'Junior Camp',
        type: 'camp',
        startOffset: 35,
        durationH: 30,
        fee: 160,
        location: 'Indoor Court',
        description: 'Week-long junior development camp. Ages 8–14.',
      },
      {
        title: 'Doubles Strategy Clinic',
        type: 'seminar',
        startOffset: 14,
        durationH: 2,
        fee: 15,
        location: 'Court 2',
        description: 'Positioning and shot selection for doubles.',
      },
    ],
    goals: [
      {
        title: 'Reliable second serve',
        description: 'Land 7/10 kick second serves under pressure.',
        categories: ['technique', 'mental'],
      },
      {
        title: 'Move up a rating band',
        description: 'Progress from 3.0 to 3.5 by end of season.',
        categories: ['attitude'],
      },
      {
        title: 'Net play confidence',
        description: 'Finish points at the net in match play.',
        categories: ['technique'],
      },
      {
        title: 'Match fitness',
        description: 'Play 3 full sets without fading.',
        categories: ['physical'],
      },
    ],
    tasks: [
      'Shadow-swing serve 10 min/day',
      'Watch a pro doubles match',
      'String racquet before camp',
      'Footwork ladder twice a week',
    ],
  },
  // ── WELLNESS ─────────────────────────────────────────────────────────────────
  {
    key: 'yoga',
    sector: 'wellness',
    ownerName: 'Maya Iyer',
    teamName: 'Lotus Yoga Studio',
    teamSlug: 'lotus-yoga-studio',
    sportType: 'Yoga / Pilates',
    accentColor: '#9333ea',
    instructors: ['Maya Iyer', 'Clara Hoffmann'],
    description:
      'A calm space for vinyasa, yin and meditation — every body, every level, every day.',
    portalGradient: 'sunset',
    appointmentName: 'Private Session',
    activities: [
      {
        name: 'Vinyasa Flow',
        slug: 'vinyasa-flow',
        color: '#9333ea',
        tags: [],
        isFreeTrial: true,
        base_score: 10,
        description: 'Breath-led flowing practice for all levels.',
      },
      {
        name: 'Yin Yoga',
        slug: 'yin-yoga',
        color: '#0891b2',
        tags: [],
        isFreeTrial: true,
        base_score: 8,
        description: 'Long-held floor poses to release deep tension.',
      },
      {
        name: 'Power Yoga',
        slug: 'power-yoga',
        color: '#dc2626',
        tags: ['intermediate'],
        isFreeTrial: false,
        base_score: 12,
        description: 'A stronger, sweatier flow for experienced practitioners.',
      },
      {
        name: 'Meditation',
        slug: 'meditation',
        color: '#16a34a',
        tags: [],
        isFreeTrial: true,
        base_score: 6,
        description: 'Guided sits and breathwork — start or end your day grounded.',
      },
    ],
    rankingSystem: null, // wellness studios don't grade students
    subscriptions: [
      {
        kind: 'monthly',
        name: 'Unlimited Monthly',
        description: 'Unlimited classes, billed monthly.',
        source: 'internal',
        price: 110,
      },
      {
        kind: 'quarterly',
        name: '10-Class Pack',
        description: 'Ten classes, use any time in 3 months.',
        source: 'internal',
        price: 180,
      },
      {
        kind: 'annual',
        name: 'Annual Membership',
        description: 'Full year of unlimited flow.',
        source: 'internal',
        price: 990,
      },
      {
        kind: 'aggregator',
        name: 'ClassPass',
        description: 'Access via the ClassPass network.',
        source: 'aggregator',
        price: null,
      },
    ],
    locations: ['Studio A', 'Studio B', 'Garden Deck'],
    events: [
      {
        title: 'Weekend Yoga Retreat',
        type: 'camp',
        startOffset: 55,
        durationH: 48,
        fee: 220,
        location: 'Lakeside Retreat House',
        description: 'Two-day immersion: flow, meditation and restorative practice.',
      },
      {
        title: 'Breathwork Workshop',
        type: 'seminar',
        startOffset: 18,
        durationH: 2,
        fee: 35,
        location: 'Studio A',
        description: 'Guided pranayama and breath techniques for calm.',
      },
      {
        title: 'Full-Moon Flow',
        type: 'seminar',
        startOffset: 9,
        durationH: 1.5,
        fee: 0,
        location: 'Garden Deck',
        description: 'Free community evening flow under the full moon.',
      },
    ],
    goals: [
      {
        title: 'Hold crow for 10s',
        description: 'Build the arm balance gradually and safely.',
        categories: ['technique', 'physical'],
      },
      {
        title: 'Daily breath practice',
        description: '5 minutes of pranayama every morning.',
        categories: ['attitude', 'mental'],
      },
      {
        title: 'Touch toes comfortably',
        description: 'Improve hamstring mobility over 6 weeks.',
        categories: ['physical'],
      },
      {
        title: 'Attend 3× per week',
        description: 'Build a consistent practice rhythm.',
        categories: ['attendance'],
      },
    ],
    tasks: [
      'Roll out the mat before bed',
      'Try one Yin class this week',
      'Breathe 5 min each morning',
      'Note how you feel after class',
    ],
  },
  {
    key: 'pilates',
    sector: 'wellness',
    ownerName: 'Sophie Laurent',
    teamName: 'Core Pilates Studio',
    teamSlug: 'core-pilates-studio',
    sportType: 'Yoga / Pilates',
    accentColor: '#0d9488',
    instructors: ['Sophie Laurent', 'Nadia Brun'],
    description:
      'Reformer and mat pilates in small, focused groups — strength, posture and control.',
    portalGradient: 'ocean',
    appointmentName: 'Private Reformer',
    activities: [
      {
        name: 'Reformer Flow',
        slug: 'reformer-flow',
        color: '#0d9488',
        tags: [],
        isFreeTrial: true,
        base_score: 12,
        description: 'Full-body reformer sequence — maximum six per class.',
      },
      {
        name: 'Mat Pilates',
        slug: 'mat-pilates',
        color: '#9333ea',
        tags: [],
        isFreeTrial: true,
        base_score: 10,
        description: 'Classical mat work for core strength and posture.',
      },
      {
        name: 'Barre',
        slug: 'barre',
        color: '#db2777',
        tags: [],
        isFreeTrial: true,
        base_score: 10,
        description: 'Ballet-inspired sculpt and balance work at the barre.',
      },
      {
        name: 'Core & Stability',
        slug: 'core-stability',
        color: '#2563eb',
        tags: ['beginner'],
        isFreeTrial: true,
        base_score: 8,
        description: 'Gentle foundations for beginners and post-rehab returns.',
      },
    ],
    rankingSystem: {
      id: 'reformer-level',
      name: 'Reformer Level',
      levels: [
        { value: 0, label: 'Level 1', color: '#94a3b8' },
        { value: 1, label: 'Level 2', color: '#0d9488' },
        { value: 2, label: 'Level 3', color: '#7c3aed' },
      ],
    },
    subscriptions: [
      {
        kind: 'monthly',
        name: 'Unlimited Monthly',
        description: 'Unlimited reformer + mat, monthly.',
        source: 'internal',
        price: 165,
      },
      {
        kind: 'quarterly',
        name: '8-Class Pack',
        description: 'Eight reformer classes in 2 months.',
        source: 'internal',
        price: 200,
      },
      {
        kind: 'annual',
        name: 'Annual Membership',
        description: 'Best value — unlimited all year.',
        source: 'internal',
        price: 1690,
      },
      {
        kind: 'aggregator',
        name: 'ClassPass',
        description: 'Access via the ClassPass network.',
        source: 'aggregator',
        price: null,
      },
    ],
    locations: ['Reformer Room', 'Mat Studio', 'Barre Studio'],
    events: [
      {
        title: 'Reformer Intensive',
        type: 'camp',
        startOffset: 42,
        durationH: 4,
        fee: 60,
        location: 'Reformer Room',
        description: 'Half-day deep dive into advanced reformer repertoire.',
      },
      {
        title: 'Posture Workshop',
        type: 'seminar',
        startOffset: 16,
        durationH: 2,
        fee: 30,
        location: 'Mat Studio',
        description: 'Understand your posture and build a daily routine.',
      },
      {
        title: 'Prenatal Pilates Q&A',
        type: 'seminar',
        startOffset: 10,
        durationH: 1,
        fee: 0,
        location: 'Barre Studio',
        description: 'Free session on safe movement during pregnancy.',
      },
    ],
    goals: [
      {
        title: 'Master the hundred',
        description: 'Hold strong form through all 100 beats.',
        categories: ['technique', 'physical'],
      },
      {
        title: 'Improve core control',
        description: 'Stable pelvis through full reformer flow.',
        categories: ['physical'],
      },
      {
        title: 'Progress to Level 2',
        description: 'Build the strength for the Level 2 repertoire.',
        categories: ['attitude'],
      },
      {
        title: 'Weekly consistency',
        description: 'Two reformer + one mat class each week.',
        categories: ['attendance'],
      },
    ],
    tasks: [
      'Foot exercises at home',
      'Book a Level 2 assessment',
      'Practice breathing pattern',
      'Stretch hip flexors daily',
    ],
  },
  {
    key: 'dance',
    sector: 'wellness',
    ownerName: 'Isabella Rossi',
    teamName: 'Rhythm Dance Studio',
    teamSlug: 'rhythm-dance-studio',
    sportType: 'Dance',
    accentColor: '#db2777',
    instructors: ['Isabella Rossi', 'Marcus Lee'],
    description:
      'Ballet, contemporary and hip-hop for kids and adults — from first steps to the showcase stage.',
    portalGradient: 'warm',
    appointmentName: 'Private Lesson',
    activities: [
      {
        name: 'Ballet',
        slug: 'ballet',
        color: '#db2777',
        tags: [],
        isFreeTrial: true,
        base_score: 10,
        description: 'Classical technique from barre to centre work.',
      },
      {
        name: 'Contemporary',
        slug: 'contemporary',
        color: '#9333ea',
        tags: ['intermediate'],
        isFreeTrial: true,
        base_score: 12,
        description: 'Floor work, release technique and choreography.',
      },
      {
        name: 'Hip-Hop',
        slug: 'hip-hop',
        color: '#0f172a',
        tags: [],
        isFreeTrial: true,
        base_score: 12,
        description: 'Foundations, grooves and choreo to current tracks.',
      },
      {
        name: 'Kids Dance',
        slug: 'kids-dance',
        color: '#f59e0b',
        tags: ['beginner'],
        isFreeTrial: true,
        base_score: 8,
        description: 'A playful introduction to rhythm and movement, ages 5–9.',
      },
    ],
    rankingSystem: {
      id: 'dance-grade',
      name: 'Grade',
      levels: [
        { value: 0, label: 'Pre-Bronze', color: '#a16207' },
        { value: 1, label: 'Bronze', color: '#b45309' },
        { value: 2, label: 'Silver', color: '#94a3b8' },
        { value: 3, label: 'Gold', color: '#eab308' },
      ],
    },
    subscriptions: [
      {
        kind: 'monthly',
        name: 'Unlimited Monthly',
        description: 'Unlimited classes, billed monthly.',
        source: 'internal',
        price: 120,
      },
      {
        kind: 'quarterly',
        name: 'Term Plan',
        description: 'One full term of weekly classes.',
        source: 'internal',
        price: 290,
      },
      {
        kind: 'annual',
        name: 'Annual Membership',
        description: 'Full year including the showcase.',
        source: 'internal',
        price: 1090,
      },
    ],
    locations: ['Dance Hall', 'Studio 2', 'Performance Space'],
    events: [
      {
        title: 'Spring Showcase',
        type: 'competition',
        startOffset: 60,
        durationH: 4,
        fee: 15,
        location: 'Performance Space',
        description: 'Our annual student showcase across all styles and grades.',
      },
      {
        title: 'Hip-Hop Masterclass',
        type: 'seminar',
        startOffset: 21,
        durationH: 2,
        fee: 35,
        location: 'Dance Hall',
        description: 'Guest choreographer masterclass — all levels.',
      },
      {
        title: 'Open Day',
        type: 'seminar',
        startOffset: 12,
        durationH: 3,
        fee: 0,
        location: 'Studio 2',
        description: 'Free taster classes for new and prospective dancers.',
      },
    ],
    goals: [
      {
        title: 'Clean double pirouette',
        description: 'Land a controlled double turn.',
        categories: ['technique'],
      },
      {
        title: 'Perform at the showcase',
        description: 'Learn and polish the showcase routine.',
        categories: ['attitude', 'mental'],
      },
      {
        title: 'Improve flexibility',
        description: 'Reach a full split over the term.',
        categories: ['physical'],
      },
      {
        title: 'Grade up',
        description: 'Pass the next grade assessment.',
        categories: ['attendance', 'attitude'],
      },
    ],
    tasks: [
      'Stretch 15 min daily',
      'Practice the routine at home',
      'Watch the choreography video',
      'Bring proper shoes to class',
    ],
  },
]

// ── per-team seed ───────────────────────────────────────────────────────────

async function seedDemoTeam(profile: SectorProfile) {
  const {
    key,
    ownerName,
    teamName,
    teamSlug,
    sportType,
    accentColor,
    description,
    portalGradient,
    instructors,
    activities,
    appointmentName,
    rankingSystem,
    subscriptions,
    locations,
  } = profile
  const teamId = `sandbox-${key}`
  const uid = `sandbox-${key}-uid`
  const email = `${key}@linyup.com`
  const contactCount = CONTACT_POOL.length // ~24 contacts per team
  const teamLanguage = 'en'

  // ── subscription types ────────────────────────────────────────────────────
  const subIdOf = (kind: SubKind) => `${teamId}-sub-${kind}`
  // Canonical recurrence per kind — drives the single seeded price each priced
  // type carries. Aggregator types stay price-less.
  const recurrenceForKind = (k: Exclude<SubKind, null>): string | null =>
    k === 'monthly'
      ? 'monthly'
      : k === 'quarterly'
        ? 'quarterly'
        : k === 'annual'
          ? 'annual'
          : null
  function resolveSub(kind: SubKind): {
    id: string
    name: string
    recurrence: string | null
    priceId?: string
    amount?: number
  } | null {
    if (!kind) return null
    const found =
      subscriptions.find((s) => s.kind === kind) ??
      subscriptions.find((s) => s.kind === 'monthly')!
    const id = subIdOf(found.kind)
    const recurrence = recurrenceForKind(found.kind)
    return found.price != null && recurrence
      ? { id, name: found.name, recurrence, priceId: `${id}-price`, amount: found.price }
      : { id, name: found.name, recurrence }
  }

  const rankSystemId = rankingSystem?.id ?? null
  function rankFor(entry: PoolEntry): number | null {
    if (!rankingSystem || entry.type !== 'student') return null
    const n = rankingSystem.levels.length
    const s = entry.totalSessions
    // Bucket by attendance across the available levels.
    if (s < 15) return 0
    if (s < 50) return Math.min(1, n - 1)
    if (s < 100) return Math.min(2, n - 1)
    if (s < 160) return Math.min(3, n - 1)
    return n - 1
  }

  const gamificationSettings = {
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

  // ── auth user (owner) ───────────────────────────────────────────────────────
  await upsertAuthUser({ uid, email, displayName: ownerName, password: DEMO_PASSWORD })

  // ── team doc + public profile ─────────────────────────────────────────────
  // Every sandbox team installs the full storefront (memberships, products,
  // courses, website), so the bio-link surfaces all of them.
  const portalLinks = buildStorefrontPageLinks()
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
    // Every sandbox team seeds an appointment activity + availability.
    appointmentsEnabled: true,
  }

  await db
    .collection('teams')
    .doc(teamId)
    .set({
      name: teamName,
      description,
      slug: teamSlug,
      sport_type: sportType,
      language: teamLanguage,
      createdBy: uid,
      created: ts(daysFromNow(-220)),
      plan: 'studio',
      plan_status: 'active',
      default_currency: 'CHF',
      payment_modes: [...DEFAULT_PAYMENT_MODES],
      // Standalone Studio demo teams enable the affiliation axis (team-local 'club').
      affiliations_enabled: true,
      ranking_systems: rankingSystem
        ? [{ ...rankingSystem, is_primary: true, levels: withRankLevelIds(rankingSystem.levels) }]
        : [],
      settings: { gamification: gamificationSettings, teamEmail: email },
      bioLinkTheme: 'light',
      bioLinkAccentColor: accentColor,
      bioLinkBackground,
      links: portalLinks,
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
    })

  // Mirror written to public_profile (what syncSubscriptionTypesToPublicProfile
  // would produce) so the bio-link / website pricing table works deterministically.

  const publicSubTypes = subscriptions.map((st) => {
    const recurrence = recurrenceForKind(st.kind)
    const entry: {
      id: string
      name: string
      description?: string
      checkout_contact_mode?: string
      prices?: { id: string; amount: number; recurrence: string }[]
    } = {
      id: subIdOf(st.kind),
      name: st.name,
      checkout_contact_mode: recurrence && recurrence !== 'per_class' ? 'full' : 'minimal',
    }
    if (st.description) entry.description = st.description
    // price.id (stable client id) must mirror the raw subscription_types write so the
    // shop's Buy button enables and checkout can resolve the chosen price.
    if (st.price != null && recurrence)
      entry.prices = [{ id: `${subIdOf(st.kind)}-price`, amount: st.price, recurrence }]
    return entry
  })

  await db
    .collection('teams')
    .doc(teamId)
    .collection('public_profile')
    .doc(teamId)
    .set({
      type: 'team',
      name: teamName,
      description,
      slug: teamSlug,
      sport_type: sportType,
      profileImage: null,
      heroImage: null,
      bioLinkTheme: 'light',
      bioLinkAccentColor: accentColor,
      bioLinkBackground,
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
      links: portalLinks,
      bookingSettings,
      default_currency: 'CHF',
      aggregator_subscription_types: publicSubTypes,
      partner_apps: partnerAppNames(subscriptions),
      membershipRequiredFields: null,
      membershipOptionalFields: null,
      updated_at: ts(now()),
    })

  // ── owner member + user profile ─────────────────────────────────────────────
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
  const [ownerFirst, ownerLast] = ownerName.split(' ')
  await db
    .collection('users')
    .doc(uid)
    .set(
      {
        email,
        displayName: ownerName,
        firstname: ownerFirst,
        lastname: ownerLast ?? '',
        currentTeam: teamId,
        created_at: ts(daysFromNow(-220)),
      },
      { merge: true }
    )

  // ── manager member (second instructor as manager role) ──────────────────────
  // Each demo team gets a manager so the coach picker shows all three coach-
  // eligible roles (owner, manager, coach). Uses the second instructor name.
  const managerUid = `${teamId}-manager`
  const managerName = instructors[1] ?? `${ownerName.split(' ')[0]} Assistant`
  const managerEmail = `${key}-manager@linyup.com`
  await upsertAuthUser({
    uid: managerUid,
    email: managerEmail,
    displayName: managerName,
    password: DEMO_PASSWORD,
  })
  await db
    .collection('teams')
    .doc(teamId)
    .collection('team_members')
    .doc(managerUid)
    .set({
      teamId,
      userId: managerUid,
      role: 'manager',
      email: managerEmail,
      ...memberCapsFor('manager'),
      joined: ts(daysFromNow(-180)),
      addedBy: uid,
    })
  const [mgrFirst, mgrLast] = managerName.split(' ')
  await db
    .collection('users')
    .doc(managerUid)
    .set({
      email: managerEmail,
      displayName: managerName,
      firstname: mgrFirst,
      lastname: mgrLast ?? '',
      currentTeam: teamId,
      created_at: ts(daysFromNow(-180)),
    })

  // ── coach role config (owner + manager + coach eligible) ───────────────────
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
      updated_at: ts(daysFromNow(-180)),
    })

  // ── affiliation type catalog (team-local 'club') ──────────────────────────
  const affiliationTypeDefs = teamAffiliationTypes()
  const clubAffiliationType = affiliationTypeDefs.find((t) => t.key === 'club')!
  for (const at of affiliationTypeDefs) {
    await db
      .collection('teams')
      .doc(teamId)
      .collection(AFFILIATION_TYPES_SUBCOLLECTION)
      .doc(at.id)
      .set(at)
  }

  // ── activities (classes + appointments) ─────────────────────────────────
  const actIds = activities.map((_, i) => `${teamId}-act-${i}`)
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i]
    // Paid-access gate: explicit subscription gate when the def carries
    // accessSubKinds, else derived from isFreeTrial (the same derivation
    // resolveActivityAccessRule applies). isFreeTrial stays in sync (open ⇔ true).
    const accessRule = a.accessSubKinds?.length
      ? { type: 'subscription', subscriptionTypeIds: a.accessSubKinds.map((k) => subIdOf(k)) }
      : { type: a.isFreeTrial ? 'open' : 'members' }
    const dropIn =
      a.dropInPrice != null ? { enabled: true, priceAmount: a.dropInPrice } : null
    await db
      .collection('activities')
      .doc(actIds[i])
      .set({
        teamId,
        name: a.name,
        slug: a.slug,
        color: a.color,
        description: a.description,
        isFreeTrial: a.isFreeTrial,
        accessRule,
        ...(a.trialEnabled ? { trialEnabled: true } : {}),
        ...(dropIn ? { dropIn } : {}),
        base_score: a.base_score,
        type: 'class',
        // Bookings confirm themselves — the default `resolveAutoConfirm` gives
        // a class too (2026-09-11). Written explicitly so the seed exercises
        // the field; a class that needs the studio's approval is the exception
        // a studio sets on purpose, and none of these do.
        autoConfirm: true,
        isActive: true,
        created_at: ts(daysFromNow(-200)),
      })
    await db
      .collection('activities')
      .doc(actIds[i])
      .collection('public_profile')
      .doc(actIds[i])
      .set({
        type: 'activity',
        activityType: 'class',
        teamId,
        name: a.name,
        slug: a.slug,
        color: a.color,
        description: a.description,
        image_url: null,
        isFreeTrial: a.isFreeTrial,
        accessRule,
        // Drop-in mirrored only when enabled + priced, exactly as
        // syncActivityPublicProfile does. trialEnabled IS mirrored (when true)
        // so the public flow can offer the newcomer trial door.
        ...(dropIn ? { dropIn } : {}),
        ...(a.trialEnabled ? { trialEnabled: true } : {}),
        ...(a.tags?.length ? { tags: normalizeActivityTags(a.tags) } : {}),
      })
  }

  // The WHAT of an appointment: name, bookable lengths (with their prices) and
  // the ONE member-benefit rule. No access rule — the price is the gate. The
  // availability below only publishes the WHEN.
  const appointmentActId = `${teamId}-act-appointment`
  // Per-duration BASE pricing (major units, CHF), and ONE MEMBER RULE PER
  // LENGTH (`Activity.durationBenefits`). The rule is per length because the
  // price is: a single activity-wide rule could not say "the short one is
  // included, the long one is cheaper", and could not express a fixed member
  // price at all (one amount cannot be right for 30 and 60 minutes alike).
  //
  // THE SEEDS DEMO DIFFERENT EFFECTS ON PURPOSE, so a click-through meets each
  // of them: this one gives monthly-plan holders their 30-minute check-in free
  // and 20% off the 60-minute session (85 → 68). Every sandbox profile defines
  // a monthly plan, so the id below always resolves.
  //
  // The legacy activity-wide
  // `memberBenefit` is deliberately NOT written anywhere here — its fallback is
  // covered by a unit test, not by seed data a studio might mistake for the
  // shape the product writes today.
  const appointmentDurations = [
    { minutes: 30, priceAmount: 45 },
    { minutes: 60, priceAmount: 85 },
  ]
  const appointmentMonthly = subIdOf('monthly')
  const appointmentDurationBenefits = [
    { minutes: 30, benefit: { subscriptionTypeIds: [appointmentMonthly], effect: 'included' } },
    {
      minutes: 60,
      benefit: {
        subscriptionTypeIds: [appointmentMonthly],
        effect: 'percent_off',
        percent: 20,
      },
    },
  ]
  await db
    .collection('activities')
    .doc(appointmentActId)
    .set({
      teamId,
      name: appointmentName,
      slug: 'private-coaching',
      color: accentColor,
      type: 'appointment',
      providerId: uid,
      providerName: ownerName,
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
      name: appointmentName,
      slug: 'private-coaching',
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

  // ── availability (the WHEN — publishes free time, generates nothing) ────
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
      providerName: ownerName,
      // The SCHEDULE's name — the offering's name lives on the activity.
      title: 'Weekday mornings',
      description: `One-on-one ${appointmentName.toLowerCase()}.`,
      activityIds: [appointmentActId],
      location: locations[0],
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

  // ── booked appointments ─────────────────────────────────────────────────
  // Availability pre-generates NOTHING — a session exists only once someone
  // books. These mirror what `bookAppointment` writes.
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
      activityName: appointmentName,
      providerId: uid,
      providerName: ownerName,
      start: apt.start,
      durationMinutes: apt.durationMinutes,
      location: locations[0],
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

  // ── subscription types ────────────────────────────────────────────────────
  for (const st of subscriptions) {
    const id = subIdOf(st.kind)
    const recurrence = recurrenceForKind(st.kind)
    const prices =
      st.price != null && recurrence
        ? [{ id: `${id}-price`, amount: st.price, recurrence, active: true }]
        : []
    await db
      .collection('teams')
      .doc(teamId)
      .collection('subscription_types')
      .doc(id)
      .set({
        name: st.name,
        description: st.description,
        source: st.source,
        active: true,
        // Surface every plan on the bio-link / website pricing table.
        public: true,
        checkout_contact_mode: recurrence && recurrence !== 'per_class' ? 'full' : 'minimal',
        prices,
        teamId,
        created_at: ts(daysFromNow(-120)),
      })
  }

  // ── group sessions (4 past weeks + 4 upcoming weeks) ──────────────────────
  // Weekly template references activities by index (modulo, so 4–5 activities work).
  type Slot = {
    day: number
    actIdx: number
    hour: number
    dur: number
    locIdx: number
    upcomingOnly?: boolean
  }
  const weeklyTemplate: Slot[] = [
    { day: 1, actIdx: 0, hour: 18, dur: 1.5, locIdx: 0 },
    { day: 2, actIdx: 3, hour: 9, dur: 1, locIdx: 1 },
    { day: 3, actIdx: 2, hour: 19, dur: 1, locIdx: 1 },
    { day: 5, actIdx: 0, hour: 7, dur: 1, locIdx: 0 },
    { day: 6, actIdx: 1, hour: 10, dur: 1.5, locIdx: 2 },
    { day: 0, actIdx: 3, hour: 10, dur: 1, locIdx: 1, upcomingOnly: true },
  ]
  type SessionDef = {
    dayOffset: number
    actIdx: number
    hour: number
    duration: number
    location: string
    allowBooking: boolean
    instructor: string
  }
  const sessionDefs: SessionDef[] = []
  for (let week = -4; week <= 3; week++) {
    const upcoming = week >= 0
    for (let si = 0; si < weeklyTemplate.length; si++) {
      const s = weeklyTemplate[si]
      if (s.upcomingOnly && !upcoming) continue
      sessionDefs.push({
        dayOffset: week * 7 + s.day,
        actIdx: s.actIdx % activities.length,
        hour: s.hour,
        duration: s.dur,
        location: locations[s.locIdx % locations.length],
        // Every upcoming session is bookable; the `upcomingOnly` Sunday slot is
        // the one kept OFF the booking calendar on purpose — the showcase of
        // the exception a studio sets, never a default.
        allowBooking: upcoming && !s.upcomingOnly,
        instructor: instructors[si % instructors.length],
      })
    }
  }

  const pastCount = sessionDefs.filter((s) => s.dayOffset < 0).length
  const sessionIds: string[] = []
  for (let i = 0; i < sessionDefs.length; i++) {
    const s = sessionDefs[i]
    const a = activities[s.actIdx]
    const base = daysFromNow(s.dayOffset)
    base.setHours(s.hour, 0, 0, 0)
    const end = hoursOffset(base, s.duration)
    const id = `${teamId}-session-${i.toString().padStart(3, '0')}`
    sessionIds.push(id)

    await db
      .collection('sessions')
      .doc(id)
      .set({
        teamId,
        activityId: actIds[s.actIdx],
        activityName: a.name,
        start: ts(base),
        end: ts(end),
        location: s.location,
        providerName: s.instructor,
        locationAddress: '12 Studio Lane',
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
          activityId: actIds[s.actIdx],
          activityName: a.name,
          activityColor: a.color,
          activitySlug: a.slug,
          activityIsFreeTrial: a.isFreeTrial,
          activityImage: null,
          start: ts(base),
          end: ts(end),
          location: s.location,
          providerName: s.instructor,
          locationAddress: '12 Studio Lane',
          locationMapsUrl: null,
          capacity: null,
          participants_count: 0,
          allowBooking: true,
          slug: null,
        })
    }
  }

  // ── contacts ───────────────────────────────────────────────────────────────
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
    const monthScore = c.totalSessions > 0 ? Math.floor(seededRand(seed + 'sc') * 140) : 0
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

    // ── affiliation (replaces the old membership_* fields) ───────────────────
    // Standalone studio → issuer 'team', team-local 'club' type. External and
    // guest contacts hold no affiliation.
    const writeAffiliation = c.type !== 'external' && c.status !== 'guest'
    const affiliationDoc = writeAffiliation
      ? buildAffiliationDoc({
          teamId,
          type: clubAffiliationType,
          statusId: c.status,
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
            ? 'Consistent attendance. Progressing well — review focus areas next month.'
            : c.type === 'trial'
              ? 'Came in via the website trial form — follow up after first session.'
              : '',
        created_at: createdTs,
        deleted_at: null,
        archived_at: null,
        ...acquisition,
        // Best-effort affiliation summary (the trigger recomputes this live).
        ...(affiliationDoc
          ? { affiliation_summary: buildAffiliationSummary([affiliationDoc as AffiliationSummaryInput]) }
          : {}),
        current_month_score: monthScore,
        current_streak: streak,
        max_streak: maxStreak,
        times_leader: Math.floor(seededRand(seed + 'tl') * 3),
        times_top5: Math.floor(seededRand(seed + 't5') * 6),
        distinct_activities: activities
          .slice(0, 1 + Math.floor(seededRand(seed + 'da') * 2))
          .map((a) => a.slug),
        custom_badges: badgesFor(c.totalSessions, maxStreak, seed),
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
        ...(rank != null && rankSystemId ? { ranks: { [rankSystemId]: rank } } : {}),
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

  // ── contact alerts (show_in_app) — a few per team ─────────────────────────
  // Gamification scores follow the team's own switch — scores under a disabled
  // scoreboard are data no screen explains.
  if (gamificationSettings.enabled) {
    await seedMonthlyScores({ teamId, monthlyCap: gamificationSettings.monthly_cap })
  }

  await seedContactAlerts({ teamId, vocabulary: 'generic' })

  // ── goals & tasks ──────────────────────────────────────────────────────────
  // `categories` are GOAL CATEGORIES (technique / attitude / attendance /
  // physical / mental — see DEFAULT_GOAL_CATEGORIES), never check-in axis keys.
  // A step created FROM a weak axis carries `from_dimension` instead — seeded
  // by seedPerformanceCheckins below, which is where the axis comes from.
  const goalContactIds: string[] = []
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i]
    if (c.type !== 'student' || c.totalSessions < 5) continue
    const id = contactIds[i]
    goalContactIds.push(id)
    const numGoals = i < 4 ? 2 : 1
    for (let g = 0; g < numGoals; g++) {
      const def = profile.goals[(i + g) % profile.goals.length]
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
                  ? 'Good start — keep practising.'
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
        title: profile.tasks[i % profile.tasks.length],
        description: null,
        status: taskDone ? 'achieved' : 'open',
        categories: [],
        created_by: 'coach',
        created_at: ts(daysFromNow(-7)),
        target_date: ts(daysFromNow(7)),
        completed_at: taskDone ? ts(daysFromNow(-2)) : null,
      })
  }

  // ── performance check-ins ──────────────────────────────────────────────────
  // Straight after the goals, because the arcs hang a `from_dimension` step off
  // one. Capped at six: that is one contact per named profile the heuristic can
  // report, and a seventh would only repeat a story. See lib/fixtures/coaching.ts.
  const checkins = await seedPerformanceCheckins({ contactIds: goalContactIds.slice(0, 6) })

  // ── past-session participants + bookings ──────────────────────────────────
  const studentIdxs = pool
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.type === 'student')
    .map((x) => x.i)
  for (let i = 0; i < pastCount; i++) {
    const sid = sessionIds[i]
    if (!sid) continue
    const target = 4 + ((i * 3) % 6)
    const attending = studentIdxs
      .filter((_, k) => (k + i) % studentIdxs.length < target)
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

  // ── team activity log ─────────────────────────────────────────────────────
  const logEntries = [
    {
      event: 'contact_add',
      desc: `New trial contact ${pool[bookingIdxs[0]]?.firstname ?? 'lead'} added from portal.`,
      contact: contactIds[bookingIdxs[0]],
    },
    {
      event: 'session_participant_add',
      desc: `${pool[0].firstname} ${pool[0].lastname} checked into ${activities[0].name}.`,
      contact: contactIds[0],
    },
    {
      event: 'subscription_change',
      desc: `${pool[1].firstname} ${pool[1].lastname} switched to ${subscriptions.find((s) => s.kind === 'annual')?.name ?? 'Annual'}.`,
      contact: contactIds[1],
    },
    {
      event: 'booking_confirmed',
      desc: 'Trial booking confirmed for an upcoming session.',
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

  // ── automations (Studio tier) ─────────────────────────────────────────────────
  await seedAutomations({ teamId, language: teamLanguage, vocabulary: 'generic' })

  // ── events ───────────────────────────────────────────────────────────────────
  for (let ei = 0; ei < profile.events.length; ei++) {
    const e = profile.events[ei]
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

  // ── installed plugins + their demo data (website, online courses, gamification) ──
  await seedTeamPlugins(profile, teamId, uid)

  // ── team weekly reports (1 year of history → dashboard trend charts) ────────
  await seedWeeklyReports(teamId)

  // ── saas_subscriptions (active Studio; gateway_type null = manually managed) ──
  const nowTs = ts(now())
  await db
    .collection('saas_subscriptions')
    .doc(teamId)
    .set({
      teamId,
      plan: 'studio',
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

  // ── messaging policy: /try teams NEVER deliver outbound mail/SMS ────────────
  // Anonymous visitors hold the shared owner logins and public surfaces (forms,
  // booking OTP) accept arbitrary recipient addresses — hard-silence the tenant
  // regardless of the environment's MESSAGING_DEFAULT_MODE.
  await db.collection('messaging_policies').doc(teamId).set({
    entityId: teamId,
    mode: 'silent',
    note: '/try playground — public shared logins; no outbound messaging.',
    updated_at: nowTs,
    updated_by: 'seed-sandbox',
  })

  // ── Stripe Connect (TEST) ───────────────────────────────────────────────────
  // Links a REAL onboarded test account when STRIPE_CONNECT_TEST_ACCOUNT names
  // one for this team; silently leaves the team payment-less otherwise. Last, so
  // it merges onto the public_profile written above rather than being overwritten
  // by it. See scripts/lib/connect.ts for the one-time setup.
  await linkSeedConnectAccount({ db, teamId })

  // The profile tally is printed, not asserted: the arcs in lib/fixtures/coaching.ts
  // are built to land on six DIFFERENT named profiles, and a change to
  // `detectPerformanceProfile` that collapsed them would otherwise be invisible.
  const profileTally = Object.entries(checkins.profiles)
    .map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
    .sort()
    .join(', ')
  console.log(
    `   ✓ ${teamName} (${profile.sector}) — ${contactCount} contacts, ${sessionDefs.length} sessions`
  )
  console.log(
    `     coaching: ${checkins.checkins} check-ins over ${checkins.contacts} contacts, ` +
      `${checkins.steps} steps from a weak axis (${profileTally})`
  )
  for (const d of checkins.drifted) {
    console.warn(`     ⚠ check-in arc built for '${d.intended}' now reads '${d.got}'`)
  }
}

// ── automations seed (templates + presets + rules + logs) ─────────────────────
// Copy is sector-neutral (uses {{teamName}}/{{firstname}} placeholders).


// ── plugin install + demo data (website, online courses, gamification) ────────
// All six demo teams install the same plugins with near-identical, sector-
// neutral content (parameterised by team name / sport) so every /try tenant
// showcases the full plugin surface.

async function seedTeamPlugins(profile: SectorProfile, teamId: string, uid: string) {
  const { teamName, teamSlug, description, accentColor, instructors, activities, locations } =
    profile

  // ── installed_plugins (the install = the feature gate) ──────────────────────
  // NOTE: never add a LOCKED plugin here (e.g. 'ai-assistant'). Locked plugins are
  // key-gated and must stay out of all seed/sandbox/demo data — they install only
  // via the unlockPlugin callable.
  const plugins: { id: string; config?: Record<string, unknown> }[] = [
    { id: 'gamification' }, // seed already writes scores/badges/settings
    { id: 'website' },
    { id: 'online-courses' },
    // NOT 'documents' — it is a default feature on every plan, not a plugin. Its
    // signup-consent selection is written to teams/{teamId}/settings/documents
    // below.
  ]
  for (const p of plugins) {
    await db
      .collection('teams')
      .doc(teamId)
      .collection('installed_plugins')
      .doc(p.id)
      .set({
        pluginId: p.id,
        teamId,
        installedAt: ts(daysFromNow(-200)),
        installedBy: uid,
        status: 'active',
        config: p.config ?? {},
        updated_at: ts(daysFromNow(-200)),
      })
  }

  // Documents settings — the signup-consent selection, in its post-plugin home.
  await seedDocumentsSettings(teamId, [`${teamId}-doc-terms`, `${teamId}-doc-privacy`], 200)

  // ── website plugin: a published one-page site (draft + public snapshot) ──────
  // hero + about + schedule (live sessions) + contact — every section populated.
  const siteSections = [
    {
      id: `${teamId}-sec-hero`,
      type: 'hero',
      headline: teamName,
      subheadline: description,
      align: 'center',
      overlay: 45,
      cta: { label: 'Book Now', action: 'booking' },
    },
    {
      id: `${teamId}-sec-about`,
      type: 'content',
      heading: `About ${teamName}`,
      menuLabel: 'About',
      imageSide: 'left',
      body: `<p>${description}</p><p>Our coaches welcome every level — drop in for a free trial class, find your rhythm, and become part of a community that keeps showing up. Sessions run throughout the week at ${locations[0]}.</p>`,
    },
    {
      id: `${teamId}-sec-schedule`,
      type: 'schedule',
      heading: 'Upcoming classes',
      menuLabel: 'Schedule',
      source: 'sessions',
      windowDays: 14,
      displayMode: 'calendar',
    },
    {
      id: `${teamId}-sec-contact`,
      type: 'contact',
      heading: 'Visit us',
      menuLabel: 'Contact',
      address: '12 Studio Lane, 8001 Zürich',
      phone: '+41 44 123 45 67',
      email: `${teamSlug}@linyup.com`,
      hours: 'Mon–Fri 7:00–21:00 · Sat 9:00–14:00',
      mapQuery: 'Zürich, Switzerland',
      showSocial: true,
    },
  ]
  const siteMeta = {
    title: teamName,
    theme: 'light',
    accentColor,
    font: 'sans',
    seo: { title: teamName, description },
    header: { showNav: true, ctaLabel: 'Book now', ctaAction: 'booking' },
    footer: { showSocial: true },
  }
  await db
    .collection('site_drafts')
    .doc(teamId)
    .set({
      teamId,
      slug: teamSlug,
      name: teamName,
      enabled: true,
      meta: siteMeta,
      sections: siteSections,
      updated_at: ts(daysFromNow(-12)),
      updatedBy: uid,
    })
  await db
    .collection('site_published')
    .doc(teamId)
    .set({
      teamId,
      slug: teamSlug,
      name: teamName,
      meta: siteMeta,
      sections: siteSections,
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${teamSlug}` }],
      showBranding: false, // studio plan
      published_at: ts(daysFromNow(-12)),
      updated_at: ts(daysFromNow(-12)),
    })

  // ── online courses plugin: 2 published courses (1 free, 1 sign-in required),
  // each with modules. Published courses also get a courses/{id}/public_profile/{id}
  // summary so the public Space lists them even before syncCoursePublicProfile is
  // deployed/triggered. ──
  const primary = activities[0]?.name ?? 'Training'
  const coach = instructors[0] ?? 'Your coach'
  const courses = [
    {
      id: `${teamId}-course-foundations`,
      title: `${primary} Foundations`,
      summary: `A self-paced introduction to ${primary.toLowerCase()} — watch, learn, and practise between classes.`,
      status: 'published' as const,
      access: 'free' as const,
      createdDaysAgo: 90,
      modules: [
        {
          title: 'Welcome & basics',
          lessons: [
            {
              title: 'What to expect',
              type: 'text' as const,
              body: `<p>Welcome to ${teamName}! Here is everything you need to know before your first class with ${coach}.</p>`,
            },
            {
              title: 'Your first session',
              type: 'video' as const,
              body: '<p>A quick walkthrough of how a typical class runs.</p>',
              media: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
              dur: 360,
            },
          ],
        },
        {
          title: 'Core skills',
          lessons: [
            {
              title: `${primary} fundamentals`,
              type: 'text' as const,
              body: '<p>The building blocks every member should master early on.</p>',
            },
            {
              title: 'Drills to practise at home',
              type: 'video' as const,
              body: '<p>Three short drills you can do between classes.</p>',
              media: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
              dur: 480,
            },
          ],
        },
        {
          title: 'Going further',
          lessons: [
            {
              title: 'Building consistency',
              type: 'text' as const,
              body: '<p>How to turn a few classes into a lasting habit.</p>',
            },
            {
              title: 'Tracking your progress',
              type: 'text' as const,
              body: '<p>Use the app to follow your attendance and milestones.</p>',
            },
          ],
        },
      ],
    },
    {
      id: `${teamId}-course-welcome`,
      title: `Getting started at ${teamName}`,
      summary: 'Our values, etiquette, and how to get the most from your membership.',
      status: 'published' as const,
      access: 'registered' as const,
      createdDaysAgo: 30,
      modules: [
        {
          title: 'Before you arrive',
          lessons: [
            {
              title: 'What to bring',
              type: 'text' as const,
              body: '<p>A short checklist for your first visit.</p>',
            },
            {
              title: 'Studio etiquette',
              type: 'text' as const,
              body: '<p>A few simple norms that keep classes welcoming for everyone.</p>',
            },
          ],
        },
        {
          title: 'Your membership',
          lessons: [
            {
              title: 'Making the most of it',
              type: 'text' as const,
              body: '<p>Tips for booking, attending and progressing.</p>',
            },
          ],
        },
      ],
    },
  ]

  for (const c of courses) {
    let moduleCount = 0,
      lessonCount = 0
    const courseRef = db.collection('courses').doc(c.id)
    for (let mi = 0; mi < c.modules.length; mi++) {
      const m = c.modules[mi]
      const moduleId = `${c.id}-m${mi}`
      await courseRef
        .collection('modules')
        .doc(moduleId)
        .set({
          courseId: c.id,
          teamId,
          title: m.title,
          order: mi,
          created_at: ts(daysFromNow(-c.createdDaysAgo)),
          updated_at: ts(daysFromNow(-c.createdDaysAgo)),
        })
      moduleCount++
      for (let li = 0; li < m.lessons.length; li++) {
        const l = m.lessons[li]
        await courseRef
          .collection('lessons')
          .doc(`${moduleId}-l${li}`)
          .set({
            courseId: c.id,
            moduleId,
            teamId,
            title: l.title,
            type: l.type,
            order: li,
            body: l.body,
            ...(l.type === 'video'
              ? { mediaSource: 'youtube', mediaUrl: l.media, durationSeconds: l.dur }
              : {}),
            attachments: [],
            created_at: ts(daysFromNow(-c.createdDaysAgo)),
            updated_at: ts(daysFromNow(-c.createdDaysAgo)),
          })
        lessonCount++
      }
    }
    await courseRef.set({
      scope: 'team',
      teamId,
      title: c.title,
      slug: `${c.id}`,
      summary: c.summary,
      status: c.status,
      accessRule: { type: c.access },
      moduleCount,
      lessonCount,
      order: 0,
      created_at: ts(daysFromNow(-c.createdDaysAgo)),
      updated_at: ts(daysFromNow(-c.createdDaysAgo)),
      createdBy: uid,
      archived_at: null,
    })

    // Mirror what syncCoursePublicProfile writes, so the public "Space" web area can
    // list published courses even before the trigger is deployed against the project.
    if (c.status === 'published') {
      await courseRef
        .collection('public_profile')
        .doc(c.id)
        .set({
          type: 'course',
          teamId,
          slug: `${c.id}`,
          title: c.title,
          summary: c.summary,
          coverImageUrl: null,
          accessType: c.access,
          subscriptionTypeIds: [],
          moduleCount,
          lessonCount,
          order: 0,
        })
    }
  }

  // ── storefront extras: a Products shop tab + a sellable (purchase) course. The
  // website above covers the Site surface and the two courses above cover the
  // Space portal; this fills the remaining shop tabs so every sandbox demo team
  // has items in all shop sections. ──
  const storefront = {
    teamId,
    uid,
    teamName,
    teamSlug,
    accentColor,
    description,
    primaryActivity: activities[0]?.name ?? 'Training',
    email: `${teamSlug}@linyup.com`,
    locationLabel: locations[0],
    currency: 'CHF',
    installedDaysAgo: 200,
  }
  await seedStoreProducts(storefront)
  await seedStorePromoCode(storefront)
  await seedStoreCourses(storefront, { includeFree: false })

  // ── the money ledger (member_subscriptions + member_payments) ──────────────
  // After contacts, whose subscription assignment it reads back. See
  // scripts/lib/fixtures/money.ts for why seeded ledger rows exist at all.
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

  // Finance: sandbox + lead only (decision 2). Replays the ledger rows above
  // into the journal through the SAME builders the Connect webhook uses.

  // ── the smaller cross-surface gaps (Phase 2 Lane 6) ────────────────────────
  // Each of these was a shipped feature with zero data behind it on every
  // surface. See scripts/lib/fixtures/engagement.ts.
  await seedContactNotes(teamId, uid)
  await seedDynamicContactGroup(teamId, uid)
  await seedEventProgram(teamId, uid)
  await seedSessionWaitlist({ teamId })
  await seedCoursePurchase(teamId)

  // ── one-off sales, then the journal ────────────────────────────────────────
  // ORDER MATTERS. Sales read back the bookings and course entitlements the
  // fixtures above just wrote, and seedTeamFinance replays every member_payments
  // row into the journal — so it has to be last, or the rails it cannot see are
  // simply missing from finance.
  await seedTeamSales({ teamId })
  await seedTeamFinance({ teamId, uid })
  // The asset register is its own Coach+ plugin — seeded beside finance, not by it.
  await seedTeamAssetRegister({ teamId, uid })

  // ── documents plugin: 3 published documents (terms, privacy, house rules) ──
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
<p>All members are expected to maintain respectful conduct during classes. The Studio reserves the right to revoke access for repeated violations.</p>
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
<li>Wear clean training attire — no street clothes on the training floor</li>
<li>Use flip-flops off the mats to keep the training area clean</li>
</ul>
<h3>Training etiquette</h3>
<ul>
<li>Arrive on time — late arrivals may not be admitted to class</li>
<li>Respect your training partners and the coach's instructions</li>
<li>Report any injuries to the coach immediately</li>
</ul>
<h3>Facility</h3>
<ul>
<li>No outdoor shoes on the training floor</li>
<li>No food or drink (except water) in the training area</li>
<li>Personal belongings must be stored in the lockers provided</li>
</ul>`,
      order: 2,
    },
  ]

  // Documents + the studio's liability WAIVER, each with its frozen v1 snapshot
  // and public mirror, through the ONE shared writer. A published document with
  // no versions/v0001 is the exact state backfill-document-versions.ts exists to
  // clear, and a tenant with no waiver policy silently behaves as if the booking
  // gate were switched off.
  await seedTeamWaiver({
    teamId,
    uid,
    teamName,
    teamSlug,
    otherDocuments: docSeeds,
    createdDaysAgo: 180,
  })
}

// ── team weekly reports — a year of history so the dashboard trend charts
// (Weekly trends, Trial funnel, Correlation, Engagement matrix, Bookings) show a
// believable upward acquisition curve with weekly noise. Doc id = ISO week label
// (matches the dashboard's dateToIsoWeek / buildWeekKeys). Shape mirrors the
// generateWeeklyReports Cloud Function output.

function scaleMap(map: Record<string, number>, factor: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(map)) out[k] = Math.max(0, Math.round(v * factor))
  return out
}

async function seedWeeklyReports(teamId: string) {
  // Current-snapshot aggregates from the shared contact pool.
  // Keyed by acquisition_stage (trial_booked/trial_attended/joined) to match the
  // live generateWeeklyReports function, which writes contacts_count_by_stage.
  const byStage: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byAffiliationType: Record<string, number> = {}
  const bySub: Record<string, number> = {}
  let withAffiliation = 0
  let withSubscription = 0
  for (const c of CONTACT_POOL) {
    const stage = stageForPoolEntry(c.type, c.totalSessions)
    byStage[stage] = (byStage[stage] ?? 0) + 1
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
    // Affiliation: standalone studios issue a team-local 'club' to every
    // non-external, non-guest contact (mirrors the contact seeding above).
    // by-type counts every holder; the scalar only counts active statuses.
    if (c.type !== 'external' && c.status !== 'guest') {
      byAffiliationType.club = (byAffiliationType.club ?? 0) + 1
      if (statusCountsAsActive(c.status)) withAffiliation++
    }
    if (c.sub) {
      bySub[`${teamId}-sub-${c.sub}`] = (bySub[`${teamId}-sub-${c.sub}`] ?? 0) + 1
      withSubscription++
    }
  }
  const curActive = CONTACT_POOL.length

  const WEEKS = 52 // a full year of history → fills the dashboard's 4/8/13/26/52-week views
  for (let w = WEEKS - 1; w >= 0; w--) {
    const monday = mondayOfWeeksAgo(w)
    const label = isoWeekLabel(monday)
    const seed = `${teamId}-wr-${w}`
    const progress = (WEEKS - 1 - w) / (WEEKS - 1) // 0 = oldest, 1 = current week
    const ramp = 0.62 + 0.38 * progress
    const factor = Math.min(1.05, Math.max(0.5, ramp + (seededRand(seed + 'n') - 0.5) * 0.08))

    const appointments = 1 + Math.floor(seededRand(seed + 'co') * 2) // 1–2
    const group = 5 + Math.floor(seededRand(seed + 'gp') * 2) // 5–6
    const bookings = 1 + Math.round(progress * 4) + Math.floor(seededRand(seed + 'bk') * 2) // grows 1→6
    const bkAppointments = Math.min(bookings, Math.floor(seededRand(seed + 'bc') * 2))

    await db
      .collection('teams')
      .doc(teamId)
      .collection('team_weekly_reports')
      .doc(label)
      .set({
        iso_week: label,
        generated_at: ts(new Date(monday.getTime() + 6 * 86_400_000)),
        active_contacts_count: Math.max(0, Math.round(curActive * factor)),
        contacts_count_by_stage: scaleMap(byStage, factor),
        contacts_count_by_membership_status: scaleMap(byStatus, factor),
        contacts_with_active_affiliation: Math.round(withAffiliation * factor),
        contacts_count_by_affiliation_type: scaleMap(byAffiliationType, factor),
        contacts_with_active_subscription: Math.round(withSubscription * factor),
        contacts_count_by_subscription_type: scaleMap(bySub, factor),
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
}

// ── auth helpers ──────────────────────────────────────────────────────────────

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

// Provision Identity Platform + enable email/password sign-in on a fresh real
// project (the Auth emulator already has it enabled). Uses the same ADC
// credential as the Admin SDK.
async function enableEmailPasswordSignIn() {
  const credential = admin.app().options.credential!
  const token = await (
    credential as { getAccessToken(): Promise<{ access_token: string }> }
  ).getAccessToken()
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'X-Goog-User-Project': PROJECT_ID,
  }

  // 1. Initialize the Identity Platform config on the project. On a fresh project
  //    the /config resource doesn't exist yet, so the PATCH below 404s with
  //    CONFIGURATION_NOT_FOUND until this runs. Idempotent — re-running returns an
  //    ALREADY_INITIALIZED-style error, which we tolerate.
  const initRes = await fetch(
    `https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/identityPlatform:initializeAuth`,
    { method: 'POST', headers, body: '{}' }
  )
  if (!initRes.ok) {
    const body = await initRes.text()
    if (initRes.status !== 409 && !/ALREADY/i.test(body)) {
      throw new Error(`Failed to initialize Identity Platform: ${initRes.status} ${body}`)
    }
  } else {
    console.log('   ✓ Identity Platform initialized')
  }

  // 2. Enable email/password sign-in.
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/config` +
      `?updateMask=signIn.email.enabled,signIn.email.passwordRequired`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ signIn: { email: { enabled: true, passwordRequired: true } } }),
    }
  )
  if (!res.ok) {
    throw new Error(`Failed to enable email/password sign-in: ${res.status} ${await res.text()}`)
  }
  console.log('   ✓ Email/password sign-in enabled')
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🌱 Seeding demo playground → ${PROJECT_ID}${USE_EMULATOR ? ' (emulator)' : ''}\n`)

  if (!USE_EMULATOR) await enableEmailPasswordSignIn()

  // Which teams get a Stripe TEST connected account — one account backs exactly
  // ONE team (see scripts/lib/connect.ts), so the six /try tenants are served in
  // profile order until the configured accounts run out.
  planSeedConnectAccounts(SECTOR_PROFILES.map((p) => `sandbox-${p.key}`))

  for (const profile of SECTOR_PROFILES) {
    await seedDemoTeam(profile)
  }

  // The member app's test login — the same review studio the production
  // console provisions, with its fixed code (scripts/lib/mobile.ts). The nightly
  // reseed refreshes its window, so on the sandbox it never lapses.
  const memberApp = await seedReviewTenant({ db, seededBy: 'seed-sandbox' })
  await seedMobileSettings({ db, seededBy: 'seed-sandbox' })

  console.log('\n✅ Demo playground seeded successfully!\n')
  console.log('   ┌──────────┬──────────────────────────┬────────────────────────┬────────────┐')
  console.log('   │ Sector   │ Team                     │ Login                  │ Password   │')
  console.log('   ├──────────┼──────────────────────────┼────────────────────────┼────────────┤')
  for (const p of SECTOR_PROFILES) {
    console.log(
      `   │ ${p.sector.padEnd(8)} │ ${p.teamName.padEnd(24)} │ ${`${p.key}@linyup.com`.padEnd(22)} │ ${DEMO_PASSWORD.padEnd(10)} │`
    )
  }
  console.log('   └──────────┴──────────────────────────┴────────────────────────┴────────────┘\n')
  console.log('   All accounts: plan=studio, status=active (full feature set, no trial wall).')
  console.log('   Portals:')
  for (const p of SECTOR_PROFILES) {
    console.log(`   ${p.teamName.padEnd(26)} → /public/${p.teamSlug}`)
  }
  reportSeedConnectAccounts()
  printMemberAppLogin(memberApp)
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seed failed:', err)
    process.exit(1)
  })
