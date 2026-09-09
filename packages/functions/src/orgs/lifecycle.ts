/* eslint-disable no-console */
// THE ONE PLACE AN ORGANISATION STOPS BEING AN ORGANISATION (UX-9 / UX-10).
//
// Two events reach it and nothing else may: the trial sweep
// (`handleTrialLifecycle` phase 2) and the Stripe webhook's `subscription.
// cancelled` for an org. Both land here so the answer to "what does a lapsed org
// do to its studios" is written once.
//
// ── THE INVARIANT, AND HOW IT SURVIVES ───────────────────────────────────────
// UX-35 established `org_id ⇒ plan 'organization'`: joining an org sets both in
// one write, and `useInstalledPlugins` treats `org_id` AS the grant rather than
// re-asking the plan. A member studio dropping to Free therefore CANNOT keep
// `org_id` — it would be a Free team merging the org's plugin installs, and the
// org plugins page is client-writable by an org admin (`firestore.rules`:
// `organizations/{orgId}/installed_plugins` → `allow write: if hasOrgRole(orgId,
// 'org_admin')`), so a lapsed org admin could hand every Free studio a plugin
// back by clicking Install.
//
// So the membership ENDS with the plan: `teams/{id}.org_id` is deleted and
// `org_teams/{id}` becomes `removed` (reason `org_lapsed`) in the same beat the
// studio lands on Free. The invariant holds in both directions afterwards, and
// the state is one an existing path already produces — `removeTeamFromOrg` does
// exactly this severance by hand.
//
// It has a real consequence, which is the point rather than a side effect: the
// rules grant an org admin access to a member studio's data through
// `isOrgAdminOfTeam(teamId)`, which reads `teams/{teamId}.org_id`. Severing it
// ends that access. An organisation that stopped paying stops seeing its
// studios' contacts. Getting them back is `inviteTeamToOrg` → the team owner
// accepting again — a human act, not a flag flip.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_TEAMS_SUBCOLLECTION,
  ORG_INSTALLED_PLUGINS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  tenantExemptFromTrialSweep,
  trialSweepExemption,
} from '@linyup/shared'
import type { TenantFlags } from '@linyup/shared'
import { downgradeTeamToFree } from '../saas-billing/downgrade'
import { unpublishSiteForOrg } from '../utils/plugins'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { getHostingUrl } from '../utils/env'

/** Why the organisation is being lapsed. Decides the org's own resting status
 *  and whether the member studios are told their trial ended — the two things
 *  that legitimately differ between "the trial ran out" and "the subscription
 *  was cancelled". Everything else is identical, deliberately. */
export type OrgLapseReason = 'trial_lapsed' | 'subscription_cancelled'

/**
 * Wind an organisation down to nothing it does not pay for.
 *
 *   1. org-level plugin installs → inactive
 *   2. the org's public site → unpublished (draft kept)
 *   3. every active member studio → Free, via the ONE `downgradeTeamToFree`,
 *      but keeping its course mirrors (see the call site)
 *   4. every member studio → severed from the org (see the header)
 *   5. (trial only) the org's own status → 'expired', then the admins are told
 *
 * ── IDEMPOTENT, AND WHY IN THAT ORDER ────────────────────────────────────────
 * The daily sweep must not re-downgrade, re-delete or re-notify a studio it
 * already handled, and it must still finish a run that died halfway.
 *
 *   • a studio already on `plan: 'free'` is skipped entirely (no second
 *     downgrade, no second email) and only re-severed — the cheap, correct
 *     resume.
 *   • the severance is what removes a studio from the `status == 'active'` query
 *     this function reads, so a completed studio is invisible to the next run.
 *   • the org's OWN status flips LAST. Anything that throws mid-run leaves the
 *     org matching the sweep's query, so tomorrow it resumes; once the flip
 *     lands the sweep can never select it again, and the admin email is sent
 *     after the flip so it cannot be sent twice.
 *
 * Deliberately NOT transactional: it spans an unbounded number of studios and
 * several collections. Resumability is the guarantee, not atomicity.
 */
export async function lapseOrganization(
  orgId: string,
  opts: { reason: OrgLapseReason }
): Promise<void> {
  const db = admin.firestore()
  const fromTrial = opts.reason === 'trial_lapsed'
  const orgRef = db.collection(ORGANIZATIONS_COLLECTION).doc(orgId)

  // ── 0: an exempt organisation is never wound down ──────────────────────────
  // The daily sweep already skips these (`tenantExemptFromTrialSweep`), so this
  // is belt-and-braces against the OTHER callers: a hand-run script, an operator
  // console action, or a future webhook branch. A comped tenant has no Stripe
  // subscription at all, so nothing upstream can ever legitimately conclude that
  // it stopped paying — and this teardown unpublishes their site and drops every
  // member studio to Free, which is not a mistake anyone can quietly undo.
  const orgFlags = (await orgRef.get()).data()?.flags as TenantFlags | undefined
  if (tenantExemptFromTrialSweep(orgFlags)) {
    console.log(
      `[orgs] refused to lapse ${trialSweepExemption(orgFlags)} org ${orgId} (reason: ${opts.reason})`
    )
    return
  }

  // ── 1 + 2: the org's own paid surface ──────────────────────────────────────
  const installs = await orgRef
    .collection(ORG_INSTALLED_PLUGINS_SUBCOLLECTION)
    .where('status', '==', 'active')
    .get()
  const activePluginIds = installs.docs.map((d) => d.id)
  for (const d of installs.docs) {
    await d.ref.set(
      { status: 'inactive', updated_at: FieldValue.serverTimestamp() },
      { merge: true }
    )
  }
  if (activePluginIds.includes('website')) {
    await unpublishSiteForOrg(orgId)
  }

  // ── 3 + 4: the member studios ──────────────────────────────────────────────
  const memberTeams = await orgRef
    .collection(ORG_TEAMS_SUBCOLLECTION)
    .where('status', '==', 'active')
    .get()

  for (const link of memberTeams.docs) {
    const teamId = link.id
    try {
      const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
      if (teamSnap.exists && teamSnap.data()?.plan !== 'free') {
        // `fromTrial` also decides the in-app banner (it writes
        // `downgraded_from_trial_at`, which FreeDowngradeBanner reads and whose
        // copy says "your trial has ended"). True on the trial rail, where that
        // sentence is what happened; false when the ORGANISATION cancelled a
        // paid subscription, where it would be a lie.
        // `courseMirrors: 'keep_for_buyers'` is the ONE thing an org lapse does
        // differently from a team's own (UX-16 follow-up). A team that stops
        // paying loses its course listings; here the studio did not stop paying
        // and neither did the member who BOUGHT a course — the organisation
        // above them did. Deleting `courses/{id}/public_profile/{id}` would take
        // that course away from the buyer (the entitlement survives, the surface
        // the Space resolves it through does not) and nothing rewrites a mirror
        // on reinstall, so it would not come back when the org pays again.
        await downgradeTeamToFree(teamId, { fromTrial, courseMirrors: 'keep_for_buyers' })
        // The studio owner is told on BOTH rails, because on neither one did
        // they do anything — the organisation did. A silent drop to a capped
        // plan is the thing nobody finds out about until it refuses a signup.
        await sendStudioLapseEmail(teamId, teamSnap.data()!, orgId, opts.reason).catch((e) =>
          console.error(`[org-lapse] studio email failed ${teamId}:`, e)
        )
      }
      // Severance — ALWAYS, including for a studio that was already Free, so a
      // resumed run finishes what it started.
      if (teamSnap.exists) {
        await db.collection(TEAMS_COLLECTION).doc(teamId).update({
          org_id: FieldValue.delete(),
          updated_at: FieldValue.serverTimestamp(),
        })
      }
      await link.ref.update({
        status: 'removed',
        removed_at: FieldValue.serverTimestamp(),
        removed_reason: 'org_lapsed',
      })
      console.log(`[org-lapse] org ${orgId}: studio ${teamId} moved to free and unlinked`)
    } catch (err) {
      // Leave this link 'active' so the next run retries it, and let the loop
      // carry on — one unreachable studio must not strand the others.
      console.error(`[org-lapse] org ${orgId}: studio ${teamId} failed:`, err)
    }
  }

  // ── 5: the org's own resting state ─────────────────────────────────────────
  // A cancelled subscription already wrote 'cancelled' onto both documents in
  // the webhook; only the trial rail has a status to settle here.
  if (!fromTrial) return

  const now = FieldValue.serverTimestamp()
  await orgRef.update({
    plan_status: 'expired',
    downgraded_from_trial_at: now,
    updated_at: now,
  })
  await db
    .collection('saas_subscriptions')
    .doc(orgId)
    .set({ status: 'expired', updated_at: now }, { merge: true })

  await sendOrgTrialExpiredEmail(orgId).catch((e) =>
    console.error(`[org-lapse] admin email failed ${orgId}:`, e)
  )
}

/** The org admins are told once, after the status has actually moved. */
async function sendOrgTrialExpiredEmail(orgId: string): Promise<void> {
  const db = admin.firestore()
  const orgSnap = await db.collection(ORGANIZATIONS_COLLECTION).doc(orgId).get()
  if (!orgSnap.exists) return
  const orgName = (orgSnap.data()?.name as string | undefined) ?? 'your organisation'

  const admins = await db
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(orgId)
    .collection('org_members')
    .where('role', '==', 'org_admin')
    .get()

  const recipients = [
    ...new Set(
      admins.docs
        .map((d) => (d.data().email as string | undefined) ?? '')
        .filter((e) => e.includes('@'))
    ),
  ]
  if (recipients.length === 0) return

  const billingUrl = `${getHostingUrl()}/org/${orgId}/billing`
  const { html, text } = buildEmailTemplate({
    title: 'Your Linyup organisation trial has ended',
    body: `
      <p>The trial of <strong>${orgName}</strong> on Linyup has ended.</p>
      <p>The studios that were billed through the organisation have been moved to the
      <strong>Free plan</strong> and unlinked from it. All of their data is kept, and each one keeps
      working within the Free plan's limits.</p>
      <p style="margin:16px 0;">${ctaButton(billingUrl, 'Subscribe')}</p>
      <p>Subscribing reopens the organisation. Its studios then have to be invited back — a studio
      owner has to accept, which is also what restores your access to their data.</p>
    `,
  })

  for (const to of recipients) {
    await sendEmail({ to, subject: 'Your Linyup organisation trial has ended', html, text })
  }
}

/** …and so is the owner of each studio that just landed on Free, because they
 *  are the person who meets the Free plan's limits tomorrow morning. */
async function sendStudioLapseEmail(
  teamId: string,
  team: FirebaseFirestore.DocumentData,
  orgId: string,
  reason: OrgLapseReason
): Promise<void> {
  const db = admin.firestore()
  let ownerEmail: string | undefined

  const ownerUid = team.primaryContact as string | undefined
  if (ownerUid) ownerEmail = (await db.collection('users').doc(ownerUid).get()).data()?.email
  if (!ownerEmail) {
    const m = await db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection('team_members')
      .where('role', '==', 'owner')
      .limit(1)
      .get()
    if (!m.empty) {
      const uid = (m.docs[0].data().userId as string | undefined) ?? m.docs[0].id
      ownerEmail = (await db.collection('users').doc(uid).get()).data()?.email
    }
  }
  if (!ownerEmail) return

  const orgSnap = await db.collection(ORGANIZATIONS_COLLECTION).doc(orgId).get()
  const orgName = (orgSnap.data()?.name as string | undefined) ?? 'your organisation'
  const billingUrl = `${getHostingUrl()}/settings/billing`

  // Say which of the two happened. They are the same downgrade and completely
  // different news, and a studio owner asking their organisation "why?" should
  // not be told the wrong thing by us.
  const cause =
    reason === 'trial_lapsed'
      ? `The Linyup trial of <strong>${orgName}</strong>, which paid for ` +
        `<strong>${team.name ?? 'your studio'}</strong>, has ended.`
      : `The Linyup subscription of <strong>${orgName}</strong>, which paid for ` +
        `<strong>${team.name ?? 'your studio'}</strong>, has ended.`

  const { html, text } = buildEmailTemplate({
    title: 'Your Linyup plan has changed',
    body: `
      <p>${cause}</p>
      <p>Your studio is now on the <strong>Free plan</strong> and no longer linked to the
      organisation. All your data is kept and everything keeps working within the Free plan's
      limits.</p>
      <p style="margin:16px 0;">${ctaButton(billingUrl, 'See plans &amp; upgrade')}</p>
    `,
  })
  await sendEmail({ to: ownerEmail, subject: 'Your Linyup plan has changed', html, text })
}
