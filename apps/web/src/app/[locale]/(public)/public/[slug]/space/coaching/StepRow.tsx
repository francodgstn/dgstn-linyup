'use client'

// One task/step row — under a goal, or in the virtual "General" bucket.
//
// THE CHECKBOX IS INTERACTIVE FOR A STEP THE MEMBER CREATED (any change), AND
// ALSO FOR A COACH-CREATED STEP — but only the one transition firestore.rules
// grant a member over a coach's task: `open` ⟷ `achieved`, changing only
// `status` + `completed_at`. That is the core coaching loop ("coach assigns
// homework, member ticks it off"), and it is why a step's ownership rule is
// narrower-but-more-permissive than a goal's: she can never rename or delete a
// coach's step, but she CAN mark it done. A coach-created step stuck in some
// other status (e.g. `abandoned`) falls outside that one allowed transition
// and stays non-interactive here — rare, and stated via the tooltip rather
// than silently doing nothing.
//
// Delete is unaffected by any of this: only a step the member created herself
// may be removed, coach-created or not.

import { useTranslations } from 'next-intl'
import { Check, Trash2 } from 'lucide-react'
import type { Goal } from '@linyup/shared'
import type { ConfirmOptions } from '@/components/ui/confirm-dialog'
import { useSpaceTheme } from '../useSpaceTheme'
import type { SpaceGoalsState } from './useSpaceGoals'
import { Tip } from '@/components/ui/tip'

interface Props {
  step: Goal
  setStepDone: SpaceGoalsState['setStepDone']
  deleteGoal: SpaceGoalsState['deleteGoal']
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

export function StepRow({ step, setStepDone, deleteGoal, confirm }: Props) {
  const t = useTranslations('SpaceCoaching')
  const tCommon = useTranslations('Common')
  const { accent, textMain, textMuted, cardBorder } = useSpaceTheme()

  const own = step.created_by === 'student'
  const done = step.status === 'achieved'
  // Mirrors the coach-task arm in firestore.rules exactly: open ⟷ achieved
  // only, and only when the step is ALREADY in one of those two states.
  const coachToggleable = step.created_by === 'coach' && (step.status === 'open' || step.status === 'achieved')
  const canToggle = own || coachToggleable
  const togglePending = setStepDone.isPending && setStepDone.variables?.goalId === step.id
  const toggleFailed = setStepDone.isError && setStepDone.variables?.goalId === step.id
  const deletePending = deleteGoal.isPending && deleteGoal.variables === step.id

  async function handleDelete() {
    const ok = await confirm({
      title: t('deleteStepConfirmTitle'),
      description: t('deleteStepConfirmBody', { title: step.title }),
      confirmLabel: tCommon('delete'),
    })
    if (ok) deleteGoal.mutate(step.id)
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Tip label={!canToggle ? t('stepCoachCreatedNote') : undefined}>
          <button
            type="button"
            disabled={!canToggle || togglePending}
            onClick={() => setStepDone.mutate({ goalId: step.id, done: !done })}
            aria-pressed={done}
            aria-label={!canToggle ? t('stepCoachCreatedNote') : undefined}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-60"
            style={{ borderColor: done ? accent : cardBorder, background: done ? accent : 'transparent' }}
          >
            {done && <Check className="h-3 w-3 text-white" />}
          </button>
        </Tip>
        <span
          className="flex-1 text-sm"
          style={{ color: done ? textMuted : textMain, textDecoration: done ? 'line-through' : undefined }}
        >
          {step.title}
        </span>
        {!own && (
          <span className="shrink-0 text-xs" style={{ color: textMuted }}>
            {t('goalCoachCreatedBadge')}
          </span>
        )}
        {own && (
          <Tip label={t('deleteGoal')}>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deletePending}
              aria-label={t('deleteGoal')}
              className="shrink-0 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" style={{ color: textMuted }} />
            </button>
          </Tip>
        )}
      </div>
      {toggleFailed && (
        <p className="ml-7 text-xs" style={{ color: '#dc2626' }}>
          {t('stepToggleFailed')}
        </p>
      )}
    </div>
  )
}
