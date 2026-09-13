import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ── THE CENSUS: where the Tarif 595 install gate goes ───────────────────────
// Same rule as connect/pluginGate.test.ts, re-derived from the source so a new
// callable cannot forget it silently:
//
//   GATED   — creating a receipt (preview is the dry run of the same creation;
//             the bulk run is the same creation for every member).
//   UNGATED — using one that exists: download, void, email. A receipt already
//             handed to a member must stay retrievable after the plugin is
//             unticked, and voiding winds existing state DOWN.
//   CONTACT — the member's own copy, authenticated by the CONTACT SESSION and
//             nothing else: no manager role (a member has none), no install
//             gate (consumption), and NEVER a contactId from the body.
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
  ['bulk.ts', 'startTarif595BulkIssue', 'creating a receipt for every member'],
]
const UNGATED: Array<[string, string, string]> = [
  ['download.ts', 'downloadTarif595Receipt', 'retrieving a receipt already handed out'],
  ['void.ts', 'voidTarif595Receipt', 'winding down an existing receipt'],
  ['email.ts', 'emailTarif595Receipt', 're-sending a receipt already issued'],
]
const CONTACT: Array<[string, string, string]> = [['mine.ts', 'listMyTarif595Receipts', "the member's own receipts"]]

describe('the Tarif 595 install gate — creation only', () => {
  for (const [file, name, why] of GATED) {
    it(`${name} IS gated (${why})`, () => {
      const body = callableBody(read(file), name)
      assert.ok(/await assertPluginInstalled\(/.test(body), `${name} does not call assertPluginInstalled`)
      assert.ok(/await assertManager\(/.test(body), `${name} does not call assertManager`)
    })
  }
  for (const [file, name, why] of UNGATED) {
    it(`${name} is NOT gated (${why})`, () => {
      const body = callableBody(read(file), name)
      assert.ok(!/assertPluginInstalled\(/.test(body), `${name} consumes an existing receipt — gating it strands the member`)
      assert.ok(/await assertManager\(/.test(body), `${name} does not call assertManager`)
    })
  }
  for (const [file, name, why] of CONTACT) {
    it(`${name} is a contact-session callable (${why})`, () => {
      const body = callableBody(read(file), name)
      assert.match(body, /await requireContactSessionForTeam\(request, teamId\)/, `${name} must take WHO from the session`)
      assert.ok(!/assertManager\(/.test(body), `${name} runs for the member — a manager role is not theirs to have`)
      assert.ok(!/assertPluginInstalled\(/.test(body), `${name} is consumption; the install state is a flag in the answer, not a gate`)
      assert.ok(!/data\.contactId|contactId\s*=\s*typeof/.test(body), `${name} must never read a contactId from the body`)
    })
  }
  it('the download has two doors — the manager, or the contact session on their own receipt — and the body decides neither', () => {
    const body = callableBody(read('download.ts'), 'downloadTarif595Receipt')
    assert.match(body, /optionalContactSessionFromRequest\(request\)/)
    assert.match(body, /await requireContactSessionForTeam\(request, teamId\)/)
    assert.match(body, /r\.contact_id !== ownContactId/, 'a receipt of another member must answer not-found')
    assert.ok(!/data\.contactId/.test(body), 'the contactId comes from the token, never the body')
  })
  it('every callable in the folder is classified', () => {
    const listed = new Set([...GATED, ...UNGATED, ...CONTACT].map(([, name]) => name))
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.rules-test.ts'))) {
      const src = read(file)
      for (const m of src.matchAll(/export const (\w+) = onCall/g)) {
        assert.ok(listed.has(m[1]), `${file}: ${m[1]} is not in GATED, UNGATED or CONTACT`)
      }
    }
  })
  it('the bulk worker is a task handler, exported for deploy, and runs the same issue implementation as the callable', () => {
    assert.match(read('bulkWorker.ts'), /export const runTarif595BulkIssue = onTaskDispatched</)
    assert.match(readFileSync(join(DIR, '..', 'index.ts'), 'utf8'), /\brunTarif595BulkIssue\b/)
    const bulk = read('bulk.ts')
    assert.match(bulk, /await issueReceipt\(/, 'the bulk run issues through issue.ts — never a second implementation')
    assert.match(bulk, /locations\/europe-west6\/functions\/runTarif595BulkIssue/, 'the queue is addressed by its fully-qualified name')
    assert.match(bulk, /id: `\$\{jobId\}-r\$\{round\}`/, 'the task id is job-first and deterministic per round')
    assert.match(bulk, /if \(\(job\.rounds \?\? 0\) >= round\)/, 'a redelivered round is a no-op')
  })
  it('no second door: nothing in the folder calls requirePlan', () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
      assert.ok(!/requirePlan\(/.test(read(file)), `${file} calls requirePlan — the plan requirement lives in the manifest`)
    }
  })
})
