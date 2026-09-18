// The ONE writer of a contact's WhatsApp consent — both answers,
// `whatsapp_consent` (reminders) and `whatsapp_marketing_consent` (news and
// offers). Every door that records an answer builds its patch here. Kept apart
// from the callables so the booking and signup rails can use it without
// loading them.
import { FieldValue } from 'firebase-admin/firestore'
import {
  WHATSAPP_CONSENT_FIELD,
  type WhatsAppConsentKind,
  type WhatsAppConsentSource,
} from '@linyup/shared'

/** One answer, written whole — never key by key, so an opt-out can never keep
 *  an earlier opt-in's `recorded_by`. */
export function whatsappConsentPatch(
  kind: WhatsAppConsentKind,
  optIn: boolean,
  source: WhatsAppConsentSource,
  recordedBy?: string,
): Record<string, Record<string, unknown>> {
  return {
    [WHATSAPP_CONSENT_FIELD[kind]]: {
      status: optIn ? 'opted_in' : 'opted_out',
      at: FieldValue.serverTimestamp(),
      source,
      ...(recordedBy ? { recorded_by: recordedBy } : {}),
    },
  }
}

/** A STOP ends both answers at once. */
export function whatsappStopPatch(source: WhatsAppConsentSource): Record<string, Record<string, unknown>> {
  return {
    ...whatsappConsentPatch('reminders', false, source),
    ...whatsappConsentPatch('marketing', false, source),
  }
}
