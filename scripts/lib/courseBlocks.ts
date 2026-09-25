/**
 * Shared course-seeding helpers — a term course, mid-run.
 *
 * A COURSE (`course_blocks/{id}`, displayed as *Course*) is a bounded set of
 * lessons sold once: "8 Tuesdays, 9 places, one price". It is not the
 * online-courses plugin, which is on-demand video and is displayed as *Online
 * course*. See `docs/courses.md`.
 *
 * ── WHY IT IS SEEDED MID-TERM ───────────────────────────────────────────────
 *
 * A course that has not started shows an empty roster, no attendance and
 * nothing on the day sheet, which is the least informative state it has. One
 * that has finished cannot be enrolled on. So the seed puts it a third of the
 * way through: a few lessons behind it, most ahead, places part-taken. That is
 * the state a studio actually looks at, and the one where every surface the
 * course touches has something in it.
 *
 * ── WHAT IT WRITES, AND WHY EACH PIECE ──────────────────────────────────────
 *
 * The course OWNS a `session_series` whose sessions are its lessons, so this
 * writes the series too. The series is `status: 'fixed'` (materialized in full,
 * nothing to roll) and carries `course_block_id`, which is what
 * `buildSeriesSessionDoc` stamps onto every lesson and what the public mirror
 * reads to publish a lesson that is visible but not separately bookable.
 *
 * The enrollments are the truth and the per-lesson bookings are a projection of
 * them, exactly as `syncCourseBlockRoster` treats them: one booking per live
 * enrollment per FUTURE lesson, and none on the past ones, because a converger
 * never puts somebody on the register of a lesson that already happened.
 *
 * ── MONEY: TOGETHER OR NOT AT ALL ───────────────────────────────────────────
 *
 * One enrollment is PAID and is seeded with its `member_payments` row in the
 * same call; the rest are studio-granted (`payment_status: 'not_required'`),
 * which is what `enrolCourseBlockContact` writes when a studio puts somebody on
 * a course by hand. The rule is the one `scripts/lib/appointments.ts` states:
 * a paid thing and its ledger row are seeded together or not at all. What must
 * never appear is an enrollment stamped as paid with no money behind it.
 *
 * Path/type constants mirror @linyup/shared (the seed scripts compile under
 * tsconfig.scripts.json, which does not resolve the workspace import — same
 * convention as scripts/lib/appointments.ts and scripts/lib/storefront.ts).
 */
import * as admin from 'firebase-admin'
import { seedMemberPayment } from './fixtures/money'
// Pure and import-free so the functions test runner can reach it; see that
// module's header for why it is not just a function in this file.
import { courseLessonDates } from './courseSchedule'

export { courseLessonDates }

const COURSE_BLOCKS_COLLECTION = 'course_blocks'
const COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION = 'enrolments'
const SESSION_SERIES_COLLECTION = 'session_series'
const SESSIONS_COLLECTION = 'sessions'

const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)

/**
 * The payer's deterministic PaymentIntent id.
 *
 * `_course_block`, NOT `_course`: the online-courses fixture
 * (`seedCoursePurchase`) already writes `pi_seed_{contact}_course` for the same
 * contact, and the two collided on one document. The row that survived was
 * whichever seeder ran last, so a course sale silently became an online-course
 * sale, with the enrollment still pointing at it. That is what `idSuffix` is for.
 */
const COURSE_BLOCK_PI = (contactId: string) => `pi_seed_${contactId}_course_block`

export interface SeedCourseContact {
  id: string
  firstname: string
  lastname: string
  email: string
}

export interface SeedCourseBlockSpec {
  teamId: string
  /** Deterministic, so a re-run overwrites in place rather than accumulating. */
  blockId: string
  name: string
  description?: string
  /** The class the lessons are sessions of. Its picture, meeting point and
   *  terms are then said once rather than restated on the course. */
  activityId: string
  activityName: string
  location?: string
  providerId?: string | null
  providerName?: string | null
  places: number
  /** Major units. Null or absent means free for everyone, which is a real offer
   *  (a taster week) rather than a gap. */
  priceAmount?: number | null
  /** Weekday, JS `getDay()`: 0=Sun … 6=Sat. */
  dayOfWeek: number
  /** 'HH:MM', local. */
  time: string
  durationMinutes: number
  /** How many lessons the course runs in total. */
  lessons: number
  /** How many of them are already behind us. The rest are ahead. */
  lessonsElapsed: number
  /** Who is on it. The FIRST one is the payer when `priceAmount` is set. */
  enrolled: SeedCourseContact[]
  /** Owner uid, for `createdBy` and as the series' nominal teacher. */
  uid: string
}

/**
 * One term course, its series, its lessons, its roster and (for the payer) its
 * money. Returns the ids so a caller can reference them.
 */
export async function seedCourseBlock(spec: SeedCourseBlockSpec): Promise<{
  blockId: string
  seriesId: string
  sessionIds: string[]
}> {
  const db = admin.firestore()
  const { teamId, blockId } = spec
  const seriesId = `${blockId}-series`

  const dates = courseLessonDates(spec)
  const meetings = dates.map((start) => ({
    start: tsOf(start),
    end: tsOf(new Date(start.getTime() + spec.durationMinutes * 60_000)),
  }))
  const nowMs = Date.now()

  // ── the series the course owns ────────────────────────────────────────────
  // `status: 'fixed'` means MATERIALIZED IN FULL, NOTHING TO ROLL: the daily
  // roller queries `status == 'active'`, so it never reads this one and cannot
  // generate a fourteenth lesson onto a course sold as thirteen.
  await db
    .collection(SESSION_SERIES_COLLECTION)
    .doc(seriesId)
    .set({
      teamId,
      teacher: spec.uid,
      createdBy: spec.uid,
      course_block_id: blockId,
      status: 'fixed',
      template: {
        activityId: spec.activityId,
        activityName: spec.activityName,
        activityType: 'class',
        location: spec.location ?? null,
        placeId: null,
        roomId: null,
        tags: [],
        notes: '',
        headline: null,
        headlinePublic: false,
        duration: spec.durationMinutes,
        // A course lesson is sold as part of the course, never individually.
        allowBooking: false,
        bookingMandatory: false,
        providerName: spec.providerName ?? null,
        providerId: spec.providerId ?? null,
        max_participants: spec.places,
      },
      recurrence: null,
      lastGeneratedUntil: meetings[meetings.length - 1].end,
      totalOccurrences: meetings.length,
      createdAt: tsOf(dates[0]),
      updatedAt: tsOf(dates[0]),
    })

  // ── the course ────────────────────────────────────────────────────────────
  const live = spec.enrolled
  const block = {
    teamId,
    name: spec.name,
    description: spec.description ?? null,
    activityId: spec.activityId,
    activityName: spec.activityName,
    seriesId,
    meetings,
    pattern: null,
    placeId: null,
    roomId: null,
    location: spec.location ?? null,
    providerId: spec.providerId ?? null,
    providerName: spec.providerName ?? null,
    places: spec.places,
    places_taken: live.length,
    priceAmount: spec.priceAmount ?? null,
    includedSubscriptionTypeIds: [],
    benefit: null,
    audience: 'anyone' as const,
    close_days_before: null,
    booking_closes_at: null,
    status: 'published' as const,
    roster_version: 1,
    fanout_conflicts: [],
    created_at: tsOf(dates[0]),
    updated_at: tsOf(dates[0]),
    createdBy: spec.uid,
  }
  await db.collection(COURSE_BLOCKS_COLLECTION).doc(blockId).set(block)

  // The public mirror, field for field as `buildCourseBlockPublicProfile`
  // writes it: AGGREGATES ONLY, and a lesson COUNT rather than the meeting
  // list. Seeded rather than left to the trigger so a snapshot taken without
  // the functions emulator still has a public course.
  await db
    .collection(COURSE_BLOCKS_COLLECTION)
    .doc(blockId)
    .collection('public_profile')
    .doc(blockId)
    .set({
      type: 'course_block',
      teamId,
      name: block.name,
      description: block.description,
      activityId: block.activityId,
      activityName: block.activityName,
      first_meeting: meetings[0].start,
      last_meeting: meetings[meetings.length - 1].end,
      meeting_count: meetings.length,
      placeId: null,
      location: block.location,
      providerId: block.providerId,
      providerName: block.providerName,
      priceAmount: block.priceAmount,
      includedSubscriptionTypeIds: [],
      benefit: null,
      audience: 'anyone',
      places: block.places,
      places_taken: block.places_taken,
      booking_closes_at: null,
    })

  // ── the lessons ───────────────────────────────────────────────────────────
  const sessionIds: string[] = []
  for (let i = 0; i < dates.length; i++) {
    const start = dates[i]
    const end = new Date(start.getTime() + spec.durationMinutes * 60_000)
    const id = `${blockId}-lesson-${i.toString().padStart(2, '0')}`
    sessionIds.push(id)
    const isPast = start.getTime() < nowMs
    // Bookings exist for FUTURE lessons only, which is what the converger does:
    // it never puts somebody on the register of a lesson that already happened.
    const bookingsCount = isPast ? 0 : live.length

    await db
      .collection(SESSIONS_COLLECTION)
      .doc(id)
      .set({
        teamId,
        seriesId,
        // What makes a lesson publicly VISIBLE without being separately
        // BOOKABLE: `syncSessionPublicProfile` publishes on
        // `allowBooking === true || course_block_id != null`.
        course_block_id: blockId,
        activityId: spec.activityId,
        activityName: spec.activityName,
        activityType: 'class',
        start: tsOf(start),
        end: tsOf(end),
        duration_minutes: spec.durationMinutes,
        location: spec.location ?? null,
        providerId: spec.providerId ?? null,
        providerName: spec.providerName ?? null,
        allowBooking: false,
        autoConfirm: true,
        max_participants: spec.places,
        bookings_count: bookingsCount,
        participants_count: isPast ? live.length : 0,
        created_at: tsOf(dates[0]),
        createdBy: spec.uid,
      })

    await db
      .collection(SESSIONS_COLLECTION)
      .doc(id)
      .collection('public_profile')
      .doc(id)
      .set({
        type: 'session',
        teamId,
        course_block_id: blockId,
        activityId: spec.activityId,
        activityName: spec.activityName,
        activityColor: null,
        activitySlug: null,
        activityImage: null,
        start: tsOf(start),
        end: tsOf(end),
        location: spec.location ?? null,
        providerName: spec.providerName ?? null,
        locationAddress: null,
        locationMapsUrl: null,
        capacity: spec.places,
        participants_count: isPast ? live.length : 0,
        allowBooking: false,
        slug: null,
      })

    if (bookingsCount === 0) continue
    for (const person of live) {
      await db
        .collection(SESSIONS_COLLECTION)
        .doc(id)
        .collection('bookings')
        .doc(person.id)
        .set({
          teamId,
          contact: person.id,
          session: id,
          firstname: person.firstname,
          lastname: person.lastname,
          email: person.email,
          // CONFIRMED whatever the activity's autoConfirm says: they bought the
          // course, and a place on it is not a request to attend.
          status: 'confirmed',
          payment_status: 'not_required',
          course_block_id: blockId,
          booking_token: `tok-${id}-${person.id}`,
          joinedAt: tsOf(dates[0]),
        })
    }
  }

  // ── the roster ────────────────────────────────────────────────────────────
  const payerId = spec.priceAmount ? live[0]?.id : null
  for (const person of live) {
    const paid = person.id === payerId
    await db
      .collection(COURSE_BLOCKS_COLLECTION)
      .doc(blockId)
      .collection(COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)
      .doc(person.id)
      .set({
        contactId: person.id,
        teamId,
        status: 'enrolled',
        firstname: person.firstname,
        lastname: person.lastname,
        email: person.email,
        // Everyone but the payer was put on by the studio, which moves no money
        // and is exactly what `enrolCourseBlockContact` writes.
        payment_status: paid ? 'paid' : 'not_required',
        ...(paid ? { payment_intent_id: COURSE_BLOCK_PI(person.id) } : {}),
        expires_at: null,
        withdrawn_at: null,
        enrolled_at: tsOf(dates[0]),
        roster_version_applied: 1,
      })
  }

  // ── the money, with the enrollment that claims it ──────────────────────────
  if (payerId && spec.priceAmount) {
    const payer = live[0]
    await seedMemberPayment(teamId, {
      contactId: payer.id,
      purpose: 'course_block',
      amount: spec.priceAmount,
      daysAgo: Math.max(1, (spec.lessonsElapsed - 1) * 7 + 2),
      idSuffix: 'course_block',
      paymentIntentId: COURSE_BLOCK_PI(payer.id),
      courseName: spec.name,
      // The TOP-LEVEL kind is what puts the sale in the accounts:
      // `mapCategory` reads it and nothing else, and a row carrying only a line
      // item books to `other`.
      kind: 'course_block',
      lineItem: { kind: 'course_block', courseBlockId: blockId, label: spec.name },
      comment: spec.name,
    })
  }

  return { blockId, seriesId, sessionIds }
}
