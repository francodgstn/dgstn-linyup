// The signup rail's consent, written as REAL ledger rows.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
// Before waivers, `completeSignup` wrote `Contact.consent = { privacyAcceptedAt,
// documents: [{slug, kind, version}] }`, the only client that filled it sent
// `version: ''` for every document, and the field was declared on no type, read
// by no code and rendered on no screen. Its own comment said the strings were
// "never used for authorization" — which was true, and left the studio with a
// consent record that recorded nothing. That blob is still written for one
// release, now marked deprecated on `Contact.consent`, beside the rows below.
//
// ── THIS RAIL RECORDS; IT NEVER REFUSES ─────────────────────────────────────
// Signup is not attendance. A required waiver binds at the first BOOKING, on the
// rails that put a person in a room, and gating account creation on one would be
// a new gate this design does not ask for. So the gate's decision is used here
// only to answer "is this tick worth recording", and a missing signature simply
// produces no row. `waivers/gate.ts`'s census is unaffected — nothing here books
// anything.
//
// ── WHAT IS TRUSTED, AND WHAT IS NOT ────────────────────────────────────────
// The client echoes WHICH documents it displayed and at WHICH version. Neither
// is trusted:
//   • the id must appear in the team's OWN configured signup list
//     (`resolveSignupDocumentIds`, the same helper the mirror is computed from),
//     so a caller cannot mint a signature against a document the studio never
//     attached;
//   • the version must resolve to an existing immutable snapshot, and the hash
//     recorded is that snapshot's own — never one the client sent.
// A document the client echoes with no version, or whose snapshot cannot be
// read, is SKIPPED rather than recorded against nothing: that is the known state
// of a document published before versioning existed and not yet covered by
// `scripts/backfill-document-versions.ts`, and inventing a row for it would be
// the `version: ''` defect in a new spelling.

import * as admin from 'firebase-admin'
import {
  DOCUMENTS_COLLECTION,
  DOCUMENT_VERSIONS_SUBCOLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_SETTINGS_SUBCOLLECTION,
  DOCUMENTS_SETTINGS_DOC_ID,
  contactIdentityKey,
  documentVersionId,
  resolveSignupDocumentIds,
  type DocumentVersion,
  type WaiverEmailVerification,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'
import { recordWaiverEvents, type WaiverEventInput } from './accept'
import {
  applicableWaivers,
  declarationFor,
  decideWaiverGate,
  loadSignerFacts,
  loadWaiverPolicy,
  parseWaiverSubmissions,
  resolveWaiverSubmissions,
} from './gate'

export interface SignupConsentInput {
  teamId: string
  contactId: string
  contactName: string
  contactEmail: string | null
  /** What the form says it showed: `{ documentId, version }` per consent link. */
  echoed: Array<{ documentId: string; version: number }>
  /** A required waiver's own tick, in the standard payload shape. */
  waiverAcceptances: unknown
  /**
   * How the signer's address was established on THIS path, decided by the
   * caller because only it knows which door was used:
   *   'verified_code' — the OTP path. `verification_codes.email` is the address
   *                     the code was actually mailed to, so control of that
   *                     specific mailbox was shown minutes ago.
   *   'session'       — a live contact session, which identifies the CONTACT and
   *                     not the person at the keyboard (`login_emails` is an
   *                     access grant and identifies nobody).
   */
  signerEmailVerifiedBy: Extract<WaiverEmailVerification, 'verified_code' | 'session'>
  /** The address that was actually proven, which on the OTP path is the code's
   *  and NOT, in general, the contact's own. */
  signerEmail: string
  ip: string | null
  userAgent: string | null
  locale: string | null
}

/** The team's configured signup documents, read from the same place the public
 *  mirror is computed from — never from the client's echo. */
async function configuredSignupDocumentIds(teamId: string): Promise<Set<string>> {
  const db = admin.firestore()
  const [settingsSnap, legacySnap] = await Promise.all([
    db
      .doc(`${TEAMS_COLLECTION}/${teamId}/${TEAM_SETTINGS_SUBCOLLECTION}/${DOCUMENTS_SETTINGS_DOC_ID}`)
      .get(),
    db.doc(`${TEAMS_COLLECTION}/${teamId}/${INSTALLED_PLUGINS_SUBCOLLECTION}/documents`).get(),
  ])
  return new Set(
    resolveSignupDocumentIds({
      settings: settingsSnap.data() as { signupDocumentIds?: string[] } | undefined,
      legacyPluginConfig: legacySnap.data()?.config as { signupDocumentIds?: unknown } | undefined,
    })
  )
}

/**
 * Writes one acceptance event per consent document the visitor was shown, plus
 * one per required waiver they ticked.
 *
 * Returns how many rows were written. Throws only on a genuine write failure —
 * a document that cannot be pinned to a version is skipped, not fatal, because
 * that state is known and named and blocking every signup for the team over it
 * would be worse than the missing row.
 */
export async function recordSignupConsent(input: SignupConsentInput): Promise<number> {
  const nowMs = Date.now()
  const identityKey = contactIdentityKey(
    { email: input.contactEmail, contactId: input.contactId },
    sha256Hex
  )
  const events: WaiverEventInput[] = []

  const base = {
    teamId: input.teamId,
    contactId: input.contactId,
    identityKey,
    kind: 'accepted' as const,
    signerRole: 'self' as const,
    signerName: input.contactName,
    signerEmail: input.signerEmail,
    signerEmailVerifiedBy: input.signerEmailVerifiedBy,
    subjectName: input.contactName,
    subjectEmail: input.contactEmail,
    ip: input.ip,
    userAgent: input.userAgent,
    locale: input.locale,
    source: 'signup' as const,
    contactName: input.contactName,
    contactEmail: input.contactEmail,
  }

  // ── The consent-checkbox documents (terms, privacy, regulations) ───────────
  const configured = await configuredSignupDocumentIds(input.teamId)
  const echoed = input.echoed.filter((e) => configured.has(e.documentId))
  const db = admin.firestore()
  for (const item of echoed) {
    const snap = await db
      .collection(DOCUMENTS_COLLECTION)
      .doc(item.documentId)
      .collection(DOCUMENT_VERSIONS_SUBCOLLECTION)
      .doc(documentVersionId(item.version))
      .get()
    if (!snap.exists) continue
    const version = snap.data() as DocumentVersion
    events.push({
      ...base,
      documentId: item.documentId,
      version: item.version,
      // The SNAPSHOT's own hash. The client never supplies one here — it has no
      // reason to know it, and accepting one would let a caller pin a signature
      // to text of their choosing.
      bodyHash: version.bodyHash,
      // Deterministic per (contact, document, version), so a retried signup —
      // which `completeSignup`'s resolve-or-create makes an ordinary occurrence
      // — writes ONE row rather than a second signature for the same tick.
      intentId: `signup_${input.contactId}`,
      // A terms or privacy document carries no WaiverConfig, so no lapse rule
      // is in force. `null` says exactly that, and is what the predicate reads.
      validityMonthsAtSigning: null,
    })
  }

  // ── A required waiver shown as its own step on this rail ───────────────────
  const submissions = parseWaiverSubmissions(input.waiverAcceptances)
  if (submissions.length > 0) {
    const applicable = applicableWaivers(await loadWaiverPolicy(input.teamId), null)
    if (applicable.length > 0) {
      const [signers, resolved] = await Promise.all([
        loadSignerFacts(applicable, input.contactId),
        resolveWaiverSubmissions(applicable, submissions),
      ])
      const steps = decideWaiverGate({
        applicable,
        signers,
        submissions: resolved,
        nowMs,
      })
      for (const step of steps) {
        if (step.outcome !== 'record') continue
        // The self-declaration, honored only for a waiver the studio flagged
        // `mayIncludeMinors` — one helper, so this rail cannot record a claim
        // its own step never showed.
        const declaration = declarationFor(step.entry, step.submission)
        events.push({
          ...base,
          documentId: step.entry.documentId,
          version: step.submission.version,
          bodyHash: step.submission.bodyHash,
          intentId: step.submission.intentId,
          signerRole: declaration.signingAsGuardian ? 'guardian' : 'self',
          signerName: declaration.guardianName || input.contactName,
          validityMonthsAtSigning: step.entry.validityMonths,
        })
      }
    }
  }

  if (events.length === 0) return 0
  await recordWaiverEvents(events, nowMs)
  return events.length
}
