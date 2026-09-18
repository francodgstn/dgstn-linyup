// Shared plugin teardown helpers.
// Called from onInstalledPluginStatusChange (trigger) and downgradeTeamToFree
// (saas-billing) so teardown logic is never duplicated.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  TEAMS_COLLECTION,
  SITE_PUBLISHED_COLLECTION,
  SITE_PAGES_SUBCOLLECTION,
  SITE_DRAFTS_COLLECTION,
  ORG_SITE_PUBLISHED_COLLECTION,
  ORG_SITE_DRAFTS_COLLECTION,
  COURSES_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_INSTALLED_PLUGINS_SUBCOLLECTION,
} from '@linyup/shared'
import { deleteSiteI18nSidecars } from '../translate/translateSite'

/**
 * Nudges the team document so `syncTeamPublicProfile` re-runs and recomputes
 * `active_public_surfaces`.
 *
 * The signals that decide surface liveness (a published site, a published
 * course/form/document) live OUTSIDE the team doc — in `site_published`, the
 * `courses`/`forms`/`documents` collections — so publishing or unpublishing that
 * content does NOT re-trigger the `onDocumentWritten('teams/{teamId}')` sync.
 * A tiny server-timestamp write on a dedicated field fires that trigger without
 * rewriting the team document. Nothing reads `surfaces_updated_at`; it exists
 * solely to re-run the recompute. Call it from any flow that flips a surface's
 * published state (see website callables + the content public_profile syncs).
 *
 * ── `update`, NEVER `set(..., {merge:true})` — IT RESURRECTS DELETED TEAMS ──
 * This used to be a merge write, which CREATES the document when it is absent.
 * Most callers are `onDocumentWritten` triggers on a team's courses, forms,
 * documents, events, activities and availability — and those fire on DELETE as
 * much as on write. So tearing a tenant down ran this against a team that was
 * already gone and brought it back, which then fired `onTeamCreated` and SEEDED
 * it: default payment modes, the `lib_trial_cleanup` automation rule, default
 * plugins, and a `public_profile` mirror from `syncTeamPublicProfile`.
 *
 * Not hypothetical. Deleting HMD's sixteen studios from staging (2026-09-05)
 * left THIRTEEN of them standing as half-provisioned ghosts, each carrying
 * `payment_modes`, `surfaces_updated_at`, an `automation_rules` rule and a
 * public profile — a tenant that had been deleted, advertising itself. The same
 * chain runs under `saas-billing/purgeTeam.ts`, which deletes the same content
 * for a real customer.
 *
 * An earlier, quieter symptom of the same bug: the migration's pass 2 saw the
 * resurrected stub, concluded the team already existed, and skipped writing its
 * name — so a club lost its identity on a run that reported success.
 *
 * `update` fails with NOT_FOUND instead of creating, and NOT_FOUND is exactly
 * the case where there is nothing to recompute. No other error is swallowed.
 */
export async function touchTeamForSurfaceRecompute(teamId: string): Promise<void> {
  try {
    await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .update({ surfaces_updated_at: FieldValue.serverTimestamp() })
  } catch (err) {
    // NOT_FOUND (gRPC 5) — the team is being deleted, or already is. Nothing to
    // recompute, and re-creating it is the bug this catch exists to prevent.
    if ((err as { code?: number }).code === 5) return
    throw err
  }
}

/**
 * The resolved ACTIVE install of `pluginId` for `teamId` — the team's own, or
 * the one its organisation installed on its behalf. Null when neither is active.
 *
 * ── ORG_ID IS THE GRANT ──────────────────────────────────────────────────────
 * This is `useInstalledPlugins`' doctrine (see its header) applied server-side.
 * An org install confers the feature on every member studio, and there is no
 * second plan check here for the same reason there is none there: joining an org
 * sets `plan: 'organization'` in the same write as `org_id`, and every plugin is
 * included at that tier, so the team's own plan already says yes.
 *
 * This function used to read the TEAM path only, which made an org-level install
 * invisible to every server-side gate — a studio could see a feature in its own
 * sidebar and be refused by the callable behind it.
 *
 * ── AN INACTIVE TEAM DOCUMENT DOES NOT VETO AN ACTIVE ORG ONE ────────────────
 * The obvious "the team document wins if it exists" reading is WRONG, and the
 * client is the specification: `useInstalledPlugins` filters to
 * `status === 'active'` FIRST and only then lets a team entry take precedence
 * over an org one. A veto here would refuse exactly what the studio can see.
 * Precedence between two ACTIVE documents still favours the team's, which is
 * why its config is returned in preference.
 */
export async function resolveActivePluginInstall(
  teamId: string,
  pluginId: string,
): Promise<Record<string, unknown> | null> {
  const db = admin.firestore()
  const teamSnap = await db.collection(TEAMS_COLLECTION).doc(teamId).get()
  const orgId = (teamSnap.data()?.org_id as string | undefined) ?? null
  const resolved = await resolveActivePluginInstalls(teamId, orgId, [pluginId])
  return resolved.get(pluginId) ?? null
}

/**
 * The same question for SEVERAL plugins at once, asked by a caller that ALREADY
 * knows the team's `org_id`.
 *
 * ── ONE IMPLEMENTATION OF THE PRECEDENCE RULE ────────────────────────────────
 * This is where the doctrine documented above actually lives;
 * `resolveActivePluginInstall` reads the team document for `org_id` and then
 * delegates here. The rule is subtle enough — an INACTIVE team document must not
 * veto an ACTIVE org one — that a second copy would eventually disagree with the
 * client, which is the specification.
 *
 * ── WHY THE PLURAL FORM EXISTS ───────────────────────────────────────────────
 * `syncTeamPublicProfile` probes three plugins on EVERY team write and already
 * holds the team document. Calling the singular form three times would re-read
 * that document three times for a value it is standing on. Batched, this is two
 * `getAll` round trips whatever the plugin count — and the second only when
 * something was not answered by the team's own installs.
 */
export async function resolveActivePluginInstalls(
  teamId: string,
  orgId: string | null | undefined,
  pluginIds: readonly string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const db = admin.firestore()
  const out = new Map<string, Record<string, unknown> | null>()
  const ids = [...new Set(pluginIds)]
  if (ids.length === 0) return out

  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)
  const teamSnaps = await db.getAll(
    ...ids.map((id) => teamRef.collection(INSTALLED_PLUGINS_SUBCOLLECTION).doc(id))
  )
  const unresolved: string[] = []
  ids.forEach((id, i) => {
    const snap = teamSnaps[i]
    if (snap?.exists && snap.data()?.status === 'active') out.set(id, snap.data() ?? null)
    else unresolved.push(id)
  })

  if (!orgId || unresolved.length === 0) {
    for (const id of unresolved) out.set(id, null)
    return out
  }

  const orgPluginsRef = db
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(orgId)
    .collection(ORG_INSTALLED_PLUGINS_SUBCOLLECTION)
  const orgSnaps = await db.getAll(...unresolved.map((id) => orgPluginsRef.doc(id)))
  unresolved.forEach((id, i) => {
    const snap = orgSnaps[i]
    out.set(
      id,
      snap?.exists && snap.data()?.status === 'active' ? (snap.data() ?? null) : null
    )
  })
  return out
}

/** Is a plugin installed AND active for this team — its own, or its org's? */
export async function pluginIsActive(teamId: string, pluginId: string): Promise<boolean> {
  return (await resolveActivePluginInstall(teamId, pluginId)) !== null
}

/**
 * THE install gate for a plugin-delivered capability. One helper, so a new entry
 * point is a one-line addition rather than a re-derivation of what "installed"
 * means.
 *
 * ── WHERE IT BELONGS, AND WHERE IT MUST NOT GO ──────────────────────────────
 * On CREATION — selling a gift card, minting one, creating a promo code. NEVER
 * on consuming what already exists:
 *
 *   • An outstanding gift card is money the studio has ALREADY TAKEN. Refusing
 *     to redeem it because somebody unticked a plugin would be the studio
 *     keeping a customer's money and giving nothing back.
 *   • A live promo code caught mid-checkout belongs to a visitor who did
 *     nothing wrong. This matches the `requirePlan` gate it replaces, which was
 *     creation-only for the same reason.
 *
 * `packages/functions/src/connect/pluginGate.test.ts` re-derives the call sites
 * from the source, so a new creation path that forgets this fails the build,
 * and a redemption path that adds it fails too.
 */
export async function assertPluginInstalled(teamId: string, pluginId: string): Promise<void> {
  if (await pluginIsActive(teamId, pluginId)) return
  throw new HttpsError('failed-precondition', `The ${pluginId} plugin is not installed`, {
    reason: 'plugin_not_installed',
    pluginId,
  })
}

/**
 * Removes the public site snapshot and flags the site draft as disabled.
 * Mirrors the core of unpublishWebsite callable (website/index.ts) without
 * the auth/RBAC guards that are only relevant for the user-facing callable.
 */
export async function unpublishSiteForTeam(teamId: string): Promise<void> {
  const db = admin.firestore()
  // The pages (and their sidecars, which sit beside them) first: deleting the
  // site doc alone would leave every page world-readable by its direct path.
  await db.recursiveDelete(db.collection(`${SITE_PUBLISHED_COLLECTION}/${teamId}/${SITE_PAGES_SUBCOLLECTION}`))
  await db.doc(`${SITE_PUBLISHED_COLLECTION}/${teamId}`).delete()
  await deleteSiteI18nSidecars(db, SITE_PUBLISHED_COLLECTION, teamId)
  await db.doc(`${SITE_DRAFTS_COLLECTION}/${teamId}`).set(
    { enabled: false, updated_at: FieldValue.serverTimestamp() },
    { merge: true }
  )
}

/**
 * The organisation-level counterpart: removes `org_site_published/{orgId}` and
 * flags the org draft disabled. Mirrors the core of the unpublishOrgWebsite
 * callable (orgWebsite/index.ts) without its auth guard.
 *
 * It exists because no trigger tears an ORG's artefacts down.
 * `onInstalledPluginStatusChange` is bound to
 * `teams/{teamId}/installed_plugins/{pluginId}` only, and the org-level trigger
 * that does now exist (`plugins/bundleTriggers.ts`) owns bundle reconciliation
 * and nothing else — deliberately, because the org lapse path is
 * resumable-not-atomic and a teardown step inside an eventually-consistent
 * trigger could leave a public site up after a half-run lapse. So deactivating
 * an org's `website` install still tears nothing down by itself, and
 * orgs/lifecycle.ts calls this explicitly.
 */
export async function unpublishSiteForOrg(orgId: string, updatedBy?: string): Promise<void> {
  const db = admin.firestore()
  // The pages first, exactly as for a team: deleting the site doc alone would
  // leave every page world-readable by its direct path — after an unpublish,
  // and after a LAPSE, which runs this same function.
  await db.recursiveDelete(db.collection(`${ORG_SITE_PUBLISHED_COLLECTION}/${orgId}/${SITE_PAGES_SUBCOLLECTION}`))
  await db.doc(`${ORG_SITE_PUBLISHED_COLLECTION}/${orgId}`).delete()
  await deleteSiteI18nSidecars(db, ORG_SITE_PUBLISHED_COLLECTION, orgId)
  await db.doc(`${ORG_SITE_DRAFTS_COLLECTION}/${orgId}`).set(
    { enabled: false, updated_at: FieldValue.serverTimestamp(), ...(updatedBy ? { updatedBy } : {}) },
    { merge: true }
  )
}

/**
 * Batch-deletes every courses/{courseId}/public_profile/{courseId} summary
 * belonging to the team, effectively unpublishing all course listings.
 * Mirrors what syncCoursePublicProfile does for a single course on delete/
 * unpublish, applied to all courses of the team at once.
 *
 * ONE-WAY: nothing rewrites a mirror on reinstall (syncCoursePublicProfile fires
 * on a `courses/{id}` write only), and a contact who BOUGHT a course reaches it
 * through this mirror — so whether it runs at all is a decision, not a detail.
 * Both callers take it from `CourseMirrorDisposition` (saas-billing/downgrade.ts),
 * which is where that decision is written down.
 */
export async function deleteAllCoursePublicProfiles(teamId: string): Promise<void> {
  const db = admin.firestore()
  // Fetch all courses for the team (no status filter — removes all summaries
  // regardless of current status, since the plugin is no longer active).
  const coursesSnap = await db
    .collection(COURSES_COLLECTION)
    .where('teamId', '==', teamId)
    .get()

  if (coursesSnap.empty) return

  // Firestore batches are capped at 500 ops. Split into chunks.
  const BATCH_SIZE = 400
  const docs = coursesSnap.docs
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch()
    for (const courseDoc of docs.slice(i, i + BATCH_SIZE)) {
      const profileRef = courseDoc.ref.collection('public_profile').doc(courseDoc.id)
      batch.delete(profileRef)
    }
    await batch.commit()
  }
}

// There is deliberately NO deleteAllDocumentPublicProfiles here.
//
// It existed to tear down every document mirror when the Documents plugin was
// deactivated — which `downgradeTeamToFree` triggers for every lapsed team.
// Documents is now a default feature with no install to deactivate, and under a
// waiver gate that teardown was actively dangerous: a downgrade would have
// deleted the public copy of a document the booking gate points at, and emptied
// `signup_documents` in the same beat. Retiring a plan must not delete evidence.
//
// If some future feature needs a bulk mirror teardown, write it for that feature
// — do not resurrect this one.
