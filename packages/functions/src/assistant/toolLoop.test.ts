import assert from 'node:assert/strict'
import type { Content } from '@google/genai'
import { API_SCOPES, type ApiScope } from '@linyup/shared'
import type { ApiPrincipal } from '../api/auth/principal'
import type { TeamReadContext } from '../api/context'
import { toolsFor, type ReadToolContext } from '../api/tools/registry'
import { ASSISTANT_SCOPES } from './index'
import {
  MAX_CALLS_PER_ROUND,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_ROUNDS,
  clipToolOutput,
  functionDeclarations,
  runToolLoop,
  type Generate,
  type ModelTurn,
} from './toolLoop'

// The assistant's tool loop with the model replaced by a script. The one tool
// exercised for real is the overview, which reads nothing from Firestore.

const NOW = Date.UTC(2026, 8, 14, 12)

const team: TeamReadContext = {
  teamId: 'team-1',
  name: 'Lotus Yoga Studio',
  slug: 'lotus-yoga',
  language: 'en',
  currency: 'CHF',
  timeZone: 'Europe/Zurich',
  engagementThresholds: undefined,
}

function ctx(scopes: readonly ApiScope[] = ASSISTANT_SCOPES): ReadToolContext {
  const principal: ApiPrincipal = {
    teamId: team.teamId,
    uid: 'u-1',
    via: { kind: 'member' },
    role: 'owner',
    scopes: new Set(scopes),
    capabilities: new Set(),
    dataScope: 'all',
    lastUsedAtMs: null,
  }
  return { principal, team, nowMs: NOW }
}

const user: Content = { role: 'user', parts: [{ text: 'What studio is this?' }] }

/** A model that plays back `turns` in order and records what it was sent. */
function scripted(turns: ModelTurn[]) {
  const seen: Array<{ contents: Content[]; allowTools: boolean }> = []
  const generate: Generate = async (contents, { allowTools }) => {
    seen.push({ contents: structuredClone(contents), allowTools })
    const turn = turns[seen.length - 1]
    assert.ok(turn, `the model was called ${seen.length} times, more than scripted`)
    return turn
  }
  return { generate, seen }
}

const call = (name: string, args: Record<string, unknown> = {}, id?: string) => ({ name, args, ...(id ? { id } : {}) })

function responses(content: Content) {
  return (content.parts ?? []).map((p) => p.functionResponse!)
}

describe('assistant tool loop', () => {
  it('withholds contact details from the assistant', () => {
    assert.ok(!ASSISTANT_SCOPES.includes('contacts:read:pii'))
    assert.equal(ASSISTANT_SCOPES.length, API_SCOPES.length - 1)
  })

  it('declares the tools the principal may use, with object parameters', () => {
    const tools = toolsFor(ctx())
    const declarations = functionDeclarations(tools)
    assert.deepEqual(
      declarations.map((d) => d.name),
      tools.map((t) => t.name)
    )
    for (const d of declarations) assert.equal((d.parametersJsonSchema as { type?: string }).type, 'object')
  })

  it('answers directly when the model needs no tool', async () => {
    const { generate, seen } = scripted([{ text: 'Hello.' }])
    const { turn, toolsUsed } = await runToolLoop(generate, [user], toolsFor(ctx()), ctx())
    assert.equal(turn.text, 'Hello.')
    assert.deepEqual(toolsUsed, [])
    assert.equal(seen.length, 1)
  })

  it('runs a tool, hands its result back, and returns the answer', async () => {
    const { generate, seen } = scripted([
      { functionCalls: [call('get_studio_overview', {}, 'c1')] },
      { text: 'This is Lotus Yoga Studio.' },
    ])
    const { turn, toolsUsed } = await runToolLoop(generate, [user], toolsFor(ctx()), ctx())
    assert.equal(turn.text, 'This is Lotus Yoga Studio.')
    assert.deepEqual(toolsUsed, ['get_studio_overview'])

    const second = seen[1].contents
    assert.equal(second[1].role, 'model', 'the model turn with the call is kept')
    const [response] = responses(second[2])
    assert.equal(response.name, 'get_studio_overview')
    assert.equal(response.id, 'c1', 'the response carries the call id')
    assert.match(String((response.response as { output?: string }).output), /Lotus Yoga Studio/)
  })

  it('answers an unknown tool with an error the model can read', async () => {
    const { generate, seen } = scripted([{ functionCalls: [call('delete_everything')] }, { text: 'I cannot do that.' }])
    const { toolsUsed } = await runToolLoop(generate, [user], toolsFor(ctx()), ctx())
    assert.deepEqual(toolsUsed, [], 'an unknown tool is not counted as used')
    const [response] = responses(seen[1].contents[2])
    assert.match(String((response.response as { error?: string }).error), /unknown_tool/)
  })

  it('pairs every call with a response, refusing those over the per-round cap', async () => {
    const calls = Array.from({ length: MAX_CALLS_PER_ROUND + 2 }, () => call('get_studio_overview'))
    const { generate, seen } = scripted([{ functionCalls: calls }, { text: 'Done.' }])
    await runToolLoop(generate, [user], toolsFor(ctx()), ctx())
    const answered = responses(seen[1].contents[2])
    assert.equal(answered.length, calls.length, 'function calling refuses unpaired calls')
    const refused = answered.filter((r) => 'error' in (r.response as object))
    assert.equal(refused.length, 2)
    assert.match(String((refused[0].response as { error: string }).error), /too_many_calls/)
  })

  it('asks for an answer with tools off once the rounds run out', async () => {
    const turns: ModelTurn[] = [
      ...Array.from({ length: MAX_TOOL_ROUNDS }, () => ({ functionCalls: [call('get_studio_overview')] })),
      { text: 'Here is what I found.' },
    ]
    const { generate, seen } = scripted(turns)
    const { turn } = await runToolLoop(generate, [user], toolsFor(ctx()), ctx())
    assert.equal(turn.text, 'Here is what I found.')
    assert.equal(seen.length, MAX_TOOL_ROUNDS + 1)
    assert.ok(seen.slice(0, MAX_TOOL_ROUNDS).every((s) => s.allowTools))
    assert.equal(seen[MAX_TOOL_ROUNDS].allowTools, false)
  })

  it('clips a long tool result and says so', () => {
    assert.equal(clipToolOutput('short'), 'short')
    const long = clipToolOutput('x'.repeat(MAX_TOOL_OUTPUT_CHARS + 50))
    assert.ok(long.length < MAX_TOOL_OUTPUT_CHARS + 200)
    assert.match(long, /Cut here/)
  })
})
