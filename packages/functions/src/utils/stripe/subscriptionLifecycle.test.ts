import assert from 'node:assert/strict'
import {
  subscriptionCancellation,
  subscriptionEndsAt,
  subscriptionEndsAtMs,
  subscriptionIsCancelling,
} from '@linyup/shared'

// The stored half of the "cancels at period end" story. objectShape.test.ts pins
// how the two Stripe expressions are READ; this pins how the stored pair is
// answered — once, so the studio's contact detail, the member's Space, the
// billing page and the org billing page cannot drift apart on it.

const ts = (ms: number) => ({ toMillis: () => ms, seconds: Math.floor(ms / 1000) }) as never

const PERIOD_END = ts(1_800_000_000_000)
const CANCEL_AT = ts(1_789_487_599_000)

describe('subscriptionEndsAt', () => {
  it('says nothing about a subscription that is simply renewing', () => {
    assert.equal(
      subscriptionEndsAt({ status: 'active', cancel_at_period_end: false, current_period_end: PERIOD_END }),
      null
    )
  })

  it('prefers Stripe’s own cancel_at — the BILLING-PORTAL case', () => {
    const end = subscriptionEndsAt({
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: CANCEL_AT,
      current_period_end: PERIOD_END,
    })
    assert.equal(end, CANCEL_AT)
  })

  // NB the fallback is for STORED docs that never captured a cancel_at, not for a
  // live API cancel: on Dahlia that path sets cancel_at too (see the file header).
  it('falls back to the period end when the doc carries the boolean and no cancel_at', () => {
    const end = subscriptionEndsAt({
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: null,
      current_period_end: PERIOD_END,
    })
    assert.equal(end, PERIOD_END)
  })

  it('says nothing about a subscription that has ALREADY ended', () => {
    // The past is not an announcement — `status` already says it. Without this,
    // a canceled membership would show "ends on <a date last month>" forever.
    for (const status of ['canceled', 'cancelled', 'unpaid', 'expired']) {
      assert.equal(
        subscriptionEndsAt({ status, cancel_at_period_end: true, cancel_at: CANCEL_AT }),
        null,
        status
      )
    }
  })

  it('still announces it while billing is FROZEN or the payment is late', () => {
    // Paused/past_due are live states — the member is still a member, and a
    // pending end date is exactly what a studio needs to see there.
    for (const status of ['trialing', 'past_due', 'paused', 'trial']) {
      assert.equal(
        subscriptionEndsAt({ status, cancel_at_period_end: true, cancel_at: CANCEL_AT }),
        CANCEL_AT,
        status
      )
    }
  })

  it('is null-safe for a missing subscription and for one with no dates at all', () => {
    assert.equal(subscriptionEndsAt(null), null)
    assert.equal(subscriptionEndsAt(undefined), null)
    assert.equal(subscriptionEndsAt({ status: 'active', cancel_at_period_end: true }), null)
  })

  it('gives the same answer in epoch ms', () => {
    assert.equal(
      subscriptionEndsAtMs({ status: 'active', cancel_at_period_end: true, cancel_at: CANCEL_AT }),
      1_789_487_599_000
    )
    assert.equal(subscriptionEndsAtMs({ status: 'active', cancel_at_period_end: false }), null)
  })
})

// THE PRE-MIGRATION DOC, which is the entire existing population: the writer
// stored the cancellation boolean but read `current_period_end` from the
// subscription (Dahlia moved it onto the subscription ITEM), so it stored null.
// No cancel_at either — that field was not being read at all.
const LEGACY_CANCELLING = {
  status: 'active',
  cancel_at_period_end: true,
  cancel_at: null,
  current_period_end: null,
} as const

describe('subscriptionIsCancelling — WHETHER, asked apart from WHEN', () => {
  it('is TRUE for a pre-migration doc that has the boolean and NO date', () => {
    // The regression this pins: deriving "is it canceling" from
    // `subscriptionEndsAt(...) !== null` additionally demands a date, which these
    // docs do not have — so the org billing page hid Reactivate from exactly the
    // studios that were canceled and still live, and the operator console showed
    // an empty cell for them.
    assert.equal(subscriptionIsCancelling(LEGACY_CANCELLING), true)
    assert.equal(subscriptionEndsAt(LEGACY_CANCELLING), null, 'the date is genuinely unknown')
  })

  it('is TRUE for the billing-portal shape — a cancel_at with the boolean FALSE', () => {
    assert.equal(
      subscriptionIsCancelling({ status: 'active', cancel_at_period_end: false, cancel_at: CANCEL_AT }),
      true
    )
  })

  it('is FALSE for one that is simply renewing, and for a missing doc', () => {
    assert.equal(subscriptionIsCancelling({ status: 'active', cancel_at_period_end: false }), false)
    assert.equal(subscriptionIsCancelling(null), false)
    assert.equal(subscriptionIsCancelling(undefined), false)
  })

  it('is FALSE once the subscription has actually ENDED — that is the past', () => {
    for (const status of ['canceled', 'cancelled', 'unpaid', 'expired', 'incomplete_expired']) {
      assert.equal(
        subscriptionIsCancelling({ status, cancel_at_period_end: true, cancel_at: CANCEL_AT }),
        false,
        status
      )
    }
  })

  // ── EVERY SHAPE THAT EXISTS IN THE WILD, ENUMERATED ───────────────────────
  //
  // The gap this closes: every case above supplies a `status`, so a predicate
  // that REQUIRED one passed the whole suite while reading status-less docs as
  // "not canceling". Two verification lenses disagreed about whether that
  // mattered, because only one of them walked a doc with no status.
  //
  // It is not hypothetical. The SaaS webhook's `subscription.updated` branch
  // (functions/src/saas-billing/index.ts) sets no `status`, and persists with
  // `set(…, {merge:true})` — so an `updated` event arriving for a doc that does
  // not exist yet CREATES one with the cancellation and no status. A real one
  // written by a live event was sitting in the emulator while this was written:
  // saas_subscriptions/hmd, cape=true + cancel_at set + NO status.
  //
  // So the matrix is the two cancellation expressions crossed with the status
  // column, INCLUDING its absence. Every cell is asserted rather than reasoned
  // about, which is the only way the next reader can change the predicate and
  // find out what they broke.
  const EXPRESSIONS = [
    { name: 'boolean-only (pre-migration)', f: { cancel_at_period_end: true, cancel_at: null }, cancelling: true },
    { name: 'cancel_at-only (billing portal)', f: { cancel_at_period_end: false, cancel_at: CANCEL_AT }, cancelling: true },
    { name: 'both (API cancel on Dahlia)', f: { cancel_at_period_end: true, cancel_at: CANCEL_AT }, cancelling: true },
    { name: 'neither (renewing)', f: { cancel_at_period_end: false, cancel_at: null }, cancelling: false },
  ] as const

  // Statuses that must NOT suppress a cancellation the doc plainly carries.
  const NOT_ENDED = [
    { name: 'absent', s: {} },
    { name: 'explicit undefined', s: { status: undefined } },
    { name: 'null', s: { status: null } },
    { name: 'empty string', s: { status: '' } },
    { name: 'active', s: { status: 'active' } },
    { name: 'trialing (Stripe)', s: { status: 'trialing' } },
    { name: 'trial (SaaS vocabulary)', s: { status: 'trial' } },
    { name: 'past_due', s: { status: 'past_due' } },
    { name: 'paused', s: { status: 'paused' } },
    { name: 'incomplete', s: { status: 'incomplete' } },
    { name: 'a status neither vocabulary knows', s: { status: 'something_new' } },
  ] as const

  const ENDED = ['canceled', 'cancelled', 'unpaid', 'expired', 'incomplete_expired']

  for (const e of EXPRESSIONS) {
    it(`${e.name}: is ${e.cancelling} for every status that is not an ENDED one`, () => {
      for (const st of NOT_ENDED) {
        assert.equal(
          subscriptionIsCancelling({ ...st.s, ...e.f }),
          e.cancelling,
          `${e.name} + status ${st.name}`
        )
      }
    })

    it(`${e.name}: is false once the subscription has ENDED, whatever it still carries`, () => {
      for (const status of ENDED) {
        assert.equal(subscriptionIsCancelling({ status, ...e.f }), false, `${e.name} + ${status}`)
      }
    })
  }

  it('THE REAL DOC: a status-less saas_subscriptions row reads as canceling', () => {
    // Field-for-field the emulator's saas_subscriptions/hmd, as the SaaS webhook
    // wrote it from evt_1U4wq0Gz6xwscm1ePB35od9E. Before the fix this was `false`
    // — the regression against 926c72b on org billing and the operator console.
    const hmd = {
      cancel_at_period_end: true,
      cancel_at: CANCEL_AT,
      current_period_end: PERIOD_END,
      // no `status` key at all — the `subscription.updated` branch writes none
    }
    assert.equal(subscriptionIsCancelling(hmd), true)
    assert.equal(subscriptionEndsAt(hmd), CANCEL_AT, 'and the date is available too')
    assert.ok(subscriptionCancellation(hmd), 'so the operator console has something to show')
  })

  it('agrees with subscriptionEndsAt wherever a date IS known', () => {
    // The two may only diverge on the missing-date case above; anywhere a date
    // exists, "there is an end date" and "it is canceling" must be the same
    // answer, or two surfaces will disagree about one subscription.
    const cases = [
      { status: 'active', cancel_at_period_end: true, cancel_at: CANCEL_AT },
      { status: 'active', cancel_at_period_end: false, cancel_at: CANCEL_AT },
      { status: 'past_due', cancel_at_period_end: true, current_period_end: PERIOD_END },
      { status: 'active', cancel_at_period_end: false, current_period_end: PERIOD_END },
      { status: 'canceled', cancel_at_period_end: true, cancel_at: CANCEL_AT },
    ]
    for (const c of cases) {
      assert.equal(
        subscriptionEndsAt(c) !== null,
        subscriptionIsCancelling(c),
        JSON.stringify(c)
      )
    }
  })
})

const REQUESTED_AT = ts(1_786_810_613_000)
const DETAILS = {
  reason: 'cancellation_requested' as const,
  feedback: 'switched_service' as const,
  comment: null,
}

describe('subscriptionCancellation', () => {
  it('narrates a subscription that is winding down', () => {
    const rec = subscriptionCancellation({
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: CANCEL_AT,
      canceled_at: REQUESTED_AT,
      cancellation_details: DETAILS,
    })
    assert.ok(rec)
    assert.equal(rec.endsAt, CANCEL_AT)
    assert.equal(rec.ended, false)
    assert.equal(rec.requestedAt, REQUESTED_AT)
    assert.equal(rec.reason, 'cancellation_requested')
    assert.equal(rec.feedback, 'switched_service')
  })

  it('still narrates one that has ALREADY ended — the reason outlives the date', () => {
    // "Cancels on" is gone once it has, but "their card failed" versus "they
    // left" is exactly what a studio reviewing a lapsed member needs, and it is
    // the whole reason the reason is stored rather than collapsed to a boolean.
    const rec = subscriptionCancellation({
      status: 'canceled',
      cancel_at_period_end: true,
      cancel_at: CANCEL_AT,
      canceled_at: REQUESTED_AT,
      cancellation_details: { reason: 'payment_failed', feedback: null, comment: null },
    })
    assert.ok(rec)
    assert.equal(rec.endsAt, null) // the date is the past; status says the rest
    assert.equal(rec.ended, true)
    assert.equal(rec.reason, 'payment_failed')
  })

  it('knows both spellings of canceled', () => {
    // Stripe writes `canceled`; the SaaS rail's own vocabulary writes
    // `cancelled`. A set that knew one would silently drop half of them.
    for (const status of ['canceled', 'cancelled']) {
      assert.equal(subscriptionCancellation({ status, cancellation_details: DETAILS })?.ended, true, status)
    }
  })

  it('says NOTHING about a renewing subscription, even one carrying a stale record', () => {
    // The gate is the lifecycle state, never the presence of a cancellation
    // field — so a writer that forgets to clear one of these on reactivation
    // produces stale data, not a wrong screen.
    assert.equal(
      subscriptionCancellation({
        status: 'active',
        cancel_at_period_end: false,
        canceled_at: REQUESTED_AT,
        cancellation_details: DETAILS,
      }),
      null
    )
  })

  it('NARRATES a pre-migration doc that is canceling with no date at all', () => {
    // The operator-console half of the same regression: gating the record on a
    // date meant `toSubscriptionView` produced five nulls for these docs and the
    // console showed "—" where it had previously shown the cancellation.
    const rec = subscriptionCancellation(LEGACY_CANCELLING)
    assert.ok(rec, 'a doc that is canceling always has a record, date or not')
    assert.equal(rec.endsAt, null)
    assert.equal(rec.ended, false)
    assert.equal(rec.reason, null)
  })

  it('is null-safe, and copes with a doc written before these fields existed', () => {
    assert.equal(subscriptionCancellation(null), null)
    assert.equal(subscriptionCancellation(undefined), null)
    const legacy = subscriptionCancellation({
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: PERIOD_END,
    })
    assert.ok(legacy)
    assert.equal(legacy.endsAt, PERIOD_END)
    assert.equal(legacy.requestedAt, null)
    assert.equal(legacy.reason, null)
  })
})
