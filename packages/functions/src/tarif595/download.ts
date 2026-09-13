// downloadTarif595Receipt — the ONLY way the bytes leave the bucket. storage.rules
// excludes teams/{t}/tarif595/** from every client rule, so the PDF and XML are
// re-read here, checked against the sha256 frozen on the receipt (a tampered or
// half-written object is refused, never served) and returned inline as base64
// — callable responses are JSON, and signed URLs need IAM the emulator lacks.
// The precedent is exportFinanceReport (bytes inline, hard size cap).
//
// TWO DOORS, decided by the token, never by the body: a manager of the team
// (a Firebase user, `assertManager`) downloads any receipt of the team; a
// CONTACT SESSION (the Space's custom token — `requireContactSessionForTeam`,
// the only trustworthy source of a caller's contactId) downloads a receipt
// whose `contact_id` is their own, and any other receipt id answers
// `not-found`, exactly as a receipt that does not exist would — a member must
// not be able to tell which ids belong to somebody else.
//
// NOT plugin-gated: a receipt already handed to a member must stay retrievable
// after the studio unticks the plugin. A voided receipt downloads too — it is a
// record of what was issued.

import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  TARIF595_RECEIPTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type Tarif595DownloadRequest,
  type Tarif595DownloadResult,
  type Tarif595ReceiptDoc,
} from '@linyup/shared'
import { assertManager } from '../connect/access'
import { readVerified, toDownloadResult } from '../pdf/files'
import { optionalContactSessionFromRequest, requireContactSessionForTeam } from '../utils/contactSession'

export const downloadTarif595Receipt = onCall(async (request): Promise<Tarif595DownloadResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = (request.data ?? {}) as Partial<Tarif595DownloadRequest>
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  const receiptId = typeof data.receiptId === 'string' ? data.receiptId.trim() : ''
  const kind = data.kind === 'xml' ? 'xml' : data.kind === 'pdf' ? 'pdf' : null
  if (!teamId || !receiptId || !kind) throw new HttpsError('invalid-argument', 'teamId, receiptId and kind are required')

  // The contact door is taken whenever the token carries a contact session —
  // a member's custom token never carries a team role, and a manager's ID token
  // never carries a contactId, so the two cannot both apply.
  let ownContactId: string | null = null
  if (optionalContactSessionFromRequest(request)) {
    ownContactId = (await requireContactSessionForTeam(request, teamId)).contactId
  } else {
    await assertManager(request.auth.uid, teamId)
  }

  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(TARIF595_RECEIPTS_SUBCOLLECTION).doc(receiptId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Receipt not found')
  const r = snap.data() as Tarif595ReceiptDoc
  if (ownContactId !== null && r.contact_id !== ownContactId) throw new HttpsError('not-found', 'Receipt not found')
  if (r.status === 'pending' || !r.files) {
    throw new HttpsError('failed-precondition', 'The receipt is not issued yet', { reason: 'receipt_not_issued' })
  }
  const bytes = await readVerified(r.files[kind])
  return toDownloadResult(`${r.number}.${kind}`, kind === 'pdf' ? 'application/pdf' : 'application/xml', bytes)
})
