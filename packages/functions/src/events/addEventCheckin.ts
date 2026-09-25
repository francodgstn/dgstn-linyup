import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { isCheckinCompleted } from '@linyup/shared'
import {
  decideCheckinAuthorization,
  checkinDataIsAcceptable,
  type CheckinAuthSnapshot,
} from './checkinAuthorization'

// Region comes from the single setGlobalOptions call in index.ts — see the note
// there. A second call warns "Calling setGlobalOptions twice leads to undefined
// behavior".

const CHECKINS_COLLECTION = 'checkins'
const EVENTS_COLLECTION = 'events'
const CONTACTS_COLLECTION = 'contacts'
const ORG_TEAMS_SUBCOLLECTION = 'org_teams'

/**
 * THE ONLY WRITER of a `checkins` document — `allow create: if false` in the
 * rules, deliberately.
 *
 * This function READS; `checkinAuthorization.ts` DECIDES. Every rule about who
 * may write what, and under whose tenant stamp, lives there with its reasoning
 * and its fixtures. Do not add a permission check here — extend the decision.
 */

interface AddEventCheckinInput {
  eventId: string
  contactId: string
  checkinData?: Record<string, unknown>
  /**
   * For org-scoped events: the studio the contact belongs to. It is a REQUEST,
   * validated against the organization's member studios before it is honored.
   * Ignored entirely for team-scoped events, which carry their own teamId.
   */
  checkinTeamId?: string
}

export const addEventCheckin = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.')

  const { eventId, contactId, checkinData = {}, checkinTeamId } =
    request.data as AddEventCheckinInput

  if (!eventId || !contactId) {
    throw new HttpsError('invalid-argument', 'eventId and contactId are required.')
  }

  const payload = checkinDataIsAcceptable(checkinData)
  if (!payload.ok) throw new HttpsError('invalid-argument', payload.message)

  const db = admin.firestore()
  const uid = request.auth.uid

  const eventDoc = await db.collection(EVENTS_COLLECTION).doc(eventId).get()
  if (!eventDoc.exists) throw new HttpsError('not-found', 'Event not found.')
  const event = eventDoc.data()!

  const isOrgEvent = event.scope === 'org' && !!event.orgId
  const orgId = event.orgId as string | undefined

  // The team the row would be stamped with, as PROPOSED. Nothing is trusted
  // yet — the decision below is what makes it authoritative.
  const proposedTeamId = isOrgEvent
    ? (typeof checkinTeamId === 'string' ? checkinTeamId.trim() : '')
    : ((event.teamId as string | null) ?? '')

  // ── read the facts the decision needs ──────────────────────────────────
  // Membership, authority and the contact are fetched together; the decision
  // is a pure function of them. A read whose key is empty is skipped rather
  // than issued — `.doc('')` throws.
  const [orgMemberSnap, orgTeamSnap, teamMemberSnap, contactSnap] = await Promise.all([
    isOrgEvent && orgId
      ? db.collection('organizations').doc(orgId).collection('org_members').doc(uid).get()
      : Promise.resolve(null),
    isOrgEvent && orgId && proposedTeamId
      ? db
          .collection('organizations')
          .doc(orgId)
          .collection(ORG_TEAMS_SUBCOLLECTION)
          .doc(proposedTeamId)
          .get()
      : Promise.resolve(null),
    proposedTeamId
      ? db.collection('teams').doc(proposedTeamId).collection('team_members').doc(uid).get()
      : Promise.resolve(null),
    db.collection(CONTACTS_COLLECTION).doc(contactId).get(),
  ])

  // A check-in for this (event, contact) may already exist. It is read BEFORE
  // the decision because moving an existing row between tenants is one of the
  // things the decision refuses.
  const existingSnap = await db
    .collection(CHECKINS_COLLECTION)
    .where('event.id', '==', eventId)
    .where('contact.id', '==', contactId)
    .limit(1)
    .get()
  const existing = existingSnap.empty ? null : existingSnap.docs[0]

  const snapshot: CheckinAuthSnapshot = {
    event: {
      exists: true,
      scope: event.scope as string | undefined,
      orgId: (event.orgId as string | null) ?? null,
      teamId: (event.teamId as string | null) ?? null,
      teacher: (event.teacher as string | null) ?? null,
      deletedAt: event.deleted_at ?? null,
    },
    requestedTeamId: checkinTeamId ?? null,
    orgRole: (orgMemberSnap?.exists ? orgMemberSnap.data()?.role : null) ?? null,
    orgTeamLink: orgTeamSnap
      ? { exists: orgTeamSnap.exists, status: orgTeamSnap.data()?.status ?? null }
      : null,
    teamRole: (teamMemberSnap?.exists ? teamMemberSnap.data()?.role : null) ?? null,
    contact: {
      exists: contactSnap.exists,
      teamId: (contactSnap.data()?.teamId as string | null) ?? null,
    },
    existingCheckinTeamId: (existing?.data()?.teamId as string | null) ?? null,
  }

  const decision = decideCheckinAuthorization(snapshot)
  if (!decision.ok) throw new HttpsError(decision.code, decision.message)

  const resolvedTeamId = decision.teamId
  const is_completed = isCheckinCompleted(event.type as string, checkinData)

  // The stored contact, NOT the client's. The old signature took
  // `contact: { firstname, lastname }` off the payload and spread it onto the
  // row, so the display name on a check-in was whatever the caller typed —
  // and the spread could overwrite the id the server had just set.
  const contactData = contactSnap.data() ?? {}
  const contactStamp = {
    id: contactId,
    firstname: (contactData.firstname as string) ?? '',
    lastname: (contactData.lastname as string) ?? '',
  }

  if (existing) {
    await existing.ref.update({
      checkin_data: checkinData,
      is_completed,
      // Re-stamped so a row can never drift from the contact it names, and so
      // the tenant stamp is reasserted by the same decision that approved it.
      contact: contactStamp,
      teamId: resolvedTeamId,
      updated_by: uid,
      updated_at: FieldValue.serverTimestamp(),
    })
    return { id: existing.ref.id, is_completed, created: false }
  }

  const docRef = await db.collection(CHECKINS_COLLECTION).add({
    event: { id: eventId, title: event.title ?? '', type: event.type ?? '' },
    contact: contactStamp,
    teamId: resolvedTeamId,
    is_completed,
    checkin_data: checkinData,
    checked_in_by: uid,
    created_at: FieldValue.serverTimestamp(),
  })

  return { id: docRef.id, is_completed, created: true }
})
