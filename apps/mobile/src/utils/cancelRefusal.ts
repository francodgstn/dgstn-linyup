/**
 * A refused cancellation, made legible in the app — the mobile half of the
 * contract pinned in packages/functions/src/booking/cancelContract.test.ts.
 *
 * Every refusal `cancelBooking` gives is FINAL, and it says which one in
 * `details.reason`. A generic "failed, try again" on a final answer teaches a
 * member that the button is broken — PrimeTestLab report 7107's M-02 was
 * exactly that reading. So a tagged refusal gets its own sentence and the
 * caller reloads its list (whatever the row said is no longer true); ONLY a
 * failure with no reason (a network drop, an internal error) may invite a
 * second press.
 *
 * Mirrors apps/web/src/lib/bookingCancellation.ts's `cancelFailureKey`. The
 * copy lives in the `BookingCancellation` namespace, which the caller binds
 * and reads with the key returned here — a pure module cannot call
 * `useTranslations` itself (same pattern as utils/waiverRefusal.ts).
 */
import { parseBookingCancelRefusal, type BookingCancelRefusal } from '@linyup/shared';
import { callableErrorCode } from './callableError';

export type CancelRefusalKey =
  | 'refusedNotFound'
  | 'refusedSessionGone'
  | 'refusedAlreadySettled'
  | 'refusedPast'
  | 'failedTransient';

const REFUSAL_KEYS: Record<BookingCancelRefusal, CancelRefusalKey> = {
  not_found: 'refusedNotFound',
  session_gone: 'refusedSessionGone',
  already_settled: 'refusedAlreadySettled',
  past: 'refusedPast',
};

/** Which sentence a failed cancel deserves. Prefers the server's own reason;
 *  falls back to the error code for a deployment older than the contract. */
export function cancelRefusalKey(err: unknown): CancelRefusalKey {
  const details = typeof err === 'object' && err !== null ? (err as { details?: unknown }).details : undefined;
  const reason = parseBookingCancelRefusal(details);
  if (reason) return REFUSAL_KEYS[reason];
  switch (callableErrorCode(err)) {
    case 'not-found':
      return 'refusedNotFound';
    case 'failed-precondition':
      // Both `failed-precondition` refusals are final; without a reason the
      // one that covers both is the honest choice.
      return 'refusedAlreadySettled';
    default:
      return 'failedTransient';
  }
}

/** Final means the row that offered the cancel was stale — reload it. Only
 *  the unexplained failure is worth pressing the button again for. */
export function cancelRefusalIsFinal(err: unknown): boolean {
  return cancelRefusalKey(err) !== 'failedTransient';
}
