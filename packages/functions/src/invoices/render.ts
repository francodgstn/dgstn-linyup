// QR-bill invoice — one A4 sheet on the shared pdf/ rail: creditor block,
// debtor block, number / date / due date, the single line, totals (VAT shown
// when the studio is VAT-registered), the footer text, and the Swiss QR-bill
// payment part at the bottom with the amount SET (this is a claim, unlike the
// Tarif 595 receipt's without-amount slip).
//
// DETERMINISTIC: takes the frozen invoice and nothing else; the PDF's own
// timestamps come from `request_timestamp`, so a resume after a crash renders
// byte-identical bytes. Labels are server-side text in the invoice language.

import { formatVatNumber, type InvoiceDoc, type InvoiceLang } from '@linyup/shared'
import { A4, PDF_FONT, PDF_FONT_BOLD, drawKeyValueGrid, drawTable, withPdf } from '../pdf/document'
import { attachQrBill } from '../pdf/qrBill'
import { chDate, chf } from '../tarif595/render'

const MARGIN = 40
const CONTENT_W = A4.width - 2 * MARGIN

type Labels = Record<
  'invoice' | 'invoiceNo' | 'invoiceDate' | 'dueDate' | 'description' | 'amount' | 'total' | 'vatIncluded' | 'vatNumber' | 'reference' | 'payBy' | 'thanks',
  string
>

const LABELS: Record<InvoiceLang, Labels> = {
  de: { invoice: 'Rechnung', invoiceNo: 'Rechnungs-Nummer', invoiceDate: 'Rechnungs-Datum', dueDate: 'Zahlbar bis', description: 'Bezeichnung', amount: 'Betrag', total: 'Total CHF', vatIncluded: 'davon MWST', vatNumber: 'MwSt.-Nummer', reference: 'Referenz', payBy: 'Bitte begleichen Sie den Betrag bis zum', thanks: 'Vielen Dank.' },
  fr: { invoice: 'Facture', invoiceNo: 'N° de facture', invoiceDate: 'Date de facture', dueDate: 'Payable jusqu’au', description: 'Désignation', amount: 'Montant', total: 'Total CHF', vatIncluded: 'dont TVA', vatNumber: 'N° TVA', reference: 'Référence', payBy: 'Merci de régler le montant d’ici au', thanks: 'Merci beaucoup.' },
  it: { invoice: 'Fattura', invoiceNo: 'N. fattura', invoiceDate: 'Data fattura', dueDate: 'Pagabile entro', description: 'Descrizione', amount: 'Importo', total: 'Totale CHF', vatIncluded: 'di cui IVA', vatNumber: 'N. IVA', reference: 'Riferimento', payBy: 'La preghiamo di saldare l’importo entro il', thanks: 'Grazie mille.' },
  en: { invoice: 'Invoice', invoiceNo: 'Invoice number', invoiceDate: 'Invoice date', dueDate: 'Due by', description: 'Description', amount: 'Amount', total: 'Total CHF', vatIncluded: 'of which VAT', vatNumber: 'VAT number', reference: 'Reference', payBy: 'Please pay the amount by', thanks: 'Thank you.' },
}

function lines(name: string, postal: { street_name: string; house_no: string; zip: string; city: string } | null): string[] {
  return postal ? [name, `${postal.street_name} ${postal.house_no}`.trim(), `${postal.zip} ${postal.city}`] : [name]
}

export async function renderInvoicePdf(inv: InvoiceDoc): Promise<Buffer> {
  const L = LABELS[inv.language]
  return withPdf(
    (doc) => {
      doc.font(PDF_FONT_BOLD).fontSize(16).text(L.invoice, MARGIN, MARGIN)
      doc.font(PDF_FONT).fontSize(9)
      const creditor = [...lines(inv.creditor.legal_name, inv.creditor.postal), inv.creditor.phone ?? '', inv.creditor.email ?? ''].filter(Boolean)
      doc.text(creditor.join('\n'), MARGIN, MARGIN + 30, { width: 240 })
      doc.font(PDF_FONT).fontSize(10)
      doc.text(lines(`${inv.debtor.givenname} ${inv.debtor.familyname}`, inv.debtor.postal).join('\n'), 330, MARGIN + 60, { width: 220 })

      let y = MARGIN + 150
      const meta: Array<[string, string]> = [
        [L.invoiceNo, inv.number],
        [L.invoiceDate, chDate(inv.issued_on)],
        [L.dueDate, chDate(inv.due_on)],
      ]
      if (inv.reference.value) meta.push([L.reference, inv.reference.value])
      if (inv.creditor.vat_number) meta.push([L.vatNumber, formatVatNumber(inv.creditor.vat_number, inv.language)])
      y = drawKeyValueGrid(doc, meta, MARGIN, y, { labelWidth: 130, valueWidth: 380, fontSize: 9 })

      y = drawTable(doc, {
        x: MARGIN,
        y: y + 14,
        columns: [
          { header: L.description, width: 415 },
          { header: L.amount, width: 100, align: 'right' },
        ],
        rows: [[inv.description, chf(inv.amount_minor)]],
        fontSize: 9,
      })

      const totals: Array<[string, string]> = [[L.total, chf(inv.amount_minor)]]
      if (inv.vat_rate > 0) totals.push([`${L.vatIncluded} ${inv.vat_rate}%`, chf(inv.vat_minor)])
      y = drawKeyValueGrid(doc, totals, 300, y + 8, { labelWidth: 130, valueWidth: 125, fontSize: 10, valueFont: PDF_FONT_BOLD })

      doc.font(PDF_FONT).fontSize(9)
      doc.text(`${L.payBy} ${chDate(inv.due_on)}. ${L.thanks}`, MARGIN, y + 16, { width: CONTENT_W })
      if (inv.message) doc.text(inv.message, MARGIN, y + 32, { width: CONTENT_W })
      if (inv.footer_text) doc.fontSize(8).fillColor('#555555').text(inv.footer_text, MARGIN, y + 56, { width: CONTENT_W }).fillColor('#000000')

      attachQrBill(doc, {
        creditor: { name: inv.creditor.legal_name, postal: inv.creditor.postal, iban: inv.creditor.iban, qrIban: inv.creditor.qr_iban },
        debtor: inv.debtor.postal ? { name: `${inv.debtor.givenname} ${inv.debtor.familyname}`, postal: inv.debtor.postal } : null,
        amountMinor: inv.amount_minor,
        documentNumber: inv.number,
        message: inv.message ?? inv.number,
        language: inv.language,
      })
    },
    { creationDate: new Date(inv.request_timestamp * 1000), title: `${L.invoice} ${inv.number}`, language: inv.language }
  )
}
