import type { PluginManifest } from '@linyup/shared'

/**
 * AI INSIGHTS — the first GENERIC plugin container.
 *
 * It is built exactly like HMD's bundle (`PLUGIN_BUNDLES` in @linyup/shared,
 * materialized by `reconcileBundle`): a studio installs ONE card and switches its
 * modules on and off in the Configure dialog, and every module is an ordinary
 * plugin with its own manifest, its own install document and its own server
 * gate. What each module stores and why the cost is bounded the way it is lives
 * in `packages/shared/src/types/aiInsights.ts`.
 *
 *  - `ai-contact-summary` — the coach's briefing on a contact.
 *  - `ai-member-recap`    — email the member-facing part of that briefing.
 *  - `ai-team-sentiment`  — a team-wide reading on the dashboard, five a day.
 *  - `ai-offer-drafting`  — "Draft with AI" on Offerings (owner only).
 *
 * ── BETA, AND SAYS SO ON THE CARD ────────────────────────────────────────────
 * The contact summary was an experiment until 2026-09-16, and offer drafting
 * until 2026-09-17. They moved here when
 * three AI surfaces became things a studio chooses between, which is what a
 * container's module switches express and an experiment's single switch did
 * not. The model's output is still what is being tuned, so the card carries the
 * beta badge — the marketplace keeps it visible once installed, because the
 * caveat outlives the decision to install.
 *
 * ── NOT THE ASSISTANT ────────────────────────────────────────────────────────
 * `ai-assistant` (the in-app copilot) stays standalone: it is LOCKED, and a
 * locked plugin cannot be a member — `unlockPlugin` writes one document and
 * never reconciles, and `pluginIsInstallable` would hide its card besides.
 */
export const aiManifest: PluginManifest = {
  id: 'ai',
  nameKey: 'aiName',
  descriptionKey: 'aiDescription',
  category: 'data',
  // Every module spends model calls; Studio is where AI features sit.
  minPlan: 'studio',
  status: 'beta',
  iconName: 'BrainCircuit',
  // The module switches — one per member of PLUGIN_BUNDLES.ai.
  hasOwnerConfig: true,
  // NO `addon`, NO `locked`: both install paths write one document and never
  // reconcile (`plugins/bundles.test.ts` asserts it). No `navContributions`: a
  // container contributes nothing itself — its modules mount in place, on the
  // contact page and the dashboard.
}
