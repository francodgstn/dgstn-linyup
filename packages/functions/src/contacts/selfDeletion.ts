/**
 * "Delete my account", from the contact's own app.
 *
 * ── WHY IT DID NOT EXIST, AND WHY IT DOES NOW ────────────────────────────────
 *
 * `deleteContact` is STAFF-side: it requires `hasTeamRole(uid, teamId,
 * 'manager')`, which a contact session (`uid = contact:{contactId}`) can never
 * satisfy. So a member had no way to leave except asking their studio.
 *
 * Apple's guideline 5.1.1(v) requires in-app deletion where accounts can be
 * created, and reviewers apply it broadly; more to the point, an erasure request
 * is something a person is entitled to make without going through the business
 * that holds their data.
 *
 * ── NOTHING IS DESTROYED HERE ────────────────────────────────────────────────
 *
 * These two callables only move a date. The account keeps working for the whole
 * window and the contact can cancel by signing in; the sweep
 * (`dailyTasks/anonymizeScheduledContacts`) is what eventually acts, and it
 * ANONYMIZES rather than erases — see `utils/contactDeletion.ts` for why the
 * studio's finance and consent records have to survive somebody leaving.
 *
 * Authenticated by the CONTACT SESSION, which is the only thing that proves the
 * person asking is the person being deleted. `optionalContactSessionFromRequest`
 * is documented as the only trustworthy source of a contactId on a public
 * callable — a contactId in the request body is a claim, not a proof.
 */
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  CONTACT_DELETION_GRACE_DAYS,
  contactDeletionState,
} from '@linyup/shared'
import { optionalContactSessionFromRequest } from '../utils/contactSession'

/** The caller's own contact, or a refusal. Re-reads the document rather than
 *  trusting the 7-day token, exactly as `requireContactSessionForTeam` does: a
 *  session can outlive the contact it names. */
async function requireOwnContact(request: Parameters<typeof optionalContactSessionFromRequest>[0]) {
  const session = optionalContactSessionFromRequest(request)
  if (!session) throw new HttpsError('unauthenticated', 'Sign in required')
  const ref = admin.firestore().collection(CONTACTS_COLLECTION).doc(session.contactId)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Contact not found')
  const data = snap.data()!
  if (data.deleted_at || data.anonymized_at) {
    throw new HttpsError('failed-precondition', 'This account is already closed')
  }
  return { ref, data, contactId: session.contactId }
}

/**
 * Schedule this account for deletion.
 *
 * Idempotent: asking twice does not move the date closer. A person who taps it
 * again a week later is checking, not re-deciding, and silently resetting their
 * window to another 30 days would be the wrong answer to either reading.
 */
export const requestContactDeletion = onCall(async (request) => {
  const { ref, data, contactId } = await requireOwnContact(request)
  const nowMs = Date.now()

  const state = contactDeletionState(data, nowMs)
  if (state === 'scheduled' || state === 'due') {
    return {
      scheduled: true,
      scheduledForMs: (data.deletion_scheduled_for as Timestamp).toMillis(),
      graceDays: CONTACT_DELETION_GRACE_DAYS,
    }
  }

  const scheduledFor = Timestamp.fromMillis(
    nowMs + CONTACT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000
  )
  await ref.update({
    deletion_requested_at: FieldValue.serverTimestamp(),
    deletion_scheduled_for: scheduledFor,
  })
  // eslint-disable-next-line no-console
  console.log(`[contact-deletion] requested for ${contactId}, due ${scheduledFor.toDate().toISOString()}`)

  return {
    scheduled: true,
    scheduledForMs: scheduledFor.toMillis(),
    graceDays: CONTACT_DELETION_GRACE_DAYS,
  }
})

/**
 * Change your mind.
 *
 * Works right up to the moment the sweep runs — and deliberately also works in
 * the `due` state, the hours between the deadline passing and the nightly sweep
 * reaching it. Refusing there would be technically defensible and would read, to
 * the person, as the button breaking on the day it mattered most.
 */
export const cancelContactDeletion = onCall(async (request) => {
  const { ref, data, contactId } = await requireOwnContact(request)
  const state = contactDeletionState(data, Date.now())
  if (state === 'none') return { scheduled: false }

  await ref.update({ deletion_requested_at: null, deletion_scheduled_for: null })
  // eslint-disable-next-line no-console
  console.log(`[contact-deletion] canceled for ${contactId}`)
  return { scheduled: false }
})
