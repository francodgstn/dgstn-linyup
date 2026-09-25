'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { MAX_PROGRAM_TEMPLATES, extractTemplate, sortedDays } from '@linyup/shared'
import type { EventProgramConfig, EventProgramItem } from '@linyup/shared'
import { useResetOnOpen } from '@/hooks/useResetOnOpen'
import {
  useProgramTemplates,
  useSaveProgramTemplate,
  type SaveTemplateInput,
} from './useProgramTemplates'

// Templates are edited by apply → adjust on a real event → save back, which is
// why this dialog offers "overwrite an existing one" alongside "save as new".
// A standalone template editor would roughly double the UI for little gain.
//
// Saving always writes to the OWNER passed in (a team, or an org when an org
// admin is working on an org event). A club that applied an org template and
// saves it back therefore produces its own team template — never a write to the
// organization's copy, which the rules refuse anyway.

const NEW = '__new__'

export interface SaveAsTemplateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: EventProgramConfig
  items: EventProgramItem[]
  /** Where the template is saved. */
  scope: 'team' | 'org'
  ownerId: string | null
  defaultName?: string
}

export function SaveAsTemplateDialog({
  open, onOpenChange, config, items, scope, ownerId, defaultName,
}: SaveAsTemplateDialogProps) {
  const t = useTranslations('EventProgram')
  // Only same-scope templates are overwritable: a team cannot overwrite an org's.
  const existingQ = useProgramTemplates(
    scope === 'team' ? ownerId : null,
    scope === 'org' ? ownerId : null,
  )
  const existing = (existingQ.data ?? []).filter((tpl) => tpl.scope === scope)
  const save = useSaveProgramTemplate(scope, ownerId)

  const [target, setTarget] = useState<string>(NEW)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  useResetOnOpen(open, () => {
    setTarget(NEW)
    setName(defaultName ?? '')
    setDescription('')
    setError(null)
  })

  // Overwriting pre-fills from the chosen template so the name is not lost.
  useEffect(() => {
    if (target === NEW) return
    const tpl = existing.find((e) => e.id === target)
    if (tpl) { setName(tpl.name); setDescription(tpl.description ?? '') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const atCap = target === NEW && existing.length >= MAX_PROGRAM_TEMPLATES

  async function submit() {
    setError(null)
    if (!name.trim()) { setError(t('errorTemplateNameRequired')); return }
    if (atCap) { setError(t('templateCapReached', { max: MAX_PROGRAM_TEMPLATES })); return }

    const body = extractTemplate(config, items)
    const input: SaveTemplateInput = {
      ...body,
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(target === NEW ? {} : { templateId: target }),
    }
    await save.mutateAsync(input)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('saveAsTemplate')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-target">{t('templateTarget')}</Label>
            <Select value={target} onValueChange={(v) => setTarget(v ?? NEW)}>
              <SelectTrigger id="tpl-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW}>{t('templateNew')}</SelectItem>
                {existing.map((tpl) => (
                  <SelectItem key={tpl.id} value={tpl.id}>
                    {t('templateOverwrite', { name: tpl.name })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">{t('templateName')}</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('templateNamePlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tpl-desc">{t('templateDescription')}</Label>
            <Input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <p className="text-xs text-muted-foreground">
            {t('templateSummary', { days: sortedDays(config).length, items: items.length })}
            {scope === 'org' && ` · ${t('templateSavedToOrg')}`}
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
