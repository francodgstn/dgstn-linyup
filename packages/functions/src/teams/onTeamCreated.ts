// Provisions system defaults for every NEW team: the default MANUAL payment modes
// (Settings → Payments), the DEFAULT PLUGINS (@linyup/shared, pluginDefaults.ts)
// and the 'lib_trial_cleanup' automation rule (archive
// never-attended trial bookings after N days, shipped ACTIVE — lead hygiene most
// studios never think about; anyone can pause/edit it in the Automations UI). The
// rule literal lives in @linyup/shared (automationDefaults.ts) and is also offered
// in the web automation library for manual (re)install on existing teams.
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import {
  TRIAL_CLEANUP_RULE,
  TRIAL_CLEANUP_RULE_KEY,
  DEFAULT_PAYMENT_MODES,
  DEFAULT_TEAM_PLUGINS,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  clientInstallableFrom,
  planIsAtLeast,
} from '@linyup/shared'
import type { SaasPlan } from '@linyup/shared'

export const onTeamCreated = onDocumentCreated('teams/{teamId}', async (event) => {
  const snap = event.data
  if (!snap) return

  // Seed the default manual payment modes when the team doc doesn't already carry
  // them — covers seed scripts + any direct/Admin-SDK create (createTeamRecord
  // already sets them for web signups, so that path no-ops here). A .set(merge) on
  // an UPDATE never re-fires onDocumentCreated, so there's no loop.
  if (!Array.isArray(snap.data()?.payment_modes)) {
    await snap.ref.set({ payment_modes: [...DEFAULT_PAYMENT_MODES] }, { merge: true })
  }

  // ── DEFAULT PLUGINS ────────────────────────────────────────────────────────
  //
  // BEFORE the automation-rule block below, which returns early when the rule
  // already exists — behind it, a retry that found the rule present would never
  // reach the plugins.
  //
  // `.create()`, never `.set()`: on an event retry an existing document must be
  // left alone, and if the owner has already removed the plugin in between, a
  // `set` would resurrect it. ALREADY_EXISTS (gRPC 6) IS the idempotency, so it
  // is the one error swallowed here.
  //
  // GATED ON THE PLAN the team was actually created with. A new studio starts on
  // a Studio trial so this passes today, but seeds and Admin-SDK creates make
  // any plan reachable, and an install document is honored by
  // `useInstalledPlugins` with no plan check of its own — so a Free team would
  // simply be handed a paid-tier feature.
  const plan = (snap.data()?.plan as SaasPlan | undefined) ?? 'free'
  for (const pluginId of DEFAULT_TEAM_PLUGINS) {
    if (!planIsAtLeast(plan, clientInstallableFrom(pluginId))) continue
    try {
      await snap.ref
        .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
        .doc(pluginId)
        .create({
          pluginId,
          teamId: event.params.teamId,
          status: 'active',
          config: {},
          installedAt: FieldValue.serverTimestamp(),
          installedBy: 'system',
        })
    } catch (err) {
      if ((err as { code?: number })?.code !== 6) throw err
    }
  }

  // Fixed doc id (= the system_key) so this converges with a seed writing the same
  // rule: whichever runs first wins, the other is a harmless no-op — never a
  // duplicate, regardless of order. Idempotent on event retries too.
  const ref = snap.ref.collection('automation_rules').doc(TRIAL_CLEANUP_RULE_KEY)
  if ((await ref.get()).exists) return

  await ref.set({
    name: TRIAL_CLEANUP_RULE.name,
    system_key: TRIAL_CLEANUP_RULE.system_key,
    // Default-ON (unlike manual library installs, which are review-first inactive).
    active: true,
    trigger: TRIAL_CLEANUP_RULE.trigger,
    conditions: TRIAL_CLEANUP_RULE.conditions,
    actions: TRIAL_CLEANUP_RULE.actions,
    created_at: FieldValue.serverTimestamp(),
  })
  console.log(`[onTeamCreated] installed default '${TRIAL_CLEANUP_RULE_KEY}' rule for team ${event.params.teamId}`) // eslint-disable-line no-console
})
