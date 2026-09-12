import type { EngagementBand } from '@linyup/shared'

// The colour of each engagement band, shared by the badge on the page and the
// meter on the insights card so the two never disagree about what "at risk"
// looks like. The band itself comes from `computeEngagementBand` in shared.
export const ENGAGEMENT_BAR: Record<EngagementBand, string> = {
  active: 'bg-emerald-500',
  low: 'bg-amber-500',
  at_risk: 'bg-red-500',
  inactive: 'bg-muted-foreground/40',
}

export const ENGAGEMENT_TEXT: Record<EngagementBand, string> = {
  active: 'text-emerald-600 dark:text-emerald-400',
  low: 'text-amber-600 dark:text-amber-500',
  at_risk: 'text-red-600 dark:text-red-400',
  inactive: 'text-muted-foreground',
}
