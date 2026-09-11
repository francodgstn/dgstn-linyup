// ─── The member's own attendance (getMyAttendance) ───────────────────────────
//
// The wire shape of "which sessions did I actually attend, in this window" —
// the question the member app's calendar and training chart ask, and the one
// they used to answer with a document read PER SESSION in the window
// (docs/scalability-2026-09.md §17 C1). A month at a busy studio was 150–200
// reads per calendar open, per member; the chart repeated it over its weeks.
//
// One collection-group query over HER OWN attendance rows answers it instead.
// The rows are `sessions/{id}/participants/{contactId}` — the document id IS
// the contact id — and `firestore.rules` lets a contact read her own row but
// never LIST across sessions, which is why this is a callable and not a client
// query.

/** One session the contact attended. */
export interface MyAttendance {
  sessionId: string
  activityId: string | null
  activityName: string | null
  /** ISO 8601. The SESSION's clock, not the check-in's — see the callable. */
  start: string | null
  end: string | null
  location: string | null
  providerName: string | null
}

export interface MyAttendanceResult {
  /** Sessions whose START falls in the requested window, soonest first. */
  attended: MyAttendance[]
  /**
   * The scan hit its page cap, so there may be attendance in this window that
   * is not listed.
   *
   * Honest truncation rather than a silently short answer: a member reading a
   * calendar with days missing has no way to tell that from not having trained.
   * In practice it is unreachable — the cap covers years of one person's
   * attendance — and it exists so that "in practice" never has to be trusted.
   */
  truncated: boolean
  /** How many of her attendance rows the server walked. Diagnostics only. */
  scanned: number
}
