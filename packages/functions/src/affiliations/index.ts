/* eslint-disable no-console */
// Affiliation callables — the belonging axis for contacts.
// Generalises the old single-valued org-membership into a multi-valued set.
// Each affiliation is a doc under contacts/{contactId}/affiliations/{id}.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { assertManager } from '../connect/access'
import { getTeam } from '../utils/teams'
import { to } from '../utils/async'
import {
  CONTACTS_COLLECTION,
  CONTACT_AFFILIATIONS_SUBCOLLECTION,
  AFFILIATION_TYPES_SUBCOLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  DEFAULT_ORG_AFFILIATION_STATUSES,
  planSupportsAffiliations,
  resolveAffiliationValidUntil,
  type Affiliation,
  type AffiliationType,
  type OrgAffiliationStatusDef,
  type AffiliationIssuer,
  isLiveContact,
} from '@linyup/shared'

// ─── helpers ─────────────────────────────────────────────────────────────────

async function resolveStatusDefs(
  issuer: AffiliationIssuer,
  orgId: string | undefined,
): Promise<OrgAffiliationStatusDef[]> {
  if (issuer === 'org' && orgId) {
    const db = admin.firestore()
    const [err, snap] = await to(
      db
        .collection(ORGANIZATIONS_COLLECTION)
        .doc(orgId)
        .collection(ORG_AFFILIATION_STATUSES_SUBCOLLECTION)
        .get(),
    )
    if (!err && snap && !snap.empty) {
      return snap.docs.map((d) => d.data() as OrgAffiliationStatusDef)
    }
  }
  return DEFAULT_ORG_AFFILIATION_STATUSES
}

/** Resolve the issuer's "active" status id (countsAsActive===true && isFinal===false),
 * lowest order first. The mirror of resolveExpiredStatusId in the daily expiry task —
 * renewing an affiliation reverses expiry by flipping it back to this status. */
async function resolveActiveStatusId(
  issuer: AffiliationIssuer,
  orgId: string | undefined,
): Promise<string> {
  const pick = (defs: OrgAffiliationStatusDef[]): string | undefined =>
    defs
      .filter((s) => s.countsAsActive && !s.isFinal)
      .sort((a, b) => a.order - b.order)[0]?.id

  const fromIssuer = pick(await resolveStatusDefs(issuer, orgId))
  return fromIssuer ?? pick(DEFAULT_ORG_AFFILIATION_STATUSES) ?? 'active'
}

async function resolveAffiliationType(
  teamId: string,
  affiliation_type_id: string,
  issuer: AffiliationIssuer,
  orgId: string | undefined,
): Promise<AffiliationType | null> {
  const db = admin.firestore()
  // For org-issued affiliations, try the org's affiliation_types first.
  if (issuer === 'org' && orgId) {
    const [, snap] = await to(
      db
        .collection(ORGANIZATIONS_COLLECTION)
        .doc(orgId)
        .collection(AFFILIATION_TYPES_SUBCOLLECTION)
        .doc(affiliation_type_id)
        .get(),
    )
    if (snap?.exists) return { id: snap.id, ...(snap.data() as Omit<AffiliationType, 'id'>) }
  }
  // Fall back to team-local affiliation_types.
  const [, snap] = await to(
    db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(AFFILIATION_TYPES_SUBCOLLECTION)
      .doc(affiliation_type_id)
      .get(),
  )
  if (snap?.exists) return { id: snap.id, ...(snap.data() as Omit<AffiliationType, 'id'>) }
  return null
}

/** Check whether the caller is allowed to write this affiliation.
 * Mirrors the Firestore rules' orgMembershipWriteAllowed logic:
 * if issuer==='org' and the org has lock_affiliation:true, only org_admin may write. */
async function affiliationWriteAllowed(
  uid: string,
  teamId: string,
  issuer: AffiliationIssuer,
  orgId: string | undefined,
): Promise<void> {
  // Manager-level team check is always required.
  await assertManager(uid, teamId)

  if (issuer !== 'org' || !orgId) return // team/external — manager is enough

  const db = admin.firestore()
  const [, orgSnap] = await to(db.collection(ORGANIZATIONS_COLLECTION).doc(orgId).get())
  if (!orgSnap?.exists) return // org not found — allow the manager to proceed

  const orgData = orgSnap.data()!
  if (!orgData.lock_affiliation) return // not locked — manager is enough

  // Locked: caller must also be an org_admin.
  const [, memberSnap] = await to(
    db
      .collection(ORGANIZATIONS_COLLECTION)
      .doc(orgId)
      .collection('org_members')
      .doc(uid)
      .get(),
  )
  const role = memberSnap?.exists ? (memberSnap.data()?.role as string | undefined) : undefined
  if (role !== 'org_admin') {
    throw new HttpsError(
      'permission-denied',
      'This organization has locked affiliation writes — org admin access is required',
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertAffiliation
// ─────────────────────────────────────────────────────────────────────────────

export const upsertAffiliation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    contactId?: string
    affiliationId?: string
    affiliation_type_id?: string
    issuer?: AffiliationIssuer
    org_id?: string
    issuer_name?: string
    status_id?: string
    reference?: string
    valid_from?: unknown
    valid_until?: unknown
  }

  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!data?.contactId) throw new HttpsError('invalid-argument', 'contactId is required')
  if (!data?.affiliation_type_id) throw new HttpsError('invalid-argument', 'affiliation_type_id is required')
  if (!data?.issuer) throw new HttpsError('invalid-argument', 'issuer is required')
  if (!data?.status_id) throw new HttpsError('invalid-argument', 'status_id is required')

  const { teamId, contactId, affiliationId, affiliation_type_id, issuer, org_id, issuer_name, status_id, reference } = data

  // Auth + plan gate
  await affiliationWriteAllowed(request.auth.uid, teamId, issuer, org_id)

  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')

  if (!team.affiliations_enabled) {
    throw new HttpsError('failed-precondition', 'Affiliations are not enabled for this team')
  }
  if (!planSupportsAffiliations(team.plan ?? null)) {
    throw new HttpsError('failed-precondition', 'Affiliations require Studio or Organization plan')
  }

  // Verify contact belongs to team
  const db = admin.firestore()
  const [, contactSnap] = await to(db.collection(CONTACTS_COLLECTION).doc(contactId).get())
  if (!contactSnap?.exists || contactSnap.data()?.teamId !== teamId) {
    throw new HttpsError('not-found', 'Contact not found in this team')
  }

  // Resolve type + denormalized fields
  const affiliationType = await resolveAffiliationType(teamId, affiliation_type_id, issuer, org_id)
  const type_key = affiliationType?.key ?? undefined
  const label = affiliationType?.label ?? undefined

  // Resolve status → active flag
  const statusDefs = await resolveStatusDefs(issuer, org_id)
  const statusDef = statusDefs.find((s) => s.id === status_id)
  const active = statusDef?.countsAsActive ?? false

  // Parse timestamps if provided
  const valid_from = data.valid_from
    ? admin.firestore.Timestamp.fromMillis(
        typeof data.valid_from === 'number'
          ? data.valid_from
          : (data.valid_from as { seconds: number }).seconds * 1000,
      )
    : undefined
  const valid_until = data.valid_until
    ? admin.firestore.Timestamp.fromMillis(
        typeof data.valid_until === 'number'
          ? data.valid_until
          : (data.valid_until as { seconds: number }).seconds * 1000,
      )
    : undefined

  const affiliationsRef = db
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)

  if (affiliationId) {
    // Update existing
    const updatePayload: Partial<Affiliation> & { updated_at: unknown } = {
      teamId,
      affiliation_type_id,
      issuer,
      status_id,
      active,
      updated_at: FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp,
    }
    if (org_id !== undefined) updatePayload.org_id = org_id
    if (issuer_name !== undefined) updatePayload.issuer_name = issuer_name
    if (type_key !== undefined) updatePayload.type_key = type_key
    if (label !== undefined) updatePayload.label = label
    if (reference !== undefined) updatePayload.reference = reference
    if (valid_from !== undefined) updatePayload.valid_from = valid_from
    if (valid_until !== undefined) updatePayload.valid_until = valid_until

    await affiliationsRef.doc(affiliationId).update(updatePayload)
    return { id: affiliationId }
  } else {
    // Create new
    const newRef = affiliationsRef.doc()
    // `contact_live` IS STAMPED AT CREATE, and the contact is already loaded
    // above. `syncAffiliationContactLive` owns the TRANSITIONS, but it fires on
    // the contact — so a row created for somebody already archived would carry
    // no value at all until that person was next written, and an equality filter
    // never matches a missing field. See the field's comment in shared.
    const contactData = contactSnap.data()!
    const createPayload: Omit<Affiliation, 'id'> & { created_at: unknown; updated_at: unknown } = {
      teamId,
      affiliation_type_id,
      issuer,
      status_id,
      active,
      contact_live: isLiveContact(contactData),
      created_by: request.auth.uid,
      created_at: FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp,
      updated_at: FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp,
    }
    if (org_id !== undefined) createPayload.org_id = org_id
    if (issuer_name !== undefined) createPayload.issuer_name = issuer_name
    if (type_key !== undefined) createPayload.type_key = type_key
    if (label !== undefined) createPayload.label = label
    if (reference !== undefined) createPayload.reference = reference
    if (valid_from !== undefined) createPayload.valid_from = valid_from
    if (valid_until !== undefined) createPayload.valid_until = valid_until

    await newRef.set({ id: newRef.id, ...createPayload })
    return { id: newRef.id }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// removeAffiliation
// ─────────────────────────────────────────────────────────────────────────────

export const removeAffiliation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    contactId?: string
    affiliationId?: string
  }

  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!data?.contactId) throw new HttpsError('invalid-argument', 'contactId is required')
  if (!data?.affiliationId) throw new HttpsError('invalid-argument', 'affiliationId is required')

  const { teamId, contactId, affiliationId } = data

  // Load the affiliation to get its issuer/org_id for the permission check
  const db = admin.firestore()
  const [, affSnap] = await to(
    db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
      .doc(affiliationId)
      .get(),
  )
  if (!affSnap?.exists) throw new HttpsError('not-found', 'Affiliation not found')

  const affData = affSnap.data() as Affiliation
  if (affData.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'Affiliation does not belong to this team')
  }

  await affiliationWriteAllowed(request.auth.uid, teamId, affData.issuer, affData.org_id)

  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')
  if (!team.affiliations_enabled) {
    throw new HttpsError('failed-precondition', 'Affiliations are not enabled for this team')
  }
  if (!planSupportsAffiliations(team.plan ?? null)) {
    throw new HttpsError('failed-precondition', 'Affiliations require Studio or Organization plan')
  }

  await affSnap.ref.delete()
  return { success: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// approveAffiliation — convenience wrapper: set status + recompute active
// ─────────────────────────────────────────────────────────────────────────────

export const approveAffiliation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    contactId?: string
    affiliationId?: string
    status_id?: string
  }

  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!data?.contactId) throw new HttpsError('invalid-argument', 'contactId is required')
  if (!data?.affiliationId) throw new HttpsError('invalid-argument', 'affiliationId is required')
  if (!data?.status_id) throw new HttpsError('invalid-argument', 'status_id is required')

  const { teamId, contactId, affiliationId, status_id } = data

  const db = admin.firestore()
  const [, affSnap] = await to(
    db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
      .doc(affiliationId)
      .get(),
  )
  if (!affSnap?.exists) throw new HttpsError('not-found', 'Affiliation not found')

  const affData = affSnap.data() as Affiliation
  if (affData.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'Affiliation does not belong to this team')
  }

  await affiliationWriteAllowed(request.auth.uid, teamId, affData.issuer, affData.org_id)

  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')
  if (!team.affiliations_enabled) {
    throw new HttpsError('failed-precondition', 'Affiliations are not enabled for this team')
  }
  if (!planSupportsAffiliations(team.plan ?? null)) {
    throw new HttpsError('failed-precondition', 'Affiliations require Studio or Organization plan')
  }

  // Resolve the status def → active flag
  const statusDefs = await resolveStatusDefs(affData.issuer, affData.org_id)
  const statusDef = statusDefs.find((s) => s.id === status_id)
  const active = statusDef?.countsAsActive ?? false

  await affSnap.ref.update({
    status_id,
    active,
    updated_at: FieldValue.serverTimestamp(),
  })

  return { id: affiliationId, status_id, active }
})

// ─────────────────────────────────────────────────────────────────────────────
// renewAffiliation — reverse expiry: set active + extend the validity window.
// No payment is processed; the fee (if any) is paid directly to the issuer.
// Bulk renew is the caller looping this per selected affiliation.
// ─────────────────────────────────────────────────────────────────────────────

/** Add `months` calendar months to a Date, clamping day overflow (e.g. Jan 31 + 1
 * month lands on the last day of Feb, not Mar 3). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  const targetMonth = d.getMonth() + months
  d.setMonth(targetMonth)
  // If the day rolled over into the next month, clamp back to the last valid day.
  if (d.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    d.setDate(0)
  }
  return d
}

export const renewAffiliation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as {
    teamId?: string
    contactId?: string
    affiliationId?: string
    months?: number
    fee_paid?: boolean
  }

  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!data?.contactId) throw new HttpsError('invalid-argument', 'contactId is required')
  if (!data?.affiliationId) throw new HttpsError('invalid-argument', 'affiliationId is required')

  const { teamId, contactId, affiliationId } = data

  const db = admin.firestore()
  const [, affSnap] = await to(
    db
      .collection(CONTACTS_COLLECTION)
      .doc(contactId)
      .collection(CONTACT_AFFILIATIONS_SUBCOLLECTION)
      .doc(affiliationId)
      .get(),
  )
  if (!affSnap?.exists) throw new HttpsError('not-found', 'Affiliation not found')

  const affData = affSnap.data() as Affiliation
  if (affData.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'Affiliation does not belong to this team')
  }

  await affiliationWriteAllowed(request.auth.uid, teamId, affData.issuer, affData.org_id)

  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')
  if (!team.affiliations_enabled) {
    throw new HttpsError('failed-precondition', 'Affiliations are not enabled for this team')
  }
  if (!planSupportsAffiliations(team.plan ?? null)) {
    throw new HttpsError('failed-precondition', 'Affiliations require Studio or Organization plan')
  }

  // Validity window: extend from the later of now / current expiry so no time is lost.
  const type = await resolveAffiliationType(teamId, affData.affiliation_type_id, affData.issuer, affData.org_id)
  // ONE RESOLVER, shared with the web preview. The two used to compute this
  // separately and agreed only because both were three lines of `addMonths`; a
  // second validity mode would have made the preview and the saved record
  // disagree, which is the worst way to find out.
  const now = admin.firestore.Timestamp.now()
  const currentUntil = affData.valid_until
    ? (affData.valid_until as unknown as admin.firestore.Timestamp).toDate()
    : null
  const newValidUntil = admin.firestore.Timestamp.fromDate(
    resolveAffiliationValidUntil({
      type,
      currentValidUntil: currentUntil,
      now: now.toDate(),
      monthsOverride: typeof data.months === 'number' ? data.months : null,
    })
  )

  // Flip back to the issuer's "active" status (reverses the daily expiry task).
  const activeStatusId = await resolveActiveStatusId(affData.issuer, affData.org_id)

  const updatePayload: Record<string, unknown> = {
    status_id: activeStatusId,
    active: true,
    valid_until: newValidUntil,
    updated_at: FieldValue.serverTimestamp(),
  }
  // Optional, display-only "fee received" flag — no payment is processed here.
  if (typeof data.fee_paid === 'boolean') {
    updatePayload.fee_paid = data.fee_paid
    updatePayload.fee_paid_at = data.fee_paid ? now : FieldValue.delete()
  }

  await affSnap.ref.update(updatePayload)

  return {
    id: affiliationId,
    status_id: activeStatusId,
    active: true,
    valid_until: newValidUntil.toMillis(),
  }
})
