// ─── Team notifications (teams/{teamId}/notifications) ───────────────────────
//
// The studio-facing inbox: something happened that a manager should look at.
// Function-written only (`allow create/delete: if false`); clients read and
// mark read.
//
// ─── WHY THIS TYPE EXISTS ────────────────────────────────────────────────────
//
// It didn't, and the shape was hand-rolled at every end: the org writer built
// its document inline, and the dashboard banner declared a private interface to
// read it back. Two independent descriptions of one document, with nothing
// holding them together — which is exactly the arrangement that let the contact
// alerts grow two incompatible shapes and a reader that silently matched
// neither. Add a field HERE and through `createTeamNotification`, never at a
// call site.
//
// ─── WHY `team_alerts` IS NOT THIS ───────────────────────────────────────────
//
// `teams/{teamId}/team_alerts` was a second, parallel attempt at the same idea.
// It had two writers, ZERO readers, no `link` and no `status`, and rules that
// let a coach READ an alert they had no permission to dismiss — a notification
// nobody could clear. Its writers now come here instead. The collection, its
// rules and its indexes are left standing (deleting them would strand existing
// documents for no gain), but nothing writes it any more.
//
// The audience is deliberately MANAGER/OWNER, matching the rules on both read
// and update: everyone who can see one of these can also clear it. Team-wide
// dismissal is the model — `status` lives on the document, not per user — so
// one manager clearing an item clears it for the studio.

import type { Timestamp } from './common'

/**
 * What happened. Open vocabulary in practice — a reader must tolerate a `type`
 * it does not know rather than dropping the row, because a function deployed
 * ahead of the web app will write one.
 */
export type TeamNotificationType =
  | 'org_access_request'
  | 'contact_request'
  | 'form_submission'

export interface TeamNotification {
  id: string
  type: TeamNotificationType | string
  /** One line, already localised at write time by the function. */
  title: string
  /** The detail under the title. May be empty. */
  body: string
  /** Team-wide: one manager clearing it clears it for everyone. */
  status: 'unread' | 'read'
  /**
   * In-app destination, e.g. `/contacts/abc123` or `/settings?tab=org`.
   * A notification you cannot act on is a dead end, so every writer should
   * set one where a destination exists.
   */
  link?: string | null
  created_at?: Timestamp | null
  read_at?: Timestamp | null
  /** TTL stamp — `LEDGER_RETENTION_DAYS.notifications` after creation, written
   *  by `createTeamNotification` and deleted on by Firestore's TTL policy
   *  (firestore.index.json). Absent on rows written before the policy existed
   *  until `pnpm backfill:ledger-ttl` stamps them. */
  expires_at?: Timestamp | null

  // ── Type-specific payload ──────────────────────────────────────────────────
  // Denormalised for display and deep-linking. Readers must treat every one of
  // these as optional: they are present only for the `type` that writes them.
  orgId?: string | null
  orgName?: string | null
  contact_id?: string | null
  contact_name?: string | null
  request_id?: string | null
  form_id?: string | null
  submission_id?: string | null
}
