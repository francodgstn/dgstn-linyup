// Ported verbatim from hmd-lineup/functions/src/utils/recurrence.js — converted to TypeScript
// DST-safe recurrence calculation for Europe/Zurich timezone
import { addDays, addWeeks, addMonths, addYears, isBefore, isAfter, getDay, differenceInDays, startOfDay } from 'date-fns'
import type { RecurrencePattern, Timestamp } from '@linyup/shared'

const TIMEZONE = 'Europe/Zurich'

function getDatePartsInTimezone(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  })
  return Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, parseInt(value, 10)]))
}

function localTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  const localParts = getDatePartsInTimezone(utcGuess, timezone)
  const diffMs =
    Date.UTC(year, month - 1, day, hour, minute, second) -
    Date.UTC(localParts.year, localParts.month - 1, localParts.day, localParts.hour, localParts.minute, localParts.second)
  return new Date(utcGuess.getTime() + diffMs)
}

function normalizeToDstSafeDate(date: Date, referenceDate: Date, timezone: string): Date {
  const refParts = getDatePartsInTimezone(referenceDate, timezone)
  const dateParts = getDatePartsInTimezone(date, timezone)
  return localTimeToUtc(dateParts.year, dateParts.month, dateParts.day, refParts.hour, refParts.minute, refParts.second, timezone)
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000)
}

function getNextOccurrenceDate(currentDate: Date, recurrence: RecurrencePattern): Date {
  switch (recurrence.frequency) {
    case 'daily': return addDays(currentDate, recurrence.interval)
    case 'weekly': return addWeeks(currentDate, recurrence.interval)
    case 'monthly': return addMonths(currentDate, recurrence.interval)
    case 'yearly': return addYears(currentDate, recurrence.interval)
    default: throw new Error(`Unknown frequency: ${recurrence.frequency}`)
  }
}

function createOccurrence(startDate: Date, duration: number) {
  return { start: new Date(startDate), end: addMinutes(startDate, duration) }
}

/**
 * The calendar day an instant falls on IN THE STUDIO'S TIMEZONE, as
 * `YYYY-MM-DD`.
 *
 * Deliberately not `startOfDay`, which this file otherwise uses: that is the
 * PROCESS timezone, and Cloud Run is UTC. A 21:00 Zurich class is 20:00 UTC in
 * summer, so a process-local day boundary still agrees — but a 00:30 class is
 * the previous day in UTC, and excluding "24 December" would skip the 23rd.
 * A skip date is a thing a human wrote on a calendar, so it is compared the way
 * they meant it.
 */
function civilDateKey(date: Date, timezone: string): string {
  const p = getDatePartsInTimezone(date, timezone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** The pattern's skip dates as civil-date keys. Accepts a Timestamp, a Date or
 *  epoch millis, because this is read from Firestore, from a form and from a
 *  fixture. */
function excludedDayKeys(
  excludeDates: RecurrencePattern['excludeDates'],
  timezone: string
): Set<string> {
  const keys = new Set<string>()
  for (const entry of excludeDates ?? []) {
    const date =
      entry instanceof Date
        ? entry
        : typeof entry === 'number'
          ? new Date(entry)
          : typeof (entry as Timestamp)?.toDate === 'function'
            ? (entry as Timestamp).toDate()
            : null
    if (date && !Number.isNaN(date.getTime())) keys.add(civilDateKey(date, timezone))
  }
  return keys
}

export function calculateOccurrences(
  recurrence: RecurrencePattern & { startDate: Date | Timestamp; endDate?: Date | Timestamp },
  fromDate: Date,
  toDate: Date
): { start: Date; end: Date }[] {
  const occurrences: { start: Date; end: Date }[] = []

  const startDate = (recurrence.startDate as Timestamp).toDate?.() ?? new Date(recurrence.startDate as Date)
  const endDate = recurrence.endDate
    ? (recurrence.endDate as Timestamp).toDate?.() ?? new Date(recurrence.endDate as Date)
    : null

  const excluded = excludedDayKeys(recurrence.excludeDates, TIMEZONE)

  let currentDate = new Date(startDate)
  const from = startOfDay(new Date(fromDate))
  const to = startOfDay(new Date(toDate))
  let occurrenceCount = 0
  const maxIterations = 10000
  let iterations = 0

  while (iterations < maxIterations) {
    iterations++
    if (isAfter(startOfDay(currentDate), to)) break
    if (recurrence.endCondition === 'date' && endDate && isAfter(startOfDay(currentDate), startOfDay(endDate))) break
    if (recurrence.endCondition === 'count' && recurrence.maxOccurrences && occurrenceCount >= recurrence.maxOccurrences) break

    if (!isBefore(startOfDay(currentDate), from) && !isAfter(startOfDay(currentDate), to) && !isBefore(startOfDay(currentDate), startOfDay(startDate))) {
      // BEFORE occurrenceCount++, in both arms: a skipped day must not spend
      // one of a `count` series' occurrences. "20 lessons, skipping the
      // holidays" means twenty lessons, and counting the skips would quietly
      // make it eighteen.
      const skipped = excluded.size > 0 && excluded.has(civilDateKey(currentDate, TIMEZONE))
      if (!skipped) {
        if (recurrence.frequency === 'weekly') {
          const dayOfWeek = getDay(currentDate)
          if (recurrence.daysOfWeek?.includes(dayOfWeek)) {
            occurrences.push(createOccurrence(currentDate, recurrence.duration))
            occurrenceCount++
          }
        } else {
          occurrences.push(createOccurrence(currentDate, recurrence.duration))
          occurrenceCount++
        }
      }
    }

    const nextDate = normalizeToDstSafeDate(getNextOccurrenceDate(currentDate, recurrence), startDate, TIMEZONE)

    if (recurrence.frequency === 'weekly' && recurrence.daysOfWeek && recurrence.daysOfWeek.length > 1) {
      const nextDay = normalizeToDstSafeDate(addDays(currentDate, 1), startDate, TIMEZONE)
      const weeksSinceStart = Math.floor(differenceInDays(startOfDay(nextDay), startOfDay(startDate)) / 7)
      if (weeksSinceStart % recurrence.interval === 0) {
        currentDate = nextDay
        continue
      }
    }

    currentDate = nextDate
  }

  return occurrences
}

export function validateRecurrence(recurrence: Partial<RecurrencePattern>): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!recurrence.frequency) errors.push('Frequency is required')
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(recurrence.frequency ?? '')) errors.push('Invalid frequency')
  if (!recurrence.interval || recurrence.interval < 1) errors.push('Interval must be at least 1')
  if (!recurrence.duration || recurrence.duration < 1) errors.push('Duration must be at least 1 minute')
  if (!recurrence.startDate) errors.push('Start date is required')
  if (!recurrence.endCondition) errors.push('End condition is required')
  if (!['date', 'count', 'never'].includes(recurrence.endCondition ?? '')) errors.push('Invalid end condition')
  if (recurrence.frequency === 'weekly' && (!recurrence.daysOfWeek || recurrence.daysOfWeek.length === 0)) errors.push('Days of week required for weekly recurrence')
  if (recurrence.endCondition === 'date' && !recurrence.endDate) errors.push('End date required when end condition is "date"')
  if (recurrence.endCondition === 'count' && (!recurrence.maxOccurrences || recurrence.maxOccurrences < 1)) errors.push('Max occurrences must be at least 1')
  // Skip dates are optional and unordered, and a date outside the pattern's own
  // range is harmless — it simply never matches. The one thing worth refusing is
  // a list that is not a list, which would otherwise be silently ignored.
  if (recurrence.excludeDates !== undefined && !Array.isArray(recurrence.excludeDates)) errors.push('Skip dates must be a list')
  return { valid: errors.length === 0, errors }
}
