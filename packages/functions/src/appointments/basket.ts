// A BASKET: several dates with one provider, booked and paid as one (US-07).
//
// There is no order document. A basket is N ordinary appointment holds taken
// together, and on the paid rail the Checkout Session IS the order: its metadata
// carries the provider and the list of starts, from which every session id
// (`apt_{providerId}_{startMs}`) is derived. Twelve starts fit in one metadata
// value; twelve session ids would not.
//
// ONE SECRET, ONE TOKEN PER DATE. Each booking needs its own `booking_token`:
// it is the credential a "cancel this date" link carries, and `cancelBooking`
// finds the booking by it, so a shared token would address every date at once.
// The hold-release proof, meanwhile, needs something this attempt can present
// for every date. So the basket mints one secret and derives each date's token
// from it and the session id: unguessable without the secret, distinct per
// date, and re-derivable by the webhook and the expiry handler from metadata
// alone. A one-date booking never uses this file.
import { createHash, randomUUID } from 'node:crypto'
import { HttpsError } from 'firebase-functions/v2/https'
import { BASKET_MAX_DATES, resolveMaxDatesPerBooking } from '@linyup/shared'
import { loadAppointmentBookingContext, type AppointmentBookingContext } from './booking'

/**
 * The dates a caller asked for, sorted and de-duplicated, or a refusal. Accepts
 * today's single `startMs` so a one-date caller is untouched, or a
 * `startMsList` of up to `max` dates (the offer's own `maxDatesPerBooking`).
 */
export function readBasketStarts(
  data: { startMs?: unknown; startMsList?: unknown },
  max: number
): number[] {
  if (Array.isArray(data.startMsList)) {
    const starts = [...new Set(data.startMsList)]
    if (starts.length === 0 || starts.some((s) => typeof s !== 'number' || !Number.isInteger(s))) {
      throw new HttpsError('invalid-argument', 'startMsList must hold whole-millisecond start times')
    }
    if (starts.length > Math.min(max, BASKET_MAX_DATES)) {
      throw new HttpsError('failed-precondition', 'Too many dates for one booking of this appointment.', {
        reason: 'basket_too_large',
        max: Math.min(max, BASKET_MAX_DATES),
      })
    }
    return (starts as number[]).sort((a, b) => a - b)
  }
  if (typeof data.startMs === 'number' && Number.isInteger(data.startMs)) return [data.startMs]
  throw new HttpsError('invalid-argument', 'startMs or startMsList is required')
}

/**
 * Every date's booking context (the same loader a one-date booking uses), then
 * the offer's own limit. A date that cannot be booked refuses the whole basket
 * and SAYS WHICH (`details.startMs`), so the picker can take that one out
 * rather than leave the visitor guessing among twelve.
 */
export async function loadBasketContexts(params: {
  teamId: string
  providerId: string
  activityId: string
  starts: number[]
  durationMinutes: number
}): Promise<AppointmentBookingContext[]> {
  const { starts, ...rest } = params
  const contexts = await Promise.all(
    starts.map((startMs) =>
      loadAppointmentBookingContext({ ...rest, startMs }).catch((err: unknown) => {
        if (starts.length > 1 && err instanceof HttpsError && err.code === 'failed-precondition') {
          throw new HttpsError('failed-precondition', err.message, {
            ...((err.details as Record<string, unknown> | undefined) ?? {}),
            reason: 'date_unavailable',
            startMs,
          })
        }
        throw err
      })
    )
  )
  const max = resolveMaxDatesPerBooking(contexts[0].activity)
  if (starts.length > max) {
    throw new HttpsError('failed-precondition', 'Too many dates for one booking of this appointment.', {
      reason: 'basket_too_large',
      max,
    })
  }
  return contexts
}

/** The session a date lives at: the same deterministic id every rail uses. */
export function appointmentSessionId(providerId: string, startMs: number): string {
  return `apt_${providerId}_${startMs}`
}

export interface BasketIdentity {
  /** Groups the dates of one basket on their bookings. Not a credential. */
  basketId: string
  /** Derives every date's booking token. Carried in Checkout metadata. */
  secret: string
}

export function newBasketIdentity(secret: string): BasketIdentity {
  return { basketId: randomUUID(), secret }
}

/** THE token a basket date's booking carries, derived rather than stored. */
export function basketDateToken(secret: string, sessionId: string): string {
  return createHash('sha256').update(`${secret}:${sessionId}`).digest('base64url')
}

/** A basket in Checkout metadata: nothing for one date, so a one-date
 *  purchase carries exactly the metadata it always has. */
export function basketCheckoutMetadata(
  starts: number[],
  identity: BasketIdentity | null
): Record<string, string> {
  if (starts.length <= 1 || !identity) return {}
  return {
    startMsList: starts.join(','),
    basketId: identity.basketId,
    basketSecret: identity.secret,
  }
}

/** The basket a payment bought, or null for a one-date purchase (and for every
 *  Checkout Session created before baskets existed). */
export function basketFromCheckoutMetadata(
  md: Record<string, string | undefined>
): { starts: number[]; basketId: string; secret: string } | null {
  if (!md.startMsList || !md.basketId || !md.basketSecret) return null
  const starts = md.startMsList.split(',').map(Number)
  if (starts.length < 2 || starts.some((s) => !Number.isInteger(s))) return null
  return { starts, basketId: md.basketId, secret: md.basketSecret }
}

/** The refund key for the dates a basket's payment could not buy: built from
 *  WHICH dates, so a redelivery meeting the same dates reissues the same
 *  refund, and a different set is a different refund. */
export function basketRefundKey(paymentIntentId: string, sessionIds: string[]): string {
  const which = createHash('sha256').update([...sessionIds].sort().join(',')).digest('hex').slice(0, 16)
  return `apt-basket-refund:${paymentIntentId}:${which}`
}

/** The part of a Checkout idempotency key that says which dates: ZERO parts for
 *  one date, so a one-date purchase keeps the key it has always had. */
export function basketKeyParts(starts: number[]): string[] {
  if (starts.length <= 1) return []
  return [`b${starts.length}`, createHash('sha256').update(starts.join(',')).digest('hex').slice(0, 12)]
}
