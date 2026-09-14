/**
 * Multi-plan holdings: give every contact a plan list.
 *
 * ── WHY IT IS NEEDED ────────────────────────────────────────────────────────
 * docs/multi-plan-holdings.md moves a contact's non-Stripe plan out of the
 * single `subscription_type_*` slot and into `contacts/{c}/plan_grants`, and
 * folds every store into one mirror on the contact, `held_plans`. The triggers
 * that keep the mirror only fire on a write AFTER they are deployed, so every
 * contact that exists today has neither a grant for its slot nor a mirror.
 *
 * WHAT IT DOES per contact, and what it skips, is owned by
 * scripts/lib/planGrantImport.ts — the same code the seeders and the HMD
 * migration run. This file is the command line around it.
 *
 * DEPLOY ORDER: rules, then functions (so the plan-grant trigger is live), then
 * this. Nothing reads the new fields before phase 3, so running it late costs
 * nothing but a stale mirror nobody looks at.
 *
 * Auth: gcloud Application Default Credentials (ADC), like the other backfills.
 * Against the emulator, set FIRESTORE_EMULATOR_HOST and use the demo project.
 *
 * Usage:
 *   pnpm backfill:plan-grants --project linyup-staging [--team t1] [--apply]
 */

import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { formatPlanGrantImportStats, importPlanGrants } from './lib/planGrantImport'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    team: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})

if (!values.project) {
  console.error(
    '❌ --project is required (e.g. --project linyup-staging, or demo-linyup for the emulator)'
  )
  process.exit(1)
}

admin.initializeApp({ credential: applicationDefault(), projectId: values.project })

async function main(): Promise<void> {
  console.log(
    `\n🔧 plan-grants backfill on '${values.project}'${values.team ? ` (team ${values.team})` : ''} ${values.apply ? '(APPLY)' : '(dry run)'}\n`
  )
  const stats = await importPlanGrants(admin.firestore(), {
    teamIds: values.team ? [values.team] : undefined,
    apply: Boolean(values.apply),
    onError: (id, err) => console.error(`  ✗ ${id}:`, (err as Error).message),
  })
  for (const line of formatPlanGrantImportStats(stats, Boolean(values.apply))) console.log(line)
  if (!values.apply) console.log('\nDry run: nothing written. Re-run with --apply.')
  if (stats.failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
