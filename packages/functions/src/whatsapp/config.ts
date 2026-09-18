// WhatsApp Business — environment configuration. docs/whatsapp-outbound.md.
//
// Every param here must also appear in each committed `.env.<alias>` (and
// `.env.local.example`), or the non-interactive deploy stops to prompt for it.
import { defineString } from 'firebase-functions/params'

// Kill switch. DEFAULTS OFF, like SMS: an environment opts in once its Meta app
// is set up.
export const WHATSAPP_ENABLED = defineString('WHATSAPP_ENABLED', {
  description: 'Set to "true" to send WhatsApp messages in this environment',
  default: 'false',
})

export const META_APP_ID = defineString('META_APP_ID', {
  description: 'Meta app id (WhatsApp Tech Provider app); empty = connecting is unavailable',
  default: '',
})

export const WHATSAPP_SIGNUP_CONFIG_ID = defineString('WHATSAPP_SIGNUP_CONFIG_ID', {
  description: 'Embedded Signup configuration id (WhatsApp Business App onboarding enabled)',
  default: '',
})

// Pinned, and bumped deliberately: Graph versions retire on a schedule.
export const META_GRAPH_VERSION = defineString('META_GRAPH_VERSION', {
  description: 'Graph API version for WhatsApp calls, e.g. "v25.0"',
  default: 'v25.0',
})

// Secret Manager names (emulator: META_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN,
// WHATSAPP_TOKEN_KEY in functions/.env.local).
export const META_APP_SECRET = 'meta-app-secret'
export const WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'whatsapp-webhook-verify-token'
export const WHATSAPP_TOKEN_KEY = 'whatsapp-token-key'

export function whatsappEnabled(): boolean {
  return WHATSAPP_ENABLED.value() === 'true'
}
