/**
 * THE APP-STORE REVIEW LOGIN.
 *
 * The contacts' mobile app signs in with an emailed six-digit code. A store
 * reviewer cannot receive that email, so without something here the app cannot
 * be reviewed at all — and a rejected build costs a review cycle, not an hour.
 *
 * So a SHORT LIST of contact addresses may be given a KNOWN code, which is
 * never mailed. `sendContactVerificationCode` is the only place a contact code
 * is
 * generated, so that is the only place this is consulted; `loginContactWithCode`
 * and the shared validator read whatever is in the `verification_codes` document
 * and need no change at all. That containment is the point: the validator is
 * also used by `completeSignup` and `requestContactUpdate`, and this must not
 * reach either.
 *
 * ── THIS IS A DELIBERATE AUTH BYPASS. THE GUARDS ARE THE DESIGN ──────────────
 *
 * - **A bounded list of addresses**, each matched exactly after normalization.
 *   It was one address until 2026-09-04, when Play's closed test needed a dozen
 *   people signing in as THEMSELVES rather than sharing the reviewer's contact —
 *   sharing it meant any curious tester could delete or rename the account the
 *   store reviewer depends on. Widening the door needs a bound, so
 *   `REVIEW_ACCESS_MAX_EMAILS` caps it and an over-long list FAILS CLOSED
 *   rather than being truncated to a silently different configuration.
 * - **Synthetic addresses are expected.** These are demo-tenant contacts, so a
 *   listed address outside `@example.com` is logged as unusual. It is not
 *   refused — that is a judgment for whoever configures it — but it is never
 *   silent, because a fixed code on a REAL mailbox is the failure worth seeing.
 * - **`expires_at` is mandatory** and enforced here. A review window, not a
 *   standing door: past it the address behaves like any other, with a random
 *   code and a real email, and nobody has to remember to turn it off.
 * - **Server-only.** `app_settings/*` other than `public` has no rules match, so
 *   clients are denied by default — same posture as `messaging_policies`.
 * - **Never returned to the client.** The callable's contract is unchanged; the
 *   code reaches the reviewer through App Store Connect, not over the wire.
 * - **Every use is logged**, so Cloud Logging can answer "was this used, and
 *   when" without a database read.
 *
 * ── WHY IT ALSO BYPASSES THE PER-EMAIL RATE LIMIT ────────────────────────────
 *
 * Not a shortcut — the feature fails without it. `sendContactVerificationCode`
 * allows five codes per email per hour, counted by QUERYING `verification_codes`.
 * A reviewer who retries six times in an hour would be refused with
 * `resource-exhausted` and would reasonably report the app as broken. The
 * per-IP limit (20/hour) still applies and is untouched, so this is not an open
 * oracle.
 *
 * One property worth knowing when reasoning about the risk: contact-login codes
 * are ALREADY replayable within their 15-minute window — `loginContactWithCode`
 * never marks them `used`, deliberately, because the web provider re-submits the
 * same code for contact selection. A fixed code does not introduce replay; it
 * removes the guessing. What it does change is that the secret stops rotating,
 * which is what the expiry above is for.
 */
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { APP_SETTINGS_COLLECTION } from '@linyup/shared'

export const REVIEW_ACCESS_DOC = 'review_access'

export interface ReviewAccess {
  enabled: boolean
  /** LEGACY single address. Still honored so an existing document keeps
   *  working untouched; `emails` supersedes it and both may be present. */
  email?: string
  /** Every contact address this code opens, capped at REVIEW_ACCESS_MAX_EMAILS. */
  emails?: string[]
  /** The six digits the reviewer will type. */
  code: string
  /** Hard stop. Past this the address is an ordinary one again. */
  expires_at: Timestamp
  note?: string
  updated_at?: Timestamp
  updated_by?: string
}

/** The longest a review window may be opened for. App review is measured in
 *  days; anything beyond this is somebody forgetting rather than needing. */
export const REVIEW_ACCESS_MAX_DAYS = 60

/** How many addresses one review window may cover. Twelve testers plus spare
 *  capacity and the reviewer; past that it is somebody automating something
 *  rather than running a store review. */
export const REVIEW_ACCESS_MAX_EMAILS = 25

// Same shape as messagingPolicy's cache and for the same reason: this is read on
// a login path, and a Firestore round trip per OTP request for a document that
// changes a few times a year is waste. The window is short enough that
// disabling it in the console takes effect while the operator is still looking
// at the screen.
let cached: { value: ReviewAccess | null; atMs: number } | null = null
const CACHE_MS = 60_000

/** Test seam — the console's writer calls this after a change so an operator
 *  disabling access does not wait out the cache. */
export function clearReviewAccessCache(): void {
  cached = null
}

async function loadReviewAccess(nowMs: number): Promise<ReviewAccess | null> {
  if (cached && nowMs - cached.atMs < CACHE_MS) return cached.value
  let value: ReviewAccess | null = null
  try {
    const snap = await admin
      .firestore()
      .collection(APP_SETTINGS_COLLECTION)
      .doc(REVIEW_ACCESS_DOC)
      .get()
    value = snap.exists ? (snap.data() as ReviewAccess) : null
  } catch (err) {
    // FAIL CLOSED. A read error must not hand out a fixed code, and must not
    // break ordinary logins either — returning null does both: this caller
    // simply generates a random code and mails it, as it always did.
    console.error('[review-otp] could not read review access; treating as disabled', err) // eslint-disable-line no-console
    value = null
  }
  cached = { value, atMs: nowMs }
  return value
}

/**
 * THE DECISION, with no IO in it — which is what the tests exercise.
 *
 * Null is the answer for: no document, disabled, expired, a different address,
 * or a malformed code. Every one of those is a way this bypass could be left
 * open by accident, so every one of them is pinned by a test.
 */
export function decideReviewCode(
  access: ReviewAccess | null,
  email: string,
  nowMs: number
): string | null {
  if (!access || access.enabled !== true) return null
  const addresses = reviewAccessAddresses(access)
  // An over-long list is a misconfiguration, and the safe reading of a
  // misconfigured auth bypass is CLOSED — not 'the first 25 of them'.
  if (addresses.length === 0 || addresses.length > REVIEW_ACCESS_MAX_EMAILS) return null
  if (!addresses.includes(email)) return null
  // An absent or unparseable expiry is treated as EXPIRED, not as forever.
  const expiresMs = access.expires_at?.toMillis?.()
  if (typeof expiresMs !== 'number' || expiresMs <= nowMs) return null
  if (!/^\d{6}$/.test(access.code ?? '')) return null
  return access.code
}

/** Every address the document covers, normalized and de-duplicated. Legacy
 *  `email` and modern `emails` are unioned so a half-migrated document behaves
 *  as the sum of what it says, never as neither. */
export function reviewAccessAddresses(access: ReviewAccess | null): string[] {
  if (!access) return []
  const raw = [access.email, ...(Array.isArray(access.emails) ? access.emails : [])]
  const seen = new Set<string>()
  for (const e of raw) {
    if (typeof e !== 'string') continue
    const n = e.toLowerCase().trim()
    if (n) seen.add(n)
  }
  return [...seen]
}

/** The fixed code for this email, or null for everybody and everything else. */
export async function reviewAccessCodeFor(
  email: string,
  nowMs: number = Date.now()
): Promise<string | null> {
  const access = await loadReviewAccess(nowMs)
  const code = decideReviewCode(access, email, nowMs)
  const addresses = reviewAccessAddresses(access)
  if (code) {
    const outsiders = addresses.filter((a) => !a.endsWith('@example.com'))
    if (outsiders.length > 0) {
      console.warn(`[review-otp] review access covers ${outsiders.length} non-synthetic address(es); a fixed code on a real mailbox is worth checking`) // eslint-disable-line no-console
    }
  }
  if (!code && access?.enabled === true && addresses.includes(email)) {
    // Configured for this address but refused — worth a line, because from the
    // reviewer's side this is indistinguishable from the feature not existing.
    console.warn(`[review-otp] access for ${email} is configured but not usable (expired, a malformed code, or too many addresses)`) // eslint-disable-line no-console
  }
  return code
}
