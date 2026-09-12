import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ── THE CENSUS: where the Tarif 595 install gate goes ───────────────────────
// Same rule as connect/pluginGate.test.ts, re-derived from the source so a new
// callable cannot forget it silently:
//
//   GATED   — creating a receipt (preview is the dry run of the same creation).
//   UNGATED — using one that exists: download, void, email. A receipt already
//             handed to a member must stay retrievable after the plugin is
//             unticked, and voiding winds existing state DOWN.
//
// Every `onCall` in this folder must appear in exactly one list.

const DIR = __dirname
const read = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/\r\n/g, '\n')

function callableBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = onCall`)
  assert.notEqual(start, -1, `callable ${name} not found — was it renamed or removed?`)
  const rest = src.slice(start + 1)
  const next = rest.indexOf('\nexport const ')
  return next === -1 ? rest : rest.slice(0, next)
}

const GATED: Array<[string, string, string]> = [
  ['issue.ts', 'previewTarif595Receipt', 'the dry run of creating a receipt'],
  ['issue.ts', 'issueTarif595Receipt', 'creating a receipt'],
]
const UNGATED: Array<[string, string, string]> = [
  ['download.ts', 'downloadTarif595Receipt', 'retrieving a receipt already handed out'],
  ['void.ts', 'voidTarif595Receipt', 'winding down an existing receipt'],
  ['email.ts', 'emailTarif595Receipt', 're-sending a receipt already issued'],
]

describe('the Tarif 595 install gate — creation only', () => {
  for (const [file, name, why] of GATED) {
    it(`${name} IS gated (${why})`, () => {
      assert.ok(/await assertPluginInstalled\(/.test(callableBody(read(file), name)), `${name} does not call assertPluginInstalled`)
    })
  }
  for (const [file, name, why] of UNGATED) {
    it(`${name} is NOT gated (${why})`, () => {
      assert.ok(!/assertPluginInstalled\(/.test(callableBody(read(file), name)), `${name} consumes an existing receipt — gating it strands the member`)
    })
  }
  it('every callable in the folder is classified, and every one checks the manager role', () => {
    const listed = new Set([...GATED, ...UNGATED].map(([, name]) => name))
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.rules-test.ts'))) {
      const src = read(file)
      for (const m of src.matchAll(/export const (\w+) = onCall/g)) {
        assert.ok(listed.has(m[1]), `${file}: ${m[1]} is not in GATED or UNGATED`)
        assert.ok(/await assertManager\(/.test(callableBody(src, m[1])), `${m[1]} does not call assertManager`)
      }
    }
  })
  it('no second door: nothing in the folder calls requirePlan', () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
      assert.ok(!/requirePlan\(/.test(read(file)), `${file} calls requirePlan — the plan requirement lives in the manifest`)
    }
  })
})
