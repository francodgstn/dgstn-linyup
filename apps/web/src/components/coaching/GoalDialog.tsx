'use client'

// Create or edit a goal, or create a step ("task" — the word is kept
// deliberately), on the coach's tab AND in the member Space. ONE dialog: what
// differs between the surfaces is what each lets the person SET, and that is a
// capability the caller declares in `fields`, not a second form:
//
//   the admin — description and both dates on either kind, plus a parent
//               picker on a step (a coach plans ahead, and reparents);
//   the Space — description, categories and a target date on a goal; a step
//               is a title only ("boolean homework", not a smaller goal), and
//               a member never reparents or backdates.
//
// Categories are offered on a GOAL whenever the studio has any — both
// surfaces agree, so that is not a capability. Copy comes from the caller
// (different namespaces). Dates go through the app's DatePicker on both
// surfaces, so there is no string round-trip to get a timezone wrong in —
// the Space's old copy did exactly that (docs/scalability-2026-09.md §1).

import { useEffect, useState } from 'react'
import type { Goal, GoalType, PerformanceIndicator } from '@linyup/shared'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface GoalDialogValues {
  title: string
  /** Trimmed; `''` when left empty or when the field is not offered. */
  description: string
  /** Empty for a step. */
  categories: string[]
  targetDate: Date | null
  startDate: Date | null
  /** Steps only; null = General (no parent). */
  parentGoalId: string | null
}

/** What THIS surface lets the person set — see the module header. Title is
 *  always asked; categories whenever the kind is a goal and the studio has any. */
export interface GoalDialogFields {
  description?: boolean
  startDate?: boolean
  targetDate?: boolean
  /** Steps only: the goals a step can attach to. Absent/empty hides the picker. */
  parentOptions?: { id: string; title: string }[]
}

export interface GoalDialogLabels {
  dialogTitle: string
  title: string
  description?: string
  categories: string
  parentGoal?: string
  parentGoalNone?: string
  startDate?: string
  noStartDate?: string
  targetDate?: string
  noTargetDate?: string
  cancel: string
  save: string
  saving: string
  saveFailed: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  type: GoalType
  categories: PerformanceIndicator[]
  /** Present when editing; absent when creating. */
  initial?: Goal | null
  /** Steps only, new step: pre-filled when opened from a goal card's own "add
   *  step" button; unset (General) when opened from the General section. */
  defaultParentGoalId?: string | null
  fields: GoalDialogFields
  onSubmit: (values: GoalDialogValues) => Promise<void>
  labels: GoalDialogLabels
}

// Sentinel for the Select's "no parent" option — Radix Select rejects an
// empty-string item value, and `undefined`/`null` aren't valid values either.
const NO_PARENT = '__none__'

function tsToDate(ts: { toDate(): Date } | null | undefined): Date | null {
  return ts ? ts.toDate() : null
}

export function GoalDialog({ open, onOpenChange, type, categories, initial, defaultParentGoalId, fields, onSubmit, labels }: Props) {
  const isGoal = type === 'goal'
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  // `categories` (the prop) is the OPTIONS list; `selected` is what this goal
  // carries. Two different things, named apart on purpose.
  const [selected, setSelected] = useState<string[]>([])
  const [targetDate, setTargetDate] = useState<Date | null>(null)
  const [startDate, setStartDate] = useState<Date | null>(null)
  const [parentGoalId, setParentGoalId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle(initial?.title ?? '')
    setDescription(initial?.description ?? '')
    setSelected(initial?.categories ?? [])
    setTargetDate(tsToDate(initial?.target_date))
    setStartDate(tsToDate(initial?.start_date))
    setParentGoalId(initial ? (initial.parent_goal_id ?? null) : (defaultParentGoalId ?? null))
    setErrorMsg('')
  }, [open, initial, defaultParentGoalId])

  const toggleCategory = (key: string) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    setErrorMsg('')
    try {
      await onSubmit({
        title: title.trim(),
        description: fields.description ? description.trim() : '',
        categories: isGoal ? selected : [],
        targetDate: fields.targetDate ? targetDate : null,
        startDate: fields.startDate ? startDate : null,
        parentGoalId: isGoal ? null : parentGoalId,
      })
    } catch {
      setErrorMsg(labels.saveFailed)
    } finally {
      setSubmitting(false)
    }
  }

  const showParent = !isGoal && !!fields.parentOptions?.length
  const showDates = !!fields.startDate || !!fields.targetDate
  const yearFrom = new Date().getFullYear() - 1
  const yearTo = new Date().getFullYear() + 5

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{labels.dialogTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{labels.title}</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
            </div>

            {fields.description && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{labels.description}</label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </div>
            )}

            {isGoal && categories.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{labels.categories}</p>
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((cat) => (
                    <button
                      key={cat.key}
                      type="button"
                      onClick={() => toggleCategory(cat.key)}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                        selected.includes(cat.key)
                          ? 'border-transparent bg-primary text-primary-foreground'
                          : 'border-border text-muted-foreground hover:border-foreground'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {showParent && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{labels.parentGoal}</label>
                <Select
                  value={parentGoalId ?? NO_PARENT}
                  onValueChange={(v) => setParentGoalId(v === NO_PARENT ? null : v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PARENT}>{labels.parentGoalNone}</SelectItem>
                    {fields.parentOptions!.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Start beside target: two halves of the same question, and the
                start is the one a coach fills in when planning ahead. */}
            {showDates && (
              <div className={`grid gap-3 ${fields.startDate && fields.targetDate ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {fields.startDate && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{labels.startDate}</label>
                    <DatePicker
                      value={startDate ?? undefined}
                      onChange={(d) => setStartDate(d ?? null)}
                      placeholder={labels.noStartDate}
                      fromYear={yearFrom}
                      toYear={yearTo}
                    />
                  </div>
                )}
                {fields.targetDate && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{labels.targetDate}</label>
                    <DatePicker
                      value={targetDate ?? undefined}
                      onChange={(d) => setTargetDate(d ?? null)}
                      placeholder={labels.noTargetDate}
                      fromYear={yearFrom}
                      toYear={yearTo}
                    />
                  </div>
                )}
              </div>
            )}

            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? labels.saving : labels.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
