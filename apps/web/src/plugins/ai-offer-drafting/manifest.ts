import type { PluginManifest } from '@linyup/shared'

/**
 * OFFER DRAFTING — a module of the `ai` container.
 *
 * "Draft with AI" in the Create menu on Offerings: describe the studio, review
 * the activities and plans the model proposes, then create them in one batch.
 * Surface: `manage/offer/page.tsx` + `components/offer/AiDraftDialog.tsx`.
 * Server: `draftOfferings` / `applyOfferingDraft`
 * (`functions/src/offer/draftOfferings.ts`), which check this install and the
 * OWNER role — the install is owner-written, so nobody drafts priced records
 * from a switch they cannot reach.
 *
 * It was the `offer-drafting` experiment until 2026-09-17.
 */
export const aiOfferDraftingManifest: PluginManifest = {
  id: 'ai-offer-drafting',
  nameKey: 'aiOfferDraftingName',
  descriptionKey: 'aiOfferDraftingDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'beta',
  iconName: 'ListPlus',
  hasOwnerConfig: false,
}
