// Emailing an invoice (PDF attached) — the `emailInvoice` callable and the
// helper `createInvoice` calls when the manager ticked "email it". Ungated
// (consumption). One idempotency key per (invoice, send_count); the count is
// written as an absolute value from the row just read.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { CONTACTS_COLLECTION, INVOICES_SUBCOLLECTION, TEAMS_COLLECTION, type EmailInvoiceRequest, type InvoiceDoc } from '@linyup/shared'
import { assertManager } from '../connect/access'
import { readVerified } from '../pdf/files'
import { chDate, chf } from '../tarif595/render'
import { buildEmailTemplate, idempotencyKey, sendEmail } from '../utils/email'

const SUBJECT: Record<InvoiceDoc['language'], (n: string) => string> = {
  de: (n) => `Rechnung ${n}`,
  fr: (n) => `Facture ${n}`,
  it: (n) => `Fattura ${n}`,
  en: (n) => `Invoice ${n}`,
}

const BODY: Record<InvoiceDoc['language'], (i: InvoiceDoc) => string> = {
  de: (i) =>
    `<p>Guten Tag ${i.debtor.givenname} ${i.debtor.familyname}</p><p>Im Anhang finden Sie die Rechnung <strong>${i.number}</strong> über CHF ${chf(i.amount_minor)} (${i.description}), zahlbar bis ${chDate(i.due_on)}. Der QR-Zahlteil im PDF lässt sich mit jeder Banking-App scannen.</p><p>${i.creditor.legal_name}</p>`,
  fr: (i) =>
    `<p>Bonjour ${i.debtor.givenname} ${i.debtor.familyname}</p><p>Vous trouverez en annexe la facture <strong>${i.number}</strong> de CHF ${chf(i.amount_minor)} (${i.description}), payable jusqu’au ${chDate(i.due_on)}. La section paiement QR du PDF se scanne avec toute application bancaire.</p><p>${i.creditor.legal_name}</p>`,
  it: (i) =>
    `<p>Buongiorno ${i.debtor.givenname} ${i.debtor.familyname}</p><p>In allegato trova la fattura <strong>${i.number}</strong> di CHF ${chf(i.amount_minor)} (${i.description}), pagabile entro il ${chDate(i.due_on)}. La sezione pagamento QR nel PDF si scansiona con qualsiasi app bancaria.</p><p>${i.creditor.legal_name}</p>`,
  en: (i) =>
    `<p>Hello ${i.debtor.givenname} ${i.debtor.familyname}</p><p>Attached is invoice <strong>${i.number}</strong> for CHF ${chf(i.amount_minor)} (${i.description}), due by ${chDate(i.due_on)}. The QR payment part in the PDF scans with any banking app.</p><p>${i.creditor.legal_name}</p>`,
}

export async function sendInvoiceEmail(teamId: string, invoiceId: string, to?: string | null): Promise<{ sent: boolean; send_count: number }> {
  const ref = admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(INVOICES_SUBCOLLECTION).doc(invoiceId)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found')
  const inv = snap.data() as InvoiceDoc
  if (inv.status === 'pending' || !inv.files) {
    throw new HttpsError('failed-precondition', 'The invoice is not issued yet', { reason: 'invoice_not_open' })
  }
  let recipient = to?.trim() || inv.debtor.email || null
  if (!recipient) {
    const contact = await admin.firestore().collection(CONTACTS_COLLECTION).doc(inv.contact_id).get()
    recipient = (contact.data()?.email as string | undefined) ?? null
  }
  if (!recipient) throw new HttpsError('failed-precondition', 'The contact has no email address', { reason: 'no_email' })

  const pdf = await readVerified(inv.files.pdf)
  const sendCount = inv.delivery?.send_count ?? 0
  const subject = SUBJECT[inv.language](inv.number)
  const { html, text } = buildEmailTemplate({ title: subject, body: BODY[inv.language](inv) })
  await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    teamId,
    attachments: [{ filename: `${inv.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
    tags: ['invoice'],
    idempotencyKey: idempotencyKey('invoice', invoiceId, String(sendCount)),
  })
  await ref.update({ 'delivery.send_count': sendCount + 1, 'delivery.emailed_at': FieldValue.serverTimestamp() })
  console.log(`[invoices] emailed team=${teamId} invoice=${invoiceId} send=${sendCount + 1}`)
  return { sent: true, send_count: sendCount + 1 }
}

export const emailInvoice = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const d = (request.data ?? {}) as Partial<EmailInvoiceRequest>
  const teamId = typeof d.teamId === 'string' ? d.teamId.trim() : ''
  const invoiceId = typeof d.invoiceId === 'string' ? d.invoiceId.trim() : ''
  if (!teamId || !invoiceId) throw new HttpsError('invalid-argument', 'teamId and invoiceId are required')
  const to = typeof d.to === 'string' && /.+@.+/.test(d.to) ? d.to.trim() : null
  await assertManager(request.auth.uid, teamId)
  return sendInvoiceEmail(teamId, invoiceId, to)
})
