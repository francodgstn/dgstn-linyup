// ─── OpenAPI response schemas, checked against the projection types ─────────
//
// Each schema is written with `objectOf<T>()`, whose argument must name EVERY
// key of `T` and must list exactly T's optional keys as optional. A field added
// to a projection (`ApiContact`, `ApiSession`, …) therefore fails the typecheck
// here until it is documented, the same way `fieldCatalog.ts` makes a new
// internal field fail until it is classified. The published document cannot
// quietly fall behind what the API returns.
//
// OpenAPI 3.0.3 dialect: `nullable: true`, and a nullable reference is written
// as `allOf` + `nullable`.

import {
  ACQUISITION_STAGES,
  API_SCOPES,
  BOOKING_SOURCES,
  CONTACT_ENTRIES,
  CONTACT_SOURCES,
  ENGAGEMENT_BANDS,
  type ApiActivity,
  type ApiAttendance,
  type ApiBooking,
  type ApiContact,
  type ApiContactAddress,
  type ApiEvent,
  type ApiFinanceMonth,
  type ApiFinanceTotals,
  type ApiHeldPlan,
  type ApiMoney,
  type ApiPerson,
  type ApiPlan,
  type ApiSession,
  type ApiSubscription,
  type ApiWeeklyReport,
} from '@linyup/shared'
import type { ListPage } from '../access'
import { FILL_GROUPS, type ApiClassFill, type FillRow } from '../insights/classFill'
import type { ApiContactHistory, ApiSessionRef, ApiSessionRoster } from '../resources/people'
import type { ApiCredentialInfo, ApiTeamInfo } from '../rest'

export type JsonSchema = Record<string, unknown>

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T]

/**
 * `objectOf<T>()(properties, optional, description?)` — every key of T documented,
 * T's optional keys (and only those) listed in `optional`.
 */
export function objectOf<T>() {
  return <const O extends readonly OptionalKeys<T>[]>(
    properties: { [K in keyof Required<T>]: JsonSchema },
    optional: O &
      ([Exclude<OptionalKeys<T>, O[number]>] extends [never]
        ? unknown
        : { missingOptionalKeys: Exclude<OptionalKeys<T>, O[number]> }),
    description?: string
  ): JsonSchema => ({
    type: 'object',
    additionalProperties: false,
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties).filter((k) => !(optional as readonly string[]).includes(k)),
  })
}

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` })
const nullableRef = (name: string): JsonSchema => ({ allOf: [ref(name)], nullable: true })
const nullable = (schema: JsonSchema): JsonSchema => ({ ...schema, nullable: true })
const str = (description?: string): JsonSchema => ({ type: 'string', ...(description ? { description } : {}) })
const nstr = (description?: string): JsonSchema => nullable(str(description))
const int = (description?: string): JsonSchema => ({ type: 'integer', ...(description ? { description } : {}) })
const bool = (description?: string): JsonSchema => ({ type: 'boolean', ...(description ? { description } : {}) })
const time = (description?: string): JsonSchema => ({
  type: 'string',
  format: 'date-time',
  nullable: true,
  ...(description ? { description } : {}),
})
const arr = (items: JsonSchema, description?: string): JsonSchema => ({ type: 'array', items, ...(description ? { description } : {}) })
const oneOf = (values: readonly string[], description?: string): JsonSchema => ({
  type: 'string',
  enum: [...values],
  ...(description ? { description } : {}),
})
const constant = (value: string): JsonSchema => ({ type: 'string', enum: [value] })
const countsMap = (description?: string): JsonSchema => ({
  type: 'object',
  additionalProperties: { type: 'integer' },
  ...(description ? { description } : {}),
})

const MONEY = 'Integer minor units (Rappen, cents) beside an ISO 4217 currency.'

// ─── shared shapes ───────────────────────────────────────────────────────────

const Money = objectOf<ApiMoney>()({ amount: int('Minor units'), currency: str('ISO 4217, upper case') }, [], MONEY)

const Person = objectOf<ApiPerson>()(
  {
    contact_id: str(),
    first_name: nstr(),
    last_name: nstr(),
    email: nstr('Only with contacts:read:pii'),
    phone: nstr('Only with contacts:read:pii'),
  },
  ['email', 'phone'],
  'Who a record is about, from the contact document. Absent (null) when this connection may not name them, or they were deleted.'
)

const HeldPlan = objectOf<ApiHeldPlan>()(
  {
    plan_id: str(),
    plan_name: nstr(),
    source: oneOf(['grant', 'stripe', 'credits']),
    status: oneOf(['active', 'trialing', 'past_due', 'paused', 'cancelling']),
    starts_at: time(),
    ends_at: time(),
    next_charge_at: time(),
    recurrence: nstr(),
    price: nullableRef('Money'),
    credits_remaining: nullable(int()),
  },
  []
)

const ContactAddress = objectOf<ApiContactAddress>()(
  { street: nstr(), street_number: nstr(), postal_code: nstr(), locality: nstr() },
  []
)

const Contact = objectOf<ApiContact>()(
  {
    object: constant('contact'),
    id: str(),
    first_name: nstr(),
    last_name: nstr(),
    lifecycle: oneOf(['active', 'provisional', 'external', 'archived'], 'external = trains here without being on the roster'),
    journey: objectOf<ApiContact['journey']>()(
      {
        stage: nullable(oneOf(ACQUISITION_STAGES)),
        entry: nullable(oneOf(CONTACT_ENTRIES)),
        source: nullable(oneOf(CONTACT_SOURCES)),
        trial_booked_at: time(),
        trial_attended_at: time(),
        converted_at: time(),
        pending_signup: bool(),
      },
      []
    ),
    affiliation: objectOf<ApiContact['affiliation']>()({ has_active: bool() }, []),
    plans: arr(ref('HeldPlan')),
    credits: arr(
      objectOf<ApiContact['credits'][number]>()(
        { plan_id: str(), plan_name: nstr(), remaining: int(), next_expires_at: time() },
        []
      )
    ),
    attendance: objectOf<ApiContact['attendance']>()(
      { total_sessions: int(), last_session_at: time(), engagement_band: oneOf(ENGAGEMENT_BANDS) },
      []
    ),
    attention_reasons: arr(str(), 'Why the studio should follow this person up'),
    assigned_coach_ids: arr(str()),
    group_ids: arr(str()),
    tags: arr(str()),
    created_at: time(),
    email: nstr('Only with contacts:read:pii'),
    phone: nstr('Only with contacts:read:pii'),
    gender: nullable({ ...oneOf(['M', 'F', 'other']), description: 'Only with contacts:read:pii' }),
    birthdate: nullable({ type: 'string', format: 'date', description: 'Only with contacts:read:pii' }),
    address: { ...nullableRef('ContactAddress'), description: 'Only with contacts:read:pii' },
  },
  ['email', 'phone', 'gender', 'birthdate', 'address']
)

const Session = objectOf<ApiSession>()(
  {
    object: constant('session'),
    id: str(),
    activity: objectOf<ApiSession['activity']>()({ id: nstr(), name: nstr(), type: oneOf(['class', 'appointment']) }, []),
    start: time(),
    end: time(),
    duration_minutes: nullable(int()),
    location: nstr(),
    place_id: nstr(),
    room_id: nstr(),
    provider: nullable(objectOf<NonNullable<ApiSession['provider']>>()({ id: str(), name: nstr() }, [])),
    capacity: nullable(int('Null = no cap')),
    booked: int('Bookings holding a seat'),
    waitlisted: int(),
    attended: int(),
    trial_bookings: int(),
    status: oneOf(['open', 'full', 'cancelled', 'pending_payment'], '`full` is derived from bookings against capacity'),
    booking: objectOf<ApiSession['booking']>()({ allowed: bool(), required: bool() }, []),
    headline: nstr(),
    headline_public: bool(),
    series_id: nstr(),
    tags: arr(str()),
  },
  []
)

const bookingProperties: { [K in keyof Required<ApiBooking>]: JsonSchema } = {
  object: constant('booking'),
  id: str(),
  session_id: nstr(),
  contact_id: str(),
  contact: nullableRef('Person'),
  status: oneOf(['pending', 'confirmed', 'cancelled', 'no_show', 'rebooked']),
  source: nullable(oneOf(BOOKING_SOURCES)),
  booked_at: time(),
  is_trial: bool(),
  paid: bool(),
  from_waitlist: bool(),
  waiver_state: nstr(),
  rebooked_to: nstr(),
}
const Booking = objectOf<ApiBooking>()(bookingProperties, [])

const attendanceProperties: { [K in keyof Required<ApiAttendance>]: JsonSchema } = {
  object: constant('attendance'),
  session_id: nstr(),
  contact_id: str(),
  contact: nullableRef('Person'),
  checked_in_at: time(),
  checked_in_by: nstr(),
  from_booking: bool(),
}
const Attendance = objectOf<ApiAttendance>()(attendanceProperties, [])

const SessionRef = objectOf<ApiSessionRef>()({ id: str(), activity: nstr(), start: time(), status: str() }, [])

const SessionRoster = objectOf<ApiSessionRoster>()(
  {
    object: constant('session_roster'),
    session: ref('Session'),
    bookings: arr(ref('Booking')),
    attendance: arr(ref('Attendance')),
    hidden_bookings: int('Bookings about people this connection may not name'),
    hidden_attendance: int(),
    truncated: bool(),
  },
  []
)

const ContactHistory = objectOf<ApiContactHistory>()(
  {
    object: constant('contact_history'),
    contact: ref('Contact'),
    bookings: arr(
      objectOf<ApiContactHistory['bookings'][number]>()({ ...bookingProperties, session: ref('SessionRef') }, [])
    ),
    attendance: arr(
      objectOf<ApiContactHistory['attendance'][number]>()({ ...attendanceProperties, session: ref('SessionRef') }, [])
    ),
  },
  []
)

const Activity = objectOf<ApiActivity>()(
  {
    object: constant('activity'),
    id: str(),
    name: nstr(),
    alternative_name: nstr(),
    slug: nstr(),
    description: nstr(),
    type: oneOf(['class', 'appointment']),
    color: nstr(),
    tags: arr(str()),
    image_url: nstr(),
    active: bool(),
    provider: nullable(objectOf<NonNullable<ApiActivity['provider']>>()({ id: str(), name: nstr() }, [])),
    access: nullable(
      objectOf<NonNullable<ApiActivity['access']>>()(
        { tier: str(), audience: nstr(), require_plan: bool(), plan_ids: arr(str()) },
        [],
        'Classes only: who may book'
      )
    ),
    drop_in: nullable(
      objectOf<NonNullable<ApiActivity['drop_in']>>()(
        { enabled: bool(), price: nullableRef('Money'), follows: oneOf(['studio', 'custom', 'off']) },
        [],
        'Classes only: the price at the door'
      )
    ),
    trial: nullable(objectOf<NonNullable<ApiActivity['trial']>>()({ enabled: bool(), price: nullableRef('Money') }, [])),
    waitlist_enabled: bool(),
    durations: arr(
      objectOf<ApiActivity['durations'][number]>()(
        { minutes: int(), sale: oneOf(['free', 'priced', 'benefit_only']), price: nullableRef('Money') },
        []
      ),
      'Appointments only'
    ),
    details: objectOf<ApiActivity['details']>()(
      {
        prerequisites: nstr(),
        meeting_point: nstr(),
        whats_included: nstr(),
        whats_not_included: nstr(),
        faq: nstr(),
        cancellation_policy: nstr(),
      },
      []
    ),
  },
  []
)

const Plan = objectOf<ApiPlan>()(
  {
    object: constant('plan'),
    id: str(),
    name: nstr(),
    description: nstr(),
    source: oneOf(['own', 'partner'], 'partner = sold through a partner app'),
    active: bool(),
    public: bool(),
    prices: arr(
      objectOf<ApiPlan['prices'][number]>()(
        {
          id: str(),
          price: nullableRef('Money'),
          recurrence: str(),
          included_months: nullable(int()),
          credits: nullable(int()),
          label: nstr(),
          active: bool(),
        },
        []
      )
    ),
    usage_limit: nullable(objectOf<NonNullable<ApiPlan['usage_limit']>>()({ count: int(), per: str() }, [])),
    intro_offers: arr(
      objectOf<ApiPlan['intro_offers'][number]>()({ price_id: str(), periods: int(), price: nullableRef('Money') }, [])
    ),
  },
  []
)

const Event = objectOf<ApiEvent>()(
  {
    object: constant('event'),
    id: str(),
    title: nstr(),
    type: str(),
    start: time(),
    end: time(),
    location: nstr(),
    place_id: nstr(),
    room_id: nstr(),
    description: nstr(),
    fee: nullableRef('Money'),
    status: oneOf(['open', 'restricted', 'closed', 'cancelled']),
    participants: int(),
    attendees: int(),
    checked_in: int(),
    coach: nullable(objectOf<NonNullable<ApiEvent['coach']>>()({ id: str(), name: nstr() }, [])),
    public: bool(),
  },
  []
)

const Subscription = objectOf<ApiSubscription>()(
  {
    object: constant('subscription'),
    id: str(),
    contact_id: nstr(),
    contact: nullableRef('Person'),
    plan: objectOf<ApiSubscription['plan']>()({ id: nstr(), name: nstr() }, []),
    recurrence: nstr(),
    price: { ...nullableRef('Money'), description: 'Null unless the member may see money (reports.view)' },
    status: str(),
    paused: bool(),
    current_period_start: time(),
    current_period_end: time(),
    cancelling: bool('Still running, will not renew'),
    ends_at: time('Null while renewing, and on a record cancelling without a stored date — read `cancelling` for whether'),
    cancellation: nullable(
      objectOf<NonNullable<ApiSubscription['cancellation']>>()(
        {
          ended: bool(),
          requested_at: time(),
          reason: nstr(),
          feedback: nstr(),
          comment: nstr('Only with contacts:read:pii: the member’s own words'),
        },
        ['comment']
      )
    ),
    last_payment_status: nstr(),
    created_at: time(),
  },
  []
)

const WeeklyReport = objectOf<ApiWeeklyReport>()(
  {
    object: constant('weekly_report'),
    iso_week: str('As stored, e.g. 2026-W37'),
    generated: bool('False for a week with no stored report; its numbers are zero, not measured'),
    active_contacts: int(),
    contacts_by_stage: countsMap(),
    contacts_with_active_affiliation: int(),
    contacts_with_plan: int(),
    contacts_with_partner_plan: int(),
    contacts_by_plan: countsMap(),
    sessions: int(),
    sessions_by_type: countsMap(),
    bookings: int(),
    bookings_by_type: countsMap(),
    trial_conversions: int(),
    trial_dropouts: int(),
  },
  []
)

const FinanceTotals = objectOf<ApiFinanceTotals>()(
  { gross: int(), stripe_fees: int(), platform_fees: int(), net: int(), count: int() },
  [],
  'Minor units'
)

const FinanceMonth = objectOf<ApiFinanceMonth>()(
  {
    object: constant('finance_month'),
    month: str('YYYY-MM, bucketed in period_time_zone'),
    period_time_zone: str(),
    generated: bool('False until the month has closed and its report was written'),
    currencies: arr(str()),
    transactions: int(),
    totals: nullableRef('FinanceTotals'),
    by_category: { type: 'object', additionalProperties: ref('FinanceTotals') },
    by_source: { type: 'object', additionalProperties: ref('FinanceTotals') },
    refunds: nullable(objectOf<NonNullable<ApiFinanceMonth['refunds']>>()({ count: int(), amount: int() }, [])),
    payouts: nullable(objectOf<NonNullable<ApiFinanceMonth['payouts']>>()({ count: int(), total: int() }, [])),
  },
  []
)

const FillRowSchema = objectOf<FillRow>()(
  {
    key: str(),
    label: str(),
    sessions: int(),
    capped_sessions: int('Sessions with a capacity'),
    avg_fill_percent: nullable(int('Null when no session had a capacity')),
    full_sessions: int(),
    avg_booked: { type: 'number' },
    avg_attended: { type: 'number' },
  },
  []
)

const ClassFill = objectOf<ApiClassFill>()(
  {
    object: constant('class_fill'),
    from: str(),
    to: str(),
    group_by: oneOf(FILL_GROUPS),
    time_zone: str(),
    sessions_counted: int(),
    truncated: bool(),
    rows: arr(ref('FillRow')),
  },
  []
)

const Credential = objectOf<ApiCredentialInfo>()(
  {
    object: constant('credential'),
    team: objectOf<ApiCredentialInfo['team']>()({ id: str(), name: str() }, []),
    role: oneOf(['owner', 'manager', 'coach', 'viewer']),
    via: oneOf(['api_key', 'oauth']),
    scopes: objectOf<ApiCredentialInfo['scopes']>()(
      {
        usable: arr(oneOf(API_SCOPES)),
        unusable: arr(oneOf(API_SCOPES), 'Granted, but the member’s current role does not allow them'),
      },
      []
    ),
  },
  []
)

const Team = objectOf<ApiTeamInfo>()(
  {
    object: constant('team'),
    id: str(),
    name: str(),
    slug: nstr(),
    language: str(),
    currency: str(),
    time_zone: str('IANA zone; bare dates in requests are days in this zone'),
  },
  []
)

const ErrorSchema: JsonSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: oneOf([
          'unauthenticated',
          'insufficient_scope',
          'not_found',
          'invalid_request',
          'invalid_cursor',
          'feature_unavailable',
          'window_too_wide',
          'rate_limited',
          'internal',
        ]),
        message: str(),
        hint: str('What to do about it'),
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
}

/** A list page of `item`. */
export function listOf(item: string): JsonSchema {
  return objectOf<ListPage<unknown>>()(
    {
      object: constant('list'),
      data: arr(ref(item)),
      has_more: bool(),
      next_cursor: nstr('Pass as `cursor` for the next page'),
      scanned: int('Records read while filtering'),
      scan_exhausted: bool('The read budget ran out before the page filled; continue with the cursor'),
    },
    ['scanned', 'scan_exhausted']
  )
}

export const COMPONENT_SCHEMAS: Record<string, JsonSchema> = {
  Money,
  Person,
  HeldPlan,
  ContactAddress,
  Contact,
  Session,
  Booking,
  Attendance,
  SessionRef,
  SessionRoster,
  ContactHistory,
  Activity,
  Plan,
  Event,
  Subscription,
  WeeklyReport,
  FinanceTotals,
  FinanceMonth,
  FillRow: FillRowSchema,
  ClassFill,
  Credential,
  Team,
  Error: ErrorSchema,
}
