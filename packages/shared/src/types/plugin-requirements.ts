import type { PluginId } from './plugin'

/**
 * Plugin DEPENDENCIES — "installing A requires B to be installed too".
 *
 * ── WHY THIS IS NOT A BUNDLE ─────────────────────────────────────────────────
 * `PLUGIN_BUNDLES` next door expresses a different relation and cannot express
 * this one. A bundle MEMBER is deliberately never offered on its own
 * (`pluginIsInstallable` returns false for it) — the container is the single
 * card a tenant installs. A REQUIREMENT is the opposite: it is a first-class
 * plugin a tenant discovers, installs and keeps on its own, which some other
 * plugin also happens to need.
 *
 * The bundle file also rules itself out explicitly: "a container is never an
 * `addon` … those two install paths write ONE document and do not reconcile".
 * `finance` IS an add-on (`PLUGIN_ADDONS.finance`), so it could never be a
 * container even if members were independently installable.
 *
 * ── WHY IT LIVES IN SHARED AND NOT IN THE MANIFEST ───────────────────────────
 * The same reason `PLUGIN_BUNDLES` and `PLUGIN_ADDONS` do: the server needs it
 * and cannot import `PLUGIN_REGISTRY`, which lives in `apps/web`.
 * `activatePluginAddon` (packages/functions/src/saas-billing) installs finance
 * for a Coach without the client ever writing the document, so the requirement
 * has to be resolvable from `@linyup/shared` alone.
 *
 * ── SEMANTICS ────────────────────────────────────────────────────────────────
 * Installing A installs any missing requirement of A, as an ORDINARY,
 * standalone install — no provenance stamp, no `installedByBundle`. That is the
 * deliberate difference from the bundle reconciler, and it decides the removal
 * rule below: a requirement installed this way is indistinguishable from one
 * the tenant chose, because after the fact it IS one.
 *
 * Consequently:
 *   • Removing A never removes its requirements. B is independently useful and
 *     the tenant may well have wanted it anyway; silently taking a feature away
 *     because an unrelated plugin left is the failure the bundle reconciler's
 *     "it only removes what it created" rule exists to avoid.
 *   • Removing B while A is installed is REFUSED, naming A. There is no
 *     cascade: uninstalling one plugin must never uninstall another behind the
 *     tenant's back.
 *
 * ── INVARIANTS ───────────────────────────────────────────────────────────────
 * Asserted in `packages/functions/src/plugins/requirements.test.ts`:
 *   - every id on both sides is a real manifest;
 *   - no cycles, and no requirement of a requirement (one level only — a chain
 *     would need a resolver, and nothing needs one yet);
 *   - a requirement is never a bundle member (it must be installable on its
 *     own) and never itself an add-on (it must be free to auto-install);
 *   - a requirement's `minPlan` is never higher than its requirer's, or the
 *     auto-install would be refused by `firestore.rules` at the moment the
 *     requirer is installed.
 */
export const PLUGIN_REQUIREMENTS: Record<PluginId, readonly PluginId[]> = {
  // The statement of assets is an accounting artifact and the accrual phase's
  // depreciation postings read the register's records — so finance needs the
  // register present. The register does NOT need finance: it answers an
  // operational question ("what do we own") and stands alone.
  // See docs/finance-accrual.md → "Assets" and docs/plugins.md.
  finance: ['asset-register'],
}

/** Plugins that `id` needs installed alongside it, or `[]`. */
export function pluginRequirements(id: PluginId): readonly PluginId[] {
  return PLUGIN_REQUIREMENTS[id] ?? []
}

/**
 * Plugins that require `id` — the reverse lookup, which is what a remove
 * confirmation has to show ("Finance needs this"). Computed rather than stored
 * so the two directions cannot disagree.
 */
export function pluginsRequiring(id: PluginId): PluginId[] {
  return Object.keys(PLUGIN_REQUIREMENTS).filter((requirer) =>
    PLUGIN_REQUIREMENTS[requirer]!.includes(id)
  )
}

/** True when `id` is required by something in `installedIds`. */
export function requirementBlockers(id: PluginId, installedIds: readonly PluginId[]): PluginId[] {
  const requirers = pluginsRequiring(id)
  return installedIds.filter((installed) => requirers.includes(installed))
}
