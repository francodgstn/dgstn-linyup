// Waivers (Wave 3 Phase 4) — the PURE half: the vocabulary, the caps, the key
// derivations and the predicates. Browser-safe (no crypto, no Firestore, no
// firebase-admin): every hasher is INJECTED, exactly as promoCode.ts injects
// `Sha256Hex`. The impure half lives in packages/functions/src/waivers/.
//
// ── THE GOVERNING RULE ──────────────────────────────────────────────────────
// A signature is a FACT ABOUT A PERSON, not a claim on a scarce resource.
// Nothing here is reserved, held, released or restored. The promo phase's
// reserve → commit → release apparatus has no analogue in this file, and
// reaching for it is the single biggest way this area goes wrong.
//
// ── THE LEDGER'S TWO HALVES ─────────────────────────────────────────────────
// APPEND-ONLY EVENT ROWS (`WaiverAcceptanceEvent`) hold the immutable facts;
// ONE MUTABLE CURRENT-STATE ROW per (document, contact) (`WaiverSignerState`)
// holds the answer the gate asks. Re-signing, expiry and revocation are states
// of the second, never edits to the first — the discipline
// packages/shared/src/types/finance.ts already states for the journal ("errors
// are fixed by new rows, never edits").
//
// That split is what dissolves the deadlock the earlier design hit: one
// document per acceptance at a deterministic id derived from the RELATIONSHIP
// (contact, document, version) plus `.create()` made re-signing, expiry and
// revocation all inexpressible, because each of them produces the same id
// again. The event id here contains the event's own NONCE (`intentId`), so a
// second genuine signing is a second row rather than a collision, while a
// double-submit of ONE tick still collapses to one row.
import type { Timestamp } from './common'
import type { DocumentKind } from './document'
import type { SaasPlan } from './team'
import { contactIdentityKey, type Sha256Hex } from '../utils/identity'

// ─── Configuration (the studio's authored settings) ──────────────────────────

/**
 * Where a waiver is required. ONE axis, on the WAIVER — not a flag on the
 * Activity — so "which waivers does this booking need" is one filter over one
 * list, and a studio manages waivers in one place.
 *
 * There is deliberately no arm that can name an EVENT: an Event is a different
 * primitive (no Session, no Activity), and event attendance is exempted with
 * that reason stated rather than silently uncovered. See docs/waivers.md.
 */
export type WaiverApplies =
  | { appliesTo: 'all_bookings' }
  | { appliesTo: 'activities'; activityIds: string[] }

export interface WaiverConfig {
  /**
   * "Participants may be minors." OFF by default.
   *
   * IT IS A PROMPT, NOT AN ENFORCEMENT, and the distinction is the whole design.
   * The studio is the party with the legal exposure and the only party who can
   * actually verify a participant's age — they see the child at the door. The
   * product's job is to make that check easy and PROMPTED, not to simulate an
   * enforcement it cannot deliver.
   *
   * Two things follow from it, and nothing else does:
   *   • the consent step shows a second required choice — "I am the participant"
   *     vs "I am signing as a parent or guardian", with an optional name;
   *   • every booking taken against this waiver carries a chip on the roster and
   *     the printed manifest, so the studio checks at the door.
   *
   * What it deliberately does NOT do: ask for a date of birth, compute an age,
   * email anybody, or refuse a booking. An earlier design did all four (an
   * emailed guardian link bound to a mailbox) and was removed: an emailed link
   * proves control of a mailbox, not parenthood — a teenager with a parent's
   * phone defeats it — so it bought evidence barely stronger than a checkbox at
   * the price of a public mail-sending abuse surface.
   */
  mayIncludeMinors?: boolean
  /**
   * Absent/null = a signature never lapses. Set, and an acceptance expires this
   * many months after it was given.
   *
   * IT GOVERNS FUTURE SIGNATURES ONLY. The value in force at the tick is FROZEN
   * onto the acceptance event and copied to the signer row
   * (`validity_months_at_signing`, `valid_until`), exactly as `DocumentVersion`
   * freezes `mayIncludeMinors`. Editing this number must never retroactively
   * re-date what a past signature was worth: that would refuse a whole
   * population with a valid acceptance, a matching hash, no revocation and no
   * publish event to explain it. Re-dating EXISTING signatures, if it is ever
   * wanted, has to be a publish outcome with its own version — never a field
   * edit.
   *
   * Expiry is LAZY: computed by `waiverAcceptanceState`, never swept.
   */
  validityMonths?: number | null
  scope: WaiverApplies
  /**
   * Off by default. A waiver can be authored, published and previewed without
   * blocking a single booking; flipping this on is the moment it becomes a
   * gate. This is what lets the whole feature ship dark.
   *
   * Written ONLY by `setWaiverRequirement`, which writes the team's waiver
   * policy in the same transaction. Nothing else may write it — a second writer
   * is how the policy and the documents stop agreeing.
   */
  required: boolean
}

// ─── The published version snapshot ──────────────────────────────────────────

/**
 * What a publish DOES, per outcome:
 *
 *   silent         → version created, `min_valid_version` unchanged, no signer
 *                    rows touched, nobody told.
 *   require_resign → version created, `min_valid_version` ← N, no signer rows
 *                    touched. Supersession is DERIVED from that one number by
 *                    `waiverAcceptanceState`, so the publish is O(1) rather
 *                    than O(signers) and is correct at every instant.
 *
 * `notify` — a third outcome that mails every signer and records per-recipient
 * deliverability — is DEFERRED to v2 (Franco's D1, 2026-08-15) and is therefore
 * absent from this union. Adding it back is additive: a new member here, a
 * writer for the `notices` subcollection that already exists in the model, and
 * a report. No stored row changes shape.
 */
export type PublishOutcome = 'silent' | 'require_resign'

/**
 * ONE published snapshot. `documents/{documentId}/versions/{versionId}`, where
 * `versionId === documentVersionId(version)` so a plain orderBy(documentId())
 * lists them in order with no index.
 *
 * IMMUTABLE: written once by `publishDocumentVersion` with `.create()`,
 * `allow write: if false` in firestore.rules, and never updated — not even to
 * correct a typo. A typo is a new version.
 *
 * THREE INVARIANTS DEPEND ON THAT, and the export's storage decision rests on
 * all three: an acceptance stores only the HASH of the text, the one copy of
 * the text lives here, and the export materializes it. If any of these is ever
 * relaxed, that decision must be revisited in the same change.
 *   • a version document is never updated (this docblock, and the rules);
 *   • a published document can never be deleted (firestore.rules);
 *   • a waiver document is callable-only (firestore.rules).
 */
export interface DocumentVersion {
  teamId: string
  documentId: string
  version: number
  kind: DocumentKind
  title: string
  /**
   * The exact SANITIZED HTML that was, and forever will be, version N.
   * Sanitized at PUBLISH and never again on this value: the public mirror reads
   * this frozen string rather than re-sanitizing the raw body, so the text a
   * signer read and the text stored as version N are the same string. Two
   * sanitize calls with a library upgrade between them would silently break
   * every hash. (The mirror does keep one `sanitizeRichHtml` call, for a
   * document published before versioning existed and so carrying no version to
   * copy from — a state `scripts/backfill-document-versions.ts` exists to empty
   * and `scripts/verify-waiver-ledger.ts` exists to keep empty. It never touches
   * a version's bytes.)
   */
  bodyHtml: string
  /** sha256 of `bodyHtml`. THE fingerprint an acceptance pins. */
  bodyHash: string
  bodyChars: number
  /** `external_link` documents snapshot the URL instead. Whatever is at that
   *  URL can change freely — the docs say so plainly rather than implying the
   *  snapshot covers it. */
  externalUrl?: string | null
  /** The minors flag in force AT PUBLISH. A later config change does not
   *  rewrite what a past signature was taken under. */
  mayIncludeMinors?: boolean | null
  publish_outcome: PublishOutcome
  supersedes: number | null
  published_at: Timestamp
  published_by: string
  /** Snapshot, so it survives a rename — GiftCard.issued_by_name's rule. */
  published_by_name: string
  /**
   * Set ONLY by `scripts/backfill-document-versions.ts`, which mints v1 for a
   * document that was already published before versioning existed. The export
   * must be able to say that a v1 snapshot was taken RETROACTIVELY: somebody
   * who signed a terms document in 2025 signed text that was captured in 2026,
   * and printing that as an ordinary publish would assert more than happened.
   */
  backfilled_at?: Timestamp | null
}

/** `documents/{d}/versions/{versionId}` — zero-padded so a plain
 *  orderBy(documentId()) is chronological with no index and no field. */
export function documentVersionId(version: number): string {
  return `v${String(version).padStart(4, '0')}`
}

// ─── The acceptance ledger: append-only EVENT rows ───────────────────────────

export type WaiverAcceptanceSource =
  | 'booking'
  | 'drop_in'
  | 'appointment'
  | 'appointment_checkout'
  | 'waitlist_claim'
  | 'signup'
  | 'space'
  /** RETIRED. The emailed-guardian rail is gone and nothing writes this; it
   *  stays in the union because rows taken before the removal carry it and the
   *  export must be able to name where they came from. */
  | 'guardian_link'
  | 'kiosk'
  | 'admin'

/**
 * APPEND-ONLY. `documents/{d}/acceptances/{acceptanceId}`. Never updated, never
 * deleted — `allow write: if false`, and no callable writes twice to one id.
 *
 * IDEMPOTENCY, AND THE TRAP. `recordFinanceTransaction`'s idiom (`.create()`,
 * catch gRPC 6, return false) works ONLY because that helper is a standalone
 * write OUTSIDE any transaction, so the error is catchable at the call site.
 * Inside a booking commit transaction a `tx.create()` collision does not throw
 * at the call: it fails the WHOLE commit as a precondition violation, is not
 * catch-and-continue-able, and takes the seat with it. So every rail `tx.get`s
 * the acceptance ref in the transaction's READ phase and SKIPS the create when
 * it exists. See packages/functions/src/waivers/accept.ts, which owns that
 * shape; do not follow the journal citation here, because an implementer who
 * does will write the uncatchable version.
 */
export interface WaiverAcceptanceEvent {
  teamId: string
  documentId: string
  /** The version the signer ACTUALLY READ — not necessarily the current one.
   *  Validity is decided against the document's floor, later and elsewhere. */
  version: number
  /** sha256 of the exact `bodyHtml`. Pins the text independently of the version
   *  document; a mismatch at export time is reported, not hidden. */
  body_hash: string
  kind: WaiverEventKind

  contactId: string
  /**
   * `contactIdentityKey` of the normalized email at signing time. Survives the
   * contact document being purged and recreated, and lets the export find a
   * person's history when their contact id changed.
   *
   * IT IS NOT THE KEY OF ANYTHING. The signer row is keyed on `contactId` by
   * design: an identity key is `sha256(normalised email)` and is not
   * unforgeable, so a shared family mailbox gives a mother and her child the
   * SAME key — harmless for a redemption cap, catastrophic for a waiver, where
   * it would merge a child's row with their parent's.
   */
  identity_key: string

  /**
   * WHO SAID THEY WERE TICKING — and it is A SELF-DECLARATION. Nothing verifies
   * it, nothing can: the person at the keyboard chose `guardian` from two
   * radios on the consent step, and the studio is the only party that can check
   * the claim, at the door, which is what the roster chip exists to prompt.
   *
   * Never describe a `guardian` row as verified consent, in copy, in the export
   * or in a report. `'self'` on a waiver flagged `mayIncludeMinors` is equally
   * unverified and gets its own chip for the same reason.
   */
  signer_role: WaiverSignerRole
  /** The name given FOR THE SIGNER. The subject's own on a `self` row; on a
   *  `guardian` row the guardian's name when they gave one, and otherwise the
   *  name the booking was made under — `signer_role` is what carries the
   *  distinction, and it is a self-declaration either way. */
  signer_name: string
  /** The address that actually identifies the signer on THIS path — not, in
   *  general, the contact's own. */
  signer_email: string
  /** How that address was established. `emailed_link` and `verified_code` both
   *  mean the signer demonstrably controlled THAT mailbox; `session` means only
   *  that a contact session was open, which identifies the CONTACT and not the
   *  person at the keyboard; `none` means the address was merely typed. */
  signer_email_verified_by: WaiverEmailVerification

  /** WHO the release is about — snapshotted, so removing anything later never
   *  rewrites history. */
  subject_name: string
  subject_email: string | null

  /** The validity rule IN FORCE AT THE TICK, frozen for the same reason
   *  `DocumentVersion` freezes `mayIncludeMinors`. null = never lapses. */
  validity_months_at_signing: number | null
  /** Derived once, here, so expiry is a COMPARISON rather than arithmetic over
   *  a number that may since have moved. null when the above is null. */
  valid_until: Timestamp | null

  method: 'click_wrap'
  /** Server time, never client time. */
  accepted_at: Timestamp
  ip: string | null
  user_agent: string | null
  /** Which language the text was read in — a four-locale product cannot claim
   *  informed consent without recording which rendering was shown. */
  locale: string | null
  source: WaiverAcceptanceSource
  booking_ref?: { sessionId: string; bookingId: string } | null
  /** The nonce that makes a double-submit idempotent. */
  intent_id: string
  /** `kind: 'revoked'` only. */
  revoked_by?: string | null
  revoked_reason?: string | null
  revokes_acceptance_id?: string | null
  created_at: Timestamp
}

export type WaiverEventKind = 'accepted' | 'revoked'

/** What the signer DECLARED they were. See `WaiverAcceptanceEvent.signer_role`:
 *  a self-declaration, and never treated as anything more. */
export type WaiverSignerRole = 'self' | 'guardian'

/**
 * How the signer's address was established.
 *
 * `emailed_link` HAS NO WRITER any more — it was the emailed-guardian path's
 * value, and that path was removed. It stays in the union because rows written
 * before the removal carry it and the signers tab renders its copy; deleting it
 * would make a stored value unreadable. Nothing new is ever stamped with it.
 */
export type WaiverEmailVerification = 'session' | 'verified_code' | 'emailed_link' | 'none'

// ─── The acceptance ledger: the ONE mutable current-state row ────────────────

/**
 * THE current-state row. `documents/{d}/signers/{contactId}`.
 *
 * Mutable, with exactly ONE writer: packages/functions/src/waivers/accept.ts.
 * The revoke path does not write it either — it calls the same helper with a
 * `kind: 'revoked'` event, which is what keeps `rounds` single-writer. ALWAYS
 * inside a transaction, and CONDITIONALLY, under `waiverSignerTransition`'s
 * precedence rule. Never an unconditional `.set()`.
 *
 * Deliberately does NOT store `superseded` or `expired`: both are DERIVED by
 * `waiverAcceptanceState`, so a `require_resign` publish writes zero signer
 * rows and there is no stored value that can disagree with the computed one.
 */
export interface WaiverSignerState {
  teamId: string
  documentId: string
  contactId: string

  accepted_version: number
  accepted_at: Timestamp
  /** Copied from the winning acceptance event. Expiry is a comparison against
   *  this instant, never arithmetic over the live config. */
  valid_until: Timestamp | null
  /** The event row that established the current state. */
  acceptance_id: string
  /** Absolute, computed from the writing transaction's own read set. Never
   *  FieldValue.increment — the same rule `bookings_count` and `usage_count`
   *  carry. Bumped by an applied `accepted` event and by nothing else. */
  rounds: number

  signer_role: WaiverSignerRole
  signer_name: string
  signer_email: string
  signer_email_verified_by: WaiverEmailVerification

  /** The ONLY stored lifecycle state. Everything else is derived. */
  status: 'active' | 'revoked'
  revoked_at?: Timestamp | null
  revoked_by?: string | null

  /**
   * Pointer to the newest `notices/{noticeId}` row, for a live view ONLY. It is
   * a cache, it is overwritten freely, and NOTHING evidential reads it.
   *
   * IT HAS NO WRITER IN THIS PHASE (`notify` is deferred — see PublishOutcome).
   * It is declared, and carried forward across every signer-row write, so that
   * adding `notify` in v2 is an ADDITION rather than a migration.
   */
  latest_notice_id?: string | null

  /** Denormalised for the roster and the report; never read for a decision. */
  contact_name: string
  contact_email: string | null
  updated_at: Timestamp
}

// ─── The notice layer: declared, append-only, WITH NO WRITER YET ─────────────

/**
 * ⚠ THIS SUBCOLLECTION HAS NO WRITER IN THIS PHASE, AND THAT IS DELIBERATE.
 *
 * `notify` — the publish outcome that mails every signer and records
 * per-recipient deliverability — is deferred to v2 (Franco's D1, 2026-08-15).
 * Everything that exists only to SERVE notify left this phase: the job queue,
 * the fan-out worker, the mail-ledger linkage and the deliverability report.
 * The MODEL stayed, because removing it would make notify a MIGRATION later
 * rather than an addition.
 *
 * So: do not "simplify away" this type, `WaiverNoticeDelivery`,
 * `waiverNoticeKey` or `WaiverSignerState.latest_notice_id` on the grounds that
 * nothing writes them. The property they buy is that NO notice state is ever
 * stored as a field on the signer row — a resend is a new ROW at attempt + 1,
 * and a later publish therefore cannot erase an earlier version's record. A
 * design that folded notice state onto the signer row would have to be undone,
 * with data, before notify could ship.
 *
 * APPEND-ONLY. `documents/{d}/notices/{noticeId}`, where
 * `noticeId === waiverNoticeKey(...)` — the SAME string as the `mail_sends`
 * document id, which is what will let a report read delivery state by direct
 * `get` with no query and no linkage.
 */
export interface WaiverNoticeRow {
  teamId: string
  documentId: string
  version: number
  contactId: string
  attempt: number
  /** The address it was addressed to, snapshotted — because `MailSendRecord`
   *  has no recipient field and a contact's email may change. */
  email: string | null
  provider_message_id?: string | null
  state: WaiverNoticeDelivery
  /** The raw provider event that last moved `state`. Kept because a soft and a
   *  hard bounce mean very different things to a studio. */
  last_event?: string | null
  /** From an EXPLICIT suppression check, never inferred from a missing ledger
   *  row: the mail service writes no row at all for an already-suppressed
   *  recipient, so "no row" must never have to be interpreted. */
  suppressed_at_send: boolean
  created_at: Timestamp
  sent_at?: Timestamp | null
  resolved_at?: Timestamp | null
}

export type WaiverNoticeDelivery =
  | 'not_attempted'
  | 'no_address'
  | 'suppressed'
  | 'blocked_by_policy'
  /** A fact about the ENVIRONMENT (the mail kill switch), never about the
   *  member — it must never be filed beside a hard bounce. */
  | 'not_sent_env'
  | 'sent'
  | 'delivered'
  /** A soft bounce. Transient, and NOT evidence of non-delivery. */
  | 'deferred'
  | 'bounced'
  | 'spam'
  | 'failed'

/**
 * Keyed on the EVENT, not on the relationship — the lesson the waitlist's
 * notifier records, where a `{session}-{contact}` key silently deduped a second
 * round's mail and handed someone a held seat nobody told them about. The
 * `attempt` suffix is what will make a Resend action actually send.
 */
export function waiverNoticeKey(
  documentId: string,
  version: number,
  contactId: string,
  attempt: number
): string {
  const suffix = attempt > 1 ? `-r${attempt}` : ''
  return `waiver-notice-${documentId}-v${version}-${contactId}${suffix}`
}

// ─── The authorization source, and its display mirror ────────────────────────

/**
 * `teams/{teamId}/waiver_policy/current` — SERVER-WRITTEN, client-unwritable.
 * THE authoritative answer to "what does a booking here require".
 *
 * It exists because the display mirror FAILS OPEN. `signup_documents` skips any
 * id whose public summary is missing and writes the array anyway — correct for
 * a list of consent links, catastrophic for an authorization gate, where
 * "silently skipped" becomes "the required waiver vanished and the booking went
 * through". So authorization reads THIS document, which fails CLOSED; the
 * public mirror stays a display list.
 *
 * ONE WRITE PATH, and its owner is `writePolicyAndTouchTeam` in
 * `packages/functions/src/waivers/publish.ts` — the single `tx.set` on this
 * document. Its callers are enumerated THERE and nowhere else; this docblock
 * used to list them and the list was wrong within the same phase. Each caller
 * reads this document INSIDE its own transaction, patches or removes EXACTLY the
 * one entry for the document it is writing, and writes the array back — never a
 * rebuild from a query, which would need a composite index that does not exist
 * and would let two managers publishing within the same second drop each other's
 * entry with the policy left internally consistent.
 */
export interface TeamWaiverPolicy {
  teamId: string
  /** Capped at MAX_REQUIRED_WAIVERS_PER_TEAM so the gate's read cost is bounded
   *  and STATED, rather than growing with a studio's document count. */
  required: RequiredWaiverEntry[]
  updated_at: Timestamp
}

export interface RequiredWaiverEntry {
  documentId: string
  slug: string
  title: string
  current_version: number
  min_valid_version: number
  body_hash: string
  /**
   * The studio's "participants may be minors" flag, denormalised so the gate and
   * the consent step read it without a document `get`.
   *
   * IT IS A STORED FIELD ON `teams/{t}/waiver_policy/current`, written by
   * `waiverPolicyEntryFor` and read back by `scripts/verify-waiver-ledger.ts`.
   * The writers and the verifier share that one derivation precisely so a change
   * to this shape cannot make the checker report drift on every team.
   */
  mayIncludeMinors: boolean
  validityMonths: number | null
  scope: WaiverApplies
}

/**
 * The world-readable SUMMARY of a required waiver — id, slug, title, version,
 * minors flag. NEVER the body: `TeamPublicProfile` is served by an
 * unauthenticated collection-group read, so anything put here is world-readable
 * and enumerable by anyone. The text arrives with the callable the consent step
 * calls anyway.
 *
 * It is a RENDERING HINT and never a decision: the client calls the requirement
 * callable if and only if this list is non-empty, so a tenant with no waiver
 * pays zero extra round-trips, and a briefly-stale empty list degrades to a
 * server refusal the surface can act on rather than to a compliance hole.
 */
export interface PublicRequiredWaiver {
  documentId: string
  slug: string
  title: string
  version: number
  /**
   * DENORMALISED, and the mirror is only rewritten when the team is touched — so
   * a client reading a stale `false` here simply renders one fewer optional
   * question until the next sync. It is a rendering hint like every other field
   * on this type; the CHIP and the recorded declaration both come from the
   * server-written policy, which is never stale in that way.
   */
  mayIncludeMinors: boolean
}

// ─── THE predicate ───────────────────────────────────────────────────────────

export type WaiverAcceptanceState =
  | 'none'
  | 'valid'
  /** Signed below the document's floor — a `require_resign` publish moved it. */
  | 'superseded'
  | 'expired'
  | 'revoked'

/** The subset of the signer row the predicate reads. Nothing else about a
 *  signer is allowed to influence validity. */
export type WaiverSignerFacts = Pick<
  WaiverSignerState,
  'accepted_version' | 'accepted_at' | 'valid_until' | 'status'
>

/** What the PRECEDENCE rule reads: the validity facts plus the revocation
 *  instant, which the validity predicate deliberately does not need. */
export type WaiverSignerOrderingFacts = WaiverSignerFacts &
  Pick<WaiverSignerState, 'revoked_at'>

/**
 * THE only expression of "does this person's signature count". Every surface
 * that answers that question calls THIS — server and client, studio-side and
 * public — and none reimplements it; the surfaces that merely *display* a state
 * (the Space card, the chip) receive one computed here rather than deriving
 * their own. Deliberately not enumerated: a list of call sites in a docblock
 * rots, and this one had rotted already. `grep -rn 'waiverAcceptanceState('` is
 * the census, and it is one line.
 *
 * The checkable half: `waiverValidUntilMs` is called only where a `valid_until`
 * is WRITTEN (`waivers/accept.ts`, and the seed fixture that reproduces its
 * rows), never where one is judged — and no code outside this function compares
 * a signer's
 * `accepted_version` against a document's `min_valid_version`. What DOES compare
 * versions elsewhere — `decideWaiverGate` on a submitted tick — answers "may
 * this be recorded", which is a question about a payload and not about a signer
 * row.
 *
 * The decision ORDER is fixed here so the states can never be argued about
 * independently. Revocation outranks supersession because a revoked signature
 * must never be reported as merely stale, and outranks expiry for the same
 * reason.
 *
 * Note what it does NOT take: the live `validityMonths`. Expiry is a comparison
 * against `valid_until`, an instant frozen onto the signature at the tick — see
 * `WaiverConfig.validityMonths` for why reading the live number instead would
 * let one field edit retroactively re-date a studio's whole population.
 */
export function waiverAcceptanceState(
  waiver: { min_valid_version: number },
  signer: WaiverSignerFacts | null,
  nowMs: number
): WaiverAcceptanceState {
  if (!signer) return 'none'
  if (signer.status === 'revoked') return 'revoked'
  if (signer.accepted_version < waiver.min_valid_version) return 'superseded'
  if (signer.valid_until && signer.valid_until.toMillis() <= nowMs) return 'expired'
  return 'valid'
}

/** Only `valid` satisfies the gate. Stated as a function so no call site has to
 *  re-derive which of the five states passes. */
export function waiverStateSatisfiesGate(state: WaiverAcceptanceState): boolean {
  return state === 'valid'
}

// ─── The precedence rule ─────────────────────────────────────────────────────

/** The facts about an incoming event that decide whether it improves the row. */
export interface WaiverEventFacts {
  kind: WaiverEventKind
  version: number
  /** Server time of the event, in millis. */
  accepted_at_ms: number
}

/**
 * Does this event STRICTLY IMPROVE the current-state row?
 *
 * THE EVENT ROW IS ALWAYS CREATED — it is a fact, and facts are recorded. The
 * SIGNER ROW is updated only when this returns true. Two ordinary sequences
 * make the difference load-bearing, and both silently destroyed a stronger
 * signature under an unconditional `.set()`:
 *
 *  • A member signs v5 in Space at 10:00 after a `require_resign` publish, then
 *    a booking submitted from a tab opened at 09:00 lands at 10:05 still
 *    carrying v4. Without this rule the row falls back to v4 and the member is
 *    `superseded` — blocked at their next booking by a signature that was valid
 *    five minutes earlier.
 *  • A manager revokes at 10:00:00 while an acceptance that read the row at
 *    09:59:59 lands at 10:00:01 and silently undoes the revocation.
 *
 * `revoked` ALWAYS applies: it is a deliberate act at the current instant, and
 * a revocation that could be out-ordered is not a revocation.
 *
 * The comparison must be made against a row RE-READ INSIDE THE SAME TRANSACTION
 * that writes. A signer write outside a transaction is a bug, not an
 * optimization — Firestore's optimistic-concurrency detection is the only thing
 * standing between these two sequences and a lost update.
 */
export function waiverEventImprovesSigner(
  current: WaiverSignerOrderingFacts | null,
  event: WaiverEventFacts
): boolean {
  if (event.kind === 'revoked') return true
  if (!current) return true
  // `?? 0` — the revoke writer always stamps `revoked_at` beside `status`, so a
  // revoked row without an instant is corruption rather than a case; the ledger
  // verifier is where that is caught, not here.
  const revokedAtMs = current.revoked_at ? current.revoked_at.toMillis() : 0
  if (event.accepted_at_ms <= revokedAtMs) return false
  if (event.version > current.accepted_version) return true
  return (
    event.version === current.accepted_version &&
    event.accepted_at_ms > current.accepted_at.toMillis()
  )
}

// ─── Derived keys ────────────────────────────────────────────────────────────

/**
 * The acceptance EVENT's document id.
 *
 * `intentId` is the whole trick. A relationship-only id — (document, version,
 * contact) — is what deadlocked the earlier design: re-signing after a
 * revocation, renewing after an expiry and re-signing after a `require_resign`
 * publish all produce the same id, `.create()` refuses, and a `.set()` would
 * rewrite the original timestamp, IP and text hash. Adding the event's own
 * nonce makes a second genuine signing a second row, while a double-submit of
 * ONE tick (same nonce) still collapses to one row.
 *
 * The nonce is minted by the requirement callable and echoed back with the
 * tick. It is NOT a credential: forging one only affects whether a duplicate
 * row is created,
 * which is self-harm. It is deliberately not persisted — no intent collection,
 * no TTL, no sweep.
 *
 * The components are all id-shaped (Firestore auto-ids, a decimal version and a
 * hex nonce), so the plain join is unambiguous.
 */
export function waiverAcceptanceId(
  input: { documentId: string; version: number; contactId: string; intentId: string },
  sha256Hex: Sha256Hex
): string {
  const material = [input.documentId, String(input.version), input.contactId, input.intentId].join(
    ':'
  )
  return `a_${sha256Hex(material).slice(0, 32)}`
}

/** Re-exported so a waiver call site never has to know the helper lives beside
 *  the promo one. There is exactly ONE definition of "the same person" — see
 *  packages/shared/src/utils/identity.ts. */
export { contactIdentityKey }

// ─── Validity arithmetic ─────────────────────────────────────────────────────

/**
 * `accepted_at + N months`, in millis, computed ONCE at the tick and stored.
 * UTC, with end-of-month clamping (31 Jan + 1 month = 28/29 Feb) so a signature
 * taken on the 31st never silently rolls into the following month.
 *
 * Returns null when `months` is null — a signature that never lapses.
 */
export function waiverValidUntilMs(acceptedAtMs: number, months: number | null): number | null {
  if (months == null) return null
  const d = new Date(acceptedAtMs)
  const targetMonth = d.getUTCMonth() + months
  const clamped = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      targetMonth + 1,
      0,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds()
    )
  )
  const lastDayOfTargetMonth = clamped.getUTCDate()
  return Date.UTC(
    d.getUTCFullYear(),
    targetMonth,
    Math.min(d.getUTCDate(), lastDayOfTargetMonth),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds()
  )
}

// ─── Caps and constants ──────────────────────────────────────────────────────

/** Waiver CREATION requires this tier. Gates control creation and REQUIRING,
 *  never retiring: an in-flight requirement survives a downgrade, and a
 *  downgraded studio can always turn a requirement off, edit settings and
 *  archive. */
export const WAIVER_MIN_PLAN: SaasPlan = 'studio'

/** Zero on free/coach is the same statement as `WAIVER_MIN_PLAN`, expressed as
 *  data so the client can render "0 of 5" without a second rule. */
export const WAIVER_LIMITS: Record<SaasPlan, { maxWaivers: number }> = {
  free: { maxWaivers: 0 },
  coach: { maxWaivers: 0 },
  studio: { maxWaivers: 5 },
  organization: { maxWaivers: 20 },
}

export function getWaiverLimits(plan: SaasPlan | null): { maxWaivers: number } {
  return WAIVER_LIMITS[plan ?? 'free']
}

/** Bounds the GATE's read cost, independently of how many waivers exist: one
 *  policy `get` plus at most this many signer `get`s. */
export const MAX_REQUIRED_WAIVERS_PER_TEAM = 3

/** Bounds a document's version subcollection. A studio that hits this is
 *  republishing in a loop and should hear about it. */
export const MAX_DOCUMENT_VERSIONS = 200

/**
 * THE one definition of the body clamp. It was duplicated between the public
 * mirror sync and the web editor's limits, and a drift between them would
 * freeze a truncation the editor never showed — the version snapshot is taken
 * at this clamp. Both former sites now delegate here.
 */
export const MAX_WAIVER_BODY_CHARS = 50000

/**
 * The cap on any NAME a caller puts on a waiver record — today, the optional
 * guardian name on the consent step's self-declaration.
 *
 * It is a cap on a PUBLIC entry point, not a form-validation nicety. That name
 * is supplied by an unauthenticated visitor, is stored on a legal record, and is
 * rendered back into the consent export a studio hands a lawyer; a name field
 * with no ceiling is a way to put a paragraph of somebody else's prose into it.
 * 120 is generous for a person's name and useless as a canvas.
 */
export const MAX_WAIVER_NAME_CHARS = 120

/**
 * THE cleaner every waiver path runs a caller-supplied name through.
 *
 * Three things, in order, and each of them for a reason a fixture states:
 *   • CONTROL CHARACTERS ARE REMOVED (including CR and LF). A newline in a name
 *     is never legitimate, and a name is copied into a stored record and into an
 *     exported artefact — two places where a line break is somebody else's
 *     structure.
 *   • WHITESPACE IS COLLAPSED, so "Anna   Müller" and "Anna Müller" are one
 *     person to a reader.
 *   • THE RESULT IS CLAMPED to MAX_WAIVER_NAME_CHARS.
 *
 * It does NOT escape HTML. Escaping belongs at the point of rendering, where the
 * target syntax is known (the export escapes) — storing a name pre-escaped would
 * put `&amp;` in a legal record. This is hygiene; escaping is the other half,
 * and both exist.
 */
export function cleanWaiverName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return (
    raw
      // C0, DEL and C1, written as escapes because a literal control character
      // in a source file is invisible to the next reader and to every diff.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_WAIVER_NAME_CHARS)
  )
}

// ─── Scope — the question the GATE asks before anything else ─────────────────

/**
 * Does this required waiver apply to the thing being booked?
 *
 * ONE definition, called by the gate on every rail, by the public requirement
 * callable and by the roster. `activityId` is null on a rail that has no
 * activity in hand; an `activities`-scoped waiver then does NOT apply, because
 * "we could not tell which activity" must never silently widen a requirement
 * a studio scoped narrowly — the surface would be asking for a signature the
 * studio did not ask for. Every rail in this product does resolve an activity,
 * so the null arm is a defensive floor rather than a live case.
 */
export function waiverAppliesToActivity(
  scope: WaiverApplies,
  activityId: string | null
): boolean {
  if (scope.appliesTo === 'all_bookings') return true
  if (!activityId) return false
  return scope.activityIds.includes(activityId)
}

// ─── The self-declaration the consent step takes ─────────────────────────────

/**
 * What the visitor DECLARED on a waiver flagged `mayIncludeMinors`.
 *
 * A SELF-DECLARATION and nothing more. It is two radios and an optional name; no
 * evidence is collected, none is claimed, and no booking is refused over it. It
 * lands on the ledger as `signer_role` / `signer_name`, and it lands on the
 * booking as `BookingWaiverState` so the roster and the printed manifest can
 * prompt the studio — the only party who sees the participant — to check.
 *
 * Absent on a waiver that is not flagged: the step does not ask, and the record
 * says `self`, which is the truth about what was shown.
 */
export interface WaiverSelfDeclaration {
  /** True ⇒ "I am signing as a parent or guardian". False ⇒ "I am the
   *  participant". */
  signingAsGuardian: boolean
  /** Optional, and optional on purpose: making it mandatory buys a required
   *  field's worth of friction for a string nothing checks. Passed through
   *  `cleanWaiverName` before it reaches a record. */
  guardianName?: string | null
}

// ─── The denormalised booking stamp ──────────────────────────────────────────

/**
 * `Booking.waiver_state` — a DENORMALISED convenience for the day sheet and the
 * printed manifest, written by whichever rail committed the seat and never read
 * for a decision. The authoritative answer is always `waiverAcceptanceState`
 * over the signer row.
 *
 * ABSENT is a real third value and it means "no required waiver applied to this
 * booking, or the booking predates waivers". The roster renders NOTHING for it,
 * following the `showsNoSubBadge` tri-state already on that page: unknown must
 * not print as either a tick or a warning.
 *
 * THE TWO CHIP VALUES ARE PROMPTS, NOT VERDICTS. Both mean "a human should look
 * at who is actually standing here", and neither asserts anybody's age: a studio
 * that never flags a waiver `mayIncludeMinors` only ever sees `ok`.
 */
export type BookingWaiverState =
  /** Every applicable required waiver was valid, or was signed with this booking,
   *  and nothing about it asks the studio to check anything. */
  | 'ok'
  /** Somebody ticked declaring they are the participant's parent or guardian.
   *  SELF-DECLARED — see `WaiverAcceptanceEvent.signer_role`. */
  | 'guardian_declared'
  /** A `mayIncludeMinors` waiver applied and the signer said they ARE the
   *  participant. Nothing is wrong; the studio is simply the only party who can
   *  confirm that at the door. */
  | 'check_participant'

/**
 * THE DOOR CHECK — what the roster and the printed manifest ask a human to LOOK
 * AT. Two values, and both are PROMPTS rather than verdicts: neither asserts
 * anybody's age, and neither refuses anything.
 *
 *   'guardian' — somebody ticked declaring they are a parent or guardian.
 *   'check'    — a `mayIncludeMinors` waiver applied and the signer said they
 *                ARE the participant.
 *
 * NOTHING VERIFIED EITHER — see `WaiverAcceptanceEvent.signer_role`. The studio
 * is the party with the legal exposure and the only one who sees the participant,
 * so the chip is the prompt and the door is the mechanism.
 */
export type WaiverDoorCheck = 'guardian' | 'check'

/**
 * THE one derivation of the door check for ONE waiver and the signature against
 * it — used by the LIVE surfaces, which read the signer row.
 *
 * `guardian` outranks `check`, because it is the more specific fact about the
 * same booking. null is the answer for every waiver a studio never flagged,
 * which is what keeps this chip off every adults-only roster in the product.
 *
 * IT ASSUMES A SIGNATURE EXISTS, and the caller owns that check: a person who
 * has not signed at all already gets the STATE chip (`WaiverChip`), and adding a
 * door check beside it would say the same thing twice. A row that exists but
 * carries no role is a pre-existing one, and `check` is the conservative answer
 * for it on a flagged waiver.
 */
export function waiverDoorCheckFor(input: {
  signerRole: WaiverSignerRole | null | undefined
  mayIncludeMinors: boolean | undefined
}): WaiverDoorCheck | null {
  if (input.signerRole === 'guardian') return 'guardian'
  if (input.mayIncludeMinors === true) return 'check'
  return null
}

/**
 * The SAME question answered off a booking's denormalised stamp — what the
 * printed manifest has to work with, since a booked row carries no signer
 * lookup.
 *
 * Two sources on purpose (live row vs snapshot), ONE vocabulary: they must land
 * on the same word, or the desk is told two different things about one person.
 * `waivers/gate.test.ts` asserts they agree. The snapshot is deliberately the
 * imprecise one — a repeat booking riding on a guardian signature given months
 * ago stamps `check_participant` — and the prompt is the same either way.
 */
export function waiverDoorCheckFromBookingState(
  state: BookingWaiverState | null | undefined
): WaiverDoorCheck | null {
  if (state === 'guardian_declared') return 'guardian'
  if (state === 'check_participant') return 'check'
  return null
}

// ─── Policy-entry derivation ─────────────────────────────────────────────────

/** The shape the policy writers read a document as. Deliberately structural
 *  rather than `StudioDocument`, so the verifier script can pass a raw
 *  Firestore payload without casting a partial document to a full one. */
export interface WaiverPolicySourceDocument {
  documentId: string
  slug: string
  title: string
  kind: DocumentKind
  status: string
  archived_at?: unknown
  current_version?: number | null
  min_valid_version?: number | null
  waiver?: WaiverConfig | null
}

/**
 * THE single derivation of "should this document have a policy entry, and what
 * is in it". Used by `publishDocumentVersion`, `setWaiverRequirement`,
 * `archiveWaiver` AND `scripts/verify-waiver-ledger.ts` — the writers and the
 * checker must agree by construction, not by two people implementing the same
 * paragraph.
 *
 * Returns null when the document must NOT appear in the policy: anything that
 * is not a required, published, unarchived waiver with a version.
 */
export function waiverPolicyEntryFor(
  doc: WaiverPolicySourceDocument,
  bodyHash: string
): RequiredWaiverEntry | null {
  if (doc.kind !== 'waiver') return null
  if (!doc.waiver || doc.waiver.required !== true) return null
  if (doc.status !== 'published') return null
  if (doc.archived_at != null) return null
  if (typeof doc.current_version !== 'number') return null
  return {
    documentId: doc.documentId,
    slug: doc.slug,
    title: doc.title,
    current_version: doc.current_version,
    min_valid_version: doc.min_valid_version ?? 0,
    body_hash: bodyHash,
    mayIncludeMinors: doc.waiver.mayIncludeMinors === true,
    validityMonths: doc.waiver.validityMonths ?? null,
    scope: doc.waiver.scope,
  }
}

/** The default a freshly-created waiver carries. `mayIncludeMinors: false` is the
 *  adults-only common case: no extra question on the acquisition path, and no
 *  chip on any roster. See `WaiverConfig.mayIncludeMinors`. */
export function defaultWaiverConfig(): WaiverConfig {
  return {
    mayIncludeMinors: false,
    validityMonths: null,
    scope: { appliesTo: 'all_bookings' },
    required: false,
  }
}
