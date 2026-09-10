// Thin re-export of @linyup/shared's coaching contract (goal categories vs
// check-in dimensions — two vocabularies answering two different questions;
// see the module header of packages/shared/src/types/goal.ts). This app adds
// no mobile-only helpers here; kept as a stable import path for the profile
// components that were written against it.
export {
  CANONICAL_DIMENSION_KEYS,
  DEFAULT_COACHING_DIMENSIONS,
  DEFAULT_GOAL_CATEGORIES,
  detectPerformanceProfile,
  dimensionLabel,
  goalCategoryLabel,
  groupGoalsWithSteps,
  sortSteps,
  GOAL_STATUSES,
  resolveCoachingDimensions,
  resolveGoalCategories,
} from '@linyup/shared';
export type { ProfileResult } from '@linyup/shared';
