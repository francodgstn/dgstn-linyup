'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Building2, LayoutTemplate } from 'lucide-react'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { MAX_PROGRAM_ITEMS, materialiseTemplate, toISODate } from '@linyup/shared'
import type {
  Event, EventProgramConfig, MaterialisedItem, ProgramTemplate,
} from '@linyup/shared'
import { useProgramTemplates } from './useProgramTemplates'
import { useResetOnOpen } from '@/hooks/useResetOnOpen'

// Applying a template REPLACES the programme rather than merging into it —
// merging two multi-track schedules has no sane automatic answer, so the
// destructive-but-predictable behaviour is the honest one. Confirmed whenever
// there is something to lose.

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2, 11)}`

function isoDateOf(ts: { toDate(): Date } | undefined | null): string | null {
  if (!ts?.toDate) return null
  const d = ts.toDate()
  if (Number.isNaN(d.getTime())) return null
  return toISODate(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())))
}

export interface ApplyTemplateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  event: Event
  teamId: string | null
  orgId: string | null
  /** How many items the programme currently holds — drives the replace warning. */
  existingItemCount: number
  onApply: (config: EventProgramConfig, items: MaterialisedItem[]) => Promise<void> | void
  applying?: boolean
}

export function ApplyTemplateDialog({
  open, onOpenChange, event, teamId, orgId, existingItemCount, onApply, applying,
}: ApplyTemplateDialogProps) {
  const t = useTranslations('EventProgram')
  const templatesQ = useProgramTemplates(teamId, orgId)
  const templates = useMemo(() => templatesQ.data ?? [], [templatesQ.data])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [startDate, setStartDate] = useState('')
  const [error, setError] = useState<string | null>(null)

  useResetOnOpen(open, () => {
    setSelectedId(null)
    setError(null)
    setStartDate(isoDateOf(event.start) ?? toISODate(new Date()))
  })

  const selected = templates.find((tpl) => tpl.id === selectedId) ?? null

  async function apply() {
    if (!selected || !startDate) return
    setError(null)
    const { config, items } = materialiseTemplate(selected, startDate, newId)
    if (items.length > MAX_PROGRAM_ITEMS) {
      setError(t('itemCapReached', { max: MAX_PROGRAM_ITEMS }))
      return
    }
    await onApply(config, items)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('applyTemplate')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {templatesQ.isLoading && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          )}

          {!templatesQ.isLoading && templates.length === 0 && (
            <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              {t('noTemplates')}
            </p>
          )}

          {templates.length > 0 && (
            <div className="space-y-2">
              {templates.map((tpl: ProgramTemplate) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => setSelectedId(tpl.id)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                    tpl.id === selectedId ? 'border-primary bg-primary/5' : 'hover:bg-muted',
                  )}
                >
                  <LayoutTemplate className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{tpl.name}</span>
                      {tpl.scope === 'org' && (
                        <Badge variant="outline" className="gap-1 text-[0.625rem]">
                          <Building2 className="h-3 w-3" />
                          {t('templateFromOrg')}
                        </Badge>
                      )}
                    </div>
                    {tpl.description && (
                      <p className="text-xs text-muted-foreground">{tpl.description}</p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('templateSummary', {
                        days: tpl.days?.length ?? 0,
                        items: tpl.itemCount ?? tpl.items?.length ?? 0,
                      })}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="space-y-1.5">
              <Label htmlFor="apply-start">{t('applyStartDate')}</Label>
              <Input
                id="apply-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('applyStartDateHint')}</p>
            </div>
          )}

          {selected && existingItemCount > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>{t('applyReplaceWarning', { count: existingItemCount })}</span>
            </p>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={apply} disabled={!selected || !startDate || applying}>
            {applying ? t('saving') : t('applyTemplate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
