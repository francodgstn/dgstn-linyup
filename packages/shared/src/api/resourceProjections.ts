import type { Activity } from '../types/activity'
import { resolveActivityAccessRule, resolveAppointmentDurations, resolveDurationSale } from '../types/activity'
import type { MemberSubscription } from '../types/connect'
import type { Contact, SubscriptionType } from '../types/contact'
import { resolveUsageLimit } from '../types/contact'
import type { Event } from '../types/event'
import type { FinanceMonthlyReport, FinanceTotals } from '../types/finance'
import { FINANCE_TIMEZONE } from '../types/finance'
import type { Booking } from '../types/session'
import { bookingWasPaidFor } from '../types/session'
import { classAccessFacts } from '../utils/classAccess'
import { contactLifecycle } from '../utils/contactLifecycle'
import { resolveActivityDropIn, type DropInPrice } from '../utils/dropIn'
import { introOffersOf } from '../utils/introOffer'
import { subscriptionCancellation, subscriptionEndsAt, subscriptionIsCancelling } from '../utils/subscriptionLifecycle'
import { apiCount, apiIsoTime, apiMoneyFromMajor, apiStr, apiStrings, type ApiMoney } from './projections'

// ─── Public API projections: offerings, people's records, reports ───────────
//
// The same rules as projections.ts: built field by field from what
// fieldCatalog.ts exposes, pinned by the sentinel tests beside the functions'
// api tests, and every derived answer taken from the resolver that owns it.

// ─── person — who a record is about ──────────────────────────────────────────

export interface ApiPerson {
  contact_id: string
  first_name: string | null
  last_name: string | null
  /** Present only under `contacts:read:pii`. */
  email?: string | null
  phone?: string | null
}

/**
 * Who a booking, a check-in or a subscription is about, from the CONTACT
 * document — never from the copy denormalised onto the record, which outlives
 * anonymisation. Null for a deleted or anonymised person, and the caller passes
 * null for anyone it may not show.
 */
export function projectPerson(contact: Contact | null, pii: boolean): ApiPerson | null {
  if (!contact || contactLifecycle(contact) === 'deleted') return null
  const person: ApiPerson = {
    contact_id: contact.id,
    first_name: apiStr(contact.firstname),
    last_name: apiStr(contact.lastname),
  }
  if (pii) {
    person.email = apiStr(contact.email)
    person.phone = apiStr(contact.phone)
  }
  return person
}

// ─── activity ────────────────────────────────────────────────────────────────

export interface ApiActivity {
  object: 'activity'
  id: string
  name: string | null
  alternative_name: string | null
  slug: string | null
  description: string | null
  type: 'class' | 'appointment'
  color: string | null
  tags: string[]
  image_url: string | null
  active: boolean
  provider: { id: string; name: string | null } | null
  /** Classes only: who may book. */
  access: { tier: string; audience: string | null; require_plan: boolean; plan_ids: string[] } | null
  /** Classes only: the price at the door, as `resolveActivityDropIn` answers it. */
  drop_in: { enabled: boolean; price: ApiMoney | null; follows: string } | null
  /** Classes only: the first-class trial. */
  trial: { enabled: boolean; price: ApiMoney | null } | null
  waitlist_enabled: boolean
  /** Appointments only: the lengths on offer. */
  durations: Array<{ minutes: number; sale: string; price: ApiMoney | null }>
  details: {
    prerequisites: string | null
    meeting_point: string | null
    whats_included: string | null
    whats_not_included: string | null
    faq: string | null
    cancellation_policy: string | null
  }
}

/** An activity as the API returns it, or null when it is archived. */
export function projectActivity(
  activity: Activity,
  ctx: { currency: string; studioDropIn: DropInPrice | null }
): ApiActivity | null {
  if (activity.archived_at) return null
  const isAppointment = activity.type === 'appointment'
  const access = isAppointment ? null : resolveActivityAccessRule(activity)
  const accessFacts = isAppointment ? null : classAccessFacts(activity, ctx.studioDropIn)
  const dropIn = isAppointment ? null : resolveActivityDropIn(activity, ctx.studioDropIn)
  return {
    object: 'activity',
    id: activity.id,
    name: apiStr(activity.name),
    alternative_name: apiStr(activity.alternativeName),
    slug: apiStr(activity.slug),
    description: apiStr(activity.description),
    type: isAppointment ? 'appointment' : 'class',
    color: apiStr(activity.color),
    tags: apiStrings(activity.tags),
    image_url: apiStr(activity.image_url),
    active: activity.isActive !== false,
    provider: activity.providerId ? { id: activity.providerId, name: apiStr(activity.providerName) } : null,
    access: access
      ? {
          // DERIVED, like every other reader (docs/class-access-derived.md):
          // the three words the API has always used, from the class's prices.
          tier: accessFacts!.planHoldersOnly
            ? 'subscription'
            : accessFacts!.signupRequired
              ? 'members'
              : 'open',
          audience: accessFacts!.signupRequired ? 'members' : 'anyone',
          require_plan: accessFacts!.planHoldersOnly,
          plan_ids: accessFacts!.includedPlanIds,
        }
      : null,
    drop_in: dropIn
      ? {
          enabled: dropIn.enabled,
          price: dropIn.enabled ? apiMoneyFromMajor(dropIn.priceAmount, ctx.currency) : null,
          follows: dropIn.source,
        }
      : null,
    trial: isAppointment
      ? null
      : {
          enabled: activity.trialEnabled === true,
          price: activity.trialEnabled === true ? apiMoneyFromMajor(activity.trialPriceAmount, ctx.currency) : null,
        },
    waitlist_enabled: !isAppointment && activity.waitlistEnabled === true,
    durations: isAppointment
      ? resolveAppointmentDurations(activity).map((d) => {
          const sale = resolveDurationSale(d)
          return { minutes: d.minutes, sale: sale.mode, price: apiMoneyFromMajor(sale.priceAmount, ctx.currency) }
        })
      : [],
    details: {
      prerequisites: apiStr(activity.prerequisites),
      meeting_point: apiStr(activity.meetingPoint),
      whats_included: apiStr(activity.whatsIncluded),
      whats_not_included: apiStr(activity.whatsNotIncluded),
      faq: apiStr(activity.faq),
      cancellation_policy: apiStr(activity.cancellationPolicy),
    },
  }
}

// ─── plan (subscription type) ────────────────────────────────────────────────

export interface ApiPlan {
  object: 'plan'
  id: string
  name: string | null
  description: string | null
  /** `own` for the studio's plans, `partner` for a partner app's (stored as `aggregator`). */
  source: 'own' | 'partner'
  active: boolean
  public: boolean
  prices: Array<{
    id: string
    price: ApiMoney | null
    recurrence: string
    included_months: number | null
    credits: number | null
    label: string | null
    active: boolean
  }>
  usage_limit: { count: number; per: string } | null
  intro_offers: Array<{ price_id: string; periods: number; price: ApiMoney | null }>
}

export function projectPlan(type: SubscriptionType, ctx: { currency: string }): ApiPlan {
  const limit = resolveUsageLimit(type)
  return {
    object: 'plan',
    id: type.id,
    name: apiStr(type.name),
    description: apiStr(type.description),
    source: type.source === 'aggregator' ? 'partner' : 'own',
    active: type.active !== false,
    public: type.public === true,
    prices: (type.prices ?? []).map((p) => ({
      id: p.id,
      price: apiMoneyFromMajor(p.amount, ctx.currency),
      recurrence: p.recurrence,
      included_months: typeof p.included_months === 'number' ? p.included_months : null,
      credits: typeof p.credits === 'number' ? p.credits : null,
      label: apiStr(p.label),
      active: p.active !== false,
    })),
    usage_limit: limit ? { count: limit.count, per: String(limit.per) } : null,
    intro_offers: introOffersOf(type).map((o) => ({
      price_id: o.priceId,
      periods: o.periods,
      price: apiMoneyFromMajor(o.amount, ctx.currency),
    })),
  }
}

// ─── event ───────────────────────────────────────────────────────────────────

export interface ApiEvent {
  object: 'event'
  id: string
  title: string | null
  type: string
  start: string | null
  end: string | null
  location: string | null
  place_id: string | null
  room_id: string | null
  description: string | null
  fee: ApiMoney | null
  status: string
  participants: number
  attendees: number
  checked_in: number
  coach: { id: string; name: string | null } | null
  public: boolean
}

/** An event as the API returns it, or null when deleted or not the team's own. */
export function projectEvent(event: Event, ctx: { currency: string }): ApiEvent | null {
  if (event.deleted_at || event.scope === 'org') return null
  return {
    object: 'event',
    id: event.id,
    title: apiStr(event.title),
    type: String(event.type),
    start: apiIsoTime(event.start),
    end: apiIsoTime(event.end),
    location: apiStr(event.location),
    place_id: apiStr(event.placeId),
    room_id: apiStr(event.roomId),
    description: apiStr(event.description),
    fee: apiMoneyFromMajor(event.fee, ctx.currency),
    status: event.status ?? 'open',
    participants: apiCount(event.participants_count),
    attendees: apiCount(event.attendees_count),
    checked_in: apiCount(event.completed_checkins_count),
    coach: event.coachId ? { id: event.coachId, name: apiStr(event.coachName) } : null,
    public: event.publicVisibility === 'public',
  }
}

// ─── booking and attendance ──────────────────────────────────────────────────

export interface ApiBooking {
  object: 'booking'
  id: string
  session_id: string | null
  contact_id: string
  contact: ApiPerson | null
  /** An absent stored status is pending. */
  status: string
  source: string | null
  booked_at: string | null
  is_trial: boolean
  paid: boolean
  from_waitlist: boolean
  waiver_state: string | null
  rebooked_to: string | null
}

export function projectBooking(
  booking: Booking,
  ctx: { sessionId: string | null; person: ApiPerson | null }
): ApiBooking {
  return {
    object: 'booking',
    id: booking.id,
    session_id: ctx.sessionId ?? apiStr(booking.session),
    contact_id: booking.contact,
    contact: ctx.person,
    status: booking.status ?? 'pending',
    source: booking.source ?? null,
    booked_at: apiIsoTime(booking.joinedAt),
    is_trial: booking.is_new_contact === true,
    paid: bookingWasPaidFor(booking),
    from_waitlist: booking.claimed_from_waitlist === true,
    waiver_state: booking.waiver_state ?? null,
    rebooked_to: apiStr(booking.rebooked_to),
  }
}

/**
 * A `sessions/{id}/participants/{contactId}` row as `buildParticipantDoc` writes
 * it. The shared `Participant` type predates that builder and names fields the
 * writer never used, so the API reads the stored shape.
 */
export interface ParticipantRecord {
  contactId?: string
  contact?: string
  checkedInAt?: unknown
  checkedInBy?: string
  confirmedFromBooking?: boolean
}

export interface ApiAttendance {
  object: 'attendance'
  session_id: string | null
  contact_id: string
  contact: ApiPerson | null
  checked_in_at: string | null
  checked_in_by: string | null
  from_booking: boolean
}

export function projectAttendance(
  row: ParticipantRecord & { id: string },
  ctx: { sessionId: string | null; person: ApiPerson | null }
): ApiAttendance {
  return {
    object: 'attendance',
    session_id: ctx.sessionId,
    // The document id IS the contact id (buildParticipantDoc's invariant).
    contact_id: row.contactId ?? row.contact ?? row.id,
    contact: ctx.person,
    checked_in_at: apiIsoTime(row.checkedInAt),
    checked_in_by: apiStr(row.checkedInBy),
    from_booking: row.confirmedFromBooking === true,
  }
}

// ─── member subscription ─────────────────────────────────────────────────────

export interface ApiSubscription {
  object: 'subscription'
  id: string
  contact_id: string | null
  contact: ApiPerson | null
  plan: { id: string | null; name: string | null }
  recurrence: string | null
  /** Null unless the member may see money (`reports.view`). */
  price: ApiMoney | null
  status: string
  paused: boolean
  current_period_start: string | null
  current_period_end: string | null
  cancelling: boolean
  /** Null while it renews — AND on a doc cancelling without a stored date. Read `cancelling` for whether. */
  ends_at: string | null
  cancellation: {
    ended: boolean
    requested_at: string | null
    reason: string | null
    feedback: string | null
    /** Present only under `contacts:read:pii`: the member's own words. */
    comment?: string | null
  } | null
  last_payment_status: string | null
  created_at: string | null
}

export function projectSubscription(
  sub: MemberSubscription,
  ctx: { person: ApiPerson | null; amounts: boolean; pii: boolean }
): ApiSubscription {
  const record = subscriptionCancellation(sub)
  return {
    object: 'subscription',
    id: sub.subscriptionId,
    contact_id: apiStr(sub.contactId),
    contact: ctx.person,
    plan: { id: apiStr(sub.subscriptionTypeId), name: apiStr(sub.subscriptionTypeName) },
    recurrence: apiStr(sub.recurrence),
    // MemberSubscription.amount is already minor units.
    price:
      ctx.amounts && typeof sub.amount === 'number'
        ? { amount: sub.amount, currency: String(sub.currency ?? '').toUpperCase() }
        : null,
    status: String(sub.status),
    paused: !!sub.pause_collection,
    current_period_start: apiIsoTime(sub.current_period_start),
    current_period_end: apiIsoTime(sub.current_period_end),
    cancelling: subscriptionIsCancelling(sub),
    ends_at: apiIsoTime(subscriptionEndsAt(sub)),
    cancellation: record
      ? {
          ended: record.ended,
          requested_at: apiIsoTime(record.requestedAt),
          reason: record.reason ?? null,
          feedback: record.feedback ?? null,
          ...(ctx.pii ? { comment: record.comment ?? null } : {}),
        }
      : null,
    last_payment_status: apiStr(sub.last_payment_status),
    created_at: apiIsoTime(sub.created_at),
  }
}

// ─── reports ─────────────────────────────────────────────────────────────────

/** A `teams/{t}/team_weekly_reports/{iso_week}` document as `weeklyReportsForTeam` writes it. */
export interface WeeklyReportRecord {
  iso_week?: string
  active_contacts_count?: number
  contacts_count_by_stage?: Record<string, number>
  contacts_with_active_affiliation?: number
  contacts_with_active_subscription?: number
  contacts_with_aggregator_subscription?: number
  contacts_count_by_subscription_type?: Record<string, number>
  sessions_count?: number
  sessions_count_by_type?: Record<string, number>
  bookings_count?: number
  bookings_count_by_type?: Record<string, number>
  trial_conversions_count?: number
  trial_dropouts_count?: number
}

export interface ApiWeeklyReport {
  object: 'weekly_report'
  /** As stored (`2026-W37`), never recomputed. */
  iso_week: string
  /** False for a week with no stored report — its numbers are zero, not measured. */
  generated: boolean
  active_contacts: number
  contacts_by_stage: Record<string, number>
  contacts_with_active_affiliation: number
  contacts_with_plan: number
  contacts_with_partner_plan: number
  contacts_by_plan: Record<string, number>
  sessions: number
  sessions_by_type: Record<string, number>
  bookings: number
  bookings_by_type: Record<string, number>
  trial_conversions: number
  trial_dropouts: number
}

function counts(map: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (map && typeof map === 'object') {
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
  }
  return out
}

export function projectWeeklyReport(isoWeek: string, row: WeeklyReportRecord | null): ApiWeeklyReport {
  const r = row ?? {}
  return {
    object: 'weekly_report',
    iso_week: apiStr(r.iso_week) ?? isoWeek,
    generated: row !== null,
    active_contacts: apiCount(r.active_contacts_count),
    contacts_by_stage: counts(r.contacts_count_by_stage),
    contacts_with_active_affiliation: apiCount(r.contacts_with_active_affiliation),
    contacts_with_plan: apiCount(r.contacts_with_active_subscription),
    contacts_with_partner_plan: apiCount(r.contacts_with_aggregator_subscription),
    contacts_by_plan: counts(r.contacts_count_by_subscription_type),
    sessions: apiCount(r.sessions_count),
    sessions_by_type: counts(r.sessions_count_by_type),
    bookings: apiCount(r.bookings_count),
    bookings_by_type: counts(r.bookings_count_by_type),
    trial_conversions: apiCount(r.trial_conversions_count),
    trial_dropouts: apiCount(r.trial_dropouts_count),
  }
}

export type ApiFinanceTotals = FinanceTotals

export interface ApiFinanceMonth {
  object: 'finance_month'
  /** As stored (`2026-08`), bucketed in `period_time_zone`, never re-bucketed. */
  month: string
  period_time_zone: string
  /** False for a month whose report has not been generated (the running month, or no activity). */
  generated: boolean
  currencies: string[]
  transactions: number
  /** All amounts in minor units. */
  totals: ApiFinanceTotals | null
  by_category: Record<string, ApiFinanceTotals>
  by_source: Record<string, ApiFinanceTotals>
  refunds: { count: number; amount: number } | null
  payouts: { count: number; total: number } | null
}

function totals(t: unknown): ApiFinanceTotals | null {
  if (!t || typeof t !== 'object') return null
  const x = t as Partial<FinanceTotals>
  return {
    gross: apiCount(x.gross),
    stripe_fees: apiCount(x.stripe_fees),
    platform_fees: apiCount(x.platform_fees),
    net: apiCount(x.net),
    count: apiCount(x.count),
  }
}

function totalsMap(map: unknown): Record<string, ApiFinanceTotals> {
  const out: Record<string, ApiFinanceTotals> = {}
  if (map && typeof map === 'object') {
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      const t = totals(v)
      if (t && t.count > 0) out[k] = t
    }
  }
  return out
}

/** A month of the finance journal. `reconciliation_check` is internal and never leaves. */
export function projectFinanceMonth(month: string, report: FinanceMonthlyReport | null): ApiFinanceMonth {
  return {
    object: 'finance_month',
    month,
    period_time_zone: FINANCE_TIMEZONE,
    generated: report !== null,
    currencies: apiStrings(report?.currencies).map((c) => c.toUpperCase()),
    transactions: apiCount(report?.txn_count),
    totals: totals(report?.totals),
    by_category: totalsMap(report?.by_category),
    by_source: totalsMap(report?.by_source),
    refunds: report?.refunds ? { count: apiCount(report.refunds.count), amount: apiCount(report.refunds.amount) } : null,
    payouts: report?.payouts ? { count: apiCount(report.payouts.count), total: apiCount(report.payouts.total) } : null,
  }
}
