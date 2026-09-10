/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getTeam } from '../utils/teams'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { escapeHtml } from '../utils/html'
import { timingSafeEqualStr } from '../utils/secureCompare'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import { assertVerifiableCode } from './verificationCode'
import { recordSignupConsent } from '../waivers/signup'
import { resolveSignupJoinPromotion, type SignupJoinPromotion } from './signupJoin'
import { to } from '../utils/async'
import {
  CONTACTS_COLLECTION,
  CONTACT_AFFILIATIONS_SUBCOLLECTION,
  AFFILIATION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  planSupportsAffiliations,
  normalizeEmail,
  type AffiliationType,
} from '@linyup/shared'


// ─────────────────────────────────────────────────────────────────────────────
// verifyContactCode
// ─────────────────────────────────────────────────────────────────────────────

export const verifyContactCode = onCall(async (request) => {
  const data = request.data as { codeId?: string; code?: string }

  if (!data?.codeId || !data?.code) {
    throw new HttpsError('invalid-argument', 'codeId and code are required')
  }

  if (!/^\d{6}$/.test(data.code)) {
    throw new HttpsError('invalid-argument', 'Code must be 6 digits')
  }

  const codeRef = admin.firestore().collection('verification_codes').doc(data.codeId)
  const codeData = await assertVerifiableCode(codeRef, data.code)

  return { verified: true, email: codeData.email, teamId: codeData.team_id }
})

// ─────────────────────────────────────────────────────────────────────────────
// completeSignup
// ─────────────────────────────────────────────────────────────────────────────

export const completeSignup = onCall(async (request) => {
  const data = request.data as {
    codeId?: string
    code?: string
    // Session path: the team the signed-in contact is finalizing for (the code
    // path derives it from the code doc instead).
    teamId?: string
    contactDetails?: {
      firstname: string
      lastname: string
      phone?: string
      birthdate?: string
      notes?: string
      privacyConsent: boolean
    }
    // The terms/privacy documents the studio linked beside the consent checkbox,
    // echoed back as the visitor was SHOWN them.
    //
    // `documentId` + `version` are what make this a real record: each becomes an
    // append-only acceptance event, at the version on screen, pinned to that
    // version's own frozen text (see recordSignupConsent below). The legacy
    // `slug`/`kind`/`version: ''` shape is still accepted and still written to
    // the deprecated `Contact.consent` blob for one release — a client that has
    // not deployed yet keeps working, it simply produces no ledger row.
    //
    // Nothing here is trusted for authorization: privacyConsent is hard-required
    // above, and the ledger writer intersects this list with the team's OWN
    // configured signup documents.
    acceptedDocuments?: Array<{
      documentId?: string
      slug?: string
      kind?: string
      version?: string | number
    }>
    // A required WAIVER shown as its own step on this rail (§7.3). Recorded, never
    // enforced: signup is not attendance, and the gate binds at the first
    // booking. Same payload shape every booking callable takes.
    waiverAcceptances?: unknown
  }

  if (!data?.contactDetails) {
    throw new HttpsError('invalid-argument', 'contactDetails are required')
  }

  const { contactDetails } = data

  if (!contactDetails.firstname || !contactDetails.lastname) {
    throw new HttpsError('invalid-argument', 'firstname and lastname are required')
  }

  if (!contactDetails.privacyConsent) {
    throw new HttpsError('failed-precondition', 'Privacy consent is required')
  }

  // ── Identity: an OTP code (anonymous flow) OR a live contact session. The
  // session was itself minted by the same OTP flow (≤7 days ago), so re-verifying
  // the same inbox for an already-signed-in contact would be pure friction — the
  // signup page skips straight to the details step and calls this with teamId only.
  let email: string
  let teamId: string
  let codeRef: admin.firestore.DocumentReference | null = null
  // Session path: finalize EXACTLY this contact (never an email guess — a family
  // email may match several).
  let sessionContactId: string | null = null

  if (data.codeId) {
    if (!data.code || !/^\d{6}$/.test(data.code)) {
      throw new HttpsError('invalid-argument', 'A valid 6-digit code is required')
    }
    codeRef = admin.firestore().collection('verification_codes').doc(data.codeId)
    const codeDoc = await codeRef.get()
    if (!codeDoc.exists) throw new HttpsError('not-found', 'Invalid verification code')

    const codeData = codeDoc.data()!

    if (!codeData.verified) {
      throw new HttpsError('failed-precondition', 'Email not verified. Please verify your email first.')
    }
    if (codeData.used) {
      throw new HttpsError('already-exists', 'This verification code has already been used')
    }
    // Defence in depth: bind completion to knowledge of the code itself, not just
    // the (client-held) codeId. The 15-min expiry is intentionally NOT re-checked
    // here — verifyContactCode already enforced it; signup completion may legitimately
    // happen later. Constant-time compare to avoid a timing oracle on the code.
    if (!timingSafeEqualStr(String(codeData.code), data.code)) {
      throw new HttpsError('permission-denied', 'Verification code does not match')
    }

    email = codeData.email as string
    teamId = codeData.team_id as string
  } else {
    const session = optionalContactSessionFromRequest(request)
    if (!session || !data.teamId || session.teamId !== data.teamId) {
      throw new HttpsError('invalid-argument', 'codeId or a signed-in contact session is required')
    }
    sessionContactId = session.contactId
    teamId = session.teamId
    // The address the contact authenticated with (token claim), falling back to
    // the contact's stored primary email.
    let sessionEmail = (request.auth?.token?.email as string | undefined)?.toLowerCase().trim()
    if (!sessionEmail) {
      const cSnap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(session.contactId).get()
      sessionEmail = ((cSnap.data()?.email as string | undefined) ?? '').toLowerCase().trim()
    }
    if (!sessionEmail) {
      throw new HttpsError('failed-precondition', 'No email on this account — sign in again')
    }
    email = sessionEmail
  }

  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')

  const teamName = team.name || 'Team'

  // Get owner emails for notification
  const ownersSnap = await admin.firestore().collection('teams').doc(teamId).collection('team_members').where('role', '==', 'owner').get()
  const ownerEmails: string[] = []
  for (const memberDoc of ownersSnap.docs) {
    const userDoc = await admin.firestore().collection('users').doc(memberDoc.id).get()
    if (userDoc.exists) {
      const ownerEmail = userDoc.get('email')
      if (ownerEmail) ownerEmails.push(ownerEmail)
    }
  }

  const sanitized = {
    firstname: contactDetails.firstname.trim(),
    lastname: contactDetails.lastname.trim(),
    phone: contactDetails.phone?.trim() || null,
    birthdate: contactDetails.birthdate ? Timestamp.fromDate(new Date(contactDetails.birthdate)) : null,
    notes: contactDetails.notes?.trim() || null,
  }

  // DEPRECATED consent blob. Kept for ONE release beside the real ledger rows
  // written below, and now declared on `Contact.consent` with a pointer to its
  // replacement — two proofs of acceptance with different evidential weight and
  // no marker saying which is which is the state to avoid, so the marker is on
  // the type. Retiring it is a follow-up once no reader remains.
  const acceptedDocuments = Array.isArray(data.acceptedDocuments)
    ? data.acceptedDocuments
        .filter((d) => d && typeof d.slug === 'string')
        .slice(0, 10)
        .map((d) => ({
          slug: String(d.slug).slice(0, 200),
          kind: typeof d.kind === 'string' ? d.kind.slice(0, 40) : null,
          version:
            typeof d.version === 'string'
              ? d.version.slice(0, 60)
              : typeof d.version === 'number'
                ? String(d.version)
                : null,
        }))
    : []
  const consent = {
    privacyAcceptedAt: FieldValue.serverTimestamp(),
    documents: acceptedDocuments,
  }

  // Resolve-or-create. A 'full'-mode shop purchase already created a pending-signup
  // contact (the Connect webhook); finalizing must UPDATE that contact, not fork a
  // duplicate. Email is NOT unique in Linyup (a parent address may control several
  // child contacts), so match all active contacts by team+email and pick deliberately.
  const db = admin.firestore()
  const normEmail = normalizeEmail(email)
  const matchSnap = await db
    .collection(CONTACTS_COLLECTION)
    .where('teamId', '==', teamId)
    .where('email', '==', normEmail)
    .get()
  const activeMatches = matchSnap.docs.filter((d) => {
    const c = d.data()
    return c.archived_at == null && c.deleted_at == null
  })

  // The profile fields the buyer just filled — written on both finalize and create.
  // pending_signup/signup_completed_at flip the contact from "paid, awaiting signup"
  // to fully signed.
  const profile = {
    firstname: sanitized.firstname,
    lastname: sanitized.lastname,
    email: normEmail,
    phone: sanitized.phone,
    birthdate: sanitized.birthdate,
    notes: sanitized.notes,
    pending_signup: false,
    signup_completed_at: FieldValue.serverTimestamp(),
    consent,
  }

  // Completing signup IS the act of joining, so the contact is moved to
  // 'joined' here — from no stage at all (a shop buyer, UX-82) and from a trial
  // stage (a trial lead who decided to join, UX-83). Only a contact already at
  // 'joined' is left alone; the funnel never runs backwards. See signupJoin.ts
  // for the whole decision (what "absent" means, why entry/converted_at still
  // fill-gaps-overwrite-nothing, and why only the trial→joined case is counted
  // as a conversion).
  const logJoinPromotion = (p: SignupJoinPromotion, id: string): void => {
    if (p.reason === 'promoted_from_stage') {
      console.log(
        `[completeSignup] contact ${id} moved ${String(p.from)} → 'joined' by completing signup (a trial conversion; entry=${String(p.patch.entry ?? 'kept')})`,
      )
    } else if (p.reason === 'promoted_from_none') {
      console.log(
        `[completeSignup] contact ${id} carried no acquisition_stage — promoted to 'joined' (entry=${String(p.patch.entry ?? 'kept')})`,
      )
    } else if (p.reason === 'holds_unrecognised_stage') {
      console.warn(
        `[completeSignup] contact ${id} holds an unrecognised acquisition_stage (${String(p.from)}) — left untouched, so paid access still refuses it`,
      )
    }
  }

  let contactRef: admin.firestore.DocumentReference
  if (sessionContactId) {
    // Session path: finalize EXACTLY the signed-in contact (never an email guess).
    // Keep its stored primary email — the session may have been opened via a
    // login_emails allow-list address (e.g. a parent finalizing a child's profile),
    // and that address must not overwrite the contact's own.
    contactRef = db.collection(CONTACTS_COLLECTION).doc(sessionContactId)
    const sessionSnap = await contactRef.get()
    const sc = sessionSnap.data()
    if (!sessionSnap.exists || sc?.teamId !== teamId || sc?.archived_at != null || sc?.deleted_at != null) {
      throw new HttpsError('permission-denied', 'This account is no longer active')
    }
    const { email: _keepExistingEmail, ...profileWithoutEmail } = profile
    const promotion = resolveSignupJoinPromotion(sc, () => FieldValue.serverTimestamp())
    logJoinPromotion(promotion, sessionContactId)
    await contactRef.set(
      {
        ...profileWithoutEmail,
        // Advances the stage to 'joined' (unless it is already there) and fills
        // entry/converted_at only where the contact holds none — a shop
        // registration signs in with a session and carries no stage; a trial
        // lead signs in with one and carries 'trial_booked'.
        ...promotion.patch,
        // Completing the full signup MATERIALIZES a provisional lead — it now
        // counts toward the contact cap (see Contact.provisional).
        provisional: FieldValue.delete(),
        provisional_expires_at: FieldValue.delete(),
        // …and brings an EXTERNAL back onto the roster: this form is the one
        // act that says "I'm joining". A purchase never does (Contact.external).
        external: FieldValue.delete(),
        external_since: FieldValue.delete(),
      },
      { merge: true }
    )
  } else if (activeMatches.length === 0) {
    // No prior contact (minimal/off purchase, or signup without a purchase) — create.
    contactRef = db.collection(CONTACTS_COLLECTION).doc()
    await contactRef.set({
      ...profile,
      // Birth facts, stamped whole: nothing exists to preserve. A finalize of an
      // EXISTING contact reaches the same 'joined' by a different route — it
      // ADVANCES the stage (never backwards) and keeps every entry/converted_at
      // it already holds (resolveSignupJoinPromotion). The approval pipeline
      // (requested → active) lives on the affiliation axis, not here.
      acquisition_stage: 'joined',
      acquisition_stage_updated_at: FieldValue.serverTimestamp(),
      converted_at: FieldValue.serverTimestamp(),
      entry: 'signup',
      teamId,
      archived_at: null,
      deleted_at: null,
      created_at: FieldValue.serverTimestamp(),
    })
  } else {
    // Finalize the existing contact. >1 active match (shared family email) → newest;
    // never overwrite the birth facts (entry/converted_at) it HOLDS — but do fill the
    // ones it holds NOT, and do advance the acquisition stage to 'joined', because
    // completing this form is the join. Without that, a shop buyer (no stage) and a
    // trial lead ('trial_booked') are both refused by every gated class forever.
    if (activeMatches.length > 1) {
      activeMatches.sort(
        (a, b) => (b.data().created_at?.toMillis?.() ?? 0) - (a.data().created_at?.toMillis?.() ?? 0),
      )
      console.log(
        `[completeSignup] ${activeMatches.length} contacts share ${normEmail} (team=${teamId}) — finalizing newest ${activeMatches[0].id}`,
      )
    }
    contactRef = activeMatches[0].ref
    const promotion = resolveSignupJoinPromotion(
      activeMatches[0].data(),
      () => FieldValue.serverTimestamp(),
    )
    logJoinPromotion(promotion, contactRef.id)
    await contactRef.set(
      {
        ...profile,
        ...promotion.patch,
        // Full signup materializes a provisional lead (counts toward the cap)
        // and brings an external back onto the roster — see the branch above.
        provisional: FieldValue.delete(),
        provisional_expires_at: FieldValue.delete(),
        external: FieldValue.delete(),
        external_since: FieldValue.delete(),
      },
      { merge: true }
    )
  }
  const contactId = contactRef.id

  // ── The consent LEDGER, written against real versions ──────────────────────
  // The contact exists, so the rows can name somebody — which is the one thing a
  // consent record has to do. Deliberately ABOVE the best-effort blocks below
  // (affiliation, welcome mail, owner notification): those swallow their own
  // failures because a signup should not fail over an email, and an evidential
  // record must not sit in that zone. If this throws, the caller retries and the
  // ledger's read-then-skip makes the retry write one row, not two.
  const signupConsentRows = await recordSignupConsent({
    teamId,
    contactId,
    contactName: `${sanitized.firstname} ${sanitized.lastname}`.trim(),
    contactEmail: normEmail,
    echoed: Array.isArray(data.acceptedDocuments)
      ? data.acceptedDocuments
          .filter(
            (d): d is { documentId: string; version: number } =>
              !!d && typeof d.documentId === 'string' && typeof d.version === 'number'
          )
          .map((d) => ({ documentId: d.documentId, version: d.version }))
      : [],
    waiverAcceptances: data.waiverAcceptances,
    // WHICH DOOR WAS USED, and the two are not equally strong.
    // `verification_codes.email` is the address the code was actually mailed to,
    // so the OTP path shows control of THAT mailbox minutes ago. A session shows
    // only that a contact session was open — it identifies the contact, not the
    // person at the keyboard. The record says which, rather than flattening both
    // into one claim.
    signerEmailVerifiedBy: codeRef ? 'verified_code' : 'session',
    signerEmail: email,
    ip: request.rawRequest?.ip ?? null,
    userAgent: (request.rawRequest?.headers?.['user-agent'] as string | undefined) ?? null,
    locale: typeof (data as { locale?: string }).locale === 'string'
      ? ((data as { locale?: string }).locale as string)
      : null,
  })
  if (signupConsentRows > 0) {
    console.log(`[completeSignup] recorded ${signupConsentRows} consent event(s) for ${contactId}`)
  }

  // ── Create a PENDING affiliation (if affiliations are enabled + plan allows) ──
  // Best-effort: signup must not fail if the affiliation catalog is missing.
  try {
    if (team.affiliations_enabled && planSupportsAffiliations(team.plan ?? null)) {
      // Find the first active affiliation type in the team's catalog.
      // Prefer org-issued types if the team belongs to an org; else team-local.
      let affiliationTypeId: string | null = null
      let affiliationIssuer: 'team' | 'org' = 'team'
      let affiliationOrgId: string | undefined

      if (team.org_id) {
        const [, orgTypesSnap] = await to(
          db
            .collection('organizations')
            .doc(team.org_id)
            .collection(AFFILIATION_TYPES_SUBCOLLECTION)
            .where('active', '!=', false)
            .limit(1)
            .get(),
        )
        if (orgTypesSnap && !orgTypesSnap.empty) {
          const t = orgTypesSnap.docs[0].data() as AffiliationType
          affiliationTypeId = orgTypesSnap.docs[0].id
          affiliationIssuer = 'org'
          affiliationOrgId = team.org_id
          void t // used above for type narrowing
        }
      }

      if (!affiliationTypeId) {
        const [, teamTypesSnap] = await to(
          db
            .collection(TEAMS_COLLECTION)
            .doc(teamId)
            .collection(AFFILIATION_TYPES_SUBCOLLECTION)
            .where('active', '!=', false)
            .limit(1)
            .get(),
        )
        if (teamTypesSnap && !teamTypesSnap.empty) {
          affiliationTypeId = teamTypesSnap.docs[0].id
          affiliationIssuer = 'team'
        }
      }

      if (affiliationTypeId) {
        // Idempotent: when finalizing an existing contact, don't stack a second pending
        // affiliation of the same type if one is already active or requested.
        const [, existingAffSnap] = await to(
          contactRef
            .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
            .where('affiliation_type_id', '==', affiliationTypeId)
            .where('status_id', 'in', ['requested', 'active'])
            .limit(1)
            .get(),
        )
        if (existingAffSnap && !existingAffSnap.empty) {
          console.log(
            `[completeSignup] affiliation of type ${affiliationTypeId} already present for contact ${contactId}, skipping`,
          )
        } else {
          const affRef = contactRef.collection(CONTACT_AFFILIATIONS_SUBCOLLECTION).doc()
          await affRef.set({
            id: affRef.id,
            teamId,
            affiliation_type_id: affiliationTypeId,
            issuer: affiliationIssuer,
            ...(affiliationOrgId ? { org_id: affiliationOrgId } : {}),
            status_id: 'requested',
            active: false, // 'requested' countsAsActive=false
            created_by: null,
            created_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
          })
          console.log(`[completeSignup] created pending affiliation for contact ${contactId}`)
        }
      } else {
        console.log(`[completeSignup] no affiliation types found for team ${teamId}, skipping`)
      }
    }
  } catch (err) {
    // Non-fatal: contact is already created; affiliation is best-effort
    console.error('[completeSignup] affiliation creation failed (non-fatal):', err)
  }

  // Mark code as used (code path only — the session path holds no code)
  if (codeRef) await codeRef.update({ used: true, usedAt: FieldValue.serverTimestamp(), contactId })

  // Send welcome email
  try {
    const { html, text } = buildEmailTemplate({
      title: `Welcome to ${teamName}!`,
      body: `<p>Hi ${escapeHtml(sanitized.firstname)},</p><p>Thanks for signing up with <strong>${escapeHtml(teamName)}</strong>. Your membership request has been received and is under review.</p><p>We'll be in touch soon.</p>`,
    })
    await sendEmail({ to: email, subject: `Welcome to ${teamName}!`, html, text, teamId })
    console.log(`Welcome email sent to ${email}`)
  } catch (err) {
    console.error('Error sending welcome email:', err)
  }

  // Notify owners
  for (const ownerEmail of ownerEmails) {
    try {
      const { html, text } = buildEmailTemplate({
        title: `New Member Signup: ${sanitized.firstname} ${sanitized.lastname}`,
        body: `<p>A new membership request has been submitted.</p><p><strong>Name:</strong> ${escapeHtml(sanitized.firstname)} ${escapeHtml(sanitized.lastname)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p>${sanitized.phone ? `<p><strong>Phone:</strong> ${escapeHtml(sanitized.phone)}</p>` : ''}`,
      })
      await sendEmail({ to: ownerEmail, subject: `New Member Signup: ${sanitized.firstname} ${sanitized.lastname}`, html, text, teamId })
    } catch (err) {
      console.error('Error sending owner notification:', err)
    }
  }

  return { success: true, contactId }
})
