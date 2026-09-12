// The ONE PDFKit document factory the shared PDF rail builds on — the Tarif
// 595 receipt today, the Swiss QR-bill invoice next. It owns page setup (A4,
// 40pt margins, Helvetica) and the two layout primitives a renderer reaches
// for before it ever needs anything bespoke: a label/value grid and a
// paginating table. Nothing here knows about tariffs, positions or invoice
// line items — extend the caller, not this file.
//
// DETERMINISM. `withPdf` stamps `info.CreationDate`/`info.ModDate` from the
// caller rather than letting PDFKit default to `new Date()`, because PDFKit
// derives the file's `/ID` trailer entry from `info` at construction time
// (`PDFSecurity.generateFileID`, hashing `info.CreationDate.getTime()` plus
// every other info key). Two renders of the same content at the same
// `creationDate` are therefore byte-identical — which is what lets a receipt
// re-render after a crash keep the sha256 it already told an insurer about.

import PDFDocument from 'pdfkit'

export const PDF_FONT = 'Helvetica'
export const PDF_FONT_BOLD = 'Helvetica-Bold'

/** A4 in points (72dpi) — the size PDFKit's own `'A4'` preset resolves to,
 *  named here so a caller doing manual layout math never re-derives it. */
export const A4 = { width: 595.28, height: 841.89 }

export interface WithPdfOptions {
  /** Stamped as info.CreationDate AND info.ModDate — see the module header
   *  for why this is what makes two renders byte-identical. */
  creationDate: Date
  title?: string
  /** Tagged-PDF `/Lang` entry; display/accessibility metadata only, no layout
   *  effect. */
  language?: string
}

/**
 * Builds a PDF via PDFKit and collects the whole stream into a Buffer.
 * `build` receives the live document — draw into it, return (or resolve)
 * when done. `withPdf` calls `doc.end()` and resolves once the stream has
 * fully drained.
 */
export async function withPdf(
  build: (doc: PDFKit.PDFDocument) => void | Promise<void>,
  opts: WithPdfOptions
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    autoFirstPage: true,
    lang: opts.language,
    info: {
      Producer: 'Linyup',
      Creator: 'Linyup',
      CreationDate: opts.creationDate,
      ModDate: opts.creationDate,
      ...(opts.title ? { Title: opts.title } : {}),
    },
  })

  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  await build(doc)
  doc.end()
  return done
}

export interface KeyValueGridOptions {
  /** Width of the label column, points. */
  labelWidth?: number
  /** Width of the value column, points. */
  valueWidth?: number
  /** Vertical distance between rows, points. */
  lineHeight?: number
  fontSize?: number
  labelFont?: string
  valueFont?: string
}

/**
 * A simple two-column label/value grid — the shape every receipt and invoice
 * header uses for "Biller / Provider / Patient" style blocks. Draws top to
 * bottom from `(x, y)` and returns the y position immediately below the last
 * row, so a caller can keep laying out underneath it.
 */
export function drawKeyValueGrid(
  doc: PDFKit.PDFDocument,
  rows: ReadonlyArray<[string, string]>,
  x: number,
  y: number,
  opts: KeyValueGridOptions = {}
): number {
  const fontSize = opts.fontSize ?? 9
  const lineHeight = opts.lineHeight ?? fontSize + 4
  const labelWidth = opts.labelWidth ?? 140
  const valueWidth = opts.valueWidth ?? 300
  let cursor = y
  for (const [label, value] of rows) {
    doc
      .font(opts.labelFont ?? PDF_FONT_BOLD)
      .fontSize(fontSize)
      .text(label, x, cursor, { width: labelWidth })
    doc
      .font(opts.valueFont ?? PDF_FONT)
      .fontSize(fontSize)
      .text(value, x + labelWidth, cursor, { width: valueWidth })
    cursor += lineHeight
  }
  return cursor
}

export interface TableColumn {
  header: string
  /** Column width, points. */
  width: number
  align?: 'left' | 'center' | 'right'
}

export interface DrawTableOptions {
  x: number
  y: number
  columns: ReadonlyArray<TableColumn>
  rows: ReadonlyArray<ReadonlyArray<string>>
  fontSize?: number
  headerFontSize?: number
  /** Row height, points. Defaults to `fontSize + 8`. */
  rowHeight?: number
  headerHeight?: number
}

/**
 * A left-to-right column table that PAGINATES: a row that would cross the
 * page's bottom margin starts a fresh page first, with the header repeated at
 * its top — the print convention for anything long enough to run past one
 * sheet (a receipt with many attendance lines, an invoice with many items).
 * Returns the y position immediately below the last row drawn.
 */
export function drawTable(doc: PDFKit.PDFDocument, options: DrawTableOptions): number {
  const fontSize = options.fontSize ?? 9
  const headerFontSize = options.headerFontSize ?? fontSize
  const rowHeight = options.rowHeight ?? fontSize + 8
  const headerHeight = options.headerHeight ?? rowHeight
  const bottomLimit = doc.page.height - doc.page.margins.bottom

  const drawHeader = (headerY: number): number => {
    doc.font(PDF_FONT_BOLD).fontSize(headerFontSize)
    let cx = options.x
    for (const col of options.columns) {
      doc.text(col.header, cx, headerY, { width: col.width, align: col.align ?? 'left' })
      cx += col.width
    }
    return headerY + headerHeight
  }

  let cursorY = drawHeader(options.y)

  for (const row of options.rows) {
    if (cursorY + rowHeight > bottomLimit) {
      doc.addPage()
      cursorY = drawHeader(doc.page.margins.top)
    }
    doc.font(PDF_FONT).fontSize(fontSize)
    let cx = options.x
    for (let i = 0; i < options.columns.length; i++) {
      const col = options.columns[i]
      doc.text(row[i] ?? '', cx, cursorY, { width: col.width, align: col.align ?? 'left' })
      cx += col.width
    }
    cursorY += rowHeight
  }
  return cursorY
}
