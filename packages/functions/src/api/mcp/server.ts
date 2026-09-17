// ─── The remote MCP server ───────────────────────────────────────────────────
//
// docs/public-api.md. Stateless Streamable HTTP with JSON responses: every POST
// builds a server for THIS principal, publishes only the tools it may use,
// answers, and is discarded. Read-only tools need no SSE and no session.
//
// The SDK is `@modelcontextprotocol/sdk` 1.x, and this is the ONE file that
// imports it — the v2 split packages require zod 4 while the functions run on
// zod 3, so a later move touches here and nowhere else. `api/index.ts` loads
// this module lazily, so no other function's cold start pays for the SDK.
//
// The tools themselves are NOT defined here. They live in api/tools/registry.ts,
// which the in-app assistant publishes too; this file only hands each one to the
// SDK. The SDK gets our zod shape for the published JSON Schema, but the
// arguments are typed and validated by the tool's own `parseInput` — the SDK's
// generic signature instantiates too deeply against these shapes, and a second
// definition of "valid" is exactly what the registry exists to prevent.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { z } from 'zod'
import type { ApiPrincipal } from '../auth/principal'
import type { ApiRequest, ApiResponse } from '../access'
import { loadTeamContext, type TeamReadContext } from '../context'
import { studioInstructions } from '../tools/instructions'
import { toolsFor, type ReadTool, type ReadToolContext, type ToolResult } from '../tools/registry'

export { contactLine, money, sessionLine } from '../tools/format'
export type { ToolResult } from '../tools/registry'

export const MCP_SERVER_NAME = 'linyup'
export const MCP_SERVER_VERSION = '1.1.0'

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

type LooseRegisterTool = (
  name: string,
  config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: typeof READ_ONLY },
  handler: (args: unknown) => Promise<ToolResult>
) => unknown

/** Publish one registry tool on this server, for this principal. */
function publishReadTool(server: McpServer, tool: ReadTool, ctx: ReadToolContext): void {
  const register = server.registerTool.bind(server) as unknown as LooseRegisterTool
  register(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.shape, annotations: READ_ONLY },
    (args) => tool.invoke(ctx, args)
  )
}

export function serverInstructions(principal: ApiPrincipal, team: TeamReadContext, nowMs: number): string {
  return studioInstructions(principal, team, nowMs, 'connection')
}

export function buildMcpServer(principal: ApiPrincipal, team: TeamReadContext, nowMs: number): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: serverInstructions(principal, team, nowMs) }
  )
  const ctx: ReadToolContext = { principal, team, nowMs }
  for (const tool of toolsFor(ctx)) publishReadTool(server, tool, ctx)
  return server
}

/** Answer one MCP POST for an already-resolved principal. */
export async function handleMcp(req: ApiRequest, res: ApiResponse, principal: ApiPrincipal, nowMs: number): Promise<void> {
  if (req.method !== 'POST') {
    // Stateless and read-only: no server-initiated stream (GET) and no session to end (DELETE).
    res.set('Allow', 'POST').status(405).json({ error: { code: 'method_not_allowed', message: 'Use POST' } })
    return
  }
  const team = await loadTeamContext(principal.teamId)
  const server = buildMcpServer(principal, team, nowMs)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
