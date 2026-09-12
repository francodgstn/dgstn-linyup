import type { SaasPlan } from './team'

/**
 * WHAT A TEAM GETS WITHOUT ASKING, AND WHAT IT MAY INSTALL WITHOUT A SERVER GRANT.
 *
 * Two small facts that live here because THREE places need them and only one of
 * them can read a plugin manifest:
 *
 *   `packages/functions`  provisions a new team — cannot import PLUGIN_REGISTRY
 *                         (it is in apps/web).
 *   `firestore.rules`     decides whether a client install is allowed — cannot
 *                         import anything at all.
 *   `apps/web`            owns the manifests, which are the actual truth.
 *
 * So these are DERIVED DATA, and the derivation is checked rather than trusted:
 * `packages/functions/src/teams/teamDefaults.test.ts` reads the manifests AND
 * `firestore.rules` and fails the build when either drifts from what is here.
 * Never hand-edit one of the three without running that test.
 */

/**
 * Installed into every NEW team by `onTeamCreated`.
 *
 * Custom Fields is here because a contact form that cannot be extended is the
 * thing a studio hits on its first afternoon, and discovering that the answer
 * was a plugin it had to go and find is a worse first afternoon (Franco,
 * 2026-08-28).
 *
 * A member of this list must be installable by the plan a new team starts on
 * and must never be a paid add-on — self-granting a paid plugin is the exact
 * thing the install rules exist to stop. The test enforces both.
 */
export const DEFAULT_TEAM_PLUGINS: readonly string[] = ['custom-fields']

/**
 * The LOWEST plan on which an owner may install a plugin from the client — the
 * tiers at which `pluginAccessForPlan` resolves to `included`.
 *
 * Anything absent is `CLIENT_INSTALLABLE_DEFAULT_PLAN`: included from Studio up,
 * and below that either a paid add-on (which must go through
 * `activatePluginAddon`, server-side, so it cannot be self-granted) or simply
 * out of reach.
 *
 * THIS MAP EXISTS BECAUSE THE RULES HAD GONE STALE. They admitted only
 * `['studio', 'organization']`, with a comment explaining that Coach plans
 * activate plugins as PAID add-ons — true when it was written, and falsified by
 * the 2026-06 overhaul that made Contact Groups and Custom Fields *included*
 * from Coach and took them out of `PLUGIN_ADDONS`. From then on a Coach could
 * see both plugins offered as "Included" and be denied by the rules on click,
 * and `activatePluginAddon` refused them too ("not an add-on plugin") — so
 * there was no path at all. Gift Cards had the same hole one tier lower.
 */
export const CLIENT_INSTALLABLE_FROM: Readonly<Record<string, SaasPlan>> = {
  'gift-cards': 'free',
  'asset-register': 'coach',
  'contact-groups': 'coach',
  'custom-fields': 'coach',
  'tarif-595': 'coach',
  'qr-invoices': 'coach',
}

/** The tier every other plugin is client-installable from. */
export const CLIENT_INSTALLABLE_DEFAULT_PLAN: SaasPlan = 'studio'

/** The lowest plan that may client-install `pluginId`. */
export function clientInstallableFrom(pluginId: string): SaasPlan {
  return CLIENT_INSTALLABLE_FROM[pluginId] ?? CLIENT_INSTALLABLE_DEFAULT_PLAN
}
