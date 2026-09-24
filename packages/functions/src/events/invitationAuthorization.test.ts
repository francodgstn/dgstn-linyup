import { strict as assert } from 'assert'
import {
  decideInvitationAuthorization,
  resolveInvitationTeamId,
  type InvitationAuthSnapshot,
} from './invitationAuthorization'

const ORG = 'org-fed'
const TEAM = 'team-basel'

function teamEvent(over: Partial<InvitationAuthSnapshot> = {}): InvitationAuthSnapshot {
  return {
    event: { exists: true, scope: 'team', teamId: TEAM, orgId: null, deletedAt: null },
    callerCanManageEvents: true,
    ...over,
  }
}

function orgEvent(over: Partial<InvitationAuthSnapshot> = {}): InvitationAuthSnapshot {
  return {
    event: { exists: true, scope: 'org', teamId: null, orgId: ORG, deletedAt: null },
    requestedTeamId: TEAM,
    orgTeamLink: { exists: true, status: 'active' },
    callerCanManageEvents: true,
    ...over,
  }
}

describe('decideInvitationAuthorization', () => {
  describe('team event', () => {
    it('invites the event’s own team', () => {
      assert.deepEqual(decideInvitationAuthorization(teamEvent()), { ok: true, teamId: TEAM })
    })

    it('ignores a requested team — the client cannot redirect a team event', () => {
      const d = decideInvitationAuthorization(teamEvent({ requestedTeamId: 'team-victim' }))
      assert.deepEqual(d, { ok: true, teamId: TEAM })
    })

    it('falls back to the legacy `teacher` tenant', () => {
      const d = decideInvitationAuthorization(
        teamEvent({ event: { exists: true, teamId: null, teacher: TEAM } }),
      )
      assert.deepEqual(d, { ok: true, teamId: TEAM })
    })

    it('refuses a caller without events.manage — signing in is not enough', () => {
      const d = decideInvitationAuthorization(teamEvent({ callerCanManageEvents: false }))
      assert.equal(d.ok, false)
      assert.equal(!d.ok && d.code, 'permission-denied')
    })

    it('refuses an event with no tenant at all', () => {
      const d = decideInvitationAuthorization(
        teamEvent({ event: { exists: true, scope: 'team', teamId: null } }),
      )
      assert.equal(!d.ok && d.code, 'failed-precondition')
    })
  })

  describe('org event', () => {
    it('invites the requested member studio — the "Event has no team" regression', () => {
      assert.deepEqual(decideInvitationAuthorization(orgEvent()), { ok: true, teamId: TEAM })
    })

    it('asks which studio when none is named', () => {
      const d = decideInvitationAuthorization(orgEvent({ requestedTeamId: '  ' }))
      assert.equal(!d.ok && d.code, 'invalid-argument')
    })

    it('refuses a studio that is not linked to the event’s organisation', () => {
      const d = decideInvitationAuthorization(orgEvent({ orgTeamLink: { exists: false } }))
      assert.equal(!d.ok && d.code, 'permission-denied')
    })

    it('refuses a studio whose link is no longer active', () => {
      const d = decideInvitationAuthorization(
        orgEvent({ orgTeamLink: { exists: true, status: 'removed' } }),
      )
      assert.equal(!d.ok && d.code, 'permission-denied')
    })

    it('reads an absent link status as active, like currentTeamInOrg', () => {
      const d = decideInvitationAuthorization(orgEvent({ orgTeamLink: { exists: true } }))
      assert.deepEqual(d, { ok: true, teamId: TEAM })
    })

    it('refuses a caller without events.manage in the requested studio', () => {
      const d = decideInvitationAuthorization(orgEvent({ callerCanManageEvents: false }))
      assert.equal(!d.ok && d.code, 'permission-denied')
    })
  })

  it('refuses a missing or deleted event', () => {
    assert.equal(
      decideInvitationAuthorization(teamEvent({ event: { exists: false } })).ok,
      false,
    )
    const deleted = decideInvitationAuthorization(
      teamEvent({ event: { exists: true, teamId: TEAM, deletedAt: { seconds: 1 } } }),
    )
    assert.equal(!deleted.ok && deleted.code, 'failed-precondition')
  })
})

describe('resolveInvitationTeamId', () => {
  it('uses the requested team only on an org event', () => {
    assert.equal(resolveInvitationTeamId({ exists: true, scope: 'org', orgId: ORG }, TEAM), TEAM)
    assert.equal(
      resolveInvitationTeamId({ exists: true, scope: 'team', teamId: 'own' }, TEAM),
      'own',
    )
  })
})
