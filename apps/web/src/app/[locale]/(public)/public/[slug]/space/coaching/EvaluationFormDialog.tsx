'use client'

// Add a self-evaluation on a goal — coach-created or the member's own; the
// rules permit an evaluation on either (see the module note in
// useSpaceGoals.ts's `useAddGoalEvaluation`). What differs by ownership is the
// STATUS control: it is offered only when `goal.created_by === 'student'`,
// because that is the only case the resulting cascade write can succeed.
// Showing it regardless and quietly dropping the write afterwards — which is
// what the mobile app currently does — would be worse than never asking.

import { GOAL_STATUSES } from '@linyup/shared'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Goal, GoalStatus } from '@linyup/shared'
import { RatingStars } from './RatingStars'

const STATUS_KEYS: Record<GoalStatus, string> = {
  open: 'statusOpen',
  in_progress: 'statusInProgress',
  achieved: 'statusAchieved',
  abandoned: 'statusAbandoned',
}

export interface EvaluationFormValues {
  score: number
  notes: string | null
  statusAfter?: GoalStatus
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  goal: Goal
  onSubmit: (values: EvaluationFormValues) => Promise<void>
}

export function EvaluationFormDialog({ open, onOpenChange, goal, onSubmit }: Props) {
  const t = useTranslations('SpaceCoaching')
  const tSpace = useTranslations('Space')
  const tCommon = useTranslations('Common')
  const own = goal.created_by === 'student'

  // Unset, deliberately (see RatingStars) — Submit stays disabled until the
  // member actually picks a star, so a stray click on this dialog can never
  // save a "neutral" score she never chose.
  const [score, setScore] = useState(0)
  const [notes, setNotes] = useState('')
  const [statusAfter, setStatusAfter] = useState<GoalStatus>(goal.status)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!open) return
    setScore(0)
    setNotes('')
    setStatusAfter(goal.status)
    setErrorMsg('')
  }, [open, goal.status])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (score === 0) return
    setSubmitting(true)
    setErrorMsg('')
    try {
      await onSubmit({
        score,
        notes: notes.trim() || null,
        statusAfter: own ? statusAfter : undefined,
      })
    } catch {
      setErrorMsg(t('evaluationSaveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('evaluationFormTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('evaluationScoreLabel')}</label>
              <RatingStars value={score} onChange={setScore} size={28} />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('evaluationNotesLabel')}</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder={t('evaluationNotesPlaceholder')}
                className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {own && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('evaluationStatusLabel')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {GOAL_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatusAfter(s)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${
                        statusAfter === s ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground'
                      }`}
                    >
                      {t(STATUS_KEYS[s])}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={submitting || score === 0}>
              {submitting ? tSpace('saving') : t('evaluationSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
