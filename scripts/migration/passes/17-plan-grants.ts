/**
 * Pass 17 — plan lists (docs/multi-plan-holdings.md).
 *
 * Pass 05 writes each migrated contact's plan as a plan grant. This pass builds
 * every contact's plan list (`held_plans`) from its grants, through the one
 * writer of that list (`recomputeHeldPlans`, via scripts/lib/planGrantImport.ts)
 * — no trigger fires on a migration's Admin-SDK writes. Idempotent: an
 * unchanged list is not rewritten.
 */

import type { MigrationConfig } from '../config'
import { targetDb } from '../config'
import { rebuildPlanLists } from '../../lib/planGrantImport'

export async function pass17PlanGrants(cfg: MigrationConfig, teamIds: string[]): Promise<void> {
  console.log('\n── Pass 17: plan lists ──')
  if (cfg.dryRun) {
    console.log('   (dry run — plan lists are built from the grants pass 05 writes; nothing to do)')
    return
  }
  const stats = await rebuildPlanLists(targetDb(), {
    teamIds,
    onError: (id, err) => console.error(`   ✗ contact ${id}:`, (err as Error).message),
  })
  console.log(`   contacts ${stats.contacts} · plan lists written ${stats.changed} · failed ${stats.failed}`)
}
