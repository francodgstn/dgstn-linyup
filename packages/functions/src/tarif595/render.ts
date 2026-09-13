// Tarif 595 — the PDF: three sheets, drawn on the shared pdf/ rail.
//
//   1. Patientenrechnung — the member's own invoice page with a Swiss QR-bill
//      payment part WITHOUT amount (the member has already paid; the XML says
//      amount_due 0 and esrQRRedplus).
//   2. Rückforderungsbeleg — the reimbursement form the insurer reads: the
//      header grid (patient incl. AHV number in print layout, insurer GLN,
//      Vergütungsart TG, Gesetz VVG, treatment period, Behandlungsart /
//      -grund, Rolle/Ort), biller GLN(B)/ZSR(B), provider GLN(P)/GLN(L)/ZSR(P),
//      then the line table and the totals/VAT block (template DetailG).
//   3+. QR-Code Blatt — the XML in ≤ 12 QR codes (qrSheet.ts), six per page,
//      numbered "QR-Code n" (template Annex).
//
// DETERMINISTIC: takes the frozen receipt + the XML bytes and nothing else;
// the PDF's own timestamps come from `request_timestamp`, so a resume after a
// crash re-renders byte-identical output. Labels are server-side text in the
// receipt's language (the XML allows de/fr/it only) — not next-intl, which
// never runs here. The wording follows the Forum's print templates.

import QRCode from 'qrcode'
import { formatAhv, formatIban, formatVatNumber, type Tarif595Lang, type Tarif595ReceiptDoc } from '@linyup/shared'
import { A4, PDF_FONT, PDF_FONT_BOLD, drawKeyValueGrid, drawTable, withPdf } from '../pdf/document'
import { attachQrBill } from '../pdf/qrBill'
import { buildQrSheetChunks } from './qrSheet'
import { TARIF595_TIMEZONE } from './sources'

const MARGIN = 40
const CONTENT_W = A4.width - 2 * MARGIN

type Labels = Record<
  | 'invoice' | 'reimbursementForm' | 'qrSheet' | 'toInsurer' | 'forYourRecords' | 'identification' | 'patient'
  | 'biller' | 'provider' | 'name' | 'givenname' | 'street' | 'zip' | 'city' | 'birthdate' | 'gender' | 'ahv'
  | 'insuredNumber' | 'insurerGln' | 'canton' | 'copy' | 'no' | 'paymentType' | 'law' | 'treatment' | 'treatmentKind'
  | 'ambulatory' | 'treatmentReason' | 'prevention' | 'rolePlace' | 'rolePlaceValue' | 'invoiceDateNo'
  | 'date' | 'tariff' | 'code' | 'quantity' | 'unitPrice' | 'vat' | 'amount' | 'total' | 'prepaid' | 'due'
  | 'vatNumber' | 'vatRate' | 'vatAmount' | 'period' | 'invoiceNo' | 'invoiceDate' | 'page' | 'qrCode'
  | 'male' | 'female' | 'diverse' | 'paidNote' | 'iban',
  string
>

const LABELS: Record<Tarif595Lang, Labels> = {
  de: {
    invoice: 'Patientenrechnung mit QR-Code', reimbursementForm: 'Rückforderungsbeleg', qrSheet: 'Rückforderungsbeleg QR-Code Blatt',
    toInsurer: 'Der Versicherung zustellen', forYourRecords: 'Für Ihre Unterlagen', identification: 'Identifikation',
    patient: 'PatientIn', biller: 'RechnungsstellerIn', provider: 'LeistungserbringerIn', name: 'Name', givenname: 'Vorname',
    street: 'Strasse', zip: 'PLZ', city: 'Ort', birthdate: 'Geburtsdatum', gender: 'Geschlecht', ahv: 'AHV-Nr.',
    insuredNumber: 'Versicherten-Nr.', insurerGln: 'GLN-Nr. Versicherer', canton: 'Kanton', copy: 'Kopie', no: 'nein',
    paymentType: 'Vergütungsart', law: 'Gesetz', treatment: 'Behandlung', treatmentKind: 'Behandlungsart', ambulatory: 'ambulant',
    treatmentReason: 'Behandlungsgrund', prevention: 'Prävention', rolePlace: 'Rolle/Ort', rolePlaceValue: 'Andere · Unternehmen',
    invoiceDateNo: 'Rechnungs-Datum/-Nr.', date: 'Datum', tariff: 'Tarif', code: 'Tarifziffer', quantity: 'Anzahl',
    unitPrice: 'Preis', vat: 'MWST', amount: 'Betrag', total: 'Gesamttotal', prepaid: 'Anzahlung / bereits bezahlt',
    due: 'Fälliger Betrag', vatNumber: 'MwSt.-Nummer', vatRate: 'MwSt-Satz/%', vatAmount: 'MwSt/CHF', period: 'Behandlung',
    invoiceNo: 'Rechnungs-Nummer', invoiceDate: 'Rechnungs-Datum', page: 'Seite', qrCode: 'QR-Code', male: 'Herr / M',
    female: 'Frau / F', diverse: 'Divers', paidNote: 'Diese Rechnung ist bereits bezahlt. Reichen Sie den Rückforderungsbeleg und das QR-Code Blatt bei Ihrer Krankenversicherung ein.',
    iban: 'IBAN',
  },
  fr: {
    invoice: 'Facture patient avec code QR', reimbursementForm: 'Justificatif de remboursement', qrSheet: 'Justificatif de remboursement – feuille QR',
    toInsurer: "À remettre à l'assurance", forYourRecords: 'Pour vos dossiers', identification: 'Identification',
    patient: 'Patient·e', biller: 'Facturier', provider: 'Fournisseur de prestations', name: 'Nom', givenname: 'Prénom',
    street: 'Rue', zip: 'NPA', city: 'Localité', birthdate: 'Date de naissance', gender: 'Sexe', ahv: 'N° AVS',
    insuredNumber: "N° d'assuré·e", insurerGln: 'N° GLN assureur', canton: 'Canton', copy: 'Copie', no: 'non',
    paymentType: 'Type de rémunération', law: 'Loi', treatment: 'Traitement', treatmentKind: 'Type de traitement', ambulatory: 'ambulatoire',
    treatmentReason: 'Motif du traitement', prevention: 'Prévention', rolePlace: 'Rôle/Lieu', rolePlaceValue: 'Autre · Entreprise',
    invoiceDateNo: 'Date/N° de facture', date: 'Date', tariff: 'Tarif', code: 'Position', quantity: 'Quantité',
    unitPrice: 'Prix', vat: 'TVA', amount: 'Montant', total: 'Total', prepaid: 'Acompte / déjà payé',
    due: 'Montant dû', vatNumber: 'N° TVA', vatRate: 'Taux TVA/%', vatAmount: 'TVA/CHF', period: 'Traitement',
    invoiceNo: 'N° de facture', invoiceDate: 'Date de facture', page: 'Page', qrCode: 'Code QR', male: 'Monsieur / M',
    female: 'Madame / F', diverse: 'Divers', paidNote: "Cette facture est déjà payée. Remettez le justificatif de remboursement et la feuille QR à votre assurance-maladie.",
    iban: 'IBAN',
  },
  it: {
    invoice: 'Fattura paziente con codice QR', reimbursementForm: 'Giustificativo di rimborso', qrSheet: 'Giustificativo di rimborso – foglio QR',
    toInsurer: "Da inviare all'assicurazione", forYourRecords: 'Per i suoi documenti', identification: 'Identificazione',
    patient: 'Paziente', biller: 'Fatturante', provider: 'Fornitore di prestazioni', name: 'Cognome', givenname: 'Nome',
    street: 'Via', zip: 'NPA', city: 'Località', birthdate: 'Data di nascita', gender: 'Sesso', ahv: 'N. AVS',
    insuredNumber: 'N. assicurato', insurerGln: 'N. GLN assicuratore', canton: 'Cantone', copy: 'Copia', no: 'no',
    paymentType: 'Tipo di rimunerazione', law: 'Legge', treatment: 'Trattamento', treatmentKind: 'Tipo di trattamento', ambulatory: 'ambulatoriale',
    treatmentReason: 'Motivo del trattamento', prevention: 'Prevenzione', rolePlace: 'Ruolo/Luogo', rolePlaceValue: 'Altro · Azienda',
    invoiceDateNo: 'Data/N. fattura', date: 'Data', tariff: 'Tariffa', code: 'Posizione', quantity: 'Quantità',
    unitPrice: 'Prezzo', vat: 'IVA', amount: 'Importo', total: 'Totale', prepaid: 'Acconto / già pagato',
    due: 'Importo dovuto', vatNumber: 'N. IVA', vatRate: 'Aliquota IVA/%', vatAmount: 'IVA/CHF', period: 'Trattamento',
    invoiceNo: 'N. fattura', invoiceDate: 'Data fattura', page: 'Pagina', qrCode: 'Codice QR', male: 'Signor / M',
    female: 'Signora / F', diverse: 'Diverso', paidNote: 'Questa fattura è già stata pagata. Consegni il giustificativo di rimborso e il foglio QR alla sua cassa malati.',
    iban: 'IBAN',
  },
}

export function chf(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'")
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`
}

/** `YYYY-MM-DD` → `DD.MM.YYYY` (the Swiss print layout). */
export function chDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

const STAMP_FMT = new Intl.DateTimeFormat('de-CH', {
  timeZone: TARIF595_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

/** The "Identifikation: {timestamp} / {dd.MM.yyyy HH:mm:ss} / {guid}" line the templates print. */
export function identificationLine(r: Tarif595ReceiptDoc): string {
  const stamp = STAMP_FMT.format(new Date(r.request_timestamp * 1000)).replace(',', '')
  return `${r.request_timestamp} / ${stamp} / ${r.guid}`
}

/** A footer line INSIDE the bottom margin: text placed below `page.maxY()`
 *  makes pdfkit flow onto a fresh page, which is how a blank sheet appears. */
function footer(doc: PDFKit.PDFDocument, text: string): void {
  doc.font(PDF_FONT).fontSize(7).fillColor('#555555')
  doc.text(text, MARGIN, A4.height - MARGIN - 10, { width: CONTENT_W, align: 'right', lineBreak: false })
  doc.fillColor('#000000')
}

function addressLines(name: string, postal: { street_name: string; house_no: string; zip: string; city: string }): string[] {
  return [name, `${postal.street_name} ${postal.house_no}`.trim(), `${postal.zip} ${postal.city}`]
}

function genderLabel(r: Tarif595ReceiptDoc, L: Labels): string {
  return r.patient.gender === 'male' ? L.male : r.patient.gender === 'female' ? L.female : `${L.diverse} / ${r.patient.sex === 'male' ? 'M' : 'F'}`
}

function patientLine(r: Tarif595ReceiptDoc, L: Labels): string {
  const p = r.patient
  const sal = p.salutation ? `${p.salutation} ` : ''
  return `${L.patient}: ${sal}${p.givenname} ${p.familyname} · ${p.postal.street_name} ${p.postal.house_no} · ${p.postal.zip} ${p.postal.city} · ${L.birthdate}: ${chDate(p.birthdate)} · ${L.gender}: ${genderLabel(r, L)}`
}

function sheetHeader(doc: PDFKit.PDFDocument, title: string, release: string, subtitle: string, r: Tarif595ReceiptDoc, L: Labels): number {
  doc.font(PDF_FONT_BOLD).fontSize(14).text(title, MARGIN, MARGIN, { width: CONTENT_W })
  doc.font(PDF_FONT).fontSize(8).fillColor('#555555')
  doc.text(release, MARGIN, MARGIN, { width: CONTENT_W, align: 'right' })
  doc.text(subtitle, MARGIN, MARGIN + 18, { width: CONTENT_W })
  doc.text(`${L.identification}: ${identificationLine(r)}`, MARGIN, MARGIN + 30, { width: CONTENT_W })
  doc.text(patientLine(r, L), MARGIN, MARGIN + 42, { width: CONTENT_W })
  doc.fillColor('#000000')
  const y = MARGIN + 60
  doc.moveTo(MARGIN, y).lineTo(A4.width - MARGIN, y).lineWidth(0.5).stroke()
  return y + 10
}

// ─── Sheet 1: Patientenrechnung ───────────────────────────────────────────────

function drawInvoiceSheet(doc: PDFKit.PDFDocument, r: Tarif595ReceiptDoc, L: Labels): void {
  doc.font(PDF_FONT_BOLD).fontSize(14).text(L.invoice, MARGIN, MARGIN)
  doc.font(PDF_FONT).fontSize(8).fillColor('#555555').text(`Release 5.0/QL/${r.language}`, MARGIN, MARGIN, { width: CONTENT_W, align: 'right' })
  doc.text(L.forYourRecords, MARGIN, MARGIN + 18)
  doc.fillColor('#000000')

  // Biller (left) and patient (right, window position).
  let y = MARGIN + 50
  doc.font(PDF_FONT_BOLD).fontSize(8).text(L.biller, MARGIN, y)
  doc.font(PDF_FONT).fontSize(9)
  const billerLines = [...addressLines(r.biller.companyname, r.biller.postal), r.biller.phone ?? '', r.biller.email ?? ''].filter(Boolean)
  doc.text(billerLines.join('\n'), MARGIN, y + 12, { width: 240 })
  const sal = r.patient.salutation ? `${r.patient.salutation}\n` : ''
  doc.font(PDF_FONT).fontSize(10).text(sal + addressLines(`${r.patient.givenname} ${r.patient.familyname}`, r.patient.postal).join('\n'), 330, y + 12, { width: 220 })
  y += 100

  doc.font(PDF_FONT_BOLD).fontSize(8).text(L.provider, MARGIN, y)
  doc.font(PDF_FONT).fontSize(9).text(addressLines(r.provider.companyname, r.provider.postal).join('\n'), MARGIN, y + 12, { width: 240 })
  y += 60

  const vatLabel = r.vat_number ? formatVatNumber(r.vat_number, r.language) : '—'
  y = drawKeyValueGrid(
    doc,
    [
      [L.invoiceNo, r.number],
      [L.invoiceDate, chDate(r.request_date)],
      [L.period, `${chDate(r.period.from)} - ${chDate(r.period.to)}`],
      [L.vatNumber, vatLabel],
      [L.iban, formatIban(r.iban)],
    ],
    MARGIN,
    y + 8,
    { labelWidth: 130, valueWidth: 380, fontSize: 9 }
  )

  y = drawTable(doc, {
    x: MARGIN,
    y: y + 10,
    columns: [
      { header: L.date, width: 60 },
      { header: L.code, width: 60 },
      { header: '', width: 220 },
      { header: L.quantity, width: 45, align: 'right' },
      { header: L.unitPrice, width: 65, align: 'right' },
      { header: L.amount, width: 65, align: 'right' },
    ],
    rows: r.lines.map((l) => [chDate(l.date_begin), l.code, l.name, String(l.quantity), chf(l.unit_minor), chf(l.amount_minor)]),
    fontSize: 8,
  })

  y = drawKeyValueGrid(
    doc,
    [
      [L.total, `CHF ${chf(r.totals.amount_minor)}`],
      [L.prepaid, `CHF ${chf(r.totals.amount_minor)}`],
      [L.due, 'CHF 0.00'],
    ],
    330,
    y + 8,
    { labelWidth: 130, valueWidth: 95, fontSize: 9, valueFont: PDF_FONT_BOLD }
  )
  doc.font(PDF_FONT).fontSize(8).fillColor('#555555').text(L.paidNote, MARGIN, y + 10, { width: CONTENT_W })
  doc.fillColor('#000000')

  attachQrBill(doc, {
    creditor: { name: r.biller.companyname, postal: r.biller.postal, iban: r.iban },
    debtor: { name: `${r.patient.givenname} ${r.patient.familyname}`, postal: r.patient.postal },
    amountMinor: null,
    documentNumber: r.number,
    message: r.number,
    language: r.language,
  })
}

// ─── Sheet 2: Rückforderungsbeleg ─────────────────────────────────────────────

function drawReimbursementForm(doc: PDFKit.PDFDocument, r: Tarif595ReceiptDoc, L: Labels): void {
  doc.addPage()
  let y = sheetHeader(doc, L.reimbursementForm, `Release 5.0/General/${r.language}`, L.toInsurer, r, L)

  const p = r.patient
  const left: Array<[string, string]> = [
    [L.name, p.familyname],
    [L.givenname, p.givenname],
    [L.street, `${p.postal.street_name} ${p.postal.house_no}`.trim()],
    [L.zip, p.postal.zip],
    [L.city, p.postal.city],
    [L.birthdate, chDate(p.birthdate)],
    [L.gender, genderLabel(r, L)],
    [L.ahv, formatAhv(p.ssn)],
    [L.insuredNumber, r.insured_number ?? ''],
    [L.insurerGln, r.insurer?.gln ?? ''],
    [L.canton, r.canton],
    [L.copy, L.no],
  ]
  const right: Array<[string, string]> = [
    [L.paymentType, 'TG'],
    [L.law, 'VVG'],
    [L.treatment, `${chDate(r.period.from)} - ${chDate(r.period.to)}`],
    [L.treatmentKind, L.ambulatory],
    [L.treatmentReason, L.prevention],
    [L.rolePlace, L.rolePlaceValue],
    [L.invoiceDateNo, `${chDate(r.request_date)} / ${r.number}`],
    ['GLN-Nr. (B)', r.biller.gln],
    ['ZSR-Nr. (B)', r.biller.zsr],
    ['GLN-Nr. (P)', r.provider.gln],
    ['GLN-Nr. (L)', r.provider.gln_location],
    ['ZSR-Nr. (P)', r.provider.zsr ?? ''],
  ]
  doc.font(PDF_FONT_BOLD).fontSize(8).text(L.patient, MARGIN, y)
  const yLeft = drawKeyValueGrid(doc, left, MARGIN, y + 12, { labelWidth: 80, valueWidth: 150, fontSize: 8, lineHeight: 11 })
  const yRight = drawKeyValueGrid(doc, right, 300, y + 12, { labelWidth: 100, valueWidth: 155, fontSize: 8, lineHeight: 11 })
  y = Math.max(yLeft, yRight) + 6
  // The two parties as one line each — the grid above carries the identifiers.
  doc.font(PDF_FONT).fontSize(8)
  doc.text(`${L.biller}: ${addressLines(r.biller.companyname, r.biller.postal).join(' · ')}`, MARGIN, y, { width: CONTENT_W, lineBreak: false })
  doc.text(`${L.provider}: ${addressLines(r.provider.companyname, r.provider.postal).join(' · ')}`, MARGIN, y + 11, { width: CONTENT_W, lineBreak: false })
  y += 30

  y = drawTable(doc, {
    x: MARGIN,
    y,
    columns: [
      { header: L.date, width: 55 },
      { header: L.tariff, width: 35 },
      { header: L.code, width: 50 },
      { header: '', width: 190 },
      { header: L.quantity, width: 40, align: 'right' },
      { header: L.unitPrice, width: 55, align: 'right' },
      { header: L.vat, width: 35, align: 'right' },
      { header: L.amount, width: 55, align: 'right' },
    ],
    rows: r.lines.map((l) => [
      chDate(l.date_begin),
      '595',
      l.code,
      l.name,
      String(l.quantity),
      chf(l.unit_minor),
      l.vat_rate ? String(l.vat_rate) : '0',
      chf(l.amount_minor),
    ]),
    fontSize: 8,
  })

  const vatRows: Array<[string, string]> = []
  if (r.vat_number) {
    vatRows.push([L.vatNumber, formatVatNumber(r.vat_number, r.language)])
    const rates = [...new Set(r.lines.map((l) => l.vat_rate))].sort((a, b) => a - b)
    for (const rate of rates) {
      const amount = r.lines.filter((l) => l.vat_rate === rate).reduce((s, l) => s + l.amount_minor, 0)
      const vat = rate > 0 ? Math.round((amount * rate) / (100 + rate)) : 0
      vatRows.push([`${L.vatRate} ${rate}`, `${chf(amount)} · ${L.vatAmount} ${chf(vat)}`])
    }
  }
  y = drawKeyValueGrid(
    doc,
    [
      ...vatRows,
      [L.total, `CHF ${chf(r.totals.amount_minor)}`],
      [L.prepaid, `CHF ${chf(r.totals.amount_minor)}`],
      [L.due, 'CHF 0.00'],
    ],
    300,
    y + 8,
    { labelWidth: 130, valueWidth: 125, fontSize: 9, valueFont: PDF_FONT_BOLD }
  )
  footer(doc, `${L.reimbursementForm} · ${L.page} 1`)
}

// ─── Sheet 3+: QR-Code Blatt ──────────────────────────────────────────────────

export const QR_CODES_PER_PAGE = 6

async function drawQrSheet(doc: PDFKit.PDFDocument, r: Tarif595ReceiptDoc, chunks: string[], L: Labels): Promise<void> {
  const images = await Promise.all(
    chunks.map((c) => QRCode.toBuffer(c, { errorCorrectionLevel: 'M', type: 'png', margin: 1, scale: 4 }))
  )
  const size = 200
  const colX = [MARGIN + 30, MARGIN + 30 + size + 40]
  const pages = Math.ceil(chunks.length / QR_CODES_PER_PAGE)
  for (let page = 0; page < pages; page++) {
    doc.addPage()
    const top = sheetHeader(doc, L.qrSheet, `Release 5.0/Annex/${r.language}`, L.toInsurer, r, L)
    for (let i = 0; i < QR_CODES_PER_PAGE; i++) {
      const n = page * QR_CODES_PER_PAGE + i
      if (n >= chunks.length) break
      const x = colX[i % 2]
      const y = top + Math.floor(i / 2) * (size + 30)
      doc.font(PDF_FONT_BOLD).fontSize(9).text(`${L.qrCode} ${n + 1}`, x, y, { width: size, align: 'center' })
      doc.image(images[n], x, y + 14, { width: size, height: size })
    }
    footer(doc, `${L.qrSheet} · ${L.page} ${page + 1}/${pages}`)
  }
}

export async function renderTarif595Pdf(r: Tarif595ReceiptDoc, xml: Buffer): Promise<Buffer> {
  const L = LABELS[r.language]
  const chunks = buildQrSheetChunks(xml)
  return withPdf(
    async (doc) => {
      drawInvoiceSheet(doc, r, L)
      drawReimbursementForm(doc, r, L)
      await drawQrSheet(doc, r, chunks, L)
    },
    { creationDate: new Date(r.request_timestamp * 1000), title: `${L.reimbursementForm} ${r.number}`, language: r.language }
  )
}
