// ─── The remote MCP server ───────────────────────────────────────────────────
//
// docs/public-api.md. Stateless Streamable HTTP with JSON responses: every POST
// builds a server for THIS principal, registers only the tools its scopes can
// use, answers, and is discarded. Read-only tools need no SSE and no session.
//
// The SDK is `@modelcontextprotocol/sdk` 1.x, and this is the ONE file that
// imports it — the v2 split packages require zod 4 while the functions run on
// zod 3, so a later move touches here and nowhere else. `api/index.ts` loads
// this module lazily, so no other function's cold start pays for the SDK.
//
// Tools are registered through `registerReadTool`, which hands the SDK our zod
// shape for the published JSON Schema but types and validates the arguments
// with `parseInput` (api/schemas.ts) — the same parser REST uses. The SDK's own
// generic signature instantiates too deeply against these shapes, and REST and
// MCP refusing input differently would be a second definition of "valid".
//
// Tools answer questions; they do not mirror endpoints. Each returns compact
// text for the model plus the same rows as `structuredContent`, and a failure
// comes back as a tool result with `isError`, so the model reads the hint.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { ApiContact, ApiScope, ApiSession } from '@linyup/shared'
import { principalMay, type ApiPrincipal } from '../auth/principal'
import type { ApiRequest, ApiResponse, ListPage } from '../access'
import { loadTeamContext, type TeamReadContext } from '../context'
import { toApiError } from '../errors'
import { getContact, listContacts } from '../resources/contacts'
import { listSessions } from '../resources/sessions'
import { describeScopes } from '../rest'
import { contactListShape, parseInput, sessionListShape } from '../schemas'
import { parseApiInstant, zonedYmd } from '../time'

export const MCP_SERVER_NAME = 'linyup'
export const MCP_SERVER_VERSION = '1.0.0'
/** The schedule window one tool call may cover. */
const SCHEDULE_MAX_DAYS = 14

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function ok(text: string, structured: object): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured as Record<string, unknown> }
}

function failure(err: unknown): ToolResult {
  const e = toApiError(err)
  const issues = Array.isArray(e.details?.issues)
    ? ` (${(e.details.issues as Array<{ path: string; message: string }>).map((i) => `${i.path}: ${i.message}`).join('; ')})`
    : ''
  return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}${issues}${e.hint ? ` — ${e.hint}` : ''}` }] }
}

type LooseRegisterTool = (
  name: string,
  config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: typeof READ_ONLY },
  handler: (args: unknown) => Promise<ToolResult>
) => unknown

/** Register a read-only tool whose arguments are parsed by OUR schema, not the SDK's generics. */
export function registerReadTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; shape: S },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
): void {
  const register = server.registerTool.bind(server) as unknown as LooseRegisterTool
  register(
    name,
    { title: config.title, description: config.description, inputSchema: config.shape, annotations: READ_ONLY },
    async (args) => {
      try {
        return await handler(parseInput(config.shape, args))
      } catch (err) {
        return failure(err)
      }
    }
  )
}

function localTime(iso: string | null, team: TeamReadContext): string {
  if (!iso) return '?'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: team.timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function contactLine(c: ApiContact, team: TeamReadContext): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)'
  const last = c.attendance.last_session_at ? localTime(c.attendance.last_session_at, team) : 'never'
  const plans = c.plans.map((p) => p.plan_name ?? p.plan_id).join(', ')
  const reach = [c.email, c.phone].filter(Boolean).join(', ')
  return (
    `- ${name} [${c.id}] · ${c.lifecycle} · ${c.attendance.engagement_band} · last session ${last}` +
    ` · ${c.attendance.total_sessions} sessions` +
    (plans ? ` · plans: ${plans}` : ' · no plan') +
    (c.attention_reasons.length ? ` · needs attention: ${c.attention_reasons.join(', ')}` : '') +
    (reach ? ` · ${reach}` : '')
  )
}

export function sessionLine(s: ApiSession, team: TeamReadContext): string {
  const seats = s.capacity === null ? `${s.booked} booked` : `${s.booked}/${s.capacity} booked`
  return (
    `- ${localTime(s.start, team)} · ${s.activity.name ?? s.activity.type} [${s.id}]` +
    (s.provider?.name ? ` · ${s.provider.name}` : '') +
    ` · ${seats}` +
    (s.waitlisted ? ` · ${s.waitlisted} waiting` : '') +
    (s.status !== 'open' ? ` · ${s.status}` : '')
  )
}

function pageFooter(page: ListPage<unknown>): string {
  if (!page.has_more) return ''
  return page.scan_exhausted
    ? `\n(Stopped after reading ${page.scanned} records; call again with cursor "${page.next_cursor}" to keep looking.)`
    : `\n(More results: call again with cursor "${page.next_cursor}".)`
}

export function serverInstructions(principal: ApiPrincipal, team: TeamReadContext, nowMs: number): string {
  const { usable } = describeScopes(principal)
  const missing = (['contacts:read', 'contacts:read:pii', 'schedule:read'] as ApiScope[]).filter((s) => !usable.includes(s))
  return [
    `You are connected, read-only, to the Linyup studio "${team.name}".`,
    `Today is ${zonedYmd(nowMs, team.timeZone)} in ${team.timeZone}; give times in that zone. Money is in ${team.currency}, in minor units (divide by 100).`,
    'People: "roster" means members and leads the studio looks after; "external" means people who train here without being on the roster (partner-app drop-ins, former members) and are not churn. Leads are not yet confirmed.',
    'Engagement bands (active, low, at_risk, inactive) are measured from the last attended session.',
    missing.length
      ? `This connection cannot see: ${missing.join(', ')}. Say so rather than guessing.`
      : 'This connection can see contact details.',
  ].join('\n')
}

export function buildMcpServer(principal: ApiPrincipal, team: TeamReadContext, nowMs: number): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: serverInstructions(principal, team, nowMs) }
  )

  registerReadTool(
    server,
    'get_studio_overview',
    {
      title: 'Studio overview',
      description: "The studio's name, today's date in its time zone, its currency, and what this connection may read.",
      shape: {},
    },
    async () => {
      const overview = {
        studio: team.name,
        today: zonedYmd(nowMs, team.timeZone),
        time_zone: team.timeZone,
        currency: team.currency,
        role: principal.role,
        scopes: describeScopes(principal),
      }
      return ok(
        `${team.name} — today is ${overview.today} (${team.timeZone}), currency ${team.currency}. ` +
          `Readable: ${overview.scopes.usable.join(', ') || 'nothing'}.`,
        overview
      )
    }
  )

  if (principalMay(principal, 'contacts:read')) {
    registerReadTool(
      server,
      'find_contacts',
      {
        title: 'Find contacts',
        description:
          'Search and filter the people of the studio: by name, lifecycle, engagement band, tags, coach, trial stage, inactivity, plan. Returns one line per person.',
        shape: contactListShape(25, 100),
      },
      async (args) => {
        const page = await listContacts(
          principal,
          team,
          {
            limit: args.limit,
            cursor: args.cursor,
            lifecycle: args.lifecycle,
            query: args.q,
            engagement: args.engagement,
            tags: args.tags,
            coachId: args.coach_id,
            stages: args.stages,
            inactiveDays: args.inactive_days,
            hasPlan: args.has_plan,
            needsAttention: args.needs_attention,
          },
          nowMs
        )
        const text = page.data.length
          ? `${page.data.length} contact(s):\n${page.data.map((c) => contactLine(c, team)).join('\n')}${pageFooter(page)}`
          : `No matching contacts.${pageFooter(page)}`
        return ok(text, page)
      }
    )

    registerReadTool(
      server,
      'list_inactive_contacts',
      {
        title: 'Inactive contacts',
        description:
          "Who hasn't come in N days. By default only people who attended at least once (gone quiet, not never-came) and only the roster (externals excluded).",
        shape: {
          days: z.coerce.number().int().min(1).max(3650).default(21).describe('No session in the last N days'),
          include_never_attended: z.boolean().default(false),
          only_with_plan: z.boolean().default(false).describe('Only people still holding a plan — paying but absent'),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(2000).optional(),
        },
      },
      async (args) => {
        const page = await listContacts(
          principal,
          team,
          {
            limit: args.limit,
            cursor: args.cursor,
            lifecycle: 'roster',
            inactiveDays: args.days,
            excludeNeverAttended: !args.include_never_attended,
            hasPlan: args.only_with_plan,
          },
          nowMs
        )
        const text = page.data.length
          ? `${page.data.length} contact(s) with no session in ${args.days} days:\n${page.data
              .map((c) => contactLine(c, team))
              .join('\n')}${pageFooter(page)}`
          : `Nobody on the roster has been away ${args.days} days.${pageFooter(page)}`
        return ok(text, page)
      }
    )

    registerReadTool(
      server,
      'get_contact',
      {
        title: 'Get a contact',
        description: "One person's record: lifecycle, trial journey, plans and credits, attendance and what needs attention.",
        shape: { contact_id: z.string().min(1).max(128) },
      },
      async (args) => {
        const contact = await getContact(principal, team, args.contact_id, nowMs)
        return ok(contactLine(contact, team), contact)
      }
    )
  }

  if (principalMay(principal, 'schedule:read')) {
    registerReadTool(
      server,
      'get_schedule',
      {
        title: 'Schedule',
        description: `Classes and appointments between two dates (at most ${SCHEDULE_MAX_DAYS} days), with bookings, capacity and waitlists.`,
        shape: sessionListShape(50, 100),
      },
      async (args) => {
        const page = await listSessions(
          principal,
          {
            fromMs: parseApiInstant(args.from, team.timeZone, 'from'),
            toMs: parseApiInstant(args.to, team.timeZone, 'to'),
            limit: args.limit,
            cursor: args.cursor,
            activityId: args.activity_id,
            maxWindowDays: SCHEDULE_MAX_DAYS,
          },
          nowMs
        )
        const text = page.data.length
          ? `${page.data.length} session(s):\n${page.data.map((s) => sessionLine(s, team)).join('\n')}${pageFooter(page)}`
          : `No sessions in that window.${pageFooter(page)}`
        return ok(text, page)
      }
    )
  }

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
