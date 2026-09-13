// downloadInvoice — the ONLY way the PDF leaves the bucket (storage.rules
// excludes teams/{t}/invoices/** from every client rule): bytes re-read,
// sha256-checked against the frozen invoice, returned inline as base64.
// Ungated: an invoice already sent to a member stays retrievable. Voided and
// paid invoices download too — they are records.

import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { INVOICES_SUBCOLLECTION, TEAMS_COLLECTION, type DocumentDownloadResult, type InvoiceDoc, type InvoiceRefRequest } from '@linyup/shared'
import { assertManager } from '../connect/access'
import { readVerified, toDownloadResult } from '../pdf/files'

export const downloadInvoice = onCall(async (request): Promise<DocumentDownloadResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const d = (request.data ?? {}) as Partial<InvoiceRefRequest>
  const teamId = typeof d.teamId === 'string' ? d.teamId.trim() : ''
  const invoiceId = typeof d.invoiceId === 'string' ? d.invoiceId.trim() : ''
  if (!teamId || !invoiceId) throw new HttpsError('invalid-argument', 'teamId and invoiceId are required')

  await assertManager(request.auth.uid, teamId)

  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(INVOICES_SUBCOLLECTION).doc(invoiceId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found')
  const inv = snap.data() as InvoiceDoc
  if (inv.status === 'pending' || !inv.files) {
    throw new HttpsError('failed-precondition', 'The invoice is not issued yet', { reason: 'invoice_not_open' })
  }
  const bytes = await readVerified(inv.files.pdf)
  return toDownloadResult(`${inv.number}.pdf`, 'application/pdf', bytes)
})
