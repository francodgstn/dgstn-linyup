import { strict as assert } from 'assert'
import {
  decideCheckinAuthorization,
  checkinDataIsAcceptable,
  CHECKIN_DATA_MAX_KEYS,
  CHECKIN_DATA_MAX_BYTES,
  type CheckinAuthSnapshot,
} from './checkinAuthorization'

/**
 * The vulnerability these fixtures exist for, stated once so the cases below
 * read as consequences rather than as a list:
 *
 *   `checkins/{id}.teamId` is the tenant boundary. It used to be copied
 *   verbatim from a client field on any org-scoped event, behind a gate that
 *   asked only "are you an org admin of this event's org" — and any
 *   authenticated user can mint an organization that makes them one. So an
 *   outsider could write a row, with contact names and payload of their
 *   choosing, into ANY tenant in the system.
 *
 * `ORG` below is the ATTACKER'S organization in the escalation cases, which is
 * the whole point: they really are an org admin, of an org the victim has
 * never heard of.
 */

const ORG = 'org-hmd'
const TEAM = 'team-basel'
const OTHER_TEAM = 'team-victim'
const CONTACT_TEAM = TEAM

/** A valid org-event snapshot; each test spreads its own deviation over it. */
function orgEvent(over: Partial<CheckinAuthSnapshot> = {}): CheckinAuthSnapshot {
  return {
    event: { exists: true, scope: 'org', orgId: ORG, teamId: null, deletedAt: null },
    requestedTeamId: TEAM,
    orgRole: 'org_admin',
    orgTeamLink: { exists: true, status: 'active' },
    teamRole: null,
    contact: { exists: true, teamId: CONTACT_TEAM },
    ...over,
  }
}

/** A valid team-event snapshot. */
function teamEvent(over: Partial<CheckinAuthSnapshot> = {}): CheckinAuthSnapshot {
  return {
    event: { exists: true, scope: 'team', orgId: null, teamId: TEAM, deletedAt: null },
    orgRole: null,
    orgTeamLink: null,
    teamRole: 'manager',
    contact: { exists: true, teamId: CONTACT_TEAM },
    ...over,
  }
}

function refusal(s: CheckinAuthSnapshot) {
  const d = decideCheckinAuthorization(s)
  assert.equal(d.ok, false, 'expected a refusal, got an approval')
  return d as { ok: false; code: string; message: string }
}

function approval(s: CheckinAuthSnapshot) {
  const d = decideCheckinAuthorization(s)
  assert.equal(d.ok, true, `expected an approval, got: ${JSON.stringify(d)}`)
  return d as { ok: true; teamId: string }
}

describe('decideCheckinAuthorization — the tenant stamp', () => {
  it('THE ESCALATION: an org admin cannot stamp a team outside their organization', () => {
    // The attacker owns ORG and is genuinely its admin. They name a team that
    // has no link document in it. Before the fix this wrote into that tenant.
    const d = refusal(orgEvent({ requestedTeamId: OTHER_TEAM, orgTeamLink: { exists: false } }))
    assert.equal(d.code, 'permission-denied')
    assert.match(d.message, /not part of this organization/)
  })

  it('a studio whose membership has lapsed is refused too', () => {
    const d = refusal(orgEvent({ orgTeamLink: { exists: true, status: 'removed' } }))
    assert.equal(d.code, 'permission-denied')
  })

  it('an absent status reads as active, matching the currentTeamInOrg rule', () => {
    // `data.get('status', 'active')` in firestore.rules. A link written before
    // the field existed must not lock a studio out.
    assert.equal(approval(orgEvent({ orgTeamLink: { exists: true, status: null } })).teamId, TEAM)
  })

  it('never stamps a null team: an org event with no requested studio is refused', () => {
    // The old fallback was `checkinTeamId ?? event.teamId`, and an org event
    // stores teamId: null — so this wrote a row no rule can ever match.
    const d = refusal(orgEvent({ requestedTeamId: null }))
    assert.equal(d.code, 'invalid-argument')
  })

  it('never stamps an empty-string team — `??` does not catch it, the roster sends it', () => {
    // `selectedAddTeamId || currentTeamId || ''`
    const d = refusal(orgEvent({ requestedTeamId: '' }))
    assert.equal(d.code, 'invalid-argument')
  })

  it('trims a padded team id rather than stamping whitespace', () => {
    assert.equal(approval(orgEvent({ requestedTeamId: `  ${TEAM}  ` })).teamId, TEAM)
  })

  it('a TEAM event ignores the requested team entirely', () => {
    // The client cannot influence the stamp on a team event at all.
    const d = approval(teamEvent({ requestedTeamId: OTHER_TEAM }))
    assert.equal(d.teamId, TEAM)
  })
})

describe('decideCheckinAuthorization — authority', () => {
  it('an org admin of ANOTHER organization is refused', () => {
    // Authority is per organization. `orgRole` is the caller's role in THIS
    // event's org, so "admin somewhere" is not expressible as an approval.
    const d = refusal(orgEvent({ orgRole: null, teamRole: null }))
    assert.equal(d.code, 'permission-denied')
  })

  it('THE WIDENING: a member studio manager may check in at an org event', () => {
    // Closes the contradiction with the checkins rule, which already lets this
    // person UPDATE and DELETE such a row.
    const d = approval(orgEvent({ orgRole: null, teamRole: 'manager' }))
    assert.equal(d.teamId, TEAM)
  })

  it('and an owner may too', () => {
    assert.equal(approval(orgEvent({ orgRole: null, teamRole: 'owner' })).teamId, TEAM)
  })

  it('but a plain member of that studio may not', () => {
    assert.equal(refusal(orgEvent({ orgRole: null, teamRole: 'coach' })).code, 'permission-denied')
  })

  it('the widening cannot reach sideways: team authority is read for the RESOLVED team', () => {
    // A manager of TEAM naming OTHER_TEAM has no team_members row there, so
    // `teamRole` arrives null and there is no arm left to approve them.
    const d = refusal(
      orgEvent({
        requestedTeamId: OTHER_TEAM,
        orgRole: null,
        teamRole: null,
        orgTeamLink: { exists: true, status: 'active' },
        contact: { exists: true, teamId: OTHER_TEAM },
      }),
    )
    assert.equal(d.code, 'permission-denied')
  })

  it('a team event refuses a non-member outright', () => {
    assert.equal(refusal(teamEvent({ teamRole: null })).code, 'permission-denied')
  })
})

describe('decideCheckinAuthorization — the contact', () => {
  it('refuses a contact that does not exist', () => {
    assert.equal(refusal(orgEvent({ contact: { exists: false } })).code, 'not-found')
  })

  it('refuses a contact belonging to a different studio', () => {
    // Otherwise the caller supplies the id AND the display name, and the row is
    // free text wearing a person's shape.
    const d = refusal(orgEvent({ contact: { exists: true, teamId: OTHER_TEAM } }))
    assert.equal(d.code, 'permission-denied')
    assert.match(d.message, /does not belong to this studio/)
  })

  it('refuses a contact with no team at all', () => {
    assert.equal(refusal(orgEvent({ contact: { exists: true, teamId: null } })).code, 'permission-denied')
  })
})

describe('decideCheckinAuthorization — updating an existing row', () => {
  it('refuses to move a row between tenants', () => {
    // The existing row is found by (event, contact) across the WHOLE
    // collection, so without this an authorized caller could retarget somebody
    // else's row by naming their own team.
    const d = refusal(orgEvent({ existingCheckinTeamId: OTHER_TEAM }))
    assert.equal(d.code, 'permission-denied')
  })

  it('allows an update that stays in the same tenant', () => {
    assert.equal(approval(orgEvent({ existingCheckinTeamId: TEAM })).teamId, TEAM)
  })
})

describe('decideCheckinAuthorization — the event itself', () => {
  it('refuses a missing event', () => {
    assert.equal(refusal(orgEvent({ event: { exists: false } })).code, 'not-found')
  })

  it('refuses a soft-deleted event rather than counting a check-in into it', () => {
    const d = refusal(orgEvent({ event: { exists: true, scope: 'org', orgId: ORG, deletedAt: 'x' } }))
    assert.equal(d.code, 'failed-precondition')
  })

  it('refuses a legacy team event that has only `teacher` and no teamId', () => {
    // This used to reach the write with an undefined stamp and fail as an
    // unhandled `internal`. Same outcome, legibly.
    const d = refusal(
      teamEvent({ event: { exists: true, scope: 'team', teamId: null, teacher: 'uid-1' } }),
    )
    assert.equal(d.code, 'failed-precondition')
  })

  it('an event whose scope says org but carries no orgId is treated as a team event', () => {
    // It cannot be an org event without an org, and falling through to the team
    // branch means it is judged on its own teamId rather than a client's.
    const d = approval(
      teamEvent({ event: { exists: true, scope: 'org', orgId: null, teamId: TEAM } }),
    )
    assert.equal(d.teamId, TEAM)
  })
})

describe('checkinDataIsAcceptable', () => {
  it('accepts a normal payload and an absent one', () => {
    assert.equal(checkinDataIsAcceptable({ categories: ['a'], weight: 67.5 }).ok, true)
    assert.equal(checkinDataIsAcceptable(undefined).ok, true)
    assert.equal(checkinDataIsAcceptable({}).ok, true)
  })

  it('refuses a non-object, which would otherwise be stored verbatim', () => {
    assert.equal(checkinDataIsAcceptable('nope').ok, false)
    assert.equal(checkinDataIsAcceptable([1, 2, 3]).ok, false)
  })

  it('refuses an unbounded key count', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i <= CHECKIN_DATA_MAX_KEYS; i++) wide[`k${i}`] = i
    assert.equal(checkinDataIsAcceptable(wide).ok, false)
  })

  it('refuses an oversized payload', () => {
    assert.equal(checkinDataIsAcceptable({ blob: 'x'.repeat(CHECKIN_DATA_MAX_BYTES) }).ok, false)
  })

  it('refuses a circular payload instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.equal(checkinDataIsAcceptable(circular).ok, false)
  })

  it('leaves real check-in shapes comfortably inside the limits', () => {
    // The guard must never refuse use — only abuse.
    assert.equal(checkinDataIsAcceptable({ disciplines: { hmd: 0, kd: 3 } }).ok, true)
    assert.equal(checkinDataIsAcceptable({ join_as: 'support' }).ok, true)
  })
})
