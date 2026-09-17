import * as assert from 'node:assert'
import {
  CONTACT_FIELD_CATALOG,
  SESSION_FIELD_CATALOG,
  projectSession,
  type Session,
  projectContact,
  type ApiProjectionContext,
  type Contact,
} from '@linyup/shared'

// The allow-list, pinned by sentinel. Every field the catalog excludes is set to
// a string no projection could produce by accident; none of them may come out.
// PII sentinels may come out only under the PII scope. A projection that starts
// spreading its document, or a field classified `excluded` that a projection
// reads anyway, fails here.

const NOW = Date.UTC(2026, 8, 14, 12)
const DAY = 86_400_000

const ctx = (pii: boolean): ApiProjectionContext => ({ nowMs: NOW, currency: 'CHF', pii })

/** Fields whose sentinel would change the answer rather than test the output. */
const DECISION_FIELDS = new Set(['deleted_at', 'anonymized_at', 'archived_at', 'provisional', 'external', 'id'])

/**
 * The sentinel in the SHAPE the field is stored in. A derived answer (the
 * attention reasons) legitimately reads some excluded arrays and maps, and a bare
 * string there would crash the resolver instead of testing the projection.
 */
const SENTINEL_SHAPES: Record<string, (s: string) => unknown> = {
  login_emails: (s) => [s],
  emergency_contacts: (s) => [{ name: s, phone: s, email: s }],
  active_subscriptions: (s) => [
    { subscription_type_id: s, subscription_type_name: s, recurrence: s, amount: 1, status: 'active' },
  ],
  no_show_strike_refs: (s) => [s],
  distinct_activities: (s) => [s],
  custom_badges: (s) => [s],
  held_plan_type_ids: (s) => [s],
  consent: (s) => ({ documents: [{ slug: s, kind: s, version: s }] }),
  mobile_app: (s) => ({ version: s, ota_channel: s }),
  ai_summary: (s) => ({ text: s, generated_by: s, model: s, language: s }),
  ranks: (s) => ({ system: s }),
  custom_fields: (s) => ({ field: s }),
}

function sentinelContact(): Contact {
  const doc: Record<string, unknown> = {}
  for (const [field, cls] of Object.entries(CONTACT_FIELD_CATALOG)) {
    if (cls === 'exposed' || DECISION_FIELDS.has(field)) continue
    const sentinel = `LEAK_${field}`
    doc[field] = SENTINEL_SHAPES[field]?.(sentinel) ?? sentinel
  }
  return {
    ...doc,
    id: 'c-1',
    teamId: 'LEAK_teamId',
    firstname: 'Ada',
    lastname: 'Lovelace',
    email: 'LEAK_email',
    phone: 'LEAK_phone',
    address: { route: 'LEAK_address', street_number: '1', postal_code: '8000', locality: 'Zürich' },
    deleted_at: null,
    anonymized_at: null,
    archived_at: null,
    held_plans: [
      {
        subscription_type_id: 'plan-1',
        subscription_type_name: 'Unlimited',
        source: 'stripe',
        status: 'cancelling',
        starts_at_ms: null,
        ends_at_ms: NOW + 10 * DAY,
        next_charge_at_ms: null,
        price_id: 'LEAK_price_id',
        amount: 129.5,
        recurrence: 'monthly',
        ref: 'LEAK_stripe_subscription_ref',
      },
    ],
    last_session_at: { toMillis: () => NOW - 3 * DAY },
    total_sessions: 42,
    tags: ['vip'],
  } as unknown as Contact
}

describe('projectContact', () => {
  it('lets no excluded value out, under any scope', () => {
    for (const pii of [false, true]) {
      const out = JSON.stringify(projectContact(sentinelContact(), ctx(pii)))
      for (const [field, cls] of Object.entries(CONTACT_FIELD_CATALOG)) {
        if (cls === 'excluded') assert.ok(!out.includes(`LEAK_${field}`), `excluded field ${field} leaked (pii=${pii})`)
      }
      // Held-plan internals that are not wire fields.
      assert.ok(!out.includes('LEAK_price_id'))
      assert.ok(!out.includes('LEAK_stripe_subscription_ref'))
    }
  })

  it('shares personal details only under the PII scope', () => {
    const without = projectContact(sentinelContact(), ctx(false))!
    for (const key of ['email', 'phone', 'gender', 'birthdate', 'address'] as const) {
      assert.ok(!(key in without), `${key} must be absent without the PII scope`)
    }
    const text = JSON.stringify(without)
    assert.ok(!text.includes('LEAK_email') && !text.includes('LEAK_address'))

    const withPii = projectContact(sentinelContact(), ctx(true))!
    assert.strictEqual(withPii.email, 'LEAK_email')
    assert.strictEqual(withPii.address?.street, 'LEAK_address')
  })

  it('never returns a deleted or anonymised person', () => {
    const deleted = { ...sentinelContact(), deleted_at: { toMillis: () => NOW - DAY } } as unknown as Contact
    const anonymised = { ...sentinelContact(), anonymized_at: { toMillis: () => NOW - DAY } } as unknown as Contact
    assert.strictEqual(projectContact(deleted, ctx(true)), null)
    assert.strictEqual(projectContact(anonymised, ctx(true)), null)
  })

  it('reports lifecycle through the one predicate', () => {
    const base = sentinelContact()
    assert.strictEqual(projectContact(base, ctx(false))!.lifecycle, 'active')
    assert.strictEqual(projectContact({ ...base, external: true } as Contact, ctx(false))!.lifecycle, 'external')
    assert.strictEqual(projectContact({ ...base, provisional: true } as Contact, ctx(false))!.lifecycle, 'provisional')
    assert.strictEqual(
      projectContact({ ...base, archived_at: { toMillis: () => NOW } } as unknown as Contact, ctx(false))!.lifecycle,
      'archived'
    )
  })

  it('puts money in minor units beside its currency, and times in ISO UTC', () => {
    const out = projectContact(sentinelContact(), ctx(false))!
    assert.deepStrictEqual(out.plans[0].price, { amount: 12950, currency: 'CHF' })
    assert.strictEqual(out.plans[0].ends_at, new Date(NOW + 10 * DAY).toISOString())
    assert.strictEqual(out.attendance.last_session_at, new Date(NOW - 3 * DAY).toISOString())
    assert.strictEqual(out.attendance.engagement_band, 'active')
  })
})

describe('projectSession', () => {
  const SESSION_DECISIONS = new Set(['id', 'status', 'isException', 'exceptionType', 'blocked_time', 'hold_expires_at', 'start', 'end'])

  function sentinelSession(over: Record<string, unknown> = {}): Session {
    const doc: Record<string, unknown> = {}
    for (const [field, cls] of Object.entries(SESSION_FIELD_CATALOG)) {
      if (cls !== 'exposed' && !SESSION_DECISIONS.has(field)) doc[field] = `LEAK_${field}`
    }
    return {
      ...doc,
      id: 's-1',
      activityId: 'a-1',
      activityName: 'Open mat',
      start: { toMillis: () => NOW + DAY },
      end: { toMillis: () => NOW + DAY + 3_600_000 },
      providerId: 'coach-1',
      providerName: 'Marta',
      max_participants: 12,
      bookings_count: 12,
      status: 'full',
      blocked_time: false,
      ...over,
    } as unknown as Session
  }

  it('lets no excluded value out — no notes, no meeting link, no client name', () => {
    const out = JSON.stringify(projectSession(sentinelSession(), { nowMs: NOW }))
    for (const [field, cls] of Object.entries(SESSION_FIELD_CATALOG)) {
      if (cls === 'excluded') assert.ok(!out.includes(`LEAK_${field}`), `excluded field ${field} leaked`)
    }
  })

  it('reports status through the shared cancellation predicate', () => {
    assert.strictEqual(projectSession(sentinelSession(), { nowMs: NOW })!.status, 'full')
    assert.strictEqual(projectSession(sentinelSession({ status: 'cancelled' }), { nowMs: NOW })!.status, 'cancelled')
    assert.strictEqual(
      projectSession(sentinelSession({ status: 'open', isException: true, exceptionType: 'cancelled' }), { nowMs: NOW })!.status,
      'cancelled'
    )
  })

  it('derives full from the seat count, whatever status was stored', () => {
    // The local seed stores `status: 'open'` on an 8/8 class; the API must still say full.
    assert.strictEqual(projectSession(sentinelSession({ status: 'open', bookings_count: 8, max_participants: 8 }), { nowMs: NOW })!.status, 'full')
    assert.strictEqual(projectSession(sentinelSession({ status: 'full', bookings_count: 7, max_participants: 8 }), { nowMs: NOW })!.status, 'open', 'a freed seat reopens it')
    assert.strictEqual(projectSession(sentinelSession({ status: 'open', bookings_count: 40, max_participants: null }), { nowMs: NOW })!.status, 'open', 'no cap is never full')
    assert.strictEqual(
      projectSession(sentinelSession({ status: 'cancelled', bookings_count: 8, max_participants: 8 }), { nowMs: NOW })!.status,
      'cancelled',
      'cancelled wins over full'
    )
  })

  it('drops blocked time and lapsed appointment holds', () => {
    assert.strictEqual(projectSession(sentinelSession({ blocked_time: true }), { nowMs: NOW }), null)
    const lapsed = sentinelSession({ status: 'pending_payment', hold_expires_at: { toMillis: () => NOW - 1 } })
    assert.strictEqual(projectSession(lapsed, { nowMs: NOW }), null)
    const live = sentinelSession({ status: 'pending_payment', hold_expires_at: { toMillis: () => NOW + 60_000 } })
    assert.strictEqual(projectSession(live, { nowMs: NOW })!.status, 'pending_payment')
  })
})
