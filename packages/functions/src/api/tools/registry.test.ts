import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { API_SCOPES, type ApiScope, type Capability, type TeamRole } from '@linyup/shared'
import type { ApiPrincipal } from '../auth/principal'
import type { TeamReadContext } from '../context'
import { buildMcpServer } from '../mcp/server'
import { toolParametersJsonSchema } from './jsonSchema'
import { READ_TOOLS, resultText, toolsFor, type ReadToolContext } from './registry'

// THE READ TOOLS ARE DEFINED ONCE. The registry is the only definition; the
// remote MCP server and the in-app assistant both publish it. What would go
// quietly wrong is a front end publishing a different set than the registry
// decides for the same principal — so that is pinned against a real MCP client.

const NOW = Date.UTC(2026, 8, 14, 12)

const team: TeamReadContext = {
  teamId: 'team-1',
  name: 'Samurai Fight Academy',
  slug: 'samurai-fight-academy',
  language: 'en',
  currency: 'CHF',
  timeZone: 'Europe/Zurich',
  engagementThresholds: undefined,
}

function ctx(scopes: readonly ApiScope[], role: TeamRole = 'owner', capabilities: Capability[] = []): ReadToolContext {
  const principal: ApiPrincipal = {
    teamId: team.teamId,
    uid: 'u-1',
    via: { kind: 'member' },
    role,
    scopes: new Set(scopes),
    capabilities: new Set(capabilities),
    dataScope: role === 'coach' ? 'own' : 'all',
    lastUsedAtMs: null,
  }
  return { principal, team, nowMs: NOW }
}

async function mcpToolNames(c: ReadToolContext): Promise<string[]> {
  const server = buildMcpServer(c.principal, c.team, c.nowMs)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'registry-test', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return (await client.listTools()).tools.map((t) => t.name).sort()
}

describe('read tool registry', () => {
  it('names every tool once, and describes each', () => {
    const names = READ_TOOLS.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, 'a tool name is defined twice')
    for (const tool of READ_TOOLS) {
      assert.ok(tool.title.trim(), `${tool.name} has no title`)
      assert.ok(tool.description.trim().length > 20, `${tool.name} needs a description a model can choose by`)
    }
  })

  it('gives a principal holding nothing only the overview', () => {
    assert.deepEqual(
      toolsFor(ctx([])).map((t) => t.name),
      ['get_studio_overview']
    )
  })

  describe('the MCP server publishes exactly what the registry decides', () => {
    const cases: Array<[string, ReadToolContext]> = [
      ['an owner holding every scope', ctx(API_SCOPES)],
      ['schedule only', ctx(['schedule:read'])],
      ['a viewer granted reports it does not hold', ctx(['schedule:read', 'reports:read'], 'viewer', ['schedule.view'])],
      ['a coach who sees only their own sessions', ctx(['schedule:read', 'contacts:read'], 'coach', ['schedule.view', 'contacts.view'])],
      ['the assistant scopes (no contact details)', ctx(API_SCOPES.filter((s) => s !== 'contacts:read:pii'))],
    ]
    for (const [label, c] of cases) {
      it(label, async () => {
        assert.deepEqual(await mcpToolNames(c), toolsFor(c).map((t) => t.name).sort())
      })
    }
  })

  it('converts every tool to a JSON Schema a function-calling model accepts', () => {
    for (const tool of READ_TOOLS) {
      const schema = toolParametersJsonSchema(tool.shape)
      assert.equal(schema.type, 'object', `${tool.name}: parameters must be an object`)
      assert.ok(!('$schema' in schema), `${tool.name}: the $schema marker must be stripped`)
    }
    const schedule = toolParametersJsonSchema(READ_TOOLS.find((t) => t.name === 'get_schedule')!.shape)
    assert.deepEqual([...((schedule.required as string[]) ?? [])].sort(), ['from', 'to'])
  })

  it('refuses bad arguments as a result the model can read, without throwing', async () => {
    const schedule = READ_TOOLS.find((t) => t.name === 'get_schedule')!
    const result = await schedule.invoke(ctx(['schedule:read']), { from: 'soon', to: '2026-09-14' })
    assert.equal(result.isError, true)
    assert.ok(resultText(result).length > 0)
  })

  it('answers the overview without touching data', async () => {
    const overview = READ_TOOLS.find((t) => t.name === 'get_studio_overview')!
    const result = await overview.invoke(ctx(['schedule:read']), {})
    assert.ok(!result.isError)
    assert.ok(resultText(result).includes('Samurai Fight Academy'))
    assert.ok(resultText(result).includes('today is 2026-09-14'))
  })
})
