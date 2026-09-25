// The automation events one contact write produces — the pure half of
// `onContactWrite`, kept free of firebase imports so its tests run the real
// code rather than a copy of it.
//
// PLAN EVENTS DIFF THE STORED PLAN LIST. `held_plan_type_ids` is the flat
// mirror `recomputeHeldPlans` writes (docs/multi-plan-holdings.md): every plan
// type held when it was last computed, whatever holds it — a staff grant, a
// purchase, a Stripe subscription, a credit pack. Each type that appears fires
// `subscription_added`, each that goes fires `subscription_removed` (a single
// write can emit several), and the coarse `subscription_changed` follows.
//
// It is the STORED list that is compared, not one re-derived against the clock:
// a grant that simply runs out is not a write, and the event for it arrives
// when the daily `refreshHeldPlans` job rewrites the mirror. Comparing both
// sides against "now" would make that rewrite look like no change at all.
import { ACQUISITION_STAGES } from '@linyup/shared'
import type { AutomationTriggerType, EventDelta } from '../utils/automationEngine'

type Doc = Record<string, unknown>

const stageRank = (stage: unknown): number =>
  (ACQUISITION_STAGES as readonly string[]).indexOf(stage as string)

/** The plan types on the contact's stored plan-list mirror. */
export function resolveHeldTypeIds(doc: Doc | undefined): Set<string> {
  const ids = new Set<string>()
  const list = doc?.held_plan_type_ids
  if (!Array.isArray(list)) return ids
  for (const id of list) if (typeof id === 'string' && id) ids.add(id)
  return ids
}

/**
 * The subscription type ids this contact holds that are set to END — a live
 * membership the member has asked Stripe to stop renewing.
 *
 * Read off `active_subscriptions[].cancelling`, which
 * `rollupMemberSubscriptions` stamps. Keyed by type id, so the trigger fires
 * once per SUBSCRIPTION rather than once per contact write: a member with two
 * memberships who cancels one has one event to act on, not an ambiguous
 * "something changed".
 */
export function resolveCancellingSubIds(doc: Doc | undefined): Set<string> {
  const ids = new Set<string>()
  const active = doc?.active_subscriptions as
    | Array<{ subscription_type_id?: string; cancelling?: boolean }>
    | undefined
  for (const s of active ?? []) {
    if (s.cancelling === true && s.subscription_type_id) ids.add(s.subscription_type_id)
  }
  return ids
}

export interface ContactEvent {
  triggerType: AutomationTriggerType
  delta?: EventDelta
}

/**
 * The ordered list of automation events to fire for a single contact write.
 * Empty when no relevant change is detected (including deletes).
 */
export function resolveContactEvents(
  before: Doc | undefined,
  after: Doc | undefined
): ContactEvent[] {
  if (!after) return [] // deleted — no automation on delete

  const events: ContactEvent[] = []

  // New document — contact created
  if (!before) {
    events.push({ triggerType: 'contact_created' })
    return events
  }

  // acquisition_stage advanced (trial_booked → trial_attended → joined).
  // Only FORWARD moves fire automation. A backward move is a manual correction
  // (undoing a mistaken promotion) and must not re-trigger outreach rules.
  if (
    before.acquisition_stage !== after.acquisition_stage &&
    stageRank(after.acquisition_stage) > stageRank(before.acquisition_stage)
  ) {
    events.push({ triggerType: 'acquisition_stage_changed' })
  }

  // Plan delta — diff the stored plan-list mirror.
  const beforeIds = resolveHeldTypeIds(before)
  const afterIds = resolveHeldTypeIds(after)
  const added = [...afterIds].filter((id) => !beforeIds.has(id))
  const removed = [...beforeIds].filter((id) => !afterIds.has(id))

  if (
    added.length > 0 ||
    removed.length > 0 ||
    before.subscription_status !== after.subscription_status
  ) {
    for (const id of added)
      events.push({ triggerType: 'subscription_added', delta: { subscriptionTypeId: id } })
    for (const id of removed)
      events.push({ triggerType: 'subscription_removed', delta: { subscriptionTypeId: id } })
    // The coarse trigger, so rules that watch 'subscription_changed' keep working.
    events.push({ triggerType: 'subscription_changed' })
  }

  // ── Billing events, as CONTACT deltas ───────────────────────────────────────
  // Both are TRANSITIONS, never states. A rule must fire when the member asks to
  // cancel, not on every subsequent write while the cancellation stands — a
  // recurring event on a standing fact is how an automation mails somebody the
  // same win-back offer every time an unrelated field is touched.
  //
  // They are read from the rollup rather than from the Stripe webhook on
  // purpose: `rollupMemberSubscriptions` puts both facts on this document from
  // EVERY write path, so a cancellation recorded by the manager callable, by a
  // seed or by the webhook all fire the same rule.
  const beforeCancelling = resolveCancellingSubIds(before)
  for (const id of resolveCancellingSubIds(after)) {
    if (!beforeCancelling.has(id)) {
      events.push({
        triggerType: 'subscription_cancel_requested',
        delta: { subscriptionTypeId: id },
      })
    }
  }

  // 'past_due' IS the failed invoice: the rollup maps Stripe's past_due/unpaid
  // onto it, so the transition into it is the moment the payment failed.
  if (before.subscription_status !== 'past_due' && after.subscription_status === 'past_due') {
    events.push({ triggerType: 'subscription_payment_failed' })
  }

  return events
}
