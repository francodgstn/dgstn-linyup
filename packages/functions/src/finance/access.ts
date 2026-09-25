// Finance plugin gate — shared by the export callable and the accounting
// callables/trigger. Journal WRITING is never gated (core infrastructure);
// this gate protects the surfaces the plugin sells: export + accounting.
//
// Gating is by INSTALL STATE, not a PlanFeature flag (repo convention, see
// plan.ts): studio/organization owners install the plugin free, coach pays the
// add-on via activatePluginAddon, free sees an upgrade prompt and can't install.

import { HttpsError } from 'firebase-functions/v2/https'
import { pluginIsActive } from '../utils/plugins'

export const FINANCE_PLUGIN_ID = 'finance'

/**
 * True when the finance plugin is installed and active for the team.
 *
 * Delegates to the ONE resolver rather than reading the install document here:
 * this used to be its own copy, and so it could not see an ORG-level install —
 * a studio inside an organization that bought finance for it was refused. The
 * named wrapper stays because its refusal copy below is specific.
 */
export async function isFinancePluginActive(teamId: string): Promise<boolean> {
  return pluginIsActive(teamId, FINANCE_PLUGIN_ID)
}

/** Callable gate — kiosk pattern (failed-precondition, not permission-denied,
 * so the client can distinguish "install the plugin" from "not allowed"). */
export async function assertFinancePluginActive(teamId: string): Promise<void> {
  if (!(await isFinancePluginActive(teamId))) {
    throw new HttpsError('failed-precondition', 'The Finance plugin is not enabled for this team.')
  }
}
