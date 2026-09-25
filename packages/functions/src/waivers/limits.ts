// ABUSE LIMITS ON THE PUBLIC WAIVER SURFACE — ONE MODEL, STATED ONCE.
//
// ONE callable is reachable without an account, and this file bounds it:
// `resolveWaiverRequirement` (waivers/requirement.ts), which READS. Everything
// it is bounded by is decided here and nowhere else, because the previous two
// attempts each fixed one site and broke another.
//
// IT USED TO BOUND FOUR. The other three were the emailed-guardian mint and the
// signing page's two token callables, and they were removed with that whole
// mechanism — along with the mail counters, which existed because the mint was a
// PUBLIC MAIL-SENDING PRIMITIVE that sent as the studio. No waiver path sends
// mail any more. What did NOT go away is why this file exists: the survivor is
// still public, still unauthenticated, and still IDENTITY-BEARING — it resolves a
// caller by email+name against `contacts`, which is a query about a person made
// by a stranger. Removing the mail axis removed neither the volume axis nor the
// enumeration axis.
//
// ══ THE MODEL ═══════════════════════════════════════════════════════════════
// Bound what actually costs something, on the axis that actually pays for it,
// and never let a stranger spend an entitled caller's quota. Two costs live on
// this callable and they do not share an axis. ANSWERING WHETHER AN ADDRESS
// BELONGS TO SOMEBODY HERE costs an information leak, and the answer to that is
// not a smaller ration but no answer: the callable no longer reports the
// ambiguity bit at all, so an unproven caller's reply is byte-identical for a
// known household mailbox and a stranger's — a bound a counter cannot give.
// ASKING AT ALL costs one query about a person, so an uncredentialed caller pays
// one unit per identity-bearing call against a per-IP hourly ceiling sized for
// the busiest doorway anyone can describe rather than for a probe budget. And a
// caller who presents a credential WE minted for THIS team — a live contact
// session, or a kiosk tablet paired through `unlockKiosk` — is exempt from the
// per-IP ceiling outright, because Phase 3's rule is that the entitled caller
// must never be throttled by strangers sharing their address, and a doorway
// tablet at a busy class is one address for a whole evening.
//
// ══ THE EXPOSURE THIS ACCEPTS, NAMED RATHER THAN DISCOVERED ═════════════════
// A call that supplies NO identity is not charged. It asks about nobody, runs no
// query about anybody, and is answered out of the team's own published waiver
// text — the same bytes D2 already serves world-readable at
// `/public/{slug}/documents/{slug}` with no counter in front of them. So a flood
// of exactly that shape is bounded by nothing here, deliberately: a counter on it
// would buy the price of a public page read, and it would cost a gym, a school or
// a doorway tablet its own booking path. That failure has now been produced
// twice, and it is worse than the thing it was reaching for.
//
// ══ WHY THE CREDENTIAL CHECK COSTS NOTHING ══════════════════════════════════
// It reads CLAIMS, never Firestore. Firebase verifies a custom token's signature
// before `request.auth` is populated, so a claim that survives to here was minted
// by us; and obtaining one costs either an emailed six-digit code or the studio's
// kiosk PIN, both bounded elsewhere. Possession is therefore a sufficient reason
// to be exempt from a VOLUME counter — it is deliberately NOT sufficient to grant
// an authorization, and nothing here grants one.

import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import {
  WAIVER_CHECK_RATE_LIMIT_BUCKET,
  rateLimitWindowEndMs,
  spendRateLimit,
} from '../connect/checkout'
import { kioskClaimForTeam, type KioskTokenClaims } from '../utils/kioskSession'

// ─── The ceilings ────────────────────────────────────────────────────────────

/**
 * Identity-bearing `resolveWaiverRequirement` calls, per hour, per IP, for a
 * caller holding no credential of ours.
 *
 * SIZED FOR THE BUSIEST DOORWAY, NOT FOR A PROBE BUDGET, and the difference is
 * the whole reason this number is not 30 like its neighbors. The callable is a
 * PRECONDITION for booking at a waiver-configured tenant, so a ceiling a shared
 * address can reach is a ceiling that stops a gym, a school or a tablet at a
 * class door from booking anything. The worst legitimate case anybody has been
 * able to describe is a doorway running 200 walk-ins in an hour at roughly two
 * identity-bearing calls each; this sits comfortably above it, the studio's own
 * paired tablet is exempt outright, and every signed-in member is too.
 */
export const WAIVER_RESOLVE_LIMIT_PER_HOUR = 600

// ─── Who is exempt, and why ──────────────────────────────────────────────────

/** A credential WE minted, naming THIS team. Never a claim off the request body. */
export type WaiverCallerCredential = 'contact_session' | 'kiosk_device'

/** The claim bag as it arrives on a verified token. Every field is `unknown`
 *  because these are attacker-influenced right up until they are checked. */
export interface WaiverCredentialClaims extends KioskTokenClaims {
  teamId?: unknown
  sessionExpires?: unknown
}

/**
 * PURE. Which credential, if any, does this token present for this team?
 *
 * Pure so the exemption is asserted by a fixture rather than by reading a
 * callable — the last two rounds both shipped a limiter whose real behavior was
 * only visible by tracing which branch reached which counter.
 *
 * An EXPIRED contact session is not a credential: it is checked here exactly as
 * `optionalContactSessionFromRequest` checks it, so a seven-day token cannot buy
 * an unbounded exemption for an eighth day.
 */
export function waiverCredentialForTeam(
  claims: WaiverCredentialClaims | null | undefined,
  teamId: string,
  nowMs: number
): WaiverCallerCredential | null {
  if (!claims || !teamId) return null
  if (kioskClaimForTeam(claims, teamId)) return 'kiosk_device'
  const contactId = typeof claims.contactId === 'string' ? claims.contactId : ''
  const claimedTeam = typeof claims.teamId === 'string' ? claims.teamId : ''
  if (!contactId || claimedTeam !== teamId) return null
  if (typeof claims.sessionExpires === 'number' && claims.sessionExpires < nowMs) return null
  return 'contact_session'
}

/** The same question against a live request. Reads claims only — no Firestore. */
export function waiverCallerCredential(
  request: CallableRequest<unknown>,
  teamId: string
): WaiverCallerCredential | null {
  return waiverCredentialForTeam(
    request.auth?.token as WaiverCredentialClaims | undefined,
    teamId,
    Date.now()
  )
}

// ─── The resolve ─────────────────────────────────────────────────────────────

/**
 * PURE. Does this `resolveWaiverRequirement` call cost a unit?
 *
 * Two conditions, and both are load-bearing:
 *   • the caller holds no credential of ours — otherwise a stranger sharing
 *     their address could spend an entitled caller's hour, which is the Phase-3
 *     rule this file exists to keep;
 *   • the call asks about a PERSON — an address, or an OTP pair. A call that
 *     asks about nobody runs no query about anybody and is answered from the
 *     team's own published text, so charging it would bound a public page read
 *     and lock a doorway out of booking.
 */
export function waiverResolveCosts(input: {
  credential: WaiverCallerCredential | null
  asksAboutAPerson: boolean
}): boolean {
  return !input.credential && input.asksAboutAPerson
}

/** PURE. Has the hour been spent? Separate from the charge so the doorway
 *  arithmetic ("200 walk-ins, two calls each") is a fixture and not a comment. */
export function waiverResolveExceeded(newCount: number): boolean {
  return newCount > WAIVER_RESOLVE_LIMIT_PER_HOUR
}

/**
 * Charge the resolve, at the TOP of the callable and before any query, so an IP
 * that has spent its hour is refused before it costs a read rather than after.
 *
 * Returns without touching Firestore for every shape that costs nothing.
 */
export async function chargeWaiverResolve(input: {
  ip: string | undefined
  credential: WaiverCallerCredential | null
  asksAboutAPerson: boolean
}): Promise<void> {
  if (!waiverResolveCosts(input)) return
  const count = await spendRateLimit(input.ip, WAIVER_CHECK_RATE_LIMIT_BUCKET)
  if (waiverResolveExceeded(count)) throw tooManyAttempts()
}

/**
 * The refusal. `rate_limited`, with the window's end, because a cap that does
 * not say when it lifts reads as a permanent lockout.
 */
function tooManyAttempts(): HttpsError {
  return new HttpsError('resource-exhausted', 'Too many attempts. Please try again later.', {
    reason: 'rate_limited',
    retryAfter: new Date(rateLimitWindowEndMs()).toISOString(),
  })
}
