/**
 * WHO MAY CHECK WHOM IN, AND UNDER WHOSE TENANT STAMP.
 *
 * `checkins/{id}.teamId` IS the tenant boundary — every arm of the `checkins`
 * rule (read, update, delete) dereferences that one field and nothing else. So
 * the question "what teamId does this row carry" is a security question, not a
 * denormalisation convenience, and it is answered HERE rather than at the call
 * site.
 *
 * THE SPLIT is the one this codebase already uses for `decideWaiverGate` /
 * `enforceWaiverGate` and `resolvePaymentOptions` / `loadContactPaymentSnapshot`:
 * this module is PURE and exhaustively unit-tested (`*.test.ts` runs plain
 * mocha, no emulator), and the caller does the reads. A decision that needs a
 * Firestore handle to test is a decision nobody tests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WENT WRONG BEFORE, because the shape of the fix follows from it.
 *
 * The callable took `checkinTeamId` from the client and, on an org-scoped
 * event, stamped it VERBATIM. The gate in front of it asked only "are you an
 * org admin of this event's organization" — and `createOrganization` lets ANY
 * authenticated user mint an organization that writes them an `org_admin` row.
 * So the full path was: sign up, create your own organization, create an
 * org-scoped event in it, then post a check-in naming ANY team id in the
 * system. The row landed in that tenant, carrying attacker-chosen contact names
 * and an arbitrary payload, and the `checkins` trigger then wrote an
 * activity-log entry into the victim's own subtree quoting the attacker's text.
 * A cross-tenant write reachable by an unrelated outsider.
 *
 * Three rules follow, and each one is load-bearing on its own:
 *
 *   1. THE TARGET TEAM MUST BE IN THE EVENT'S ORGANIZATION. Membership is the
 *      `org_teams/{teamId}` link with `status == 'active'` — the same fact, read
 *      the same way, as the `currentTeamInOrg` rules helper. Without this the
 *      caller picks the tenant.
 *   2. AUTHORITY IS PER ORGANIZATION, NOT GLOBAL. Being an org admin somewhere
 *      authorizes nothing here; it has to be an org admin OF THIS EVENT'S org.
 *   3. NEVER STAMP AN ABSENT TEAM. An org event stores `teamId: null`, so the
 *      old fallback wrote `teamId: null` whenever the client omitted the field —
 *      a row no rule can match, readable and deletable by nobody. Refusing is
 *      better than writing data that cannot be reached again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO IS ALLOWED, and why it is wider than it was.
 *
 * A member studio's owner or manager may now check in AT AN ORG EVENT, for
 * their OWN team only. That is not a loosening — it closes a contradiction:
 * the `checkins` rule already lets that person UPDATE and DELETE a row stamped
 * with their team, and the roster UI already does exactly that with a direct
 * client write. Only CREATE went through this callable, so a coach at a
 * federation camp could tick a competitor off the list but not put them on it.
 * Commit 4060ed51 granted member studios read on an org event's categories and
 * attendees precisely so they could run the door; without this they still
 * cannot.
 *
 * Authority is checked against the RESOLVED team, so a manager of studio A can
 * never stamp studio B — the widening cannot be used to reach sideways.
 *
 * NOTE ON ROLE vs CAPABILITY: this checks the ROLE (owner/manager), matching
 * the `checkins` rule that governs these very rows (`hasTeamRole(teamId,
 * 'manager')`). The `events` rules gate on the `events.manage` CAPABILITY
 * instead, so a manager with that capability revoked cannot edit the event yet
 * can still record attendance at it. That divergence predates this module and
 * is left alone deliberately: aligning it would silently lock out anyone
 * currently running a door, and it belongs to the capability model, not here.
 */

/** The facts the decision needs. The caller reads them; this module judges. */
export interface CheckinAuthSnapshot {
  /** The event being checked into. `teamId` is null for an org-scoped event. */
  event: {
    exists: boolean
    scope?: string
    orgId?: string | null
    teamId?: string | null
    /** Legacy team events carry the owning uid here and no teamId. */
    teacher?: string | null
    deletedAt?: unknown
  }
  /** `checkinTeamId` from the client. Meaningful only on an org event. */
  requestedTeamId?: string | null
  /** `org_members/{uid}.role` in the EVENT'S organization, if any. */
  orgRole?: string | null
  /**
   * `organizations/{event.orgId}/org_teams/{resolvedTeamId}.status`, or null
   * when that link document does not exist. Absent status reads as 'active',
   * matching `currentTeamInOrg`'s `data.get('status', 'active')`.
   */
  orgTeamLink?: { exists: boolean; status?: string | null } | null
  /** `team_members/{uid}.role` in the RESOLVED team, if any. */
  teamRole?: string | null
  /** The contact being checked in, as stored. */
  contact?: { exists: boolean; teamId?: string | null } | null
  /** For the update path: the teamId already stamped on the existing row. */
  existingCheckinTeamId?: string | null
}

export type CheckinAuthDecision =
  | { ok: true; teamId: string }
  | { ok: false; code: CheckinRefusalCode; message: string }

export type CheckinRefusalCode =
  | 'not-found'
  | 'invalid-argument'
  | 'permission-denied'
  | 'failed-precondition'

function refuse(code: CheckinRefusalCode, message: string): CheckinAuthDecision {
  return { ok: false, code, message }
}

/** Trims and rejects the empty string — `?? ` does not catch `''`, and the
 *  roster's batch add sends `selectedAddTeamId || currentTeamId || ''`. */
function cleanId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const WRITE_ROLES = new Set(['owner', 'manager'])

/**
 * Decide the tenant stamp and whether the caller may write it.
 *
 * Order matters: every refusal here happens BEFORE the caller writes anything,
 * so a rejected attempt leaves no document, no counter change and no activity
 * log row.
 */
export function decideCheckinAuthorization(s: CheckinAuthSnapshot): CheckinAuthDecision {
  if (!s.event.exists) return refuse('not-found', 'Event not found.')

  if (s.event.deletedAt != null) {
    return refuse('failed-precondition', 'This event has been deleted.')
  }

  const isOrgEvent = s.event.scope === 'org' && cleanId(s.event.orgId) !== null

  // ── resolve the tenant stamp ────────────────────────────────────────────
  let teamId: string | null
  if (isOrgEvent) {
    // The client names the studio because an org event has none of its own.
    // It is a REQUEST, and everything below decides whether to honor it.
    teamId = cleanId(s.requestedTeamId)
    if (!teamId) {
      return refuse(
        'invalid-argument',
        'An organization event needs the studio the contact belongs to.',
      )
    }
  } else {
    // A team event carries its own. The client cannot influence this at all —
    // note that `requestedTeamId` is not consulted on this branch.
    teamId = cleanId(s.event.teamId)
    if (!teamId) {
      // A legacy event with only `teacher` and no teamId used to reach the
      // write with `resolvedTeamId === undefined` and fail as an unhandled
      // `internal`. A named refusal is the same outcome, legibly.
      return refuse(
        'failed-precondition',
        'This event has no studio recorded and cannot take check-ins.',
      )
    }
  }

  // ── the target team must belong to the event's organization ─────────────
  if (isOrgEvent) {
    const link = s.orgTeamLink
    if (!link || !link.exists) {
      return refuse('permission-denied', 'That studio is not part of this organization.')
    }
    // Absent status reads as active — the same default `currentTeamInOrg` uses.
    const status = link.status ?? 'active'
    if (status !== 'active') {
      return refuse('permission-denied', 'That studio is no longer part of this organization.')
    }
  }

  // ── authority ───────────────────────────────────────────────────────────
  // Both arms are evaluated against the RESOLVED team, never the requested
  // one, so neither can be used to reach into a studio the caller does not
  // hold. `orgRole` is the caller's role in THIS event's organization.
  const isOrgAdmin = isOrgEvent && s.orgRole === 'org_admin'
  const runsThisTeam = s.teamRole != null && WRITE_ROLES.has(s.teamRole)

  if (!isOrgAdmin && !runsThisTeam) {
    return refuse(
      'permission-denied',
      isOrgEvent
        ? 'Only an organization admin, or an owner or manager of the studio, can check people in at this event.'
        : 'Only owners and managers can manage check-ins.',
    )
  }

  // ── the contact must be a real contact of that team ─────────────────────
  // Without this the caller supplies both the contact id AND the display name,
  // so the row is free text wearing a person's shape. `contact` is optional in
  // the snapshot only so the type can express "not read yet"; the caller
  // always reads it.
  if (s.contact) {
    if (!s.contact.exists) return refuse('not-found', 'Contact not found.')
    if (cleanId(s.contact.teamId) !== teamId) {
      return refuse('permission-denied', 'That contact does not belong to this studio.')
    }
  }

  // ── an update may not move a row between tenants ────────────────────────
  // The existing row is found by (event, contact) across the WHOLE collection,
  // so without this an authorized caller could retarget somebody else's row by
  // naming their own team.
  if (s.existingCheckinTeamId != null && cleanId(s.existingCheckinTeamId) !== teamId) {
    return refuse(
      'permission-denied',
      'This contact is already checked in under a different studio.',
    )
  }

  return { ok: true, teamId }
}

/**
 * A ceiling on the stored payload. `checkin_data` is written verbatim under a
 * teamId the caller named, so an unbounded map is an arbitrary-content write
 * into somebody else's tenant, repeatable at will. The limits are deliberately
 * far above any real form — the built-in shapes carry a handful of keys — so
 * this refuses abuse without ever refusing use.
 */
export const CHECKIN_DATA_MAX_KEYS = 64
export const CHECKIN_DATA_MAX_BYTES = 16 * 1024

export function checkinDataIsAcceptable(
  data: unknown,
): { ok: true } | { ok: false; message: string } {
  if (data == null) return { ok: true }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'Check-in data must be an object.' }
  }
  const keys = Object.keys(data as Record<string, unknown>)
  if (keys.length > CHECKIN_DATA_MAX_KEYS) {
    return { ok: false, message: 'Check-in data has too many fields.' }
  }
  let size: number
  try {
    size = JSON.stringify(data).length
  } catch {
    // Circular, or otherwise not storable — Firestore would reject it anyway.
    return { ok: false, message: 'Check-in data could not be read.' }
  }
  if (size > CHECKIN_DATA_MAX_BYTES) {
    return { ok: false, message: 'Check-in data is too large.' }
  }
  return { ok: true }
}
