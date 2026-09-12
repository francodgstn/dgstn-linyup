import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ── THE CENSUS: where the QR-invoices install gate goes ─────────────────────
// Same rule as tarif595/gate.test.ts: creation is gated, consumption of an
// invoice that already exists — download, email, void, mark as paid — is not.
// Marking paid records a payment the studio is owed; gating it would strand a
// member's money behind a plugin toggle. Every onCall in the folder is classified.

const DIR = __dirname
const read = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/\r\n/g, '\n')

function callableBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = onCall`)
  assert.notEqual(start, -1, `callable ${name} not found — was it renamed or removed?`)
  const rest = src.slice(start + 1)
  const next = rest.indexOf('\nexport const ')
  return next === -1 ? rest : rest.slice(0, next)
}

const GATED: Array<[string, string, string]> = [['create.ts', 'createInvoice', 'creating an invoice']]
const UNGATED: Array<[string, string, string]> = [
  ['download.ts', 'downloadInvoice', 'retrieving an invoice already sent'],
  ['void.ts', 'voidInvoice', 'winding down an open invoice'],
  ['email.ts', 'emailInvoice', 're-sending an invoice already issued'],
  ['markPaid.ts', 'markInvoicePaid', 'recording money the studio is owed'],
]

describe('the QR-invoices install gate — creation only', () => {
  for (const [file, name, why] of GATED) {
    it(`${name} IS gated (${why})`, () => {
      assert.ok(/await assertPluginInstalled\(/.test(callableBody(read(file), name)), `${name} does not call assertPluginInstalled`)
    })
  }
  for (const [file, name, why] of UNGATED) {
    it(`${name} is NOT gated (${why})`, () => {
      assert.ok(!/assertPluginInstalled\(/.test(callableBody(read(file), name)), `${name} consumes an existing invoice`)
    })
  }
  it('every callable in the folder is classified and checks the manager role; nothing calls requirePlan', () => {
    const listed = new Set([...GATED, ...UNGATED].map(([, name]) => name))
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.rules-test.'))) {
      const src = read(file)
      assert.ok(!/requirePlan\(/.test(src), `${file} calls requirePlan — the plan requirement lives in the manifest`)
      for (const m of src.matchAll(/export const (\w+) = onCall/g)) {
        assert.ok(listed.has(m[1]), `${file}: ${m[1]} is not in GATED or UNGATED`)
        assert.ok(/await assertManager\(/.test(callableBody(src, m[1])), `${m[1]} does not call assertManager`)
      }
    }
  })
})
