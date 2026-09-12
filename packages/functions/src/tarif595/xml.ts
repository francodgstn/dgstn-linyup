// Tarif 595 — the XML 5.0 `generalInvoiceRequest` builder. PURE and
// deterministic: everything it prints is in the frozen receipt snapshot
// (guid, request_timestamp, party blocks, lines), so a re-render after a crash
// produces byte-identical output and the sha256 on the receipt stays honest.
//
// Element order follows generalInvoiceRequest_500.xsd (fixtures/), which is a
// `sequence` at every level — reorder nothing. Facts the shape rests on, each
// verified against the XSD, its CHM reference docs, and the Helsana Wegleitung
// (docs/tarif-595.md → "The document"):
//
//   • Tiers Garant only; `body@role="other" @place="company"`; `law@type="VVG"`;
//     `treatment@reason="prevention"` always, `@treatment="ambulatory"`.
//   • `transport@to` is the insurer's GLN when known, else the schema's own
//     non-recipient constant — a paper receipt has no electronic recipient.
//   • `debitor@gln` is required; the CHM names a pseudo GLN for a private person.
//   • `patient@ssn` is required — the AHV number, in digits (the print layout
//     with dots is the PDF's job, not this file's).
//   • The member has already paid: `balance@amount_prepaid = amount`,
//     `amount_due = 0`, and the mandatory pay-in-slip element is `esrQRRed` in
//     its `esrQRRedplus` ("without amount") form.
//   • Lines are `service` (not `service_ex`, the TARDOC mt/tt split):
//     `unit_factor="1"` ("TPW AL entspricht dem Standardwert 1"), amounts with
//     two decimals, `date_begin` a dateTime at midnight.
//
// No XML library: the document is small, the vocabulary is fixed, and a
// hand-built string with one escaper is auditable against the schema line by
// line. `buildTarif595Xml` returns UTF-8 bytes because the QR sheet compresses
// exactly these bytes.

import {
  TARIF595_TARIFF_TYPE,
  XML50_GLN_NO_RECIPIENT,
  XML50_GLN_PRIVATE_DEBITOR,
  type StructuredPostal,
  type Tarif595Party,
  type Tarif595Person,
  type Tarif595ReceiptDoc,
} from '@linyup/shared'

export const XML50_NAMESPACE = 'http://www.forum-datenaustausch.ch/invoice'
export const XML50_SCHEMA_FILE = 'generalInvoiceRequest_500.xsd'
/** `prolog/generator@name` (≤ 50 chars) and `@version` (100·major + minor). */
export const TARIF595_GENERATOR_NAME = 'Linyup Tarif 595'
export const TARIF595_GENERATOR_VERSION = 100

export function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Two decimals, dot, no grouping — `double` in the schema, money by convention. */
export function xmlMoney(minor: number): string {
  return (minor / 100).toFixed(2)
}

function xmlDateTime(dateIso: string): string {
  return `${dateIso}T00:00:00`
}

/** Schema string types are bounded (`stringType1_35` etc.); a value that is
 *  longer is cut rather than rejected, because the snapshot is already frozen
 *  and a name that overflows must still print. */
function cut(value: string, max: number): string {
  const v = value.trim()
  return v.length > max ? v.slice(0, max) : v
}

function postalXml(p: StructuredPostal): string {
  const street = cut(`${p.street_name} ${p.house_no}`.trim(), 35)
  const parts = [
    `<invoice:street street_name="${esc(cut(p.street_name, 35))}" house_no="${esc(cut(p.house_no, 10))}">${esc(street)}</invoice:street>`,
    `<invoice:zip>${esc(cut(p.zip, 9))}</invoice:zip>`,
    `<invoice:city>${esc(cut(p.city, 35))}</invoice:city>`,
  ]
  if (p.country && p.country !== 'CH') {
    parts.push(`<invoice:country country_code="${esc(p.country)}">${esc(p.country)}</invoice:country>`)
  }
  return `<invoice:postal>${parts.join('')}</invoice:postal>`
}

function companyXml(party: Tarif595Party): string {
  const parts = [`<invoice:companyname>${esc(cut(party.companyname, 35))}</invoice:companyname>`, postalXml(party.postal)]
  if (party.phone) parts.push(`<invoice:telecom><invoice:phone>${esc(cut(party.phone, 25))}</invoice:phone></invoice:telecom>`)
  if (party.email) parts.push(`<invoice:online><invoice:email>${esc(cut(party.email, 80))}</invoice:email></invoice:online>`)
  return `<invoice:company>${parts.join('')}</invoice:company>`
}

function personXml(person: Tarif595Person, salutation?: string | null): string {
  const attrs = salutation ? ` salutation="${esc(cut(salutation, 35))}"` : ''
  const parts = [
    `<invoice:familyname>${esc(cut(person.familyname, 35))}</invoice:familyname>`,
    `<invoice:givenname>${esc(cut(person.givenname, 35))}</invoice:givenname>`,
    postalXml(person.postal),
  ]
  if (person.email) parts.push(`<invoice:online><invoice:email>${esc(cut(person.email, 80))}</invoice:email></invoice:online>`)
  return `<invoice:person${attrs}>${parts.join('')}</invoice:person>`
}

export function buildTarif595XmlString(r: Tarif595ReceiptDoc): string {
  const transportTo = r.insurer?.gln ?? XML50_GLN_NO_RECIPIENT
  // The optional `insurance` element wants a full company address, which the
  // studio never holds; the insurer's GLN travels in `transport@to` (and on the
  // printed form) instead. Omitting the element is what the TG schema allows.
  const insurance = ''
  const lawAttrs = r.insured_number ? ` insured_id="${esc(cut(r.insured_number, 35))}"` : ''
  const vatRates = new Map<number, { amount: number; vat: number }>()
  for (const l of r.lines) {
    const acc = vatRates.get(l.vat_rate) ?? { amount: 0, vat: 0 }
    acc.amount += l.amount_minor
    vatRates.set(l.vat_rate, acc)
  }
  // One rounding per rate group, on the summed amount — the same arithmetic as
  // lines.ts' totals, so `vat@vat` and the `vat_rate` rows always add up.
  for (const [rate, acc] of vatRates) {
    acc.vat = rate > 0 ? Math.round((acc.amount * rate) / (100 + rate)) : 0
  }
  if (vatRates.size === 0) vatRates.set(0, { amount: 0, vat: 0 })
  const vatRateXml = [...vatRates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, v]) => `<invoice:vat_rate vat_rate="${rate}" amount="${xmlMoney(v.amount)}" vat="${xmlMoney(v.vat)}"/>`)
    .join('')
  const vatNumber = r.vat_number ? ` vat_number="${esc(r.vat_number)}"` : ''
  const providerUid = r.provider.uid ? ` uid="${esc(r.provider.uid)}"` : ''
  const providerZsr = r.provider.zsr
    ? `<invoice:provider_zsr zsr="${esc(r.provider.zsr)}">${companyXml(r.provider)}</invoice:provider_zsr>`
    : ''

  const services = r.lines
    .map(
      (l) =>
        `<invoice:service record_id="${l.record_id}" tariff_type="${TARIF595_TARIFF_TYPE}" code="${esc(l.code)}" name="${esc(
          cut(l.name, 350)
        )}" session="1" quantity="${l.quantity}" date_begin="${xmlDateTime(l.date_begin)}" provider_id="${esc(
          r.provider.gln
        )}" responsible_id="${esc(r.provider.gln)}" unit="${xmlMoney(l.unit_minor)}" unit_factor="1" amount="${xmlMoney(
          l.amount_minor
        )}" vat_rate="${l.vat_rate}"/>`
    )
    .join('')

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<invoice:request xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:invoice="${XML50_NAMESPACE}" xsi:schemaLocation="${XML50_NAMESPACE} ${XML50_SCHEMA_FILE}" language="${r.language}" modus="${r.modus}" guid="${esc(r.guid)}">` +
    `<invoice:processing><invoice:transport from="${esc(r.biller.gln)}" to="${esc(transportTo)}"/></invoice:processing>` +
    `<invoice:payload request_type="invoice" request_subtype="normal">` +
    `<invoice:invoice request_timestamp="${r.request_timestamp}" request_date="${xmlDateTime(r.request_date)}" request_id="${esc(r.number)}"/>` +
    `<invoice:body role="other" place="company">` +
    `<invoice:prolog><invoice:generator name="${TARIF595_GENERATOR_NAME}" version="${TARIF595_GENERATOR_VERSION}"/></invoice:prolog>` +
    `<invoice:tiers_garant>` +
    `<invoice:billers>` +
    `<invoice:biller_gln gln="${esc(r.biller.gln)}">${companyXml(r.biller)}</invoice:biller_gln>` +
    `<invoice:biller_zsr zsr="${esc(r.biller.zsr)}">${companyXml(r.biller)}</invoice:biller_zsr>` +
    `</invoice:billers>` +
    `<invoice:debitor gln="${XML50_GLN_PRIVATE_DEBITOR}">${personXml(r.guarantor)}</invoice:debitor>` +
    `<invoice:providers>` +
    `<invoice:provider_gln gln="${esc(r.provider.gln)}" gln_location="${esc(r.provider.gln_location)}"${providerUid}>${companyXml(r.provider)}</invoice:provider_gln>` +
    providerZsr +
    `</invoice:providers>` +
    insurance +
    `<invoice:patient gender="${r.patient.gender}" sex="${r.patient.sex}" birthdate="${esc(r.patient.birthdate)}" ssn="${esc(r.patient.ssn)}">${personXml(r.patient, r.patient.salutation)}</invoice:patient>` +
    `<invoice:guarantor>${personXml(r.guarantor)}</invoice:guarantor>` +
    `<invoice:partners/>` +
    `<invoice:balance currency="CHF" amount="${xmlMoney(r.totals.amount_minor)}" amount_prepaid="${xmlMoney(r.totals.amount_minor)}" amount_due="0.00">` +
    `<invoice:vat vat="${xmlMoney(r.totals.vat_minor)}"${vatNumber}>${vatRateXml}</invoice:vat>` +
    `</invoice:balance>` +
    `</invoice:tiers_garant>` +
    `<invoice:esrQRRed subtype="esrQRRedplus" iban="${esc(r.iban)}"><invoice:creditor>${companyXml(r.biller)}</invoice:creditor></invoice:esrQRRed>` +
    `<invoice:law type="VVG"${lawAttrs}/>` +
    `<invoice:treatment date_begin="${esc(r.period.from)}" date_end="${esc(r.period.to)}" canton="${esc(r.canton)}" treatment="ambulatory" reason="prevention"/>` +
    `<invoice:services>${services}</invoice:services>` +
    `</invoice:body>` +
    `</invoice:payload>` +
    `</invoice:request>`
  )
}

export function buildTarif595Xml(r: Tarif595ReceiptDoc): Buffer {
  return Buffer.from(buildTarif595XmlString(r), 'utf8')
}
