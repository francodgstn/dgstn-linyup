import assert from 'node:assert/strict'
import {
  resolveRoleCapabilities,
  roleHasCapability,
  dataScopeForRole,
  canManageRole,
  capabilityIsScoped,
  COACH_DEFAULT_CAPABILITIES,
  COACH_ASSIGNABLE_CAPABILITIES,
  ALL_CAPABILITIES,
  ROLE_RANK,
  coachLockReason,
} from '@linyup/shared'

describe('capabilities — system role sets', () => {
  it('owner has every capability', () => {
    for (const c of ALL_CAPABILITIES) assert.equal(roleHasCapability('owner', c), true)
  })

  it('manager has members.manage + offerings but NOT owner-only surfaces', () => {
    assert.equal(roleHasCapability('manager', 'members.manage'), true)
    assert.equal(roleHasCapability('manager', 'offerings.manage'), true)
    assert.equal(roleHasCapability('manager', 'reports.view'), true)
    assert.equal(roleHasCapability('manager', 'billing.manage'), false)
    assert.equal(roleHasCapability('manager', 'integrations.manage'), false)
    assert.equal(roleHasCapability('manager', 'plugins.manage'), false)
    assert.equal(roleHasCapability('manager', 'team.settings'), false)
  })

  it('viewer is read-only: can view contacts + schedule, cannot edit anything', () => {
    assert.equal(roleHasCapability('viewer', 'contacts.view'), true)
    assert.equal(roleHasCapability('viewer', 'contacts.view.all'), true)
    assert.equal(roleHasCapability('viewer', 'schedule.view'), true)
    assert.equal(roleHasCapability('viewer', 'contacts.manage'), false)
    assert.equal(roleHasCapability('viewer', 'contacts.delete'), false)
    assert.equal(roleHasCapability('viewer', 'schedule.manage'), false)
    assert.equal(roleHasCapability('viewer', 'activities.manage'), false)
    assert.equal(roleHasCapability('viewer', 'events.manage'), false)
    assert.equal(roleHasCapability('viewer', 'offerings.manage'), false)
    assert.equal(roleHasCapability('viewer', 'members.manage'), false)
  })
})

describe('capabilities — coach role', () => {
  it('defaults to own contacts + schedule (+ full-calendar read)', () => {
    assert.deepEqual(resolveRoleCapabilities('coach'), COACH_DEFAULT_CAPABILITIES)
    assert.equal(roleHasCapability('coach', 'contacts.manage'), true)
    assert.equal(roleHasCapability('coach', 'schedule.view.all'), true)
    assert.equal(roleHasCapability('coach', 'offerings.manage'), false)
    assert.equal(roleHasCapability('coach', 'members.manage'), false)
  })

  it('honors a team override but never grants owner-only or members.manage', () => {
    const override = resolveRoleCapabilities('coach', [
      'contacts.view',
      'reports.view',
      'billing.manage', // must be stripped
      'members.manage', // must be stripped
    ])
    assert.equal(override.includes('contacts.view'), true)
    assert.equal(override.includes('reports.view'), true)
    assert.equal(override.includes('billing.manage'), false)
    assert.equal(override.includes('members.manage'), false)
  })

  it('coach-assignable menu excludes owner-only + members.manage', () => {
    for (const forbidden of [
      'billing.manage',
      'plugins.manage',
      'members.manage',
      'team.settings',
    ] as const) {
      assert.equal(COACH_ASSIGNABLE_CAPABILITIES.includes(forbidden), false)
    }
  })

  // AN EMPTY OVERRIDE IS AN ANSWER, NOT THE ABSENCE OF ONE.
  //
  // The resolver used to test `coachOverride.length`, so a studio that switched
  // every coach switch off and saved silently got the five defaults back — in the
  // capabilities `syncMemberCapabilities` denormalizes onto each coach's member
  // document, which is what firestore.rules reads. The editor meanwhile showed
  // every switch off, because it distinguishes null from [] correctly. Screen and
  // enforcement disagreed, in the permissive direction.
  //
  // The three inputs are asserted together on purpose: the fix is a DISTINCTION
  // between two falsy-looking values, and a test that only pinned [] would pass
  // just as well against `return coachOverride ?? DEFAULT`, which breaks the
  // undefined case that every un-customized team is in.
  it('distinguishes an empty override from no override at all', () => {
    assert.deepEqual(resolveRoleCapabilities('coach', []), [], 'empty = granted nothing')
    assert.deepEqual(resolveRoleCapabilities('coach', null), COACH_DEFAULT_CAPABILITIES)
    assert.deepEqual(resolveRoleCapabilities('coach', undefined), COACH_DEFAULT_CAPABILITIES)
    // …and the same distinction through the predicate the callables ask.
    assert.equal(roleHasCapability('coach', 'contacts.manage', []), false)
    assert.equal(roleHasCapability('coach', 'contacts.manage', null), true)
  })

  // A LOCK NAMES ITS WALL. Derived from the sets, never retyped: members.manage is
  // the one a coach cannot hold that is NOT owner-only, and the editor must not
  // tell a studio "owners only" about a capability its managers are using.
  it('coachLockReason separates the owner-only wall from the manager wall', () => {
    assert.equal(coachLockReason('members.manage'), 'owners_and_managers')
    for (const ownerOnly of [
      'team.settings',
      'billing.manage',
      'integrations.manage',
      'plugins.manage',
    ] as const) {
      assert.equal(coachLockReason(ownerOnly), 'owners_only')
    }
    for (const grantable of COACH_ASSIGNABLE_CAPABILITIES) {
      assert.equal(coachLockReason(grantable), null)
    }
    // Every capability is either grantable or locked with a stated reason — no
    // row can render a lock icon with nothing beside it.
    for (const cap of ALL_CAPABILITIES) {
      const locked = coachLockReason(cap) !== null
      assert.equal(locked, !COACH_ASSIGNABLE_CAPABILITIES.includes(cap))
    }
  })
})

describe('capabilities — scope + rank', () => {
  it('coach is own-scoped, system roles are all-scoped', () => {
    assert.equal(dataScopeForRole('coach'), 'own')
    assert.equal(dataScopeForRole('owner'), 'all')
    assert.equal(dataScopeForRole('manager'), 'all')
    assert.equal(dataScopeForRole('viewer'), 'all')
  })

  it('rank governs who can manage whom', () => {
    assert.equal(canManageRole('owner', 'manager'), true)
    assert.equal(canManageRole('manager', 'coach'), true)
    assert.equal(canManageRole('manager', 'viewer'), true)
    assert.equal(canManageRole('coach', 'viewer'), true)
    assert.equal(canManageRole('manager', 'owner'), false)
    assert.equal(canManageRole('coach', 'manager'), false)
    assert.equal(canManageRole('viewer', 'viewer'), false)
    assert.ok(ROLE_RANK.owner > ROLE_RANK.manager)
    assert.ok(ROLE_RANK.manager > ROLE_RANK.coach)
    assert.ok(ROLE_RANK.coach > ROLE_RANK.viewer)
  })

  it('scoped flag marks the own-vs-all capabilities', () => {
    assert.equal(capabilityIsScoped('contacts.manage'), true)
    assert.equal(capabilityIsScoped('schedule.manage'), true)
    assert.equal(capabilityIsScoped('offerings.manage'), false)
    assert.equal(capabilityIsScoped('members.manage'), false)
  })
})
