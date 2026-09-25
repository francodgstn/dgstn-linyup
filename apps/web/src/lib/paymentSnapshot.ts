// Builds the OPTIMISTIC client-side `ContactPaymentSnapshot` the shared
// `resolvePaymentOptions` (@linyup/shared) consumes for price/coverage DISPLAY
// only — booking/checkout callables always re-resolve authoritatively server-side
// (see packages/functions/src/booking/access.ts `loadContactPaymentSnapshot`,
// which additionally classifies each held type as unmetered vs credit-metered via
// a Firestore read — the impure part that has no client equivalent).
//
// The web only ever has the client mirror `held_subscription_type_ids` (already a
// union of live subscriptions + usable credit packs — see
// `Activity.heldSubscriptionTypeIds` in packages/shared/src/types/activity.ts), so
// every id is reported as unmetered and `heldCreditTypes` stays empty. This
// reproduces today's optimistic client behavior exactly: a held credit-pack type
// is treated as "covered", never as "spend one credit" — the server is what
// actually spends the credit atomically at booking time.

import { GUEST_SNAPSHOT, type ContactPaymentSnapshot } from '@linyup/shared'

export { GUEST_SNAPSHOT }

export function clientPaymentSnapshot(args: {
  authenticated: boolean
  /** acquisition_stage === 'joined'. Defaults to true — every verified public
   *  contact session used for pricing display today is treated as joined
   *  (today's optimistic assumption; the server checks this for real). */
  joined?: boolean
  heldSubscriptionTypeIds?: string[] | null
  ownsCourse?: boolean
}): ContactPaymentSnapshot {
  if (!args.authenticated) return GUEST_SNAPSHOT
  return {
    authenticated: true,
    joined: args.joined ?? true,
    heldUnmeteredTypeIds: args.heldSubscriptionTypeIds ?? [],
    heldCreditTypes: [],
    ownsCourse: args.ownsCourse,
  }
}
