import type { PluginManifest } from '@linyup/shared'

/**
 * HMD — a TENANT-SPECIFIC plugin CONTAINER.
 *
 * HMD (Hwal Moo Do) is the organization Linyup's predecessor was built for, and
 * its first migrated customer. Everything HMD needs that no other tenant should
 * see lives inside this container: the Fighting Cup today, and later its belt
 * progression rules, its predefined automations and templates, its technical
 * programs and its org reporting.
 *
 * ── IT HOLDS PLUGINS, NOT "MODULES" ──────────────────────────────────────────
 * Its members are ordinary plugins with ordinary manifests and ordinary install
 * documents — the composition is declared in `PLUGIN_BUNDLES`
 * (`@linyup/shared`), and `reconcileBundle` materializes it. Nothing downstream
 * knows what a bundle is: a member's nav rows, event type, automation
 * contributions and server gate all resolve through the member's OWN id exactly
 * as they would if a tenant had installed it directly.
 *
 * That is why widening `hmd-fighting-cup` into this bundle needed no migration.
 * The member kept its id and its `hmd_fighting_cup` event-type value; this
 * container was added beside it. The rename `docs/ux-review-open-decisions.md`
 * deferred is settled by not renaming anything.
 *
 * ── THE AUDIENCE GATES DISCOVERY, NEVER RUNNING ──────────────────────────────
 * `audience` keeps one customer's name out of every other tenant's catalog —
 * see `PluginAudience` in @linyup/shared, which is emphatic that nothing
 * resolving an INSTALLED plugin may consult it. So yes: a studio owner on
 * studio/organization could hand-write a member install document and get the
 * event type. That is pre-existing and deliberate, not a hole to close — closing
 * it would turn a list edit into an outage for a live customer.
 *
 * Named at the ORG because that is where HMD's install lives
 * (`scripts/migration/passes/00-setup.ts`, ORG_ID = 'hmd'); every studio under
 * that org inherits the visibility, so a second HMD studio needs no edit here.
 */
export const hmdManifest: PluginManifest = {
  id: 'hmd',
  nameKey: 'hmdName',
  descriptionKey: 'hmdDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'available',
  iconName: 'Shield',
  // The module switches — one per member of PLUGIN_BUNDLES.hmd.
  hasOwnerConfig: true,
  audience: { orgIds: ['hmd'] },
  // NO `addon` and NO `locked`, and both are load-bearing rather than
  // oversights: those two install paths write a single document and never
  // reconcile, so a container reached through either would install none of its
  // members. `plugins/bundles.test.ts` asserts it.
  //
  // No `navContributions` and no `eventType`: a container contributes nothing
  // itself. Its members do.
}
