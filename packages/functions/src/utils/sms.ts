// Thin façade over the SMS service (src/mail/smsService.ts), parallel to
// utils/email.ts. Call sites send AS a studio:
//
//   await sendSms({ to: contact.phone, contactId: contact.id, content: '…', teamId })
//
// The service handles E.164 normalization (CH default), the SMS_ENABLED kill
// switch, TEST_MODE redirect, the contact's sms_opt_out, suppression and the
// idempotency ledger.
import { sendStudioSms, type SmsSendOutcome } from '../mail/smsService'

export { idempotencyKey } from '../mail/mailService'
export { normalizePhoneE164 } from '../mail/smsService'

export interface SendSmsOptions {
  to: string
  /** Whose opt-out applies — see OutboundSms.contactId. */
  contactId: string | null
  content: string
  teamId: string
  tag?: string
  idempotencyKey?: string
}

export async function sendSms(options: SendSmsOptions): Promise<SmsSendOutcome> {
  const { teamId, ...msg } = options
  return sendStudioSms(teamId, msg)
}

// ─── Quiet hours ─────────────────────────────────────────────────────────────
// Lifted here from dailyTasks/sendBookingReminders (which re-exports them) once
// a second caller appeared: the waitlist anchors a claim WINDOW to the sending
// window, so "when may we text?" is no longer a reminder-loop detail.

const SMS_QUIET_START_HOUR = 8 // team-local, inclusive
const SMS_QUIET_END_HOUR = 21 // exclusive

/** Local wall-clock parts of `date` in `timeZone`. */
function localParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(
    parts.map(({ type, value }) => [type, parseInt(value, 10)])
  ) as ReturnType<typeof localParts>
}

/** A local wall-clock time → the UTC instant it names, DST-safe (the guess is
 *  re-read in the zone and corrected by the difference). Same technique as
 *  appointments/index.ts's localTimeToUtc, kept local so this module stays
 *  independent of the appointment scheduler. Day overflow normalizes. */
function localWallTimeToUtc(
  year: number, month: number, day: number, hour: number, timeZone: string
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0))
  const p = localParts(guess, timeZone)
  const diffMs =
    Date.UTC(year, month - 1, day, hour, 0, 0) -
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return new Date(guess.getTime() + diffMs)
}

/** SMS quiet hours: only send 08:00–20:59 team-local (Europe/Zurich). */
export function isWithinSmsSendingHours(now: Date, timeZone = 'Europe/Zurich'): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone }).format(now),
  )
  return hour >= SMS_QUIET_START_HOUR && hour < SMS_QUIET_END_HOUR
}

/** The next instant an SMS may go out — `now` itself when the window is already
 *  open, otherwise the next 08:00 team-local.
 *
 *  The waitlist anchors a claim window's START to this, which is NOT the same as
 *  deferring the offer: an offer whose window opens at 08:00 is still minted and
 *  emailed at 23:10, because deferring a claim is not deferral — it is expiry,
 *  and the seat would sit dark all night while walk-ins take it in the morning. */
export function nextSmsWindowOpen(now: Date, timeZone = 'Europe/Zurich'): Date {
  if (isWithinSmsSendingHours(now, timeZone)) return now
  const p = localParts(now, timeZone)
  // Before the window opens → today's opening; after it closed → tomorrow's.
  const day = p.hour < SMS_QUIET_START_HOUR ? p.day : p.day + 1
  return localWallTimeToUtc(p.year, p.month, day, SMS_QUIET_START_HOUR, timeZone)
}
