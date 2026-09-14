/**
 * Pass 17 — plan grants (docs/multi-plan-holdings.md, phase 2).
 *
 * Pass 05 writes each migrated contact's legacy plan slot. This pass imports
 * that slot as a plan grant and rebuilds the contact's plan list, through the
 * same code the backfill and the seeders run (scripts/lib/planGrantImport.ts),
 * so a re-import after the production cutover lands in the new shape. It is
 * idempotent: a contact whose grant is already there is left alone.
 */

import type { MigrationConfig } from '../config'
import { targetDb } from '../config'
import { formatPlanGrantImportStats, importPlanGrants } from '../../lib/planGrantImport'

export async function pass17PlanGrants(cfg: MigrationConfig, teamIds: string[]): Promise<void> {
  console.log('\n── Pass 17: plan grants ──')
  const stats = await importPlanGrants(targetDb(), {
    teamIds,
    apply: !cfg.dryRun,
    onError: (id, err) => console.error(`   ✗ contact ${id}:`, (err as Error).message),
  })
  for (const line of formatPlanGrantImportStats(stats, !cfg.dryRun)) console.log(`   ${line}`)
}
