// Organization member management — add / change role / remove.
//
// WHY THESE EXIST (UX-34): the org Members tab has always rendered a complete
// form — an "Add member" dialog with an email field and a role picker, and a
// per-row delete with a confirmation — against `addOrgMember` and
// `removeOrgMember`, neither of which had ever been written. Every submit came
// back "internal". `createOrganization` makes exactly ONE org_admin (the
// creator) and there was no second path, so an organization could never gain an
// admin, hand one over, or lose one: a bus factor of one, permanently.
//
// AUTHORIZATION follows UX-75's shape and nothing else: `assertOrgAdmin` against
// `organizations/{orgId}/org_members/{uid}`. An org admin is not a team owner
// and has no `team_members` document anywhere, so `hasTeamRole` / `assertOwner`
// would refuse the very person who is allowed to do this.
//
// WHY CALLABLES AT ALL, when firestore.rules already lets an org_admin write
// `org_members/{memberId}` directly: the client cannot turn an email address
// into a uid (that is an Admin SDK read), cannot maintain `users/{uid}.orgIds`
// (it may only write its OWN user document), and cannot enforce "an
// organization keeps at least one admin" — that is a read of the whole
// collection inside a transaction. All three are server obligations.
//
// TWO DOORS, ONE WRITER. Since decision 12 there is a second way into
// `org_members`: accepting an invitation (./memberInvitations.ts), which is what
// the Members tab now offers because an address with no Linyup account had no
// way in at all. Both doors go through `grantOrgMembership` below — the ONE
// place that writes a membership row and the matching `users/{uid}.orgIds`
// entry. Never write those two from anywhere else; a second writer is how a
// person ends up in an org their sidebar cannot find.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_MEMBERS_SUBCOLLECTION,
  type OrgRole,
} from '@linyup/shared'
import { assertOrgAdmin } from './index'

const ORG_ROLES: OrgRole[] = ['org_admin', 'org_viewer']

export function requireOrgRole(role: unknown): OrgRole {
  if (typeof role !== 'string' || !ORG_ROLES.includes(role as OrgRole)) {
    throw new HttpsError('invalid-argument', 'role must be org_admin or org_viewer')
  }
  return role as OrgRole
}

export function membersRef(orgId: string) {
  return admin
    .firestore()
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(orgId)
    .collection(ORG_MEMBERS_SUBCOLLECTION)
}

/**
 * The last-admin guard, shared by the two callables that can take an admin away
 * (remove, and demote to viewer). Reads the whole member collection — an org has
 * a handful of admins, not thousands — and refuses when `uid` is the only one
 * left. Called INSIDE the transaction that performs the write, so two admins
 * removing each other at once cannot both pass.
 *
 * IT COUNTS MEMBERSHIPS, NOT INVITATIONS — checked, not assumed. A pending
 * `org_member_invitation` for a second admin must NOT satisfy this guard: an
 * invitation grants nothing until it is accepted, and an unopened mailbox is
 * not an administrator. Counting one would let the last admin walk out against
 * a link that may never be clicked and leave the organization with nobody. The
 * guard therefore reads only `org_members`, and in the other direction
 * `inviteOrgMember` never consults it: sending an invitation takes no admin
 * away, so there is nothing for it to protect.
 */
async function assertNotLastAdmin(
  tx: FirebaseFirestore.Transaction,
  orgId: string,
  uid: string
): Promise<void> {
  const snap = await tx.get(membersRef(orgId).where('role', '==', 'org_admin'))
  const otherAdmins = snap.docs.filter((d) => d.id !== uid)
  if (otherAdmins.length === 0) {
    throw new HttpsError(
      'failed-precondition',
      'An organization must keep at least one admin.',
      { reason: 'last_admin' }
    )
  }
}

/**
 * THE ONE WRITER of an organization membership. Writes the `org_members/{uid}`
 * row and the `users/{uid}.orgIds` entry together, in one batch, because they
 * are two halves of one fact: the row is the grant, and the array is how the
 * sidebar finds it (a collectionGroup query would need an index the app does
 * not have).
 *
 * Callers: `addOrgMember` (the immediate grant) and `acceptOrgMemberInvitation`
 * (./memberInvitations.ts). A caller may pass its own transaction so the
 * membership lands atomically with whatever else it is writing — the
 * invitation's accept marks the invitation and grants the membership in a
 * single commit, so a half-accepted invitation is not a state that exists.
 * (Writes only: the caller must have finished its reads before calling.)
 *
 * It does NOT authorize anything. Both callers do that first, and in different
 * ways: `addOrgMember` requires an org admin, the accept requires the invited
 * mailbox.
 */
export async function grantOrgMembership(
  params: {
    orgId: string
    uid: string
    role: OrgRole
    /** uid of whoever caused the grant — the inviting admin, or the invitee. */
    addedBy: string
    /** Denormalized display copy; an org admin has no rule that lets them read
     *  other users' documents, so a row written without these renders a raw uid. */
    displayName: string
    email: string
    /** Merged into the SAME `users/{uid}` write, so a person whose account was
     *  created to answer an invitation ends up with a profile rather than a
     *  document containing nothing but `orgIds`. Pass only fields that are
     *  currently missing — this must never overwrite what a user set. */
    userProfile?: { email?: string; displayName?: string }
  },
  tx?: FirebaseFirestore.Transaction
): Promise<void> {
  const db = admin.firestore()
  const memberRef = membersRef(params.orgId).doc(params.uid)
  const userRef = db.collection('users').doc(params.uid)
  const memberDoc = {
    userId: params.uid,
    orgId: params.orgId,
    role: params.role,
    joined: FieldValue.serverTimestamp(),
    addedBy: params.addedBy,
    displayName: params.displayName,
    email: params.email,
  }
  // `set(..., {merge:true})` rather than `update` — a user document is created
  // at signup, but an account created some other way (an operator import) may
  // not have one yet.
  const userPatch = {
    ...(params.userProfile ?? {}),
    orgIds: FieldValue.arrayUnion(params.orgId),
  }

  if (tx) {
    tx.set(memberRef, memberDoc)
    tx.set(userRef, userPatch, { merge: true })
    return
  }

  const batch = db.batch()
  batch.set(memberRef, memberDoc)
  batch.set(userRef, userPatch, { merge: true })
  await batch.commit()
}

// ─────────────────────────────────────────────────────────────────────────────
// addOrgMember — org admin adds an EXISTING Linyup user by email
// ─────────────────────────────────────────────────────────────────────────────
//
// AN IMMEDIATE GRANT, not an invitation — and since decision 12 it is no longer
// the only door. The Members tab now sends an INVITATION (`inviteOrgMember`),
// because being made an admin of an organization is worth the person's consent
// and because the refusal this callable gives an address with no Linyup account
// ("no_account") was a dead end with nothing on the other side of it.
//
// This stays as the server-side grant for a person who is already known and
// already in Linyup — it is what `orgs/lifecycle.ts`-style operator work and
// any future console reaches for, and removing it would delete the tested UX-34
// rail. It is NOT reachable from the Members tab any more.

export const addOrgMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = (request.data ?? {}) as { orgId?: string; email?: string; role?: string }
  if (!data.orgId) throw new HttpsError('invalid-argument', 'orgId is required')
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
  if (!email) throw new HttpsError('invalid-argument', 'email is required')
  const role = requireOrgRole(data.role ?? 'org_admin')

  await assertOrgAdmin(request.auth.uid, data.orgId)

  const db = admin.firestore()
  const orgSnap = await db.collection(ORGANIZATIONS_COLLECTION).doc(data.orgId).get()
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found')

  // Resolve the person. Auth is the authority on "does this address have an
  // account"; the users document is where the display name lives.
  let userRecord: admin.auth.UserRecord
  try {
    userRecord = await admin.auth().getUserByEmail(email)
  } catch {
    throw new HttpsError(
      'not-found',
      'No Linyup account exists for that email address.',
      { reason: 'no_account' }
    )
  }
  const uid = userRecord.uid

  const memberRef = membersRef(data.orgId).doc(uid)
  const existing = await memberRef.get()
  if (existing.exists) {
    throw new HttpsError('already-exists', 'That person is already a member of this organization.')
  }

  const userDoc = await db.collection('users').doc(uid).get()
  const displayName =
    (userDoc.data()?.displayName as string | undefined) ?? userRecord.displayName ?? ''

  await grantOrgMembership({
    orgId: data.orgId,
    uid,
    role,
    addedBy: request.auth.uid,
    displayName,
    email: userRecord.email ?? email,
  })

  return { userId: uid, role, displayName, email: userRecord.email ?? email }
})

// ─────────────────────────────────────────────────────────────────────────────
// updateOrgMemberRole — org admin promotes/demotes an existing member
// ─────────────────────────────────────────────────────────────────────────────

export const updateOrgMemberRole = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = (request.data ?? {}) as { orgId?: string; userId?: string; role?: string }
  if (!data.orgId) throw new HttpsError('invalid-argument', 'orgId is required')
  if (!data.userId) throw new HttpsError('invalid-argument', 'userId is required')
  const role = requireOrgRole(data.role)

  await assertOrgAdmin(request.auth.uid, data.orgId)

  const orgId = data.orgId
  const userId = data.userId
  const memberRef = membersRef(orgId).doc(userId)

  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(memberRef)
    if (!snap.exists) throw new HttpsError('not-found', 'That person is not a member of this organization.')
    const current = snap.data()!.role as OrgRole
    if (current === role) return
    // Demoting the last admin locks everyone out of the organization just as
    // surely as removing them — same guard, same transaction.
    if (current === 'org_admin') await assertNotLastAdmin(tx, orgId, userId)
    tx.update(memberRef, { role, updated_at: FieldValue.serverTimestamp() })
  })

  return { success: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// removeOrgMember — org admin removes a member
// ─────────────────────────────────────────────────────────────────────────────

export const removeOrgMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = (request.data ?? {}) as { orgId?: string; userId?: string }
  if (!data.orgId) throw new HttpsError('invalid-argument', 'orgId is required')
  if (!data.userId) throw new HttpsError('invalid-argument', 'userId is required')

  await assertOrgAdmin(request.auth.uid, data.orgId)

  const db = admin.firestore()
  const orgId = data.orgId
  const userId = data.userId
  const memberRef = membersRef(orgId).doc(userId)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(memberRef)
    if (!snap.exists) throw new HttpsError('not-found', 'That person is not a member of this organization.')
    if ((snap.data()!.role as OrgRole) === 'org_admin') {
      await assertNotLastAdmin(tx, orgId, userId)
    }
    tx.delete(memberRef)
    tx.set(
      db.collection('users').doc(userId),
      { orgIds: FieldValue.arrayRemove(orgId) },
      { merge: true }
    )
  })

  return { success: true }
})
