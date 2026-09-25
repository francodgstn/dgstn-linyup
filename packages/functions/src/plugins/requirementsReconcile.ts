// THE ONE WRITER of a requirement install (`PLUGIN_REQUIREMENTS`).
//
// ── WHY A TRIGGER AND NOT THE INSTALL BUTTON ─────────────────────────────────
// There are FIVE writers of `installed_plugins/{pluginId}`: the marketplace's
// client `setDoc`, `activatePluginAddon`, `unlockPlugin`, `onTeamCreated`'s
// `DEFAULT_TEAM_PLUGINS`, and `bundleReconcile`. `finance` is a Coach ADD-ON,
// so on the tier where the asset register matters most it is installed
// server-side and never touches the client at all — a dependency implemented in
// the install button would be silently absent for exactly those tenants.
// Reconciling from the document itself covers all five by construction, and
// covers the org path the same way.
//
// Deliberately NOT part of `onInstalledPluginStatusChange`: that trigger
// carries a non-idempotent activation hook (the finance ledger rebuild) and
// must stay `retry: false`. This is a pure function of current state, so it
// wants `retry: true` — a retry can only converge. Same split, same reason, as
// `bundleReconcile`.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────
// Both directions of the relation, from whichever document changed:
//   • a REQUIRER was written  → materialize its missing requirements;
//   • a REQUIREMENT went away → put it back if a requirer is still active.
// The second arm is what makes the marketplace's blocked-remove more than a
// suggestion: the client explains why it refuses, and a client that bypasses
// the UI is simply converged back.
//
// A requirement is written as an ORDINARY standalone install: no provenance
// stamp, and deliberately not `installedByBundle` (`bundles.test.ts` allows one
// writer of that field, and a requirement is not a bundle member — it is
// independently discoverable, installable and keepable). The consequence is
// intended: removing the requirer never removes the requirement, because after
// the fact it is indistinguishable from one the tenant chose.
//
// ── LOOP BREAKERS ────────────────────────────────────────────────────────────
// Two, mirroring `bundleReconcile`, and neither is an optimization:
//   1. a document that is neither a requirer nor a requirement returns before
//      any read — most install writes are neither;
//   2. an empty diff returns before committing, so the write this function
//      makes cannot re-fire itself into a loop.

import * as admin from 'firebase-admin'
// FieldValue from the MODULAR path, as bundleReconcile does: the namespace
// import's `admin.firestore.FieldValue` is undefined inside the functions
// runtime, which fails at the write and takes the whole trigger down.
import { FieldValue } from 'firebase-admin/firestore'
import {
  INSTALLED_PLUGINS_SUBCOLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_INSTALLED_PLUGINS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  pluginRequirements,
  pluginsRequiring,
} from '@linyup/shared'

export type RequirementScope = { kind: 'team'; teamId: string } | { kind: 'org'; orgId: string }

function installsRef(scope: RequirementScope): admin.firestore.CollectionReference {
  const db = admin.firestore()
  return scope.kind === 'team'
    ? db.collection(TEAMS_COLLECTION).doc(scope.teamId).collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    : db
        .collection(ORGANIZATIONS_COLLECTION)
        .doc(scope.orgId)
        .collection(ORG_INSTALLED_PLUGINS_SUBCOLLECTION)
}

const isActive = (snap: admin.firestore.DocumentSnapshot): boolean =>
  snap.exists && snap.data()?.status === 'active'

export async function reconcileRequirements(
  scope: RequirementScope,
  pluginId: string
): Promise<void> {
  const asRequirer = pluginRequirements(pluginId)
  const asRequirement = pluginsRequiring(pluginId)

  // LOOP BREAKER 1 — nothing in the relation touches this plugin.
  if (asRequirer.length === 0 && asRequirement.length === 0) return

  const col = installsRef(scope)

  // Which requirer/requirement pairs could this write have disturbed? Reading
  // both sides keeps ONE code path for both directions.
  const requirers = asRequirer.length > 0 ? [pluginId] : asRequirement
  const requirerSnaps = await admin.firestore().getAll(...requirers.map((id) => col.doc(id)))

  const needed = new Set<string>()
  const installedByOf = new Map<string, string>()
  for (const snap of requirerSnaps) {
    if (!isActive(snap)) continue
    for (const req of pluginRequirements(snap.id)) {
      needed.add(req)
      if (!installedByOf.has(req)) {
        installedByOf.set(req, (snap.data()?.installedBy as string | undefined) ?? 'requirement')
      }
    }
  }
  if (needed.size === 0) return

  const wanted = [...needed]
  const existing = await admin.firestore().getAll(...wanted.map((id) => col.doc(id)))

  const batch = admin.firestore().batch()
  let ops = 0
  for (const snap of existing) {
    if (isActive(snap)) continue
    // `set` with merge:false so a doc left `inactive` by a plan lapse is
    // restored whole rather than keeping a stale status alongside a new one.
    batch.set(col.doc(snap.id), {
      pluginId: snap.id,
      ...(scope.kind === 'team' ? { teamId: scope.teamId } : { orgId: scope.orgId }),
      installedAt: FieldValue.serverTimestamp(),
      installedBy: installedByOf.get(snap.id) ?? 'requirement',
      status: 'active',
      config: {},
    })
    ops += 1
  }

  // LOOP BREAKER 2 — a no-op commit would re-fire the trigger this runs inside.
  if (ops === 0) return
  await batch.commit()
}
