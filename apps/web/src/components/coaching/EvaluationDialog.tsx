'use client'

// Add — or, on the admin, edit — an evaluation of a goal: a 1–5 score, notes,
// and the status the goal moves to. ONE dialog for the coach's tab and the
// member Space; what differs between them is CAPABILITY, not the form:
//
//   `initial`      — the admin edits its own past evaluations; the Space only
//                    ever adds.
//   `canSetStatus` — the admin always; the Space only on the member's own
//                    goal, the only case its cascade write can succeed.
//                    Showing the control regardless and quietly dropping the
//                    write afterwards would be worse than never asking.
//
// The score starts UNSET (never a default 3): a stray double-click on Save
// used to write a permanent, dated rating indistinguishable from a deliberate
// neutral, so Save stays disabled until a star is touched (see RatingStars).
// Copy comes from the caller — the surfaces translate from different
// namespaces — so this owns the behaviour, not the words.

import { useEffect, useState } from 'react'
import { GOAL_STATUSES, type GoalEvaluation, type GoalStatus } from '@linyup/shared'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RatingStars } from './RatingStars'
import { GOAL_STATUS_CLASSES } from './goalStatusStyles'

export interface EvaluationDialogValues {
  score: number
  /** Trimmed; `''` when left empty. */
  notes: string
  /** The goal's own status when `canSetStatus` is off. */
  statusAfter: GoalStatus
}

export interface EvaluationDialogLabels {
  title: string
  score: string
  /** Shown under the stars while none is chosen. */
  scoreHint?: string
  notes: string
  notesPlaceholder?: string
  statusAfter: string
  status: (status: GoalStatus) => string
  cancel: string
  save: string
  saving: string
  saveFailed: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The goal's current status — where the status control starts. */
  goalStatus: GoalStatus
  /** Editing an existing evaluation: pre-fills the form. Pass a STABLE object
   *  (state, not an inline literal) — the form resets whenever it changes. */
  initial?: Pick<GoalEvaluation, 'score' | 'notes' | 'status_after'> | null
  canSetStatus: boolean
  onSubmit: (values: EvaluationDialogValues) => Promise<void>
  labels: EvaluationDialogLabels
}

export function EvaluationDialog({ open, onOpenChange, goalStatus, initial, canSetStatus, onSubmit, labels }: Props) {
  const [score, setScore] = useState(initial?.score ?? 0)
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [statusAfter, setStatusAfter] = useState<GoalStatus>(initial?.status_after ?? goalStatus)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // Reset on every open, from whatever `initial` is now — one instance serves
  // an add and, on the admin, the edits that follow it.
  useEffect(() => {
    if (!open) return
    setScore(initial?.score ?? 0)
    setNotes(initial?.notes ?? '')
    setStatusAfter(initial?.status_after ?? goalStatus)
    setErrorMsg('')
  }, [open, initial, goalStatus])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (score === 0) return
    setSubmitting(true)
    setErrorMsg('')
    try {
      await onSubmit({
        score,
        notes: notes.trim(),
        statusAfter: canSetStatus ? statusAfter : goalStatus,
      })
    } catch {
      setErrorMsg(labels.saveFailed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{labels.score}</label>
              <RatingStars value={score} onChange={setScore} size={28} />
              {score === 0 && labels.scoreHint && (
                <p className="text-xs text-muted-foreground">{labels.scoreHint}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">{labels.notes}</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder={labels.notesPlaceholder}
              />
            </div>

            {canSetStatus && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{labels.statusAfter}</label>
                <div className="flex flex-wrap gap-2">
                  {GOAL_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatusAfter(s)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        statusAfter === s
                          ? `${GOAL_STATUS_CLASSES[s]} border-transparent`
                          : 'border-border text-muted-foreground hover:border-foreground'
                      }`}
                    >
                      {labels.status(s)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={submitting || score === 0}>
              {submitting ? labels.saving : labels.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
