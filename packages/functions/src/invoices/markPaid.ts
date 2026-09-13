// markInvoicePaid — the money arrived. Records the payment through THE ONE
// manual-payment writer (`writeManualPaymentEvent`, payments/recordManualPayment.ts):
// a `payment_events` row with gateway `manual`, the finance journal row, and the
// purchase effects (subscription fields, credits, course entitlement) — exactly
// what the Record-payment dialog does, because it IS that path. The invoice
// then carries the payment's id and flips to `paid`.
//
// Idempotent: the payment's idempotency key is derived from the invoice id, so
// a retried call finds the same `payment_events` document (the writer reports
// `duplicate`) and the invoice is stamped once. NOT plugin-gated — settling a
// claim already issued is consumption (docs/plugins.md, "The server gate").

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { INVOICES_SUBCOLLECTION, TEAMS_COLLECTION, type InvoiceDoc, type MarkInvoicePaidRequest, type MarkInvoicePaidResult } from '@linyup/shared'
import { assertManager } from '../connect/access'
import { sendDeskSaleReceipt } from '../payments/deskReceipt'
import { writeManualPaymentEvent } from '../payments/recordManualPayment'

const MODE_MAX = 60

export const markInvoicePaid = onCall(async (request): Promise<MarkInvoicePaidResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const d = (request.data ?? {}) as Partial<MarkInvoicePaidRequest>
  const teamId = typeof d.teamId === 'string' ? d.teamId.trim() : ''
  const invoiceId = typeof d.invoiceId === 'string' ? d.invoiceId.trim() : ''
  if (!teamId || !invoiceId) throw new HttpsError('invalid-argument', 'teamId and invoiceId are required')
  const paymentMode = typeof d.paymentMode === 'string' && d.paymentMode.trim() ? d.paymentMode.trim().slice(0, MODE_MAX) : null
  const paidAtMs = typeof d.paidAtMs === 'number' && Number.isFinite(d.paidAtMs) ? d.paidAtMs : Date.now()

  await assertManager(request.auth.uid, teamId)

  const ref = admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(INVOICES_SUBCOLLECTION).doc(invoiceId)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found')
  const inv = snap.data() as InvoiceDoc
  if (inv.status === 'paid' && inv.paid) {
    return { invoiceId, paymentEventId: inv.paid.payment_event_id, status: 'paid' }
  }
  if (inv.status !== 'open') {
    throw new HttpsError('failed-precondition', 'Only an open invoice can be marked paid', {
      reason: inv.status === 'void' ? 'invoice_void' : 'invoice_not_open',
    })
  }

  const result = await writeManualPaymentEvent({
    teamId,
    contactId: inv.contact_id,
    amount: inv.amount_minor,
    currency: inv.currency,
    occurredAtMs: paidAtMs,
    paymentMode,
    lineItem: inv.line_item,
    comment: `${inv.number} · ${inv.description}`,
    idempotencyKey: `invoice-${invoiceId}`,
    recordedBy: request.auth.uid,
  })

  await ref.update({
    status: 'paid',
    paid: { payment_event_id: result.id, paid_at: Timestamp.fromMillis(paidAtMs), mode: paymentMode },
    updated_at: FieldValue.serverTimestamp(),
  })
  console.log(`[invoices] paid team=${teamId} invoice=${invoiceId} payment=${result.id} duplicate=${result.duplicate === true}`)

  if (d.sendReceipt === true && !result.duplicate) {
    await sendDeskSaleReceipt({
      teamId,
      contactId: inv.contact_id,
      lineItem: inv.line_item,
      paymentRef: result.id,
      amountRappen: inv.amount_minor,
      currency: inv.currency,
      methodLabel: paymentMode,
    })
  }
  return { invoiceId, paymentEventId: result.id, status: 'paid' }
})
