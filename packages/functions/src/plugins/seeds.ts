// THE ONE WRITER OF SEEDED PLUGIN CONTENT.
//
// A plugin whose install carries data (`PLUGIN_SEEDS` in @linyup/shared) has it
// laid down here, on the same triggers that reconcile bundles and requirements.
// The four rules a seed obeys — fixed ids, a human's edit wins, uninstall leaves
// everything, and it never touches a tenant's own collections — are stated once,
// at that declaration. This module is what makes them true.
//
// ── WHY IT RIDES THE BUNDLE TRIGGERS AND NOT THE ACTIVATION HOOK ─────────────
// `onInstalledPluginStatusChange` is where per-plugin activation already lives
// (finance seeds a chart of accounts there), and it is the wrong home for this
// for two reasons. It is a TEAM-path trigger, and HMD's install — the only seed
// today — is org-level, so it would never fire. And it is deliberately
// `retry: false`, because it carries a non-idempotent rebuild; seeding is a pure
// function of current state with an empty-diff skip, so it wants `retry: true`
// and belongs beside the reconcilers that already have it.
//
// ── IT DOES NOT UNDO ITSELF ─────────────────────────────────────────────────
// There is no teardown arm and no `status !== 'active'` branch that deletes. A
// rule that has been grading people for a year is the organization's, and
// removing it would strand every grading recorded against it. An uninstall
// simply stops this from running; a re-install finds the documents again and
// converges on `seed_version`.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  ORGANIZATIONS_COLLECTION,
  RANK_PROGRESSIONS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  pluginSeeds,
  type PluginSeedBundle,
  type RankProgressionSeed,
} from '@linyup/shared'

export type SeedScope = { kind: 'team'; teamId: string } | { kind: 'org'; orgId: string }

function scopeRef(scope: SeedScope): FirebaseFirestore.DocumentReference {
  const db = admin.firestore()
  return scope.kind === 'org'
    ? db.collection(ORGANIZATIONS_COLLECTION).doc(scope.orgId)
    : db.collection(TEAMS_COLLECTION).doc(scope.teamId)
}

function scopeLabel(scope: SeedScope): string {
  return scope.kind === 'org' ? `org ${scope.orgId}` : `team ${scope.teamId}`
}

/**
 * Should this seed document be written?
 *
 * The two skips are different in kind and both matter:
 *
 *   • `updated_by` set — a HUMAN edited it. Never write again, at any version.
 *     A federation that tuned its own ladder must not have that reverted by a
 *     deploy, and merging is not an option: it would make "which rule applied to
 *     this grading" stop having one answer.
 *
 *   • stored `seed_version >= version` — already current. This is what makes an
 *     install, a re-install and a `retry: true` redelivery write exactly once.
 */
export function seedShouldWrite(
  existing: { seed_version?: number; updated_by?: string } | undefined,
  version: number
): boolean {
  if (!existing) return true
  if (existing.updated_by) return false
  return (existing.seed_version ?? 0) < version
}

async function applyRankProgressions(
  scope: SeedScope,
  pluginId: string,
  bundle: PluginSeedBundle,
  seeds: RankProgressionSeed[]
): Promise<number> {
  const parent = scopeRef(scope)
  let written = 0

  for (const seed of seeds) {
    // FIXED DOC ID — the system it governs. An auto-id here is what turns a
    // re-install into a duplicate ladder.
    const ref = parent.collection(RANK_PROGRESSIONS_SUBCOLLECTION).doc(seed.systemId)
    const snap = await ref.get()
    const existing = snap.data() as { seed_version?: number; updated_by?: string } | undefined

    if (!seedShouldWrite(existing, bundle.version)) {
      if (existing?.updated_by) {
        console.log(
          `[seeds] ${pluginId}: kept edited rank_progressions/${seed.systemId} on ${scopeLabel(scope)}`
        )
      }
      continue
    }

    // `set` without merge: the seed IS the document at this version. Merging
    // would leave a band from an earlier version standing beside its
    // replacement, and two bands can both contain a level — at which point
    // "the FIRST band containing the target wins" picks arbitrarily.
    await ref.set({
      ...seed.progression,
      id: seed.systemId,
      seed_plugin_id: pluginId,
      seed_version: bundle.version,
      seeded_at: FieldValue.serverTimestamp(),
    })
    written += 1
    console.log(
      `[seeds] ${pluginId}: wrote rank_progressions/${seed.systemId} v${bundle.version} on ${scopeLabel(scope)}`
    )
  }

  return written
}

/**
 * Apply `pluginId`'s seed content to `scope`, if it has any and is active.
 *
 * Safe to call on every install-document write: a plugin with no seeds returns
 * immediately, and one whose documents are already current writes nothing.
 */
export async function applyPluginSeeds(scope: SeedScope, pluginId: string): Promise<void> {
  const bundle = pluginSeeds(pluginId)
  if (!bundle) return

  // The install must be ACTIVE. A disabled install is not an uninstall — the
  // document stays and the tenant may re-enable it — but it is not a reason to
  // lay new content down either.
  const installRef = scopeRef(scope).collection('installed_plugins').doc(pluginId)
  const install = await installRef.get()
  if (!install.exists || install.data()?.status !== 'active') return

  try {
    if (bundle.rankProgressions?.length) {
      await applyRankProgressions(scope, pluginId, bundle, bundle.rankProgressions)
    }
  } catch (err) {
    // A failed seed must not fail the install. The plugin is installed and its
    // gates are open either way; the content is retried on the next write to
    // the install document, and `retry: true` on the trigger covers a transient
    // fault without one.
    console.error(`[seeds] ${pluginId}: seeding failed on ${scopeLabel(scope)}:`, err)
  }
}
