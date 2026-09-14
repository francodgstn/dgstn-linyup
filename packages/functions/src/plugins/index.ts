// Plugin action handler registry.
// Each plugin registers its action handlers here by their namespaced action ID.
// The automation engine dispatches plugin actions through this map.

import type { ContactData } from '../utils/automationEngine'
import type { PluginActionId } from '@linyup/shared'

import { whatsappSendMessage } from './whatsapp'

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

export const pluginActionHandlers: Record<string, PluginActionHandler> = {
  'plugin:whatsapp:send_message':        whatsappSendMessage,
}
