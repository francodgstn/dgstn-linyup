// Organization member invitations — invite a PERSON to help run the org,
// by email, whether or not they have a Linyup account yet.
//
// ─── THE COLLECTION THIS IS NOT ──────────────────────────────────────────────
//
// `organizations/{orgId}/org_invitations` already exists and means something
// else entirely: a whole STUDIO is invited into the organization, the studio's
// OWNER accepts, and accepting moves that studio's billing onto the org plan
// (./index.ts — inviteTeamToOrg / acceptOrgInvitation, landing on
// /org-invite/{orgId}/{invId}).
//
// This one grants a person a row in `org_members` and nothing else. No studio
// changes hands, no billing moves, no team is enrolled. The two must not be
// conflated in code OR in copy: an org admin who receives "you've been invited"
// must never land on a screen that enrolls their studio.
//
// So the collection is `org_member_invitations`, the route is
// `/org-member-invite/{orgId}/{token}`, and the naming rule that keeps them
// apart is written down once, beside `ORG_INVITATIONS_SUBCOLLECTION` in
// shared/paths.ts: AN INVITATION IS NAMED AFTER THE COLLECTION IT GRANTS INTO.
//
// ─── WHY IT EXISTS (decision 12) ─────────────────────────────────────────────
//
// `addOrgMember` is a GRANT against an account that already exists. An address
// with no Linyup account got a named refusal, because the client cannot resolve
// email→uid and a placeholder user would be worse than a refusal. That refusal
// was a dead end: an organization could not bring in anybody who had not
// already signed up on their own. The pending invitation is the thing that was
// missing on the other side of it.
//
// ─── THE THREE THINGS THAT MAKE IT SAFE ──────────────────────────────────────
//
//  1. THE DOC ID IS DERIVED FROM THE ADDRESS (`orgMemberInvitationId`). Inviting
//     the same address twice rewrites one row instead of leaving two live
//     tokens. See the type's doc comment in shared/types/org.ts.
//
//  2. THE TOKEN ALONE GRANTS NOTHING. It proves control of a mailbox, not of an
//     identity, so `acceptOrgMemberInvitation` ALSO requires the signed-in
//     account's address to equal the invited one. Silently attaching whoever
//     happens to be signed in is the failure this exists to avoid, and the
//     refusal is server-side — the accept page's blocked state is UX only.
//
//  3. THE DEADLINE IS CHECKED AT ACCEPT, against `now`. The daily sweep
//     (../dailyTasks/expireOrgMemberInvitations.ts) never authorizes anything;
//     if it never ran, an expired invitation would still be refused.
//
// AUTHORIZATION follows UX-75's shape and nothing else: `assertOrgAdmin`
// against `organizations/{orgId}/org_members/{uid}`. An org admin is not a team
// owner and has no `team_members` document anywhere.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_MEMBER_INVITATIONS_SUBCOLLECTION,
  SIGNUP_ALLOWLIST_COLLECTION,
  localizedAppUrl,
  normalizeEmail,
  orgMemberInvitationId,
  orgMemberInvitePath,
  type OrgMemberInvitation,
  type OrgRole,
} from '@linyup/shared'
import { assertOrgAdmin } from './index'
import { grantOrgMembership, membersRef, requireOrgRole } from './members'
import { generateSecureToken, sha256Hex } from '../utils/crypto'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { getHostingUrl } from '../utils/env'

/** Seven days, the same window every other Linyup invitation gets. */
export const ORG_MEMBER_INVITATION_DAYS = 7

function invitationsRef(orgId: string) {
  return admin
    .firestore()
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(orgId)
    .collection(ORG_MEMBER_INVITATIONS_SUBCOLLECTION)
}

function requireEmail(value: unknown): string {
  const email = typeof value === 'string' ? normalizeEmail(value) : ''
  // Deliberately loose — Firebase Auth is the real validator at signup. This
  // only rejects what could not possibly be an address (and what would make a
  // nonsense `to:` header).
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'A valid email address is required')
  }
  return email
}

function expired(inv: { expires_at?: FirebaseFirestore.Timestamp }): boolean {
  return !inv.expires_at || inv.expires_at.toMillis() <= Date.now()
}

/** Does this address already have a Linyup account? Auth is the authority. */
async function uidForEmail(email: string): Promise<string | null> {
  try {
    return (await admin.auth().getUserByEmail(email)).uid
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// inviteOrgMember — org admin invites a person by email
// ─────────────────────────────────────────────────────────────────────────────

export const inviteOrgMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = (request.data ?? {}) as {
    orgId?: string
    email?: string
    role?: string
    locale?: string
  }
  if (!data.orgId) throw new HttpsError('invalid-argument', 'orgId is required')
  const orgId = data.orgId
  const email = requireEmail(data.email)
  const role: OrgRole = requireOrgRole(data.role ?? 'org_admin')

  await assertOrgAdmin(request.auth.uid, orgId)

  const db = admin.firestore()
  const orgSnap = await db.collection(ORGANIZATIONS_COLLECTION).doc(orgId).get()
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found')
  const orgName = (orgSnap.data()?.name as string | undefined) ?? 'the organization'

  // Already in? Say so rather than mailing a link that would no-op. An account
  // that exists is how we can answer this at all; an address with no account
  // cannot be a member by definition.
  const existingUid = await uidForEmail(email)
  if (existingUid) {
    const already = await membersRef(orgId).doc(existingUid).get()
    if (already.exists) {
      throw new HttpsError(
        'already-exists',
        'That person is already a member of this organization.',
        { reason: 'already_member' }
      )
    }
  }

  const inviterDoc = await db.collection('users').doc(request.auth.uid).get()
  const invitedByName =
    (inviterDoc.data()?.displayName as string | undefined) ||
    (inviterDoc.data()?.email as string | undefined) ||
    ''

  const token = generateSecureToken(32)
  const expiresAt = Timestamp.fromDate(
    new Date(Date.now() + ORG_MEMBER_INVITATION_DAYS * 24 * 60 * 60 * 1000)
  )
  const invitationId = orgMemberInvitationId(email, sha256Hex)

  // ONE ROW PER (ORG, ADDRESS). A re-invite lands on the same document and
  // rewrites it — a fresh token (so the previous mail's link dies here and now),
  // a fresh deadline, and `status` back to 'pending' even if the last one had
  // expired or been revoked. `set` without merge, so no field of a previous
  // lifecycle (an `accepted_at`, a `revoked_at`) survives into the new one.
  await invitationsRef(orgId).doc(invitationId).set({
    orgId,
    email,
    role,
    token,
    status: 'pending',
    invitedBy: request.auth.uid,
    invitedByName,
    created: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
    expires_at: expiresAt,
  })

  // THE INVITEE MUST BE ABLE TO CREATE AN ACCOUNT, or the whole rail is dead on
  // arrival: `beforeSignup` fails CLOSED while public signup is closed, which is
  // today's launch posture, and the one address this invitation is for is
  // exactly the one that would be refused.
  //
  // This is a permission to create an account and NOTHING MORE — it grants no
  // org role (accepting does that, and accepting separately requires the
  // signed-in address to be this one). Attributed with `source` + `org_id` so an
  // operator reviewing the allowlist can tell an entry a customer caused from
  // one they added themselves.
  await db
    .collection(SIGNUP_ALLOWLIST_COLLECTION)
    .doc(email)
    .set(
      {
        email,
        added_by: 'inviteOrgMember',
        added_at: FieldValue.serverTimestamp(),
        note: `Invited to organization ${orgName}`,
        source: 'org_member_invitation',
        org_id: orgId,
      },
      // merge: an operator's own entry for this address keeps its note and its
      // added_by; we are not the only writer of this collection.
      { merge: true }
    )

  // The link is locale-pinned through the SHARED builder. An emailed link
  // carries no locale, so an unprefixed `${getHostingUrl()}/…` opens in whatever
  // language the reader's browser asks for; `localizedAppUrl` applies the one
  // prefix rule (`as-needed`, so 'en' stays unprefixed and costs no 302).
  const acceptUrl = localizedAppUrl(
    getHostingUrl(),
    typeof data.locale === 'string' ? data.locale : null,
    orgMemberInvitePath(orgId, token)
  )

  const roleLabel = role === 'org_admin' ? 'administrator' : 'viewer'
  const invitedByLine = invitedByName
    ? `<strong>${invitedByName}</strong> has invited you`
    : 'You have been invited'

  // COPY IS THE OTHER HALF OF KEEPING THE TWO INVITATIONS APART. Nothing here
  // may suggest a studio is being enrolled or that billing moves — that is the
  // OTHER invitation. This one says, plainly, that a person is being asked to
  // help run an organization.
  const { html, text } = buildEmailTemplate({
    title: `Join ${orgName} on Linyup`,
    body: `
      <p>${invitedByLine} to help run <strong>${orgName}</strong> on Linyup as an <strong>${roleLabel}</strong>.</p>
      <p>This is an invitation for you personally. It does not change anything about
      any studio you may run, and it does not affect billing.</p>
      <p style="margin:16px 0;">${ctaButton(acceptUrl, 'Accept invitation')}</p>
      <p>Accept with this email address: <strong>${email}</strong>. If you do not have a
      Linyup account yet, you can create one on that page — it takes a moment.</p>
      <p>This invitation expires in ${ORG_MEMBER_INVITATION_DAYS} days. If you did not
      expect it, you can safely ignore this email.</p>
    `,
  })

  // Linyup SYSTEM mail (no teamId): an organization is not a studio, and the
  // studio sender resolution is keyed on teams.
  await sendEmail({ to: email, subject: `Join ${orgName} on Linyup`, html, text })

  return { invitationId, email, role, expiresAt: expiresAt.toDate().toISOString() }
})

// ─────────────────────────────────────────────────────────────────────────────
// getOrgMemberInvitation — the accept page's read. UNAUTHENTICATED by design
// ─────────────────────────────────────────────────────────────────────────────
//
// The invitee may have no account at all, so no Firestore rule could ever match
// them and no signed-in read is possible. The token is the credential; it is
// also why this returns only what the page must show and never the token back.
//
// It DOES echo the invited address. That is deliberate: the whole point of the
// mismatch guard is that a person can be told which address to use, and the
// token was mailed to that address in the first place.

export const getOrgMemberInvitation = onCall(async (request) => {
  const data = (request.data ?? {}) as { orgId?: string; token?: string }
  if (!data.orgId || !data.token) {
    throw new HttpsError('invalid-argument', 'orgId and token are required')
  }

  // Collection-scope query (single field, auto-indexed) — NOT a collectionGroup
  // one, which would need an index the emulator would not miss for us.
  const snap = await invitationsRef(data.orgId)
    .where('token', '==', data.token)
    .limit(1)
    .get()
  if (snap.empty) throw new HttpsError('not-found', 'Invitation not found')

  const inv = snap.docs[0].data() as OrgMemberInvitation & {
    expires_at?: FirebaseFirestore.Timestamp
  }
  if (inv.status !== 'pending') {
    throw new HttpsError('failed-precondition', `Invitation is already ${inv.status}`, {
      reason: `invitation_${inv.status}`,
    })
  }
  if (expired(inv)) {
    // Refused on the deadline whether or not the sweep has run.
    throw new HttpsError('deadline-exceeded', 'Invitation has expired', {
      reason: 'invitation_expired',
    })
  }

  const orgDoc = await admin
    .firestore()
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(data.orgId)
    .get()
  if (!orgDoc.exists) throw new HttpsError('not-found', 'Organization not found')

  return {
    orgId: data.orgId,
    orgName: orgDoc.data()?.name ?? '',
    email: inv.email,
    role: inv.role,
    invitedByName: inv.invitedByName ?? null,
    expiresAt: inv.expires_at ? inv.expires_at.toDate().toISOString() : null,
    // Lets the page offer "sign in" rather than "create an account" — a hint for
    // the form, never a gate. Both paths end at the same accept call.
    hasAccount: (await uidForEmail(inv.email)) !== null,
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// acceptOrgMemberInvitation — the invitee attaches their account
// ─────────────────────────────────────────────────────────────────────────────

export const acceptOrgMemberInvitation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = (request.data ?? {}) as { orgId?: string; token?: string; displayName?: string }
  if (!data.orgId || !data.token) {
    throw new HttpsError('invalid-argument', 'orgId and token are required')
  }
  const orgId = data.orgId
  const uid = request.auth.uid

  const snap = await invitationsRef(orgId).where('token', '==', data.token).limit(1).get()
  if (snap.empty) throw new HttpsError('not-found', 'Invitation not found')
  const invRef = snap.docs[0].ref
  const inv = snap.docs[0].data() as OrgMemberInvitation

  // ── THE ADDRESS MUST MATCH ────────────────────────────────────────────────
  //
  // THE SHARP CASE, and the reason this callable exists rather than a rule: the
  // person may have signed up with a DIFFERENT address than the one invited —
  // by accident (their browser was already signed in as someone else) or on
  // purpose (a forwarded link). The token proves control of a mailbox, not of
  // an identity, so attaching whoever is signed in would grant an organization
  // admin role to an account nobody invited.
  //
  // So: refuse, by name, and hand back the invited address so the page can say
  // which one to use. Never attach silently, and never "helpfully" re-point the
  // invitation at the address that turned up — that would make a forwarded link
  // a transferable grant.
  //
  // `request.auth.token.email` is the account's own address (Firebase Auth's
  // record), not client input.
  const callerEmail = request.auth.token.email
    ? normalizeEmail(request.auth.token.email)
    : ''
  if (!callerEmail || callerEmail !== inv.email) {
    throw new HttpsError(
      'permission-denied',
      'This invitation was sent to a different email address.',
      { reason: 'email_mismatch', invitedEmail: inv.email, signedInAs: callerEmail || null }
    )
  }

  const db = admin.firestore()
  const userDoc = await db.collection('users').doc(uid).get()
  const storedName = (userDoc.data()?.displayName as string | undefined) ?? ''
  // A name typed on the accept page is used ONLY to fill a gap. An account that
  // already carries a name keeps it — a client payload must not be able to
  // rename somebody.
  const offeredName =
    typeof data.displayName === 'string' ? data.displayName.trim().slice(0, 80) : ''
  const displayName = storedName || request.auth.token.name || offeredName || ''
  const userProfile: { email?: string; displayName?: string } = {}
  if (!storedName && displayName) userProfile.displayName = displayName
  if (!userDoc.data()?.email) userProfile.email = callerEmail

  await db.runTransaction(async (tx) => {
    // Re-read INSIDE the transaction: between the query above and here the
    // invitation may have been revoked, re-issued with a new token, or already
    // accepted in another tab.
    const fresh = await tx.get(invRef)
    if (!fresh.exists) throw new HttpsError('not-found', 'Invitation not found')
    const current = fresh.data() as OrgMemberInvitation & {
      expires_at?: FirebaseFirestore.Timestamp
    }

    // ORDER MATTERS HERE, and getting it wrong makes the first arm dead code.
    // Every terminal transition DELETES the token, so a token comparison placed
    // first would answer "not found" to the one person entitled to a friendlier
    // answer. The document was located BY this token in the read above, so it is
    // the right document regardless of what the field says now.
    //
    // 1. Already accepted BY THIS PERSON — a double submit, not an error.
    if (current.status === 'accepted' && current.acceptedBy === uid) return
    // 2. Any other terminal state — say which, so the page can explain it.
    if (current.status !== 'pending') {
      throw new HttpsError('failed-precondition', `Invitation is already ${current.status}`, {
        reason: `invitation_${current.status}`,
      })
    }
    // 3. Still pending but the token moved: a re-invite rotated it while this
    //    tab was open. The older mail's link must not accept the newer
    //    invitation — which may carry a different role.
    if (current.token !== data.token) {
      throw new HttpsError('not-found', 'Invitation not found')
    }
    if (expired(current)) {
      throw new HttpsError('deadline-exceeded', 'Invitation has expired', {
        reason: 'invitation_expired',
      })
    }

    // One commit: the membership and the mark that consumed the invitation. A
    // half-accepted invitation is not a state that exists.
    tx.update(invRef, {
      status: 'accepted',
      accepted_at: FieldValue.serverTimestamp(),
      acceptedBy: uid,
      updated_at: FieldValue.serverTimestamp(),
      // The token has done its job; a spent credential should not sit in a
      // document an org admin can read.
      token: FieldValue.delete(),
    })
    await grantOrgMembership(
      {
        orgId,
        uid,
        role: current.role,
        // The invitee attached their own account. The inviting admin is on the
        // invitation; `addedBy` is who performed the write.
        addedBy: uid,
        displayName,
        email: current.email,
        userProfile: Object.keys(userProfile).length ? userProfile : undefined,
      },
      tx
    )
  })

  return { orgId, role: inv.role }
})

// ─────────────────────────────────────────────────────────────────────────────
// declineOrgMemberInvitation — the invitee says no
// ─────────────────────────────────────────────────────────────────────────────
//
// Same address check as accepting: declining is a statement about a person's
// own mailbox, and letting anyone holding the link close somebody else's
// invitation is a denial-of-service with no upside.

export const declineOrgMemberInvitation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = (request.data ?? {}) as { orgId?: string; token?: string }
  if (!data.orgId || !data.token) {
    throw new HttpsError('invalid-argument', 'orgId and token are required')
  }

  const snap = await invitationsRef(data.orgId).where('token', '==', data.token).limit(1).get()
  if (snap.empty) throw new HttpsError('not-found', 'Invitation not found')
  const inv = snap.docs[0].data() as OrgMemberInvitation

  const callerEmail = request.auth.token.email ? normalizeEmail(request.auth.token.email) : ''
  if (!callerEmail || callerEmail !== inv.email) {
    throw new HttpsError(
      'permission-denied',
      'This invitation was sent to a different email address.',
      { reason: 'email_mismatch', invitedEmail: inv.email, signedInAs: callerEmail || null }
    )
  }
  if (inv.status !== 'pending') {
    throw new HttpsError('failed-precondition', `Invitation is already ${inv.status}`, {
      reason: `invitation_${inv.status}`,
    })
  }

  await snap.docs[0].ref.update({
    status: 'declined',
    declined_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
    token: FieldValue.delete(),
  })

  return { success: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// revokeOrgMemberInvitation — org admin takes it back
// ─────────────────────────────────────────────────────────────────────────────
//
// It does NOT touch the last-admin guard: an invitation grants nothing, so
// withdrawing one takes no admin away. It also does not remove the signup
// allowlist entry — that entry says "this address may create a Linyup account",
// which is not a grant of anything in the organization, and an operator may
// have added the same address themselves.

export const revokeOrgMemberInvitation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = (request.data ?? {}) as { orgId?: string; invitationId?: string }
  if (!data.orgId) throw new HttpsError('invalid-argument', 'orgId is required')
  if (!data.invitationId) throw new HttpsError('invalid-argument', 'invitationId is required')

  await assertOrgAdmin(request.auth.uid, data.orgId)

  const ref = invitationsRef(data.orgId).doc(data.invitationId)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Invitation not found')
  if ((snap.data() as OrgMemberInvitation).status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Only a pending invitation can be revoked.')
  }

  await ref.update({
    status: 'revoked',
    revoked_at: FieldValue.serverTimestamp(),
    revokedBy: request.auth.uid,
    updated_at: FieldValue.serverTimestamp(),
    // Kill the credential with the invitation, not merely the status.
    token: FieldValue.delete(),
  })

  return { success: true }
})
