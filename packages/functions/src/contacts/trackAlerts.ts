// `trackContactAlerts` — the ONE writer of `Contact.alerts_count`.
//
// `alerts_count` is the highest-weighted attention reason in
// `contactAttentionReasons` (weight 5, above a trial pending or a canceling
// member) — and until this trigger, NOTHING in the repo wrote it. Both
// existing alert writers (the booking-notification alert in
// `booking/index.ts` and the automation engine's `create_alert` action)
// create rows in `contact_alerts` but never touched the counter, so the
// reason it drives has never fired.
//
// ABSOLUTE, from a fresh query of the subcollection — never
// `FieldValue.increment` (see the waitlist "ONE SEAT WRITER" precedent in
// CLAUDE.md): an alert can be created from either of the two sites above and
// archived from studio UI, so only a recount can never drift. Counts
// non-archived alerts only (`archived_at` unset/null) — an archived alert is a
// dismissed one and must not keep the badge lit.

import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import { CONTACTS_COLLECTION, CONTACT_ALERTS_SUBCOLLECTION, type ContactAlert } from '@linyup/shared'
import { to } from '../utils/async'

export const trackContactAlerts = onDocumentWritten(
  `${CONTACTS_COLLECTION}/{contactId}/${CONTACT_ALERTS_SUBCOLLECTION}/{alertId}`,
  async (event) => {
    const beforeExists = event.data?.before.exists ?? false
    const afterExists = event.data?.after.exists ?? false
    if (!beforeExists && !afterExists) return

    const { contactId } = event.params
    const db = admin.firestore()
    const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)

    const [snapErr, alertsSnap] = await to(contactRef.collection(CONTACT_ALERTS_SUBCOLLECTION).get())
    if (snapErr || !alertsSnap) return

    const active = alertsSnap.docs.reduce((n, doc) => {
      const alert = doc.data() as ContactAlert
      return alert.archived_at ? n : n + 1
    }, 0)

    const [contactErr, contactSnap] = await to(contactRef.get())
    if (contactErr || !contactSnap?.exists) return
    const current = (contactSnap.data()!.alerts_count as number | undefined) ?? 0
    if (current === active) return

    const [updateErr] = await to(contactRef.update({ alerts_count: active }))
    if (updateErr) {
      console.error(`[contacts] trackContactAlerts: update failed for ${contactId}:`, updateErr) // eslint-disable-line no-console
    }
  },
)
