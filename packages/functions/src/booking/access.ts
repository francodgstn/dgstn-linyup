// The paid-access gate shared by bookSession (group classes) and bookAppointment
// (1:1 appointments). An activity's accessRule ('open' | 'members' | 'subscription')
// is enforced here against an already-resolved authenticated contact (or null for
// a guest) — the single source of truth so both booking flows agree.
// CLASS-ONLY as of 2026-07 — appointments dropped the access gate entirely (money
// is the only gate there; see `ActivityMemberBenefit` in @linyup/shared). The
// appointment paths share this file's snapshot loader (loadContactPaymentContext)
// and resolve through the same shared resolver.
import * as admin from 'firebase-admin'
import { HttpsError } from 'firebase-functions/v2/https'
import type { Timestamp } from 'firebase-admin/firestore'
import {
  GUEST_SNAPSHOT,
  planGrantIsCurrent,
  resolvePaymentOptions,
  resolveUsageLimit,
  usageWindowDocId,
  type ActivityAccessRule,
  type ContactPaymentSnapshot,
  type PaymentDenial,
  type SubscriptionPrice,
  type SubscriptionUsageLimit,
} from '@linyup/shared'

/**
 * Does HOLDING a subscription of this type grant unmetered (non-credit) access?
 * Used by the booking access gate: credit-pack types must not pass on the
 * membership snapshot alone — their access is metered by credit balance.
 *   • The contact's held price is a non-credit price of this type → true.
 *   • The contact's held price is a credit price of this type      → false.
 *   • Price unknown: true unless EVERY active price carries credits (a
 *     credits-only type can only ever grant metered access).
 */
async function classifyHeldType(
  teamId: string,
  subscriptionTypeId: string,
  contact: FirebaseFirestore.DocumentData
): Promise<{ unmetered: boolean; limit: SubscriptionUsageLimit | null }> {
  try {
    const snap = await admin
      .firestore()
      .collection('teams')
      .doc(teamId)
      .collection('subscription_types')
      .doc(subscriptionTypeId)
      .get()
    if (!snap.exists) return { unmetered: true, limit: null } // unknown type — pre-credits behavior
    const data = snap.data()!
    const limit = resolveUsageLimit({ limits: data.limits as SubscriptionUsageLimit[] | undefined })
    const prices = ((data.prices as SubscriptionPrice[] | undefined) ?? []).filter(
      (p) => p.active !== false
    )
    if (prices.length === 0 || prices.every((p) => !p.credits)) return { unmetered: true, limit }
    const heldPriceId =
      contact.subscription_type_id === subscriptionTypeId
        ? (contact.subscription_price_id as string | undefined)
        : undefined
    if (heldPriceId) {
      const heldPrice = prices.find((p) => p.id === heldPriceId)
      if (heldPrice) return { unmetered: !heldPrice.credits, limit }
    }
    // Held price unknown: lenient unless the type is credits-only.
    return { unmetered: prices.some((p) => !p.credits), limit }
  } catch {
    return { unmetered: true, limit: null } // fail open — pre-credits/pre-limits behavior
  }
}

export interface AccessGateResult {
  /** The subscription type whose coverage matched, or null (open/members rule,
   *  or no subscription check was needed). */
  matchedSubscriptionTypeId: string | null
  /** Set when the match came from a lesson-credit pack — the caller must spend
   *  one credit of this type atomically with the booking write. */
  creditSpendTypeId: string | null
  /** Set when the match came from a USAGE-LIMITED subscription — the caller
   *  must increment this window counter atomically with the booking write
   *  (and stamp the booking so cancellation can decrement it). */
  usageSpend: { subscriptionTypeId: string; docId: string; count: number } | null
}

/** Why coverage was denied — null means it wasn't (the caller is covered). */
export type BookingAccessDenialReason =
  | 'guest'
  | 'not_joined'
  | 'no_subscription'
  | 'no_credits'
  | 'limit_reached'

export interface BookingCoverageResult extends AccessGateResult {
  /** Whether the accessRule is satisfied — the non-throwing twin of
   *  resolveBookingAccessGate's "doesn't throw". */
  covered: boolean
  denial: BookingAccessDenialReason | null
}

/** THE wording for every coverage refusal. Widened past
 *  BookingAccessDenialReason (a strict subset) to the resolver's full denial
 *  union so the waitlist claim — which resolves a DROP-IN target and can
 *  therefore see the trial denials too — reuses these strings instead of
 *  growing a second, drifting set. */
export function denialMessage(denial: PaymentDenial, isAppointment: boolean): string {
  switch (denial) {
    case 'guest':
      return isAppointment
        ? 'This appointment series is for registered members only. Please verify your email.'
        : 'This session is for registered members only. Please verify your email.'
    case 'not_joined':
      return isAppointment
        ? 'This appointment series is for members only. Trial accounts cannot book.'
        : 'This session is for members only. Trial accounts cannot book this class.'
    case 'no_credits':
      return 'No lesson credits remaining on your pack. Purchase a new pack to book this class.'
    case 'limit_reached':
      return 'You have used all the classes your membership includes for this period.'
    case 'no_subscription':
      return 'This class requires an active membership you do not currently hold.'
    case 'sign_in_required':
      return 'Please sign in to book this class.'
    case 'trial_used':
      return 'This email has already used a trial'
  }
}

// The "held" shape every coverage/benefit resolution starts from: live
// subscriptions + the primary snapshot while its grant is still current, and
// non-exhausted, non-expired lesson-credit balances. Pure, no DB call — the DB
// call (classifyHeldType, above) happens per-id, because it depends on
// which id is being checked.
//
// The flat grant's expiry runs through `planGrantIsCurrent` (@linyup/shared) —
// the SAME predicate the client-side union uses, deliberately, because this
// function and that one answer the same question on the two sides of the wire
// and a studio would never find out if they disagreed: the member would simply
// be shown a price the server then refuses (or the reverse).
function heldAndCreditSets(
  contact: FirebaseFirestore.DocumentData,
  nowMs: number
): {
  held: Set<string>
  creditTypes: Set<string>
} {
  const held = new Set<string>()
  const active =
    (contact.active_subscriptions as Array<{ subscription_type_id?: string }> | undefined) ?? []
  active.forEach((s) => {
    if (s.subscription_type_id) held.add(s.subscription_type_id)
  })
  if (
    contact.subscription_type_id &&
    planGrantIsCurrent(contact as { subscription_expires_at?: Timestamp | null }, nowMs)
  ) {
    held.add(contact.subscription_type_id)
  }

  const creditTypes = new Set(
    (
      (contact.credit_summary as
        | Array<{
            subscription_type_id: string
            remaining: number
            next_expires_at?: Timestamp | null
          }>
        | undefined) ?? []
    )
      .filter((e) => e.remaining > 0 && (!e.next_expires_at || e.next_expires_at.toMillis() > nowMs))
      .map((e) => e.subscription_type_id)
  )
  return { held, creditTypes }
}

/**
 * Build the pure snapshot `resolvePaymentOptions` (@linyup/shared) consumes —
 * the AUTHORITATIVE server-side one. This is where the impure part of coverage
 * lives: classifying each relevant held type as unmetered vs credit-metered
 * (`classifyHeldType`, a per-type Firestore read, deliberately
 * fail-open). Only ids in `relevantTypeIds` are classified — pass the union of
 * every id the resolution can touch (accessRule ids ∪ benefit ids).
 */
export interface LimitedUsageWindow {
  subscriptionTypeId: string
  /** Doc id under contacts/{id}/usage_windows for the CURRENT window. */
  docId: string
  /** The configured allowance (limit.count). */
  count: number
  used: number
}

export interface ContactPaymentContext {
  snapshot: ContactPaymentSnapshot
  /** Per LIMITED unmetered held type: the current window's counter state —
   *  what bookSession must increment transactionally on a covered booking. */
  limitedWindows: Record<string, LimitedUsageWindow>
}

export async function loadContactPaymentContext(params: {
  teamId: string
  contact: (admin.firestore.DocumentData & { id: string }) | null
  relevantTypeIds: string[]
  /** The moment the usage-limit window is metered against — pass the SESSION's
   *  start so "3 per week" counts the week the class HAPPENS, not the week the
   *  booking is made (advance bookings must debit the right window). Defaults
   *  to now for callers with no session date (e.g. course checkouts, where
   *  limits don't apply anyway). */
  usageAt?: Date
}): Promise<ContactPaymentContext> {
  const { teamId, contact, relevantTypeIds, usageAt } = params
  if (!contact) return { snapshot: GUEST_SNAPSHOT, limitedWindows: {} }

  const nowMs = Date.now()
  const { held, creditTypes } = heldAndCreditSets(contact, nowMs)
  const usableRemaining = (id: string): number => {
    const entries =
      (contact.credit_summary as
        | Array<{
            subscription_type_id?: string
            remaining?: number
            next_expires_at?: Timestamp | null
          }>
        | undefined) ?? []
    return entries
      .filter(
        (e) =>
          e.subscription_type_id === id &&
          (e.remaining ?? 0) > 0 &&
          (!e.next_expires_at || e.next_expires_at.toMillis() > nowMs)
      )
      .reduce((sum, e) => sum + (e.remaining ?? 0), 0)
  }

  const heldUnmeteredTypeIds: string[] = []
  const heldCreditTypes: Array<{ subscriptionTypeId: string; remaining: number }> = []
  const limited: Array<{ id: string; limit: SubscriptionUsageLimit }> = []
  for (const id of relevantTypeIds) {
    if (held.has(id)) {
      const { unmetered, limit } = await classifyHeldType(teamId, id, contact)
      if (unmetered) {
        heldUnmeteredTypeIds.push(id)
        if (limit) limited.push({ id, limit })
        continue
      }
      // Mirror-held but credit-metered — attached, possibly with 0 usable left
      // (drives the no_credits denial).
      heldCreditTypes.push({ subscriptionTypeId: id, remaining: usableRemaining(id) })
      continue
    }
    if (creditTypes.has(id)) {
      heldCreditTypes.push({ subscriptionTypeId: id, remaining: usableRemaining(id) })
    }
  }

  // Current-window consumption for the limited types (one small doc each).
  const limitedWindows: Record<string, LimitedUsageWindow> = {}
  const usageRemaining: Record<string, number> = {}
  for (const { id, limit } of limited) {
    const docId = usageWindowDocId(id, limit.per, usageAt ?? new Date())
    let used = 0
    try {
      const snap = await admin
        .firestore()
        .collection('contacts')
        .doc(contact.id)
        .collection('usage_windows')
        .doc(docId)
        .get()
      used = (snap.data()?.used as number | undefined) ?? 0
    } catch {
      used = 0 // fail open, like the type classification
    }
    limitedWindows[id] = { subscriptionTypeId: id, docId, count: limit.count, used }
    usageRemaining[id] = Math.max(0, limit.count - used)
  }

  return {
    snapshot: {
      authenticated: true,
      joined: contact.acquisition_stage === 'joined',
      heldUnmeteredTypeIds,
      heldCreditTypes,
      trialUsed: !!contact.trial_used_at,
      ...(limited.length > 0 ? { usageRemaining } : {}),
    },
    limitedWindows,
  }
}

export async function loadContactPaymentSnapshot(params: {
  teamId: string
  contact: (admin.firestore.DocumentData & { id: string }) | null
  relevantTypeIds: string[]
  usageAt?: Date
}): Promise<ContactPaymentSnapshot> {
  return (await loadContactPaymentContext(params)).snapshot
}

/**
 * Non-throwing core of the paid-access gate: does this (already-resolved)
 * authenticated contact — or null for a guest — satisfy an activity's
 * accessRule? Snapshot → resolvePaymentOptions (@linyup/shared) → mapped back
 * to the legacy result shape, so bookSession/bookAppointment diffs stay nil.
 * CLASS-ONLY — appointments dropped the access gate entirely.
 */
export async function resolveBookingCoverage(params: {
  teamId: string
  accessRule: ActivityAccessRule
  authenticatedContact: (admin.firestore.DocumentData & { id: string }) | null
  /** Session start — meters usage limits against the week the class HAPPENS. */
  usageAt?: Date
  /** The class's drop-in configuration. The FREE path needs it to tell "books
   *  free" from "must go and pay": with no price there is nowhere to send her,
   *  so a class nobody's plan covers is simply free. Omitted ⇒ no paid door,
   *  which is the safe reading (it can only refuse, never give a class away). */
  dropIn?: { enabled?: boolean; priceAmount?: number } | null
}): Promise<BookingCoverageResult> {
  const { teamId, accessRule, authenticatedContact, usageAt, dropIn } = params
  const { snapshot, limitedWindows } = await loadContactPaymentContext({
    teamId,
    contact: authenticatedContact,
    relevantTypeIds: accessRule.subscriptionTypeIds ?? [],
    usageAt,
  })
  const { options, denial } = resolvePaymentOptions(snapshot, {
    kind: 'class_booking',
    accessRule,
    dropIn,
  })
  if (denial) {
    // 'sign_in_required'/'trial_used' never come out of the class arm.
    return {
      covered: false,
      matchedSubscriptionTypeId: null,
      creditSpendTypeId: null,
      usageSpend: null,
      denial: denial as BookingAccessDenialReason,
    }
  }
  const option = options[0]
  if (option?.type === 'spend_credits') {
    return {
      covered: true,
      matchedSubscriptionTypeId: option.via.subscriptionTypeId,
      creditSpendTypeId: option.via.subscriptionTypeId,
      usageSpend: null,
      denial: null,
    }
  }
  const matched =
    option?.type === 'covered' && option.via.reason === 'subscription'
      ? option.via.subscriptionTypeId
      : null
  // A limited type's coverage must consume one unit of its current window.
  const window = matched ? limitedWindows[matched] : undefined
  return {
    covered: true,
    matchedSubscriptionTypeId: matched,
    creditSpendTypeId: null,
    usageSpend: window
      ? { subscriptionTypeId: window.subscriptionTypeId, docId: window.docId, count: window.count }
      : null,
    denial: null,
  }
}

// History: an APPOINTMENTS-ONLY `resolveHeldBenefit` (multi-match held-benefit
// lookup) lived here until the pricing consolidation — the appointment paths
// now build a snapshot via loadContactPaymentContext and resolve through
// resolvePaymentOptions like everything else.

/**
 * Enforce an activity's accessRule against an already-resolved authenticated
 * contact (or null for a guest). Throws HttpsError on denial. Shared by
 * bookSession (group classes) and bookAppointment (1:1 appointments) so both
 * agree on the paid-access axis. Thin thrower over resolveBookingCoverage —
 * class behaviour is unchanged.
 */
export async function resolveBookingAccessGate(params: {
  teamId: string
  accessRule: ActivityAccessRule
  authenticatedContact: (admin.firestore.DocumentData & { id: string }) | null
  /** Drives denial-message wording only. */
  isAppointment: boolean
  /** Session start — meters usage limits against the week the class HAPPENS. */
  usageAt?: Date
  /** See `resolveBookingCoverage` — the paid door the free path checks for. */
  dropIn?: { enabled?: boolean; priceAmount?: number } | null
}): Promise<AccessGateResult> {
  const coverage = await resolveBookingCoverage(params)
  if (coverage.denial) {
    throw new HttpsError('permission-denied', denialMessage(coverage.denial, params.isAppointment))
  }
  return {
    matchedSubscriptionTypeId: coverage.matchedSubscriptionTypeId,
    creditSpendTypeId: coverage.creditSpendTypeId,
    usageSpend: coverage.usageSpend,
  }
}
