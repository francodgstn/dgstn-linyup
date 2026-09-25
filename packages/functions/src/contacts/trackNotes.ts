// `trackContactNotes` — the ONE writer of `Contact.notes_count`.
//
// WHY A COUNTER AT ALL. Notes live in `contacts/{id}/contact_notes`, and
// `matchesFilter` — the single contact-matching predicate the contacts list,
// saved presets, dynamic groups and the automation engine all run — is a PURE
// function of the contact DOCUMENT. It cannot read a subcollection, and giving
// it the ability to would mean a read per contact per filter evaluation. So the
// fact has to already be on the document, exactly as `alerts_count` is.
//
// ABSOLUTE, from a fresh query of the subcollection — never
// `FieldValue.increment`. Notes are written from more than one place (the staff
// Notes tab writes Firestore directly, the automation engine's `add_note` action
// writes through the Admin SDK, seeds write their own), and only a recount can
// never drift. Same rule as `trackContactAlerts` beside it, and the same reason.
//
// IT COUNTS EVERY NOTE. Unlike an alert, a note has no archived state — there is
// nothing to exclude, and "has notes" means the studio has written something
// down about this person.

import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import { CONTACTS_COLLECTION, CONTACT_NOTES_SUBCOLLECTION } from '@linyup/shared'
import { to } from '../utils/async'

export const trackContactNotes = onDocumentWritten(
  `${CONTACTS_COLLECTION}/{contactId}/${CONTACT_NOTES_SUBCOLLECTION}/{noteId}`,
  async (event) => {
    const beforeExists = event.data?.before.exists ?? false
    const afterExists = event.data?.after.exists ?? false
    // An EDIT changes nothing about the count. Returning early here is not an
    // optimization: without it every keystroke-saved note edit would re-read the
    // whole subcollection.
    if (beforeExists && afterExists) return
    if (!beforeExists && !afterExists) return

    const { contactId } = event.params
    const db = admin.firestore()
    const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)

    const [snapErr, notesSnap] = await to(
      contactRef.collection(CONTACT_NOTES_SUBCOLLECTION).count().get(),
    )
    if (snapErr || !notesSnap) return
    const total = notesSnap.data().count

    const [contactErr, contactSnap] = await to(contactRef.get())
    if (contactErr || !contactSnap?.exists) return
    const current = (contactSnap.data()!.notes_count as number | undefined) ?? 0
    if (current === total) return

    const [updateErr] = await to(contactRef.update({ notes_count: total }))
    if (updateErr) {
      console.error(`[contacts] trackContactNotes: update failed for ${contactId}:`, updateErr) // eslint-disable-line no-console
    }
  },
)
