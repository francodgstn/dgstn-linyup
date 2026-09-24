'use client'

// ─── RUNNING A COURSE AGAIN, AND CALLING ONE OFF ────────────────────────────
//
// Two dialogs, side by side because they are the two things a studio does to a
// course that already exists, and because each one has exactly one thing it
// must say out loud that the server cannot say for it.
//
// DUPLICATE has to say that the SKIP DATES ARE GONE. The server drops them on
// purpose (a holiday is a fact about one year, and carrying 8 October into
// spring removes a lesson nobody notices until week seven), but a studio that
// is not told will not re-enter them, and the copy then runs on half-term.
//
// CANCEL has to say that NO MONEY MOVES. The callable returns the payments that
// may be owed back and refunds none of them, deliberately: whether money comes
// back, and in what shape, is the studio's policy. A dialog that let them
// believe otherwise would leave members waiting for a refund nobody had issued.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { meetingCount, type CourseBlock } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'
import { toDateInputValue } from '@/lib/format'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  teamId: string
  block: CourseBlock
  onClose: () => void
  /** Called with the new course's id, so the pane can open the copy. */
  onDuplicated?: (id: string) => void
}

// ─── duplicate ───────────────────────────────────────────────────────────────

export function CourseDuplicateDialog({ teamId, block, onClose, onDuplicated }: Props) {
  const t = useTranslations('CourseBlocks')
  const qc = useQueryClient()
  const first = block.meetings?.[0]
  const [startDate, setStartDate] = useState(
    first ? toDateInputValue(first.start.toDate()) : ''
  )
  const [name, setName] = useState(block.name)
  const [saving, setSaving] = useState(false)

  const skipped = block.pattern?.recurrence?.excludeDates?.length ?? 0

  async function run() {
    if (!startDate) return
    setSaving(true)
    try {
      const res = (await callFunction('duplicateCourseBlock')({
        teamId,
        blockId: block.id,
        newStartDate: startDate,
        name,
      })) as { data?: { id?: string } }
      await qc.invalidateQueries({ queryKey: ['course-blocks', teamId] })
      await qc.invalidateQueries({ queryKey: ['sessions'] })
      toast.success(t('duplicated'))
      const id = res?.data?.id
      if (id) onDuplicated?.(id)
      onClose()
    } catch (err) {
      console.error('[course duplicate] failed:', err)
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('duplicateTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="dup-name">{t('nameLabel')}</Label>
            <Input id="dup-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dup-start">{t('duplicateStartLabel')}</Label>
            <Input
              id="dup-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            {/* Every lesson moves by the same number of days, so the shape of the
                term is kept and only the studio's own skip dates are lost. */}
            <p className="text-xs text-muted-foreground">
              {t('duplicateShiftHint', { count: meetingCount(block) })}
            </p>
          </div>
          {skipped > 0 && (
            // The one thing the server cannot say for itself.
            <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t('duplicateSkipWarning', { count: skipped })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('duplicateDraftHint')}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={run} disabled={saving || !startDate}>
            {saving ? t('saving') : t('duplicateAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── cancel the whole course ─────────────────────────────────────────────────

interface RefundRow {
  contactId: string | null
  email: string | null
  paymentId: string
  refundableAmount: number
  currency: string
}

export function CourseCancelDialog({ teamId, block, onClose }: Props) {
  const t = useTranslations('CourseBlocks')
  const qc = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [refunds, setRefunds] = useState<RefundRow[] | null>(null)
  const enrolled = block.places_taken ?? 0

  async function run() {
    setSaving(true)
    try {
      const res = (await callFunction('cancelCourseBlock')({ teamId, blockId: block.id })) as {
        data?: { refunds?: RefundRow[]; notified?: number }
      }
      await qc.invalidateQueries({ queryKey: ['course-blocks', teamId] })
      await qc.invalidateQueries({ queryKey: ['sessions'] })
      toast.success(t('cancelled', { count: res?.data?.notified ?? 0 }))
      // The refund list is shown IN PLACE rather than in a toast: it is a list
      // of people owed money, and it must survive the studio looking away.
      setRefunds(res?.data?.refunds ?? [])
    } catch (err) {
      console.error('[course cancel] failed:', err)
      toast.error(err instanceof Error ? err.message : t('saveFailed'))
      setSaving(false)
    }
  }

  if (refunds) {
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('cancelDoneTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {refunds.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('cancelNoRefunds')}</p>
            ) : (
              <>
                <p className="text-sm">{t('cancelRefundsIntro', { count: refunds.length })}</p>
                <ul className="space-y-1 text-sm">
                  {refunds.map((r) => (
                    <li key={r.paymentId} className="flex justify-between gap-3">
                      <span className="truncate">{r.email ?? r.paymentId}</span>
                      <span className="tabular-nums">
                        {(r.refundableAmount / 100).toFixed(2)} {r.currency.toUpperCase()}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">{t('cancelRefundsHint')}</p>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>{t('closeButton')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cancelTitle', { name: block.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm">{t('cancelBody', { count: enrolled })}</p>
          {/* Said before the click, not after: a studio that expected refunds to
              go out automatically would leave members waiting on nothing. */}
          <p className="text-sm text-muted-foreground">{t('cancelNoMoney')}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancelKeep')}
          </Button>
          <Button variant="destructive" onClick={run} disabled={saving}>
            {saving ? t('saving') : t('cancelAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
