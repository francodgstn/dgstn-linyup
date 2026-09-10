/**
 * Renames the one per-entry field the mobile app's trial-anonymisation check
 * reads, on the `leaderboard/current` doc only — `leaderboard` is a REAL,
 * live subcollection (no dead-weight question here: it has no
 * packages/shared/src/paths.ts constant only because nobody added one, not
 * because the feature was retired — it is written by
 * packages/functions/src/utils/leaderboard.ts's `updateTeamLeaderboard`,
 * called from onSessionUpdate, the `recalculateScores` callable and the
 * scores-rebuild job, and read by apps/mobile/src/services/firestore.ts's
 * `getTeamLeaderboard` → apps/mobile/src/screens/ProfileScreen.tsx).
 *
 * ── THE BUG THIS RENAMES ────────────────────────────────────────────────────
 * hmd-lineup's updateTeamLeaderboard denormalises the retired `type` field
 * onto each entry: `{ contact_id, firstname, lastname, type, score, streak,
 * max_streak, rank }` (hmd-lineup/functions/src/utils/leaderboard.js:49-56).
 * Linyup's port denormalises `acquisition_stage` instead
 * (packages/functions/src/utils/leaderboard.ts:24-35) — a straight
 * consequence of the Contact.type → acquisition_stage axis change
 * (transforms/contacts.ts), not a leaderboard-specific decision. The
 * reader, ProfileScreen.tsx:729-734, uses exactly that field to anonymise a
 * still-trial contact's name on the leaderboard ("Anonymise not-yet-joined
 * (trial) members on the public leaderboard"): `isTrial =
 * entry.acquisition_stage === 'trial_booked' || 'trial_attended'`. A
 * migrated entry carries `type` but never `acquisition_stage`, so `isTrial`
 * is always false and a trial contact's full name is shown to every other
 * member/contact who can read this doc (firestore.rules:826-835 — team
 * members AND any contact of the team via their session token) until the
 * cache is next regenerated, which is not guaranteed to happen soon (no
 * trigger fires on session/participant CREATE or check-in — only on a
 * session's start/activityId being edited, a manual "Recalculate scores",
 * or the monthly reset).
 *
 * The mapping below is not a guess at a retired condition — it is a direct
 * consequence of this doc's OWN write filter. Every entry here has
 * `current_month_score > 0` (hmd-lineup/functions/src/utils/leaderboard.js:
 * 33, the query hmd-lineup's own updateTeamLeaderboard runs to select
 * entries), which is exactly the "hasAttended" signal
 * transforms/contacts.ts uses to decide `trial_attended` over
 * `trial_booked` (`totalSessions > 0`). So a scored `type: 'trial'` entry
 * can only be `trial_attended`, never `trial_booked` — there is no case
 * here transforms/contacts.ts's own logic would resolve differently.
 * `'student'` folds to `'joined'`; a scored `'external'` is `trial_attended`
 * too — the person attended and never joined THIS club (they land in the
 * Contact.external lifecycle bucket) — mirroring the same transform.
 */

// Mirrors transforms/contacts.ts: a scored entry has attended, so `trial` AND
// `external` both read `trial_attended` — an external never joined THIS club
// (they land in the Contact.external lifecycle bucket, journey from what they
// did), and the leaderboard entry must say the same thing the contact says or
// the mobile anonymisation check disagrees with the contact page. Only
// `student` is `joined`.
function mapEntryAcquisitionStage(type: unknown): 'trial_attended' | 'joined' {
  return type === 'trial' || type === 'external' ? 'trial_attended' : 'joined'
}

export function transformLeaderboardDoc(src: Record<string, unknown>): Record<string, unknown> {
  const entries = src.entries
  if (!Array.isArray(entries)) return src

  return {
    ...src,
    entries: entries.map((raw) => {
      const entry = raw as Record<string, unknown>
      if (!('type' in entry)) return entry
      const { type, ...rest } = entry
      return { ...rest, acquisition_stage: mapEntryAcquisitionStage(type) }
    }),
  }
}
