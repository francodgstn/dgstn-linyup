'use client'

// One goal, with its steps nested underneath (see `groupGoalsWithSteps` in
// GoalsSection). Edit/delete and the status control inside the evaluation
// dialog are all gated on `goal.created_by === 'student'` — a coach-created
// GOAL is read-only here, matching what firestore.rules actually enforces
// (see the module note in useSpaceGoals.ts). A STEP is different — see
// StepRow, which lets a member tick a coach-created one done too.
//
// PARITY WITH THE ADMIN CARD (contacts/[id]/GoalsTab.tsx's `GoalCard`) — read
// its header and `GoalProgressBar`'s first, the design reasoning is not
// restated here:
//
//   • COLLAPSE is a second, independent fold from `expanded` (which opens the
//     evaluations history below). Collapsing hides the categories/provenance/
//     date chips, the score+last-evaluated+overdue chips, the step list and
//     the evaluations panel — but NOT the header or the status pill, and NOT
//     the step rail, because "what is this, what state is it in, how far
//     along" is exactly what a folded card still has to answer.
//   • ARCHIVED GOALS ARE NEVER HANDED TO THIS COMPONENT. useSpaceGoals.ts
//     filters them out of the query result entirely (steps included) — a
//     member cannot archive, and a goal her coach filed away is gone from her
//     view too, not merely dimmed. The `goalIsArchived` check below is a
//     defensive SECOND guard (a stale cache, a future caller), not the
//     primary one; there is deliberately no "Archived" badge to build,
//     because the primary answer is "she never sees it", a stronger version
//     of "must not clutter the list" than the admin's opacity treatment.
//   • ORDERING: the admin's tab owns a `StepSortMode` toggle the member has no
//     equivalent control for. `GoalsSection` fixes it to `'manual'` (the
//     admin's own default) before steps ever reach this component — see the
//     comment there for why. This component never re-sorts `steps` itself,
//     matching `sortSteps`'s own contract of being applied ONCE, by whoever
//     owns the list.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, ChevronUp, Info, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { dimensionLabel, goalCategoryLabel, goalIsArchived } from '@linyup/shared'
import type { Goal, GoalStatus, PerformanceIndicator } from '@linyup/shared'
import type { ConfirmOptions } from '@/components/ui/confirm-dialog'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail } from '@/lib/publicQueryError'
import { useSpaceTheme } from '../useSpaceTheme'
import { StepRow } from './StepRow'
import { RatingStars } from '@/components/coaching/RatingStars'
import { GoalStateChips } from '@/components/coaching/GoalStateChips'
import { GoalProgressBar } from '@/components/coaching/GoalProgressBar'
import { GoalDialog } from '@/components/coaching/GoalDialog'
import { EvaluationDialog } from '@/components/coaching/EvaluationDialog'
import { useSpaceCoachingLabels } from './useSpaceCoachingLabels'
import { useAddGoalEvaluation, useGoalEvaluations } from './useSpaceGoals'
import type { SpaceGoalsState } from './useSpaceGoals'
import { Tip } from '@/components/ui/tip'
import { usePublicFormat } from '../../usePublicFormat'

const STATUS_KEYS: Record<GoalStatus, string> = {
  open: 'statusOpen',
  in_progress: 'statusInProgress',
  achieved: 'statusAchieved',
  abandoned: 'statusAbandoned',
}

interface Props {
  goal: Goal
  /** Already ordered by the caller (`GoalsSection`) — see this file's header
   *  for why the fixed order lives there and not here. */
  steps: Goal[]
  /** What a goal is ABOUT — labels the category chips and fills the picker. */
  categories: PerformanceIndicator[]
  /** Check-in axes — used ONLY to label the `from_dimension` provenance chip. */
  dimensions: PerformanceIndicator[]
  createGoal: SpaceGoalsState['createGoal']
  updateGoal: SpaceGoalsState['updateGoal']
  deleteGoal: SpaceGoalsState['deleteGoal']
  setStepDone: SpaceGoalsState['setStepDone']
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

export function GoalCard({ goal, steps, categories, dimensions, createGoal, updateGoal, deleteGoal, setStepDone, confirm }: Props) {
  const t = useTranslations('SpaceCoaching')
  const tCommon = useTranslations('Common')
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const labels = useSpaceCoachingLabels()

  const [expanded, setExpanded] = useState(false)
  // NOT `expanded` above, which opens the evaluations history. This folds the
  // card's own body away so a long goal list stays readable; the header, its
  // status pill and the step rail stay visible — see the module header.
  const [collapsed, setCollapsed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [addingStep, setAddingStep] = useState(false)
  const [evaluating, setEvaluating] = useState(false)

  const own = goal.created_by === 'student'
  const canEvaluate = goal.status === 'open' || goal.status === 'in_progress'
  const deleteFailed = deleteGoal.isError && deleteGoal.variables === goal.id
  const doneSteps = steps.filter((s) => s.status === 'achieved').length

  const evaluationsQuery = useGoalEvaluations(goal.id, expanded)
  const addEvaluation = useAddGoalEvaluation()

  async function handleDelete() {
    const ok = await confirm({
      title: t('deleteGoalConfirmTitle'),
      description: t('deleteGoalConfirmBody', { title: goal.title }),
      confirmLabel: tCommon('delete'),
    })
    if (ok) deleteGoal.mutate(goal.id)
  }

  // Defensive second guard — see the module header. The primary guard is
  // useSpaceGoals.ts never returning an archived goal in the first place.
  // AFTER every hook call, deliberately: an early return may never sit
  // between two hooks, or their call order would differ across renders the
  // instant a goal's `archived_at` flips while this instance stays mounted.
  if (goalIsArchived(goal)) return null

  return (
    <div className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" style={{ color: textMain }}>
            {goal.title}
          </p>
          {goal.description && (
            <p className="mt-0.5 text-xs" style={{ color: textMuted }}>
              {goal.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tip label={collapsed ? t('expandGoal') : t('collapseGoal')}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? t('expandGoal') : t('collapseGoal')}
            >
              {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" style={{ color: textMuted }} />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" style={{ color: textMuted }} />
              )}
            </button>
          </Tip>
          {own ? (
            <>
              <Tip label={t('editGoal')}>
                <button type="button" onClick={() => setEditing(true)} aria-label={t('editGoal')}>
                  <Pencil className="h-3.5 w-3.5" style={{ color: textMuted }} />
                </button>
              </Tip>
              <Tip label={t('deleteGoal')}>
                <button type="button" onClick={handleDelete} disabled={deleteGoal.isPending} aria-label={t('deleteGoal')}>
                  <Trash2 className="h-3.5 w-3.5" style={{ color: textMuted }} />
                </button>
              </Tip>
            </>
          ) : (
            <span title={t('goalCoachCreatedNote')} className="shrink-0">
              <Info className="h-3.5 w-3.5" style={{ color: accent }} />
            </span>
          )}
        </div>
      </div>

      {deleteFailed && (
        <p className="mt-1 text-xs" style={{ color: '#dc2626' }}>
          {t('goalDeleteFailed')}
        </p>
      )}

      {/* Status — stays visible collapsed, together with the rail below: it
          is the other half of "what state is this goal in". */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${accent}1f`, color: accent }}>
          {t(STATUS_KEYS[goal.status])}
        </span>
      </div>

      {/* What the goal is about + when it runs — folded away with the card. */}
      {!collapsed && ((goal.categories?.length ?? 0) > 0 || goal.from_dimension || goal.start_date || goal.target_date) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {(goal.categories ?? []).map((cat) => (
            <span key={cat} className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: cardBorder, color: textMuted }}>
              {goalCategoryLabel(cat, categories)}
            </span>
          ))}
          {/* Provenance, not a category — the axis this goal was created
              FROM. Drawn deliberately quieter than the category chips
              (outline, no fill) so the two never read as one list. */}
          {goal.from_dimension && (
            <span
              className="rounded-full border border-dashed px-2 py-0.5 text-[10px]"
              style={{ borderColor: cardBorder, color: textMuted }}
            >
              {t('goalFromDimension', { dimension: dimensionLabel(goal.from_dimension, dimensions) })}
            </span>
          )}
          {goal.start_date && (
            <span className="text-[10px]" style={{ color: textMuted }}>
              {t('startDateLabel', { date: fmt.date(goal.start_date) })}
            </span>
          )}
          {goal.target_date && (
            <span className="text-[10px]" style={{ color: textMuted }}>
              {t('targetDateLabel', { date: fmt.date(goal.target_date) })}
            </span>
          )}
        </div>
      )}

      {/* Latest score / last evaluated / overdue — folded away with the card. */}
      {!collapsed && <GoalStateChips goal={goal} labels={labels.goalStateChips} mutedColor={textMuted} className="mt-2" />}

      {/* THE RAIL STAYS WHEN COLLAPSED — see GoalProgressBar and this file's
          header for why. */}
      {steps.length > 0 && (
        <div className="mt-2">
          <GoalProgressBar
            steps={steps}
            label={t('tasksCompletedLabel', { done: doneSteps, total: steps.length })}
            palette={{ accent, muted: textMuted, halo: cardBg, track: cardBorder }}
          />
        </div>
      )}

      {!collapsed && (
        <>
          {steps.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t pt-2" style={{ borderColor: cardBorder }}>
              {steps.map((step) => (
                <StepRow key={step.id} step={step} setStepDone={setStepDone} deleteGoal={deleteGoal} confirm={confirm} />
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setAddingStep(true)}
              className="inline-flex items-center gap-1 text-xs font-medium"
              style={{ color: accent }}
            >
              <Plus className="h-3.5 w-3.5" /> {t('addStep')}
            </button>
            {canEvaluate && (
              <button
                type="button"
                onClick={() => setEvaluating(true)}
                className="inline-flex items-center gap-1 text-xs font-medium"
                style={{ color: accent }}
              >
                <Star className="h-3.5 w-3.5" /> {t('addEvaluation')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="ml-auto inline-flex items-center gap-1 text-xs"
              style={{ color: textMuted }}
            >
              {t('evaluationsTitle')}
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>
        </>
      )}

      {expanded && !collapsed && (
        <div className="mt-2 space-y-1.5 border-t pt-2" style={{ borderColor: cardBorder }}>
          {evaluationsQuery.isLoading ? (
            <div className="flex justify-center py-2">
              <div
                className="h-4 w-4 rounded-full border-2 border-t-transparent animate-spin"
                style={{ borderColor: accent, borderTopColor: 'transparent' }}
              />
            </div>
          ) : evaluationsQuery.isError ? (
            <QueryErrorState
              onRetry={() => void evaluationsQuery.refetch()}
              title={t('evaluationsLoadFailed')}
              detail={loadFailureDetail(evaluationsQuery.error)}
              theme={{ textMain, textMuted, accent, border: cardBorder }}
            />
          ) : (evaluationsQuery.data ?? []).length === 0 ? (
            <p className="text-xs" style={{ color: textMuted }}>
              {t('evaluationsEmpty')}
            </p>
          ) : (
            (evaluationsQuery.data ?? []).map((ev) => (
              <div key={ev.id} className="flex items-start justify-between gap-2 text-xs">
                <div className="flex min-w-0 items-center gap-1.5">
                  <RatingStars value={ev.score} readOnly size={12} emptyColor={textMuted} />
                  {ev.notes && (
                    <span className="truncate" style={{ color: textMuted }}>
                      {ev.notes}
                    </span>
                  )}
                </div>
                <span className="shrink-0" style={{ color: textMuted }}>
                  {fmt.date(ev.evaluated_at)} ·{' '}
                  {ev.evaluated_by === 'coach' ? t('evaluatedByCoach') : t('evaluatedBySelf')}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      <GoalDialog
        open={editing}
        onOpenChange={setEditing}
        type="goal"
        categories={categories}
        initial={goal}
        fields={{ description: true, targetDate: true }}
        onSubmit={async (v) => {
          await updateGoal.mutateAsync({ goalId: goal.id, title: v.title, description: v.description || null, categories: v.categories, targetDate: v.targetDate })
          setEditing(false)
        }}
        labels={labels.goalDialog(t('goalFormTitleEdit'))}
      />
      <GoalDialog
        open={addingStep}
        onOpenChange={setAddingStep}
        type="task"
        categories={categories}
        fields={{}}
        onSubmit={async (v) => {
          await createGoal.mutateAsync({ type: 'task', parentGoalId: goal.id, title: v.title })
          setAddingStep(false)
        }}
        labels={labels.goalDialog(t('goalFormTitleCreateStep'))}
      />
      {/* The status control is offered only on the member's OWN goal — the
          only case the cascade write can succeed (useSpaceGoals). */}
      <EvaluationDialog
        open={evaluating}
        onOpenChange={setEvaluating}
        goalStatus={goal.status}
        canSetStatus={own}
        onSubmit={async ({ score, notes, statusAfter }) => {
          await addEvaluation.mutateAsync({ goal, score, notes: notes || null, statusAfter: own ? statusAfter : undefined })
          setEvaluating(false)
        }}
        labels={labels.evaluationDialog}
      />
    </div>
  )
}
