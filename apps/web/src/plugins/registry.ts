// Plugin registry — static list of all available first-party plugins.
// Manifests are code (bundled); only installation state lives in Firestore.
// To add a new plugin: create a manifest file and add it here.

import type { PluginId, PluginManifest } from '@linyup/shared'
import { bundleContaining, bundleMembers, pluginIsInstallable } from '@linyup/shared'
import { aiAssistantManifest } from './ai-assistant/manifest'
import { aiInsightsManifest } from './ai-insights/manifest'
import { whatsappManifest } from './whatsapp/manifest'
import { websiteManifest } from './website/manifest'
import { hmdManifest } from './hmd/manifest'
import { hmdFightingCupManifest } from './hmd-fighting-cup/manifest'
import { hmdBeltsManifest } from './hmd-belts/manifest'
import { referralsManifest } from './referrals/manifest'
import { onlineCoursesManifest } from './online-courses/manifest'
import { productsManifest } from './products/manifest'
import { gamificationManifest } from './gamification/manifest'
import { contactGroupsManifest } from './contact-groups/manifest'
import { customFieldsManifest } from './custom-fields/manifest'
import { customFormsManifest } from './custom-forms/manifest'
// NO documents manifest: Documents is a default feature on every plan, not a
// plugin. Leaving it registered would keep a marketplace card with an install
// button that means nothing — and, on Free and Coach, one that the rules refuse.
import { kioskManifest } from './kiosk/manifest'
import { financeManifest } from './finance/manifest'
import { assetRegisterManifest } from './asset-register/manifest'
import { giftCardsManifest } from './gift-cards/manifest'
import { promoCodesManifest } from './promo-codes/manifest'
import { tarif595Manifest } from './tarif-595/manifest'
import { qrInvoicesManifest } from './qr-invoices/manifest'

export const PLUGIN_REGISTRY: PluginManifest[] = [
  aiAssistantManifest,
  aiInsightsManifest,
  whatsappManifest,
  websiteManifest,
  hmdManifest,
  hmdFightingCupManifest,
  hmdBeltsManifest,
  referralsManifest,
  onlineCoursesManifest,
  productsManifest,
  gamificationManifest,
  contactGroupsManifest,
  customFieldsManifest,
  customFormsManifest,
  kioskManifest,
  financeManifest,
  assetRegisterManifest,
  giftCardsManifest,
  promoCodesManifest,
  tarif595Manifest,
  qrInvoicesManifest,
]

/** All plugin-contributed event type IDs (built-in type IDs from installed plugins). */
export function getPluginEventTypeIds(): string[] {
  return PLUGIN_REGISTRY
    .filter((p) => p.eventType)
    .map((p) => p.eventType!.id)
}

// ─── Bundle-aware views of the registry ───────────────────────────────────────
// A container (`PLUGIN_BUNDLES`) is the card a tenant installs; its members are
// real plugins that resolve normally once installed, but are never offered on
// their own. These three helpers are the ONLY places that difference is applied
// — every other consumer of PLUGIN_REGISTRY resolves an already-installed
// plugin and must stay bundle-blind. `plugins/bundles.test.ts` re-derives that
// split from the source.

/**
 * The catalogue view: containers and standalone plugins, never bundle members.
 * THE list every surface that offers an install must iterate.
 */
export function installableManifests(): PluginManifest[] {
  return PLUGIN_REGISTRY.filter(pluginIsInstallable)
}

/**
 * The container manifest that owns `id`, for surfaces that must ATTRIBUTE a
 * member's feature to the card a tenant actually sees — naming the member there
 * would leak the customer name the container's audience exists to hide.
 * Undefined for a standalone plugin.
 */
export function containerManifestFor(id: PluginId): PluginManifest | undefined {
  const containerId = bundleContaining(id)
  return containerId ? PLUGIN_REGISTRY.find((m) => m.id === containerId) : undefined
}

/** Member manifests of a container, in PLUGIN_BUNDLES order — the order the
 *  container's config panel renders its module switches in. */
export function memberManifestsOf(containerId: PluginId): PluginManifest[] {
  return bundleMembers(containerId)
    .map((id) => PLUGIN_REGISTRY.find((m) => m.id === id))
    .filter((m): m is PluginManifest => m !== undefined)
}

/**
 * One manifest by id, for surfaces that hold an id and need its display name —
 * a remove dialog naming the plugin that requires the one being removed, say.
 *
 * A helper rather than a `PLUGIN_REGISTRY.find(...)` at the call site because
 * `bundles.test.ts` forbids the catalogue pages from reaching into the registry
 * directly, and because this deliberately searches ALL manifests, not
 * `installableManifests()`: a bundle member can be the answer here.
 */
export function manifestById(id: PluginId): PluginManifest | undefined {
  return PLUGIN_REGISTRY.find((m) => m.id === id)
}
