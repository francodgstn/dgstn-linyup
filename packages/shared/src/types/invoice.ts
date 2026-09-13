// QR-bill invoices (plugin `qr-invoices`) — the claim BEFORE a payment.
//
// A studio that takes bank transfers today emails a home-made QR-bill; Linyup
// had only the payment that follows (`payment_events`, gateway `manual`). An
// invoice is a numbered document with the studio's legal profile as creditor,
// a contact as debtor, one structured `PaymentLineItem`, an amount and a due
// date, rendered as a PDF with a Swiss QR-bill payment part (amount SET).
//
// "Mark as paid" records the manual payment through the ONE writer every
// manual payment goes through (`writeManualPaymentEvent`), so entitlements and
// the finance journal behave exactly as for a payment recorded by hand. THE
// INVOICE ITSELF WRITES NO JOURNAL ROW — the money event is the payment. No
// reminders, no dunning, no bank-file reconciliation: this is the deliberate,
// recorded exception to the "no AR" non-goal (docs/product-strategy.md §7,
// docs/finance-accrual.md non-goals), and it stops here.
//
// Records (all under teams/{teamId}, see paths.ts):
//   invoice_settings/config — InvoiceSettings (prefix, due days, footer). Manager+.
//   invoices/{invoiceId}    — InvoiceDoc, a frozen snapshot; functions-only.
//   counters/invoices       — `{last, year}`, absolute, in the allocating tx.
// Shared with Tarif 595: the legal profile (types/legalProfile.ts) and the
// functions pdf/ rail (document, QR-bill, numbering, files).

import type { Timestamp } from './common'
import type { StructuredPostal } from './legalProfile'
import type { PaymentLineItem } from './payment'

export const QR_INVOICES_PLUGIN_ID = 'qr-invoices'
/** `stringType1_35`-style ceiling kept in step with the receipts; also the SCOR body limit (21 alphanumerics) is derived from it. */
export const INVOICE_NUMBER_MAX = 35
export type InvoiceLang = 'de' | 'fr' | 'it' | 'en'

export interface InvoiceSettings {
  /** A–Z0–9, ≤ 10; default 'INV'. */
  prefix: string
  /** Days from issue to due date; default 30. */
  due_days: number
  /** Printed under the totals — payment terms, a thank-you, a bank note. */
  footer_text?: string | null
  /** Document language; defaults to the team's. */
  language?: InvoiceLang | null
  updated_at?: Timestamp
  updated_by?: string | null
}

export const DEFAULT_INVOICE_SETTINGS: Pick<InvoiceSettings, 'prefix' | 'due_days'> = { prefix: 'INV', due_days: 30 }

export type InvoiceStatus = 'pending' | 'open' | 'paid' | 'void'

export interface InvoiceCreditor {
  legal_name: string
  postal: StructuredPostal
  iban: string
  qr_iban: string | null
  vat_number: string | null
  phone: string | null
  email: string | null
}

export interface InvoiceDebtor {
  familyname: string
  givenname: string
  postal: StructuredPostal | null
  email: string | null
}

export interface InvoiceFileRef {
  path: string
  sha256: string
  bytes: number
}

export interface InvoiceDoc {
  id: string
  teamId: string
  contact_id: string
  number: string
  status: InvoiceStatus
  creditor: InvoiceCreditor
  debtor: InvoiceDebtor
  line_item: PaymentLineItem
  /** What is printed on the line — the line item's label, or the manager's text. */
  description: string
  /** Gross, minor units (Rappen). */
  amount_minor: number
  /** Percent; 0 when the studio is not VAT-registered. */
  vat_rate: number
  /** VAT contained in the gross amount, minor units. */
  vat_minor: number
  currency: 'CHF'
  /** YYYY-MM-DD */
  issued_on: string
  due_on: string
  reference: { type: 'QRR' | 'SCOR' | 'NON'; value: string | null }
  message: string | null
  footer_text: string | null
  language: InvoiceLang
  /** Frozen at allocation, like a receipt's — a resume re-renders identically. */
  request_timestamp: number
  files: { pdf: InvoiceFileRef } | null
  delivery: { send_count: number; emailed_at: Timestamp | null }
  paid: { payment_event_id: string; paid_at: Timestamp; mode: string | null } | null
  created_at: Timestamp
  created_by: string
  issued_at?: Timestamp | null
  voided_at?: Timestamp | null
  voided_by?: string | null
  void_reason?: string | null
}

/** Deterministic id from a per-attempt client key: a retried create finds its
 *  own document instead of taking a second number. Hasher injected (crypto-free). */
export function invoiceId(sha256Hex: (s: string) => string, teamId: string, contactId: string, requestKey: string): string {
  return sha256Hex(`invoice:${teamId}:${contactId}:${requestKey}`).slice(0, 32)
}

export function invoiceLangOf(teamLanguage: string | null | undefined): InvoiceLang {
  return teamLanguage === 'fr' || teamLanguage === 'it' || teamLanguage === 'en' ? teamLanguage : 'de'
}

const PREFIX_RE = /^[A-Z0-9]{1,10}$/

export interface InvoiceSettingsIssue {
  path: string
  code: 'required' | 'pattern' | 'range'
}

export function validateInvoiceSettings(s: Partial<InvoiceSettings> | null | undefined): InvoiceSettingsIssue[] {
  const issues: InvoiceSettingsIssue[] = []
  const v = s ?? {}
  if (!v.prefix) issues.push({ path: 'prefix', code: 'required' })
  else if (!PREFIX_RE.test(v.prefix)) issues.push({ path: 'prefix', code: 'pattern' })
  if (typeof v.due_days !== 'number' || !Number.isInteger(v.due_days) || v.due_days < 0 || v.due_days > 365) {
    issues.push({ path: 'due_days', code: 'range' })
  }
  return issues
}

/** The settings with defaults applied — what every reader uses. */
export function resolveInvoiceSettings(s: Partial<InvoiceSettings> | null | undefined): InvoiceSettings {
  return {
    prefix: s?.prefix && PREFIX_RE.test(s.prefix) ? s.prefix : DEFAULT_INVOICE_SETTINGS.prefix,
    due_days: typeof s?.due_days === 'number' && Number.isInteger(s.due_days) && s.due_days >= 0 ? s.due_days : DEFAULT_INVOICE_SETTINGS.due_days,
    footer_text: s?.footer_text ?? null,
    language: s?.language ?? null,
  }
}

// ─── Callable contracts ───────────────────────────────────────────────────────

export interface CreateInvoiceRequest {
  teamId: string
  contactId: string
  /** Per-attempt key from the client (a uuid minted when the dialog opens). */
  requestKey: string
  lineItem: PaymentLineItem
  /** Gross, minor units. */
  amountMinor: number
  description?: string | null
  /** YYYY-MM-DD; defaults to issue date + due_days. */
  dueOn?: string | null
  message?: string | null
  /** Email the PDF to the contact right away. */
  email?: boolean
}

export interface CreateInvoiceResult {
  invoiceId: string
  number: string
  status: InvoiceStatus
  resumed: boolean
  emailed: boolean
}

export interface InvoiceRefRequest {
  teamId: string
  invoiceId: string
}

export interface VoidInvoiceRequest extends InvoiceRefRequest {
  reason?: string | null
}

export interface EmailInvoiceRequest extends InvoiceRefRequest {
  to?: string | null
}

export interface MarkInvoicePaidRequest extends InvoiceRefRequest {
  /** Studio payment-mode label, e.g. "Bank transfer". */
  paymentMode?: string | null
  /** Epoch ms the money arrived; defaults to now. */
  paidAtMs?: number | null
  /** Send the buyer the desk-sale receipt mail (the manual-payment flag). */
  sendReceipt?: boolean
}

export interface MarkInvoicePaidResult {
  invoiceId: string
  paymentEventId: string
  status: 'paid'
}

export interface DocumentDownloadResult {
  filename: string
  contentType: string
  base64: string
  bytes: number
}
