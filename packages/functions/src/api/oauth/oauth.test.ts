import * as assert from 'node:assert'
import { Timestamp } from 'firebase-admin/firestore'
import type { ApiCredential } from '@linyup/shared'
import { decideApiPrincipal, principalMay } from '../auth/principal'
import {
  ClientMetadataError,
  fetchClientMetadata,
  isNonPublicAddress,
  isRecognisedClient,
  parseClientIdUrl,
  redirectUriAllowed,
  validateClientMetadataDocument,
} from './clientMetadata'
import { requestedScopes } from './endpoints'
import { authorizationServerMetadata, protectedResourceMetadata, resourceMetadataUrl } from './metadata'
import { isValidCodeChallenge, opaqueToken, pkceS256, verifyPkce, withQuery } from './pkce'

const CLIENT = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const BASE = 'https://api.linyup.com'

function reason(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof ClientMetadataError ? err.reason : 'other'
  }
  return undefined
}

async function asyncReason(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (err) {
    return err instanceof ClientMetadataError ? err.reason : 'other'
  }
  return undefined
}

describe('oauth: PKCE', () => {
  it('matches the RFC 7636 appendix B example', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    assert.strictEqual(pkceS256(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    assert.ok(verifyPkce(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'))
  })

  it('refuses a wrong, short or non-conforming verifier and a malformed challenge', () => {
    const challenge = pkceS256('a'.repeat(43))
    assert.ok(!verifyPkce('b'.repeat(43), challenge))
    assert.ok(!verifyPkce('a'.repeat(42), pkceS256('a'.repeat(42))), 'shorter than 43 characters')
    assert.ok(!verifyPkce('a'.repeat(42) + '!', challenge))
    assert.ok(!isValidCodeChallenge('plain-text-challenge'))
  })

  it('keeps a redirect URI’s own query and mints distinct opaque tokens', () => {
    assert.strictEqual(withQuery('https://x.test/cb?a=1', { code: 'c', state: null }), 'https://x.test/cb?a=1&code=c')
    const a = opaqueToken()
    assert.match(a, /^[A-Za-z0-9_-]{43}$/)
    assert.notStrictEqual(a, opaqueToken())
  })
})

describe('oauth: client metadata documents', () => {
  it('accepts an https client_id with a path, and loopback http only on the emulator', () => {
    assert.strictEqual(parseClientIdUrl(CLIENT, { allowLoopbackHttp: false }).host, 'claude.ai')
    assert.strictEqual(reason(() => parseClientIdUrl('http://127.0.0.1:9/client.json', { allowLoopbackHttp: false })), 'invalid_client_id')
    assert.ok(parseClientIdUrl('http://127.0.0.1:9/client.json', { allowLoopbackHttp: true }))
    assert.strictEqual(reason(() => parseClientIdUrl('http://example.com/client.json', { allowLoopbackHttp: true })), 'invalid_client_id')
    assert.strictEqual(reason(() => parseClientIdUrl('https://claude.ai/', { allowLoopbackHttp: false })), 'invalid_client_id')
    assert.strictEqual(reason(() => parseClientIdUrl('https://claude.ai/x#frag', { allowLoopbackHttp: false })), 'invalid_client_id')
    assert.strictEqual(reason(() => parseClientIdUrl('https://u:p@claude.ai/x', { allowLoopbackHttp: false })), 'invalid_client_id')
  })

  it('treats private, loopback, link-local, CGNAT and mapped addresses as non-public', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      assert.ok(isNonPublicAddress(ip), ip)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) assert.ok(!isNonPublicAddress(ip), ip)
  })

  it('validates the document against the URL it came from', () => {
    const good = {
      client_id: CLIENT,
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      logo_uri: 'http://insecure.example/logo.png',
    }
    const meta = validateClientMetadataDocument(good, CLIENT)
    assert.strictEqual(meta.client_name, 'Claude')
    assert.strictEqual(meta.logo_uri, null, 'a non-https logo is dropped')
    assert.strictEqual(reason(() => validateClientMetadataDocument({ ...good, client_id: 'https://evil.example/x' }, CLIENT)), 'invalid_document')
    assert.strictEqual(reason(() => validateClientMetadataDocument({ ...good, redirect_uris: [] }, CLIENT)), 'invalid_document')
    assert.strictEqual(reason(() => validateClientMetadataDocument({ ...good, token_endpoint_auth_method: 'client_secret_post' }, CLIENT)), 'invalid_document')
    assert.strictEqual(reason(() => validateClientMetadataDocument({ ...good, redirect_uris: ['http://evil.example/cb'] }, CLIENT)), 'invalid_document')
    assert.strictEqual(reason(() => validateClientMetadataDocument([good], CLIENT)), 'invalid_document')
  })

  it('matches redirect URIs exactly, except a loopback port', () => {
    const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:3000/callback']
    assert.ok(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', registered))
    assert.ok(redirectUriAllowed('http://127.0.0.1:53124/callback', registered))
    assert.ok(!redirectUriAllowed('http://127.0.0.1:53124/other', registered))
    assert.ok(!redirectUriAllowed('https://claude.ai/api/mcp/auth_callback?x=1', registered))
    assert.ok(!redirectUriAllowed('https://evil.example/api/mcp/auth_callback', registered))
  })

  it('refuses IP-literal hosts, redirects and oversized documents when fetching', async () => {
    assert.strictEqual(await asyncReason(() => fetchClientMetadata('https://10.0.0.5/client.json', { allowLoopbackHttp: false })), 'unsafe_host')
    const redirecting = (async () => new Response(null, { status: 302, headers: { location: 'https://x' } })) as unknown as typeof fetch
    assert.strictEqual(
      await asyncReason(() => fetchClientMetadata(CLIENT, { allowLoopbackHttp: false, skipDnsCheck: true, fetchImpl: redirecting })),
      'fetch_failed'
    )
    const huge = (async () => new Response('x'.repeat(10_000), { status: 200 })) as unknown as typeof fetch
    assert.strictEqual(
      await asyncReason(() => fetchClientMetadata(CLIENT, { allowLoopbackHttp: false, skipDnsCheck: true, fetchImpl: huge })),
      'too_large'
    )
    const ok = (async () =>
      new Response(JSON.stringify({ client_id: CLIENT, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }), {
        status: 200,
      })) as unknown as typeof fetch
    const meta = await fetchClientMetadata(CLIENT, { allowLoopbackHttp: false, skipDnsCheck: true, fetchImpl: ok })
    assert.deepStrictEqual(meta.redirect_uris, ['https://claude.ai/api/mcp/auth_callback'])
  })

  it('recognises known client hosts for display, and not look-alikes', () => {
    assert.ok(isRecognisedClient(CLIENT))
    assert.ok(isRecognisedClient('https://chatgpt.com/connector/client.json'))
    assert.ok(!isRecognisedClient('https://evilclaude.ai/client.json'))
    assert.ok(!isRecognisedClient('https://claude.ai.evil.example/client.json'))
  })
})

describe('oauth: discovery and scopes', () => {
  it('advertises CIMD, S256, public clients and the issuer as the resource’s authorization server', () => {
    const as = authorizationServerMetadata(BASE)
    assert.strictEqual(as.issuer, BASE)
    assert.deepStrictEqual(as.code_challenge_methods_supported, ['S256'])
    assert.deepStrictEqual(as.token_endpoint_auth_methods_supported, ['none'])
    assert.strictEqual(as.client_id_metadata_document_supported, true)
    const prm = protectedResourceMetadata(BASE)
    assert.strictEqual(prm.resource, `${BASE}/mcp`)
    assert.deepStrictEqual(prm.authorization_servers, [BASE])
    assert.strictEqual(resourceMetadataUrl(BASE), `${BASE}/.well-known/oauth-protected-resource/mcp`)
  })

  it('reads the scope parameter: defaults when absent, refuses when nothing is known, adds contacts for PII', () => {
    assert.ok(!(requestedScopes(undefined) as string[]).includes('contacts:read:pii'), 'defaults leave PII out')
    assert.strictEqual(requestedScopes('files:write'), 'invalid')
    assert.deepStrictEqual(requestedScopes('contacts:read:pii'), ['contacts:read', 'contacts:read:pii'])
    assert.deepStrictEqual(requestedScopes('schedule:read unknown:scope'), ['schedule:read'])
  })
})

describe('oauth: access tokens in the principal', () => {
  const NOW = Date.UTC(2026, 8, 14, 12)
  const access = (over: Partial<ApiCredential> = {}): ApiCredential => ({
    kind: 'oauth_access',
    teamId: 'team-1',
    uid: 'owner-1',
    parent_id: 'grant-1',
    scopes: ['contacts:read'],
    resource: `${BASE}/mcp`,
    client_id: CLIENT,
    redirect_uri: null,
    code_challenge: null,
    used_at: null,
    created_at: Timestamp.fromMillis(NOW - 1000),
    expires_at: Timestamp.fromMillis(NOW + 3_600_000),
    ...over,
  })
  const facts = (credential: ApiCredential) => ({
    credential,
    parent: { revoked_at: null, last_used_at: null },
    member: { role: 'owner' as const },
  })

  it('accepts a token on the MCP resource it was issued for, acting as a connected app', () => {
    const decision = decideApiPrincipal(facts(access()), 'mcp', NOW, `${BASE}/mcp`)
    assert.ok('principal' in decision)
    assert.deepStrictEqual(decision.principal.via, { kind: 'oauth', grantId: 'grant-1', clientId: CLIENT })
    assert.ok(principalMay(decision.principal, 'contacts:read'))
  })

  it('refuses it on another deployment’s resource, on REST, after expiry and once the grant is revoked', () => {
    assert.deepStrictEqual(decideApiPrincipal(facts(access()), 'mcp', NOW, 'https://api-staging.example/mcp'), { refusal: 'wrong_resource' })
    assert.deepStrictEqual(decideApiPrincipal(facts(access()), 'rest', NOW), { refusal: 'wrong_surface' })
    assert.deepStrictEqual(decideApiPrincipal(facts(access({ expires_at: Timestamp.fromMillis(NOW) })), 'mcp', NOW, `${BASE}/mcp`), {
      refusal: 'expired',
    })
    assert.deepStrictEqual(
      decideApiPrincipal({ ...facts(access()), parent: { revoked_at: Timestamp.fromMillis(NOW - 1) } }, 'mcp', NOW, `${BASE}/mcp`),
      { refusal: 'revoked' }
    )
  })

  it('never accepts a code or a refresh token as a bearer', () => {
    for (const kind of ['oauth_code', 'oauth_refresh'] as const) {
      assert.deepStrictEqual(decideApiPrincipal(facts(access({ kind })), 'mcp', NOW, `${BASE}/mcp`), { refusal: 'wrong_surface' })
    }
  })
})
