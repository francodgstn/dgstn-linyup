import type { PluginId } from './plugin'

/**
 * Canonical composition of every plugin CONTAINER — a plugin whose install
 * installs others.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE MANIFEST ────────────────────────────────
 * The server-side reconciler needs the member list, and it cannot import
 * `PLUGIN_REGISTRY`: that lives in `apps/web`. `PLUGIN_ADDONS` next door sets
 * exactly this precedent — the catalogue, the billing functions and the scripts
 * all need one list, and `@linyup/shared` is the only module all three can
 * reach. Declaring it in both places would be a copy for a test to police.
 *
 * ── A CONTAINER IS NOT A NEW KIND OF THING ───────────────────────────────────
 * Its members are ordinary plugins with ordinary manifests and ordinary
 * `installed_plugins/{pluginId}` documents, so the sidebar, the event-type
 * contribution, the automation trigger/action registries, `assertPluginInstalled`,
 * the teardown switch and `firestore.rules` all keep working with no knowledge
 * that bundles exist. The container adds exactly one thing: a tenant discovers
 * and installs ONE card instead of several.
 *
 * That is also why widening `hmd-fighting-cup` into HMD's whole customization
 * bundle needed no migration. The member kept its id, its `hmd_fighting_cup`
 * event type and its folder; the container was added beside it.
 *
 * ── INVARIANTS ───────────────────────────────────────────────────────────────
 * Asserted in `packages/functions/src/plugins/bundles.test.ts`, not merely
 * described here:
 *   - no nesting — a container is never a member of another container;
 *   - no sharing — a plugin belongs to at most one container;
 *   - a container is never an `addon` and never `locked`: those two install
 *     paths write ONE document and do not reconcile, so a container reached
 *     through either would install nothing.
 */
export const PLUGIN_BUNDLES: Record<PluginId, readonly PluginId[]> = {
  // HMD's org-level customization bundle. See apps/web/src/plugins/hmd/manifest.ts.
  hmd: ['hmd-fighting-cup', 'hmd-belts'],
  // AI insights — the first GENERIC container. See types/aiInsights.ts and
  // apps/web/src/plugins/ai/manifest.ts. Order is the config panel's order.
  ai: ['ai-contact-summary', 'ai-member-recap', 'ai-team-sentiment'],
}

/** Members of `id`, or `[]` when `id` is not a container. */
export function bundleMembers(id: PluginId): readonly PluginId[] {
  return PLUGIN_BUNDLES[id] ?? []
}

/** The container `id` belongs to, or undefined when it is standalone. */
export function bundleContaining(id: PluginId): PluginId | undefined {
  for (const [container, members] of Object.entries(PLUGIN_BUNDLES)) {
    if (members.includes(id)) return container
  }
  return undefined
}

export function isBundleContainer(id: PluginId): boolean {
  return bundleMembers(id).length > 0
}

export function isBundleMember(id: PluginId): boolean {
  return bundleContaining(id) !== undefined
}

/**
 * The config key on a CONTAINER's install document holding its desired module
 * set — `config.modules`, a `Record<PluginId, boolean>`.
 *
 * The container document is the DESIRED state (one document, one thing an admin
 * toggles); the member documents are the MATERIALIZED state. `reconcileBundle`
 * is the one function that turns one into the other.
 */
export const BUNDLE_MODULES_CONFIG_KEY = 'modules' as const

/**
 * Which members of `containerId` should be installed, given its config.
 *
 * A member ABSENT from the map is ON. That is the load-bearing default: a module
 * shipped after a tenant installed the container must reach that tenant without
 * anybody editing their data. Only an explicit `false` switches one off, and
 * because it is stored rather than inferred it survives every reconcile.
 */
export function enabledBundleModules(
  containerId: PluginId,
  config: Record<string, unknown> | undefined,
): PluginId[] {
  const modules = (config?.[BUNDLE_MODULES_CONFIG_KEY] ?? {}) as Record<string, boolean>
  return bundleMembers(containerId).filter((m) => modules[m] !== false)
}
