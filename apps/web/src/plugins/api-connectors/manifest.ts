import type { PluginManifest } from '@linyup/shared'

// API & AI connectors — the public REST API and the remote MCP server
// (docs/public-api.md). Landing sells "API access" on Studio and Organization;
// the plan requirement lives HERE, in `minPlan`, and nowhere else.
//
// THE GATE IS ON CREATION ONLY (api/keys.ts `createApiKey`, and in Phase 2 the
// OAuth approval). Removing the plugin does not merely close that door: the
// teardown arm in sync/onInstalledPluginStatusChange.ts revokes every key the
// team issued, which is why the removal dialog has its own copy.
export const apiConnectorsManifest: PluginManifest = {
  // A literal, not API_CONNECTORS_PLUGIN_ID: teams/teamDefaults.test.ts reads
  // manifest ids from the source. The two must stay equal.
  id: 'api-connectors',
  nameKey: 'apiConnectorsName',
  descriptionKey: 'apiConnectorsDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'beta',
  iconName: 'KeyRound',
}
