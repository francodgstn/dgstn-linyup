// Provider cost/usage — the payload reducer, and the one cross-boundary
// contract that would otherwise break in silence.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BILLING_BUDGET_TOPIC, budgetNotificationToSnapshot } from './budgetNotification'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

describe('billing budget topic name — a contract with Terraform', () => {
  // A Pub/Sub trigger on a topic nothing publishes to looks exactly like a quiet
  // month: no error, no empty state, just a figure that never updates. The two
  // sides of the name live in different languages in different directories, so
  // this is asserted rather than commented (CLAUDE.md — a claim about other
  // code belongs in a test, where it is executable).
  it('matches the default in infra/modules/budget/variables.tf', () => {
    const tf = readFileSync(join(REPO_ROOT, 'infra/modules/budget/variables.tf'), 'utf8')
    const block = tf.slice(tf.indexOf('variable "cost_feed_topic_name"'))
    const m = /default\s*=\s*"([^"]+)"/.exec(block)
    assert.ok(m, 'cost_feed_topic_name has no default in variables.tf')
    assert.equal(
      m[1],
      BILLING_BUDGET_TOPIC,
      'the Terraform topic name and BILLING_BUDGET_TOPIC have diverged — the cost feed would go silent',
    )
  })

  it('the budget module actually publishes to that topic', () => {
    const tf = readFileSync(join(REPO_ROOT, 'infra/modules/budget/main.tf'), 'utf8')
    assert.match(tf, /pubsub_topic\s*=/, 'all_updates_rule does not set pubsub_topic')
    assert.match(
      tf,
      /billing-budgets@system\.gserviceaccount\.com/,
      'the billing service agent is not a publisher on the topic, so delivery would fail silently',
    )
  })
})

describe('budgetNotificationToSnapshot', () => {
  const NOW = 1_757_000_000_000

  it('reads a well-formed notification', () => {
    const out = budgetNotificationToSnapshot(
      {
        budgetDisplayName: 'Linyup prod budget',
        costAmount: 12.34,
        budgetAmount: 500,
        currencyCode: 'CHF',
        costIntervalStart: '2026-09-01T00:00:00Z',
      },
      NOW,
    )
    assert.deepEqual(out, {
      month_to_date: 12.34,
      budget_amount: 500,
      currency: 'CHF',
      interval_start: '2026-09-01',
      received_at_ms: NOW,
    })
  })

  it('writes NOTHING when the cost is missing — a zero would be a claim', () => {
    // The failure this guards: a schema change drops or renames costAmount, and
    // the page cheerfully reports that we spent nothing this month.
    assert.equal(budgetNotificationToSnapshot({ currencyCode: 'CHF' }, NOW), null)
    assert.equal(budgetNotificationToSnapshot({ costAmount: null, currencyCode: 'CHF' }, NOW), null)
    assert.equal(
      budgetNotificationToSnapshot({ costAmount: 'not a number', currencyCode: 'CHF' }, NOW),
      null,
    )
  })

  it('writes nothing without a currency — an amount with no unit is not a cost', () => {
    assert.equal(budgetNotificationToSnapshot({ costAmount: 10 }, NOW), null)
  })

  it('accepts a numeric string, because JSON payloads carry both', () => {
    const out = budgetNotificationToSnapshot(
      { costAmount: '7.5', budgetAmount: '100', currencyCode: 'CHF' },
      NOW,
    )
    assert.equal(out?.month_to_date, 7.5)
    assert.equal(out?.budget_amount, 100)
  })

  it('keeps the cost when only the budget or interval is unusable', () => {
    // A partial payload still carries the number worth having; only the
    // optional context degrades to null.
    const out = budgetNotificationToSnapshot(
      { costAmount: 3, currencyCode: 'CHF', costIntervalStart: 'nonsense' },
      NOW,
    )
    assert.equal(out?.month_to_date, 3)
    assert.equal(out?.budget_amount, null)
    assert.equal(out?.interval_start, null)
  })

  it('tolerates junk instead of an object', () => {
    for (const junk of [null, undefined, 'string', 42, []]) {
      assert.equal(budgetNotificationToSnapshot(junk, NOW), null, `junk: ${JSON.stringify(junk)}`)
    }
  })
})

describe('the honest-blank rule holds across the readers', () => {
  // The rule is worth an executable check because it is a rule about ABSENCE,
  // and absence is what a well-meaning edit adds a `?? 0` to.
  it('no reader of a provider block defaults it to zero', () => {
    for (const rel of [
      'packages/functions/src/analytics/providerUsage.ts',
      'apps/admin/src/lib/queries/providerCosts.ts',
    ]) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      const code = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n')
      // Match the member access on ANY receiver, not just `providers.x` — a
      // real `?? 0` lands on whichever local holds the block (`p.gcp`,
      // `m.providers?.brevo`, …). The first version of this pin required the
      // literal `providers.` prefix and so passed against the very edit it
      // exists to catch.
      assert.doesNotMatch(
        code,
        /\.(gcp|brevo|deepl)\b[^\n]*\?\?\s*0/,
        `${rel} defaults a provider BLOCK to zero — an absent block means "not measured"`,
      )
      // And the figures inside a block, which is the likelier slip.
      assert.doesNotMatch(
        code,
        /\b(month_to_date|characters_used|character_limit|budget_amount)\b[^\n]*\?\?\s*0/,
        `${rel} defaults a provider FIGURE to zero`,
      )
    }
  })
})
