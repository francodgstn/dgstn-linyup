// Ported from hmd-lineup/functions/src/requestContactUpdate/index.js
// Creates a contact data update request. Supports two auth modes:
//   1. contact session — the passwordless contact session (web Space portal,
//                        mobile, and /contact-update when the signed-in contact is
//                        the link's contact), identified by the custom-token claims
//   2. codeId         — from the /contact-update email-verification flow; when
//                        sent, it wins over any session (see below)
//
// A third mode, `authToken` (an `auth_tokens` doc from the student app), was
// removed 2026-07-17: its only minter (`generateAuthToken`) never wrote the
// snake_case shape this read, so the branch was unreachable. The student app now
// uses its contact session — see docs/security-audit-2026-07.md.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { createTeamNotification } from '../utils/teamNotifications'

const CONTACT_REQUESTS_SUBCOLLECTION = 'contact_requests'

/**
 * Which proof authorizes the request. A CODE, WHEN SENT, DECIDES — even with a
 * session present. The code path binds the request to the contact in the mailed
 * link; the session path writes to the session's own contact. A signed-in member
 * who opens a link for somebody else (a child sharing a parent's address) and
 * proves the email must update THAT contact, not themselves — which is what
 * trusting the session first did.
 */
export function contactUpdateAuthMode(input: {
  codeId?: string
  sessionContactId?: string
}): 'code' | 'session' | null {
  if (input.codeId) return 'code'
  if (input.sessionContactId) return 'session'
  return null
}

export const requestContactUpdate = onCall(async (request) => {
  const { codeId, contactDetails, note } = request.data as {
    codeId?: string
    contactId?: string
    teamId?: string
    contactDetails: Record<string, unknown>
    note?: string
  }

  // Contact-session claims, minted by buildContactSession: { contactId, teamId,
  // sessionExpires (epoch ms) }. Present when an authenticated portal contact calls.
  const sessionContactId = request.auth?.token?.contactId as string | undefined
  const sessionTeamId = request.auth?.token?.teamId as string | undefined
  const sessionExpires = request.auth?.token?.sessionExpires as number | undefined

  const authMode = contactUpdateAuthMode({ codeId, sessionContactId })
  if (!authMode)
    throw new HttpsError('invalid-argument', 'Missing required field: codeId, or a contact session')
  if (!contactDetails)
    throw new HttpsError('invalid-argument', 'Missing required field: contactDetails')

  const firstname = (contactDetails.firstname as string)?.trim()
  const lastname = (contactDetails.lastname as string)?.trim()
  if (!firstname || !lastname)
    throw new HttpsError('invalid-argument', 'First name and last name are required')

  let contactId: string = request.data.contactId ?? ''
  let teamId: string = request.data.teamId ?? ''

  const db = admin.firestore()
  let codeRef: admin.firestore.DocumentReference | null = null

  if (authMode === 'session') {
    // ── Contact-session auth (web Space portal / mobile) ────────────────────────
    // Trust the custom-token claims (minted server-side after email verification);
    // refuse a session past its 7-day window.
    if (!sessionTeamId)
      throw new HttpsError('permission-denied', 'Contact session is missing a team')
    if (typeof sessionExpires === 'number' && sessionExpires < Date.now())
      throw new HttpsError('deadline-exceeded', 'Contact session has expired. Please sign in again.')
    contactId = sessionContactId!
    teamId = sessionTeamId
    console.log(`Session-based contact update request from contact ${contactId} for team ${teamId}`)
  } else {
    // ── Code-based auth (bio-link email verification) ───────────────────────────
    if (!contactId) throw new HttpsError('invalid-argument', 'Missing required field: contactId')
    if (!teamId) throw new HttpsError('invalid-argument', 'Missing required field: teamId')

    codeRef = db.collection('verification_codes').doc(codeId!)
    const codeDoc = await codeRef.get()
    if (!codeDoc.exists) throw new HttpsError('not-found', 'Invalid verification code')

    const codeData = codeDoc.data()!
    if (!codeData.verified)
      throw new HttpsError(
        'failed-precondition',
        'Email not verified. Please verify your email first.'
      )
    if (codeData.used)
      throw new HttpsError('already-exists', 'This verification code has already been used')

    const verifiedAt = codeData.verifiedAt as Timestamp
    const thirtyMinutesAgo = Timestamp.fromMillis(Date.now() - 30 * 60 * 1000)
    if (verifiedAt.toMillis() < thirtyMinutesAgo.toMillis())
      throw new HttpsError('deadline-exceeded', 'Verification expired. Please start over.')

    // BIND the code to the target contact. A verified code proves control of the
    // EMAIL it was sent to and nothing more, so it may only author an update for a
    // contact that email actually matched (recorded on the code doc when it was
    // sent). Without this, contactId/teamId are both taken from the request body,
    // so any verified code — trivially minted for the caller's OWN email —
    // authorized a pending update request against an ARBITRARY contact in an
    // ARBITRARY team, proposing attacker-chosen data under the real member's name.
    const matchedContactIds = Array.isArray(codeData.matchedContactIds)
      ? (codeData.matchedContactIds as unknown[]).map((v) => String(v))
      : []
    if (!matchedContactIds.includes(contactId)) {
      throw new HttpsError(
        'permission-denied',
        'This verification code does not authorize updating this contact.'
      )
    }

    console.log(`Code-based contact update request from contact ${contactId} for team ${teamId}`)
  }

  // ── Validate contact ────────────────────────────────────────────────────────
  const contactRef = db.collection('contacts').doc(contactId)
  const contactDoc = await contactRef.get()
  if (!contactDoc.exists) throw new HttpsError('not-found', 'Contact not found')
  if ((contactDoc.data()!.teamId as string) !== teamId)
    throw new HttpsError('permission-denied', 'Contact does not belong to this team')

  // ── Duplicate check ─────────────────────────────────────────────────────────
  const existingSnap = await db
    .collection('teams')
    .doc(teamId)
    .collection(CONTACT_REQUESTS_SUBCOLLECTION)
    .where('contact_id', '==', contactId)
    .where('status', '==', 'pending')
    .limit(1)
    .get()
  if (!existingSnap.empty)
    throw new HttpsError(
      'already-exists',
      'A pending update request already exists for this contact'
    )

  // ── Sanitize submitted data ─────────────────────────────────────────────────
  const sanitizedData: Record<string, unknown> = {
    firstname,
    lastname,
    phone: ((contactDetails.phone as string) ?? '').trim(),
    birthdate: contactDetails.birthdate
      ? Timestamp.fromDate(new Date(contactDetails.birthdate as string))
      : null,
    gender: (contactDetails.gender as string) || '',
    birthplace: ((contactDetails.birthplace as string) ?? '').trim(),
    residence: (contactDetails.residence as unknown) ?? null,
    emergencyContact: contactDetails.emergencyContact
      ? {
          name: ((contactDetails.emergencyContact as Record<string, string>).name ?? '').trim(),
          phone: ((contactDetails.emergencyContact as Record<string, string>).phone ?? '').trim(),
        }
      : null,
    notes: ((contactDetails.notes as string) ?? '').trim(),
  }

  // ── Create request ──────────────────────────────────────────────────────────
  const requestRef = db
    .collection('teams')
    .doc(teamId)
    .collection(CONTACT_REQUESTS_SUBCOLLECTION)
    .doc()
  const contactData = contactDoc.data()!
  const contactName =
    `${(contactData.firstname as string) || ''} ${(contactData.lastname as string) || ''}`.trim()
  const contactEmail = (contactData.email as string) || ''

  await requestRef.set({
    contact_id: contactId,
    contact_name: contactName,
    contact_email: contactEmail,
    team_id: teamId,
    request_type: 'data_update',
    submitted_data: sanitizedData,
    note: (note ?? '').trim(),
    status: 'pending',
    requested_at: FieldValue.serverTimestamp(),
  })

  console.log(`Contact update request created: ${requestRef.id} for contact ${contactId}`)

  // ── In-app notification (teams/{teamId}/notifications/{id}) ────────────────
  try {
    await createTeamNotification(teamId, {
      type: 'contact_request',
      title: 'Contact update request',
      body: `${contactName} has requested a change to their contact details.`,
      // The requests list lives under the contacts page's "Requests" tab
      // (apps/web/src/app/[locale]/(auth)/contacts/page.tsx, TAB_IDS +
      // useTabParam) — ?tab= is that page's existing URL convention.
      link: '/contacts?tab=requests',
      request_id: requestRef.id,
      contact_id: contactId,
      contact_name: contactName,
    })
  } catch (notifyErr) {
    console.error('Failed to create team notification for contact request', notifyErr)
  }

  // ── Mark auth as used ───────────────────────────────────────────────────────
  if (codeRef) {
    await codeRef.update({ used: true, usedAt: FieldValue.serverTimestamp(), contactId })
  }

  return { success: true, requestId: requestRef.id }
})
