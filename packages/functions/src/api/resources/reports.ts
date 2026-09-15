// ─── Reports — stored weekly and monthly figures, read by id ────────────────
//
// Both are read by document id for the requested window and never recomputed:
// the weekly report is keyed by the ISO week its writer stamped, the finance
// month by the Europe/Zurich month the journal was bucketed in.

import * as admin from 'firebase-admin'
import {
  FINANCE_MONTHLY_REPORTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_WEEKLY_REPORTS_SUBCOLLECTION,
  isoWeekKeysBack,
  projectFinanceMonth,
  projectWeeklyReport,
  type ApiFinanceMonth,
  type ApiWeeklyReport,
  type FinanceMonthlyReport,
  type WeeklyReportRecord,
} from '@linyup/shared'
import { isFinancePluginActive } from '../../finance/access'
import type { ApiPrincipal } from '../auth/principal'
import { requireScope, type ListPage } from '../access'
import { ApiError } from '../errors'

export const WEEKLY_REPORT_MAX_WEEKS = 26
export const FINANCE_MAX_MONTHS = 24

function teamCollection(teamId: string, name: string) {
  return admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(name)
}

/** The last `weeks` weeks, this one included, oldest first. */
export async function getWeeklyReports(
  principal: ApiPrincipal,
  weeks: number,
  nowMs: number
): Promise<ListPage<ApiWeeklyReport>> {
  requireScope(principal, 'reports:read')
  const keys = isoWeekKeysBack(Math.min(Math.max(weeks, 1), WEEKLY_REPORT_MAX_WEEKS), new Date(nowMs))
  const col = teamCollection(principal.teamId, TEAM_WEEKLY_REPORTS_SUBCOLLECTION)
  const snaps = await admin.firestore().getAll(...keys.map((k) => col.doc(k)))
  const data = snaps.map((snap, i) => projectWeeklyReport(keys[i], snap.exists ? (snap.data() as WeeklyReportRecord) : null))
  return { object: 'list', data, has_more: false, next_cursor: null }
}

/** `YYYY-MM` months from `from` to `to`, inclusive. */
export function monthsBetween(from: string, to: string, max = FINANCE_MAX_MONTHS): string[] {
  const parse = (m: string) => {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(m)
    if (!match) throw new ApiError('invalid_request', `Not a month: ${m}`, 'Use YYYY-MM')
    return Number(match[1]) * 12 + Number(match[2]) - 1
  }
  const start = parse(from)
  const end = parse(to)
  if (end < start) throw new ApiError('invalid_request', '`to` must not be before `from`')
  if (end - start + 1 > max) {
    throw new ApiError('window_too_wide', `More than ${max} months`, `Ask for at most ${max} months at a time`)
  }
  const out: string[] = []
  for (let n = start; n <= end; n++) out.push(`${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`)
  return out
}

export async function getFinanceMonths(
  principal: ApiPrincipal,
  from: string,
  to: string
): Promise<ListPage<ApiFinanceMonth>> {
  requireScope(principal, 'finance:read')
  const months = monthsBetween(from, to)
  if (!(await isFinancePluginActive(principal.teamId))) {
    throw new ApiError('feature_unavailable', 'Revenue figures need the Finance plugin', 'The studio owner can install it under Plugins')
  }
  const col = teamCollection(principal.teamId, FINANCE_MONTHLY_REPORTS_SUBCOLLECTION)
  const snaps = await admin.firestore().getAll(...months.map((m) => col.doc(m)))
  const data = snaps.map((snap, i) => projectFinanceMonth(months[i], snap.exists ? (snap.data() as FinanceMonthlyReport) : null))
  return { object: 'list', data, has_more: false, next_cursor: null }
}
