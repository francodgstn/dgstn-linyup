/* eslint-disable no-console */
// Appointments are ACTIVITY-BOUND and AVAILABILITY-ONLY. A coach publishes an
// `Availability` (the *when* — a daily range or explicit times, Calendly-style)
// linked to one or more `type: 'appointment'` Activities (the *what* — name,
// duration(s), memberBenefit). Nothing is ever pre-generated: a start time is
// indeterminate until the client picks an activity, so free time is computed
// on the fly here, and a Session is created lazily, overlap-safe, at booking
// time.
//
//  • listAvailability — public: free start times per coach/activity/day/duration.
//  • bookAppointment  — public: resolves the covering availability server-side,
//    runs the PRICE gate (the only gate — see ActivityMemberBenefit), then
//    delegates the overlap-safe create-session + book to the shared
//    appointments/booking.ts transaction.
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { generateSecureToken } from '../utils/crypto'
import { getHostingUrl } from '../utils/env'
import { to } from '../utils/async'
import { paymentsAreChargeable, type EnabledTeam } from '../connect/access'
import { loadContactPaymentSnapshot } from '../booking/access'
import { checkoutRateLimit } from '../connect/checkout'
import { attachWaiverContact, enforceWaiverGate, parseWaiverSubmissions } from '../waivers/gate'
import {
  AVAILABILITY_COLLECTION,
  AVAILABILITY_EXCEPTIONS_COLLECTION,
  ACTIVITIES_COLLECTION,
  BASKET_MAX_DATES,
  ORGANIZATIONS_COLLECTION,
  ORG_PLACES_SUBCOLLECTION,
  TEAM_PLACES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  GUEST_SNAPSHOT,
  appointmentSlotBlocked,
  normalizeBenefit,
  resolveAppointmentDurations,
  resolveDurationBenefit,
  resolveDurationParty,
  resolveDurationSale,
  resolveMaxDatesPerBooking,
  resolvePaymentOptions,
  type Activity,
  type BookingContactField,
  type ActivityDuration,
  type ActivityDurationBenefit,
  type ActivityMemberBenefit,
  type Availability,
  type Benefit,
  type ListAvailabilityResult,
  type ListAvailabilityCoach,
  type ListAvailabilityActivity,
  type ListAvailabilityDay,
  localizedPublicUrl,
} from '@linyup/shared'
import {
  DAY_MS,
  MAX_SESSION_MS,
  loadAppointmentBookingContext,
  parseHHMM,
  resolveAppointmentCaller,
  resolveOrCreateAppointmentContact,
  runAppointmentSlotTransaction,
  type WindowTemplate,
} from './booking'
import { sendAppointmentBookingEmails } from './emails'
import { getDatePartsInTz, localTimeToUtc } from './index'
import { partyBookingFields, readAppointmentParty } from './party'
import {
  appointmentSessionId,
  basketDateToken,
  loadBasketContexts,
  newBasketIdentity,
  readBasketStarts,
} from './basket'
import { releaseAppointmentHold } from './holdRelease'
import { resolveContactFieldPatchForBooking } from '../booking/contactFields'

/** How long a FREE basket's dates are held between its two phases. Seconds
 *  in practice; minutes only so a crash between them frees the dates soon. */
const BASKET_FREE_HOLD_MINUTES = 5

const DEFAULT_RANGE_DAYS = 28
const MAX_RANGE_DAYS = 60

// listAvailability is a public BROWSE surface — the picker refetches as the
// visitor changes activity/day, so one genuine session makes many calls. The
// default checkout ceiling (30/h) would lock a browsing user out, so this read
// gets a higher ceiling: still bounds an anonymous enumerator to a trivially
// cheap number of teamId-scoped scans per hour. The two write callables below
// keep the default 30/h.
const AVAILABILITY_RATE_LIMIT_PER_HOUR = 240

interface BusyInterval {
  start: number
  end: number
}

// Does [start, start+dur) collide with any busy interval expanded by buffer?
function conflicts(startMs: number, durMs: number, busy: BusyInterval[], bufferMs: number): boolean {
  const endMs = startMs + durMs
  return busy.some((b) => startMs < b.end + bufferMs && endMs > b.start - bufferMs)
}

// Loaded/derived shape of a `type: 'appointment'` activity — the *what*.
// No accessRule here any more — appointments dropped the access gate entirely;
// money (durations + the member rule on each) is the only gate.
interface ActivityInfo {
  id: string
  name: string
  /** Priced duration menu (resolveAppointmentDurations default applied). */
  durations: ActivityDuration[]
  /** BOTH halves travel together, always — `resolveDurationBenefit` needs the
   *  pair to tell "no rule for this length" from "this tenant predates
   *  per-length rules". Sending one without the other is how a reader silently
   *  falls back to the wrong reading. */
  memberBenefit?: ActivityMemberBenefit | Benefit
  durationBenefits?: ActivityDurationBenefit[]
  /** Per-activity cancellation-policy override; the picker falls back to the
   *  team default it already has (TeamPublicProfile.bookingCancellationPolicy).
   *  Display-only, and the same text the confirmation email appends — the point
   *  is that the visitor reads it BEFORE the button, not after. */
  cancellationPolicy?: string | null
  /** The activity's own CONTACT fields, which extend the team-wide list. Sent
   *  to the picker so the guest step asks for exactly what the booking
   *  callables will accept — the resolver runs on both sides. */
  contactFields?: BookingContactField[]
  /** How many dates one booking may take (`resolveMaxDatesPerBooking`). */
  maxDatesPerBooking: number
}

function toActivityInfo(id: string, a: Activity): ActivityInfo | null {
  const durations = resolveAppointmentDurations(a)
  if (!durations.length) return null
  return {
    id,
    name: a.name || 'Appointment',
    durations,
    memberBenefit: a.memberBenefit,
    durationBenefits: a.durationBenefits,
    cancellationPolicy: a.cancellationPolicy?.trim() || null,
    contactFields: a.contactFields,
    maxDatesPerBooking: resolveMaxDatesPerBooking(a),
  }
}

// Enumerate candidate starts for (template, activity durations) across
// [nowMs, toMs], merging into a per-day, per-duration accumulator so several
// availabilities offering the SAME activity combine into one listing.
function accumulateCandidates(
  tpl: WindowTemplate,
  durations: number[],
  busy: BusyInterval[],
  nowMs: number,
  toMs: number,
  daysMap: Map<number, Record<string, Set<number>>>
): void {
  const bufferMs = (tpl.bufferMinutes || 0) * 60_000
  const daysOfWeek = tpl.recurrence?.daysOfWeek ?? []
  const startDate = tpl.recurrence?.startDate ? tpl.recurrence.startDate.toMillis() : 0
  const endDate = tpl.recurrence?.endDate ? tpl.recurrence.endDate.toMillis() : Infinity

  let gran = 0
  let winStartHM: [number, number] | null = null
  let winEndHM: [number, number] | null = null
  if (tpl.mode === 'range') {
    if (!tpl.window) return
    winStartHM = parseHHMM(tpl.window.start)
    winEndHM = parseHHMM(tpl.window.end)
    gran = (tpl.granularityMinutes || 15) * 60_000
  }

  const cursor = new Date(nowMs)
  cursor.setUTCHours(0, 0, 0, 0)
  while (cursor.getTime() <= toMs) {
    const { year, month, day, dayOfWeek } = getDatePartsInTz(cursor)
    const dayMidnight = localTimeToUtc(year, month, day, 0, 0).getTime()
    if (daysOfWeek.includes(dayOfWeek) && dayMidnight >= startDate - DAY_MS && dayMidnight <= endDate) {
      for (const dur of durations) {
        const durMs = dur * 60_000
        const starts: number[] = []
        if (tpl.mode === 'times') {
          for (const hhmm of tpl.times ?? []) {
            const [h, m] = parseHHMM(hhmm)
            const s = localTimeToUtc(year, month, day, h, m).getTime()
            if (s <= nowMs) continue
            // 'times' mode: no window bound — just don't spill past end of day.
            if (s + durMs > dayMidnight + DAY_MS) continue
            if (conflicts(s, durMs, busy, bufferMs)) continue
            starts.push(s)
          }
        } else if (winStartHM && winEndHM) {
          const winStart = localTimeToUtc(year, month, day, winStartHM[0], winStartHM[1]).getTime()
          const winEnd = localTimeToUtc(year, month, day, winEndHM[0], winEndHM[1]).getTime()
          for (let s = winStart; s + durMs <= winEnd; s += gran) {
            if (s <= nowMs) continue
            if (conflicts(s, durMs, busy, bufferMs)) continue
            starts.push(s)
          }
        }
        if (starts.length) {
          let byDur = daysMap.get(dayMidnight)
          if (!byDur) {
            byDur = {}
            daysMap.set(dayMidnight, byDur)
          }
          const set = byDur[String(dur)] ?? (byDur[String(dur)] = new Set<number>())
          for (const s of starts) set.add(s)
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
}

// ─── listAvailability (public) ─────────────────────────────────────────────────

/**
 * WHERE ONE SCHEDULE'S OFFERS LAND, the (activity, place) bucket key, and the
 * one place the place-vs-location precedence is decided.
 *
 * `listAvailability` returns one entry per (provider, activity, PLACE), and
 * this is the "place" half. Grouping on (provider, activity) alone merged a
 * coach's schedules at DIFFERENT places into one calendar labeled with
 * whichever schedule was read first, so a visitor picked a Tuesday believing
 * it was one place and `bookAppointment` put them in another, because booking
 * resolves the place from the availability that covers the start, not from
 * anything the visitor was shown. That was wrong output, not a missing feature.
 *
 * The key falls back to the free-text `location`, then `onlineUrl`, then the
 * empty string, so a legacy schedule carrying no `placeId` buckets exactly as
 * it did before, one entry, unchanged.
 */
export function availabilityPlaceKey(tpl: AvailabilityWhere): string {
  return tpl.placeId ?? tpl.location ?? tpl.onlineUrl ?? ''
}

/** The three fields that say where a schedule happens.
 *
 *  Nullable, unlike `Availability`'s own optional spelling, because the editor
 *  writes `placeId: data.placeId || null`, a cleared field is stored as null,
 *  not removed. Both read the same through `??`; the type is widened so a
 *  fixture can be honest about what is on disk. */
type AvailabilityWhere = {
  [K in 'placeId' | 'location' | 'onlineUrl']?: Availability[K] | null
}

/** The bucket key itself. Separate from `availabilityPlaceKey` only so the
 *  activity half cannot be spelled two ways at two call sites. */
export function availabilityBucketKey(activityId: string, tpl: AvailabilityWhere): string {
  return `${activityId}::${availabilityPlaceKey(tpl)}`
}

/**
 * Place id → the place's own name, for the ids a set of schedules actually
 * references.
 *
 * Read by id rather than mirrored: a place has no public document of its own,
 * the set on screen is tiny (MAX_PLACES caps a team at 25 and a coach's
 * schedules reference a handful), and an id-keyed read is the one shape that
 * needs nothing kept in step. A session's place may also be an ORG place, which
 * a team-scoped query would never find, hence the second lookup, tried only for
 * the ids the first did not answer.
 *
 * A missing place yields no entry, and the caller renders the schedule's own
 * free-text `location` exactly as it did before. Never throws: a label is not
 * worth failing a calendar over.
 */
async function resolvePlaceNames(
  db: FirebaseFirestore.Firestore,
  teamId: string,
  orgIds: readonly string[],
  placeIds: ReadonlySet<string>
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (placeIds.size === 0) return names

  const teamPlaces = db.collection(TEAMS_COLLECTION).doc(teamId).collection(TEAM_PLACES_SUBCOLLECTION)
  const [teamErr, teamDocs] = await to(Promise.all([...placeIds].map((id) => teamPlaces.doc(id).get())))
  if (teamErr) console.warn('[listAvailability] could not read team places:', teamErr)
  for (const doc of teamDocs ?? []) {
    const name = doc.exists ? (doc.data()?.name as string | undefined) : undefined
    if (name) names.set(doc.id, name)
  }

  const unresolved = [...placeIds].filter((id) => !names.has(id))
  for (const orgId of orgIds) {
    if (unresolved.length === 0) break
    const orgPlaces = db.collection(ORGANIZATIONS_COLLECTION).doc(orgId).collection(ORG_PLACES_SUBCOLLECTION)
    const [orgErr, orgDocs] = await to(Promise.all(unresolved.map((id) => orgPlaces.doc(id).get())))
    if (orgErr) {
      console.warn('[listAvailability] could not read org places:', orgErr)
      break
    }
    for (const doc of orgDocs ?? []) {
      const name = doc.exists ? (doc.data()?.name as string | undefined) : undefined
      if (name) names.set(doc.id, name)
    }
    for (let i = unresolved.length - 1; i >= 0; i--) {
      if (names.has(unresolved[i])) unresolved.splice(i, 1)
    }
  }

  return names
}

export const listAvailability = onCall(async (request): Promise<ListAvailabilityResult> => {
  await checkoutRateLimit(request.rawRequest?.ip, 'availability', AVAILABILITY_RATE_LIMIT_PER_HOUR)
  const data = request.data as {
    teamId?: string
    providerId?: string
    activityId?: string
    days?: number
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  const rangeDays = Math.min(Math.max(Math.floor(data.days ?? DEFAULT_RANGE_DAYS), 1), MAX_RANGE_DAYS)
  const db = admin.firestore()
  const nowMs = Date.now()
  const toMs = nowMs + rangeDays * DAY_MS

  // Both 'range' and 'times' modes are live — no mode filter here any more.
  const snap = await db
    .collection(AVAILABILITY_COLLECTION)
    .where('teamId', '==', data.teamId)
    .where('status', '==', 'active')
    .get()
  let templates: WindowTemplate[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Availability) }))
  if (data.providerId) templates = templates.filter((t) => t.providerId === data.providerId)
  if (templates.length === 0) return { coaches: [], settleAtStudio: false }

  // CAN THE STUDIO BE PAID ONLINE? A priced duration used to be DROPPED when it
  // could not (UX-33's fail-closed reading), and that produced the wrong
  // sentence at the wrong moment: a visitor who reached one anyway was told
  // "This slot is no longer available", which is false — the slot is fine, the
  // studio simply has no Stripe account yet.
  //
  // Franco's call (2026-08-28): let them BOOK IT AND SETTLE AT THE STUDIO. So
  // the length stays on the menu and `settleAtStudio` tells the client to say
  // where the money changes hands, instead of hiding a bookable time and
  // costing the studio the appointment.
  //
  // It is a TEAM-level fact, not a per-duration one, and it is computed here
  // rather than in each client so the web picker and the mobile app cannot
  // disagree about which door a price opens.
  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(data.teamId).get()
  const settleAtStudio = !paymentsAreChargeable(
    teamSnap.data()?.payments as EnabledTeam['payments']
  )

  // ── THE STUDIO'S OWN TOGGLE, HONORED WHERE IT ACTUALLY MATTERS ───────────
  // `bookingSettings.appointmentsEnabled` ("Show bookable hours") had exactly
  // one web reader, `usePublicSurfaces`, imported only by `(auth)` routes — so
  // it governed what the STUDIO was told about its own surfaces and nothing a
  // visitor could reach. Switching it off hid nothing public (Franco,
  // 2026-08-28: honor it on public routes).
  //
  // It is enforced HERE, at the callable, rather than on the page: this is the
  // one door every client goes through, so the web picker, the mobile app and
  // anything added later are covered by construction — and a page-level gate
  // would leave the callable answering to a direct call anyway.
  //
  // The toggle lives on the public_profile document (Settings → Booking writes
  // it straight there, never touching the team doc), which is why it is a
  // second read rather than a field on `teamSnap`.
  //
  // ABSENT MEANS ON, matching `appointmentPickerLive`: a studio that never
  // touched the switch has bookable hours if it published any.
  const profileSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(data.teamId)
    .collection('public_profile')
    .doc(data.teamId)
    .get()
  const appointmentsEnabled =
    (profileSnap.data()?.bookingSettings as { appointmentsEnabled?: boolean } | undefined)
      ?.appointmentsEnabled !== false
  if (!appointmentsEnabled) return { coaches: [], settleAtStudio }

  // Batch-load the union of referenced activities; keep only bookable appointment offerings.
  const activityIds = new Set<string>()
  for (const t of templates) for (const id of t.activityIds ?? []) activityIds.add(id)
  const activityDocs = await Promise.all(
    [...activityIds].map((id) => db.collection(ACTIVITIES_COLLECTION).doc(id).get())
  )
  const activityMap = new Map<string, ActivityInfo>()
  for (const doc of activityDocs) {
    if (!doc.exists) continue
    const a = doc.data() as Activity
    if (a.type !== 'appointment' || a.teamId !== data.teamId) continue
    if (data.activityId && doc.id !== data.activityId) continue
    const info = toActivityInfo(doc.id, a)
    if (!info) continue
    activityMap.set(doc.id, info)
  }
  if (activityMap.size === 0) return { coaches: [], settleAtStudio }

  // Group templates by provider so a provider's busy sessions are queried once.
  const byProvider = new Map<string, WindowTemplate[]>()
  for (const t of templates) {
    const offersBookable = (t.activityIds ?? []).some((id) => activityMap.has(id))
    if (!offersBookable) continue
    const arr = byProvider.get(t.providerId)
    if (arr) arr.push(t)
    else byProvider.set(t.providerId, [t])
  }
  if (byProvider.size === 0) return { coaches: [], settleAtStudio }

  // One bounded read for the whole answer, before the per-provider loop: the
  // label belongs to the place, so resolving it inside the loop would re-read
  // the same document once per coach who teaches there.
  const referencedPlaceIds = new Set<string>()
  for (const list of byProvider.values()) for (const t of list) if (t.placeId) referencedPlaceIds.add(t.placeId)
  const team = teamSnap.data() as { org_id?: string; organization_ids?: string[] } | undefined
  const orgIds = [...new Set([team?.org_id, ...(team?.organization_ids ?? [])].filter((id): id is string => !!id))]
  const placeNames = await resolvePlaceNames(db, data.teamId, orgIds, referencedPlaceIds)

  interface ActivityAccumulator {
    activityId: string
    activityName: string
    placeId: string | null
    placeName: string | null
    durations: ActivityDuration[]
    memberBenefit?: ActivityMemberBenefit | Benefit
    durationBenefits?: ActivityDurationBenefit[]
    cancellationPolicy: string | null
    contactFields: BookingContactField[] | null
    maxDatesPerBooking: number
    location: string | null
    onlineUrl: string | null
    daysMap: Map<number, Record<string, Set<number>>>
  }

  const coaches: ListAvailabilityCoach[] = []
  for (const [providerId, providerTemplates] of byProvider) {
    // Busy = this provider's slot-blocking sessions overlapping the range —
    // EXPIRED paid-booking holds don't block (lazy release, see
    // appointmentSlotBlocked): a lapsed checkout must free its slot immediately,
    // not wait for the daily sweep.
    const busySnap = await db
      .collection('sessions')
      .where('teamId', '==', data.teamId)
      .where('providerId', '==', providerId)
      .where('start', '>=', Timestamp.fromMillis(nowMs - MAX_SESSION_MS))
      .where('start', '<=', Timestamp.fromMillis(toMs))
      .get()
    const busy: BusyInterval[] = busySnap.docs
      .map((d) => d.data())
      .filter((s) => appointmentSlotBlocked(s as { status?: string; hold_expires_at?: Timestamp | null }, nowMs))
      .map((s) => ({ start: (s.start as Timestamp).toMillis(), end: (s.end as Timestamp).toMillis() }))

    // Provider time-off (availability_exceptions) OVERRIDES the templates — each
    // window is an extra busy interval, so accumulateCandidates skips any slot
    // that overlaps it (a coach off "this week"/"this day"/"this slot").
    const exSnap = await db
      .collection(AVAILABILITY_EXCEPTIONS_COLLECTION)
      .where('teamId', '==', data.teamId)
      .where('providerId', '==', providerId)
      .get()
    for (const d of exSnap.docs) {
      const e = d.data()
      const s = (e.start as Timestamp).toMillis()
      const en = (e.end as Timestamp).toMillis()
      if (en > nowMs && s < toMs) busy.push({ start: s, end: en })
    }

    // GROUP BY (provider, activity, PLACE), merge days across a provider's
    // several availabilities that offer the same activity AT THE SAME PLACE
    // (e.g. "Saturday mornings" AND "Weekday evenings", both at the Hallenbad).
    // The key, and why the place is in it, is `availabilityBucketKey` above.
    const activityAcc = new Map<string, ActivityAccumulator>()
    for (const tpl of providerTemplates) {
      const offered = (tpl.activityIds ?? []).filter((id) => activityMap.has(id))
      for (const activityId of offered) {
        const info = activityMap.get(activityId)!
        const accKey = availabilityBucketKey(activityId, tpl)
        let acc = activityAcc.get(accKey)
        if (!acc) {
          acc = {
            activityId,
            activityName: info.name,
            placeId: tpl.placeId ?? null,
            placeName: tpl.placeId ? (placeNames.get(tpl.placeId) ?? null) : null,
            durations: info.durations,
            memberBenefit: info.memberBenefit,
            durationBenefits: info.durationBenefits,
            cancellationPolicy: info.cancellationPolicy ?? null,
            contactFields: info.contactFields ?? null,
            maxDatesPerBooking: info.maxDatesPerBooking,
            location: tpl.location ?? null,
            onlineUrl: tpl.onlineUrl ?? null,
            daysMap: new Map(),
          }
          activityAcc.set(accKey, acc)
        }
        accumulateCandidates(tpl, info.durations.map((d) => d.minutes), busy, nowMs, toMs, acc.daysMap)
      }
    }

    const activities: ListAvailabilityActivity[] = []
    for (const acc of activityAcc.values()) {
      const days: ListAvailabilityDay[] = [...acc.daysMap.entries()]
        .map(([dayMs, byDur]) => ({
          dayMs,
          slotsByDuration: Object.fromEntries(
            Object.entries(byDur).map(([dur, set]) => [dur, [...set].sort((a, b) => a - b)])
          ),
        }))
        .sort((a, b) => a.dayMs - b.dayMs)
      if (days.length) {
        activities.push({
          activityId: acc.activityId,
          activityName: acc.activityName,
          // Priced duration menu so the picker can show prices per length.
          // `benefitOnly` rides along because the picker must be able to say
          // "not sold individually — {pack} opens it" instead of rendering a
          // free-looking slot the server will refuse (UX-70).
          durations: acc.durations.map((d) => {
            const sale = resolveDurationSale(d)
            // Only a party the booking callables honor; absent for one person,
            // so an installed member app reads exactly the shape it always has.
            const party = resolveDurationParty(d)
            return {
              minutes: d.minutes,
              priceAmount: sale.priceAmount,
              benefitOnly: sale.mode === 'benefit_only',
              ...(party ? { party } : {}),
            }
          }),
          // Verbatim from the activity — the picker mirrors the resolver
          // (resolveEffectiveAppointmentPrice) for display; the server always
          // re-resolves authoritatively at booking/checkout.
          memberBenefit: acc.memberBenefit ?? null,
          durationBenefits: acc.durationBenefits ?? null,
          // Display-only; the picker falls back to the team-wide default.
          cancellationPolicy: acc.cancellationPolicy,
          // Extends the team-wide contact-field list on the guest step.
          contactFields: acc.contactFields,
          // Only when a basket is offered: a one-date offer answers in the
          // shape every installed client already reads.
          ...(acc.maxDatesPerBooking > 1 ? { maxDatesPerBooking: acc.maxDatesPerBooking } : {}),
          placeId: acc.placeId,
          placeName: acc.placeName,
          location: acc.location,
          onlineUrl: acc.onlineUrl,
          days,
        })
      }
    }
    if (activities.length) {
      coaches.push({ providerId, providerName: providerTemplates[0].providerName, activities })
    }
  }

  return { coaches, settleAtStudio }
})

// ─── bookAppointment (public) — the FREE path ──────────────────────────────────
// Composes the shared appointments/booking.ts helpers. THE PRICE IS THE GATE —
// appointments have no access gate any more: a guest may always attempt to
// book. Only the PRICE gate can refuse: a priced duration whose effective price
// (base, or the caller's resolved member-benefit price) is an AMOUNT refuses
// here; the client must use createAppointmentCheckout instead. An unpriced
// duration always resolves free, for anyone.

export const bookAppointment = onCall(async (request) => {
  await checkoutRateLimit(request.rawRequest?.ip, 'book-appointment')
  const data = request.data as {
    teamId?: string
    providerId?: string
    activityId?: string
    startMs?: number
    durationMinutes?: number
    contactDetails?: { firstname: string; lastname: string; email: string; phone?: string }
    authenticatedContactId?: string
    verificationCodeId?: string
    /** Ticks from the waiver step — see waivers/gate.ts. */
    waiverAcceptances?: unknown
    /** Answers to the studio's book-form contact fields — narrowed server side
     *  against the resolved list. See booking/contactFields.ts. */
    contactFieldAnswers?: Record<string, unknown>
    /** A party length: how many people, the booker included. See party.ts. */
    people?: number
    /** The companions' names, one per person beyond the booker. */
    participants?: string[]
    /** A BASKET: several starts booked as one, up to the offer's
     *  `maxDatesPerBooking`. See basket.ts. */
    startMsList?: number[]
  }
  if (
    !data?.teamId ||
    !data?.providerId ||
    !data?.activityId ||
    typeof data.durationMinutes !== 'number'
  ) {
    throw new HttpsError(
      'invalid-argument',
      'teamId, providerId, activityId, startMs and durationMinutes are required'
    )
  }
  const { teamId, providerId, activityId, durationMinutes } = data
  // One date or a basket; the offer's own limit is checked once it is loaded.
  const starts = readBasketStarts(data, BASKET_MAX_DATES)

  const contexts = await loadBasketContexts({ teamId, providerId, activityId, starts, durationMinutes })
  const ctx = contexts[0]
  // Checked BEFORE the caller is resolved: that call spends the one-time code,
  // and a party the length cannot take is the caller's to fix, not a reason to
  // make them verify their email again.
  const party = readAppointmentParty(ctx.chosenDuration, data)
  const caller = await resolveAppointmentCaller(request, { ...data, teamId })
  // THE ONE READER, here as everywhere: the member rule for the length being
  // booked, falling back to the activity-wide one on a tenant that predates
  // per-length rules.
  const durationRule = resolveDurationBenefit(ctx.activity, ctx.chosenDuration.minutes)

  // ── Price gate — the ONLY gate. The shared resolver answers covered /
  // spend_credits / pay for this caller (guests always land on base price).
  const snapshot = caller.authenticatedContact
    ? await loadContactPaymentSnapshot({
        teamId,
        contact: caller.authenticatedContact,
        // The rule for THE LENGTH BEING BOOKED, not the activity's — an
        // appointment carries one per session length now.
        relevantTypeIds:
          normalizeBenefit(durationRule)?.subscriptionTypeIds ?? [],
      })
    : GUEST_SNAPSHOT
  const priced = resolvePaymentOptions(snapshot, {
    kind: 'appointment',
    duration: ctx.chosenDuration,
    benefit: durationRule,
    people: party.people,
    quantity: starts.length,
  })
  const priceOption = priced.options[0]

  // ── A PRICE THE STUDIO CANNOT TAKE ONLINE IS SETTLED AT THE DOOR ──────────
  // A payable caller normally bounces here so the client can open Stripe
  // Checkout. That refusal only makes sense if there is a checkout to open: a
  // studio with no chargeable Connect account had `createAppointmentCheckout`
  // fail too, and the picker rendered the pair as "This slot is no longer
  // available" — a false sentence about a slot that was fine.
  //
  // Franco's call (2026-08-28): book it, and settle in person. The booking is
  // confirmed and carries what is OWED, which is the state
  // `markAppointmentPaid` already exists to clear — the same shape the staff
  // 'link' rail produces when its payment has not arrived yet. No new
  // settlement concept, no second ledger.
  //
  // Note this is the ONE place a public caller can create an unpaid-but-
  // confirmed appointment, and it is gated on a fact the caller cannot
  // influence: whether the studio finished Connect onboarding.
  const settleAtStudio = !paymentsAreChargeable(ctx.team.payments as EnabledTeam['payments'])
  // PER BOOKING: each date of a basket owes its own share, so settling one date
  // at the desk (`markAppointmentPaid`) closes exactly that date.
  const owedAtStudio =
    priceOption?.type === 'pay' && settleAtStudio
      ? (priceOption.basket?.lessonAmount ?? priceOption.amount)
      : null

  if (priceOption?.type === 'pay' && !settleAtStudio) {
    throw new HttpsError('failed-precondition', 'This duration requires payment.', {
      reason: 'payment_required',
      priceAmount: priceOption.amount,
    })
  }
  // NO OPTION AT ALL — a benefit_only length (UX-70) the caller has no way into.
  // This branch must exist and must come BEFORE the free path: without it an
  // empty options array falls straight through to "books without spending",
  // which is the free one-to-one the whole feature exists to prevent. The
  // resolver's denial is passed through verbatim so the picker can say sign in
  // vs buy the pack.
  if (!priceOption) {
    throw new HttpsError('failed-precondition', 'This duration is not sold individually.', {
      reason: priced.denial ?? 'no_subscription',
    })
  }
  // Free path: 'covered' (unpriced, or included via an unmetered subscription)
  // books without spending; 'spend_credits' burns one credit transactionally.
  const creditSpendTypeId =
    priceOption?.type === 'spend_credits' ? priceOption.via.subscriptionTypeId : null
  const viaSubscriptionTypeId =
    priceOption?.type === 'spend_credits'
      ? priceOption.via.subscriptionTypeId
      : priceOption?.type === 'covered' && priceOption.via.reason === 'benefit_included'
        ? priceOption.via.subscriptionTypeId
        : null

  // ── The waiver gate — after the caller is identified, before the contact is
  // created. Everything above is a read; `resolveOrCreateAppointmentContact`
  // below is the first write, so a refusal here costs nothing.
  //
  // The one cost that IS real on this rail is upstream and unavoidable:
  // `resolveAppointmentCaller` marks the OTP code used at its own entry, so a
  // refusal that sends the caller back to the email step costs them one
  // re-verification against a three-per-hour budget. That is why the picker
  // presents the step BEFORE calling this callable rather than reacting to the
  // refusal — the refusal is the floor, not the plan. ──
  const waiverNowMs = Date.now()
  let waiverOutcome = await enforceWaiverGate({
    teamId,
    activityId,
    subject: {
      contactId: caller.authenticatedContact?.id ?? null,
      name: `${caller.sanitized.firstname} ${caller.sanitized.lastname}`.trim(),
      email: caller.sanitized.email,
    },
    submissions: parseWaiverSubmissions(data.waiverAcceptances),
    source: 'appointment',
    // See the same three-way distinction in bookSession: an OTP proves control
    // of that mailbox, a contact session identifies only the contact.
    signerEmailVerifiedBy: data.authenticatedContactId
      ? 'verified_code'
      : caller.authenticatedContact
        ? 'session'
        : 'none',
    // The address that strength is ABOUT — the mailbox the code went to, which
    // on this rail is routinely a parent's rather than the subject's. null on
    // the session and guest paths.
    signerEmail: caller.verifiedEmail,
    ip: request.rawRequest?.ip ?? null,
    userAgent: (request.rawRequest?.headers?.['user-agent'] as string | undefined) ?? null,
    locale: null,
    nowMs: waiverNowMs,
  })

  // ── Resolve/create the contact — guests are always allowed now (no access gate). ──
  const { contactId, isNewContact } = await resolveOrCreateAppointmentContact({
    teamId,
    plan: ctx.plan,
    sanitized: caller.sanitized,
    authenticatedContact: caller.authenticatedContact,
    // The book form's contact-field answers, already narrowed against the
    // team + activity list. `{}` — and no extra read — when none were sent.
    contactFieldPatch: await resolveContactFieldPatchForBooking({
      teamId,
      team: ctx.team,
      activityContactFields: ctx.activity.contactFields,
      answers: data.contactFieldAnswers,
      existing: caller.authenticatedContact,
    }),
  })
  waiverOutcome = attachWaiverContact(waiverOutcome, contactId)

  // ── Overlap-safe create (transaction) ──
  // A BASKET holds every date at its own shared address, each booking with its
  // own token derived from one secret (basket.ts says why). One date keeps the
  // attempt's token and books exactly as before.
  const attemptToken = generateSecureToken()
  const basket = starts.length > 1 ? newBasketIdentity(attemptToken) : null
  const holds = contexts.map((c) => {
    const sessionId = appointmentSessionId(providerId, c.start.getTime())
    return {
      c,
      sessionRef: admin.firestore().collection('sessions').doc(sessionId),
      token: basket ? basketDateToken(basket.secret, sessionId) : attemptToken,
    }
  })

  const sessionDocFor = (c: typeof ctx) => ({
    teamId,
    templateId: c.tpl.id,
    origin: 'window',
    activityType: 'appointment',
    // The session INHERITS FROM THE ACTIVITY: name/capacity come from the
    // offering the client picked, not the schedule — exactly like a class.
    // NOTE: no accessRule any more — appointments dropped the gate entirely.
    activityId,
    activityName: c.activity.name,
    // Denormalised from the activity — see `autoConfirm` above.
    autoConfirm: c.autoConfirm,
    providerId,
    providerName: c.providerName,
    start: Timestamp.fromDate(c.start),
    end: Timestamp.fromDate(c.end),
    duration_minutes: durationMinutes,
    // An appointment is a provider's exclusive time — one booking per slot, by
    // definition. trackBookings reads this to drive the 'full' flip.
    max_participants: 1,
    bookings_count: 1,
    // Where, from the matched availability (the *when*). The window now carries
    // a structured PLACE the way a session does, with the free-text `location`
    // demoted to a note beside it — so both travel, or the place a studio picked
    // on the window would be stored and then silently dropped from every session
    // booked against it.
    ...(c.tpl.placeId ? { placeId: c.tpl.placeId } : {}),
    ...(c.tpl.roomId ? { roomId: c.tpl.roomId } : {}),
    location: c.tpl.location ?? null,
    onlineUrl: c.tpl.onlineUrl ?? null,
    allowBooking: true,
    status: 'full',
    has_bookings: true,
    last_booking_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
  })
  const bookingDocFor = (h: (typeof holds)[number]) => ({
    firstname: caller.sanitized.firstname,
    lastname: caller.sanitized.lastname,
    email: caller.sanitized.email,
    phone: caller.sanitized.phone,
    contact: contactId,
    session: h.sessionRef.id,
    teamId,
    joinedAt: FieldValue.serverTimestamp(),
    fromBioLink: true,
    is_new_contact: isNewContact,
    booking_token: h.token,
    ...(basket ? { basket_id: basket.basketId } : {}),
    authenticated_booking: !!caller.authenticatedContact,
    // The resolved member-benefit type (free/discount), if any — not an access
    // gate match any more, just which benefit (if any) priced this booking.
    subscription_type_id: viaSubscriptionTypeId,
    ...partyBookingFields(party),
    // The slot is taken the moment it's booked either way (bookings_count: 1
    // above, unconditionally) — only the booking's own status differs by
    // autoConfirm; a non-auto-confirm appointment still holds capacity but
    // stays unconfirmed until the studio confirms it.
    ...(ctx.autoConfirm && {
      status: 'confirmed' as const,
      fullname: `${caller.sanitized.firstname} ${caller.sanitized.lastname}`,
    }),
    ...(waiverOutcome.bookingWaiverState
      ? { waiver_state: waiverOutcome.bookingWaiverState }
      : {}),
    // OWED, NOT PAID. `payment_status: 'required'` is exactly what the staff
    // 'link' rail writes while a payment is outstanding, so the studio's own
    // settlement action (`markAppointmentPaid`) closes this booking with no
    // new branch — it flips this to 'paid' and stamps `settled_offline`.
    ...(owedAtStudio !== null
      ? {
          payment_status: 'required' as const,
          amount_due: owedAtStudio,
          settle_at_studio: true,
        }
      : {}),
  })

  if (!basket) {
    const h = holds[0]
    await runAppointmentSlotTransaction({
      sessionRef: h.sessionRef,
      sessionDoc: sessionDocFor(h.c),
      bookingDocId: contactId,
      bookingDoc: bookingDocFor(h),
      teamId,
      providerId,
      startMs: h.c.start.getTime(),
      endMs: h.c.end.getTime(),
      bufferMs: h.c.bufferMs,
      creditSpend: creditSpendTypeId ? { contactId, subscriptionTypeId: creditSpendTypeId } : undefined,
      // The acceptance rides INSIDE the slot transaction — the free path's seat
      // and its signature commit together or not at all.
      waiverLedger: { accepts: waiverOutcome.accepts, nowMs: waiverNowMs },
    })
  } else {
    // ── A BASKET, IN TWO PHASES ──────────────────────────────────────────────
    // A free booking written straight to 'full' cannot be given back by the
    // ownership executor, and half a basket is the one outcome US-07 forbids.
    // So every date is first HELD exactly as a paid checkout holds it, then all
    // are confirmed in ONE transaction. A refusal while holding gives back
    // every hold already taken; a crash between the phases leaves holds that
    // lapse on their own deadline like any abandoned checkout.
    const holdUntil = Timestamp.fromMillis(Date.now() + BASKET_FREE_HOLD_MINUTES * 60_000)
    const acquired: (typeof holds)[number][] = []
    try {
      for (const [i, h] of holds.entries()) {
        await runAppointmentSlotTransaction({
          sessionRef: h.sessionRef,
          sessionDoc: { ...sessionDocFor(h.c), status: 'pending_payment', hold_expires_at: holdUntil },
          bookingDocId: contactId,
          // Shaped as a checkout hold's booking, so a lapsed one is reclaimed
          // and swept by the same rules.
          bookingDoc: { ...bookingDocFor(h), status: 'pending', payment_status: 'required', expires_at: holdUntil },
          teamId,
          providerId,
          startMs: h.c.start.getTime(),
          endMs: h.c.end.getTime(),
          bufferMs: h.c.bufferMs,
          allowRewriteByHolder: contactId,
          // The acceptance is a fact about the person, recorded once.
          ...(i === 0 ? { waiverLedger: { accepts: waiverOutcome.accepts, nowMs: waiverNowMs } } : {}),
        }).catch((err: unknown) => {
          if (err instanceof HttpsError && err.code === 'failed-precondition') {
            throw new HttpsError('failed-precondition', err.message, {
              reason: 'date_unavailable',
              startMs: h.c.start.getTime(),
            })
          }
          throw err
        })
        acquired.push(h)
      }
      // Every date confirmed together, or none: each still ours, then written.
      await admin.firestore().runTransaction(async (tx) => {
        const read = await Promise.all(
          holds.map((h) =>
            Promise.all([tx.get(h.sessionRef), tx.get(h.sessionRef.collection('bookings').doc(contactId))])
          )
        )
        read.forEach(([sSnap, bSnap], i) => {
          if (sSnap.data()?.status !== 'pending_payment' || bSnap.data()?.booking_token !== holds[i].token) {
            throw new HttpsError('failed-precondition', 'This time was just taken. Please pick another.', {
              reason: 'date_unavailable',
              startMs: holds[i].c.start.getTime(),
            })
          }
        })
        for (const h of holds) {
          tx.set(h.sessionRef, { status: 'full', hold_expires_at: FieldValue.delete() }, { merge: true })
          tx.set(h.sessionRef.collection('bookings').doc(contactId), bookingDocFor(h))
        }
      })
    } catch (err) {
      // Every hold THIS call took, proven by its own token (census entry in
      // appointments/holdRelease.ts).
      for (const h of acquired) {
        await releaseAppointmentHold({
          teamId,
          sessionId: h.sessionRef.id,
          contactId,
          bookingToken: h.token,
          label: 'bookAppointment basket',
        }).catch((releaseErr: unknown) => console.error('[appointments] basket release failed:', releaseErr))
      }
      throw err
    }
  }

  // A contact this booking created already counts one pending booking.
  const newPending = holds.length - (isNewContact ? 1 : 0)
  if (newPending > 0) {
    await to(
      admin
        .firestore()
        .collection('contacts')
        .doc(contactId)
        .update({ pending_bookings_count: FieldValue.increment(newPending) })
    )
  }

  // ── Emails (confirmation + .ics + coach notification) ──
  // Locale-pinned to the studio's language, like the mail it goes into — an
  // unprefixed link opens in the reader's browser language instead.
  const cancelUrlFor = (token: string) =>
    ctx.teamSlug
      ? localizedPublicUrl(getHostingUrl(), ctx.lang, ctx.teamSlug, 'appointments/cancel', { token })
      : null
  const cancelUrl = cancelUrlFor(holds[0].token)
  await sendAppointmentBookingEmails({
    teamId,
    teamName: ctx.teamName,
    lang: ctx.lang,
    activityName: ctx.activity.name,
    providerId,
    providerName: ctx.providerName,
    start: ctx.start,
    end: ctx.end,
    location: ctx.tpl.location ?? null,
    onlineUrl: ctx.tpl.onlineUrl ?? null,
    cancelUrl,
    bookingId: `${holds[0].sessionRef.id}-${contactId}`,
    // A basket: ONE confirmation listing every date, each with its own cancel
    // link and calendar entry.
    ...(basket
      ? {
          dates: holds.map((h) => ({
            start: h.c.start,
            end: h.c.end,
            cancelUrl: cancelUrlFor(h.token),
            bookingId: `${h.sessionRef.id}-${contactId}`,
          })),
        }
      : {}),
    // FREE BY CONSTRUCTION. This callable refuses a payable caller outright
    // (`payment_required` above) — the money rail is createAppointmentCheckout →
    // the Connect webhook, which sends its own confirmation as a receipt. A
    // credit-pack spend also lands here and is NOT counted as paid, exactly as
    // the class free path treats one: `bookingWasPaidFor` reads money and gift
    // cards, and widening it is a decision for the predicate, not for a mailer.
    wasPaidFor: false,
    client: caller.sanitized,
  })

  return { success: true }
})
