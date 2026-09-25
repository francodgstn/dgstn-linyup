/**
 * Shared fixtures for the smaller cross-surface gaps the Phase 1 audit found —
 * each one a feature that exists, ships, and had zero data behind it on every
 * one of the five authoring surfaces (docs/seed-truth-2026-08.md).
 *
 * They live together because none is big enough for its own file and all four
 * share the same shape: read back what the seeder already wrote, and add the one
 * row that makes a shipped screen render.
 *
 * Path constants mirror @linyup/shared (same convention as lib/storefront.ts).
 */

import admin from 'firebase-admin'

const TEAMS_COLLECTION = 'teams'
const CONTACTS_COLLECTION = 'contacts'
const CONTACT_NOTES_SUBCOLLECTION = 'contact_notes'
const CONTACT_GROUPS_SUBCOLLECTION = 'contact_groups'
const SESSIONS_COLLECTION = 'sessions'
const WAITLIST_SUBCOLLECTION = 'waitlist'
const EVENTS_COLLECTION = 'events'
const EVENT_PROGRAM_ITEMS_SUBCOLLECTION = 'program_items'
const COURSES_COLLECTION = 'courses'
const COURSE_PURCHASES_SUBCOLLECTION = 'purchases'

const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)
function daysFrom(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ── Contact notes ─────────────────────────────────────────────────────────────

/**
 * A few coach notes on the team's first contacts.
 *
 * The Notes tab is on the contact detail page every demo opens first, and it
 * rendered a permanent empty state on all five surfaces.
 */
export async function seedContactNotes(teamId: string, uid: string, limit = 4): Promise<number> {
  const db = admin.firestore()
  const contacts = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(limit)
    .get()

  const notes = [
    'Wants to focus on conditioning before the winter. Happy in the 07:00 slot.',
    'Recovering from a shoulder issue — keep drilling light on the right side.',
    'Asked about the annual plan. Follow up after the next block of classes.',
    'Brings a friend most Thursdays; worth offering a referral code.',
  ]

  let written = 0
  for (let i = 0; i < contacts.docs.length; i++) {
    const c = contacts.docs[i]
    const at = tsOf(daysFrom(-(7 + i * 5)))
    await c.ref
      .collection(CONTACT_NOTES_SUBCOLLECTION)
      .doc(`${c.id}-note-1`)
      .set({
        teamId,
        contactId: c.id,
        body: notes[i % notes.length],
        created_at: at,
        updated_at: at,
        createdBy: uid,
        createdByName: 'Coach',
      })
    written += 1
  }
  return written
}

// ── A DYNAMIC contact group ───────────────────────────────────────────────────

/**
 * One dynamic group, whose membership is a RULE and is never materialised.
 *
 * The lead seeder writes manual groups; nothing anywhere wrote a dynamic one, so
 * the half of the feature that exists BECAUSE of age — the dimension that
 * changes with no write at all, which is why a snapshot group silently goes
 * wrong — had no coverage.
 *
 * Note what is NOT written: no `Contact.group_ids` entry for anybody. A group is
 * manual OR dynamic, the two membership sources are disjoint, and materialising
 * a dynamic group's membership is the one thing that would make it wrong.
 */
export async function seedDynamicContactGroup(teamId: string, uid: string): Promise<void> {
  await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(CONTACT_GROUPS_SUBCOLLECTION)
    .doc(`${teamId}-group-juniors`)
    .set({
      name: 'Juniors (under 18)',
      parent_id: null,
      color: '#6366f1',
      description: 'Everyone under 18 — recomputed on every read, never stored.',
      // `birth_year` rather than `age` is deliberate: rosters and competition
      // categories run on the calendar year, and `includeUnknown: false` is the
      // honest default — a missing birthdate silently dropping a child from a
      // juniors list is exactly the failure nobody spots.
      rule: {
        search: '',
        stages: [],
        sources: [],
        statuses: [],
        subscriptions: [],
        groups: [],
        coaches: [],
        engagement: [],
        tags: [],
        hasAlerts: false,
        pendingSignup: false,
        needsAttention: false,
        sessionsMin: null,
        sessionsMax: null,
        inactivity: null,
        rankFilter: null,
        age: { mode: 'age', min: null, max: 17, includeUnknown: false },
        customFields: [],
        consent: null,
      },
      created_at: tsOf(daysFrom(-60)),
      created_by: uid,
    })
}

// ── Waitlist ──────────────────────────────────────────────────────────────────

/**
 * Fill one upcoming class and put a queue behind it.
 *
 * Entries are written only by callables in production — every client write is
 * denied — so a seeded queue is the only way `/public/{slug}/waitlist` and the
 * seat-offer banner have anything to show.
 *
 * NO OFFER IS SEEDED, and that is the point. An offered seat is held as an
 * ordinary booking whose `claim_expires_at`, the entry's `offer_expires_at` and
 * the Stripe session's expiry are ONE instant computed once by
 * `resolveClaimWindow` and copied. A seed cannot call that, and a seed that
 * reproduced the instant by hand would be the second writer the single-deadline
 * rule exists to forbid — with the failure mode that a seat gets sold twice.
 * Waiting entries demonstrate the queue; the offer is demonstrated by freeing a
 * seat and letting `seatFreedEdge` do it.
 */
export async function seedSessionWaitlist(opts: {
  teamId: string
  /** Contacts to queue, in join order. */
  count?: number
}): Promise<{ sessionId: string | null; queued: number }> {
  const db = admin.firestore()
  const { teamId } = opts
  const count = opts.count ?? 3

  // The soonest upcoming session.
  const upcoming = await db
    .collection(SESSIONS_COLLECTION)
    .where('teamId', '==', teamId)
    .where('start', '>', admin.firestore.Timestamp.now())
    .orderBy('start')
    .limit(5)
    .get()
  const target = upcoming.docs.find((d) => d.data().activityType !== 'appointment')
  if (!target) return { sessionId: null, queued: 0 }

  const session = target.data()

  // A CAPACITY IS SEEDED HERE IF THE SESSION HAS NONE, and that is a gap behind
  // the gap: only the lead seeder ever wrote `max_participants`, so on every
  // other surface no class could be full and "full" is what a waitlist is for.
  // An unbounded class is a real configuration, but it cannot be the ONLY one a
  // demo tenant has.
  const capacity =
    typeof session.max_participants === 'number' && session.max_participants > 0
      ? (session.max_participants as number)
      : 8

  const contacts = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(60)
    .get()

  // Whoever already holds a seat here. Booking doc ids are seeder-specific, so
  // match on the `contact` FIELD.
  const bookings = await target.ref.collection('bookings').get()
  const booked = new Set(bookings.docs.map((d) => d.data().contact as string).filter(Boolean))

  // FILL THE CLASS WITH REAL BOOKINGS, one document per seat.
  //
  // An earlier version of this fixture just wrote `bookings_count: capacity` and
  // stopped, which is the exact half-record this repo keeps paying for: the
  // agenda read the counter and showed 20/20, the session detail read the
  // `bookings` subcollection and showed nobody, and the two disagreed on every
  // seeded tenant. A counter is a CACHE of the rows; seeding one without the
  // other states something no query can confirm.
  const free = contacts.docs.filter((d) => !booked.has(d.id))
  const fillers = free.slice(0, Math.max(0, capacity - booked.size))
  for (let i = 0; i < fillers.length; i++) {
    const c = fillers[i]
    const d = c.data() as { firstname?: string; lastname?: string; email?: string; phone?: string }
    await target.ref
      .collection('bookings')
      .doc(`${target.id}-wlfill-${c.id}`)
      .set({
        teamId,
        contact: c.id,
        session: target.id,
        email: d.email ?? `${c.id}@example.com`,
        firstname: d.firstname ?? 'Member',
        lastname: d.lastname ?? '',
        phone: d.phone ?? '',
        is_new_contact: false,
        joinedAt: tsOf(daysFrom(-3 - i)),
        // A settled seat, not a trial hold — `bookingHoldsSeat` counts it, which
        // is what makes the class genuinely full rather than nominally full.
        status: 'confirmed',
        booking_token: `wlfill-${target.id}-${c.id}`,
      })
  }

  // ABSOLUTE, and recounted from the rows that now exist — never `capacity`
  // asserted independently of them, and never FieldValue.increment.
  const seated = booked.size + fillers.length
  await target.ref.update({ max_participants: capacity, bookings_count: seated })

  // Queue people who are NOT holding a seat — a waitlist entry for somebody
  // already booked is a contradiction the UI would render as one.
  const seatedIds = new Set([...booked, ...fillers.map((f) => f.id)])
  const queue = free.filter((d) => !seatedIds.has(d.id)).slice(0, count)


  let queued = 0
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]
    const d = c.data() as { firstname?: string; lastname?: string; email?: string; phone?: string }
    await target.ref
      .collection(WAITLIST_SUBCOLLECTION)
      .doc(c.id) // doc id = contactId, so a second join is idempotent
      .set({
        id: c.id,
        teamId,
        session: target.id,
        contact: c.id,
        session_start: session.start,
        firstname: d.firstname ?? 'Member',
        lastname: d.lastname ?? '',
        email: d.email ?? `${c.id}@example.com`,
        phone: d.phone ?? null,
        // THE ordering key. `joined_at ASC` is the queue, always — there is no
        // stored position, so a departure ahead of you rewrites nothing.
        joined_at: tsOf(daysFrom(-1 - (queue.length - i))),
        status: 'waiting',
        entry_token: `wl-${target.id}-${c.id}`,
        // BookingSource is online | kiosk | staff — a public-portal join is
        // 'online'; there is no 'portal' member.
        source: 'online',
      })
    queued += 1
  }
  return { sessionId: target.id, queued }
}

// ── Event program ───────────────────────────────────────────────────────────

/**
 * Give the team's first multi-day-capable event a real agenda: days and tracks
 * embedded on the event doc, items in the subcollection.
 *
 * TIMES ARE WALL-CLOCK at the venue ('HH:MM' plus the day's 'YYYY-MM-DD'), never
 * Timestamps. A program is a printed schedule — "09:00 breakfast" is 09:00
 * wherever the camp is.
 *
 * Every item carries the denormalised tenant stamp, because create validates it
 * against the parent once and every later read/update trusts it.
 */
export async function seedEventProgram(teamId: string, uid: string): Promise<number> {
  const db = admin.firestore()
  const events = await db
    .collection(EVENTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(1)
    .get()
  if (events.empty) return 0
  const event = events.docs[0]

  const day1 = isoDate(daysFrom(30))
  const day2 = isoDate(daysFrom(31))
  const days = [
    { id: 'd1', date: day1, title: 'Day 1 — Arrival & fundamentals', order: 0 },
    { id: 'd2', date: day2, title: 'Day 2 — Sparring & awards', order: 1 },
  ]
  const tracks = [
    { id: 't-kids', name: 'Kids', color: '#22c55e', order: 0 },
    { id: 't-adults', name: 'Adults', color: '#3b82f6', order: 1 },
  ]

  await event.ref.set(
    {
      program: {
        days,
        tracks,
        timezoneLabel: 'Europe/Zurich',
        note: 'Times are local to the venue. Bring both gi and no-gi kit.',
      },
    },
    { merge: true }
  )

  const items: Array<{
    id: string
    dayId: string
    trackId: string | null
    startTime: string
    endTime: string
    title: string
    kind: string
    isHighlight?: boolean
    locationText?: string
    peopleText?: string
    internalNote?: string
  }> = [
    { id: 'i1', dayId: 'd1', trackId: null, startTime: '08:30', endTime: '09:00', title: 'Registration & welcome', kind: 'briefing', locationText: 'Main hall' },
    { id: 'i2', dayId: 'd1', trackId: 't-kids', startTime: '09:00', endTime: '10:30', title: 'Fundamentals — kids', kind: 'activity', peopleText: 'Coach Marta' },
    { id: 'i3', dayId: 'd1', trackId: 't-adults', startTime: '09:00', endTime: '10:30', title: 'Fundamentals — adults', kind: 'activity', peopleText: 'Coach Luis' },
    { id: 'i4', dayId: 'd1', trackId: null, startTime: '12:30', endTime: '13:30', title: 'Lunch', kind: 'meal', locationText: 'Terrace' },
    { id: 'i5', dayId: 'd1', trackId: null, startTime: '18:00', endTime: '19:00', title: 'Open mat', kind: 'free' },
    { id: 'i6', dayId: 'd2', trackId: null, startTime: '08:00', endTime: '08:45', title: 'Breakfast', kind: 'meal' },
    { id: 'i7', dayId: 'd2', trackId: 't-kids', startTime: '09:30', endTime: '11:30', title: 'Kids sparring rounds', kind: 'activity' },
    { id: 'i8', dayId: 'd2', trackId: 't-adults', startTime: '09:30', endTime: '11:30', title: 'Adults sparring rounds', kind: 'activity' },
    {
      id: 'i9', dayId: 'd2', trackId: null, startTime: '16:00', endTime: '17:00',
      title: 'Awards ceremony', kind: 'ceremony', isHighlight: true,
      // Staff-only, and NEVER mirrored to the public profile — seeded precisely
      // so the mirror can be checked to be leaving it out.
      internalNote: 'Trophies are in the store room; Marta has the key.',
    },
  ]

  const now = tsOf(new Date())
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    await event.ref
      .collection(EVENT_PROGRAM_ITEMS_SUBCOLLECTION)
      .doc(`${event.id}-${it.id}`)
      .set({
        id: `${event.id}-${it.id}`,
        eventId: event.id,
        // The denormalised tenant stamp — validated once at create, trusted by
        // every read after, and what makes an org-scoped event (teamId null)
        // work by construction.
        teamId,
        scope: 'team',
        dayId: it.dayId,
        trackId: it.trackId,
        startTime: it.startTime,
        endTime: it.endTime,
        title: it.title,
        kind: it.kind,
        ...(it.locationText ? { locationText: it.locationText } : {}),
        ...(it.peopleText ? { peopleText: it.peopleText } : {}),
        ...(it.internalNote ? { internalNote: it.internalNote } : {}),
        ...(it.isHighlight ? { isHighlight: true } : {}),
        order: i,
        created_at: now,
        updated_at: now,
        createdBy: uid,
      })
  }
  return items.length
}

// ── Course purchase ───────────────────────────────────────────────────────────

/**
 * Give one contact a LIFETIME entitlement to the team's `purchase`-tier course.
 *
 * The shop already sells such a course on three surfaces, but nobody had ever
 * bought one — so the Space's unlock state, the half of the tier that is not a
 * price tag, was never demonstrated.
 *
 * The doc id is the buyer's contactId, and `payment_ref` carries the provenance
 * the id cannot: a refund reversal deletes the entitlement only when the ref
 * matches the payment being reversed, so a manual or gift-card-funded grant
 * survives a refund of some other charge.
 */
export async function seedCoursePurchase(teamId: string): Promise<string | null> {
  const db = admin.firestore()
  const courses = await db.collection(COURSES_COLLECTION).where('teamId', '==', teamId).get()
  const paid = courses.docs.find((d) => d.data().accessRule?.type === 'purchase')
  if (!paid) return null

  const contacts = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .limit(1)
    .get()
  if (contacts.empty) return null
  const buyer = contacts.docs[0]

  const priceAmount = (paid.data().accessRule?.priceAmount as number | undefined) ?? 0
  const paymentIntentId = `pi_seed_${buyer.id}_course`
  await paid.ref
    .collection(COURSE_PURCHASES_SUBCOLLECTION)
    .doc(buyer.id)
    .set({
      courseId: paid.id,
      teamId,
      contactId: buyer.id,
      paymentIntentId,
      payment_ref: paymentIntentId,
      source: 'stripe_connect',
      amount: Math.round(priceAmount * 100),
      currency: 'CHF',
      purchasedAt: tsOf(daysFrom(-21)),
    })
  return paid.id
}
