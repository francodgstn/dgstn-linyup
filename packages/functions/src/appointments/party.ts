// A PARTY on an appointment: the booker plus the people they bring, on a length
// priced per person (`ActivityDuration.party`). One booking of the provider's
// time whatever its size; the companions are names, never contacts.
//
// Every rail that books an appointment reads the caller's party through
// `readAppointmentParty` (the shared `normalizePartyRequest`, which the picker
// runs too) and writes it through `partyBookingFields`. The paid rail also
// carries it through Stripe: the party the buyer PAID FOR is the one in the
// Checkout Session's metadata, and the webhook writes the booking's party from
// there. A retry that changed the party size rewrites the hold, but the older
// Checkout Session can still be paid, and the booking must then say what that
// money bought.
import { createHash } from 'node:crypto'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  DURATION_PARTY_MAX,
  PARTICIPANT_NAME_MAX,
  normalizePartyRequest,
  resolveDurationParty,
  type ActivityDuration,
  type PartyRequestProblem,
} from '@linyup/shared'

export interface AppointmentParty {
  /** The booker included. */
  people: number
  /** The companions' names, `people - 1` of them. */
  participants: string[]
}

const PARTY_REFUSALS: Record<PartyRequestProblem, string> = {
  party_required: 'This appointment is booked for a group. Say how many people are coming.',
  party_size: 'That number of people cannot book this appointment.',
  participant_names: 'Give the name of everyone coming along.',
  no_party: 'This appointment is booked for one person.',
}

/** The caller's party for the length they chose, or a refusal carrying the
 *  reason by name (`details.reason`), so a client can say what to fix. */
export function readAppointmentParty(
  duration: ActivityDuration,
  data: { people?: unknown; participants?: unknown }
): AppointmentParty {
  const r = normalizePartyRequest(duration, data)
  if (!r.ok) {
    throw new HttpsError('failed-precondition', PARTY_REFUSALS[r.reason], { reason: r.reason })
  }
  return { people: r.people, participants: r.participants }
}

/**
 * The STUDIO's own booking of a party length: the same bounds, but the names
 * are optional, because a studio books a pair before it knows who the second
 * person is. No size given = the smallest party the length takes, which is
 * what a dialog that predates parties means when it books one.
 */
export function readStaffAppointmentParty(
  duration: ActivityDuration,
  data: { people?: unknown; participants?: unknown }
): AppointmentParty {
  const bounds = resolveDurationParty(duration)
  if (!bounds) return { people: 1, participants: [] }
  let people = bounds.min
  if (data.people !== undefined && data.people !== null) {
    const p = data.people
    if (typeof p !== 'number' || !Number.isInteger(p) || p < bounds.min || p > bounds.max) {
      throw new HttpsError('failed-precondition', PARTY_REFUSALS.party_size, { reason: 'party_size' })
    }
    people = p
  }
  const participants = (Array.isArray(data.participants) ? data.participants : [])
    .map((n) => (typeof n === 'string' ? n.trim().slice(0, PARTICIPANT_NAME_MAX) : ''))
    .filter((n) => n.length > 0)
    .slice(0, people - 1)
  return { people, participants }
}

/** The fields a booking document carries for its party. Nothing for one
 *  person, so a solo booking's document is unchanged. */
export function partyBookingFields(party: AppointmentParty): {
  party_size?: number
  participants?: string[]
} {
  return party.people > 1 ? { party_size: party.people, participants: party.participants } : {}
}

/** The party as Checkout Session metadata: one key per name, because a single
 *  JSON value of up to nine names outgrows Stripe's 500-character value cap. */
export function partyCheckoutMetadata(party: AppointmentParty): Record<string, string> {
  if (party.people <= 1) return {}
  const md: Record<string, string> = { people: String(party.people) }
  party.participants.forEach((name, i) => {
    md[`participant${i + 1}`] = name.slice(0, PARTICIPANT_NAME_MAX)
  })
  return md
}

/**
 * The party's part of a Checkout idempotency key: ZERO parts for one person,
 * so a solo purchase keeps the key it has always had. A party changes the
 * amount and the metadata, and Stripe refuses a reused key whose parameters
 * differ, so a buyer who goes back and turns "2 people" into "3" inside the
 * key's minute would otherwise be refused rather than re-priced.
 */
export function partyKeyParts(party: AppointmentParty): string[] {
  if (party.people <= 1) return []
  const names = createHash('sha256').update(party.participants.join('\n')).digest('hex').slice(0, 12)
  return [`p${party.people}`, names]
}

/** The party a payment bought, read back from its metadata; null for a solo
 *  purchase (and for every Checkout Session created before parties existed). */
export function partyFromCheckoutMetadata(
  md: Record<string, string | undefined>
): AppointmentParty | null {
  const people = Number(md.people)
  if (!Number.isInteger(people) || people < 2 || people > DURATION_PARTY_MAX) return null
  // A studio-made booking may name fewer companions than it books.
  const participants = Array.from({ length: people - 1 }, (_, i) => md[`participant${i + 1}`] ?? '')
    .filter((n) => n.length > 0)
  return { people, participants }
}
