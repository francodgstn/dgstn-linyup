// Ported from hmd-lineup/functions/src/sendOutreachEmail/index.js
// Sends outreach emails to one or more contacts using a team-defined template.
//
// This is BULK marketing mail, which makes three things non-optional — the
// decisions live in ./recipients.ts, pure and unit-tested:
//
//  • CONSENT. Contact.email_unsubscribed is the studio's own marketing opt-out
//    and must be honored here. The mail service's suppression list is a
//    different thing (bounces/blocks/spam reports from the ESP) and does not
//    cover it — the automation engine has always checked this flag; the manual
//    path did not, and quietly mailed people who had opted out.
//  • IDEMPOTENCY. A double-click, a network retry or a client retry must not
//    mail anyone twice. Each recipient gets a stable key derived from the
//    caller-supplied sendId, so retries collapse while a deliberate re-send
//    tomorrow (new sendId) still goes out.
//  • BOUNDED CONCURRENCY. The old code fired every recipient at the ESP at once
//    via Promise.allSettled, which at a few hundred contacts means a burst of
//    parallel HTTP calls against the request's own deadline.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { to } from '../utils/async'
import { isTeamMember, requireCapability } from '../utils/teams'
import { sendEmail, idempotencyKey } from '../utils/email'
import { logActivity } from '../utils/users'
import { substituteVariables, renderBody, buildOutreachEmail } from '../utils/outreachEmail'
import { getTeamContactEmail } from '../mail/senderConfig'
import {
  MAX_RECIPIENTS, CONCURRENCY,
  partitionRecipients, mapWithConcurrency, emptyOutreachStats,
  type OutreachSkipReason,
} from './recipients'

const TEAMS_COLLECTION = 'teams'
const CONTACTS_COLLECTION = 'contacts'
const OUTREACH_TEMPLATES_SUBCOLLECTION = 'outreach_templates'

export const sendOutreachEmail = onCall(
  // Bulk sends are I/O-bound and long: the default 60s deadline is not enough
  // for a few hundred ESP round trips at CONCURRENCY in flight.
  { timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated.')

    const { contactIds, templateId, teamId, sendId } = request.data as {
      contactIds: string[]
      templateId: string
      teamId: string
      // Stable per user-initiated send. Retries of the SAME send reuse it and
      // dedupe; a new send gets a new one. Absent ⇒ no dedupe (legacy callers).
      sendId?: string
    }

    console.log('[sendOutreachEmail] Called with:', {
      contactCount: contactIds?.length ?? 0, templateId, teamId, sendId,
    })

    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      throw new HttpsError('invalid-argument', 'contactIds must be a non-empty array.')
    }
    if (contactIds.length > MAX_RECIPIENTS) {
      throw new HttpsError(
        'invalid-argument',
        `Too many recipients: ${contactIds.length} (max ${MAX_RECIPIENTS} per send).`,
      )
    }
    if (!templateId) throw new HttpsError('invalid-argument', 'templateId is required.')
    if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.')

    // The same contact listed twice would otherwise cost a wasted round trip
    // before the idempotency key caught it.
    const uniqueContactIds = [...new Set(contactIds)]

    const callerId = request.auth.uid
    const db = admin.firestore()

    const [memberErr, isMember] = await to(isTeamMember(callerId, teamId))
    if (memberErr || !isMember) throw new HttpsError('permission-denied', 'You are not a member of this team.')
    // Sending outreach is a write action — viewers (read-only) may not send.
    await requireCapability(callerId, teamId, 'contacts.manage')

    const [templateErr, templateDoc] = await to(
      db.collection(TEAMS_COLLECTION).doc(teamId).collection(OUTREACH_TEMPLATES_SUBCOLLECTION).doc(templateId).get()
    )
    if (templateErr || !templateDoc || !templateDoc.exists) throw new HttpsError('not-found', 'Outreach template not found.')

    const template = templateDoc.data()!
    if (!template.active) throw new HttpsError('not-found', 'Outreach template is inactive.')

    const [teamErr, teamDoc] = await to(db.collection(TEAMS_COLLECTION).doc(teamId).get())
    const teamData = (!teamErr && teamDoc && teamDoc.exists ? teamDoc.data() : {}) as Record<string, unknown>
    const teamName = (teamData.name as string) || ''

    // Machine-readable opt-out on every message in this bulk send. The footer
    // already asks people to write in; this is what mail clients actually read
    // to render an Unsubscribe button, and what the big inbox providers expect
    // from a bulk sender. Resolved once — it's the same for the whole send.
    // NOTE: this is the mailto form, so unsubscribing still lands in the
    // studio's inbox as a human request. One-click (RFC 8058) needs a public
    // HTTP endpoint that flips Contact.email_unsubscribed; see docs.
    const [replyErr, contactEmail] = await to(getTeamContactEmail(teamId, teamData))
    const listUnsubscribe = !replyErr && contactEmail
      ? `<mailto:${contactEmail}?subject=Unsubscribe>`
      : undefined

    const stats = emptyOutreachStats(uniqueContactIds.length)
    const skip = (reason: OutreachSkipReason) => {
      stats.skipped++
      stats.skippedByReason[reason]++
    }

    await mapWithConcurrency(uniqueContactIds, CONCURRENCY, async (contactId) => {
      try {
        const [contactErr, contactDoc] = await to(db.collection(CONTACTS_COLLECTION).doc(contactId).get())
        const contact = (!contactErr && contactDoc?.exists ? contactDoc.data() : null) as
          | Record<string, unknown>
          | null

        const verdict = partitionRecipients(contact, teamId)
        if (!verdict.ok) {
          skip(verdict.reason)
          return
        }

        const now = new Date()
        const subject = substituteVariables(template.subject as string, contact!, teamName, now, teamData)
        const rawBody = substituteVariables(template.body as string, contact!, teamName, now, teamData)
        const htmlBody = renderBody(template as { body_mode?: string }, rawBody)
        const { html, text } = buildOutreachEmail({ body: htmlBody, teamName, language: (template.language as string) || 'en', teamData })

        const outcome = await sendEmail({
          to: contact!.email as string,
          subject,
          html,
          text,
          teamId,
          tags: ['outreach'],
          ...(listUnsubscribe ? { listUnsubscribe } : {}),
          ...(sendId ? { idempotencyKey: idempotencyKey('outreach', teamId, sendId, contactId) } : {}),
        })

        // A deduped, policy-dropped or ESP-suppressed send is not a delivery.
        // Logging an activity here would claim the contact was mailed when they
        // weren't — and calling it 'unsubscribed' would misattribute a retry.
        if (outcome?.skipped) {
          skip('not_delivered')
          return
        }

        await to(
          logActivity(teamId, {
            created_at: FieldValue.serverTimestamp(),
            event: 'outreach_email_sent',
            parameters: {
              description: `Outreach email "${template.name as string}" sent to ${contact!.firstname as string} ${contact!.lastname as string}.`,
              template_name: template.name,
              template_id: templateId,
              subject,
              automated: false,
            },
            refs: { contact: contactId, user: callerId },
          })
        )

        stats.sent++
      } catch (error) {
        const err = error as Error
        console.error(`[sendOutreachEmail] ✗ Failed for contact ${contactId}:`, err.message)
        stats.failed++
        // Bounded so a mass failure can't return a megabyte of identical strings.
        if (stats.errors.length < 20) stats.errors.push({ contactId, error: err.message })
      }
    })

    console.log(
      `[sendOutreachEmail] Done. Sent: ${stats.sent}, skipped: ${stats.skipped}, failed: ${stats.failed}`
    )
    return { success: true, stats }
  }
)
