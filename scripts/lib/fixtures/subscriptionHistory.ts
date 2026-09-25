/**
 * Seeds `contacts/{id}/subscription_history` — the ONLY store of a contact's
 * plan PERIODS — using `resolveHeldPlans` (@linyup/shared) so seeded and
 * produced data cannot drift. Run AFTER `seedTeamMoney`: it builds each
 * contact's plan list first (`rebuildPlanLists`, through the one writer of
 * `held_plans`) from the seeded plan grants and the member subscriptions
 * `seedTeamMoney` wrote — no trigger fires on an Admin-SDK write, so nothing
 * else would have built it yet — and reads what the contact holds from that.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────────
 * The four seeders each wrote their own inline `subscription_history` block,
 * and every one of them opened AND closed the SAME plan (a "previous" row for
 * type X, then a "current" row for type X) — which is not a real switch, so no
 * seeded tenant had a history a "what did this person hold before" view could
 * show anything interesting for. This fixture writes one OPEN row per plan a
 * contact actually HOLDS (so a contact with two concurrent memberships —
 * `money.ts`'s `concurrentPlans` — gets two tracks, not one), plus, for a
 * deterministic slice of contacts, one CLOSED row on a DIFFERENT type: a plan
 * they held before switching to what they hold now.
 *
 * Deterministic ids (`subscriptionHistoryOpenDocId`) + `set()`, same convention
 * as every other fixture here, so a reseed overwrites in place.
 *
 * Path constants mirror @linyup/shared (same convention as lib/storefront.ts).
 */

import admin from 'firebase-admin'
import { resolveHeldPlans, subscriptionHistoryOpenDocId } from '@linyup/shared'
import type { ContactSubscriptionFields } from '@linyup/shared'
import { rebuildPlanLists } from '../planGrantImport'

const TEAMS_COLLECTION = 'teams'
const CONTACTS_COLLECTION = 'contacts'
const CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION = 'subscription_history'
const SUBSCRIPTION_TYPES_SUBCOLLECTION = 'subscription_types'

const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)
function daysFrom(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

export interface SeedTeamSubscriptionHistoryOptions {
  teamId: string
  /**
   * Fraction of held-a-plan contacts that ALSO get one CLOSED row on a plan
   * type they do NOT currently hold — a believable "switched from X to what
   * they have now". Default 0.25 (roughly 1 in 4), the same slice frequency the
   * old inline seeders used (`i % 4 === 0`) for their (same-type, and therefore
   * unrealistic) "previous" row.
   */
  pastPlanRatio?: number
}

/**
 * Give a team realistic `subscription_history`: every plan every contact holds
 * gets an OPEN row (staggered starts, so contacts on the same plan don't all
 * show one identical start date), and a deterministic slice of contacts also
 * gets a CLOSED row on a plan type they've since left.
 */
export async function seedTeamSubscriptionHistory(
  opts: SeedTeamSubscriptionHistoryOptions
): Promise<{ opened: number; closed: number }> {
  const db = admin.firestore()
  const { teamId } = opts
  const pastPlanRatio = opts.pastPlanRatio ?? 0.25
  // Every Nth eligible (held ≥1 plan) contact gets the extra closed row —
  // deterministic so a reseed with the same population lands on the same slice.
  const everyNth = pastPlanRatio > 0 ? Math.max(1, Math.round(1 / pastPlanRatio)) : 0

  await rebuildPlanLists(db, { teamIds: [teamId] })
  const [contactsSnap, typesSnap] = await Promise.all([
    db.collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).get(),
    db.collection(TEAMS_COLLECTION).doc(teamId).collection(SUBSCRIPTION_TYPES_SUBCOLLECTION).get(),
  ])

  const allTypes = typesSnap.docs.map((d) => ({
    id: d.id,
    name: (d.data().name as string | undefined) ?? d.id,
  }))

  // Sorted so "every Nth" lands on the SAME contacts on every reseed, regardless
  // of Firestore's own (unordered) query result order.
  const contactDocs = [...contactsSnap.docs].sort((a, b) => a.id.localeCompare(b.id))

  let opened = 0
  let closed = 0
  let eligibleIndex = 0

  for (const contactDoc of contactDocs) {
    const held = resolveHeldPlans(contactDoc.data() as ContactSubscriptionFields)
    if (held.size === 0) continue

    const heldTypeIds = new Set(held.keys())
    const historyRef = db
      .collection(CONTACTS_COLLECTION)
      .doc(contactDoc.id)
      .collection(CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION)

    const startsDaysAgo: number[] = []
    let typeIndex = 0
    for (const snapshot of held.values()) {
      // Staggered by BOTH the contact's position and the plan's position within
      // that contact, so two contacts on the same plan — and one contact holding
      // two plans at once — don't all show one identical start date.
      const startedDaysAgo = 30 + ((eligibleIndex * 17 + typeIndex * 41) % 150)
      startsDaysAgo.push(startedDaysAgo)
      const startedAt = daysFrom(-startedDaysAgo)
      const docId = subscriptionHistoryOpenDocId(snapshot.subscription_type_id, startedAt.getTime())
      await historyRef.doc(docId).set({
        subscription_type_id: snapshot.subscription_type_id,
        subscription_type_name: snapshot.subscription_type_name,
        recurrence: snapshot.recurrence,
        subscription_price_id: snapshot.subscription_price_id,
        amount: snapshot.amount,
        start_date: tsOf(startedAt),
        end_date: null,
        termination_reason: null,
        notes: null,
        created_at: tsOf(startedAt),
        updated_at: tsOf(startedAt),
      })
      opened += 1
      typeIndex += 1
    }

    // The deterministic slice: one CLOSED row on a type this contact does NOT
    // currently hold — a real switch, unlike the old same-type open+close pair.
    // Needs at least one OTHER team subscription type to switch FROM.
    if (everyNth > 0 && eligibleIndex % everyNth === 0) {
      const previousType = allTypes.find((t) => !heldTypeIds.has(t.id))
      if (previousType) {
        // Ends strictly BEFORE the earliest current plan starts — a past period
        // can't overlap the one that replaced it.
        const earliestCurrentStart = Math.min(...startsDaysAgo)
        const endedDaysAgo = earliestCurrentStart + 14 + (eligibleIndex % 30)
        const startedDaysAgo = endedDaysAgo + 60 + (eligibleIndex % 90)
        const startedAt = daysFrom(-startedDaysAgo)
        const endedAt = daysFrom(-endedDaysAgo)
        const docId = subscriptionHistoryOpenDocId(previousType.id, startedAt.getTime())
        await historyRef.doc(docId).set({
          subscription_type_id: previousType.id,
          subscription_type_name: previousType.name,
          recurrence: null,
          subscription_price_id: null,
          amount: null,
          start_date: tsOf(startedAt),
          end_date: tsOf(endedAt),
          termination_reason: 'Switched plans.',
          notes: null,
          created_at: tsOf(startedAt),
          updated_at: tsOf(endedAt),
        })
        closed += 1
      }
    }

    eligibleIndex += 1
  }

  return { opened, closed }
}
