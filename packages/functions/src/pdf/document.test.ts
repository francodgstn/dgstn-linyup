import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { drawTable, withPdf } from './document'

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

describe('withPdf', () => {
  it('returns a Buffer starting with the PDF magic bytes', async () => {
    const buf = await withPdf(
      (doc) => {
        doc.text('hello')
      },
      { creationDate: new Date('2026-01-01T00:00:00Z') }
    )
    assert.ok(Buffer.isBuffer(buf))
    assert.equal(buf.subarray(0, 4).toString('ascii'), '%PDF')
  })

  it('renders the same content at the same creationDate byte-identically', async () => {
    const creationDate = new Date('2026-03-15T12:00:00Z')
    const build = (doc: PDFKit.PDFDocument) => {
      doc.font('Helvetica').fontSize(12).text('Receipt TAR-2026-00042', 40, 40)
    }
    const first = await withPdf(build, { creationDate, title: 'Receipt' })
    const second = await withPdf(build, { creationDate, title: 'Receipt' })
    assert.equal(sha256(first), sha256(second))
  })

  it('a different creationDate changes the bytes', async () => {
    const build = (doc: PDFKit.PDFDocument) => {
      doc.text('hello')
    }
    const first = await withPdf(build, { creationDate: new Date('2026-01-01T00:00:00Z') })
    const second = await withPdf(build, { creationDate: new Date('2026-01-02T00:00:00Z') })
    assert.notEqual(sha256(first), sha256(second))
  })
})

describe('drawTable', () => {
  it('paginates 80 rows, adding pages as needed', async () => {
    const columns = [
      { header: 'Date', width: 100 },
      { header: 'Description', width: 300 },
      { header: 'Amount', width: 80, align: 'right' as const },
    ]
    const rows = Array.from({ length: 80 }, (_, i) => [`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, `Line ${i + 1}`, '10.00'])

    let pageCount = 0
    await withPdf(
      (doc) => {
        doc.on('pageAdded', () => {
          pageCount += 1
        })
        pageCount += 1 // the autoFirstPage the constructor already added, before this listener attached
        drawTable(doc, { x: 40, y: 40, columns, rows })
      },
      { creationDate: new Date('2026-01-01T00:00:00Z') }
    )
    assert.ok(pageCount > 1, `expected drawTable to add pages for 80 rows, got ${pageCount}`)
  })
})
