import type { MigrationConfig } from '../config'
import { sourceDb, targetDb } from '../config'
import { BatchWriter } from '../batch-writer'
import { transformActivity } from '../transforms/activities'
import {
  CANONICAL_SUBSCRIPTION_TYPES,
  sourceTypeDuplicatesCanonical,
} from '../transforms/subscriptions'

export async function pass03Activities(
  cfg: MigrationConfig,
  teamIds: string[],
): Promise<Map<string, { name: string; type: string }>> {
  console.log('Pass 3: activities')
  const src       = sourceDb()
  const tgt       = targetDb()
  const bw        = new BatchWriter(tgt, cfg.dryRun)
  const activityMap = new Map<string, { name: string; type: string }>()

  for (const teamId of teamIds) {
    if (cfg.fromTeam && teamId < cfg.fromTeam) continue
    // EVERY PLAN THIS STUDIO WILL HAVE, derived rather than read back: pass 11
    // writes the types and runs LATER, so the target has none of them yet. The
    // canonical ids are a code constant, and a source type survives exactly when
    // pass 11 will not skip it as a canonical duplicate — the same predicate, so
    // the two passes cannot disagree about which plans exist.
    const srcTypes = await src.collection('teams').doc(teamId).collection('subscription_types').get()
    const planIds = [
      ...CANONICAL_SUBSCRIPTION_TYPES.map((t) => t.id),
      ...srcTypes.docs
        .filter((d) => !sourceTypeDuplicatesCanonical((d.data() as { name?: string }).name))
        .map((d) => d.id),
    ]

    const snap = await src.collection('activities').where('teamId', '==', teamId).get()
    for (const d of snap.docs) {
      const data = transformActivity(d.data() as Record<string, unknown>, planIds)
      activityMap.set(d.id, {
        name: String(data.name ?? ''),
        type: String(data.type ?? 'class'),
      })
      const tgtRef = tgt.collection('activities').doc(d.id)
      if (!cfg.dryRun) {
        const existing = await tgtRef.get()
        if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
      }
      bw.set(tgtRef, data)
    }
  }
  await bw.done()
  return activityMap
}
