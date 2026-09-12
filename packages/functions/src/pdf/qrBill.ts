// The Swiss QR-bill payment part — shared by Tarif 595 receipts (always
// "without amount": the member has already paid, the slip exists because the
// XML 5.0 schema requires a pay-in-slip element regardless) and, next, QR-bill
// invoices (amount present). PURE except for `attachQrBill`, which draws.
//
// REFERENCE TYPE follows the creditor's account, not a caller's choice: a
// QR-IBAN (`creditor.qrIban`) REQUIRES a QRR reference — swissqrbill itself
// refuses a QR-IBAN paired with anything else (`ACCOUNT_IS_QR_IBAN_BUT_…` in
// its ValidationErrors) — and a plain IBAN takes the ISO 11649 creditor
// reference (SCOR, `creditorReferenceFor` from `@linyup/shared`) derived from
// the same document number. `qrBillData` is pure so a caller can log or
// compare the reference before ever touching PDFKit.
//
// THE QRR CHECK DIGIT is the SIX "modulo 10 recursive" algorithm: walk the 26
// reference digits left to right, carrying an index into a fixed 10-entry
// table, seeded at 0; the check digit is `(10 - carry) % 10`. Verified against
// the spec's own worked example (`docs`/`qrBill.test.ts`):
// `21 00000 00003 13947 14300 09017` — check digit `7` over the leading 26.

import { SwissQRBill } from 'swissqrbill/pdf'
import type { Data as SwissQRBillData, PDFOptions as SwissQRBillPdfOptions } from 'swissqrbill/types'
import { creditorReferenceFor, type StructuredPostal } from '@linyup/shared'

export type QrBillReferenceType = 'QRR' | 'SCOR' | 'NON'

export interface QrBillInput {
  creditor: {
    name: string
    postal: StructuredPostal
    iban: string
    /** Present ⇒ QRR; absent ⇒ SCOR against the plain `iban`. */
    qrIban?: string | null
  }
  debtor: { name: string; postal: StructuredPostal } | null
  /** Minor units (Rappen). `null` renders the "without amount" form — the
   *  form Tarif 595 receipts always use, since the member already paid. */
  amountMinor: number | null
  documentNumber: string
  message?: string | null
  language: 'de' | 'fr' | 'it' | 'en'
}

const LANGUAGE_MAP: Record<QrBillInput['language'], NonNullable<SwissQRBillPdfOptions['language']>> = {
  de: 'DE',
  fr: 'FR',
  it: 'IT',
  en: 'EN',
}

/** SIX's "modulo 10 recursive" carry-lookup table (the QR-reference check
 *  digit algorithm — NOT the ISO 7064 mod-97 used for IBAN/SCOR). Index by
 *  `(carry + digit) % 10`. */
const QRR_CHECK_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5]

/** The check digit for a 26-digit QRR body (digits only). */
export function qrrCheckDigit(digits: string): number {
  let carry = 0
  for (const ch of digits) {
    const d = ch.charCodeAt(0) - 48
    carry = QRR_CHECK_TABLE[(carry + d) % 10]
  }
  return (10 - carry) % 10
}

/**
 * A 27-digit QRR reference from a document number: keep its digits (drop any
 * prefix/separator letters), right-align into a 26-digit body zero-padded on
 * the left, append the check digit.
 */
export function buildQrrReference(documentNumber: string): string {
  const digits = documentNumber.replace(/[^0-9]/g, '')
  if (!digits) throw new Error('buildQrrReference: document number carries no digits')
  const body = digits.slice(-26).padStart(26, '0')
  return `${body}${qrrCheckDigit(body)}`
}

function toPartyAddress(name: string, postal: StructuredPostal) {
  return {
    name,
    address: postal.street_name,
    buildingNumber: postal.house_no,
    zip: postal.zip,
    city: postal.city,
    country: postal.country ?? 'CH',
  }
}

export interface QrBillDataResult {
  data: SwissQRBillData
  referenceType: QrBillReferenceType
}

/** Pure: builds the swissqrbill `Data` object and reports which reference
 *  kind it used. Never emits `'NON'` — a `documentNumber` is always given, so
 *  there is always something to derive a reference from; the type includes it
 *  because a bill without any reference is a real (if unused here) shape. */
export function qrBillData(input: QrBillInput): QrBillDataResult {
  const isQr = Boolean(input.creditor.qrIban)
  const account = isQr ? (input.creditor.qrIban as string) : input.creditor.iban
  const reference = isQr ? buildQrrReference(input.documentNumber) : creditorReferenceFor(input.documentNumber)
  const referenceType: QrBillReferenceType = isQr ? 'QRR' : 'SCOR'

  const data: SwissQRBillData = {
    currency: 'CHF',
    creditor: { ...toPartyAddress(input.creditor.name, input.creditor.postal), account },
    reference,
  }
  if (input.debtor) data.debtor = toPartyAddress(input.debtor.name, input.debtor.postal)
  if (input.amountMinor != null) data.amount = Math.round(input.amountMinor) / 100
  if (input.message) data.message = input.message

  return { data, referenceType }
}

/** Builds the data and draws the payment part onto `doc` at PDFKit's default
 *  position (bottom of the current/a new page — swissqrbill adds one itself
 *  when there isn't enough room left). */
export function attachQrBill(doc: PDFKit.PDFDocument, input: QrBillInput): { referenceType: QrBillReferenceType } {
  const { data, referenceType } = qrBillData(input)
  new SwissQRBill(data, {
    language: LANGUAGE_MAP[input.language],
    outlines: true,
    scissors: true,
  }).attachTo(doc)
  return { referenceType }
}
