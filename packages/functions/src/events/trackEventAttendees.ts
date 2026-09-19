/**
 * Maintains `participants_count` and `completed_checkins_count` on an event —
 * the two counters that say who actually turned up, and how many of them still
 * owe the desk their paperwork.
 *
 * It is a Firestore trigger on the top-level `checkins` collection (one doc per
 * person admitted to an event). A create is +1 participant, a delete is -1, and
 * `is_completed` flipping either way moves the completed counter on its own.
 *
 * ── IT NEVER TOUCHES `attendees_count` ───────────────────────────────────────
 * `events/{id}/attendees` is a different thing wearing a similar word: the RSVP
 * list, written by `handleEventInvitationResponse` when an invitee accepts and
 * deleted when they decline. `attendees_count` counts ACCEPTANCES and is
 * maintained there, in events/index.ts. Nothing reconciles the two — accepting
 * an invitation and walking through the door are separate facts — so reading
 * this trigger as "the attendees counter" gets both of them wrong.
 *
 * ── WHY THE NAME SURVIVES THE CORRECTION ─────────────────────────────────────
 * The exported symbol IS the deployed Cloud Function name. Renaming it deletes
 * this Firestore trigger and creates another, and in the window between the two
 * every check-in write goes uncounted — the counters drift on a live event and
 * nothing announces it. The name arrived with the code from
 * hmd-lineup/functions/src/trackEventAttendees/index.js and the meaning drifted
 * underneath it; correcting the header is the honest fix that costs nothing.
 */
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { to } from '../utils/async'
import { logActivity } from '../utils/users'

export const trackEventAttendees = onDocumentWritten(
  'checkins/{checkinId}',
  async (event) => {
    const { checkinId } = event.params
    console.log(`trackEventAttendees onWrite event checkin: ${checkinId}`)

    const before = event.data?.before
    const after = event.data?.after

    const newDoc = after?.exists ? after.data() : null
    const oldDoc = before?.exists ? before.data() : null
    const checkinData = (newDoc ?? oldDoc) as Record<string, unknown>

    let completedIncrement = 0
    let participantsIncrement = 0
    let eventId: string | undefined

    if (!before?.exists && after?.exists) {
      // Created
      participantsIncrement = 1
      completedIncrement = after.get('is_completed') === true ? 1 : 0
      eventId = after.get('event.id') as string
    } else if (before?.exists && !after?.exists) {
      // Deleted
      participantsIncrement = -1
      completedIncrement = before.get('is_completed') === true ? -1 : 0
      eventId = before.get('event.id') as string
    } else if (before?.exists && after?.exists) {
      // Updated
      const wasCompleted = before.get('is_completed') === true
      const isCompleted = after.get('is_completed') === true
      if (!wasCompleted && isCompleted) completedIncrement = 1
      else if (wasCompleted && !isCompleted) completedIncrement = -1
      eventId = after.get('event.id') as string
    }

    if (participantsIncrement === 0 && completedIncrement === 0) return null

    if (!eventId) {
      console.warn(`trackEventAttendees: no eventId found for checkin ${checkinId}`)
      return null
    }

    const eventRef = admin.firestore().collection('events').doc(eventId)
    const eventDoc = await eventRef.get()

    const updateData: Record<string, unknown> = {}
    if (participantsIncrement !== 0) {
      updateData.participants_count = FieldValue.increment(participantsIncrement)
    }
    if (completedIncrement !== 0) {
      updateData.completed_checkins_count = FieldValue.increment(completedIncrement)
    }

    const [counterUpdateErr] = await to(eventRef.update(updateData))
    if (counterUpdateErr) {
      console.error(
        `Error updating check-in counters for event ${eventId}:`,
        counterUpdateErr.message ?? counterUpdateErr
      )
      throw counterUpdateErr
    }

    // Activity log
    if (eventDoc.exists && checkinData) {
      await trackInActivityLog(eventDoc, { ...checkinData, id: checkinId }, participantsIncrement)
    }

    return null
  }
)

async function trackInActivityLog(
  eventDoc: admin.firestore.DocumentSnapshot,
  checkinData: Record<string, unknown>,
  increment: number
): Promise<void> {
  const eventData = eventDoc.data() as Record<string, unknown>

  // teacher || teamId — legacy compat
  const teamId = (checkinData.teamId ?? checkinData.teacher) as string | undefined
  if (!teamId) return

  const contact = checkinData.contact as Record<string, unknown> | undefined
  const contactFullname =
    `${(contact?.firstname as string) || ''} ${(contact?.lastname as string) || ''}`.trim() ||
    'Unknown contact'

  const activityLogItem = {
    date: FieldValue.serverTimestamp(),
    event: increment > 0 ? 'event_checkin_add' : 'event_checkin_delete',
    parameters: {
      description:
        increment > 0
          ? `${contactFullname} checked in to the event ${eventData.title}.`
          : `${contactFullname} removed from the event ${eventData.title}.`,
      contact_firstname: contact?.firstname,
      contact_lastname: contact?.lastname,
      event_date: eventData.start,
      event_title: eventData.title,
    },
    refs: {
      contact: contact?.id,
      event: eventDoc.id,
      checkin: checkinData.id,
      user: teamId,
    },
  }

  await logActivity(teamId, activityLogItem as Record<string, unknown>)
}
