import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DRAFT_MAX_OUTPUT_TOKENS, DRAFT_THINKING_BUDGET, readDraftReply } from './draftOfferings'

// Offer drafting's reply, before `parseOfferingDraft` sees it. A reply the model
// was stopped in the middle of is incomplete JSON by definition, and is never
// parsed. The call itself needs Vertex, so its config is pinned from the source.

const EMPTY_DRAFT = '{"activities":[],"plans":[]}'

describe('offer drafting — the reply', () => {
  it('refuses a stopped reply before parsing it, even when its text happens to parse', () => {
    assert.deepEqual(readDraftReply(EMPTY_DRAFT, true), { ok: false, reason: 'stopped' })
  })

  it('parses a finished reply, fence and all', () => {
    assert.deepEqual(readDraftReply(`\`\`\`json\n${EMPTY_DRAFT}\n\`\`\``, false), {
      ok: true,
      json: { activities: [], plans: [] },
    })
  })

  it('calls a finished reply that is not JSON unreadable', () => {
    assert.deepEqual(readDraftReply('{"activities": [', false), { ok: false, reason: 'unreadable' })
  })

  it('bounds thinking and leaves the answer room for the largest draft the parser accepts', () => {
    assert.ok(DRAFT_THINKING_BUDGET > 0)
    // 8 activities and 6 plans, every description at 600 characters, is under
    // 4000 tokens of JSON (see DRAFT_THINKING_BUDGET).
    assert.ok(DRAFT_MAX_OUTPUT_TOKENS - DRAFT_THINKING_BUDGET >= 4096)
  })

  it('the call uses that budget and never parses a stopped reply', () => {
    const source = readFileSync(join(__dirname, 'draftOfferings.ts'), 'utf8').replace(/\r\n/g, '\n')
    assert.match(source, /maxOutputTokens:\s*DRAFT_MAX_OUTPUT_TOKENS/)
    assert.match(source, /thinkingConfig:\s*\{\s*thinkingBudget:\s*DRAFT_THINKING_BUDGET\s*\}/)
    assert.match(source, /stopped = replyWasStopped\(response\)/)
    assert.match(source, /readDraftReply\(raw,\s*stopped\)/)
    // The reply is parsed in ONE place, readDraftReply, which refuses a stopped one first.
    assert.equal(source.match(/JSON\.parse\(/g)?.length, 1, 'only readDraftReply parses the reply')
  })
})
