// Tier 1 event trigger — fires automation rules in real-time when a contact document
// is created or has key fields updated.
//
// It also owns the two BILLING triggers (`subscription_cancel_requested`,
// `subscription_payment_failed`). They live here rather than in the Stripe
// webhook because the rollup already lands both facts on the contact document
// from every write path — see the note beside them below.
//
// Subscription delta logic:
//   Before/after active_subscriptions arrays are diffed by subscription_type_id.
//   The legacy primary field (subscription_type_id) is folded into both sides so
//   contacts that only carry the primary field (manual assignment, pre-Stripe data)
//   are handled correctly. Each added/removed type id fires one subscription_added /
//   subscription_removed event — a single write can emit multiple events.
//
// Trigger path: contacts/{contactId}
// Contacts are top-level with a teamId field — teamId is read from the document.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { ACQUISITION_STAGES } from '@linyup/shared'
import {
  fireEventRules,
  type ContactData,
  type AutomationTriggerType,
  type EventDelta,
} from '../utils/automationEngine'

const stageRank = (stage: unknown): number =>
  (ACQUISITION_STAGES as readonly string[]).indexOf(stage as string)

/**
 * Builds the set of subscription type IDs a contact holds from a Firestore document
 * snapshot. Combines active_subscriptions (multi-sub array) with the legacy primary
 * subscription_type_id so both representations are covered.
 */
/**
 * The subscription type ids this contact holds that are set to END — a live
 * membership the member has asked Stripe to stop renewing.
 *
 * Read off `active_subscriptions[].cancelling`, which
 * `rollupMemberSubscriptions` stamps. Deliberately keyed by type id like
 * `resolveSubIds`, so the trigger fires once per SUBSCRIPTION rather than once
 * per contact write: a member with two memberships who cancels one has one event
 * to act on, not an ambiguous "something changed".
 */
function resolveCancellingSubIds(doc: FirebaseFirestore.DocumentData | undefined): Set<string> {
  const ids = new Set<string>()
  const active = doc?.active_subscriptions as
    | Array<{ subscription_type_id?: string; cancelling?: boolean }>
    | undefined
  for (const s of active ?? []) {
    if (s.cancelling === true && s.subscription_type_id) ids.add(s.subscription_type_id)
  }
  return ids
}

function resolveSubIds(doc: FirebaseFirestore.DocumentData | undefined): Set<string> {
  const ids = new Set<string>()
  if (!doc) return ids
  const primary = doc.subscription_type_id as string | undefined
  if (primary) ids.add(primary)
  const active = doc.active_subscriptions as Array<{ subscription_type_id: string }> | undefined
  for (const s of active ?? []) {
    if (s.subscription_type_id) ids.add(s.subscription_type_id)
  }
  return ids
}

interface ContactEvent {
  triggerType: AutomationTriggerType
  delta?: EventDelta
}

/**
 * Computes the ordered list of automation events to fire for a single contact write.
 * Returns an empty array when no relevant change is detected (including deletes).
 */
function resolveContactEvents(
  before: FirebaseFirestore.DocumentData | undefined,
  after: FirebaseFirestore.DocumentData | undefined
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

  // Subscription delta — diff the full set of subscription type IDs.
  const beforeSubIds = resolveSubIds(before)
  const afterSubIds = resolveSubIds(after)

  const hasSubChange =
    before.subscription_type_id !== after.subscription_type_id ||
    before.subscription_status !== after.subscription_status ||
    JSON.stringify([...beforeSubIds].sort()) !== JSON.stringify([...afterSubIds].sort())

  if (hasSubChange) {
    // Fire delta events for each added/removed type
    for (const id of afterSubIds) {
      if (!beforeSubIds.has(id)) {
        events.push({
          triggerType: 'subscription_added',
          delta: { subscriptionTypeId: id },
        })
      }
    }
    for (const id of beforeSubIds) {
      if (!afterSubIds.has(id)) {
        events.push({
          triggerType: 'subscription_removed',
          delta: { subscriptionTypeId: id },
        })
      }
    }

    // Also fire the legacy coarse trigger so existing rules that watch
    // 'subscription_changed' keep working without migration.
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
  const afterCancelling = resolveCancellingSubIds(after)
  for (const id of afterCancelling) {
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

export const onContactWrite = onDocumentWritten(
  'contacts/{contactId}',
  async (event) => {
    const before = event.data?.before?.data()
    const after = event.data?.after?.data()

    const contactEvents = resolveContactEvents(before, after)
    if (contactEvents.length === 0) return

    const teamId = (after?.teamId || before?.teamId) as string | undefined
    if (!teamId) {
      console.log(`[onContactWrite] contact=${event.params.contactId}: no teamId, skipping`) // eslint-disable-line no-console
      return
    }

    // Skip deleted, archived or external contacts on update triggers — an
    // external buying a partner-app plan must not fire the welcome sequence.
    if (after && (after.deleted_at || after.archived_at || after.external)) return

    const contact: ContactData = {
      id: event.params.contactId,
      ...(after as Omit<ContactData, 'id'>),
    }

    for (const { triggerType, delta } of contactEvents) {
      console.log(`[onContactWrite] contact=${event.params.contactId} team=${teamId} trigger=${triggerType}${delta?.subscriptionTypeId ? ` subId=${delta.subscriptionTypeId}` : ''}`) // eslint-disable-line no-console
      // event.id is the CloudEvent id of this write — stable across a duplicate
      // delivery, and the occurrence half of a delayed rule's dedup key.
      await fireEventRules(teamId, triggerType, [contact], { eventId: event.id }, delta)
    }
  }
)
