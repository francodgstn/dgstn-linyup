'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { PageHeader } from '@/components/layout/PageHeader'
import { ColorPicker, DEFAULT_ACCENT } from '@/components/ui/color-picker'
import { Plus, Pencil, Trash2, Lock, Package } from 'lucide-react'
import {
  TEAMS_COLLECTION, EVENT_TYPES_SUBCOLLECTION,
  BUILTIN_EVENT_TYPES,
} from '@linyup/shared'
import type { EventTypeConfig, EventTypeField, EventTypeFieldType } from '@linyup/shared'
import { PLUGIN_REGISTRY, containerManifestFor } from '@/plugins/registry'
import { usePluginDiscovery } from '@/hooks/usePluginDiscovery'
import { useTranslations } from 'next-intl'
import { useConfirm } from '@/components/ui/confirm-dialog'

// ─── constants ────────────────────────────────────────────────────────────────

const FIELD_TYPE_VALUES: EventTypeFieldType[] = ['text', 'number', 'select', 'multiselect', 'boolean']

const BUILTIN_LABEL_KEYS: Record<string, string> = {
  competition: 'builtinLabels.competition',
  camp: 'builtinLabels.camp',
  exam: 'builtinLabels.exam',
  seminar: 'builtinLabels.seminar',
  workshop: 'builtinLabels.workshop',
  other: 'builtinLabels.other',
}

// ─── field builder ────────────────────────────────────────────────────────────

function FieldBuilder({
  fields,
  onChange,
}: {
  fields: EventTypeField[]
  onChange: (fields: EventTypeField[]) => void
}) {
  const t = useTranslations('EventTypesSettings')

  function addField() {
    onChange([...fields, { key: `field_${fields.length + 1}`, label: '', type: 'text' }])
  }
  function removeField(i: number) {
    onChange(fields.filter((_, idx) => idx !== i))
  }
  function updateField(i: number, patch: Partial<EventTypeField>) {
    onChange(fields.map((f, idx) => idx === i ? { ...f, ...patch } : f))
  }

  return (
    <div className="space-y-3">
      {fields.map((f, i) => (
        <div key={i} className="rounded-lg border p-3 space-y-2 bg-muted/20">
          <div className="flex items-center gap-2">
            <div className="flex-1 grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">{t('fieldBuilder.label')}</Label>
                <Input
                  value={f.label}
                  onChange={(e) => updateField(i, { label: e.target.value })}
                  placeholder={t('fieldBuilder.labelPlaceholder')}
                  className="h-7 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('fieldBuilder.type')}</Label>
                <Select value={f.type} onValueChange={(v) => updateField(i, { type: v as EventTypeFieldType })}>
                  <SelectTrigger className="h-7 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPE_VALUES.map((ft) => (
                      <SelectItem key={ft} value={ft}>{t(`fieldTypes.${ft}` as Parameters<typeof t>[0])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive shrink-0"
              onClick={() => removeField(i)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          {(f.type === 'select' || f.type === 'multiselect') && (
            <div className="space-y-1">
              <Label className="text-xs">{t('fieldBuilder.options')}</Label>
              <textarea
                className="w-full rounded-md border px-2 py-1 text-sm h-16 resize-none"
                value={(f.options ?? []).join('\n')}
                onChange={(e) => updateField(i, { options: e.target.value.split('\n').filter(Boolean) })}
                placeholder={t('fieldBuilder.optionsPlaceholder')}
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={!!f.required}
              onChange={(e) => updateField(i, { required: e.target.checked })}
            />
            {t('fieldBuilder.required')}
          </label>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={addField}>
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        {t('fieldBuilder.addField')}
      </Button>
    </div>
  )
}

// ─── form dialog ──────────────────────────────────────────────────────────────

function EventTypeFormDialog({
  initial,
  onSave,
  onClose,
}: {
  initial?: EventTypeConfig
  onSave: (data: Omit<EventTypeConfig, 'id' | 'source' | 'created_at' | 'created_by'>) => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations('EventTypesSettings')
  const [name, setName] = useState(initial?.name ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? 'Calendar')
  const [color, setColor] = useState(initial?.color ?? DEFAULT_ACCENT)
  const [fields, setFields] = useState<EventTypeField[]>(initial?.checkin_fields ?? [])
  const [busy, setBusy] = useState(false)

  async function handleSave() {
    if (!name.trim()) return
    setBusy(true)
    await onSave({ name: name.trim(), icon, color, checkin_fields: fields })
    setBusy(false)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? t('form.editTitle') : t('form.newTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('form.name')}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('form.namePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('form.icon')}</Label>
              <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder={t('form.iconPlaceholder')} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.color')}</Label>
            <ColorPicker value={color} onChange={setColor} className="w-8 h-8" aria-label={t('form.color')} />
          </div>
          <div className="space-y-2">
            <Label>{t('form.checkinFields')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('form.checkinFieldsHint')}
            </p>
            <FieldBuilder fields={fields} onChange={setFields} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('form.cancel')}</Button>
          <Button onClick={handleSave} disabled={busy || !name.trim()}>
            {busy ? t('form.saving') : t('form.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function EventTypesPage() {
  // Styled confirmation, replacing a browser `confirm()` (see confirm-dialog).
  const { confirm, confirmDialog } = useConfirm()
  const tCommon = useTranslations('Common')
  const t = useTranslations('EventTypesSettings')
  // Plugin display names live in the Plugins namespace, beside the manifests'
  // nameKeys — this page credits a plugin without owning its copy.
  const tPlugins = useTranslations('Plugins')
  const { currentTeamId } = useAuth()
  const { canDiscover } = usePluginDiscovery()
  const qc = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<EventTypeConfig | null>(null)

  const { data: customTypes = [], isLoading } = useQuery<EventTypeConfig[]>({
    queryKey: ['event-types', currentTeamId],
    enabled: !!currentTeamId,
    queryFn: async () => {
      if (!currentTeamId) return []
      const snap = await getDocs(
        query(collection(db, TEAMS_COLLECTION, currentTeamId, EVENT_TYPES_SUBCOLLECTION), orderBy('name')),
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as EventTypeConfig)
    },
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['event-types', currentTeamId] })

  async function handleSave(data: Omit<EventTypeConfig, 'id' | 'source' | 'created_at' | 'created_by'>) {
    if (!currentTeamId) return
    if (editing) {
      await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId, EVENT_TYPES_SUBCOLLECTION, editing.id), {
        ...data,
        updated_at: serverTimestamp(),
      })
    } else {
      await addDoc(collection(db, TEAMS_COLLECTION, currentTeamId, EVENT_TYPES_SUBCOLLECTION), {
        ...data,
        source: 'team',
        created_at: serverTimestamp(),
      })
    }
    invalidate()
  }

  async function handleDelete(type: EventTypeConfig) {
    if (!currentTeamId) return
    const okDeleteType = await confirm({
      title: t('deleteConfirmTitle'),
      description: t('deleteConfirm', { name: type.name }),
      confirmLabel: tCommon('delete'),
    })
    if (!okDeleteType) return
    await deleteDoc(doc(db, TEAMS_COLLECTION, currentTeamId, EVENT_TYPES_SUBCOLLECTION, type.id))
    invalidate()
  }

  // This section names the plugin that provides each type ("Provided by HMD"),
  // so it is a discovery surface even though it installs nothing — it was the
  // second place a customer's name reached every other tenant. Install state is
  // deliberately NOT part of the filter: the list has always shown plugin types
  // whether or not the team installed them, and narrowing that here would be a
  // separate behaviour change.
  //
  // It keeps the WHOLE registry rather than `installableManifests()`, and asks
  // about the CONTAINER instead: a bundle member really does provide the event
  // type, so hiding its row would only remove information from a page that
  // offers no install — but attributing the row to the member would print the
  // member's id, which is exactly the customer name the container's audience
  // exists to keep out of other tenants' screens. So: gate on the container's
  // audience, and label with the container's name.
  const pluginTypes = PLUGIN_REGISTRY
    .filter((p) => p.eventType)
    .map((p) => ({ p, card: containerManifestFor(p.id) ?? p }))
    .filter(({ card }) => canDiscover(card))

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        action={
          <Button onClick={() => { setEditing(null); setFormOpen(true) }}>
            <Plus className="h-4 w-4 mr-1.5" />
            {t('newType')}
          </Button>
        }
      />

      {/* Built-in types */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('builtin.heading')}</h2>
        <div className="divide-y rounded-lg border">
          {BUILTIN_EVENT_TYPES.map((type) => (
            <div key={type} className="flex items-center gap-3 p-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {BUILTIN_LABEL_KEYS[type] ? t(BUILTIN_LABEL_KEYS[type] as Parameters<typeof t>[0]) : type}
                </p>
                <p className="text-xs text-muted-foreground capitalize">{type}</p>
              </div>
              <Badge variant="secondary" className="text-xs shrink-0">{t('builtin.badge')}</Badge>
              <Lock className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
            </div>
          ))}
        </div>
      </section>

      {/* Plugin-provided types */}
      {pluginTypes.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('fromPlugins.heading')}</h2>
          <div className="divide-y rounded-lg border">
            {pluginTypes.map(({ p: plugin, card }) => (
              <div key={plugin.id} className="flex items-center gap-3 p-3">
                <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{plugin.eventType!.id}</p>
                  {/* The CONTAINER's display name, not the member's id — the row
                      credits the card a tenant actually installs, and a raw id
                      here used to be how a customer's name travelled. */}
                  <p className="text-xs text-muted-foreground">
                    {t('fromPlugins.providedBy', { pluginId: tPlugins(card.nameKey as never) })}
                  </p>
                </div>
                <Badge variant="outline" className="text-xs shrink-0">{t('fromPlugins.badge')}</Badge>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Custom types */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('custom.heading')}</h2>

        {isLoading && (
          <div className="space-y-2">
            {[1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
          </div>
        )}

        {!isLoading && customTypes.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('custom.empty')}
          </div>
        )}

        {!isLoading && customTypes.length > 0 && (
          <div className="divide-y rounded-lg border">
            {customTypes.map((type) => (
              <div key={type.id} className="flex items-center gap-3 p-3">
                {type.color && (
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: type.color }} />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{type.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(type.checkin_fields?.length ?? 0) > 0
                      ? t('custom.checkinFieldCount', { count: type.checkin_fields!.length })
                      : t('custom.noCheckinFields')}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    onClick={() => { setEditing(type); setFormOpen(true) }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(type)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {formOpen && (
        <EventTypeFormDialog
          initial={editing ?? undefined}
          onSave={handleSave}
          onClose={() => { setFormOpen(false); setEditing(null) }}
        />
      )}
      {confirmDialog}
    </div>
  )
}
