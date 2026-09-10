// Tailwind light/dark class pairs per goal status, for the app-token surfaces:
// the admin's status pill and the status picker inside the shared
// EvaluationDialog. Derived BY FAMILY — blue / orange / green / gray — from
// `GOAL_STATUS_COLORS` in @linyup/shared, the one hex map the member app and
// every inline style read. A single hex cannot also carry a dark-mode text
// contrast, so the classes stay literal here (Tailwind's JIT needs them in
// source); change the two together.

import type { GoalStatus } from '@linyup/shared'

export const GOAL_STATUS_CLASSES: Record<GoalStatus, string> = {
  open: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  in_progress: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  achieved: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  abandoned: 'bg-muted text-muted-foreground',
}
