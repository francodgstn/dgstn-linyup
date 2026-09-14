// ─── Request schemas — shared by REST query parsing and MCP tool inputs ──────
//
// One zod shape per question, so `GET /v1/contacts?inactive_days=21` and the
// `find_contacts` tool accept the same thing and refuse the same thing. REST
// sends strings (hence the preprocessing of lists and booleans); MCP sends JSON.

import { z } from 'zod'
import { ACQUISITION_STAGES, ENGAGEMENT_BANDS, type EngagementBand } from '@linyup/shared'
import { ApiError } from './errors'
import { FILL_GROUPS } from './insights/classFill'
import { MEMBERSHIP_STATES } from './resources/subscriptions'

const list = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.array(item).max(20)
  )

const flag = z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v), z.boolean())

const limit = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback).describe(`Rows per page, at most ${max}`)

const cursor = z.string().max(2000).optional().describe('The next_cursor of the previous page')

const rangeFrom = z.string().min(10).max(40).describe('YYYY-MM-DD (a studio day) or an ISO 8601 instant with offset')
const rangeTo = z.string().min(10).max(40).describe('YYYY-MM-DD (inclusive studio day) or an ISO 8601 instant with offset')
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
const id = z.string().min(1).max(128)

export const CONTACT_LIFECYCLE_VIEWS = ['live', 'roster', 'external', 'leads'] as const

export function contactListShape(defaultLimit: number, maxLimit: number) {
  return {
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Search by name (and by email or phone only when this connection may read them)'),
    lifecycle: z
      .enum(CONTACT_LIFECYCLE_VIEWS)
      .default('live')
      .describe(
        'live = everyone current; roster = members and leads the studio looks after; external = drop-ins not on the roster; leads = not yet confirmed'
      ),
    engagement: list(z.enum(ENGAGEMENT_BANDS as [EngagementBand, ...EngagementBand[]]))
      .optional()
      .describe('Engagement bands: active, low, at_risk, inactive'),
    tags: list(z.string().min(1).max(60)).optional(),
    coach_id: id.optional().describe('Only contacts assigned to this coach'),
    stages: list(z.enum(ACQUISITION_STAGES)).optional().describe('Trial funnel stages'),
    inactive_days: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe('No session in the last N days (never-attended contacts included)'),
    has_plan: flag.optional().describe('Only contacts holding at least one plan'),
    needs_attention: flag.optional().describe('Only contacts the studio should follow up'),
    limit: limit(defaultLimit, maxLimit),
    cursor,
  }
}

export function sessionListShape(defaultLimit: number, maxLimit: number) {
  return {
    from: rangeFrom,
    to: rangeTo,
    activity_id: id.optional(),
    limit: limit(defaultLimit, maxLimit),
    cursor,
  }
}

export function historyShape(defaultLimit: number, maxLimit: number) {
  return { limit: limit(defaultLimit, maxLimit) }
}

export function subscriptionListShape(defaultLimit: number, maxLimit: number) {
  return {
    state: z
      .enum(MEMBERSHIP_STATES)
      .default('live')
      .describe('live = every running membership; cancelling = running but will not renew; past_due; trialing; ended'),
    limit: limit(defaultLimit, maxLimit),
  }
}

export function eventListShape(defaultLimit: number, maxLimit: number) {
  return { from: rangeFrom, to: rangeTo, limit: limit(defaultLimit, maxLimit) }
}

export const weeklyReportShape = {
  weeks: z.coerce.number().int().min(1).max(26).default(12).describe('How many weeks back, this week included'),
}

export const financeReportShape = {
  from: month.describe('First month, YYYY-MM'),
  to: month.describe('Last month, YYYY-MM'),
}

export const classFillShape = {
  from: rangeFrom,
  to: rangeTo,
  group_by: z
    .enum(FILL_GROUPS)
    .default('activity')
    .describe('activity = per class; weekday_time = per weekly slot, e.g. "Thu 18:00"; provider = per instructor'),
  activity_id: id.optional(),
}

/** Parse against a shape, turning zod's issues into an `invalid_request`. */
export function parseInput<S extends z.ZodRawShape>(shape: S, input: unknown): z.infer<z.ZodObject<S>> {
  const result = z.object(shape).safeParse(input ?? {})
  if (!result.success) {
    throw new ApiError('invalid_request', 'The request parameters are not valid', undefined, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  return result.data
}
