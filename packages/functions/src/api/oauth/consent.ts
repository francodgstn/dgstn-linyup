// ─── OAuth consent callables ─────────────────────────────────────────────────
//
// The web app's consent page (apps/web …/oauth/consent) signs the member in
// with Firebase and asks these callables:
//
//   getOAuthAuthorizationRequest  what is being asked, and which of the
//                                 member's teams could grant it
//   approveOAuthAuthorization     create the grant + code, return the redirect
//   denyOAuthAuthorization        return the client's access_denied redirect
//   revokeOAuthGrant              disconnect an app (owner, or the member who
//                                 connected it)
//
// Approval is behind the `api-connectors` install gate — it CREATES a door.
// Revocation never is. Granted scopes are the intersection of what the client
// asked for, what the member ticked and what the member's role can use now.

import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  API_CONNECTORS_PLUGIN_ID,
  OAUTH_GRANTS_SUBCOLLECTION,
  OAUTH_REQUESTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
  apiScopeUsableBy,
  normalizeApiScopes,
  type ApiScope,
  type Capability,
  type OAuthAuthorizationRequest,
  type OAuthGrant,
  type TeamMember,
  type TeamRole,
} from '@linyup/shared'
import { assertPluginInstalled, pluginIsActive } from '../../utils/plugins'
import { hasCapability, resolveMemberCapabilities } from '../../utils/teams'
import { approveAuthorization, denyAuthorization, revokeOAuthGrant as revokeGrant, type ConsentOutcome } from '../auth/credentials'
import { isRecognisedClient } from './clientMetadata'

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new HttpsError('invalid-argument', `A valid ${field} is required`, { reason: `invalid_${field}` })
  }
  return value
}

function requireUid(request: { auth?: { uid: string } }): string {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue')
  return uid
}

async function loadOpenRequest(requestId: string, nowMs: number): Promise<OAuthAuthorizationRequest> {
  const snap = await admin.firestore().collection(OAUTH_REQUESTS_COLLECTION).doc(requestId).get()
  const req = snap.data() as OAuthAuthorizationRequest | undefined
  if (req?.consumed_at) {
    throw new HttpsError('failed-precondition', 'This connection request was already answered', { reason: 'request_used' })
  }
  if (!req || req.expires_at.toMillis() <= nowMs) {
    throw new HttpsError('not-found', 'This connection request has expired', { reason: 'request_expired' })
  }
  return req
}

async function capabilitiesOf(teamId: string, member: Pick<TeamMember, 'role' | 'capabilities'>): Promise<Capability[]> {
  return Array.isArray(member.capabilities)
    ? member.capabilities
    : (await resolveMemberCapabilities(teamId, member.role)).capabilities
}

function refuseOutcome(outcome: Exclude<ConsentOutcome, { redirect: string }>): never {
  throw new HttpsError('failed-precondition', 'This connection request has expired', {
    reason: outcome === 'consumed' ? 'request_used' : 'request_expired',
  })
}

export interface ConsentTeamOption {
  teamId: string
  name: string
  role: TeamRole
  plugin_installed: boolean
  scopes: Array<{ scope: ApiScope; usable: boolean }>
}

export const getOAuthAuthorizationRequest = onCall(async (request) => {
  const uid = requireUid(request)
  const data = (request.data ?? {}) as Record<string, unknown>
  const req = await loadOpenRequest(requireString(data.requestId, 'requestId'), Date.now())

  const db = admin.firestore()
  const memberships = await db.collectionGroup(TEAM_MEMBERS_SUBCOLLECTION).where('userId', '==', uid).limit(50).get()
  const teamIds = memberships.docs.map((d) => d.ref.parent.parent!.id)
  const teamSnaps = teamIds.length ? await db.getAll(...teamIds.map((id) => db.collection(TEAMS_COLLECTION).doc(id))) : []

  const teams: ConsentTeamOption[] = []
  for (let i = 0; i < memberships.docs.length; i++) {
    const member = memberships.docs[i].data() as TeamMember
    const teamId = teamIds[i]
    if (!teamSnaps[i]?.exists) continue
    const capabilities = await capabilitiesOf(teamId, member)
    teams.push({
      teamId,
      name: (teamSnaps[i].data()?.name as string | undefined) ?? teamId,
      role: member.role,
      plugin_installed: await pluginIsActive(teamId, API_CONNECTORS_PLUGIN_ID),
      scopes: req.scopes.map((scope) => ({ scope, usable: apiScopeUsableBy(scope, member.role, capabilities) })),
    })
  }

  return {
    client: {
      id: req.client_id,
      name: req.client_name,
      uri: req.client_uri,
      logo_uri: req.logo_uri,
      redirect_host: new URL(req.redirect_uri).host,
      recognised: isRecognisedClient(req.client_id),
    },
    scopes: req.scopes,
    teams,
    expires_at_ms: req.expires_at.toMillis(),
  }
})

export const approveOAuthAuthorization = onCall(async (request) => {
  const uid = requireUid(request)
  const data = (request.data ?? {}) as Record<string, unknown>
  const requestId = requireString(data.requestId, 'requestId')
  const teamId = requireString(data.teamId, 'teamId')
  const nowMs = Date.now()

  const memberSnap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TEAM_MEMBERS_SUBCOLLECTION)
    .doc(uid)
    .get()
  const member = memberSnap.data() as TeamMember | undefined
  if (!member) throw new HttpsError('permission-denied', 'You are not a member of this team', { reason: 'not_a_member' })
  await assertPluginInstalled(teamId, API_CONNECTORS_PLUGIN_ID)

  const req = await loadOpenRequest(requestId, nowMs)
  const capabilities = await capabilitiesOf(teamId, member)
  const chosen = normalizeApiScopes(data.scopes).filter(
    (s) => req.scopes.includes(s) && apiScopeUsableBy(s, member.role, capabilities)
  )
  if (chosen.length === 0) {
    throw new HttpsError('invalid-argument', 'Choose at least one thing this app may read', { reason: 'no_scopes' })
  }

  const outcome = await approveAuthorization({ requestId, teamId, uid, scopes: chosen, nowMs })
  if (typeof outcome === 'string') refuseOutcome(outcome)
  console.info(`[oauth] granted team=${teamId} uid=${uid} client=${req.client_id} scopes=${chosen.join(',')}`)
  return { redirect: outcome.redirect }
})

export const denyOAuthAuthorization = onCall(async (request) => {
  requireUid(request)
  const data = (request.data ?? {}) as Record<string, unknown>
  const outcome = await denyAuthorization(requireString(data.requestId, 'requestId'))
  if (typeof outcome === 'string') refuseOutcome(outcome)
  return { redirect: outcome.redirect }
})

export const revokeOAuthGrant = onCall(async (request) => {
  const uid = requireUid(request)
  const data = (request.data ?? {}) as Record<string, unknown>
  const teamId = requireString(data.teamId, 'teamId')
  const grantId = requireString(data.grantId, 'grantId')

  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(OAUTH_GRANTS_SUBCOLLECTION).doc(grantId).get()
  const grant = snap.data() as OAuthGrant | undefined
  if (!grant) throw new HttpsError('not-found', 'No such connected app', { reason: 'grant_not_found' })
  // The member who connected an app may always disconnect it; anyone else needs integrations.manage.
  if (grant.uid !== uid && !(await hasCapability(uid, teamId, 'integrations.manage'))) {
    throw new HttpsError('permission-denied', 'Only the owner or the member who connected this app can disconnect it')
  }
  return { outcome: await revokeGrant(teamId, grantId, uid) }
})
