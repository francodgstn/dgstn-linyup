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

  it('is a PDF with the invoice sheet, the form and the QR pages, and re-renders byte-identically', async () => {
    const r = monthlyReceipt()
    const xml = buildTarif595Xml(r)
    const pdf = await renderTarif595Pdf(r, xml)
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-')
    const qrPages = Math.ceil(buildQrSheetChunks(xml).length / QR_CODES_PER_PAGE)
    assert.equal(pageCount(pdf), 2 + qrPages)
    // SEVERAL renders, not two. Comparing exactly two SAMPLES the race this
    // guards — at the rate it actually occurred (about one pair in twelve) a
    // two-render check passed locally, passed most CI runs, and failed the one
    // that mattered. Cheap: a render is ~40ms.
    for (let i = 0; i < 6; i++) {
      const again = await renderTarif595Pdf(r, xml)
      assert.equal(sha(again), sha(pdf), 'a resume after a crash must re-render byte-identical files')
    }
  })

  it('embeds the QR images with NO alpha channel — no /SMask', async () => {
    // THE DETERMINISTIC GUARD for the race above, and the reason it is worth a
    // second test: the fix is one option (`rendererOpts: { colorType: 2 }`)
    // travelling through qrcode → pngjs → PDFKit. If any link in that chain
    // stops honouring it the alpha channel returns, PDFKit goes back to
    // embedding each image through an async `splitAlphaChannel` decode, and the
    // object order races again — while the repeat check above would only catch
    // it sometimes.
    //
    // An alpha channel shows up as an /SMask entry per image (and doubles the
    // image objects, since each mask is its own XObject), so its ABSENCE is the
    // exact signature of the fix still working. Verified by removing the option:
    // /SMask appears and the image count goes 2 → 4.
    const r = monthlyReceipt()
    const pdf = await renderTarif595Pdf(r, buildTarif595Xml(r))
    assert.doesNotMatch(
      pdf.toString('latin1'),
      /\/SMask/,
      'an alpha channel is back in the QR PNGs — PDFKit will embed them asynchronously and two renders can differ',
    )
  })

  // The twice-render above only catches nondeterminism when the timing happens
  // to go wrong, so a regression would come back as a flake, not a failure.
  // This pins the cause structurally: PDFKit decodes a PNG WITH an alpha
  // channel asynchronously and writes the image and its /SMask in callback
  // order (see drawQrSheet in render.ts). No soft mask means no alpha, which
  // means the synchronous embed path.
  it('embeds its QR images without an alpha channel, so the object order is the call order', async () => {
    const r = monthlyReceipt()
    const text = (await renderTarif595Pdf(r, buildTarif595Xml(r))).toString('latin1')
    assert.ok(/\/Subtype\s*\/Image/.test(text), 'the QR sheet embeds its codes as images')
    assert.doesNotMatch(text, /\/SMask/, 'an image with an alpha channel is embedded asynchronously and lands in decode order')
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
