/* eslint-disable no-console */
// Connecting a studio's WhatsApp Business number, and letting go of it.
// docs/whatsapp-outbound.md → "Connect / disconnect".
//
// The browser runs Meta's Embedded Signup (Business App onboarding) and hands
// back a one-time code plus the account and number ids; everything that needs
// the app secret or the studio's token happens here.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { TEAMS_COLLECTION, WHATSAPP_PLUGIN_ID, apiAccessBlocked, type Team } from '@linyup/shared'
import { assertPluginInstalled, touchTeamForSurfaceRecompute } from '../utils/plugins'
import { isTeamMember, requireCapability } from '../utils/teams'
import { getHostingUrl } from '../utils/env'
import { META_APP_ID, META_GRAPH_VERSION, WHATSAPP_SIGNUP_CONFIG_ID } from './config'
import {
  loadWhatsAppCredentials,
  patchWhatsAppIntegration,
  sealWhatsAppToken,
  whatsappConnectionRef,
  whatsappIntegrationRef,
  whatsappNumberRef,
} from './connection'
import { whatsappGraph, WhatsAppGraphError } from './graph'
import { provisionLinyupTemplates } from './templates'

async function requireIntegrationManager(request: CallableRequest<unknown>, teamId: unknown): Promise<string> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  if (typeof teamId !== 'string' || !teamId) throw new HttpsError('invalid-argument', 'teamId is required.')
  const uid = request.auth.uid
  if (!(await isTeamMember(uid, teamId))) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }
  await requireCapability(uid, teamId, 'integrations.manage')
  return uid
}

function metaFailure(err: unknown): HttpsError {
  if (err instanceof WhatsAppGraphError) {
    console.warn(`[whatsapp] Graph error ${err.httpStatus} code=${err.code}: ${err.message}`)
    return new HttpsError('failed-precondition', err.message, { reason: 'meta_error', code: err.code })
  }
  return err instanceof HttpsError ? err : new HttpsError('internal', 'WhatsApp request failed.')
}

/** What the browser needs to open Embedded Signup — not secrets. */
export const getWhatsAppSignupConfig = onCall(async (request) => {
  await requireIntegrationManager(request, (request.data as { teamId?: string })?.teamId)
  const appId = META_APP_ID.value()
  const configId = WHATSAPP_SIGNUP_CONFIG_ID.value()
  return appId && configId
    ? { available: true, appId, configId, graphVersion: META_GRAPH_VERSION.value() }
    : { available: false }
})

export const connectWhatsApp = onCall(async (request) => {
  const { teamId, code, wabaId, phoneNumberId } = (request.data ?? {}) as Record<string, unknown>
  const uid = await requireIntegrationManager(request, teamId)
  const team = teamId as string
  if (typeof code !== 'string' || typeof wabaId !== 'string') {
    throw new HttpsError('invalid-argument', 'code and wabaId are required.')
  }
  if (phoneNumberId !== undefined && typeof phoneNumberId !== 'string') {
    throw new HttpsError('invalid-argument', 'phoneNumberId must be a string.')
  }
  await assertPluginInstalled(team, WHATSAPP_PLUGIN_ID)

  const db = admin.firestore()
  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(team).get()
  // The public demos: their owner login is shared with every visitor.
  if (apiAccessBlocked(teamSnap.data() as Team | undefined)) {
    throw new HttpsError('failed-precondition', 'This studio cannot connect WhatsApp.', { reason: 'demo_tenant' })
  }
  if (!META_APP_ID.value()) {
    throw new HttpsError('failed-precondition', 'WhatsApp is not available yet.', { reason: 'not_configured' })
  }

  const graph = whatsappGraph()
  let token: string
  let numberId: string
  let phone: Awaited<ReturnType<typeof graph.getPhoneNumber>>
  try {
    token = await graph.exchangeCode(code)
    // Business App onboarding reports the account only; an account onboarded
    // that way carries the one number that was in the app.
    const ids = phoneNumberId ? [phoneNumberId] : await graph.listPhoneNumberIds(token, wabaId)
    if (ids.length !== 1) {
      throw new HttpsError('failed-precondition', 'Choose exactly one WhatsApp number to connect.', {
        reason: ids.length === 0 ? 'no_number' : 'several_numbers',
      })
    }
    numberId = ids[0]
    phone = await graph.getPhoneNumber(token, numberId)
  } catch (err) {
    throw metaFailure(err)
  }
  // Replies must land somewhere a person reads them: the studio's app.
  if (phone.is_on_biz_app !== true) {
    throw new HttpsError('failed-precondition', 'Connect a number you use in the WhatsApp Business app.', {
      reason: 'not_business_app',
    })
  }

  const sealed = await sealWhatsAppToken(token)
  const previous = await loadWhatsAppCredentials(team).catch(() => null)
  await db.runTransaction(async (tx) => {
    const claimRef = whatsappNumberRef(numberId)
    const claim = await tx.get(claimRef)
    const holder = claim.data()?.teamId as string | undefined
    if (holder && holder !== team) {
      throw new HttpsError('already-exists', 'This number is connected to another studio.', {
        reason: 'number_taken',
      })
    }
    if (previous && previous.phoneNumberId !== numberId) {
      tx.delete(whatsappNumberRef(previous.phoneNumberId))
    }
    tx.set(claimRef, { teamId: team, claimed_at: FieldValue.serverTimestamp() })
    tx.set(whatsappConnectionRef(team), {
      team_id: team,
      sealed_token: sealed,
      waba_id: wabaId,
      phone_number_id: numberId,
      connected_by: uid,
      connected_at: FieldValue.serverTimestamp(),
    })
  })

  let templates
  try {
    await graph.subscribeApp(token, wabaId)
    templates = await provisionLinyupTemplates(graph, token, wabaId, getHostingUrl())
  } catch (err) {
    await patchWhatsAppIntegration(team, { status: 'error', last_error: (err as Error).message })
    throw metaFailure(err)
  }

  await patchWhatsAppIntegration(team, {
    status: 'connected',
    waba_id: wabaId,
    phone_number_id: numberId,
    display_phone_number: phone.display_phone_number,
    verified_name: phone.verified_name,
    is_on_biz_app: phone.is_on_biz_app,
    quality_rating: phone.quality_rating,
    templates,
    connected_by: uid,
    connected_at: FieldValue.serverTimestamp(),
    last_error: null,
  })
  // The public forms start offering the opt-in (TeamPublicProfile.whatsapp_opt_in_offered).
  await touchTeamForSurfaceRecompute(team)
  return { ok: true }
})

/** Re-reads the number and the templates, and creates any template missing. */
export const refreshWhatsAppStatus = onCall(async (request) => {
  const teamId = (request.data as { teamId?: string })?.teamId
  await requireIntegrationManager(request, teamId)
  const credentials = await loadWhatsAppCredentials(teamId as string)
  if (!credentials) throw new HttpsError('failed-precondition', 'WhatsApp is not connected.')
  const graph = whatsappGraph()
  try {
    const phone = await graph.getPhoneNumber(credentials.token, credentials.phoneNumberId)
    const templates = await provisionLinyupTemplates(graph, credentials.token, credentials.wabaId, getHostingUrl())
    await patchWhatsAppIntegration(teamId as string, {
      status: 'connected',
      display_phone_number: phone.display_phone_number,
      verified_name: phone.verified_name,
      is_on_biz_app: phone.is_on_biz_app,
      quality_rating: phone.quality_rating,
      templates,
      last_error: null,
    })
  } catch (err) {
    throw metaFailure(err)
  }
  return { ok: true }
})

/**
 * Stops Linyup using the number: unsubscribes the app, deletes the token and the
 * number claim. The studio's WhatsApp account and app are untouched. Also the
 * plugin teardown's body, so uninstalling cannot leave a live token behind.
 */
export async function disconnectWhatsAppForTeam(teamId: string): Promise<void> {
  // Never connected: nothing to undo, and no doc to create.
  const [connectionSnap, integrationSnap] = await Promise.all([
    whatsappConnectionRef(teamId).get(),
    whatsappIntegrationRef(teamId).get(),
  ])
  if (!connectionSnap.exists && !integrationSnap.exists) return
  const credentials = await loadWhatsAppCredentials(teamId).catch((err) => {
    console.warn(`[whatsapp] could not read credentials for ${teamId} while disconnecting:`, err)
    return null
  })
  if (credentials) {
    try {
      await whatsappGraph().unsubscribeApp(credentials.token, credentials.wabaId)
    } catch (err) {
      // Best effort: the token is deleted below either way, and an event that
      // still arrives for an unclaimed number is dropped by the webhook.
      console.warn(`[whatsapp] unsubscribe failed for ${teamId}:`, (err as Error).message)
    }
  }
  const db = admin.firestore()
  await db.runTransaction(async (tx) => {
    const connection = await tx.get(whatsappConnectionRef(teamId))
    const numberId = connection.data()?.phone_number_id as string | undefined
    if (numberId) {
      const claim = await tx.get(whatsappNumberRef(numberId))
      if (claim.data()?.teamId === teamId) tx.delete(claim.ref)
    }
    tx.delete(connection.ref)
  })
  await patchWhatsAppIntegration(teamId, {
    status: 'disconnected',
    waba_id: null,
    phone_number_id: null,
    display_phone_number: null,
    verified_name: null,
    is_on_biz_app: null,
    quality_rating: null,
    templates: {},
    last_error: null,
  })
  await touchTeamForSurfaceRecompute(teamId)
}

export const disconnectWhatsApp = onCall(async (request) => {
  const teamId = (request.data as { teamId?: string })?.teamId
  await requireIntegrationManager(request, teamId)
  await disconnectWhatsAppForTeam(teamId as string)
  return { ok: true }
})
