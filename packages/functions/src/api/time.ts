// ─── Turning a question's dates into an instant range ────────────────────────
//
// A caller may say `2026-09-14` or `2026-09-14T18:00:00Z`. An instant with an
// offset means exactly that instant. A bare date means the studio's day, in the
// team's DISPLAY zone (`resolveRegional(team.regional).timezone`) — which only
// turns a question into a range and never feeds stored math, so it respects the
// boundary `shared/utils/regional.ts` draws. Half-open: `from` is the start of
// its day, `to` is the start of the day AFTER it, so `from=to=2026-09-14` is
// that whole day.

import { ApiError } from './errors'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i

/** The zone's offset from UTC at `utcMs`, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utcMs)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** The instant a calendar day begins in `timeZone`. Corrects once for a DST edge. */
export function zonedDayStartMs(ymd: string, timeZone: string): number {
  const match = DATE_ONLY.exec(ymd)
  if (!match) throw new ApiError('invalid_request', `Not a date: ${ymd}`, 'Use YYYY-MM-DD')
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const first = guess - zoneOffsetMs(guess, timeZone)
  return guess - zoneOffsetMs(first, timeZone)
}

/** `YYYY-MM-DD` of an instant in `timeZone`. */
export function zonedYmd(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/**
 * One end of a range. A bare date is the start of that studio day for `from`
 * and the start of the next one for `to`; an instant must carry its offset,
 * because a wall-clock time without one means a different moment on every
 * machine that parses it.
 */
export function parseApiInstant(value: string, timeZone: string, edge: 'from' | 'to'): number {
  const trimmed = value.trim()
  if (DATE_ONLY.test(trimmed)) {
    return zonedDayStartMs(edge === 'from' ? trimmed : nextDay(trimmed), timeZone)
  }
  const ms = Date.parse(trimmed)
  if (!HAS_OFFSET.test(trimmed) || Number.isNaN(ms)) {
    throw new ApiError(
      'invalid_request',
      `Not a date or an instant with an offset: ${value}`,
      'Use YYYY-MM-DD for a studio day, or an ISO 8601 instant ending in Z or an offset'
    )
  }
  return ms
}
