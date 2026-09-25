import assert from 'node:assert/strict'
import { StripeAdapter } from './stripe'
import type { StripeGatewayConfig } from '@linyup/shared'

// The SaaS rail's cancel/reactivate calls, pinned at the PARAMETER level.
//
// WHY THIS IS WORTH A FIXTURE: the failure it guards is not a wrong field, it is
// a REJECTED REQUEST. `subscriptions.update` refuses to accept both cancellation
// parameters at once, so a reactivate that sends both does not partly work — it
// throws, every time, and the studio stays canceled. Verified against a live
// Stripe test account on 2026-04-22.dahlia:
//
//   update{cancel_at_period_end:false, cancel_at:''}
//     → StripeInvalidRequestError: "Received both cancel_at_period_end and
//       cancel_at parameters. Please pass in only one."
//
// and, in the same session, that `cancel_at_period_end:false` ALONE clears the
// cancellation from all three shapes Stripe can be left in — an API cancel, an
// explicit `cancel_at: <timestamp>` (the billing-portal shape), and
// `cancel_at: 'max_period_end'` — returning cancel_at, canceled_at and
// cancellation_details all null.
//
// Nothing here talks to Stripe. It records the calls the adapter makes.

interface RecordedUpdate {
  id: string
  params: Record<string, unknown>
}

function adapterWithRecorder(): { adapter: StripeAdapter; calls: RecordedUpdate[] } {
  const calls: RecordedUpdate[] = []
  const adapter = StripeAdapter.withSecretKey(
    { type: 'stripe' } as unknown as StripeGatewayConfig,
    'sk_test_not_used'
  )
  // The adapter owns its Stripe client; swap in a recorder for the one method
  // these two calls touch.
  ;(adapter as unknown as { stripe: unknown }).stripe = {
    subscriptions: {
      update: async (id: string, params: Record<string, unknown>) => {
        calls.push({ id, params })
        return {}
      },
    },
  }
  return { adapter, calls }
}

describe('StripeAdapter cancellation parameters', () => {
  it('reactivate sends cancel_at_period_end:false and NOTHING else', async () => {
    const { adapter, calls } = adapterWithRecorder()
    await adapter.reactivateSubscription({ subscriptionId: 'sub_123' })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].id, 'sub_123')
    assert.deepEqual(calls[0].params, { cancel_at_period_end: false })
  })

  it('reactivate NEVER sends cancel_at alongside the boolean — Stripe rejects the pair', async () => {
    // Stated as its own assertion rather than folded into the deepEqual above,
    // because THIS is the regression: the combination is a hard API error, so a
    // future edit that reintroduces `cancel_at: ''` "to be thorough" breaks every
    // reactivation on the SaaS billing rail.
    const { adapter, calls } = adapterWithRecorder()
    await adapter.reactivateSubscription({ subscriptionId: 'sub_123' })

    const keys = Object.keys(calls[0].params)
    assert.ok(!keys.includes('cancel_at'), `cancel_at must not be sent; got ${keys.join(', ')}`)
    assert.equal(keys.length, 1, `exactly one cancellation parameter; got ${keys.join(', ')}`)
  })

  it('cancel sends the boolean, so the two calls are exact inverses', async () => {
    const { adapter, calls } = adapterWithRecorder()
    await adapter.cancelSubscription({ subscriptionId: 'sub_123' })

    assert.deepEqual(calls[0].params, { cancel_at_period_end: true })
  })
})
