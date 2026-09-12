// Tarif 595 — emailing a receipt to the member (PDF + XML attached). Used by
// the `emailTarif595Receipt` callable (re-send at any time) and by
// `issueTarif595Receipt` when the manager ticked "also email".
//
// NOT plugin-gated: sending an existing receipt is consumption (docs/plugins.md,
// "The server gate"). Idempotency: one key per (receipt, send_count), so a
// retried call does not send twice while a deliberate re-send does; the count
// is written as an ABSOLUTE value from the row just read, never incremented.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  TARIF595_RECEIPTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type Tarif595EmailRequest,
  type Tarif595EmailResult,
  type Tarif595ReceiptDoc,
} from '@linyup/shared'
import { assertManager } from '../connect/access'
import { readVerified } from '../pdf/files'
import { buildEmailTemplate, idempotencyKey, sendEmail } from '../utils/email'

const SUBJECT: Record<Tarif595ReceiptDoc['language'], (n: string) => string> = {
  de: (n) => `Rückforderungsbeleg ${n} für Ihre Krankenversicherung`,
  fr: (n) => `Justificatif de remboursement ${n} pour votre assurance-maladie`,
  it: (n) => `Giustificativo di rimborso ${n} per la sua cassa malati`,
}

const BODY: Record<Tarif595ReceiptDoc['language'], (r: Tarif595ReceiptDoc) => string> = {
  de: (r) =>
    `<p>Guten Tag ${r.patient.givenname} ${r.patient.familyname}</p>` +
    `<p>Im Anhang finden Sie Ihren Rückforderungsbeleg <strong>${r.number}</strong> (Tarif 595) für die Zeit vom ${r.period.from} bis ${r.period.to}. ` +
    `Reichen Sie das PDF – alle Seiten, inklusive QR-Code Blatt – bei Ihrer Krankenversicherung ein. Die Rechnung ist bereits bezahlt.</p>` +
    `<p>${r.biller.companyname}</p>`,
  fr: (r) =>
    `<p>Bonjour ${r.patient.givenname} ${r.patient.familyname}</p>` +
    `<p>Vous trouverez en annexe votre justificatif de remboursement <strong>${r.number}</strong> (tarif 595) pour la période du ${r.period.from} au ${r.period.to}. ` +
    `Remettez le PDF – toutes les pages, feuille QR comprise – à votre assurance-maladie. La facture est déjà payée.</p>` +
    `<p>${r.biller.companyname}</p>`,
  it: (r) =>
    `<p>Buongiorno ${r.patient.givenname} ${r.patient.familyname}</p>` +
    `<p>In allegato trova il suo giustificativo di rimborso <strong>${r.number}</strong> (tariffa 595) per il periodo dal ${r.period.from} al ${r.period.to}. ` +
    `Consegni il PDF – tutte le pagine, foglio QR compreso – alla sua cassa malati. La fattura è già stata pagata.</p>` +
    `<p>${r.biller.companyname}</p>`,
}

function receiptRef(teamId: string, receiptId: string) {
  return admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(TARIF595_RECEIPTS_SUBCOLLECTION).doc(receiptId)
}

/** Sends an ISSUED receipt and bumps `delivery`. Throws when the receipt has no files or no address. */
export async function sendReceiptEmail(teamId: string, receiptId: string, to?: string | null): Promise<Tarif595EmailResult> {
  const ref = receiptRef(teamId, receiptId)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Receipt not found')
  const r = snap.data() as Tarif595ReceiptDoc
  if (r.status === 'pending' || !r.files) {
    throw new HttpsError('failed-precondition', 'The receipt is not issued yet', { reason: 'receipt_not_issued' })
  }
  let recipient = to?.trim() || r.patient.email || null
  if (!recipient) {
    const contact = await admin.firestore().collection(CONTACTS_COLLECTION).doc(r.contact_id).get()
    recipient = (contact.data()?.email as string | undefined) ?? null
  }
  if (!recipient) throw new HttpsError('failed-precondition', 'The contact has no email address', { reason: 'no_email' })

  const [pdf, xml] = await Promise.all([readVerified(r.files.pdf), readVerified(r.files.xml)])
  const sendCount = r.delivery?.send_count ?? 0
  const { html, text } = buildEmailTemplate({ title: SUBJECT[r.language](r.number), body: BODY[r.language](r) })
  await sendEmail({
    to: recipient,
    subject: SUBJECT[r.language](r.number),
    html,
    text,
    teamId,
    attachments: [
      { filename: `${r.number}.pdf`, content: pdf, contentType: 'application/pdf' },
      { filename: `${r.number}.xml`, content: xml, contentType: 'application/xml' },
    ],
    tags: ['tarif595'],
    idempotencyKey: idempotencyKey('tarif595', receiptId, String(sendCount)),
  })
  await ref.update({ 'delivery.send_count': sendCount + 1, 'delivery.emailed_at': FieldValue.serverTimestamp() })
  console.log(`[tarif595] emailed team=${teamId} receipt=${receiptId} send=${sendCount + 1}`)
  return { sent: true, send_count: sendCount + 1 }
}

export const emailTarif595Receipt = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = (request.data ?? {}) as Partial<Tarif595EmailRequest>
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  const receiptId = typeof data.receiptId === 'string' ? data.receiptId.trim() : ''
  if (!teamId || !receiptId) throw new HttpsError('invalid-argument', 'teamId and receiptId are required')
  const to = typeof data.to === 'string' && /.+@.+/.test(data.to) ? data.to.trim() : null

  await assertManager(request.auth.uid, teamId)
  return sendReceiptEmail(teamId, receiptId, to)
})
