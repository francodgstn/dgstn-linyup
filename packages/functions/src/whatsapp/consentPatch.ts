// The ONE writer of `Contact.whatsapp_consent`: every door that records a
// member's answer builds its patch here. Kept apart from the callables so the
// booking and signup rails can use it without loading them.
import { FieldValue } from 'firebase-admin/firestore'
import type { WhatsAppConsentSource } from '@linyup/shared'

/** The field, written whole — never key by key, so an opt-out can never keep an
 *  earlier opt-in's `recorded_by`. */
export function whatsappConsentPatch(
  optIn: boolean,
  source: WhatsAppConsentSource,
  recordedBy?: string,
): { whatsapp_consent: Record<string, unknown> } {
  return {
    whatsapp_consent: {
      status: optIn ? 'opted_in' : 'opted_out',
      at: FieldValue.serverTimestamp(),
      source,
      ...(recordedBy ? { recorded_by: recordedBy } : {}),
    },
  }
}
