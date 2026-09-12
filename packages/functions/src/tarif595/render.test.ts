import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { attendanceReceipt, monthlyReceipt } from './fixtures/receipts'
import { QR_CODES_PER_PAGE, chDate, chf, identificationLine, renderTarif595Pdf } from './render'
import { buildQrSheetChunks } from './qrSheet'
import { buildTarif595Xml } from './xml'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length

describe('tarif595 render — the three-sheet PDF', function () {
  this.timeout(20_000)

  it('is a PDF with the invoice sheet, the form and the QR pages, and renders identically twice', async () => {
    const r = monthlyReceipt()
    const xml = buildTarif595Xml(r)
    const pdf = await renderTarif595Pdf(r, xml)
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-')
    const qrPages = Math.ceil(buildQrSheetChunks(xml).length / QR_CODES_PER_PAGE)
    assert.equal(pageCount(pdf), 2 + qrPages)
    const again = await renderTarif595Pdf(r, xml)
    assert.equal(sha(again), sha(pdf), 'a resume after a crash must re-render byte-identical files')
  })

  it('renders the VAT-registered attendance receipt in every language', async () => {
    for (const language of ['de', 'fr', 'it'] as const) {
      const r = { ...attendanceReceipt(), language }
      const pdf = await renderTarif595Pdf(r, buildTarif595Xml(r))
      assert.ok(pdf.length > 10_000, language)
    }
  })

  it('formats money and dates the Swiss way', () => {
    assert.equal(chf(106800), "1'068.00")
    assert.equal(chf(5), '0.05')
    assert.equal(chDate('2027-01-15'), '15.01.2027')
    assert.match(identificationLine(monthlyReceipt()), /^1800000000 \/ \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} \/ f9f999ea1a3c404aa64a04327fc0aab2$/)
  })
})
