// Daily task: close out organization member invitations whose deadline has
// passed (organizations/*/org_member_invitations, status 'pending').
//
// ─── WHY THIS SWEEP EARNS ITS PLACE, WHEN THE WAIVER WORK ADDED NONE ─────────
//
// The waivers phase deliberately has no job, cron or sweep anywhere, because
// nothing there is reserved, held or released: supersession and expiry are
// DERIVED at the moment the gate asks, so a stored flag would only be a second
// answer to a question already answered correctly.
//
// This sweep does not answer that question either — and that is precisely the
// point. AUTHORIZATION NEVER DEPENDS ON IT: `getOrgMemberInvitation` and
// `acceptOrgMemberInvitation` both compare `expires_at` to `now` themselves, so
// if this never ran again, not one expired invitation would become acceptable.
// It cannot grant anything and it cannot fail open.
//
// What it does is make the STORED STATUS true, which buys three small things
// that a derivation cannot:
//
//   • The org admin's pending list stops showing a row that can no longer be
//     accepted. That list is a plain Firestore read by a client that must not
//     re-implement the deadline (and, being a client clock, could not be
//     trusted with it anyway).
//   • `status` becomes a genuinely terminal state, so 'expired' is
//     distinguishable from 'revoked' and from 'declined' — three different
//     things an admin acts on differently.
//   • A spent token stops sitting in a document. The status flip deletes it,
//     the same way accepting, declining and revoking do.
//
// ─── IDEMPOTENCE ─────────────────────────────────────────────────────────────
//
// The query selects `status == 'pending'`; the write sets `status = 'expired'`.
// A swept row therefore no longer matches, so it cannot be swept twice, and
// there is nothing to re-notify because NOTHING IS NOTIFIED — an invitation
// that quietly lapses sends no mail to anyone. (An expiry notice would be the
// one part of this that could double-fire, which is a good enough reason not to
// have one: an admin who cares re-invites, and re-inviting rewrites the same
// row.) A partial run is simply a shorter run; the next day finishes it.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { ORG_MEMBER_INVITATIONS_SUBCOLLECTION } from '@linyup/shared'

/** One day's worth is far more than a real tenant will ever produce; the cap is
 *  here so a pathological dataset cannot turn the daily batch into a timeout. */
const SCAN_LIMIT = 500

export async function expireOrgMemberInvitations(): Promise<{ expired: number }> {
  const db = admin.firestore()
  const now = Timestamp.now()

  // Collection-GROUP query: invitations live under each organization, and the
  // sweep is platform-wide. Needs the (status, expires_at) COLLECTION_GROUP
  // index in firestore.index.json — the emulator answers without it, a real
  // project does not.
  const snap = await db
    .collectionGroup(ORG_MEMBER_INVITATIONS_SUBCOLLECTION)
    .where('status', '==', 'pending')
    .where('expires_at', '<=', now)
    .limit(SCAN_LIMIT)
    .get()

  if (snap.empty) return { expired: 0 }

  const batch = db.batch()
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      status: 'expired',
      expired_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      token: FieldValue.delete(),
    })
  }
  await batch.commit()

  return { expired: snap.size }
}
