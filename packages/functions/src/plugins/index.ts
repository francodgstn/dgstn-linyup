// Plugin action handler registry.
// Each plugin registers its action handlers here by their namespaced action ID.
// The automation engine dispatches plugin actions through this map.

import type { ContactData } from '../utils/automationEngine'
import type { PluginActionId } from '@linyup/shared'

// ─── Handler interface ────────────────────────────────────────────────────────

export interface PluginActionContext {
  action: { type: PluginActionId; config?: Record<string, unknown> }
  contact: ContactData
  contactId: string
  teamId: string
  teamData: Record<string, unknown>
  ruleId: string
}

export type PluginActionHandler = (ctx: PluginActionContext) => Promise<void>

// ─── Registry ─────────────────────────────────────────────────────────────────

// EMPTY on purpose since 2026-09-17: the WhatsApp stub action was removed with
// the plugin's Phase 1 (docs/whatsapp-outbound.md) — a WhatsApp message is a
// pre-approved template, so the real action lands with the template picker in
// Phase 2 and registers here then. No manifest emits a plugin action today.
export const pluginActionHandlers: Record<string, PluginActionHandler> = {}
