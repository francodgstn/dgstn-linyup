/* eslint-disable no-console */
// A studio's OWN WhatsApp templates, written in Linyup and submitted to Meta.
// docs/whatsapp-outbound.md → "6b". The doc (`teams/{t}/whatsapp_templates/{id}`)
// is written only here; every client write is denied by the rules.
//
// ONE RULE shapes everything below: an approved template is never edited in
// place. An edit is a NEW submission under a new Meta name (`next`); the old
// one (`live`) keeps sending until Meta approves the new one, then the new one
// is promoted and the old one is deleted at Meta. Rules point at the Linyup id,
// so an edit never breaks an automation.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { randomBytes } from 'crypto'
import {
  TEAMS_COLLECTION,
  WHATSAPP_PLUGIN_ID,
  WHATSAPP_TEMPLATES_SUBCOLLECTION,
  WHATSAPP_TEMPLATE_LABEL_MAX,
  resolveWhatsAppLanguage,
  validateWhatsAppTemplateBody,
  whatsappTemplateForMeta,
  type WhatsAppStudioTemplate,
  type WhatsAppTemplateCategory,
  type WhatsAppTemplateSubmission,
} from '@linyup/shared'
import { assertPluginInstalled } from '../utils/plugins'
import { isTeamMember, requireCapability } from '../utils/teams'
import { loadWhatsAppCredentials } from './connection'
import { whatsappGraph, WhatsAppGraphError } from './graph'
import { normaliseTemplateStatus } from './templates'

function templatesRef(teamId: string): FirebaseFirestore.CollectionReference {
  return admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(WHATSAPP_TEMPLATES_SUBCOLLECTION)
}

/** A fresh Meta name: lowercase letters, digits and underscores, never reused. */
export function newMetaTemplateName(): string {
  return `lyp_${randomBytes(6).toString('hex')}`
}

/** The create payload for a studio template. Pure. */
export function buildStudioTemplateCreatePayload(args: {
  metaName: string
  language: string
  category: WhatsAppTemplateCategory
  body: string
}): Record<string, unknown> {
  const { text, params } = whatsappTemplateForMeta(args.body)
  return {
    name: args.metaName,
    language: args.language,
    category: args.category,
    parameter_format: 'NAMED',
    components: [
      {
        type: 'BODY',
        text,
        ...(params.length
          ? { example: { body_text_named_params: params.map((p) => ({ param_name: p.name, example: p.example })) } }
          : {}),
      },
    ],
  }
}

async function requireTemplateAuthor(request: { auth?: { uid: string } }, teamId: unknown): Promise<string> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  if (typeof teamId !== 'string' || !teamId) throw new HttpsError('invalid-argument', 'teamId is required.')
  const uid = request.auth.uid
  if (!(await isTeamMember(uid, teamId))) throw new HttpsError('permission-denied', 'You are not a member of this team.')
  // The same capability that writes email templates and automations.
  await requireCapability(uid, teamId, 'outreach.manage')
  return uid
}

async function deleteAtMetaQuietly(teamId: string, metaName: string | null | undefined): Promise<void> {
  if (!metaName) return
  try {
    const credentials = await loadWhatsAppCredentials(teamId)
    if (credentials) await whatsappGraph().deleteTemplate(credentials.token, credentials.wabaId, metaName)
  } catch (err) {
    // Best effort: an orphan at Meta sends nothing, because nothing here names it.
    console.warn(`[whatsapp] could not delete template ${metaName} at Meta for ${teamId}:`, (err as Error).message)
  }
}

export const submitWhatsAppTemplate = onCall(async (request) => {
  const { teamId, templateId, label, category, body } = (request.data ?? {}) as Record<string, unknown>
  const uid = await requireTemplateAuthor(request, teamId)
  const team = teamId as string
  await assertPluginInstalled(team, WHATSAPP_PLUGIN_ID)

  const cleanLabel = typeof label === 'string' ? label.trim() : ''
  if (!cleanLabel || cleanLabel.length > WHATSAPP_TEMPLATE_LABEL_MAX) {
    throw new HttpsError('invalid-argument', 'Give the message a name.', { reason: 'label' })
  }
  if (category !== 'UTILITY' && category !== 'MARKETING') {
    throw new HttpsError('invalid-argument', 'category must be UTILITY or MARKETING.')
  }
  const text = typeof body === 'string' ? body.trim() : ''
  const { problems, unknown } = validateWhatsAppTemplateBody(text)
  if (problems.length) {
    throw new HttpsError('invalid-argument', 'The message cannot be submitted as written.', {
      reason: 'body',
      problems,
      unknown,
    })
  }

  const credentials = await loadWhatsAppCredentials(team)
  if (!credentials) throw new HttpsError('failed-precondition', 'WhatsApp is not connected.', { reason: 'not_connected' })

  const teamSnap = await admin.firestore().collection(TEAMS_COLLECTION).doc(team).get()
  const language = resolveWhatsAppLanguage(teamSnap.data()?.language as string | undefined)

  const ref = typeof templateId === 'string' && templateId ? templatesRef(team).doc(templateId) : templatesRef(team).doc()
  const existing = ref.id === templateId ? ((await ref.get()).data() as WhatsAppStudioTemplate | undefined) : undefined
  if (templateId && !existing) throw new HttpsError('not-found', 'Message not found.')

  // A label-only edit changes nothing at Meta.
  const current = existing?.next ?? existing?.live
  if (existing && current && current.body === text && current.category === category) {
    await ref.update({ label: cleanLabel, updated_at: FieldValue.serverTimestamp() })
    return { id: ref.id, status: current.status }
  }

  const metaName = newMetaTemplateName()
  let status: string
  try {
    ;({ status } = await whatsappGraph().createTemplate(
      credentials.token,
      credentials.wabaId,
      buildStudioTemplateCreatePayload({ metaName, language, category, body: text }),
    ))
  } catch (err) {
    if (err instanceof WhatsAppGraphError) {
      throw new HttpsError('failed-precondition', err.message, { reason: 'meta_error', code: err.code })
    }
    throw err
  }

  const submission: WhatsAppTemplateSubmission = {
    meta_name: metaName,
    category,
    body: text,
    status: normaliseTemplateStatus(status),
    reason: null,
    submitted_at: Timestamp.now(),
  }
  // An edit replaces a still-pending edit: that one will never be promoted.
  if (existing?.next) await deleteAtMetaQuietly(team, existing.next.meta_name)

  if (submission.status === 'APPROVED') {
    // Approved on the spot (Meta does this for some utility text): promote now.
    if (existing?.live) await deleteAtMetaQuietly(team, existing.live.meta_name)
    await ref.set(
      {
        label: cleanLabel,
        language,
        live: submission,
        next: null,
        updated_at: FieldValue.serverTimestamp(),
        ...(existing ? {} : { created_by: uid, created_at: FieldValue.serverTimestamp() }),
      },
      { mergeFields: ['label', 'language', 'live', 'next', 'updated_at', ...(existing ? [] : ['created_by', 'created_at'])] },
    )
  } else {
    await ref.set(
      {
        label: cleanLabel,
        language,
        next: submission,
        updated_at: FieldValue.serverTimestamp(),
        ...(existing ? {} : { live: null, created_by: uid, created_at: FieldValue.serverTimestamp() }),
      },
      {
        mergeFields: ['label', 'language', 'next', 'updated_at', ...(existing ? [] : ['live', 'created_by', 'created_at'])],
      },
    )
  }
  return { id: ref.id, status: submission.status }
})

export const deleteWhatsAppTemplate = onCall(async (request) => {
  const { teamId, templateId } = (request.data ?? {}) as Record<string, unknown>
  await requireTemplateAuthor(request, teamId)
  if (typeof templateId !== 'string' || !templateId) throw new HttpsError('invalid-argument', 'templateId is required.')
  const ref = templatesRef(teamId as string).doc(templateId)
  const doc = (await ref.get()).data() as WhatsAppStudioTemplate | undefined
  if (!doc) return { ok: true }
  await deleteAtMetaQuietly(teamId as string, doc.live?.meta_name)
  await deleteAtMetaQuietly(teamId as string, doc.next?.meta_name)
  // A rule still pointing at it skips with `template_not_approved`, like a
  // deleted email template.
  await ref.delete()
  return { ok: true }
})

/** Finds the studio template holding this Meta name, as `live` or `next`. */
async function findByMetaName(
  teamId: string,
  metaName: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; doc: WhatsAppStudioTemplate; slot: 'live' | 'next' } | null> {
  for (const slot of ['next', 'live'] as const) {
    const snap = await templatesRef(teamId).where(`${slot}.meta_name`, '==', metaName).limit(1).get()
    const hit = snap.docs[0]
    if (hit) return { ref: hit.ref, doc: hit.data() as WhatsAppStudioTemplate, slot }
  }
  return null
}

/**
 * Meta's review result for a studio template. Approving `next` promotes it and
 * deletes the old live version at Meta; any other result is recorded on the
 * submission it is about. Returns false when the name is not a studio template.
 */
export async function applyStudioTemplateStatus(
  teamId: string,
  metaName: string,
  event: string,
  reason: string | null,
): Promise<boolean> {
  const found = await findByMetaName(teamId, metaName)
  if (!found) return false
  const status = normaliseTemplateStatus(event)
  const { ref, doc, slot } = found
  if (slot === 'next' && status === 'APPROVED') {
    const oldLive = doc.live?.meta_name
    await ref.update({
      live: { ...doc.next!, status, reason: null },
      next: null,
      updated_at: FieldValue.serverTimestamp(),
    })
    if (oldLive && oldLive !== metaName) await deleteAtMetaQuietly(teamId, oldLive)
    return true
  }
  await ref.update({
    [`${slot}.status`]: status,
    [`${slot}.reason`]: reason,
    updated_at: FieldValue.serverTimestamp(),
  })
  return true
}

/** Meta moved a template to another category — most often utility → marketing,
 *  which changes both its price and the answer it needs. */
export async function applyStudioTemplateCategory(
  teamId: string,
  metaName: string,
  category: string,
): Promise<boolean> {
  if (category !== 'UTILITY' && category !== 'MARKETING') return false
  const found = await findByMetaName(teamId, metaName)
  if (!found) return false
  await found.ref.update({
    [`${found.slot}.category`]: category,
    [`${found.slot}.recategorized_at`]: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  return true
}
