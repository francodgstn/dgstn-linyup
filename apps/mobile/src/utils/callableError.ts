/** The gRPC-style code of a failed callable, without the `functions/` prefix
 *  the Firebase JS SDK puts on it (`functions/not-found` → `not-found`), or
 *  null when the error is not a callable's. Mirrors
 *  apps/web/src/lib/bookingCancellation.ts's `callableErrorCode`. */
export function callableErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  return code.startsWith('functions/') ? code.slice('functions/'.length) : code;
}
