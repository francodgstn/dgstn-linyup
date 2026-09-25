'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarRange, Eye, LayoutTemplate, Pencil, Plus, Printer, Save, Settings2 } from 'lucide-react'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { MAX_PROGRAM_ITEMS, nextItemOrder, sortedDays } from '@linyup/shared'
import type { Event, EventProgramConfig, EventProgramItem } from '@linyup/shared'
import { ProgramTimeline } from './ProgramTimeline'
import { ProgramSheet } from './ProgramSheet'
import { ProgramItemDialog } from './ProgramItemDialog'
import { ProgramStructureDialog } from './ProgramStructureDialog'
import { ApplyTemplateDialog } from './ApplyTemplateDialog'
import { SaveAsTemplateDialog } from './SaveAsTemplateDialog'
import {
  programTenant,
  useCreateProgramItem,
  useDeleteProgramDay,
  useDeleteProgramItem,
  useDeleteProgramTrack,
  useProgramItems,
  useReplaceProgram,
  useSaveProgramConfig,
  useUpdateProgramItem,
  type ProgramItemDraft,
} from './useProgram'

// The Program tab. Deliberately TENANT-AGNOSTIC: everything it needs about the
// tenant comes off the Event document (teamId / orgId / scope), never from team
// context — that is what lets the same component serve both the team event page
// and the org event page without a second implementation.

const EMPTY_CONFIG: EventProgramConfig = { days: [], tracks: [] }

export interface ProgramTabProps {
  event: Event
  /** False for a read-only viewer — hides every editing affordance. */
  canEdit?: boolean
  /** The org this event's team belongs to, so inherited org templates appear in
   *  the picker. An org-scoped event derives it from the event itself. */
  parentOrgId?: string | null
  /** The staff printout of this program. Supplied by the page because the
   *  route depends on which page (studio or org) the tab is mounted on. */
  printHref?: string
}

export function ProgramTab({ event, canEdit = true, parentOrgId, printHref }: ProgramTabProps) {
  const t = useTranslations('EventProgram')
  const eventId = event.id
  const config = event.program ?? EMPTY_CONFIG
  const tenant = useMemo(() => programTenant(event), [event])

  const itemsQ = useProgramItems(eventId)
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data])

  const saveConfig = useSaveProgramConfig(eventId)
  const createItem = useCreateProgramItem(eventId, tenant)
  const updateItem = useUpdateProgramItem(eventId)
  const deleteItem = useDeleteProgramItem(eventId)
  const deleteDay = useDeleteProgramDay(eventId)
  const deleteTrack = useDeleteProgramTrack(eventId)
  const replaceProgram = useReplaceProgram(eventId, tenant)

  // Templates are saved to the org when an org admin edits an org event, and to
  // the team otherwise. The picker always offers both, inherited ones read-only.
  const orgId = event.orgId ?? parentOrgId ?? null
  const templateScope: 'team' | 'org' = event.scope === 'org' ? 'org' : 'team'
  const templateOwnerId = templateScope === 'org' ? orgId : event.teamId ?? null

  const days = sortedDays(config)
  const [activeDayId, setActiveDayId] = useState<string | null>(null)
  const [structureOpen, setStructureOpen] = useState(false)
  const [itemOpen, setItemOpen] = useState(false)
  const [editing, setEditing] = useState<EventProgramItem | null>(null)
  const [preview, setPreview] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)

  // Fall back to the first day whenever the selected one disappears.
  const currentDayId = days.some((d) => d.id === activeDayId) ? activeDayId : days[0]?.id ?? null

  const atCap = items.length >= MAX_PROGRAM_ITEMS

  const nextOrderFor = (dayId: string) => nextItemOrder(items, dayId)

  function openNewItem() {
    setEditing(null)
    setItemOpen(true)
  }

  // The timeline is shared with the public surfaces, so it hands back the
  // narrower display shape — resolve the real document before editing.
  function openEditItem(item: { id: string }) {
    const full = items.find((i) => i.id === item.id)
    if (!full) return
    setEditing(full)
    setItemOpen(true)
  }

  async function submitItem(draft: ProgramItemDraft) {
    if (editing) await updateItem.mutateAsync({ itemId: editing.id, patch: draft })
    else await createItem.mutateAsync(draft)
    setItemOpen(false)
    setEditing(null)
  }

  async function removeItem() {
    if (!editing) return
    await deleteItem.mutateAsync(editing.id)
    setItemOpen(false)
    setEditing(null)
  }

  if (itemsQ.isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  // ── Empty state: the discovery affordance for the whole feature ────────────
  if (days.length === 0) {
    return (
      <>
        <div className="rounded-xl border bg-card px-6 py-14 text-center">
          <CalendarRange className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="mt-3 text-sm font-medium">{t('emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {t('emptyDescription')}
          </p>
          {canEdit && (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button onClick={() => setStructureOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('buildProgram')}
              </Button>
              <Button variant="outline" onClick={() => setApplyOpen(true)}>
                <LayoutTemplate className="mr-1.5 h-4 w-4" />
                {t('applyTemplate')}
              </Button>
            </div>
          )}
        </div>

        {canEdit && (
          <>
            <ProgramStructureDialog
              open={structureOpen}
              onOpenChange={setStructureOpen}
              event={event}
              config={config}
              items={items}
              saving={saveConfig.isPending}
              onSave={(next) => saveConfig.mutateAsync(next)}
              onDeleteDay={(dayId) => deleteDay.mutateAsync({ config, dayId, items })}
              onDeleteTrack={(trackId) => deleteTrack.mutateAsync({ config, trackId, items })}
            />
            <ApplyTemplateDialog
              open={applyOpen}
              onOpenChange={setApplyOpen}
              event={event}
              teamId={event.teamId ?? null}
              orgId={orgId}
              existingItemCount={items.length}
              applying={replaceProgram.isPending}
              onApply={(nextConfig, nextItems) =>
                replaceProgram.mutateAsync({ config: nextConfig, items: nextItems, existing: items })
              }
            />
          </>
        )}
      </>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{t('itemCount', { count: items.length })}</Badge>
          {config.tracks.length > 0 && (
            <Badge variant="outline">{t('trackCount', { count: config.tracks.length })}</Badge>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {printHref && items.length > 0 && (
            <Link href={printHref as Route} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
              <Printer className="mr-1.5 h-3.5 w-3.5" />
              {t('printOrPdf')}
            </Link>
          )}
          <Button size="sm" variant="outline" onClick={() => setPreview((p) => !p)}>
            {preview ? <Pencil className="mr-1.5 h-3.5 w-3.5" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}
            {preview ? t('modeEdit') : t('modePreview')}
          </Button>
          {canEdit && (
            <>
              <Button size="sm" variant="outline" onClick={() => setSaveTemplateOpen(true)}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {t('saveAsTemplate')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setApplyOpen(true)}>
                <LayoutTemplate className="mr-1.5 h-3.5 w-3.5" />
                {t('applyTemplate')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setStructureOpen(true)}>
                <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                {t('structureTitle')}
              </Button>
              <Button size="sm" onClick={openNewItem} disabled={atCap}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {t('newItem')}
              </Button>
            </>
          )}
        </div>
      </div>

      {atCap && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {t('itemCapReached', { max: MAX_PROGRAM_ITEMS })}
        </p>
      )}

      {/* ── Preview: the handout members see and print (ProgramSheet), with
          the internal notes shown because the reader here is staff. ──────── */}
      {preview ? (
        <ProgramSheet
          className="rounded-sm border border-neutral-200"
          title={event.title}
          start={(event.start as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null}
          end={(event.end as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null}
          location={event.location}
          coachName={event.coachName}
          description={event.description}
          config={config}
          items={items}
          showInternalNotes
        />
      ) : (
        <>
          {/* Day selector — horizontally scrollable so a two-week camp still
              works on a phone. */}
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {days.map((day, index) => (
              <button
                key={day.id}
                type="button"
                onClick={() => setActiveDayId(day.id)}
                className={cn(
                  'shrink-0 rounded-lg border px-3 py-1.5 text-xs transition-colors',
                  day.id === currentDayId
                    ? 'border-primary bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                <span className="block">{day.title || t('dayN', { n: index + 1 })}</span>
                <span className="block text-xs opacity-70">{day.date}</span>
              </button>
            ))}
          </div>

          {currentDayId && (
            <ProgramTimeline
              config={config}
              items={items}
              dayId={currentDayId}
              showInternalNotes
              onEditItem={canEdit ? openEditItem : undefined}
            />
          )}
        </>
      )}

      {canEdit && (
        <>
          <ProgramItemDialog
            open={itemOpen}
            onOpenChange={(o) => { setItemOpen(o); if (!o) setEditing(null) }}
            config={config}
            defaultDayId={currentDayId ?? undefined}
            item={editing}
            nextOrderFor={nextOrderFor}
            saving={createItem.isPending || updateItem.isPending || deleteItem.isPending}
            onSubmit={submitItem}
            onDelete={editing ? removeItem : undefined}
          />

          <ProgramStructureDialog
            open={structureOpen}
            onOpenChange={setStructureOpen}
            event={event}
            config={config}
            items={items}
            saving={saveConfig.isPending}
            onSave={(next) => saveConfig.mutateAsync(next)}
            onDeleteDay={(dayId) => deleteDay.mutateAsync({ config, dayId, items })}
            onDeleteTrack={(trackId) => deleteTrack.mutateAsync({ config, trackId, items })}
          />

          <ApplyTemplateDialog
            open={applyOpen}
            onOpenChange={setApplyOpen}
            event={event}
            teamId={event.teamId ?? null}
            orgId={orgId}
            existingItemCount={items.length}
            applying={replaceProgram.isPending}
            onApply={(nextConfig, nextItems) =>
              replaceProgram.mutateAsync({ config: nextConfig, items: nextItems, existing: items })
            }
          />

          <SaveAsTemplateDialog
            open={saveTemplateOpen}
            onOpenChange={setSaveTemplateOpen}
            config={config}
            items={items}
            scope={templateScope}
            ownerId={templateOwnerId}
            defaultName={event.title}
          />
        </>
      )}
    </div>
  )
}
