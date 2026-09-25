// Makes a production failure reach a human.
//
// Before this, nothing did. Functions error handling is overwhelmingly bare
// `console.error` (grep to see the current extent), which lands in Cloud Logging
// and sits there: no grouping, no alerting, nobody paged. The first signal of a
// broken webhook was a studio saying "I paid and nothing happened", days later.
//
// The fix is deliberately NOT a rewrite of those call sites. One report at the
// handler boundary catches every unhandled throw beneath it, which is nearly all
// of the signal for a fraction of the churn — and leaves the existing
// `console.error` breadcrumbs in place as context.
//
// WHY CLOUD ERROR REPORTING AND NOT SENTRY: the stack is already entirely GCP,
// and `apps/web` + `apps/admin` are SSR on Cloud Run, so their server-side
// throws land in the same place as the functions'. That covers every render,
// every server action and every callable with no new vendor, no DSN secret and
// no source-map upload step. The gap it leaves is browser-side JavaScript, which
// PostHog already captures. Revisit when browser bugs start costing real time.
//
// Where the output surfaces: the ops console's Health page links straight into
// it, per environment (`apps/admin/src/lib/opsLinks.ts`).
import * as logger from 'firebase-functions/logger'
import { HttpsError } from 'firebase-functions/v2/https'

/**
 * `HttpsError` codes that mean "the system worked". A rate limiter refusing a
 * flood, a caller asking for something they may not have, a full class — these
 * are outcomes, not bugs, and reporting them would bury the real failures in
 * exactly the noise Error Reporting exists to remove.
 *
 * Anything NOT in this set is reported, including `internal` and `unknown`,
 * which are the ones that usually mean a genuine defect.
 */
const EXPECTED_HTTPS_CODES = new Set([
  'invalid-argument',
  'failed-precondition',
  'permission-denied',
  'unauthenticated',
  'not-found',
  'already-exists',
  'resource-exhausted',
  'out-of-range',
  'cancelled',
])

function isExpected(err: unknown): boolean {
  return err instanceof HttpsError && EXPECTED_HTTPS_CODES.has(err.code)
}

/**
 * Emit one entry that Cloud Error Reporting will pick up, group by cause, and
 * count. Detection keys on a stack trace in the message at ERROR severity, so
 * the stack is passed through verbatim rather than summarized — a message
 * without one is logged but never grouped.
 *
 * `context` is free-form and shows up alongside the group. Include the ids that
 * make an incident actionable (teamId, the Stripe event id) and NEVER a secret,
 * a token or a full request body.
 */
export function reportError(err: unknown, context: { fn: string } & Record<string, unknown>): void {
  const error = err instanceof Error ? err : new Error(String(err))
  logger.error(error.stack ?? `${error.name}: ${error.message}`, {
    ...context,
    errorName: error.name,
    errorMessage: error.message,
    // Error Reporting reads this to attribute the group to a service rather than
    // lumping every function together.
    serviceContext: { service: context.fn },
  })
}

/**
 * Wrap a handler so any unhandled throw beneath it is reported and then
 * re-thrown unchanged. The rethrow matters: the caller's error contract —
 * `HttpsError` codes the web app switches on, a webhook's non-2xx that tells
 * Stripe to retry — must not change just because we started watching.
 *
 * Use at the handler boundary only. Wrapping inner helpers double-reports one
 * failure and splits its group.
 *
 * ```ts
 * export const myFn = onCall(withErrorReporting('myFn', async (request) => { … }))
 * ```
 */
export function withErrorReporting<A extends unknown[], R>(
  fn: string,
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await handler(...args)
    } catch (err) {
      if (!isExpected(err)) reportError(err, { fn })
      throw err
    }
  }
}
