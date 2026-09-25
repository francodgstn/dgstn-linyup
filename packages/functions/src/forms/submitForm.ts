// Public callable for the Custom Forms plugin. Anyone can submit a 'public'
// form; 'contacts' forms require a valid contact-session token (the same
// passwordless mechanism as the public Space). All writes go through the Admin
// SDK — Firestore rules block direct client writes to submissions.
//
// Mirrors the validation/contact-resolution shape of booking/bookSession and
// the notification + email pattern of bio-link/getInTouchForm. The staff
// notification is a `TeamNotification` (see ../utils/teamNotifications) —
// NOT the retired `team_alerts` collection.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  FORMS_COLLECTION,
  FORM_SUBMISSIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  CONTACTS_COLLECTION,
  CHOICE_FIELD_TYPES,
} from '@linyup/shared'
import type { Form, FormField } from '@linyup/shared'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { escapeHtml } from '../utils/html'
import { APP_CHECK_ENFORCE, monitorAppCheck } from '../utils/appCheck'
import { createTeamNotification } from '../utils/teamNotifications'
import { systemEmailEnabledFor } from '../utils/systemEmails'

const SUBMIT_RATE_LIMIT_MAX = 10 // per form, per IP, per hour
const RATE_WINDOW_MS = 60 * 60 * 1000

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function asString(val: unknown): string {
  return typeof val === 'string' ? val.trim() : ''
}

// Validate the submitted answers against the form's field definitions. Returns a
// cleaned answers map keyed by field id, or throws HttpsError on the first issue.
function validateAnswers(
  fields: FormField[],
  raw: Record<string, unknown>
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const field of fields) {
    const value = raw[field.id]
    const isChoice = CHOICE_FIELD_TYPES.includes(field.type)
    const isMulti = field.type === 'multiple_choice'
    const isEmpty =
      value == null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0)

    if (isEmpty) {
      if (field.required) {
        throw new HttpsError('invalid-argument', `Missing required field: ${field.label}`)
      }
      continue
    }

    if (field.type === 'email' && !EMAIL_RE.test(asString(value))) {
      throw new HttpsError('invalid-argument', `Invalid email in field: ${field.label}`)
    }

    if (isChoice) {
      const options = field.options ?? []
      const values = isMulti ? (Array.isArray(value) ? value : [value]) : [value]
      for (const v of values) {
        if (!options.includes(asString(v))) {
          throw new HttpsError('invalid-argument', `Invalid option for field: ${field.label}`)
        }
      }
      cleaned[field.id] = isMulti ? values.map(asString) : asString(value)
      continue
    }

    cleaned[field.id] = typeof value === 'string' ? value.trim() : value
  }
  return cleaned
}

// Resolve the email address to notify the studio at: custom team email, or the
// team owner's user email. Returns null if none can be resolved.
async function resolveStaffEmail(teamId: string): Promise<string | null> {
  const db = admin.firestore()
  const teamDoc = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  if (!teamDoc.exists) return null
  const settings = (teamDoc.data()!.settings as Record<string, unknown>) ?? {}

  if ((settings.notificationType as string) === 'custom' && settings.teamEmail) {
    return settings.teamEmail as string
  }

  let ownerId = settings.notificationOwnerUserId as string | undefined
  if (!ownerId) {
    const snap = await db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection('team_members')
      .where('role', '==', 'owner')
      .limit(1)
      .get()
    if (!snap.empty) ownerId = snap.docs[0].id
  }
  if (!ownerId) return null
  const userDoc = await db.collection('users').doc(ownerId).get()
  return userDoc.exists ? ((userDoc.data()!.email as string) ?? null) : null
}

function renderAnswersHtml(fields: FormField[], answers: Record<string, unknown>): string {
  const rows = fields
    .map((f) => {
      const v = answers[f.id]
      if (v == null || (Array.isArray(v) && v.length === 0) || v === '') return ''
      const display = Array.isArray(v) ? v.join(', ') : String(v)
      // Field labels and answers are attacker-controlled on public forms — escape
      // before interpolating, then re-introduce the intended newline <br> only.
      const labelHtml = escapeHtml(f.label)
      const displayHtml = escapeHtml(display).replace(/\n/g, '<br>')
      return `<tr><td style="padding:8px 12px;font-weight:600;color:#555;vertical-align:top;white-space:nowrap;">${labelHtml}</td><td style="padding:8px 12px;color:#333;">${displayHtml}</td></tr>`
    })
    .join('')
  return `<table style="width:100%;border-collapse:collapse;">${rows}</table>`
}

export const submitForm = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'submitForm')
  const data = request.data as {
    teamId?: string
    formId?: string
    answers?: Record<string, unknown>
    submitterEmail?: string
  }

  if (!data?.teamId || !data?.formId) {
    throw new HttpsError('invalid-argument', 'teamId and formId are required')
  }
  if (!data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) {
    throw new HttpsError('invalid-argument', 'answers must be an object')
  }

  const db = admin.firestore()
  const formRef = db.collection(FORMS_COLLECTION).doc(data.formId)
  const formDoc = await formRef.get()
  if (!formDoc.exists) throw new HttpsError('not-found', 'Form not found')

  const form = formDoc.data() as Form
  if (form.teamId !== data.teamId) {
    throw new HttpsError('permission-denied', 'Form does not belong to this team')
  }
  if (form.status !== 'published') {
    throw new HttpsError('failed-precondition', 'This form is not accepting responses')
  }

  // ── Access enforcement ──────────────────────────────────────────────────────
  // 'contacts' forms require a valid contact-session token scoped to this team.
  const token = request.auth?.token as
    | { contactId?: string; teamId?: string; sessionExpires?: number }
    | undefined
  const isContactSession =
    !!token?.contactId &&
    token.teamId === data.teamId &&
    typeof token.sessionExpires === 'number' &&
    token.sessionExpires >= Date.now()

  if (form.access === 'contacts' && !isContactSession) {
    throw new HttpsError('permission-denied', 'Please sign in to submit this form')
  }

  // ── Validate answers ────────────────────────────────────────────────────────
  const fields = Array.isArray(form.fields) ? form.fields : []
  const answers = validateAnswers(fields, data.answers)

  // ── IP rate limit (per form, per IP, per hour) ──────────────────────────────
  const ip = request.rawRequest?.ip || null
  if (ip) {
    const windowKey = Math.floor(Date.now() / RATE_WINDOW_MS).toString()
    const rlRef = db
      .collection('rate_limits')
      .doc(ip.replace(/[./:]/g, '_'))
      .collection('form_submit')
      .doc(`${data.formId}_${windowKey}`)
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(rlRef)
      const count = snap.exists ? (snap.data()!.count as number) : 0
      if (count >= SUBMIT_RATE_LIMIT_MAX) return false
      tx.set(rlRef, { count: count + 1, updated_at: FieldValue.serverTimestamp() }, { merge: true })
      return true
    })
    if (!allowed) {
      throw new HttpsError('resource-exhausted', 'Too many submissions. Please try again later.')
    }
  }

  // ── Resolve submitter email + contact link ──────────────────────────────────
  const emailFromField = form.emailFieldId ? asString(answers[form.emailFieldId]) : ''
  let submitterEmail =
    emailFromField || asString(data.submitterEmail) || null
  if (submitterEmail && !EMAIL_RE.test(submitterEmail)) submitterEmail = null

  let contactId: string | null = null
  let submittedByContact = false

  if (isContactSession && token?.contactId) {
    // Authenticated contact — link directly, trust the session.
    const contactDoc = await db.collection(CONTACTS_COLLECTION).doc(token.contactId).get()
    if (contactDoc.exists && contactDoc.data()!.teamId === data.teamId) {
      contactId = token.contactId
      submittedByContact = true
      if (!submitterEmail) submitterEmail = (contactDoc.data()!.email as string) ?? null
    }
  } else if (form.createContact !== false && submitterEmail) {
    // Lead capture: match an existing contact by email, else create one.
    const existing = await db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', data.teamId)
      .where('email', '==', submitterEmail)
      .limit(1)
      .get()
    if (!existing.empty) {
      contactId = existing.docs[0].id
    } else {
      const firstName = guessFirstName(fields, answers)
      const newRef = db.collection(CONTACTS_COLLECTION).doc()
      await newRef.set({
        firstname: firstName || submitterEmail.split('@')[0],
        lastname: '',
        email: submitterEmail,
        teamId: data.teamId,
        // A public form is an OFF-FUNNEL entry: a captured lead hasn't started the
        // trial→join journey, so NO acquisition_stage (not on the funnel). They enter
        // the funnel later if they book a trial. Mirrors the shop entry route.
        entry: 'form',
        // A captured lead doesn't count toward the contact cap until it materializes
        // (attends / joins / pays). No expiry — never auto-purged. See Contact.provisional.
        provisional: true,
        source: 'website',
        source_detail: form.title,
        lead_acknowledged: false,
        created_at: FieldValue.serverTimestamp(),
      })
      contactId = newRef.id
    }
  }

  // ── Write submission ────────────────────────────────────────────────────────
  const submissionRef = formRef.collection(FORM_SUBMISSIONS_SUBCOLLECTION).doc()
  await submissionRef.set({
    formId: data.formId,
    teamId: data.teamId,
    answers,
    contactId,
    submittedByContact,
    submitterEmail,
    status: 'new',
    submitted_at: FieldValue.serverTimestamp(),
    source_ip: ip,
  })
  await formRef.update({ submissionCount: FieldValue.increment(1) })

  // ── Notifications (per-form toggle; both non-fatal) ─────────────────────────
  // The in-app notification and the staff email are two INDEPENDENT try/catch
  // blocks, deliberately. They used to share one: resolveStaffEmail() ran FIRST,
  // so a lookup failure threw before the team_alerts write ever ran and the
  // in-app notification was lost as collateral of an unrelated email problem.
  // The in-app notification below is ALWAYS written when notifyStaff is on; the
  // email is additionally gated on the team's `form_submission_notification`
  // system-email toggle (absent ⇒ enabled).
  const notifyStaff = form.notifications?.notifyStaff !== false // default on
  if (notifyStaff) {
    try {
      await createTeamNotification(data.teamId, {
        type: 'form_submission',
        title: 'New form response',
        body: `New response to “${form.title}”.`,
        // The submissions list lives under the form's "responses" tab
        // (apps/web/src/app/[locale]/(auth)/plugins/custom-forms/[formId]/page.tsx,
        // FORM_TABS + useTabParam) — ?tab= is that page's existing URL convention.
        link: `/plugins/custom-forms/${data.formId}?tab=responses`,
        form_id: data.formId,
        submission_id: submissionRef.id,
        contact_id: contactId,
      })
    } catch (err) {
      console.error('Failed to create team notification for form submission', err)
    }

    try {
      if (await systemEmailEnabledFor(data.teamId, 'form_submission_notification')) {
        const staffEmail = await resolveStaffEmail(data.teamId)
        if (staffEmail) {
          const { html } = buildEmailTemplate({
            title: `New response: ${form.title}`,
            body: `<p>A new response to <strong>${escapeHtml(form.title)}</strong> has been submitted.</p>${renderAnswersHtml(fields, answers)}`,
          })
          await sendEmail({
            to: staffEmail,
            teamId: data.teamId,
            subject: `New response: ${form.title}`,
            html,
          })
        }
      }
    } catch (err) {
      console.error('Failed to notify staff of form submission', err)
    }
  }

  // ── Submitter confirmation (opt-in per form) ────────────────────────────────
  if (form.notifications?.confirmSubmitter && submitterEmail) {
    try {
      const title = form.confirmation?.emailSubject || `Thanks for your response`
      const body =
        form.confirmation?.emailBody ||
        form.confirmation?.message ||
        `<p>Thank you — we've received your response to <strong>${escapeHtml(form.title)}</strong>.</p>`
      const { html } = buildEmailTemplate({ title, body })
      await sendEmail({ to: submitterEmail, teamId: data.teamId, subject: title, html })
    } catch (err) {
      console.error('Failed to send submitter confirmation', err)
    }
  }

  return { success: true, submissionId: submissionRef.id }
})

// Best-effort first-name guess from a short_text field labeled like a name.
function guessFirstName(fields: FormField[], answers: Record<string, unknown>): string {
  const nameField = fields.find(
    (f) => f.type === 'short_text' && /name|nom|vorname/i.test(f.label)
  )
  return nameField ? asString(answers[nameField.id]) : ''
}
