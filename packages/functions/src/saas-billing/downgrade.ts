// THE ONE WRITER OF "this team is now on the Free plan".
//
// It lives in its own module for exactly one reason: an ORGANIZATION lapse has
// to move its member studios to Free too (UX-9 / UX-10), and `orgs/lifecycle.ts`
// importing `saas-billing/index.ts` — a module whose top level REGISTERS every
// billing function — would be a cycle. The rule it protects is more important
// than the file it lives in: there is one downgrade path for both tiers, and an
// org-specific copy of this teardown must never be written.
//
// Callers: `saas-billing/index.ts` (the trial sweep + a canceled team
// subscription) and `orgs/lifecycle.ts` (a lapsed organization, per member
// studio). `orgTierRails.test.ts` re-derives that set from the source.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  TEAMS_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  KEEP_COURSE_MIRRORS_FIELD,
} from '@linyup/shared'
import { unpublishSiteForTeam, deleteAllCoursePublicProfiles } from '../utils/plugins'

/**
 * What this downgrade does to `courses/{id}/public_profile/{id}` — the mirror the
 * Space and the shop read, and the ONLY thing that makes a course openable by
 * the contact who bought it.
 *
 *   • `'tear_down'`     — delete every mirror. The listings go dark and NOTHING
 *     brings them back (UX-16: `syncCoursePublicProfile` fires on a
 *     `courses/{id}` write only), so each course must be re-published by hand.
 *     This is what a TEAM's own lapse does: the team stopped paying.
 *   • `'keep_for_buyers'` — leave every mirror standing. A contact who bought a
 *     course keeps watching it. This is what an ORGANIZATION's lapse does to its
 *     member studios (UX-16 follow-up): there, the person who stopped paying is
 *     a THIRD PARTY — neither the studio nor the member who paid for the course
 *     — and taking a bought course away from them for it is indefensible.
 *
 * Stated as a named disposition rather than a boolean so the call site says
 * which of the two it means; there is no default, so a new caller has to choose.
 */
export type CourseMirrorDisposition = 'tear_down' | 'keep_for_buyers'

/**
 * Move a team onto the Free plan (trial lapsed, paid subscription canceled, or
 * the organization that paid for it stopped paying).
 *
 * Clears the legacy wall/purge markers and deactivates plugin installs — Free
 * has no plugin access; install config is preserved so a later upgrade can
 * reactivate without losing settings.
 *
 * WHAT THIS DESTROYS, and what comes back:
 *   • published website  → `site_published/{teamId}` deleted, the DRAFT is kept.
 *     Recovered by re-publishing.
 *   • course mirrors     → `courses/{id}/public_profile/{id}`, per
 *     `opts.courseMirrors` (see CourseMirrorDisposition). On `'tear_down'` they
 *     are deleted and NOT recovered by re-installing the plugin — each course
 *     has to be re-published by hand; a contact who BOUGHT a course keeps the
 *     entitlement and loses the listing, which is exactly why the org rail
 *     passes `'keep_for_buyers'`.
 *
 * Idempotent: a second call finds no active installs, so no teardown re-runs; the
 * team-doc update rewrites the same values.
 */
export async function downgradeTeamToFree(
  teamId: string,
  opts: { fromTrial: boolean; courseMirrors: CourseMirrorDisposition }
): Promise<void> {
  const db = admin.firestore()
  const update: Record<string, unknown> = {
    plan: 'free',
    plan_status: 'active',
    suspended_at: FieldValue.delete(),
    purge_at: FieldValue.delete(),
    updated_at: FieldValue.serverTimestamp(),
  }
  if (opts.fromTrial) update.downgraded_from_trial_at = FieldValue.serverTimestamp()
  await db.collection(TEAMS_COLLECTION).doc(teamId).update(update)

  const installs = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    .where('status', '==', 'active')
    .get()

  const activePluginIds = installs.docs.map((d) => d.id)
  const keepCourseMirrors = opts.courseMirrors === 'keep_for_buyers'

  for (const d of installs.docs) {
    const deactivation: Record<string, unknown> = {
      status: 'inactive',
      updated_at: FieldValue.serverTimestamp(),
    }
    // TWO EXECUTORS, ONE DECISION. Deactivating the install fires
    // `onInstalledPluginStatusChange`, whose `online-courses` arm deletes every
    // mirror — so sparing them here alone is undone by a trigger moments later.
    // The disposition therefore rides ON the deactivating write: same document,
    // same write, so the trigger reads the instruction and the transition it
    // belongs to atomically, and no second lookup can race it.
    //
    // It cannot go stale: this function is the ONLY writer of
    // `status: 'inactive'` on a team install (every other end-of-install path —
    // the plugins page, `deactivatePluginAddon`, the webhook's add-on reconcile
    // — DELETES the document, which carries no marker and so tears down), and
    // this write always states the field. `orgTierRails.test.ts` re-derives both
    // halves of that from the tree.
    if (d.id === 'online-courses') deactivation[KEEP_COURSE_MIRRORS_FIELD] = keepCourseMirrors
    await d.ref.set(deactivation, { merge: true })
  }

  // Tear down plugin-specific public artefacts that would otherwise remain
  // visible after a downgrade (the plugin-status trigger only fires on
  // installed_plugins writes; it runs in parallel with this path so we also
  // tear down here to guarantee the artefacts are removed synchronously).
  const teardowns: Promise<void>[] = []
  if (activePluginIds.includes('website')) {
    teardowns.push(unpublishSiteForTeam(teamId))
  }
  if (activePluginIds.includes('online-courses') && !keepCourseMirrors) {
    teardowns.push(deleteAllCoursePublicProfiles(teamId))
  }
  await Promise.all(teardowns)
}
