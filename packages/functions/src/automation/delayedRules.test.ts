// Unit tests for Tier 2 delay routing — the decision of whether an event rule
// runs inline or is deferred to Cloud Tasks, and the dedup key a deferred run
// carries (UX-85).
//
// Everything under test is pure. The two halves that are not pure — the enqueue
// itself and executeDelayedRule's Firestore reads — are covered by the
// invariants pinned here plus the source-reading parity test at the bottom,
// which spans the functions/web boundary on purpose: `supportsDelay` in the
// rule builder is a PROMISE that the engine honors the delay, and the two
// files are where that promise has already been broken once.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  MAX_DELAY_MINUTES,
  buildEventIdempotencyKey,
  clampDelayMinutes,
  resolveEventDelayMinutes,
  type AutomationRule,
  type AutomationTriggerType,
} from '../utils/automationEngine'

function rule(
  type: AutomationTriggerType,
  delayMinutes?: number,
  id = 'r1'
): AutomationRule {
  return {
    id,
    name: 'test rule',
    active: true,
    trigger: { type, ...(delayMinutes === undefined ? {} : { delayMinutes }) },
    conditions: [],
    actions: [{ type: 'send_email', templateId: 'tpl' }],
  }
}

// ---------------------------------------------------------------------------
// No delay stored → inline, exactly as before. This is the regression fence:
// every rule that works today stores no delay and must keep running inline.
// ---------------------------------------------------------------------------

describe('resolveEventDelayMinutes — absent or zero delay runs inline', () => {
  const inlineTriggers: AutomationTriggerType[] = [
    'contact_created',
    'acquisition_stage_changed',
    'booking_confirmed',
    'booking_no_show',
    'booking_cancelled',
    'subscription_added',
    'subscription_removed',
    'subscription_changed',
    'affiliation_added',
    'affiliation_removed',
    'affiliation_changed',
    'payment_received',
    'payment_refunded',
    'payment_disputed',
  ]

  for (const t of inlineTriggers) {
    it(`${t}: no delayMinutes field at all → 0 (inline)`, () => {
      assert.equal(resolveEventDelayMinutes(rule(t)), 0)
    })
    it(`${t}: delayMinutes 0 → 0 (inline)`, () => {
      assert.equal(resolveEventDelayMinutes(rule(t, 0)), 0)
    })
  }

  it('a negative delay runs inline rather than scheduling in the past', () => {
    assert.equal(resolveEventDelayMinutes(rule('contact_created', -30)), 0)
  })

  it('a non-finite delay runs inline rather than throwing at enqueue', () => {
    // Neither is reachable from the builder's number input, but a hand-written
    // rule document must not be able to make an enqueue throw.
    assert.equal(resolveEventDelayMinutes(rule('contact_created', NaN)), 0)
    assert.equal(resolveEventDelayMinutes(rule('contact_created', Infinity)), 0)
  })
})

// ---------------------------------------------------------------------------
// The event triggers that store a delay now honor it. Named rather than counted:
// the list grows, and a tally in the heading goes wrong the moment it does.
// ---------------------------------------------------------------------------

describe('resolveEventDelayMinutes — the triggers that stored a delay nothing read', () => {
  const nowHonoured: AutomationTriggerType[] = [
    'contact_created',
    'booking_confirmed',
    'booking_no_show',
    'booking_cancelled',
    'subscription_added',
    'subscription_removed',
    'subscription_changed',
    'affiliation_added',
    'affiliation_removed',
    'affiliation_changed',
    'payment_received',
    'payment_refunded',
    'payment_disputed',
  ]

  for (const t of nowHonoured) {
    it(`${t}: a 3-day delay is deferred, not run inline`, () => {
      assert.equal(resolveEventDelayMinutes(rule(t, 3 * 24 * 60)), 4320)
    })
  }

  it('acquisition_stage_changed honors a delay too — "welcome them 3 days after they join"', () => {
    assert.equal(resolveEventDelayMinutes(rule('acquisition_stage_changed', 4320)), 4320)
  })
})

// ---------------------------------------------------------------------------
// Refusals — each one is a decision, not an omission.
// ---------------------------------------------------------------------------

describe('resolveEventDelayMinutes — triggers refused a delay', () => {
  it('session_ended is refused HERE because onSessionWrite owns its Tier 2 path', () => {
    // fireEventRules only ever sees session_ended on the already-ended backfill
    // path, where the session is in the past and a delay is meaningless.
    // Deferring here would change the one path that already worked.
    assert.equal(resolveEventDelayMinutes(rule('session_ended', 4320)), 0)
  })

  it('inbound_webhook is refused by name — a task would persist the caller POST body', () => {
    assert.equal(resolveEventDelayMinutes(rule('inbound_webhook', 60)), 0)
  })

  it('schedule_daily and manual are not event triggers and are refused', () => {
    assert.equal(resolveEventDelayMinutes(rule('schedule_daily', 60)), 0)
    assert.equal(resolveEventDelayMinutes(rule('manual', 60)), 0)
  })

  it('ANY trigger carrying a payload is refused — a task body is persisted', () => {
    assert.equal(
      resolveEventDelayMinutes(rule('contact_created', 60), { payload: { token: 'secret' } }),
      0
    )
  })

  it('an empty payload object is not a payload and does not block the delay', () => {
    assert.equal(resolveEventDelayMinutes(rule('contact_created', 60), { payload: {} }), 60)
  })

  it('a context with no payload (just an eventId) does not block the delay', () => {
    assert.equal(resolveEventDelayMinutes(rule('contact_created', 60), { eventId: 'e1' }), 60)
  })
})

// ---------------------------------------------------------------------------
// The Cloud Tasks ceiling.
// ---------------------------------------------------------------------------

describe('clampDelayMinutes — the 30-day Cloud Tasks ceiling', () => {
  it('MAX_DELAY_MINUTES is 30 days', () => {
    assert.equal(MAX_DELAY_MINUTES, 43200)
  })

  it('passes a delay under the ceiling through unchanged', () => {
    assert.equal(clampDelayMinutes(4320), 4320)
  })

  it('clamps rather than dropping — a 90-day rule fires at 30 days, it does not vanish', () => {
    assert.equal(clampDelayMinutes(90 * 24 * 60), MAX_DELAY_MINUTES)
  })

  it('floors a fractional delay', () => {
    assert.equal(clampDelayMinutes(90.7), 90)
  })

  it('zero and below mean inline', () => {
    assert.equal(clampDelayMinutes(0), 0)
    assert.equal(clampDelayMinutes(-1), 0)
  })
})

// ---------------------------------------------------------------------------
// The dedup key. Getting this wrong double-sends (too loose) or suppresses a
// legitimate later firing forever (too tight).
// ---------------------------------------------------------------------------

describe('buildEventIdempotencyKey', () => {
  it('is stable for the same rule and the same event — a duplicate delivery collapses', () => {
    const a = buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 'evt-abc' })
    const b = buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 'evt-abc' })
    assert.equal(a, b)
  })

  it('separates two rules reacting to the same event', () => {
    assert.notEqual(
      buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 'evt-abc' }),
      buildEventIdempotencyKey({ ruleId: 'r2', occurrenceId: 'evt-abc' })
    )
  })

  it('separates two occurrences of the same rule — a second booking is not suppressed', () => {
    assert.notEqual(
      buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 'evt-jan' }),
      buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 'evt-mar' })
    )
  })

  it('folds in the subscription delta — one write emitting two adds is two occurrences', () => {
    assert.notEqual(
      buildEventIdempotencyKey({
        ruleId: 'r1',
        occurrenceId: 'evt-abc',
        delta: { subscriptionTypeId: 'sub_a' },
      }),
      buildEventIdempotencyKey({
        ruleId: 'r1',
        occurrenceId: 'evt-abc',
        delta: { subscriptionTypeId: 'sub_b' },
      })
    )
  })

  it('folds in the affiliation delta the same way', () => {
    assert.notEqual(
      buildEventIdempotencyKey({
        ruleId: 'r1',
        occurrenceId: 'evt-abc',
        delta: { affiliationTypeKey: 'club' },
      }),
      buildEventIdempotencyKey({
        ruleId: 'r1',
        occurrenceId: 'evt-abc',
        delta: { affiliationTypeKey: 'federation' },
      })
    )
  })

  it('an absent delta does not change the key of a delta-free trigger', () => {
    assert.equal(
      buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 'evt-abc', delta: {} }),
      buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 'evt-abc' })
    )
  })

  it('does not collide with a session key, which is {ruleId}:{sessionId}', () => {
    // The 'evt' prefix keeps the two namespaces apart in one automation_logs
    // collection, so an event occurrence can never be mistaken for a session id.
    const key = buildEventIdempotencyKey({ ruleId: 'r1', occurrenceId: 's1' })
    assert.equal(key, 'evt:r1:s1')
    assert.notEqual(key, 'r1:s1')
  })
})

// ---------------------------------------------------------------------------
// Cross-boundary parity: the builder's supportsDelay flag vs what the engine
// will actually defer. Reads BOTH sources, in the spirit of
// connect/commitSites.test.ts — a bare claim in a comment would rot silently.
// ---------------------------------------------------------------------------

describe('TRIGGER_OPTIONS.supportsDelay agrees with the engine', () => {
  const pagePath = path.join(
    __dirname,
    '../../../../apps/web/src/app/[locale]/(auth)/automations/page.tsx'
  )

  function readTriggerOptions(): { value: string; supportsDelay: boolean }[] {
    const src = fs.readFileSync(pagePath, 'utf8')
    const block = src.slice(src.indexOf('const TRIGGER_OPTIONS = ['))
    const body = block.slice(0, block.indexOf('\n]'))
    const out: { value: string; supportsDelay: boolean }[] = []
    const re = /\{\s*value:\s*'([^']+)',[^}]*?supportsDelay:\s*(true|false)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      out.push({ value: m[1], supportsDelay: m[2] === 'true' })
    }
    return out
  }

  it('finds the builder trigger list (the test is worthless if the shape moved)', () => {
    const opts = readTriggerOptions()
    assert.ok(opts.length >= 12, `expected the full trigger list, parsed ${opts.length}`)
    assert.ok(opts.some((o) => o.value === 'session_ended'))
    assert.ok(opts.some((o) => o.value === 'contact_created'))
  })

  it('every trigger offered a delay in the builder is one the engine defers', () => {
    for (const opt of readTriggerOptions().filter((o) => o.supportsDelay)) {
      const type = opt.value as AutomationTriggerType
      if (type === 'session_ended') {
        // Deferred, but by onSessionWrite against the session's end time —
        // fireEventRules deliberately refuses it. The promise is still kept.
        assert.equal(resolveEventDelayMinutes(rule(type, 60)), 0)
        continue
      }
      assert.equal(
        resolveEventDelayMinutes(rule(type, 60)),
        60,
        `${type} offers a delay the engine would not honour`
      )
    }
  })

  it('every trigger the engine refuses is marked supportsDelay: false (except session_ended)', () => {
    for (const opt of readTriggerOptions()) {
      const type = opt.value as AutomationTriggerType
      if (type === 'session_ended') continue
      const deferred = resolveEventDelayMinutes(rule(type, 60)) > 0
      assert.equal(
        deferred,
        opt.supportsDelay,
        `${type}: builder says supportsDelay=${opt.supportsDelay}, engine defers=${deferred}`
      )
    }
  })
})
