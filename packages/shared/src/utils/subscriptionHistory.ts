// THE reconciler between "what a contact currently HOLDS" and "what
// `contacts/{id}/subscription_history` currently says" — the pure core of
// `onContactSubscriptionChange` (packages/functions/src/sync/), pulled out for the
// same reason `subscriptionRollup.ts` was: that trigger has exactly one caller in
// production, but the going-forward-only seed fixtures
// (`scripts/lib/fixtures/subscriptionHistory.ts`) need to produce data the trigger
// would have produced, and an Admin-SDK write fires no trigger. A seed that
// invented its own reconciliation would put every demo tenant one refactor away
// from history that disagrees with what the real writer does.
//
// Deliberately data-only: no firebase-admin, no Timestamp import. Callers pass
// plain records and millisecond numbers, so this stays importable from the web,
// the functions and the scripts — same convention as `subscriptionRollup.ts`.
//
// ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────
// The old writer fired only on the contact's single plan field changing, and
// on every change closed EVERY open row (`where('end_date','==',null)`)
// regardless of type. A contact holding two
// memberships at once therefore got ONE track: adding a second plan closed the
// first one's row even though the member still holds it, and the two plans'
// histories collapsed into whichever one last touched that field. This file
// makes "what is held" and "what the history says" the same question asked two
// ways, reconciled by SET DIFFERENCE rather than by watching one field change —
// so idempotency is a property of the algorithm (re-running it against unchanged
// input plans nothing), not a dedup key bolted on afterward.

import type { HeldPlan } from '../types/planHoldings'

// ─── held plans (the "what") ───────────────────────────────────────────────────

/** The field `resolveHeldPlans` reads off a contact document — the plan list
 *  (docs/multi-plan-holdings.md). Structurally compatible with
 *  `FirebaseFirestore.DocumentData`, so a trigger can pass a raw snapshot's
 *  `.data()` straight through. */
export interface ContactSubscriptionFields {
  held_plans?: ReadonlyArray<HeldPlan> | null
}

/** One plan a contact currently holds, as a history row records it. */
export interface HeldPlanSnapshot {
  subscription_type_id: string
  subscription_type_name: string | null
  recurrence: string | null
  /** The price the plan was given at, when a grant names one. A Stripe entry
   *  never does: it tracks what is CHARGED, not the price the studio assigned. */
  subscription_price_id: string | null
  /**
   * ⚠ MAJOR units. `HeldPlan.amount` is already divided down from Rappen by
   * `buildHeldPlans` for a Stripe entry, and a grant's `amount` is stored in
   * major units. Sourcing this from a raw `member_subscriptions.amount` — which
   * IS Rappen — would silently write a number 100x too large into history.
   * Pinned by a test.
   */
  amount: number | null
}

/**
 * The plan types a contact HOLDS, one snapshot each, read off the STORED plan
 * list — every membership on it, whatever holds it (a staff grant, a purchase,
 * a Stripe subscription). Credit packs are not periods of membership and are
 * left out, as they are everywhere "subscribed" is displayed (`heldMemberships`).
 *
 * The list is read AS STORED, not re-filtered against the clock: a grant that
 * simply runs out is not a write, and its row closes when the daily
 * `refreshHeldPlans` job rewrites the mirror. Comparing both sides of a write
 * against "now" would make that rewrite look like no change at all.
 *
 * Two entries of one type (a grant and a Stripe subscription) make one period:
 * each field takes the first non-null value, in list order.
 */
export function resolveHeldPlans(
  contact: ContactSubscriptionFields | null | undefined
): Map<string, HeldPlanSnapshot> {
  const held = new Map<string, HeldPlanSnapshot>()
  for (const entry of contact?.held_plans ?? []) {
    const typeId = entry?.subscription_type_id
    if (!typeId || entry.source === 'credits') continue
    const existing = held.get(typeId)
    held.set(typeId, {
      subscription_type_id: typeId,
      subscription_type_name: existing?.subscription_type_name ?? entry.subscription_type_name ?? null,
      recurrence: existing?.recurrence ?? entry.recurrence ?? null,
      subscription_price_id: existing?.subscription_price_id ?? entry.price_id ?? null,
      amount: existing?.amount ?? (typeof entry.amount === 'number' ? entry.amount : null),
    })
  }
  return held
}

/**
 * Set equality of held type ids — the CHEAP guard run BEFORE any Firestore read.
 * A plain field touch (`last_seen_at`, `notes`, …) must not cost a subcollection
 * read on every contact write, and comparing the two `resolveHeldPlans` outputs
 * by key is all that question needs.
 */
export function heldPlanIdsEqual(
  a: Map<string, HeldPlanSnapshot>,
  b: Map<string, HeldPlanSnapshot>
): boolean {
  if (a.size !== b.size) return false
  for (const id of a.keys()) {
    if (!b.has(id)) return false
  }
  return true
}

// ─── the reconciler (the "what the history says") ──────────────────────────────

/** The subset of a `subscription_history` row this module needs to reconcile
 *  against — deliberately narrow so a caller can pass a Firestore doc snapshot's
 *  data directly, or a plain test fixture. */
export interface SubscriptionHistoryRow {
  id: string
  subscription_type_id?: string | null
  subscription_type_name?: string | null
  recurrence?: string | null
  subscription_price_id?: string | null
  amount?: number | null
  /** Presence only matters — the reconciler never reads the date itself. */
  start_date?: unknown
  /** null OR ABSENT both mean "not closed" — see `isSubscriptionHistoryRowOpen`. */
  end_date?: unknown
  termination_reason?: string | null
}

/**
 * A row counts as OPEN when `end_date` is null or ABSENT **and** it has a
 * `start_date`. That second condition is the whole mitigation for a row with no
 * `start_date` at all (a legacy/malformed doc, or one mid-write) being treated
 * as an open track forever — one condition, no extra ceremony, no dedicated
 * "malformed" branch to maintain.
 */
export function isSubscriptionHistoryRowOpen(row: Pick<SubscriptionHistoryRow, 'start_date' | 'end_date'>): boolean {
  return (row.end_date === null || row.end_date === undefined) && row.start_date != null
}

/** One row of `teams/{teamId}/subscription_transitions` this reconciliation implies. */
export interface SubscriptionTransitionPlan {
  from_subscription_type_id: string | null
  from_subscription_type_name: string | null
  to_subscription_type_id: string | null
  to_subscription_type_name: string | null
  recurrence: string | null
  subscription_price_id: string | null
  amount: number | null
  /** Carried from the CLOSED row's `termination_reason` — never fabricated, and
   *  never written back onto the row itself (see the module header). */
  termination_reason: string | null
}

export interface SubscriptionHistoryPlan {
  /** Held types with no open row — need a NEW open row written for them. */
  open: HeldPlanSnapshot[]
  /** Open rows whose type is no longer held — need `end_date` set. */
  close: SubscriptionHistoryRow[]
  /** Never fabricates a swap that didn't happen — see the function doc below. */
  transitions: SubscriptionTransitionPlan[]
  /** Type ids that had MORE THAN ONE open row at once — a bug elsewhere (a retry
   *  that used a non-deterministic id, a manual Firestore edit) that this
   *  reconciliation self-heals by closing every one of them, but is worth a
   *  caller logging rather than silently swallowing. */
  duplicateOpenTypeIds: string[]
}

/**
 * Reconcile `held` (this contact's CURRENT plans, from `resolveHeldPlans`)
 * against `rows` (everything under its `subscription_history` subcollection) by
 * SET DIFFERENCE — never by diffing one before/after pair of fields. That is
 * what makes the result IDEMPOTENT: re-running this against the same `held` and
 * the `rows` it already produced returns `{ open: [], close: [], transitions: [] }`,
 * with no dedup key or "have I already processed this event" bookkeeping
 * required anywhere.
 *
 * Rules, applied per type id:
 *  - held with no open row → `open` (a NEW row is needed).
 *  - an open row whose type is no longer held → `close` (ALL such rows for that
 *    type, not just one — see `duplicateOpenTypeIds`).
 *  - an open row whose type IS still held → untouched; nothing to reconcile.
 *
 * Transitions never fabricate a pairing that did not happen: with exactly one
 * close and one open, it is the legacy "swap" shape (`{from, to}`, one row).
 * Otherwise — 0 closes, 0 opens, or more than one of either — it is one row PER
 * close (`to: null`) and PER open (`from: null`). An N-in/M-out write (e.g. two
 * plans added in the same write, or one added while an unrelated one lapses)
 * would otherwise have no correct way to pick which close pairs with which open.
 */
export function planSubscriptionHistory(
  held: Map<string, HeldPlanSnapshot>,
  rows: SubscriptionHistoryRow[]
): SubscriptionHistoryPlan {
  const openRowsByType = new Map<string, SubscriptionHistoryRow[]>()
  for (const row of rows) {
    if (!isSubscriptionHistoryRowOpen(row)) continue
    const typeId = row.subscription_type_id
    if (!typeId) continue // an open row naming no type has nothing to reconcile against
    const list = openRowsByType.get(typeId) ?? []
    list.push(row)
    openRowsByType.set(typeId, list)
  }

  const open: HeldPlanSnapshot[] = []
  for (const [typeId, snapshot] of held) {
    if (!openRowsByType.has(typeId)) open.push(snapshot)
  }

  const close: SubscriptionHistoryRow[] = []
  const duplicateOpenTypeIds: string[] = []
  for (const [typeId, list] of openRowsByType) {
    if (held.has(typeId)) {
      // Still held: close nothing. A second open row for a type still held is a
      // bug (or a race) worth reporting, but the algorithm's job here is only to
      // reconcile HELD-vs-HISTORY, and "still held" is not a reconciliation case.
      if (list.length > 1) duplicateOpenTypeIds.push(typeId)
      continue
    }
    // No longer held: close every open row for this type. There should be
    // exactly one, but closing ALL of them is what stops a stray always-open
    // duplicate from surviving a reconciliation that only closed the first.
    close.push(...list)
    if (list.length > 1) duplicateOpenTypeIds.push(typeId)
  }

  const transitions: SubscriptionTransitionPlan[] = []
  if (close.length === 1 && open.length === 1) {
    const from = close[0]
    const to = open[0]
    transitions.push({
      from_subscription_type_id: from.subscription_type_id ?? null,
      from_subscription_type_name: from.subscription_type_name ?? null,
      to_subscription_type_id: to.subscription_type_id,
      to_subscription_type_name: to.subscription_type_name,
      recurrence: to.recurrence,
      subscription_price_id: to.subscription_price_id,
      amount: to.amount,
      termination_reason: from.termination_reason ?? null,
    })
  } else {
    for (const row of close) {
      transitions.push({
        from_subscription_type_id: row.subscription_type_id ?? null,
        from_subscription_type_name: row.subscription_type_name ?? null,
        to_subscription_type_id: null,
        to_subscription_type_name: null,
        recurrence: row.recurrence ?? null,
        subscription_price_id: row.subscription_price_id ?? null,
        amount: typeof row.amount === 'number' ? row.amount : null,
        termination_reason: row.termination_reason ?? null,
      })
    }
    for (const snapshot of open) {
      transitions.push({
        from_subscription_type_id: null,
        from_subscription_type_name: null,
        to_subscription_type_id: snapshot.subscription_type_id,
        to_subscription_type_name: snapshot.subscription_type_name,
        recurrence: snapshot.recurrence,
        subscription_price_id: snapshot.subscription_price_id,
        amount: snapshot.amount,
        termination_reason: null,
      })
    }
  }

  return { open, close, transitions, duplicateOpenTypeIds }
}

// ─── deterministic doc ids ──────────────────────────────────────────────────────

/**
 * Firestore doc ids may not contain `/`. Kept to a small safe alphabet (rather
 * than only blocking the slash) so an old subscription-type id carrying spaces
 * or punctuation can't produce a surprising path segment either.
 */
function sanitizeForDocId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200)
  return cleaned || '_'
}

/**
 * Deterministic id for a newly-OPENED `subscription_history` row: keyed on the
 * type being opened and the millisecond it opens at. Deterministic so a
 * duplicate delivery of the SAME trigger event overwrites the row it already
 * wrote instead of appending a second — Cloud Functions gen2 gives at-least-once
 * delivery, not exactly-once, and `startMs` must come from `event.time` (stable
 * across retries), never `Date.now()`.
 */
export function subscriptionHistoryOpenDocId(typeId: string, startMs: number): string {
  return `${sanitizeForDocId(typeId)}-${startMs}`
}

/**
 * Deterministic id for one row of `teams/{teamId}/subscription_transitions`.
 * Keyed on the contact, the triggering event id, and the row's position within
 * that event's transition list — so re-delivery of the SAME event overwrites the
 * same rows rather than duplicating a team's analytics feed.
 */
export function subscriptionTransitionDocId(contactId: string, eventId: string, index: number): string {
  return `${sanitizeForDocId(contactId)}-${sanitizeForDocId(eventId)}-${index}`
}
