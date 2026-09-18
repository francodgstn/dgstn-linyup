import type { PluginManifest } from '@linyup/shared'

/**
 * CROSSFIT ZUG — a CLIENT WEBSITE plugin.
 *
 * The website parts built to reproduce crossfitzug.ch: the two-column offer
 * section, the black statement panels and matching FAQ, and the Box theme. They
 * are CrossFit Zug's, not the builder's — offering them to every studio would
 * hand a competitor CFZ's exact website components, and custom website work is
 * sold per client. Which parts it owns is listed once, in `CLIENT_SITE_PARTS`
 * (@linyup/shared); this manifest renders and publishes nothing itself.
 *
 * ── WHO SEES IT ──────────────────────────────────────────────────────────────
 * `audience` keeps the client's name out of every other tenant's catalogue. It
 * names the lead tenant today; when CFZ signs, their production team id is added
 * here — a one-line change in the deploy that onboards them. The lead id stays
 * harmless: it only ever matches in the sandbox and on local emulators.
 *
 * ── THE GATE IS ON OFFERING, NEVER RUNNING ───────────────────────────────────
 * Removing the plugin stops the builder OFFERING these parts. A site that
 * already uses them keeps publishing and rendering exactly as before, and the
 * sections stay editable — see `CLIENT_SITE_PARTS`.
 */
export const crossfitZugSiteManifest: PluginManifest = {
  // A literal, as every manifest id is (the plugin tests read manifests as
  // source); it must equal CROSSFIT_ZUG_SITE_PLUGIN in @linyup/shared.
  id: 'crossfitzug',
  nameKey: 'crossfitZugSiteName',
  descriptionKey: 'crossfitZugSiteDescription',
  category: 'web',
  minPlan: 'studio',
  status: 'available',
  iconName: 'Palette',
  audience: { teamIds: ['lead-crossfitzug'] },
}
