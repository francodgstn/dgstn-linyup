/**
 * GIVE EVERY EXISTING RANK LEVEL ITS STABLE `id` — Phase 1 of
 * docs/rank-scale-decoupling.md.
 *
 *   pnpm backfill:rank-level-ids --target staging --dry-run
 *   pnpm backfill:rank-level-ids --target staging
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *
 * For every `organizations/*` and `teams/*` document carrying `ranking_systems`,
 * fills each level's missing `id` with `withRankLevelIds` — the SAME deterministic
 * derivation the seeders and presets use, and the same strings the HMD migration
 * writes literally — then writes the array back. A level that already has an id
 * keeps it. A document whose levels all have ids is left untouched.
 *
 * It also refreshes `teams/{id}/public_profile/{id}.ranking_systems` for every
 * team whose EFFECTIVE systems changed. That mirror is normally rebuilt by
 * `syncTeamPublicProfile` on a TEAM write, and its own header records that an
 * org-only write does not re-trigger it. An organisation's ladder gaining ids
 * is exactly such a write, so without this step every member studio's public
 * mirror — and the member app, which reads it — would keep the id-less copy.
 * The one field is written here with the same shared resolver the sync uses,
 * `effectiveRankingSystems`, so the two cannot disagree about what it holds.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * Nothing on a contact. `Contact.ranks` still stores `value` and every reader
 * still resolves by it; converting records to ids is Phase 2, a separate
 * script, run on YOUR timing against the mobile release — see the plan.
 *
 * RE-RUNNABLE: the derivation is deterministic and a filled id is never
 * replaced, so a second run writes nothing.
 */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { effectiveRankingSystems, withRankLevelIds } from '@linyup/shared'
import type { RankingSystem } from '@linyup/shared'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
})

const TARGETS: Record<string, { projectId: string; emulator: boolean }> = {
  emulator: { projectId: 'demo-linyup', emulator: true },
  staging: { projectId: 'linyup-staging', emulator: false },
  production: { projectId: 'linyup-prod', emulator: false },
}

const target = TARGETS[values.target ?? '']
if (!target) {
  console.error(`❌ --target must be one of: ${Object.keys(TARGETS).join(' | ')}`)
  process.exit(1)
}
if (target.emulator) {
  const slot = Number(process.env.LINYUP_SLOT ?? 0) || 0
  process.env.FIRESTORE_EMULATOR_HOST ??= `localhost:${8080 + slot * 10000}`
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('❌ Refusing to run against a cloud project with FIRESTORE_EMULATOR_HOST set.')
  process.exit(1)
}

admin.initializeApp(
  target.emulator
    ? { projectId: target.projectId }
    : { credential: applicationDefault(), projectId: target.projectId },
)
const db = admin.firestore()
const dryRun = values['dry-run'] ?? false

/** The systems with ids filled, and whether that changed anything. */
function fill(systems: RankingSystem[] | undefined): { systems: RankingSystem[]; changed: boolean } {
  const list = systems ?? []
  let changed = false
  const out = list.map((s) => {
    const before = s.levels ?? []
    const levels = withRankLevelIds(before)
    if (levels.some((l: { id?: string }, i: number) => l.id !== before[i]?.id)) changed = true
    return { ...s, levels }
  })
  return { systems: out, changed }
}

async function main() {
  console.log(`Rank level id backfill — ${target.projectId}${dryRun ? ' (dry run)' : ''}`)

  if (!dryRun && !values.yes && !target.emulator) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nType '${target.projectId}' to write: `)
    rl.close()
    if (answer.trim() !== target.projectId) {
      console.error('Aborted.')
      process.exit(1)
    }
  }

  // ── organisations ──────────────────────────────────────────────────────────
  // Their filled systems are kept for the team loop below, which needs them to
  // rebuild each member studio's EFFECTIVE list for the public mirror.
  const orgSystems = new Map<string, RankingSystem[]>()
  const changedOrgs = new Set<string>()
  const orgs = await db.collection('organizations').get()
  for (const doc of orgs.docs) {
    const { systems, changed } = fill(doc.data().ranking_systems as RankingSystem[] | undefined)
    orgSystems.set(doc.id, systems)
    if (!changed) continue
    changedOrgs.add(doc.id)
    console.log(`  organizations/${doc.id}: ${systems.length} system(s) gain ids`)
    if (!dryRun) await doc.ref.update({ ranking_systems: systems })
  }

  // ── teams, and their public mirrors ────────────────────────────────────────
  let teamsWritten = 0
  let mirrorsWritten = 0
  const teams = await db.collection('teams').get()
  for (const doc of teams.docs) {
    const data = doc.data()
    const own = fill(data.ranking_systems as RankingSystem[] | undefined)
    if (own.changed) {
      teamsWritten++
      console.log(`  teams/${doc.id}: ${own.systems.length} system(s) gain ids`)
      if (!dryRun) await doc.ref.update({ ranking_systems: own.systems })
    }

    // The mirror holds the EFFECTIVE systems; refresh it whenever either side
    // changed, because an org-only change never reaches it on its own.
    const orgId = data.org_id as string | undefined
    if (!own.changed && !(orgId && changedOrgs.has(orgId))) continue
    const effective = effectiveRankingSystems(own.systems, orgId ? (orgSystems.get(orgId) ?? []) : [])
    const mirror = doc.ref.collection('public_profile').doc(doc.id)
    if (!(await mirror.get()).exists) continue
    mirrorsWritten++
    if (!dryRun) await mirror.set({ ranking_systems: effective }, { merge: true })
  }

  console.log(
    `\n${dryRun ? 'Would write' : 'Wrote'}: ${changedOrgs.size} organisation(s), ${teamsWritten} team(s), ${mirrorsWritten} public mirror(s).`,
  )
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
