import * as assert from 'node:assert'
import {
  ACTIVITY_FIELD_CATALOG,
  BOOKING_FIELD_CATALOG,
  EVENT_FIELD_CATALOG,
  MEMBER_SUBSCRIPTION_FIELD_CATALOG,
  PLAN_FIELD_CATALOG,
  projectActivity,
  projectBooking,
  projectEvent,
  projectFinanceMonth,
  projectPerson,
  projectPlan,
  projectSubscription,
  projectWeeklyReport,
  type Activity,
  type Booking,
  type Contact,
  type Event,
  type FieldCatalog,
  type FinanceMonthlyReport,
  type MemberSubscription,
  type SubscriptionType,
} from '@linyup/shared'
import { matchRoute } from './rest'
import { monthsBetween } from './resources/reports'
import { ApiError } from './errors'

// The allow-list for the second wave of resources, pinned the same way as
// projections.test.ts: every excluded field carries a sentinel, none may leave.

const NOW = Date.UTC(2026, 8, 14, 12)
const ts = (ms: number) => ({ toMillis: () => ms })

/** Build a document whose excluded fields are sentinels, in the shape each is stored in. */
function sentinels<T>(
  catalog: FieldCatalog<T>,
  shapes: Record<string, (s: string) => unknown> = {},
  skip: string[] = []
): Record<string, unknown> {
  const doc: Record<string, unknown> = {}
  for (const [field, cls] of Object.entries(catalog)) {
    if (cls !== 'excluded' || skip.includes(field)) continue
    doc[field] = shapes[field]?.(`LEAK_${field}`) ?? `LEAK_${field}`
  }
  return doc
}

function assertNoLeak<T>(catalog: FieldCatalog<T>, output: unknown, label: string) {
  const text = JSON.stringify(output)
  for (const [field, cls] of Object.entries(catalog)) {
    if (cls === 'excluded') assert.ok(!text.includes(`LEAK_${field}`), `${label}: excluded ${field} leaked`)
  }
}

describe('projectActivity', () => {
  const base = (over: Partial<Activity> = {}): Activity =>
    ({
      ...sentinels(
        ACTIVITY_FIELD_CATALOG,
        {
          memberBenefit: (s) => ({ kind: s }),
          durationBenefits: (s) => [{ minutes: 60, benefit: { kind: s } }],
          bookingQuestions: (s) => [{ id: s, label: s }],
          contactFields: (s) => [{ key: s }],
        },
        ['isFreeTrial', 'autoConfirm']
      ),
      id: 'a-1',
      name: 'Brazilian Jiu-Jitsu',
      slug: 'bjj',
      type: 'class',
      trialEnabled: true,
      trialPriceAmount: 20,
      // Members-only: an OPEN class is free for everyone and so has no drop-in at all.
      accessRule: { type: 'subscription', audience: 'members', requirePlan: true, subscriptionTypeIds: ['p-1'] },
      dropIn: { mode: 'studio', enabled: false },
      archived_at: null,
      ...over,
    }) as unknown as Activity

  it('lets no excluded value out — no door codes, no booking questions', () => {
    assertNoLeak(ACTIVITY_FIELD_CATALOG, projectActivity(base(), { currency: 'CHF', studioDropIn: null }), 'activity')
  })

  it('answers the drop-in price through the resolver, following the studio default', () => {
    const out = projectActivity(base(), { currency: 'CHF', studioDropIn: { enabled: true, priceAmount: 25 } })!
    assert.deepStrictEqual(out.drop_in, { enabled: true, price: { amount: 2500, currency: 'CHF' }, follows: 'studio' })
    assert.deepStrictEqual(out.trial, { enabled: true, price: { amount: 2000, currency: 'CHF' } })
    // rule 1 (class-access stage 5): require_plan/tier are DERIVED from the
    // resolved door, not the stored fields — a studio default price is live
    // here, so the door is open (require_plan false) even though the stored
    // rule says requirePlan: true.
    assert.deepStrictEqual(out.access, { tier: 'members', audience: 'members', require_plan: false, plan_ids: ['p-1'] })

    const open = projectActivity(base({ accessRule: undefined }), { currency: 'CHF', studioDropIn: { enabled: true, priceAmount: 25 } })!
    assert.strictEqual(open.drop_in?.enabled, false, 'a class free for everyone has no drop-in price')
  })

  it('gives an appointment its lengths and no class-only fields', () => {
    const out = projectActivity(base({ type: 'appointment', durations: [{ minutes: 60, priceAmount: 90 }, { minutes: 30 }] }), {
      currency: 'CHF',
      studioDropIn: { enabled: true, priceAmount: 25 },
    })!
    assert.strictEqual(out.drop_in, null)
    assert.strictEqual(out.access, null)
    assert.deepStrictEqual(
      out.durations.map((d) => [d.minutes, d.sale, d.price?.amount ?? null]),
      [
        [60, 'priced', 9000],
        [30, 'free', null],
      ]
    )
  })

  it('does not return an archived activity', () => {
    assert.strictEqual(projectActivity(base({ archived_at: ts(NOW) as never }), { currency: 'CHF', studioDropIn: null }), null)
  })
})

describe('projectPlan', () => {
  it('renames a partner source, moves prices to minor units and keeps partner payout terms in', () => {
    const type = {
      ...sentinels(PLAN_FIELD_CATALOG),
      id: 'p-1',
      name: 'FitPass',
      source: 'aggregator',
      payoutPerVisit: 12.5,
      prices: [{ id: 'm', amount: 129.5, recurrence: 'monthly', maxPurchasesPerContact: 3 }],
      limits: [{ count: 8, per: 'month' }],
    } as unknown as SubscriptionType
    const out = projectPlan(type, { currency: 'CHF' })
    assertNoLeak(PLAN_FIELD_CATALOG, out, 'plan')
    assert.strictEqual(out.source, 'partner')
    assert.deepStrictEqual(out.prices[0].price, { amount: 12950, currency: 'CHF' })
    assert.deepStrictEqual(out.usage_limit, { count: 8, per: 'month' })
    assert.ok(!JSON.stringify(out).includes('12.5'), 'payout per visit never leaves')
    assert.ok(!JSON.stringify(out).includes('maxPurchasesPerContact'))
  })
})

describe('projectBooking and projectPerson', () => {
  const contact = (over: Partial<Contact> = {}): Contact =>
    ({ id: 'c-1', teamId: 't', firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com', deleted_at: null, archived_at: null, ...over }) as Contact

  it('names the person from the contact document, never from the booking copy', () => {
    const booking = {
      ...sentinels(BOOKING_FIELD_CATALOG, { question_answers: (s) => ({ injuries: s }) }),
      id: 'c-1',
      contact: 'c-1',
      joinedAt: ts(NOW),
      is_new_contact: true,
      status: 'confirmed',
      payment_status: 'paid',
    } as unknown as Booking
    const out = projectBooking(booking, { sessionId: 's-1', person: projectPerson(contact(), false) })
    assertNoLeak(BOOKING_FIELD_CATALOG, out, 'booking')
    assert.strictEqual(out.contact?.first_name, 'Ada')
    assert.ok(!('email' in (out.contact ?? {})), 'no email without the PII scope')
    assert.strictEqual(out.paid, true)
    assert.strictEqual(out.is_trial, true)
  })

  it('has no person for someone deleted or anonymised', () => {
    assert.strictEqual(projectPerson(contact({ anonymized_at: ts(NOW) as never }), true), null)
    assert.strictEqual(projectPerson(contact({ deleted_at: ts(NOW) as never }), true), null)
    assert.strictEqual(projectPerson(null, true), null)
    assert.strictEqual(projectPerson(contact(), true)?.email, 'ada@example.com')
  })

  it('reads an absent booking status as pending', () => {
    const out = projectBooking({ id: 'x', contact: 'x', joinedAt: ts(NOW) } as unknown as Booking, { sessionId: null, person: null })
    assert.strictEqual(out.status, 'pending')
  })
})

describe('projectSubscription', () => {
  const sub = (over: Partial<MemberSubscription> = {}): MemberSubscription =>
    ({
      ...sentinels(MEMBER_SUBSCRIPTION_FIELD_CATALOG),
      subscriptionId: 'sub_1',
      contactId: 'c-1',
      subscriptionTypeName: 'Unlimited',
      amount: 12900,
      currency: 'chf',
      status: 'active',
      current_period_start: ts(NOW - 10 * 86_400_000),
      current_period_end: ts(NOW + 20 * 86_400_000),
      cancel_at_period_end: true,
      cancel_at: null,
      canceled_at: ts(NOW - 86_400_000),
      cancellation_details: { reason: 'cancellation_requested', feedback: 'too_expensive', comment: 'Moving to Bern' },
      created_at: ts(NOW - 100 * 86_400_000),
      ...over,
    }) as unknown as MemberSubscription

  it('lets no excluded value out, and shows money only to those who may see it', () => {
    const hidden = projectSubscription(sub(), { person: null, amounts: false, pii: false })
    assertNoLeak(MEMBER_SUBSCRIPTION_FIELD_CATALOG, hidden, 'subscription')
    assert.strictEqual(hidden.price, null)
    const shown = projectSubscription(sub(), { person: null, amounts: true, pii: false })
    assert.deepStrictEqual(shown.price, { amount: 12900, currency: 'CHF' })
  })

  it('answers cancelling and its end through the lifecycle readers; the member’s words only under PII', () => {
    const out = projectSubscription(sub(), { person: null, amounts: false, pii: false })
    assert.strictEqual(out.cancelling, true)
    assert.strictEqual(out.ends_at, new Date(NOW + 20 * 86_400_000).toISOString())
    assert.strictEqual(out.cancellation?.reason, 'cancellation_requested')
    assert.ok(!('comment' in (out.cancellation ?? {})))
    assert.strictEqual(projectSubscription(sub(), { person: null, amounts: false, pii: true }).cancellation?.comment, 'Moving to Bern')
  })

  it('reports a reactivated subscription as not cancelling, whatever stale record it carries', () => {
    const out = projectSubscription(sub({ cancel_at_period_end: false, cancel_at: null }), { person: null, amounts: false, pii: false })
    assert.strictEqual(out.cancelling, false)
    assert.strictEqual(out.cancellation, null)
  })
})

describe('projectEvent', () => {
  it('lets no excluded value out and skips deleted and organisation events', () => {
    const event = {
      ...sentinels(EVENT_FIELD_CATALOG, { program: (s) => ({ days: [{ label: s }] }) }, ['deleted_at', 'scope']),
      id: 'e-1',
      title: 'Summer camp',
      type: 'camp',
      start: ts(NOW),
      end: ts(NOW + 3 * 86_400_000),
      fee: 350,
      deleted_at: null,
    } as unknown as Event
    const out = projectEvent(event, { currency: 'CHF' })!
    assertNoLeak(EVENT_FIELD_CATALOG, out, 'event')
    assert.deepStrictEqual(out.fee, { amount: 35000, currency: 'CHF' })
    assert.strictEqual(projectEvent({ ...event, deleted_at: ts(NOW) } as unknown as Event, { currency: 'CHF' }), null)
    assert.strictEqual(projectEvent({ ...event, scope: 'org' } as Event, { currency: 'CHF' }), null)
  })
})

describe('reports', () => {
  it('marks a week with no stored report as not generated, with zeros', () => {
    const missing = projectWeeklyReport('2026-W37', null)
    assert.strictEqual(missing.generated, false)
    assert.strictEqual(missing.sessions, 0)
    const stored = projectWeeklyReport('2026-W36', { iso_week: '2026-W36', sessions_count: 42, bookings_count_by_type: { class: 30, bad: 'x' as never } })
    assert.strictEqual(stored.sessions, 42)
    assert.deepStrictEqual(stored.bookings_by_type, { class: 30 })
  })

  it('never lets the reconciliation check out, and keeps the stored month', () => {
    const report = {
      month: '2026-08',
      txn_count: 3,
      currencies: ['chf'],
      totals: { gross: 30000, stripe_fees: 900, platform_fees: 300, net: 28800, count: 3 },
      by_category: { membership: { gross: 30000, stripe_fees: 900, platform_fees: 300, net: 28800, count: 3 } },
      by_source: {},
      refunds: { count: 0, amount: 0 },
      disputes: { count: 0, withdrawn: 0, reinstated: 0, fees: 0 },
      payouts: { count: 1, total: 28800 },
      reconciliation: { net_activity: 1, paid_out: 1, delta: 0 },
      reconciliation_check: { sources_count: 99, journal_count: 98, ok: false },
    } as unknown as FinanceMonthlyReport
    const out = projectFinanceMonth('2026-08', report)
    assert.ok(!JSON.stringify(out).includes('reconciliation'))
    assert.strictEqual(out.period_time_zone, 'Europe/Zurich')
    assert.deepStrictEqual(out.currencies, ['CHF'])
    assert.strictEqual(projectFinanceMonth('2026-09', null).generated, false)
  })

  it('walks months inclusively across a year and refuses too many', () => {
    assert.deepStrictEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02'])
    assert.throws(() => monthsBetween('2024-01', '2026-06'), (e: unknown) => e instanceof ApiError && e.code === 'window_too_wide')
    assert.throws(() => monthsBetween('2026-05', '2026-04'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_request')
  })
})

describe('REST routes', () => {
  it('matches fixed routes before id routes, and nothing else', () => {
    assert.deepStrictEqual(matchRoute('/v1/contacts'), { key: 'contacts' })
    assert.deepStrictEqual(matchRoute('/v1/contacts/c-1'), { key: 'contacts/*', id: 'c-1' })
    assert.deepStrictEqual(matchRoute('/v1/contacts/c-1/history'), { key: 'contacts/*/history', id: 'c-1' })
    assert.deepStrictEqual(matchRoute('/v1/sessions/s-1/roster'), { key: 'sessions/*/roster', id: 's-1' })
    assert.deepStrictEqual(matchRoute('/v1/reports/weekly'), { key: 'reports/weekly' })
    assert.deepStrictEqual(matchRoute('/v1/insights/class-fill'), { key: 'insights/class-fill' })
    assert.strictEqual(matchRoute('/v1/reports'), null)
    assert.strictEqual(matchRoute('/v1/activities/a-1'), null)
    assert.strictEqual(matchRoute('/v1/contacts/c-1/notes'), null)
    assert.strictEqual(matchRoute('/v2/contacts'), null)
  })
})
