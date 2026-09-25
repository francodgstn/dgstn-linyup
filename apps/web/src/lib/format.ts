// Shared formatting helpers.

import {
  createRegionalFormatter,
  DEFAULT_REGIONAL,
  type RegionalFormatter,
  type RegionalSettings,
} from '@linyup/shared'

// Formats a decimal amount (e.g. 49.9, NOT cents) in the given ISO 4217 currency.
// Used for subscription-type prices in the editor, contact assignment, and the
// public website pricing table.
export function formatCurrency(amount: number, currency: string, locale = 'de-CH'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: (currency || 'CHF').toUpperCase(),
  }).format(amount)
}

// ─── dates and times ──────────────────────────────────────────────────────────
// THE date/time entry point for apps/web. Everything that renders an instant
// should reach it through `useTeamFormat()` (hooks/useTeamFormat) so the
// studio's regional settings and the reader's UI language both apply. A bare
// `toLocaleDateString()` uses the BROWSER's locale, which is how an en-US
// browser came to show US dates and 12-hour times inside a German dashboard.
//
// This module only re-exports and thinly wraps the shared resolver; the model
// and the rules live in packages/shared/src/utils/regional.ts.

export {
  createRegionalFormatter,
  resolveRegional,
  regionalLocale,
  startOfWeek,
  weekdayOrder,
  DEFAULT_REGIONAL,
  DATE_FORMAT_SAMPLE,
  DATE_FORMAT_STYLES,
  TIME_FORMAT_STYLES,
} from '@linyup/shared'
export type {
  RegionalSettings,
  RegionalFormatter,
  DateFormatStyle,
  TimeFormatStyle,
  WeekStart,
  DateLike,
} from '@linyup/shared'

/** The zone the browser is actually in. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_REGIONAL.timezone
  } catch {
    return DEFAULT_REGIONAL.timezone
  }
}

/**
 * Formatter for code that runs outside React (a `queryFn`, a CSV builder) and
 * therefore cannot call the hook. Prefer `useTeamFormat()` in components — it
 * memoises and it already has the team.
 */
export function teamFormatter(
  language?: string | null,
  regional?: Partial<RegionalSettings> | null,
  timeZoneOverride?: string
): RegionalFormatter {
  return createRegionalFormatter(language, regional, timeZoneOverride)
}

/**
 * `YYYY-MM-DD` from a Date's LOCAL parts, for `<input type="date">`.
 *
 * Not a display format and not the formatter's `isoDate`: the native control is
 * device-local, and the obvious `toISOString().slice(0,10)` converts to UTC
 * first — so midnight in any zone ahead of UTC serializes as the PREVIOUS day
 * and the field shows a date nobody picked.
 */
export function toDateInputValue(date: Date | null | undefined): string {
  if (!date || isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
