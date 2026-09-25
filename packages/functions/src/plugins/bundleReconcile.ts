// THE ONE WRITER of a bundle member's install document.
//
// A plugin CONTAINER's install document holds its desired module set in
// `config.modules`; this makes that true by creating and deleting ordinary
// member install documents. Everything downstream — the sidebar, event types,
// automation contributions, `assertPluginInstalled`, the teardown switch and
// `firestore.rules` — then works on a member with no knowledge that bundles
// exist, because a member IS an ordinary plugin.
//
// ── IDEMPOTENT, AND SELF-LIMITING ────────────────────────────────────────────
// It computes the desired set, diffs it against what is there, and COMMITS
// NOTHING when the diff is empty. That empty-diff early return is not an
// optimization: this function's own writes land in the very collection its
// triggers watch, so without it the first install would loop forever. The
// `isBundleContainer` guard at the top is the other half — it stops a member
// write (which this function just made) from re-entering.
//
// ── IT DELETES; IT NEVER DEACTIVATES ─────────────────────────────────────────
// `status: 'inactive'` on an install document means one specific thing — a plan
// lapse — and `orgs/orgTierRails.test.ts` sweeps every file that writes it,
// allowing only `saas-billing/downgrade.ts` and `orgs/lifecycle.ts`. So removal
// here is a delete. That is the right behavior anyway: a deleted document
// carries no stale `keep_course_mirrors` marker into a later reinstall.
//
// ── WHY IT IS NOT PART OF onInstalledPluginStatusChange ──────────────────────
// That trigger carries a non-idempotent activation hook (the finance ledger
// rebuild) and must stay `retry: false`. This one is a pure function of current
// state and wants `retry: true`, because a retry can only converge.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  TEAMS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  ORG_INSTALLED_PLUGINS_SUBCOLLECTION,
  INSTALLED_BY_BUNDLE_FIELD,
  isBundleContainer,
  bundleMembers,
  enabledBundleModules,
} from '@linyup/shared'

/** Which tenant's installs to reconcile. The two paths differ only in where the
 *  `installed_plugins` subcollection hangs. */
export type BundleScope =
  | { kind: 'team'; teamId: string }
  | { kind: 'org'; orgId: string }

function installsRef(scope: BundleScope) {
  const db = admin.firestore()
  return scope.kind === 'team'
    ? db.collection(TEAMS_COLLECTION).doc(scope.teamId).collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    : db
        .collection(ORGANIZATIONS_COLLECTION)
        .doc(scope.orgId)
        .collection(ORG_INSTALLED_PLUGINS_SUBCOLLECTION)
}

function scopeLabel(scope: BundleScope): string {
  return scope.kind === 'team' ? `team ${scope.teamId}` : `org ${scope.orgId}`
}

/**
 * Make the member install documents of `containerId` match its desired module
 * set. Safe to call for any plugin id — it returns immediately for one that is
 * not a container.
 */
export async function reconcileBundle(scope: BundleScope, containerId: string): Promise<void> {
  // LOOP BREAKER #1. Every member document this function writes re-fires the
  // trigger; a member is not a container, so the re-entry stops here.
  if (!isBundleContainer(containerId)) return

  const col = installsRef(scope)
  const containerSnap = await col.doc(containerId).get()

  // A container that is absent, or not active, desires nothing — so a removal
  // and a plan-lapse deactivation both tear the members down through the same
  // single path.
  const desired = new Set(
    containerSnap.exists && containerSnap.data()?.status === 'active'
      ? enabledBundleModules(containerId, containerSnap.data()?.config as Record<string, unknown>)
      : [],
  )

  const memberIds = bundleMembers(containerId)
  if (memberIds.length === 0) return
  // Bounded by construction: `bundleMembers` reads a code constant, never data.
  const memberSnaps = await admin.firestore().getAll(...memberIds.map((id) => col.doc(id)))

  const batch = admin.firestore().batch()
  let ops = 0
  const created: string[] = []
  const removed: string[] = []

  memberSnaps.forEach((snap, i) => {
    const memberId = memberIds[i]
    const wanted = desired.has(memberId)
    const exists = snap.exists
    const ownedByThisBundle = snap.data()?.[INSTALLED_BY_BUNDLE_FIELD] === containerId

    if (wanted && !exists) {
      batch.set(col.doc(memberId), {
        pluginId: memberId,
        ...(scope.kind === 'team' ? { teamId: scope.teamId } : { orgId: scope.orgId }),
        installedAt: FieldValue.serverTimestamp(),
        // Attributed to whoever installed the container — the person who
        // actually made this choice.
        installedBy: (containerSnap.data()?.installedBy as string | undefined) ?? 'bundle',
        status: 'active',
        config: {},
        [INSTALLED_BY_BUNDLE_FIELD]: containerId,
      })
      ops += 1
      created.push(memberId)
      return
    }

    if (!wanted && exists && ownedByThisBundle) {
      batch.delete(col.doc(memberId))
      ops += 1
      removed.push(memberId)
      return
    }

    // LEFT ALONE, deliberately: an existing member document WITHOUT this
    // container's stamp is a standalone install that predates the container (or
    // was made directly). It is not this function's to remove, and deleting it
    // would take away a feature the tenant chose for itself — along with its
    // config.
  })

  // LOOP BREAKER #2. Without this, a commit with zero changes still re-fires the
  // trigger this function is running inside.
  if (ops === 0) return

  await batch.commit()
  console.log(
    `[bundles] ${scopeLabel(scope)}: ${containerId} reconciled ` +
      `(+${created.length} ${created.join(',') || '-'} / -${removed.length} ${removed.join(',') || '-'})`,
  )
}
