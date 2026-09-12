// Studio legal profile — the creditor identity a studio prints on every
// document it issues: legal name, structured postal address, canton, IBAN
// (+ optional QR-IBAN), optional VAT number.
//
// SHARED, NOT PLUGIN-OWNED. Two consumers read it — the Tarif 595 receipts
// (biller/provider address, IBAN, VAT) and the QR-bill invoices — and neither
// may own it, or the second one re-collects what the first already asked for.
// It lives at teams/{teamId}/settings/legal_profile under the existing
// `settings/{settingId}` rule (member read, owner write): an IBAN is printed on
// every invoice, so member read leaks nothing.
//
// Why not fields on `Team`: a team write rebuilds the whole public mirror, and
// nothing here is public. Why not `Place.address`: that is ONE free-text line
// (also the map query); the XML 5.0 schema and the Swiss QR-bill both want the
// street, house number, zip and city as separate values, and parsing a free line
// is how a wrong address gets printed on a legal document. The owner types it
// once, structured.
//
// ONE validator — `validateLegalProfile` — is run by the settings card and by
// every callable that renders a document, so the client and the server cannot
// disagree about what "complete" means.

import type { Timestamp } from './common'

/** Swiss cantons + Liechtenstein, the values `treatment@canton` accepts for a
 *  domestic provider (the XSD also lists A/D/F/I for border cases; a Swiss
 *  studio never needs them). */
export const SWISS_CANTONS = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TI', 'TG', 'UR', 'VD', 'VS', 'ZG', 'ZH', 'LI',
] as const
export type SwissCanton = (typeof SWISS_CANTONS)[number]

/** A structured postal address in the shape the XML 5.0 `postalAddressType` and
 *  the Swiss QR-bill structured address (type S) both take verbatim. */
export interface StructuredPostal {
  street_name: string
  house_no: string
  zip: string
  city: string
  /** ISO 3166-1 alpha-2; 'CH' unless set. */
  country?: string
}

export interface StudioLegalProfile {
  legal_name: string
  postal: StructuredPostal
  canton: SwissCanton
  /** Electronic layout (no spaces), CH/LI only. */
  iban: string
  /** Optional QR-IBAN (IID 30000–31999) — enables QRR references on QR-bills. */
  qr_iban?: string | null
  /** Electronic layout `CHE123456789` (no punctuation, no MWST suffix), or absent
   *  when the studio is not VAT-registered. */
  vat_number?: string | null
  /** Percent, e.g. 8.1. Only meaningful with a vat_number. */
  vat_rate?: number | null
  phone?: string | null
  email?: string | null
  updated_at?: Timestamp
  updated_by?: string | null
}

export type LegalProfileIssueCode = 'required' | 'pattern' | 'checksum' | 'length'
export interface LegalProfileIssue {
  path: string
  code: LegalProfileIssueCode
}

// ─── IBAN ─────────────────────────────────────────────────────────────────────

/** Strip whitespace, upper-case — the electronic layout. */
export function normalizeIban(raw: string): string {
  return (raw ?? '').replace(/\s+/g, '').toUpperCase()
}

/** ISO 7064 mod 97-10 over the rearranged IBAN; digit-by-digit to stay exact. */
function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    const piece = code >= 65 && code <= 90 ? String(code - 55) : ch
    for (const d of piece) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return remainder
}

/** A Swiss or Liechtenstein IBAN: 21 characters, `CH`/`LI`, valid check digits —
 *  the `esrQRRed@iban` pattern `(LI|CH)[0-9]{7}[0-9A-Z]{12}` plus mod-97. */
export function isValidChIban(raw: string): boolean {
  const iban = normalizeIban(raw)
  if (!/^(CH|LI)[0-9]{7}[0-9A-Z]{12}$/.test(iban)) return false
  return ibanMod97(iban) === 1
}

/** The IID (positions 5–9) of a QR-IBAN lies in 30000–31999; a plain IBAN never does. */
export function isQrIban(raw: string): boolean {
  const iban = normalizeIban(raw)
  if (!isValidChIban(iban)) return false
  const iid = Number(iban.slice(4, 9))
  return iid >= 30000 && iid <= 31999
}

/** Print layout: groups of four, `CH93 0076 2011 6238 5295 7`. */
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})(?=.)/g, '$1 ')
}

// ─── ISO 11649 creditor reference (SCOR) ─────────────────────────────────────

/** `RF` + 2 check digits + up to 21 alphanumerics derived from a document
 *  number. Used when the studio has a plain IBAN (no QR-IBAN): a QRR reference
 *  needs a QR-IBAN, an RF reference works with any IBAN. */
export function creditorReferenceFor(documentNumber: string): string {
  const body = documentNumber.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 21)
  if (!body) throw new Error('creditorReferenceFor: empty document number')
  // Check digits: 98 − ((body + "RF00") as digits mod 97)
  let remainder = 0
  for (const ch of body + 'RF00') {
    const code = ch.charCodeAt(0)
    const piece = code >= 65 && code <= 90 ? String(code - 55) : ch
    for (const d of piece) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  const check = String(98 - remainder).padStart(2, '0')
  return `RF${check}${body}`
}

export function isValidCreditorReference(raw: string): boolean {
  const ref = (raw ?? '').replace(/\s+/g, '').toUpperCase()
  if (!/^RF[0-9]{2}[0-9A-Z]{1,21}$/.test(ref)) return false
  let remainder = 0
  for (const ch of ref.slice(4) + ref.slice(0, 4)) {
    const code = ch.charCodeAt(0)
    const piece = code >= 65 && code <= 90 ? String(code - 55) : ch
    for (const d of piece) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return remainder === 1
}

// ─── VAT number ───────────────────────────────────────────────────────────────

/** `CHE-123.456.789 MWST` → `CHE123456789` (the electronic layout the XML and
 *  the QR-bill carry). Returns '' for blank input. */
export function normalizeVatNumber(raw: string): string {
  return (raw ?? '')
    .toUpperCase()
    .replace(/\b(MWST|TVA|IVA|VAT)\b/g, '')
    .replace(/[^A-Z0-9]/g, '')
}

export function isValidVatNumber(raw: string): boolean {
  return /^CHE[0-9]{9}$/.test(normalizeVatNumber(raw))
}

const VAT_SUFFIX: Record<string, string> = { de: 'MWST', fr: 'TVA', it: 'IVA', en: 'VAT' }

/** Print layout, language-dependent suffix: `CHE-123.456.789 MWST`. */
export function formatVatNumber(electronic: string, lang: string): string {
  const n = normalizeVatNumber(electronic)
  if (!/^CHE[0-9]{9}$/.test(n)) return electronic
  const d = n.slice(3)
  return `CHE-${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)} ${VAT_SUFFIX[lang] ?? 'MWST'}`
}

// ─── The validator ────────────────────────────────────────────────────────────

const NAME_MAX = 35 // `stringType1_35` in the XML schema: companyname, street, city

export function validateLegalProfile(
  profile: Partial<StudioLegalProfile> | null | undefined
): LegalProfileIssue[] {
  const issues: LegalProfileIssue[] = []
  const p = profile ?? {}
  const need = (path: string, value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '') issues.push({ path, code: 'required' })
  }
  need('legal_name', p.legal_name)
  if (typeof p.legal_name === 'string' && p.legal_name.length > NAME_MAX) {
    issues.push({ path: 'legal_name', code: 'length' })
  }
  need('postal.street_name', p.postal?.street_name)
  need('postal.house_no', p.postal?.house_no)
  need('postal.zip', p.postal?.zip)
  need('postal.city', p.postal?.city)
  if (typeof p.postal?.city === 'string' && p.postal.city.length > NAME_MAX) {
    issues.push({ path: 'postal.city', code: 'length' })
  }
  if (!p.canton) issues.push({ path: 'canton', code: 'required' })
  else if (!(SWISS_CANTONS as readonly string[]).includes(p.canton)) {
    issues.push({ path: 'canton', code: 'pattern' })
  }
  if (!p.iban) issues.push({ path: 'iban', code: 'required' })
  else if (!isValidChIban(p.iban)) issues.push({ path: 'iban', code: 'checksum' })
  if (p.qr_iban) {
    if (!isValidChIban(p.qr_iban)) issues.push({ path: 'qr_iban', code: 'checksum' })
    else if (!isQrIban(p.qr_iban)) issues.push({ path: 'qr_iban', code: 'pattern' })
  }
  if (p.vat_number && !isValidVatNumber(p.vat_number)) {
    issues.push({ path: 'vat_number', code: 'pattern' })
  }
  if (p.email && !/.+@.+/.test(p.email)) issues.push({ path: 'email', code: 'pattern' })
  return issues
}

export function legalProfileIsComplete(profile: Partial<StudioLegalProfile> | null | undefined): boolean {
  return validateLegalProfile(profile).length === 0
}
