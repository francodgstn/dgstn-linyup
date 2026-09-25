import type { Timestamp } from './common'
import type { SaasPlan } from './team'
import { isBundleMember } from './plugin-bundles'

export type PluginId = string
// Consolidated, user-facing buckets (kept deliberately few + meaningful):
//   engagement — gamification, referrals
//   commerce   — products, online courses (things you sell)
//   web        — website, messaging (whatsapp)
//   data       — contact groups, custom fields, insights/analytics
export type PluginCategory = 'engagement' | 'commerce' | 'web' | 'data'
export type PluginStatus = 'available' | 'coming_soon' | 'beta'

// Template literal union — enables type-safe namespaced IDs like 'plugin:whatsapp:send_message'
export type PluginActionId = `plugin:${string}:${string}`
export type PluginTriggerId = `plugin:${string}:${string}`

/**
 * The plugin id inside a namespaced `plugin:{pluginId}:{name}` id — null when
 * the string is not one.
 *
 * THE OWNER OF THIS PARSE, and it lives beside the two id types above so a
 * third namespace (a plugin-contributed rank requirement already uses the same
 * shape) extends it rather than copying it. Every caller that wants to know
 * "which plugin does this belong to" — the automation engine's install gate,
 * the rank requirement resolver — asks here.
 *
 * Strict about the arity: exactly three colon-separated parts. A two-part or
 * four-part string is not a namespaced id, and returning a plausible-looking
 * middle segment for one would hand a caller a plugin id nothing installed.
 */
export function pluginIdOfNamespacedId(id: string): string | null {
  const parts = id.split(':')
  return parts.length === 3 && parts[0] === 'plugin' && parts[1] ? parts[1] : null
}

export interface PluginAutomationTrigger {
  id: PluginTriggerId
  labelKey: string
  descriptionKey?: string
  icon: string
  supportsDelay: boolean
}

export interface PluginAutomationActionField {
  key: string
  labelKey: string
  type: 'text' | 'textarea' | 'select' | 'number'
  options?: Array<{ value: string; labelKey: string }>
  required?: boolean
}

export interface PluginAutomationAction {
  id: PluginActionId
  labelKey: string
  descriptionKey?: string
  icon: string
  configFields?: PluginAutomationActionField[]
}

/**
 * Built-in sidebar sections a plugin nav item can render into.
 *
 * 'operations' is the working day (Run), 'engage' is an outward surface (Grow),
 * 'manage' is the back office — periodic rather than operational, and not an
 * engagement surface either (finance, the asset register).
 */
export type PluginNavSection = 'operations' | 'engage' | 'manage' | 'configure' | 'team'

export interface PluginNavContribution {
  href: string // relative to /(auth)/ — e.g. '/plugins/online-courses'
  labelKey: string
  icon: string
  minPlan?: SaasPlan
  /** Optional existing sidebar section to render into. When set and matching
   *  a built-in section, the item appears inside that section (after the
   *  built-in items). When omitted or unmatched, the item falls back to the
   *  default plugin groups ("Plugins" / "Engage"). */
  section?: PluginNavSection
}

export interface PluginEventType {
  id: string // e.g. 'fighting_cup' — used as event.type value
  nameKey: string
  icon: string // lucide icon name
  hasCategories?: boolean // plugin manages per-event categories (events/{id}/categories)
  hasCheckinForm?: boolean // plugin provides a custom React check-in form
  hasCsvExport?: boolean
  hasPdfExport?: boolean
}

/**
 * The DISCOVERY allow-list of a tenant-specific plugin — who may SEE it in a
 * catalog. A plugin built for one customer (a bespoke customization bundle)
 * should not advertise that customer's name to every other tenant browsing the
 * marketplace, so it names the tenants it belongs to and nobody else finds it.
 *
 * Two identifiers, either of which admits:
 *  - `teamIds` — a single studio.
 *  - `orgIds`  — an organization, AND every team whose `org_id` is in the list.
 *    A member studio of an allowed org is treated as ALLOWED: an org-level
 *    customization bundle exists precisely so the org's studios can run it, and
 *    org membership already confers plugin access everywhere else in the product
 *    (`useInstalledPlugins`: "org_id IS the grant"). Making the studios ask
 *    separately would be a second, disagreeing answer to a question already
 *    settled by joining the org.
 *
 * THIS IS A GATE ON DISCOVERY, NEVER ON RUNNING. Nothing that resolves an
 * INSTALLED plugin — the nav mount, `useInstalledPlugins`, the event-type
 * contribution, the plugin's own pages — consults it. A tenant that was allowed
 * yesterday, installed, and has since been dropped from the list keeps working
 * exactly as before and keeps its card (with its Configure/Remove controls) in
 * the Installed section; it simply could not find it again if it removed it.
 * The alternative — a list edit silently switching a customer's live feature off
 * — is a data change with an outage in it.
 *
 * Absent means PUBLIC. Only a plugin that names an audience is restricted, so
 * every generic plugin is unaffected by construction.
 */
export interface PluginAudience {
  /** Team ids that may discover this plugin. */
  teamIds?: string[]
  /** Organization ids that may discover it — INCLUDING their member teams. */
  orgIds?: string[]
}

/**
 * Whether `manifest` may be DISCOVERED by this tenant. The one reader of
 * `audience` — a call site must go through it rather than test the field.
 *
 * THE CENSUS — every surface that shows a tenant a plugin it has NOT installed,
 * and therefore every place this is called. Add to this list; do not copy it.
 *
 *  - `/plugins` — the marketplace grid, AND its `?plugin=<id>` deep
 *    link, which opens a detail modal naming and describing the plugin.
 *  - `settings/event-types` — the "From plugins" section, which prints
 *    "Provided by {pluginId}" for every plugin event type in the registry.
 *  - `dashboard/DiscoverPanel` — the unsolicited suggestion list.
 *  - `org/{orgId}/plugins` — the org catalog, which passes the ROUTE's org id
 *    rather than the signed-in team's.
 *
 * BUNDLE MEMBERSHIP IS A SECOND, ORTHOGONAL REASON A PLUGIN IS NOT OFFERED, and
 * it is not this function's. `pluginIsInstallable` (below) hides a member of a
 * container from the surfaces above that OFFER AN INSTALL — the marketplace grid,
 * its `?plugin=` deep link, `DiscoverPanel` and the org catalog — because the
 * container is the card a tenant installs. `settings/event-types` calls THIS
 * function and not that one on purpose: it offers no install, so it keeps showing
 * a member's event type and simply attributes it to the container.
 *
 * ONE surface deliberately does not call it: the sidebar's plugin suggestion in
 * `(auth)/layout.tsx`, which is unreachable for a restricted plugin by
 * construction — it takes only manifests that are `recommended` AND contribute
 * a nav row, and a plugin built for one customer is neither. Give a
 * tenant-specific plugin `recommended` or `navContributions` and that filter
 * needs this call added.
 *
 * Fails CLOSED while the tenant is unknown: `useAuth()` reports a null team
 * for as long as the team document is loading, and treating that as "allowed"
 * would show the card for exactly as long as it takes to read it. An
 * unrestricted plugin is unaffected — it returns before looking at the tenant.
 */
export function pluginVisibleToTenant(
  manifest: { audience?: PluginAudience },
  tenant: { teamId?: string | null; orgId?: string | null }
): boolean {
  const audience = manifest.audience
  if (!audience) return true // public — the overwhelming majority
  if (tenant.teamId && audience.teamIds?.includes(tenant.teamId)) return true
  if (tenant.orgId && audience.orgIds?.includes(tenant.orgId)) return true
  return false
}

/**
 * Whether `manifest` may be offered as an INSTALLABLE CARD.
 *
 * False for a bundle member: its container is the thing a tenant installs, and
 * showing both would offer two doors to one feature — with the member's door
 * writing a document the reconciler then owns and may later delete.
 *
 * DELIBERATELY NOT folded into `pluginVisibleToTenant`. That function answers
 * "may this tenant see this?" from `audience`, and its answer depends on the
 * tenant; this one answers "is this a thing anybody installs directly?" from the
 * bundle map, and its answer does not. Fusing them would overload a function
 * whose doc comment carefully promises that an absent audience means PUBLIC.
 *
 * A surface that DESCRIBES a member's feature without offering an install —
 * `settings/event-types` — calls the other one and not this.
 */
export function pluginIsInstallable(manifest: { id: PluginId }): boolean {
  return !isBundleMember(manifest.id)
}

export interface PluginManifest {
  id: PluginId
  nameKey: string
  descriptionKey: string
  category: PluginCategory
  minPlan: SaasPlan
  status: PluginStatus
  /**
   * When set, only the named tenants may DISCOVER this plugin (see
   * `PluginAudience` / `pluginVisibleToTenant`). Absent = visible to everyone.
   *
   * The list lives HERE, in the manifest, rather than in operator-editable
   * data. A tenant-specific plugin is code that exists only because one
   * customer was built for; its manifest is written in the same change that
   * creates it, so naming the audience costs one line in a file already being
   * added. A data-backed list would need a collection, rules, an operator
   * screen and a read on every catalog render before the FIRST one worked —
   * and a globally-readable "which plugin belongs to whom" document leaks the
   * customer names this field exists to hide, while a per-tenant grant document
   * spreads one plugin's audience across N tenants' data. If a plugin ever
   * needs to be handed to a tenant WITHOUT a deploy, the mechanism already
   * exists and composes with this one: `locked` + the `unlockPlugin` callable.
   */
  audience?: PluginAudience
  recommended?: boolean // surfaced with a "Recommended" tag and floated to the top
  // When set, this plugin is available to the Coach plan as a paid monthly
  // add-on (à la carte). Studio/Org include all plugins regardless. Plugins
  // without `addon` are upgrade-locked for coaches.
  addon?: { coachPriceMonthly: number; stripeLookupKey: string }

  iconName: string // lucide icon name resolved at runtime
  /** When true, the plugin is visible in the marketplace but can only be installed
   *  via the `unlockPlugin` callable after a strong secret key check — never a direct
   *  client write (see firestore.rules installed_plugins + unlockPlugin). Used for
   *  experimental/gated plugins the operator unlocks privately. */
  locked?: boolean
  /** Optional URL (or public path) to a screenshot shown in the plugin detail modal. */
  screenshot?: string
  automationTriggers?: PluginAutomationTrigger[]
  automationActions?: PluginAutomationAction[]
  navContributions?: PluginNavContribution[]
  hasOwnerConfig?: boolean // plugin has a settings/credential dialog
  eventType?: PluginEventType // plugin contributes an event type
}

export interface InstalledPlugin {
  pluginId: PluginId
  /** Set for team-scoped installs; absent on org-level installs. */
  teamId?: string
  /** Set for org-level installs; absent on team-scoped installs. */
  orgId?: string
  installedAt: Timestamp
  installedBy: string
  config?: Record<string, unknown>
  secretRef?: string // pointer to Secret Manager secret (future)
  status: 'active' | 'disabled'
  updated_at?: Timestamp
  updatedBy?: string
  /**
   * Written ONLY by the bundle reconciler
   * (`packages/functions/src/plugins/bundleReconcile.ts`), naming the CONTAINER
   * whose install materialized this document.
   *
   * It is what makes removal safe. Uninstalling a container deletes the member
   * documents it created and nothing else — so a studio that had installed the
   * same plugin standalone BEFORE the container arrived keeps it, and keeps its
   * config. Without the stamp the reconciler could not tell the two apart and
   * would take away a feature the tenant chose for itself.
   *
   * Use `INSTALLED_BY_BUNDLE_FIELD` rather than the literal: the writer and the
   * reader are in different packages, and a typo on either side silently changes
   * which installs are considered the container's.
   */
  installedByBundle?: PluginId
  /**
   * `online-courses` only, and server-written only. Set on the write that
   * deactivates the install, it tells `onInstalledPluginStatusChange` whether to
   * delete this team's `courses/{id}/public_profile/{id}` mirrors — the only
   * thing that keeps a bought course openable. `true` on an ORGANIZATION lapse
   * (the studio's member paid for a course and a third party stopped paying),
   * absent/false everywhere else. Written by `downgradeTeamToFree`, which is the
   * only writer of an inactive install; see its comment for why it cannot go
   * stale. Use `KEEP_COURSE_MIRRORS_FIELD` rather than the literal.
   */
  keep_course_mirrors?: boolean
}

/**
 * The field name above, so the writer (`downgradeTeamToFree`) and the reader
 * (`onInstalledPluginStatusChange`) cannot drift apart silently — a typo on
 * either side would delete the mirrors a paying member's course lives behind,
 * with nothing to notice it.
 */
export const KEEP_COURSE_MIRRORS_FIELD = 'keep_course_mirrors' as const

/**
 * The field name above — same reason as `KEEP_COURSE_MIRRORS_FIELD` next door:
 * the writer (`bundleReconcile`) and the readers live in different packages, so
 * a literal on either side is a typo waiting to orphan a member install.
 */
export const INSTALLED_BY_BUNDLE_FIELD = 'installedByBundle' as const
