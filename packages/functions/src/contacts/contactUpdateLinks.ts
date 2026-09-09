/**
 * CONTACT UPDATE LINKS — mint, revoke, resolve, submit.
 *
 * The model, the token/OTP hashing and the windows are documented once in
 * `@linyup/shared` → `types/contactLink.ts`. This file is the only writer of
 * `contact_update_links`, and `firestore.rules` denies every client read and
 * write of it — which is what allows the document to carry an OTP hash at all.
 *
 * ── THE TWO PUBLIC CALLABLES ARE UNAUTHENTICATED ────────────────────────────
 * `resolveContactUpdateLink` and `submitContactUpdateLink` are reached by
 * somebody holding a QR and nothing else, so every gate is re-checked in BOTH:
 * submit never trusts that resolve ran, or that it ran against the same link.
 * The payload is attacker-shaped like any public form, so the write goes
 * through `buildContactFieldPatch` — the existing narrowing writer — rather
 * than merging what arrived.
 *
 * ── WHY IDENTITY FIELDS ARE HANDLED SEPARATELY ──────────────────────────────
 * `buildContactFieldPatch` speaks the BOOK-FORM vocabulary, which is
 * deliberately `phone | birthdate | address | custom:*` — it has no `email`,
 * `firstname` or `lastname`, because a booking may not rename the person it is
 * booking for. This form may: reviewing a name and adding an address is most of
 * its job. So the base three plus the studio's public custom fields go through
 * the shared writer with all of its semantics intact, and the three identity
 * fields are written here, each under its own stated rule.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  CONTACT_REQUESTS_SUBCOLLECTION,
  CONTACT_UPDATE_LINKS_COLLECTION,
  CONTACT_LINK_MAX_ATTEMPTS,
  CONTACT_LINK_MAX_SUBMISSIONS,
  CONTACT_LINK_OTP_LENGTH,
  TEAMS_COLLECTION,
  clampContactLinkTtl,
  localizedPublicUrl,
} from '@linyup/shared'
import type { BookingContactField, CustomFieldDefinition } from '@linyup/shared'
import { hasTeamRole } from '../utils/teams'
import { createTeamNotification } from '../utils/teamNotifications'
import { getHostingUrl } from '../utils/env'
import { buildContactFieldPatch } from '../booking/contactFields'

/** What this form asks for beyond the studio's public custom fields. */
const LINK_BASE_FIELDS: BookingContactField[] = [
  { key: 'phone' },
  { key: 'birthdate' },
  { key: 'address' },
]

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Constant-time compare of two hex digests of equal length. */
function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}

function normaliseEmail(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

interface LoadedLink {
  ref: admin.firestore.DocumentReference
  data: admin.firestore.DocumentData
}

/**
 * Load a link and refuse it for every reason except a missing OTP, which is the
 * caller's to handle — the form has to be able to ask.
 *
 * A wrong OTP is counted HERE, so the counter moves whether the attempt came
 * through resolve or submit.
 */
async function loadLink(token: unknown, otp: unknown): Promise<{
  link: LoadedLink
  otpRequired: boolean
}> {
  if (typeof token !== 'string' || token.length < 16) {
    throw new HttpsError('not-found', 'not_found')
  }
  const db = admin.firestore()
  const ref = db.collection(CONTACT_UPDATE_LINKS_COLLECTION).doc(sha256(token))
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'not_found')

  const data = snap.data()!
  if (data.revoked_at) throw new HttpsError('permission-denied', 'revoked')

  const expiresAt = data.expires_at as Timestamp | undefined
  if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
    throw new HttpsError('deadline-exceeded', 'expired')
  }
  if ((data.attempts ?? 0) >= CONTACT_LINK_MAX_ATTEMPTS) {
    throw new HttpsError('resource-exhausted', 'too_many_attempts')
  }

  if (data.requires_otp === true) {
    const supplied = typeof otp === 'string' ? otp.replace(/\D/g, '') : ''
    if (!supplied) return { link: { ref, data }, otpRequired: true }
    if (!hashesMatch(sha256(`${token}:${supplied}`), String(data.otp_hash ?? ''))) {
      // Counted before refusing, so a burst of guesses cannot outrun the cap.
      await ref.update({ attempts: FieldValue.increment(1) })
      throw new HttpsError('permission-denied', 'otp_invalid')
    }
  }

  return { link: { ref, data }, otpRequired: false }
}

/** The studio's custom fields that may be asked publicly, with their labels. */
async function loadPublicCustomFields(teamId: string): Promise<CustomFieldDefinition[]> {
  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  const defs = (snap.get('custom_fields') as CustomFieldDefinition[] | undefined) ?? []
  return defs.filter((d) => d?.publicOnBookingForm === true)
}

// ─── mint ────────────────────────────────────────────────────────────────────

/**
 * A COACH may mint one. That is the role standing in the room at training with
 * the person whose email is missing, and withholding it from them would leave
 * the feature usable only by whoever is not there.
 */
export const createContactUpdateLink = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required')

  const { teamId, contactId, ttlMinutes, requireOtp } = request.data as {
    teamId?: string
    contactId?: string
    ttlMinutes?: number
    requireOtp?: boolean
  }
  if (!teamId || !contactId) {
    throw new HttpsError('invalid-argument', 'teamId and contactId are required')
  }
  if (!(await hasTeamRole(uid, teamId, 'coach'))) {
    throw new HttpsError('permission-denied', 'Not allowed for this team')
  }

  const db = admin.firestore()
  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const contactSnap = await contactRef.get()
  if (!contactSnap.exists) throw new HttpsError('not-found', 'Contact not found')
  // The link names one contact of one team; a contact of ANOTHER team is not
  // this caller's to grant access to, however the id arrived.
  if (contactSnap.get('teamId') !== teamId) {
    throw new HttpsError('permission-denied', 'Contact belongs to another team')
  }
  if (contactSnap.get('deleted_at')) {
    throw new HttpsError('failed-precondition', 'Contact is in the trash')
  }

  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  const slug = teamSnap.get('slug') as string | undefined
  if (!slug) throw new HttpsError('failed-precondition', 'Team has no public slug')
  // Locale-pinned like every other public URL this package builds (UX-97). The
  // studio's language rather than the reader's: nobody is choosing a language
  // at the moment a QR is held up, and a club's members read what the club
  // writes. An unprefixed link would fall through to English.
  const lang = teamSnap.get('language') as string | undefined

  const minutes = clampContactLinkTtl(ttlMinutes)
  const token = randomBytes(24).toString('base64url')
  const otp = requireOtp === true
    ? String(randomBytes(4).readUInt32BE(0) % 10 ** CONTACT_LINK_OTP_LENGTH).padStart(
        CONTACT_LINK_OTP_LENGTH,
        '0'
      )
    : null

  const links = db.collection(CONTACT_UPDATE_LINKS_COLLECTION)

  // ONE LIVE LINK PER CONTACT. Minting is how the studio re-displays a QR (the
  // token is not stored, so the old one cannot be shown again), and leaving the
  // previous grant alive would mean every dialog ever opened is still a key.
  const live = await links
    .where('contact_id', '==', contactId)
    .where('revoked_at', '==', null)
    .get()
  const batch = db.batch()
  for (const d of live.docs) batch.update(d.ref, { revoked_at: FieldValue.serverTimestamp() })

  const name = `${contactSnap.get('firstname') ?? ''} ${contactSnap.get('lastname') ?? ''}`.trim()
  batch.set(links.doc(sha256(token)), {
    teamId,
    contact_id: contactId,
    contact_name: name,
    created_at: FieldValue.serverTimestamp(),
    created_by: uid,
    expires_at: Timestamp.fromMillis(Date.now() + minutes * 60_000),
    requires_otp: otp !== null,
    otp_hash: otp === null ? null : sha256(`${token}:${otp}`),
    attempts: 0,
    submissions: 0,
    revoked_at: null,
    last_submitted_at: null,
  })
  await batch.commit()

  return {
    url: localizedPublicUrl(getHostingUrl(), lang, slug, 'contact-update', { t: token }),
    otp,
    expiresAt: Date.now() + minutes * 60_000,
    ttlMinutes: minutes,
  }
})

// ─── revoke ──────────────────────────────────────────────────────────────────

/** Kills every live link for one contact. The studio never holds a token, so
 *  the contact is the only handle it can revoke by. */
export const revokeContactUpdateLinks = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required')

  const { teamId, contactId } = request.data as { teamId?: string; contactId?: string }
  if (!teamId || !contactId) {
    throw new HttpsError('invalid-argument', 'teamId and contactId are required')
  }
  if (!(await hasTeamRole(uid, teamId, 'coach'))) {
    throw new HttpsError('permission-denied', 'Not allowed for this team')
  }

  const db = admin.firestore()
  const live = await db
    .collection(CONTACT_UPDATE_LINKS_COLLECTION)
    .where('contact_id', '==', contactId)
    .where('revoked_at', '==', null)
    .get()

  const batch = db.batch()
  for (const d of live.docs) {
    // Scoped to the caller's team even though contact_id already implies it —
    // a stray link written against another tenant is not theirs to touch.
    if (d.get('teamId') !== teamId) continue
    batch.update(d.ref, { revoked_at: FieldValue.serverTimestamp() })
  }
  await batch.commit()
  return { revoked: live.size }
})

// ─── resolve (public) ────────────────────────────────────────────────────────

export const resolveContactUpdateLink = onCall(async (request) => {
  const { token, otp } = request.data as { token?: string; otp?: string }
  const { link, otpRequired } = await loadLink(token, otp)
  if (otpRequired) return { status: 'otp_required' as const }

  const db = admin.firestore()
  const teamId = link.data.teamId as string
  const [contactSnap, teamSnap, customFields] = await Promise.all([
    db.collection(CONTACTS_COLLECTION).doc(link.data.contact_id as string).get(),
    db.collection(TEAMS_COLLECTION).doc(teamId).get(),
    loadPublicCustomFields(teamId),
  ])
  if (!contactSnap.exists || contactSnap.get('deleted_at')) {
    throw new HttpsError('not-found', 'not_found')
  }

  const birthdate = contactSnap.get('birthdate') as Timestamp | undefined

  // ONLY what the form renders. A grant to edit details is not a licence to
  // read the person's bookings, notes, plan or payment history, so none of it
  // is returned — not even to a caller holding a valid token.
  return {
    status: 'ok' as const,
    team: { name: teamSnap.get('name') ?? '', logoUrl: teamSnap.get('logo_url') ?? null },
    contact: {
      firstname: contactSnap.get('firstname') ?? '',
      lastname: contactSnap.get('lastname') ?? '',
      email: contactSnap.get('email') ?? '',
      phone: contactSnap.get('phone') ?? '',
      birthdate: birthdate?.toDate ? birthdate.toDate().toISOString().slice(0, 10) : '',
      address: contactSnap.get('address') ?? null,
      custom_fields: contactSnap.get('custom_fields') ?? {},
    },
    customFields,
    expiresAt: (link.data.expires_at as Timestamp).toMillis(),
  }
})

// ─── submit (public) ─────────────────────────────────────────────────────────

export const submitContactUpdateLink = onCall(async (request) => {
  const { token, otp, values } = request.data as {
    token?: string
    otp?: string
    values?: Record<string, unknown>
  }
  const { link, otpRequired } = await loadLink(token, otp)
  if (otpRequired) throw new HttpsError('permission-denied', 'otp_required')
  if ((link.data.submissions ?? 0) >= CONTACT_LINK_MAX_SUBMISSIONS) {
    throw new HttpsError('resource-exhausted', 'too_many_submissions')
  }

  const answers = values ?? {}
  const db = admin.firestore()
  const teamId = link.data.teamId as string
  const contactId = link.data.contact_id as string
  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)

  const [contactSnap, customFields] = await Promise.all([
    contactRef.get(),
    loadPublicCustomFields(teamId),
  ])
  if (!contactSnap.exists || contactSnap.get('deleted_at')) {
    throw new HttpsError('not-found', 'not_found')
  }
  const existing = contactSnap.data() as Record<string, unknown>

  // Phone / birthdate / address / custom:* — through the shared writer, which
  // owns the Timestamp and address-map shapes and the empty-never-blanks rule.
  const patch = buildContactFieldPatch({
    fields: [
      ...LINK_BASE_FIELDS,
      ...customFields.map((d) => ({ key: `custom:${d.id}` })),
    ],
    answers,
    definitions: customFields,
    existing,
  })

  // ── Identity fields, each under its own rule ──────────────────────────────
  // Names: trimmed, and an empty box never erases a stored name — the same
  // reasoning as every other field, and worse here, because a contact with no
  // name is one nobody can find again on the roster.
  for (const key of ['firstname', 'lastname'] as const) {
    const v = answers[key]
    if (typeof v === 'string' && v.trim()) patch[key] = v.trim()
  }

  // Email is the one field that changes what the person can DO — it is the
  // Space and member-app login — so it is the one with a consequence to report.
  const submittedEmail = normaliseEmail(answers.email)
  const currentEmail = normaliseEmail(existing.email)
  let sharedWith: string[] = []
  if (submittedEmail && submittedEmail !== currentEmail) {
    // DELIBERATELY NOT REFUSED WHEN IT ALREADY BELONGS TO SOMEBODY.
    //
    // hmd-lineup rejects a duplicate address, which is right for a system where
    // one email means one person. Linyup is not that system: `login_emails`
    // (cap 5) exists precisely so one address reaches several contacts, and
    // `loginCandidates` resolves the sign-in to a choice among them — a parent
    // with two children in the club is the ordinary case, not an attack. So the
    // collision is RECORDED and reported to the studio rather than blocking a
    // parent at the door.
    const owners = await db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('email', '==', submittedEmail)
      .limit(5)
      .get()
    sharedWith = owners.docs.filter((d) => d.id !== contactId && !d.get('deleted_at')).map((d) => d.id)
    patch.email = submittedEmail
  }

  if (Object.keys(patch).length > 0) {
    patch.updated_at = FieldValue.serverTimestamp()
    await contactRef.update(patch)
  }

  await link.ref.update({
    submissions: FieldValue.increment(1),
    last_submitted_at: FieldValue.serverTimestamp(),
  })

  // The studio sees it where it already looks for member-authored changes —
  // APPLIED, not pending. A link is handed over in person by a team member, so
  // the vouching already happened; an update sitting in a queue would not give
  // the contact the login this exists to provide.
  const requestRef = await contactRef.collection(CONTACT_REQUESTS_SUBCOLLECTION).add({
    contact_id: contactId,
    contact_name: link.data.contact_name ?? '',
    team_id: teamId,
    request_type: 'data_update',
    source: 'update_link',
    submitted_data: patch,
    email_shared_with: sharedWith,
    status: 'approved',
    auto_applied: true,
    requested_at: FieldValue.serverTimestamp(),
    reviewed_at: FieldValue.serverTimestamp(),
    reviewed_by: 'system:update-link',
  })

  const contactName = (link.data.contact_name as string) || 'A contact'
  await createTeamNotification(teamId, {
    type: 'contact_request',
    title: 'Contact details updated',
    // The shared address is stated HERE rather than left in the audit row: it
    // is the one outcome a manager may need to act on, and a notification that
    // omits it would send them to a screen that looks entirely ordinary.
    body:
      sharedWith.length > 0
        ? `${contactName} updated their own details. The email address they gave is also used by another contact — both will be offered at sign-in.`
        : `${contactName} updated their own details from a link you shared.`,
    link: `/contacts/${contactId}`,
    request_id: requestRef.id,
    contact_id: contactId,
    contact_name: contactName,
  })

  return { status: 'ok' as const, emailSharedWith: sharedWith.length }
})
