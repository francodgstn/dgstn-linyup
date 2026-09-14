import * as assert from 'node:assert'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { API_SCOPES, type ApiScope, type Capability, type TeamRole } from '@linyup/shared'
import type { ApiPrincipal } from '../auth/principal'
import type { TeamReadContext } from '../context'
import { buildMcpServer, money } from './server'

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

function principal(scopes: readonly ApiScope[], role: TeamRole = 'owner', capabilities: Capability[] = []): ApiPrincipal {
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

async function toolNames(p: ApiPrincipal): Promise<string[]> {
  return (await (await connect(p)).listTools()).tools.map((t) => t.name).sort()
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content.map((c) => c.text ?? '').join('\n')
}

describe('mcp server', () => {
  it('publishes every tool to an owner holding every scope, all read-only', async () => {
    const client = await connect(principal(API_SCOPES))
    const { tools } = await client.listTools()
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), [
      'find_contacts',
      'get_attendance_trend',
      'get_class_fill_rates',
      'get_contact',
      'get_contact_history',
      'get_revenue_summary',
      'get_schedule',
      'get_session_roster',
      'get_studio_overview',
      'list_events',
      'list_inactive_contacts',
      'list_memberships',
      'list_offerings',
    ])
    for (const tool of tools) {
      assert.strictEqual(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`)
      assert.strictEqual(tool.annotations?.destructiveHint, false)
    }
  })

  it('publishes only what the granted scopes can use', async () => {
    assert.deepStrictEqual(await toolNames(principal(['schedule:read'])), [
      'get_class_fill_rates',
      'get_schedule',
      'get_session_roster',
      'get_studio_overview',
      'list_events',
    ])
    assert.deepStrictEqual(await toolNames(principal(['offerings:read', 'reports:read'])), [
      'get_attendance_trend',
      'get_studio_overview',
      'list_offerings',
    ])
  })

  it('follows the LIVE role: a viewer granted reports but not holding it gets no report tool', async () => {
    assert.deepStrictEqual(await toolNames(principal(['schedule:read', 'reports:read'], 'viewer', ['schedule.view'])), [
      'get_class_fill_rates',
      'get_schedule',
      'get_session_roster',
      'get_studio_overview',
      'list_events',
    ])
  })

  it('keeps whole-studio fill rates from a coach who only sees their own sessions', async () => {
    const own = await toolNames(principal(['schedule:read'], 'coach', ['schedule.view']))
    assert.ok(!own.includes('get_class_fill_rates'))
    const wide = await toolNames(principal(['schedule:read'], 'coach', ['schedule.view', 'schedule.view.all']))
    assert.ok(wide.includes('get_class_fill_rates'))
  })

  it('publishes JSON Schemas a model can fill', async () => {
    const client = await connect(principal(API_SCOPES))
    const { tools } = await client.listTools()
    const props = (name: string) => tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { enum?: string[] }>
    assert.ok(props('find_contacts').lifecycle?.enum?.includes('roster'), 'lifecycle enumerates its views')
    assert.ok(props('find_contacts').inactive_days, 'inactivity is askable in days')
    assert.ok(props('list_memberships').state?.enum?.includes('cancelling'))
    assert.ok(props('get_class_fill_rates').group_by?.enum?.includes('weekday_time'))
    const schedule = tools.find((t) => t.name === 'get_schedule')!
    assert.deepStrictEqual([...(schedule.inputSchema.required ?? [])].sort(), ['from', 'to'])
  })

  it('tells the model where it is, what day it is, and what it cannot see', async () => {
    const client = await connect(principal(['contacts:read', 'schedule:read']))
    const instructions = client.getInstructions() ?? ''
    assert.ok(instructions.includes('Samurai Fight Academy'))
    assert.ok(instructions.includes('2026-09-14'))
    assert.ok(instructions.includes('contacts:read:pii'), 'names the missing PII scope')
    assert.ok(instructions.includes('finance:read'), 'names the missing finance scope')

    const overview = await client.callTool({ name: 'get_studio_overview', arguments: {} })
    assert.ok(!overview.isError)
    assert.ok(text(overview).includes('today is 2026-09-14'))
  })

  it('returns bad arguments as a tool error the model can read, before any data is touched', async () => {
    const client = await connect(principal(['schedule:read', 'finance:read']))
    const schedule = await client.callTool({ name: 'get_schedule', arguments: { from: 'soon', to: '2026-09-14' } })
    assert.strictEqual(schedule.isError, true)
    const revenue = await client.callTool({ name: 'get_revenue_summary', arguments: { from: '2026-13', to: '2026-09' } })
    assert.strictEqual(revenue.isError, true)
    assert.ok(text(revenue).length > 0)
  })

  it('formats minor units as the model should read them', () => {
    assert.strictEqual(money({ amount: 12950, currency: 'CHF' }), 'CHF 129.50')
    assert.strictEqual(money(null), '—')
  })
})
