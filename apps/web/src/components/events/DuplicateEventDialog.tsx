'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toISODate } from '@linyup/shared'
import { useResetOnOpen } from '@/hooks/useResetOnOpen'
import type { Event } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

// Duplicating copies the event's SETUP — settings, categories, the whole
// program — and never its participants. The server callable owns that
// contract (see packages/functions/src/events/duplicateEvent.ts); this dialog
// only collects the new title and start date.

function isoDateOf(ts: { toDate(): Date } | undefined | null): string {
  const d = ts?.toDate?.()
  if (!d || Number.isNaN(d.getTime())) return toISODate(new Date())
  return toISODate(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())))
}

export interface DuplicateEventDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  event: Event
  /** Called with the new event id once the copy exists. */
  onDuplicated: (newEventId: string) => void
}

export function DuplicateEventDialog({
  open, onOpenChange, event, onDuplicated,
}: DuplicateEventDialogProps) {
  const t = useTranslations('EventProgram')
  const [title, setTitle] = useState('')
  const [startDate, setStartDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useResetOnOpen(open, () => {
    setTitle(t('duplicateSuffix', { title: event.title }))
    setStartDate(isoDateOf(event.start))
    setError(null)
    setBusy(false)
  })

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const call = callFunction<
        { eventId: string; newStart?: string; title?: string },
        { eventId: string }
      >('duplicateEvent')
      const res = await call({
        eventId: event.id,
        newStart: startDate || undefined,
        title: title.trim() || undefined,
      })
      onOpenChange(false)
      onDuplicated(res.data.eventId)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('duplicateFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('duplicateTitle')}</DialogTitle>
          <DialogDescription>{t('duplicateDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dup-title">{t('duplicateNewTitle')}</Label>
            <Input id="dup-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dup-start">{t('duplicateNewStart')}</Label>
            <Input
              id="dup-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            {busy ? t('duplicating') : t('duplicateEvent')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
