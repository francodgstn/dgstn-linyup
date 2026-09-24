// ─── Series teardown: deleting "this and all following" in the background ─────
//
// Cancelling one occurrence is a click. Cancelling the REST OF A SERIES is a
// walk over every future session — each one closing its waitlist, giving seats
// back, moving per-contact counters and mailing everybody who held a booking.
// A six-month weekly series is ~26 of those; a daily one is ~180. That does not
// fit in a callable, and half-finishing it in one is the worst outcome: the
// studio sees a timeout and has no idea which classes were called off.
//
// So a large teardown becomes a JOB: the callable pins the scope, freezes the
// series and returns a jobId; a Cloud Task drains it in batches; the client
// polls this document. A small one still runs inline, because a studio deleting
// three classes should not have to watch a progress bar.
//
// ── WHAT MAKES IT SAFE TO RUN WHILE PEOPLE ARE STILL USING THE CALENDAR ───────
// Three rules, and each answers a race that is otherwise real:
//
//  1. THE SCOPE IS PINNED, NEVER RE-DECIDED. `cutoff` is the anchor session's
//     start, captured when the studio clicked. "Future" therefore means the same
//     set ten minutes later, so how long the job took cannot change what it
//     deleted.
//  2. THE SERIES IS FROZEN BEFORE THE JOB IS ENQUEUED — one synchronous write,
//     inside the callable. `status: 'deleting'` is what the daily roller already
//     filters on (it rolls `status == 'active'` only), so the generator cannot
//     re-materialise occurrences behind the job that is deleting them. The
//     editing callables refuse on `teardown_job_id` for the same reason.
//  3. EVERY UNIT IS IDEMPOTENT AND TOLERATES A MISSING DOCUMENT. A session
//     somebody else deleted mid-run is simply already done — the drain query
//     stops returning it, and that counts as progress, not an error. This is
//     the direct answer to "what about sessions deleted while the task runs":
//     nothing has to detect it, because the work list is a LIVE QUERY and a
//     deleted session leaves it by itself.
//
// The one thing idempotency alone does NOT cover is a duplicate *worker* — two
// runs mailing the same roster "your class is cancelled" twice. That is why a
// session is CLAIMED (a transaction, `teardown_claim`) before it is torn down,
// and why the claim carries a timestamp: a worker that died mid-session must not
// wedge that session forever, so a stale claim can be taken over.

import type { Timestamp } from './common'

/**
 * Scope sizes at or below this are torn down INLINE, in the callable, exactly as
 * before. Above it the work is handed to a Cloud Task.
 *
 * Chosen from the cost of ONE session's teardown (a waitlist close, a bookings
 * read, N counter writes and N emails — comfortably a second or two when mail is
 * involved), against the callable budget we are willing to spend before the
 * studio thinks the app has hung.
 */
export const SERIES_TEARDOWN_INLINE_MAX = 8

/** Sessions torn down per task invocation before the worker re-enqueues itself. */
export const SERIES_TEARDOWN_BATCH = 20

/**
 * A hard stop on the chain, so a bug that stops making progress burns a bounded
 * number of tasks instead of looping forever. At BATCH=20 this covers 20k
 * sessions — far past any real series.
 */
export const SERIES_TEARDOWN_MAX_ROUNDS = 1000

/**
 * How many individually-failed sessions a job tolerates before giving up. They
 * are recorded by id (`failed_ids`) and skipped on later rounds — otherwise one
 * poisoned document would be re-attempted forever, since the drain query keeps
 * returning what was never deleted.
 */
export const SERIES_TEARDOWN_MAX_FAILURES = 25

/**
 * How long one worker's claim on a session is respected. Past this the session
 * is assumed abandoned (the worker crashed) and may be claimed again — the cost
 * of being wrong is a duplicate cancellation mail, the cost of never expiring is
 * a session nothing will ever delete.
 */
export const SERIES_TEARDOWN_CLAIM_TTL_MS = 15 * 60 * 1000

/**
 * How long a `running` job may go without a heartbeat before a fresh teardown is
 * allowed to start anyway.
 *
 * A chain CAN die outright: if one round exhausts its Cloud Tasks retries,
 * nothing re-enqueues it and the job stays `running` with no worker behind it.
 * Without this the studio would be locked out of their own series for good —
 * the same dead end a `failed` job used to be.
 *
 * An hour is deliberately generous: a round may legitimately run for the 9-minute
 * function timeout and then be retried with backoff, so a shorter window would
 * declare a healthy job dead. It is safe to be wrong in the other direction
 * because a second worker cannot double-cancel anything — the per-session claim
 * (SERIES_TEARDOWN_CLAIM_TTL_MS, four times shorter) is what prevents that, and
 * the two jobs simply share the drain.
 */
export const SERIES_TEARDOWN_STALE_MS = 60 * 60 * 1000

/**
 * `running`  — a task is draining it, or is queued to.
 * `completed` — the scope is empty and every session was torn down.
 * `completed_with_errors` — the scope is drained except for `failed_ids`.
 * `failed`   — the run stopped early (too many failures, or the round cap).
 *
 * A terminal status is never re-opened; a retry is a NEW job.
 */
export type SeriesTeardownStatus = 'running' | 'completed' | 'completed_with_errors' | 'failed'

export function seriesTeardownIsTerminal(status: SeriesTeardownStatus): boolean {
  return status !== 'running'
}

export interface SeriesTeardownJob {
  id: string
  teamId: string
  seriesId: string
  /** The occurrence the studio actually clicked — the anchor for `cutoff`. */
  anchorSessionId: string
  /**
   * Sessions starting at or after this instant are in scope. Captured once, from
   * the anchor session, and never recomputed — see rule 1 in the header.
   */
  cutoff: Timestamp
  status: SeriesTeardownStatus
  /** Scope size measured once, at enqueue. Progress is `processed`/`total`. */
  total: number
  /** Sessions torn down so far (a session someone else deleted counts here). */
  processed: number
  notified: number
  notify_failed: number
  /** Sessions whose teardown threw. Skipped by later rounds; capped. */
  failed_ids: string[]
  /** Task invocations spent — the round cap's counter. */
  rounds: number
  created_at: Timestamp
  updated_at: Timestamp
  finished_at?: Timestamp | null
  createdBy: string
  /** Why a `failed` job stopped. Null on every other status. */
  error?: string | null
  /**
   * Whether each torn-down session mails its own roster. Absent reads as TRUE,
   * which is what every teardown started by "delete this and all following"
   * wants: those sessions have nothing in common but a recurrence rule, so one
   * notice each is one notice per thing the member lost.
   *
   * A COURSE is the case that needs it false. Its lessons are not thirteen
   * things somebody booked, they are one thing somebody bought, so cancelling it
   * is ONE message: nine enrolled people would otherwise receive a hundred and
   * seventeen mails, each correct and none of them the news. `cancelCourseBlock`
   * sends that message itself and sets this, which is why the flag lives on the
   * job rather than being inferred from the series: it describes the OPERATION,
   * not the documents. Cancelling ONE lesson of a course still mails the roster,
   * through the very same function, because there "no class this Wednesday" is
   * exactly the news.
   */
  notify?: boolean
}

/** Progress as a 0–1 fraction, safe on a zero-size scope. */
export function seriesTeardownProgress(job: Pick<SeriesTeardownJob, 'total' | 'processed'>): number {
  if (!job.total || job.total <= 0) return 1
  return Math.min(1, job.processed / job.total)
}
