// The drop-in rail's PRICING inputs, in one place.
//
// Extracted in Wave 3 Phase 3 (P3-G) because a second consumer appeared:
// `previewPromoCode` has to quote the price a drop-in checkout WOULD charge, and
// N22 makes that a hard requirement rather than a nicety — "the preview cannot
// quote a price the checkout would not charge". The divergence that rule exists
// to stop is not hypothetical:
//
//   createDropInCheckout meters usage limits against the CLASS'S OWN WEEK
//   (usageAt = session.start). A preview metering against `now` would resolve a
//   "3 per week" member who has spent this week's allowance as UNCOVERED for a
//   class nine days out, quote them a discounted drop-in, and then the checkout
//   would throw "You can already book this class for free".
//
// So both callers build the target through `buildDropInTarget` and the snapshot
// through `resolveDropInForContact`, and neither may read the activity's pricing
// fields directly.

import {
  normalizeBenefit,
  resolveActivityAccessRule,
  resolvePaymentOptions,
  type ActivityAccessRule,
  type AnyBenefit,
  type DropInTarget,
  type PaymentContext,
  type PaymentOptionsResult,
  resolveActivityDropIn,
  type ActivityDropIn,
  type ActivityType,
  type DropInPrice,
} from '@linyup/shared'
import { loadContactPaymentSnapshot } from './access'

/** Which door of a class the caller asked for, and whether it is open. */
export type DropInDoor =
  | {
      ok: true
      /** THE target the resolver prices — coverage rule, list price, member
       *  benefit and the trial door, all from the one activity document. */
      target: DropInTarget
      /** The AUTHORED base price of the requested door, major units. Validated
       *  by the callable with requireChargeableAmountFromMajor; a derived price
       *  clamps instead of throwing (shared/utils/money.ts). */
      baseMajor: number
      accessRule: ActivityAccessRule
    }
  /** The requested door is not configured. Reported as two distinct reasons
   *  because the callable's two refusals read differently to a visitor — "this
   *  class has no drop-in" vs "this class offers no paid trial" — while the
   *  promo preview maps both to `not_applicable`. */
  | { ok: false; reason: 'drop_in_unavailable' | 'trial_unavailable' }

/**
 * Activity document → the ONE `DropInTarget` the resolver prices, for the door
 * the caller asked for. Pure: no reads, no throws. The callable keeps its own
 * HttpsError messages by switching on `reason`.
 */
export function buildDropInTarget(
  activity: FirebaseFirestore.DocumentData,
  opts: { asTrial: boolean },
  /** The studio's default drop-in price (`studioDropInOf(bookingSettings)`),
   *  which a class that names no price of its own follows. REQUIRED, not
   *  optional: a caller that forgets it would price such a class as having no
   *  drop-in, silently, and every rail this feeds has the settings in hand. */
  studioDropIn: DropInPrice | null
): DropInDoor {
  // THE ONE READER (shared/utils/dropIn.ts).
  const dropIn = resolveActivityDropIn(
    {
      type: activity.type as ActivityType | undefined,
      accessRule: activity.accessRule as ActivityAccessRule | undefined,
      isFreeTrial: activity.isFreeTrial as boolean | undefined,
      dropIn: activity.dropIn as ActivityDropIn | undefined,
    },
    studioDropIn
  )
  const trialPriceAmount = activity.trialPriceAmount as number | null | undefined
  const accessRule = resolveActivityAccessRule({
    accessRule: activity.accessRule as ActivityAccessRule | undefined,
    isFreeTrial: activity.isFreeTrial as boolean | undefined,
  })

  // The drop-in enabled/priced requirement does NOT apply in trial mode — a
  // class can offer a paid trial with no drop-in configured at all.
  if (opts.asTrial) {
    if (activity.trialEnabled !== true || typeof trialPriceAmount !== 'number') {
      return { ok: false, reason: 'trial_unavailable' }
    }
  } else if (!dropIn.enabled) {
    return { ok: false, reason: 'drop_in_unavailable' }
  }

  return {
    ok: true,
    accessRule,
    baseMajor: opts.asTrial ? (trialPriceAmount as number) : (dropIn.priceAmount as number),
    target: {
      kind: 'drop_in',
      accessRule,
      dropIn,
      trial: { enabled: activity.trialEnabled === true, priceAmount: trialPriceAmount ?? null },
      asTrial: opts.asTrial,
      benefit: (activity.memberBenefit as AnyBenefit | undefined) ?? null,
    },
  }
}

/**
 * Resolve the drop-in payment options for a KNOWN contact — the SAME semantics
 * bookSession uses, via the shared resolver:
 *  • a usable lesson-credit balance counts as covered (a member with credits
 *    left must not be sold a redundant drop-in);
 *  • an EXHAUSTED/expired pack does NOT count — that contact gets to pay,
 *    fixing the old deadlock where bookSession denied no_credits while the
 *    previous field-only check also refused the drop-in;
 *  • a held benefit type reduces the drop-in price (member rate — percent_off
 *    or fixed_price on Activity.memberBenefit);
 *  • a promo code (Phase 3) competes with that member rate, best-one-wins,
 *    inside the resolver. It arrives as `context`, never as a snapshot or
 *    target field.
 */
export async function resolveDropInForContact(
  teamId: string,
  target: DropInTarget,
  contact: FirebaseFirestore.DocumentData & { id: string },
  /** Session start — meters usage limits against the week the class happens. */
  usageAt?: Date,
  context?: PaymentContext
): Promise<PaymentOptionsResult> {
  const benefit = normalizeBenefit(target.benefit)
  const snapshot = await loadContactPaymentSnapshot({
    teamId,
    contact,
    relevantTypeIds: [
      ...(target.accessRule.subscriptionTypeIds ?? []),
      ...(benefit?.subscriptionTypeIds ?? []),
    ],
    usageAt,
  })
  return resolvePaymentOptions(snapshot, target, context)
}
