/**
 * CONTACT UPDATE LINK — a scoped, expiring grant to edit ONE contact's details.
 *
 * A studio hands a person a QR (or a copied link) in the room, they fill in
 * their own details — including the email address the studio never had — and
 * the link dies minutes later. It exists because the two authenticated ways in
 * are both email-gated: a contact session is minted from an emailed code, and
 * the bio-link flow verifies an address before it will match a contact. Neither
 * can reach somebody whose record has no email, which is the exact population
 * this is for. (Measured on the HMD federation at import time: 1,351 of 1,485
 * live contacts had no address on file.)
 *
 * ── IT IS A GRANT, NOT A LOGIN ──────────────────────────────────────────────
 * This is deliberately NOT the `auth_tokens` mechanism deleted in 2026-07 — a
 * general "prove you are this contact" token whose blast radius was everything
 * a contact can do. A link authorises exactly one thing: writing a named set of
 * fields onto one contact document. It mints no session, reads no bookings, no
 * payment history and no notes, and it cannot be exchanged for either.
 *
 * ── THE TOKEN IS NEVER STORED ───────────────────────────────────────────────
 * The document id is `sha256(token)`, so the token itself exists only in the
 * URL the studio just handed over. A dump of this collection yields no working
 * links. The OTP is hashed WITH the token (`sha256(token + ':' + otp)`) for the
 * same reason turned around: six digits is a trivial space to enumerate, so the
 * hash is salted by the one secret an attacker reading the database does not
 * have.
 *
 * Because the id is a hash, a link cannot be re-displayed after the dialog
 * closes — mint another. At a five-minute default that is the common path
 * anyway, and it makes "is the old QR on someone's camera roll still live?"
 * answerable with a flat no.
 */

/** The window is short by default because the normal use is hand-to-hand. */
export const CONTACT_LINK_DEFAULT_TTL_MINUTES = 5
export const CONTACT_LINK_MIN_TTL_MINUTES = 5
/** A day is the ceiling: long enough to send it home with a parent, short
 *  enough that a forgotten link is not a standing key. */
export const CONTACT_LINK_MAX_TTL_MINUTES = 24 * 60

/** Offered in the studio UI. Any value in range is accepted by the server. */
export const CONTACT_LINK_TTL_CHOICES = [5, 15, 60, 480, 1440] as const

export const CONTACT_LINK_OTP_LENGTH = 6

/**
 * Contacts per batch-mint call. The client chunks a bigger roster.
 *
 * Sized by the Firestore batch limit rather than by taste: each contact costs
 * one create plus at most one revoke of its previous grant, so 100 contacts is
 * 200 writes against a ceiling of 500 — room for the limit to be misread once
 * without a partial commit.
 */
export const CONTACT_LINK_MAX_BATCH = 100

/**
 * Windows offered when PRINTING a sheet. The hand-to-hand default makes no
 * sense on paper: a sheet is printed before training and handed out during it,
 * so anything under an hour is expired before the first slip is torn off.
 *
 * A printed slip also carries no spoken code — printing the code beside the QR
 * would defeat it — so on this path the slip IS the secret, which is the other
 * reason the window matters more here than it does at the counter.
 */
export const CONTACT_LINK_SHEET_TTL_CHOICES = [60, 480, 1440] as const
export const CONTACT_LINK_SHEET_DEFAULT_TTL_MINUTES = 1440

/**
 * Wrong OTPs before the link is dead. Low on purpose: the code is spoken aloud
 * to somebody standing there, so a second failure is a typo and a sixth is not
 * the person the studio was talking to.
 */
export const CONTACT_LINK_MAX_ATTEMPTS = 5

/**
 * Submissions allowed while the link is live. More than one because the first
 * thing people do after typing an email address wrong is notice; fewer than
 * unlimited because the link is a grant, not an account.
 */
export const CONTACT_LINK_MAX_SUBMISSIONS = 3

/** Server-side shape. Clients never read this collection — rules deny it. */
export interface ContactUpdateLink {
  /** sha256 of the token. Also the document id. */
  id: string
  teamId: string
  contact_id: string
  /** Denormalised so the notification and audit row can name them without a read. */
  contact_name: string
  created_at: unknown
  created_by: string
  expires_at: unknown
  requires_otp: boolean
  /** sha256(`${token}:${otp}`), or null when the studio minted no code. */
  otp_hash: string | null
  attempts: number
  submissions: number
  revoked_at: unknown | null
  last_submitted_at: unknown | null
}

/** Clamp a requested TTL into the allowed window. */
export function clampContactLinkTtl(minutes: number | undefined | null): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    return CONTACT_LINK_DEFAULT_TTL_MINUTES
  }
  return Math.min(
    CONTACT_LINK_MAX_TTL_MINUTES,
    Math.max(CONTACT_LINK_MIN_TTL_MINUTES, Math.round(minutes))
  )
}

/**
 * Why a link will not open. One vocabulary, so the public form and the server
 * cannot disagree about what to tell somebody standing at a reception desk.
 *
 * `otp_required` is not a failure — it is the form's cue to ask for the code.
 */
export type ContactLinkRefusal =
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'otp_required'
  | 'otp_invalid'
  | 'too_many_attempts'
  | 'too_many_submissions'
