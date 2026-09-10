/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getHostingUrl, resolveBaseUrl } from '../utils/env'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { getTeam } from '../utils/teams'
import { getPlatformStripeAdapter } from '../saas-billing/actions'
import { createTeamNotification } from '../utils/teamNotifications'
import type { OrgRole, TenantFlags } from '@linyup/shared'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_TRIAL_DAYS,
  TRIAL_DAYS,
} from '@linyup/shared'

// ─── helpers ──────────────────────────────────────────────────────────────────

// Exported so other org-scoped callables (e.g. ../orgWebsite, ./billing) reuse
// the exact same org-admin gate instead of re-implementing the org_members role
// check. THIS is what authorizes an organisation's own billing — an org admin is
// not a team owner and has no `team_members` document anywhere (UX-75).
export async function assertOrgAdmin(uid: string, orgId: string): Promise<void> {
  const memberDoc = await admin.firestore()
    .collection('organizations').doc(orgId)
    .collection('org_members').doc(uid)
    .get()
  if (!memberDoc.exists || memberDoc.data()?.role !== 'org_admin') {
    throw new HttpsError('permission-denied', 'Organization admin access required')
  }
}

/**
 * "Is this organisation currently paying (or still inside its trial)?" — ONE
 * definition, read off `saas_subscriptions/{orgId}.status`, which is the
 * document both billing rails write and the org billing page reads.
 *
 * It exists because a lapse is now real (UX-9): `handleTrialLifecycle` phase 2
 * rests a lapsed org on 'expired' and the webhook on 'cancelled'. Anything that
 * would hand the ORGANISATION TIER back out from under a lapsed subscription
 * asks this first. A missing subscription document reads as 'trial' — an org
 * created before this rail existed is mid-trial, not lapsed.
 *
 * Callers: `acceptOrgInvitation` (accepting IS the grant of the tier to a
 * studio) and `publishOrgWebsite` (the org's paid public surface, which the
 * lapse takes down and a click would otherwise put straight back up).
 */
export async function assertOrgSubscriptionLive(orgId: string): Promise<void> {
  // A COMPED ORGANISATION HAS NO SUBSCRIPTION AND NEVER WILL — that is the whole
  // arrangement, not a fault to gate on. An absent document already reads as
  // 'trial' and passes, so a freshly comped org is fine by accident; a comped
  // org that USED to pay is not, because cancelling its subscription leaves the
  // document on 'cancelled' and this gate then freezes it permanently:
  // `publishOrgWebsite` refuses, and `acceptOrgInvitation` refuses too, so no
  // new studio can ever join. Comping a customer must not cost it its own
  // organisation.
  const orgSnap = await admin.firestore().collection(ORGANIZATIONS_COLLECTION).doc(orgId).get()
  const orgFlags = orgSnap.data()?.flags as TenantFlags | undefined
  if (orgFlags?.comped === true) return

  const sub = await admin.firestore().collection('saas_subscriptions').doc(orgId).get()
  const status = sub.exists ? ((sub.data()?.status as string | undefined) ?? 'trial') : 'trial'
  if (status !== 'trial' && status !== 'active') {
    throw new HttpsError(
      'failed-precondition',
      'This organization does not have an active subscription.',
      { reason: 'org_subscription_inactive' }
    )
  }
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
}

// ─────────────────────────────────────────────────────────────────────────────
// createOrganization — any authenticated user can create an org
// ─────────────────────────────────────────────────────────────────────────────

export const createOrganization = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { name?: string; description?: string }
  if (!data?.name?.trim()) throw new HttpsError('invalid-argument', 'Organization name is required')

  const uid = request.auth.uid
  const name = data.name.trim()
  const db = admin.firestore()

  // Generate a slug, append random suffix if taken
  let slug = generateSlug(name)
  const existing = await db.collection('organizations').where('slug', '==', slug).limit(1).get()
  if (!existing.empty) {
    slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`
  }

  const now = FieldValue.serverTimestamp()
  // A DEADLINE, not a countdown: `handleTrialLifecycle`'s org phase reads this
  // stored value and never recomputes it, so a Linyup operator onboarding an
  // organisation by hand extends its trial by editing this one field (or exempts
  // it entirely with `flags.internal` / `flags.pilot`).
  const trialEndsAt = Timestamp.fromDate(new Date(Date.now() + ORG_TRIAL_DAYS * 24 * 60 * 60 * 1000))

  // Display copy for the creator's own member row. The org Members list names
  // people from the membership document — an org admin has no rule that lets
  // them read `users/{uid}` — so a row written without these renders a raw uid.
  const creatorDoc = await db.collection('users').doc(uid).get()
  const creatorName = (creatorDoc.data()?.displayName as string | undefined) ?? ''
  const creatorEmail = (creatorDoc.data()?.email as string | undefined) ?? ''

  const orgRef = db.collection('organizations').doc()
  const batch = db.batch()

  // Org entity
  batch.set(orgRef, {
    name,
    slug,
    description: data.description?.trim() ?? '',
    plan: 'organization',
    plan_status: 'trial',
    trial_ends_at: trialEndsAt,
    created: now,
    createdBy: uid,
  })

  // Creator as org_admin
  batch.set(orgRef.collection('org_members').doc(uid), {
    userId: uid,
    orgId: orgRef.id,
    role: 'org_admin',
    joined: now,
    addedBy: uid,
    displayName: creatorName,
    email: creatorEmail,
  })

  // Record orgId on the user profile so the sidebar can find it without a collectionGroup query
  batch.update(db.collection('users').doc(uid), {
    orgIds: FieldValue.arrayUnion(orgRef.id),
  })

  // SaaS subscription record
  batch.set(db.collection('saas_subscriptions').doc(orgRef.id), {
    entity_type: 'org',
    entity_id: orgRef.id,
    teamId: orgRef.id, // backwards compat field
    plan: 'organization',
    status: 'trial',
    trial_ends_at: trialEndsAt,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    gateway_type: null,
    gateway_data: null,
    created_at: now,
    updated_at: now,
  })

  await batch.commit()
  return { orgId: orgRef.id, slug }
})

// ─────────────────────────────────────────────────────────────────────────────
// inviteTeamToOrg — org admin sends invitation to a team owner
// ─────────────────────────────────────────────────────────────────────────────

export const inviteTeamToOrg = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { orgId?: string; teamId?: string; inviteeEmail?: string }
  if (!data?.orgId) throw new HttpsError('invalid-argument', 'orgId is required')
  if (!data.teamId && !data.inviteeEmail) {
    throw new HttpsError('invalid-argument', 'Either teamId or inviteeEmail is required')
  }

  await assertOrgAdmin(request.auth.uid, data.orgId)

  const db = admin.firestore()
  const orgDoc = await db.collection('organizations').doc(data.orgId).get()
  if (!orgDoc.exists) throw new HttpsError('not-found', 'Organization not found')

  const org = orgDoc.data()!
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))

  // If inviting by teamId, verify team exists and get owner email
  let inviteeEmail = data.inviteeEmail?.toLowerCase().trim()
  let teamName: string | undefined

  if (data.teamId) {
    const team = await getTeam(data.teamId)
    if (!team) throw new HttpsError('not-found', 'Team not found')
    teamName = team.name

    // Check if already in an org
    if (team.org_id) {
      throw new HttpsError('failed-precondition', 'This team is already part of an organization')
    }

    // Get owner email for invitation
    if (!inviteeEmail) {
      const ownerSnap = await db.collection('teams').doc(data.teamId)
        .collection('team_members').where('role', '==', 'owner').limit(1).get()
      if (!ownerSnap.empty) {
        const ownerDoc = await db.collection('users').doc(ownerSnap.docs[0].id).get()
        inviteeEmail = ownerDoc.data()?.email ?? undefined
      }
    }
  }

  if (!inviteeEmail) {
    throw new HttpsError('invalid-argument', 'Could not determine invitee email address')
  }

  const invRef = await db.collection('organizations').doc(data.orgId)
    .collection('org_invitations').add({
      orgId: data.orgId,
      teamId: data.teamId ?? null,
      inviteeEmail,
      status: 'pending',
      invitedBy: request.auth.uid,
      created: FieldValue.serverTimestamp(),
      expires_at: expiresAt,
    })

  const hostingUrl = getHostingUrl()
  const acceptUrl = `${hostingUrl}/org-invite/${data.orgId}/${invRef.id}`
  const teamLabel = teamName ? `<strong>${teamName}</strong>` : 'your team'

  const { html, text } = buildEmailTemplate({
    title: `Invitation to join ${org.name} on Linyup`,
    body: `
      <p>You have been invited to join ${teamLabel} to the organization <strong>${org.name}</strong> on Linyup.</p>
      <p>By accepting, your team's billing will be managed by the organization and you'll get access to all organization plan features.</p>
      <p style="margin:16px 0;">${ctaButton(acceptUrl, 'Accept Invitation')}</p>
      <p>This invitation expires in 7 days. If you did not expect this, you can safely ignore this email.</p>
    `,
  })

  await sendEmail({
    to: inviteeEmail,
    subject: `Invitation to join ${org.name} on Linyup`,
    html,
    text,
  })

  return { invitationId: invRef.id }
})

// ─────────────────────────────────────────────────────────────────────────────
// acceptOrgInvitation — team owner accepts an org invitation
// ─────────────────────────────────────────────────────────────────────────────

export const acceptOrgInvitation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { invitationId?: string; teamId?: string }
  if (!data?.invitationId || !data?.teamId) {
    throw new HttpsError('invalid-argument', 'invitationId and teamId are required')
  }

  const db = admin.firestore()

  // Load invitation
  const invQuery = await db.collectionGroup('org_invitations')
    .where(admin.firestore.FieldPath.documentId(), '==', data.invitationId)
    .limit(1)
    .get()

  // Fallback: try finding it by path structure
  // (collectionGroup on a known-path subcollection requires a composite index)
  // Instead, search within the orgs the user could be invited to — safer to
  // require orgId in the URL and fetch directly.
  // For now, accept invitationId + orgId as context from the client (passed via the accept page).
  if (invQuery.empty) {
    throw new HttpsError('not-found', 'Invitation not found')
  }

  const invDoc = invQuery.docs[0]
  const inv = invDoc.data()

  if (inv.status !== 'pending') {
    throw new HttpsError('failed-precondition', `Invitation is already ${inv.status}`)
  }
  if (inv.expires_at.toDate() < new Date()) {
    await invDoc.ref.update({ status: 'expired' })
    throw new HttpsError('deadline-exceeded', 'Invitation has expired')
  }

  // Validate caller is owner of the team
  const teamMemberDoc = await db.collection('teams').doc(data.teamId)
    .collection('team_members').doc(request.auth.uid).get()
  if (!teamMemberDoc.exists || teamMemberDoc.data()?.role !== 'owner') {
    throw new HttpsError('permission-denied', 'Only the team owner can accept this invitation')
  }

  const orgId = inv.orgId

  // Load org subscription to propagate plan_status
  const subDoc = await db.collection('saas_subscriptions').doc(orgId).get()
  const orgPlanStatus = subDoc.exists ? (subDoc.data()?.status ?? 'trial') : 'trial'

  // ACCEPTING IS THE GRANT — this write is what puts a studio on the
  // organisation plan (UX-35: `org_id` IS the grant), so an organisation that is
  // no longer paying must not be able to issue it. Without this check the whole
  // of UX-9 is undone by two clicks: the trial sweep lapses the org and unlinks
  // its studios, and the org admin re-invites them straight back onto the top
  // tier — with the org now on 'expired', so the sweep (which selects 'trial')
  // can never fire again.
  if (orgPlanStatus !== 'trial' && orgPlanStatus !== 'active') {
    throw new HttpsError(
      'failed-precondition',
      'This organization does not have an active subscription. Ask an organization admin to subscribe, then accept again.',
      { reason: 'org_subscription_inactive' }
    )
  }

  // A STUDIO THAT IS STILL PAYING FOR ITSELF CANNOT JOIN — it would pay twice.
  //
  // Accepting puts the studio on the ORGANISATION's plan and the org's
  // subscription is what pays for it (UX-35). Its own Stripe subscription is not
  // touched by that write and goes on invoicing, so the owner is charged for a
  // seat the federation is already paying for — and nothing anywhere says so.
  // The two halves of the old failure are both silent, and the second is worse
  // than the duplicate charge: cancelling the leftover subscription — the
  // correct thing to do — fires `subscription.cancelled` into
  // `downgradeTeamToFree` on a paid-up member of the federation, deactivating
  // its plugins, unpublishing its website and deleting its course mirrors
  // one-way. See `docs/studio-independent-contacts.md`.
  //
  // REFUSING IS THE CHOSEN ANSWER (Franco, 2026-09-09) rather than cancelling
  // the subscription on the owner's behalf: this callable never takes a money
  // action for somebody, and the refusal mirrors `createCheckoutSession`'s
  // `billed_by_org`, which is this same rule read from the other end.
  //
  // A TRIAL IS NOT A SUBSCRIPTION and must not be refused — a trialing studio
  // joining a federation is the ordinary path. It cannot be caught here by
  // construction: no `saas_subscriptions/{teamId}` document exists until Stripe
  // fires for a real subscription (a team's trial lives on `teams/{id}`, and
  // only `createOrganization` seeds a subscription doc up front, for an ORG).
  const teamSubDoc = await db.collection('saas_subscriptions').doc(data.teamId).get()
  const teamSubStatus = teamSubDoc.exists
    ? ((teamSubDoc.data()?.status as string | undefined) ?? null)
    : null
  // `active` covers a subscription already set to stop at period end: it is
  // still live, the studio has paid through the period, and letting it in would
  // still hand the organisation a bill for the overlap.
  if (teamSubStatus === 'active' || teamSubStatus === 'past_due') {
    throw new HttpsError(
      'failed-precondition',
      'This studio still has its own Linyup subscription. Cancel it first, then accept — ' +
        'otherwise it would be paid for twice.',
      { reason: 'team_has_own_subscription', status: teamSubStatus }
    )
  }

  const now = FieldValue.serverTimestamp()
  const batch = db.batch()

  // Mark invitation accepted
  batch.update(invDoc.ref, { status: 'accepted', accepted_at: now })

  // Create org_teams entry
  batch.set(
    db.collection('organizations').doc(orgId).collection('org_teams').doc(data.teamId),
    {
      teamId: data.teamId,
      orgId,
      status: 'active',
      joined: now,
      addedBy: request.auth.uid,
    }
  )

  // Link team to org and upgrade its plan. `trial_ends_at` is CLEARED: the
  // team's own trial is over as a fact — the organisation's subscription is what
  // governs it now, and a leftover past date on a team whose status is 'trial'
  // (which it is whenever the org is still trialing) is precisely what made
  // handleTrialLifecycle reset member studios to Free (UX-35). One stale field,
  // two systems disagreeing about who is paying.
  batch.update(db.collection('teams').doc(data.teamId), {
    org_id: orgId,
    plan: 'organization',
    plan_status: orgPlanStatus,
    trial_ends_at: FieldValue.delete(),
    updated_at: now,
  })

  await batch.commit()
  return { orgId, teamId: data.teamId }
})

// ─────────────────────────────────────────────────────────────────────────────
// declineOrgInvitation — team owner declines an org invitation
// ─────────────────────────────────────────────────────────────────────────────

export const declineOrgInvitation = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { invitationId?: string; orgId?: string }
  if (!data?.invitationId || !data?.orgId) {
    throw new HttpsError('invalid-argument', 'invitationId and orgId are required')
  }

  const invDoc = await admin.firestore()
    .collection('organizations').doc(data.orgId)
    .collection('org_invitations').doc(data.invitationId)
    .get()

  if (!invDoc.exists) throw new HttpsError('not-found', 'Invitation not found')
  if (invDoc.data()?.status !== 'pending') {
    throw new HttpsError('failed-precondition', `Invitation is already ${invDoc.data()?.status}`)
  }

  await invDoc.ref.update({ status: 'declined', declined_at: FieldValue.serverTimestamp() })
  return { success: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// removeTeamFromOrg — org admin removes a team from the organization
// ─────────────────────────────────────────────────────────────────────────────

export const removeTeamFromOrg = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { orgId?: string; teamId?: string }
  if (!data?.orgId || !data?.teamId) {
    throw new HttpsError('invalid-argument', 'orgId and teamId are required')
  }

  await assertOrgAdmin(request.auth.uid, data.orgId)

  const db = admin.firestore()
  const orgTeamRef = db.collection('organizations').doc(data.orgId)
    .collection('org_teams').doc(data.teamId)

  const orgTeamDoc = await orgTeamRef.get()
  if (!orgTeamDoc.exists || orgTeamDoc.data()?.status !== 'active') {
    throw new HttpsError('not-found', 'Team is not an active member of this organization')
  }

  const now = FieldValue.serverTimestamp()
  const trialEndsAt = Timestamp.fromDate(new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000))

  const batch = db.batch()

  // Mark org_teams entry as removed
  batch.update(orgTeamRef, { status: 'removed', removed_at: now })

  // Reset team to a grace trial so they can subscribe independently. It is a
  // TEAM trial, so it is TRIAL_DAYS long — the same one a self-service signup
  // gets. (It was hard-coded to 14 from before the 2026-06 pricing overhaul
  // moved a team trial to 30; nothing else in the product grants 14 any more.)
  batch.update(db.collection('teams').doc(data.teamId), {
    org_id: FieldValue.delete(),
    plan: 'studio',
    plan_status: 'trial',
    trial_ends_at: trialEndsAt,
    updated_at: now,
  })

  await batch.commit()
  return { success: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// createOrgCheckoutSession — org admin initiates Stripe checkout for org plan
// ─────────────────────────────────────────────────────────────────────────────

export const createOrgCheckoutSession = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { orgId?: string; locale?: string; origin?: string }
  if (!data?.orgId) throw new HttpsError('invalid-argument', 'orgId is required')

  await assertOrgAdmin(request.auth.uid, data.orgId)

  // A comped organisation is not billed, and its billing page still renders a
  // Subscribe button — see `assertNotComped` in saas-billing/index.ts for why
  // the refusal lives at the callable rather than only in the UI.
  const compedSnap = await admin
    .firestore()
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(data.orgId)
    .get()
  if ((compedSnap.data()?.flags as TenantFlags | undefined)?.comped === true) {
    throw new HttpsError(
      'failed-precondition',
      'This organisation is on a comped plan and is not billed. Contact Linyup to change that.',
      { reason: 'tenant_comped' }
    )
  }

  const { orgId, locale = 'en' } = data

  // Rate limit: max 3 checkout session requests per org per hour
  const oneHourAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000)
  const recentAttempts = await admin.firestore()
    .collection('saas_checkout_attempts')
    .where('teamId', '==', orgId)
    .where('created_at', '>', oneHourAgo)
    .get()
  if (recentAttempts.size >= 3) {
    throw new HttpsError('resource-exhausted', 'Too many checkout requests. Please try again in an hour.')
  }

  const ownerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get()
  const customerEmail: string = ownerDoc.exists ? (ownerDoc.data()!.email ?? '') : ''

  const adapter = await getPlatformStripeAdapter()
  // Same-session redirect → prefer the caller's origin (so local dev returns to
  // localhost), falling back to the env-configured hosting URL.
  const hostingUrl = resolveBaseUrl(data.origin)
  const idempotencyKey = `org-checkout:${orgId}:organization:${Math.floor(Date.now() / 60000)}`

  let session: { url: string; sessionId: string }
  try {
    session = await adapter.createCheckoutSession({
      orgId,
      plan: 'organization',
      customerEmail,
      successUrl: `${hostingUrl}/${locale}/org/${orgId}/billing?checkout=success`,
      cancelUrl: `${hostingUrl}/${locale}/org/${orgId}/billing?checkout=cancelled`,
      idempotencyKey,
    })
  } catch (err) {
    console.error('Org checkout session creation failed:', err)
    throw new HttpsError('internal', 'Failed to create checkout session')
  }

  admin.firestore().collection('saas_checkout_attempts').add({
    teamId: orgId, // reusing field for rate limiting
    plan: 'organization',
    sessionId: session.sessionId,
    created_at: FieldValue.serverTimestamp(),
  }).catch((err) => console.error('Failed to log org checkout attempt:', err))

  return { url: session.url }
})

// ─────────────────────────────────────────────────────────────────────────────
// requestTeamAccess — org admin requests view/manage access to a member team
// ─────────────────────────────────────────────────────────────────────────────

export const requestTeamAccess = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { orgId?: string; teamId?: string; accessType?: string }
  if (!data?.orgId || !data?.teamId) throw new HttpsError('invalid-argument', 'orgId and teamId are required')
  if (data.accessType !== 'view' && data.accessType !== 'manage') {
    throw new HttpsError('invalid-argument', 'accessType must be "view" or "manage"')
  }

  await assertOrgAdmin(request.auth.uid, data.orgId)

  const db = admin.firestore()

  // Verify the team is in this org
  const orgTeamDoc = await db.collection('organizations').doc(data.orgId)
    .collection('org_teams').doc(data.teamId).get()
  if (!orgTeamDoc.exists || orgTeamDoc.data()?.status !== 'active') {
    throw new HttpsError('not-found', 'Team is not an active member of this organization')
  }

  const now = FieldValue.serverTimestamp()
  const requestPayload = {
    teamId: data.teamId,
    orgId: data.orgId,
    requestedBy: request.auth.uid,
    requestedAt: now,
    accessType: data.accessType,
    status: 'pending',
  }

  // Write to both sides atomically so the team can see the request in their own settings
  // and the org admin can see it in the org's teams view.
  const batch = db.batch()

  // Org side: one doc per team, idempotent (org admin view)
  batch.set(
    db.collection('organizations').doc(data.orgId).collection('team_access_requests').doc(data.teamId),
    requestPayload,
    { merge: false }
  )

  // Team side: one doc per org, so team managers/owners can discover and approve it
  batch.set(
    db.collection('teams').doc(data.teamId).collection('org_access_requests').doc(data.orgId),
    requestPayload,
    { merge: false }
  )

  await batch.commit()

  // Notifications (in-app + email) are best-effort — failures must not roll back
  // the access request that was already committed above.
  try {
    const [orgDoc, ownerSnap] = await Promise.all([
      db.collection('organizations').doc(data.orgId).get(),
      db.collection('teams').doc(data.teamId)
        .collection('team_members').where('role', '==', 'owner').limit(1).get(),
    ])

    const orgName = (orgDoc.data()?.name ?? data.orgId) as string

    const [requesterDoc, team] = await Promise.all([
      db.collection('users').doc(request.auth.uid).get(),
      getTeam(data.teamId),
    ])
    const requesterName = (requesterDoc.data()?.displayName || requesterDoc.data()?.email || 'An org admin') as string
    const teamName = team?.name ?? data.teamId
    const accessLabel = data.accessType === 'manage' ? 'manage (admin)' : 'view'
    const hostingUrl = getHostingUrl()

    // ── In-app notification (teams/{teamId}/notifications/{id}) ───────────────
    // Written via Admin SDK so Firestore rules for this subcollection deny client
    // writes ("allow write: if false"). All team managers/owners can read via the
    // "allow read: if hasTeamRole(teamId, 'manager')" rule added to firestore.rules.
    const notificationTitle = `Access request from ${orgName}`
    const notificationBody = `${requesterName} (${orgName}) has requested ${accessLabel} access to your studio.`
    await createTeamNotification(data.teamId, {
      type: 'org_access_request',
      orgId: data.orgId,
      orgName,
      title: notificationTitle,
      body: notificationBody,
      // requestId: the org-side doc (organizations/{orgId}/team_access_requests/{teamId})
      // and the team-side doc (teams/{teamId}/org_access_requests/{orgId}) both use
      // teamId / orgId as their doc id, so no separate requestId field is needed.
      link: '/settings?tab=org',
    })

    // ── Email notification ────────────────────────────────────────────────────
    if (!ownerSnap.empty) {
      const ownerUserDoc = await db.collection('users').doc(ownerSnap.docs[0].id).get()
      const ownerEmail = ownerUserDoc.data()?.email as string | undefined

      if (ownerEmail) {
        const { html, text } = buildEmailTemplate({
          title: `Access request for ${teamName} on Linyup`,
          body: `
            <p><strong>${requesterName}</strong>, an admin of the organization <strong>${orgName}</strong>,
            has requested <strong>${accessLabel}</strong> access to your team <strong>${teamName}</strong> on Linyup.</p>
            <p>You can review and approve or deny this request in your team's settings.</p>
            <p style="margin:16px 0;">${ctaButton(`${hostingUrl}/settings?tab=org`, 'Review Request')}</p>
          `,
        })

        await sendEmail({ to: ownerEmail, subject: `Access request for ${teamName} on Linyup`, html, text })
      }
    }
  } catch (err) {
    console.error('requestTeamAccess: notification failed (non-fatal):', err)
  }

  return { success: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// getOrgInvitationDetails — public: load invitation for the accept page
// ─────────────────────────────────────────────────────────────────────────────

export const getOrgInvitationDetails = onCall(async (request) => {
  const data = request.data as { invitationId?: string; orgId?: string }
  if (!data?.invitationId || !data?.orgId) {
    throw new HttpsError('invalid-argument', 'invitationId and orgId are required')
  }

  const invDoc = await admin.firestore()
    .collection('organizations').doc(data.orgId)
    .collection('org_invitations').doc(data.invitationId)
    .get()

  if (!invDoc.exists) throw new HttpsError('not-found', 'Invitation not found')

  const inv = invDoc.data()!
  if (inv.status !== 'pending') {
    throw new HttpsError('failed-precondition', `Invitation is already ${inv.status}`)
  }

  const orgDoc = await admin.firestore().collection('organizations').doc(data.orgId).get()
  if (!orgDoc.exists) throw new HttpsError('not-found', 'Organization not found')

  const org = orgDoc.data()!

  let teamName: string | undefined
  if (inv.teamId) {
    const teamDoc = await admin.firestore().collection('teams').doc(inv.teamId).get()
    if (teamDoc.exists) teamName = teamDoc.data()?.name
  }

  return {
    orgId: data.orgId,
    orgName: org.name,
    teamId: inv.teamId ?? null,
    teamName: teamName ?? null,
    inviteeEmail: inv.inviteeEmail,
    expiresAt: inv.expires_at.toDate().toISOString(),
  }
})
