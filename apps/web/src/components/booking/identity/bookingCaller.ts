import type { GuestDetailsValues } from '@/components/booking/GuestDetailsForm'
import type { WaiverAcceptancePayload, WaiverCallerIdentity } from '@/lib/waiver'

// WHO IS BOOKING, derived, never stored.
//
// A public booking surface has three kinds of caller and they are not a UI
// state: they are derived from the contact session and the OTP result on every
// render. Storing "signed in" as a flag is how a screen ends up disagreeing
// with the call it is about to make, and this rail has been there: the
// appointment picker referenced the auth context zero times while the session's
// ID token rode on every callable it sent, so the SERVER booked as the signed-in
// contact while the SCREEN asked that same contact for their details, quoted
// them the guest price, and filed what they typed under somebody else.
//
// THE ORDER IS THE SERVER'S ORDER. `resolveAppointmentCaller`
// (packages/functions/src/appointments/booking.ts) checks the contact session
// FIRST and returns from that branch before it looks at
// `authenticatedContactId` or `contactDetails`. A session therefore outranks an
// OTP result here too. Any other precedence puts the screen back in
// disagreement with the server.
//
// WHAT A MEMBER HOLDS follows one rule, and both funnels had written it out:
// the LIVE union of plans from the contact's own record, with the single
// `subscription_type_id` frozen onto the session at sign-in as the floor for a
// FAILED read, never as the answer (UX-102: a member covered by a second plan
// was told she held none and routed to pay a drop-in the server then refused to
// sell her). Display and routing only, in both funnels: every callable
// re-resolves the snapshot server side and remains the authority.

/** The minimum this derivation needs of a session contact. Structural so it
 *  takes the persisted session's contact without importing the auth context,
 *  which lives with the public routes rather than here. */
export interface SessionContactLike {
  id: string
  firstname?: string | null
  lastname?: string | null
  email?: string | null
  /** The ONE plan frozen onto the session at sign-in. Read only as the floor
   *  for a failed live read; see the header. */
  subscription_type_id?: string | null
}

export type BookingCaller =
  | { kind: 'guest' }
  /** A contact-session sign-in from anywhere under `/public/{slug}/…`: the pill
   *  in the corner, the Space, the shop. Nothing needs to travel in the body. */
  | { kind: 'session'; contactId: string; name: string; email: string | null; held: string[] }
  /** An OTP sign-in taken on this screen's own offer. The `verificationCodeId`
   *  is single-use and is spent by the server at its own entry, before any
   *  gate, which is why every path that holds one is interrupted by the consent
   *  screen BEFORE it calls. */
  | {
      kind: 'code'
      contactId: string
      verificationCodeId: string
      name: string
      email: string
      held: string[]
    }

export type VerifiedCaller = Extract<BookingCaller, { kind: 'code' }>

export const GUEST: BookingCaller = { kind: 'guest' }

/** The identity a booking or checkout call carries IN ITS BODY.
 *
 *  A contact session carries NONE, and that is not an omission: `callFunction`
 *  attaches the session's ID token, the server reads it before anything in the
 *  body, and body details are then discarded silently. Sending them would be a
 *  lie about what is being booked. */
export interface BookingCallBody {
  contactDetails?: { firstname: string; lastname: string; email: string; phone?: string }
  authenticatedContactId?: string
  verificationCodeId?: string
  /** The ticks from the consent screen, straight back as the server issued
   *  them. Recorded before Stripe on the paid arm and not conditional on
   *  payment: they read the text and ticked, and that is true whether or not
   *  the card clears. */
  waiverAcceptances?: WaiverAcceptancePayload[]
  /** Answers to the studio's book-form contact fields. About the PERSON, so
   *  stored on the contact rather than the booking. */
  contactFieldAnswers?: Record<string, unknown>
}

export interface ResolveCallerInput {
  /** The persisted session's contact, or null. */
  sessionContact: SessionContactLike | null
  isAuthenticated: boolean
  /** The live union from the contact's own record, or null when that read has
   *  not landed or has FAILED. Null is "we do not know", never "holds none". */
  liveHeld: string[] | null
  /** An OTP result taken on this screen. Outranked by a session, deliberately. */
  verified?: VerifiedCaller | null
}

export function resolveBookingCaller({
  sessionContact,
  isAuthenticated,
  liveHeld,
  verified,
}: ResolveCallerInput): BookingCaller {
  if (isAuthenticated && sessionContact) {
    return {
      kind: 'session',
      contactId: sessionContact.id,
      name: `${sessionContact.firstname ?? ''} ${sessionContact.lastname ?? ''}`.trim(),
      email: sessionContact.email ?? null,
      held: heldFrom(liveHeld, sessionContact),
    }
  }
  return verified ?? GUEST
}

/** The live union first, the frozen slot only as the floor for a failed read. */
export function heldFrom(
  liveHeld: string[] | null,
  sessionContact: SessionContactLike | null
): string[] {
  if (liveHeld) return liveHeld
  return sessionContact?.subscription_type_id ? [sessionContact.subscription_type_id] : []
}

/**
 * The stable name of an identity, for everything whose truth ENDS when the
 * identity moves: the accepted price (`useAcceptedPrice`) and the server's
 * `payment_required` figure.
 *
 * The held types are part of it because they price the booking: a contact who
 * buys a subscription in another tab is, as far as a screen's figures go,
 * somebody else.
 */
export function callerKey(caller: BookingCaller): string {
  return caller.kind === 'guest'
    ? 'guest'
    : `${caller.kind}:${caller.contactId}:${[...caller.held].sort().join(',')}`
}

/** The subscription types this caller is quoted against. None, for a guest. */
export function heldOf(caller: BookingCaller): string[] {
  return caller.kind === 'guest' ? [] : caller.held
}

/** The address a confirmation will reach, when the rail knows one. */
export function emailOf(caller: BookingCaller): string | null {
  return caller.kind === 'guest' ? null : caller.email
}

export function bodyIdentity(
  caller: BookingCaller,
  guest?: GuestDetailsValues
): BookingCallBody {
  if (caller.kind === 'session') return {}
  if (caller.kind === 'code') {
    return {
      authenticatedContactId: caller.contactId,
      verificationCodeId: caller.verificationCodeId,
    }
  }
  return {
    contactDetails: {
      firstname: guest?.firstname ?? '',
      lastname: guest?.lastname ?? '',
      email: guest?.email ?? '',
      ...(guest?.phone ? { phone: guest.phone } : {}),
    },
    // The studio's own contact fields, answered on the guest step. Narrowed
    // again server side against the resolved list, see booking/contactFields.ts.
    ...(guest?.contactFieldAnswers ? { contactFieldAnswers: guest.contactFieldAnswers } : {}),
  }
}

/** The identity the consent gate resolves its requirement for: the same proofs
 *  `resolveWaiverCaller` accepts, in the same order. A body `contactId` is not
 *  a proof there; it is sent because the server decides whether the session
 *  agrees with it, exactly as `SignupForm` does. */
export function waiverIdentity(
  caller: BookingCaller,
  guest?: GuestDetailsValues
): WaiverCallerIdentity {
  if (caller.kind === 'session') {
    return { contactId: caller.contactId, ...(caller.email ? { email: caller.email } : {}) }
  }
  if (caller.kind === 'code') {
    return {
      authenticatedContactId: caller.contactId,
      verificationCodeId: caller.verificationCodeId,
      email: caller.email,
    }
  }
  return { email: guest?.email, firstname: guest?.firstname, lastname: guest?.lastname }
}
