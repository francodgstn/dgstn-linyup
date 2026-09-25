import type { PluginManifest } from '@linyup/shared'

// Site Themes — ready-made looks for the studio website.
//
// A theme is DATA (SITE_THEMES in packages/shared/src/types/siteTheme.ts): a
// combination of brand settings the builder already has plus the style each
// section type starts in. This plugin renders nothing and publishes nothing —
// installing it unlocks the theme picker in the website builder's Design tab,
// and applying a theme writes ordinary, editable site settings.
//
// THE GATE IS ON APPLYING, never on rendering: a site keeps the look a theme
// wrote after the plugin is removed, exactly as it keeps any setting a studio
// made by hand. That is also why there is no teardown arm for it.
//
// Included from Coach, because the website it decorates is reachable from Coach
// (as an add-on); a Studio-only theme would sit above the site it styles. The
// tier is stated in CLIENT_INSTALLABLE_FROM + firestore.rules as well, which a
// test keeps in step with this manifest.
export const siteThemesManifest: PluginManifest = {
  id: 'site-themes',
  nameKey: 'siteThemesName',
  descriptionKey: 'siteThemesDescription',
  category: 'web',
  minPlan: 'coach',
  status: 'beta',
  iconName: 'Palette',
  // No nav contribution: the picker lives in Website → Design.
  //
  // HIDDEN FROM EVERY CATALOG (2026-09-17). Its only theme, Box, was built
  // to reproduce one client's site and now belongs to that client's plugin
  // (CLIENT_SITE_PARTS), so installing this would unlock a picker with nothing
  // in it. An empty audience keeps the card out of every catalog without
  // touching existing installs — the audience gates discovery, never running.
  // Give it a public audience again when a generic theme exists.
  audience: { teamIds: [] },
}
