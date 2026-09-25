/* eslint-disable no-console */
// Appointments (1:1 slots) are ACTIVITY-BOUND and AVAILABILITY-ONLY: a coach
// publishes an `Availability` doc (the *when*), and a Session is materialized
// lazily — overlap-safe — only when a client books via `bookAppointment`
// (see ./window.ts). Nothing is pre-generated; there is no daily/on-write
// slot-generation job any more.

// Email templates are used by bookAppointment (./window.ts).
export {
  buildAppointmentConfirmationEmail,
  buildAppointmentICalAttachment,
  buildAppointmentProviderNotificationEmail,
  buildAppointmentCancellationEmail,
} from './templates'

export const TIMEZONE = 'Europe/Zurich'

// ─── timezone helpers ──────────────────────────────────────────────────────
// Used by ./window.ts (listAvailability + bookAppointment) to enumerate and
// validate candidate start times in Europe/Zurich local time.

export function getDatePartsInTz(date: Date): { year: number; month: number; day: number; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'narrow',
  }).formatToParts(date)
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10)
  const [y, m, d] = [get('year'), get('month'), get('day')]
  const localNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return { year: y, month: m, day: d, dayOfWeek: localNoon.getUTCDay() }
}

export function localTimeToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  })
  const p = Object.fromEntries(formatter.formatToParts(utcGuess).map(({ type, value }) => [type, parseInt(value, 10)]))
  const diffMs = Date.UTC(year, month - 1, day, hour, minute, 0)
    - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return new Date(utcGuess.getTime() + diffMs)
}
