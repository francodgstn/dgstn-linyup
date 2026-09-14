// ─── The API principal — ONE resolver ────────────────────────────────────────
//
// docs/public-api.md → "The principal". Every request to the public API, REST or
// MCP, API key or OAuth token, is answered by `resolveApiPrincipal` and by
// nothing else. The read layer then asks `principalMay` / `principalSees*`.
//
// Four rules this module exists to keep:
//
//   1. LIVE, NOT GRANTED. The member document is read on EVERY request. A token
//      carries the scopes it was granted; what the member may do is whatever
//      their role says NOW. Leaving the team, a demotion and a revocation all
//      take effect on the next call, with no token to expire first.
//   2. THE PARENT IS THE GATE. A credential row is cleanup; the key or grant it
//      names is read too, so a revocation that has not yet deleted its rows still
//      refuses.
//   3. BOUND TO THIS RESOURCE. An OAuth access token is accepted only by the MCP
//      endpoint it was issued for (RFC 8707) — never by REST, never by another
//      deployment's `/mcp`.
//   4. NARROWER THAN THE RULES, NEVER WIDER. Scopes intersect capabilities; the
//      coach's own-records scope is applied through the same predicates the
//      rules mirror (utils/dataScope.ts in @linyup/shared).

import * as admin from 'firebase-admin'
import {
  API_CREDENTIALS_COLLECTION,
  API_KEYS_SUBCOLLECTION,
  OAUTH_GRANTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
  apiScopeUsableBy,
  coachOwnsContact,
  coachOwnsSession,
  memberCapabilityList,
  memberDataScope,
  normalizeApiScopes,
  type ApiCredential,
  type ApiCredentialKind,
  type ApiScope,
  type Capability,
  type Contact,
  type DataScope,
  type Session,
  type TeamRole,
} from '@linyup/shared'
import { resolveMemberCapabilities } from '../../utils/teams'
import { apiCredentialId, parseApiKeySecret } from './keyFormat'

export type ApiSurface = 'rest' | 'mcp'

export type ApiAuthRefusal =
  | 'missing_token'
  | 'malformed_token'
  | 'unknown_token'
  | 'expired'
  | 'revoked'
  | 'wrong_surface'
  | 'wrong_resource'
  | 'not_a_member'

export interface ApiPrincipal {
  teamId: string
  uid: string
  via: { kind: 'api_key'; keyId: string } | { kind: 'oauth'; grantId: string; clientId: string }
  role: TeamRole
  scopes: ReadonlySet<ApiScope>
  /** LIVE — from the member document read for this request. */
  capabilities: ReadonlySet<Capability>
  /** LIVE — `'own'` only for a coach. */
  dataScope: DataScope
  /** The parent key's or grant's `last_used_at`, for the throttled touch. */
  lastUsedAtMs: number | null
}

/**
 * Which credential kinds may be presented as a bearer on each surface. OAuth
 * access tokens are bound to the MCP resource, so they are refused on REST;
 * codes and refresh tokens are never bearers at all.
 */
const BEARER_KINDS: Record<ApiSurface, readonly ApiCredentialKind[]> = {
  rest: ['api_key'],
  mcp: ['api_key', 'oauth_access'],
}

interface TimestampLike {
  toMillis(): number
}

function millis(value: unknown): number | null {
  return value && typeof (value as TimestampLike).toMillis === 'function'
    ? (value as TimestampLike).toMillis()
    : null
}

/** The token in an `Authorization: Bearer …` header, or null. Query strings are never read. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}

/** What the loader read for one request — everything `decideApiPrincipal` needs. */
export interface PrincipalFacts {
  credential: ApiCredential | null
  /** The key or grant the credential names; null when it no longer exists. */
  parent: { revoked_at?: unknown; expires_at?: unknown; last_used_at?: unknown } | null
  member: { role: TeamRole; capabilities?: Capability[]; scope?: DataScope } | null
  /** Resolved capabilities for a member document that predates the denormalisation. */
  fallbackCapabilities?: Capability[] | null
}

export type PrincipalDecision = { principal: ApiPrincipal } | { refusal: ApiAuthRefusal }

/**
 * Pure: the whole decision, given what was read. `expectedResource` is the
 * canonical MCP resource of THIS deployment; an OAuth token bound to anything
 * else is refused.
 */
export function decideApiPrincipal(
  facts: PrincipalFacts,
  surface: ApiSurface,
  nowMs: number,
  expectedResource?: string
): PrincipalDecision {
  const { credential, parent, member } = facts
  if (!credential) return { refusal: 'unknown_token' }
  if (!BEARER_KINDS[surface].includes(credential.kind)) return { refusal: 'wrong_surface' }
  if (credential.kind === 'oauth_access' && credential.resource !== (expectedResource ?? null)) {
    return { refusal: 'wrong_resource' }
  }
  if (!parent || parent.revoked_at != null) return { refusal: 'revoked' }

  const credentialExpiry = millis(credential.expires_at)
  const parentExpiry = millis(parent.expires_at)
  if ((credentialExpiry !== null && credentialExpiry <= nowMs) || (parentExpiry !== null && parentExpiry <= nowMs)) {
    return { refusal: 'expired' }
  }

  if (!member) return { refusal: 'not_a_member' }

  const capabilities = Array.isArray(member.capabilities)
    ? member.capabilities
    : (facts.fallbackCapabilities ?? memberCapabilityList(member))

  return {
    principal: {
      teamId: credential.teamId,
      uid: credential.uid,
      via:
        credential.kind === 'api_key'
          ? { kind: 'api_key', keyId: credential.parent_id }
          : { kind: 'oauth', grantId: credential.parent_id, clientId: credential.client_id ?? '' },
      role: member.role,
      scopes: new Set(normalizeApiScopes(credential.scopes)),
      capabilities: new Set(capabilities),
      dataScope: memberDataScope(member),
      lastUsedAtMs: millis(parent.last_used_at),
    },
  }
}

function parentRef(credential: ApiCredential): FirebaseFirestore.DocumentReference {
  const team = admin.firestore().collection(TEAMS_COLLECTION).doc(credential.teamId)
  return credential.kind === 'api_key'
    ? team.collection(API_KEYS_SUBCOLLECTION).doc(credential.parent_id)
    : team.collection(OAUTH_GRANTS_SUBCOLLECTION).doc(credential.parent_id)
}

/**
 * THE resolver. Reads the credential by the hash of the presented secret, then
 * its parent and the member document together.
 */
export async function resolveApiPrincipal(
  authorization: string | undefined,
  surface: ApiSurface,
  nowMs: number = Date.now(),
  expectedResource?: string
): Promise<PrincipalDecision> {
  const token = bearerToken(authorization)
  if (!token) return { refusal: 'missing_token' }
  // API keys are recognisable offline; OAuth tokens are opaque and not lyp_-prefixed.
  if (token.startsWith('lyp_') && !parseApiKeySecret(token)) return { refusal: 'malformed_token' }

  const db = admin.firestore()
  const credentialSnap = await db.collection(API_CREDENTIALS_COLLECTION).doc(apiCredentialId(token)).get()
  const credential = credentialSnap.exists ? (credentialSnap.data() as ApiCredential) : null
  if (!credential) return decideApiPrincipal({ credential: null, parent: null, member: null }, surface, nowMs, expectedResource)

  const memberRef = db
    .collection(TEAMS_COLLECTION)
    .doc(credential.teamId)
    .collection(TEAM_MEMBERS_SUBCOLLECTION)
    .doc(credential.uid)
  const [parentSnap, memberSnap] = await db.getAll(parentRef(credential), memberRef)

  const member = memberSnap.exists ? (memberSnap.data() as PrincipalFacts['member']) : null
  const fallbackCapabilities =
    member && !Array.isArray(member.capabilities)
      ? (await resolveMemberCapabilities(credential.teamId, member.role)).capabilities
      : null

  return decideApiPrincipal(
    {
      credential,
      parent: parentSnap.exists ? (parentSnap.data() as PrincipalFacts['parent']) : null,
      member,
      fallbackCapabilities,
    },
    surface,
    nowMs,
    expectedResource
  )
}

/** Was `scope` granted, AND does the member hold what it requires right now? */
export function principalMay(principal: ApiPrincipal, scope: ApiScope): boolean {
  return principal.scopes.has(scope) && apiScopeUsableBy(scope, principal.role, [...principal.capabilities])
}

/** The rules' `canAccessContact`, for a principal that already may read contacts. */
export function principalSeesContact(
  principal: ApiPrincipal,
  contact: Pick<Contact, 'assigned_coach_ids' | 'createdBy'>
): boolean {
  return (
    principal.dataScope === 'all' ||
    principal.capabilities.has('contacts.view.all') ||
    coachOwnsContact(contact, principal.uid)
  )
}

/** The same for a session, honouring `schedule.view.all`. */
export function principalSeesSession(
  principal: ApiPrincipal,
  session: Pick<Session, 'providerId' | 'createdBy'>
): boolean {
  return (
    principal.dataScope === 'all' ||
    principal.capabilities.has('schedule.view.all') ||
    coachOwnsSession(session, principal.uid)
  )
}
