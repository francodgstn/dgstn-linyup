// What to SAY when a member cancels — the one place the three cancel surfaces
// (the emailed manage-booking page, the emailed appointment-cancel page, and
// the member portal's own list) read their sentences from.
//
// ── Why this file exists ──────────────────────────────────────────────────────
//
// Two failures, both from the same habit of describing a cancellation in
// general terms instead of describing THIS one:
//
//  1. NOBODY WAS TOLD WHAT HAPPENS TO THE CREDIT. `cancelBooking` puts a spent
//     lesson credit back on the pack, unconditionally — no window, and even if
//     the pack has expired since. That is a good deal, and every surface kept it
//     secret; a member who does not know it stays home rather than canceling,
//     which costs the studio the seat AND the goodwill. The mirror image matters
//     just as much: a booking somebody PAID for gets no refund here, and copy
//     that implies otherwise would be a promise the code does not keep.
//
//  2. A FINAL REFUSAL OFFERED "TRY AGAIN". Every way `cancelBooking` says no is
//     permanent (the class has started; the studio checked you in; the booking
//     is already gone). Inviting a retry teaches the member that the button is
//     broken. So a refusal that names a reason gets that reason's sentence and
//     no retry; only an unexplained failure — a network drop, an internal error
//     — gets the retry copy, because only that one can succeed second time.
//
// The reasons and the effect shape are `@linyup/shared` types written by
// `cancelBooking` itself, so this file translates the server's answer and never
// invents one.
//
// ONE `BookingCancellation` namespace serves all three surfaces, which is why
// its German, French and Italian copy is written WITHOUT a second-person
// pronoun: the member portal addresses people informally (`du` / `tu`) and the
// emailed manage-booking page formally (`Sie` / `vous`), and a shared sentence
// cannot be both. English has no such fork, so it keeps "your".

import {
  parseBookingCancelRefusal,
  type BookingCancelEffect,
  type BookingCancelRefusal,
} from '@linyup/shared'

/** The `BookingCancellation` message keys for a refusal. `null` ⇒ transient. */
const REFUSAL_KEYS: Record<BookingCancelRefusal, string> = {
  not_found: 'refusedNotFound',
  session_gone: 'refusedSessionGone',
  already_settled: 'refusedAlreadySettled',
  past: 'refusedPast',
}

/**
 * A callable rejection's error code, WITHOUT the SDK's `functions/` namespace.
 *
 * The prefix is the trap: `FunctionsError` is constructed as
 * `` `${FUNCTIONS_TYPE}/${code}` ``, so a client comparing `err.code` to
 * `'not-found'` never matches and silently falls through to its generic branch.
 * The appointment cancel page shipped exactly that — four carefully written
 * error sentences, none of which could ever render.
 */
export function callableErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return null
  return code.startsWith('functions/') ? code.slice('functions/'.length) : code
}

/**
 * Which sentence a failed cancel deserves, as a `BookingCancellation` key.
 *
 * Prefers the server's own `details.reason`; falls back to the error code for
 * a deployment where the callable is older than this page. `failedTransient`
 * is the ONLY outcome that may be paired with a retry.
 */
export function cancelFailureKey(err: unknown): string {
  const reason = parseBookingCancelRefusal((err as { details?: unknown })?.details)
  if (reason) return REFUSAL_KEYS[reason]
  switch (callableErrorCode(err)) {
    case 'not-found':
      return REFUSAL_KEYS.not_found
    case 'failed-precondition':
      // Both `failed-precondition` refusals are final; without a reason we
      // cannot tell which, so the one that covers both is the honest choice.
      return REFUSAL_KEYS.already_settled
    default:
      return 'failedTransient'
  }
}

/** Is this failure worth pressing the button again for? Only the unexplained one. */
export function cancelFailureIsRetryable(err: unknown): boolean {
  return cancelFailureKey(err) === 'failedTransient'
}

/**
 * The `BookingCancellation` keys describing an effect, in reading order.
 *
 * `tense` picks the pair: `'will'` before the member commits (the confirmation
 * step), `'did'` afterwards. `paidNotRefunded` has one form for both — the
 * money does not move in either tense, which is the entire point of it.
 */
export function cancelEffectKeys(
  effect: BookingCancelEffect | null | undefined,
  tense: 'will' | 'did'
): string[] {
  if (!effect) return []
  const keys: string[] = []
  if (effect.credit) keys.push(tense === 'will' ? 'willReturnCredit' : 'returnedCredit')
  if (effect.usageUnit) keys.push(tense === 'will' ? 'willReturnUsage' : 'returnedUsage')
  if (effect.paid) keys.push('paidNotRefunded')
  return keys
}
