// Public-surface read failures: log them, and never let one render as "empty".
//
// ── Why this file exists ──────────────────────────────────────────────────────
// The Space "My courses" section 403'd on its entitlements query for as long as
// the feature had shipped: a contact who had PAID for a course never saw it. It
// went unnoticed because the effect ended in `.catch(() => {})`, so a hard
// permission-denied and "this studio publishes no courses" produced the exact
// same pixels — and produced no console line either, so nothing pointed at it
// from the inside. The rule was wrong for months; the silence is what made the
// wrongness invisible.
//
// Two rules follow, and they are separate:
//
//   1. LOG EVERY SWALLOWED READ. Even where degrading to a terminal state is the
//      right product behavior (a bio-link that renders "not found" when its
//      lookup fails), the failure must leave a trace a developer can grep. Call
//      `reportPublicLoadFailure` in every catch on a public surface — there is
//      no acceptable `catch {}` on a read path.
//
//      Stated as an absolute because the exceptions people reach for are not
//      exceptions to THIS rule, they are exceptions to rule 2 — "the visitor
//      must not see it" is an argument for silence on screen, never in the log.
//      It now has NO admitted exception. The one it carried —
//      `TrialBookingForm`'s failed session read rendering as "no trial
//      sessions" — turned out to be unreachable: `trial-booking/page.tsx` has
//      redirected to `/booking` since the two flows merged, and nothing
//      imported the component. It was deleted on 2026-08-28 rather than having
//      an error state threaded through it, which is what the defect record had
//      assumed the fix would cost.
//   2. WHERE THE VISITOR CAN TELL THE DIFFERENCE, SHOW THEM. A list that could
//      legitimately be empty must not render its empty state after a failed
//      fetch; render `QueryErrorState` (components/ui/query-error) instead, with
//      `loadFailureDetail(err)` as its detail line.
//
// Not a telemetry pipeline: public surfaces run without the authenticated app's
// PostHog provider, so this deliberately matches the existing console convention
// in lib/publicTeamMeta.ts rather than inventing a second one.

/** Firestore/Functions errors carry a machine `code`; plain Errors do not. */
function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

function errorMessage(err: unknown): string | null {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return null
}

/**
 * Log a read failure on a public surface.
 *
 * `scope` names the query, not the file — it is what somebody greps for when a
 * studio reports "my courses are missing" (e.g. 'space/purchases').
 */
export function reportPublicLoadFailure(scope: string, err: unknown): void {
  const code = errorCode(err)
  // permission-denied is the one worth calling out by name: it means a rules or
  // index change broke a query that used to work, not that the network blipped.
  console.error(`[public/${scope}] load failed${code ? ` (${code})` : ''}:`, err)
}

/**
 * The same trace for a failed WRITE — a cancel, a submit, anything the visitor
 * pressed a button to cause.
 *
 * A separate function only so the line does not say "load failed" about
 * something nobody was loading; the `[public/…]` prefix is deliberately
 * identical, because whoever greps for one wants the other. Rule 1 covers these
 * too, and they are in one way worse: a swallowed read shows the visitor stale
 * data, while a swallowed write shows them a button that appears to do nothing,
 * and the answer to a button that does nothing is to press it again.
 */
export function reportPublicActionFailure(scope: string, err: unknown): void {
  const code = errorCode(err)
  console.error(`[public/${scope}] action failed${code ? ` (${code})` : ''}:`, err)
}

/**
 * A short, human-readable detail line for `QueryErrorState`. Returns null when
 * there is nothing useful to say, which renders the generic message alone.
 */
export function loadFailureDetail(err: unknown): string | null {
  if (err == null) return null
  const code = errorCode(err)
  const message = errorMessage(err)
  if (code && message) return `${code}: ${message}`
  return code ?? message
}
