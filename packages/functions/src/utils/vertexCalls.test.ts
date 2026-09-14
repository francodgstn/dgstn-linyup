import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { replyWasStopped } from './vertexClient'

// EVERY VERTEX CALL STATES ITS THINKING BUDGET AND CHECKS FOR A STOPPED REPLY.
//
// Thinking tokens count against `maxOutputTokens` on the assistant model, so a
// call that is silent about thinking can be stopped before its answer is
// written — contact summaries were stored as sentence fragments that way. The
// rule and its reasoning live in the header of utils/vertexClient.ts; this
// reads every call site from the SOURCE, because none of them can run without
// Vertex, and fails for a file that sets no thinking budget or never asks
// `replyWasStopped`. The check is per file.

const SRC = join(__dirname, '..')
const CALL = /\.generateContent(?:Stream)?\(/
const THINKING = /thinkingConfig:\s*\{\s*thinkingBudget:/
const STOP_CHECK = /replyWasStopped\(/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.ts$/.test(name) && !/\.(test|rules-test|d)\.ts$/.test(name)) out.push(path)
  }
  return out
}

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

/** What a calling file is missing, empty when it has both. */
function missingGuards(source: string): string[] {
  const missing: string[] = []
  if (!THINKING.test(source)) missing.push('an explicit thinking budget')
  if (!STOP_CHECK.test(source)) missing.push('a replyWasStopped check')
  return missing
}

describe('Vertex calls — every one states its thinking budget and checks for a stopped reply', () => {
  const callers = sourceFiles(SRC).filter((path) => CALL.test(read(path)))

  it('reads the real tree, not an empty listing', () => {
    assert.ok(callers.length > 0, 'no generateContent call found under src')
  })

  it('every file that calls the model sets thinkingBudget and calls replyWasStopped', () => {
    const offenders = callers
      .map((path) => ({ file: relative(SRC, path).replace(/\\/g, '/'), missing: missingGuards(read(path)) }))
      .filter((c) => c.missing.length > 0)
    assert.deepEqual(offenders, [], 'A Vertex call is missing its guards — see utils/vertexClient.ts')
  })

  it('and the check is capable of failing', () => {
    assert.deepEqual(missingGuards('await ai.models.generateContent({ config: { maxOutputTokens: 512 } })'), [
      'an explicit thinking budget',
      'a replyWasStopped check',
    ])
  })
})

describe('replyWasStopped', () => {
  it('is true only when the reply reached the output cap', () => {
    assert.equal(replyWasStopped({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), true)
    assert.equal(replyWasStopped({ candidates: [{ finishReason: 'STOP' }] }), false)
    assert.equal(replyWasStopped({ candidates: [] }), false)
    assert.equal(replyWasStopped({}), false)
    assert.equal(replyWasStopped(null), false)
  })
})
