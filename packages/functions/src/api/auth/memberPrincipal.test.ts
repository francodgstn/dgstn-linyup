import assert from 'node:assert/strict'
import { API_SCOPES, memberDataScope, type Capability, type TeamRole } from '@linyup/shared'
import { decideMemberPrincipal, principalMay, principalSeesContact, type ApiPrincipal } from './principal'

// THE MEMBER PRINCIPAL — no key, no grant: the member signed in to the web app,
// asking through the in-app assistant. It must hold the same two promises the
// credentialed principals do: live, not granted; narrower than the role, never wider.

const withoutPii = API_SCOPES.filter((s) => s !== 'contacts:read:pii')

function member(role: TeamRole, capabilities?: Capability[]) {
  return { role, ...(capabilities ? { capabilities } : {}) }
}

function principal(decision: ReturnType<typeof decideMemberPrincipal>): ApiPrincipal {
  assert.ok('principal' in decision, `expected a principal, got ${JSON.stringify(decision)}`)
  return decision.principal
}

describe('member principal', () => {
  it('refuses someone who is not on the team', () => {
    assert.deepEqual(decideMemberPrincipal('t', 'u', null, null, withoutPii), { refusal: 'not_a_member' })
  })

  it('carries no credential and nothing to touch', () => {
    const p = principal(decideMemberPrincipal('t', 'u', member('owner', ['contacts.view']), null, withoutPii))
    assert.deepEqual(p.via, { kind: 'member' })
    assert.equal(p.lastUsedAtMs, null)
    assert.equal(p.teamId, 't')
    assert.equal(p.uid, 'u')
  })

  it('never widens a role: a scope asked for but not held by the role is unusable', () => {
    const viewer = principal(decideMemberPrincipal('t', 'u', member('viewer', ['schedule.view']), null, withoutPii))
    assert.ok(viewer.scopes.has('reports:read'), 'the scope was asked for')
    assert.equal(principalMay(viewer, 'reports:read'), false, 'but the role does not hold reports.view')
    assert.equal(principalMay(viewer, 'schedule:read'), true)
  })

  it('withholds contact details when they are not asked for, whatever the role', () => {
    const owner = principal(decideMemberPrincipal('t', 'u', member('owner', ['contacts.view']), null, withoutPii))
    assert.equal(principalMay(owner, 'contacts:read'), true)
    assert.equal(principalMay(owner, 'contacts:read:pii'), false)
  })

  it('keeps a coach to their own people', () => {
    const m = member('coach', ['contacts.view'])
    const coach = principal(decideMemberPrincipal('t', 'coach-1', m, null, withoutPii))
    assert.equal(coach.dataScope, memberDataScope(m as Parameters<typeof memberDataScope>[0]))
    assert.equal(principalSeesContact(coach, { assigned_coach_ids: ['coach-1'], createdBy: 'someone' }), true)
    if (coach.dataScope === 'own') {
      assert.equal(principalSeesContact(coach, { assigned_coach_ids: ['other'], createdBy: 'someone' }), false)
    }
  })

  it('uses the resolved capabilities for a member document that predates them', () => {
    const p = principal(decideMemberPrincipal('t', 'u', member('manager'), ['reports.view', 'schedule.view'], withoutPii))
    assert.equal(principalMay(p, 'reports:read'), true)
    assert.ok(p.capabilities.has('schedule.view'))
  })
})
