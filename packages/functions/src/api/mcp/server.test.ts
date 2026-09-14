import * as assert from 'node:assert'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ApiScope, Capability, TeamRole } from '@linyup/shared'
import type { ApiPrincipal } from '../auth/principal'
import type { TeamReadContext } from '../context'
import { buildMcpServer } from './server'

// The MCP surface as a real client sees it: which tools are published for which
// scopes, what JSON Schema a model is asked to fill, and how a refusal reads.
// Tools that touch Firestore are exercised by listing, not calling.

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

function principal(scopes: ApiScope[], role: TeamRole = 'owner', capabilities: Capability[] = []): ApiPrincipal {
  return {
    teamId: team.teamId,
    uid: 'u-1',
    via: { kind: 'api_key', keyId: 'key-1' },
    role,
    scopes: new Set(scopes),
    capabilities: new Set(capabilities),
    dataScope: role === 'coach' ? 'own' : 'all',
    lastUsedAtMs: null,
  }
}

async function connect(p: ApiPrincipal): Promise<Client> {
  const server = buildMcpServer(p, team, NOW)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'linyup-test', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return client
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content.map((c) => c.text ?? '').join('\n')
}

describe('mcp server', () => {
  it('publishes only the tools the connection can use, every one read-only', async () => {
    const owner = await connect(principal(['contacts:read', 'schedule:read']))
    const { tools } = await owner.listTools()
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), [
      'find_contacts',
      'get_contact',
      'get_schedule',
      'get_studio_overview',
      'list_inactive_contacts',
    ])
    for (const tool of tools) {
      assert.strictEqual(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`)
      assert.strictEqual(tool.annotations?.destructiveHint, false)
    }

    const scheduleOnly = await connect(principal(['schedule:read']))
    assert.deepStrictEqual((await scheduleOnly.listTools()).tools.map((t) => t.name).sort(), ['get_schedule', 'get_studio_overview'])
  })

  it('follows the LIVE role: a viewer granted reports but not holding it gets no contact tools it cannot use', async () => {
    const viewer = await connect(principal(['schedule:read', 'reports:read'], 'viewer', ['schedule.view']))
    assert.deepStrictEqual((await viewer.listTools()).tools.map((t) => t.name).sort(), ['get_schedule', 'get_studio_overview'])
  })

  it('publishes JSON Schemas a model can fill', async () => {
    const client = await connect(principal(['contacts:read', 'schedule:read']))
    const { tools } = await client.listTools()
    const find = tools.find((t) => t.name === 'find_contacts')!
    const props = find.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>
    assert.ok(props.lifecycle?.enum?.includes('roster'), 'lifecycle enumerates its views')
    assert.ok(props.inactive_days, 'inactivity is askable in days')
    const schedule = tools.find((t) => t.name === 'get_schedule')!
    assert.deepStrictEqual([...(schedule.inputSchema.required ?? [])].sort(), ['from', 'to'])
  })

  it('tells the model where it is, what day it is, and what it cannot see', async () => {
    const client = await connect(principal(['contacts:read', 'schedule:read']))
    const instructions = client.getInstructions() ?? ''
    assert.ok(instructions.includes('Samurai Fight Academy'))
    assert.ok(instructions.includes('2026-09-14'))
    assert.ok(instructions.includes('contacts:read:pii'), 'names the missing PII scope')

    const overview = await client.callTool({ name: 'get_studio_overview', arguments: {} })
    assert.ok(!overview.isError)
    assert.ok(text(overview).includes('today is 2026-09-14'))
  })

  it('returns bad arguments as a tool error the model can read, before any data is touched', async () => {
    const client = await connect(principal(['schedule:read']))
    const result = await client.callTool({ name: 'get_schedule', arguments: { from: 'soon', to: '2026-09-14' } })
    assert.strictEqual(result.isError, true)
    assert.ok(text(result).length > 0)
  })
})
