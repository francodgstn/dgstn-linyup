import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { endStoppedReply } from './index'

// The assistant's reply when the model was stopped at its output cap: shown,
// but as what it is. The call itself needs Vertex, so its config is pinned from
// the source (see utils/vertexCalls.test.ts for the rule every call follows).

describe('assistant — a reply stopped at the output cap', () => {
  it('ends at its last whole sentence and says it was cut', () => {
    assert.equal(
      endStoppedReply('Go to Settings › Roles. There you can choose what a coach may'),
      'Go to Settings › Roles. …'
    )
  })

  it('ends a numbered answer at its last whole step, not at a step number', () => {
    assert.equal(
      endStoppedReply('1. Open Settings › Roles\n2. Pick the coach role\n3. Tick wh'),
      '1. Open Settings › Roles\n2. Pick the coach role\n…'
    )
  })

  it('marks a reply with no sentence end at all', () => {
    assert.equal(endStoppedReply('You can find this under Settings, where'), 'You can find this under Settings, where…')
    assert.equal(endStoppedReply('Open Settings, '), 'Open Settings…')
  })

  it('empty stays empty', () => {
    assert.equal(endStoppedReply('   '), '')
  })

  it('the call turns thinking off and passes a stopped reply through endStoppedReply', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    assert.match(source, /thinkingConfig:\s*\{\s*thinkingBudget:\s*0\s*\}/)
    assert.match(source, /if \(replyWasStopped\(response\)\)/)
    assert.match(source, /reply = endStoppedReply\(reply\)/)
  })
})
