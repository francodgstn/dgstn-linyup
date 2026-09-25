// THE waiver gate. One helper, called by every rail; there is no per-rail copy.
//
// ══ THE CENSUS — every site that puts a person in a room, and what it does ═══
// This block is the OWNER of that list. Add to it here; never restate it, and
// never restate a count of it. It was built by grepping the WRITE SITES —
//
//   grep -rn "collection('participants')\|collection('bookings')\|
//             collection('attendees')\|PARTICIPANTS_SUBCOLLECTION" \
//        packages/functions/src apps/web/src apps/mobile/src
//
// — and not the callable names, because a list of names you already trust
// cannot discover the name you forgot. Regenerate it rather than trusting the
// rows below to still be exhaustive.
//
// GATED — refuses before any contact write, records the acceptance with the seat:
//   • bookSession                (booking/index.ts)      — free class booking
//   • createDropInCheckout       (booking/dropIn.ts)     — paid class, both the
//     Stripe hold and the full-gift-card-cover branch that books immediately
//   • bookAppointment            (appointments/window.ts)
//   • createAppointmentCheckout  (appointments/checkout.ts) — the hold IS the session
//   • claimWaitlistSeat          (booking/waitlist/claim.ts)
//
// GATED, REFUSE-ONLY — no contact is created and no seat is booked, so there is
// nothing to record; an unsigned member is simply told to sign:
//   • selfCheckIn                (sessions/index.ts) — a contact-session
//     callable that writes `participants` with NO booking required. Live on the
//     kiosk QR and the mobile scanner. Left open, a member whose signature a
//     `require_resign` publish superseded walks up, scans, and attends unsigned.
//
// INHERITED — no server work; they call a gated callable:
//   • the kiosk walk-in (WalkIn.tsx → bookSession)
//   • the waitlist claim's payable hop (→ createDropInCheckout({waitlistToken}))
//   • apps/mobile (bookSession, bookAppointment, selfCheckIn)
//
// NOT GATED, AND WHY — the exemptions are as explicit as the inclusions, because
// a set is only enumerated when both halves are written down:
//   • rebookSession — MOVES an existing seat. It creates no new attendance
//     relationship, and a publish never retroactively invalidates a committed
//     booking, so gating it would be stricter on the reversible operation than
//     on the irreversible one. Its two callers (the studio's bookings list and
//     the public manage-booking link) have no waiver step to send anyone to.
//   • joinWaitlist — joining a queue is not a booking. A signature taken here
//     would belong to a class the person may never be offered.
//   • the waitlist promoter (booking/waitlist/promote.ts) — a SYSTEM write with
//     no caller. It reserves the seat as a `pending` booking; the person is
//     gated when they claim it, which is the row above.
//   • Staff class booking (apps/web .../sessions/[id]/page.tsx add-participant)
//     — a direct client write with NO server seam. It CANNOT be gated without a
//     new callable. Surfaced on the roster instead.
//   • createStaffAppointment — the manual-override tool by design (its own
//     comment says it works outside availability). A coach booking a client by
//     phone must not be stopped by a document the client has not opened.
//   • checkInContact (contacts/index.ts) — the STAFF-side QR scanner, and the
//     structural twin of `selfCheckIn`: it writes `participants` with no
//     booking required. It is EXEMPT on the same axis that exempts
//     `createStaffAppointment`: the acting party is a team member standing at
//     the door who has chosen to admit this person, and refusing them there
//     stops a queue over a document the coach cannot resolve from that screen.
//     The axis is WHO IS ACTING, not "can it technically be gated" — self-scan
//     is the member acting alone and is gated; a coach scanning is an override,
//     and an override a human chose is what "surface, do not block" means. The
//     roster chip is the surfacing.
//   • Confirming an EXISTING booking into `participants` (the bookings list, the
//     session detail page, checkInContact's booking arm, the Connect webhook) —
//     the attendance relationship was created and gated upstream; a confirm that
//     could refuse would strand a paid seat.
//   • Event attendance (handleEventInvitationResponse, addEventCheckin) — an
//     Event is a different primitive: no Session, no Activity, and
//     `WaiverApplies` has no arm that can name one. Exempt in v1 with the reason
//     stated to the studio in docs/waivers.md rather than left to inference.
//
// EVERY RAIL REFUSES, AND THERE IS NO EXCEPTION. An earlier cut let two rails
// (the waitlist claim and the paired kiosk) COMPLETE with a waiver outstanding,
// because the only thing they could not resolve on the spot was a guardian's
// emailed signature. That machinery is gone (see `WaiverConfig.mayIncludeMinors`
// in @linyup/shared), and with it the only reason a rail could not finish: the
// consent step is now always completable by the person standing there. So there
// is one behavior on every rail — sign, or be refused — and `WaiverGateStep`
// has no `defer` arm to reintroduce it.
//
// ══ THE TWO ORDERING RULES, WHICH ARE THE WHOLE POINT ═══════════════════════
// 1. REFUSE BEFORE ANY CONTACT WRITE. A refusal must leave no contact created,
//    no funnel stamp, no `trial_used_at` burned and no acceptance recorded.
//    Each rail's call site sits above its first contact write and says so.
// 2. RECORD WITH THE COMMIT. On the free rails the acceptance event and the
//    signer row go INSIDE the transaction that commits the seat, so neither can
//    exist without the other. On the paid rails the acceptance is written before
//    Stripe, in its own transaction, and is NOT conditional on payment — a
//    signature is a fact about a person: they read the text and ticked, and that
//    is true whether or not the card clears.
//
// NOT AN ATTENDANCE RAIL, AND DELIBERATELY OUTSIDE THE CENSUS ABOVE. Each of
// these writes the LEDGER without putting anybody in a room, so listing it
// beside the rails would misdescribe both — and a census whose members are not
// all the same kind of thing stops being checkable. Every one of them still
// composes the same pieces, so there is exactly one answer to "does this tick
// count": `decideWaiverGate` for the decision, `resolveWaiverSubmissions` for
// the server's own hash, `accept.ts` for the write.
//   • waivers/space.ts (`signWaiverInSpace`) — a signed-in member re-signing a
//     document from their own account, which a `require_resign` publish is the
//     ordinary reason for. Without it, a supersession is discovered by being
//     refused mid-booking. It resolves the WHOLE policy rather than
//     `applicableWaivers(…, null)`, because it is not a gate and because the
//     rails that refuse over an activity-scoped waiver (selfCheckIn, the mobile
//     scanner) send the member there to sign it.
//   • waivers/signup.ts (`recordSignupConsent`, called by `completeSignup`) —
//     the signup consent checkbox, written as real events against real version
//     snapshots. It RECORDS and never refuses: signup is not attendance, and the
//     requirement still binds at the first booking.
//   • waivers/revoke.ts (`revokeWaiverAcceptance`) — a manager withdrawing a
//     signature. It appends a `kind: 'revoked'` event naming the acceptance it
//     revokes; the accepted row is never touched.
//
// This module decides; `accept.ts` writes. Nothing here creates, updates or
// deletes anything.

import * as admin from 'firebase-admin'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  DOCUMENTS_COLLECTION,
  DOCUMENT_VERSIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  WAIVER_POLICY_DOC_ID,
  WAIVER_POLICY_SUBCOLLECTION,
  cleanWaiverName,
  contactIdentityKey,
  documentVersionId,
  waiverAcceptanceState,
  waiverAppliesToActivity,
  waiverStateSatisfiesGate,
  type BookingWaiverState,
  type RequiredWaiverEntry,
  type WaiverAcceptanceSource,
  type WaiverAcceptanceState,
  type WaiverEmailVerification,
  type WaiverSignerFacts,
  type WaiverSignerState,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'
import { waiverSignerRef, type WaiverEventInput } from './accept'

// ─── Refusals ────────────────────────────────────────────────────────────────

/** Every refusal this gate can produce. Each has a translated string on every
 *  public surface — a refusal a surface cannot act on is a dead end, and on the
 *  returning-member path it is a dead end that already cost a verification
 *  code. */
export type WaiverRefusalReason =
  /** A required waiver has no valid acceptance for this caller. */
  | 'waiver_required'
  /** A `require_resign` publish landed between the tick and the submit. */
  | 'waiver_version_changed'
  /** The policy names a waiver whose version or text cannot be read. A
   *  compliance gate that fails OPEN is not a gate. */
  | 'waiver_unavailable'

export interface WaiverRefusalDetails {
  reason: WaiverRefusalReason
  documentId: string
  slug: string
  title: string
  /** The version the caller must now read, when that is what changed. */
  version: number
  /** So the surface can render the self-declaration choice on the step it is
   *  about to present, without a second round-trip to learn whether to. */
  mayIncludeMinors: boolean
}

function refuse(details: WaiverRefusalDetails): HttpsError {
  // 'failed-precondition', never 'permission-denied': the caller is not
  // forbidden, they have a step to complete. The surface routes on
  // `details.reason` and never on the message.
  return new HttpsError('failed-precondition', 'This booking needs a signed document.', details)
}

// ─── What a rail hands the gate ──────────────────────────────────────────────

/** The person the release is about, as the rail already knows them. */
export interface WaiverGateSubject {
  /**
   * null ⇒ a brand-new guest whose contact does not exist yet. The gate still
   * runs (that is the point of running it above the contact write): with no
   * contact there is no signer row, so every required waiver reads `none`.
   */
  contactId: string | null
  name: string
  email: string | null
}

/** One tick the visitor sent back, echoing what they were shown. */
export interface WaiverSubmission {
  documentId: string
  version: number
  bodyHash: string
  /** The nonce minted by `resolveWaiverRequirement`. It buys exactly one
   *  property — a double-submit of the same tick writes one row — and it is not
   *  a credential. */
  intentId: string
  /**
   * THE SELF-DECLARATION, shown only on a waiver the studio flagged
   * `mayIncludeMinors`: "I am signing as a parent or guardian" instead of "I am
   * the participant". It is honored ONLY for a flagged waiver — a value the
   * step never showed must not land in the evidence, the same discipline that
   * governs every other field on this payload.
   */
  signingAsGuardian?: boolean
  /** Optional name the guardian gave for themselves. Cleaned before it reaches
   *  a record; absent is ordinary and is not an error. */
  guardianName?: string | null
}

// ─── The pure decision core ──────────────────────────────────────────────────

export interface ResolvedSubmission extends WaiverSubmission {
  /**
   * The hash the SERVER holds for the version this submission names — from the
   * policy entry when it is the current version, or from that version's own
   * immutable snapshot when a `silent` publish moved on underneath the visitor.
   * null ⇒ the version could not be read at all.
   */
  authoritativeHash: string | null
}

export type WaiverGateStep =
  /** Already valid. The acceptance write is a NO-OP whatever payload arrived. */
  | { outcome: 'satisfied'; entry: RequiredWaiverEntry; state: WaiverAcceptanceState }
  /** Record this tick with the commit. */
  | { outcome: 'record'; entry: RequiredWaiverEntry; submission: ResolvedSubmission }
  | { outcome: 'refuse'; details: WaiverRefusalDetails }

export interface WaiverGateDecisionInput {
  /** Already filtered to the waivers that apply to what is being booked. */
  applicable: RequiredWaiverEntry[]
  /** Current-state facts per documentId. Missing or null ⇒ never signed. */
  signers: Record<string, WaiverSignerFacts | null>
  submissions: ResolvedSubmission[]
  nowMs: number
}

/**
 * The whole gate, as a pure function, so every rail's behavior can be asserted
 * without a Firestore emulator and no refusal in `WaiverRefusalReason` can be
 * argued about one rail at a time. (That union is the owner of the refusal set.)
 *
 * ORDER PER WAIVER, fixed here:
 *   1. Is the existing signature valid?   → satisfied, and nothing is recorded.
 *   2. Did they tick, on a version that still counts, over the text we hold?
 *
 * There is no third question about WHO may tick. The person in front of the step
 * is the only person who can complete it, on every rail; whether they say they
 * are the participant or a parent is RECORDED (see `WaiverSubmission`), never
 * gated on — the studio is the only party who can verify that, and the roster
 * chip is where they are asked to.
 */
export function decideWaiverGate(input: WaiverGateDecisionInput): WaiverGateStep[] {
  const { applicable, signers, submissions, nowMs } = input

  return applicable.map((entry): WaiverGateStep => {
    const detailsFor = (reason: WaiverRefusalReason): WaiverRefusalDetails => ({
      reason,
      documentId: entry.documentId,
      slug: entry.slug,
      title: entry.title,
      version: entry.current_version,
      mayIncludeMinors: entry.mayIncludeMinors === true,
    })

    // ── 1. An existing signature that still counts ends it here ──
    const state = waiverAcceptanceState(
      { min_valid_version: entry.min_valid_version },
      signers[entry.documentId] ?? null,
      nowMs
    )
    if (waiverStateSatisfiesGate(state)) return { outcome: 'satisfied', entry, state }

    const submission = submissions.find((s) => s.documentId === entry.documentId) ?? null

    // ── 2. The tick itself ──
    if (!submission) return { outcome: 'refuse', details: detailsFor('waiver_required') }

    // A version BELOW the floor is exactly what a `require_resign` publish
    // means, and it is the only version failure the visitor can act on: they
    // re-read the new text and tick again. A `silent` publish does NOT move the
    // floor, so a submission against the version they actually read stays valid
    // — recording it against the newer one would claim they read text they never
    // saw, which is the one thing this whole design exists to prevent.
    if (submission.version < entry.min_valid_version || submission.version > entry.current_version) {
      return { outcome: 'refuse', details: detailsFor('waiver_version_changed') }
    }
    // Versions are immutable, so a hash that disagrees for the same version
    // number is a state that cannot legitimately exist. Refusing beats recording
    // a signature against text the server cannot identify.
    if (!submission.authoritativeHash || submission.authoritativeHash !== submission.bodyHash) {
      return { outcome: 'refuse', details: detailsFor('waiver_unavailable') }
    }

    return { outcome: 'record', entry, submission }
  })
}

/**
 * THE self-declaration this request actually made about ONE waiver, resolved
 * exactly the way `decideWaiverGate` resolves a submission: the row naming that
 * document, and only when the studio flagged that document `mayIncludeMinors`.
 *
 * Both halves are load-bearing. The payload is untrusted in what it may NAME —
 * a row for a `documentId` this policy does not contain is never consumed by any
 * decision, so it must never reach a record either. And a declaration the step
 * did not SHOW is not a declaration: honoring `signingAsGuardian` on an
 * unflagged waiver would let a client stamp "a parent signed" onto an
 * adults-only studio's ledger, which is a claim nobody was asked to make.
 */
export function declarationFor(
  entry: RequiredWaiverEntry,
  submission: Pick<WaiverSubmission, 'signingAsGuardian' | 'guardianName'> | null
): { signingAsGuardian: boolean; guardianName: string } {
  if (!submission || entry.mayIncludeMinors !== true) {
    return { signingAsGuardian: false, guardianName: '' }
  }
  const signingAsGuardian = submission.signingAsGuardian === true
  return {
    signingAsGuardian,
    guardianName: signingAsGuardian ? cleanWaiverName(submission.guardianName) : '',
  }
}

// ─── The Firestore half ──────────────────────────────────────────────────────

function policyRef(teamId: string): FirebaseFirestore.DocumentReference {
  return admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(WAIVER_POLICY_SUBCOLLECTION)
    .doc(WAIVER_POLICY_DOC_ID)
}

/**
 * THE authorization source. Server-written, client-unwritable, and it fails
 * CLOSED — which is the whole reason it exists rather than the gate reading
 * `TeamPublicProfile.required_waivers`. That mirror SKIPS any document whose
 * public summary is missing and writes the array anyway; fail-open-to-empty is
 * right for a list of consent links and catastrophic for an authorization gate,
 * where "silently skipped" becomes "the required waiver vanished and the
 * booking went through".
 *
 * Cost: ONE document read. A team with no waivers — which is every team on the
 * day this ships — pays exactly that and nothing else, per booking.
 */
export async function loadWaiverPolicy(teamId: string): Promise<RequiredWaiverEntry[]> {
  const snap = await policyRef(teamId).get()
  const raw = snap.data()?.required
  return Array.isArray(raw) ? (raw as RequiredWaiverEntry[]) : []
}

/** Which of the team's required waivers apply to the thing being booked. */
export function applicableWaivers(
  policy: RequiredWaiverEntry[],
  activityId: string | null
): RequiredWaiverEntry[] {
  return policy.filter((e) => waiverAppliesToActivity(e.scope, activityId))
}

/** Signer rows for the applicable waivers — at most one `get` each, bounded by
 *  MAX_REQUIRED_WAIVERS_PER_TEAM. A null contactId (a guest whose contact does
 *  not exist yet) costs zero reads and reads as "never signed". */
export async function loadSignerFacts(
  entries: RequiredWaiverEntry[],
  contactId: string | null
): Promise<Record<string, WaiverSignerFacts | null>> {
  if (!contactId || entries.length === 0) return {}
  const snaps = await admin
    .firestore()
    .getAll(...entries.map((e) => waiverSignerRef(e.documentId, contactId)))
  const out: Record<string, WaiverSignerFacts | null> = {}
  entries.forEach((entry, i) => {
    const data = snaps[i]?.exists ? (snaps[i].data() as WaiverSignerState) : null
    out[entry.documentId] = data
      ? {
          accepted_version: data.accepted_version,
          accepted_at: data.accepted_at,
          valid_until: data.valid_until ?? null,
          status: data.status,
        }
      : null
  })
  return out
}

/**
 * Resolve the hash the server holds for each submitted version.
 *
 * Fast path — the submission names the current version, so the policy entry
 * already carries its hash and no read happens. Slow path — a `silent` publish
 * moved on while the visitor was reading, so the version they actually read is
 * still valid and its snapshot is fetched to pin the right text. That read only
 * occurs in the mid-publish race.
 */
export async function resolveWaiverSubmissions(
  entries: RequiredWaiverEntry[],
  submissions: WaiverSubmission[]
): Promise<ResolvedSubmission[]> {
  const byId = new Map(entries.map((e) => [e.documentId, e]))
  return Promise.all(
    submissions.map(async (s): Promise<ResolvedSubmission> => {
      const entry = byId.get(s.documentId)
      if (!entry) return { ...s, authoritativeHash: null }
      if (s.version === entry.current_version) return { ...s, authoritativeHash: entry.body_hash }
      const snap = await admin
        .firestore()
        .collection(DOCUMENTS_COLLECTION)
        .doc(s.documentId)
        .collection(DOCUMENT_VERSIONS_SUBCOLLECTION)
        .doc(documentVersionId(s.version))
        .get()
      const hash = snap.exists ? ((snap.data()?.bodyHash as string | undefined) ?? null) : null
      return { ...s, authoritativeHash: hash }
    })
  )
}

export interface WaiverGateParams {
  teamId: string
  /** The activity being booked, for `scope: 'activities'`. */
  activityId: string | null
  subject: WaiverGateSubject
  /** Untrusted client payload; coerced by `parseWaiverSubmissions`. */
  submissions: WaiverSubmission[]
  source: WaiverAcceptanceSource
  /** How the signer's address was established ON THIS RAIL. 'session' means a
   *  contact session was open, which identifies the CONTACT and not the person
   *  at the keyboard; 'none' means the address was merely typed. */
  signerEmailVerifiedBy: WaiverEmailVerification
  /**
   * THE address that identifies the signer, when it is not the subject's own.
   * Read by `buildAcceptance` below and written to `signer_email`.
   *
   * On the OTP rails it is `booking_verification_codes.email` — the address the
   * six-digit code was actually mailed to — and passing it is not a nicety:
   *
   *   A parent verifies with parent@example.com, selects their 14-year-old from
   *   the matched list (the flow bookSession's own comment describes) and
   *   books. Taking `signer_email` from the CONTACT instead records
   *   `signer_email: child@example.com` against `verified_code`, and the export
   *   prints a mailbox-proved signature by a child who never touched it.
   *
   * Where this address differs from the subject's, the record is already
   * telling its reader that a third party signed, which is exactly what the
   * export prints side by side. Absent ⇒ the subject's own address, which is
   * the truth on the three rails that never see a code: the drop-in checkout,
   * the waitlist claim and `selfCheckIn` all identify the caller by contact
   * session or by nothing, so there is no second address to record.
   */
  signerEmail?: string | null
  ip: string | null
  userAgent: string | null
  locale: string | null
  /** THE INSTANT OF THE TICK, captured ONCE before any transaction. */
  nowMs: number
}

export interface WaiverGateOutcome {
  /**
   * Ledger inputs the rail must write — one per waiver actually signed by this
   * request. EMPTY when nothing applied or everything was already valid, which
   * is the overwhelmingly common case and costs the rail nothing.
   */
  accepts: WaiverEventInput[]
  /** The denormalised stamp for the booking document, or null to write nothing. */
  bookingWaiverState: BookingWaiverState | null
}

/**
 * THE call every rail makes. Throws `HttpsError` with `details.reason` on a
 * refusal; returns what to write on success.
 *
 * PLACE IT ABOVE THE FIRST CONTACT WRITE. Every refusal it throws must cost the
 * caller nothing but a re-render.
 *
 * It writes NOTHING itself — the rail owns the writes, because on the free rails
 * they belong inside the transaction that commits the seat.
 */
export async function enforceWaiverGate(params: WaiverGateParams): Promise<WaiverGateOutcome> {
  const policy = await loadWaiverPolicy(params.teamId)
  const applicable = applicableWaivers(policy, params.activityId)
  if (applicable.length === 0) {
    return { accepts: [], bookingWaiverState: null }
  }

  const [signers, submissions] = await Promise.all([
    loadSignerFacts(applicable, params.subject.contactId),
    resolveWaiverSubmissions(applicable, params.submissions),
  ])

  const steps = decideWaiverGate({
    applicable,
    signers,
    submissions,
    nowMs: params.nowMs,
  })

  const firstRefusal = steps.find((s) => s.outcome === 'refuse')
  if (firstRefusal && firstRefusal.outcome === 'refuse') throw refuse(firstRefusal.details)

  // Past this point the caller is admitted, so a contactId is required to
  // record anything. A brand-new guest reaches here only when nothing needs
  // recording (every applicable waiver would have refused above), and the rail
  // then creates its contact and calls `attachWaiverContact` with it.
  const accepts: WaiverEventInput[] = []
  for (const step of steps) {
    if (step.outcome !== 'record') continue
    accepts.push(buildAcceptance(params, step.entry, step.submission, params.subject.contactId ?? ''))
  }

  return {
    accepts,
    bookingWaiverState: bookingWaiverStateFor(applicable, accepts),
  }
}

/**
 * The denormalised stamp, and it is a PROMPT rather than a verdict.
 *
 * `guardian_declared` when this request recorded somebody signing as a parent or
 * guardian; `check_participant` when a `mayIncludeMinors` waiver applied and it
 * did not. A studio that never flags a waiver only ever sees `ok`, which is what
 * keeps the chip off every adults-only roster in the product.
 *
 * It is a snapshot of THIS booking, so a repeat booking riding on a guardian
 * signature taken months ago stamps `check_participant` rather than
 * `guardian_declared` — the prompt is the same either way, and the precise
 * answer is on the signer row, which is what the live roster chip reads.
 */
export function bookingWaiverStateFor(
  applicable: Pick<RequiredWaiverEntry, 'mayIncludeMinors'>[],
  accepts: Pick<WaiverEventInput, 'signerRole'>[]
): BookingWaiverState {
  if (accepts.some((a) => a.signerRole === 'guardian')) return 'guardian_declared'
  if (applicable.some((e) => e.mayIncludeMinors === true)) return 'check_participant'
  return 'ok'
}

function buildAcceptance(
  params: WaiverGateParams,
  entry: RequiredWaiverEntry,
  submission: ResolvedSubmission,
  contactId: string
): WaiverEventInput {
  const email = params.subject.email
  const declaration = declarationFor(entry, submission)
  return {
    teamId: params.teamId,
    documentId: entry.documentId,
    version: submission.version,
    bodyHash: submission.bodyHash,
    contactId,
    identityKey: contactIdentityKey({ email, contactId }, sha256Hex),
    kind: 'accepted',
    intentId: submission.intentId,
    // THE SELF-DECLARATION, and nothing verifies it — see
    // `WaiverAcceptanceEvent.signer_role`. A guardian who gave no name falls
    // back to the name the booking was made under; the role is what carries the
    // distinction.
    signerRole: declaration.signingAsGuardian ? 'guardian' : 'self',
    signerName: declaration.guardianName || params.subject.name,
    // THE SIGNER'S address, which is not always the SUBJECT's — see
    // `WaiverGateParams.signerEmail`. The fallback is the subject's own, which
    // is the truth wherever no rail proved a different mailbox. Note the
    // identity key above deliberately keeps using the SUBJECT's address: it is
    // what says which person this row is about, and binding it to whoever
    // happened to hold the code would merge a parent's ledger with a child's.
    signerEmail: params.signerEmail || email || '',
    signerEmailVerifiedBy: params.signerEmailVerifiedBy,
    subjectName: params.subject.name,
    subjectEmail: email,
    // FROZEN AT THE TICK. Reading the live `validityMonths` at expiry time
    // instead would let one field edit retroactively re-date every signature a
    // studio ever took, with no version, no publish event and nothing in the
    // export saying when the rule changed.
    validityMonthsAtSigning: entry.validityMonths,
    ip: params.ip,
    userAgent: params.userAgent,
    locale: params.locale,
    source: params.source,
    contactName: params.subject.name,
    contactEmail: email,
  }
}

/**
 * Bind a gate outcome computed for a not-yet-existing guest to the contact the
 * rail has just created.
 *
 * It exists because rule 1 and rule 2 pull in opposite directions on the guest
 * rails: the gate must run ABOVE the contact write, and the acceptance must
 * carry the contact id. Rather than resolve the gate twice (which would let the
 * two answers diverge), the rail resolves once and rebinds here.
 */
export function attachWaiverContact(
  outcome: WaiverGateOutcome,
  contactId: string
): WaiverGateOutcome {
  return {
    ...outcome,
    accepts: outcome.accepts.map((a) => ({
      ...a,
      contactId,
      identityKey: contactIdentityKey({ email: a.contactEmail, contactId }, sha256Hex),
    })),
  }
}

// ─── Client payload coercion ─────────────────────────────────────────────────

/**
 * Narrow an untrusted `waiverAcceptances` payload. Anything malformed is
 * DROPPED rather than repaired: a submission the server cannot read is a
 * submission that never happened, and the gate then refuses in the ordinary way
 * with a reason the surface can act on.
 *
 * THE WIRE SHAPE every booking surface must send, per waiver:
 *
 *   { documentId, version, bodyHash, intentId, accepted: true,
 *     signingAsGuardian?, guardianName? }
 *
 * `documentId`, `version`, `bodyHash` and `intentId` come straight back from
 * `resolveWaiverRequirement` — they are what pin the signature to the exact text
 * that was on screen. `accepted` is the checkbox and is NOT on the internal
 * type, deliberately: an omitted or `false` tick must read as "did not sign"
 * rather than as a shape the server fills in for the visitor. The last two are
 * the self-declaration, and `declarationFor` drops them for any waiver the
 * studio did not flag `mayIncludeMinors` — the step never asked, so the record
 * must not claim.
 */
export function parseWaiverSubmissions(raw: unknown): WaiverSubmission[] {
  if (!Array.isArray(raw)) return []
  const out: WaiverSubmission[] = []
  for (const item of raw.slice(0, 8)) {
    const s = item as Record<string, unknown> | null
    if (!s || typeof s !== 'object') continue
    if (typeof s.documentId !== 'string' || !s.documentId) continue
    if (typeof s.version !== 'number' || !Number.isInteger(s.version) || s.version < 1) continue
    if (typeof s.bodyHash !== 'string' || !s.bodyHash) continue
    if (typeof s.intentId !== 'string' || !s.intentId) continue
    // The tick itself. An explicit `false` is a visitor who did not agree, and a
    // payload that omits it is a client bug; both must read as "not signed".
    if (s.accepted !== true) continue
    out.push({
      documentId: s.documentId,
      version: s.version,
      bodyHash: s.bodyHash,
      intentId: s.intentId,
      signingAsGuardian: s.signingAsGuardian === true,
      guardianName: typeof s.guardianName === 'string' ? s.guardianName : null,
    })
  }
  return out
}
