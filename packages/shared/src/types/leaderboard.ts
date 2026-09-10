// The team's monthly leaderboard — `teams/{teamId}/leaderboard/current`, ONE
// denormalised document written by `updateTeamLeaderboard`
// (packages/functions/src/utils/leaderboard.ts) and READ, never queried, by
// the admin, the member Space and the member app.
//
// The row shape was declared on both member surfaces separately (mobile's
// `LeaderboardEntry`, the Space's `SpaceLeaderboardEntry`) and the two had
// already parted on `acquisition_stage`'s nullability, while the writer never
// declared the shape at all. Owned here so the three agree by construction.

import type { Timestamp } from './common'

export interface LeaderboardEntry {
  contact_id: string
  firstname: string
  lastname: string
  /** The stage of a not-yet-joined contact — what `leaderboardDisplayName`
   *  anonymises on. Absent or null for a member. */
  acquisition_stage?: string | null
  score: number
  /** 1-based position. */
  rank: number
  streak: number
  max_streak?: number
}

export interface TeamLeaderboard {
  /** `YYYY-MM`. */
  month: string
  /** Scored contacts only (`current_month_score > 0`), rank ascending. */
  entries: LeaderboardEntry[]
  entries_count: number
  /** Up to twelve months of `final_score` per listed contact, oldest first —
   *  for a sparkline; absent for a contact with no scored history. */
  score_history?: Record<string, Array<{ month: string; score: number }>>
  updated_at: Timestamp
}
