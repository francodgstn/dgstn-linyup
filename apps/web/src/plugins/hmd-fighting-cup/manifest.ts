import type { PluginManifest } from '@linyup/shared'

// A TENANT-SPECIFIC plugin, and the first MEMBER of the `hmd` container
// (`PLUGIN_BUNDLES` in @linyup/shared; see plugins/hmd/manifest.ts).
//
// The id stays `hmd-fighting-cup`, and the widening it was waiting for has now
// happened WITHOUT it: the container was added beside this plugin rather than
// grown out of it, so there was never a rename to perform. Every
// installed_plugins document, every `event.type` value and the event-type label
// map are untouched.
//
// It is no longer offered in any catalog — the container is the card a tenant
// installs — but nothing else changes: once installed, this manifest resolves
// through its own id exactly as before (`pluginIsInstallable` is the only
// predicate that treats it differently).
export const hmdFightingCupManifest: PluginManifest = {
  id: 'hmd-fighting-cup',
  nameKey: 'hmdFightingCupName',
  descriptionKey: 'hmdFightingCupDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'available',
  iconName: 'Trophy',
  hasOwnerConfig: false,
  // Kept for defense in depth, though a member is already hidden from every
  // catalog by `pluginIsInstallable`. If this plugin were ever taken OUT of
  // the bundle it would become directly installable again, and this line is
  // what stops that from putting a customer's name in every tenant's
  // marketplace. See PluginAudience in @linyup/shared.
  audience: { orgIds: ['hmd'] },
  // No navContributions: this plugin adds no sidebar entry. It surfaces purely
  // as an event type (below) — the Categories tab, custom check-in form, and
  // lineup exports all live on the event detail page.
  eventType: {
    id: 'hmd_fighting_cup',
    nameKey: 'hmdFightingCupEventTypeName',
    icon: 'Trophy',
    hasCategories: true,
    hasCheckinForm: true,
    hasCsvExport: true,
    hasPdfExport: true,
  },
}
