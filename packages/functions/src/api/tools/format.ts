// ─── What a model reads — one line per record ───────────────────────────────
//
// The text half of every read tool's answer (the other half is the same rows as
// structured data). Shared by every front end that hands these tools to a model:
// the remote MCP server and the in-app assistant read identical lines, so an
// answer does not change with the door it was asked through. Money arrives in
// minor units and is written as the studio reads it; times are the studio's zone.

import type { ApiActivity, ApiContact, ApiEvent, ApiMoney, ApiPerson, ApiPlan, ApiSession, ApiSubscription } from '@linyup/shared'
import type { ListPage } from '../access'
import type { TeamReadContext } from '../context'

export function localTime(iso: string | null, team: TeamReadContext): string {
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

export function localDate(iso: string | null, team: TeamReadContext): string {
  if (!iso) return '?'
  return new Intl.DateTimeFormat('en-GB', { timeZone: team.timeZone, day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(iso)
  )
}

export function money(m: ApiMoney | null | undefined): string {
  if (!m) return '—'
  return `${m.currency} ${(m.amount / 100).toFixed(2)}`
}

export function personName(p: ApiPerson | null): string {
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

export function activityLine(a: ApiActivity): string {
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

export function planLine(p: ApiPlan): string {
  const prices = p.prices
    .filter((x) => x.active)
    .map((x) => `${money(x.price)} ${x.recurrence}${x.credits ? ` (${x.credits} credits)` : ''}`)
    .join(', ')
  return `- ${p.name ?? '(unnamed)'} [${p.id}] · ${p.source}${p.active ? '' : ' · inactive'}${prices ? ` · ${prices}` : ''}`
}

export function subscriptionLine(s: ApiSubscription, team: TeamReadContext): string {
  const parts = [`- ${personName(s.contact)} · ${s.plan.name ?? s.plan.id ?? '?'} · ${s.status}`]
  if (s.price) parts.push(`${money(s.price)} ${s.recurrence ?? ''}`.trim())
  if (s.paused) parts.push('paused')
  if (s.cancelling) parts.push(s.ends_at ? `ends ${localDate(s.ends_at, team)}` : 'canceling (end date unknown)')
  if (s.cancellation?.reason) parts.push(`reason: ${s.cancellation.reason}`)
  return parts.join(' · ')
}

export function eventLine(e: ApiEvent, team: TeamReadContext): string {
  return (
    `- ${localTime(e.start, team)} · ${e.title ?? '(untitled)'} [${e.id}] · ${e.type}` +
    ` · ${e.participants} registered` +
    (e.fee && e.fee.amount > 0 ? ` · fee ${money(e.fee)}` : '') +
    (e.status !== 'open' ? ` · ${e.status}` : '')
  )
}

export function pageFooter(page: ListPage<unknown>): string {
  if (!page.has_more) return ''
  if (!page.next_cursor) return '\n(More exist than shown; narrow the question to see them.)'
  return page.scan_exhausted
    ? `\n(Stopped after reading ${page.scanned} records; call again with cursor "${page.next_cursor}" to keep looking.)`
    : `\n(More results: call again with cursor "${page.next_cursor}".)`
}
