// ─── The read tools — ONE definition, every front end ────────────────────────
//
// docs/public-api.md → "Read tools". A tool answers a question about the studio
// ("who has gone quiet?", "how full were Thursdays?") from the read layer
// (api/resources, api/insights) for ONE resolved principal. This registry is the
// only place a tool is defined. Two front ends publish it:
//
//   api/mcp/server.ts   the remote MCP server — Claude, ChatGPT, Claude Code
//   assistant/          the in-app assistant — Gemini function calling
//
// so an answer cannot depend on the door the question came through, and a tool
// added here reaches both. Nothing in this file imports an SDK.
//
// Each tool states WHO may use it (`available`: granted scopes intersected with
// the member's LIVE capabilities, through `principalMay`) and parses its own
// arguments with `parseInput` — the parser REST uses — so a front end never
// decides what "valid" means. A refusal of any kind comes back as a tool result
// with `isError`, never as a throw, so the model reads the hint and can recover.

import { z } from 'zod'
import { principalMay, type ApiPrincipal } from '../auth/principal'
import type { TeamReadContext } from '../context'
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
import {
  activityLine,
  contactLine,
  eventLine,
  localTime,
  money,
  pageFooter,
  personName,
  planLine,
  sessionLine,
  subscriptionLine,
} from './format'

/** The schedule window one tool call may cover. */
export const SCHEDULE_MAX_DAYS = 14

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Everything a tool needs to answer: who is asking, about which studio, when. */
export interface ReadToolContext {
  principal: ApiPrincipal
  team: TeamReadContext
  nowMs: number
}

export interface ReadTool {
  name: string
  title: string
  description: string
  /** The arguments, as a zod shape — published as JSON Schema by each front end. */
  shape: z.ZodRawShape
  /** May THIS principal use the tool? Scopes ∩ live capabilities, never granted alone. */
  available(ctx: ReadToolContext): boolean
  /** Parse the arguments with our schema, answer, and turn any failure into a tool error. */
  invoke(ctx: ReadToolContext, rawArgs: unknown): Promise<ToolResult>
}

export function ok(text: string, structured: object): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured as Record<string, unknown> }
}

export function failure(err: unknown): ToolResult {
  const e = toApiError(err)
  const issues = Array.isArray(e.details?.issues)
    ? ` (${(e.details.issues as Array<{ path: string; message: string }>).map((i) => `${i.path}: ${i.message}`).join('; ')})`
    : ''
  return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}${issues}${e.hint ? ` — ${e.hint}` : ''}` }] }
}

/** The text a model reads from a result, errors included. */
export function resultText(result: ToolResult): string {
  return result.content.map((c) => c.text).join('\n')
}

/**
 * Define a tool whose handler receives arguments typed from its own shape. The
 * returned `ReadTool` is erased to `unknown` arguments at the boundary, which is
 * exactly where `parseInput` re-establishes the type.
 */
function defineReadTool<S extends z.ZodRawShape>(def: {
  name: string
  title: string
  description: string
  shape: S
  available: (ctx: ReadToolContext) => boolean
  run: (ctx: ReadToolContext, args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
}): ReadTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    shape: def.shape,
    available: def.available,
    async invoke(ctx, rawArgs) {
      try {
        return await def.run(ctx, parseInput(def.shape, rawArgs ?? {}))
      } catch (err) {
        return failure(err)
      }
    },
  }
}

const may = (...scopes: Parameters<typeof principalMay>[1][]) => (ctx: ReadToolContext) =>
  scopes.every((s) => principalMay(ctx.principal, s))

const range = (a: { from: string; to: string }, team: TeamReadContext) => ({
  fromMs: parseApiInstant(a.from, team.timeZone, 'from'),
  toMs: parseApiInstant(a.to, team.timeZone, 'to'),
})

export const READ_TOOLS: readonly ReadTool[] = [
  defineReadTool({
    name: 'get_studio_overview',
    title: 'Studio overview',
    description: "The studio's name, today's date in its time zone, its currency, and what this connection may read.",
    shape: {},
    available: () => true,
    run: async ({ principal, team, nowMs }) => {
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
    },
  }),

  // ── people ────────────────────────────────────────────────────────────────
  defineReadTool({
    name: 'find_contacts',
    title: 'Find contacts',
    description:
      'Search and filter the people of the studio: by name, lifecycle, engagement band, tags, coach, trial stage, inactivity, plan. Returns one line per person.',
    shape: contactListShape(25, 100),
    available: may('contacts:read'),
    run: async ({ principal, team, nowMs }, args) => {
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
    },
  }),

  defineReadTool({
    name: 'list_inactive_contacts',
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
    available: may('contacts:read'),
    run: async ({ principal, team, nowMs }, args) => {
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
    },
  }),

  defineReadTool({
    name: 'get_contact',
    title: 'Get a contact',
    description: "One person's record: lifecycle, trial journey, plans and credits, attendance and what needs attention.",
    shape: { contact_id: z.string().min(1).max(128) },
    available: may('contacts:read'),
    run: async ({ principal, team, nowMs }, args) => {
      const contact = await getContact(principal, team, args.contact_id, nowMs)
      return ok(contactLine(contact, team), contact)
    },
  }),

  defineReadTool({
    name: 'get_contact_history',
    title: "A contact's bookings and visits",
    description: "One person's recent bookings and check-ins, newest first, with the class and time of each.",
    shape: { contact_id: z.string().min(1).max(128), ...historyShape(20, 100) },
    available: may('contacts:read', 'schedule:read'),
    run: async ({ principal, team, nowMs }, args) => {
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
    },
  }),

  // ── schedule ──────────────────────────────────────────────────────────────
  defineReadTool({
    name: 'get_schedule',
    title: 'Schedule',
    description: `Classes and appointments between two dates (at most ${SCHEDULE_MAX_DAYS} days), with bookings, capacity and waitlists.`,
    shape: sessionListShape(50, 100),
    available: may('schedule:read'),
    run: async ({ principal, team, nowMs }, args) => {
      const page = await listSessions(
        principal,
        { ...range(args, team), limit: args.limit, cursor: args.cursor, activityId: args.activity_id, maxWindowDays: SCHEDULE_MAX_DAYS },
        nowMs
      )
      const text = page.data.length
        ? `${page.data.length} session(s):\n${page.data.map((s) => sessionLine(s, team)).join('\n')}${pageFooter(page)}`
        : `No sessions in that window.${pageFooter(page)}`
      return ok(text, page)
    },
  }),

  defineReadTool({
    name: 'get_session_roster',
    title: 'Session roster',
    description: 'Who booked and who checked in for one session. People this connection may not name are counted, not listed.',
    shape: { session_id: z.string().min(1).max(128) },
    available: may('schedule:read'),
    run: async ({ principal, team, nowMs }, args) => {
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
    },
  }),

  defineReadTool({
    name: 'list_events',
    title: 'Events',
    description: 'The studio’s events (seminars, camps, competitions) between two dates, with registrations and fees.',
    shape: eventListShape(25, 100),
    available: may('schedule:read'),
    run: async ({ principal, team }, args) => {
      const page = await listEvents(principal, team, { ...range(args, team), limit: args.limit })
      const text = page.data.length
        ? `${page.data.length} event(s):\n${page.data.map((e) => eventLine(e, team)).join('\n')}${pageFooter(page)}`
        : `No events in that window.${pageFooter(page)}`
      return ok(text, page)
    },
  }),

  defineReadTool({
    name: 'get_class_fill_rates',
    title: 'Class fill rates',
    description: `How full classes are over a period (at most ${CLASS_FILL_MAX_DAYS} days), per class, per weekly slot ("Thu 18:00") or per instructor. Cancelled sessions and appointments are left out.`,
    shape: classFillShape,
    // Whole-studio figures: a coach who sees only their own sessions does not get them.
    available: (ctx) => principalMay(ctx.principal, 'schedule:read') && principalSeesWholeSchedule(ctx.principal),
    run: async ({ principal, team, nowMs }, args) => {
      const fill = await getClassFill(principal, team, { ...range(args, team), groupBy: args.group_by, activityId: args.activity_id }, nowMs)
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
    },
  }),

  // ── offerings, memberships, reports ───────────────────────────────────────
  defineReadTool({
    name: 'list_offerings',
    title: 'Classes and plans',
    description: 'What the studio offers: its classes and appointment types with prices, and its plans with prices and credits.',
    shape: { kind: z.enum(['all', 'activities', 'plans']).default('all') },
    available: may('offerings:read'),
    run: async ({ principal, team }, args) => {
      const [activities, plans] = await Promise.all([
        args.kind === 'plans' ? null : listActivities(principal, team),
        args.kind === 'activities' ? null : listPlans(principal, team),
      ])
      const lines: string[] = []
      if (activities) lines.push(`Activities (${activities.data.length}):`, ...activities.data.map(activityLine))
      if (plans) lines.push(`Plans (${plans.data.length}):`, ...plans.data.map(planLine))
      return ok(lines.join('\n'), { activities: activities?.data ?? null, plans: plans?.data ?? null })
    },
  }),

  defineReadTool({
    name: 'list_memberships',
    title: 'Memberships',
    description:
      'Stripe memberships by state: live, cancelling (running but will not renew — with the end date and reason), past_due, trialing or ended.',
    shape: subscriptionListShape(25, 100),
    available: may('subscriptions:read'),
    run: async ({ principal, team, nowMs }, args) => {
      const page = await listSubscriptions(principal, team, { state: args.state, limit: args.limit }, nowMs)
      const text = page.data.length
        ? `${page.data.length} ${args.state} membership(s):\n${page.data.map((s) => subscriptionLine(s, team)).join('\n')}${pageFooter(page)}`
        : `No ${args.state} memberships.`
      return ok(text, page)
    },
  }),

  defineReadTool({
    name: 'get_attendance_trend',
    title: 'Weekly trend',
    description: 'Week by week: sessions, bookings, active contacts, members with a plan, and trial conversions.',
    shape: weeklyReportShape,
    available: may('reports:read'),
    run: async ({ principal, nowMs }, args) => {
      const page = await getWeeklyReports(principal, args.weeks, nowMs)
      const lines = page.data.map((w) =>
        w.generated
          ? `- ${w.iso_week}: ${w.sessions} sessions, ${w.bookings} bookings, ${w.active_contacts} active contacts, ${w.contacts_with_plan} with a plan, ${w.trial_conversions} trial conversions`
          : `- ${w.iso_week}: no report yet`
      )
      return ok(`Weekly figures, oldest first:\n${lines.join('\n')}`, page)
    },
  }),

  defineReadTool({
    name: 'get_revenue_summary',
    title: 'Revenue by month',
    description:
      'Monthly revenue from the Finance plugin: gross, fees, net, refunds and payouts. Months are Europe/Zurich calendar months; the running month has no report until it closes.',
    shape: financeReportShape,
    available: may('finance:read'),
    run: async ({ principal, team }, args) => {
      const page = await getFinanceMonths(principal, args.from, args.to)
      const lines = page.data.map((m) => {
        if (!m.generated || !m.totals) return `- ${m.month}: no report yet`
        const cur = m.currencies[0] ?? team.currency
        const fmt = (n: number) => money({ amount: n, currency: cur })
        return `- ${m.month}: net ${fmt(m.totals.net)} (gross ${fmt(m.totals.gross)}, fees ${fmt(m.totals.stripe_fees + m.totals.platform_fees)}), ${m.transactions} transactions${m.refunds?.count ? `, ${m.refunds.count} refunds (${fmt(m.refunds.amount)})` : ''}`
      })
      return ok(`Revenue by month:\n${lines.join('\n')}`, page)
    },
  }),
]

/** The tools THIS principal may use, in registry order. */
export function toolsFor(ctx: ReadToolContext): ReadTool[] {
  return READ_TOOLS.filter((tool) => tool.available(ctx))
}
