// `signWaiverInSpace` — a member re-signing from their own account.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
// A `require_resign` publish supersedes every signature the studio holds. Until
// this callable, the only way to fix that was to try to book something and be
// refused — which is a compliance feature discovering itself at the worst
// possible moment, on the acquisition path, for a member who was doing nothing
// wrong. Space is where a member's own state lives, so it is where a member
// puts it right.
//
// ── WHY IT IS NOT IN waivers/gate.ts's CENSUS ───────────────────────────────
// That census enumerates every site that PUTS A PERSON IN A ROOM. This one puts
// nobody anywhere: it books nothing, admits nobody and refuses no attendance.
// Listing it there would misdescribe both it and the census — and a census whose
// members are not all the same kind of thing stops being checkable.
//
// It still has exactly ONE answer to "does this tick count", because it composes
// the same pieces the rails do: `loadWaiverPolicy` (the authorization source
// that fails closed), `resolveWaiverSubmissions` (the server's own hash for the
// version named), `decideWaiverGate` (the pure decision, in its fixed order) and
// `recordWaiverEvents` (the one ledger writer, with its read-then-skip and its
// precedence rule). Nothing about validity is re-derived here.
//
// ── SCOPE: EVERY REQUIRED WAIVER, WHATEVER ITS SCOPE ────────────────────────
// The whole policy, not `applicableWaivers(policy, null)`.
//
// It was the latter, and that made this surface a dead end for the exact member
// it exists for. `waiverAppliesToActivity` excludes an `activities`-scoped
// waiver when no activity is in hand — the right answer for a GATE, where "we
// could not tell which activity" must never widen a requirement a studio scoped
// narrowly — so an activity-scoped waiver was invisible here and unsignable
// here. Meanwhile `selfCheckIn` and the mobile scanner REFUSE over precisely
// that waiver and send the member to Space to sign it (`signUrl` in the
// refusal). The member was told to go to the one place that could not help
// them, and there was no other route: no booking form need ever be opened to be
// refused at a door.
//
// Widening is sound here because this callable is not a gate: it books nothing,
// admits nobody and refuses no attendance. It offers a member the documents
// their studio requires and records the ones they choose to sign. Signing a
// waiver early can only ever satisfy a requirement the member would otherwise
// meet later; it cannot impose one, because what is REQUIRED for a booking is
// still decided by the gate, from the policy, against the activity in hand.

import * as admin from 'firebase-admin'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  contactIdentityKey,
  type RequiredWaiverEntry,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'
import { requireContactSessionForTeam } from '../utils/contactSession'
import { normalizeWaiverLocale, recordWaiverEvents, type WaiverEventInput } from './accept'
import {
  declarationFor,
  decideWaiverGate,
  loadSignerFacts,
  loadWaiverPolicy,
  parseWaiverSubmissions,
  resolveWaiverSubmissions,
} from './gate'

export const signWaiverInSpace = onCall(async (request: CallableRequest<unknown>) => {
  const data = (request.data ?? {}) as { teamId?: string; waiverAcceptances?: unknown }
  if (!data.teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  // A CONTACT SESSION AND NOTHING ELSE. There is no guest arm here on purpose:
  // an unauthenticated caller could otherwise write a signature naming any
  // contact, and a compliance ledger's whole value is naming somebody.
  const session = await requireContactSessionForTeam(request, data.teamId)
  const contactSnap = await admin
    .firestore()
    .collection(CONTACTS_COLLECTION)
    .doc(session.contactId)
    .get()
  if (!contactSnap.exists) {
    throw new HttpsError('not-found', 'We could not find your record.', {
      reason: 'contact_not_found',
    })
  }
  const contact = contactSnap.data()!
  // THE TENANT ASSERTION, ON THE SNAPSHOT THIS CALLABLE ACTUALLY WRITES FROM.
  // `requireContactSessionForTeam` reads the contact and checks its `teamId`,
  // so this is not the only check — but it checked a DIFFERENT read of the
  // document than the one every field below is copied from, and the ledger row
  // is written with `teamId: data.teamId`. A contact moved between teams
  // between the two reads, or a later narrowing of that shared helper (it
  // serves a dozen callables and nothing in it is owned by this file), would
  // land a signature naming one tenant's member in another tenant's evidence.
  // A cross-tenant row in a compliance ledger is not a display bug, it is a
  // false record.
  if (contact.teamId !== data.teamId) {
    throw new HttpsError('permission-denied', 'This account is no longer active', {
      reason: 'contact_team_mismatch',
    })
  }

  // THE WHOLE POLICY. See the scope note in the header: this is the member's own
  // portal, not a rail, and the activity-scoped waivers have to be reachable
  // here because the rails that refuse over them send the member here.
  const applicable: RequiredWaiverEntry[] = await loadWaiverPolicy(data.teamId)
  if (applicable.length === 0) return { recorded: 0 }

  const nowMs = Date.now()
  const submissions = parseWaiverSubmissions(data.waiverAcceptances)
  const [signers, resolved] = await Promise.all([
    loadSignerFacts(applicable, session.contactId),
    resolveWaiverSubmissions(applicable, submissions),
  ])

  const steps = decideWaiverGate({
    applicable,
    signers,
    submissions: resolved,
    nowMs,
  })

  const name = `${(contact.firstname as string) ?? ''} ${(contact.lastname as string) ?? ''}`.trim()
  const email = ((contact.email as string | undefined) ?? '').trim() || null
  const identityKey = contactIdentityKey({ email, contactId: session.contactId }, sha256Hex)

  const accepts: WaiverEventInput[] = []
  for (const step of steps) {
    // A waiver that is ALREADY valid is a no-op whatever payload arrived.
    if (step.outcome === 'satisfied') continue
    if (step.outcome === 'refuse') {
      // A REFUSAL IS ONLY THE CALLER'S PROBLEM IF THEY SUBMITTED FOR IT.
      //
      // This is not a rail: nobody is being admitted anywhere, so an outstanding
      // waiver the member did not tick is simply still outstanding — it stays on
      // the panel and they can come back to it. Throwing over it would mean that
      // a member with several documents could not record ANY of them: they tick
      // the one they read, and the call fails on the one they left. Widening
      // this surface to every scope (see the header) makes that the ordinary
      // shape rather than the rare one.
      //
      // What IS thrown is a refusal about something they DID submit — a
      // `require_resign` publish that landed while they were reading, or a hash
      // the server cannot identify. Swallowing that would let a member tick a box
      // and be told nothing happened.
      const submitted = submissions.some((s) => s.documentId === step.details.documentId)
      if (!submitted) continue
      throw new HttpsError('failed-precondition', 'This document still needs a signature.', step.details)
    }
    if (step.outcome !== 'record') continue
    const entry = step.entry
    // The self-declaration, honored only for a waiver the studio actually
    // flagged — the same rule the booking rails run, from the same helper, so
    // Space cannot record a claim its own step never showed.
    const declaration = declarationFor(entry, step.submission)
    accepts.push({
      teamId: data.teamId,
      documentId: entry.documentId,
      version: step.submission.version,
      bodyHash: step.submission.bodyHash,
      contactId: session.contactId,
      identityKey,
      kind: 'accepted',
      intentId: step.submission.intentId,
      signerRole: declaration.signingAsGuardian ? 'guardian' : 'self',
      signerName: declaration.guardianName || name,
      // A contact SESSION identifies the CONTACT, not the person at the
      // keyboard — `login_emails` is an access grant and identifies nobody. The
      // record says exactly that and claims no more.
      signerEmail: email ?? '',
      signerEmailVerifiedBy: 'session',
      subjectName: name,
      subjectEmail: email,
      validityMonthsAtSigning: entry.validityMonths,
      ip: request.rawRequest?.ip ?? null,
      userAgent: (request.rawRequest?.headers?.['user-agent'] as string | undefined) ?? null,
      // A CLIENT STRING ON A LEGAL RECORD, so it gets the ledger's own bound
      // rather than a local `typeof === 'string'` that stored whatever arrived.
      // `normalizeWaiverLocale` runs again inside the ledger writer — it is the
      // enforcing point for every rail — and it is idempotent, so calling it
      // here as well costs nothing and keeps this call site honestly typed.
      locale: normalizeWaiverLocale((request.data as { locale?: unknown })?.locale),
      source: 'space',
      contactName: name,
      contactEmail: email,
    })
  }

  if (accepts.length === 0) return { recorded: 0 }
  await recordWaiverEvents(accepts, nowMs)

  return { recorded: accepts.length }
})
