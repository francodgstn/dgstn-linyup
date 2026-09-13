// voidInvoice — withdraws an OPEN invoice. Never edited, never deleted; a paid
// invoice cannot be voided (the payment stands — reverse it through the
// payments surface, which is a money event with its own rails), and a pending
// one is mid-creation (resume it). Ungated: winding down existing state.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { INVOICES_SUBCOLLECTION, TEAMS_COLLECTION, type InvoiceDoc, type VoidInvoiceRequest } from '@linyup/shared'
import { assertManager } from '../connect/access'

const REASON_MAX = 350

export const voidInvoice = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const d = (request.data ?? {}) as Partial<VoidInvoiceRequest>
  const teamId = typeof d.teamId === 'string' ? d.teamId.trim() : ''
  const invoiceId = typeof d.invoiceId === 'string' ? d.invoiceId.trim() : ''
  if (!teamId || !invoiceId) throw new HttpsError('invalid-argument', 'teamId and invoiceId are required')
  const reason = typeof d.reason === 'string' ? d.reason.trim().slice(0, REASON_MAX) : null

  await assertManager(request.auth.uid, teamId)

  const ref = admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(INVOICES_SUBCOLLECTION).doc(invoiceId)
  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found')
    const inv = snap.data() as InvoiceDoc
    if (inv.status === 'void') return
    if (inv.status !== 'open') {
      throw new HttpsError('failed-precondition', 'Only an open invoice can be voided', {
        reason: inv.status === 'paid' ? 'invoice_already_paid' : 'invoice_not_open',
      })
    }
    tx.update(ref, { status: 'void', voided_at: FieldValue.serverTimestamp(), voided_by: request.auth!.uid, void_reason: reason || null })
  })
  console.log(`[invoices] voided team=${teamId} invoice=${invoiceId} by=${request.auth.uid}`)
  return { invoiceId, status: 'void' as const }
})
