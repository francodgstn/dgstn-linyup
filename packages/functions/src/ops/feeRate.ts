/**
 * Operator-only: bring a tenant's live member subscriptions onto the platform-fee
 * rate that applies now. See `connect/feeRateSync.ts` for why subscriptions need
 * this and one-off payments do not.
 *
 * The console SETS the rate (a server action writing `flags.fee_rate`, like the
 * comp); this callable exists only because updating a subscription is a Stripe
 * call on the studio's connected account, and the console holds no Stripe key.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { requireOperator } from '../utils/operator'
import { resyncTenantSubscriptionFees } from '../connect/feeRateSync'

export const resyncTenantFeeRate = onCall({ timeoutSeconds: 300 }, async (request) => {
  const operator = requireOperator(request)
  const data = (request.data ?? {}) as { kind?: string; entityId?: string }
  if (data.kind !== 'team' && data.kind !== 'org') {
    throw new HttpsError('invalid-argument', "kind must be 'team' or 'org'")
  }
  if (!data.entityId || typeof data.entityId !== 'string') {
    throw new HttpsError('invalid-argument', 'entityId is required')
  }

  const results = await resyncTenantSubscriptionFees(data.kind, data.entityId)
  console.log(
    `[fee-resync] ${data.kind}/${data.entityId} by ${operator}:`,
    JSON.stringify(results)
  )
  return { results }
})
