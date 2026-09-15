/**
 * Is this session cancelled? A cancelled session is either stored as
 * `status: 'cancelled'` or is a cancelled EXCEPTION of a series — both count.
 *
 * Moved here from `functions/src/booking/waitlist/constants.ts` (which
 * re-exports it) so the public API's session projection answers the same
 * question the waitlist does.
 */
export function isSessionCancelled(session: {
  status?: unknown
  isException?: unknown
  exceptionType?: unknown
}): boolean {
  return session.status === 'cancelled' || (session.isException === true && session.exceptionType === 'cancelled')
}
