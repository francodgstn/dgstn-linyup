import type { PluginManifest } from '@linyup/shared'

/**
 * CONTACT BRIEFING — a module of the `ai` container.
 *
 * The AI summary at the top of a contact's insights card: status, outlook and
 * one thing for the next session, written only when somebody presses Generate.
 * Surface: `contacts/[id]/InsightsCard.tsx`. Server: `generateContactSummary`
 * (`functions/src/contacts/aiSummary.ts`), which checks this install too.
 * Docs: `docs/contact-summary.md`.
 *
 * It was the `contact-summary` experiment until 2026-09-16.
 */
export const aiContactSummaryManifest: PluginManifest = {
  id: 'ai-contact-summary',
  nameKey: 'aiContactSummaryName',
  descriptionKey: 'aiContactSummaryDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'beta',
  iconName: 'ScrollText',
  hasOwnerConfig: false,
}
