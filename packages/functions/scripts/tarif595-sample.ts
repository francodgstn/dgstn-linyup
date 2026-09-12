// Renders the Tarif 595 fixture receipts to PDF + XML files for eyeballing
// against the Forum's print templates (and for handing to an insurer for
// validation). Dev-only; nothing here runs in production.
//
//   pnpm --filter @linyup/functions tarif595:sample [outDir]

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attendanceReceipt, monthlyReceipt } from '../src/tarif595/fixtures/receipts'
import { renderTarif595Pdf } from '../src/tarif595/render'
import { buildTarif595Xml } from '../src/tarif595/xml'

async function main() {
  const out = process.argv[2] ?? join(__dirname, '..', 'tmp', 'tarif595')
  mkdirSync(out, { recursive: true })
  for (const [name, receipt] of [
    ['monthly', monthlyReceipt()],
    ['attendance', attendanceReceipt()],
  ] as const) {
    const xml = buildTarif595Xml(receipt)
    const pdf = await renderTarif595Pdf(receipt, xml)
    writeFileSync(join(out, `${name}.xml`), xml)
    writeFileSync(join(out, `${name}.pdf`), pdf)
    console.log(`${name}: ${pdf.length} bytes → ${join(out, `${name}.pdf`)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
