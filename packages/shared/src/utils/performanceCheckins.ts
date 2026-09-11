// A performance check-in, as every writer stores it, and the ONE rule that
// there is one per day per author.
//
// Three surfaces write `contacts/{id}/performance_checkins` — the member app,
// the member Space and the coach's tab — and "one check-in per day per author"
// was implemented three ways: the app with a range query, the Space with an
// in-memory scan of its most recent page, the coach's tab not at all, so a coach
// could leave several 1:1 check-ins on one day. The QUERY STRATEGY may
// legitimately differ (an index the app has and the Space does not); the
// PAYLOAD and the SAME-DAY PREDICATE may not, and they live here.
//
// `taken_at` is the caller's: a client `Timestamp.now()` on the member
// surfaces, a server sentinel on the coach's tab. That difference is deliberate
// and is exactly what the day window compares, so the day is always the
// CALLER's local calendar day — `sameDayCheckin` is asked with the same clock
// that stamped the row.

import { detectPerformanceProfile } from '../types/goal'
import type { GoalCreatedBy, PerformanceCheckin, PerformanceContext } from '../types/goal'

export interface PerformanceCheckinInput {
  /** dimension key → 1–5 */
  scores: Record<string, number>
  notes?: string | null
  filled_by: GoalCreatedBy
  context: PerformanceContext
}

/** The stored document, with `taken_at` in whatever form the writer stamps it. */
export type PerformanceCheckinDoc<TS> = Omit<PerformanceCheckin, 'id' | 'taken_at'> & {
  taken_at: TS
}

/**
 * The document every writer stores: scores, trimmed notes (null when empty),
 * author, context, the profile heuristic run ONCE here, and the caller's
 * `taken_at`. There is no Cloud Function trigger for the profile yet, so a
 * writer that skipped it would store raw scores and no profile at all.
 */
export function buildPerformanceCheckin<TS>(
  input: PerformanceCheckinInput,
  takenAt: TS,
): PerformanceCheckinDoc<TS> {
  return {
    taken_at: takenAt,
    filled_by: input.filled_by,
    context: input.context,
    scores: input.scores,
    notes: input.notes?.trim() || null,
    ...detectPerformanceProfile(input.scores),
  }
}

/** Same calendar day in the runtime's local zone. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** The first and last instant of `day` in the local zone — for a writer that
 *  dedupes with a range query rather than over rows in hand. */
export function localDayBounds(day: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(day)
  start.setHours(0, 0, 0, 0)
  const end = new Date(day)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

/**
 * THE one-per-day-per-author rule, asked of rows already in hand: today's
 * check-in by `filledBy`, if there is one — the row a second check-in the same
 * day OVERWRITES rather than sits beside (a correction five minutes later must
 * not leave two rows for one day).
 */
export function sameDayCheckin<T extends { filled_by: GoalCreatedBy; taken_at: { toDate(): Date } }>(
  rows: readonly T[],
  filledBy: GoalCreatedBy,
  now: Date = new Date(),
): T | undefined {
  return rows.find((r) => r.filled_by === filledBy && isSameLocalDay(r.taken_at.toDate(), now))
}
