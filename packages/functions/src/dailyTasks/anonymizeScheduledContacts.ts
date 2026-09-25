// Anonymizes contacts whose self-service deletion window has passed.
//
// The acting half of `contacts/selfDeletion.ts`: that one only writes a date,
// this is what eventually honors it. It ANONYMIZES rather than deletes — the
// studio's finance rows and its immutable waiver ledger reference this contact
// and must survive somebody leaving. `utils/contactDeletion.ts` carries the full
// reasoning and, importantly, THE FIELD LIST: the failure mode of missing one is
// silent and looks finished, so the list is written down once, beside its
// argument, rather than spelled out here.
//
// Deliberately NOT a hard delete, unlike `purgeProvisionalContacts` next door.
// That one removes abandoned registrations holding nothing; this one is a person
// who trained, paid and signed things.
//
// PLUGIN-OWNED RECORDS ABOUT THE PERSON go in the same batch — the census of
// them is the "Records outside the contact document" note in
// `utils/contactDeletion.ts`, beside the field list, for the same reason the
// field list lives there: missing one is silent. Today that is the Tarif 595
// insurer row (`teams/{t}/tarif595_contacts/{contactId}` — AHV number, insurer,
// insured number), which is DELETED, while the issued receipts are kept: they
// are records of documents handed out (docs/tarif-595.md → "Decisions").
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  TARIF595_CONTACTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  anonymizedContactPatch,
} from '@linyup/shared'

const BATCH_SIZE = 100

export async function anonymizeScheduledContacts(): Promise<{ anonymized: number }> {
  const db = admin.firestore()
  const now = Timestamp.now()

  // Single-field query: only a contact with an outstanding request carries
  // `deletion_scheduled_for`, so the deadline alone selects them. The patch
  // clears the field, so a row is never selected twice.
  const snap = await db
    .collection(CONTACTS_COLLECTION)
    .where('deletion_scheduled_for', '<=', now)
    .get()

  let anonymized = 0
  const nowMs = now.toMillis()

  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = db.batch()
    for (const doc of snap.docs.slice(i, i + BATCH_SIZE)) {
      const data = doc.data()
      // Re-check at write time: the contact may have canceled between the query
      // and here, and honoring a request they withdrew is the one mistake this
      // sweep must never make.
      if (!data.deletion_scheduled_for) continue
      if (data.anonymized_at) continue
      batch.update(doc.ref, anonymizedContactPatch(nowMs))
      // The plugin-owned insurer row goes with the identity. A delete of a
      // document that never existed is a no-op inside a batch, so this costs
      // nothing for the many contacts who never had one.
      const teamId = typeof data.teamId === 'string' ? data.teamId : null
      if (teamId) {
        batch.delete(db.collection(TEAMS_COLLECTION).doc(teamId).collection(TARIF595_CONTACTS_SUBCOLLECTION).doc(doc.id))
      }
      anonymized++
    }
    await batch.commit()
  }

  if (anonymized > 0) {
    // eslint-disable-next-line no-console
    console.log(`anonymizeScheduledContacts: anonymized ${anonymized} contact(s) past their deletion date`)
  }
  return { anonymized }
}
