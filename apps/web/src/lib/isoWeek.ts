// ISO-week LABELS for the dashboard charts. The key grammar itself — what a
// date's week is called, and the window of keys a trend card plots — is
// @linyup/shared's `isoWeekKey` / `isoWeekKeysBack`, the same generator the
// functions write `*_weekly_reports` with and the member app reads them by.
// This file used to carry a second generator (UTC midnight where shared uses
// UTC noon; same keys today, two places to break tomorrow); it now only turns
// a key back into words.

import { subWeeks, parse, format } from 'date-fns'
import { isoWeekKeysBack } from '@linyup/shared'

export function isoWeekToDate(isoWeek: string): Date {
  return parse(isoWeek, "RRRR-'W'II", new Date())
}

/** The `weeks` keys ending `offset` weeks ago, oldest first — a trend window
 *  and, with an offset, the comparison window before it. */
export function buildWeekKeys(weeks: number, offset = 0): string[] {
  return isoWeekKeysBack(weeks, subWeeks(new Date(), offset))
}

export function shortWeekLabel(isoWeek: string, prevIsoWeek?: string): string {
  try {
    const d = isoWeekToDate(isoWeek)
    const prevD = prevIsoWeek ? isoWeekToDate(prevIsoWeek) : null
    const showYear = !prevD || d.getFullYear() !== prevD.getFullYear()
    return showYear ? format(d, "'W'II ''yy") : format(d, "'W'II")
  } catch {
    return isoWeek
  }
}

export function formatTooltipWeek(isoWeek: string): string {
  try {
    return format(isoWeekToDate(isoWeek), "'Week of' MMM d, yyyy")
  } catch {
    return isoWeek
  }
}

export function formatAxisWeek(isoWeek: string): string {
  try {
    return format(isoWeekToDate(isoWeek), "'W'II")
  } catch {
    return isoWeek
  }
}
