// ─── Class fill rates — "how full are Thursday classes?" ────────────────────
//
// A pure `computeClassFill` over projected sessions, so the model never pages
// through a schedule and adds it up itself, and the arithmetic is fixture-tested.
// Classes only: an appointment is one person's exclusive time and is "full" by
// definition. Canceled sessions are left out; a session with no capacity is
// counted but has no fill rate.

import type { ApiSession } from '@linyup/shared'
import type { ApiPrincipal } from '../auth/principal'
import { requireScope } from '../access'
import type { TeamReadContext } from '../context'
import { ApiError } from '../errors'
import { listSessions } from '../resources/sessions'

export const FILL_GROUPS = ['activity', 'weekday_time', 'provider'] as const
export type FillGroupBy = (typeof FILL_GROUPS)[number]

/** The widest window one fill-rate question may cover. */
export const CLASS_FILL_MAX_DAYS = 92
const MAX_PAGES = 10

export interface FillRow {
  key: string
  label: string
  sessions: number
  /** Sessions with a capacity — the ones a fill rate means anything for. */
  capped_sessions: number
  avg_fill_percent: number | null
  full_sessions: number
  avg_booked: number
  avg_attended: number
}

function slotLabel(iso: string | null, timeZone: string): string {
  if (!iso) return '?'
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('weekday')} ${get('hour')}:${get('minute')}`
}

const round1 = (n: number) => Math.round(n * 10) / 10

export function computeClassFill(sessions: ApiSession[], groupBy: FillGroupBy, timeZone: string): FillRow[] {
  const groups = new Map<
    string,
    { label: string; sessions: number; capped: number; fillSum: number; full: number; booked: number; attended: number }
  >()
  for (const s of sessions) {
    if (s.activity.type !== 'class' || s.status === 'cancelled') continue
    let key: string
    let label: string
    if (groupBy === 'activity') {
      key = s.activity.id ?? s.activity.name ?? '?'
      label = s.activity.name ?? '(unnamed class)'
    } else if (groupBy === 'provider') {
      key = s.provider?.id ?? '(none)'
      label = s.provider?.name ?? '(no instructor)'
    } else {
      label = slotLabel(s.start, timeZone)
      key = label
    }
    const g = groups.get(key) ?? { label, sessions: 0, capped: 0, fillSum: 0, full: 0, booked: 0, attended: 0 }
    g.sessions += 1
    g.booked += s.booked
    g.attended += s.attended
    if (typeof s.capacity === 'number' && s.capacity > 0) {
      g.capped += 1
      g.fillSum += Math.min(s.booked / s.capacity, 1)
      if (s.booked >= s.capacity) g.full += 1
    }
    groups.set(key, g)
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: g.label,
      sessions: g.sessions,
      capped_sessions: g.capped,
      avg_fill_percent: g.capped > 0 ? Math.round((g.fillSum / g.capped) * 100) : null,
      full_sessions: g.full,
      avg_booked: round1(g.booked / g.sessions),
      avg_attended: round1(g.attended / g.sessions),
    }))
    .sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label))
}

/** Fill rates describe the whole studio; a coach limited to their own sessions would see a partial answer. */
export function principalSeesWholeSchedule(principal: ApiPrincipal): boolean {
  return principal.dataScope === 'all' || principal.capabilities.has('schedule.view.all')
}

export interface ApiClassFill {
  object: 'class_fill'
  from: string
  to: string
  group_by: FillGroupBy
  time_zone: string
  sessions_counted: number
  truncated: boolean
  rows: FillRow[]
}

export async function getClassFill(
  principal: ApiPrincipal,
  team: TeamReadContext,
  input: { fromMs: number; toMs: number; groupBy: FillGroupBy; activityId?: string | null },
  nowMs: number
): Promise<ApiClassFill> {
  requireScope(principal, 'schedule:read')
  if (!principalSeesWholeSchedule(principal)) {
    throw new ApiError('insufficient_scope', 'Fill rates need access to the whole schedule', undefined, {
      required: 'schedule.view.all',
    })
  }
  const sessions: ApiSession[] = []
  let cursor: string | null = null
  let truncated = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listSessions(
      principal,
      {
        fromMs: input.fromMs,
        toMs: input.toMs,
        limit: 200,
        cursor,
        activityId: input.activityId,
        maxWindowDays: CLASS_FILL_MAX_DAYS,
      },
      nowMs
    )
    sessions.push(...result.data)
    if (!result.has_more) break
    cursor = result.next_cursor
    truncated = page === MAX_PAGES - 1
  }
  return {
    object: 'class_fill',
    from: new Date(input.fromMs).toISOString(),
    to: new Date(input.toMs).toISOString(),
    group_by: input.groupBy,
    time_zone: team.timeZone,
    sessions_counted: sessions.length,
    truncated,
    rows: computeClassFill(sessions, input.groupBy, team.timeZone),
  }
}
