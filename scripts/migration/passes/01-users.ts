import type { MigrationConfig } from '../config'
import { sourceDb, targetDb } from '../config'
import { BatchWriter } from '../batch-writer'
import { resolveOrgAdmin, isRemappedAdminUid } from '../orgAdmin'

export async function pass01Users(cfg: MigrationConfig): Promise<void> {
  console.log('Pass 1: users (active only)')
  const src = sourceDb()
  const tgt = targetDb()
  const bw  = new BatchWriter(tgt, cfg.dryRun)
  const admin = await resolveOrgAdmin(cfg)

  // disabled_at == null matches both null and missing field (active users only)
  const snap = await src.collection('users').where('disabled_at', '==', null).get()
  console.log(`  found ${snap.size} active users`)

  for (const d of snap.docs) {
    // The admin already has a profile on the target under their own login;
    // copying the source one would leave two `users` documents for one email
    // and a `limit(1)` lookup picking either. See orgAdmin.ts.
    if (isRemappedAdminUid(admin, d.id)) {
      console.log(`  users/${d.id} is the org admin's source profile — skipped, target login ${admin.targetUid} owns theirs`)
      bw.skip()
      continue
    }
    const tgtRef = tgt.collection('users').doc(d.id)
    if (!cfg.dryRun) {
      const existing = await tgtRef.get()
      if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
    }
    bw.set(tgtRef, d.data())
  }
  await bw.done()
}
