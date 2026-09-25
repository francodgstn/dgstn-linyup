/**
 * WHOSE ROSTER AN EVENT INVITATION GOES TO, AND WHO MAY SEND IT.
 *
 * `sendEventInvitations` emails every roster contact of ONE studio. So "which
 * studio" is a security question — the answer decides whose members receive an
 * email written by the caller's event — and it is answered HERE, purely, with
 * the callable doing the reads. Same split as `checkinAuthorization.ts`, whose
 * header explains the class of bug this guards against: on an org event the
 * client names the studio, and an org is something any signed-in user can
 * create.
 *
 * WHAT WENT WRONG BEFORE:
 *
 *   - The callable resolved the studio as `event.teamId`, which an org event
 *     does not have, so a member studio opening its federation's event and
 *     pressing "Send invitations" got "Event has no team". An org event is
 *     published once and shown by every member studio; each studio inviting
 *     ITS OWN members to it is the point.
 *   - It checked nothing but `request.auth`. Any signed-in user who learned an
 *     event id could email that studio's whole roster.
 *
 * The rules, each load-bearing on its own:
 *
 *   1. A TEAM EVENT INVITES ITS OWN TEAM. `requestedTeamId` is not consulted on
 *      that branch, so the client cannot redirect it.
 *   2. AN ORG EVENT INVITES THE REQUESTED STUDIO, which must be linked to the
 *      event's organization (`org_teams/{teamId}`, absent status = active —
 *      the same fact `currentTeamInOrg` reads).
 *   3. THE CALLER MUST HOLD `events.manage` IN THE RESOLVED STUDIO — the
 *      capability the `events` rules gate editing on. Being an org admin does
 *      NOT authorize emailing a member studio's contacts: they are the studio's
 *      people, and the studio decides when to write to them.
 */

export interface InvitationAuthSnapshot {
  event: {
    exists: boolean
    scope?: string | null
    orgId?: string | null
    teamId?: string | null
    /** Legacy team events stored the tenant here. */
    teacher?: string | null
    deletedAt?: unknown
  }
  /** `teamId` from the client. Meaningful only on an org event. */
  requestedTeamId?: string | null
  /** `organizations/{event.orgId}/org_teams/{resolvedTeamId}`, null when unread. */
  orgTeamLink?: { exists: boolean; status?: string | null } | null
  /** Does the caller hold `events.manage` in the RESOLVED team? */
  callerCanManageEvents: boolean
}

export type InvitationRefusalCode =
  | 'not-found'
  | 'invalid-argument'
  | 'permission-denied'
  | 'failed-precondition'

export type InvitationAuthDecision =
  | { ok: true; teamId: string }
  | { ok: false; code: InvitationRefusalCode; message: string }

function refuse(code: InvitationRefusalCode, message: string): InvitationAuthDecision {
  return { ok: false, code, message }
}

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function isOrgScopedEvent(event: InvitationAuthSnapshot['event']): boolean {
  return event.scope === 'org' && cleanId(event.orgId) !== null
}

/**
 * The studio an invitation run targets, before any authority is checked — the
 * callable needs it to know which link and which membership to read.
 */
export function resolveInvitationTeamId(
  event: InvitationAuthSnapshot['event'],
  requestedTeamId: string | null | undefined,
): string | null {
  return isOrgScopedEvent(event)
    ? cleanId(requestedTeamId)
    : cleanId(event.teamId) ?? cleanId(event.teacher)
}

export function decideInvitationAuthorization(s: InvitationAuthSnapshot): InvitationAuthDecision {
  if (!s.event.exists) return refuse('not-found', 'Event not found')
  if (s.event.deletedAt != null) return refuse('failed-precondition', 'This event has been deleted')

  const isOrgEvent = isOrgScopedEvent(s.event)
  const teamId = resolveInvitationTeamId(s.event, s.requestedTeamId)

  if (!teamId) {
    return isOrgEvent
      ? refuse('invalid-argument', 'Choose the studio whose members should be invited')
      : refuse('failed-precondition', 'Event has no team')
  }

  if (isOrgEvent) {
    const link = s.orgTeamLink
    if (!link || !link.exists) {
      return refuse('permission-denied', 'That studio is not part of this organization')
    }
    if ((link.status ?? 'active') !== 'active') {
      return refuse('permission-denied', 'That studio is no longer part of this organization')
    }
  }

  if (!s.callerCanManageEvents) {
    return refuse('permission-denied', 'You do not have permission to send invitations for this studio')
  }

  return { ok: true, teamId }
}
