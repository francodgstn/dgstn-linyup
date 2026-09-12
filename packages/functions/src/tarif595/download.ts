// downloadTarif595Receipt — the ONLY way the bytes leave the bucket. storage.rules
// excludes teams/{t}/tarif595/** from every client rule, so the PDF and XML are
// re-read here, checked against the sha256 frozen on the receipt (a tampered or
// half-written object is refused, never served) and returned inline as base64
// — callable responses are JSON, and signed URLs need IAM the emulator lacks.
// The precedent is exportFinanceReport (bytes inline, hard size cap).
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

export const downloadTarif595Receipt = onCall(async (request): Promise<Tarif595DownloadResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = (request.data ?? {}) as Partial<Tarif595DownloadRequest>
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  const receiptId = typeof data.receiptId === 'string' ? data.receiptId.trim() : ''
  const kind = data.kind === 'xml' ? 'xml' : data.kind === 'pdf' ? 'pdf' : null
  if (!teamId || !receiptId || !kind) throw new HttpsError('invalid-argument', 'teamId, receiptId and kind are required')

  await assertManager(request.auth.uid, teamId)

  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(TARIF595_RECEIPTS_SUBCOLLECTION).doc(receiptId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Receipt not found')
  const r = snap.data() as Tarif595ReceiptDoc
  if (r.status === 'pending' || !r.files) {
    throw new HttpsError('failed-precondition', 'The receipt is not issued yet', { reason: 'receipt_not_issued' })
  }
  const bytes = await readVerified(r.files[kind])
  return toDownloadResult(`${r.number}.${kind}`, kind === 'pdf' ? 'application/pdf' : 'application/xml', bytes)
})
