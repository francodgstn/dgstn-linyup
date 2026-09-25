'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { doc, updateDoc } from 'firebase/firestore'
import { Link } from '@/i18n/navigation'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION } from '@linyup/shared'
import type { Team, CustomFieldDefinition, CustomFieldType } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown } from 'lucide-react'

const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'date', 'select', 'checkbox']

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Generate a stable, unique id from a label, avoiding collisions with existing ids. */
function uniqueId(label: string, existing: string[]): string {
  const base = slugify(label) || 'field'
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

interface FieldFormState {
  id: string
  label: string
  type: CustomFieldType
  options: string[]
  required: boolean
  publicOnBookingForm: boolean
}

function emptyForm(): FieldFormState {
  return { id: '', label: '', type: 'text', options: [''], required: false, publicOnBookingForm: false }
}

// ─── Add / edit dialog ────────────────────────────────────────────────────────

function CustomFieldDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: FieldFormState | null
  onSave: (form: FieldFormState) => void
}) {
  const t = useTranslations('TeamSettings')
  const [form, setForm] = useState<FieldFormState>(initial ?? emptyForm())
  const isEdit = !!initial

  useEffect(() => {
    if (open) setForm(initial ?? emptyForm())
  }, [open, initial])

  const cleanOptions = form.options.map((o) => o.trim()).filter(Boolean)
  const canSave =
    form.label.trim().length > 0 && (form.type !== 'select' || cleanOptions.length > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('editCustomField') : t('addCustomField')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4 py-1">
          <div className="space-y-1">
            <Label>{t('customFieldLabel')}</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder={t('customFieldLabelPlaceholder')}
            />
          </div>

          <div className="space-y-1">
            <Label>{t('customFieldType')}</Label>
            <Select
              value={form.type}
              onValueChange={(v) => setForm((f) => ({ ...f, type: v as CustomFieldType }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((ft) => (
                  <SelectItem key={ft} value={ft}>
                    {t(`customFieldType_${ft}` as Parameters<typeof t>[0])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Options editor — only for 'select' */}
          {form.type === 'select' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('customFieldOptions')}</Label>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, options: [...f.options, ''] }))}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  {t('addOption')}
                </button>
              </div>
              <div className="space-y-1.5">
                {form.options.map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={opt}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          options: f.options.map((o, i) => (i === idx ? e.target.value : o)),
                        }))
                      }
                      placeholder={t('optionPlaceholder')}
                      className="h-8 text-sm flex-1"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          options: f.options.filter((_, i) => i !== idx),
                        }))
                      }
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* THIS IS THE CONTACT FORM'S "required", not the book form's — they
              are two flags and only the other one is enforced. The hint says
              which, because two adjacent switches reading "Required" is how a
              studio comes away believing it has made a booking question
              mandatory when it has not touched the book form at all. */}
          <label className="flex items-start justify-between gap-3 cursor-pointer">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{t('customFieldRequired')}</span>
              <span className="block text-xs text-muted-foreground">
                {t('customFieldRequiredHint')}
              </span>
            </span>
            <Switch
              checked={form.required}
              onCheckedChange={(v) => setForm((f) => ({ ...f, required: v }))}
            />
          </label>

          {/* Opt-in, and off by default: ticking this MIRRORS the field's label
              and options into the world-readable team profile so the anonymous
              book form can render it. The helper text says so plainly — a
              studio should never discover after the fact that "Payment risk"
              became public. */}
          <label className="flex items-start justify-between gap-3 cursor-pointer">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{t('customFieldPublicOnBooking')}</span>
              <span className="block text-xs text-muted-foreground">
                {t('customFieldPublicOnBookingHint')}
              </span>
            </span>
            <Switch
              checked={form.publicOnBookingForm}
              onCheckedChange={(v) => setForm((f) => ({ ...f, publicOnBookingForm: v }))}
            />
          </label>

          {/* THE SECOND STEP. Opting in only makes the field ASKABLE — nothing
              here adds it to the book form, deliberately (see the header of
              BookingContactFieldsEditor). Said at the moment the switch goes on,
              because that is when a studio believes it is finished. */}
          {form.publicOnBookingForm && (
            <div className="rounded-md border border-dashed p-2.5 space-y-1">
              <p className="text-xs text-muted-foreground">{t('customFieldPublicNextStep')}</p>
              <Link
                href="/settings/booking"
                className="text-xs text-primary hover:underline underline-offset-2"
              >
                {t('customFieldPublicNextStepLink')}
              </Link>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onSave({ ...form, options: cleanOptions })
              onOpenChange(false)
            }}
          >
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Tab ──────────────────────────────────────────────────────────────────────

export function CustomFieldsTab({ teamId, team }: { teamId: string; team: Team }) {
  const t = useTranslations('TeamSettings')
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<FieldFormState | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const defs: CustomFieldDefinition[] = team.custom_field_definitions ?? []

  const save = async (next: CustomFieldDefinition[]) => {
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { custom_field_definitions: next })
      qc.invalidateQueries({ queryKey: ['team', teamId] })
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async (form: FieldFormState) => {
    const existingIds = defs.map((d) => d.id)
    const def: CustomFieldDefinition = {
      id: editing ? editing.id : uniqueId(form.label, existingIds),
      label: form.label.trim(),
      type: form.type,
      ...(form.type === 'select' ? { options: form.options } : {}),
      required: form.required,
      publicOnBookingForm: form.publicOnBookingForm,
    }
    const next = editing
      ? defs.map((d) => (d.id === editing.id ? def : d))
      : [...defs, def]
    await save(next)
    setEditing(null)
  }

  const handleDelete = async (id: string) => {
    await save(defs.filter((d) => d.id !== id))
    setDeleting(null)
  }

  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= defs.length) return
    const next = [...defs]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    await save(next)
  }

  const openAdd = () => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (d: CustomFieldDefinition) => {
    setEditing({
      id: d.id,
      label: d.label,
      type: d.type,
      options: d.options && d.options.length > 0 ? [...d.options] : [''],
      required: d.required ?? false,
      publicOnBookingForm: d.publicOnBookingForm ?? false,
    })
    setDialogOpen(true)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('customFieldsIntro')}</p>
        <Button size="sm" onClick={openAdd} disabled={saving}>
          <Plus className="h-4 w-4 mr-1.5" />
          {t('addCustomField')}
        </Button>
      </div>

      {defs.length === 0 ? (
        <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          {t('customFieldsEmpty')}
        </div>
      ) : (
        <div className="space-y-2">
          {defs.map((d, idx) => (
            <div key={d.id} className="rounded-lg border p-3 flex items-center gap-2">
              <div className="flex flex-col">
                <button
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0 || saving}
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30 transition-colors"
                  aria-label="Move up"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  onClick={() => move(idx, 1)}
                  disabled={idx === defs.length - 1 || saving}
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30 transition-colors"
                  aria-label="Move down"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium">{d.label}</p>
                  <Badge variant="secondary" className="text-xs">
                    {t(`customFieldType_${d.type}` as Parameters<typeof t>[0])}
                  </Badge>
                  {d.required && (
                    <Badge variant="outline" className="text-xs">
                      {t('customFieldRequired')}
                    </Badge>
                  )}
                  {/* The flag that actually governs whether the field can be
                      asked publicly — invisible outside the edit dialog until
                      now, which is why "I turned it on" and "it isn't there"
                      were both true. */}
                  {d.publicOnBookingForm && (
                    <Badge variant="outline" className="text-xs">
                      {t('customFieldPublicBadge')}
                    </Badge>
                  )}
                </div>
                {d.type === 'select' && d.options && d.options.length > 0 && (
                  <p className="text-xs text-muted-foreground truncate">{d.options.join(' · ')}</p>
                )}
              </div>
              <button
                onClick={() => openEdit(d)}
                className="p-1.5 rounded hover:bg-muted transition-colors"
                aria-label="Edit"
              >
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
              <button
                onClick={() => setDeleting(d.id)}
                className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-destructive"
                aria-label="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <CustomFieldDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v)
          if (!v) setEditing(null)
        }}
        initial={editing}
        onSave={handleSave}
      />

      <Dialog open={!!deleting} onOpenChange={() => setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteCustomField')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            {t('deleteCustomFieldConfirm', {
              name: defs.find((d) => d.id === deleting)?.label ?? '',
            })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => deleting && handleDelete(deleting)}
            >
              {t('deleteCustomField')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
