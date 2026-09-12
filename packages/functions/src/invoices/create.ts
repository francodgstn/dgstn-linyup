// createInvoice — the ONE way an invoice comes into being. Plugin-gated
// (creation). Same two-phase shape as issueTarif595Receipt, for the same
// reason: the number is inside the PDF, so the transaction allocates it and
// freezes the snapshot first (`pending`), the file renders from the frozen
// snapshot afterwards, and a crash between the two resumes on the next call
// with the same requestKey (same deterministic id, no second number).
//
// The creditor is the SHARED legal profile at creation time, frozen into the
// document — a later address change never rewrites an issued invoice. NO
// FINANCE JOURNAL ROW: the invoice is a claim; the money event is recorded by
// markInvoicePaid through the manual-payment writer (noJournal.test.ts pins it).

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  INVOICES_SUBCOLLECTION,
  INVOICE_SETTINGS_DOC,
  INVOICE_SETTINGS_SUBCOLLECTION,
  INVOICE_NUMBER_MAX,
  QR_INVOICES_PLUGIN_ID,
  TEAMS_COLLECTION,
  TEAM_COUNTERS_SUBCOLLECTION,
  TEAM_INVOICE_COUNTER_DOC,
  invoiceId as invoiceIdOf,
  invoiceLangOf,
  invoiceStoragePath,
  resolveInvoiceSettings,
  validateLegalProfile,
  type Contact,
  type CreateInvoiceRequest,
  type CreateInvoiceResult,
  type InvoiceDoc,
  type InvoiceSettings,
  type StructuredPostal,
} from '@linyup/shared'
import { assertManager } from '../connect/access'
import { saveWithSha256 } from '../pdf/files'
import { allocateNumber } from '../pdf/numbering'
import { qrBillData } from '../pdf/qrBill'
import { normalizePaymentLineItem } from '../payments/effects'
import { loadLegalProfile } from '../tarif595/config'
import { zurichDay } from '../tarif595/sources'
import { sha256Hex } from '../utils/crypto'
import { assertPluginInstalled } from '../utils/plugins'
import { getTeam } from '../utils/teams'
import { sendInvoiceEmail } from './email'
import { renderInvoicePdf } from './render'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
const DESCRIPTION_MAX = 140
const MESSAGE_MAX = 140
const REQUEST_KEY_MAX = 64

export async function loadInvoiceSettings(teamId: string): Promise<InvoiceSettings> {
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(INVOICE_SETTINGS_SUBCOLLECTION)
    .doc(INVOICE_SETTINGS_DOC)
    .get()
  return resolveInvoiceSettings(snap.exists ? (snap.data() as Partial<InvoiceSettings>) : null)
}

function addDays(dayIso: string, days: number): string {
  const d = new Date(`${dayIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function contactPostal(c: Contact): StructuredPostal | null {
  const a = c.address
  if (!a?.postal_code || !a?.locality) return null
  return { street_name: a.route ?? '', house_no: a.street_number ?? '', zip: a.postal_code, city: a.locality, country: 'CH' }
}

/** Phase 2 — deterministic from the frozen snapshot; safe to run again. */
async function renderAndStore(ref: FirebaseFirestore.DocumentReference, inv: InvoiceDoc): Promise<void> {
  const pdf = await renderInvoicePdf(inv)
  const pdfRef = await saveWithSha256(invoiceStoragePath(inv.teamId, inv.id), pdf, 'application/pdf', {
    invoiceId: inv.id,
    number: inv.number,
    teamId: inv.teamId,
  })
  await ref.update({ status: 'open', issued_at: FieldValue.serverTimestamp(), files: { pdf: pdfRef } })
}

export const createInvoice = onCall(async (request): Promise<CreateInvoiceResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid
  const d = (request.data ?? {}) as Partial<CreateInvoiceRequest>
  const teamId = typeof d.teamId === 'string' ? d.teamId.trim() : ''
  const contactId = typeof d.contactId === 'string' ? d.contactId.trim() : ''
  const requestKey = typeof d.requestKey === 'string' ? d.requestKey.trim().slice(0, REQUEST_KEY_MAX) : ''
  if (!teamId || !contactId || !requestKey) throw new HttpsError('invalid-argument', 'teamId, contactId and requestKey are required')
  if (typeof d.amountMinor !== 'number' || !Number.isInteger(d.amountMinor) || d.amountMinor < 1) {
    throw new HttpsError('invalid-argument', 'amountMinor must be a positive integer in minor units')
  }
  const lineItem = normalizePaymentLineItem(d.lineItem)
  if (!lineItem) throw new HttpsError('invalid-argument', 'lineItem is required')
  if (d.dueOn != null && (typeof d.dueOn !== 'string' || !ISO_RE.test(d.dueOn))) {
    throw new HttpsError('invalid-argument', 'dueOn must be YYYY-MM-DD')
  }

  await assertManager(uid, teamId)
  await assertPluginInstalled(teamId, QR_INVOICES_PLUGIN_ID)

  const db = admin.firestore()
  const [legalProfile, settings, team, contactSnap] = await Promise.all([
    loadLegalProfile(teamId),
    loadInvoiceSettings(teamId),
    getTeam(teamId),
    db.collection(CONTACTS_COLLECTION).doc(contactId).get(),
  ])
  const profileIssues = validateLegalProfile(legalProfile)
  if (!legalProfile || profileIssues.length > 0) {
    throw new HttpsError('failed-precondition', 'The legal profile is incomplete', {
      reason: 'legal_profile_incomplete',
      issues: profileIssues,
    })
  }
  const contact = contactSnap.exists ? (contactSnap.data() as Contact) : null
  if (!contact || contact.teamId !== teamId || contact.deleted_at) {
    throw new HttpsError('invalid-argument', 'Contact does not belong to this team')
  }

  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)
  const id = invoiceIdOf(sha256Hex, teamId, contactId, requestKey)
  const ref = teamRef.collection(INVOICES_SUBCOLLECTION).doc(id)
  const counterRef = teamRef.collection(TEAM_COUNTERS_SUBCOLLECTION).doc(TEAM_INVOICE_COUNTER_DOC)
  const now = new Date()
  const issuedOn = zurichDay(now) ?? now.toISOString().slice(0, 10)
  const year = issuedOn.slice(0, 4)
  const language = settings.language ?? invoiceLangOf(team?.language)
  const vatRate = legalProfile.vat_number ? legalProfile.vat_rate ?? 0 : 0
  const amount = d.amountMinor
  const description = (typeof d.description === 'string' && d.description.trim()) || lineItem.label || lineItem.kind
  const message = typeof d.message === 'string' && d.message.trim() ? d.message.trim().slice(0, MESSAGE_MAX) : null

  const outcome = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref)
    if (existing.exists) {
      const inv = existing.data() as InvoiceDoc
      return { invoice: inv, resumed: inv.status === 'pending' }
    }
    const { number } = await allocateNumber(tx, counterRef, settings.prefix, year)
    if (number.length > INVOICE_NUMBER_MAX) {
      throw new HttpsError('failed-precondition', 'The invoice number is too long', { reason: 'number_too_long' })
    }
    const reference = qrBillData({
      creditor: { name: legalProfile.legal_name, postal: legalProfile.postal, iban: legalProfile.iban, qrIban: legalProfile.qr_iban ?? null },
      debtor: null,
      amountMinor: amount,
      documentNumber: number,
      language,
    })
    const invoice: InvoiceDoc = {
      id,
      teamId,
      contact_id: contactId,
      number,
      status: 'pending',
      creditor: {
        legal_name: legalProfile.legal_name,
        postal: legalProfile.postal,
        iban: legalProfile.iban,
        qr_iban: legalProfile.qr_iban ?? null,
        vat_number: legalProfile.vat_number ?? null,
        phone: legalProfile.phone ?? null,
        email: legalProfile.email ?? null,
      },
      debtor: {
        familyname: contact.lastname,
        givenname: contact.firstname,
        postal: contactPostal(contact),
        email: contact.email ?? null,
      },
      line_item: lineItem,
      description: description.slice(0, DESCRIPTION_MAX),
      amount_minor: amount,
      vat_rate: vatRate,
      vat_minor: vatRate > 0 ? Math.round((amount * vatRate) / (100 + vatRate)) : 0,
      currency: 'CHF',
      issued_on: issuedOn,
      due_on: d.dueOn ?? addDays(issuedOn, settings.due_days),
      reference: { type: reference.referenceType, value: reference.data.reference ?? null },
      message,
      footer_text: settings.footer_text ?? null,
      language,
      request_timestamp: Math.floor(now.getTime() / 1000),
      files: null,
      delivery: { send_count: 0, emailed_at: null },
      paid: null,
      created_at: FieldValue.serverTimestamp() as unknown as InvoiceDoc['created_at'],
      created_by: uid,
    }
    tx.set(ref, invoice)
    return { invoice, resumed: false }
  })

  const inv = outcome.invoice
  if (inv.status === 'pending') await renderAndStore(ref, inv)
  console.log(`[invoices] created team=${teamId} invoice=${inv.id} number=${inv.number} contact=${contactId} resumed=${outcome.resumed} by=${uid}`)
  const emailed = d.email === true && inv.status !== 'void' ? (await sendInvoiceEmail(teamId, inv.id)).sent : false
  return { invoiceId: inv.id, number: inv.number, status: inv.status === 'pending' ? 'open' : inv.status, resumed: outcome.resumed, emailed }
})
