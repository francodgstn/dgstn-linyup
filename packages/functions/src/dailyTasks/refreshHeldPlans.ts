// The plan lists whose next change has come due. One task per tenant, daily —
// see utils/tenantFanOut.ts and docs/scalability-2026-09.md §9.
//
// WHY THIS JOB EXISTS AT ALL. Every server and client reader decides "held now"
// by comparing a plan's dates against the clock (`holdingIsCurrent`), so none of
// them needs this. The SECURITY RULES do: they cannot compare per list element,
// so the course gates read the flat `held_plan_type_ids`, which is only as fresh
// as its last recompute. A grant that ends, a grant that starts, a credit pack
// that expires — none of those is a write, so nothing else would recompute the
// mirror when it happens (docs/multi-plan-holdings.md §2.3, decision D1).
//
// `recomputeHeldPlans` is the one writer; this only finds the contacts that are
// due. The recompute moves `held_plans_next_change_at_ms` past today, so a
// redelivered task finds nothing left to do.
import * as admin from 'firebase-admin'
import { CONTACTS_COLLECTION } from '@linyup/shared'
import { recomputeHeldPlans } from '../sync/heldPlans'
import { dispatchTenantJob, type FanOutResult } from '../utils/tenantFanOut'

export interface HeldPlansRefreshStats {
  due: number
  changed: number
  errors: number
}

/** ONE tenant's due contacts. The worker body and the dispatcher's inline path.
 *  Bounded by the contacts whose plan list changes today, not by the roster. */
export async function refreshHeldPlansForTeam(
  teamId: string,
  nowMs: number = Date.now()
): Promise<HeldPlansRefreshStats> {
  const db = admin.firestore()
  const stats: HeldPlansRefreshStats = { due: 0, changed: 0, errors: 0 }
  const snap = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .where('held_plans_next_change_at_ms', '<=', nowMs)
    .get()
  stats.due = snap.size
  for (const doc of snap.docs) {
    try {
      const result = await recomputeHeldPlans(doc.id, { nowMs })
      if (result.changed) stats.changed++
    } catch (err) {
      console.error(`[refreshHeldPlans] recompute failed for ${doc.id}:`, err) // eslint-disable-line no-console
      stats.errors++
    }
  }
  return stats
}

/** THE DISPATCHER — one task per tenant, daily. */
export async function refreshHeldPlans(): Promise<FanOutResult> {
  console.log('refreshHeldPlans dispatch started') // eslint-disable-line no-console
  const result = await dispatchTenantJob({
    functionName: 'heldPlansForTeam',
    granularity: 'day',
    perTeam: (teamId) => refreshHeldPlansForTeam(teamId),
    label: 'heldPlans',
  })
  console.log('refreshHeldPlans dispatch completed:', result) // eslint-disable-line no-console
  return result
}
