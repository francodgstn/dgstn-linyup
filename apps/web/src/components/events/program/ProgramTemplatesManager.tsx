'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Building2, LayoutTemplate, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { Route } from 'next'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ProgramTemplate } from '@linyup/shared'
import {
  useCreateProgramTemplate,
  useDeleteProgramTemplate,
  useProgramTemplates,
} from './useProgramTemplates'

// The template LIST: create, open, delete.
//
// ── IT USED TO BE LIST / RENAME / DELETE ONLY ───────────────────────────────
// Templates were authored one way — build a programme on a real event, then
// "Save as template" — and this page said so in its empty state. That is still
// the right route for saving a programme you have just built; it was the wrong
// one for AUTHORING, because a studio writing its standard camp agenda before
// any camp exists had to invent an event, build on it, save, and delete the
// event again (Franco, 2026-08-31).
//
// So "New template" mints an empty one and opens `ProgramTemplateEditor` on it,
// and the rename dialog is gone: the editor holds the name and the description
// beside the programme they belong to, which is one screen instead of two doing
// half the job each.

export interface ProgramTemplatesManagerProps {
  /** Which collection this page manages. */
  scope: 'team' | 'org'
  ownerId: string | null
  /** For the team page: also list inherited org templates, read-only. */
  inheritedOrgId?: string | null
  canEdit?: boolean
  /** Where a template opens — `${basePath}/${templateId}`. The team and org
   *  pages mount the same editor under their own route. */
  basePath: string
}

export function ProgramTemplatesManager({
  scope, ownerId, inheritedOrgId, canEdit = true, basePath,
}: ProgramTemplatesManagerProps) {
  const t = useTranslations('EventProgram')
  const router = useRouter()

  const listQ = useProgramTemplates(
    scope === 'team' ? ownerId : null,
    scope === 'org' ? ownerId : (inheritedOrgId ?? null),
  )
  const create = useCreateProgramTemplate(scope, ownerId)
  const remove = useDeleteProgramTemplate(scope, ownerId)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<ProgramTemplate | null>(null)

  const templates = listQ.data ?? []
  /** Inherited org templates are read-only on the team page. */
  const isOwned = (tpl: ProgramTemplate) => tpl.scope === scope

  const open = (tpl: ProgramTemplate) => router.push(`${basePath}/${tpl.id}` as Route)

  async function createTemplate() {
    const id = await create.mutateAsync({ name: name.trim(), description: description.trim() })
    setCreating(false)
    setName('')
    setDescription('')
    // Straight into the editor: an empty template is not a result, it is the
    // start of one, and a studio that lands back on a list with a new blank row
    // has to work out that clicking it is the next step.
    router.push(`${basePath}/${id}` as Route)
  }

  const newButton = canEdit ? (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus className="mr-1.5 h-4 w-4" />
      {t('templateCreateNew')}
    </Button>
  ) : null

  // Only the NAME is asked for up front — everything else is authored in the
  // editor this leads to. A create dialog that collects the whole programme
  // would be the editor, twice.
  const createDialog = (
    <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('templateCreateNew')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-new-name">{t('templateName')}</Label>
            <Input
              id="tpl-new-name"
              value={name}
              placeholder={t('templateNamePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-new-desc">{t('templateDescription')}</Label>
            <Input
              id="tpl-new-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreating(false)}>{t('cancel')}</Button>
          <Button disabled={!name.trim() || create.isPending} onClick={createTemplate}>
            {create.isPending ? t('saving') : t('templateCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  if (listQ.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <>
        <div className="rounded-xl border bg-card px-6 py-14 text-center">
          <LayoutTemplate className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="mt-3 text-sm font-medium">{t('templatesEmpty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('templatesEmptyHint')}</p>
          {canEdit && <div className="mt-4 flex justify-center">{newButton}</div>}
        </div>
        {createDialog}
      </>
    )
  }

  return (
    <>
      <div className="mb-3 flex justify-end">{newButton}</div>
      <div className="space-y-2">
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            className={`flex items-start gap-3 rounded-lg border bg-card p-3 ${
              isOwned(tpl) ? 'transition-colors hover:bg-muted/40' : ''
            }`}
          >
            <LayoutTemplate className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            {/* Only an OWNED template opens. An inherited one lives in the
                organisation's collection, which this page's editor route does
                not address — offering a click that 404s is worse than not
                offering it. The row still says what is in it (days, items) and
                the apply dialog on an event shows the rest. */}
            <button
              type="button"
              className="min-w-0 flex-1 text-left disabled:cursor-default"
              disabled={!isOwned(tpl)}
              onClick={() => open(tpl)}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{tpl.name}</span>
                {!isOwned(tpl) && (
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
                {!isOwned(tpl) && ` · ${t('templateInherited')}`}
              </p>
            </button>

            {canEdit && isOwned(tpl) && (
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon" variant="ghost"
                  aria-label={t('templateOpen')}
                  onClick={() => open(tpl)}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
                <Button
                  size="icon" variant="ghost"
                  aria-label={t('templateDelete')}
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(tpl)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {createDialog}

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('templateDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('templateDeleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!confirmDelete) return
                await remove.mutateAsync(confirmDelete.id)
                setConfirmDelete(null)
              }}
            >
              {t('templateDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
