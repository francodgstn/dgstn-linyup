/**
 * Does `candidate` move a contact's `last_session_at` forward?
 *
 * `trackSessionParticipants` is handed ONE attendance row at a time and used to
 * write that row's session start unconditionally, so whichever trigger ran last
 * decided the contact's "last session". Rows created one by one in real use
 * arrive roughly in date order and that happened to be right; a bulk import
 * writes years of attendance at once, the triggers finish in any order, and the
 * stored date became an arbitrary old session — contacts who trained last week
 * read "Stopped", and the AI summary called their last class years ago.
 *
 * The rule is a high-water mark: write only a strictly later date. Asked inside
 * the trigger's transaction against the value it re-reads, so two triggers
 * racing cannot put the older date back. Removing an attendance row does NOT
 * move the date back — nothing stored says which row was the latest before it;
 * `pnpm backfill:contact-attendance` recounts both fields absolutely.
 */
export function advancesLastSession(stored: unknown, candidate: unknown): boolean {
  const next = millisOf(candidate)
  if (next == null) return false
  const current = millisOf(stored)
  return current == null || next > current
}

function millisOf(value: unknown): number | null {
  if (value == null) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const t = value as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof t.toMillis === 'function') return t.toMillis()
  const seconds = t.seconds ?? t._seconds
  return typeof seconds === 'number' ? seconds * 1000 : null
}
