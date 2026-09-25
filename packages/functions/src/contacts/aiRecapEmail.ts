// ─── Email the member recap ───────────────────────────────────────────────────
//
// The `ai-member-recap` module: from the AI summary on a contact, the studio
// sends the person the MEMBER-FACING recap (`ai_summary.member`) — where they
// stand, and one thing for their next session. Never the outlook: that part is a
// note about the person, not a message to them, and the model is not even asked
// for a member version of it (see ContactAiMemberRecap in @linyup/shared).
//
// ── A PERSON REVIEWS EVERY RECAP BEFORE IT LEAVES ────────────────────────────
// The two parts arrive from the dialog as the studio last edited them, not
// re-read from the contact. Model text addressed to a member goes out only after
// somebody at the studio has read it and pressed Send — which is also why there
// is no bulk or automated arm. The stored recap is still REQUIRED: the send
// stamps `ai_summary.member_sent_at` on the summary it came from, and a recap
// with no summary behind it would be free-form outreach under an AI label.
//
// ── IT IS OUTREACH, SO IT OBEYS OUTREACH'S RULES ─────────────────────────────
// `partitionRecipients` (outreach/recipients.ts) decides who may be mailed, so
// the studio's marketing opt-out is honored here exactly as in a template send;
// the idempotency key collapses a double click or a retry; the send lands in the
// contact's email history as `outreach_email_sent`, beside template sends.
//
// No model call happens here. The recap was written with the studio's summary,
// in the same call, so sending it costs an email and nothing else.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  AI_MODULES,
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  coachOwnsContact,
  composeMemberRecap,
  isLiveContact,
  renderMemberRecapHtml,
  type Contact,
} from '@linyup/shared'
import { to } from '../utils/async'
import { callerIsAllScoped, isTeamMember, requireCapability } from '../utils/teams'
import { pluginIsActive } from '../utils/plugins'
import { bucketRateLimit } from '../utils/rateLimit'
import { idempotencyKey, sendEmail } from '../utils/email'
import { buildOutreachEmail } from '../utils/outreachEmail'
import { getTeamContactEmail } from '../mail/senderConfig'
import { logActivity } from '../utils/users'
import { partitionRecipients } from '../outreach/recipients'

/** Recaps per user and team per hour — a person reviewing each one sends far fewer. */
const RATE_LIMIT_MAX = 20

type Request = {
  teamId?: string
  contactId?: string
  /** Stable per click of Send: a retry of the same send dedupes, a new one does not. */
  sendId?: string
  status?: string
  nextSession?: string
}

export type RecapSendResult =
  | { sent: true }
  /** The mail service declined it after the decision to send — a duplicate of
   *  this same send, a suppressed address, or the tenant's messaging policy. */
  | { sent: false; reason: 'not_delivered' }

export const sendContactRecapEmail = onCall(async (request): Promise<RecapSendResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId, contactId, sendId, status, nextSession } = (request.data ?? {}) as Request
  if (!teamId || !contactId || !sendId) {
    throw new HttpsError('invalid-argument', 'teamId, contactId and sendId are required.')
  }

  const [memberErr, isMember] = await to(isTeamMember(uid, teamId))
  if (memberErr || !isMember) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }
  // Mailing a contact is a write action — a viewer may not.
  await requireCapability(uid, teamId, 'contacts.manage')

  if (!(await pluginIsActive(teamId, AI_MODULES.memberRecap))) {
    throw new HttpsError('failed-precondition', 'Member recaps are not switched on for this team.')
  }

  const db = admin.firestore()
  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const contactSnap = await contactRef.get()
  const contact = contactSnap.exists
    ? ({ ...contactSnap.data(), id: contactSnap.id } as Contact)
    : null
  if (!contact || contact.teamId !== teamId) throw new HttpsError('not-found', 'Contact not found.')
  if (!isLiveContact(contact)) {
    throw new HttpsError('failed-precondition', 'This contact is archived.')
  }
  if (!(await callerIsAllScoped(uid, teamId)) && !coachOwnsContact(contact, uid)) {
    throw new HttpsError('permission-denied', 'This contact is not in your book.')
  }
  if (!contact.ai_summary?.member) {
    throw new HttpsError('failed-precondition', 'Generate the summary first.', { reason: 'no_recap' })
  }

  const verdict = partitionRecipients(contact as unknown as Record<string, unknown>, teamId)
  if (!verdict.ok) {
    // `no_email` and `unsubscribed` are the two a studio can act on; the card
    // names them rather than showing a generic failure.
    throw new HttpsError('failed-precondition', 'This contact cannot be emailed.', {
      reason: verdict.reason,
    })
  }

  await bucketRateLimit({
    collection: 'contact_recap_attempts',
    key: `${uid}:${teamId}`,
    limit: RATE_LIMIT_MAX,
    windowMs: 3_600_000,
    message: 'You have reached the hourly limit. Try again later.',
  })

  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  const teamData = (teamSnap.data() ?? {}) as Record<string, unknown>
  const teamName = String(teamData.name ?? '')
  // The language the recap was WRITTEN in, so the labels match the parts.
  const language = contact.ai_summary.language ?? teamData.language ?? 'en'

  const message = composeMemberRecap({
    firstname: contact.firstname,
    teamName,
    status: status ?? '',
    nextSession: nextSession ?? '',
    language,
  })
  if (!message.status || !message.nextSession) {
    throw new HttpsError('invalid-argument', 'Both parts of the recap need some text.')
  }

  const { html, text } = buildOutreachEmail({
    body: renderMemberRecapHtml(message),
    teamName,
    language: String(language),
    teamData,
  })
  // Same machine-readable opt-out as a template send (see outreach/index.ts).
  const [replyErr, contactEmail] = await to(getTeamContactEmail(teamId, teamData))
  const listUnsubscribe =
    !replyErr && contactEmail ? `<mailto:${contactEmail}?subject=Unsubscribe>` : undefined

  const outcome = await sendEmail({
    to: contact.email as string,
    subject: message.subject,
    html,
    text,
    teamId,
    tags: ['outreach', 'ai-recap'],
    ...(listUnsubscribe ? { listUnsubscribe } : {}),
    idempotencyKey: idempotencyKey('ai-recap', teamId, sendId, contactId),
  })
  // A deduped, policy-dropped or suppressed send is not a delivery: no stamp,
  // no history row claiming the person was mailed.
  if (outcome?.skipped) return { sent: false, reason: 'not_delivered' }

  // Dotted paths, so only the two stamps change — the summary beside them is
  // the model's and stays exactly as written.
  await contactRef.update({
    'ai_summary.member_sent_at': FieldValue.serverTimestamp(),
    'ai_summary.member_sent_by': uid,
  })
  await to(
    logActivity(teamId, {
      created_at: FieldValue.serverTimestamp(),
      event: 'outreach_email_sent',
      parameters: {
        description: `AI recap sent to ${contact.firstname ?? ''} ${contact.lastname ?? ''}.`.trim(),
        template_name: message.historyName,
        subject: message.subject,
        automated: false,
        ai_recap: true,
      },
      refs: { contact: contactId, user: uid },
    })
  )
  return { sent: true }
})
