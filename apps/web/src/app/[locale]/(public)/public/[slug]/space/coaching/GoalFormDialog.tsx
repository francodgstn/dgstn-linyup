'use client'

// Create/edit a goal, or create a step. One dialog because the fields overlap
// almost entirely; `kind` trims the form down for a step (title only — a step
// is deliberately "boolean homework", not a smaller goal). Editing a step is
// not offered anywhere in the UI (see StepRow — a step has no edit control),
// so `initialGoal` only ever arrives with `kind: 'goal'` in practice; the code
// does not assume that, it just never needs a distinct "edit step" title.
//
// This dialog is NEVER shown for a coach-created goal — GoalCard only renders
// its edit trigger when `goal.created_by === 'student'` — so there is no
// "read-only" mode to build here.

import { toDateInputValue } from '@/lib/format'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Goal, PerformanceIndicator } from '@linyup/shared'

export interface GoalFormValues {
  title: string
  description?: string | null
  categories?: string[]
  targetDate?: Date | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: 'goal' | 'task'
  /** Category options — only rendered for `kind: 'goal'`. Resolved once at the
   *  page level via `resolveGoalCategories`; see CoachingHome. NOT the check-in
   *  axes: what a goal is about and how someone is doing are two questions. */
  categories: PerformanceIndicator[]
  /** Present when editing; absent when creating. */
  initialGoal?: Goal | null
  onSubmit: (values: GoalFormValues) => Promise<void>
}

// `categories` (the prop) is the OPTIONS list; `selected` below is what this
// goal carries. Two different things, named apart on purpose.
export function GoalFormDialog({ open, onOpenChange, kind, categories, initialGoal, onSubmit }: Props) {
  const t = useTranslations('SpaceCoaching')
  const tSpace = useTranslations('Space')
  const tCommon = useTranslations('Common')
  const isEditing = !!initialGoal

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [targetDate, setTargetDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle(initialGoal?.title ?? '')
    setDescription(initialGoal?.description ?? '')
    setSelected(initialGoal?.categories ?? [])
    // The app's local-calendar formatter, not a UTC slice: the copy that used to
    // live here serialised through toISOString(), so a CET deadline of the 15th
    // rendered as the 14th on reopen and the save path then wrote the 14th back
    // — one day earlier per edit, and goalIsOverdue ran off the drifted date.
    setTargetDate(toDateInputValue(initialGoal?.target_date?.toDate() ?? null))
    setErrorMsg('')
  }, [open, initialGoal])

  function toggleCategory(key: string) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    setErrorMsg('')
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || null,
        ...(kind === 'goal' ? { categories: selected } : {}),
        targetDate: kind === 'goal' && targetDate ? new Date(`${targetDate}T00:00:00`) : null,
      })
    } catch {
      setErrorMsg(t('goalSaveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const titleKey = isEditing ? 'goalFormTitleEdit' : kind === 'goal' ? 'goalFormTitleCreate' : 'goalFormTitleCreateStep'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('fieldTitle')}</label>
              <input
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {kind === 'goal' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('fieldDescription')}</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('fieldCategories')}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {categories.map((d) => (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() => toggleCategory(d.key)}
                        className={`rounded-full border px-3 py-1 text-xs font-medium ${
                          selected.includes(d.key)
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-input text-muted-foreground'
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('fieldTargetDate')}</label>
                  <input
                    type="date"
                    value={targetDate}
                    onChange={(e) => setTargetDate(e.target.value)}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </>
            )}

            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? tSpace('saving') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
