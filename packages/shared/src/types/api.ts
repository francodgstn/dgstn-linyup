import type { Capability, DataScope } from './capabilities'
import type { Timestamp } from './common'
import type { TeamRole } from './team'
import { resolveRoleCapabilities } from './capabilities'

// ─── Public API + MCP — the shared vocabulary ────────────────────────────────
//
// docs/public-api.md owns the design. This module is pure and client-safe: the
// Settings screen that creates a key and the consent page read the same scope
// table the server enforces, so what an owner is shown and what a credential can
// do are one list.

/** The plugin that entitles a team to the API (manifest: minPlan studio). */
export const API_CONNECTORS_PLUGIN_ID = 'api-connectors'

/**
 * The version of the field catalog an owner consented to. Bump it whenever a
 * projection starts sharing something it did not share before, so keys and
 * grants can tell the owner what changed rather than silently widening.
 */
export const API_FIELD_CATALOG_VERSION = 1

// ─── Scopes ──────────────────────────────────────────────────────────────────

export const API_SCOPES = [
  'contacts:read',
  'contacts:read:pii',
  'schedule:read',
  'offerings:read',
  'subscriptions:read',
  'reports:read',
  'finance:read',
] as const
export type ApiScope = (typeof API_SCOPES)[number]

export interface ApiScopeRequirement {
  /** The capability the member must hold LIVE; null = team membership is enough. */
  capability: Capability | null
  /** Scopes that must be granted alongside this one for it to mean anything. */
  requires?: ApiScope[]
  /** A plugin whose data the scope reads — refused as unavailable when inactive. */
  pluginId?: string
}

/**
 * What each scope needs. A scope NARROWS a role; it never widens one — the
 * principal may use a granted scope only while the member still holds the
 * capability here. Data scope (a coach's own-records narrowing) is applied on
 * top by the read layer.
 */
export const API_SCOPE_REQUIREMENTS: Record<ApiScope, ApiScopeRequirement> = {
  'contacts:read': { capability: 'contacts.view' },
  'contacts:read:pii': { capability: 'contacts.view', requires: ['contacts:read'] },
  'schedule:read': { capability: 'schedule.view' },
  'offerings:read': { capability: null },
  'subscriptions:read': { capability: 'contacts.view' },
  'reports:read': { capability: 'reports.view' },
  'finance:read': { capability: 'reports.view', pluginId: 'finance' },
}

/** What a new credential offers pre-ticked: everything but personal contact details. */
export const DEFAULT_API_SCOPES: ApiScope[] = API_SCOPES.filter((s) => s !== 'contacts:read:pii')

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value)
}

/**
 * A scope list as stored: known scopes only, deduped, in catalogue order, and a
 * scope whose `requires` is missing dropped rather than silently completed — a
 * request for PII without contacts is a malformed request, not a request for
 * contacts.
 */
export function normalizeApiScopes(input: unknown): ApiScope[] {
  if (!Array.isArray(input)) return []
  const asked = new Set(input.filter(isApiScope))
  return API_SCOPES.filter(
    (s) => asked.has(s) && (API_SCOPE_REQUIREMENTS[s].requires ?? []).every((r) => asked.has(r))
  )
}

/**
 * May a member with this role and these capabilities use `scope` right now?
 * Owner is all-capable, as everywhere else (`roleHasCapability`).
 */
export function apiScopeUsableBy(
  scope: ApiScope,
  role: TeamRole,
  capabilities: readonly Capability[]
): boolean {
  if (role === 'owner') return true
  const cap = API_SCOPE_REQUIREMENTS[scope].capability
  return cap === null || capabilities.includes(cap)
}

/**
 * A member's effective capabilities, from the denormalised member document when
 * it carries them and from the role otherwise — the order `hasCapability` uses.
 * The coach override is the caller's to supply (it lives in another document).
 */
export function memberCapabilityList(
  member: { role: TeamRole; capabilities?: Capability[] },
  coachOverride?: Capability[] | null
): Capability[] {
  return Array.isArray(member.capabilities)
    ? member.capabilities
    : resolveRoleCapabilities(member.role, coachOverride)
}

/**
 * The data scope stored on a member document. Mirrors `callerIsAllScoped` and
 * the rules: only an explicit `'own'` narrows.
 */
export function memberDataScope(member: { scope?: DataScope } | null | undefined): DataScope {
  return member?.scope === 'own' ? 'own' : 'all'
}

// ─── Credentials ─────────────────────────────────────────────────────────────

/** Production keys; every other environment mints `lyp_test_`. */
export const API_KEY_PREFIX_LIVE = 'lyp_live_'
export const API_KEY_PREFIX_TEST = 'lyp_test_'
export type ApiKeyEnvironment = 'live' | 'test'

/** Characters of the secret kept for display (`prefix`), after the environment prefix. */
export const API_KEY_DISPLAY_CHARS = 4
/** Keys a team may hold unrevoked at once. */
export const MAX_ACTIVE_API_KEYS = 10
export const API_KEY_NAME_MAX = 60

/**
 * `teams/{teamId}/api_keys/{keyId}` — the owner-visible record of a key. The
 * secret is never stored; its hash is the id of the `api_credentials` document
 * that authenticates it. Written only by Cloud Functions.
 */
export interface ApiKey {
  id: string
  teamId: string
  name: string
  /** `lyp_live_` + the first characters of the secret — enough to recognise it. */
  prefix: string
  last4: string
  scopes: ApiScope[]
  /** `API_FIELD_CATALOG_VERSION` when it was created — what the owner was shown. */
  catalog_version: number
  created_by: string
  created_at: Timestamp
  expires_at: Timestamp | null
  revoked_at: Timestamp | null
  revoked_by: string | null
  last_used_at: Timestamp | null
}

export type ApiCredentialKind = 'api_key' | 'oauth_code' | 'oauth_access' | 'oauth_refresh'

/**
 * `api_credentials/{sha256(secret)}` — what a presented secret authenticates.
 * Every client read and write is denied. `parent_id` names the key (or, in
 * Phase 2, the grant) whose revocation ends it; the resolver reads the parent on
 * every request, so deleting this row on revocation is cleanup, not the gate.
 */
export interface ApiCredential {
  kind: ApiCredentialKind
  teamId: string
  uid: string
  parent_id: string
  scopes: ApiScope[]
  /** OAuth only: the RFC 8707 resource the token is bound to. */
  resource: string | null
  client_id: string | null
  redirect_uri: string | null
  code_challenge: string | null
  used_at: Timestamp | null
  created_at: Timestamp
  expires_at: Timestamp | null
}

// ─── OAuth (Phase 2) ─────────────────────────────────────────────────────────
//
// Linyup is its own authorization server (docs/public-api.md → "OAuth"):
// authorization code + S256 PKCE, public clients identified by Client ID
// Metadata Documents, tokens bound to the MCP resource (RFC 8707). One grant =
// one member × one team × one client.

/** The path of the protected resource OAuth access tokens are bound to. */
export const API_MCP_PATH = '/mcp'

export const OAUTH_AUTHORIZATION_REQUEST_TTL_MS = 10 * 60_000
export const OAUTH_CODE_TTL_MS = 5 * 60_000
export const OAUTH_ACCESS_TOKEN_TTL_MS = 60 * 60_000
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * 86_400_000
export const OAUTH_CLIENT_METADATA_TTL_MS = 24 * 3_600_000

/** Hosts whose clients the consent page names as recognised. Display only — never a decision. */
export const OAUTH_RECOGNISED_CLIENT_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com', 'chatgpt.com', 'openai.com'] as const

/**
 * `oauth_requests/{requestId}` — an authorization request between `/oauth/authorize`
 * and the member's decision on the consent page. Consumed once; TTL-retired.
 * Every client read and write is denied.
 */
export interface OAuthAuthorizationRequest {
  client_id: string
  client_name: string
  client_uri: string | null
  logo_uri: string | null
  redirect_uri: string
  state: string | null
  code_challenge: string
  scopes: ApiScope[]
  /** RFC 8707 resource the tokens will be bound to. */
  resource: string
  /** The authorization server's issuer, returned as `iss` on the redirect. */
  issuer: string
  created_at: Timestamp
  expires_at: Timestamp
  consumed_at: Timestamp | null
}

/**
 * `teams/{teamId}/oauth_grants/{grantId}` — a connected app. Revoking it ends
 * every token issued under it: the principal resolver reads the grant on each
 * request. Written only by Cloud Functions; readable by an owner and by the
 * member who granted it.
 */
export interface OAuthGrant {
  id: string
  teamId: string
  uid: string
  client_id: string
  client_name: string
  client_uri: string | null
  redirect_host: string
  scopes: ApiScope[]
  resource: string
  catalog_version: number
  created_at: Timestamp
  revoked_at: Timestamp | null
  revoked_by: string | null
  last_used_at: Timestamp | null
}

/** `oauth_clients/{sha256(client_id)}` — a fetched Client ID Metadata Document, cached. */
export interface OAuthClientRecord {
  client_id: string
  client_name: string
  client_uri: string | null
  logo_uri: string | null
  redirect_uris: string[]
  fetched_at: Timestamp
  expires_at: Timestamp
}

/** `teams/{teamId}/api_usage/{yyyy-mm-dd}` — a day's request counter, TTL-retired. */
export interface ApiUsageDay {
  requests: number
  denied: number
  expires_at: Timestamp
}
