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
import type {
  ApiActivity,
  ApiContact,
  ApiEvent,
  ApiMoney,
  ApiPerson,
  ApiPlan,
  ApiScope,
  ApiSession,
  ApiSubscription,
} from '@linyup/shared'
import { principalMay, type ApiPrincipal } from '../auth/principal'
import type { ApiRequest, ApiResponse, ListPage } from '../access'
import { loadTeamContext, type TeamReadContext } from '../context'
import { toApiError } from '../errors'
import { CLASS_FILL_MAX_DAYS, getClassFill, principalSeesWholeSchedule } from '../insights/classFill'
import { getContact, listContacts } from '../resources/contacts'
import { listEvents } from '../resources/events'
import { listActivities, listPlans } from '../resources/offerings'
import { getContactHistory, getSessionRoster } from '../resources/people'
import { getFinanceMonths, getWeeklyReports } from '../resources/reports'
import { listSessions } from '../resources/sessions'
import { listSubscriptions } from '../resources/subscriptions'
import { describeScopes } from '../rest'
import {
  classFillShape,
  contactListShape,
  eventListShape,
  financeReportShape,
  historyShape,
  parseInput,
  sessionListShape,
  subscriptionListShape,
  weeklyReportShape,
} from '../schemas'
import { parseApiInstant, zonedYmd } from '../time'

export const MCP_SERVER_NAME = 'linyup'
export const MCP_SERVER_VERSION = '1.1.0'
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

// ─── text formatting — what the model reads ──────────────────────────────────

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

function localDate(iso: string | null, team: TeamReadContext): string {
  if (!iso) return '?'
  return new Intl.DateTimeFormat('en-GB', { timeZone: team.timeZone, day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(iso)
  )
}

export function money(m: ApiMoney | null | undefined): string {
  if (!m) return '—'
  return `${m.currency} ${(m.amount / 100).toFixed(2)}`
}

function personName(p: ApiPerson | null): string {
  if (!p) return '(hidden)'
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || '(no name)'
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

function activityLine(a: ApiActivity): string {
  const parts = [`- ${a.name ?? '(unnamed)'} [${a.id}] · ${a.type}`]
  if (!a.active) parts.push('inactive')
  if (a.drop_in?.enabled) parts.push(`drop-in ${money(a.drop_in.price)}`)
  if (a.trial?.enabled) parts.push(a.trial.price ? `trial ${money(a.trial.price)}` : 'free trial')
  if (a.access?.require_plan) parts.push('plan required')
  if (a.waitlist_enabled) parts.push('waitlist')
  if (a.durations.length) {
    parts.push(a.durations.map((d) => `${d.minutes} min ${d.price ? money(d.price) : d.sale}`).join(', '))
  }
  return parts.join(' · ')
}

function planLine(p: ApiPlan): string {
  const prices = p.prices
    .filter((x) => x.active)
    .map((x) => `${money(x.price)} ${x.recurrence}${x.credits ? ` (${x.credits} credits)` : ''}`)
    .join(', ')
  return `- ${p.name ?? '(unnamed)'} [${p.id}] · ${p.source}${p.active ? '' : ' · inactive'}${prices ? ` · ${prices}` : ''}`
}

function subscriptionLine(s: ApiSubscription, team: TeamReadContext): string {
  const parts = [`- ${personName(s.contact)} · ${s.plan.name ?? s.plan.id ?? '?'} · ${s.status}`]
  if (s.price) parts.push(`${money(s.price)} ${s.recurrence ?? ''}`.trim())
  if (s.paused) parts.push('paused')
  if (s.cancelling) parts.push(s.ends_at ? `ends ${localDate(s.ends_at, team)}` : 'cancelling (end date unknown)')
  if (s.cancellation?.reason) parts.push(`reason: ${s.cancellation.reason}`)
  return parts.join(' · ')
}

function eventLine(e: ApiEvent, team: TeamReadContext): string {
  return (
    `- ${localTime(e.start, team)} · ${e.title ?? '(untitled)'} [${e.id}] · ${e.type}` +
    ` · ${e.participants} registered` +
    (e.fee && e.fee.amount > 0 ? ` · fee ${money(e.fee)}` : '') +
    (e.status !== 'open' ? ` · ${e.status}` : '')
  )
}

function pageFooter(page: ListPage<unknown>): string {
  if (!page.has_more) return ''
  if (!page.next_cursor) return '\n(More exist than shown; narrow the question to see them.)'
  return page.scan_exhausted
    ? `\n(Stopped after reading ${page.scanned} records; call again with cursor "${page.next_cursor}" to keep looking.)`
    : `\n(More results: call again with cursor "${page.next_cursor}".)`
}

export function serverInstructions(principal: ApiPrincipal, team: TeamReadContext, nowMs: number): string {
  const { usable } = describeScopes(principal)
  const watched: ApiScope[] = [
    'contacts:read',
    'contacts:read:pii',
    'schedule:read',
    'offerings:read',
    'subscriptions:read',
    'reports:read',
    'finance:read',
  ]
  const missing = watched.filter((s) => !usable.includes(s))
  return [
    `You are connected, read-only, to the Linyup studio "${team.name}".`,
    `Today is ${zonedYmd(nowMs, team.timeZone)} in ${team.timeZone}; give times in that zone. Money is in minor units (divide by 100); the studio's currency is ${team.currency}.`,
    'People: "roster" means members and leads the studio looks after; "external" means people who train here without being on the roster (partner-app drop-ins, former members) and are not churn. Leads are not yet confirmed.',
    'Engagement bands (active, low, at_risk, inactive) are measured from the last attended session.',
    missing.length
      ? `This connection cannot see: ${missing.join(', ')}. Say so rather than guessing.`
      : 'This connection can see everything the API offers, contact details included.',
  ].join('\n')
}

export function buildMcpServer(principal: ApiPrincipal, team: TeamReadContext, nowMs: number): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: serverInstructions(principal, team, nowMs) }
  )
  const range = (a: { from: string; to: string }) => ({
    fromMs: parseApiInstant(a.from, team.timeZone, 'from'),
    toMs: parseApiInstant(a.to, team.timeZone, 'to'),
  })

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

  // ── people ──────────────────────────────────────────────────────────────────
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

    if (principalMay(principal, 'schedule:read')) {
      registerReadTool(
        server,
        'get_contact_history',
        {
          title: "A contact's bookings and visits",
          description: "One person's recent bookings and check-ins, newest first, with the class and time of each.",
          shape: { contact_id: z.string().min(1).max(128), ...historyShape(20, 100) },
        },
        async (args) => {
          const history = await getContactHistory(principal, team, args.contact_id, args.limit, nowMs)
          const lines = [contactLine(history.contact, team)]
          lines.push(`Bookings (${history.bookings.length}):`)
          for (const b of history.bookings) {
            lines.push(
              `  - ${localTime(b.session.start, team)} · ${b.session.activity ?? '?'} · ${b.status}${b.is_trial ? ' · trial' : ''}${b.paid ? ' · paid' : ''}`
            )
          }
          lines.push(`Check-ins (${history.attendance.length}):`)
          for (const a of history.attendance) lines.push(`  - ${localTime(a.session.start, team)} · ${a.session.activity ?? '?'}`)
          return ok(lines.join('\n'), history)
        }
      )
    }
  }

  // ── schedule ────────────────────────────────────────────────────────────────
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
          { ...range(args), limit: args.limit, cursor: args.cursor, activityId: args.activity_id, maxWindowDays: SCHEDULE_MAX_DAYS },
          nowMs
        )
        const text = page.data.length
          ? `${page.data.length} session(s):\n${page.data.map((s) => sessionLine(s, team)).join('\n')}${pageFooter(page)}`
          : `No sessions in that window.${pageFooter(page)}`
        return ok(text, page)
      }
    )

    registerReadTool(
      server,
      'get_session_roster',
      {
        title: 'Session roster',
        description:
          'Who booked and who checked in for one session. People this connection may not name are counted, not listed.',
        shape: { session_id: z.string().min(1).max(128) },
      },
      async (args) => {
        const roster = await getSessionRoster(principal, team, args.session_id, nowMs)
        const lines = [sessionLine(roster.session, team), `Booked (${roster.bookings.length}):`]
        for (const b of roster.bookings) {
          lines.push(`  - ${personName(b.contact)} · ${b.status}${b.is_trial ? ' · trial' : ''}${b.paid ? ' · paid' : ''}`)
        }
        if (roster.hidden_bookings) lines.push(`  (+${roster.hidden_bookings} not shown)`)
        lines.push(`Checked in (${roster.attendance.length}):`)
        for (const a of roster.attendance) lines.push(`  - ${personName(a.contact)}`)
        if (roster.hidden_attendance) lines.push(`  (+${roster.hidden_attendance} not shown)`)
        return ok(lines.join('\n'), roster)
      }
    )

    registerReadTool(
      server,
      'list_events',
      {
        title: 'Events',
        description: 'The studio’s events (seminars, camps, competitions) between two dates, with registrations and fees.',
        shape: eventListShape(25, 100),
      },
      async (args) => {
        const page = await listEvents(principal, team, { ...range(args), limit: args.limit })
        const text = page.data.length
          ? `${page.data.length} event(s):\n${page.data.map((e) => eventLine(e, team)).join('\n')}${pageFooter(page)}`
          : `No events in that window.${pageFooter(page)}`
        return ok(text, page)
      }
    )

    if (principalSeesWholeSchedule(principal)) {
      registerReadTool(
        server,
        'get_class_fill_rates',
        {
          title: 'Class fill rates',
          description: `How full classes are over a period (at most ${CLASS_FILL_MAX_DAYS} days), per class, per weekly slot ("Thu 18:00") or per instructor. Cancelled sessions and appointments are left out.`,
          shape: classFillShape,
        },
        async (args) => {
          const fill = await getClassFill(
            principal,
            team,
            { ...range(args), groupBy: args.group_by, activityId: args.activity_id },
            nowMs
          )
          const lines = fill.rows.map(
            (r) =>
              `- ${r.label} · ${r.sessions} session(s)` +
              (r.avg_fill_percent === null ? ' · no capacity set' : ` · ${r.avg_fill_percent}% full on average · ${r.full_sessions} full`) +
              ` · avg ${r.avg_booked} booked, ${r.avg_attended} attended`
          )
          const text = lines.length
            ? `Fill rates over ${fill.sessions_counted} session(s), by ${fill.group_by}:\n${lines.join('\n')}${fill.truncated ? '\n(Too many sessions; the period was cut short.)' : ''}`
            : 'No classes in that period.'
          return ok(text, fill)
        }
      )
    }
  }

  // ── offerings, memberships, reports ─────────────────────────────────────────
  if (principalMay(principal, 'offerings:read')) {
    registerReadTool(
      server,
      'list_offerings',
      {
        title: 'Classes and plans',
        description: 'What the studio offers: its classes and appointment types with prices, and its plans with prices and credits.',
        shape: { kind: z.enum(['all', 'activities', 'plans']).default('all') },
      },
      async (args) => {
        const [activities, plans] = await Promise.all([
          args.kind === 'plans' ? null : listActivities(principal, team),
          args.kind === 'activities' ? null : listPlans(principal, team),
        ])
        const lines: string[] = []
        if (activities) lines.push(`Activities (${activities.data.length}):`, ...activities.data.map(activityLine))
        if (plans) lines.push(`Plans (${plans.data.length}):`, ...plans.data.map(planLine))
        return ok(lines.join('\n'), { activities: activities?.data ?? null, plans: plans?.data ?? null })
      }
    )
  }

  if (principalMay(principal, 'subscriptions:read')) {
    registerReadTool(
      server,
      'list_memberships',
      {
        title: 'Memberships',
        description:
          'Stripe memberships by state: live, cancelling (running but will not renew — with the end date and reason), past_due, trialing or ended.',
        shape: subscriptionListShape(25, 100),
      },
      async (args) => {
        const page = await listSubscriptions(principal, team, { state: args.state, limit: args.limit }, nowMs)
        const text = page.data.length
          ? `${page.data.length} ${args.state} membership(s):\n${page.data.map((s) => subscriptionLine(s, team)).join('\n')}${pageFooter(page)}`
          : `No ${args.state} memberships.`
        return ok(text, page)
      }
    )
  }

  if (principalMay(principal, 'reports:read')) {
    registerReadTool(
      server,
      'get_attendance_trend',
      {
        title: 'Weekly trend',
        description: 'Week by week: sessions, bookings, active contacts, members with a plan, and trial conversions.',
        shape: weeklyReportShape,
      },
      async (args) => {
        const page = await getWeeklyReports(principal, args.weeks, nowMs)
        const lines = page.data.map((w) =>
          w.generated
            ? `- ${w.iso_week}: ${w.sessions} sessions, ${w.bookings} bookings, ${w.active_contacts} active contacts, ${w.contacts_with_plan} with a plan, ${w.trial_conversions} trial conversions`
            : `- ${w.iso_week}: no report yet`
        )
        return ok(`Weekly figures, oldest first:\n${lines.join('\n')}`, page)
      }
    )
  }

  if (principalMay(principal, 'finance:read')) {
    registerReadTool(
      server,
      'get_revenue_summary',
      {
        title: 'Revenue by month',
        description:
          'Monthly revenue from the Finance plugin: gross, fees, net, refunds and payouts. Months are Europe/Zurich calendar months; the running month has no report until it closes.',
        shape: financeReportShape,
      },
      async (args) => {
        const page = await getFinanceMonths(principal, args.from, args.to)
        const lines = page.data.map((m) => {
          if (!m.generated || !m.totals) return `- ${m.month}: no report yet`
          const cur = m.currencies[0] ?? team.currency
          const fmt = (n: number) => money({ amount: n, currency: cur })
          return `- ${m.month}: net ${fmt(m.totals.net)} (gross ${fmt(m.totals.gross)}, fees ${fmt(m.totals.stripe_fees + m.totals.platform_fees)}), ${m.transactions} transactions${m.refunds?.count ? `, ${m.refunds.count} refunds (${fmt(m.refunds.amount)})` : ''}`
        })
        return ok(`Revenue by month:\n${lines.join('\n')}`, page)
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
