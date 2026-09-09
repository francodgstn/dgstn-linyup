// Sync trigger: mirrors a contact's LIVENESS onto every affiliation it holds,
// so a collection-group query over affiliations can exclude the people who left.
//
// ── WHY A CONTACT TRIGGER WRITES INTO AN AFFILIATION ────────────────────────
//
// The organisation's status breakdown counts affiliation ROWS, scoped by
// `org_id` — the one shape `firestore.rules` can prove for an org admin. A
// collection group cannot reach the parent document, so `archived_at` is
// invisible to it, and an ex-member's licence stayed in the federation's queue
// for ever ("34 records" on a page whose headcount was 31, #249).
//
// #249 moved that count onto the CONTACT instead, where liveness is native.
// `orgAdminMayReadContact` then made the query unprovable — Firestore matches a
// query against a rule by VALUE, and the `org:status` key it filtered on has a
// tenant-configurable half no rule can name — so the count came back here, and
// the liveness had to come with it. See `docs/org-contact-visibility.md`.
//
// ── LIVENESS CHANGES ON THE CONTACT, NEVER ON THE AFFILIATION ───────────────
//
// Which is the whole reason this is a separate trigger rather than a line in
// `onAffiliationWrite`: archiving somebody writes the CONTACT and touches none
// of their affiliations, so nothing on the affiliation side would ever fire.
// `upsertAffiliation` stamps the field at create time for the opposite case — a
// row written before this trigger has any reason to run.
//
// ── IT WRITES ONLY ON A TRANSITION ──────────────────────────────────────────
//
// Contacts are written constantly (last_seen_at, counters, denormalised
// rollups). Firing a subcollection fan-out on every one of those would be a
// write amplification with no new information in it, so the guard is the
// TRANSITION, computed from before/after, not the current value.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { CONTACTS_COLLECTION, CONTACT_AFFILIATIONS_SUBCOLLECTION } from '@linyup/shared'

/**
 * Is this contact somebody the studio still looks after?
 *
 * THE SAME PAIR `liveContactConstraints()` puts on every contact query in
 * `apps/web/src/lib/liveContacts.ts` — deleted is "in the bin", archived is
 * "the person left, keep the record". Both halves matter and forgetting the
 * second is the failure that module exists to prevent; it fails silently and
 * UPWARDS, as a count that flatters whoever reads it.
 */
function contactIsLive(data: admin.firestore.DocumentData | undefined): boolean {
  return !!data && !data.deleted_at && !data.archived_at
}

export const syncAffiliationContactLive = onDocumentWritten(
  'contacts/{contactId}',
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() : undefined
    const after = event.data?.after.exists ? event.data.after.data() : undefined

    // A DELETED CONTACT IS NOT A TRANSITION WORTH CHASING. Hard deletion removes
    // the subcollection with it (or leaves orphans no query can reach through a
    // parent that no longer exists), and the rows are gone either way.
    if (!after) return

    const wasLive = contactIsLive(before)
    const isLive = contactIsLive(after)
    // The guard. `before` absent means a CREATE, and a contact cannot already
    // hold affiliations at that moment, so there is nothing to stamp.
    if (!before || wasLive === isLive) return

    const db = admin.firestore()
    const affiliations = await db
      .collection(CONTACTS_COLLECTION)
      .doc(event.params.contactId)
      .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
      .get()
    if (affiliations.empty) return

    // One batch. A person holds a handful of affiliations — a club membership, a
    // federation licence, a grading — never a number that needs chunking, and
    // Firestore's 500-write limit is orders of magnitude above it.
    const batch = db.batch()
    for (const affiliation of affiliations.docs) {
      batch.update(affiliation.ref, {
        contact_live: isLive,
        updated_at: FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()

    console.log(
      `[affiliations] contact ${event.params.contactId} ${isLive ? 'restored' : 'left'} — ` +
        `${affiliations.size} affiliation(s) marked contact_live=${isLive}`
    )
  }
)
