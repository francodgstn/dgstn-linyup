// `resolveWaiverRequirement` — the ONE public answer to "does this booking need
// a signature, and what do I render?". Every public surface builds its waiver
// step from this and nothing else.
//
// It WRITES NOTHING ABOUT ANYBODY. A visitor who opens the booking form and
// leaves has left no trace: no contact, no acceptance, no intent row. The single
// exception is the per-IP volume counter, which is spent only by an
// uncredentialed caller ASKING ABOUT A PERSON — see waivers/limits.ts, which
// states the whole abuse model in one paragraph. Reading what you have to sign
// is free, for everybody, always.
//
// AND IT TELLS NOBODY WHO IS A MEMBER HERE. An unproven caller's answer is
// byte-identical whether the address they typed addresses a whole family at this
// studio or nobody at all: there is no ambiguity bit, because a rationed oracle
// is still an oracle (waivers/caller.ts, step 4).
//
// ── WHY THE CLIENT MAY NOT CALL IT BLINDLY ──────────────────────────────────
// The client calls this if and only if `TeamPublicProfile.required_waivers` is
// non-empty. A tenant with no waiver — which is every tenant on the day this
// ships — therefore pays ZERO extra round-trips on the acquisition path, and a
// tenant with one pays exactly one callable on a step it is about to render
// anyway. If that mirror is briefly stale-empty the visitor simply sees no step
// and the SERVER refuses with `waiver_required`, which the surface handles by
// fetching the requirement properly. Annoying; never a compliance hole.
//
// ── CALLER RESOLUTION IS THE WHOLE CORRECTNESS ARGUMENT ─────────────────────
// This callable must report EXACTLY the state the gate will compute for the
// same person at the same instant, or it is worse than useless: it would tell
// somebody there is nothing to sign and then have the rail refuse them — on the
// returning-member path, after their verification code was already marked used.
// So it resolves the caller through the same proofs the rails accept, in the
// same order, and never by email alone:
//
//   1. a contact session          → that contactId, authoritatively
//   2. authenticatedContactId + verificationCodeId → validated READ-ONLY
//      against `booking_verification_codes`, exactly as `bookSession` validates
//      it, WITHOUT marking the code used. Nothing here may spend a credential
//      the rail is about to need.
//   3. email + firstname + lastname → the shared guest predicate
//      (booking/guestContactMatch.ts), which is the rails' own code
//   4. anything less → the CONSERVATIVE answer: no contact, `state: 'none'`.
//
// A `contactId` in the request body is deliberately NOT a proof. Trusting one
// would turn this into an oracle over a compliance fact ("has contact X signed
// the release?") for any anonymous caller — the same shape the July 2026 audit
// closed on `createDropInCheckout`. It is honored only when it agrees with the
// session, so an over-eager client still works.

import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  DOCUMENTS_COLLECTION,
  DOCUMENT_VERSIONS_SUBCOLLECTION,
  documentVersionId,
  waiverAcceptanceState,
  waiverStateSatisfiesGate,
  type WaiverAcceptanceState,
} from '@linyup/shared'
import { generateSecureToken } from '../utils/crypto'
import { resolveWaiverCaller } from './caller'
import { chargeWaiverResolve, waiverCallerCredential } from './limits'
import { applicableWaivers, loadSignerFacts, loadWaiverPolicy } from './gate'

/** What the surface must do next for one waiver. Two answers, because the person
 *  in front of the step is always the person who can complete it. */
export type WaiverStepAction = 'none' | 'sign_self'

export interface WaiverRequirementItem {
  documentId: string
  slug: string
  title: string
  version: number
  /** The FROZEN text of that version — the same string the acceptance's hash
   *  pins. It comes from the version snapshot and never from the document's
   *  live body, which a manager may be mid-edit on. */
  bodyHtml: string
  bodyHash: string
  /** The studio flagged this waiver "participants may be minors", so the step
   *  shows the second required choice — "I am the participant" vs "I am signing
   *  as a parent or guardian" — with an optional name. A SELF-DECLARATION: it
   *  changes what is recorded and what the roster shows, never whether the
   *  booking is allowed. */
  mayIncludeMinors: boolean
  state: WaiverAcceptanceState
  action: WaiverStepAction
  intentId: string
}

// The caller resolution lives in waivers/caller.ts because the answer it gives
// has to be the answer the GATE computes for the same person at the same
// instant — a disagreement would tell somebody there is nothing to sign and then
// have the rail refuse them, on the returning-member path, after their
// verification code was already marked used.

/** The frozen text of one version. Read from the immutable snapshot, never from
 *  the document's live body. */
async function loadVersionText(
  documentId: string,
  version: number
): Promise<{ bodyHtml: string; bodyHash: string } | null> {
  const snap = await admin
    .firestore()
    .collection(DOCUMENTS_COLLECTION)
    .doc(documentId)
    .collection(DOCUMENT_VERSIONS_SUBCOLLECTION)
    .doc(documentVersionId(version))
    .get()
  if (!snap.exists) return null
  const d = snap.data()!
  const bodyHtml = (d.bodyHtml as string | undefined) ?? ''
  const bodyHash = (d.bodyHash as string | undefined) ?? ''
  if (!bodyHash) return null
  return { bodyHtml, bodyHash }
}

export const resolveWaiverRequirement = onCall(async (request) => {
  const data = (request.data ?? {}) as {
    teamId?: string
    activityId?: string
    contactId?: string
    authenticatedContactId?: string
    verificationCodeId?: string
    email?: string
    firstname?: string
    lastname?: string
    /**
     * WHICH SURFACE IS ASKING, and it changes exactly one thing: the SCOPE.
     *
     * A booking rail asks about ONE activity, so `activities`-scoped waivers are
     * filtered to that activity and a null activity excludes them — "we could
     * not tell which activity" must never widen a requirement a studio scoped
     * narrowly.
     *
     * `space` is not a booking. It is the member's own portal answering "what do
     * I owe this studio", so it resolves EVERY required waiver whatever its
     * scope. That is not a widening of any gate — nothing here books anything —
     * and without it the member's only self-service surface could not show, let
     * alone sign, an activity-scoped waiver: `selfCheckIn` and the mobile app
     * refuse over exactly those and send the member HERE, which was a loop with
     * no exit.
     *
     * Honored only for a caller holding a contact session for this team. The
     * activity-scoped titles are already in the world-readable mirror, so this
     * is a narrowing of habit rather than a security boundary — but a portal
     * answer belongs to somebody who is signed in.
     */
    surface?: 'booking' | 'space'
  }
  if (!data.teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  // ── THE LIMIT, AND THE WHOLE OF IT ────────────────────────────────────────
  // One charge, at the TOP, before any query — so an IP that has spent its hour
  // is refused before it costs a read rather than after. It is spent by exactly
  // one shape: an uncredentialed caller ASKING ABOUT A PERSON. The model, the
  // ceiling and the reason it is 600 rather than 30 are in waivers/limits.ts.
  //
  // Three shapes deliberately cost nothing here, and each one was a lockout the
  // last time it did: a signed-in member or the studio's own paired tablet (a
  // credential of ours, checked from claims with no read at all), a returning
  // walk-in whom the guest predicate recognizes, and a caller who supplied no
  // identity and is therefore reading nothing but the studio's published text.
  const credential = waiverCallerCredential(request, data.teamId)
  await chargeWaiverResolve({
    ip: request.rawRequest?.ip,
    credential,
    asksAboutAPerson:
      !!(data.email ?? '').trim() || !!(data.authenticatedContactId && data.verificationCodeId),
  })

  const policy = await loadWaiverPolicy(data.teamId)
  const scoped = applicableWaivers(policy, data.activityId ?? null)
  // The zero-cost rule is unchanged: a tenant whose policy says nothing (every
  // tenant on the day this ships) returns here, before the caller is resolved,
  // and so does a booking rail with nothing applicable — exactly what it paid
  // before. Only the Space arm, at a tenant that DOES require something, reaches
  // past this.
  if (policy.length === 0 || (scoped.length === 0 && data.surface !== 'space')) {
    return { waivers: [] as WaiverRequirementItem[] }
  }

  const caller = await resolveWaiverCaller(request, { ...data, teamId: data.teamId })
  const applicable = data.surface === 'space' && caller.proof === 'session' ? policy : scoped
  if (applicable.length === 0) {
    return { waivers: [] as WaiverRequirementItem[] }
  }
  const signers = await loadSignerFacts(applicable, caller.contactId)
  const nowMs = Date.now()

  const waivers: WaiverRequirementItem[] = []
  for (const entry of applicable) {
    const state = waiverAcceptanceState(
      { min_valid_version: entry.min_valid_version },
      signers[entry.documentId] ?? null,
      nowMs
    )
    const text = await loadVersionText(entry.documentId, entry.current_version)
    if (!text) {
      // The policy names a version whose snapshot cannot be read. The gate will
      // refuse this booking with `waiver_unavailable`, so saying "nothing to
      // sign" here would send the visitor into a refusal with no step behind it.
      throw new HttpsError('failed-precondition', 'This booking is temporarily unavailable.', {
        reason: 'waiver_unavailable',
        documentId: entry.documentId,
      })
    }

    waivers.push({
      documentId: entry.documentId,
      slug: entry.slug,
      title: entry.title,
      version: entry.current_version,
      bodyHtml: text.bodyHtml,
      bodyHash: text.bodyHash,
      mayIncludeMinors: entry.mayIncludeMinors === true,
      state,
      action: waiverStateSatisfiesGate(state) ? 'none' : 'sign_self',
      // 16 bytes, minted per render and echoed back with the tick. It buys ONE
      // property — a double-submit of the same tick writes one row — and it is
      // not a credential: forging one only affects whether a duplicate row is
      // created, which is self-harm. Deliberately not persisted, so there is no
      // intent collection, no TTL and no sweep.
      intentId: generateSecureToken(16),
    })
  }

  // NOTHING IS CHARGED HERE. The counter was spent at the top or not at all —
  // a charge that depends on what the answer turned out to contain is a charge
  // on being recognized, and every returning walk-in at a doorway is recognized.
  return { waivers }
})
