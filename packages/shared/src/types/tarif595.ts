// Tarif 595 — Swiss health-insurance reimbursement receipts (Rückforderungsbeleg)
// in the Forum Datenaustausch XML 5.0 `generalInvoiceRequest` format.
//
// A RECEIPT IS AN ATTESTATION, NEVER A MONEY EVENT. It states what a member
// bought and when, so the member's supplementary insurer can reimburse them; the
// money moved when the member paid the studio. So nothing here writes a finance
// journal row, nothing here is priced by the resolver, and voiding a receipt
// moves no money — it only says "this document is withdrawn". Full doc:
// docs/tarif-595.md.
//
// Three plugin-owned records (all under teams/{teamId}, see paths.ts):
//   tarif595_settings/config      — Tarif595Config: the plugin's OWN identifiers
//                                   (GLN/ZSR, numbering, offering → position map).
//                                   Name, address, IBAN, VAT, canton come from the
//                                   SHARED legal profile (types/legalProfile.ts).
//   tarif595_contacts/{contactId} — Tarif595ContactData: insurer + AHV number etc.
//                                   Manager-only; never on Contact, never mirrored.
//   tarif595_receipts/{receiptId} — Tarif595ReceiptDoc: the frozen snapshot.
//                                   Functions-only write; doc id = tarif595ReceiptId.
//
// The position list itself is DATA, generated from the Forum's XLSX into
// data/tarif595/positions.ts and exposed on the `@linyup/shared/tarif595-positions`
// subpath — deliberately NOT re-exported from index.ts, so the web bundle only
// pays for it on the two pages that pick positions.

import type { Timestamp } from './common'
import type { StructuredPostal, SwissCanton } from './legalProfile'

export const TARIF595_PLUGIN_ID = 'tarif-595'
/** The tariff number as it appears in `service@tariff_type`. */
export const TARIF595_TARIFF_TYPE = '595'
/** The free-text position: the only code whose description the studio may overwrite. */
export const TARIF595_FREE_TEXT_CODE = '9999'
/** Recorded (asynchronous) online training — always this code, whatever the method. */
export const TARIF595_RECORDED_ONLINE_CODE = '1105'
/** `define_gln_norecipient` (fixed in the XSD): the transport `to` when the
 *  member's insurer is unknown — a paper receipt has no electronic recipient. */
export const XML50_GLN_NO_RECIPIENT = '2006666666008'
/** The pseudo GLN the standard's reference docs name for a private-person debitor. */
export const XML50_GLN_PRIVATE_DEBITOR = '2000000000008'
/** `request_id` / receipt number is `stringType1_35`. */
export const TARIF595_NUMBER_MAX = 35

/** The XSD allows de/fr/it only — a studio authoring in English gets German. */
export type Tarif595Lang = 'de' | 'fr' | 'it'
export function tarif595LangOf(teamLanguage: string | null | undefined): Tarif595Lang {
  return teamLanguage === 'fr' || teamLanguage === 'it' ? teamLanguage : 'de'
}

/** How the quantity of a mapped offering is derived from the studio's own records. */
export type Tarif595Unit =
  | 'month' // "pro 1 Monat": quantity = calendar months of the period (one line per year)
  | 'year' // "pro 1 Jahr": quantity 1 per year of the period (one line per year)
  | 'lesson' // "pro 1 Lektion" / "Einzeleintritt" from attendance: one line per day, qty 1
  | 'entry' // a pass sold as N entries: ONE line, quantity = the pass size
  | 'flat' // "pauschal": one line, quantity 1

export interface Tarif595OfferingMapping {
  position: string
  unit: Tarif595Unit
  /** Personal training = the method's position PLUS the PT position (Qualitop FAQ
   *  4.6): a second line with the same quantity and a zero price. */
  ptPosition?: string | null
  /** Only honoured for TARIF595_FREE_TEXT_CODE — every other description is the
   *  official text and must not be altered. */
  customName?: string | null
  /** For `unit: 'entry'`: how many entries the pass holds (e.g. 10). */
  entries?: number | null
}

export type Tarif595OfferingKind = 'subscription' | 'activity' | 'course'
export function tarif595OfferingKey(kind: Tarif595OfferingKind, id: string): string {
  return `${kind}:${id}`
}
export function parseTarif595OfferingKey(key: string): { kind: Tarif595OfferingKind; id: string } | null {
  const i = key.indexOf(':')
  if (i <= 0) return null
  const kind = key.slice(0, i)
  if (kind !== 'subscription' && kind !== 'activity' && kind !== 'course') return null
  return { kind, id: key.slice(i + 1) }
}

export interface Tarif595Config {
  language: Tarif595Lang
  /** `request@modus` — `test` while validating with an insurer; no money flows either way. */
  modus: 'production' | 'test'
  /** Rechnungssteller: GLN (B) + ZSR (B), issued by the studio's label body. */
  biller: { gln: string; zsr: string }
  /** Leistungserbringer: GLN (P), GLN (L, = P when there is no separate location),
   *  ZSR (P). Defaults to the biller; a multi-location studio overrides. */
  provider: { gln: string; gln_location: string; zsr?: string | null; uid?: string | null }
  numbering: { prefix: string }
  offerings: Record<string, Tarif595OfferingMapping>
  updated_at?: Timestamp
  updated_by?: string | null
}

export interface Tarif595ContactData {
  /** AHVN13 (`756` + 10 digits, EAN-13 check digit), electronic layout. REQUIRED
   *  to issue: Helsana Wegleitung §3.6 and the XSD both demand it. */
  ahv_number?: string | null
  insurer_name?: string | null
  insurer_gln?: string | null
  /** The Versichertennummer from the insurance card → `law@insured_id`. */
  insured_number?: string | null
  /** `patient@sex` must be male|female; a contact whose gender is `other` or
   *  unknown needs this recorded for billing. */
  sex_override?: 'male' | 'female' | null
  /** Legal representative (parents) for a minor → the `guarantor` block. */
  guardian?: { familyname: string; givenname: string; postal?: StructuredPostal | null } | null
  updated_at?: Timestamp
  updated_by?: string | null
}

export type Tarif595Source =
  | { kind: 'subscription'; historyId: string }
  | { kind: 'attendance'; activityId: string }
  | { kind: 'course'; courseId: string }

/** `'{kind}:{ref}:{from}:{to}'` — the same period of the same source is the
 *  same receipt; Jan–Jun and Jul–Dec of one open subscription are two. */
export function tarif595SourceKey(source: Tarif595Source, fromIso: string, toIso: string): string {
  const ref =
    source.kind === 'subscription' ? source.historyId : source.kind === 'attendance' ? source.activityId : source.courseId
  return `${source.kind}:${ref}:${fromIso}:${toIso}`
}

/** Deterministic doc id: a retry finds the existing document instead of
 *  consuming a second number. The hasher is injected so this module stays
 *  crypto-free (the functions side passes `sha256Hex`). */
export function tarif595ReceiptId(
  sha256Hex: (input: string) => string,
  teamId: string,
  contactId: string,
  sourceKey: string,
  revision: number
): string {
  return sha256Hex(`${teamId}:${contactId}:${sourceKey}:${revision}`).slice(0, 32)
}

export interface Tarif595Line {
  record_id: number
  code: string
  /** The official position text in the receipt language (or the custom text of 9999). */
  name: string
  quantity: number
  /** `YYYY-MM-DD` — the subscription/period start, never a "from–to" (Helsana §4.1). */
  date_begin: string
  /** Price per unit, minor units (Rappen). */
  unit_minor: number
  /** quantity × unit, minor units. */
  amount_minor: number
  /** Percent. */
  vat_rate: number
}

export interface Tarif595Party {
  companyname: string
  postal: StructuredPostal
  phone?: string | null
  email?: string | null
}

export interface Tarif595Person {
  familyname: string
  givenname: string
  postal: StructuredPostal
  email?: string | null
}

export interface Tarif595FileRef {
  path: string
  sha256: string
  bytes: number
}

export type Tarif595ReceiptStatus = 'pending' | 'issued' | 'voided'

/** The frozen snapshot. Everything the XML and the PDF need is IN the document,
 *  so a re-render after a crash (status `pending`) produces the same bytes and
 *  a later change to the config or the contact never alters an issued receipt. */
export interface Tarif595ReceiptDoc {
  id: string
  teamId: string
  contact_id: string
  number: string
  revision: number
  replaces: string | null
  source: Tarif595Source
  source_key: string
  status: Tarif595ReceiptStatus
  period: { from: string; to: string }
  lines: Tarif595Line[]
  totals: { amount_minor: number; vat_minor: number }
  language: Tarif595Lang
  modus: 'production' | 'test'
  canton: SwissCanton
  biller: Tarif595Party & { gln: string; zsr: string }
  provider: Tarif595Party & { gln: string; gln_location: string; zsr: string | null; uid: string | null }
  iban: string
  vat_number: string | null
  patient: Tarif595Person & {
    gender: 'male' | 'female' | 'diverse'
    sex: 'male' | 'female'
    birthdate: string
    ssn: string
    salutation: string | null
  }
  guarantor: Tarif595Person
  insurer: { gln: string; name: string | null } | null
  insured_number: string | null
  /** 32 hex — `request@guid`. Frozen at allocation so a resume re-renders identically. */
  guid: string
  request_timestamp: number
  /** `YYYY-MM-DD` issue date. */
  request_date: string
  files: { pdf: Tarif595FileRef; xml: Tarif595FileRef } | null
  delivery: { send_count: number; emailed_at: Timestamp | null }
  created_at: Timestamp
  created_by: string
  issued_at?: Timestamp | null
  voided_at?: Timestamp | null
  voided_by?: string | null
  void_reason?: string | null
}

// ─── Identifier checks ────────────────────────────────────────────────────────

/** GS1 mod-10 check digit (weights 3,1,3,… from the right of the payload). GLNs
 *  and the AHVN13 both use it. */
function gs1CheckDigitOk(digits: string): boolean {
  const body = digits.slice(0, -1)
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48
    sum += i % 2 === 0 ? d * 3 : d
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1])
}

export function isValidGln(raw: string): boolean {
  const s = (raw ?? '').trim()
  return /^[0-9]{13}$/.test(s) && gs1CheckDigitOk(s)
}

/** `zsrPartyType`: one upper-case letter + six digits. */
export function isValidZsr(raw: string): boolean {
  return /^[A-Z][0-9]{6}$/.test((raw ?? '').trim())
}

export function normalizeAhv(raw: string): string {
  return (raw ?? '').replace(/[^0-9]/g, '')
}

/** AHVN13: `756` + 10 digits, EAN-13 check. The standard's unknown-SSN
 *  placeholder (7569999999991) passes the arithmetic on purpose — refusing it
 *  is a policy decision the issue path makes, not this check. */
export function isValidAhv(raw: string): boolean {
  const s = normalizeAhv(raw)
  return /^756[0-9]{10}$/.test(s) && gs1CheckDigitOk(s)
}

/** Print layout `756.1234.5678.97`. */
export function formatAhv(raw: string): string {
  const s = normalizeAhv(raw)
  if (s.length !== 13) return raw
  return `${s.slice(0, 3)}.${s.slice(3, 7)}.${s.slice(7, 11)}.${s.slice(11)}`
}

export function formatTarif595Number(prefix: string, year: string | number, n: number): string {
  return `${prefix}-${year}-${String(n).padStart(5, '0')}`
}

// ─── Config validation ────────────────────────────────────────────────────────

export type Tarif595ConfigIssueCode =
  | 'required'
  | 'pattern'
  | 'checksum'
  | 'length'
  | 'unknown_position'
  | 'no_offerings'

export interface Tarif595ConfigIssue {
  path: string
  code: Tarif595ConfigIssueCode
}

export interface Tarif595ConfigValidationContext {
  /** Is `code` a position of the list at all (any validity)? Injected so this
   *  module does not import the data table. */
  positionExists: (code: string) => boolean
}

const PREFIX_RE = /^[A-Z0-9]{1,10}$/

export function validateTarif595Config(
  config: Partial<Tarif595Config> | null | undefined,
  ctx: Tarif595ConfigValidationContext
): Tarif595ConfigIssue[] {
  const issues: Tarif595ConfigIssue[] = []
  const c = config ?? {}
  if (c.language !== 'de' && c.language !== 'fr' && c.language !== 'it') {
    issues.push({ path: 'language', code: 'required' })
  }
  if (!c.biller?.gln) issues.push({ path: 'biller.gln', code: 'required' })
  else if (!isValidGln(c.biller.gln)) issues.push({ path: 'biller.gln', code: 'checksum' })
  if (!c.biller?.zsr) issues.push({ path: 'biller.zsr', code: 'required' })
  else if (!isValidZsr(c.biller.zsr)) issues.push({ path: 'biller.zsr', code: 'pattern' })
  if (!c.provider?.gln) issues.push({ path: 'provider.gln', code: 'required' })
  else if (!isValidGln(c.provider.gln)) issues.push({ path: 'provider.gln', code: 'checksum' })
  if (!c.provider?.gln_location) issues.push({ path: 'provider.gln_location', code: 'required' })
  else if (!isValidGln(c.provider.gln_location)) {
    issues.push({ path: 'provider.gln_location', code: 'checksum' })
  }
  if (c.provider?.zsr && !isValidZsr(c.provider.zsr)) issues.push({ path: 'provider.zsr', code: 'pattern' })
  if (!c.numbering?.prefix) issues.push({ path: 'numbering.prefix', code: 'required' })
  else if (!PREFIX_RE.test(c.numbering.prefix)) issues.push({ path: 'numbering.prefix', code: 'pattern' })
  const offerings = c.offerings ?? {}
  const keys = Object.keys(offerings)
  if (keys.length === 0) issues.push({ path: 'offerings', code: 'no_offerings' })
  for (const key of keys) {
    const m = offerings[key]
    if (!parseTarif595OfferingKey(key)) {
      issues.push({ path: `offerings.${key}`, code: 'pattern' })
      continue
    }
    if (!m?.position) issues.push({ path: `offerings.${key}.position`, code: 'required' })
    else if (!ctx.positionExists(m.position)) {
      issues.push({ path: `offerings.${key}.position`, code: 'unknown_position' })
    }
    if (!m?.unit) issues.push({ path: `offerings.${key}.unit`, code: 'required' })
    if (m?.unit === 'entry' && !(typeof m.entries === 'number' && m.entries > 0)) {
      issues.push({ path: `offerings.${key}.entries`, code: 'required' })
    }
    if (m?.ptPosition && !ctx.positionExists(m.ptPosition)) {
      issues.push({ path: `offerings.${key}.ptPosition`, code: 'unknown_position' })
    }
    if (m?.position === TARIF595_FREE_TEXT_CODE && !m.customName?.trim()) {
      issues.push({ path: `offerings.${key}.customName`, code: 'required' })
    }
  }
  return issues
}

/** The `gender`/`sex` pair the XML wants, from the contact's stored gender and
 *  the plugin's override. `null` when no sex can be derived — a blocking warning. */
export function tarif595GenderSex(
  gender: 'M' | 'F' | 'other' | null | undefined,
  sexOverride: 'male' | 'female' | null | undefined
): { gender: 'male' | 'female' | 'diverse'; sex: 'male' | 'female' } | null {
  if (gender === 'M') return { gender: 'male', sex: sexOverride ?? 'male' }
  if (gender === 'F') return { gender: 'female', sex: sexOverride ?? 'female' }
  if (sexOverride) return { gender: 'diverse', sex: sexOverride }
  return null
}

// ─── Callable contracts ───────────────────────────────────────────────────────
// Shared by apps/web (typed httpsCallable wrappers) and packages/functions (the
// implementations), so neither side can drift from the other.

export interface Tarif595ReceiptRequest {
  teamId: string
  contactId: string
  source: Tarif595Source
  /** YYYY-MM-DD, inclusive. */
  from: string
  to: string
  /** Price per unit (per month / lesson / entry), minor units — only needed
   *  where the records carry none (an attendance receipt); a subscription's
   *  price comes from its history row, a course's from its purchase. */
  unitPriceMinor?: number | null
}

/** Refusals — the server's, not hints: `issue` refuses on any of them. */
export type Tarif595BlockingCode =
  | 'plugin_config_incomplete'
  | 'legal_profile_incomplete'
  | 'offering_unmapped'
  | 'source_not_found'
  | 'period_invalid'
  | 'contact_not_found'
  | 'contact_birthdate_missing'
  | 'contact_sex_unknown'
  | 'contact_address_incomplete'
  | 'contact_ahv_missing'
  | 'contact_ahv_invalid'
  | 'position_invalid_on_date'
  | 'no_lines'
  | 'already_issued'

/** Advisories — shown, never refused on. */
export type Tarif595WarningCode =
  | 'overlapping_receipt'
  | 'attendance_truncated'
  | 'insured_number_missing'
  | 'insurer_unknown'
  | 'unit_price_zero'

export interface Tarif595PreviewIssue {
  code: Tarif595BlockingCode
  /** Free detail for the UI (an offering key, a position code, a receipt number). */
  detail?: string | null
}

export interface Tarif595PreviewWarning {
  code: Tarif595WarningCode
  detail?: string | null
}

export interface Tarif595PreviewDraft {
  period: { from: string; to: string }
  lines: Tarif595Line[]
  totals: { amount_minor: number; vat_minor: number }
  language: Tarif595Lang
  /** The receipt id this issue would create (deterministic). */
  receiptId: string
  revision: number
  replaces: string | null
}

export interface Tarif595PreviewResult {
  ok: boolean
  blocking: Tarif595PreviewIssue[]
  warnings: Tarif595PreviewWarning[]
  draft: Tarif595PreviewDraft | null
  /** When the same source/period is already issued (or pending): what to offer instead. */
  existing: { receiptId: string; number: string; status: Tarif595ReceiptStatus } | null
}

export interface Tarif595IssueRequest extends Tarif595ReceiptRequest {
  /** Also email the PDF + XML to the contact right away. */
  email?: boolean
}

export interface Tarif595IssueResult {
  receiptId: string
  number: string
  status: Tarif595ReceiptStatus
  /** True when a crashed earlier attempt (status pending) was completed instead of a new allocation. */
  resumed: boolean
  emailed: boolean
}

export interface Tarif595VoidRequest {
  teamId: string
  receiptId: string
  reason?: string | null
}

export interface Tarif595DownloadRequest {
  teamId: string
  receiptId: string
  kind: 'pdf' | 'xml'
}

export interface Tarif595DownloadResult {
  filename: string
  contentType: string
  /** The bytes, base64 — callable responses are JSON. */
  base64: string
  bytes: number
}

export interface Tarif595EmailRequest {
  teamId: string
  receiptId: string
  /** Defaults to the contact's email. */
  to?: string | null
}

export interface Tarif595EmailResult {
  sent: boolean
  send_count: number
}
