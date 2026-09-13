// listMyTarif595Receipts — the member's own copy, for the Space.
//
// WHO is the contact session and only the contact session
// (`requireContactSessionForTeam`): a contactId in the body would turn this
// into a receipt enumerator for every member of the team. Same guard, same
// reasoning, as getMyBookings / getMyAttendance; pinned by mine.test.ts.
//
// WHAT comes back is a projection, not the row: no `created_by` (a manager's
// uid), no storage paths or hashes, no biller/provider identifiers — the
// member gets the number, the period, the total, the state and the date, and
// downloads the bytes through `downloadTarif595Receipt`'s contact door. A
// `pending` row (mid-issue, or a crashed issue waiting for its resume) is not
// listed: it has no files, and a number the member can see but not open is a
// support ticket.
//
// `enabled` is what the Space gates its insurance section and its Receipts
// tab on — the Space cannot read `installed_plugins` itself, and a member of a
// studio that never installed the plugin should not be asked for an AHV
// number. Reading one's own receipts is CONSUMPTION and is not install-gated
// (a studio that unticks the plugin does not take the member's receipts with
// it); the flag is a plain read of the install state, not the gate.

import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  TARIF595_PLUGIN_ID,
  TARIF595_RECEIPTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type Tarif595MyReceipt,
  type Tarif595MyReceiptsRequest,
  type Tarif595MyReceiptsResult,
  type Tarif595ReceiptDoc,
} from '@linyup/shared'
import { requireContactSessionForTeam } from '../utils/contactSession'
import { pluginIsActive } from '../utils/plugins'

/** A person accumulates a few receipts a year; a hundred is decades. */
export const MY_RECEIPTS_LIMIT = 100

export const listMyTarif595Receipts = onCall(async (request): Promise<Tarif595MyReceiptsResult> => {
  const data = (request.data ?? {}) as Partial<Tarif595MyReceiptsRequest>
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const { contactId } = await requireContactSessionForTeam(request, teamId)

  const [enabled, snap] = await Promise.all([
    pluginIsActive(teamId, TARIF595_PLUGIN_ID),
    admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(TARIF595_RECEIPTS_SUBCOLLECTION)
      .where('contact_id', '==', contactId)
      .orderBy('created_at', 'desc')
      .limit(MY_RECEIPTS_LIMIT)
      .get(),
  ])

  const rows = snap.docs.map((d) => d.data() as Tarif595ReceiptDoc)
  // A re-issue names the receipt it replaced by id; the member knows it by its
  // number, and it is theirs too, so it is in this same page.
  const numberById = new Map(rows.map((r) => [r.id, r.number]))
  const receipts: Tarif595MyReceipt[] = rows
    .filter((r) => r.status !== 'pending')
    .map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      period: r.period,
      totals: r.totals,
      language: r.language,
      issuedAt: r.issued_at?.toMillis?.() ?? null,
      replacesNumber: r.replaces ? numberById.get(r.replaces) ?? null : null,
    }))
  return { enabled, receipts }
})
