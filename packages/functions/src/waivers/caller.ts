// WHO IS ASKING — the ONE caller resolution for `resolveWaiverRequirement`, and
// for anything public that later has to work this out from what the caller
// typed.
//
// It is its own module because the answer it gives has to be the SAME answer the
// gate computes for the same person at the same instant. Two hand-written
// resolutions of "who is this" is how the public answer and the gate's answer
// start disagreeing — and that disagreement is not cosmetic:
//
//   Sabine and her son Nils share familie-meier@bluewin.ch. Sabine signed the
//   release last year. Nils books. An email-only lookup matches SABINE, finds
//   her valid signature and reports "nothing to sign" — no step, no tick. The
//   gate then matches email AND name, resolves NILS, finds no signer row and
//   refuses. On the returning-member path that refusal arrives after the
//   verification code was already marked used. Worse: on a class Sabine's
//   contact could book, a 12-year-old passes the gate on his mother's signature.
//
// So the proofs are exactly the ones the RAILS accept, in the same order:
//
//   1. a contact session                             → that contactId
//   2. authenticatedContactId + verificationCodeId   → validated READ-ONLY
//   3. email + firstname + lastname                  → the shared guest
//      predicate (booking/guestContactMatch.ts), which is the rails' own code
//   4. anything less                                 → the CONSERVATIVE answer
//
// A `contactId` in the request body is deliberately NOT a proof. Trusting one
// turns a public callable into an oracle over a compliance fact ("has contact X
// signed the release?") for any anonymous caller — the same shape the July 2026
// audit closed on `createDropInCheckout`.

import * as admin from 'firebase-admin'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { CONTACTS_COLLECTION } from '@linyup/shared'
import { matchGuestContact } from '../booking/guestContactMatch'
import { optionalContactSessionFromRequest } from '../utils/contactSession'

/** The identity fields a public waiver callable accepts off the wire. */
export interface WaiverCallerInput {
  teamId: string
  contactId?: string
  authenticatedContactId?: string
  verificationCodeId?: string
  email?: string
  firstname?: string
  lastname?: string
}

/**
 * WHICH of the four proofs actually resolved this caller.
 *
 * Needed rather than just the contactId: the requirement callable widens its
 * answer to the member's whole portal only for `session` (a widening an
 * anonymous caller could ask for is a catalog).
 *
 * IT IS NOT A RATE-LIMIT INPUT, and an earlier cut making it one is why
 * waivers/limits.ts exists. Charging the arm that "told an unproven caller
 * something" charges every returning member at a doorway — a walk-in typing
 * their own name and address IS `guest_match` — so a tablet at a busy class
 * locked itself out of booking after thirty people. The disclosure is bounded by
 * being withdrawn instead (see the ambiguity paragraph below), and the counter
 * bounds volume on an axis a doorway cannot exhaust.
 */
export type WaiverCallerProof =
  /** A contact session for this team — the caller's own record. */
  | 'session'
  /** `authenticatedContactId` + a verified `booking_verification_codes` row. */
  | 'verified_code'
  /** email AND name matched exactly one contact — the rails' guest predicate. */
  | 'guest_match'
  /** Nothing resolved. The answer is the conservative one. */
  | 'none'

/** The caller, as strongly as the proofs allowed. */
export interface ResolvedWaiverCaller {
  contactId: string | null
  /** How the caller was resolved. Never inferred from `contactId` being set:
   *  three different proofs can set it and they are not interchangeable. */
  proof: WaiverCallerProof
  /** The address the caller typed or the matched contact carries, normalized. */
  email: string | null
  firstname: string
  lastname: string
}

// ── NO `ambiguous` FLAG, AND THAT IS THE BOUND ──────────────────────────────
// There used to be one: "this email matched contacts but no name narrowed it to
// one", returned to the caller as `ambiguousCaller`. It had no reader anywhere —
// the conservative answer is already produced by resolving to no contact, so the
// step renders identically with or without it — and what it DID do was answer,
// for any anonymous caller, the one question this surface must never answer:
// does this address belong to somebody at this studio. A ration on that answer
// is still an answer, so it is withdrawn rather than rationed, and an unproven
// caller's reply is now byte-identical for a known household mailbox and a
// stranger's. `matchGuestContact` still returns `emailMatches` — the promo rails
// need it — and nothing on a waiver path may read it back into an answer.

// NO `verifiedEmail` HERE, AND THAT IS THE POINT. The mailbox a six-digit code
// was proved against belongs on the ACCEPTANCE, as `signer_email` — and the
// callable that resolves a caller through this module writes no acceptance at
// all: `resolveWaiverRequirement` is read-only. Carrying the field here would be
// a load-bearing-looking value with no reader, which is how a docblock that
// describes a hazard ends up describing one the code cannot produce. The rails
// that DO write an acceptance carry it themselves: see
// `WaiverGateParams.signerEmail` and its three OTP call sites.
function fromContact(
  contactId: string,
  data: FirebaseFirestore.DocumentData,
  proof: Exclude<WaiverCallerProof, 'none'>
): ResolvedWaiverCaller {
  return {
    contactId,
    proof,
    email: ((data.email as string | undefined) ?? '').toLowerCase().trim() || null,
    firstname: (data.firstname as string | undefined) ?? '',
    lastname: (data.lastname as string | undefined) ?? '',
  }
}

export async function resolveWaiverCaller(
  request: CallableRequest<unknown>,
  data: WaiverCallerInput
): Promise<ResolvedWaiverCaller> {
  const db = admin.firestore()
  const typedEmail = (data.email ?? '').toLowerCase().trim()
  const firstname = (data.firstname ?? '').trim()
  const lastname = (data.lastname ?? '').trim()

  // 1. A contact session is the only trustworthy source of a caller's own
  //    contactId on a public callable.
  const session = optionalContactSessionFromRequest(request)
  if (session && session.teamId === data.teamId) {
    const snap = await db.collection(CONTACTS_COLLECTION).doc(session.contactId).get()
    if (snap.exists && snap.data()?.teamId === data.teamId) {
      // A session is worth `session`, never `verified_code`: its `email` claim
      // is the CONTACT's address, not the one that authenticated, so it proves
      // nothing about who is at the keyboard.
      return fromContact(session.contactId, snap.data()!, 'session')
    }
    // A session pointing at a contact that is gone, or at another team's, is
    // not a proof of anything — fall through rather than trust it.
  }

  // 2. The OTP proof, validated exactly as bookSession validates it — and READ
  //    ONLY. bookSession marks the code `used` at its own entry; spending it
  //    here would cost the caller a re-verification for merely rendering a
  //    step, against a budget of three codes per email+team per hour.
  if (data.authenticatedContactId && data.verificationCodeId) {
    const codeDoc = await db
      .collection('booking_verification_codes')
      .doc(data.verificationCodeId)
      .get()
    const code = codeDoc.data()
    const ok =
      codeDoc.exists &&
      code?.verified === true &&
      code?.team_id === data.teamId &&
      ((code?.matched_contact_ids as string[] | undefined) ?? []).includes(
        data.authenticatedContactId
      )
    if (ok) {
      const snap = await db.collection(CONTACTS_COLLECTION).doc(data.authenticatedContactId).get()
      if (snap.exists && snap.data()?.teamId === data.teamId) {
        return fromContact(data.authenticatedContactId, snap.data()!, 'verified_code')
      }
    }
    // A bad or foreign code is NOT an error here — it is simply not a proof,
    // and the caller falls through to the guest predicate below. Throwing would
    // turn a stale tab into a dead booking form.
  }

  // 3. The guest predicate — email AND name, the rails' own code.
  if (!typedEmail) {
    return { contactId: null, proof: 'none', email: null, firstname, lastname }
  }
  const { match } = await matchGuestContact(data.teamId, {
    email: typedEmail,
    firstname,
    lastname,
  })
  if (match) return fromContact(match.id, match.data(), 'guest_match')

  // 4. Conservative. An email that addresses somebody — a household mailbox,
  //    say — but whose name we could not narrow must NEVER be answered with a
  //    candidate's state: that is how a 12-year-old passes a gate on his
  //    mother's signature. Asking someone to tick again costs a tick.
  //
  //    IT IS ALSO THE SHAPE THAT MUST NOT REPORT WHAT IT KNOWS. This branch is
  //    reached both by an address that addresses a whole family and by one that
  //    addresses nobody here at all, and the two returns are identical on
  //    purpose: whichever it was is exactly the fact an enumerator came for.
  return { contactId: null, proof: 'none', email: typedEmail, firstname, lastname }
}
