'use client'

// The three facts about a goal worth reading WITHOUT expanding its card — the
// latest score, when it was last rated, whether it is overdue — and the rule
// that it says nothing when there is nothing to say. One component for the
// admin's coaching tab and the member Space; the Space's copy described itself
// as "the admin's twin", which is the sentence that precedes drift.
//
// The WORDS come from the caller: the two surfaces translate from different
// namespaces (`Contacts`, `SpaceCoaching`) and format dates differently
// (ledger item 13 in docs/scalability-2026-09.md), so this owns the facts and
// the layout, not the copy. Colour follows GoalProgressBar's split: no
// `mutedColor` → app tokens; `mutedColor` → inline, for a tenant-themed card,
// where the overdue chip goes inline too because a `dark:` variant would
// follow the visitor's OS rather than the studio's theme.

import { AlertTriangle } from 'lucide-react'
import { goalIsOverdue, type Goal } from '@linyup/shared'
import { RatingStars } from './RatingStars'

export interface GoalStateChipLabels {
  /** "Last rated {date}" — the caller formats the date. */
  lastEvaluated: (date: Date) => string
  overdue: string
  /** A numeric restatement beside the stars ("Latest: 4/5"); omitted → stars only. */
  latestScore?: (score: number) => string
}

interface Props {
  goal: Goal
  labels: GoalStateChipLabels
  /** The host surface's muted colour on a tenant-themed card; absent → app tokens. */
  mutedColor?: string
  className?: string
}

const OVERDUE_INLINE = { background: '#fee2e2', color: '#b91c1c' }

export function GoalStateChips({ goal, labels, mutedColor, className }: Props) {
  const overdue = goalIsOverdue(goal)
  if (goal.latest_score == null && !goal.last_evaluated_at && !overdue) return null
  const mutedStyle = mutedColor ? { color: mutedColor } : undefined
  const mutedClass = mutedColor ? '' : 'text-muted-foreground'
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      {goal.latest_score != null && (
        <span className="inline-flex items-center gap-1.5">
          <RatingStars value={goal.latest_score} readOnly size={14} emptyColor={mutedColor} />
          {labels.latestScore && (
            <span className={`text-xs ${mutedClass}`} style={mutedStyle}>
              {labels.latestScore(goal.latest_score)}
            </span>
          )}
        </span>
      )}
      {goal.last_evaluated_at && (
        <span className={`text-xs ${mutedClass}`} style={mutedStyle}>
          {labels.lastEvaluated(goal.last_evaluated_at.toDate())}
        </span>
      )}
      {overdue && (
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
            mutedColor ? '' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
          }`}
          style={mutedColor ? OVERDUE_INLINE : undefined}
        >
          <AlertTriangle className="h-3 w-3" />
          {labels.overdue}
        </span>
      )}
    </div>
  )
}
