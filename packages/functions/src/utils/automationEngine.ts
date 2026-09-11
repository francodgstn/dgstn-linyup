// Generalized workflow automation engine for Linyup.
// Handles condition evaluation, action dispatch, and rule execution
// across all three trigger tiers: scheduled (Tier 3), event-based (Tier 1),
// and delayed via Cloud Tasks (Tier 2 — Phase 3).
//
// All three execution paths (daily scanner, event triggers, manual callable)
// funnel through runRule() for consistent behaviour.

import { randomUUID } from 'node:crypto'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { to } from './async'
import { sendEmail } from './email'
import { logActivity } from './users'
import { substituteVariables, renderBody, buildOutreachEmail } from './outreachEmail'
import { sanitizeRichHtml } from './sanitizeHtml'
import { pluginActionHandlers } from '../plugins/index'
import type {
  PluginActionId, PluginTriggerId, ContactGroup, ConsentLedger, EngagementThresholds,
} from '@linyup/shared'
import {
  consentDocumentIds,
  matchesFilter,
  TEAMS_COLLECTION, CONTACT_GROUPS_SUBCOLLECTION,
} from '@linyup/shared'
import { loadConsentLedgers } from '../waivers/consentLedger'
import { resolveRankingSystems } from './ranking'
import { findRankLevel, isKnownRankingSystem, pluginIdOfNamespacedId, rankLevelKey } from '@linyup/shared'
import { pluginIsActive } from './plugins'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutomationTriggerType =
  // Tier 3 — daily scheduled scan
  | 'schedule_daily'
  // Tier 1 — Firestore event triggers (real-time)
  | 'contact_created'
  | 'booking_confirmed'
  | 'booking_no_show'
  | 'booking_cancelled'
  | 'acquisition_stage_changed'
  // Legacy coarse subscription/affiliation triggers (back-compat; still accepted by engine)
  | 'subscription_changed'
  | 'affiliation_changed'
  // Delta-aware subscription triggers — carry the specific type that was added/removed
  | 'subscription_added'
  | 'subscription_removed'
  // Delta-aware affiliation triggers — carry the specific type_key that was added/removed
  | 'affiliation_added'
  | 'affiliation_removed'
  // ── The two billing events a studio would otherwise learn about from the bank
  //
  // Both are fired from `onContactWrite`, not from the Stripe webhook, and that
  // is the whole reason they are cheap: the rollup
  // (`rollupMemberSubscriptions`) already lands both facts on the CONTACT — a
  // live subscription stamped `cancelling`, and a failed invoice as the
  // 'past_due' rollup status. So they are contact-document deltas like every
  // other trigger here, they work for every write path (webhook, manager
  // callable, seed) rather than for one, and no money handler had to be touched
  // to add them.
  //
  /** A live subscription is set to end — the member cancelled, usually in
   *  Stripe's billing portal, and the studio has until the period end to talk to
   *  them. Fires on the transition INTO cancelling, once per subscription. */
  | 'subscription_cancel_requested'
  /** An invoice failed and the membership is now past due. Fires on the
   *  transition INTO 'past_due', never while it stays there. */
  | 'subscription_payment_failed'
  // Money events read off the PAYMENT document — automation/paymentEvents.ts owns the
  // census of their edges. The split from the two above is where the SUBJECT is, not
  // tidiness: a failed recurring charge writes a payment row with no contactId on it,
  // and a cancellation writes no payment row at all. docs/automations-money-triggers.md.
  | 'payment_received'
  | 'payment_refunded'
  | 'payment_disputed'
  // Tier 1+2 — event trigger + optional Cloud Tasks delay
  | 'session_ended'
  // Inbound webhook — external system POSTs to a team's unique URL
  | 'inbound_webhook'
  // Always available
  | 'manual'
  // Plugin-contributed triggers (namespaced: 'plugin:{pluginId}:{name}')
  | PluginTriggerId

export type AutomationCondition =
  | { type: 'bio_link_booking_no_show'; delay_days?: number; delay_hours?: number }
  | { type: 'sessions_attended_exactly'; value: number }
  | { type: 'sessions_attended_min'; value: number }
  | { type: 'sessions_attended_max'; value: number }
  | { type: 'inactivity_days'; value: number }
  | { type: 'inactivity_days_max'; value: number }
  | { type: 'acquisition_stage'; value: string }
  | { type: 'subscription'; value: string }
  | { type: 'subscription_missing' } // legacy alias → subscription: none
  | { type: 'subscription_set' } // legacy alias → subscription: any
  // Stripe billing rollup status (active/trialing/past_due/paused/cancelled/none)
  | { type: 'subscription_status'; value: string }
  | { type: 'tag'; value: string }
  | { type: 'field_equals'; field: string; value: unknown }
  // A one-off plan grant ending soon ("2 months included" runs out in ≤ N days).
  // `value`, NOT `days`: every other number condition is authored through the
  // editor's one number mapping, which writes `value`. This one asked for `days`
  // and so compared against `undefined` for every rule the editor could build —
  // one of the two reasons it was withheld from the picker. No stored rule uses
  // the old key (it was never offered), so this is a rename, not a migration.
  | { type: 'subscription_expires_in'; value: number }
  // Lifecycle
  | { type: 'days_since_created'; value: number } // created N+ days ago
  | { type: 'birthday_today' } // birthdate day+month matches today
  // Affiliation axis conditions (summary-based, no subcollection read required)
  | { type: 'has_affiliation' } // affiliation_summary.has_active === true
  | { type: 'affiliation_type'; value: string } // affiliation_summary.types includes value
  // Contact Groups plugin — is the contact in this group (subgroups included)?
  // Works for BOTH kinds: a manual group tests group_ids, a dynamic group
  // resolves its saved rule per contact. Nothing is materialized either way.
  | { type: 'in_group'; group_id: string }
  // NOTE: affiliation_status (per-affiliation status_id check) and affiliation_expires_in
  // are deferred — they require reading the affiliations subcollection per contact in the
  // scheduled scan path, which is expensive. The summary covers the primary use cases.

export type AutomationAction =
  | { type: 'send_email'; templateId: string }
  | { type: 'create_alert'; presetId: string }
  | { type: 'assign_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'update_field'; field: string; value: string | number | boolean | null }
  // Archive (never delete) the contact. The daily scan skips archived contacts,
  // so schedule_daily rules using this are naturally idempotent. Powers the
  // default 'lib_trial_cleanup' rule (stale never-attended trial bookings).
  | { type: 'archive_contact' }
  // Append a timestamped note to the contact (contact_notes subcollection). The
  // note supports the same {{firstname}}/{{date}}… placeholders as emails.
  | { type: 'add_note'; note: string }
  | { type: 'notify_team'; subject: string; body: string }
  | { type: 'log_activity'; message: string }
  | { type: 'webhook'; url: string }
  // Affiliation action — sets the status of the contact's affiliation of a given type.
  // Targets the contact's FIRST affiliation whose type_key matches affiliation_type_key
  // (or any affiliation if affiliation_type_key is omitted). Best-effort: no-op if none found.
  | { type: 'set_affiliation_status'; status_id: string; affiliation_type_key?: string }
  // Contact Groups plugin — add/remove a contact from a group (Contact.group_ids).
  // No-op if group_id is missing/empty.
  | { type: 'add_to_group'; group_id: string }
  | { type: 'remove_from_group'; group_id: string }
  // Plugin-contributed actions (namespaced: 'plugin:{pluginId}:{name}')
  | { type: PluginActionId; config?: Record<string, unknown> }

export interface AutomationRule {
  id: string
  name: string
  active: boolean
  trigger: {
    type: AutomationTriggerType
    delayMinutes?: number
    webhook_endpoint_id?: string // inbound_webhook: which endpoint fires this rule
    // Delta scoping for subscription_added / subscription_removed:
    // when set, the rule only fires when the specific subscription type was added/removed.
    // Absent or empty string = match ANY add/remove.
    subscriptionTypeId?: string
    // Delta scoping for affiliation_added / affiliation_removed:
    // when set, the rule only fires when the specific affiliation type_key was added/removed.
    // Absent or empty string = match ANY add/remove.
    affiliationTypeKey?: string
    // Delta scoping for the payment_* triggers: when set, the rule only fires for
    // payments of that MemberPayment.kind ('course', 'product', 'membership', …).
    // Absent or empty string = match ANY kind.
    paymentKind?: string
  }
  conditions: AutomationCondition[]
  actions: AutomationAction[]
  // Legacy fields (old format, kept for backward compat — normalizeRule converts these)
  template_id?: string
  alert_preset_id?: string
  last_run_at?: Timestamp
  last_run_sent?: number
}

export interface ContactData {
  id: string
  firstname?: string
  lastname?: string
  email?: string
  email_unsubscribed?: boolean
  acquisition_stage?: string
  subscription_type_id?: string
  subscription_status?: string
  // End of a one-off plan grant, read by `subscription_expires_in`.
  //
  // Declared as a real `Timestamp` — NOT the loose `{seconds, nanoseconds}`
  // union its neighbours carry — because `ContactData` must satisfy
  // `ContactFilterSubject`, whose `planGrantIsCurrent` calls `toMillis()`. The
  // engine reads contacts through the admin SDK, so that is what the field
  // always is; the loose union would only make a dynamic group's rule and this
  // condition disagree about the same contact.
  subscription_expires_at?: Timestamp | null
  // All currently-active subscriptions the contact holds, deduped by type.
  // Maintained by onMemberSubscriptionWrite. Absent/empty = no active subscriptions.
  // The condition evaluator checks this in addition to subscription_type_id for back-compat.
  active_subscriptions?: { subscription_type_id: string }[]
  total_sessions?: number
  last_session_at?: Timestamp | { seconds: number; nanoseconds: number } | null
  deleted_at?: Timestamp | null
  archived_at?: Timestamp | null
  // Off the roster (Contact.external). Skipped by every rule — the sweep and
  // the per-contact triggers alike — on the same line as archived: an
  // automation is the studio talking to the people it looks after.
  external?: boolean
  outreach_rules_sent?: Record<string, Timestamp>
  avatar_url?: string | null
  // Tag-based filtering + assign_tag action
  tags?: string[]
  // Lifecycle conditions
  created_at?: Timestamp | { seconds: number; nanoseconds: number } | null
  birthdate?: Timestamp | { seconds: number; nanoseconds: number } | null
  // Affiliation axis — summary maintained by onAffiliationWrite
  affiliation_summary?: { has_active: boolean; types: string[]; org_ids: string[] }
  // Read by the `in_group` condition via the shared contact predicate. Declared
  // explicitly (not left to the index signature) so ContactData satisfies
  // ContactFilterSubject — a dynamic group's rule may filter on any of these.
  group_ids?: string[]
  source?: string
  ranks?: Record<string, string | number>
  custom_fields?: Record<string, string | number | boolean>
  alerts_count?: number
  // Read by the shared `matchesFilter` for the `hasNotes` dimension. Absent
  // here, a dynamic group built on "has notes" would match nothing server-side
  // while working perfectly in the contacts list.
  notes_count?: number
  pending_signup?: boolean
  // Declared for the same reason as `group_ids` above: a dynamic group's rule
  // may filter on the coach assignment or on "needs attention", and both read
  // these off the contact document (UX-62 / UX-44).
  assigned_coach_ids?: string[]
  lead_acknowledged?: boolean
  [key: string]: unknown
}

export interface AutomationContext {
  /**
   * Trigger-supplied data addressable from action templates as {{payload.*}}.
   * For inbound_webhook this is the raw POST body. Never persisted — it lives
   * only for the duration of the run, since it may carry the caller's secrets.
   */
  payload?: Record<string, unknown>
  /**
   * The CloudEvent id of the Firestore write that fired this run. Used as the
   * OCCURRENCE half of a delayed event rule's dedup key, so a duplicate
   * delivery of the same write cannot enqueue a second sending task. Absent is
   * safe but weaker — see buildEventIdempotencyKey and the fallback in
   * fireEventRules.
   */
  eventId?: string
  /** Extra data passed by the triggering event (e.g. sessionId for session_ended) */
  [key: string]: unknown
}

/**
 * What CHANGED, for the triggers whose rules can be scoped to a part of it.
 *
 * Carries the specific type that changed so the engine can scope rules that opt-in to a
 * particular type via trigger.subscriptionTypeId / trigger.affiliationTypeKey /
 * trigger.paymentKind.
 *
 * This is also where a money trigger's facts ride — NOT in AutomationContext.payload.
 * A non-empty payload costs the run its delay (see resolveEventDelayMinutes), and that
 * loss is silent: the rule builder would still offer the field. The accepted cost of
 * the choice is that these facts are not addressable from an action template as
 * {{payload.*}}.
 */
export interface EventDelta {
  /**
   * For subscription_added / subscription_removed: the subscription_type_id that
   * changed — and for subscription_cancel_requested, the one winding down, so a rule
   * can be scoped through the same select.
   */
  subscriptionTypeId?: string
  /** For affiliation_added / affiliation_removed: the affiliation type_key that changed. */
  affiliationTypeKey?: string
  /** For the payment_* triggers: identity + money facts off the member_payments row. */
  payment?: {
    paymentIntentId: string
    /** MemberPayment.kind — what the money bought. Scoped on by trigger.paymentKind. */
    kind: string | null
    /** Gross amount of the payment, in minor units (Rappen). */
    amountMinor: number
    currency: string | null
    /** payment_refunded: what THIS refund gave back, not the running total. */
    refundAmountMinor?: number
    /** payment_refunded: whether the payment is now fully refunded. */
    refundIsFull?: boolean
    /** payment_disputed: Stripe's dispute status at the moment it first appeared. */
    disputeStatus?: string
  }
}

export interface RunRuleOptions {
  dryRun?: boolean // evaluate conditions but do not execute actions or mark sent
  triggerTier?: 'event' | 'delayed' | 'scheduled' | 'manual'
  force?: boolean // bypass dedup (used by triggerAutomationRule callable)
  context?: AutomationContext // trigger-supplied data, exposed to actions as {{payload.*}}
}

export interface RuleStats {
  processed: number
  sent: number
  skipped: number
  errors: number
  /**
   * Contact ids an action ACTUALLY RAN FOR — not everyone who matched. A contact
   * whose every action threw is counted in `errors` and is absent from here, so
   * the log answers "who got the mail" rather than "who was considered". Held
   * whole (a Set, deduped — one contact with two no-show bookings is one
   * recipient) and CAPPED only when written to the log, so `recipients_total` is
   * exact even when the stored list is a sample.
   */
  recipients: Set<string>
}

/**
 * How many recipient ids one log row carries. A run that reaches 400 people
 * stores the first 50 and says so — the row is a sample plus an exact total,
 * never a roster presented as complete (see RunHistoryDialog's copy).
 *
 * IDS, NOT NAMES OR EMAILS: `automation_logs` is readable by every manager, and
 * a resolved id is a lookup against contacts they can already read. Names in the
 * log would be a copy of contact data living outside the contact — surviving the
 * contact's deletion, and unreachable by any correction. A recipient who has
 * since been deleted therefore resolves to nothing; that is the accepted cost.
 */
export const RECIPIENT_ID_CAP = 50

/**
 * Records one recipient. Called at the single point where an action is known to
 * have succeeded for a contact, so there is no second definition of "reached".
 * Ignores an empty id — the booking path can run actions for a booking that
 * names no contact document, and a booking id in a contact-id list would resolve
 * to a stranger or to nothing.
 */
export function recordRecipient(stats: RuleStats, contactId: string | undefined): void {
  if (contactId) stats.recipients.add(contactId)
}

export interface AutomationLogData {
  rule_id: string
  rule_name: string
  triggered_at: FieldValue
  trigger_type: string
  trigger_tier: string
  contacts_matched: number
  actions_executed: number
  actions_failed: number
  /**
   * Up to RECIPIENT_ID_CAP contact ids an action ran for. ALWAYS WRITTEN (an
   * empty array when nobody was reached) so a reader can tell "this run reached
   * nobody" from "this row predates recipient recording", which is the
   * difference between two very different sentences in the UI.
   */
  recipient_ids: string[]
  /** The true number of recipients, which may exceed recipient_ids.length. */
  recipients_total: number
  error?: string
}

// ---------------------------------------------------------------------------
// normalizeRule — converts legacy hmd-lineup rule format to the new schema
// ---------------------------------------------------------------------------

/**
 * Normalises old-format rules (trigger_type field, template_id/alert_preset_id top-level)
 * into the new schema with trigger.type, conditions[], and actions[].
 * Old rules without a trigger field are treated as schedule_daily.
 */
export function normalizeRule(ruleId: string, ruleData: Record<string, unknown>): AutomationRule {
  let conditions: AutomationCondition[] = []
  let actions: AutomationAction[] = []
  let triggerType: AutomationTriggerType = 'schedule_daily'

  // Normalise conditions
  if (Array.isArray(ruleData.conditions)) {
    conditions = (ruleData.conditions as AutomationCondition[]).map((c) =>
      // legacy hmd-lineup alias → canonical bio_link_booking_no_show
      (c as { type: string }).type === 'portal_booking_pending'
        ? { ...c, type: 'bio_link_booking_no_show' as const }
        : c
    )
  } else if (ruleData.trigger_type === 'no_show_trial_booking') {
    conditions = [
      {
        type: 'bio_link_booking_no_show',
        delay_days: Math.round(((ruleData.delay_hours as number) || 24) / 24) || 1,
      },
      { type: 'sessions_attended_max', value: 0 },
    ]
  }

  // Normalise trigger
  if (ruleData.trigger && typeof ruleData.trigger === 'object') {
    const t = ruleData.trigger as { type?: string; delayMinutes?: number }
    triggerType = (t.type as AutomationTriggerType) || 'schedule_daily'
  }

  // Normalise actions — prefer explicit actions array, otherwise build from legacy fields
  if (Array.isArray(ruleData.actions) && (ruleData.actions as unknown[]).length > 0) {
    actions = ruleData.actions as AutomationAction[]
  } else {
    if (ruleData.template_id) {
      actions.push({ type: 'send_email', templateId: ruleData.template_id as string })
    }
    if (ruleData.alert_preset_id) {
      actions.push({ type: 'create_alert', presetId: ruleData.alert_preset_id as string })
    }
  }

  const trigger =
    ruleData.trigger && typeof ruleData.trigger === 'object'
      ? (ruleData.trigger as { type: AutomationTriggerType; delayMinutes?: number })
      : { type: triggerType }

  return {
    id: ruleId,
    name: (ruleData.name as string) || '',
    active: Boolean(ruleData.active),
    trigger,
    conditions,
    actions,
    template_id: ruleData.template_id as string | undefined,
    alert_preset_id: ruleData.alert_preset_id as string | undefined,
    last_run_at: ruleData.last_run_at as Timestamp | undefined,
    last_run_sent: ruleData.last_run_sent as number | undefined,
  }
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function resolveTimestampMs(ts: unknown): number | null {
  if (!ts) return null
  if (typeof (ts as Timestamp).toMillis === 'function') return (ts as Timestamp).toMillis()
  if (typeof (ts as { seconds: number }).seconds === 'number') {
    const t = ts as { seconds: number; nanoseconds?: number }
    return t.seconds * 1000 + (t.nanoseconds || 0) / 1e6
  }
  const ms = new Date(ts as string).getTime()
  return isNaN(ms) ? null : ms
}

/**
 * Evaluates non-booking conditions against a contact.
 * Returns true only when ALL applicable conditions pass (AND logic).
 * bio_link_booking_no_show conditions are skipped — they are handled by
 * the booking-based execution path.
 */
/**
 * What `in_group` needs to answer a membership question. Loaded once per team
 * per run (loadGroupContext) — a handful of docs, not per contact.
 */
export interface ConditionContext {
  groups?: ContactGroup[]
  engagementThresholds?: EngagementThresholds
  /**
   * documentId → that document's signature ledger, for every group rule that
   * filters on consent. Loaded ONCE per rule run (one query per document), never
   * per contact — see waivers/consentLedger.ts.
   */
  consent?: Record<string, ConsentLedger>
}

export function evaluateContactConditions(
  conditions: AutomationCondition[],
  contact: ContactData,
  now: Date,
  ctx: ConditionContext = {}
): boolean {
  for (const cond of conditions) {
    switch (cond.type) {
      // Group membership is a PER-CONTACT predicate, never a materialized set:
      // the contact is already in hand, so a manual group checks its group_ids
      // and a dynamic group resolves its rule right here. Both go through the
      // shared resolver so "in the group" means one thing everywhere.
      case 'in_group': {
        // Delegated, NOT reimplemented: descendant expansion, dynamic-rule
        // resolution and the not-in-context fallback all live in the shared
        // resolver. Duplicating them here is exactly the parallel check its
        // docstring forbids — the copies would drift on the next change.
        const matched = matchesFilter(
          contact,
          { groups: [cond.group_id] },
          {
            groups: ctx.groups ?? [],
            engagementThresholds: ctx.engagementThresholds,
            consent: ctx.consent,
            nowMs: now.getTime(),
          },
        )
        if (!matched) return false
        break
      }

      case 'bio_link_booking_no_show':
        // handled separately in booking path
        continue

      case 'sessions_attended_exactly':
        if ((contact.total_sessions || 0) !== cond.value) return false
        break

      case 'sessions_attended_min':
        if ((contact.total_sessions || 0) < cond.value) return false
        break

      case 'sessions_attended_max':
        if ((contact.total_sessions || 0) > cond.value) return false
        break

      case 'inactivity_days': {
        if (!contact.last_session_at) return false
        const lastMs = resolveTimestampMs(contact.last_session_at)
        if (lastMs === null) return false
        const daysSince = (now.getTime() - lastMs) / 86400000
        if (daysSince < cond.value) return false
        break
      }

      case 'inactivity_days_max': {
        if (!contact.last_session_at) return false
        const lastMs = resolveTimestampMs(contact.last_session_at)
        if (lastMs === null) return false
        const daysSince = (now.getTime() - lastMs) / 86400000
        if (daysSince > cond.value) return false
        break
      }

      case 'acquisition_stage':
        if (contact.acquisition_stage !== cond.value) return false
        break

      case 'has_affiliation':
        if (contact.affiliation_summary?.has_active !== true) return false
        break

      case 'affiliation_type':
        if (!contact.affiliation_summary?.types?.includes(cond.value)) return false
        break

      case 'subscription': {
        // Gather the full set of subscription type IDs the contact holds.
        // active_subscriptions is the authoritative multi-sub array; subscription_type_id
        // is the legacy primary field kept for back-compat. Union both to catch contacts
        // that only have the primary field set (manual assignment, pre-Stripe data).
        const activeSubs = contact.active_subscriptions ?? []
        const activeSubIds = new Set<string>(activeSubs.map((s) => s.subscription_type_id))
        if (contact.subscription_type_id) activeSubIds.add(contact.subscription_type_id)

        if (cond.value === 'none') {
          // Passes only when the contact holds NO subscriptions at all
          if (activeSubIds.size > 0) return false
        } else if (cond.value === 'any') {
          // Passes only when the contact holds at least one subscription
          if (activeSubIds.size === 0) return false
        } else {
          // Specific subscription type ID — passes when it is in the active set
          if (!activeSubIds.has(cond.value)) return false
        }
        break
      }

      case 'subscription_status':
        if ((contact.subscription_status ?? 'none') !== cond.value) return false
        break

      // legacy aliases — use the same multi-sub logic as the canonical 'subscription' condition
      case 'subscription_missing': {
        const activeSubs = contact.active_subscriptions ?? []
        const hasAny = activeSubs.length > 0 || Boolean(contact.subscription_type_id)
        if (hasAny) return false
        break
      }
      case 'subscription_set': {
        const activeSubs = contact.active_subscriptions ?? []
        const hasAny = activeSubs.length > 0 || Boolean(contact.subscription_type_id)
        if (!hasAny) return false
        break
      }

      case 'tag':
        if (!contact.tags?.includes(cond.value)) return false
        break

      case 'field_equals': {
        const contactVal = (contact as Record<string, unknown>)[cond.field]
        // eslint-disable-next-line eqeqeq
        if (contactVal != cond.value) return false // loose equality to handle string↔number
        break
      }

      case 'subscription_expires_in': {
        // THE WIN-BACK WINDOW for a one-off plan grant ("CHF 100, 2 months
        // included"). It reads `subscription_expires_at` — the same stamp the
        // booking gate compares — so the studio can reach a member BEFORE the
        // access she bought runs out.
        //
        // This is why a lazily-expiring field needs no sweep to be useful:
        // nothing fires when the date passes, but the automation scan asks every
        // contact this question on its own schedule, which is the moment the
        // studio actually cares about anyway — a few days BEFORE.
        //
        // Already-expired is deliberately NOT a match: this is "ending soon",
        // and a member whose access ran out last month is a different message on
        // a different list, not a late copy of this one.
        if (!contact.subscription_expires_at) return false
        const expiresMs = resolveTimestampMs(contact.subscription_expires_at)
        if (expiresMs === null) return false
        const daysUntil = (expiresMs - now.getTime()) / 86400000
        if (daysUntil < 0 || daysUntil > cond.value) return false
        break
      }

      case 'days_since_created': {
        if (!contact.created_at) return false
        const createdMs = resolveTimestampMs(contact.created_at)
        if (createdMs === null) return false
        const daysSince = (now.getTime() - createdMs) / 86400000
        if (daysSince < cond.value) return false
        break
      }

      case 'birthday_today': {
        if (!contact.birthdate) return false
        const bdMs = resolveTimestampMs(contact.birthdate)
        if (bdMs === null) return false
        const bday = new Date(bdMs)
        if (bday.getMonth() !== now.getMonth() || bday.getDate() !== now.getDate()) return false
        break
      }

      default:
        // Unknown condition — FAIL CLOSED. A legacy/typo'd condition must never
        // silently widen a rule's audience (an ignored `contact_type` condition once
        // turned a "welcome new trial" rule into "email every new contact", spamming
        // shop registrations). Blocking + logging makes the dead condition visible.
        console.warn(
          `[automation] unknown condition type '${(cond as { type?: string }).type}' — rule blocked (fail closed)`
        ) // eslint-disable-line no-console
        return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Pure action-payload helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns the Firestore update payload for an add_to_group or remove_from_group
 * action, or null if group_id is missing/empty (no-op guard).
 * Pure — no Firestore calls; used by executeActionsForContact and by unit tests.
 */
export function groupActionUpdate(
  action: { type: 'add_to_group' | 'remove_from_group'; group_id: string }
): { group_ids: ReturnType<typeof FieldValue.arrayUnion> | ReturnType<typeof FieldValue.arrayRemove> } | null {
  if (!action.group_id) return null
  return {
    group_ids:
      action.type === 'add_to_group'
        ? FieldValue.arrayUnion(action.group_id)
        : FieldValue.arrayRemove(action.group_id),
  }
}

// ---------------------------------------------------------------------------
// Action execution helpers
// ---------------------------------------------------------------------------

export interface ResolvedActions {
  template: Record<string, unknown> | null
  alertPreset: Record<string, unknown> | null
  language: string
  /**
   * Which of the rule's PLUGIN actions may run — the plugin ids among them that
   * are installed and active for this team (its own install, or its
   * organisation's).
   *
   * IT IS RESOLVED ONCE PER RULE, HERE, and not per contact. A rule sweeps
   * every contact in the team, so an install check inside that loop would be
   * one Firestore read per contact per action for a fact that cannot change
   * mid-sweep.
   */
  activePlugins: Set<string>
}

async function resolveActionResources(
  actions: AutomationAction[],
  teamId: string,
  teamData: Record<string, unknown>
): Promise<ResolvedActions> {
  const db = admin.firestore()
  const teamRef = db.collection('teams').doc(teamId)

  let template: Record<string, unknown> | null = null
  let alertPreset: Record<string, unknown> | null = null
  let language = (teamData.language as string) || 'en'
  const activePlugins = new Set<string>()

  // ── THE PLUGIN INSTALL GATE ────────────────────────────────────────────────
  //
  // A plugin action is a capability the studio bought, and an automation rule
  // OUTLIVES the install that justified it: compose a rule while WhatsApp is
  // installed, remove the plugin, and the rule kept sending — the dispatch
  // below trusted the stored action id and asked nothing. This is the sixth
  // install gate, and the one nobody had counted (docs/plugins.md).
  //
  // `pluginIsActive` is the same org-aware resolver every other server gate
  // uses, so an org-level install counts exactly as it does everywhere else.
  //
  // Distinct plugin ids only: a rule with three WhatsApp actions asks once.
  const pluginIds = new Set(
    actions
      .map((a) => pluginIdOfNamespacedId(a.type as string))
      .filter((id): id is string => id !== null)
  )
  for (const pluginId of pluginIds) {
    // A read failure is NOT an install. `to()` keeps a transient Firestore error
    // from aborting the whole rule, and the action is skipped for this run —
    // the safe direction for something that sends a message on the studio's
    // behalf.
    const [err, active] = await to(pluginIsActive(teamId, pluginId))
    if (err) {
      console.log(
        `[automationEngine] plugin '${pluginId}': install check failed, treating as not installed —`,
        err
      )
      continue
    }
    if (active) activePlugins.add(pluginId)
    else console.log(`[automationEngine] plugin '${pluginId}' is not installed for team ${teamId}`)
  }

  for (const action of actions) {
    if (action.type === 'send_email' && !template) {
      const [tmplErr, tmplDoc] = await to(
        teamRef.collection('outreach_templates').doc(action.templateId).get()
      )
      if (
        !tmplErr &&
        tmplDoc &&
        tmplDoc.exists &&
        (tmplDoc.data() as Record<string, unknown>).active
      ) {
        template = tmplDoc.data() as Record<string, unknown>
        language = (template.language as string) || language
      } else {
        console.log(`[automationEngine] Template ${action.templateId} not found or inactive`)
      }
    }

    if (action.type === 'create_alert' && !alertPreset) {
      const [presetErr, presetDoc] = await to(
        teamRef.collection('alert_presets').doc(action.presetId).get()
      )
      if (!presetErr && presetDoc && presetDoc.exists) {
        alertPreset = presetDoc.data() as Record<string, unknown>
      } else {
        console.log(`[automationEngine] Alert preset ${action.presetId} not found`)
      }
    }
  }

  return { template, alertPreset, language, activePlugins }
}

async function createContactAlertDoc(
  contactId: string,
  teamId: string,
  contact: ContactData,
  alertData: {
    schedule: { type: string; value: unknown }
    message: string
    alert_type?: string
    show_in_app?: boolean
  }
): Promise<void> {
  const alertRef = admin
    .firestore()
    .collection('contacts')
    .doc(contactId)
    .collection('contact_alerts')
    .doc()

  await alertRef.set({
    teamId,
    contact: {
      id: contactId,
      firstname: contact.firstname || '',
      lastname: contact.lastname || '',
      avatar_url: contact.avatar_url || null,
    },
    schedule: alertData.schedule,
    message: alertData.message || '',
    alert_type: alertData.alert_type || null,
    show_in_app: alertData.show_in_app || false,
    created_at: FieldValue.serverTimestamp(),
    archived_at: null,
  })
}

/**
 * Returns true if the rule has at least one action that can currently be executed.
 *
 * - send_email:    needs a resolved template
 * - create_alert:  needs a resolved alertPreset
 * - update_field:  self-contained (field allowlist enforced at runtime)
 * - notify_team:   self-contained (team email resolved at runtime)
 * - log_activity:  self-contained (always succeeds)
 * - assign_tag / remove_tag / add_to_group / remove_from_group / webhook: self-contained
 *
 * Exported for use by rule validators and tests.
 */
export function hasResolvableActions(actions: AutomationAction[], resolved: ResolvedActions): boolean {
  for (const a of actions) {
    if (a.type === 'send_email' && resolved.template) return true
    if (a.type === 'create_alert' && resolved.alertPreset) return true
    if (a.type === 'update_field') return true
    if (a.type === 'archive_contact') return true
    if (a.type === 'add_note') return true
    if (a.type === 'notify_team') return true
    if (a.type === 'log_activity') return true
    if (a.type === 'assign_tag') return true
    if (a.type === 'remove_tag') return true
    if (a.type === 'add_to_group') return true
    if (a.type === 'remove_from_group') return true
    if (a.type === 'webhook') return true
    // A PLUGIN ACTION IS RESOLVABLE WHEN ITS PLUGIN IS INSTALLED — and until
    // this arm existed it was resolvable never, which is a second defect the
    // install gate uncovered: a rule whose ONLY action is a plugin action was
    // skipped wholesale, with the misleading "no executable action resources
    // found" error. A WhatsApp-only automation had simply never run.
    //
    // With the plugin removed the rule is now skipped ONCE per run, by this
    // guard, instead of being walked across every contact to dispatch nothing.
    const pluginId = pluginIdOfNamespacedId(a.type as string)
    if (pluginId && resolved.activePlugins.has(pluginId)) return true
  }
  return false
}

/**
 * Executes all resolved actions for a single contact.
 * Returns { executed, failed }.
 */
async function executeActionsForContact(
  contactId: string,
  contact: ContactData,
  actions: AutomationAction[],
  resolved: ResolvedActions,
  teamId: string,
  teamData: Record<string, unknown>,
  ruleId: string,
  payload?: Record<string, unknown>
): Promise<{ executed: number; failed: number }> {
  const now = new Date()
  const teamName = (teamData.name as string) || ''
  let executed = 0
  let failed = 0

  for (const action of actions) {
    try {
      if (action.type === 'send_email' && resolved.template) {
        const subject = substituteVariables(
          resolved.template.subject as string,
          contact,
          teamName,
          now,
          teamData,
          payload
        )
        const rawBody = substituteVariables(
          resolved.template.body as string,
          contact,
          teamName,
          now,
          teamData,
          payload
        )
        const htmlBody = renderBody(resolved.template, rawBody)
        const { html, text } = buildOutreachEmail({
          body: htmlBody,
          teamName,
          language: resolved.language,
          teamData,
        })
        await sendEmail({ to: contact.email!, subject, html, text, teamId })

        await to(
          logActivity(teamId, {
            created_at: FieldValue.serverTimestamp(),
            event: 'outreach_email_sent',
            parameters: {
              description: `Outreach email "${resolved.template.name as string}" sent automatically to ${contact.firstname || ''} ${contact.lastname || ''}.`,
              template_name: resolved.template.name as string,
              template_id: (resolved.template as Record<string, unknown>).id,
              subject,
              automated: true,
              rule_id: ruleId,
            },
            refs: { contact: contactId, user: null },
          })
        )
        executed++
      }

      if (action.type === 'create_alert' && resolved.alertPreset) {
        const alertMessage = substituteVariables(
          resolved.alertPreset.message as string,
          contact,
          teamName,
          now,
          teamData,
          payload
        )
        await createContactAlertDoc(contactId, teamId, contact, {
          schedule: { type: 'datetime', value: Timestamp.now() },
          message: alertMessage,
          alert_type: 'automation',
          show_in_app: (resolved.alertPreset.show_in_app as boolean) || false,
        })
        executed++
      }

      // update_field — write an allowlisted contact field. Built-ins plus the
      // team's custom fields (dotted 'custom_fields.{id}' paths, validated against
      // custom_field_definitions so a rule can never write arbitrary keys).
      if (action.type === 'update_field') {
        const ALLOWED_UPDATE_FIELDS = [
          'acquisition_stage',
          'notes',
          'tags',
          'source',
          'source_detail',
          'lead_acknowledged',
        ] as const
        const field = action.field
        const customFieldId = field.startsWith('custom_fields.')
          ? field.slice('custom_fields.'.length)
          : null
        const customDef = customFieldId
          ? (
              teamData.custom_field_definitions as
                | Array<{ id: string; type?: string }>
                | undefined
            )?.find((d) => d.id === customFieldId)
          : undefined
        // Rank fields ('ranks.{systemId}') — validate the system id against the
        // team's EFFECTIVE ranking systems, never write an arbitrary key.
        //
        // "Effective" means the organisation's when it has any, which is the
        // whole point of the fix: this read used to be `teamData.ranking_systems`
        // alone, and an org-managed tenant keeps its systems on the ORG, so the
        // list was empty and every rank automation was silently dropped below.
        const rankSystemId = field.startsWith('ranks.') ? field.slice('ranks.'.length) : null
        const rankingSystems = rankSystemId != null ? await resolveRankingSystems(teamData) : []
        const isKnownRank =
          rankSystemId != null && isKnownRankingSystem(rankingSystems, rankSystemId)
        const allowed =
          customDef != null ||
          isKnownRank ||
          (ALLOWED_UPDATE_FIELDS as readonly string[]).includes(field)
        if (!allowed) {
          console.log(
            `[automationEngine] update_field: field '${field}' not in allowlist, skipping`
          )
        } else {
          // The builder stores values as strings — coerce per field type
          // (CustomFieldType: text | number | date | select | checkbox).
          let value: string | number | boolean | null = action.value
          if (field === 'lead_acknowledged' || customDef?.type === 'checkbox') {
            value = value === true || value === 'true'
          } else if (isKnownRank) {
            // A rank is written as the LEVEL'S ID. The builder offers ids, so
            // the value normally is one; a rule saved before ids existed holds
            // the old number, which is upgraded here rather than stored — the
            // one place a legacy number is still accepted on the way in. A
            // value naming no level of the ladder is dropped, never written.
            const ladder = rankingSystems.find((r) => r.id === rankSystemId)?.levels ?? []
            const raw = typeof value === 'string' && value !== '' && Number.isFinite(Number(value)) && !findRankLevel(ladder, value)
              ? Number(value)
              : value
            const level = typeof raw === 'string' || typeof raw === 'number' ? findRankLevel(ladder, raw) : undefined
            value = level ? rankLevelKey(level) : null
          } else if (customDef?.type === 'number') {
            const n = Number(value)
            value = Number.isFinite(n) ? n : null
          }
          const update: Record<string, unknown> = { [field]: value }
          // Stage writes behave like a manual promotion: stamp the milestone and,
          // for attended/joined, MATERIALIZE a provisional lead (it now counts
          // toward the contact cap — see Contact.provisional).
          if (field === 'acquisition_stage') {
            update.acquisition_stage_updated_at = FieldValue.serverTimestamp()
            if (value === 'trial_attended') update.trial_attended_at = FieldValue.serverTimestamp()
            if (value === 'joined') update.converted_at = FieldValue.serverTimestamp()
            if (value === 'trial_attended' || value === 'joined') {
              update.provisional = FieldValue.delete()
              update.provisional_expires_at = FieldValue.delete()
            }
          }
          await admin.firestore().collection('contacts').doc(contactId).update(update)
          await to(
            logActivity(teamId, {
              date: FieldValue.serverTimestamp(),
              event: 'automation_update_field',
              parameters: {
                description:
                  `Automation set '${field}' to '${String(value)}' for ${contact.firstname || ''} ${contact.lastname || ''}.`.trim(),
                field,
                value,
                rule_id: ruleId,
                automated: true,
              },
              refs: { contact: contactId, user: null },
            })
          )
          executed++
        }
      }

      // archive_contact — archive (never delete) the contact; the daily scan skips
      // archived contacts, so re-runs are naturally idempotent.
      if (action.type === 'archive_contact') {
        await admin.firestore().collection('contacts').doc(contactId).update({
          archived_at: FieldValue.serverTimestamp(),
          archived_reason: 'automation',
        })
        await to(
          logActivity(teamId, {
            date: FieldValue.serverTimestamp(),
            event: 'automation_archive_contact',
            parameters: {
              description:
                `Automation archived ${contact.firstname || ''} ${contact.lastname || ''}.`.trim(),
              rule_id: ruleId,
              automated: true,
            },
            refs: { contact: contactId, user: null },
          })
        )
        executed++
      }

      // add_note — append a timestamped note to the contact (contact_notes
      // subcollection), same shape the contact-detail Notes tab reads/writes.
      if (action.type === 'add_note') {
        // SANITIZE: `{{firstname}}` (and other contact fields) are substituted RAW,
        // and contact.firstname is anonymous-controllable (a public form submission
        // creates a contact with an attacker-supplied name). The note is later
        // rendered via dangerouslySetInnerHTML on the staff contact page, so an
        // unsanitized `<img onerror=…>`/`<script>` in a name would execute as stored
        // XSS in the authenticated admin session. sanitizeRichHtml strips scripts/
        // event handlers while keeping the note's legitimate formatting.
        const content = sanitizeRichHtml(
          substituteVariables(action.note, contact, teamName, now, teamData, payload)
        ).trim()
        if (content) {
          await admin
            .firestore()
            .collection('contacts')
            .doc(contactId)
            .collection('contact_notes')
            .add({
              content,
              source: 'automation',
              rule_id: ruleId,
              created_at: FieldValue.serverTimestamp(),
              updated_at: FieldValue.serverTimestamp(),
            })
          await to(
            logActivity(teamId, {
              date: FieldValue.serverTimestamp(),
              event: 'automation_add_note',
              parameters: {
                description: `Automation added a note to ${contact.firstname || ''} ${contact.lastname || ''}.`.trim(),
                rule_id: ruleId,
                automated: true,
              },
              refs: { contact: contactId, user: null },
            })
          )
          executed++
        }
      }

      // notify_team — send an internal email to the team's notification address
      if (action.type === 'notify_team') {
        const settings = (teamData.settings as Record<string, unknown>) || {}
        const toEmail = (settings.teamEmail as string) || (teamData.email as string) || ''
        if (!toEmail) {
          console.log(
            `[automationEngine] notify_team: no team email configured for team ${teamId}, skipping`
          )
        } else {
          const subject = substituteVariables(
            action.subject,
            contact,
            teamName,
            now,
            teamData,
            payload
          )
          const rawBody = substituteVariables(
            action.body,
            contact,
            teamName,
            now,
            teamData,
            payload
          )
          const htmlBody = renderBody({ body_mode: 'markdown' }, rawBody)
          const { html, text } = buildOutreachEmail({ body: htmlBody, teamName, teamData })
          await sendEmail({ to: toEmail, subject, html, text, teamId })
          executed++
        }
      }

      // log_activity — append a note to the team activity log
      if (action.type === 'log_activity') {
        const message = substituteVariables(
          action.message,
          contact,
          teamName,
          now,
          teamData,
          payload
        )
        await logActivity(teamId, {
          date: FieldValue.serverTimestamp(),
          event: 'automation_action',
          parameters: {
            description: message,
            rule_id: ruleId,
            automated: true,
          },
          refs: { contact: contactId, user: null },
        })
        executed++
      }

      // assign_tag — add a tag to the contact's tags array
      if (action.type === 'assign_tag') {
        await admin
          .firestore()
          .collection('contacts')
          .doc(contactId)
          .update({
            tags: FieldValue.arrayUnion(action.tag),
          })
        await to(
          logActivity(teamId, {
            date: FieldValue.serverTimestamp(),
            event: 'automation_assign_tag',
            parameters: {
              description:
                `Automation added tag '${action.tag}' to ${contact.firstname || ''} ${contact.lastname || ''}.`.trim(),
              tag: action.tag,
              rule_id: ruleId,
              automated: true,
            },
            refs: { contact: contactId, user: null },
          })
        )
        executed++
      }

      // remove_tag — remove a tag from the contact's tags array
      if (action.type === 'remove_tag') {
        await admin
          .firestore()
          .collection('contacts')
          .doc(contactId)
          .update({
            tags: FieldValue.arrayRemove(action.tag),
          })
        await to(
          logActivity(teamId, {
            date: FieldValue.serverTimestamp(),
            event: 'automation_remove_tag',
            parameters: {
              description:
                `Automation removed tag '${action.tag}' from ${contact.firstname || ''} ${contact.lastname || ''}.`.trim(),
              tag: action.tag,
              rule_id: ruleId,
              automated: true,
            },
            refs: { contact: contactId, user: null },
          })
        )
        executed++
      }

      // add_to_group — add the contact to a Contact Group (group_ids arrayUnion)
      if (action.type === 'add_to_group') {
        const payload = groupActionUpdate(action)
        if (!payload) {
          console.log(
            `[automationEngine] add_to_group: missing group_id for rule ${ruleId}, skipping`
          )
        } else {
          await admin.firestore().collection('contacts').doc(contactId).update(payload)
          await to(
            logActivity(teamId, {
              date: FieldValue.serverTimestamp(),
              event: 'automation_add_to_group',
              parameters: {
                description:
                  `Automation added ${contact.firstname || ''} ${contact.lastname || ''} to group '${action.group_id}'.`.trim(),
                group_id: action.group_id,
                rule_id: ruleId,
                automated: true,
              },
              refs: { contact: contactId, user: null },
            })
          )
          executed++
        }
      }

      // remove_from_group — remove the contact from a Contact Group (group_ids arrayRemove)
      if (action.type === 'remove_from_group') {
        const payload = groupActionUpdate(action)
        if (!payload) {
          console.log(
            `[automationEngine] remove_from_group: missing group_id for rule ${ruleId}, skipping`
          )
        } else {
          await admin.firestore().collection('contacts').doc(contactId).update(payload)
          await to(
            logActivity(teamId, {
              date: FieldValue.serverTimestamp(),
              event: 'automation_remove_from_group',
              parameters: {
                description:
                  `Automation removed ${contact.firstname || ''} ${contact.lastname || ''} from group '${action.group_id}'.`.trim(),
                group_id: action.group_id,
                rule_id: ruleId,
                automated: true,
              },
              refs: { contact: contactId, user: null },
            })
          )
          executed++
        }
      }

      // set_affiliation_status — update the status (and active flag) of the
      // contact's first affiliation matching the given type_key (or any affiliation
      // if no type_key is specified). Best-effort: silently skips when no match.
      if (action.type === 'set_affiliation_status') {
        const { CONTACT_AFFILIATIONS_SUBCOLLECTION, DEFAULT_ORG_AFFILIATION_STATUSES } =
          await import('@linyup/shared')
        const affiliationsSnap = await admin
          .firestore()
          .collection('contacts')
          .doc(contactId)
          .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
          .get()

        const target = affiliationsSnap.docs.find((d) => {
          if (!action.affiliation_type_key) return true // first any
          return d.data().type_key === action.affiliation_type_key
        })

        if (target) {
          const affData = target.data() as { issuer?: string; org_id?: string }
          // Resolve active flag from status defs (org or default)
          let statusDefs = DEFAULT_ORG_AFFILIATION_STATUSES
          if (affData.issuer === 'org' && affData.org_id) {
            try {
              const orgStatusSnap = await admin
                .firestore()
                .collection('organizations')
                .doc(affData.org_id as string)
                .collection('affiliation_statuses')
                .get()
              if (!orgStatusSnap.empty) {
                statusDefs = orgStatusSnap.docs.map(
                  (d) => d.data() as (typeof DEFAULT_ORG_AFFILIATION_STATUSES)[number]
                )
              }
            } catch {
              // best-effort
            }
          }
          const statusDef = statusDefs.find((s) => s.id === action.status_id)
          const active = statusDef?.countsAsActive ?? false

          await target.ref.update({
            status_id: action.status_id,
            active,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          })
          executed++
          console.log(
            `[automationEngine] set_affiliation_status: contact=${contactId} affiliation=${target.id} status=${action.status_id}`
          )
        } else {
          console.log(
            `[automationEngine] set_affiliation_status: no matching affiliation for contact=${contactId} type_key=${action.affiliation_type_key ?? '(any)'}, skipping`
          )
        }
      }

      // plugin action — dispatch to the plugin's registered handler, IF the
      // studio still has the plugin. The install was resolved once for the whole
      // rule (see `ResolvedActions.activePlugins`); this is a set lookup, not a
      // read, so it costs nothing per contact.
      if ((action.type as string).startsWith('plugin:')) {
        const pluginId = pluginIdOfNamespacedId(action.type as string)
        const handler = pluginId && resolved.activePlugins.has(pluginId)
          ? pluginActionHandlers[action.type as PluginActionId]
          : undefined
        if (handler) {
          await handler({
            action: action as { type: PluginActionId; config?: Record<string, unknown> },
            contact,
            contactId,
            teamId,
            teamData,
            ruleId,
          })
          executed++
        } else {
          // Two ways to land here and they are worth telling apart: the plugin
          // is gone (ordinary, already logged once per rule) or the id names a
          // handler that was never registered (a bug, or a rule written against
          // a build that no longer exists).
          console.log(
            pluginId && !resolved.activePlugins.has(pluginId)
              ? `[automationEngine] plugin '${pluginId}' not installed — skipping action '${action.type}'`
              : `[automationEngine] No handler registered for plugin action '${action.type}', skipping`
          )
        }
      }

      // webhook — POST a JSON payload to an external HTTPS endpoint
      if (action.type === 'webhook') {
        const url = action.url
        if (!url?.startsWith('https://')) {
          console.log(
            `[automationEngine] webhook: skipping non-HTTPS or empty URL for rule ${ruleId}`
          )
        } else {
          const payload = {
            event: 'automation_rule_fired',
            rule_id: ruleId,
            team_id: teamId,
            triggered_at: now.toISOString(),
            contact: {
              id: contactId,
              firstname: contact.firstname,
              lastname: contact.lastname,
              email: contact.email,
              acquisition_stage: contact.acquisition_stage,
              affiliation_summary: contact.affiliation_summary ?? null,
              total_sessions: contact.total_sessions,
              tags: contact.tags ?? [],
            },
          }
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 10000)
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Linyup-Automation/1.0',
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
            })
            clearTimeout(timeoutId)
            if (!response.ok) {
              throw new Error(`Webhook returned HTTP ${response.status}`)
            }
            executed++
          } finally {
            clearTimeout(timeoutId)
          }
        }
      }
    } catch (err) {
      console.error(
        `[automationEngine] Action '${action.type}' failed for contact ${contactId}:`,
        (err as Error).message
      )
      failed++
    }
  }

  return { executed, failed }
}

// ---------------------------------------------------------------------------
// Booking-based rule path (bio_link_booking_no_show)
// ---------------------------------------------------------------------------

async function runBookingRule(
  rule: AutomationRule,
  teamId: string,
  teamData: Record<string, unknown>,
  now: Date,
  stats: RuleStats,
  options: RunRuleOptions
): Promise<void> {
  const db = admin.firestore()

  const bookingCond = rule.conditions.find((c) => c.type === 'bio_link_booking_no_show') as
    | { type: 'bio_link_booking_no_show'; delay_days?: number; delay_hours?: number }
    | undefined

  const conditionCtx = await loadConditionContext(rule, teamId, teamData)

  const delayDays =
    bookingCond?.delay_days || Math.round((bookingCond?.delay_hours || 24) / 24) || 1
  const delayHours = delayDays * 24
  const windowEnd = new Date(now.getTime() - (delayHours - 12) * 3600000)
  const windowStart = new Date(now.getTime() - (delayHours + 36) * 3600000)

  const [sessErr, sessSnap] = await to(
    db
      .collection('sessions')
      .where('teamId', '==', teamId)
      .where('end', '>=', admin.firestore.Timestamp.fromDate(windowStart))
      .where('end', '<', admin.firestore.Timestamp.fromDate(windowEnd))
      .get()
  )
  if (sessErr) {
    console.error(`[automationEngine] Error fetching sessions for team ${teamId}:`, sessErr)
    stats.errors++
    return
  }

  // Legacy sessions with teacher field instead of teamId
  const [legacySessErr, legacySessSnap] = await to(
    db
      .collection('sessions')
      .where('teacher', '==', teamId)
      .where('end', '>=', admin.firestore.Timestamp.fromDate(windowStart))
      .where('end', '<', admin.firestore.Timestamp.fromDate(windowEnd))
      .get()
  )
  const seenSessionIds = new Set(sessSnap!.docs.map((d) => d.id))
  const allSessionDocs = [...sessSnap!.docs]
  if (!legacySessErr && legacySessSnap) {
    for (const doc of legacySessSnap.docs) {
      if (!seenSessionIds.has(doc.id)) allSessionDocs.push(doc)
    }
  }

  if (allSessionDocs.length === 0) return

  const resolved = await resolveActionResources(rule.actions, teamId, teamData)
  if (!hasResolvableActions(rule.actions, resolved)) {
    console.error(
      `[automationEngine] Rule ${rule.id}: no executable action resources found, skipping`
    )
    stats.errors++
    return
  }

  for (const sessionDoc of allSessionDocs) {
    const [bookingsErr, bookingsSnap] = await to(
      sessionDoc.ref
        .collection('bookings')
        .where('fromBioLink', '==', true)
        .where('status', '==', 'no_show')
        .get()
    )
    if (bookingsErr) {
      console.error(
        `[automationEngine] Error fetching bookings for session ${sessionDoc.id}:`,
        bookingsErr
      )
      stats.errors++
      continue
    }

    const eligible = bookingsSnap!.docs.filter(
      (d) => options.force || !d.data().noShowOutreachSentAt
    )

    for (const bookingDoc of eligible) {
      stats.processed++
      const booking = bookingDoc.data()

      let contact: ContactData = {
        id: '',
        firstname: booking.firstname || '',
        lastname: booking.lastname || '',
        email: booking.email || '',
        total_sessions: 0,
      }
      const contactId: string = booking.contactId || booking.contact || ''
      if (contactId) {
        const [cErr, cDoc] = await to(db.collection('contacts').doc(contactId).get())
        if (!cErr && cDoc && cDoc.exists) {
          contact = { id: contactId, ...(cDoc.data() as Omit<ContactData, 'id'>) }
        }
      }

      if (!contact.email) {
        stats.skipped++
        continue
      }
      if (contact.email_unsubscribed) {
        stats.skipped++
        continue
      }
      if (!evaluateContactConditions(rule.conditions, contact, now, conditionCtx)) {
        stats.skipped++
        continue
      }

      if (options.dryRun) {
        stats.sent++
        continue
      }

      const { executed, failed } = await executeActionsForContact(
        contactId || bookingDoc.id,
        contact,
        rule.actions,
        resolved,
        teamId,
        teamData,
        rule.id
      )
      stats.sent += executed
      stats.errors += failed
      if (executed > 0) recordRecipient(stats, contactId)

      // Mark booking as processed
      await to(bookingDoc.ref.update({ noShowOutreachSentAt: FieldValue.serverTimestamp() }))
    }
  }
}

// ---------------------------------------------------------------------------
// Contact-based rule path
// ---------------------------------------------------------------------------

/**
 * Load the group context for a rule — but only when a condition actually asks
 * for it. A rule with no in_group condition costs zero extra reads.
 */
export async function loadConditionContext(
  rule: AutomationRule,
  teamId: string,
  teamData: Record<string, unknown>
): Promise<ConditionContext> {
  if (!rule.conditions.some((c) => c.type === 'in_group')) return {}
  const [err, snap] = await to(
    admin.firestore().collection(TEAMS_COLLECTION).doc(teamId)
      .collection(CONTACT_GROUPS_SUBCOLLECTION).get()
  )
  if (err || !snap) {
    console.error(`[automationEngine] rule=${rule.id}: failed to load contact groups`, err)
    return {}
  }
  const groups = snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ContactGroup)
  // A group whose rule asks about consent needs that document's ledger, or the
  // dimension fails closed and the rule silently matches nobody. One query per
  // referenced document, once per run — the same "loaded once per team per run"
  // shape as the groups above, and zero reads for the ordinary rule that names
  // no document.
  const documentIds = consentDocumentIds(groups.map((g) => g.rule))
  const consent = documentIds.length ? await loadConsentLedgers(teamId, documentIds) : undefined
  return {
    groups,
    engagementThresholds: teamData.engagement_thresholds as EngagementThresholds | undefined,
    consent,
  }
}

async function runContactRule(
  rule: AutomationRule,
  contacts: ContactData[],
  teamId: string,
  teamData: Record<string, unknown>,
  now: Date,
  stats: RuleStats,
  options: RunRuleOptions,
  payload?: Record<string, unknown>
): Promise<void> {
  const db = admin.firestore()
  const conditionCtx = await loadConditionContext(rule, teamId, teamData)

  console.log(
    `[automationEngine] rule=${rule.id} team=${teamId}: evaluating ${contacts.length} contacts`
  )

  const resolved = await resolveActionResources(rule.actions, teamId, teamData)
  if (!hasResolvableActions(rule.actions, resolved)) {
    console.error(
      `[automationEngine] Rule ${rule.id}: no executable action resources found, skipping`
    )
    stats.errors++
    return
  }

  for (const contact of contacts) {
    if (contact.deleted_at || contact.archived_at || contact.external) continue
    if (!contact.email) {
      stats.skipped++
      continue
    }
    if (contact.email_unsubscribed) {
      stats.skipped++
      continue
    }

    // Dedup — skip if rule already fired for this contact recently (unless force=true)
    if (!options.force) {
      const lastSent = contact.outreach_rules_sent?.[rule.id]
      if (lastSent) {
        const lastMs = resolveTimestampMs(lastSent)
        if (lastMs !== null) {
          const windowMs =
            options.triggerTier === 'scheduled'
              ? 30 * 86400000 // 30-day window: lets re-engagement rules re-fire (e.g. inactivity)
              : 7 * 86400000 // 7-day window for event-triggered rules
          if (now.getTime() - lastMs < windowMs) {
            stats.skipped++
            continue
          }
        }
      }
    }

    if (!evaluateContactConditions(rule.conditions, contact, now, conditionCtx)) {
      stats.skipped++
      continue
    }

    stats.processed++

    if (options.dryRun) {
      stats.sent++
      continue
    }

    const { executed, failed } = await executeActionsForContact(
      contact.id,
      contact,
      rule.actions,
      resolved,
      teamId,
      teamData,
      rule.id,
      payload
    )
    stats.sent += executed
    stats.errors += failed

    // Mark rule as sent for this contact — and record them as a recipient. The
    // two share one condition on purpose: "reached" in the log means exactly
    // what the dedup window already means by it.
    if (executed > 0) {
      recordRecipient(stats, contact.id)
      await to(
        db
          .collection('contacts')
          .doc(contact.id)
          .update({
            [`outreach_rules_sent.${rule.id}`]: FieldValue.serverTimestamp(),
          })
      )
    }

    console.log(`[automationEngine] rule=${rule.id} actions executed for contact=${contact.id}`)
  }
}

// ---------------------------------------------------------------------------
// runRule — main entry point
// ---------------------------------------------------------------------------

/**
 * Runs an automation rule against the supplied contacts.
 * For bio_link_booking_no_show rules, `contacts` is ignored — bookings are
 * queried internally based on the condition's delay window.
 *
 * @param rule      Normalised AutomationRule
 * @param contacts  Contacts to evaluate (used for contact-based rules)
 * @param teamId    Team owning the rule
 * @param teamData  Team document data (for variable substitution, language)
 * @param options   dryRun, triggerTier, force
 * @returns         AutomationLogData to write to automation_logs
 */
export async function runRule(
  rule: AutomationRule,
  contacts: ContactData[],
  teamId: string,
  teamData: Record<string, unknown>,
  options: RunRuleOptions = {}
): Promise<AutomationLogData> {
  const now = new Date()
  const stats: RuleStats = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    recipients: new Set<string>(),
  }
  const triggerTier = options.triggerTier || 'scheduled'

  if (!rule.actions.length && !rule.template_id && !rule.alert_preset_id) {
    console.log(`[automationEngine] Rule ${rule.id} has no actions, skipping`)
    stats.skipped++
  } else if (!rule.conditions.length && rule.trigger.type === 'schedule_daily') {
    // Conditions are an AND-filter, so "no conditions" means "match everything" —
    // which is the natural intent for an event trigger (the event already scopes
    // the run to one contact), but a footgun for schedule_daily, whose contact set
    // is the ENTIRE team. An unconditioned daily rule would re-sweep every contact
    // every day, so it stays inert. The builder blocks saving one; this is the
    // backstop for rules that predate that check.
    console.log(`[automationEngine] Rule ${rule.id} is schedule_daily with no conditions, skipping`)
    stats.skipped++
  } else {
    const hasBookingCondition = rule.conditions.some((c) => c.type === 'bio_link_booking_no_show')

    if (hasBookingCondition) {
      // Booking rules are driven by the daily scan, which has no trigger payload.
      await runBookingRule(rule, teamId, teamData, now, stats, options)
    } else {
      await runContactRule(
        rule,
        contacts,
        teamId,
        teamData,
        now,
        stats,
        options,
        options.context?.payload
      )
    }
  }

  const log: AutomationLogData = {
    rule_id: rule.id,
    rule_name: rule.name,
    triggered_at: FieldValue.serverTimestamp(),
    trigger_type: rule.trigger.type,
    trigger_tier: triggerTier,
    contacts_matched: stats.processed,
    actions_executed: stats.sent,
    actions_failed: stats.errors,
    // Written HERE, on the same row as the counts, by the one function every
    // trigger tier goes through — the event tier, runScheduledRules,
    // triggerAutomationRule and executeDelayedRule all persist this object
    // verbatim, so there is no second write to keep in step.
    recipient_ids: Array.from(stats.recipients).slice(0, RECIPIENT_ID_CAP),
    recipients_total: stats.recipients.size,
  }

  console.log(`[automationEngine] runRule complete rule=${rule.id} team=${teamId}`, {
    ...stats,
    recipients: stats.recipients.size,
  })
  return log
}

// ---------------------------------------------------------------------------
// Tier 2 — delayed execution via Cloud Tasks
// ---------------------------------------------------------------------------

/**
 * Cloud Tasks refuses a scheduleTime more than 30 days out, and the delay field
 * in the rule builder is a free-text number of minutes. A delay beyond the
 * ceiling is CLAMPED (never dropped, never silently run inline) and logged —
 * a rule that says "90 days later" fires at 30, which is visible in the log,
 * rather than throwing at enqueue time and losing the run entirely.
 */
export const MAX_DELAY_MINUTES = 30 * 24 * 60

/**
 * The task-queue handler is deployed in the region set by setGlobalOptions in
 * src/index.ts, and Firebase creates the Cloud Tasks queue in that SAME region.
 * firebase-admin's `taskQueue('name')` defaults to **us-central1** when the name
 * carries no location (see functions-api-client-internal.js DEFAULT_LOCATION),
 * so a bare name enqueues into a queue that does not exist. Always address the
 * queue by its fully-qualified partial resource name.
 */
const DELAYED_RULE_FUNCTION = 'locations/europe-west6/functions/executeDelayedRule'

export interface DelayedRulePayload {
  ruleId: string
  teamId: string
  /**
   * Session-kind tasks only — the participants are re-read from this session at
   * fire time. Absent/empty for event-kind tasks.
   */
  sessionId?: string
  contactIds: string[]
  idempotencyKey: string
  /**
   * Which shape of delayed run this is. ABSENT means 'session': tasks enqueued
   * before event delays existed carry no kind, and must keep the session
   * behaviour they were enqueued with.
   */
  kind?: 'session' | 'event'
  /**
   * Event-kind only — the trigger type the rule carried at enqueue time. If the
   * studio re-points the rule at a different trigger while the task is in
   * flight, the task is dropped rather than run with the new rule's actions.
   */
  triggerType?: AutomationTriggerType
}

async function delayedRuleQueue() {
  const { getFunctions } = await import('firebase-admin/functions')
  return getFunctions().taskQueue(DELAYED_RULE_FUNCTION)
}

/**
 * Enqueues a Cloud Task to execute an automation rule after a delay.
 * scheduleTime = sessionEndTime + rule.trigger.delayMinutes
 * idempotencyKey = "{ruleId}:{sessionId}" — first execution wins; duplicates are no-ops.
 *
 * Uses firebase-admin/functions (getFunctions().taskQueue) which requires the
 * executeDelayedRule function to be deployed and registered as a task queue handler.
 * For local emulator dev, set CLOUD_TASKS_EMULATOR_HOST=localhost:9499.
 */
export async function enqueueDelayedRule(
  rule: AutomationRule,
  teamId: string,
  sessionId: string,
  sessionEndTime: Date,
  contactIds: string[]
): Promise<void> {
  const delayMs = clampDelayMinutes(rule.trigger.delayMinutes || 0, rule.id) * 60 * 1000
  const scheduleTime = new Date(sessionEndTime.getTime() + delayMs)
  const idempotencyKey = `${rule.id}:${sessionId}`

  const queue = await delayedRuleQueue()
  await queue.enqueue(
    {
      ruleId: rule.id,
      teamId,
      sessionId,
      contactIds,
      idempotencyKey,
      kind: 'session',
    } satisfies DelayedRulePayload,
    { scheduleTime }
  )

  console.log(
    `[automationEngine] enqueued delayed rule=${rule.id} session=${sessionId} at=${scheduleTime.toISOString()}`
  ) // eslint-disable-line no-console
}

/** Clamps a configured delay to what Cloud Tasks will accept. Pure. */
export function clampDelayMinutes(delayMinutes: number, ruleId?: string): number {
  if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) return 0
  const floored = Math.floor(delayMinutes)
  if (floored <= MAX_DELAY_MINUTES) return floored
  console.log(
    `[automationEngine] rule=${ruleId ?? '?'}: delay ${floored}min exceeds the Cloud Tasks ceiling, clamped to ${MAX_DELAY_MINUTES}min`
  ) // eslint-disable-line no-console
  return MAX_DELAY_MINUTES
}

/**
 * How long an EVENT rule should be deferred, in minutes. 0 means "run inline,
 * exactly as before" — which is the answer for every rule that stores no delay,
 * and the reason a rule that works today cannot regress.
 *
 * Refused a delay on purpose, each for its own reason:
 *
 * - `session_ended` owns its own Tier 2 path (onSessionWrite enqueues against
 *   the session's END time, not against now). fireEventRules only ever sees it
 *   on the already-ended backfill path, where a delay is meaningless — the
 *   session is in the past. Delaying here would change the reference path.
 * - `schedule_daily` / `manual` are not event triggers at all; reaching this
 *   function with one is a caller bug, and inline is the safe answer.
 * - `inbound_webhook` is payload-bearing BY DEFINITION: a delayed run persists
 *   its body in the Cloud Tasks queue, and that body is the caller's raw POST
 *   (routinely carrying their secrets — see inboundWebhook.ts). Refused by name
 *   so an empty POST body cannot slip past the payload check below.
 *
 * And ANY trigger is refused a delay while it actually carries a `payload`, for
 * the same reason — one rule covering every future payload-bearing trigger
 * rather than a list that goes stale.
 *
 * The web builder's TRIGGER_OPTIONS.supportsDelay must agree with this function
 * exactly; automation/delayedRules.test.ts reads both sources and pins it, so a
 * trigger offered a delay it will never get fails the build rather than the
 * studio.
 */
export function resolveEventDelayMinutes(
  rule: AutomationRule,
  context?: AutomationContext
): number {
  const type = rule.trigger.type
  if (
    type === 'session_ended' ||
    type === 'schedule_daily' ||
    type === 'manual' ||
    type === 'inbound_webhook'
  )
    return 0
  if (context?.payload && Object.keys(context.payload).length > 0) return 0
  return clampDelayMinutes(rule.trigger.delayMinutes ?? 0, rule.id)
}

/**
 * The dedup key for a delayed EVENT run.
 *
 * The session key is `{ruleId}:{sessionId}` because the session IS the
 * occurrence — re-enqueueing after an end-time edit must collapse onto the same
 * key. An event has no such document, so the occurrence is the EVENT: the
 * CloudEvent id of the Firestore write that fired it, which is stable across a
 * duplicate delivery of that same write. The delta is folded in because one
 * write can emit several events (two subscriptions added at once), and those
 * are genuinely different occurrences. A money event contributes its
 * paymentIntentId for the same reason — one payment write emits at most one of
 * them today, but the key should say WHICH payment rather than rely on that.
 *
 * The key is deliberately NOT `{ruleId}:{contactId}`: that would make a
 * legitimate second booking, months later, a permanent no-op. Repeat firings
 * inside the window are the job of the per-rule/per-contact dedup in
 * runContactRule, which the delayed run goes through like every other tier.
 */
export function buildEventIdempotencyKey(input: {
  ruleId: string
  occurrenceId: string
  delta?: EventDelta
}): string {
  const deltaKey =
    input.delta?.subscriptionTypeId ||
    input.delta?.affiliationTypeKey ||
    input.delta?.payment?.paymentIntentId
  return ['evt', input.ruleId, input.occurrenceId, deltaKey].filter(Boolean).join(':')
}

/**
 * Enqueues a Cloud Task to run an event rule against the given contacts after
 * the rule's delay. Contact ids are snapshotted here; the contact DOCUMENTS are
 * re-read at fire time (see executeDelayedRule) — see the evaluation-timing
 * note on fireEventRules.
 */
export async function enqueueDelayedEventRule(params: {
  rule: AutomationRule
  teamId: string
  contactIds: string[]
  delayMinutes: number
  idempotencyKey: string
  now?: Date
}): Promise<void> {
  const { rule, teamId, contactIds, delayMinutes, idempotencyKey } = params
  const scheduleTime = new Date((params.now ?? new Date()).getTime() + delayMinutes * 60 * 1000)

  const queue = await delayedRuleQueue()
  await queue.enqueue(
    {
      ruleId: rule.id,
      teamId,
      contactIds,
      idempotencyKey,
      kind: 'event',
      triggerType: rule.trigger.type,
    } satisfies DelayedRulePayload,
    { scheduleTime }
  )

  console.log(
    `[automationEngine] enqueued delayed event rule=${rule.id} trigger=${rule.trigger.type} contacts=${contactIds.length} at=${scheduleTime.toISOString()} key=${idempotencyKey}`
  ) // eslint-disable-line no-console
}

// ---------------------------------------------------------------------------
// fireEventRules — used by Tier 1 event triggers (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Finds all active automation rules for the given team and triggerType,
 * then runs each against the supplied subjects.
 * Called by onContactWrite, onBookingWrite, onSessionWrite, onAffiliationWrite triggers.
 *
 * @param context  Trigger-supplied data. Scopes inbound_webhook rules by endpoint,
 *                 and its `payload` is exposed to action templates as {{payload.*}}.
 * @param delta  For subscription_added/removed and affiliation_added/removed: the specific
 *               type that changed. Rules with a matching trigger.subscriptionTypeId or
 *               trigger.affiliationTypeKey are scoped to this delta; absent/empty = match any.
 *               Unused for all other trigger types — pass undefined or omit.
 *
 * WHEN THINGS ARE DECIDED, and why the line falls where it does:
 *
 *   EVENT-SHAPED facts are decided HERE, at enqueue time, because they are only
 *   knowable here — which trigger fired, which subscription type was added,
 *   which webhook endpoint was hit. None of that is re-derivable three days
 *   later.
 *
 *   CONTACT-SHAPED facts are decided at FIRE time, by re-reading the contact
 *   documents and running the same runRule() every other tier runs. That is
 *   what stops a "welcome" mail reaching someone who was archived, deleted,
 *   unsubscribed or no longer matches the rule's conditions in the meantime.
 *   The contact ids are snapshotted; the contact STATE never is.
 *
 * Only `rule.active` is checked twice — once here to avoid queueing dead work,
 * once at fire time because it is the studio's off switch.
 */
export async function fireEventRules(
  teamId: string,
  triggerType: AutomationTriggerType,
  subjects: ContactData[],
  context?: AutomationContext,
  delta?: EventDelta
): Promise<void> {
  const db = admin.firestore()

  const [rulesErr, rulesSnap] = await to(
    db
      .collection('teams')
      .doc(teamId)
      .collection('automation_rules')
      .where('active', '==', true)
      .get()
  )
  if (rulesErr || !rulesSnap) {
    console.error(
      `[automationEngine] fireEventRules: error loading rules for team ${teamId}:`,
      rulesErr
    )
    return
  }

  const [teamErr, teamDoc] = await to(db.collection('teams').doc(teamId).get())
  const teamData =
    !teamErr && teamDoc && teamDoc.exists ? (teamDoc.data() as Record<string, unknown>) : {}

  // Automations are available on every paid tier (2026-06 overhaul): Studio/Org
  // get the full suite, while Free/Coach are "half active" — limited to the
  // triggers and actions of their ACTIVE modules and installed add-ons. That
  // limit is enforced at rule-creation time (the builder only offers core
  // actions plus the team's installed-plugin actions), so the engine simply
  // runs whatever rules the team was allowed to create. No tier is skipped here.

  // One occurrence per fireEventRules call — every rule that matches this event
  // shares it, and the ruleId in the key keeps them apart. The random fallback
  // is honest about what it buys: it still collapses a Cloud Tasks REDELIVERY
  // of the same task (the payload, and so the key, is identical), but it cannot
  // collapse a duplicate delivery of the same Firestore write. Callers that can
  // supply event.id (onContactWrite, onBookingWrite) do; the rest lean on the
  // per-rule/per-contact dedup window in runContactRule, exactly as the inline
  // path already does.
  const occurrenceId =
    typeof context?.eventId === 'string' && context.eventId ? context.eventId : randomUUID()

  for (const ruleDoc of rulesSnap.docs) {
    const rule = normalizeRule(ruleDoc.id, ruleDoc.data() as Record<string, unknown>)
    if (rule.trigger.type !== triggerType) continue

    // inbound_webhook rules are scoped to a specific endpoint
    if (
      triggerType === 'inbound_webhook' &&
      rule.trigger.webhook_endpoint_id &&
      rule.trigger.webhook_endpoint_id !== context?.webhook_endpoint_id
    )
      continue

    // Delta scoping for the subscription-type family: if the rule specifies a
    // subscriptionTypeId, only fire when the delta matches.
    //
    // `subscription_cancel_requested` belongs here because it CARRIES that delta.
    // It was emitting one nothing matched on, so a rule narrowed to one plan fired
    // when any plan was cancelled — a control that silently does nothing, which is
    // found by a studio rather than by a test. The builder's select must agree;
    // automation/subscriptionScope.test.ts reads both files and pins it.
    if (
      (triggerType === 'subscription_added' ||
        triggerType === 'subscription_removed' ||
        triggerType === 'subscription_cancel_requested') &&
      rule.trigger.subscriptionTypeId &&
      rule.trigger.subscriptionTypeId !== delta?.subscriptionTypeId
    )
      continue

    // Delta scoping for affiliation_added / affiliation_removed:
    // if the rule specifies an affiliationTypeKey, only fire when the delta matches.
    if (
      (triggerType === 'affiliation_added' || triggerType === 'affiliation_removed') &&
      rule.trigger.affiliationTypeKey &&
      rule.trigger.affiliationTypeKey !== delta?.affiliationTypeKey
    )
      continue

    // Delta scoping for the payment_* family: if the rule names a paymentKind, only
    // fire for payments of that kind — "when someone buys a COURSE" as one rule,
    // rather than one rule that fires on every sale and a condition that cannot see
    // the delta. A row whose kind was never stamped (kind: null) matches nothing but
    // the unscoped rule, which is the honest answer: it is not known to be a course.
    if (
      (triggerType === 'payment_received' ||
        triggerType === 'payment_refunded' ||
        triggerType === 'payment_disputed') &&
      rule.trigger.paymentKind &&
      rule.trigger.paymentKind !== delta?.payment?.kind
    )
      continue

    // Tier 2 — a rule carrying a delay is deferred to Cloud Tasks instead of
    // running now. 0 (the overwhelmingly common case) falls straight through to
    // the inline path below, byte-for-byte the behaviour it has always had.
    const delayMinutes = resolveEventDelayMinutes(rule, context)
    if (delayMinutes > 0) {
      const [enqueueErr] = await to(
        enqueueDelayedEventRule({
          rule,
          teamId,
          contactIds: subjects.map((s) => s.id),
          delayMinutes,
          idempotencyKey: buildEventIdempotencyKey({
            ruleId: rule.id,
            occurrenceId,
            delta,
          }),
        })
      )
      if (enqueueErr) {
        console.error(
          `[automationEngine] fireEventRules: failed to enqueue delayed rule=${rule.id} trigger=${triggerType}:`,
          (enqueueErr as Error).message
        )
      }
      continue
    }

    const log = await runRule(rule, subjects, teamId, teamData, {
      triggerTier: 'event',
      context,
    })

    // Write log and update rule metadata
    await to(db.collection('teams').doc(teamId).collection('automation_logs').add(log))
    await to(
      db.collection('teams').doc(teamId).collection('automation_rules').doc(rule.id).update({
        last_run_at: FieldValue.serverTimestamp(),
        last_run_sent: log.actions_executed,
      })
    )
  }
}
