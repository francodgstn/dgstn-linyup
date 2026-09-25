// Install-document reconciliation triggers — one per install path.
//
// THREE passes ride each trigger: `reconcileBundle` (a container's members),
// `reconcileRequirements` (a plugin's dependencies) and `applyPluginSeeds` (the
// content a plugin installs with). They are separate
// relations with separate maps and separate provenance rules — see
// `plugin-requirements.ts` for why a requirement is deliberately not a bundle
// member — but they share these triggers rather than declaring a second pair on
// the same document path, which would double every install's invocations to
// register a second listener on the same event. Both are pure functions of
// current state with empty-diff early returns, so running them in sequence is
// safe in either order and a retry still converges.
//
// `retry: true` is safe and wanted here: `reconcileBundle` is a pure function of
// current state with an empty-diff early return, so a retry can only converge.
// Deliberately NOT folded into `onInstalledPluginStatusChange`, which carries a
// non-idempotent activation hook and must stay `retry: false`.
//
// THE ORG TRIGGER IS NEW. Organizations had no `installed_plugins` trigger at
// all — `orgs/lifecycle.ts` hand-calls its teardown to work around the absence.
// It owns install-document reconciliation ONLY. Org website teardown stays
// where it is: that path is documented as resumable-not-atomic, and moving a
// step of it into an eventually-consistent trigger would let a half-run lapse
// leave a public site up.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { reconcileBundle } from './bundleReconcile'
import { reconcileRequirements } from './requirementsReconcile'
import { applyPluginSeeds } from './seeds'

export const onTeamBundleInstallChange = onDocumentWritten(
  { document: 'teams/{teamId}/installed_plugins/{pluginId}', retry: true },
  async (event) => {
    await reconcileBundle({ kind: 'team', teamId: event.params.teamId }, event.params.pluginId)
    await reconcileRequirements({ kind: 'team', teamId: event.params.teamId }, event.params.pluginId)
    // AFTER the reconcilers: a member materialized by `reconcileBundle` above
    // gets its own trigger invocation, which is where ITS seeds are applied.
    // This call is for the plugin whose document actually changed.
    await applyPluginSeeds({ kind: 'team', teamId: event.params.teamId }, event.params.pluginId)
  },
)

export const onOrgBundleInstallChange = onDocumentWritten(
  { document: 'organizations/{orgId}/installed_plugins/{pluginId}', retry: true },
  async (event) => {
    await reconcileBundle({ kind: 'org', orgId: event.params.orgId }, event.params.pluginId)
    await reconcileRequirements({ kind: 'org', orgId: event.params.orgId }, event.params.pluginId)
    await applyPluginSeeds({ kind: 'org', orgId: event.params.orgId }, event.params.pluginId)
  },
)
