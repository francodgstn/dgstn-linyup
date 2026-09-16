import type { PluginManifest } from '@linyup/shared'

/**
 * TEAM SENTIMENT — a module of the `ai` container.
 *
 * A card on the dashboard: one reading of the whole team — a mood, the overall
 * picture, what is working, what to watch and where to focus — made from the
 * contact summaries the studio has already generated. Five runs per team per day
 * (`TEAM_SENTIMENT_DAILY_LIMIT`), because one run reads every recent summary at
 * once. Owners and managers only.
 * Surface: `components/dashboard/TeamSentimentCard.tsx`. Server:
 * `generateTeamSentiment` (`functions/src/aiInsights/teamSentiment.ts`).
 */
export const aiTeamSentimentManifest: PluginManifest = {
  id: 'ai-team-sentiment',
  nameKey: 'aiTeamSentimentName',
  descriptionKey: 'aiTeamSentimentDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'beta',
  iconName: 'HeartPulse',
  hasOwnerConfig: false,
}
