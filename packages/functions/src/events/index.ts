import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import * as crypto from 'crypto'
import { isRosterContact } from '@linyup/shared'
import { to } from '../utils/async'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { detailsBox, ctaButton, factLines } from '../utils/emailLayout'
import { escapeHtml } from '../utils/html'
import { getHostingUrl } from '../utils/env'

const EVENTS_COLLECTION = 'events'
const CONTACTS_COLLECTION = 'contacts'
const INVITATIONS_SUBCOLLECTION = 'invitations'
const ATTENDEES_SUBCOLLECTION = 'attendees'

// ─── helpers ──────────────────────────────────────────────────────────────────

function generateInvitationToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

// An invitation token is a bearer credential that reveals contact PII on an
// unauthenticated callable, so it must not live forever. Bound its lifetime to
// the event itself: valid until the event ends (24h grace for late RSVP/viewing),
// falling back to the start time, and only then to a 30-day cap when the event
// carries no timestamps at all.
const INVITATION_GRACE_MS = 24 * 60 * 60 * 1000
const INVITATION_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000
function invitationExpiry(event: Record<string, unknown>): Timestamp {
  const end = (event.end as Timestamp | undefined)?.toDate()
  const start = (event.start as Timestamp | undefined)?.toDate()
  const base = end ?? start
  const ms = base ? base.getTime() + INVITATION_GRACE_MS : Date.now() + INVITATION_FALLBACK_MS
  return Timestamp.fromMillis(ms)
}

// Legacy invitations predate the expiresAt field — treat a missing value as
// non-expiring so existing links keep working; new/resent tokens always carry it.
function invitationExpired(inv: Record<string, unknown>): boolean {
  const expiresAt = inv.expiresAt as Timestamp | undefined
  return expiresAt != null && expiresAt.toMillis() < Date.now()
}

function googleCalendarLink(
  title: string,
  start: Date,
  end: Date,
  location: string,
  description: string
): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0]
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: description,
    location,
  })
  return `https://calendar.google.com/calendar/render?${p.toString()}`
}

function buildInvitationEmail(params: {
  firstname: string
  teamName: string
  eventTitle: string
  eventStart: string
  eventEnd: string
  location: string
  link: string
  calendarLink: string
  fee: string
}): { subject: string; html: string; text: string } {
  const {
    firstname,
    teamName,
    eventTitle,
    eventStart,
    eventEnd,
    location,
    link,
    calendarLink,
    fee,
  } = params
  const subject = `Invitation: ${eventTitle}`
  // Escape all text interpolations (firstname is contact-controlled; event fields
  // are studio-authored). Links are server-generated (hex token / URLSearchParams).
  const facts = [
    `<strong>When:</strong> ${escapeHtml(eventStart)}${eventEnd ? ` – ${escapeHtml(eventEnd)}` : ''}`,
    location ? `<strong>Location:</strong> ${escapeHtml(location)}` : '',
    fee ? `<strong>Fee:</strong> ${escapeHtml(fee)}` : '',
  ]
  const calHtml = calendarLink
    ? `<p style="text-align:center;"><a href="${calendarLink}">Add to Google Calendar</a></p>`
    : ''
  const { html } = buildEmailTemplate({
    title: 'You are invited',
    body: `<p>Hi ${escapeHtml(firstname)},</p><p>${escapeHtml(teamName)} invites you to <strong>${escapeHtml(eventTitle)}</strong>.</p>${detailsBox({ content: factLines(facts) })}<p style="text-align:center;margin-top:24px;">${ctaButton(link, 'View invitation &amp; RSVP')}</p>${calHtml}`,
  })
  const text = `Hi ${firstname},\n\n${teamName} invites you to ${eventTitle}.\nWhen: ${eventStart}${eventEnd ? ` – ${eventEnd}` : ''}\n${location ? `Location: ${location}\n` : ''}${fee ? `Fee: ${fee}\n` : ''}\nRSVP: ${link}`
  return { subject, html, text }
}

// ─── sendEventInvitations ─────────────────────────────────────────────────────

export const sendEventInvitations = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'User must be authenticated')

  const { eventId, resend } = request.data as { eventId?: string; resend?: boolean }
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId is required')

  const db = admin.firestore()

  const [eventErr, eventDoc] = await to(db.collection(EVENTS_COLLECTION).doc(eventId).get())
  if (eventErr || !eventDoc || !eventDoc.exists)
    throw new HttpsError('not-found', 'Event not found')

  const event = eventDoc.data()!
  const teamId = (event.teamId || event.teacher) as string | undefined
  if (!teamId) throw new HttpsError('failed-precondition', 'Event has no team')

  const eventEnd = event.end as Timestamp | undefined
  if (eventEnd && eventEnd.toDate() < new Date()) {
    throw new HttpsError(
      'failed-precondition',
      'Cannot send invitations for an event that has already ended'
    )
  }

  // Get team info for email
  const [teamErr, teamDoc] = await to(db.collection('teams').doc(teamId).get())
  const teamName =
    !teamErr && teamDoc && teamDoc.exists
      ? (teamDoc.data()!.name as string) || 'Our Team'
      : 'Our Team'

  // Everyone on the ROSTER with an email address: live by query, then minus
  // externals in memory (`external` is present only when true, so its absence
  // cannot be queried). An invitation to everyone is the studio addressing the
  // people it looks after — a partner-app drop-in is not one of them.
  const [contactsErr, contactsSnap] = await to(
    db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('deleted_at', '==', null)
      .where('archived_at', '==', null)
      .get()
  )
  const rosterDocs = (contactsSnap?.docs ?? []).filter((d) => isRosterContact(d.data()))
  if (contactsErr || rosterDocs.length === 0) {
    throw new HttpsError('failed-precondition', 'No active contacts to invite')
  }

  // Get existing invitations
  const invRef = eventDoc.ref.collection(INVITATIONS_SUBCOLLECTION)
  const [, existingSnap] = await to(invRef.get())
  const existing = new Map<string, Record<string, unknown>>()
  existingSnap?.docs.forEach((d) => existing.set(d.id, d.data()))

  const eventStartDate = (event.start as Timestamp | undefined)?.toDate()
  const eventEndDate = (event.end as Timestamp | undefined)?.toDate()
  const locale = 'en-GB'
  const eventStart = eventStartDate
    ? eventStartDate.toLocaleString(locale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Zurich',
      })
    : 'TBD'
  const eventEndStr = eventEndDate
    ? eventEndDate.toLocaleString(locale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Zurich',
      })
    : ''
  const calLink = eventStartDate
    ? googleCalendarLink(
        event.title as string,
        eventStartDate,
        eventEndDate ?? new Date(eventStartDate.getTime() + 2 * 3600000),
        (event.location as string) || '',
        (event.desc as string) || ''
      )
    : ''

  let sent = 0
  let skipped = 0
  const errors: Array<{ contactId: string; error: string }> = []

  await Promise.all(
    rosterDocs.map(async (contactDoc) => {
      const email = contactDoc.data().email as string | undefined
      if (!email) return

      const existingInv = existing.get(contactDoc.id)
      if (existingInv && !resend) {
        skipped++
        return
      }

      // Rotate the token on every (re)send: a resent invitation invalidates any
      // previously emailed link so a leaked/forwarded old link stops working.
      const token = generateInvitationToken()
      const expiresAt = invitationExpiry(event)
      const link = `${getHostingUrl()}/public/event-invitation?token=${encodeURIComponent(token)}`

      const emailContent = buildInvitationEmail({
        firstname: (contactDoc.data().firstname as string) || 'Guest',
        teamName,
        eventTitle: (event.title as string) || 'Event',
        eventStart,
        eventEnd: eventEndStr,
        location: (event.location as string) || '',
        link,
        calendarLink: calLink,
        fee: (event.fee as string) || '',
      })

      try {
        await sendEmail({
          to: email,
          teamId,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
        })

        const baseData = {
          contactId: contactDoc.id,
          email,
          firstname: contactDoc.data().firstname,
          lastname: contactDoc.data().lastname,
          sentAt: FieldValue.serverTimestamp(),
          sentBy: request.auth!.uid,
          token,
          expiresAt,
          link,
          eventId,
        }
        if (existingInv) {
          await invRef.doc(contactDoc.id).update(baseData)
        } else {
          await invRef
            .doc(contactDoc.id)
            .set({
              ...baseData,
              status: 'sent',
              firstOpenedAt: null,
              lastOpenedAt: null,
              respondedAt: null,
            })
        }
        sent++
      } catch (err) {
        console.error(`Error inviting ${email}:`, err)
        errors.push({
          contactId: contactDoc.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  )

  await to(
    eventDoc.ref.update({
      invitations_sent_count: FieldValue.increment(sent),
      last_invitation_sent_at: FieldValue.serverTimestamp(),
    })
  )

  // Surface a clear error when every send attempt failed so the client shows a
  // meaningful message rather than silently treating zero-sent as success.
  if (sent === 0 && errors.length > 0) {
    throw new HttpsError('internal', errors[0].error)
  }

  return { success: true, stats: { sent, skipped, errors } }
})

// ─── getEventInvitationDetails ────────────────────────────────────────────────

export const getEventInvitationDetails = onCall(async (request) => {
  const { token, trackView = true } = request.data as { token?: string; trackView?: boolean }
  if (!token) throw new HttpsError('invalid-argument', 'token is required')

  const db = admin.firestore()

  const [invSnapErr, invSnap] = await to(
    db.collectionGroup(INVITATIONS_SUBCOLLECTION).where('token', '==', token).limit(1).get()
  )
  if (invSnapErr || !invSnap || invSnap.empty)
    throw new HttpsError('not-found', 'Invitation not found')

  const invDoc = invSnap.docs[0]
  if (invitationExpired(invDoc.data()))
    throw new HttpsError('failed-precondition', 'This invitation link has expired')
  const pathParts = invDoc.ref.path.split('/')
  const eventId = pathParts[1]
  const contactId = invDoc.data().contactId as string

  const [eventErr, eventDoc] = await to(db.collection(EVENTS_COLLECTION).doc(eventId).get())
  if (eventErr || !eventDoc || !eventDoc.exists)
    throw new HttpsError('not-found', 'Event not found')

  const [contactErr, contactDoc] = await to(db.collection(CONTACTS_COLLECTION).doc(contactId).get())
  if (contactErr || !contactDoc || !contactDoc.exists)
    throw new HttpsError('not-found', 'Contact not found')

  // Check if already an attendee
  const [attErr, attDoc] = await to(
    eventDoc.ref.collection(ATTENDEES_SUBCOLLECTION).doc(contactId).get()
  )
  const attendee = !attErr && attDoc && attDoc.exists ? { id: contactId, ...attDoc.data() } : null

  if (trackView) {
    const currentStatus = invDoc.data().status as string
    const updateData: Record<string, unknown> = { lastOpenedAt: FieldValue.serverTimestamp() }
    if (currentStatus === 'sent') {
      updateData.status = 'opened'
      updateData.firstOpenedAt = FieldValue.serverTimestamp()
    }
    await to(invDoc.ref.update(updateData))
  }

  const event = eventDoc.data()!
  const contact = contactDoc.data()!
  return {
    event: {
      id: eventDoc.id,
      title: event.title,
      description: (event.description ?? event.desc) as string | undefined,
      start: (event.start as Timestamp)?.toDate().toJSON(),
      end: (event.end as Timestamp)?.toDate().toJSON(),
      location: event.location,
      type: event.type,
      fee: event.fee,
      status: event.status,
    },
    contact: {
      id: contactDoc.id,
      firstname: contact.firstname,
      lastname: contact.lastname,
      email: contact.email,
      gender: contact.gender,
      acquisition_stage: contact.acquisition_stage,
    },
    attendee,
    token,
  }
})

// ─── handleEventInvitationResponse ───────────────────────────────────────────

export const handleEventInvitationResponse = onCall(async (request) => {
  const { token, action, notes } = request.data as {
    token?: string
    action?: 'attend' | 'decline'
    notes?: string
  }
  if (!token) throw new HttpsError('invalid-argument', 'token is required')
  if (!action || !['attend', 'decline'].includes(action))
    throw new HttpsError('invalid-argument', 'action must be "attend" or "decline"')

  const db = admin.firestore()

  const [invSnapErr, invSnap] = await to(
    db.collectionGroup(INVITATIONS_SUBCOLLECTION).where('token', '==', token).limit(1).get()
  )
  if (invSnapErr || !invSnap || invSnap.empty)
    throw new HttpsError('not-found', 'Invitation not found')

  const invDoc = invSnap.docs[0]
  if (invitationExpired(invDoc.data()))
    throw new HttpsError('failed-precondition', 'This invitation link has expired')
  const pathParts = invDoc.ref.path.split('/')
  const eventId = pathParts[1]
  const contactId = invDoc.data().contactId as string

  const [eventErr, eventDoc] = await to(db.collection(EVENTS_COLLECTION).doc(eventId).get())
  if (eventErr || !eventDoc || !eventDoc.exists)
    throw new HttpsError('not-found', 'Event not found')

  const event = eventDoc.data()!
  if (event.status !== 'open')
    throw new HttpsError('failed-precondition', 'Event is not open for registrations')

  const [contactErr, contactDoc] = await to(db.collection(CONTACTS_COLLECTION).doc(contactId).get())
  if (contactErr || !contactDoc || !contactDoc.exists)
    throw new HttpsError('not-found', 'Contact not found')

  const attendeeRef = eventDoc.ref.collection(ATTENDEES_SUBCOLLECTION).doc(contactId)

  if (action === 'decline') {
    await to(attendeeRef.delete())
    await invDoc.ref.update({ status: 'declined', respondedAt: FieldValue.serverTimestamp() })
    await to(eventDoc.ref.update({ attendees_count: FieldValue.increment(-1) }))
    return { success: true, action: 'declined' }
  }

  // action === 'attend'
  const contact = contactDoc.data()!
  const attendeeData = {
    contactId,
    firstname: contact.firstname,
    lastname: contact.lastname,
    email: contact.email,
    gender: contact.gender,
    acquisition_stage: contact.acquisition_stage,
    notes: notes ?? null,
    respondedAt: FieldValue.serverTimestamp(),
  }

  const [attGetErr, attDoc] = await to(attendeeRef.get())
  const isNew = attGetErr || !attDoc || !attDoc.exists

  await attendeeRef.set(attendeeData, { merge: true })
  await invDoc.ref.update({ status: 'responded', respondedAt: FieldValue.serverTimestamp() })
  if (isNew) await to(eventDoc.ref.update({ attendees_count: FieldValue.increment(1) }))

  return { success: true, action: 'attending', attendee: { id: contactId, ...attendeeData } }
})
