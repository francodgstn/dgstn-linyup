import type { AcquisitionStage, Contact, ContactEntry, ContactGender, ContactSource } from '../types/contact'
import type { EngagementBand, EngagementThresholds } from '../types/engagement'
import { computeEngagementBand } from '../types/engagement'
import type { HeldPlan, HeldPlanSource, HeldPlanStatus } from '../types/planHoldings'
import { isExpiredAppointmentHold, seatsFree, type Session } from '../types/session'
import { isSessionCancelled } from '../utils/sessionStatus'
import { contactAttentionReasons, type ContactAttentionReason } from '../utils/contactFilter'
import { contactLifecycle, type ContactLifecycle } from '../utils/contactLifecycle'
import { toMinorUnits } from '../utils/money'

// ─── Public API projections — values out, never documents ───────────────────
//
// docs/public-api.md → "The read layer". Each projection builds its output
// field by field from the fields `fieldCatalog.ts` classifies as exposed (or
// pii, under that scope). No spread, no `...doc`, no pass-through object: the
// sentinel test (functions/src/api/projections.test.ts) sets every excluded
// field to a string nobody could produce by accident and pins that none of them
// comes out.
//
// Wire conventions, decided once here: snake_case keys with an `object` field;
// money as integer MINOR units beside its currency (storage mixes major and
// minor — this is the one place it is normalised); instants as ISO 8601 UTC.
// Pure and client-safe: no Firebase import, timestamps read by shape.

export interface ApiProjectionContext {
  nowMs: number
  /** The team's currency, for amounts stored without one. */
  currency: string
  engagementThresholds?: EngagementThresholds
  /** `contacts:read:pii` is granted AND usable. */
  pii: boolean
  /** The team's display zone, for date-only values (a birthdate). */
  timeZone?: string
}

/** Milliseconds from a Firestore Timestamp (either SDK), `{seconds}`, a Date or a number. */
export function apiTimeMs(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis(): number }).toMillis()
  }
  const seconds = (value as { seconds?: unknown }).seconds
  if (typeof seconds === 'number') {
    const nanos = (value as { nanoseconds?: unknown }).nanoseconds
    return seconds * 1000 + (typeof nanos === 'number' ? Math.floor(nanos / 1e6) : 0)
  }
  return null
}

export function apiIsoTime(value: unknown): string | null {
  const ms = apiTimeMs(value)
  return ms === null ? null : new Date(ms).toISOString()
}

function apiDate(value: unknown, timeZone: string): string | null {
  const ms = apiTimeMs(value)
  if (ms === null) return null
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

export interface ApiMoney {
  /** Integer minor units (Rappen, cents). */
  amount: number
  currency: string
}

export function apiMoneyFromMajor(major: number | null | undefined, currency: string): ApiMoney | null {
  return typeof major === 'number' && Number.isFinite(major) ? { amount: toMinorUnits(major), currency } : null
}

export function apiStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function apiStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// ─── contact ─────────────────────────────────────────────────────────────────

export interface ApiHeldPlan {
  plan_id: string
  plan_name: string | null
  source: HeldPlanSource
  status: HeldPlanStatus
  starts_at: string | null
  ends_at: string | null
  next_charge_at: string | null
  recurrence: string | null
  price: ApiMoney | null
  credits_remaining: number | null
}

export interface ApiContactAddress {
  street: string | null
  street_number: string | null
  postal_code: string | null
  locality: string | null
}

/** A deleted or anonymised contact is never projected, so it has no lifecycle here. */
export type ApiContactLifecycle = Exclude<ContactLifecycle, 'deleted'>

export interface ApiContact {
  object: 'contact'
  id: string
  first_name: string | null
  last_name: string | null
  lifecycle: ApiContactLifecycle
  journey: {
    stage: AcquisitionStage | null
    entry: ContactEntry | null
    source: ContactSource | null
    trial_booked_at: string | null
    trial_attended_at: string | null
    converted_at: string | null
    pending_signup: boolean
  }
  affiliation: { has_active: boolean }
  plans: ApiHeldPlan[]
  credits: Array<{ plan_id: string; plan_name: string | null; remaining: number; next_expires_at: string | null }>
  attendance: {
    total_sessions: number
    last_session_at: string | null
    engagement_band: EngagementBand
  }
  attention_reasons: ContactAttentionReason[]
  assigned_coach_ids: string[]
  group_ids: string[]
  tags: string[]
  created_at: string | null
  /** Present only under `contacts:read:pii`. */
  email?: string | null
  phone?: string | null
  gender?: ContactGender | null
  birthdate?: string | null
  address?: ApiContactAddress | null
}

function projectHeldPlan(plan: HeldPlan, currency: string): ApiHeldPlan {
  return {
    plan_id: plan.subscription_type_id,
    plan_name: apiStr(plan.subscription_type_name),
    source: plan.source,
    status: plan.status,
    starts_at: apiIsoTime(plan.starts_at_ms),
    ends_at: apiIsoTime(plan.ends_at_ms),
    next_charge_at: apiIsoTime(plan.next_charge_at_ms),
    recurrence: apiStr(plan.recurrence),
    price: apiMoneyFromMajor(plan.amount, currency),
    credits_remaining: typeof plan.credits_remaining === 'number' ? plan.credits_remaining : null,
  }
}

/**
 * A contact as the API returns it, or null when it must not be returned at all
 * (deleted or anonymised — `contactLifecycle` decides, never a field test).
 */
export function projectContact(contact: Contact, ctx: ApiProjectionContext): ApiContact | null {
  const lifecycle = contactLifecycle(contact)
  if (lifecycle === 'deleted') return null

  const lastSessionMs = apiTimeMs(contact.last_session_at)
  const out: ApiContact = {
    object: 'contact',
    id: contact.id,
    first_name: apiStr(contact.firstname),
    last_name: apiStr(contact.lastname),
    lifecycle,
    journey: {
      stage: contact.acquisition_stage ?? null,
      entry: contact.entry ?? null,
      source: contact.source ?? null,
      trial_booked_at: apiIsoTime(contact.trial_booked_at),
      trial_attended_at: apiIsoTime(contact.trial_attended_at),
      converted_at: apiIsoTime(contact.converted_at),
      pending_signup: contact.pending_signup === true,
    },
    affiliation: { has_active: contact.affiliation_summary?.has_active === true },
    plans: Array.isArray(contact.held_plans) ? contact.held_plans.map((p) => projectHeldPlan(p, ctx.currency)) : [],
    credits: Array.isArray(contact.credit_summary)
      ? contact.credit_summary.map((c) => ({
          plan_id: c.subscription_type_id,
          plan_name: apiStr(c.subscription_type_name),
          remaining: c.remaining,
          next_expires_at: apiIsoTime(c.next_expires_at),
        }))
      : [],
    attendance: {
      total_sessions: typeof contact.total_sessions === 'number' ? contact.total_sessions : 0,
      last_session_at: apiIsoTime(contact.last_session_at),
      engagement_band: computeEngagementBand(
        lastSessionMs ?? apiTimeMs(contact.created_at),
        ctx.engagementThresholds,
        ctx.nowMs
      ),
    },
    attention_reasons: contactAttentionReasons(contact, {
      nowMs: ctx.nowMs,
      engagementThresholds: ctx.engagementThresholds,
    }),
    assigned_coach_ids: apiStrings(contact.assigned_coach_ids),
    group_ids: apiStrings(contact.group_ids),
    tags: apiStrings(contact.tags),
    created_at: apiIsoTime(contact.created_at),
  }

  if (ctx.pii) {
    // Written out field by field, like everything above, for the sentinel test.
    out.email = apiStr(contact.email)
    out.phone = apiStr(contact.phone)
    out.gender = contact.gender ?? null
    out.birthdate = apiDate(contact.birthdate, ctx.timeZone ?? 'Europe/Zurich')
    out.address = contact.address
      ? {
          street: apiStr(contact.address.route),
          street_number: apiStr(contact.address.street_number),
          postal_code: apiStr(contact.address.postal_code),
          locality: apiStr(contact.address.locality),
        }
      : null
  }
  return out
}

// ─── session ─────────────────────────────────────────────────────────────────

export type ApiSessionStatus = 'open' | 'full' | 'cancelled' | 'pending_payment'

export interface ApiSession {
  object: 'session'
  id: string
  activity: { id: string | null; name: string | null; type: 'class' | 'appointment' }
  start: string | null
  end: string | null
  duration_minutes: number | null
  location: string | null
  place_id: string | null
  room_id: string | null
  provider: { id: string; name: string | null } | null
  /** Null = no cap. */
  capacity: number | null
  booked: number
  waitlisted: number
  attended: number
  trial_bookings: number
  status: ApiSessionStatus
  booking: { allowed: boolean; required: boolean }
  headline: string | null
  headline_public: boolean
  series_id: string | null
  tags: string[]
}

export function apiCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * A session as the API returns it, or null when it is not a session a studio
 * would call one: a manager's blocked time, or an appointment hold whose
 * payment window has lapsed (`isExpiredAppointmentHold`).
 */
export function projectSession(session: Session, ctx: { nowMs: number }): ApiSession | null {
  if (session.blocked_time === true) return null
  if (isExpiredAppointmentHold(session, ctx.nowMs)) return null

  // `full` is DERIVED from the seat count, not read from the stored status: the
  // stored value is a capacity-state snapshot that not every writer keeps in
  // step, while `bookings_count` is the recount of seat-holding bookings
  // (`bookingHoldsSeat`) and `seatsFree` is the shared capacity question.
  const booked = apiCount(session.bookings_count)
  const status: ApiSessionStatus = isSessionCancelled(session)
    ? 'cancelled'
    : session.status === 'pending_payment'
      ? 'pending_payment'
      : seatsFree(session.max_participants, booked) <= 0
        ? 'full'
        : 'open'

  return {
    object: 'session',
    id: session.id,
    activity: {
      id: apiStr(session.activityId),
      name: apiStr(session.activityName),
      type: session.activityType === 'appointment' ? 'appointment' : 'class',
    },
    start: apiIsoTime(session.start),
    end: apiIsoTime(session.end),
    duration_minutes: typeof session.duration_minutes === 'number' ? session.duration_minutes : null,
    location: apiStr(session.location),
    place_id: apiStr(session.placeId),
    room_id: apiStr(session.roomId),
    provider: session.providerId ? { id: session.providerId, name: apiStr(session.providerName) } : null,
    capacity: typeof session.max_participants === 'number' ? session.max_participants : null,
    booked,
    waitlisted: apiCount(session.waitlist_count),
    attended: apiCount(session.participants_count),
    trial_bookings: apiCount(session.trial_bookings_count),
    status,
    booking: { allowed: session.allowBooking === true, required: session.bookingMandatory === true },
    headline: apiStr(session.headline),
    headline_public: session.headlinePublic === true,
    series_id: apiStr(session.seriesId),
    tags: apiStrings(session.tags),
  }
}
