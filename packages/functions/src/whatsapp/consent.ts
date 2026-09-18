// The callables that record a member's WhatsApp answer (`Contact.whatsapp_consent`,
// written only through `whatsappConsentPatch`). The rules deny the field to every
// client, so a staff screen cannot label its own tick as the member's.
//
// Doors, per docs/whatsapp-outbound.md → "Opt-in surfaces": the public booking
// and signup forms (through their contact-write rails), the member's Space and
// the member app (`setMyWhatsAppConsent`), and staff on the contact page
// (`setContactWhatsAppConsent`). A STOP reply goes through the webhook.
import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  WHATSAPP_PLUGIN_ID,
  coachOwnsContact,
  isLiveContact,
  type Contact,
  type WhatsAppConsentKind,
  type WhatsAppConsentSource,
} from '@linyup/shared'
import { requireContactSessionForTeam } from '../utils/contactSession'
import { callerIsAllScoped, isTeamMember, requireCapability } from '../utils/teams'
import { pluginIsActive } from '../utils/plugins'
import { whatsappConsentPatch } from './consentPatch'

const MEMBER_SOURCES: readonly WhatsAppConsentSource[] = ['space', 'member_app']

/** Which answer a request is about; absent means reminders, which is every
 *  client written before news-and-offers existed. */
function consentKindOf(value: unknown): WhatsAppConsentKind {
  if (value === undefined || value === 'reminders') return 'reminders'
  if (value === 'marketing') return 'marketing'
  throw new HttpsError('invalid-argument', 'kind must be reminders or marketing.')
}

/** A signed-in member sets their own answer, from the Space or the member app. */
export const setMyWhatsAppConsent = onCall(async (request) => {
  const { teamId, optIn, source, kind } = (request.data ?? {}) as {
    teamId?: string
    optIn?: unknown
    source?: WhatsAppConsentSource
    kind?: unknown
  }
  if (!teamId || typeof optIn !== 'boolean') {
    throw new HttpsError('invalid-argument', 'teamId and optIn are required.')
  }
  const resolvedSource = source && MEMBER_SOURCES.includes(source) ? source : 'space'
  const session = await requireContactSessionForTeam(request, teamId)
  // An opt-OUT is always accepted; an opt-in only while the studio offers the
  // channel, so a stale screen cannot record consent to something not offered.
  if (optIn && !(await pluginIsActive(teamId, WHATSAPP_PLUGIN_ID))) {
    throw new HttpsError('failed-precondition', 'WhatsApp is not offered by this studio.')
  }
  await admin
    .firestore()
    .collection(CONTACTS_COLLECTION)
    .doc(session.contactId)
    .update(whatsappConsentPatch(consentKindOf(kind), optIn, resolvedSource))
  return { ok: true }
})

/** Staff record a member's answer given in person. */
export const setContactWhatsAppConsent = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId, contactId, optIn, kind } = (request.data ?? {}) as {
    teamId?: string
    contactId?: string
    optIn?: unknown
    kind?: unknown
  }
  if (!teamId || !contactId || typeof optIn !== 'boolean') {
    throw new HttpsError('invalid-argument', 'teamId, contactId and optIn are required.')
  }
  if (!(await isTeamMember(uid, teamId))) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }
  await requireCapability(uid, teamId, 'contacts.manage')
  if (optIn && !(await pluginIsActive(teamId, WHATSAPP_PLUGIN_ID))) {
    throw new HttpsError('failed-precondition', 'The WhatsApp plugin is not installed.')
  }

  const ref = admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId)
  const snap = await ref.get()
  const contact = snap.exists ? ({ ...snap.data(), id: snap.id } as Contact) : null
  if (!contact || contact.teamId !== teamId) throw new HttpsError('not-found', 'Contact not found.')
  if (!isLiveContact(contact)) throw new HttpsError('failed-precondition', 'This contact is archived.')
  if (!(await callerIsAllScoped(uid, teamId)) && !coachOwnsContact(contact, uid)) {
    throw new HttpsError('permission-denied', 'This contact is not in your book.')
  }
  await ref.update(whatsappConsentPatch(consentKindOf(kind), optIn, 'staff', uid))
  return { ok: true }
})
