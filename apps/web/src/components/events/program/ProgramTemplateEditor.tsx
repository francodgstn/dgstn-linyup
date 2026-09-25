'use client'

/**
 * THE STANDALONE TEMPLATE EDITOR.
 *
 * Templates used to be authorable in exactly one way: build a program on a
 * real event, then "Save as template". The docs said so deliberately — "there is
 * no standalone template editor; the event page already is one" — and for
 * SAVING an existing program that is still the right route.
 *
 * It was the wrong rule for CREATING one. A studio setting up its standard camp
 * agenda in January, before any camp exists, had to invent an event, build the
 * program on it, save the template and then delete the event — four steps and
 * a throwaway record for a thing that is purely reusable by nature (Franco,
 * 2026-08-31). Settings → Program templates now creates and edits directly.
 *
 * ── HOW IT REUSES THE EVENT EDITOR ──────────────────────────────────────────
 * It does not reimplement the program UI. A template is materialized onto a
 * SCRATCH ANCHOR DATE, edited as an ordinary `EventProgramConfig` + item list in
 * local state, and turned back into a template on save — so `ProgramTimeline`,
 * `ProgramItemDialog` and `ProgramStructureDialog` are the same components the
 * event page uses, and a change to any of them lands in both places.
 *
 * THE ANCHOR IS A FIXTURE, NOT A DATE. `materialiseTemplate` needs day dates to
 * key items on; `extractTemplate` throws them away again and keeps only the
 * 0-based `dayIndex`, which is the whole point of a template. So the anchor is a
 * CONSTANT rather than today: it never leaks into what is stored, and it makes
 * the editor's day ids stable within a session. Both the timeline and the item
 * dialog run in `hideDayDates` mode here so the scratch dates are never shown —
 * printing "Monday 3 January" over a reusable program states a fact that is
 * not one.
 *
 * ── ONE WRITE, LIKE EVERY OTHER TEMPLATE WRITE ──────────────────────────────
 * A template is a single document (`ProgramTemplate.items` is embedded, unlike
 * an event's `program_items` subcollection), so this whole editor is local state
 * plus one `setDoc` — no per-item mutation, no chunked batch, and nothing to
 * half-apply. That is also why it can offer an ordinary "unsaved changes" model
 * where the event page cannot.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Eye, LayoutTemplate, Pencil, Plus, Settings2 } from 'lucide-react'
import {
  MAX_PROGRAM_ITEMS,
  extractTemplate,
  materialiseTemplate,
  nextItemOrder,
  sortedDays,
} from '@linyup/shared'
import type { EventProgramConfig, EventProgramItem } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
import { ProgramTimeline } from './ProgramTimeline'
import { ProgramItemDialog } from './ProgramItemDialog'
import { ProgramStructureDialog } from './ProgramStructureDialog'
import { useProgramTemplate, useSaveProgramTemplate } from './useProgramTemplates'
import type { ProgramItemDraft } from './useProgram'

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2, 11)}`

/** See the header: a fixture the editor keys items on, never stored, never shown. */
const ANCHOR_DATE = '2000-01-03'

const EMPTY_CONFIG: EventProgramConfig = { days: [], tracks: [] }

/** The item shape the shared components take. Local only — these ids exist for
 *  React keys and for `dayId`/`trackId` wiring, and `extractTemplate` drops them. */
type DraftItem = EventProgramItem

export interface ProgramTemplateEditorProps {
  scope: 'team' | 'org'
  ownerId: string | null
  templateId: string
  canEdit?: boolean
  /** Where the header's back link goes — the list this template came from. */
  onDone: () => void
}

export function ProgramTemplateEditor({
  scope,
  ownerId,
  templateId,
  canEdit = true,
  onDone,
}: ProgramTemplateEditorProps) {
  const t = useTranslations('EventProgram')
  const templateQ = useProgramTemplate(scope, ownerId, templateId)
  const saveTemplate = useSaveProgramTemplate(scope, ownerId)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState<EventProgramConfig>(EMPTY_CONFIG)
  const [items, setItems] = useState<DraftItem[]>([])
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [hydratedId, setHydratedId] = useState<string | null>(null)

  const [activeDayId, setActiveDayId] = useState<string | null>(null)
  const [structureOpen, setStructureOpen] = useState(false)
  const [itemOpen, setItemOpen] = useState(false)
  const [editing, setEditing] = useState<DraftItem | null>(null)
  const [preview, setPreview] = useState(false)

  // Hydrate ONCE per template. Re-running on every query settle would throw away
  // unsaved edits the moment react-query refetched in the background.
  const template = templateQ.data
  useEffect(() => {
    if (!template || hydratedId === template.id) return
    const { config: c, items: materialised } = materialiseTemplate(template, ANCHOR_DATE, newId)
    setName(template.name ?? '')
    setDescription(template.description ?? '')
    setConfig(c)
    setItems(
      materialised.map((m) => ({ ...m, id: newId(), eventId: '' }) as DraftItem)
    )
    setHydratedId(template.id)
    setDirty(false)
  }, [template, hydratedId])

  const days = sortedDays(config)
  const currentDayId = days.some((d) => d.id === activeDayId) ? activeDayId : days[0]?.id ?? null
  const atCap = items.length >= MAX_PROGRAM_ITEMS

  const visibleItems = useMemo(
    () => (preview || !currentDayId ? items : items.filter((i) => i.dayId === currentDayId)),
    [preview, currentDayId, items]
  )

  function touch() {
    setDirty(true)
    setSaved(false)
  }

  function openNewItem() {
    setEditing(null)
    setItemOpen(true)
  }

  function submitItem(draft: ProgramItemDraft) {
    if (editing) {
      setItems(items.map((i) => (i.id === editing.id ? ({ ...i, ...draft } as DraftItem) : i)))
    } else {
      setItems([...items, { ...draft, id: newId(), eventId: '' } as DraftItem])
    }
    touch()
    setItemOpen(false)
    setEditing(null)
  }

  function deleteItem() {
    if (!editing) return
    setItems(items.filter((i) => i.id !== editing.id))
    touch()
    setItemOpen(false)
    setEditing(null)
  }

  /** Days and tracks are saved together with the items, so the structure dialog's
   *  "delete" callbacks are plain local edits here — there is no batch to run. */
  function saveStructure(next: EventProgramConfig) {
    setConfig(next)
    touch()
  }
  function deleteDay(dayId: string) {
    setConfig({ ...config, days: config.days.filter((d) => d.id !== dayId) })
    setItems(items.filter((i) => i.dayId !== dayId))
    touch()
  }
  function deleteTrack(trackId: string) {
    setConfig({ ...config, tracks: config.tracks.filter((tr) => tr.id !== trackId) })
    // Items keep their place and fall back to plenary — the non-destructive
    // reading of "remove this lane", same as on an event.
    setItems(items.map((i) => (i.trackId === trackId ? { ...i, trackId: null } : i)))
    touch()
  }

  async function save() {
    if (!name.trim()) return
    const body = extractTemplate(config, items)
    await saveTemplate.mutateAsync({
      ...body,
      templateId,
      name: name.trim(),
      description: description.trim(),
    })
    setDirty(false)
    setSaved(true)
  }

  if (templateQ.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  if (!template) {
    return (
      <div className="rounded-xl border bg-card px-6 py-14 text-center">
        <LayoutTemplate className="mx-auto h-8 w-8 text-muted-foreground/60" />
        <p className="mt-3 text-sm font-medium">{t('templateMissing')}</p>
        <Button variant="outline" className="mt-4" onClick={onDone}>
          {t('templatesBack')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Name + description live IN the editor rather than behind a rename
          dialog: this is the screen you are on while authoring, and a template
          created from the list starts with a placeholder name that has to be
          replaced somewhere. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tpl-name">{t('templateName')}</Label>
          <Input
            id="tpl-name"
            value={name}
            disabled={!canEdit}
            onChange={(e) => {
              setName(e.target.value)
              touch()
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-desc">{t('templateDescription')}</Label>
          <Input
            id="tpl-desc"
            value={description}
            disabled={!canEdit}
            onChange={(e) => {
              setDescription(e.target.value)
              touch()
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setStructureOpen(true)}>
            <Settings2 className="mr-1.5 h-4 w-4" />
            {t('structureTitle')}
          </Button>
        )}
        {canEdit && days.length > 0 && (
          <Button size="sm" onClick={openNewItem} disabled={atCap}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('newItem')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setPreview((v) => !v)}>
          {preview ? <Pencil className="mr-1.5 h-4 w-4" /> : <Eye className="mr-1.5 h-4 w-4" />}
          {preview ? t('modeEdit') : t('modePreview')}
        </Button>
        {atCap && (
          <Badge variant="outline" className="text-xs">
            {t('itemCapReached', { max: MAX_PROGRAM_ITEMS })}
          </Badge>
        )}
      </div>

      {days.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <LayoutTemplate className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="mt-3 text-sm font-medium">{t('templateNoDays')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('templateNoDaysHint')}</p>
          {canEdit && (
            <Button className="mt-4" onClick={() => setStructureOpen(true)}>
              <Settings2 className="mr-1.5 h-4 w-4" />
              {t('structureTitle')}
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Day tabs — the same affordance the event page uses, minus dates. */}
          {!preview && days.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {days.map((d, index) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setActiveDayId(d.id)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    d.id === currentDayId
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted'
                  )}
                >
                  {d.title || t('dayN', { n: index + 1 })}
                </button>
              ))}
            </div>
          )}

          <ProgramTimeline
            config={config}
            items={visibleItems}
            dayId={preview ? undefined : currentDayId ?? undefined}
            showInternalNotes
            hideDayDates
            onEditItem={
              canEdit && !preview
                ? (item) => {
                    setEditing(items.find((i) => i.id === item.id) ?? null)
                    setItemOpen(true)
                  }
                : undefined
            }
          />
        </>
      )}

      <ProgramStructureDialog
        open={structureOpen}
        onOpenChange={setStructureOpen}
        hideDates
        config={config}
        items={items}
        onSave={saveStructure}
        onDeleteDay={deleteDay}
        onDeleteTrack={deleteTrack}
      />

      <ProgramItemDialog
        open={itemOpen}
        onOpenChange={(o) => {
          setItemOpen(o)
          if (!o) setEditing(null)
        }}
        config={config}
        defaultDayId={currentDayId ?? undefined}
        item={editing}
        hideDayDates
        nextOrderFor={(dayId) => nextItemOrder(items, dayId)}
        onSubmit={submitItem}
        onDelete={editing ? deleteItem : undefined}
      />

      {canEdit && (
        <SettingsSaveBar
          onSave={save}
          saving={saveTemplate.isPending}
          saved={saved}
          disabled={!dirty || !name.trim()}
        />
      )}
    </div>
  )
}
