'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Building2, LayoutTemplate, Sparkles } from 'lucide-react'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  MAX_PROGRAM_ITEMS, STARTER_PROGRAM_TEMPLATES, materialiseTemplate, toISODate,
} from '@linyup/shared'
import type {
  Event, EventProgramConfig, MaterialisedItem, ProgramTemplateBody,
} from '@linyup/shared'
import { useProgramTemplates } from './useProgramTemplates'
import { useResetOnOpen } from '@/hooks/useResetOnOpen'

// Applying a template REPLACES the programme rather than merging into it —
// merging two multi-track schedules has no sane automatic answer, so the
// destructive-but-predictable behaviour is the honest one. Confirmed whenever
// there is something to lose.
//
// The list mixes the studio's saved templates with the built-in STARTER library
// (badged "Starter"), so an event can start from a ready-made programme without
// anyone having authored one first. Both flow through `materialiseTemplate`.

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2, 11)}`

/** A selectable row — a saved template or a starter — reduced to what the picker
 *  renders plus the body `materialiseTemplate` consumes. */
interface PickEntry {
  key: string
  name: string
  description?: string
  days: number
  items: number
  badge: 'org' | 'starter' | null
  body: ProgramTemplateBody
}

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

  const entries = useMemo<PickEntry[]>(() => {
    const saved: PickEntry[] = (templatesQ.data ?? []).map((tpl) => ({
      key: `saved:${tpl.id}`,
      name: tpl.name,
      description: tpl.description,
      days: tpl.days?.length ?? 0,
      items: tpl.itemCount ?? tpl.items?.length ?? 0,
      badge: tpl.scope === 'org' ? 'org' : null,
      body: {
        days: tpl.days ?? [],
        tracks: tpl.tracks ?? [],
        items: tpl.items ?? [],
        timezoneLabel: tpl.timezoneLabel,
        note: tpl.note,
      },
    }))
    const starters: PickEntry[] = STARTER_PROGRAM_TEMPLATES.map((s) => ({
      key: `starter:${s.id}`,
      name: s.name,
      description: s.description,
      days: s.days.length,
      items: s.items.length,
      badge: 'starter',
      body: { days: s.days, tracks: s.tracks, items: s.items, timezoneLabel: s.timezoneLabel, note: s.note },
    }))
    return [...saved, ...starters]
  }, [templatesQ.data])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [startDate, setStartDate] = useState('')
  const [error, setError] = useState<string | null>(null)

  useResetOnOpen(open, () => {
    setSelectedKey(null)
    setError(null)
    setStartDate(isoDateOf(event.start) ?? toISODate(new Date()))
  })

  const selected = entries.find((e) => e.key === selectedKey) ?? null

  async function apply() {
    if (!selected || !startDate) return
    setError(null)
    const { config, items } = materialiseTemplate(selected.body, startDate, newId)
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

          {!templatesQ.isLoading && entries.length > 0 && (
            <div className="space-y-2">
              {entries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setSelectedKey(entry.key)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                    entry.key === selectedKey ? 'border-primary bg-primary/5' : 'hover:bg-muted',
                  )}
                >
                  <LayoutTemplate className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{entry.name}</span>
                      {entry.badge === 'org' && (
                        <Badge variant="outline" className="gap-1 text-xs">
                          <Building2 className="h-3 w-3" />
                          {t('templateFromOrg')}
                        </Badge>
                      )}
                      {entry.badge === 'starter' && (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Sparkles className="h-3 w-3" />
                          {t('starterBadge')}
                        </Badge>
                      )}
                    </div>
                    {entry.description && (
                      <p className="text-xs text-muted-foreground">{entry.description}</p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('templateSummary', { days: entry.days, items: entry.items })}
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
