'use client'

// The self-rating form — one star row per team dimension (see
// `resolveCoachingDimensions` in CoachingHome). Every axis starts unset;
// Submit stays disabled until every one of them has been rated, for the same
// reason a single evaluation score starts unset (see the shared RatingStars/
// EvaluationDialog) — a pre-filled "3" across the board would let a stray
// click submit a check-in nobody actually rated, indistinguishable later from
// a deliberate neutral self-assessment.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { PerformanceIndicator } from '@linyup/shared'
import { RatingStars } from '@/components/coaching/RatingStars'

export interface CheckinFormValues {
  scores: Record<string, number>
  notes: string | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  dimensions: PerformanceIndicator[]
  onSubmit: (values: CheckinFormValues) => Promise<void>
}

export function CheckinFormDialog({ open, onOpenChange, dimensions, onSubmit }: Props) {
  const t = useTranslations('SpaceCoaching')
  const tSpace = useTranslations('Space')
  const tCommon = useTranslations('Common')

  const [scores, setScores] = useState<Record<string, number>>({})
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!open) return
    setScores({})
    setNotes('')
    setErrorMsg('')
  }, [open])

  const allRated = dimensions.length > 0 && dimensions.every((d) => (scores[d.key] ?? 0) > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!allRated) return
    setSubmitting(true)
    setErrorMsg('')
    try {
      await onSubmit({ scores, notes: notes.trim() || null })
    } catch {
      setErrorMsg(t('checkinSaveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('checkinFormTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('checkinFormIntro')}</p>

            {dimensions.map((d) => (
              <div key={d.key} className="space-y-1.5">
                <label className="text-sm font-medium">{d.label}</label>
                <RatingStars
                  value={scores[d.key] ?? 0}
                  onChange={(v) => setScores((prev) => ({ ...prev, [d.key]: v }))}
                  size={24}
                />
              </div>
            ))}

            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('checkinNotesLabel')}</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder={t('checkinNotesPlaceholder')}
                className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={submitting || !allRated}>
              {submitting ? tSpace('saving') : t('checkinSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
