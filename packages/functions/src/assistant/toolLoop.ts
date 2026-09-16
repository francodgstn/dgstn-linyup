// ─── The assistant's tool loop ──────────────────────────────────────────────
//
// The model asks for read tools, the loop answers from the registry
// (api/tools/registry.ts — the same tools the remote MCP server publishes), and
// the model answers the member once it has what it needs. Kept apart from the
// Vertex call so it can be exercised without Vertex: `generate` is injected.
//
// Every call the model makes gets exactly one response, in order — function
// calling refuses a turn whose calls and responses do not pair up — so a call
// over the per-round cap is answered with an error rather than dropped. A tool
// never throws into the loop: refusals come back as results the model reads.

import type { Content, FunctionCall, Part } from '@google/genai'
import { toolParametersJsonSchema } from '../api/tools/jsonSchema'
import { resultText, type ReadTool, type ReadToolContext, type ToolResult } from '../api/tools/registry'

/** Rounds of tool calls before the model must answer with what it has. */
export const MAX_TOOL_ROUNDS = 4
/** Tool calls answered per round; further calls in the same round are refused. */
export const MAX_CALLS_PER_ROUND = 4
/** One tool's text as the model reads it — a long roster is clipped, and says so. */
export const MAX_TOOL_OUTPUT_CHARS = 8000

/** The part of a model reply the loop reads. `GenerateContentResponse` fits it. */
export interface ModelTurn {
  text?: string
  functionCalls?: FunctionCall[]
  candidates?: Array<{ content?: Content; finishReason?: unknown }>
}

export type Generate = (contents: Content[], options: { allowTools: boolean }) => Promise<ModelTurn>

/** The registry tools as Gemini function declarations — the shapes `invoke` parses with. */
export function functionDeclarations(tools: readonly ReadTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: toolParametersJsonSchema(tool.shape),
  }))
}

export function clipToolOutput(text: string): string {
  return text.length <= MAX_TOOL_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n(Cut here: the result was longer. Narrow the question to see the rest.)`
}

function refusal(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

async function answerCall(call: FunctionCall, index: number, tools: Map<string, ReadTool>, ctx: ReadToolContext): Promise<Part> {
  const name = call.name ?? ''
  const tool = tools.get(name)
  const result =
    index >= MAX_CALLS_PER_ROUND
      ? refusal(`too_many_calls: at most ${MAX_CALLS_PER_ROUND} tools per step — ask for the rest next.`)
      : tool
        ? await tool.invoke(ctx, call.args ?? {})
        : refusal(`unknown_tool: there is no tool called "${name}".`)
  const text = clipToolOutput(resultText(result))
  return {
    functionResponse: {
      ...(call.id ? { id: call.id } : {}),
      name,
      response: result.isError ? { error: text } : { output: text },
    },
  }
}

/**
 * Run the conversation until the model answers in text, or the rounds run out —
 * then it is asked once more with tools switched off, to answer from what it has.
 * Returns the final turn and the tools it used, in first-use order.
 */
export async function runToolLoop(
  generate: Generate,
  conversation: readonly Content[],
  tools: readonly ReadTool[],
  ctx: ReadToolContext
): Promise<{ turn: ModelTurn; toolsUsed: string[] }> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const history: Content[] = [...conversation]
  const used: string[] = []

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const turn = await generate(history, { allowTools: true })
    const calls = turn.functionCalls ?? []
    if (calls.length === 0) return { turn, toolsUsed: used }

    history.push(turn.candidates?.[0]?.content ?? { role: 'model', parts: calls.map((call) => ({ functionCall: call })) })
    const parts = await Promise.all(calls.map((call, i) => answerCall(call, i, byName, ctx)))
    history.push({ role: 'user', parts })
    for (const call of calls.slice(0, MAX_CALLS_PER_ROUND)) {
      if (call.name && byName.has(call.name) && !used.includes(call.name)) used.push(call.name)
    }
  }

  return { turn: await generate(history, { allowTools: false }), toolsUsed: used }
}
