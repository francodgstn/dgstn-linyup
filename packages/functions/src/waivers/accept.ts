// THE acceptance ledger's one writer.
//
// Every rail that records a signature — the free booking commit, the paid
// checkouts, the waitlist claim, signup, Space, admin revocation — calls this
// module and nothing else. Three things therefore exist
// exactly once: the event id derivation, the READ-THEN-SKIP of the acceptance
// ref, and the CONDITIONAL signer-row write.
//
// ── THE LEDGER'S TWO HALVES ─────────────────────────────────────────────────
// APPEND-ONLY event rows hold the immutable facts; ONE mutable current-state
// row per (document, contact) holds the answer the gate asks. Re-signing,
// expiry and revocation are states of the second, never edits to the first.
// See types/waiver.ts in @linyup/shared for the full argument.
//
// ── THE TRAP THIS MODULE EXISTS TO DISARM ───────────────────────────────────
// `recordFinanceTransaction`'s idiom — `.create()`, catch gRPC 6, return false
// — works ONLY because that helper is a standalone write outside any
// transaction, so the error is catchable at the call site. Inside a booking
// commit transaction a `tx.create()` collision does NOT throw at the call: it
// fails the WHOLE commit as a precondition violation, is not
// catch-and-continue-able, and takes the seat with it.
//
// Two ordinary sequences hit it:
//   • a client retries a booking after a network timeout with the identical
//     payload — a retry that succeeds today;
//   • a visitor ticks once, books Tuesday's class, presses Back (which the
//     consent step is required to make safe) and books Thursday's from the same
//     mounted flow, still holding the same `intentId`.
// Both produce the identical derived id. So: `tx.get` the acceptance ref in the
// READ phase and SKIP the create when it exists. Do NOT copy the journal's
// catch-gRPC-6 shape into a transaction.
//
// ── THE OTHER HALF: THE SIGNER ROW IS NEVER WRITTEN UNCONDITIONALLY ─────────
// The event row is ALWAYS created — it is a fact, and facts are recorded. The
// signer row is updated only when `waiverEventImprovesSigner` says the event
// strictly improves it, evaluated against a row RE-READ INSIDE THE SAME
// TRANSACTION. A signer write outside a transaction is a bug, not an
// optimization. `rounds` is read + 1, absolute, never FieldValue.increment —
// the same rule `bookings_count` and `usage_count` carry.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  DOCUMENTS_COLLECTION,
  DOCUMENT_ACCEPTANCES_SUBCOLLECTION,
  DOCUMENT_SIGNERS_SUBCOLLECTION,
  waiverAcceptanceId,
  waiverEventImprovesSigner,
  waiverValidUntilMs,
  type WaiverAcceptanceEvent,
  type WaiverAcceptanceSource,
  type WaiverEmailVerification,
  type WaiverEventKind,
  type WaiverSignerRole,
  type WaiverSignerState,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'

/** What a rail hands the ledger. Everything here is either a fact the rail
 *  already knows or a snapshot the ledger must freeze; nothing is looked up. */
export interface WaiverEventInput {
  teamId: string
  documentId: string
  /** The version the signer ACTUALLY READ. Never "the current one". */
  version: number
  /** sha256 of the exact bodyHtml that was shown. */
  bodyHash: string
  contactId: string
  /** contactIdentityKey(...) — a secondary lookup, never a key of anything. */
  identityKey: string
  kind: WaiverEventKind
  /**
   * The nonce that makes a double-submit idempotent. Minted by
   * `resolveWaiverRequirement` and echoed back with the tick.
   */
  intentId: string

  /** WHAT THE SIGNER DECLARED THEY WERE. Self-declared; nothing verifies it —
   *  see `WaiverAcceptanceEvent.signer_role`. */
  signerRole: WaiverSignerRole
  signerName: string
  signerEmail: string
  signerEmailVerifiedBy: WaiverEmailVerification

  subjectName: string
  subjectEmail: string | null

  /** The validity rule in force AT THE TICK. Frozen here; never re-read from
   *  the live config, which would let one field edit retroactively re-date a
   *  studio's whole population. */
  validityMonthsAtSigning: number | null

  ip: string | null
  userAgent: string | null
  locale: string | null
  source: WaiverAcceptanceSource
  bookingRef?: { sessionId: string; bookingId: string } | null

  // NO `acceptedAtMs`, AND ITS ABSENCE IS NOW A PROPERTY. It existed for the
  // one rail where the tick and the write were days apart — a guardian clicking
  // an emailed link, whose signature a later booking filed. That rail is gone,
  // every remaining one ticks and writes inside a single request, and
  // `planWaiverLedgerWrite`'s `nowMs` is therefore always the instant of the
  // tick. A field that lets a caller name a different instant on a legal record
  // is not something to keep against a future need.

  /** Denormalised onto the signer row for the roster and the report; never read
   *  for a decision. */
  contactName: string
  contactEmail: string | null

  /** `kind: 'revoked'` only. */
  revokedBy?: string | null
  revokedReason?: string | null
  revokesAcceptanceId?: string | null
}

export interface WaiverLedgerPlan {
  acceptanceId: string
  acceptanceRef: FirebaseFirestore.DocumentReference
  signerRef: FirebaseFirestore.DocumentReference
  /** null ⇒ the event row already exists and the create is SKIPPED. This is the
   *  idempotent double-submit, and it is not an error. */
  event: WaiverAcceptanceEvent | null
  /**
   * null ⇒ this event does not strictly improve the current-state row, so the
   * row is left ALONE. Not an error either: the person really did read the text
   * and tick, the event says so, and the row simply already holds something
   * better (a later version, a later signature, or a revocation this acceptance
   * predates).
   */
  signer: WaiverSignerState | null
}

function documentRef(documentId: string): FirebaseFirestore.DocumentReference {
  return admin.firestore().collection(DOCUMENTS_COLLECTION).doc(documentId)
}

export function waiverAcceptanceRef(
  documentId: string,
  acceptanceId: string
): FirebaseFirestore.DocumentReference {
  return documentRef(documentId).collection(DOCUMENT_ACCEPTANCES_SUBCOLLECTION).doc(acceptanceId)
}

export function waiverSignerRef(
  documentId: string,
  contactId: string
): FirebaseFirestore.DocumentReference {
  return documentRef(documentId).collection(DOCUMENT_SIGNERS_SUBCOLLECTION).doc(contactId)
}

/** The event's document id, derived from the event rather than from the
 *  relationship.
 *
 *  `planWaiverLedgerWrite` below is now the ONLY production caller. The second
 *  one this was exported for — the guardian redemption, which had to derive the
 *  same id at two points of its own flow — went with that machinery. It stays
 *  exported for `ledger.test.ts`, which pins the derivation: this id is what
 *  makes a double-submit idempotent, and an untested id rule drifts. */
export function acceptanceIdFor(input: {
  documentId: string
  version: number
  contactId: string
  intentId: string
}): string {
  return waiverAcceptanceId(input, sha256Hex)
}

/**
 * THE bound on `locale` — the one client-supplied field of an acceptance that
 * is not already bounded before it gets here.
 *
 * `ip` and `user_agent` come off the request; `signer_email` and the subject
 * fields come off a contact document, a prior ledger row (a revocation copies
 * them forward) or the rail's own resolved subject; every other field is
 * derived. `signer_name` is the subject's name EXCEPT when a guardian typed one
 * — that string is caller-supplied, and it is bounded and stripped of control
 * characters by `cleanWaiverName` at `declarationFor`, before it ever reaches
 * this module. `locale` is therefore the one field bounded HERE, and it was
 * stored exactly as sent by `signWaiverInSpace` and by
 * `completeSignup` — unbounded, unshaped, on a row whose entire purpose is to be
 * read back as evidence. A field in an evidence record that can hold a megabyte
 * of anything is not evidence of anything.
 *
 * Applied HERE rather than at each caller, because here is the one place every
 * ledger row is built, and a per-caller coercion is a thing a new rail forgets.
 * Anything that is not a plausible BCP-47 tag becomes null — a locale we cannot
 * read is worth less than the honest absence the field already models.
 */
export function normalizeWaiverLocale(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().slice(0, 12)
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(trimmed) ? trimmed : null
}

/**
 * THE READ PHASE. Call this before any write in the enclosing transaction — it
 * `tx.get`s the acceptance ref and the signer row, which is what makes the
 * create skippable and the signer write conditional.
 *
 * Cost, on a rail that is already in a transaction: two single-document reads,
 * both on documents only this contact ever writes, so neither adds contention.
 *
 * ── `nowMs` IS THE INSTANT OF THE TICK, AND IT MUST BE CAPTURED ONCE ────────
 * Server time, never client time, and never `FieldValue.serverTimestamp()`,
 * which cannot be compared inside the transaction that has to order it. Capture
 * it BEFORE entering the transaction and pass the same value on every attempt.
 *
 * Defaulting it to the call's own clock would re-stamp on a transaction retry,
 * and that quietly breaks the precedence rule in the one case it exists for: a
 * manager revokes at 10:00:00 while an acceptance that read the row at 09:59:59
 * is in flight; Firestore aborts and retries the acceptance; a re-stamped
 * `accepted_at` of 10:00:02 then beats the revocation and silently undoes it.
 * The record would also be false — it would assert the person ticked two
 * seconds after they were revoked.
 */
export async function planWaiverLedgerWrite(
  tx: FirebaseFirestore.Transaction,
  input: WaiverEventInput,
  nowMs: number
): Promise<WaiverLedgerPlan> {
  // A LOUD failure rather than a corrupt record. The guest rails resolve the
  // gate ABOVE the contact write — they have to, or a refusal would leave a
  // contact behind — so the acceptance is built before the contact id exists and
  // is rebound afterwards. A rail that forgot to rebind would otherwise write an
  // event and a signer row at the empty id: evidence that names nobody, in the
  // one collection whose whole value is naming somebody.
  if (!input.contactId) {
    throw new Error('waiver acceptance has no contactId — the rail did not bind it after creating the contact')
  }
  const acceptanceId = acceptanceIdFor(input)
  const acceptanceRef = waiverAcceptanceRef(input.documentId, acceptanceId)
  const signerRef = waiverSignerRef(input.documentId, input.contactId)

  const [acceptanceSnap, signerSnap] = await Promise.all([tx.get(acceptanceRef), tx.get(signerRef)])

  const current = signerSnap.exists ? (signerSnap.data() as WaiverSignerState) : null
  // The transaction's captured instant, which IS the instant of the tick on
  // every rail. Never a second clock read.
  const at = Timestamp.fromMillis(nowMs)
  const validUntilMs = waiverValidUntilMs(nowMs, input.validityMonthsAtSigning)

  const event: WaiverAcceptanceEvent = {
    teamId: input.teamId,
    documentId: input.documentId,
    version: input.version,
    body_hash: input.bodyHash,
    kind: input.kind,
    contactId: input.contactId,
    identity_key: input.identityKey,
    signer_role: input.signerRole,
    signer_name: input.signerName,
    signer_email: input.signerEmail,
    signer_email_verified_by: input.signerEmailVerifiedBy,
    subject_name: input.subjectName,
    subject_email: input.subjectEmail,
    validity_months_at_signing: input.validityMonthsAtSigning,
    valid_until: validUntilMs == null ? null : Timestamp.fromMillis(validUntilMs),
    method: 'click_wrap',
    accepted_at: at,
    ip: input.ip,
    user_agent: input.userAgent,
    locale: normalizeWaiverLocale(input.locale),
    source: input.source,
    booking_ref: input.bookingRef ?? null,
    intent_id: input.intentId,
    revoked_by: input.revokedBy ?? null,
    revoked_reason: input.revokedReason ?? null,
    revokes_acceptance_id: input.revokesAcceptanceId ?? null,
    created_at: at,
  }

  return {
    acceptanceId,
    acceptanceRef,
    signerRef,
    event: acceptanceSnap.exists ? null : event,
    signer: nextSignerRow(current, event, acceptanceId, input),
  }
}

/**
 * The precedence rule, applied. Pure and exported so the round-trip
 * (accept → revoke → accept → require_resign publish → accept) can be asserted
 * without a Firestore emulator.
 *
 * Returns null when the row must be left alone.
 */
export function nextSignerRow(
  current: WaiverSignerState | null,
  event: WaiverAcceptanceEvent,
  acceptanceId: string,
  input: Pick<WaiverEventInput, 'teamId' | 'documentId' | 'contactId' | 'contactName' | 'contactEmail'>
): WaiverSignerState | null {
  const improves = waiverEventImprovesSigner(
    current && {
      accepted_version: current.accepted_version,
      accepted_at: current.accepted_at,
      valid_until: current.valid_until,
      status: current.status,
      revoked_at: current.revoked_at ?? null,
    },
    { kind: event.kind, version: event.version, accepted_at_ms: event.accepted_at.toMillis() }
  )
  if (!improves) return null

  if (event.kind === 'revoked') {
    // Nothing to revoke. The event row still records that a manager acted; the
    // gate already answers `none` for a contact with no row, so minting one here
    // would invent a signature-shaped object that never existed.
    if (!current) return null
    return {
      ...current,
      status: 'revoked',
      revoked_at: event.accepted_at,
      revoked_by: event.revoked_by ?? null,
      updated_at: event.accepted_at,
    }
  }

  return {
    teamId: input.teamId,
    documentId: input.documentId,
    contactId: input.contactId,
    accepted_version: event.version,
    accepted_at: event.accepted_at,
    valid_until: event.valid_until,
    acceptance_id: acceptanceId,
    // Absolute, from this transaction's own read set. Never FieldValue.increment.
    rounds: (current?.rounds ?? 0) + 1,
    signer_role: event.signer_role,
    signer_name: event.signer_name,
    signer_email: event.signer_email,
    signer_email_verified_by: event.signer_email_verified_by,
    status: 'active',
    // Cleared EXPLICITLY rather than by omission: this is a full-object write,
    // and a re-sign after a revocation must leave no trace of the revoked round
    // on the current-state row — the revocation stays legible in the events.
    revoked_at: null,
    revoked_by: null,
    // Carried forward. It has no writer in this phase (the notify outcome is
    // deferred), and carrying it is what keeps a full-object write from being a
    // reason to fold notice state onto this row later.
    latest_notice_id: current?.latest_notice_id ?? null,
    contact_name: input.contactName,
    contact_email: input.contactEmail,
    updated_at: event.accepted_at,
  }
}

/** THE WRITE PHASE. Every write is a no-op when the read phase said so. */
export function commitWaiverLedgerWrite(
  tx: FirebaseFirestore.Transaction,
  plan: WaiverLedgerPlan
): void {
  if (plan.event) tx.create(plan.acceptanceRef, plan.event)
  if (plan.signer) tx.set(plan.signerRef, plan.signer)
}

/**
 * The plural forms, so a rail that composes the ledger into its own commit
 * writes ONE line in its read phase and ONE in its write phase rather than a
 * loop it has to get right per rail. A team can require at most
 * MAX_REQUIRED_WAIVERS_PER_TEAM waivers, so the fan-out is bounded by the same
 * cap that bounds the gate's read cost.
 *
 * Sequential rather than `Promise.all`: a Firestore transaction's reads are
 * ordered against its own snapshot, and interleaving them buys nothing on
 * single-document gets while making a failure harder to attribute.
 */
export async function planWaiverLedgerWrites(
  tx: FirebaseFirestore.Transaction,
  inputs: WaiverEventInput[],
  nowMs: number
): Promise<WaiverLedgerPlan[]> {
  const plans: WaiverLedgerPlan[] = []
  for (const input of inputs) plans.push(await planWaiverLedgerWrite(tx, input, nowMs))
  return plans
}

export function commitWaiverLedgerWrites(
  tx: FirebaseFirestore.Transaction,
  plans: WaiverLedgerPlan[]
): void {
  for (const plan of plans) commitWaiverLedgerWrite(tx, plan)
}

/** The paid rails' plural entry point — one transaction per acceptance, before
 *  Stripe. See `recordWaiverEvent` for why it is a transaction and not a bare
 *  write. */
export async function recordWaiverEvents(
  inputs: WaiverEventInput[],
  nowMs: number
): Promise<void> {
  for (const input of inputs) await recordWaiverEvent(input, nowMs)
}

/**
 * The paid rails' entry point: the acceptance is written BEFORE Stripe, in its
 * OWN transaction, and is not conditional on payment. A signature is a fact
 * about a person — they read the text and ticked, and that is true whether or
 * not the card clears. The deliberate asymmetry with a promo reservation, which
 * guards a finite counter and must therefore be consumed only by a completed
 * sale, is the whole of "a waiver is not a scarce resource".
 *
 * It is a TRANSACTION and not a bare write, because Firestore's
 * optimistic-concurrency detection is the only thing standing between a
 * manager's revocation at 10:00:00 and an acceptance that read the row at
 * 09:59:59 landing at 10:00:01 and silently undoing it.
 */
export async function recordWaiverEvent(
  input: WaiverEventInput,
  /** The instant of the tick. Captured by the caller when it has one (the tick
   *  and the callable entry are the same moment on every rail); defaulted here
   *  so it is taken ONCE, outside the transaction, and survives a retry
   *  unchanged. */
  nowMs: number = Date.now()
): Promise<WaiverLedgerPlan> {
  return admin.firestore().runTransaction(async (tx) => {
    const plan = await planWaiverLedgerWrite(tx, input, nowMs)
    commitWaiverLedgerWrite(tx, plan)
    return plan
  })
}
