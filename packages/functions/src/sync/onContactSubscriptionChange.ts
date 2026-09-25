/**
 * Firestore trigger for `contacts/{contactId}` that keeps
 * `subscription_history` (the ONLY store of a contact's plan PERIODS) in sync
 * with what the contact currently HOLDS.
 *
 * ── WHY `onDocumentWritten`, NOT `onDocumentUpdated` ─────────────────────────
 * A contact CREATED already holding a plan (manual assignment at creation,
 * import) used to get NO history row at all — `onDocumentUpdated` never fires
 * on create. `onDocumentWritten` covers create + update (and, via the `!after`
 * guard below, ignores delete: a deleted contact's history is left standing as
 * the record of what it once held).
 *
 * ── WHY THE RECONCILER, NOT A FIELD DIFF ─────────────────────────────────────
 * The old writer fired only on the contact's single plan field changing, and on every change closed EVERY open row
 * (`where('end_date','==',null)`) regardless of type — so a contact holding
 * several plans at once collapsed onto one track, and adding a second plan
 * closed the first one's still-current row. `resolveHeldPlans` +
 * `planSubscriptionHistory` (`@linyup/shared/utils/subscriptionHistory`) turn
 * this into "what is held" vs "what history says" by SET DIFFERENCE, so
 * idempotency is a property of the algorithm — re-running it against state it
 * already produced writes nothing — rather than a dedup key layered on top.
 * Those two functions are pure and shared with the seed fixture
 * (`scripts/lib/fixtures/subscriptionHistory.ts`) for the same reason
 * `subscriptionRollup.ts`'s header gives: an Admin-SDK write fires no trigger,
 * so a seed computing its own reconciliation would drift from this one.
 *
 * ── WHAT THIS FUNCTION NEVER DOES ─────────────────────────────────────────────
 * It never writes `contacts/{contactId}` itself — that is what stops it
 * SELF-TRIGGERING (a write here would re-fire this same trigger). What is held
 * is the contact's stored plan list (`resolveHeldPlans` reads `held_plans`,
 * docs/multi-plan-holdings.md): staff grants, purchases and Stripe
 * subscriptions alike, written only by `recomputeHeldPlans` — so a grant that
 * lapses closes its row when the daily `refreshHeldPlans` job rewrites it.
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
  SUBSCRIPTION_TRANSITIONS_SUBCOLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  resolveHeldPlans,
  heldPlanIdsEqual,
  planSubscriptionHistory,
  subscriptionHistoryOpenDocId,
  subscriptionTransitionDocId,
  type SubscriptionHistoryRow,
} from '@linyup/shared'
import { to } from '../utils/async'

/**
 * `end_date` is stamped from `event.time`, which is stable across a duplicate
 * delivery of the same event — but not necessarily AFTER the row's own
 * `start_date` (a row opened by a later, out-of-order-delivered event). Clamp
 * so a period is never negative-length; a defensive floor, not a real scenario
 * today, but cheap to guarantee here and expensive to notice later on a chart.
 */
function clampEndDate(startDate: unknown, now: Timestamp): Timestamp {
  if (startDate instanceof Timestamp && startDate.toMillis() > now.toMillis()) {
    return startDate
  }
  return now
}

export const onContactSubscriptionChange = onDocumentWritten(
  `${CONTACTS_COLLECTION}/{contactId}`,
  async (event) => {
    const after = event.data?.after?.data()
    if (!after) return // a delete leaves history alone — it's the record of what was held

    const before = event.data?.before?.data()

    const beforeHeld = resolveHeldPlans(before)
    const afterHeld = resolveHeldPlans(after)
    // The CHEAP guard, run BEFORE any Firestore read: a plain field touch
    // (last_seen_at, notes, …) — or a bulk import of contacts that never carry a
    // plan at all — must not cost a subcollection read on every contact write.
    if (heldPlanIdsEqual(beforeHeld, afterHeld)) return

    const { contactId } = event.params
    const teamId = (after.teamId as string | undefined) || undefined

    const db = admin.firestore()
    const historyRef = db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION)

    const [readErr, historySnap] = await to(historyRef.get())
    if (readErr) {
      console.error(`[onContactSubscriptionChange] failed to read history for ${contactId}:`, readErr) // eslint-disable-line no-console
      return
    }

    const rows: SubscriptionHistoryRow[] = (historySnap?.docs ?? []).map(
      (d) => ({ id: d.id, ...d.data() }) as SubscriptionHistoryRow
    )

    const plan = planSubscriptionHistory(afterHeld, rows)
    if (plan.duplicateOpenTypeIds.length > 0) {
      console.warn(
        `[onContactSubscriptionChange] contact ${contactId} had multiple open rows for type(s) ${plan.duplicateOpenTypeIds.join(', ')} — reconciling`
      ) // eslint-disable-line no-console
    }
    if (plan.open.length === 0 && plan.close.length === 0) return // already reconciled (e.g. a retried delivery)

    console.log(
      `[onContactSubscriptionChange] contact ${contactId}: closing ${plan.close.length}, opening ${plan.open.length}`
    ) // eslint-disable-line no-console

    // Resolve subscription type NAMES for denormalisation — only for the ids
    // that need it (already-named rows/snapshots skip the lookup entirely), and
    // `.catch`-tolerant: a missing/unreadable type doc must not fail the write.
    const resolvedNames = new Map<string, string>()
    const queued = new Set<string>()
    const nameLookups: Promise<void>[] = []
    const queueNameLookup = (typeId: string | null, currentName: string | null) => {
      if (!typeId || currentName || !teamId || queued.has(typeId)) return
      queued.add(typeId)
      nameLookups.push(
        db
          .collection(TEAMS_COLLECTION)
          .doc(teamId)
          .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
          .doc(typeId)
          .get()
          .then((d) => {
            if (d.exists) resolvedNames.set(typeId, (d.data()?.name as string) || typeId)
          })
          .catch((err) =>
            console.warn(`[onContactSubscriptionChange] could not resolve type name for ${typeId}:`, err?.message) // eslint-disable-line no-console
          )
      )
    }
    for (const snapshot of plan.open) queueNameLookup(snapshot.subscription_type_id, snapshot.subscription_type_name)
    for (const row of plan.close) queueNameLookup(row.subscription_type_id ?? null, row.subscription_type_name ?? null)
    await Promise.all(nameLookups)
    const resolveName = (typeId: string | null, currentName: string | null): string | null =>
      typeId ? (currentName ?? resolvedNames.get(typeId) ?? typeId) : null

    // Timestamp from `event.time` — STABLE across duplicate deliveries of the
    // SAME event (unlike `Timestamp.now()`), which is what makes the deterministic
    // open-row doc id below overwrite on a retry instead of appending a second row.
    const now = Timestamp.fromDate(new Date(event.time))
    const startMs = now.toMillis()

    const batch = db.batch()

    for (const row of plan.close) {
      batch.update(historyRef.doc(row.id), {
        end_date: clampEndDate(row.start_date, now),
        updated_at: now,
      })
    }

    for (const snapshot of plan.open) {
      const docId = subscriptionHistoryOpenDocId(snapshot.subscription_type_id, startMs)
      // Same field set the previous writer produced, unchanged.
      batch.set(historyRef.doc(docId), {
        subscription_type_id: snapshot.subscription_type_id,
        subscription_type_name: resolveName(snapshot.subscription_type_id, snapshot.subscription_type_name),
        recurrence: snapshot.recurrence,
        subscription_price_id: snapshot.subscription_price_id,
        amount: snapshot.amount,
        start_date: now,
        end_date: null,
        termination_reason: null,
        notes: null,
        created_at: now,
        updated_at: now,
      })
    }

    // Team-level transition events for cross-contact analytics — only when this
    // contact belongs to a team (a teamless contact has nowhere to write one).
    if (teamId) {
      const transitionsRef = db.collection(TEAMS_COLLECTION).doc(teamId).collection(SUBSCRIPTION_TRANSITIONS_SUBCOLLECTION)
      plan.transitions.forEach((t, index) => {
        const docId = subscriptionTransitionDocId(contactId, event.id, index)
        batch.set(transitionsRef.doc(docId), {
          contact_id: contactId,
          from_subscription_type_id: t.from_subscription_type_id,
          from_subscription_type_name: resolveName(t.from_subscription_type_id, t.from_subscription_type_name),
          to_subscription_type_id: t.to_subscription_type_id,
          to_subscription_type_name: resolveName(t.to_subscription_type_id, t.to_subscription_type_name),
          recurrence: t.recurrence,
          subscription_price_id: t.subscription_price_id,
          amount: t.amount,
          changed_at: now,
          termination_reason: t.termination_reason,
          team_id: teamId,
        })
      })
    }

    await batch.commit()
  }
)
