/**
 * THE PRODUCTION DEMO TENANT — the studio a store reviewer signs into.
 *
 * ── WHY THIS IS A CALLABLE AND NOT A SCRIPT ──────────────────────────────────
 *
 * Every other seeder in this repo is a local script, and each one hard-codes a
 * non-prod project and refuses to run when the ambient project disagrees. This
 * one deliberately does NOT join that family (Franco, 2026-08-21), for two
 * reasons that are about people rather than code:
 *
 *   1. A rail that shares no muscle memory with `pnpm lead:seed`. The failure
 *      being designed out is real and recent: a lead seed run with `--reset`,
 *      expecting the emulator, hit the CLOUD sandbox — purely because the
 *      default target and the operator's mental mode disagreed. Production data
 *      should not be one forgotten flag away from a command you type weekly.
 *   2. No dependency on one laptop's credentials.
 *
 * So the console is the TRIGGER and this is the EXECUTOR. The code ships
 * through the reviewed `deploy-prod.yml` (verify → `production` environment
 * approval); the button is just an authenticated operator action. It also gets
 * a real function timeout instead of a Next server action's request budget.
 *
 * ── WHY THE CONTENT IS DEFINED HERE AND NOT REUSED ───────────────────────────
 *
 * `scripts/lib/fixtures/*` is tempting and wrong: the dependency runs
 * scripts→functions (`fixtures/finance.ts` imports from `packages/functions/src`),
 * so importing them here would invert it. The demo set is also deliberately
 * SMALL — the reviewer is a contact, not a manager. They need a schedule with
 * something on it, a booking of their own, and a membership. Not a studio.
 *
 * ── THE SAFETY PROPERTIES, AND WHERE THEY COME FROM ──────────────────────────
 *
 * - **Sends nothing.** `messaging_policies/{teamId}` is written `silent` BEFORE
 *   any content lands, because `MESSAGING_DEFAULT_MODE` is `live` in prod and an
 *   absent policy means real delivery. Belt and braces: every seeded contact is
 *   `@example.com`, which `isSyntheticEmail()` drops unconditionally in every
 *   environment.
 * - **Cannot take money.** No Stripe Connect account is ever attached, so
 *   `TeamPublicProfile.payments_enabled` fails closed and every priced door —
 *   shop, drop-in, priced trial, paid appointment — is absent. A reviewer
 *   cannot trigger a real charge on a live-mode platform.
 * - **Does not pollute the numbers.** `flags.internal` excludes it from
 *   platform metrics and exempts it from the trial sweep, so it cannot silently
 *   lapse to Free in the middle of a review.
 *
 * WRITE ORDER MATTERS: the team doc goes first so `onTeamCreated` and
 * `syncTeamPublicProfile` fire — nothing else builds `public_profile`, and every
 * public surface reads it.
 */
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { format } from 'date-fns'
import { updateTeamLeaderboard } from '../utils/leaderboard'
import { IMPORTED_SLOT_GRANT_ID, importedSlotGrantDoc, planGrantsCollection } from '../contacts/planGrants'
import { classAccessRuleFor, detectPerformanceProfile } from '@linyup/shared'
import {
  TEAMS_COLLECTION,
  CONTACTS_COLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION,
  ACTIVITIES_COLLECTION,
  SESSIONS_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  DEFAULT_PAYMENT_MODES,
} from '@linyup/shared'

/** Fixed ids so every run converges on the same documents — this is what makes
 *  `provision` idempotent and `reset` meaningful. */
export const DEMO_TEAM_ID = 'linyup-demo'
export const DEMO_OWNER_UID = 'linyup-demo-owner'
const DEMO_SLUG = 'linyup-demo'

/** The contact a store reviewer signs in as. Its email is what
 *  `app_settings/review_access` allowlists. `@example.com` so the synthetic
 *  guard drops any mail addressed to it even if a policy is ever misread. */
export const DEMO_REVIEW_CONTACT_ID = 'linyup-demo-reviewer'
export const DEMO_REVIEW_EMAIL = 'app.review@example.com'

const DAY_MS = 24 * 60 * 60 * 1000

interface DemoActivity {
  id: string
  name: string
  slug: string
  color: string
  description: string
  /** Hour of the day, local wall clock, for the generated sessions. */
  hour: number
  /** Weekdays it runs on, `Date#getDay()` convention. */
  days: number[]
  /** Free-text display chips, so the review tenant exercises the public
   *  booking card's tag row rather than leaving it empty. */
  tags?: string[]
}

const ACTIVITIES: DemoActivity[] = [
  {
    id: `${DEMO_TEAM_ID}-act-morning-flow`,
    name: 'Morning Flow',
    slug: 'morning-flow',
    color: '#0EA5E9',
    description: 'A gentle hour to start the day. All levels welcome.',
    hour: 8,
    days: [1, 3, 5],
    tags: ['Beginner friendly', 'Mornings'],
  },
  {
    id: `${DEMO_TEAM_ID}-act-evening-strength`,
    name: 'Evening Strength',
    slug: 'evening-strength',
    color: '#7C3AED',
    description: 'Technique and conditioning. Bring water.',
    hour: 18,
    days: [2, 4],
    tags: ['Strength'],
  },
]

/** Six people so a roster looks like a roster. The reviewer is the first. */
const CONTACTS: Array<{ id: string; firstname: string; lastname: string }> = [
  { id: DEMO_REVIEW_CONTACT_ID, firstname: 'Alex', lastname: 'Reviewer' },
  { id: `${DEMO_TEAM_ID}-c2`, firstname: 'Mira', lastname: 'Okafor' },
  { id: `${DEMO_TEAM_ID}-c3`, firstname: 'Jonas', lastname: 'Keller' },
  { id: `${DEMO_TEAM_ID}-c4`, firstname: 'Sofia', lastname: 'Rossi' },
  { id: `${DEMO_TEAM_ID}-c5`, firstname: 'Tomás', lastname: 'Ferreira' },
  { id: `${DEMO_TEAM_ID}-c6`, firstname: 'Amara', lastname: 'Diallo' },
]

const SUBSCRIPTION_TYPE_ID = `${DEMO_TEAM_ID}-sub-unlimited`

// ── The closed-test testers ─────────────────────────────────────────────────
// Play's closed test needs a dozen people signed in for fourteen days. They
// used to have to SHARE the reviewer's login, which meant any curious tester
// could rename or delete the one account the store reviewer depends on. So each
// gets their own contact, and `app_settings/review_access` lists them all — the
// demo tenant never sends email (its messaging policy is `silent`), so a fixed
// code is the only way any of them can sign in at all.
//
// They get a history and a score but deliberately NO upcoming bookings: booking
// a class is then something a tester actually does, which is the engagement
// Google's check looks for, and it keeps this provisioner clear of session
// capacity and the one-seat-writer rule.
const TESTER_FIRSTNAMES = [
  'Anna', 'Ben', 'Clara', 'David', 'Elena', 'Felix', 'Greta', 'Hugo', 'Ida', 'Jan',
  'Kira', 'Luca', 'Maya', 'Nino', 'Olga', 'Pavel', 'Rosa', 'Samir', 'Tessa', 'Uwe',
]

export const DEMO_TESTERS = TESTER_FIRSTNAMES.map((firstname, i) => {
  const n = String(i + 1).padStart(2, '0')
  return {
    id: `${DEMO_TEAM_ID}-tester-${n}`,
    firstname,
    lastname: 'Tester',
    email: `tester${n}@example.com`,
    // Spread so the leaderboard reads like a group of people rather than a
    // generated sequence, and so the reviewer is never bottom.
    score: 12 + ((i * 7) % 44),
    streak: 1 + (i % 5),
  }
})

export interface ProvisionResult {
  teamId: string
  slug: string
  reviewContactId: string
  reviewEmail: string
  counts: {
    activities: number
    sessions: number
    contacts: number
    testers: number
    bookings: number
    attended: number
  }
}

/**
 * Create or converge the demo tenant. Safe to run repeatedly: every document has
 * a deterministic id and is written with `set(..., { merge: true })`, so a second
 * run repairs rather than duplicates.
 *
 * Sessions are the exception — they are regenerated from today, so a tenant left
 * alone for a month still shows a live schedule. Stale ones are removed first.
 */
export async function provisionDemoTenant(nowMs: number = Date.now()): Promise<ProvisionResult> {
  const db = admin.firestore()

  // ── 1. Outbound messaging OFF, before anything can trigger a send ─────────
  // Written first on purpose. An absent policy resolves to MESSAGING_DEFAULT_MODE
  // which is `live` in production, and the very next writes create contacts and
  // bookings that triggers can react to.
  await db.collection('messaging_policies').doc(DEMO_TEAM_ID).set(
    {
      mode: 'silent',
      note: 'Linyup demo tenant (app-store review). Never sends.',
      updated_at: FieldValue.serverTimestamp(),
      updated_by: 'provisionDemoTenant',
    },
    { merge: true }
  )

  // ── 2. The team ───────────────────────────────────────────────────────────
  // First real write, so `onTeamCreated` (payment modes + the trial-cleanup
  // rule) and `syncTeamPublicProfile` (public_profile, which every public
  // surface reads) both fire.
  await db
    .collection(TEAMS_COLLECTION)
    .doc(DEMO_TEAM_ID)
    .set(
      {
        name: 'Linyup Demo Studio',
        slug: DEMO_SLUG,
        description: 'A sample studio used to demonstrate the Linyup app.',
        sport_type: 'fitness',
        default_currency: 'CHF',
        payment_modes: [...DEFAULT_PAYMENT_MODES],
        settings: {},
        links: [],
        // Studio tier so the reviewer sees the full feature set, `active` with
        // no Stripe subscription — `flags.internal` is the record of why there
        // is none, and exempts it from the trial sweep so it cannot lapse to
        // Free mid-review.
        plan: 'studio',
        plan_status: 'active',
        trial_ends_at: null,
        flags: { internal: true },
        // Deliberately absent: `payments`. No Connect account means
        // `payments_enabled` fails closed and every priced door stays shut.
        // No public API or MCP either, for the reason the demo exists: its owner
        // login is published (docs/test-accounts.md), so anyone who reads the docs
        // could mint a key and read — and bill — our Firestore indefinitely. Same
        // block the /try playground carries (docs/public-api.md -> "Blocked
        // tenants"); creation is refused, so no credential can exist.
        api_access_blocked: true,
        created: FieldValue.serverTimestamp(),
        createdBy: DEMO_OWNER_UID,
        primaryContact: DEMO_OWNER_UID,
        archived_at: null,
      },
      { merge: true }
    )

  await db
    .collection(TEAMS_COLLECTION)
    .doc(DEMO_TEAM_ID)
    .collection('team_members')
    .doc(DEMO_OWNER_UID)
    .set(
      { userId: DEMO_OWNER_UID, teamId: DEMO_TEAM_ID, role: 'owner', joined: FieldValue.serverTimestamp(), addedBy: DEMO_OWNER_UID },
      { merge: true }
    )

  // ── 3. What the studio offers ─────────────────────────────────────────────
  await db
    .collection(TEAMS_COLLECTION)
    .doc(DEMO_TEAM_ID)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .doc(SUBSCRIPTION_TYPE_ID)
    .set(
      {
        name: 'Unlimited Monthly',
        description: 'Come to everything.',
        source: 'internal',
        recurrence: 'monthly',
        price: 89,
        currency: 'CHF',
        active: true,
      },
      { merge: true }
    )

  for (const a of ACTIVITIES) {
    await db.collection(ACTIVITIES_COLLECTION).doc(a.id).set(
      {
        teamId: DEMO_TEAM_ID,
        name: a.name,
        slug: a.slug,
        color: a.color,
        description: a.description,
        type: 'class',
        ...(a.tags?.length ? { tags: a.tags } : {}),
        // Openly bookable: with no Connect account there is no price to charge,
        // so this is the only door that can work — and it is the one a reviewer
        // should be able to walk through. No plans and no drop-in price is what
        // makes a class free (docs/class-access-derived.md).
        accessRule: classAccessRuleFor({
          signupRequired: false,
          includedPlanIds: [],
        }),
        dropIn: { mode: 'off', enabled: false },
        max_participants: 12,
        archived_at: null,
        order: ACTIVITIES.indexOf(a),
      },
      { merge: true }
    )
  }

  // ── 4. The people ─────────────────────────────────────────────────────────
  for (const c of CONTACTS) {
    await db.collection(CONTACTS_COLLECTION).doc(c.id).set(
      {
        teamId: DEMO_TEAM_ID,
        firstname: c.firstname,
        lastname: c.lastname,
        // Synthetic by construction — `isSyntheticEmail()` drops these in every
        // environment, so the tenant cannot email anybody even if its policy is
        // deleted by hand.
        email: c.id === DEMO_REVIEW_CONTACT_ID ? DEMO_REVIEW_EMAIL : `${c.firstname.toLowerCase()}.${c.lastname.toLowerCase()}.${DEMO_TEAM_ID}@example.com`,
        phone: null,
        acquisition_stage: 'member',
        entry: 'manual',
        provisional: false,
        archived_at: null,
        deleted_at: null,
        created_at: FieldValue.serverTimestamp(),
        subscription_type_id: SUBSCRIPTION_TYPE_ID,
        // See DEMO_TESTERS: a reseed is the repair for a curious 'Delete
        // account' tap, including on the reviewer's own login.
        deletion_requested_at: null,
        deletion_scheduled_for: null,
      },
      { merge: true }
    )
    await writeDemoPlanGrant(db, c.id)
  }

  for (const t of DEMO_TESTERS) {
    await db.collection(CONTACTS_COLLECTION).doc(t.id).set(
      {
        teamId: DEMO_TEAM_ID,
        firstname: t.firstname,
        lastname: t.lastname,
        email: t.email,
        phone: null,
        acquisition_stage: 'member',
        entry: 'manual',
        provisional: false,
        archived_at: null,
        deleted_at: null,
        subscription_type_id: SUBSCRIPTION_TYPE_ID,
        current_month_score: t.score,
        current_streak: t.streak,
        max_streak: t.streak,
        // A tester who tapped 'Delete account' out of curiosity must not stay
        // scheduled for deletion across a reseed — this provisioner is the
        // repair, so it clears the countdown rather than merging around it.
        deletion_requested_at: null,
        deletion_scheduled_for: null,
      },
      { merge: true }
    )
    await writeDemoPlanGrant(db, t.id)
  }

  // ── 5. A live schedule, regenerated every run ─────────────────────────────
  // Sessions are the one thing that goes stale on the wall clock. Old demo
  // sessions are cleared first so a tenant provisioned months ago still opens on
  // a schedule with something in it.
  const existing = await db
    .collection(SESSIONS_COLLECTION)
    .where('teamId', '==', DEMO_TEAM_ID)
    .get()
  for (const d of existing.docs) await db.recursiveDelete(d.ref)

  let sessionCount = 0
  let bookingCount = 0
  let attendedCount = 0
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)

  for (let offset = -7; offset <= 21; offset++) {
    const day = new Date(start.getTime() + offset * DAY_MS)
    for (const a of ACTIVITIES) {
      if (!a.days.includes(day.getDay())) continue
      const startsAt = new Date(day)
      startsAt.setHours(a.hour, 0, 0, 0)
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000)
      const sessionId = `${DEMO_TEAM_ID}-s-${a.slug}-${startsAt.toISOString().slice(0, 10)}`

      await db.collection(SESSIONS_COLLECTION).doc(sessionId).set({
        teamId: DEMO_TEAM_ID,
        activityId: a.id,
        activityName: a.name,
        activityColor: a.color,
        activityType: 'class',
        start: Timestamp.fromDate(startsAt),
        end: Timestamp.fromDate(endsAt),
        max_participants: 12,
        bookings_count: 0,
        participants_count: 0,
        location: 'Main studio',
        archived_at: null,
        created_at: FieldValue.serverTimestamp(),
        // REQUIRED, and the reason this tenant used to open on an empty app:
        // `syncSessionPublicProfile` publishes a class session ONLY when
        // `allowBooking === true`, and the member app reads upcoming sessions
        // from those public_profile mirrors and nowhere else. Without this the
        // sessions exist, the bookings exist, and the app shows "No upcoming
        // sessions scheduled" — which is what a store reviewer would have seen.
        allowBooking: true,
      })
      sessionCount++

      // PAST sessions get attendance, so the app opens on a history rather than
      // on empty states: the training calendar counts sessions, the streak and
      // month score have something to compute from, and the team leaderboard has
      // rows. Scoring reads the `participants` subcollection — `bookings` alone
      // leaves all of it at zero.
      if (offset < 0) {
        // Four regulars plus a rotating pair of testers: every tester picks up
        // some history without any one session exceeding its twelve seats.
        const rotate = Math.abs(offset) * 2
        const attendees = [
          ...CONTACTS.slice(0, 4),
          DEMO_TESTERS[rotate % DEMO_TESTERS.length],
          DEMO_TESTERS[(rotate + 1) % DEMO_TESTERS.length],
        ]
        for (const c of attendees) {
          await db
            .collection(SESSIONS_COLLECTION)
            .doc(sessionId)
            .collection(PARTICIPANTS_SUBCOLLECTION)
            .doc(c.id)
            .set({
              contactId: c.id,
              session: sessionId,
              firstname: c.firstname,
              lastname: c.lastname,
              fullname: `${c.lastname} ${c.firstname}`,
              joinedAt: Timestamp.fromDate(startsAt),
              checkedInAt: Timestamp.fromDate(startsAt),
              checkedInBy: 'demo-tenant',
            })
        }
        attendedCount += attendees.length
        // ABSOLUTE, like bookings_count below — written once, known not accumulated.
        await db
          .collection(SESSIONS_COLLECTION)
          .doc(sessionId)
          .set({ participants_count: attendees.length }, { merge: true })
      }

      // Give the reviewer a booking on the next few upcoming sessions, so their
      // own screens are not empty the moment they sign in.
      if (offset >= 0 && offset <= 7) {
        await db
          .collection(SESSIONS_COLLECTION)
          .doc(sessionId)
          .collection('bookings')
          .doc(DEMO_REVIEW_CONTACT_ID)
          .set({
            contact: DEMO_REVIEW_CONTACT_ID,
            teamId: DEMO_TEAM_ID,
            sessionId,
            status: 'confirmed',
            created_at: FieldValue.serverTimestamp(),
          })
        bookingCount++
        // ABSOLUTE, never an increment — the one-seat-writer rule. Each session
        // here has exactly one booking and is written once, so the count is
        // known rather than accumulated.
        await db.collection(SESSIONS_COLLECTION).doc(sessionId).set({ bookings_count: 1 }, { merge: true })
      }
    }
  }

  // ── 6. Gamification state ─────────────────────────────────────────────────
  // Derived fields written directly, the way the environment seeders already do
  // (scripts/seed-staging.ts). The scoring triggers fire on session edits and on
  // the recalculateScores callable, neither of which runs during provisioning —
  // so without this the app shows NO RANK and an empty leaderboard even though
  // the attendance above is real. The numbers are shaped so the reviewer sits
  // mid-table rather than first: a leaderboard with one name is not a leaderboard.
  const SCORES: Record<string, { score: number; streak: number }> = {
    [DEMO_REVIEW_CONTACT_ID]: { score: 48, streak: 3 },
    [`${DEMO_TEAM_ID}-c2`]: { score: 72, streak: 6 },
    [`${DEMO_TEAM_ID}-c3`]: { score: 55, streak: 4 },
    [`${DEMO_TEAM_ID}-c4`]: { score: 31, streak: 2 },
  }
  for (const [contactId, v] of Object.entries(SCORES)) {
    await db.collection(CONTACTS_COLLECTION).doc(contactId).set(
      { current_month_score: v.score, current_streak: v.streak, max_streak: v.streak },
      { merge: true }
    )
  }

  // The team leaderboard is a DENORMALISED doc (teams/{id}/leaderboard/current)
  // and the app reads only that — writing per-contact scores fills the member's
  // own cards but leaves the leaderboard empty. Rebuild it through its existing
  // writer rather than hand-assembling the document here: it reads exactly the
  // `current_month_score > 0` contacts just written.
  await updateTeamLeaderboard(DEMO_TEAM_ID, format(new Date(nowMs), 'yyyy-MM'))

  // ── 7. Performance check-ins ──────────────────────────────────────────────
  // The radar on the TRAIN tab plots the latest check-in and the history chart
  // needs more than one, so the reviewer gets three a fortnight apart. Scores
  // improve over time and are deliberately UNEVEN — five equal axes draw a
  // regular pentagon, which looks like a placeholder rather than a person.
  // `detectPerformanceProfile` derives profile_key/primary_lever/anchor exactly
  // as the app would; hardcoding them here would let this drift from the real
  // heuristic silently.
  const CHECKINS: Array<{ daysAgo: number; scores: Record<string, number> }> = [
    { daysAgo: 28, scores: { consistency: 2, effort: 4, focus: 2, recharge: 3, sense_of_progress: 2 } },
    { daysAgo: 14, scores: { consistency: 3, effort: 4, focus: 3, recharge: 3, sense_of_progress: 3 } },
    { daysAgo: 2, scores: { consistency: 4, effort: 5, focus: 3, recharge: 4, sense_of_progress: 4 } },
  ]
  for (const ci of CHECKINS) {
    const takenAt = new Date(nowMs - ci.daysAgo * DAY_MS)
    const { profile_key, primary_lever, anchor } = detectPerformanceProfile(ci.scores)
    await db
      .collection(CONTACTS_COLLECTION)
      .doc(DEMO_REVIEW_CONTACT_ID)
      .collection(CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION)
      .doc(`demo-checkin-${ci.daysAgo}`)
      .set({
        taken_at: Timestamp.fromDate(takenAt),
        filled_by: 'student',
        scores: ci.scores,
        notes: null,
        context: 'self',
        profile_key,
        primary_lever,
        anchor,
      })
  }

  return {
    teamId: DEMO_TEAM_ID,
    slug: DEMO_SLUG,
    reviewContactId: DEMO_REVIEW_CONTACT_ID,
    reviewEmail: DEMO_REVIEW_EMAIL,
    counts: {
      activities: ACTIVITIES.length,
      sessions: sessionCount,
      contacts: CONTACTS.length + DEMO_TESTERS.length,
      testers: DEMO_TESTERS.length,
      bookings: bookingCount,
      attended: attendedCount,
    },
  }
}

/**
 * The demo plan as a plan grant (docs/multi-plan-holdings.md). The contact write
 * sets the legacy slot — the bridge until the readers move to the plan list —
 * and this gives the same plan as the imported-slot row every seeder writes.
 * Written AFTER the contact, so the plan-grant trigger finds the contact and
 * builds its plan list.
 */
async function writeDemoPlanGrant(db: admin.firestore.Firestore, contactId: string): Promise<void> {
  const type = await db
    .collection(TEAMS_COLLECTION)
    .doc(DEMO_TEAM_ID)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .doc(SUBSCRIPTION_TYPE_ID)
    .get()
  const grant = importedSlotGrantDoc({
    teamId: DEMO_TEAM_ID,
    subscription_type_id: SUBSCRIPTION_TYPE_ID,
    subscription_type_name: (type.data()?.name as string | undefined) ?? null,
  })
  if (grant) await planGrantsCollection(db, contactId).doc(IMPORTED_SLOT_GRANT_ID).set(grant)
}
