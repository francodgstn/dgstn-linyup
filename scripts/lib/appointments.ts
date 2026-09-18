/**
 * Shared appointment-seeding helpers — the AVAILABILITY-ONLY model.
 *
 * An `availability` doc publishes only the WHEN (a provider's free time). The
 * WHAT — name, priced durations, member benefit — lives on the linked `appointment`
 * activities (`activityIds`). Appointments carry NO access rule: the price is the
 * only gate (unpriced = anyone books free, priced = anyone pays, benefit holders
 * less). Crucially, NOTHING is pre-generated: there is no
 * generator cron and no availability trigger, so an appointment `Session` exists
 * only once a client books one. Seeds must therefore never fabricate "open slots";
 * they materialise a handful of ALREADY-BOOKED appointments instead, shaped exactly
 * like the ones the `bookAppointment` callable writes.
 *
 * FREE-PATH ONLY: seeded booked appointments are always free-path-shaped —
 * `status: 'confirmed'`, no payment fields (no payment_status/payment_intent_id,
 * no `pending_payment` holds).
 *
 * The REASON given here used to be "a paid booking would need a matching
 * `member_payments/*` ledger doc and no such seeding pipeline exists". Half of
 * that is now false: the pipeline exists, in `scripts/lib/fixtures/money.ts`
 * (Franco's decision 1, 2026-08-19 — an empty /payments screen was costing more
 * than a fabricated ledger row). The OBLIGATION is unchanged and stricter: a
 * paid booking and its ledger row are seeded TOGETHER or not at all. What must
 * never appear is a session stamped as paid with no money behind it.
 *
 * Appointments stay free-path here anyway, because a paid one also implies a
 * hold that expires, a Checkout Session that can be resumed, and a webhook that
 * confirms it — none of which a ledger row can stand in for. Seed a paid
 * appointment by actually paying through Stripe test mode.
 *
 * Path/type constants mirror @linyup/shared (the seed scripts compile under
 * tsconfig.scripts.json, which does not resolve the workspace import — same
 * convention as scripts/lib/storefront.ts).
 */
import * as admin from 'firebase-admin'

const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)

/**
 * Dates matching `daysOfWeek` (JS getDay(): 0=Sun … 6=Sat) at `time` ('HH:MM',
 * local), walking away from today until `count` are found.
 *
 * `direction: 1` (default) collects UPCOMING dates (strictly in the future),
 * `direction: -1` collects PAST ones (strictly in the past) — history that makes
 * the appointment calendar and the reports look lived-in.
 */
export function appointmentOccurrences(p: {
  daysOfWeek: number[]
  time: string
  count: number
  direction?: 1 | -1
  /** How many days out to start looking (default 0 = today). */
  fromDayOffset?: number
  /** Give up after this many days of walking (default 120). */
  maxDayspan?: number
}): Date[] {
  const [hh, mm] = p.time.split(':').map(Number)
  const direction = p.direction ?? 1
  const maxDayspan = p.maxDayspan ?? 120
  const nowMs = Date.now()
  const out: Date[] = []
  for (let step = p.fromDayOffset ?? 0; out.length < p.count && step <= maxDayspan; step++) {
    const d = new Date()
    d.setDate(d.getDate() + step * direction)
    if (!p.daysOfWeek.includes(d.getDay())) continue
    d.setHours(hh, mm || 0, 0, 0)
    const future = d.getTime() > nowMs
    if (direction === 1 ? future : !future) out.push(d)
  }
  return out
}

export interface SeedAppointmentInput {
  teamId: string
  /** The availability doc this appointment was booked out of. */
  templateId: string
  /** The `type: 'appointment'` activity the client picked — the WHAT. */
  activityId: string
  activityName: string
  /** Denormalised from the activity's `autoConfirm` (see resolveAutoConfirm).
   *  Defaults to true — an appointment's booking takes the provider's time on the
   *  spot, which is why the booking doc below is written `status: 'confirmed'`. */
  autoConfirm?: boolean
  providerId: string
  providerName: string
  start: Date
  durationMinutes: number
  location?: string | null
  onlineUrl?: string | null
  /** Extra fields merged into BOTH docs (e.g. locationAddress, placeId). */
  extra?: Record<string, unknown>
  /** Past appointments: already delivered, so not bookable and attendance-counted. */
  past?: boolean
  createdAt?: Date
}

/**
 * The docs a booked appointment consists of: the session + its public mirror.
 * Mirrors `bookAppointment` (packages/functions/src/appointments/) for the session
 * and `syncSessionPublicProfile` for the mirror, so seeded data is shaped like
 * production data. The booking subcollection doc is built separately (see
 * buildAppointmentBookingDoc) because each seed sources its client differently.
 */
export function buildAppointmentSessionDocs(input: SeedAppointmentInput): {
  id: string
  session: Record<string, unknown>
  publicProfile: Record<string, unknown>
} {
  const end = new Date(input.start.getTime() + input.durationMinutes * 60_000)
  const extra = input.extra ?? {}
  // Deterministic id, exactly as bookAppointment mints it — same-start double
  // books collide on one doc.
  const id = `apt_${input.providerId}_${input.start.getTime()}`

  const session = {
    teamId: input.teamId,
    templateId: input.templateId,
    origin: 'window',
    activityType: 'appointment',
    activityId: input.activityId,
    activityName: input.activityName,
    // NOTE: no accessRule — appointments dropped the access gate
    // entirely (2026-07); the price is the only gate. Matches bookAppointment.
    providerId: input.providerId,
    providerName: input.providerName,
    start: tsOf(input.start),
    end: tsOf(end),
    duration_minutes: input.durationMinutes,
    // Always 1 — an appointment is a provider's exclusive time (bookAppointment
    // hardcodes this too; trackBookings reads it to drive the 'full' flip).
    max_participants: 1,
    // ONE counter for both kinds: bookings HOLDING CAPACITY (status neither
    // 'cancelled' nor 'no_show'). The separate bio-link counter classes used to
    // count into was merged into this one (2026-07).
    bookings_count: 1,
    autoConfirm: input.autoConfirm ?? true,
    location: input.location ?? null,
    onlineUrl: input.onlineUrl ?? null,
    allowBooking: !input.past,
    status: 'full',
    has_bookings: true,
    ...(input.past ? { participants_count: 1 } : {}),
    last_booking_at: tsOf(input.createdAt ?? input.start),
    created_at: tsOf(input.createdAt ?? input.start),
    ...extra,
  }

  // The live syncSessionPublicProfile mirrors appointment sessions (allowBooking:
  // true) unless cancelled, past ones included; the public timetable shows those
  // muted.
  const publicProfile = {
    type: 'appointment_session',
    teamId: input.teamId,
    activityType: 'appointment',
    activityName: input.activityName,
    providerId: input.providerId,
    providerName: input.providerName,
    templateId: input.templateId,
    start: tsOf(input.start),
    end: tsOf(end),
    duration_minutes: input.durationMinutes,
    location: input.location ?? null,
    onlineUrl: input.onlineUrl ?? null,
    // Always 1 — an appointment is a provider's exclusive time (bookAppointment
    // hardcodes this too; trackBookings reads it to drive the 'full' flip).
    max_participants: 1,
    bookings_count: 1,
    // No accessRule: appointment mirrors dropped the gate (syncSessionPublicProfile).
    status: 'full',
    allowBooking: true,
    ...extra,
  }

  return { id, session, publicProfile }
}

/** The `confirmed` booking doc bookAppointment writes at sessions/{id}/bookings/{contactId}.
 *  `status: 'confirmed'` + `fullname` are what auto-confirm looks like on the wire;
 *  a class booking, by contrast, carries no confirmed status until check-in. */
export function buildAppointmentBookingDoc(p: {
  teamId: string
  sessionId: string
  contactId: string
  firstname: string
  lastname: string
  email: string
  phone?: string | null
  bookedAt: Date
}): Record<string, unknown> {
  return {
    teamId: p.teamId,
    contactId: p.contactId,
    contact: p.contactId,
    session: p.sessionId,
    firstname: p.firstname,
    lastname: p.lastname,
    fullname: `${p.firstname} ${p.lastname}`,
    email: p.email,
    phone: p.phone ?? null,
    status: 'confirmed',
    joinedAt: tsOf(p.bookedAt),
    fromBioLink: true,
    authenticated_booking: true,
    booking_token: `tok-appointment-${p.sessionId}`,
    is_new_contact: false,
  }
}
