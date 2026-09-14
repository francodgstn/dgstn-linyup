import * as assert from 'node:assert'
import { Timestamp } from 'firebase-admin/firestore'
import type { ApiCredential } from '@linyup/shared'
import {
  bearerToken,
  decideApiPrincipal,
  principalMay,
  principalSeesContact,
  principalSeesSession,
  type ApiPrincipal,
  type PrincipalFacts,
} from './principal'

const NOW = Date.UTC(2026, 8, 14, 12)

function credential(over: Partial<ApiCredential> = {}): ApiCredential {
  return {
    kind: 'api_key',
    teamId: 'team-1',
    uid: 'owner-1',
    parent_id: 'key-1',
    scopes: ['contacts:read', 'schedule:read', 'reports:read'],
    resource: null,
    client_id: null,
    redirect_uri: null,
    code_challenge: null,
    used_at: null,
    created_at: Timestamp.fromMillis(NOW - 1000),
    expires_at: null,
    ...over,
  }
}

function facts(over: Partial<PrincipalFacts> = {}): PrincipalFacts {
  return {
    credential: credential(),
    parent: { revoked_at: null, expires_at: null, last_used_at: null },
    member: { role: 'owner' },
    ...over,
  }
}

function principal(decision: ReturnType<typeof decideApiPrincipal>): ApiPrincipal {
  assert.ok('principal' in decision, `expected a principal, got ${JSON.stringify(decision)}`)
  return decision.principal
}

describe('api principal', () => {
  it('reads only a Bearer header', () => {
    assert.strictEqual(bearerToken('Bearer abc'), 'abc')
    assert.strictEqual(bearerToken('bearer abc '), 'abc')
    assert.strictEqual(bearerToken('Basic abc'), null)
    assert.strictEqual(bearerToken('Bearer a b'), null)
    assert.strictEqual(bearerToken(undefined), null)
  })

  it('resolves an owner key with its granted scopes', () => {
    const p = principal(decideApiPrincipal(facts(), 'rest', NOW))
    assert.strictEqual(p.teamId, 'team-1')
    assert.deepStrictEqual(p.via, { kind: 'api_key', keyId: 'key-1' })
    assert.strictEqual(p.dataScope, 'all')
    assert.ok(principalMay(p, 'contacts:read'))
    assert.ok(!principalMay(p, 'contacts:read:pii'), 'a scope never granted is never usable')
  })

  it('refuses an unknown credential, a revoked or missing parent, and expiry on either', () => {
    assert.deepStrictEqual(decideApiPrincipal(facts({ credential: null }), 'rest', NOW), { refusal: 'unknown_token' })
    assert.deepStrictEqual(decideApiPrincipal(facts({ parent: null }), 'rest', NOW), { refusal: 'revoked' })
    assert.deepStrictEqual(
      decideApiPrincipal(facts({ parent: { revoked_at: Timestamp.fromMillis(NOW - 1) } }), 'rest', NOW),
      { refusal: 'revoked' }
    )
    assert.deepStrictEqual(
      decideApiPrincipal(facts({ parent: { revoked_at: null, expires_at: Timestamp.fromMillis(NOW) } }), 'rest', NOW),
      { refusal: 'expired' }
    )
    assert.deepStrictEqual(
      decideApiPrincipal(facts({ credential: credential({ expires_at: Timestamp.fromMillis(NOW - 1) }) }), 'mcp', NOW),
      { refusal: 'expired' }
    )
  })

  it('refuses a member who has left the team', () => {
    assert.deepStrictEqual(decideApiPrincipal(facts({ member: null }), 'rest', NOW), { refusal: 'not_a_member' })
  })

  it('binds OAuth access tokens to MCP and never accepts codes or refresh tokens as bearers', () => {
    const access = credential({ kind: 'oauth_access', client_id: 'https://claude.ai/oauth/client.json' })
    assert.deepStrictEqual(decideApiPrincipal(facts({ credential: access }), 'rest', NOW), { refusal: 'wrong_surface' })
    for (const kind of ['oauth_code', 'oauth_refresh'] as const) {
      assert.deepStrictEqual(
        decideApiPrincipal(facts({ credential: credential({ kind }) }), 'mcp', NOW),
        { refusal: 'wrong_surface' }
      )
    }
  })

  it('applies the LIVE role: a demoted creator keeps the grant but loses the capability', () => {
    const viewer = principal(
      decideApiPrincipal(facts({ member: { role: 'viewer', capabilities: ['contacts.view', 'schedule.view'] } }), 'rest', NOW)
    )
    assert.ok(principalMay(viewer, 'contacts:read'))
    assert.ok(!principalMay(viewer, 'reports:read'), 'granted, but reports.view is gone')
  })

  it('falls back to role capabilities for a member document that predates the denormalisation', () => {
    const manager = principal(decideApiPrincipal(facts({ member: { role: 'manager' } }), 'rest', NOW))
    assert.ok(principalMay(manager, 'reports:read'))
    const coach = principal(
      decideApiPrincipal(facts({ member: { role: 'coach', scope: 'own' }, fallbackCapabilities: ['contacts.view'] }), 'rest', NOW)
    )
    assert.ok(principalMay(coach, 'contacts:read'))
    assert.ok(!principalMay(coach, 'schedule:read'), 'the team override removed schedule.view')
  })

  it('keeps a coach to their own contacts and sessions unless the team widened the view', () => {
    const coach = principal(
      decideApiPrincipal(
        facts({ credential: credential({ uid: 'coach-1' }), member: { role: 'coach', scope: 'own', capabilities: ['contacts.view', 'schedule.view'] } }),
        'rest',
        NOW
      )
    )
    assert.strictEqual(coach.dataScope, 'own')
    assert.ok(principalSeesContact(coach, { assigned_coach_ids: ['coach-1'] }))
    assert.ok(principalSeesContact(coach, { createdBy: 'coach-1' }))
    assert.ok(!principalSeesContact(coach, { assigned_coach_ids: ['coach-2'], createdBy: 'owner-1' }))
    assert.ok(principalSeesSession(coach, { providerId: 'coach-1' }))
    assert.ok(!principalSeesSession(coach, { providerId: 'coach-2', createdBy: 'owner-1' }))

    const widened = { ...coach, capabilities: new Set([...coach.capabilities, 'schedule.view.all' as const]) }
    assert.ok(principalSeesSession(widened, { providerId: 'coach-2' }))
    assert.ok(!principalSeesContact(widened, { assigned_coach_ids: ['coach-2'] }))
  })

  it('drops a PII scope stored without the contacts scope it depends on', () => {
    const p = principal(decideApiPrincipal(facts({ credential: credential({ scopes: ['contacts:read:pii'] }) }), 'rest', NOW))
    assert.ok(!principalMay(p, 'contacts:read:pii'))
  })
})
