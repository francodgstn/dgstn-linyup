// A studio's WhatsApp connection: the display doc every surface reads
// (`teams/{t}/integrations/whatsapp`), the sealed token (`whatsapp_connections`)
// and the number → team claim (`whatsapp_numbers`). Only functions write them.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  WHATSAPP_CONNECTIONS_COLLECTION,
  WHATSAPP_INTEGRATION_DOC,
  WHATSAPP_NUMBERS_COLLECTION,
  type WhatsAppIntegration,
} from '@linyup/shared'
import { getSecret } from '../utils/secrets'
import { WHATSAPP_TOKEN_KEY } from './config'
import { decryptToken, encryptToken } from './tokenCrypto'

export interface WhatsAppCredentials {
  token: string
  wabaId: string
  phoneNumberId: string
}

export function whatsappIntegrationRef(teamId: string): FirebaseFirestore.DocumentReference {
  return admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TEAM_INTEGRATIONS_SUBCOLLECTION)
    .doc(WHATSAPP_INTEGRATION_DOC)
}

export function whatsappConnectionRef(teamId: string): FirebaseFirestore.DocumentReference {
  return admin.firestore().collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(teamId)
}

export function whatsappNumberRef(phoneNumberId: string): FirebaseFirestore.DocumentReference {
  return admin.firestore().collection(WHATSAPP_NUMBERS_COLLECTION).doc(phoneNumberId)
}

export async function sealWhatsAppToken(token: string): Promise<string> {
  return encryptToken(token, await getSecret(WHATSAPP_TOKEN_KEY))
}

export async function loadWhatsAppCredentials(teamId: string): Promise<WhatsAppCredentials | null> {
  const snap = await whatsappConnectionRef(teamId).get()
  const data = snap.data()
  if (!snap.exists || typeof data?.sealed_token !== 'string') return null
  return {
    token: decryptToken(data.sealed_token, await getSecret(WHATSAPP_TOKEN_KEY)),
    wabaId: data.waba_id as string,
    phoneNumberId: data.phone_number_id as string,
  }
}

// The reminder run asks once per booking; a minute of staleness is harmless
// (a disconnect also deletes the token, which the send reads uncached).
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; value: WhatsAppIntegration | null }>()

export async function readWhatsAppIntegration(teamId: string): Promise<WhatsAppIntegration | null> {
  const hit = cache.get(teamId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const snap = await whatsappIntegrationRef(teamId).get()
  const value = snap.exists ? (snap.data() as WhatsAppIntegration) : null
  cache.set(teamId, { at: Date.now(), value })
  return value
}

export function __clearWhatsAppIntegrationCache(): void {
  cache.clear()
}

/**
 * Patches the display doc and drops the cached copy. Each named field is
 * REPLACED, not deep-merged (`mergeFields`): a `templates` map merged key by key
 * would keep a disconnected account's approvals behind an empty one.
 */
export async function patchWhatsAppIntegration(
  teamId: string,
  patch: Partial<Record<keyof WhatsAppIntegration, unknown>>,
): Promise<void> {
  const data = { ...patch, updated_at: FieldValue.serverTimestamp() }
  await whatsappIntegrationRef(teamId).set(data, { mergeFields: Object.keys(data) })
  cache.delete(teamId)
}

/** Which team holds this phone number id — the webhook's router. */
export async function teamForPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const snap = await whatsappNumberRef(phoneNumberId).get()
  return (snap.data()?.teamId as string | undefined) ?? null
}
