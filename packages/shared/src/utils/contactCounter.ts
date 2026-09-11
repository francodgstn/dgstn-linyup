// ─── The per-team live-contact counter ───────────────────────────────────────
//
// How many contacts a studio holds — stored, not counted on demand.
//
// WHY IT IS STORED. The operator console ran ONE count aggregation PER TEAM on
// every page view (docs/scalability-2026-09.md §17 B8), which grows with the
// TENANT count: a thousand studios meant a thousand aggregation round trips to
// draw one table. The number is now kept on a document the console already
// batches, so the table costs one read per tenant and no aggregation at all.
//
// WHY IT LIVES IN A SUBCOLLECTION AND NOT ON THE TEAM. Writing the team
// document fires `syncTeamPublicProfile`, which rebuilds the whole public
// mirror. A counter on the team doc would therefore turn every contact create,
// archive and delete into a public-profile rebuild — write amplification
// (§10) traded for a read saving, which is not a trade worth making.
//
// WHY DRIFT IS SURVIVABLE. The trigger applies DELTAS, and a delta counter
// drifts: a missed event, a retry, a manual repair in the console. So the
// nightly platform-metrics job — which already computes the authoritative
// number with a `count()` aggregation for its own snapshot — writes it back
// here. Drift lasts at most one night and cannot compound. That is also why
// the console must render a MISSING counter as unknown rather than as zero: a
// studio whose counter has never been written is not an empty studio, and
// `scripts/backfill-contact-counts.ts` is what stamps the ones that predate it.

import type { Timestamp } from '../types/common'

/** `teams/{teamId}/counters/contacts`. */
export interface TeamContactCounter {
  /**
   * LIVE contacts — `deleted_at` and `archived_at` both null.
   *
   * Deliberately NOT the roster: an EXTERNAL counts here, as it does toward the
   * contact cap, because this measures records held rather than people looked
   * after. Same definition as the nightly snapshot's `countActiveContacts` and
   * as `liveContactConstraints()` in the web app — all three must agree, which
   * is why this comment names the rule rather than pointing at one of them.
   */
  live: number
  /** When the counter was last touched, by either writer. */
  updated_at: Timestamp
  /** When the nightly job last replaced `live` with an authoritative count. */
  reconciled_at?: Timestamp | null
}

/** The fields the delta rule reads off a contact document. */
export interface ContactLivenessFields {
  teamId?: string | null
  deleted_at?: unknown
  archived_at?: unknown
}

/** Is this contact document LIVE — both markers clear? */
export function contactIsLiveForCount(c: ContactLivenessFields | null | undefined): boolean {
  if (!c) return false
  return c.deleted_at == null && c.archived_at == null
}

/**
 * What one contact write does to the counters — the ONE rule, so the trigger
 * cannot express it differently from the backfill or from a future caller.
 *
 * Returns a delta per affected team, which is why it is a LIST and not a
 * number: moving a contact between studios (`moveContacts`) takes one off the
 * old team and puts one on the new, and a rule that returned a single delta
 * would have silently dropped half of that.
 */
export function liveContactCountDeltas(
  before: ContactLivenessFields | null | undefined,
  after: ContactLivenessFields | null | undefined
): Array<{ teamId: string; delta: number }> {
  const byTeam = new Map<string, number>()
  const add = (teamId: string | null | undefined, delta: number) => {
    if (!teamId) return
    byTeam.set(teamId, (byTeam.get(teamId) ?? 0) + delta)
  }
  if (contactIsLiveForCount(before)) add(before!.teamId, -1)
  if (contactIsLiveForCount(after)) add(after!.teamId, +1)
  return [...byTeam.entries()]
    .filter(([, delta]) => delta !== 0)
    .map(([teamId, delta]) => ({ teamId, delta }))
}
