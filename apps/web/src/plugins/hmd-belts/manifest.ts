import type { PluginManifest } from '@linyup/shared'

/**
 * HMD's BELT LADDER — the second member of the `hmd` container.
 *
 * It contributes no screen, no event type and no automation. What it carries is
 * DATA: the progression rules for Hwal Moo Do and Korean Dragon, laid down at
 * `organizations/{orgId}/rank_progressions/{systemId}` when the container is
 * installed (`PLUGIN_SEEDS` in @linyup/shared, applied by
 * `functions/src/plugins/seeds.ts`).
 *
 * ── WHY A PLUGIN AND NOT A LINE IN THE MIGRATION ────────────────────────────
 * The migration runs once, against one organization, and is finished. These
 * rules have to survive a re-install, converge when the ladder is corrected, and
 * step aside the moment the federation edits them — none of which a one-shot
 * script does. Installing is also the honest place for it: the rules exist
 * because HMD installed HMD's bundle, not because a database was once loaded.
 *
 * ── WHY IT IS SEPARATE FROM `hmd-fighting-cup` ──────────────────────────────
 * They fail independently and they are owned by different people. The cup is a
 * tournament format with a check-in form and an export; the ladder is the
 * grading standard the whole federation is measured against. A studio that
 * stopped running cups still grades belts. Splitting them costs one manifest and
 * buys the ability to switch either off in the container's ConfigPanel without
 * the other noticing.
 *
 * ── THE ENGINE IS GENERIC; THIS IS ITS FIRST CUSTOMER ───────────────────────
 * Nothing in `rankProgression.ts` knows about belts or dan grades. A swim school
 * whose levels require attended lessons writes the same vocabulary. This plugin
 * contributes rule data and no code, which is the whole point of the split — see
 * that module's header.
 */
export const hmdBeltsManifest: PluginManifest = {
  id: 'hmd-belts',
  nameKey: 'hmdBeltsName',
  descriptionKey: 'hmdBeltsDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'available',
  iconName: 'Award',
  hasOwnerConfig: false,
  // Defense in depth, exactly as on `hmd-fighting-cup`: a member is already
  // hidden from every catalog by `pluginIsInstallable`, and this is what keeps
  // a customer's name out of every other tenant's marketplace if it were ever
  // taken out of the bundle. See PluginAudience in @linyup/shared.
  audience: { orgIds: ['hmd'] },
}
