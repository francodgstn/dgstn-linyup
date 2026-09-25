// Ported from hmd-lineup/functions/src/utils/dateFormatting.js
// Date formatting utilities for email templates and .ics attachments.
//
// Every function here already took a `timezone` and a `language`; until the
// team-wide regional settings existed there was nothing for a call site to pass,
// so every server-rendered date fell back to Europe/Zurich. `teamTimezone` /
// `teamDateContext` below close that gap: a call site that has the team doc (or
// any `{ language, regional }` pair) can now resolve the studio's DISPLAY zone
// and hand it in.
//
// The defaults are unchanged and stay unchanged — Europe/Zurich, en-GB, 24-hour
// — so a call site that passes nothing behaves exactly as before.
//
// DEFAULT_TIMEZONE is written out as its own literal below and is deliberately
// NOT `DEFAULT_REGIONAL.timezone`, even though the two strings are equal today.
// `DEFAULT_REGIONAL` is the product's DISPLAY default, a preference a studio can
// change; `events/duplicateEvent.ts` feeds DEFAULT_TIMEZONE into
// `isoDateInTimezone` to compute the wall-clock `YYYY-MM-DD` day keys it WRITES
// onto duplicated event program items. Wiring one to the other would let a
// change to the cosmetic default silently re-date stored programs — the exact
// boundary the header of shared/utils/regional.ts draws. Only the language →
// locale map is shared with the display model.

import { regionalLocale, resolveRegional } from '@linyup/shared'
import type { RegionalSettings } from '@linyup/shared'

/** Fallback zone for a server-rendered date with no team behind it, and the
 *  fixed zone `events/duplicateEvent.ts` derives stored day keys in. Not a
 *  display preference: see the header. */
export const DEFAULT_TIMEZONE = 'Europe/Zurich'
export const DEFAULT_LOCALE = regionalLocale('en')

/** Anything carrying a studio's language + regional settings — a Team, an
 *  Organization, or a hand-built pair. */
export interface TeamDateSource {
  language?: string | null
  regional?: Partial<RegionalSettings> | null
}

/** The studio's DISPLAY timezone, defaulted. Pass the result as the `timezone`
 *  argument of the formatters below. */
export function teamTimezone(team?: TeamDateSource | null): string {
  return resolveRegional(team?.regional).timezone
}

/** Both arguments the formatters below take, resolved from one team doc. */
export function teamDateContext(team?: TeamDateSource | null): {
  language: string
  timezone: string
} {
  return {
    language: team?.language ?? 'en',
    timezone: teamTimezone(team),
  }
}

// The language → BCP-47 map now lives ONCE, in shared/utils/regional, so the
// dashboard and the mail it sends cannot drift apart.
export function getLocale(language = 'en'): string {
  return regionalLocale(language)
}

export function formatDateLong(date: Date, language = 'en', timezone = DEFAULT_TIMEZONE): string {
  if (!date) return ''
  return date.toLocaleDateString(getLocale(language), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone })
}

export function formatDateShort(date: Date, language = 'en', timezone = DEFAULT_TIMEZONE): string {
  if (!date) return ''
  return date.toLocaleDateString(getLocale(language), { year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone })
}

export function formatDateNumeric(date: Date, language = 'en', timezone = DEFAULT_TIMEZONE): string {
  if (!date) return ''
  return date.toLocaleDateString(getLocale(language), { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone })
}

export function formatTime(date: Date, language = 'en', timezone = DEFAULT_TIMEZONE): string {
  if (!date) return ''
  return date.toLocaleTimeString(getLocale(language), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
}

export function formatDateTime(date: Date, language = 'en', timezone = DEFAULT_TIMEZONE): string {
  if (!date) return ''
  return date.toLocaleString(getLocale(language), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
}

export function formatTimestamp(date: Date, language = 'en', timezone = DEFAULT_TIMEZONE): string {
  if (!date) return ''
  return date.toLocaleString(getLocale(language), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
}

export function formatDateForICal(date: Date): string {
  if (!date) return ''
  return date.toISOString().replace(/-|:|\.\d{3}/g, '').slice(0, -1) + 'Z'
}
