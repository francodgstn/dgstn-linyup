import { FieldValue } from 'firebase-admin/firestore'
import type { MigrationConfig } from '../config'
import { sourceDb, targetDb } from '../config'
import { BatchWriter } from '../batch-writer'
import {
  CANONICAL_SUBSCRIPTION_TYPES,
  sourceTypeDuplicatesCanonical,
} from '../transforms/subscriptions'
import { transformTeamWeeklyReport } from '../transforms/team-weekly-reports'
import { transformAutomationRule } from '../transforms/automation-rules'
import { transformTeamInvitation } from '../transforms/team-invitations'
import { transformActivityLogEntry } from '../transforms/activity-log'
import { transformAlertPreset } from '../transforms/alert-presets'
import { transformLeaderboardDoc } from '../transforms/leaderboard'
import { memberCapsFor, type MemberRole } from '../../lib/roles'

const TEAM_SUBCOLLECTIONS = [
  'team_members',          // must come first — rules depend on this for read access
  'subscription_types',
  'subscription_transitions',
  'outreach_templates',
  'automation_rules',
  'team_invitations',
  'contact_requests',
  'team_alerts',
  'alert_presets',
  'leaderboard',
  'activity_log',
  'team_weekly_reports',
]

// `public_profile` is deliberately NOT in this list. Every field on it is a
// MIRROR that packages/functions/src/sync/syncTeamPublicProfile.ts derives
// from the team doc (already migrated + transformed by transforms/teams.ts)
// plus a few other already-migrated collections — nothing on it is source
// data unique to this subcollection. hmd-lineup's shape
// (hmd-lineup/functions/src/syncTeamPublicProfile/index.js) predates
// Linyup's public-surface model and is not merely missing new fields, it is
// QUERY-BREAKING: hmd-lineup stamps `doc_type: 'team'`, never `type`, and
// PublicTeamProvider.tsx:49-52 resolves every /public/{slug}/* route via
// `collectionGroup('public_profile').where('type', '==', 'team')` — so a raw
// copy makes the studio's ENTIRE public surface (bio-link, booking, signup,
// space, events, …) 404 with "Team not found" until the live trigger
// overwrites it. That trigger fires automatically on staging/prod (Cloud
// Functions are deployed, and pass02 already wrote the team doc earlier in
// this run) — merge-writing the correct shape regardless of whether this
// pass wrote anything first. It does NOT fire in the recommended local
// emulator workflow (`--only auth,firestore,storage`, no functions), which
// is precisely why writing hmd-lineup's shape there is worse than writing
// nothing: nothing leaves the SAME "team not found" state (the query is
// empty either way) without seeding a world-readable doc with a decade-old
// shape and dead fields (legalLinks, consentTexts, portalColors,
// aggregator_subscription_types, …) that would otherwise linger forever
// under a merge-only writer. See scripts/MIGRATE-HMD.md → "public_profile
// is not migrated" for the local-emulator workaround and the one field
// (`bookingSettings`) the trigger does NOT backfill either way.

// Per-subcollection transforms, applied before a doc is written to target.
// Pulled out of the write loop so the loop body stays a plain read-check-write.
function transformSubcollectionDoc(
  sub: string,
  teamId: string,
  docId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  // team_weekly_reports: remap to the new field contract (drop deprecated fields,
  // derive new affiliation/subscription counts, remap or omit HMD-specific keys).
  if (sub === 'team_weekly_reports') return transformTeamWeeklyReport(data)

  // team_members: denormalize the capability-model fields (capabilities/scope)
  // from the migrated role so the granular-role rules gate consistently.
  if (sub === 'team_members') {
    const role = ((data as { role?: string }).role ?? 'viewer') as MemberRole
    return {
      ...data,
      ...memberCapsFor(role),
      // AN OWNER IS A COACH. In HMD every club is run by the person who teaches
      // in it, so a migrated owner who is not on the coach roster cannot be
      // picked as a session's instructor or assigned to a contact — which is
      // most of what they do (Franco, 2026-09-05).
      //
      // Written EXPLICITLY rather than relying on the default. `is_coach` absent
      // means coach, so this would usually be unnecessary — but the source
      // document is spread in above, and whatever hmd-lineup happened to store
      // under that key comes with it. Stating it is the only way the outcome
      // does not depend on data this migration does not control.
      //
      // Owners only: a `viewer` or an office `manager` is deliberately left to
      // the default, which the studio can still turn off per member in
      // Settings → Team.
      ...(role === 'owner' ? { is_coach: true } : {}),
    }
  }

  // automation_rules: rename the one condition type confirmed to silently break
  // (see transforms/automation-rules.ts for why); loudly flag — never silently
  // drop — condition types that have no Linyup equivalent to map to.
  if (sub === 'automation_rules') {
    const { data: transformed, unmappedConditionTypes } = transformAutomationRule(data)
    if (unmappedConditionTypes.length > 0) {
      console.warn(
        `    ${teamId}: automation_rules/${docId} ('${(data as { name?: string }).name ?? '?'}') ` +
          `carries condition type(s) [${unmappedConditionTypes.join(', ')}] retired from Linyup — ` +
          `migrated as-is but will not fire (the engine fails CLOSED on an unrecognised condition). ` +
          `Review and rebuild it with today's condition types. See scripts/MIGRATE-HMD.md → "Automation rules".`,
      )
    }
    return transformed
  }

  // team_invitations: rename the three fields hmd-lineup wrote under different
  // names (sentAt/sentBy/expiresAt) to the ones every current reader expects
  // (created/invitedBy/expires_at) — see transforms/team-invitations.ts for the
  // concrete failure mode (list exclusion + an uncaught accept-flow error) each
  // rename closes.
  if (sub === 'team_invitations') return transformTeamInvitation(data)

  // activity_log: rename the one timestamp field hmd-lineup wrote under a
  // different name (date → created_at) — see transforms/activity-log.ts. Every
  // hmd-lineup writer uses `date`; the migrated feed is otherwise invisible
  // because Firestore's orderBy/where silently drop docs missing the field.
  if (sub === 'activity_log') return transformActivityLogEntry(data)

  // alert_presets: flatten the nested schedule object hmd-lineup wrote into the
  // two top-level fields Linyup reads — the same shape change pass05 already
  // applies to contact_alerts. See transforms/alert-presets.ts.
  if (sub === 'alert_presets') return transformAlertPreset(data)

  // leaderboard: rename the one per-entry field the mobile app's trial-name
  // anonymisation reads (type → acquisition_stage) — see
  // transforms/leaderboard.ts for why this is a direct consequence of the
  // doc's own write filter, not a guess.
  if (sub === 'leaderboard') return transformLeaderboardDoc(data)

  return data
}

// `waiver_policy` is deliberately NOT in this list, and not by omission —
// hmd-lineup has no waiver or documents concept at all (see
// firebasePaths.js), so there is no source doc to copy. A migrated team
// starting with no policy is the honest, safe state: the booking gate fails
// CLOSED on an absent policy, i.e. "no waiver required," never a silently
// skipped requirement. See scripts/MIGRATE-HMD.md → "Documents / Waivers".
// A studio that wants one authors it from /plugins/documents post-migration.

export async function pass11TeamSubcollections(
  cfg: MigrationConfig,
  teamIds: string[],
): Promise<void> {
  console.log('Pass 11: team subcollections (including managers) + org admin membership')
  const src = sourceDb()
  const tgt = targetDb()

  // Resolve org admin UID from target (users were already migrated in pass01).
  // The admin needs a manager team_members entry in every club they aren't already in.
  let adminUid: string | null = null
  const adminSnap = await tgt.collection('users')
    .where('email', '==', cfg.orgAdminEmail)
    .limit(1)
    .get()
  if (adminSnap.empty) {
    console.warn(`  WARN: could not find user with email ${cfg.orgAdminEmail} in target — org admin will not be injected as manager`)
  } else {
    adminUid = adminSnap.docs[0].id
    console.log(`  org admin: ${cfg.orgAdminEmail} → uid=${adminUid}`)
  }

  for (const teamId of teamIds) {
    if (cfg.fromTeam && teamId < cfg.fromTeam) continue
    const bw = new BatchWriter(tgt, cfg.dryRun)

    // Track whether the org admin already appeared in the source team_members.
    // If so, their doc is already handled in the loop below (written or skipped
    // because it existed in target) — we must not add a second set() to the same
    // batch ref.
    let adminHandledInSource = false

    for (const sub of TEAM_SUBCOLLECTIONS) {
      const snap = await src.collection('teams').doc(teamId).collection(sub).get()
      for (const d of snap.docs) {
        // A SOURCE PLAN THAT DUPLICATES A CANONICAL ONE IS NOT COPIED. Both
        // would land in the same list — the canonical one with prices and a
        // description, the source one with nothing but a name — and the studio
        // would be looking at two plans called "Unlimited". See
        // `sourceTypeDuplicatesCanonical` for the full reasoning and for which
        // of HMD's plans this drops.
        if (sub === 'subscription_types' &&
            sourceTypeDuplicatesCanonical((d.data() as { name?: string }).name)) {
          bw.skip()
          continue
        }

        const tgtRef = tgt.collection('teams').doc(teamId).collection(sub).doc(d.id)
        if (!cfg.dryRun) {
          const existing = await tgtRef.get()
          if (existing.exists && !cfg.overwrite) { bw.skip(); continue }
        }

        // Apply per-subcollection transforms before writing — see transformSubcollectionDoc.
        const data = transformSubcollectionDoc(sub, teamId, d.id, d.data() as Record<string, unknown>)
        bw.set(tgtRef, data)

        if (sub === 'team_members' && adminUid && d.id === adminUid) {
          adminHandledInSource = true
        }
      }
    }

    // Inject org admin as manager for clubs where they weren't already a member.
    if (adminUid && !adminHandledInSource) {
      const memberRef = tgt
        .collection('teams').doc(teamId)
        .collection('team_members').doc(adminUid)

      if (!cfg.dryRun) {
        const existing = await memberRef.get()
        if (existing.exists) {
          bw.skip()
          console.log(`    ${teamId}: org admin already in team_members (role=${existing.data()?.role ?? '?'}) — skipping`)
        } else {
          bw.set(memberRef, {
            userId:  adminUid,
            teamId,
            role:    'manager',
            ...memberCapsFor('manager'),
            joined:  FieldValue.serverTimestamp(),
            addedBy: 'migration',
          })
          console.log(`    ${teamId}: injected org admin as manager`)
        }
      } else {
        bw.set(memberRef, {
          userId:  adminUid,
          teamId,
          role:    'manager',
          ...memberCapsFor('manager'),
          joined:  FieldValue.serverTimestamp(),
          addedBy: 'migration',
        })
      }
    } else if (adminUid && adminHandledInSource) {
      console.log(`    ${teamId}: org admin found in source team_members — migrated as-is`)
    }

    // ── Seed canonical subscription types ────────────────────────────────────
    // Write the 5 HMD Basel canonical subscription types (Essential, Students,
    // Unlimited, Intro Offer, One-time Class) into every team's subscription_types
    // subcollection. These overwrite the canonical ids on each run (idempotent set),
    // so re-running pass11 is safe. Unknown/other existing types are left untouched.
    for (const stype of CANONICAL_SUBSCRIPTION_TYPES) {
      const stRef = tgt
        .collection('teams').doc(teamId)
        .collection('subscription_types').doc(stype.id)
      // Always overwrite canonical types — they are the ground truth for pricing.
      // (No skip-if-exists check: we want these to be authoritative each run.)
      bw.set(stRef, stype)
    }
    console.log(`    ${teamId}: seeded ${CANONICAL_SUBSCRIPTION_TYPES.length} canonical subscription types`)

    // ── Make the Products plugin available (but do NOT flip the shop live) ────
    // Migrated studios land on the studio plan, where the storefront is a core
    // surface, so install the Products plugin eagerly — it costs nothing and
    // saves the studio a settings trip once they have something to sell.
    //
    // `ActivePublicSurfaces.shop` is NOT "has this team installed the products
    // plugin" — per its doc comment (packages/shared/src/types/team.ts) it means
    // "can this studio actually be paid", and `syncTeamPublicProfile` computes it
    // from `payments_enabled` (a chargeable Stripe Connect account) alone (UX-33).
    // A fresh HMD migration never carries a Connect account, so hand-writing
    // `shop: true` here would both misreport a fact the flag doesn't track and
    // put a page of buy buttons in front of a real customer's visitors that the
    // callable refuses at checkout — the exact defect UX-33 exists to prevent
    // (see CLAUDE.md → "Seeded tenants show priced doors ONLY with a Stripe test
    // account"). Leave the flag alone: the sync trigger sets it correctly the
    // first time anything writes the team doc, and until then "not computed yet"
    // is the same safe-closed default every other surface starts from.
    const productsRef = tgt
      .collection('teams').doc(teamId)
      .collection('installed_plugins').doc('products')
    bw.set(productsRef, {
      pluginId: 'products',
      teamId,
      status: 'active',
      config: {},
      installedBy: 'migration',
      installedAt: FieldValue.serverTimestamp(),
    })
    console.log(`    ${teamId}: installed products plugin (shop surface stays gated on a chargeable Connect account)`)

    await bw.done()
  }
}
